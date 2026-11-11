import { getHarmonicMatch } from './camelot.js';
import { TRANSITION_TYPES, planSetHeuristic } from './dj-brain.js';
import { ProMixerEngine } from './pro-mixer-engine.js';
import { YouTubeDeckEngine } from './youtube-deck-engine.js';

export { planSetHeuristic };

/**
 * Generates deterministic 88-bar visual waveform heat when a track hasn't
 * been decoded into AudioBuffer yet (e.g. YouTube IFrame stream).
 */
export function buildFallbackHeat(track) {
  if (Array.isArray(track.heat) && track.heat.length >= 24) return track.heat;
  let h = 0x811c9dc5;
  const seedStr = String(track.id || track.title || 'nova');
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 0x01000193) >>> 0;
  }
  const energy = (Number(track.energy) || 7) / 10;
  return Array.from({ length: 88 }, (_, i) => {
    const p = i / 87;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    const rnd = (h % 1000) / 1000;
    const envelope = Math.min(1, p * 6, (1 - p) * 7.5);
    const groove = 0.62 + 0.38 * Math.sin(p * Math.PI * 5 + (seedStr.length % 7));
    return Math.round(Math.max(0.08, Math.min(1, envelope * groove * (0.55 + energy * 0.45) * (0.6 + rnd * 0.4))) * 1000) / 1000;
  });
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
 * Seamlessly runs BOTH Web Audio DSP tracks (Signalsmith + Stems + 8 Club Transitions)
 * AND YouTube IFrame tracks (pre-cued dual-deck crossfades) inside one continuous live show.
 */
export class NovaOrchestrator {
  constructor(ytHostEl, onUpdate) {
    this.onUpdate = onUpdate;
    this.proMixer = new ProMixerEngine();
    this.ytEngine = new YouTubeDeckEngine(ytHostEl, {
      onDeckReady: (deckId, track) => this.#handleYtReady(deckId, track),
      onDeckLive: (deckId) => this.#emit(),
      onDeckError: (deckId, track, code) => this.#handleYtError(deckId, track, code),
      onTrackEnded: (deckId) => this.#handleDeckEnded(deckId),
    });

    this.queue = [];
    this.nextIndex = 0;
    this.liveDeckId = 'A';
    this.decks = {
      A: { id: 'A', engine: null, track: null, status: 'empty', playFull: false, position: 0, duration: 0, cutAt: null },
      B: { id: 'B', engine: null, track: null, status: 'empty', playFull: false, position: 0, duration: 0, cutAt: null },
    };

    this.vibe = 'peak';
    this.playMode = 'club';
    this.recipes = [];
    this.appliedRecipes = [];
    this.ytCrossfadeSec = 5.5;
    this.ytTransitionStyle = 'phrase'; // phrase | sweep_cut | drum_bridge | echo_drop
    this.ytFxEnabled = true;
    this.clickTrackEnabled = false;
    this.running = false;
    this.paused = false;
    this.crossfading = false;
    this.finished = false;
    this.transitionPlan = null;
    this.agentMessage = 'NOVA AI DJ STANDING BY';
    this.playedHistory = [];
    this.tickTimer = null;
    this.ytReady = false;
  }

  #isDspTrack(track) {
    return Boolean(track && (track.file || (track.dspReady && track.streamUrl)));
  }

  async startSet(tracks, { vibe = 'peak', playMode = 'club', recipes = [], ytCrossfadeSec = 5.5, ytTransitionStyle = 'phrase', ytFxEnabled = true } = {}) {
    this.stop(true);
    this.vibe = vibe;
    this.playMode = playMode;
    this.recipes = Array.isArray(recipes) ? recipes.slice() : [];
    this.appliedRecipes = [];
    this.ytCrossfadeSec = ytCrossfadeSec;
    this.ytTransitionStyle = ytTransitionStyle;
    this.ytFxEnabled = ytFxEnabled;
    this.proMixer.clickTrackEnabled = this.clickTrackEnabled;
    this.queue = tracks.slice();
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

    const hasYt = this.queue.some((t) => !this.#isDspTrack(t));
    const hasDsp = this.queue.some((t) => this.#isDspTrack(t));

    if (hasDsp || (hasYt && this.ytFxEnabled)) {
      await this.proMixer.ensureContext().catch(() => {});
    }
    if (hasYt && !this.ytReady) {
      this.#setAgent('Connecting Dual YouTube Decks…');
      this.#emit();
      await this.ytEngine.init();
      this.ytReady = true;
    }

    const first = this.#popNext();
    if (!first) return;

    this.liveDeckId = 'A';
    await this.#loadAndStartLive('A', first);

    const second = this.#popNext();
    if (second) {
      await this.#preloadDeck('B', second);
    }
    this.#prewarmUpcoming();

    this.#startTick();
    this.#emit();
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

    if (this.#isDspTrack(track)) {
      slot.engine = 'dsp';
      this.#setAgent(`Analyzing ${track.title} with Essentia WASM…`);
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
        this.#setAgent(`LIVE · ${analysis.bpm} BPM · ${analysis.camelot || 'KEY'} · ${this.playMode.toUpperCase()} MODE`);
      } catch (err) {
        this.#setAgent(`Skipped ${track.title}: ${err.message}`);
        const fallback = this.#popNext();
        if (fallback) return this.#loadAndStartLive(deckId, fallback);
        this.#finishSet();
      }
    } else {
      slot.engine = 'yt';
      if (!this.ytReady) {
        await this.ytEngine.init();
        this.ytReady = true;
      }
      this.ytEngine.load(deckId, track, 'live', this.playMode);
      slot.status = 'live';
      slot.duration = track.durationSec || 210;
      slot.cutAt = slot.playFull ? slot.duration - 2 : (track.exitSec ?? slot.duration - 16);
      this.playedHistory.push(track);
      this.#setAgent(`LIVE ON YOUTUBE DECK ${deckId} · ${track.title}`);
    }
    this.#emit();
  }

  async #preloadDeck(deckId, track) {
    const slot = this.decks[deckId];
    slot.track = track;
    slot.playFull = Boolean(track.playFull);
    slot.status = 'loading';
    this.#emit();

    if (this.#isDspTrack(track)) {
      slot.engine = 'dsp';
      try {
        const { analysis } = await this.proMixer.loadDeck(deckId, track, {
          gain: 0,
          playMode: this.playMode,
        });
        slot.status = 'ready';
        slot.duration = analysis.durationSec;
        slot.cutAt = slot.playFull ? analysis.durationSec - 1.5 : (track.exitSec ?? analysis.clubExit);
        const outSlot = this.decks[this.liveDeckId];
        if (outSlot.engine === 'dsp') {
          this.transitionPlan = this.proMixer.planTransition(this.liveDeckId, deckId, {
            vibe: this.vibe,
            playMode: this.playMode,
          });
        }
      } catch (err) {
        this.#setAgent(`Couldn't load ${track.title}: ${err.message}`);
        const nxt = this.#popNext();
        if (nxt) return this.#preloadDeck(deckId, nxt);
        slot.status = 'empty';
        slot.track = null;
      }
    } else {
      slot.engine = 'yt';
      if (!this.ytReady) {
        await this.ytEngine.init();
        this.ytReady = true;
      }
      this.ytEngine.load(deckId, track, 'preload', this.playMode);
      slot.status = 'loading';
      slot.duration = track.durationSec || 210;
      slot.cutAt = slot.playFull ? slot.duration - 2 : (track.exitSec ?? slot.duration - 16);
      this.transitionPlan = {
        style: `YOUTUBE_${this.ytTransitionStyle.toUpperCase()}`,
        durationSec: this.ytCrossfadeSec,
        harmonic: { relation: 'phrase blend' },
      };
    }
    this.#emit();
  }

  #handleYtReady(deckId, track) {
    const slot = this.decks[deckId];
    if (!slot || slot.track?.id !== track?.id) return;
    if (slot.status === 'loading') {
      slot.status = 'ready';
      slot.duration = track.durationSec || slot.duration;
      slot.cutAt = slot.playFull ? slot.duration - 2 : (track.exitSec ?? slot.duration - 16);
      this.#emit();
    }
  }

  #startTick() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.#tick(), 120);
  }

  #tick() {
    if (!this.running || this.finished || this.paused) return;
    const liveId = this.liveDeckId;
    const cueId = liveId === 'A' ? 'B' : 'A';
    const liveSlot = this.decks[liveId];
    const cueSlot = this.decks[cueId];

    if (liveSlot.engine === 'dsp') {
      liveSlot.position = this.proMixer.getDeckPosition(liveId);
      liveSlot.duration = liveSlot.track?.durationSec || liveSlot.duration;
      this.proMixer.scheduleClickLookahead(liveId);
      if (!this.crossfading) this.proMixer.checkDriftAndCorrect(liveId);
    } else if (liveSlot.engine === 'yt') {
      const p = this.ytEngine.getPosition(liveId);
      if (p) {
        liveSlot.position = p.seconds;
        if (p.duration > 5) {
          liveSlot.duration = p.duration;
          if (liveSlot.playFull) liveSlot.cutAt = p.duration - 2;
        }
      }
    }

    if (!this.crossfading && liveSlot.cutAt && liveSlot.position > 1) {
      const remaining = liveSlot.cutAt - liveSlot.position;
      const transSec = this.transitionPlan?.durationSec || this.ytCrossfadeSec;

      if ((cueSlot.status === 'ready' || (cueSlot.status === 'loading' && remaining <= 1.5)) && remaining <= transSec && remaining > -5) {
        this.triggerTransition('auto');
      } else if (cueSlot.status === 'empty' && remaining <= 3) {
        this.#endLastTrack(liveId);
      } else if (cueSlot.track && remaining <= transSec + 10 && remaining > transSec) {
        const label = this.transitionPlan?.style?.replace(/_/g, ' ') || 'PHRASE BLEND';
        this.#setAgent(`${label} INTO ${cueSlot.track.title.toUpperCase()} IN ${Math.ceil(remaining - transSec)}S`);
      }
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

    if (outSlot.engine === 'dsp' && inSlot.engine === 'dsp') {
      const matchedRecipe = !styleOverride
        ? this.recipes.find((r) => r.from === outSlot.track?.id && r.to === inSlot.track?.id)
        : null;

      let waitEndAt;
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
      }

      const waitMs = Math.max(300, (waitEndAt - this.proMixer.ctx.currentTime) * 1000 + 140);
      await new Promise((r) => setTimeout(r, waitMs));
      await this.proMixer.stopDeck(outId);
      this.proMixer.masterBpm = (inSlot.track.bpm || 120) * (this.proMixer.decks[inId].rate || 1);
    } else if (outSlot.engine === 'yt' && inSlot.engine === 'yt') {
      const ytStyle = styleOverride || this.ytTransitionStyle || 'phrase';
      this.#setAgent(`${ytStyle.replace(/_/g, ' ').toUpperCase()} INTO ${inSlot.track.title.toUpperCase()}`);
      this.#emit();

      if (inSlot.status === 'loading') {
        await this.ytEngine.waitForReady(inId, 5500);
      }
      const started = await this.ytEngine.playPreloaded(inId);
      if (!started) {
        this.crossfading = false;
        return this.#handleYtError(inId, inSlot.track, 'start-timeout');
      }
      if (this.ytFxEnabled) {
        this.proMixer.playTransitionSweepFx({
          type: ytStyle,
          bpm: outSlot.track?.bpm || 122,
          durationSec: this.ytCrossfadeSec,
        });
      }
      await this.ytEngine.crossfade(outId, inId, this.ytCrossfadeSec * 1000, ytStyle);
    } else {
      // Hybrid Cross-Engine Handover (DSP <-> YouTube)!
      const fadeMs = 3200;
      this.#setAgent(`HYBRID BLEND INTO ${inSlot.track.title.toUpperCase()}`);
      this.#emit();
      if (inSlot.engine === 'yt') {
        if (inSlot.status === 'loading') await this.ytEngine.waitForReady(inId, 5000);
        await this.ytEngine.playPreloaded(inId);
        const start = performance.now();
        await new Promise((res) => {
          const timer = setInterval(() => {
            const p = Math.min(1, (performance.now() - start) / fadeMs);
            this.ytEngine.setVolume(inId, Math.sin((p * Math.PI) / 2));
            const dspOut = this.proMixer.decks[outId];
            if (dspOut) dspOut.strip.deckVolume.gain.setTargetAtTime(Math.cos((p * Math.PI) / 2), this.proMixer.ctx.currentTime, 0.03);
            if (p >= 1) {
              clearInterval(timer);
              res();
            }
          }, 40);
        });
        await this.proMixer.stopDeck(outId);
      } else {
        const entry = inSlot.playFull ? 0 : (inSlot.track.entrySec || 0);
        await this.proMixer.playDeck(inId, { offsetSec: entry, rate: 1, gain: 0.001 });
        const start = performance.now();
        await new Promise((res) => {
          const timer = setInterval(() => {
            const p = Math.min(1, (performance.now() - start) / fadeMs);
            this.ytEngine.setVolume(outId, Math.cos((p * Math.PI) / 2));
            const dspIn = this.proMixer.decks[inId];
            if (dspIn) dspIn.strip.deckVolume.gain.setTargetAtTime(Math.sin((p * Math.PI) / 2), this.proMixer.ctx.currentTime, 0.03);
            if (p >= 1) {
              clearInterval(timer);
              res();
            }
          }, 40);
        });
        this.ytEngine.stopAll();
      }
    }

    // Promote incoming deck to LIVE and clear outgoing deck
    this.liveDeckId = inId;
    inSlot.status = 'live';
    this.playedHistory.push(inSlot.track);
    outSlot.status = 'empty';
    outSlot.track = null;
    outSlot.position = 0;
    this.crossfading = false;

    const upcoming = this.#popNext();
    if (upcoming) {
      this.#setAgent(`LIVE · ${inSlot.track.title.toUpperCase()} · NEXT: ${upcoming.title.toUpperCase()}`);
      this.#preloadDeck(outId, upcoming);
      this.#prewarmUpcoming();
    } else {
      this.#setAgent(`FINAL TRACK · ${inSlot.track.title.toUpperCase()}`);
    }
    this.#emit();
  }

  async #endLastTrack(liveId) {
    this.crossfading = true;
    const slot = this.decks[liveId];
    if (slot.engine === 'dsp') {
      const now = this.proMixer.ctx.currentTime;
      this.proMixer.decks[liveId].strip.deckVolume.gain.linearRampToValueAtTime(0.0001, now + 2.5);
      await new Promise((r) => setTimeout(r, 2600));
      await this.proMixer.stopDeck(liveId);
    } else {
      await this.ytEngine.fadeOutDeck(liveId, 2400);
    }
    this.#finishSet();
  }

  #finishSet() {
    this.running = false;
    this.crossfading = false;
    this.finished = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.#setAgent('SET COMPLETE · READY FOR ANOTHER ROUND');
    this.#emit();
  }

  async #handleYtError(deckId, track, code) {
    if (!this.running || this.finished) return;
    this.#setAgent(`YouTube blocked "${track?.title || 'track'}" (${code}), skipping cleanly…`);
    const replacement = this.#popNext();
    if (deckId === this.liveDeckId) {
      if (replacement) await this.#loadAndStartLive(deckId, replacement);
      else this.#finishSet();
    } else {
      if (replacement) await this.#preloadDeck(deckId, replacement);
      else {
        this.decks[deckId].status = 'empty';
        this.decks[deckId].track = null;
      }
    }
    this.#emit();
  }

  #handleDeckEnded(deckId) {
    if (deckId === this.liveDeckId && !this.crossfading) {
      this.triggerTransition('ended');
    }
  }

  async togglePause() {
    if (!this.running || this.finished || this.crossfading) return;
    const slot = this.decks[this.liveDeckId];
    this.paused = !this.paused;
    if (this.paused) {
      if (slot.engine === 'dsp') await this.proMixer.pauseDeck(this.liveDeckId);
      else this.ytEngine.pause(this.liveDeckId);
    } else {
      if (slot.engine === 'dsp') await this.proMixer.resumeDeck(this.liveDeckId);
      else this.ytEngine.resume(this.liveDeckId);
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
    if (slot.engine === 'dsp') await this.proMixer.seekDeck(this.liveDeckId, targetSec);
    else this.ytEngine.seek(this.liveDeckId, targetSec);
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

  async previewTransition(trackA, trackB, recipe) {
    if (!this.#isDspTrack(trackA) || !this.#isDspTrack(trackB)) {
      throw new Error('Transition preview requires local files or Audius Full-DSP tracks.');
    }
    this.stop(true);
    await this.proMixer.ensureContext();
    const { analysis: a } = await this.proMixer.loadDeck('A', trackA, { gain: 1, playMode: this.playMode });
    await this.proMixer.loadDeck('B', trackB, { gain: 0, playMode: this.playMode });
    const barDur = (60 / Math.max(55, a.bpm || 120)) * 4;
    const preBar = Math.max(0, (recipe.mix_out_bar || 4) - 2);
    const startSec = a.bars?.[preBar]?.start_sec ?? preBar * barDur;
    await this.proMixer.playDeck('A', { offsetSec: Math.min(a.durationSec - 6, startSec), rate: 1, gain: 1 });
    await new Promise((r) => setTimeout(r, Math.round(Math.min(3500, barDur * 2000))));
    const { endAt } = await this.proMixer.executeRecipe('A', 'B', recipe);
    const waitMs = Math.max(500, (endAt - this.proMixer.ctx.currentTime) * 1000 + 800);
    await new Promise((r) => setTimeout(r, Math.min(10000, waitMs)));
    this.proMixer.stopDeck('A');
    this.proMixer.stopDeck('B');
  }

  stop(silent = false) {
    this.running = false;
    this.paused = false;
    this.crossfading = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.proMixer.stopDeck('A');
    this.proMixer.stopDeck('B');
    this.ytEngine.stopAll();
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

  getSnapshot() {
    const live = this.decks[this.liveDeckId];
    const cueId = this.liveDeckId === 'A' ? 'B' : 'A';
    const cue = this.decks[cueId];
    const livePos = live?.position || 0;
    const ytBeatPhase = Math.pow(Math.max(0, Math.cos(livePos * Math.PI * (122 / 60))), 4);
    const ytSpectrum = live?.track
      ? { bass: 0.28 + ytBeatPhase * 0.52, mid: 0.42, overall: 0.35 + ytBeatPhase * 0.3 }
      : { bass: 0, mid: 0, overall: 0 };

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
      agentMessage: this.agentMessage,
      masterBpm: this.proMixer.masterBpm,
      spectrum: live?.engine === 'dsp' ? this.proMixer.getSpectrumEnergy() : ytSpectrum,
      remainingCount: Math.max(0, this.queue.length - this.nextIndex) + (cue?.track ? 1 : 0),
    };
  }
}
