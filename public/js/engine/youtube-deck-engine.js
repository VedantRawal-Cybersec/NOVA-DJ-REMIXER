let ytApiPromise = null;

export function loadYouTubeIframeApi(timeoutMs = 15000) {
  if (window.YT && typeof window.YT.Player === 'function') {
    return Promise.resolve(window.YT);
  }
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ytApiPromise = null;
        reject(new Error('YouTube IFrame API timed out. Check network or script blockers.'));
      }, timeoutMs);

      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timer);
        prev?.();
        resolve(window.YT);
      };

      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => {
        clearTimeout(timer);
        ytApiPromise = null;
        reject(new Error('Failed to download YouTube IFrame API.'));
      };
      document.head.appendChild(script);
    });
  }
  return ytApiPromise;
}

export class YouTubeDeckEngine {
  constructor(hostEl, callbacks = {}) {
    this.host = hostEl;
    this.cb = callbacks;
    this.ready = false;
    this.decks = {
      A: { id: 'A', player: null, status: 'empty', track: null, timer: null, role: 'preload' },
      B: { id: 'B', player: null, status: 'empty', track: null, timer: null, role: 'preload' },
    };
    this.fadeTimer = null;
    this.readyResolvers = { A: null, B: null };
    this.cueWaiters = { A: [], B: [] };
  }

  async init() {
    if (this.ready) return;
    const YT = await loadYouTubeIframeApi();
    await Promise.all([
      this.#createPlayer(YT, this.decks.A),
      this.#createPlayer(YT, this.decks.B),
    ]);
    this.ready = true;
  }

  #createPlayer(YT, deck) {
    return new Promise((resolve, reject) => {
      const slot = document.createElement('div');
      slot.id = `nova-yt-deck-${deck.id}`;
      this.host.appendChild(slot);

      const timeout = setTimeout(() => reject(new Error(`YT Deck ${deck.id} init timeout`)), 15000);
      deck.player = new YT.Player(slot, {
        width: '320',
        height: '180',
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          iv_load_policy: 3,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            clearTimeout(timeout);
            resolve();
          },
          onStateChange: (ev) => this.#onStateChange(deck, ev.data),
          onError: (ev) => this.#onError(deck, ev.data),
        },
      });
    });
  }

  #resolveCueWaiters(deckId, ok) {
    const waiters = this.cueWaiters[deckId];
    if (!waiters?.length) return;
    this.cueWaiters[deckId] = [];
    for (const fn of waiters) fn(ok);
  }

  #onStateChange(deck, stateCode) {
    if (!deck.track) return;
    // 1 = PLAYING, 0 = ENDED
    if (stateCode === 1) {
      try {
        const realDur = deck.player.getDuration?.();
        if (realDur && realDur > 10 && (!deck.track.durationSec || Math.abs(deck.track.durationSec - realDur) > 8)) {
          deck.track.durationSec = Math.round(realDur);
        }
      } catch {}

      if (deck.status === 'loading' && deck.role === 'preload') {
        clearTimeout(deck.timer);
        try {
          deck.player.pauseVideo();
          const startAt = deck.track.playFull ? 0 : (deck.track.entrySec || 0);
          deck.player.seekTo(startAt, true);
        } catch {}
        deck.status = 'ready';
        this.#resolveCueWaiters(deck.id, true);
        this.cb.onDeckReady?.(deck.id, deck.track);
      } else if (deck.status === 'loading' && deck.role === 'live') {
        clearTimeout(deck.timer);
        deck.status = 'live';
        this.#resolveCueWaiters(deck.id, true);
        this.cb.onDeckLive?.(deck.id, deck.track);
      } else if (deck.status === 'waiting-fade') {
        clearTimeout(deck.timer);
        try {
          deck.player.unMute();
        } catch {}
        deck.status = 'live';
        deck.role = 'live';
        this.readyResolvers[deck.id]?.(true);
        this.readyResolvers[deck.id] = null;
      }
    } else if (stateCode === 0 && deck.role === 'live' && deck.status === 'live') {
      this.cb.onTrackEnded?.(deck.id, deck.track);
    }
  }

  #onError(deck, code) {
    clearTimeout(deck.timer);
    this.#resolveCueWaiters(deck.id, false);
    if (this.readyResolvers[deck.id]) {
      this.readyResolvers[deck.id](false);
      this.readyResolvers[deck.id] = null;
    }
    this.cb.onDeckError?.(deck.id, deck.track, code);
  }

  load(deckId, track, role = 'preload', playMode = 'club') {
    const deck = this.decks[deckId];
    if (!deck?.player || !track?.videoId) return;
    clearTimeout(deck.timer);
    this.#resolveCueWaiters(deckId, false);
    deck.track = track;
    deck.role = role;
    deck.status = 'loading';

    const startSec = track.playFull ? 0 : Math.max(0, Number(track.entrySec ?? 0));

    try {
      if (role === 'preload') {
        deck.player.mute();
        deck.player.setVolume(0);
      } else {
        deck.player.unMute();
        deck.player.setVolume(100);
      }
      deck.player.loadVideoById({ videoId: track.videoId, startSeconds: startSec });
      if (role === 'live') {
        deck.player.playVideo();
      }
    } catch {}

    deck.timer = setTimeout(() => {
      if (deck.status === 'loading') {
        this.#resolveCueWaiters(deckId, false);
        this.cb.onDeckError?.(deckId, track, 'timeout');
      }
    }, 18000);
  }

  waitForReady(deckId, timeoutMs = 5500) {
    const deck = this.decks[deckId];
    if (!deck) return Promise.resolve(false);
    if (deck.status === 'ready' || deck.status === 'live') return Promise.resolve(true);
    if (deck.status === 'empty') return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(deck.status === 'ready' || deck.status === 'live');
      }, timeoutMs);
      this.cueWaiters[deckId].push((ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  async playPreloaded(deckId) {
    const deck = this.decks[deckId];
    if (!deck?.player) return false;
    return new Promise((resolve) => {
      deck.status = 'waiting-fade';
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(retryTimer);
        clearTimeout(deck.timer);
        this.readyResolvers[deckId] = null;
        resolve(ok);
      };

      this.readyResolvers[deckId] = finish;
      try {
        deck.player.setVolume(0);
        deck.player.unMute();
        deck.player.playVideo();
      } catch {}

      // Fallback if strict autoplay policy blocks unmuted play() outside user gesture:
      // start muted (always allowed), then unmute inside #onStateChange(1) at 0% volume!
      const retryTimer = setTimeout(() => {
        if (settled || deck.status !== 'waiting-fade') return;
        try {
          deck.player.mute();
          deck.player.setVolume(0);
          deck.player.playVideo();
        } catch {}
      }, 1800);

      deck.timer = setTimeout(() => finish(false), 5200);
    });
  }

  crossfade(outDeckId, inDeckId, durationMs = 5000, style = 'phrase') {
    return new Promise((resolve) => {
      const outDeck = this.decks[outDeckId];
      const inDeck = this.decks[inDeckId];
      if (this.fadeTimer) clearInterval(this.fadeTimer);

      const start = performance.now();
      this.fadeTimer = setInterval(() => {
        const p = Math.min(1, (performance.now() - start) / durationMs);
        let volIn = 100 * Math.sin((p * Math.PI) / 2);
        let volOut = 100 * Math.cos((p * Math.PI) / 2);

        if (style === 'sweep_cut') {
          // Risers build incoming stealthily until hard energy cut at 62%
          volIn = p < 0.62 ? 42 * (p / 0.62) : 42 + 58 * Math.min(1, (p - 0.62) / 0.14);
          volOut = p < 0.62 ? 100 - 20 * (p / 0.62) : Math.max(0, 80 * (1 - (p - 0.62) / 0.22));
        } else if (style === 'echo_drop') {
          // Slight dip on out, punch incoming straight up on the drop at 55%
          volIn = p < 0.55 ? 28 * (p / 0.55) : 100 * Math.sin(((p - 0.55) / 0.45) * (Math.PI / 2) * 0.65 + 0.35 * (Math.PI / 2));
          volOut = p < 0.55 ? 100 - 35 * (p / 0.55) : Math.max(0, 65 * Math.cos(((p - 0.55) / 0.45) * (Math.PI / 2)));
        } else {
          // Smooth Club S-curve equal-power overlap (full body phrase blend)
          const smooth = p * p * (3 - 2 * p);
          volIn = 100 * Math.sin((smooth * Math.PI) / 2);
          volOut = 100 * Math.cos((smooth * Math.PI) / 2);
        }

        try {
          if (inDeck?.player) inDeck.player.setVolume(Math.round(Math.max(0, Math.min(100, volIn))));
          if (outDeck?.player && outDeck.track) outDeck.player.setVolume(Math.round(Math.max(0, Math.min(100, volOut))));
        } catch {}

        if (p >= 1) {
          clearInterval(this.fadeTimer);
          this.fadeTimer = null;
          if (outDeck?.player) {
            try {
              outDeck.player.pauseVideo();
              outDeck.player.mute();
            } catch {}
            outDeck.status = 'empty';
            outDeck.track = null;
          }
          if (inDeck?.player) {
            try {
              inDeck.player.unMute();
              inDeck.player.setVolume(100);
            } catch {}
            inDeck.status = 'live';
            inDeck.role = 'live';
          }
          resolve();
        }
      }, 40);
    });
  }

  fadeOutDeck(deckId, durationMs = 2500) {
    return new Promise((resolve) => {
      const deck = this.decks[deckId];
      if (!deck?.player) return resolve();
      const start = performance.now();
      const t = setInterval(() => {
        const p = Math.min(1, (performance.now() - start) / durationMs);
        try {
          deck.player.setVolume(Math.round(100 * Math.cos((p * Math.PI) / 2)));
        } catch {}
        if (p >= 1) {
          clearInterval(t);
          try {
            deck.player.pauseVideo();
            deck.player.mute();
          } catch {}
          deck.status = 'empty';
          deck.track = null;
          resolve();
        }
      }, 40);
    });
  }

  pause(deckId) {
    try { this.decks[deckId]?.player?.pauseVideo(); } catch {}
  }

  resume(deckId) {
    try {
      const p = this.decks[deckId]?.player;
      p?.unMute();
      p?.setVolume(100);
      p?.playVideo();
    } catch {}
  }

  seek(deckId, sec) {
    try { this.decks[deckId]?.player?.seekTo(sec, true); } catch {}
  }

  setVolume(deckId, vol01) {
    try {
      const p = this.decks[deckId]?.player;
      if (!p) return;
      if (vol01 <= 0.01) p.mute();
      else {
        p.unMute();
        p.setVolume(Math.round(Math.max(0, Math.min(100, vol01 * 100))));
      }
    } catch {}
  }

  getPosition(deckId) {
    const d = this.decks[deckId];
    if (!d?.player || d.status !== 'live') return null;
    try {
      return {
        seconds: d.player.getCurrentTime() || 0,
        duration: d.player.getDuration() || d.track?.durationSec || 0,
      };
    } catch {
      return null;
    }
  }

  stopAll() {
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    for (const id of ['A', 'B']) {
      clearTimeout(this.decks[id].timer);
      this.#resolveCueWaiters(id, false);
      try {
        this.decks[id].player?.pauseVideo();
        this.decks[id].player?.mute();
      } catch {}
      this.decks[id].status = 'empty';
      this.decks[id].track = null;
    }
  }
}
