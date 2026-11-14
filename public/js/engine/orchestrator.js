import { getHarmonicMatch } from './camelot.js';
import { TRANSITION_TYPES, planSetHeuristic } from './dj-brain.js';
import { ProMixerEngine } from './pro-mixer-engine.js';
import { YouTubeDeckEngine } from './youtube-deck-engine.js';

export { planSetHeuristic };

/**
 * Neutral pre-decode bar array until real Web Audio PCM decode computes analysis.heat.
 */
export function buildFallbackHeat(track) {
  if (Array.isArray(track.heat) && track.heat.length >= 24) return track.heat;
  return Array.from({ length: 88 }, () => 0.16);
}

/**
 * AI Setlist Sequencer: sorts tracks using BPM proximity, Camelot harmonic
 * graph traversal, energy arc shaping (warmup / peak / winddown / bangers),
 * and artist separation.
 */
export function sequenceCrate(tracks, { vibe = 'peak', playMode = 'club' } = {}) {
  const pool = tracks.map((t) => ({ ...t, heat: buildFallbackHeat(t) }));
  if (pool.length <= 1) return pool;

  const targetEnergy = (t) => Number(t.energy) || 7;
  let startIdx = 0;
  if (vibe === 'warmup') {
    startIdx = pool.reduce((best, t, i) => (targetEnergy(t) < targetEnergy(pool[best]) ? i : best), 0);
  } else if (vibe === 'winddown') {
    startIdx = pool.reduce((best, t, i) => (targetEnergy(t) > targetEnergy(pool[best]) ? i : best), 0);
  } else if (vibe === 'bangers') {
    startIdx = pool.reduce((best, t, i) => (targetEnergy(t) > targetEnergy(pool[best]) ? i : best), 0);
  }

  const ordered = [pool.splice(startIdx, 1)[0]];

  while (pool.length) {
    const prev = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      let score = 0;

      // DSP tracks grouped cleanly or matched by BPM
      if (prev.bpm && cand.bpm) {
        const delta = Math.abs(prev.bpm - cand.bpm) / Math.max(60, prev.bpm);
        score += 38 * (1 - Math.min(1, delta / 0.16));
      } else {
        score += 18;
      }

      // Harmonic Camelot fit
      score += getHarmonicMatch(prev.camelot, cand.camelot).score;

      // Energy arc fit
      const eDiff = targetEnergy(cand) - targetEnergy(prev);
      if (vibe === 'warmup') {
        score += eDiff >= 0 && eDiff <= 2 ? 22 : 12 - Math.abs(eDiff - 1) * 4;
      } else if (vibe === 'winddown') {
        score += eDiff <= 0 && eDiff >= -2 ? 22 : 12 - Math.abs(eDiff + 1) * 4;
      } else if (vibe === 'bangers') {
        score += targetEnergy(cand) * 3;
      } else {
        score += 20 - Math.abs(eDiff) * 3;
      }

      // Avoid back-to-back identical artists
      const prevArtist = String(prev.artist || '').toLowerCase().split(/[,&]/)[0].trim();
      const candArtist = String(cand.artist || '').toLowerCase().split(/[,&]/)[0].trim();
      if (prevArtist && candArtist && prevArtist === candArtist) score -= 24;

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    ordered.push(pool.splice(bestIdx, 1)[0]);
  }

  // Normalize entry/exit cues per chosen playMode
  return ordered.map((t) => {
    const dur = Number(t.durationSec) || 210;
    if (playMode === 'hooks') {
      const en = t.hookEntry ?? Math.min(Math.round(dur * 0.25), 50);
      const ex = t.hookExit ?? Math.min(dur - 4, Math.max(en + 45, Math.round(dur * 0.72)));
      return { ...t, entrySec: en, exitSec: ex, playFull: false };
    }
    if (playMode === 'festival') {
      const en = t.clubEntry ?? Math.min(18, Math.round(dur * 0.08));
      const ex = Math.min(dur - 4, Math.max(en + 75, Math.round(dur * 0.76)));
      return { ...t, entrySec: en, exitSec: ex, playFull: false };
    }
    // Club Mode (Default): full song body with clean intro/outro phrase cues
    const en = t.clubEntry ?? Math.min(10, Math.round(dur * 0.04));
    const ex = t.clubExit ?? Math.max(en + 60, Math.round(dur - Math.min(26, dur * 0.14)));
    return { ...t, entrySec: en, exitSec: ex, playFull: false };
  });
}

/**
 * Unified Dual-Deck AI DJ Orchestrator
 * - Full-DSP Audio & Local Video (.mp4/.webm): Web Audio AudioContext + AudioWorklet + SignalsmithStretch + EQ/Filters/FX.
 * - Optional Official YouTube IFrame Video Mode: discrete cue/volume crossfade only (no Web Audio DSP).
 */
export class NovaOrchestrator {
  constructor(ytHostEl, onUpdate) {
    this.ytHost = ytHostEl;
    this.onUpdate = onUpdate;
    this.proMixer = new ProMixerEngine();
    this.ytEngine = ytHostEl ? new YouTubeDeckEngine(ytHostEl, {}) : null;

    this.queue = [];
    this.nextIndex = 0;
    this.liveDeckId = 'A';
    this.decks = {
      A: { id: 'A', engine: 'dsp', track: null, status: 'empty', playFull: false, position: 0, duration: 0, cutAt: null, ytVol: 0 },
      B: { id: 'B', engine: 'dsp', track: null, status: 'empty', playFull: false, position: 0, duration: 0, cutAt: null, ytVol: 0 },
    };

    this.vibe = 'peak';
    this.playMode = 'club';
    this.ytCrossfadeSec = 5.5;
    this.recipes = [];
    this.appliedRecipes = [];
    this.transitionLog = [];
    this.clickTrackEnabled = false;
    this.running = false;
    this.paused = false;
    this.crossfading = false;
    this.finished = false;
    this.previewActive = false;
    this.transitionPlan = null;
    this.agentMessage = 'NOVA AI DJ STANDING BY';
    this.playedHistory = [];
    this.clockUnsub = null;
    this.pendingTransition = null;
    this.pendingEndAt = null;
    this.djActionFeed = [];
    this.recordedEventKeys = new Set();
    this.autoDjFxEnabled = true;
    this.phraseFillDoneTrackIds = new Set();
  }

  #isDspTrack(track) {
    return Boolean(track && (track.file || track.stemFiles || track.stemUrls || (track.dspReady && track.streamUrl)));
  }

  #isYtTrack(track) {
    return Boolean(track && track.videoId && !this.#isDspTrack(track));
  }

  #isPlayableTrack(track) {
    return this.#isDspTrack(track) || this.#isYtTrack(track);
  }

  async #ensureYtReady() {
    if (!this.ytEngine && this.ytHost) {
      this.ytEngine = new YouTubeDeckEngine(this.ytHost, {});
    }
    if (!this.ytEngine) throw new Error('YouTube video player host unavailable.');
    await this.ytEngine.init();
  }

  async startSet(tracks, { vibe = 'peak', playMode = 'club', recipes = [], ytCrossfadeSec = 5.5 } = {}) {
    this.stop(true);
    const playable = (tracks || []).filter((t) => this.#isPlayableTrack(t));
    if (!playable.length) {
      throw new Error('No playable audio or YouTube video tracks found.');
    }
    this.vibe = vibe;
    this.playMode = playMode;
    this.ytCrossfadeSec = Math.max(2, Math.min(12, Number(ytCrossfadeSec) || 5.5));
    this.recipes = Array.isArray(recipes) ? recipes.slice() : [];
    this.appliedRecipes = [];
    this.djActionFeed = [];
    this.recordedEventKeys.clear();
    this.phraseFillDoneTrackIds.clear();
    this.proMixer.clearScheduledEvents?.();
    this.proMixer.clickTrackEnabled = this.clickTrackEnabled;
    this.queue = playable.slice();
    this.nextIndex = 0;
    this.playedHistory = [];
    this.finished = false;
    this.paused = false;
    this.crossfading = false;
    this.running = true;
    this.liveDeckId = 'A';

    this.decks.A.track = this.queue[0] || null;
    this.decks.A.status = this.queue[0] ? 'loading' : 'empty';
    this.decks.B.track = this.queue[1] || null;
    this.decks.B.status = this.queue[1] ? 'loading' : 'empty';

    await this.proMixer.ensureContext();
    if (playable.some((t) => this.#isYtTrack(t))) {
      await this.#ensureYtReady();
    }

    const first = this.#popNext();
    if (!first) return;

    this.liveDeckId = 'A';
    await this.#loadAndStartLive('A', first);

    const second = this.#popNext();
    if (second) {
      await this.#preloadDeck('B', second);
    }
    this.#syncLiveCutTiming();
    this.#prewarmUpcoming();

    this.#startTick();
    this.#emit();
  }

  #syncLiveCutTiming() {
    const liveSlot = this.decks[this.liveDeckId];
    const cueId = this.liveDeckId === 'A' ? 'B' : 'A';
    const cueSlot = this.decks[cueId];
    if (!liveSlot?.track || liveSlot.playFull) return;
    const dur = liveSlot.duration || liveSlot.track.durationSec || 180;
    const barDur = (60 / Math.max(55, liveSlot.track.bpm || 120)) * 4;
    const matched = this.recipes.find((r) => r.from === liveSlot.track.id && (!cueSlot?.track || r.to === cueSlot.track.id));
    if (matched && Number.isFinite(matched.mix_out_bar)) {
      const bars = liveSlot.track.bars || liveSlot.track.analysis?.bars;
      const mixOutSec = bars?.[matched.mix_out_bar]?.start_sec ?? matched.mix_out_bar * barDur;
      const transSec = (Number(matched.length_bars) || 8) * barDur;
      liveSlot.mixOutSec = Math.max(2, Math.min(dur - 4, mixOutSec));
      liveSlot.cutAt = Math.min(dur - 1.5, liveSlot.mixOutSec + transSec);
    } else {
      liveSlot.mixOutSec = null;
    }
  }

  #prewarmUpcoming() {
    // Phase 6: pre-decode next 2 upcoming DSP tracks in background while live set plays
    const upcoming = this.queue.slice(this.nextIndex, this.nextIndex + 2);
    for (const t of upcoming) {
      if (this.#isDspTrack(t) && !this.proMixer.decodedCache.has(t.id)) {
        this.proMixer.decodeAndAnalyze(t).catch(() => {});
      }
    }
  }

  #popNext() {
    if (this.nextIndex >= this.queue.length) return null;
    return this.queue[this.nextIndex++];
  }

  async #loadAndStartLive(deckId, track) {
    const slot = this.decks[deckId];
    slot.track = track;
    slot.playFull = Boolean(track.playFull);
    slot.status = 'loading';
    this.#emit();

    if (this.#isYtTrack(track)) {
      slot.engine = 'yt';
      try {
        await this.#ensureYtReady();
        this.ytEngine.load(deckId, track, 'live', this.playMode);
        await this.ytEngine.waitForReady(deckId, 7500);
        slot.status = 'live';
        slot.ytVol = 1;
        slot.duration = track.durationSec || 180;
        slot.cutAt = slot.playFull ? slot.duration - 2 : (track.exitSec || Math.max(30, slot.duration - 16));
        this.playedHistory.push(track);
        this.#setAgent(`YT VIDEO · ${track.title.toUpperCase()} · VOLUME FADE ONLY (NO DSP)`);
      } catch (err) {
        this.#setAgent(`Skipped YT track ${track.title}: ${err.message}`);
        const fallback = this.#popNext();
        if (fallback) return this.#loadAndStartLive(deckId, fallback);
        this.#finishSet();
      }
      this.#emit();
      return;
    }

    if (!this.#isDspTrack(track)) {
      throw new Error(`Track "${track?.title || 'unknown'}" has no decodable audio buffer.`);
    }
    slot.engine = 'dsp';
    this.#setAgent(`Analyzing ${track.title} with Dual-Tracker + Essentia WASM…`);
    try {
      const { analysis } = await this.proMixer.loadDeck(deckId, track, {
        gain: 1,
        playMode: this.playMode,
      });
      const startOffset = slot.playFull ? 0 : (track.entrySec ?? analysis.clubEntry);
      await this.proMixer.playDeck(deckId, { offsetSec: startOffset, rate: 1, gain: 1 });
      this.proMixer.masterBpm = analysis.bpm || 120;
      slot.status = 'live';
      slot.duration = analysis.durationSec;
      slot.cutAt = slot.playFull ? analysis.durationSec - 1.5 : (track.exitSec ?? analysis.clubExit);
      this.playedHistory.push(track);
      const stemTag = analysis.stems_available ? 'STEMS ON' : 'EQ ISOLATOR';
      this.#setAgent(`LIVE · ${analysis.bpm} BPM · ${analysis.camelot || 'KEY'} · ${stemTag}`);
    } catch (err) {
      this.#setAgent(`Skipped ${track.title}: ${err.message}`);
      const fallback = this.#popNext();
      if (fallback) return this.#loadAndStartLive(deckId, fallback);
      this.#finishSet();
    }
    this.#emit();
  }

  async #preloadDeck(deckId, track) {
    const slot = this.decks[deckId];
    slot.track = track;
    slot.playFull = Boolean(track.playFull);
    slot.status = 'loading';
    this.#emit();

    if (this.#isYtTrack(track)) {
      slot.engine = 'yt';
      try {
        await this.#ensureYtReady();
        this.ytEngine.load(deckId, track, 'preload', this.playMode);
        await this.ytEngine.waitForReady(deckId, 7500);
        slot.status = 'ready';
        slot.ytVol = 0;
        slot.duration = track.durationSec || 180;
        slot.cutAt = slot.playFull ? slot.duration - 2 : (track.exitSec || Math.max(30, slot.duration - 16));
      } catch (err) {
        this.#setAgent(`Couldn't preload YT ${track.title}: ${err.message}`);
        const nxt = this.#popNext();
        if (nxt) return this.#preloadDeck(deckId, nxt);
        slot.status = 'empty';
        slot.track = null;
      }
      this.#emit();
      return;
    }

    if (!this.#isDspTrack(track)) {
      slot.status = 'empty';
      slot.track = null;
      this.#emit();
      return;
    }
    slot.engine = 'dsp';
    try {
      const { analysis } = await this.proMixer.loadDeck(deckId, track, {
        gain: 0,
        playMode: this.playMode,
      });
      slot.status = 'ready';
      slot.duration = analysis.durationSec;
      slot.cutAt = slot.playFull ? analysis.durationSec - 1.5 : (track.exitSec ?? analysis.clubExit);
      this.transitionPlan = this.proMixer.planTransition(this.liveDeckId, deckId, {
        vibe: this.vibe,
        playMode: this.playMode,
      });
    } catch (err) {
      this.#setAgent(`Couldn't load ${track.title}: ${err.message}`);
      const nxt = this.#popNext();
      if (nxt) return this.#preloadDeck(deckId, nxt);
      slot.status = 'empty';
      slot.track = null;
    }
    this.#emit();
  }

  #startTick() {
    if (this.clockUnsub) {
      this.clockUnsub();
      this.clockUnsub = null;
    }
    this.clockUnsub = this.proMixer.addClockListener((audioTime) => this.#onAudioClock(audioTime));
  }

  #waitUntilAudioTime(targetCtxTime) {
    return new Promise((resolve) => {
      if (!this.proMixer.ctx || this.proMixer.ctx.currentTime >= targetCtxTime) return resolve();
      const unsub = this.proMixer.addClockListener((t) => {
        if ((!this.running && !this.previewActive) || t >= targetCtxTime) {
          unsub();
          resolve();
        }
      });
    });
  }

  #onAudioClock(audioTime) {
    if (!this.running || this.finished || this.paused) return;

    if (this.pendingEndAt !== null) {
      if (this.pendingEndYtId) {
        const p = Math.max(0, Math.min(1, 1 - (this.pendingEndAt - audioTime) / 2.5));
        const v = Math.cos((p * Math.PI) / 2);
        this.decks[this.pendingEndYtId].ytVol = v;
        this.ytEngine?.setVolume(this.pendingEndYtId, v);
      }
      if (audioTime >= this.pendingEndAt) {
        const liveId = this.liveDeckId;
        this.pendingEndAt = null;
        this.pendingEndYtId = null;
        if (this.decks[liveId]?.engine === 'yt') {
          this.ytEngine?.stopAll();
        } else {
          this.proMixer.stopDeck(liveId).catch(() => {});
        }
        this.#finishSet();
        return;
      }
    }

    if (this.pendingTransition?.ytFade) {
      const f = this.pendingTransition.ytFade;
      const p = Math.max(0, Math.min(1, (audioTime - f.startAt) / Math.max(0.5, f.endAt - f.startAt)));
      const smooth = p * p * (3 - 2 * p);
      const vIn = Math.sin((smooth * Math.PI) / 2);
      const vOut = Math.cos((smooth * Math.PI) / 2);
      if (f.outEngine === 'yt') {
        this.decks[f.outId].ytVol = vOut;
        this.ytEngine?.setVolume(f.outId, vOut);
      } else {
        this.proMixer.decks[f.outId]?.strip.deckVolume.gain.setTargetAtTime(Math.max(0.0001, vOut), audioTime, 0.03);
      }
      if (f.inEngine === 'yt') {
        this.decks[f.inId].ytVol = vIn;
        this.ytEngine?.setVolume(f.inId, vIn);
      } else {
        this.proMixer.decks[f.inId]?.strip.deckVolume.gain.setTargetAtTime(Math.max(0.0001, vIn), audioTime, 0.03);
      }
    }

    if (this.pendingTransition && audioTime >= this.pendingTransition.endAt) {
      this.#completeTransition();
      return;
    }

    const liveId = this.liveDeckId;
    const cueId = liveId === 'A' ? 'B' : 'A';
    const liveSlot = this.decks[liveId];
    const cueSlot = this.decks[cueId];

    if (liveSlot.engine === 'yt') {
      const yp = this.ytEngine?.getPosition(liveId);
      if (yp) {
        liveSlot.position = yp.seconds;
        if (yp.duration > 10) liveSlot.duration = yp.duration;
      }
    } else {
      liveSlot.position = this.proMixer.getDeckPosition(liveId);
      liveSlot.duration = liveSlot.track?.durationSec || liveSlot.duration;
    }
    if (this.crossfading && cueSlot?.track) {
      if (cueSlot.engine === 'yt') {
        const cy = this.ytEngine?.getPosition(cueId);
        if (cy) cueSlot.position = cy.seconds;
      } else {
        cueSlot.position = this.proMixer.getDeckPosition(cueId);
      }
      if (this.pendingTransition && liveSlot.engine === 'dsp' && cueSlot.engine === 'dsp') {
        const dMs = this.proMixer.measureDualDeckDriftMs();
        if (dMs !== null) this.pendingTransition.driftSamples.push(dMs);
      }
    }
    if (liveSlot.engine === 'dsp') {
      this.proMixer.scheduleClickLookahead(liveId);
      if (!this.crossfading) this.proMixer.checkDriftAndCorrect(liveId);
    }

    // Query genuine AudioContext-scheduled DSP events (zero fake/cosmetic timers)
    const liveEvents = this.proMixer.getLiveEventsSnapshot(audioTime);
    for (const ev of liveEvents.triggered) {
      const key = `${ev.id}_${ev.category}_${ev.label}`;
      if (!this.recordedEventKeys.has(key)) {
        this.recordedEventKeys.add(key);
        const pos = liveSlot.position || 0;
        const mm = Math.floor(pos / 60);
        const ss = Math.floor(pos % 60).toString().padStart(2, '0');
        this.djActionFeed.unshift({
          id: ev.id,
          category: ev.category,
          label: ev.label,
          detail: ev.detail,
          deckId: ev.deckId,
          timestamp: `${mm}:${ss}`,
          startAt: ev.startAt,
          endAt: ev.endAt,
        });
        if (this.djActionFeed.length > 40) {
          this.djActionFeed.length = 40;
        }
      }
    }

    // Autonomous creative DJ phrase accents (runs only on high-confidence DSP tracks)
    if (this.autoDjFxEnabled && liveSlot.engine === 'dsp' && !this.crossfading && liveSlot.position > 16) {
      const bpm = (liveSlot.track?.bpm || 120);
      const beatSec = 60 / Math.max(55, bpm);
      const barSec = beatSec * 4;
      const currentBar = Math.floor(liveSlot.position / barSec);
      const isPhraseBoundary = (currentBar > 0) && (currentBar % 16 === 15);
      const fillKey = `${liveSlot.track?.id}_bar${currentBar}`;
      if (isPhraseBoundary && !this.phraseFillDoneTrackIds.has(fillKey)) {
        const timeUntilCut = (liveSlot.cutAt || 180) - liveSlot.position;
        if (timeUntilCut > 18) {
          this.phraseFillDoneTrackIds.add(fillKey);
          const genre = (liveSlot.track?.genre || '').toLowerCase();
          const drumStyle = /punjabi|bhangra|dhol/i.test(genre) ? 'dhol'
            : /bollywood|desi|indian/i.test(genre) ? 'tabla'
            : /hip hop|trap/i.test(genre) ? 'trap' : 'house';
          this.proMixer.triggerAutonomousPhraseOverlay(liveId, drumStyle, 2);
          this.#setAgent(`AUTONOMOUS FILL: 2-BAR ${drumStyle.toUpperCase()} ACCENT`);
        }
      }
    }

    if (!this.crossfading && liveSlot.cutAt && liveSlot.position > 1) {
      const hasPlannedOut = Number.isFinite(liveSlot.mixOutSec) && !liveSlot.playFull;
      const transSec = this.transitionPlan?.durationSec || 8;
      const startMixAt = hasPlannedOut ? liveSlot.mixOutSec : (liveSlot.cutAt - transSec - 0.35);
      const timeUntilMix = startMixAt - liveSlot.position;

      if ((cueSlot.status === 'ready' || (cueSlot.status === 'loading' && timeUntilMix <= 1.5)) && timeUntilMix <= 0.15 && timeUntilMix > -6) {
        this.triggerTransition('auto');
      } else if (cueSlot.status === 'empty' && (liveSlot.cutAt - liveSlot.position) <= 3) {
        this.#endLastTrack(liveId);
      } else if (cueSlot.track && timeUntilMix <= 10 && timeUntilMix > 0.15) {
        const matched = this.recipes.find((r) => r.from === liveSlot.track?.id && r.to === cueSlot.track?.id);
        const label = (matched?.type || this.transitionPlan?.style || 'BASS SWAP BLEND').replace(/_/g, ' ').toUpperCase();
        this.#setAgent(`${label} INTO ${cueSlot.track.title.toUpperCase()} IN ${Math.ceil(timeUntilMix)}S`);
      }
    } else if (this.crossfading && liveEvents.active.length) {
      const topActive = liveEvents.active[0];
      const pct = Math.round(topActive.progress01 * 100);
      this.#setAgent(`[LIVE MOVE] ${topActive.label} (${pct}%) · ${topActive.detail || ''}`);
    }
    this.#emit();
  }

  async #completeTransition() {
    const pending = this.pendingTransition;
    if (!pending) return;
    this.pendingTransition = null;
    const { outId, inId, logDraft, driftSamples, ytFade } = pending;
    const outSlot = this.decks[outId];
    const inSlot = this.decks[inId];
    if (logDraft) {
      const sorted = (driftSamples || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
      const medDrift = ytFade ? null : (sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : this.proMixer.measureDualDeckDriftMs());
      this.transitionLog.push({
        ...logDraft,
        index: this.transitionLog.length + 1,
        driftMs: medDrift,
      });
    }

    if (outSlot?.engine === 'yt') {
      this.ytEngine?.setVolume(outId, 0);
      try { this.ytEngine?.decks?.[outId]?.player?.pauseVideo(); } catch {}
      outSlot.ytVol = 0;
    } else if (ytFade) {
      this.proMixer.stopDeck(outId).catch(() => {});
    }

    if (inSlot?.track) {
      if (inSlot.engine === 'dsp') {
        this.proMixer.masterBpm = (inSlot.track.bpm || 120) * (this.proMixer.decks[inId]?.rate || 1);
      } else {
        inSlot.ytVol = 1;
        this.ytEngine?.setVolume(inId, 1);
      }
      this.liveDeckId = inId;
      inSlot.status = 'live';
      this.playedHistory.push(inSlot.track);
    }
    if (outSlot) {
      outSlot.status = 'empty';
      outSlot.track = null;
      outSlot.position = 0;
    }
    this.crossfading = false;

    const upcoming = this.#popNext();
    if (upcoming) {
      this.#setAgent(`LIVE · ${inSlot?.track?.title?.toUpperCase() || 'DECK'} · NEXT: ${upcoming.title.toUpperCase()}`);
      await this.#preloadDeck(outId, upcoming);
      this.#syncLiveCutTiming();
      this.#prewarmUpcoming();
    } else if (inSlot?.track) {
      this.#syncLiveCutTiming();
      this.#setAgent(`FINAL TRACK · ${inSlot.track.title.toUpperCase()}`);
    }
    this.#emit();
  }

  async triggerTransition(reason = 'manual', styleOverride = null) {
    if (!this.running || this.crossfading || this.finished) return;
    const outId = this.liveDeckId;
    const inId = outId === 'A' ? 'B' : 'A';
    const outSlot = this.decks[outId];
    const inSlot = this.decks[inId];

    if (!inSlot.track) {
      return this.#endLastTrack(outId);
    }

    this.crossfading = true;
    this.paused = false;

    if (outSlot.engine !== 'dsp' || inSlot.engine !== 'dsp') {
      const durSec = this.ytCrossfadeSec || 5.5;
      const startAt = this.proMixer.ctx.currentTime + 0.08;
      const endAt = startAt + durSec;
      this.transitionPlan = {
        style: 'YT_VOLUME_CROSSFADE',
        bars: 4,
        ytOnly: true,
        harmonic: { relation: 'YT IFrame Volume Fade Only (no EQ/stems/beatmatch)' },
      };
      this.#setAgent(`YT VOLUME FADE -> ${inSlot.track.title.toUpperCase()} (NO DSP ON YT IFRAME)`);
      this.#emit();
      if (inSlot.engine === 'yt') {
        await this.ytEngine.playPreloaded(inId);
        this.ytEngine.setVolume(inId, 0);
      } else {
        await this.proMixer.playDeck(inId, { offsetSec: inSlot.track.entrySec || 0, rate: 1, gain: 0.001, when: startAt });
      }
      if (outSlot.engine === 'dsp') {
        this.proMixer.scheduleDeckStopAt(outId, endAt + 0.06);
      }
      this.pendingTransition = {
        outId,
        inId,
        endAt: endAt + 0.08,
        ytFade: { outId, inId, outEngine: outSlot.engine, inEngine: inSlot.engine, startAt, endAt },
        driftSamples: [],
        logDraft: {
          fromTitle: outSlot.track.title,
          toTitle: inSlot.track.title,
          type: 'yt_volume_crossfade',
          bars: 4,
          eqMoves: ['none (YT iframe)'],
          fxMoves: ['volume_curve'],
          reason: 'Official YouTube IFrame deck: discrete cue & equal-power volume fade only (Web Audio DSP unavailable).',
          fallbackUsed: false,
          ytOnly: true,
        },
      };
      this.#emit();
      return;
    }

    const matchedRecipe = !styleOverride
      ? this.recipes.find((r) => r.from === outSlot.track?.id && r.to === inSlot.track?.id)
      : null;

    let waitEndAt;
    let logDraft = null;
    if (matchedRecipe && TRANSITION_TYPES.includes(matchedRecipe.type)) {
      this.transitionPlan = {
        ...matchedRecipe,
        style: matchedRecipe.type.toUpperCase(),
        bars: matchedRecipe.length_bars,
        harmonic: { relation: matchedRecipe.why || 'validated recipe' },
      };
      this.appliedRecipes.push(matchedRecipe);
      this.#setAgent(
        `MIXING (${matchedRecipe.type.replace(/_/g, ' ').toUpperCase()}) · ${matchedRecipe.length_bars} BARS · VALIDATED ✓`
      );
      this.#emit();
      const res = await this.proMixer.executeRecipe(outId, inId, matchedRecipe);
      waitEndAt = res.endAt;
      logDraft = {
        fromTitle: outSlot.track.title,
        toTitle: inSlot.track.title,
        type: matchedRecipe.type,
        bars: matchedRecipe.length_bars,
        eqMoves: (matchedRecipe.eq_automation || []).map((e) => `${e.deck} ${e.band}`),
        fxMoves: (matchedRecipe.fx || []).map((f) => f.type),
        reason: matchedRecipe.why || 'AI recipe',
        fallbackUsed: Boolean(
          matchedRecipe.fallbackUsed ||
          matchedRecipe.validation?.fallbackApplied ||
          (matchedRecipe.validation && !matchedRecipe.validation.valid) ||
          /fallback/i.test(matchedRecipe.why || '')
        ),
      };
    } else {
      const plan = this.proMixer.planTransition(outId, inId, {
        vibe: this.vibe,
        playMode: this.playMode,
        overrideStyle: styleOverride,
      });
      this.transitionPlan = plan;
      this.#setAgent(
        `MIXING (${plan.style.replace(/_/g, ' ')}) · ${plan.bars} BARS · ${plan.harmonic.relation.toUpperCase()}`
      );
      this.#emit();
      const res = await this.proMixer.executeTransition(outId, inId, plan);
      waitEndAt = res.endAt;
      logDraft = {
        fromTitle: outSlot.track.title,
        toTitle: inSlot.track.title,
        type: plan.style,
        bars: plan.bars,
        eqMoves: ['A low->cut', 'B low->in'],
        fxMoves: [plan.style.toLowerCase()],
        reason: `${plan.harmonic?.relation || 'phrase align'} (${reason})`,
        fallbackUsed: false,
      };
    }

    // Schedule exact stop of outgoing deck directly on AudioContext.currentTime (zero setTimeout)
    this.proMixer.scheduleDeckStopAt(outId, waitEndAt + 0.04);
    this.pendingTransition = { outId, inId, endAt: waitEndAt + 0.06, logDraft, driftSamples: [] };
    this.#emit();
  }

  #endLastTrack(liveId) {
    if (this.pendingEndAt !== null) return;
    this.crossfading = true;
    const now = this.proMixer.ctx.currentTime;
    const fadeEnd = now + 2.5;
    if (this.decks[liveId]?.engine === 'yt') {
      this.pendingEndYtId = liveId;
    } else {
      this.pendingEndYtId = null;
      this.proMixer.decks[liveId]?.strip.deckVolume.gain.linearRampToValueAtTime(0.0001, fadeEnd);
      this.proMixer.scheduleDeckStopAt(liveId, fadeEnd + 0.05);
    }
    this.pendingEndAt = fadeEnd + 0.08;
    this.#emit();
  }

  #finishSet() {
    this.running = false;
    this.crossfading = false;
    this.finished = true;
    this.pendingTransition = null;
    this.pendingEndAt = null;
    if (this.clockUnsub) {
      this.clockUnsub();
      this.clockUnsub = null;
    }
    this.#setAgent('SET COMPLETE · READY FOR ANOTHER ROUND');
    this.#emit();
  }

  async togglePause() {
    if (!this.running || this.finished || this.crossfading) return;
    this.paused = !this.paused;
    const isYt = this.decks[this.liveDeckId]?.engine === 'yt';
    if (this.paused) {
      if (isYt) this.ytEngine?.pause(this.liveDeckId);
      else await this.proMixer.pauseDeck(this.liveDeckId);
    } else {
      if (isYt) this.ytEngine?.resume(this.liveDeckId);
      else await this.proMixer.resumeDeck(this.liveDeckId);
    }
    this.#emit();
  }

  async seekLive(targetSec) {
    const slot = this.decks[this.liveDeckId];
    if (!slot?.track || this.crossfading) return;
    slot.position = targetSec;
    if (slot.cutAt && targetSec >= slot.cutAt - 3) {
      slot.playFull = true;
      slot.cutAt = slot.duration - 2;
    }
    if (slot.engine === 'yt') this.ytEngine?.seek(this.liveDeckId, targetSec);
    else await this.proMixer.seekDeck(this.liveDeckId, targetSec);
    this.#emit();
    return slot.track;
  }

  playFullLive() {
    const slot = this.decks[this.liveDeckId];
    if (!slot?.track) return;
    slot.playFull = true;
    slot.cutAt = Math.max(slot.position + 5, (slot.duration || 210) - 2);
    this.#setAgent(`PLAYING ${slot.track.title.toUpperCase()} IN FULL`);
    this.#emit();
  }

  async playNextOverride(track) {
    const cueId = this.liveDeckId === 'A' ? 'B' : 'A';
    const currentCue = this.decks[cueId].track;
    if (currentCue && currentCue.id !== track.id) {
      this.queue.splice(this.nextIndex, 0, currentCue);
    }
    await this.#preloadDeck(cueId, track);
    this.#setAgent(`CUED NEXT: ${track.title.toUpperCase()}`);
    this.#emit();
  }

  async dropNextFromQueue() {
    const cueId = this.liveDeckId === 'A' ? 'B' : 'A';
    const dropped = this.decks[cueId].track;
    const nxt = this.#popNext();
    if (nxt) await this.#preloadDeck(cueId, nxt);
    else {
      this.decks[cueId].status = 'empty';
      this.decks[cueId].track = null;
    }
    this.#emit();
    return dropped;
  }

  requeueRemaining(newTracks) {
    this.queue = newTracks.slice();
    this.nextIndex = 0;
    const cueId = this.liveDeckId === 'A' ? 'B' : 'A';
    if (!this.crossfading) {
      const nxt = this.#popNext();
      if (nxt) this.#preloadDeck(cueId, nxt);
    }
    this.#emit();
  }

  skip() {
    if (!this.running || this.finished || this.crossfading) return;
    return this.triggerTransition('skip');
  }

  mixNow(styleOverride = null) {
    if (!this.running || this.finished || this.crossfading) return;
    return this.triggerTransition('manual', styleOverride);
  }

  setLiveStem(stem, gain) {
    const slot = this.decks[this.liveDeckId];
    if (slot?.engine === 'dsp') {
      this.proMixer.decks[this.liveDeckId]?.strip.setStem(stem, gain);
    }
  }

  setLiveFilter(norm) {
    const slot = this.decks[this.liveDeckId];
    if (slot?.engine === 'dsp') {
      this.proMixer.decks[this.liveDeckId]?.strip.setColorFilter(norm);
    }
  }

  setLiveEcho(amount) {
    const slot = this.decks[this.liveDeckId];
    if (slot?.engine === 'dsp') this.proMixer.setDeckEcho(this.liveDeckId, amount);
  }

  setLiveReverb(amount) {
    const slot = this.decks[this.liveDeckId];
    if (slot?.engine === 'dsp') this.proMixer.setDeckReverb(this.liveDeckId, amount);
  }

  async toggleLiveLoop() {
    const slot = this.decks[this.liveDeckId];
    if (slot?.engine !== 'dsp') return false;
    return this.proMixer.toggleLoopBars(this.liveDeckId, 4);
  }

  setClickTrack(enabled) {
    this.clickTrackEnabled = Boolean(enabled);
    this.proMixer.clickTrackEnabled = this.clickTrackEnabled;
    this.proMixer.lastScheduledBeatIdx = -1;
    this.#emit();
  }

  async triggerSpinbackLive() {
    const slot = this.decks[this.liveDeckId];
    if (slot?.engine === 'dsp') {
      await this.proMixer.triggerSpinback(this.liveDeckId);
    }
  }

  async triggerTapeStopLive() {
    const slot = this.decks[this.liveDeckId];
    if (slot?.engine === 'dsp') {
      await this.proMixer.triggerTapeStop(this.liveDeckId, 0.85, null, true);
    }
  }

  async previewTransition(trackA, trackB, recipe) {
    if (!this.#isDspTrack(trackA) || !this.#isDspTrack(trackB)) {
      throw new Error('Transition preview requires local files or Audius Full-DSP tracks.');
    }
    this.stop(true);
    this.previewActive = true;
    try {
      await this.proMixer.ensureContext();
      const { analysis: a } = await this.proMixer.loadDeck('A', trackA, { gain: 1, playMode: this.playMode });
      await this.proMixer.loadDeck('B', trackB, { gain: 0, playMode: this.playMode });
      const barDur = (60 / Math.max(55, a.bpm || 120)) * 4;
      const preBar = Math.max(0, (recipe.mix_out_bar || 4) - 2);
      const startSec = a.bars?.[preBar]?.start_sec ?? preBar * barDur;
      await this.proMixer.playDeck('A', { offsetSec: Math.min(a.durationSec - 6, startSec), rate: 1, gain: 1 });
      const leadEnd = this.proMixer.ctx.currentTime + Math.min(3.5, barDur * 2);
      await this.#waitUntilAudioTime(leadEnd);
      if (!this.previewActive) return;
      const { endAt } = await this.proMixer.executeRecipe('A', 'B', recipe);
      const stopAt = Math.min(this.proMixer.ctx.currentTime + 10, endAt + 0.6);
      this.proMixer.scheduleDeckStopAt('A', stopAt);
      this.proMixer.scheduleDeckStopAt('B', stopAt);
      await this.#waitUntilAudioTime(stopAt + 0.05);
    } finally {
      this.previewActive = false;
      this.proMixer.stopDeck('A');
      this.proMixer.stopDeck('B');
    }
  }

  stop(silent = false) {
    this.running = false;
    this.paused = false;
    this.crossfading = false;
    this.previewActive = false;
    this.pendingTransition = null;
    this.pendingEndAt = null;
    if (this.clockUnsub) {
      this.clockUnsub();
      this.clockUnsub = null;
    }
    this.proMixer.stopDeck('A');
    this.proMixer.stopDeck('B');
    this.ytEngine?.stopAll();
    this.decks.A.status = 'empty';
    this.decks.A.track = null;
    this.decks.B.status = 'empty';
    this.decks.B.track = null;
    if (!silent) this.#emit();
  }

  #setAgent(msg) {
    this.agentMessage = msg;
  }

  #emit() {
    this.onUpdate?.(this.getSnapshot());
  }

  setLiveEqKill(band, killed) {
    return this.proMixer.setDeckEqKill(this.liveDeckId, band, killed);
  }

  toggleAutoDjFx() {
    this.autoDjFxEnabled = !this.autoDjFxEnabled;
    this.#emit();
    return this.autoDjFxEnabled;
  }

  getSnapshot() {
    const live = this.decks[this.liveDeckId];
    const cueId = this.liveDeckId === 'A' ? 'B' : 'A';
    const cue = this.decks[cueId];
    const liveEvents = this.proMixer.getLiveEventsSnapshot(this.proMixer.ctx?.currentTime ?? 0);
    const readTelemetry = (id) => {
      const slot = this.decks[id];
      if (slot?.engine === 'yt') {
        return {
          engine: 'yt',
          playing: slot.status === 'live',
          rate: 1,
          semitones: 0,
          vol: Math.round((slot.ytVol ?? (slot.status === 'live' ? 1 : 0)) * 100) / 100,
          eqLow: 0, eqMid: 0, eqHigh: 0, hpfHz: 20, lpfHz: 20000, echoSend: 0, reverbSend: 0,
          kills: { low: false, mid: false, high: false },
          bassStem: 1, vocalStem: 1,
        };
      }
      const d = this.proMixer.decks?.[id];
      const st = d?.strip;
      return {
        engine: 'dsp',
        playing: Boolean(d?.playing),
        rate: d?.rate || 1,
        semitones: d?.semitones || 0,
        vol: st ? Math.round((st.deckVolume.gain.value || 0) * 100) / 100 : 0,
        eqLow: st ? Math.round((st.eqLow.gain.value || 0) * 10) / 10 : 0,
        eqMid: st ? Math.round((st.eqMid.gain.value || 0) * 10) / 10 : 0,
        eqHigh: st ? Math.round((st.eqHigh.gain.value || 0) * 10) / 10 : 0,
        hpfHz: st ? Math.round(st.hpf.frequency.value || 20) : 20,
        lpfHz: st ? Math.round(st.lpf.frequency.value || 20000) : 20000,
        echoSend: st ? Math.round((st.echoSend.gain.value || 0) * 100) / 100 : 0,
        reverbSend: st ? Math.round((st.reverbSend.gain.value || 0) * 100) / 100 : 0,
        kills: st?.state?.kills || { low: false, mid: false, high: false },
        bassStem: st ? Math.round((st.state?.bass ?? 1) * 100) / 100 : 1,
        vocalStem: st ? Math.round((st.state?.vocals ?? 1) * 100) / 100 : 1,
      };
    };

    return {
      running: this.running,
      paused: this.paused,
      crossfading: this.crossfading,
      finished: this.finished,
      liveId: this.liveDeckId,
      cueId,
      decks: {
        A: { ...this.decks.A },
        B: { ...this.decks.B },
      },
      liveTrack: live?.track || null,
      cueTrack: cue?.track || null,
      transitionPlan: this.transitionPlan,
      transitionLog: this.transitionLog.slice(),
      agentMessage: this.agentMessage,
      masterBpm: this.proMixer.masterBpm,
      clockMode: this.proMixer.clockMode,
      dualDriftMs: this.crossfading ? this.proMixer.measureDualDeckDriftMs() : null,
      deckTelemetry: { A: readTelemetry('A'), B: readTelemetry('B') },
      spectrum: this.proMixer.getSpectrumEnergy(),
      remainingCount: Math.max(0, this.queue.length - this.nextIndex) + (cue?.track ? 1 : 0),
      activeDspMoves: liveEvents.active,
      djActionFeed: this.djActionFeed.slice(0, 24),
      autoDjFxEnabled: this.autoDjFxEnabled,
    };
  }
}
