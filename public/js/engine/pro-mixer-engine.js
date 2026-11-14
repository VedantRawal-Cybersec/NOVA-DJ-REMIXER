import { getHarmonicMatch } from './camelot.js';
import {
  computeAudioBufferHash,
  computeAudioContentHash,
  getCachedAnalysisByHash,
  saveCachedAnalysisByHash,
} from './analysis-cache.js';
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
    this.limiter = null;
    this.analyser = null;
    this.recordDest = null;
    this.recorder = null;
    this.recordChunks = [];
    this.clockWorkletNode = null;
    this.clockListeners = new Set();
    this.clockMode = 'uninitialized';

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
    this.scheduledEvents = [];
    this._eventSeq = 1;
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

      // Club-grade master glue compressor + fast brickwall lookahead safety limiter
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -6;
      this.compressor.knee.value = 8;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.16;

      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1.0;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.001;
      this.limiter.release.value = 0.05;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.76;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

      this.recordDest = this.ctx.createMediaStreamDestination();

      this.masterFilter.connect(this.masterGain);
      this.masterGain.connect(this.compressor);
      this.compressor.connect(this.limiter);
      this.limiter.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.limiter.connect(this.recordDest);

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
      await this.#startAudioClockWorklet();
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
    let stretchLatencySec = 0;
    try {
      const SignalsmithStretch = await loadSignalsmith();
      stretch = await SignalsmithStretch(this.ctx);
      await stretch.configure({ blockMs: 90, intervalMs: 22, splitComputation: true });
      stretchLatencySec = Number(await stretch.latency?.().catch(() => 0)) || 0;
      stretch.connect(strip.input);
    } catch (err) {
      console.warn(`Deck ${id} SignalsmithStretch fallback to native AudioBufferSourceNode:`, err?.message);
    }

    const deck = {
      id,
      strip,
      stretch,
      stretchLatencySec,
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
      stretch.setUpdateInterval(0.04, (inputTime) => {
        if (deck.playing && !deck.neuralStems) {
          deck.position = Math.max(0, inputTime - (deck.stretchLatencySec || 0));
        }
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
        // Vande Veire & De Bie: stretch percussive drums vs harmonic stems separately to cut artifacts
        const isPercussive = stem === 'drums';
        await st.configure({
          blockMs: isPercussive ? 55 : 110,
          intervalMs: isPercussive ? 14 : 26,
          splitComputation: true,
        });
        st.connect(deck.strip.stemInputs[stem]);
        if (stem === 'drums') {
          deck.stretchLatencySec = Number(await st.latency?.().catch(() => deck.stretchLatencySec || 0)) || deck.stretchLatencySec || 0;
          st.setUpdateInterval(0.04, (inputTime) => {
            if (deck.playing && deck.neuralStems) {
              deck.position = Math.max(0, inputTime - (deck.stretchLatencySec || 0));
            }
          });
        }
        map[stem] = st;
      })
    );
    deck.stemStretches = map;
    return map;
  }

  async #startAudioClockWorklet() {
    if (!this.ctx) return;
    if (this.ctx.audioWorklet && !this.clockWorkletNode) {
      try {
        const procCode = `
          class NovaAudioClockProcessor extends AudioWorkletProcessor {
            constructor() { super(); this._quanta = 0; }
            process() {
              if (++this._quanta >= 8) {
                this._quanta = 0;
                this.port.postMessage({ audioTime: currentTime });
              }
              return true;
            }
          }
          registerProcessor('nova-audio-clock', NovaAudioClockProcessor);
        `;
        const blob = new Blob([procCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await this.ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(this.ctx, 'nova-audio-clock');
        const silent = this.ctx.createGain();
        silent.gain.value = 0;
        node.connect(silent);
        silent.connect(this.ctx.destination);
        node.port.onmessage = (ev) => {
          const audioTime = ev.data?.audioTime ?? this.ctx?.currentTime ?? 0;
          for (const fn of this.clockListeners) {
            try { fn(audioTime); } catch {}
          }
        };
        this.clockWorkletNode = node;
        this.clockMode = 'audioworklet';
        return;
      } catch {}
    }

    // Visual-sync requestAnimationFrame fallback strictly driven by ctx.currentTime (zero setInterval/setTimeout)
    if (this.clockMode !== 'raf' && typeof requestAnimationFrame === 'function') {
      this.clockMode = 'raf';
      const step = () => {
        if (this.ctx) {
          const t = this.ctx.currentTime;
          for (const fn of this.clockListeners) {
            try { fn(t); } catch {}
          }
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }

  addClockListener(fn) {
    if (typeof fn === 'function') this.clockListeners.add(fn);
    return () => this.clockListeners.delete(fn);
  }

  /**
   * Records a genuinely scheduled Web Audio DSP event (zero fake/cosmetic events).
   */
  recordScheduledEvent({ startAt, endAt, category = 'fx', deckId = 'MASTER', label, detail = '', params = null } = {}) {
    if (!this.ctx || !label) return null;
    const now = this.ctx.currentTime;
    const sAt = Number.isFinite(startAt) ? startAt : now;
    const eAt = Math.max(sAt + 0.6, Number.isFinite(endAt) ? endAt : sAt + 2.5);
    const dedupBucket = Math.round(sAt * 2);
    const existing = this.scheduledEvents.find(
      (ev) => ev.category === category && ev.deckId === deckId && ev.dedupBucket === dedupBucket && ev.label === label
    );
    if (existing) {
      existing.endAt = Math.max(existing.endAt, eAt);
      if (detail) existing.detail = detail;
      return existing;
    }
    const entry = {
      id: `dsp-${this._eventSeq++}`,
      dedupBucket,
      startAt: sAt,
      endAt: eAt,
      category,
      deckId,
      label,
      detail,
      params,
    };
    this.scheduledEvents.push(entry);
    // Prune stale finished events (> 6s after end) on ctx.currentTime
    if (this.scheduledEvents.length > 56) {
      this.scheduledEvents = this.scheduledEvents.filter((ev) => ev.endAt >= now - 6).slice(-48);
    }
    return entry;
  }

  clearScheduledEvents() {
    this.scheduledEvents = [];
  }

  getLiveEventsSnapshot(nowCtx = this.ctx?.currentTime ?? 0) {
    const t = Number.isFinite(nowCtx) ? nowCtx : 0;
    const active = [];
    const upcoming = [];
    const triggered = [];
    for (const ev of this.scheduledEvents) {
      if (t >= ev.startAt && t <= ev.endAt) {
        const span = Math.max(0.25, ev.endAt - ev.startAt);
        active.push({
          ...ev,
          progress01: Math.max(0, Math.min(1, (t - ev.startAt) / span)),
          remainingSec: Math.max(0, Math.round((ev.endAt - t) * 10) / 10),
        });
      } else if (ev.startAt > t && ev.startAt <= t + 30) {
        upcoming.push({ ...ev, startsInSec: Math.round((ev.startAt - t) * 10) / 10 });
      }
      if (t >= ev.startAt && ev.startAt >= t - 120) {
        triggered.push(ev);
      }
    }
    return { active, upcoming, triggered };
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
    let contentHash = track.content_hash || track.analysis?.content_hash || null;
    if (track.file) {
      if (track.file.size > 180 * 1024 * 1024) {
        throw new Error(`${track.title} exceeds 180 MB browser decode limit.`);
      }
      const bytes = await track.file.arrayBuffer();
      contentHash = contentHash || await computeAudioContentHash(bytes);
      buffer = await this.ctx.decodeAudioData(bytes.slice(0));
    } else if (track.streamUrl) {
      const res = await fetch(track.streamUrl, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`Stream unavailable (HTTP ${res.status})`);
      const bytes = await res.arrayBuffer();
      contentHash = contentHash || await computeAudioContentHash(bytes);
      buffer = await this.ctx.decodeAudioData(bytes.slice(0));
    } else if (stemBuffers) {
      buffer = this.#sumStemBuffers(stemBuffers);
      contentHash = contentHash || await computeAudioBufferHash(buffer);
    } else {
      throw new Error('Track has no decodable local file, stem bundle, or CORS stream.');
    }

    if (buffer.duration < 10) throw new Error('Track is shorter than 10 seconds.');

    // Check SHA-256 content-hash memory & IndexedDB cache first so every file is analyzed once
    const memHit = this.decodedCache.get(`hash:${contentHash}`);
    if (memHit) {
      const cachedRec = {
        buffer,
        stemBuffers: stemBuffers || memHit.stemBuffers,
        analysis: {
          ...memHit.analysis,
          cached: true,
          content_hash: contentHash,
          stems_available: Boolean(stemBuffers || memHit.stemBuffers),
          stem_mode: (stemBuffers || memHit.stemBuffers) ? 'demucs-4stem' : 'eq-midside-off',
        },
      };
      this.decodedCache.set(track.id, cachedRec);
      return cachedRec;
    }

    const storedAnalysis = await getCachedAnalysisByHash(contentHash);
    let analysis = null;
    if (storedAnalysis && storedAnalysis.beat_times?.length >= 4 && storedAnalysis.tracker_comparison) {
      onProgress?.(`Loaded cached SHA-256 beatgrid & key for ${track.title}…`);
      analysis = {
        ...storedAnalysis,
        cached: true,
        content_hash: contentHash,
      };
    } else {
      onProgress?.(`Dual-tracker analyzing beatgrid, downbeats, stems & key for ${track.title}…`);
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
      analysis = await new Promise((resolve, reject) => {
        this.workerPending.set(reqId, { resolve, reject });
        worker.postMessage({ id: reqId, mono, side, sampleRate: buffer.sampleRate }, transfers);
      });
      analysis.cached = false;
      analysis.content_hash = contentHash;
    }

    if (workerAnalysis) {
      analysis = {
        ...analysis,
        ...workerAnalysis,
        durationSec: analysis.durationSec,
        heat: analysis.heat,
        spectrum: analysis.spectrum,
        neuralStems: Boolean(stemBuffers),
        stems_available: Boolean(stemBuffers),
        stem_mode: stemBuffers ? 'demucs-4stem' : 'eq-midside-off',
      };
    } else {
      const hasStems = Boolean(stemBuffers && STEM_NAMES.every((s) => stemBuffers[s]));
      analysis.neuralStems = hasStems;
      analysis.stems_available = hasStems;
      analysis.stem_mode = hasStems ? 'demucs-4stem' : 'eq-midside-off';
    }

    if (!analysis.cached) {
      await saveCachedAnalysisByHash(contentHash, analysis);
    }

    const record = { buffer, stemBuffers, analysis };
    this.decodedCache.set(track.id, record);
    this.decodedCache.set(`hash:${contentHash}`, record);
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
    track.stems_available = Boolean(deck.neuralStems);
    track.stem_mode = deck.neuralStems ? 'demucs-4stem' : 'eq-midside-off';
    track.content_hash = analysis.content_hash;
    track.safe_transitions_only = Boolean(analysis.safe_transitions_only);
    track.tracker_comparison = analysis.tracker_comparison || null;
    track.analysis = analysis;
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

  /**
   * Schedules a sample-accurate deck stop on AudioContext.currentTime (zero setTimeout).
   */
  scheduleDeckStopAt(deckId, whenCtxTime) {
    const deck = this.decks[deckId];
    if (!deck || !this.ctx) return;
    const stopAt = Math.max(this.ctx.currentTime + 0.02, whenCtxTime);
    for (const st of this.#getDeckStretches(deck)) {
      st.schedule({
        output: stopAt,
        outputTime: stopAt,
        active: false,
        rate: 1,
        semitones: 0,
        loopStart: 0,
        loopEnd: 0,
      }).catch(() => {});
    }
    if (deck.fallbackSource) {
      try { deck.fallbackSource.stop(stopAt); } catch {}
    }
    for (const src of deck.stemFallbackSources || []) {
      try { src.stop(stopAt); } catch {}
    }
  }

  setDeckEqKill(deckId, band, killed) {
    const deck = this.decks[deckId];
    if (!deck?.strip || !this.ctx) return false;
    const ok = deck.strip.setEqKill(band, killed, this.ctx.currentTime);
    if (ok) {
      this.recordScheduledEvent({
        startAt: this.ctx.currentTime,
        endAt: this.ctx.currentTime + (killed ? 3.0 : 1.2),
        category: 'eq',
        deckId,
        label: killed ? `EQ KILL ${String(band).toUpperCase()}` : `EQ RESTORE ${String(band).toUpperCase()}`,
        detail: killed ? `Deck ${deckId} ${band} frequency completely carved (-28dB)` : `Deck ${deckId} ${band} flat (0dB)`,
      });
    }
    return ok;
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
    if (!deck.playing || !this.ctx) return deck.position;
    if (deck.loopActive && this.#getDeckStretches(deck).length) return deck.position;
    // Direct speaker-aligned timeline anchored to AudioContext.currentTime
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

    const outTitle = outDeck.track?.title || `Deck ${outDeckId}`;
    const inTitle = inDeck.track?.title || `Deck ${inDeckId}`;
    this.recordScheduledEvent({
      startAt,
      endAt,
      category: 'blend',
      deckId: 'MASTER',
      label: `BLENDING: ${outTitle} → ${inTitle}`,
      detail: `${style.replace(/_/g, ' ')} · ${plan.bars || 8} BARS · BEAT SYNCED`,
      params: { style, bars: plan.bars || 8 },
    });

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

      this.recordScheduledEvent({
        startAt: swapAt,
        endAt: swapAt + 2.5,
        category: 'eq',
        deckId: 'MASTER',
        label: 'EQ BASS SWAP (DOWNBEAT SLAM)',
        detail: `Cutting ${outDeckId} Low (-28dB) · Slamming ${inDeckId} Low (0dB)`,
      });

      outGain.setValueAtTime(1.0, startAt);
      outGain.setValueAtTime(0.92, swapAt);
      outGain.linearRampToValueAtTime(0.0001, endAt);
    } else if (style === 'STEM_VOCAL_PASS') {
      // Zero Vocal Clash: Duck Track A vocals & keep Track A drums/bass while Track B enters!
      outDeck.strip.setStem('vocals', 0.18, startAt, 0.18);
      inDeck.strip.setStem('bass', 0.02, startAt, 0.02);
      inGain.setValueCurveAtTime(makeCurve(true), startAt, dur * 0.85);

      this.recordScheduledEvent({
        startAt,
        endAt: startAt + dur * 0.45,
        category: 'stem',
        deckId: outDeckId,
        label: `STEM VOCAL DUCK (${outDeckId})`,
        detail: `Ducking Deck ${outDeckId} vocal to prevent lyrical clash`,
      });

      const swapAt = startAt + dur * 0.45;
      outDeck.strip.setStem('bass', 0.02, swapAt, 0.03);
      inDeck.strip.setStem('bass', 1.0, swapAt, 0.03);

      this.recordScheduledEvent({
        startAt: swapAt,
        endAt: swapAt + 2.5,
        category: 'eq',
        deckId: 'MASTER',
        label: 'EQ BASS SWAP (DOWNBEAT SLAM)',
        detail: `Handing off low-end foundation to Deck ${inDeckId}`,
      });

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

      this.recordScheduledEvent({
        startAt,
        endAt: startAt + dur * 0.65,
        category: 'filter',
        deckId: outDeckId,
        label: 'HPF FILTER SWEEP & ECHO WASH',
        detail: `Sweeping highpass + echo build on Deck ${outDeckId}`,
      });

      inDeck.strip.setStem('bass', 0.05, startAt, 0.02);
      inGain.setValueAtTime(0.001, startAt);
      inGain.linearRampToValueAtTime(0.65, startAt + dur * 0.68);
      inGain.setValueAtTime(1.0, startAt + dur * 0.72);
      inDeck.strip.setStem('bass', 1.0, startAt + dur * 0.72, 0.02);

      this.recordScheduledEvent({
        startAt: startAt + dur * 0.72,
        endAt: startAt + dur * 0.72 + 2.5,
        category: 'blend',
        deckId: inDeckId,
        label: 'DROP SLAM IN (DOWNBEAT)',
        detail: `Hard slam downbeat drop into Deck ${inDeckId}`,
      });

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

      this.recordScheduledEvent({
        startAt,
        endAt: startAt + dur * 0.8,
        category: 'loop',
        deckId: outDeckId,
        label: 'TENSION BEAT ROLL & FILTER',
        detail: `1-bar to 1/2-bar beat roll tension on Deck ${outDeckId}`,
      });

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

      this.recordScheduledEvent({
        startAt: brakeAt,
        endAt: brakeAt + dur * 0.35,
        category: 'fx',
        deckId: outDeckId,
        label: 'VINYL BRAKE & ECHO OUT',
        detail: `Tape brake pitch drop + 1/2 beat echo tail on Deck ${outDeckId}`,
      });

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
   * Renders an OfflineAudioContext mono/stereo AudioBuffer containing the track mixed
   * with sample-accurate click ticks on every detected beat and accented pitches on downbeats.
   */
  async renderClickOverlayBuffer(trackOrRec, { maxDurationSec = null } = {}) {
    const rec = trackOrRec?.buffer && trackOrRec?.analysis
      ? trackOrRec
      : await this.decodeAndAnalyze(trackOrRec);
    const srcBuf = rec.buffer;
    const analysis = rec.analysis;
    const sr = srcBuf.sampleRate || 44100;
    const dur = Math.min(srcBuf.duration, maxDurationSec || srcBuf.duration);
    const totalFrames = Math.max(1, Math.floor(dur * sr));
    const offline = new OfflineAudioContext(2, totalFrames, sr);

    const src = offline.createBufferSource();
    src.buffer = srcBuf;
    const srcGain = offline.createGain();
    srcGain.gain.value = 0.72;
    src.connect(srcGain);
    srcGain.connect(offline.destination);
    src.start(0, 0, dur);

    const beats = analysis.beat_times || [];
    const dbs = new Set((analysis.downbeat_times || []).map((t) => Math.round(t * 20)));
    const clickTimestamps = [];
    for (let i = 0; i < beats.length; i++) {
      const bt = beats[i];
      if (bt < 0 || bt >= dur - 0.05) continue;
      const isDown = dbs.has(Math.round(bt * 20));
      const osc = offline.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(isDown ? 1720 : 1040, bt);
      const g = offline.createGain();
      g.gain.setValueAtTime(0.0001, bt);
      g.gain.linearRampToValueAtTime(isDown ? 0.55 : 0.34, bt + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, bt + 0.048);
      osc.connect(g);
      g.connect(offline.destination);
      osc.start(bt);
      osc.stop(bt + 0.055);
      clickTimestamps.push({ t: bt, downbeat: isDown });
    }

    const rendered = await offline.startRendering();
    return { rendered, clickTimestamps, analysis };
  }

  /**
   * Auditions a track slice right from Debug Studio overlaid with detected beat clicks.
   */
  async previewBeatClickTrack(track, startSec = 0, durationSec = 14) {
    await this.ensureContext();
    const rec = await this.decodeAndAnalyze(track);
    if (this._activeClickPreviewSrc) {
      try { this._activeClickPreviewSrc.stop(); } catch {}
      this._activeClickPreviewSrc = null;
    }
    const { buffer, analysis } = rec;
    const safeStart = Math.max(0, Math.min(buffer.duration - 4, startSec));
    const playLen = Math.min(durationSec, buffer.duration - safeStart);
    const now = this.ctx.currentTime + 0.04;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const gSong = this.ctx.createGain();
    gSong.gain.setValueAtTime(0.75, now);
    src.connect(gSong);
    gSong.connect(this.ctx.destination);
    src.start(now, safeStart, playLen);
    src.stop(now + playLen + 0.02);
    this._activeClickPreviewSrc = src;

    const dbs = new Set((analysis.downbeat_times || []).map((t) => Math.round(t * 20)));
    for (const bt of analysis.beat_times || []) {
      if (bt < safeStart || bt > safeStart + playLen - 0.05) continue;
      const at = now + (bt - safeStart);
      const isDown = dbs.has(Math.round(bt * 20));
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(isDown ? 1720 : 1040, at);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(isDown ? 0.42 : 0.24, at + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      osc.connect(g);
      g.connect(this.ctx.destination);
      osc.start(at);
      osc.stop(at + 0.06);
    }
    return { startAt: now, durationSec: playLen, beatCount: (analysis.beat_times || []).length };
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
    let startAt = now + 0.32;
    const nextBeat = grid.find((b) => b >= outPos + 0.30 && b <= outPos + barSec + 0.5);
    if (nextBeat !== undefined) {
      startAt = Math.max(now + 0.30, now + (nextBeat - outPos) / Math.max(0.5, outDeck.rate || 1));
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

    const outTitle = outDeck.track?.title || `Deck ${outDeckId}`;
    const inTitle = inDeck.track?.title || `Deck ${inDeckId}`;
    const recipeType = (recipe.type || 'club_blend').replace(/_/g, ' ').toUpperCase();
    this.recordScheduledEvent({
      startAt,
      endAt,
      category: 'blend',
      deckId: 'MASTER',
      label: `BLENDING: ${outTitle} → ${inTitle}`,
      detail: `${recipeType} · ${durBars} BARS · DOWNBEAT ALIGNED`,
      params: { type: recipe.type, durBars },
    });

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
        if (layer.stem === 'vocals' && layer.gain_curve.some(([_, g]) => g <= 0.3)) {
          this.recordScheduledEvent({
            startAt,
            endAt: startAt + dur * 0.6,
            category: 'stem',
            deckId: deck.id,
            label: `STEM VOCAL DUCK (${deck.id})`,
            detail: `Ducking vocal stem on Deck ${deck.id} to eliminate lyrical clash`,
          });
        }
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
      const targetDeckId = eq.deck === 'A' ? outDeckId : inDeckId;
      if (!eq.points?.length) continue;
      for (const [b, db] of eq.points) {
        const at = startAt + Math.max(0, Math.min(durBars, b)) * barUnit;
        targetDeck.strip.setEqBand(eq.band, db, at, 0.04);
        if (eq.band === 'low' && db <= -18) {
          this.recordScheduledEvent({
            startAt: at,
            endAt: at + Math.max(1.8, barUnit * 2),
            category: 'eq',
            deckId: targetDeckId,
            label: `EQ BASS CUT (-28dB)`,
            detail: `Deck ${targetDeckId} low-end carved for clean bass handoff`,
          });
        } else if (eq.band === 'low' && db >= -2) {
          this.recordScheduledEvent({
            startAt: at,
            endAt: at + Math.max(1.8, barUnit * 2),
            category: 'eq',
            deckId: targetDeckId,
            label: `EQ BASS SLAM (0dB)`,
            detail: `Deck ${targetDeckId} full low-end engaged on downbeat`,
          });
        }
      }
    }

    // Apply filter automation points
    for (const fl of recipe.filter_automation || []) {
      const targetDeck = fl.deck === 'A' ? outDeck : inDeck;
      const targetDeckId = fl.deck === 'A' ? outDeckId : inDeckId;
      for (const [b, val] of fl.curve || []) {
        const at = startAt + Math.max(0, Math.min(durBars, b)) * barUnit;
        targetDeck.strip.setColorFilter(val, at, 0.06);
        if (Math.abs(val) >= 0.45) {
          this.recordScheduledEvent({
            startAt: at,
            endAt: at + Math.max(1.5, barUnit * 2),
            category: 'filter',
            deckId: targetDeckId,
            label: val > 0 ? 'COLOR FILTER: HPF SWEEP' : 'COLOR FILTER: LPF SWEEP',
            detail: `Deck ${targetDeckId} filter sweep at bar ${b}`,
          });
        }
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
        this.recordScheduledEvent({
          startAt: at,
          endAt: at + dur * 0.45,
          category: 'fx',
          deckId: outDeckId,
          label: 'STEREO PING-PONG ECHO DUB',
          detail: `Tempo-locked echo delay wash on Deck ${outDeckId}`,
        });
      } else if (fxItem.type === 'reverb') {
        const lvl = fxItem.params?.level ?? 0.55;
        outDeck.strip.reverbSend.gain.setValueAtTime(0, startAt);
        outDeck.strip.reverbSend.gain.linearRampToValueAtTime(lvl, at + dur * 0.55);
        outDeck.strip.reverbSend.gain.linearRampToValueAtTime(0, endAt);
        this.recordScheduledEvent({
          startAt: at,
          endAt: at + dur * 0.55,
          category: 'fx',
          deckId: outDeckId,
          label: 'CONVOLUTION REVERB WASH',
          detail: `Spatial acoustic decay wash on Deck ${outDeckId}`,
        });
      } else if (fxItem.type === 'loop_roll') {
        const anchor = outPos + (startAt - now) * Math.max(0.5, outDeck.rate);
        this.triggerLoopRoll(outDeckId, [2, 1, 0.5], at, anchor, beatSec);
      } else if (fxItem.type === 'spinback') {
        const steps = 6;
        for (const st of this.#getDeckStretches(outDeck)) {
          for (let s = 0; s < steps; s++) {
            const stAt = at + (s / steps) * 0.85;
            st.schedule({ output: stAt, outputTime: stAt, rate: 1 - (s / steps) * 0.72, semitones: -s * 2 });
          }
        }
        this.recordScheduledEvent({
          startAt: at,
          endAt: at + 0.85,
          category: 'fx',
          deckId: outDeckId,
          label: 'VINYL SPINBACK BRAKE',
          detail: `Turntable spinback brake on Deck ${outDeckId}`,
        });
      } else if (fxItem.type === 'tape_stop') {
        this.triggerTapeStop(outDeckId, Math.min(1.6, beatSec * 2), at, false);
      } else if (fxItem.type === 'reverse_riser') {
        this.playReverseRiser(at, outBpm, Math.min(4, beatSec * 4));
      } else if (fxItem.type === 'impact') {
        this.playImpactHit(at);
      } else if (fxItem.type === 'riser_impact') {
        const riserDur = Math.min(4, Math.max(beatSec * 2, dur * 0.45));
        this.playReverseRiser(at, outBpm, riserDur);
        this.playImpactHit(at + riserDur);
      } else if (fxItem.type === 'stutter') {
        const div = Number(fxItem.params?.division_beats) || 0.25;
        const repeats = Math.min(16, Number(fxItem.params?.repeats) || 8);
        this.triggerStutter(outDeckId, div, repeats, at);
      } else if (fxItem.type === 'key_lift') {
        const liftSemi = Math.max(-2, Math.min(2, Number(fxItem.params?.semitones) || 1));
        const liftAt = startAt + dur * 0.5;
        for (const st of this.#getDeckStretches(inDeck)) {
          st.schedule({ output: liftAt, outputTime: liftAt, semitones: liftSemi });
        }
        this.recordScheduledEvent({
          startAt: liftAt,
          endAt,
          category: 'harmonic',
          deckId: inDeckId,
          label: `KEY MODULATION LIFT (+${liftSemi > 0 ? '+' : ''}${liftSemi} SEMI)`,
          detail: `Energizing harmonic pitch shift on Deck ${inDeckId}`,
        });
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
   * Applies subtle +-0.4% pitch-locked rate micro-nudges across all active stem lanes if drift exceeds 7 ms.
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
    if (Math.abs(driftMs) > 7 && Math.abs(driftMs) < 95) {
      const nudge = driftMs > 0 ? 0.996 : 1.004;
      for (const st of stretches) {
        st.schedule({ output: now + 0.04, outputTime: now + 0.04, rate: (deck.rate || 1) * nudge }).catch(() => {});
        st.schedule({ output: now + 0.44, outputTime: now + 0.44, rate: deck.rate || 1 }).catch(() => {});
      }
    }
    return Math.round(driftMs * 10) / 10;
  }

  /**
   * Measures real-time beat-phase offset in milliseconds between Deck A and Deck B on AudioContext.currentTime.
   */
  measureDualDeckDriftMs() {
    const a = this.decks.A;
    const b = this.decks.B;
    if (!a?.playing || !b?.playing || !this.ctx) return null;
    if (this.ctx.currentTime < Math.max(a.startedAtCtx || 0, b.startedAtCtx || 0) + 0.05) return null;
    const beatsA = a.analysis?.beat_times || [];
    const beatsB = b.analysis?.beat_times || [];
    if (!beatsA.length || !beatsB.length) return null;
    const posA = this.getDeckPosition('A');
    const posB = this.getDeckPosition('B');
    const nearPhase = (beats, pos, rate) => {
      let best = beats[0];
      let bd = Infinity;
      for (let i = 0; i < beats.length; i++) {
        const d = Math.abs(beats[i] - pos);
        if (d < bd) { bd = d; best = beats[i]; }
      }
      return ((pos - best) / Math.max(0.5, rate || 1)) * 1000;
    };
    const pA = nearPhase(beatsA, posA, a.rate);
    const pB = nearPhase(beatsB, posB, b.rate);
    return Math.round(Math.abs(pA - pB) * 10) / 10;
  }

  async triggerSpinback(deckId) {
    const deck = this.decks[deckId];
    if (!deck?.playing) return;
    const now = this.ctx.currentTime + 0.02;
    this.recordScheduledEvent({
      startAt: now,
      endAt: now + 0.85,
      category: 'fx',
      deckId,
      label: 'VINYL SPINBACK BRAKE',
      detail: `Turntable spinback brake on Deck ${deckId}`,
    });
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

  async triggerTapeStop(deckId, durationSec = 0.85, when = null, resumeAfter = true) {
    const deck = this.decks[deckId];
    if (!deck?.playing || !this.ctx) return;
    const startAt = when ?? this.ctx.currentTime + 0.02;
    const dur = Math.max(0.25, Math.min(2.5, durationSec));
    this.recordScheduledEvent({
      startAt,
      endAt: startAt + dur,
      category: 'fx',
      deckId,
      label: 'MOTOR TAPE STOP',
      detail: `Analog tape motor slow-down on Deck ${deckId}`,
    });
    const stretches = this.#getDeckStretches(deck);
    const baseRate = deck.rate || 1;
    const baseSemi = deck.semitones || 0;
    const steps = 10;
    await Promise.all(
      stretches.map(async (st) => {
        for (let i = 1; i <= steps; i++) {
          const frac = i / steps;
          const at = startAt + frac * dur;
          const r = Math.max(0.06, baseRate * Math.pow(1 - frac, 1.7));
          const s = baseSemi - Math.round(frac * 20);
          await st.schedule({ output: at, outputTime: at, rate: r, semitones: s });
        }
        if (resumeAfter) {
          const recAt = startAt + dur + 0.14;
          await st.schedule({ output: recAt, outputTime: recAt, rate: baseRate, semitones: baseSemi });
        } else {
          await st.schedule({ output: startAt + dur + 0.02, outputTime: startAt + dur + 0.02, active: false });
        }
      })
    );
  }

  triggerLoopRoll(deckId, divisions = [2, 1, 0.5, 0.25], when = null, anchorOffset = null, beatSecOverride = null) {
    const deck = this.decks[deckId];
    if (!deck?.playing || !this.ctx) return;
    const startAt = when ?? this.ctx.currentTime + 0.02;
    const bpm = (deck.analysis?.bpm || 120) * (deck.rate || 1);
    const beatSec = beatSecOverride || 60 / Math.max(55, bpm);
    const anchor = anchorOffset ?? this.getDeckPosition(deckId);
    const stretches = this.#getDeckStretches(deck);
    let cursor = startAt;
    for (const div of divisions) {
      const sliceDur = Math.max(0.08, beatSec * div);
      for (const st of stretches) {
        st.schedule({
          output: cursor,
          outputTime: cursor,
          loopStart: Math.max(0, anchor),
          loopEnd: Math.min(deck.buffer?.duration || anchor + sliceDur, anchor + sliceDur),
        }).catch(() => {});
      }
      cursor += sliceDur * 2;
    }
    const rollDur = cursor - startAt;
    this.recordScheduledEvent({
      startAt,
      endAt: startAt + rollDur,
      category: 'loop',
      deckId,
      label: 'QUANTIZED LOOP ROLL',
      detail: `Subdividing beat slice roll tension on Deck ${deckId}`,
    });
    for (const st of stretches) {
      st.schedule({ output: cursor, outputTime: cursor, loopStart: 0, loopEnd: 0 }).catch(() => {});
    }
  }

  triggerStutter(deckId, divisionBeats = 0.25, repeats = 8, when = null) {
    const deck = this.decks[deckId];
    if (!deck?.playing || !this.ctx) return;
    const startAt = when ?? this.ctx.currentTime + 0.02;
    const bpm = (deck.analysis?.bpm || 120) * (deck.rate || 1);
    const stepSec = (60 / Math.max(55, bpm)) * divisionBeats;
    this.recordScheduledEvent({
      startAt,
      endAt: startAt + repeats * stepSec,
      category: 'fx',
      deckId,
      label: `CHOP STUTTER (1/${Math.round(4 / divisionBeats)}T)`,
      detail: `${repeats}-hit rhythmic gate stutter on Deck ${deckId}`,
    });
    const g = deck.strip.deckVolume.gain;
    for (let s = 0; s < repeats; s++) {
      const stAt = startAt + s * stepSec;
      g.setValueAtTime(1.0, stAt);
      g.setValueAtTime(0.04, stAt + stepSec * 0.52);
    }
    g.setValueAtTime(1.0, startAt + repeats * stepSec);
  }

  playReverseRiser(when = null, bpm = 122, durationSec = 2.5) {
    if (!this.ctx || !this.masterFilter) return;
    const t0 = when ?? this.ctx.currentTime + 0.02;
    const dur = Math.max(0.6, Math.min(6.0, durationSec));
    this.recordScheduledEvent({
      startAt: t0,
      endAt: t0 + dur,
      category: 'riser',
      deckId: 'MASTER',
      label: 'REVERSE WHITE NOISE RISER',
      detail: `Synthesized frequency tension build (${Math.round(bpm)} BPM)`,
    });
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const ch = buf.getChannelData(0);
    // Exponential reverse amplitude contour ending abruptly right before t0 + dur drop
    let s = 1337;
    for (let i = 0; i < len; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const white = (s / 0xffffffff) * 2 - 1;
      const env = Math.pow(i / Math.max(1, len - 1), 3.1);
      ch[i] = white * env * 0.55;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3.2;
    bp.frequency.setValueAtTime(220, t0);
    bp.frequency.exponentialRampToValueAtTime(7200, t0 + dur * 0.96);

    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(Math.max(80, bpm * 0.9), t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(220, bpm * 4.5), t0 + dur * 0.96);

    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.exponentialRampToValueAtTime(0.11, t0 + dur * 0.94);
    og.gain.linearRampToValueAtTime(0.0001, t0 + dur);

    src.connect(bp);
    bp.connect(og);
    osc.connect(bp);
    og.connect(this.masterFilter);
    og.connect(this.reverbConvolver);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  playImpactHit(when = null) {
    if (!this.ctx || !this.masterFilter) return;
    const t0 = when ?? this.ctx.currentTime + 0.02;
    this.recordScheduledEvent({
      startAt: t0,
      endAt: t0 + 0.65,
      category: 'impact',
      deckId: 'MASTER',
      label: 'SUB IMPACT DROP',
      detail: '40Hz sine sub boom downbeat impact',
    });
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(118, t0);
    osc.frequency.exponentialRampToValueAtTime(36, t0 + 0.45);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.linearRampToValueAtTime(0.28, t0 + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.65);
    osc.connect(og);
    og.connect(this.masterFilter);
    osc.start(t0);
    osc.stop(t0 + 0.68);
  }

  #schedulePercussionBridge(when, bpm, bars, style = 'house', peakGain = 0.24) {
    if (!this.ctx) return;
    const beatSec = 60 / Math.max(50, bpm);
    const durSec = bars * 4 * beatSec;
    this.recordScheduledEvent({
      startAt: when,
      endAt: when + durSec,
      category: 'drum',
      deckId: 'MASTER',
      label: `ADDED DRUM BRIDGE: ${style.toUpperCase()}`,
      detail: `${bars} bars live ${style} studio percussion layer`,
      params: { style, bars, bpm },
    });
    scheduleStudioDrumBridge(this.ctx, this.masterFilter, {
      when,
      bpm,
      bars,
      style,
      peakGain,
      samples: this.drumSamples,
    });
  }

  triggerAutonomousPhraseOverlay(deckId, style = 'house', bars = 2) {
    const deck = this.decks[deckId];
    if (!deck?.playing || !this.ctx) return null;
    const now = this.ctx.currentTime;
    const pos = this.getDeckPosition(deckId);
    const bpm = (deck.analysis?.bpm || 120) * (deck.rate || 1);
    const beatSec = 60 / Math.max(55, bpm);
    const barSec = beatSec * 4;

    const grid = deck.analysis?.downbeat_times?.length ? deck.analysis.downbeat_times : deck.analysis?.beats || [];
    let startAt = now + 0.15;
    const nextBeat = grid.find((b) => b >= pos + 0.12 && b <= pos + barSec + 0.2);
    if (nextBeat !== undefined) {
      startAt = Math.max(now + 0.12, now + (nextBeat - pos) / Math.max(0.5, deck.rate || 1));
    }

    this.#schedulePercussionBridge(startAt, bpm, bars, style, 0.22);
    return { startAt, durationSec: bars * barSec, style, bars };
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
