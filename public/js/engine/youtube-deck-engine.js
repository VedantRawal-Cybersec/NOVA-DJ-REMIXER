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

  #onStateChange(deck, stateCode) {
    if (!deck.track) return;
    // 1 = PLAYING, 0 = ENDED
    if (stateCode === 1) {
      if (deck.status === 'loading' && deck.role === 'preload') {
        clearTimeout(deck.timer);
        deck.player.pauseVideo();
        const startAt = deck.track.playFull ? 0 : (deck.track.entrySec || 0);
        deck.player.seekTo(startAt, true);
        deck.status = 'ready';
        this.cb.onDeckReady?.(deck.id, deck.track);
      } else if (deck.status === 'loading' && deck.role === 'live') {
        clearTimeout(deck.timer);
        deck.status = 'live';
        this.cb.onDeckLive?.(deck.id, deck.track);
      } else if (deck.status === 'waiting-fade') {
        clearTimeout(deck.timer);
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
    deck.track = track;
    deck.role = role;
    deck.status = 'loading';

    let startSec = 0;
    if (!track.playFull) {
      startSec = playMode === 'hooks' ? (track.entrySec || 28) : (track.clubEntry ?? 0);
    }

    if (role === 'preload') {
      deck.player.mute();
      deck.player.setVolume(0);
    } else {
      deck.player.unMute();
      deck.player.setVolume(100);
    }

    deck.player.loadVideoById({ videoId: track.videoId, startSeconds: startSec });
    if (role === 'live') {
      try { deck.player.playVideo(); } catch {}
    }
    deck.timer = setTimeout(() => {
      if (deck.status === 'loading') {
        this.cb.onDeckError?.(deckId, track, 'timeout');
      }
    }, 18000);
  }

  async playPreloaded(deckId) {
    const deck = this.decks[deckId];
    if (!deck?.player) return false;
    return new Promise((resolve) => {
      deck.status = 'waiting-fade';
      deck.player.setVolume(0);
      deck.player.unMute();
      deck.player.playVideo();
      this.readyResolvers[deckId] = resolve;
      deck.timer = setTimeout(() => {
        if (this.readyResolvers[deckId]) {
          this.readyResolvers[deckId](false);
          this.readyResolvers[deckId] = null;
        }
      }, 4500);
    });
  }

  crossfade(outDeckId, inDeckId, durationMs = 3000) {
    return new Promise((resolve) => {
      const outDeck = this.decks[outDeckId];
      const inDeck = this.decks[inDeckId];
      if (this.fadeTimer) clearInterval(this.fadeTimer);

      const start = performance.now();
      this.fadeTimer = setInterval(() => {
        const p = Math.min(1, (performance.now() - start) / durationMs);
        const volIn = Math.round(100 * Math.sin((p * Math.PI) / 2));
        const volOut = Math.round(100 * Math.cos((p * Math.PI) / 2));
        try {
          if (inDeck?.player) inDeck.player.setVolume(volIn);
          if (outDeck?.player && outDeck.track) outDeck.player.setVolume(volOut);
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
            inDeck.player.unMute();
            inDeck.player.setVolume(100);
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
      try {
        this.decks[id].player?.pauseVideo();
        this.decks[id].player?.mute();
      } catch {}
      this.decks[id].status = 'empty';
      this.decks[id].track = null;
    }
  }
}
