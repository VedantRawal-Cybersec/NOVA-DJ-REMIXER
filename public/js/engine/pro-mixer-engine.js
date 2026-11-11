import { getHarmonicMatch } from './camelot.js';
import { loadDrumSamplesForContext, scheduleStudioDrumBridge } from './drum-pack.js';
import { createStemChannelStrip } from './stems-isolator.js';

const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];

function clampRecipeRate(rate, recipeType) {
  if (!Number.isFinite(rate) || rate <= 0) return 1;
  if (recipeType === 'echo_out' || recipeType === 'impact_cut' || recipeType === 'spinback') {
    return Math.max(0.88, Math.min(1.12, rate));
  }
  return Math.max(0.91, Math.min(1.09, rate));
}

let stretchModulePromise = null;
async function loadSignalsmith() {
  if (!stretchModulePromise) {
    stretchModulePromise = import('/vendor/signalsmith-stretch.mjs').then((m) => m.default);
  }
  return stretchModulePromise;
}

export class ProMixerEngine {
  constructor(callbacks = {}) {
    this.cb = callbacks;
    this.ctx = null;
    this.masterGain = null;
    this.compressor = null;
    this.analyser = null;
    this.recordDest = null;
    this.recorder = null;
    this.recordChunks = [];

    // Master FX buses
    this.masterFilter = null;
    this.echoDelayL = null;
    this.echoDelayR = null;
    this.echoFeedback = null;
    this.echoReturn = null;
    this.reverbConvolver = null;
    this.reverbReturn = null;

    this.worker = null;
    this.workerReqId = 0;
    this.workerPending = new Map();
    this.decodedCache = new Map(); // id -> { buffer, stemBuffers?, analysis }

    this.decks = { A: null, B: null };
    this.drumSamples = null;
    this.workerConfigured = false;
    this.drumBridgeEnabled = false;
    this.masterTempoEnabled = true;
    this.autoKeyLockEnabled = true;
    this.clickTrackEnabled = false;
    this.lastScheduledBeatIdx = -1;

    this.masterBpm = 120;
    this.recorderActive = false;
    this.freqData = null;
  }

  async ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio API is unavailable in this browser.');
      this.ctx = new AC();

      this.masterFilter = this.ctx.createBiquadFilter();
      this.masterFilter.type = 'lowpass';
      this.masterFilter.frequency.value = 20000;
      this.masterFilter.Q.value = 0.7;

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.92;

      // Club-grade master glue compressor / peak limiter
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -6;
      this.compressor.knee.value = 8;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.16;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.76;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

      this.recordDest = this.ctx.createMediaStreamDestination();

      this.masterFilter.connect(this.masterGain);
      this.masterGain.connect(this.compressor);
      this.compressor.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.compressor.connect(this.recordDest);

      // Tempo-synced Ping-Pong Echo Bus
      this.echoDelayL = this.ctx.createDelay(2.0);
      this.echoDelayR = this.ctx.createDelay(2.0);
      this.echoDelayL.delayTime.value = 0.25;
      this.echoDelayR.delayTime.value = 0.375;
      this.echoFeedback = this.ctx.createGain();
      this.echoFeedback.gain.value = 0.36;
      const echoHP = this.ctx.createBiquadFilter();
      echoHP.type = 'highpass';
      echoHP.frequency.value = 260;
      this.echoReturn = this.ctx.createGain();
      this.echoReturn.gain.value = 0.55;

      this.echoDelayL.connect(this.echoDelayR);
      this.echoDelayR.connect(echoHP);
      echoHP.connect(this.echoFeedback);
      this.echoFeedback.connect(this.echoDelayL);
      this.echoDelayL.connect(this.echoReturn);
      this.echoDelayR.connect(this.echoReturn);
      this.echoReturn.connect(this.masterFilter);

      // Algorithmic Stereo Reverb Bus
      this.reverbConvolver = this.ctx.createConvolver();
      this.reverbConvolver.buffer = this.#buildImpulse(2.1, 2.7);
      this.reverbReturn = this.ctx.createGain();
      this.reverbReturn.gain.value = 0.45;
      this.reverbConvolver.connect(this.reverbReturn);
      this.reverbReturn.connect(this.masterFilter);

      this.decks.A = await this.#createDeck('A');
      this.decks.B = await this.#createDeck('B');
      this.drumSamples = await loadDrumSamplesForContext(this.ctx).catch(() => null);
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    if (!this.drumSamples) {
      this.drumSamples = await loadDrumSamplesForContext(this.ctx).catch(() => null);
    }
  }

  #buildImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  async #createDeck(id) {
    const strip = createStemChannelStrip(this.ctx, this.masterFilter);
    strip.echoSend.connect(this.echoDelayL);
    strip.reverbSend.connect(this.reverbConvolver);

    let stretch = null;
    try {
      const SignalsmithStretch = await loadSignalsmith();
      stretch = await SignalsmithStretch(this.ctx);
      await stretch.configure({ blockMs: 90, intervalMs: 22, splitComputation: true });
      stretch.connect(strip.input);
    } catch (err) {
      console.warn(`Deck ${id} SignalsmithStretch fallback to native AudioBufferSourceNode:`, err?.message);
    }

    const deck = {
      id,
      strip,
      stretch,
      stemStretches: null,
      neuralStems: false,
      fallbackSource: null,
      stemFallbackSources: [],
      track: null,
      buffer: null,
      stemBuffers: null,
      analysis: null,
      position: 0,
      rate: 1,
      semitones: 0,
      playing: false,
      loopActive: false,
      loopStart: 0,
      loopEnd: 0,
      startedAtCtx: 0,
      startedOffset: 0,
    };

    if (stretch) {
      stretch.setUpdateInterval(0.05, (inputTime) => {
        if (deck.playing && !deck.neuralStems) deck.position = inputTime;
      });
    }
    return deck;
  }

  #getDeckStretches(deck) {
    if (!deck) return [];
    if (deck.neuralStems && deck.stemStretches) {
      return STEM_NAMES.map((s) => deck.stemStretches[s]).filter(Boolean);
    }
    return deck.stretch ? [deck.stretch] : [];
  }

  async #ensureStemStretches(deck) {
    if (deck.stemStretches) return deck.stemStretches;
    const SignalsmithStretch = await loadSignalsmith();
    const map = {};
    await Promise.all(
      STEM_NAMES.map(async (stem) => {
        const st = await SignalsmithStretch(this.ctx);
        await st.configure({ blockMs: 90, intervalMs: 22, splitComputation: true });
        st.connect(deck.strip.stemInputs[stem]);
        if (stem === 'drums') {
          st.setUpdateInterval(0.05, (inputTime) => {
            if (deck.playing && deck.neuralStems) deck.position = inputTime;
          });
        }
        map[stem] = st;
      })
    );
    deck.stemStretches = map;
    return map;
  }

  #ensureWorker() {
    if (!this.worker) {
      this.worker = new Worker('/js/engine/analysis-worker.js', { type: 'module' });
      this.worker.onmessage = (ev) => {
        const { id, ok, analysis, error } = ev.data;
        const p = this.workerPending.get(id);
        if (!p) return;
        this.workerPending.delete(id);
        if (ok) p.resolve(analysis);
        else p.reject(new Error(error || 'DSP analysis error'));
      };
    }
    return this.worker;
  }

  async #fetchAndDecodeStemPaths(stemsMap, baseProxy = true) {
    const decoded = {};
    await Promise.all(
      STEM_NAMES.map(async (s) => {
        const p = stemsMap?.[s];
        if (!p) return;
        const url = baseProxy ? `/api/analyze?stemPath=${encodeURIComponent(p)}` : p;
        const r = await fetch(url);
        if (!r.ok) return;
        const ab = await r.arrayBuffer();
        decoded[s] = await this.ctx.decodeAudioData(ab);
      })
    );
    return STEM_NAMES.every((s) => decoded[s]) ? decoded : null;
  }

  #sumStemBuffers(stemBuffers) {
    const ref = stemBuffers.drums || stemBuffers.vocals;
    const numCh = Math.min(2, Math.max(1, ref.numberOfChannels));
    const len = ref.length;
    const sum = this.ctx.createBuffer(numCh, len, ref.sampleRate);
    for (let c = 0; c < numCh; c++) {
      const dst = sum.getChannelData(c);
      for (const s of STEM_NAMES) {
        const src = stemBuffers[s]?.getChannelData(Math.min(c, stemBuffers[s].numberOfChannels - 1));
        if (!src) continue;
        const n = Math.min(len, src.length);
        for (let i = 0; i < n; i++) dst[i] += src[i];
      }
      for (let i = 0; i < len; i++) dst[i] = Math.max(-0.99, Math.min(0.99, dst[i]));
    }
    return sum;
  }

  async decodeAndAnalyze(track, onProgress) {
    if (this.decodedCache.has(track.id)) {
      return this.decodedCache.get(track.id);
    }
    await this.ensureContext();
    onProgress?.(`Decoding ${track.title}…`);

    let stemBuffers = null;
    let workerAnalysis = null;

    // Path A: User dropped a 4-stem Demucs bundle (*_vocals, *_drums, *_bass, *_other)
    if (track.stemFiles && STEM_NAMES.every((s) => track.stemFiles[s])) {
      onProgress?.(`Decoding 4 isolated Demucs stems for ${track.title}…`);
      stemBuffers = {};
      await Promise.all(
        STEM_NAMES.map(async (s) => {
          const ab = await track.stemFiles[s].arrayBuffer();
          stemBuffers[s] = await this.ctx.decodeAudioData(ab);
        })
      );
    } else if (track.stemUrls && STEM_NAMES.every((s) => track.stemUrls[s])) {
      onProgress?.(`Fetching 4 neural stems for ${track.title}…`);
      stemBuffers = await this.#fetchAndDecodeStemPaths(track.stemUrls, false).catch(() => null);
    } else if (track.analysis?.stems && STEM_NAMES.every((s) => track.analysis.stems[s])) {
      stemBuffers = await this.#fetchAndDecodeStemPaths(track.analysis.stems, true).catch(() => null);
    } else if (this.workerConfigured && track.streamUrl) {
      // Path B: Optional Python GPU Worker via /api/analyze (Demucs + WhisperX + Multi-Tracker)
      try {
        onProgress?.(`Running GPU Demucs 4-stem extraction for ${track.title}…`);
        const wr = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: track.streamUrl, song_id: track.id, filename: `${track.title}.mp3` }),
        });
        const wd = wr.ok ? await wr.json() : null;
        if (wd?.stems) {
          workerAnalysis = wd;
          stemBuffers = await this.#fetchAndDecodeStemPaths(wd.stems, true).catch(() => null);
        }
      } catch {}
    }

    let buffer = null;
    if (track.file) {
      if (track.file.size > 180 * 1024 * 1024) {
        throw new Error(`${track.title} exceeds 180 MB browser decode limit.`);
      }
      const bytes = await track.file.arrayBuffer();
      buffer = await this.ctx.decodeAudioData(bytes);
    } else if (track.streamUrl) {
      const res = await fetch(track.streamUrl, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`Stream unavailable (HTTP ${res.status})`);
      const bytes = await res.arrayBuffer();
      buffer = await this.ctx.decodeAudioData(bytes);
    } else if (stemBuffers) {
      buffer = this.#sumStemBuffers(stemBuffers);
    } else {
      throw new Error('Track has no decodable local file, stem bundle, or CORS stream.');
    }

    if (buffer.duration < 10) throw new Error('Track is shorter than 10 seconds.');

    onProgress?.(`Analyzing beatgrid, downbeats, stems & key for ${track.title}…`);
    const ch0 = buffer.getChannelData(0);
    let mono;
    let side = null;
    const transfers = [];
    if (buffer.numberOfChannels > 1) {
      const ch1 = buffer.getChannelData(1);
      mono = new Float32Array(ch0.length);
      side = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) {
        mono[i] = 0.5 * (ch0[i] + ch1[i]);
        side[i] = 0.5 * (ch0[i] - ch1[i]);
      }
      transfers.push(mono.buffer, side.buffer);
    } else {
      mono = new Float32Array(ch0);
      transfers.push(mono.buffer);
    }

    const worker = this.#ensureWorker();
    const reqId = ++this.workerReqId;
    let analysis = await new Promise((resolve, reject) => {
      this.workerPending.set(reqId, { resolve, reject });
      worker.postMessage({ id: reqId, mono, side, sampleRate: buffer.sampleRate }, transfers);
    });

    if (workerAnalysis) {
      analysis = {
        ...analysis,
        ...workerAnalysis,
        durationSec: analysis.durationSec,
        heat: analysis.heat,
        spectrum: analysis.spectrum,
        neuralStems: Boolean(stemBuffers),
      };
    } else if (stemBuffers) {
      analysis.neuralStems = true;
    }

    const record = { buffer, stemBuffers, analysis };
    this.decodedCache.set(track.id, record);
    return record;
  }

  async loadDeck(deckId, track, { gain = 0, playMode = 'club' } = {}) {
    const deck = this.decks[deckId];
    if (!deck) throw new Error(`Unknown deck ${deckId}`);
    const record = await this.decodeAndAnalyze(track);
    const { buffer, stemBuffers, analysis } = record;

    await this.stopDeck(deckId);
    deck.track = track;
    deck.buffer = buffer;
    deck.stemBuffers = stemBuffers || null;
    deck.neuralStems = Boolean(stemBuffers && STEM_NAMES.every((s) => stemBuffers[s]));
    deck.analysis = analysis;
    deck.strip.setNeuralMode(deck.neuralStems, this.ctx.currentTime);

    const entrySec = playMode === 'hooks' ? analysis.hookEntry : analysis.clubEntry;
    const exitSec =
      playMode === 'hooks'
        ? analysis.hookExit
        : playMode === 'festival'
          ? Math.min(analysis.durationSec - 4, Math.max(entrySec + 75, Math.round(analysis.durationSec * 0.76)))
          : analysis.clubExit;
    track.durationSec = analysis.durationSec;
    track.bpm = analysis.bpm;
    track.key = analysis.key;
    track.camelot = analysis.camelot;
    track.energy = analysis.energy;
    track.heat = analysis.heat;
    track.lufs = analysis.lufs;
    track.neuralStems = deck.neuralStems;
    if (track.cueConfidence !== 'user') {
      track.entrySec = entrySec;
      track.exitSec = exitSec;
    }

    const lufs = Number.isFinite(analysis.lufs) ? analysis.lufs : -13;
    const trimDb = Math.max(-6, Math.min(6, -13 - lufs));
    const trimGain = Math.pow(10, trimDb / 20);
    deck.strip.lufsTrim.gain.setValueAtTime(trimGain, this.ctx.currentTime);
    deck.strip.deckVolume.gain.setValueAtTime(gain, this.ctx.currentTime);
    deck.strip.resetAll(this.ctx.currentTime);
    deck.position = track.playFull ? 0 : track.entrySec;
    deck.loopActive = false;

    if (deck.neuralStems) {
      const stMap = await this.#ensureStemStretches(deck);
      await Promise.all(
        STEM_NAMES.map(async (s) => {
          const st = stMap[s];
          const sBuf = deck.stemBuffers[s];
          await st.dropBuffers();
          const chans = [];
          for (let c = 0; c < Math.min(2, sBuf.numberOfChannels); c++) {
            chans.push(new Float32Array(sBuf.getChannelData(c)));
          }
          await st.addBuffers(chans);
        })
      );
    } else if (deck.stretch) {
      await deck.stretch.dropBuffers();
      const chans = [];
      for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
        chans.push(new Float32Array(buffer.getChannelData(c)));
      }
      await deck.stretch.addBuffers(chans);
    }

    return { deck, analysis };
  }

  async playDeck(deckId, { offsetSec, rate = 1, semitones = 0, when = null, gain = 1 } = {}) {
    const deck = this.decks[deckId];
    if (!deck || !deck.buffer) return;
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch {}
    }
    const t = when ?? this.ctx.currentTime + 0.14;
    const pos = Math.max(0, Math.min(deck.buffer.duration - 0.5, offsetSec ?? deck.position));

    deck.rate = rate;
    deck.semitones = semitones;
    deck.position = pos;
    deck.playing = true;
    deck.startedAtCtx = t;
    deck.startedOffset = pos;

    deck.strip.deckVolume.gain.cancelScheduledValues(t);
    deck.strip.deckVolume.gain.setValueAtTime(gain, t);

    const stretches = this.#getDeckStretches(deck);
    if (stretches.length) {
      await Promise.all(
        stretches.map((st) =>
          st.schedule({
            output: t,
            outputTime: t,
            active: true,
            input: pos,
            rate,
            semitones: this.masterTempoEnabled ? semitones : 0,
            formantCompensation: true,
            loopStart: 0,
            loopEnd: 0,
          })
        )
      );
    } else if (deck.neuralStems && deck.stemBuffers) {
      for (const src of deck.stemFallbackSources || []) {
        try { src.stop(); } catch {}
      }
      deck.stemFallbackSources = STEM_NAMES.map((s) => {
        const src = this.ctx.createBufferSource();
        src.buffer = deck.stemBuffers[s];
        src.playbackRate.setValueAtTime(rate, t);
        src.connect(deck.strip.stemInputs[s]);
        src.start(t, pos);
        return src;
      });
    } else {
      if (deck.fallbackSource) {
        try { deck.fallbackSource.stop(); } catch {}
      }
      const src = this.ctx.createBufferSource();
      src.buffer = deck.buffer;
      src.playbackRate.setValueAtTime(rate, t);
      src.connect(deck.strip.input);
      src.start(t, pos);
      deck.fallbackSource = src;
    }
  }

  async stopDeck(deckId) {
    const deck = this.decks[deckId];
    if (!deck) return;
    deck.playing = false;
    deck.loopActive = false;
    const now = this.ctx ? this.ctx.currentTime : 0;
    const t = now + 0.03;
    const stretches = this.#getDeckStretches(deck);
    if (stretches.length) {
      await Promise.all(
        stretches.map((st) =>
          st.schedule({
            output: t,
            outputTime: t,
            active: false,
            rate: 1,
            semitones: 0,
            loopStart: 0,
            loopEnd: 0,
          }).catch(() => {})
        )
      );
    }
    if (deck.fallbackSource) {
      try { deck.fallbackSource.stop(t); } catch {}
      deck.fallbackSource = null;
    }
    for (const src of deck.stemFallbackSources || []) {
      try { src.stop(t); } catch {}
    }
    deck.stemFallbackSources = [];
  }

  async pauseDeck(deckId) {
    const deck = this.decks[deckId];
    if (!deck || !deck.playing) return;
    deck.position = this.getDeckPosition(deckId);
    deck.playing = false;
    const t = this.ctx.currentTime + 0.03;
    const stretches = this.#getDeckStretches(deck);
    if (stretches.length) {
      await Promise.all(stretches.map((st) => st.schedule({ output: t, outputTime: t, active: false })));
    } else {
      if (deck.fallbackSource) {
        try { deck.fallbackSource.stop(); } catch {}
        deck.fallbackSource = null;
      }
      for (const src of deck.stemFallbackSources || []) {
        try { src.stop(); } catch {}
      }
      deck.stemFallbackSources = [];
    }
  }

  async resumeDeck(deckId) {
    const deck = this.decks[deckId];
    if (!deck || !deck.buffer || deck.playing) return;
    const currentVol = deck.strip.deckVolume.gain.value || 1;
    await this.playDeck(deckId, {
      offsetSec: deck.position,
      rate: deck.rate,
      semitones: deck.semitones,
      gain: currentVol,
    });
  }

  async seekDeck(deckId, targetSec) {
    const deck = this.decks[deckId];
    if (!deck || !deck.buffer) return;
    const clamped = Math.max(0, Math.min(deck.buffer.duration - 0.5, targetSec));
    deck.position = clamped;
    deck.startedOffset = clamped;
    deck.startedAtCtx = this.ctx.currentTime + 0.03;
    if (deck.playing) {
      await this.playDeck(deckId, {
        offsetSec: clamped,
        rate: deck.rate,
        semitones: deck.semitones,
        gain: deck.strip.deckVolume.gain.value || 1,
      });
    }
  }

  getDeckPosition(deckId) {
    const deck = this.decks[deckId];
    if (!deck) return 0;
    if (this.#getDeckStretches(deck).length) return deck.position;
    if (!deck.playing || !this.ctx) return deck.position;
    const elapsed = Math.max(0, this.ctx.currentTime - deck.startedAtCtx);
    return Math.min(deck.buffer?.duration || 0, deck.startedOffset + elapsed * deck.rate);
  }

  async toggleLoopBars(deckId, bars = 4) {
    const deck = this.decks[deckId];
    if (!deck || !deck.playing || !deck.analysis) return false;
    const bpm = (deck.analysis.bpm || 120) * deck.rate;
    const barDur = (60 / bpm) * 4;
    const stretches = this.#getDeckStretches(deck);
    if (deck.loopActive) {
      deck.loopActive = false;
      await Promise.all(
        stretches.map((st) =>
          st.schedule({
            output: this.ctx.currentTime + 0.03,
            outputTime: this.ctx.currentTime + 0.03,
            loopStart: 0,
            loopEnd: 0,
          })
        )
      );
      return false;
    }
    const pos = this.getDeckPosition(deckId);
    const beats = deck.analysis.downbeats?.length ? deck.analysis.downbeats : deck.analysis.beats || [];
    const anchor = beats.reduce((best, b) => (Math.abs(b - pos) < Math.abs(best - pos) ? b : best), pos);
    const loopStart = Math.max(0, anchor);
    const loopEnd = Math.min(deck.buffer.duration - 0.2, loopStart + barDur * bars);
    deck.loopActive = true;
    deck.loopStart = loopStart;
    deck.loopEnd = loopEnd;
    await Promise.all(
      stretches.map((st) =>
        st.schedule({
          output: this.ctx.currentTime + 0.03,
          outputTime: this.ctx.currentTime + 0.03,
          loopStart,
          loopEnd,
        })
      )
    );
    return true;
  }

  /**
   * Computes which of the 8 pro club transition choreographies fits best
   * and schedules quantized beat-aligned parameter curves on both decks.
   */
  planTransition(outDeckId, inDeckId, { vibe = 'peak', playMode = 'club', overrideStyle = null } = {}) {
    const outDeck = this.decks[outDeckId];
    const inDeck = this.decks[inDeckId];
    const a = outDeck?.analysis;
    const b = inDeck?.analysis;

    const outBpm = (a?.bpm || 120) * (outDeck?.rate || 1);
    const inBpm = b?.bpm || outBpm;
    const bpmDeltaPct = inBpm ? (Math.abs(outBpm - inBpm) / inBpm) * 100 : 100;
    const tempoMatchable = bpmDeltaPct <= 12;
    const targetRate = tempoMatchable ? Math.max(0.88, Math.min(1.13, outBpm / inBpm)) : 1;

    const harmonic = getHarmonicMatch(a?.camelot, b?.camelot);
    const semitones = this.autoKeyLockEnabled ? harmonic.semitoneShift : 0;

    // Choose transition style dynamically from track DNA & DJ vibe
    let style = overrideStyle;
    if (!style) {
      if (!tempoMatchable) {
        style = vibe === 'bangers' ? 'TENSION_ROLL_DROP' : 'ECHO_OUT_BRAKE';
      } else if (this.drumBridgeEnabled) {
        style = 'PERCUSSION_BRIDGE';
      } else if ((a?.spectrum?.vocal || 0) > 0.36 && (b?.spectrum?.vocal || 0) > 0.36) {
        style = 'STEM_VOCAL_PASS';
      } else if (vibe === 'bangers' || playMode === 'festival') {
        style = 'DROP_SWAP';
      } else if (harmonic.score >= 28 && vibe === 'winddown') {
        style = 'HARMONIC_BLEND';
      } else if ((b?.energy || 7) < (a?.energy || 7) - 2) {
        style = 'BREAKDOWN_BRIDGE';
      } else {
        style = 'BASS_SWAP_16BAR';
      }
    }

    const bars =
      style === 'ECHO_OUT_BRAKE' ? 4 :
      style === 'TENSION_ROLL_DROP' ? 4 :
      style === 'DROP_SWAP' ? 8 :
      playMode === 'hooks' ? 8 : 16;

    const beatSec = 60 / Math.max(60, outBpm);
    const outPlayable = Math.max(4, (outDeck.track?.exitSec || outDeck.buffer?.duration || 180) - this.getDeckPosition(outDeckId));
    const maxSafeSec = Math.max(2.5, Math.min(28, outPlayable * 0.48));
    const durationSec = Math.min(maxSafeSec, Math.max(2.5, bars * 4 * beatSec));

    // Align incoming entry precisely to Deck B's nearest Bar 1 downbeat for exact beat-phase lock!
    const rawEntry = inDeck.track?.playFull
      ? (b?.downbeats?.[0] || 0)
      : (inDeck.track?.entrySec ?? b?.clubEntry ?? 0);
    const inDownbeats = b?.downbeats?.length ? b.downbeats : b?.beats || [];
    let inOffset = rawEntry;
    if (inDownbeats.length && inDeck.track?.cueConfidence !== 'user') {
      const snapped = inDownbeats.reduce((best, d) =>
        Math.abs(d - rawEntry) < Math.abs(best - rawEntry) ? d : best,
        inDownbeats[0]
      );
      if (Math.abs(snapped - rawEntry) <= Math.max(2.5, beatSec * 4)) {
        inOffset = snapped;
      }
    }

    return {
      style,
      bars,
      durationSec,
      outBpm,
      inBpm,
      bpmDeltaPct: Math.round(bpmDeltaPct * 10) / 10,
      tempoMatchable,
      incomingRate: targetRate,
      semitones,
      harmonic,
      inOffset,
    };
  }

  /**
   * Executes a scheduled multi-bar club transition synchronized to the next
   * Beat 1 downbeat on the outgoing deck.
   */
  async executeTransition(outDeckId, inDeckId, plan) {
    const outDeck = this.decks[outDeckId];
    const inDeck = this.decks[inDeckId];
    if (!outDeck || !inDeck || !inDeck.buffer) return;

    const now = this.ctx.currentTime;
    // Quantize transition start to outgoing Beat 1 (with >= 0.16s headroom so SignalsmithStretch latency-compensates cleanly)
    let startAt = now + 0.16;
    const outPos = this.getDeckPosition(outDeckId);
    const grid = outDeck.analysis?.downbeats?.length ? outDeck.analysis.downbeats : outDeck.analysis?.beats || [];
    const nextBeat = grid.find((b) => b >= outPos + 0.16 && b <= outPos + 2.4);
    if (nextBeat !== undefined) {
      startAt = Math.max(now + 0.16, now + (nextBeat - outPos) / Math.max(0.5, outDeck.rate));
    }

    const dur = plan.durationSec;
    const endAt = startAt + dur;
    const beatSec = 60 / Math.max(60, plan.outBpm);

    // Tempo-lock stereo echo delay to 1/2 beat & dotted 1/4 beat!
    this.echoDelayL.delayTime.setValueAtTime(beatSec * 0.5, startAt);
    this.echoDelayR.delayTime.setValueAtTime(beatSec * 0.75, startAt);

    // Start incoming deck muted or filtered right on Beat 1
    await this.playDeck(inDeckId, {
      offsetSec: plan.inOffset,
      rate: plan.incomingRate,
      semitones: plan.semitones,
      when: startAt,
      gain: 0.001,
    });

    const outGain = outDeck.strip.deckVolume.gain;
    const inGain = inDeck.strip.deckVolume.gain;

    // Equal-power fade curve helper
    const makeCurve = (isIn) => {
      const arr = new Float32Array(64);
      for (let i = 0; i < 64; i++) {
        const p = i / 63;
        arr[i] = isIn ? Math.sin((p * Math.PI) / 2) : Math.cos((p * Math.PI) / 2);
      }
      return arr;
    };

    const style = plan.style;
    outGain.cancelScheduledValues(startAt);
    inGain.cancelScheduledValues(startAt);

    if (style === 'BASS_SWAP_16BAR' || style === 'HARMONIC_BLEND') {
      // Bring in Track B high-passed & bass-killed -> Instant Downbeat Bass Swap at 50% -> Smooth exit
      inDeck.strip.setStem('bass', 0.02, startAt, 0.02);
      inDeck.strip.setColorFilter(0.32, startAt, 0.02);
      inGain.setValueAtTime(0.001, startAt);
      inGain.linearRampToValueAtTime(0.88, startAt + dur * 0.28);
      inGain.linearRampToValueAtTime(1.0, endAt);
      inDeck.strip.setColorFilter(0, startAt + dur * 0.25, dur * 0.15);

      const swapAt = startAt + dur * 0.5;
      outDeck.strip.setStem('bass', 0.02, swapAt, 0.03);
      inDeck.strip.setStem('bass', 1.0, swapAt, 0.03);

      outGain.setValueAtTime(1.0, startAt);
      outGain.setValueAtTime(0.92, swapAt);
      outGain.linearRampToValueAtTime(0.0001, endAt);
    } else if (style === 'STEM_VOCAL_PASS') {
      // Zero Vocal Clash: Duck Track A vocals & keep Track A drums/bass while Track B enters!
      outDeck.strip.setStem('vocals', 0.18, startAt, 0.18);
      inDeck.strip.setStem('bass', 0.02, startAt, 0.02);
      inGain.setValueCurveAtTime(makeCurve(true), startAt, dur * 0.85);

      const swapAt = startAt + dur * 0.45;
      outDeck.strip.setStem('bass', 0.02, swapAt, 0.03);
      inDeck.strip.setStem('bass', 1.0, swapAt, 0.03);

      outGain.setValueAtTime(1.0, startAt);
      outGain.setValueCurveAtTime(makeCurve(false), startAt + dur * 0.25, dur * 0.75);
    } else if (style === 'DROP_SWAP') {
      // Rising HPF sweep + echo wash on A -> Hard slam drop into B!
      outDeck.strip.setColorFilter(0.75, startAt, dur * 0.65);
      outDeck.strip.echoSend.gain.setValueAtTime(0, startAt);
      outDeck.strip.echoSend.gain.linearRampToValueAtTime(0.45, startAt + dur * 0.65);
      outDeck.strip.echoSend.gain.linearRampToValueAtTime(0, endAt);
      this.echoFeedback.gain.setValueAtTime(0.46, startAt);
      this.echoFeedback.gain.setValueAtTime(0.36, endAt);

      inDeck.strip.setStem('bass', 0.05, startAt, 0.02);
      inGain.setValueAtTime(0.001, startAt);
      inGain.linearRampToValueAtTime(0.65, startAt + dur * 0.68);
      inGain.setValueAtTime(1.0, startAt + dur * 0.72);
      inDeck.strip.setStem('bass', 1.0, startAt + dur * 0.72, 0.02);

      outGain.setValueAtTime(1.0, startAt);
      outGain.linearRampToValueAtTime(0.0001, startAt + dur * 0.76);
    } else if (style === 'TENSION_ROLL_DROP') {
      // 4-bar beat roll tension on Deck A (loop last 1 bar -> half bar) + filter rise -> slam B
      const rollAnchor = outPos + (startAt - now) * Math.max(0.5, outDeck.rate);
      const t1 = startAt;
      const t2 = startAt + dur * 0.5;
      for (const st of this.#getDeckStretches(outDeck)) {
        st.schedule({ output: t1, outputTime: t1, loopStart: Math.max(0, rollAnchor - beatSec * 2), loopEnd: Math.max(0.2, rollAnchor) });
        st.schedule({ output: t2, outputTime: t2, loopStart: Math.max(0, rollAnchor - beatSec), loopEnd: Math.max(0.1, rollAnchor) });
      }
      outDeck.strip.setColorFilter(0.82, startAt, dur * 0.75);
      outDeck.strip.echoSend.gain.setValueAtTime(0.1, startAt);
      outDeck.strip.echoSend.gain.linearRampToValueAtTime(0.48, startAt + dur * 0.8);
      outDeck.strip.echoSend.gain.linearRampToValueAtTime(0, endAt);
      outGain.setValueAtTime(1.0, startAt);
      outGain.setValueAtTime(1.0, startAt + dur * 0.82);
      outGain.linearRampToValueAtTime(0.0001, endAt);

      inGain.setValueAtTime(0.001, startAt);
      inGain.setValueAtTime(0.001, startAt + dur * 0.8);
      inGain.linearRampToValueAtTime(1.0, startAt + dur * 0.86);
    } else if (style === 'ECHO_OUT_BRAKE') {
      // Big BPM gap: 1/2-beat echo wash + subtle vinyl brake pitch-down on A -> clean B entry!
      outDeck.strip.echoSend.gain.setValueAtTime(0, startAt);
      outDeck.strip.echoSend.gain.linearRampToValueAtTime(0.55, startAt + dur * 0.45);
      outDeck.strip.echoSend.gain.linearRampToValueAtTime(0, endAt);
      this.echoFeedback.gain.setValueAtTime(0.5, startAt);
      this.echoFeedback.gain.setValueAtTime(0.36, endAt);
      const brakeAt = startAt + dur * 0.3;
      for (const st of this.#getDeckStretches(outDeck)) {
        st.schedule({ output: brakeAt, outputTime: brakeAt, rate: 0.78, semitones: -4 });
      }
      outGain.setValueAtTime(1.0, startAt);
      outGain.linearRampToValueAtTime(0.0001, startAt + dur * 0.65);

      inGain.setValueAtTime(0.001, startAt);
      inGain.setValueAtTime(0.001, startAt + dur * 0.45);
      inGain.linearRampToValueAtTime(1.0, startAt + dur * 0.55);
    } else if (style === 'PERCUSSION_BRIDGE') {
      this.#schedulePercussionBridge(startAt, plan.outBpm, plan.bars);
      outGain.setValueCurveAtTime(makeCurve(false), startAt, dur);
      inGain.setValueCurveAtTime(makeCurve(true), startAt, dur);
    } else {
      // BREAKDOWN_BRIDGE
      outGain.setValueCurveAtTime(makeCurve(false), startAt, dur);
      inGain.setValueCurveAtTime(makeCurve(true), startAt, dur);
    }

    // Smoothly ramp incoming track tempo back toward its natural BPM after transition finishes if needed
    return { startAt, endAt };
  }

  /**
   * Lookahead Beat-Grid Metronome Overlay (verifies detected beats & downbeats by ear)
   */
  scheduleClickLookahead(deckId) {
    if (!this.clickTrackEnabled || !this.ctx) return;
    const deck = this.decks[deckId];
    if (!deck || !deck.playing || !deck.analysis?.beat_times?.length) return;
    const pos = this.getDeckPosition(deckId);
    const rate = Math.max(0.5, deck.rate || 1);
    const lookAheadInputSec = 0.25 * rate;
    const beats = deck.analysis.beat_times;
    const dbs = new Set((deck.analysis.downbeat_times || []).map((t) => Math.round(t * 10)));

    for (let i = 0; i < beats.length; i++) {
      const bt = beats[i];
      if (bt <= pos - 0.02 || bt > pos + lookAheadInputSec) continue;
      if (i <= this.lastScheduledBeatIdx && Math.abs(i - this.lastScheduledBeatIdx) < 400) continue;
      this.lastScheduledBeatIdx = i;
      const at = this.ctx.currentTime + Math.max(0.01, (bt - pos) / rate);
      const isDown = dbs.has(Math.round(bt * 10)) || i % 4 === 0;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(isDown ? 1580 : 940, at);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(isDown ? 0.24 : 0.12, at + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.055);
      osc.connect(g);
      g.connect(this.ctx.destination);
      osc.start(at);
      osc.stop(at + 0.065);
    }
  }

  /**
   * Executes a complete Phase 2/3 validated JSON transition recipe on AudioContext.currentTime.
   * Supports all 14 Phase 5 templates + stem curves + 3-band EQ kills + spinback/stutter + genre drums.
   */
  async executeRecipe(outDeckId, inDeckId, recipe) {
    const outDeck = this.decks[outDeckId];
    const inDeck = this.decks[inDeckId];
    if (!outDeck || !inDeck || !inDeck.buffer) return { startAt: this.ctx.currentTime, endAt: this.ctx.currentTime + 4 };

    const now = this.ctx.currentTime;
    const outPos = this.getDeckPosition(outDeckId);
    const outBpm = (outDeck.analysis?.bpm || 120) * (outDeck.rate || 1);
    const beatSec = 60 / Math.max(55, outBpm);
    const barSec = beatSec * 4;

    const grid = outDeck.analysis?.downbeat_times?.length ? outDeck.analysis.downbeat_times : outDeck.analysis?.beats || [];
    let startAt = now + 0.16;
    const nextBeat = grid.find((b) => b >= outPos + 0.16 && b <= outPos + barSec + 0.4);
    if (nextBeat !== undefined) {
      startAt = Math.max(now + 0.16, now + (nextBeat - outPos) / Math.max(0.5, outDeck.rate || 1));
    }

    const durBars = Math.max(2, Number(recipe.length_bars) || 16);
    const rawDur = durBars * barSec;
    const outRem = Math.max(3, (outDeck.buffer.duration - outPos) * 0.72);
    const dur = Math.min(rawDur, Math.max(2.5, Math.min(36, outRem)));
    const barUnit = dur / durBars;
    const endAt = startAt + dur;

    const stretchFrom = Number(recipe.tempo_plan?.stretch_from || inDeck.analysis?.bpm || outBpm);
    const stretchTo = Number(recipe.tempo_plan?.stretch_to || outBpm);
    let rate = outBpm / Math.max(55, stretchFrom);
    if (Math.abs(rate - 2.0) < 0.16) rate *= 0.5;
    else if (Math.abs(rate - 0.5) < 0.08) rate *= 2.0;
    const safeRate = clampRecipeRate(rate, recipe.type);
    const semitones = Math.max(-2, Math.min(2, Number(recipe.tempo_plan?.pitch_shift_semitones || 0)));

    // Compute exact Bar 1 downbeat entry on Deck B from mix_in_bar
    const inBarObj = inDeck.analysis?.bars?.[recipe.mix_in_bar];
    const inOffset = inBarObj ? inBarObj.start_sec : Math.max(0, (recipe.mix_in_bar || 0) * (240 / Math.max(55, stretchFrom)));

    this.echoDelayL.delayTime.setValueAtTime(beatSec * 0.5, startAt);
    this.echoDelayR.delayTime.setValueAtTime(beatSec * 0.75, startAt);

    await this.playDeck(inDeckId, {
      offsetSec: Math.min(inDeck.buffer.duration - 2, inOffset),
      rate: safeRate,
      semitones,
      when: startAt,
      gain: 0.001,
    });

    const outGain = outDeck.strip.deckVolume.gain;
    const inGain = inDeck.strip.deckVolume.gain;
    outGain.cancelScheduledValues(startAt);
    inGain.cancelScheduledValues(startAt);

    // Apply stem_layers gain automation curves
    const applyDeckCurve = (deck, songId, defStartGain, defEndGain) => {
      const volParam = deck.strip.deckVolume.gain;
      const allLayer = (recipe.stem_layers || []).find((s) => s.song === songId && s.stem === 'all');
      if (allLayer?.gain_curve?.length) {
        volParam.setValueAtTime(Math.max(0.0001, allLayer.gain_curve[0][1]), startAt);
        for (const [b, g] of allLayer.gain_curve) {
          const at = startAt + Math.max(0, Math.min(durBars, b)) * barUnit;
          volParam.linearRampToValueAtTime(Math.max(0.0001, Math.min(1.15, g)), at);
        }
      } else {
        volParam.setValueAtTime(defStartGain, startAt);
        volParam.linearRampToValueAtTime(defEndGain, endAt);
      }

      for (const layer of (recipe.stem_layers || []).filter((s) => s.song === songId && s.stem !== 'all')) {
        if (!layer.gain_curve?.length) continue;
        for (const [b, g] of layer.gain_curve) {
          const at = startAt + Math.max(0, Math.min(durBars, b)) * barUnit;
          deck.strip.setStem(layer.stem, g, at, 0.06);
        }
      }
    };

    applyDeckCurve(outDeck, outDeck.track?.id || recipe.from, 1.0, 0.0001);
    applyDeckCurve(inDeck, inDeck.track?.id || recipe.to, 0.001, 1.0);

    // Apply 3-band EQ automation points
    for (const eq of recipe.eq_automation || []) {
      const targetDeck = eq.deck === 'A' ? outDeck : inDeck;
      if (!eq.points?.length) continue;
      for (const [b, db] of eq.points) {
        const at = startAt + Math.max(0, Math.min(durBars, b)) * barUnit;
        targetDeck.strip.setEqBand(eq.band, db, at, 0.04);
      }
    }

    // Apply filter automation points
    for (const fl of recipe.filter_automation || []) {
      const targetDeck = fl.deck === 'A' ? outDeck : inDeck;
      for (const [b, val] of fl.curve || []) {
        const at = startAt + Math.max(0, Math.min(durBars, b)) * barUnit;
        targetDeck.strip.setColorFilter(val, at, 0.06);
      }
    }

    // Apply FX events (echo, reverb, loop_roll, spinback, riser_impact, impact)
    for (const fxItem of recipe.fx || []) {
      const at = startAt + Math.max(0, Math.min(durBars, fxItem.start_bar || 0)) * barUnit;
      if (fxItem.type === 'echo') {
        const lvl = fxItem.params?.level ?? 0.5;
        outDeck.strip.echoSend.gain.setValueAtTime(0, startAt);
        outDeck.strip.echoSend.gain.linearRampToValueAtTime(lvl, at + dur * 0.45);
        outDeck.strip.echoSend.gain.linearRampToValueAtTime(0, endAt);
      } else if (fxItem.type === 'reverb') {
        const lvl = fxItem.params?.level ?? 0.55;
        outDeck.strip.reverbSend.gain.setValueAtTime(0, startAt);
        outDeck.strip.reverbSend.gain.linearRampToValueAtTime(lvl, at + dur * 0.55);
        outDeck.strip.reverbSend.gain.linearRampToValueAtTime(0, endAt);
      } else if (fxItem.type === 'loop_roll') {
        const anchor = outPos + (startAt - now) * Math.max(0.5, outDeck.rate);
        const halfAt = at + dur * 0.45;
        for (const st of this.#getDeckStretches(outDeck)) {
          st.schedule({ output: at, outputTime: at, loopStart: Math.max(0, anchor - beatSec * 2), loopEnd: Math.max(0.2, anchor) });
          st.schedule({ output: halfAt, outputTime: halfAt, loopStart: Math.max(0, anchor - beatSec), loopEnd: Math.max(0.1, anchor) });
        }
      } else if (fxItem.type === 'spinback') {
        const steps = 6;
        for (const st of this.#getDeckStretches(outDeck)) {
          for (let s = 0; s < steps; s++) {
            const stAt = at + (s / steps) * 0.85;
            st.schedule({ output: stAt, outputTime: stAt, rate: 1 - (s / steps) * 0.72, semitones: -s * 2 });
          }
        }
      } else if (fxItem.type === 'riser_impact' || fxItem.type === 'impact' || fxItem.type === 'reverse_riser') {
        this.playTransitionSweepFx({ type: fxItem.type === 'reverse_riser' ? 'echo_drop' : 'sweep_cut', bpm: outBpm, durationSec: Math.min(6, dur * 0.85) });
      } else if (fxItem.type === 'stutter') {
        const div = Number(fxItem.params?.division_beats) || 0.25;
        const repeats = Math.min(16, Number(fxItem.params?.repeats) || 8);
        const stepSec = beatSec * div;
        for (let s = 0; s < repeats; s++) {
          const stAt = at + s * stepSec;
          outGain.setValueAtTime(1.0, stAt);
          outGain.setValueAtTime(0.05, stAt + stepSec * 0.52);
        }
      } else if (fxItem.type === 'key_lift') {
        const liftSemi = Math.max(-2, Math.min(2, Number(fxItem.params?.semitones) || 1));
        const liftAt = startAt + dur * 0.5;
        for (const st of this.#getDeckStretches(inDeck)) {
          st.schedule({ output: liftAt, outputTime: liftAt, semitones: liftSemi });
        }
      }
    }

    // Apply genre-matched added_drums bridge (Dhol / Tabla / House / Trap)
    if (recipe.added_drums) {
      const style = recipe.added_drums.style || 'house';
      const drGain = Math.min(0.32, Number(recipe.added_drums.gain) || 0.22);
      const drStart = startAt + Math.max(0, Number(recipe.added_drums.start_bar) || 0) * barUnit;
      const drBars = Math.max(2, (Number(recipe.added_drums.end_bar) || durBars) - (Number(recipe.added_drums.start_bar) || 0));
      this.#schedulePercussionBridge(drStart, outBpm, drBars, style, drGain);
    }

    return { startAt, endAt };
  }

  /**
   * Per-bar drift monitor comparing AudioContext playback clock against measured downbeat grid.
   * Applies subtle +-0.4% pitch-locked rate micro-nudges across all active stem lanes if drift exceeds 15 ms.
   */
  checkDriftAndCorrect(deckId) {
    const deck = this.decks[deckId];
    const stretches = this.#getDeckStretches(deck);
    if (!deck || !deck.playing || !deck.analysis?.beat_times?.length || !this.ctx || !stretches.length) return 0;
    const now = this.ctx.currentTime;
    if (deck.lastDriftCheckAt && now - deck.lastDriftCheckAt < 1.8) return 0;
    deck.lastDriftCheckAt = now;

    const pos = this.getDeckPosition(deckId);
    const beats = deck.analysis.beat_times;
    let nearest = beats[0];
    let minDiff = Infinity;
    for (let i = 0; i < beats.length; i++) {
      const d = Math.abs(beats[i] - pos);
      if (d < minDiff) {
        minDiff = d;
        nearest = beats[i];
      }
    }
    const driftMs = (pos - nearest) * 1000;
    if (Math.abs(driftMs) > 15 && Math.abs(driftMs) < 95) {
      const nudge = driftMs > 0 ? 0.996 : 1.004;
      for (const st of stretches) {
        st.schedule({ output: now + 0.04, outputTime: now + 0.04, rate: (deck.rate || 1) * nudge }).catch(() => {});
        st.schedule({ output: now + 0.44, outputTime: now + 0.44, rate: deck.rate || 1 }).catch(() => {});
      }
    }
    return Math.round(driftMs);
  }

  async triggerSpinback(deckId) {
    const deck = this.decks[deckId];
    if (!deck?.playing) return;
    const now = this.ctx.currentTime + 0.02;
    const stretches = this.#getDeckStretches(deck);
    await Promise.all(
      stretches.map(async (st) => {
        for (let i = 0; i < 6; i++) {
          const at = now + i * 0.11;
          await st.schedule({ output: at, outputTime: at, rate: Math.max(0.2, 1 - i * 0.16), semitones: -i * 2 });
        }
        const resAt = now + 0.72;
        await st.schedule({ output: resAt, outputTime: resAt, rate: deck.rate || 1, semitones: deck.semitones || 0 });
      })
    );
  }

  #schedulePercussionBridge(when, bpm, bars, style = 'house', peakGain = 0.24) {
    if (!this.ctx) return;
    scheduleStudioDrumBridge(this.ctx, this.masterFilter, {
      when,
      bpm,
      bars,
      style,
      peakGain,
      samples: this.drumSamples,
    });
  }

  getSpectrumEnergy() {
    if (!this.analyser || !this.freqData) return { bass: 0, mid: 0, overall: 0 };
    this.analyser.getByteFrequencyData(this.freqData);
    let bass = 0, mid = 0, total = 0;
    const len = this.freqData.length;
    for (let i = 0; i < len; i++) {
      const v = this.freqData[i] / 255;
      total += v;
      if (i < 6) bass += v;
      else if (i < 36) mid += v;
    }
    return {
      bass: bass / 6,
      mid: mid / 30,
      overall: total / len,
    };
  }

  async playTransitionSweepFx({ type = 'sweep', bpm = 122, durationSec = 4.0 } = {}) {
    try {
      await this.ensureContext();
    } catch {
      return;
    }
    const now = this.ctx.currentTime + 0.04;
    if (type === 'drum_bridge') {
      const bars = Math.max(1, Math.min(4, Math.round(durationSec / ((60 / Math.max(80, bpm)) * 4))));
      this.#schedulePercussionBridge(now, bpm, bars);
      return;
    }

    // Subtle analog filter riser + clean sub impact thump at the mix handover point
    const len = Math.floor(this.ctx.sampleRate * Math.min(6, durationSec));
    const noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;

    const noise = this.ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = type === 'echo_drop' ? 3.2 : 2.1;
    bp.frequency.setValueAtTime(240, now);
    bp.frequency.exponentialRampToValueAtTime(5800, now + durationSec * 0.62);
    bp.frequency.exponentialRampToValueAtTime(160, now + durationSec * 0.96);

    const g = this.ctx.createGain();
    const peakGain = type === 'phrase' ? 0.045 : 0.085;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peakGain, now + durationSec * 0.58);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durationSec * 0.95);

    noise.connect(bp);
    bp.connect(g);
    g.connect(this.masterFilter);
    if (type === 'echo_drop') {
      g.connect(this.echoDelayL);
    }
    noise.start(now);
    noise.stop(now + durationSec);

    // Subtle warm 808 sub impact on the incoming downbeat (at 62% of blend)
    if (type !== 'phrase') {
      const dropAt = now + durationSec * 0.62;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(92, dropAt);
      osc.frequency.exponentialRampToValueAtTime(38, dropAt + 0.42);
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(0.0001, dropAt);
      og.gain.linearRampToValueAtTime(0.18, dropAt + 0.015);
      og.gain.exponentialRampToValueAtTime(0.0001, dropAt + 0.55);
      osc.connect(og);
      og.connect(this.masterFilter);
      osc.start(dropAt);
      osc.stop(dropAt + 0.6);
    }
  }

  setMasterFilter(hz) {
    if (!this.masterFilter) return;
    this.masterFilter.frequency.setTargetAtTime(Math.max(160, Math.min(20000, hz)), this.ctx.currentTime, 0.03);
  }

  setDeckEcho(deckId, amount) {
    const deck = this.decks[deckId];
    if (!deck) return;
    const now = this.ctx.currentTime;
    deck.strip.echoSend.gain.cancelScheduledValues(now);
    deck.strip.echoSend.gain.setTargetAtTime(Math.max(0, Math.min(0.85, amount)), now, 0.04);
  }

  setDeckReverb(deckId, amount) {
    const deck = this.decks[deckId];
    if (!deck) return;
    const now = this.ctx.currentTime;
    deck.strip.reverbSend.gain.cancelScheduledValues(now);
    deck.strip.reverbSend.gain.setTargetAtTime(Math.max(0, Math.min(0.85, amount)), now, 0.04);
  }

  toggleRecording() {
    if (!this.ctx || !this.recordDest || !window.MediaRecorder) {
      throw new Error('Start Web Audio playback first to record.');
    }
    if (this.recorder && this.recorder.state === 'recording') {
      this.recorder.stop();
      this.recorderActive = false;
      return false;
    }
    this.recordChunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    this.recorder = new MediaRecorder(this.recordDest.stream, { mimeType: mime, audioBitsPerSecond: 192000 });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.recordChunks.push(e.data);
    };
    this.recorder.onstop = () => {
      const blob = new Blob(this.recordChunks, { type: this.recorder.mimeType || 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `NOVA-DJ-Set-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    };
    this.recorder.start(800);
    this.recorderActive = true;
    return true;
  }
}
