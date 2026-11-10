import { getHarmonicMatch } from './camelot.js';
import { createStemChannelStrip } from './stems-isolator.js';

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
    this.decodedCache = new Map(); // id -> { buffer, analysis }

    this.decks = { A: null, B: null };
    this.drumSamples = null;
    this.drumBridgeEnabled = false;
    this.masterTempoEnabled = true;
    this.autoKeyLockEnabled = true;

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
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
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
      fallbackSource: null,
      track: null,
      buffer: null,
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
        if (deck.playing) deck.position = inputTime;
      });
    }
    return deck;
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

  async decodeAndAnalyze(track, onProgress) {
    if (this.decodedCache.has(track.id)) {
      return this.decodedCache.get(track.id);
    }
    await this.ensureContext();
    onProgress?.(`Decoding ${track.title}…`);

    let bytes;
    if (track.file) {
      if (track.file.size > 180 * 1024 * 1024) {
        throw new Error(`${track.title} exceeds 180 MB browser decode limit.`);
      }
      bytes = await track.file.arrayBuffer();
    } else if (track.streamUrl) {
      const res = await fetch(track.streamUrl, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`Stream unavailable (HTTP ${res.status})`);
      bytes = await res.arrayBuffer();
    } else {
      throw new Error('Track has no decodable local file or CORS stream.');
    }

    const buffer = await this.ctx.decodeAudioData(bytes.slice(0));
    if (buffer.duration < 10) throw new Error('Track is shorter than 10 seconds.');

    onProgress?.(`Analyzing beatgrid, key & structure for ${track.title}…`);
    const ch0 = buffer.getChannelData(0);
    let mono;
    if (buffer.numberOfChannels > 1) {
      const ch1 = buffer.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
    } else {
      mono = new Float32Array(ch0);
    }

    const worker = this.#ensureWorker();
    const reqId = ++this.workerReqId;
    const analysis = await new Promise((resolve, reject) => {
      this.workerPending.set(reqId, { resolve, reject });
      worker.postMessage({ id: reqId, mono, sampleRate: buffer.sampleRate }, [mono.buffer]);
    });

    const record = { buffer, analysis };
    this.decodedCache.set(track.id, record);
    return record;
  }

  async loadDeck(deckId, track, { gain = 0, playMode = 'club' } = {}) {
    const deck = this.decks[deckId];
    if (!deck) throw new Error(`Unknown deck ${deckId}`);
    const record = await this.decodeAndAnalyze(track);
    const { buffer, analysis } = record;

    await this.stopDeck(deckId);
    deck.track = track;
    deck.buffer = buffer;
    deck.analysis = analysis;

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
    if (track.cueConfidence !== 'user') {
      track.entrySec = entrySec;
      track.exitSec = exitSec;
    }

    // LUFS auto-gain trim toward -13 LUFS target (clamped ±6 dB)
    const lufs = Number.isFinite(analysis.lufs) ? analysis.lufs : -13;
    const trimDb = Math.max(-6, Math.min(6, -13 - lufs));
    const trimGain = Math.pow(10, trimDb / 20);
    deck.strip.lufsTrim.gain.setValueAtTime(trimGain, this.ctx.currentTime);
    deck.strip.deckVolume.gain.setValueAtTime(gain, this.ctx.currentTime);
    deck.strip.resetAll(this.ctx.currentTime);
    deck.position = track.playFull ? 0 : track.entrySec;
    deck.loopActive = false;

    if (deck.stretch) {
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
    const t = when ?? this.ctx.currentTime + 0.04;
    const pos = Math.max(0, Math.min(deck.buffer.duration - 0.5, offsetSec ?? deck.position));

    deck.rate = rate;
    deck.semitones = semitones;
    deck.position = pos;
    deck.playing = true;
    deck.startedAtCtx = t;
    deck.startedOffset = pos;

    deck.strip.deckVolume.gain.cancelScheduledValues(t);
    deck.strip.deckVolume.gain.setValueAtTime(gain, t);

    if (deck.stretch) {
      await deck.stretch.schedule({
        output: t,
        outputTime: t,
        active: true,
        input: pos,
        rate,
        semitones: this.masterTempoEnabled ? semitones : 0,
        formantCompensation: true,
        loopStart: 0,
        loopEnd: 0,
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
    if (deck.stretch) {
      try {
        await deck.stretch.schedule({ output: now + 0.02, outputTime: now + 0.02, active: false, loopStart: 0, loopEnd: 0 });
      } catch {}
    }
    if (deck.fallbackSource) {
      try { deck.fallbackSource.stop(now + 0.02); } catch {}
      deck.fallbackSource = null;
    }
  }

  async pauseDeck(deckId) {
    const deck = this.decks[deckId];
    if (!deck || !deck.playing) return;
    deck.position = this.getDeckPosition(deckId);
    deck.playing = false;
    if (deck.stretch) {
      await deck.stretch.schedule({ output: this.ctx.currentTime + 0.02, outputTime: this.ctx.currentTime + 0.02, active: false });
    } else if (deck.fallbackSource) {
      try { deck.fallbackSource.stop(); } catch {}
      deck.fallbackSource = null;
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
    if (deck.stretch) return deck.position;
    if (!deck.playing || !this.ctx) return deck.position;
    const elapsed = Math.max(0, this.ctx.currentTime - deck.startedAtCtx);
    return Math.min(deck.buffer?.duration || 0, deck.startedOffset + elapsed * deck.rate);
  }

  async toggleLoopBars(deckId, bars = 4) {
    const deck = this.decks[deckId];
    if (!deck || !deck.playing || !deck.analysis) return false;
    const bpm = (deck.analysis.bpm || 120) * deck.rate;
    const barDur = (60 / bpm) * 4;
    if (deck.loopActive) {
      deck.loopActive = false;
      if (deck.stretch) {
        await deck.stretch.schedule({
          output: this.ctx.currentTime + 0.03,
          outputTime: this.ctx.currentTime + 0.03,
          loopStart: 0,
          loopEnd: 0,
        });
      }
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
    if (deck.stretch) {
      await deck.stretch.schedule({
        output: this.ctx.currentTime + 0.03,
        outputTime: this.ctx.currentTime + 0.03,
        loopStart,
        loopEnd,
      });
    }
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

    // Align incoming entry precisely to next downbeat
    const inOffset = inDeck.track?.playFull
      ? (b?.downbeats?.[0] || 0)
      : (inDeck.track?.entrySec ?? b?.clubEntry ?? 0);

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
    // Quantize transition start to outgoing Beat 1 (or next beat within 1.5s)
    let startAt = now + 0.08;
    const outPos = this.getDeckPosition(outDeckId);
    const grid = outDeck.analysis?.downbeats?.length ? outDeck.analysis.downbeats : outDeck.analysis?.beats || [];
    const nextBeat = grid.find((b) => b >= outPos + 0.06 && b <= outPos + 2.2);
    if (nextBeat !== undefined) {
      startAt = now + (nextBeat - outPos) / Math.max(0.5, outDeck.rate);
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

      inDeck.strip.setStem('bass', 0.05, startAt, 0.02);
      inGain.setValueAtTime(0.001, startAt);
      inGain.linearRampToValueAtTime(0.65, startAt + dur * 0.68);
      inGain.setValueAtTime(1.0, startAt + dur * 0.72);
      inDeck.strip.setStem('bass', 1.0, startAt + dur * 0.72, 0.02);

      outGain.setValueAtTime(1.0, startAt);
      outGain.linearRampToValueAtTime(0.0001, startAt + dur * 0.76);
    } else if (style === 'TENSION_ROLL_DROP') {
      // 4-bar beat roll tension on Deck A (loop last 1 bar -> half bar) + filter rise -> slam B
      const posA = this.getDeckPosition(outDeckId);
      if (outDeck.stretch) {
        outDeck.stretch.schedule({
          output: startAt,
          loopStart: Math.max(0, posA - beatSec * 2),
          loopEnd: Math.max(0.2, posA),
        });
        outDeck.stretch.schedule({
          output: startAt + dur * 0.5,
          loopStart: Math.max(0, posA - beatSec),
          loopEnd: Math.max(0.1, posA),
        });
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
      if (outDeck.stretch) {
        outDeck.stretch.schedule({ output: startAt + dur * 0.3, rate: 0.78, semitones: -4 });
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

  #schedulePercussionBridge(when, bpm, bars) {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    if (!this.drumSamples) {
      const makeBuf = (sec, fn) => {
        const b = this.ctx.createBuffer(1, Math.floor(sr * sec), sr);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = fn(i / sr);
        return b;
      };
      this.drumSamples = {
        kick: makeBuf(0.24, (t) => Math.sin(2 * Math.PI * (52 * t + 90 * (1 - Math.exp(-t * 28)) / 28)) * Math.exp(-t * 17)),
        snare: makeBuf(0.15, (t) => ((Math.random() * 2 - 1) * 0.68 + Math.sin(2 * Math.PI * 195 * t) * 0.32) * Math.exp(-t * 22)),
        hat: makeBuf(0.045, (t) => ((Math.random() * 2 - 1) * 0.6 + Math.sin(2 * Math.PI * 7400 * t) * 0.35) * Math.exp(-t * 82)),
      };
    }
    const beat = 60 / Math.max(60, bpm);
    const totalBeats = Math.ceil(bars * 4);
    const hit = (buf, at, gainVal, hpFreq = 0) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      let node = src;
      if (hpFreq) {
        const f = this.ctx.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = hpFreq;
        src.connect(f);
        node = f;
      }
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(gainVal, at + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, at + buf.duration * 0.92);
      node.connect(g);
      g.connect(this.masterFilter);
      src.start(at);
      src.stop(at + buf.duration + 0.02);
    };
    for (let k = 0; k < totalBeats; k++) {
      const at = when + k * beat;
      if (k % 2 === 0) hit(this.drumSamples.kick, at, k % 4 === 0 ? 0.22 : 0.14);
      if (k % 4 === 1 || k % 4 === 3) hit(this.drumSamples.snare, at, 0.09, 240);
      hit(this.drumSamples.hat, at + beat * 0.5, 0.04, 6200);
    }
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

  setMasterFilter(hz) {
    if (!this.masterFilter) return;
    this.masterFilter.frequency.setTargetAtTime(Math.max(160, Math.min(20000, hz)), this.ctx.currentTime, 0.03);
  }

  setDeckEcho(deckId, amount) {
    const deck = this.decks[deckId];
    if (!deck) return;
    deck.strip.echoSend.gain.setTargetAtTime(Math.max(0, Math.min(0.85, amount)), this.ctx.currentTime, 0.04);
  }

  setDeckReverb(deckId, amount) {
    const deck = this.decks[deckId];
    if (!deck) return;
    deck.strip.reverbSend.gain.setTargetAtTime(Math.max(0, Math.min(0.85, amount)), this.ctx.currentTime, 0.04);
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
