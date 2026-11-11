import { buildFallbackHeat, NovaOrchestrator, sequenceCrate } from '/js/engine/orchestrator.js';
import {
  applyManualGridOverride,
  buildRecipeFromCandidate,
  normalizeSongAnalysis,
  planSetHeuristic,
  repairOrFallbackRecipe,
  scorePairCandidates,
  validateSetPlan,
  validateTransitionRecipe,
} from '/js/engine/dj-brain.js';
import {
  exportMixToWav,
  extractAudioSliceWavBase64,
  renderTransitionClipBase64,
} from '/js/engine/offline-exporter.js';
import { renderBrainModal, renderDebugModal } from '/js/ui/debug-studio.js';

const root = document.getElementById('app');
const ytHost = document.getElementById('yt-deck-host');

function getSessionId() {
  try {
    let id = localStorage.getItem('nova.session.id');
    if (!id) {
      id = `nv-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
      localStorage.setItem('nova.session.id', id);
    }
    return id;
  } catch {
    return 'nova-guest';
  }
}

function fmtTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));
}

const LANGUAGES = [
  { id: 'hindi', label: 'Hindi', hint: 'Bollywood · Indie · Retro', query: 'Hindi party dance hit songs' },
  { id: 'punjabi', label: 'Punjabi', hint: 'Bhangra · Hip-Hop · Anthems', query: 'Punjabi party hit songs' },
  { id: 'english', label: 'English', hint: 'Pop · Hip-Hop · Club', query: 'English party dance pop hits' },
  { id: 'electronic', label: 'House & Techno', hint: 'Full DSP Club · Afro · EDM', query: 'Afro house melodic techno remix', preferDsp: true },
  { id: 'tamil-telugu', label: 'Tamil / Telugu', hint: 'Kuthu · Mass · Beats', query: 'Tamil Telugu mass party songs' },
  { id: 'bollywood-remix', label: 'DJ Remixes', hint: 'Mashups · Club Edits', query: 'Bollywood DJ remix mashup' },
];

const MIX_STYLES = [
  { id: 'club', label: 'Club Blend', hint: 'Full songs · 8–16 bar beatmatched EQ & stem handovers' },
  { id: 'festival', label: 'Festival Quick', hint: 'Tight phrase transitions · fast drop-to-drop momentum' },
  { id: 'hooks', label: 'Party Hooks', hint: 'Drops straight into the best part & mixes cleanly out' },
];

const NIGHT_VIBES = [
  { id: 'warmup', label: 'Warming Up', hint: 'People arriving, building energy smoothly' },
  { id: 'peak', label: 'Peak', hint: 'Full room, club dancefloor energy' },
  { id: 'winddown', label: 'Winding Down', hint: 'Late night, melodic & smooth' },
  { id: 'bangers', label: 'Only Bangers', hint: 'Maximum impact, zero slow tracks' },
];

const CROWD_SIZES = [
  { id: 'small', label: '4–6', hint: 'Music you can talk over' },
  { id: 'medium', label: '10–20', hint: 'A proper house party' },
  { id: 'large', label: '20+', hint: 'Full dancefloor mode' },
];

const SPLASH_HOOKS = [
  'NO MORE “BHAI, EK GAANA LAGA DE”.',
  'PASTE A PLAYLIST. HEAR A REAL DJ SET.',
  'BEATMATCHED. STEM-CLEANED. ZERO CLASH.',
  'CLUB TRANSITIONS ON AUTOPILOT.',
];

const state = {
  screen: 'splash', // splash | wizard | review | playing | summary
  wizardStep: 0, // 0: load/langs | 1: playMode | 2: vibe | 3: crowd
  sessionId: getSessionId(),
  health: null,

  // Source & Crate
  searchInput: '',
  searchProvider: 'youtube', // youtube | audius
  searchBusy: false,
  searchStatus: '',
  searchError: false,
  searchResults: [],
  crate: [],
  selectedLanguages: [],

  // Director Choices & AI Brain Plan
  playMode: 'club',
  vibe: 'peak',
  moodEnergy: 75,
  crowd: 'medium',
  sequencedSet: [],
  setPlan: null,
  opusBusy: false,
  opusKey: (() => { try { return sessionStorage.getItem('nova.opus.key') || ''; } catch { return ''; } })(),
  geminiKey: (() => { try { return sessionStorage.getItem('nova.gemini.key') || ''; } catch { return ''; } })(),
  openaiKey: (() => { try { return sessionStorage.getItem('nova.openai.key') || ''; } catch { return ''; } })(),
  debugModalOpen: false,
  brainModalOpen: false,
  exportBusy: false,
  exportMsg: '',
  previewBusyIdx: -1,
  auditBusyIdx: -1,
  batchAuditBusy: false,
  planEpoch: 0,
  tapState: { idx: -1, times: [], bpm: null, count: 0 },
  costEstimate: null,
  clickTrack: false,
  ratingsMap: (() => { try { return JSON.parse(localStorage.getItem('nova.transition.ratings.v1') || '{}'); } catch { return {}; } })(),
  learningHistory: (() => { try { return JSON.parse(localStorage.getItem('nova.learning.history.v1') || '[]'); } catch { return []; } })(),

  // Saved sets
  savedSets: [],
  setsModalOpen: false,

  // Live Playing UI State
  snap: null,
  exitConfirm: false,
  exitTimer: null,
  drawerOpen: false,
  crateModalOpen: false,
  vibeModalOpen: false,
  playNextModalOpen: false,
  playNextQuery: '',
  pipVideoVisible: false,
  sweepKey: 0,
  lastLiveId: 'A',
  lastPaused: false,
  lastRenderSig: '',
  animatingSwap: false,
  dragCueSec: null,
  showDragHint: false,
  hintTimer: null,

  // Pro Mixer Drawer State
  stems: { vocals: true, drums: true, bass: true, other: true },
  filterNorm: 0,
  echoAmt: 0,
  reverbAmt: 0,
  loopActive: false,
  masterTempo: true,
  percussionBridge: false,
  ytCrossfadeSec: 5.5,
  ytTransitionStyle: 'phrase',
  ytFxEnabled: true,
  recording: false,
  setSavedMsg: '',
  setNameInput: '',
};

let orchestrator = null;
let exitConfirmTimer = null;

function initOrchestrator() {
  if (!orchestrator) {
    orchestrator = new NovaOrchestrator(ytHost, handleOrchestratorUpdate);
  }
  return orchestrator;
}

function buildRenderSig(snap) {
  const liveSlot = snap.decks?.[snap.liveId];
  const cueSlot = snap.decks?.[snap.cueId];
  return [
    snap.liveId,
    liveSlot?.track?.id || '',
    liveSlot?.status || '',
    Boolean(liveSlot?.playFull),
    cueSlot?.track?.id || '',
    cueSlot?.status || '',
    Boolean(snap.crossfading),
    Boolean(snap.paused),
  ].join('|');
}

function handleOrchestratorUpdate(snap) {
  const prevLive = state.lastLiveId;
  state.snap = snap;

  if (state.screen === 'playing') {
    if (snap.finished) {
      state.animatingSwap = false;
      state.lastRenderSig = '';
      state.screen = 'summary';
      ytHost.setAttribute('data-visible', 'false');
      render();
      return;
    }

    if (snap.liveId !== prevLive) {
      const oldLiveEl = document.querySelector(`.deck[data-deck="${prevLive}"]`);
      const newLiveEl = document.querySelector(`.deck[data-deck="${snap.liveId}"]`);
      state.lastLiveId = snap.liveId;
      state.lastPaused = snap.paused;
      state.lastRenderSig = buildRenderSig(snap);
      state.sweepKey += 1;
      state.stems = { vocals: true, drums: true, bass: true, other: true };
      state.loopActive = false;
      triggerCueHint();
      if (oldLiveEl && newLiveEl) {
        state.animatingSwap = true;
        oldLiveEl.setAttribute('data-slot', 'out');
        newLiveEl.setAttribute('data-slot', 'live');
        const stage = document.getElementById('play-stage');
        if (stage) {
          const sw = document.createElement('div');
          sw.className = 'transition-sweep';
          stage.appendChild(sw);
          setTimeout(() => sw.remove(), 1550);
        }
        setTimeout(() => {
          state.animatingSwap = false;
          if (state.screen === 'playing') {
            state.lastRenderSig = buildRenderSig(state.snap);
            render();
          }
        }, 1520);
      } else {
        render();
      }
      return;
    }

    if (state.animatingSwap) {
      const agentMsg = document.getElementById('agent-msg');
      if (agentMsg && agentMsg.textContent !== snap.agentMessage) {
        agentMsg.textContent = snap.agentMessage;
      }
      return;
    }

    const sig = buildRenderSig(snap);
    if (sig !== state.lastRenderSig || snap.paused !== state.lastPaused) {
      state.lastPaused = snap.paused;
      state.lastRenderSig = sig;
      render();
      return;
    }

    syncPlayingDom();
  }
}

function triggerCueHint() {
  state.showDragHint = true;
  if (state.hintTimer) clearTimeout(state.hintTimer);
  state.hintTimer = setTimeout(() => {
    state.showDragHint = false;
    const bubble = document.getElementById('drag-hint-group');
    if (bubble) bubble.remove();
  }, 7500);
}

function getAiHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(state.opusKey ? { 'x-anthropic-key': state.opusKey } : {}),
    ...(state.geminiKey ? { 'x-gemini-key': state.geminiKey } : {}),
    ...(state.openaiKey ? { 'x-openai-key': state.openaiKey } : {}),
  };
}

function getAnalysisCache() {
  try {
    return JSON.parse(localStorage.getItem('nova.analysis.cache.v2') || '{}');
  } catch {
    return {};
  }
}

function saveAnalysisCache(id, patch) {
  if (!id) return;
  try {
    const cache = getAnalysisCache();
    cache[id] = { ...(cache[id] || {}), ...patch, updatedAt: Date.now() };
    const entries = Object.entries(cache).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, 40);
    localStorage.setItem('nova.analysis.cache.v2', JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function refreshCostEstimate() {
  if (!state.crate.length) {
    state.costEstimate = null;
    return;
  }
  const dspCount = state.crate.filter((t) => t.file || t.dspReady).length;
  const ytCount = state.crate.length - dspCount;
  fetch('/api/ai', {
    method: 'POST',
    headers: getAiHeaders(),
    body: JSON.stringify({ action: 'estimate_cost', dspCount, ytCount }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d?.ok && d.estimate) {
        state.costEstimate = d.estimate;
        if (state.screen === 'wizard' && state.wizardStep === 0 && document.activeElement?.id !== 'input-source') render();
      }
    })
    .catch(() => {});
}

async function fetchHealth() {
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      state.health = await res.json();
      initOrchestrator().proMixer.workerConfigured = Boolean(state.health?.audioWorkerConfigured);
    }
  } catch {}
  if (state.screen === 'wizard' && state.wizardStep === 0 && document.activeElement?.id !== 'input-source') {
    render();
  }
}

async function loadSavedSets() {
  let local = [];
  try {
    local = JSON.parse(localStorage.getItem('nova.saved.sets.v2') || '[]');
  } catch {}
  try {
    const res = await fetch(`/api/sets?sessionId=${encodeURIComponent(state.sessionId)}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.sets) && data.sets.length) {
        const seen = new Set();
        state.savedSets = [...data.sets, ...local].filter((s) => {
          if (!s?.id || seen.has(s.id)) return false;
          seen.add(s.id);
          return true;
        });
        return;
      }
    }
  } catch {}
  state.savedSets = local;
}

function persistLocalSet(setObj) {
  try {
    const existing = JSON.parse(localStorage.getItem('nova.saved.sets.v2') || '[]');
    const next = [setObj, ...existing.filter((x) => x.id !== setObj.id)].slice(0, 25);
    localStorage.setItem('nova.saved.sets.v2', JSON.stringify(next));
  } catch {}
}

function getLearnedCueMap() {
  try {
    return JSON.parse(localStorage.getItem('nova.learned.cues.v2') || '{}');
  } catch {
    return {};
  }
}

function addTrackToCrate(track) {
  if (!track || !track.id) return false;
  if (state.crate.some((t) => t.id === track.id)) return false;
  const learned = getLearnedCueMap()[track.id];
  const cachedAi = getAnalysisCache()[track.id];
  const merged = {
    ...track,
    ...(cachedAi || {}),
    ...(learned ? { entrySec: learned.entrySec ?? track.entrySec, playFull: learned.playFull ?? track.playFull, cueConfidence: 'user' } : {}),
  };
  state.crate.push({ ...merged, heat: buildFallbackHeat(merged) });
  return true;
}

async function handleSourceFetch(overrideQuery = null) {
  const q = String(overrideQuery ?? state.searchInput).trim();
  if (!q) {
    state.searchStatus = 'Paste a YouTube playlist URL, song link, direct audio URL, or type a track/artist.';
    state.searchError = true;
    render();
    return;
  }

  // Direct CORS audio file URL support (.mp3 / .wav / .flac / .m4a / .ogg)
  if (/^https?:\/\/.+\.(?:mp3|wav|flac|m4a|ogg|aac)(?:\?.*)?$/i.test(q)) {
    const cleanFile = q.split('?')[0].split('/').pop() || 'Audio Stream';
    const track = {
      id: `url-${btoa(q).replace(/[^a-z0-9]/gi, '').slice(0, 18)}`,
      source: 'stream',
      provider: 'Direct Audio · Full DSP',
      playback: 'web-audio-dsp',
      mixReady: true,
      dspReady: true,
      title: decodeURIComponent(cleanFile).replace(/\.[^.]+$/, ''),
      artist: new URL(q).hostname,
      streamUrl: q,
      durationSec: 180,
      energy: 7,
      entrySec: 8,
      exitSec: 165,
      playFull: false,
    };
    addTrackToCrate(track);
    state.searchResults = [track];
    state.searchError = false;
    state.searchStatus = `Added direct audio stream "${track.title}" to crate (Full DSP enabled).`;
    render();
    return;
  }

  state.searchBusy = true;
  state.searchError = false;
  const isUrl = /youtube\.com|youtu\.be|list=/i.test(q);
  state.searchStatus = isUrl ? 'Importing tracks from YouTube link…' : `Searching ${state.searchProvider === 'audius' ? 'Audius Full DSP' : 'YouTube'}…`;
  render();

  try {
    let tracks = [];
    if (isUrl || state.searchProvider === 'youtube') {
      const param = isUrl ? `url=${encodeURIComponent(q)}` : `q=${encodeURIComponent(q)}&limit=15`;
      const res = await fetch(`/api/youtube-search?${param}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'YouTube search failed.');
      }
      tracks = Array.isArray(data.results) ? data.results : [];
      if (data.kind === 'playlist') {
        let added = 0;
        for (const t of tracks) if (addTrackToCrate(t)) added++;
        state.searchStatus = `Imported "${data.title || 'Playlist'}": ${added} new songs loaded into your crate (${tracks.length} total).`;
        refreshCostEstimate();
      } else {
        state.searchStatus = tracks.length
          ? `Found ${tracks.length} YouTube tracks. Tap any card to add to crate, or click ADD ALL.`
          : 'No embeddable tracks matched that search.';
      }
    } else {
      const res = await fetch(`/api/catalogue?q=${encodeURIComponent(q)}&provider=all&limit=18`);
      const data = await res.json();
      tracks = (data.results || []).filter((t) => t.mixReady);
      state.searchStatus = tracks.length
        ? `Found ${tracks.length} full-DSP mixable tracks (Audius & Openverse).`
        : 'No full-stream tracks found for that query. Try electronic/hip-hop/remix or switch to YouTube.';
    }
    state.searchResults = tracks;
  } catch (err) {
    state.searchError = true;
    state.searchStatus = err.message || 'Search failed.';
  } finally {
    state.searchBusy = false;
    render();
  }
}

async function handleLocalFiles(files) {
  const list = Array.from(files || []).filter(
    (f) => f.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|ogg|aac)$/i.test(f.name)
  );
  if (!list.length) {
    state.searchError = true;
    state.searchStatus = 'No supported audio files found (use MP3, WAV, FLAC, M4A, OGG).';
    render();
    return;
  }

  state.searchBusy = true;
  state.searchError = false;
  state.searchStatus = `Decoding & analyzing ${list.length} audio file(s) with Essentia WASM…`;
  render();

  const orch = initOrchestrator();
  // Group Demucs 4-stem file bundles (*_vocals, *_drums, *_bass, *_other) cleanly when dropped together
  const stemGroups = new Map();
  const soloFiles = [];
  for (const file of list) {
    const m = file.name.match(/^(.*?)(?:_|-|\s)(vocals|drums|bass|other)\.[^.]+$/i);
    if (m) {
      const base = m[1].trim() || 'Stem Track';
      const stem = m[2].toLowerCase();
      if (!stemGroups.has(base)) stemGroups.set(base, { raw: [], map: {} });
      stemGroups.get(base).raw.push(file);
      stemGroups.get(base).map[stem] = file;
    } else {
      soloFiles.push(file);
    }
  }

  const fileItems = [];
  for (const [base, grp] of stemGroups.entries()) {
    if (['vocals', 'drums', 'bass', 'other'].every((s) => grp.map[s])) {
      fileItems.push({ base, stemFiles: grp.map, refFile: grp.map.drums });
    } else {
      for (const f of grp.raw) soloFiles.push(f);
    }
  }
  for (const f of soloFiles) fileItems.push({ file: f });

  let count = 0;
  for (const item of fileItems) {
    const refFile = item.file || item.refFile;
    const cleanName = item.stemFiles ? item.base : refFile.name.replace(/\.[^.]+$/, '');
    const parts = cleanName.split(/\s+[-–]\s+/);
    const track = {
      id: item.stemFiles
        ? `stems-${cleanName}-${refFile.size}-${refFile.lastModified}`
        : `local-${refFile.name}-${refFile.size}-${refFile.lastModified}`,
      source: 'local',
      provider: item.stemFiles ? 'Local 4-Stem Neural Bundle' : 'Local File · Full DSP',
      playback: 'web-audio-dsp',
      mixReady: true,
      dspReady: true,
      neuralStems: Boolean(item.stemFiles),
      title: parts.length > 1 ? parts.slice(1).join(' - ') : cleanName,
      artist: parts.length > 1 ? parts[0] : (item.stemFiles ? 'Demucs Stems' : 'Local Audio'),
      ...(item.stemFiles ? { stemFiles: item.stemFiles } : { file: item.file }),
      durationSec: 180,
      energy: 7,
      entrySec: 8,
      exitSec: 165,
      playFull: false,
    };
    try {
      const rec = await orch.proMixer.decodeAndAnalyze(track, (msg) => {
        state.searchStatus = msg;
        const sb = document.getElementById('wizard-status-banner');
        if (sb) sb.textContent = msg;
      });
      const a = rec.analysis;
      Object.assign(track, {
        analysis: a,
        durationSec: a.durationSec,
        bpm: a.bpm,
        key: a.key,
        camelot: a.camelot,
        energy: a.energy,
        lufs: a.lufs,
        heat: a.heat,
        clubEntry: a.clubEntry,
        clubExit: a.clubExit,
        hookEntry: a.hookEntry,
        hookExit: a.hookExit,
        entrySec: a.clubEntry,
        exitSec: a.clubExit,
      });

      // Async Phase 1 Lyric Transcription & Understanding (cached per song ID; never blocks track loading)
      const cached = getAnalysisCache()[track.id];
      const aiConfigured = state.health?.ai?.multiProviderConfigured || state.geminiKey || state.openaiKey || state.opusKey;
      if (cached?.lyric_understanding) {
        Object.assign(track, { lyrics: cached.lyrics || [], language: cached.language, lyric_understanding: cached.lyric_understanding });
      } else if (aiConfigured && rec.buffer) {
        const wavBase64 = extractAudioSliceWavBase64(rec.buffer, Math.max(0, a.hookEntry || a.clubEntry || 0), 34);
        if (wavBase64) {
          fetch('/api/ai', {
            method: 'POST',
            headers: getAiHeaders(),
            body: JSON.stringify({
              action: 'transcribe_and_understand',
              songId: track.id,
              title: track.title,
              artist: track.artist,
              durationSec: a.durationSec,
              bpm: a.bpm,
              wavBase64,
            }),
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
              if (!d?.ok) return;
              const patch = {
                language: d.language,
                lyrics: d.lyrics || [],
                lyric_understanding: d.lyric_understanding || null,
              };
              Object.assign(track, patch);
              if (track.analysis) Object.assign(track.analysis, patch);
              saveAnalysisCache(track.id, patch);
              if (state.debugModalOpen || state.screen === 'review') render();
            })
            .catch(() => {});
        }
      }
    } catch (err) {
      console.warn('Pre-decode skipped:', err?.message);
    }
    if (addTrackToCrate(track)) count++;
  }

  state.searchBusy = false;
  state.searchStatus = `Loaded ${count} local track(s) with BPM, Camelot Key & beatgrid into your crate.`;
  refreshCostEstimate();
  render();
}

async function advanceFromStep0() {
  // If user didn't add manual tracks yet but selected Language/Vibe tiles, auto-populate from APIs!
  if (state.crate.length < 2 && state.selectedLanguages.length > 0) {
    state.searchBusy = true;
    state.searchError = false;
    state.searchStatus = 'Building your crate from selected vibes…';
    render();

    const chosen = LANGUAGES.filter((l) => state.selectedLanguages.includes(l.id));
    for (const lang of chosen) {
      try {
        if (lang.preferDsp) {
          const r = await fetch(`/api/catalogue?q=${encodeURIComponent(lang.query)}&limit=10`);
          const d = await r.json();
          for (const t of (d.results || []).filter((x) => x.mixReady).slice(0, 8)) addTrackToCrate(t);
        }
        const yr = await fetch(`/api/youtube-search?q=${encodeURIComponent(lang.query)}&limit=10`);
        if (yr.ok) {
          const yd = await yr.json();
          for (const t of yd.results || []) addTrackToCrate(t);
        } else if (!lang.preferDsp) {
          const r = await fetch(`/api/catalogue?q=${encodeURIComponent(lang.query)}&limit=10`);
          const d = await r.json();
          for (const t of (d.results || []).filter((x) => x.mixReady)) addTrackToCrate(t);
        }
      } catch {}
    }
    state.searchBusy = false;
  }

  if (state.crate.length < 1) {
    state.searchError = true;
    state.searchStatus = 'Pick at least one vibe, paste a YouTube playlist/link, or drop audio files first.';
    render();
    return;
  }
  state.wizardStep = 1;
  render();
}

function getFewShotFeedback() {
  if (state.learningHistory?.length) {
    return state.learningHistory.slice(0, 8);
  }
  return Object.entries(state.ratingsMap || {}).slice(-6).map(([pair, rating]) => ({ pair, rating }));
}

function getLearningStats() {
  const hist = state.learningHistory || [];
  if (!hist.length) return { total: 0, winners: [], avoid: [] };
  const counts = {};
  for (const h of hist) {
    const k = h.type || h.pair || 'blend';
    if (!counts[k]) counts[k] = { good: 0, bad: 0 };
    if (h.rating === 'good') counts[k].good++;
    else counts[k].bad++;
  }
  const winners = Object.entries(counts).filter(([, c]) => c.good > c.bad).map(([k, c]) => `${k.replace(/_/g, ' ')} (+${c.good})`);
  const avoid = Object.entries(counts).filter(([, c]) => c.bad >= c.good).map(([k, c]) => `${k.replace(/_/g, ' ')} (-${c.bad})`);
  return { total: hist.length, winners, avoid };
}

function buildReviewSet() {
  const reqEpoch = ++state.planEpoch;
  const ordered = sequenceCrate(state.crate, {
    vibe: state.vibe,
    playMode: state.playMode,
  });
  state.sequencedSet = ordered;
  state.setPlan = planSetHeuristic(ordered, {
    vibe: state.vibe,
    playMode: state.playMode,
    moodEnergy: state.moodEnergy,
  });
  state.screen = 'review';
  render();

  const hasAnyAi = state.health?.ai?.multiProviderConfigured || state.health?.opusConfigured || state.opusKey || state.geminiKey || state.openaiKey;
  if (ordered.length >= 2 && hasAnyAi) {
    state.opusBusy = true;
    fetch('/api/plan', {
      method: 'POST',
      headers: getAiHeaders(),
      body: JSON.stringify({
        songs: state.setPlan.analyses,
        brief: { vibe: state.vibe, playMode: state.playMode, crowd: state.crowd, moodEnergy: state.moodEnergy },
        fewShotExamples: getFewShotFeedback(),
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (reqEpoch !== state.planEpoch) return;
        if (data?.ok && data.plan?.transitions?.length) {
          state.setPlan = data.plan;
          if (Array.isArray(data.plan.order)) {
            const byId = {};
            for (const t of state.sequencedSet) byId[t.id] = t;
            const reordered = data.plan.order.map((id) => byId[id]).filter(Boolean);
            if (reordered.length === state.sequencedSet.length) state.sequencedSet = reordered;
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        state.opusBusy = false;
        if (state.screen === 'review' || state.debugModalOpen) render();
      });
  }
}

async function runOfflineWavExport() {
  const tracks = state.sequencedSet.length ? state.sequencedSet : state.crate;
  if (!tracks.length) return;
  const orch = initOrchestrator();
  state.exportBusy = true;
  state.exportMsg = 'Preparing offline WAV mixdown…';
  render();
  try {
    const res = await exportMixToWav(tracks, state.setPlan?.transitions || [], orch.proMixer, {
      title: state.setNameInput || state.setPlan?.set_title || `NOVA-${state.vibe}-Mix`,
      onProgress: (m) => {
        state.exportMsg = m;
        render();
      },
    });
    state.exportMsg = `Exported ${Math.round(res.durationSec)}s studio WAV master (${(res.sizeBytes / (1024 * 1024)).toFixed(1)} MB) ✓`;
  } catch (err) {
    state.exportMsg = err?.message || 'WAV export failed.';
  } finally {
    state.exportBusy = false;
    render();
  }
}

async function approveAndPlay() {
  if (!state.sequencedSet.length) return;
  const orch = initOrchestrator();
  state.screen = 'playing';
  state.lastLiveId = 'A';
  state.lastPaused = false;
  state.lastRenderSig = '';
  state.animatingSwap = false;
  state.sweepKey = 0;
  state.exitConfirm = false;
  state.debugModalOpen = false;
  triggerCueHint();
  render();
  await orch.startSet(state.sequencedSet, {
    vibe: state.vibe,
    playMode: state.playMode,
    recipes: state.setPlan?.transitions || [],
    ytCrossfadeSec: state.ytCrossfadeSec,
    ytTransitionStyle: state.ytTransitionStyle,
    ytFxEnabled: state.ytFxEnabled,
  });
}

async function saveCueAdjustment(track, toSec, playFull) {
  if (!track) return;
  const prev = track.entrySec || 0;
  track.entrySec = Math.round(toSec);
  track.cueConfidence = 'user';
  if (playFull) track.playFull = true;

  try {
    const map = getLearnedCueMap();
    map[track.id] = { entrySec: track.entrySec, playFull: Boolean(track.playFull), updatedAt: Date.now() };
    localStorage.setItem('nova.learned.cues.v2', JSON.stringify(map));
  } catch {}

  try {
    await fetch('/api/cues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trackId: track.id,
        sessionId: state.sessionId,
        action: 'seek',
        fromSec: prev,
        toSec: track.entrySec,
        entrySec: track.entrySec,
        playFull: track.playFull,
        bpm: track.bpm || null,
        key: track.key || null,
        camelot: track.camelot || null,
        heat: track.heat || null,
      }),
    });
  } catch {}
}

async function saveCurrentSetToDb(customName) {
  const name = String(customName || '').trim() || `NOVA ${state.vibe.toUpperCase()} SET`;
  const tracks = (orchestrator?.playedHistory?.length ? orchestrator.playedHistory : state.sequencedSet).map((t) => ({
    id: t.id,
    videoId: t.videoId,
    source: t.source,
    title: t.title,
    artist: t.artist,
    artwork: t.artwork,
    streamUrl: t.streamUrl || '',
    durationSec: t.durationSec,
    bpm: t.bpm,
    key: t.key,
    camelot: t.camelot,
    energy: t.energy,
    entrySec: t.entrySec,
    exitSec: t.exitSec,
    playFull: t.playFull,
    mixReady: t.mixReady,
    dspReady: t.dspReady,
  }));

  const setObj = {
    id: `set-${Date.now().toString(36)}`,
    sessionId: state.sessionId,
    name,
    vibe: { vibe: state.vibe, playMode: state.playMode, crowd: state.crowd },
    tracks,
    createdAt: new Date().toISOString(),
  };

  persistLocalSet(setObj);
  try {
    const res = await fetch('/api/sets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(setObj),
    });
    const data = await res.json();
    state.setSavedMsg = data.persisted
      ? `SAVED "${name.toUpperCase()}" TO DATABASE ✓`
      : `SAVED "${name.toUpperCase()}" LOCALLY ✓`;
  } catch {
    state.setSavedMsg = `SAVED "${name.toUpperCase()}" LOCALLY ✓`;
  }
  await loadSavedSets();
  render();
}

function positionPipTile() {
  if (!state.pipVideoVisible || state.screen !== 'playing' || state.snap?.crossfading) {
    ytHost.setAttribute('data-visible', 'false');
    return;
  }
  const slot = document.querySelector('.deck[data-slot="live"] [data-pip-slot]');
  const liveSlot = state.snap?.decks?.[state.snap?.liveId];
  if (!slot || liveSlot?.engine !== 'yt') {
    ytHost.setAttribute('data-visible', 'false');
    return;
  }
  const rect = slot.getBoundingClientRect();
  ytHost.style.setProperty('--tile-x', `${Math.round(rect.left)}px`);
  ytHost.style.setProperty('--tile-y', `${Math.round(rect.top)}px`);
  ytHost.style.setProperty('--tile-w', `${Math.round(rect.width)}px`);
  ytHost.style.setProperty('--tile-h', `${Math.round(rect.height)}px`);
  ytHost.style.setProperty('--tile-opacity', '1');
  ytHost.setAttribute('data-visible', 'true');
  ytHost.setAttribute('data-live', state.snap.liveId);
}

/* =========================================================
   LIGHTWEIGHT 120ms PLAYING DOM SYNC (NO FULL RE-RENDER!)
   ========================================================= */
function syncPlayingDom() {
  const snap = state.snap;
  if (!snap) return;

  const liveSlot = snap.decks[snap.liveId];
  const cueSlot = snap.decks[snap.cueId];
  const pos = state.dragCueSec ?? (liveSlot?.position || 0);
  const dur = Math.max(1, liveSlot?.duration || liveSlot?.track?.durationSec || 180);

  const clock = document.getElementById('play-clock-text');
  if (clock) clock.textContent = `${fmtTime(pos)} / ${fmtTime(dur)}`;

  const agentMsg = document.getElementById('agent-msg');
  if (agentMsg && agentMsg.textContent !== snap.agentMessage) {
    agentMsg.textContent = snap.agentMessage;
  }

  const cueTitle = document.getElementById('cue-deck-title');
  if (cueTitle && cueSlot?.track && cueTitle.textContent !== cueSlot.track.title) {
    cueTitle.textContent = cueSlot.track.title;
    const cueArt = document.getElementById('cue-deck-artist');
    if (cueArt) cueArt.textContent = cueSlot.track.artist || '';
  }

  const cueStatus = document.getElementById('cue-deck-status');
  if (cueStatus) {
    const label = cueSlot?.track
      ? (cueSlot.status === 'ready' ? '○ READY' : '○ CUEING')
      : '○ STANDBY';
    if (cueStatus.textContent !== label) cueStatus.textContent = label;
  }

  // Update 88-bar waveform progress on live deck
  const wf = document.querySelector('.deck[data-slot="live"] .waveform-bars');
  if (wf) {
    const entry = liveSlot?.playFull ? 0 : (liveSlot?.track?.entrySec || 0);
    const exit = liveSlot?.playFull ? dur : (liveSlot?.cutAt || liveSlot?.track?.exitSec || dur);
    const bars = wf.children;
    const bassPulse = 1 + (snap.spectrum?.bass || 0) * 0.14;
    for (let i = 0; i < bars.length; i++) {
      const barTime = ((i + 0.5) / bars.length) * dur;
      const inside = barTime >= entry && barTime <= exit;
      const played = barTime <= pos;
      const cls = !inside ? 'wave-bar outside' : played ? 'wave-bar played' : 'wave-bar';
      if (bars[i].className !== cls) bars[i].className = cls;
      if (played && inside) {
        bars[i].style.transform = `scaleY(${bassPulse.toFixed(2)})`;
      } else if (bars[i].style.transform) {
        bars[i].style.transform = '';
      }
    }
    const ph = document.querySelector('.deck[data-slot="live"] .playhead-line');
    if (ph) {
      ph.style.left = `${Math.min(100, Math.max(0, (pos / dur) * 100))}%`;
      ph.className = state.dragCueSec !== null ? 'playhead-line dragging' : 'playhead-line';
    }
  }

  const aura = document.getElementById('pulse-aura');
  if (aura) {
    const scale = 1 + (snap.spectrum?.bass || 0) * 0.16;
    aura.style.transform = `scale(${scale.toFixed(3)})`;
  }

  positionPipTile();
}

/* =========================================================
   RENDERERS
   ========================================================= */
function renderSplash() {
  const hook = SPLASH_HOOKS[Math.floor(Math.random() * SPLASH_HOOKS.length)];
  root.innerHTML = `
    <main class="splash-screen" id="splash-enter">
      <div class="splash-aura"></div>
      <h1 class="splash-logo">NOVA</h1>
      <p class="splash-sub">THE AI DJ, HANDLED.</p>
      <p class="splash-hook">${esc(hook)}</p>
      <p class="splash-foot">Paste any YouTube playlist, search tracks, or drop audio files. Real beatmatching, pitch-locked tempo stretch, stem separation &amp; club transitions.</p>
      <div class="splash-actions">
        <button id="btn-splash-start" class="ingest-btn squeeze">ENTER BOOTH →</button>
      </div>
    </main>
  `;
  const go = () => {
    if (state.screen === 'splash') {
      state.screen = 'wizard';
      render();
    }
  };
  document.getElementById('btn-splash-start').onclick = go;
  setTimeout(() => {
    if (state.screen === 'splash') go();
  }, 2400);
}

function renderTopBar(rightHtml) {
  return `
    <header class="top-nav">
      <button class="wordmark squeeze" id="btn-home" aria-label="NOVA home">NOVA</button>
      <div class="nav-right">${rightHtml}</div>
    </header>
  `;
}

function renderExitBtn(confirmMode = false) {
  return `
    <button id="btn-exit" class="exit-btn squeeze ${state.exitConfirm ? 'confirming' : ''}" aria-label="Exit">
      ${state.exitConfirm ? 'END SET? <span style="font-size:0.7em;opacity:0.75">TAP AGAIN</span>' : '✕'}
    </button>
  `;
}

function renderWizard() {
  const step = state.wizardStep;
  const dbBadge = state.health?.database?.connected
    ? `<span class="row-tag">${esc(state.health.database.provider.toUpperCase())} DB LIVE</span>`
    : '';

  const right = `
    ${step === 0 ? `<button id="btn-open-brain" class="nav-meta-btn">BRAIN</button>` : ''}
    ${step === 0 ? `<button id="btn-open-sets" class="nav-meta-btn">MY SETS (${state.savedSets.length})</button>` : ''}
    ${dbBadge}
    <span class="step-counter">${step + 1} / 4</span>
    ${step > 0 ? renderExitBtn(false) : ''}
  `;

  let bodyHtml = '';

  if (step === 0) {
    bodyHtml = `
      <section class="wizard-body">
        <h1 class="hero-h1">WHAT ARE WE PLAYING?</h1>
        <p class="hero-sub">Paste a YouTube playlist URL, search tracks, drop audio files for full AI stem mixing, or pick party vibes below.</p>

        <div class="ingest-box">
          <div class="ingest-row">
            <input
              id="input-source"
              class="ingest-input"
              value="${esc(state.searchInput)}"
              placeholder="Paste YouTube Playlist URL (?list=...), song URL, or search artist / song…"
              autocomplete="off"
            />
            <button id="btn-fetch-source" class="ingest-btn squeeze" ${state.searchBusy ? 'disabled' : ''}>
              ${state.searchBusy ? 'LOADING…' : 'LOAD / SEARCH'}
            </button>
            <button id="btn-drop-files" class="ingest-btn ghost squeeze">
              + DROP AUDIO FILES
            </button>
            <input id="file-audio-input" type="file" accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg" multiple hidden />
          </div>

          <div class="source-pills">
            <button class="pill-btn squeeze ${state.searchProvider === 'youtube' ? 'active' : ''}" data-provider="youtube">YouTube + Playlists</button>
            <button class="pill-btn squeeze ${state.searchProvider === 'audius' ? 'active' : ''}" data-provider="audius">Audius Full DSP</button>
            ${state.searchResults.length ? `<button id="btn-add-all-results" class="pill-btn squeeze" style="border-color:var(--amber);color:var(--amber)">+ ADD ALL ${state.searchResults.length} TO CRATE</button>` : ''}
            ${state.crate.length ? `<button id="btn-clear-crate" class="pill-btn squeeze">CLEAR CRATE (${state.crate.length})</button>` : ''}
          </div>

          <div id="wizard-status-banner" class="status-banner ${state.searchError ? 'err' : ''}">${esc(state.searchStatus)}</div>
          ${state.costEstimate ? `
            <div class="font-mono-num" style="font-size:11px;color:rgba(255,184,0,0.78);margin-top:4px">
              ESTIMATE: ~${state.costEstimate.estimatedSeconds}s · AI Cost ~$${state.costEstimate.estimatedUsd.toFixed(3)} · Active Planner: ${esc(String(state.costEstimate.providers?.PLANNER || 'auto').toUpperCase())}
            </div>
          ` : ''}

          ${state.searchResults.length ? `
            <div class="search-results-grid">
              ${state.searchResults.map((t, idx) => {
                const inCrate = state.crate.some((c) => c.id === t.id);
                return `
                  <button class="result-card squeeze ${inCrate ? 'added' : ''}" data-result-idx="${idx}">
                    <img class="result-thumb" src="${esc(t.artwork || '')}" alt="" onerror="this.style.opacity=0.2" />
                    <div class="result-info">
                      <div class="result-title">${esc(t.title)}</div>
                      <div class="result-sub">${esc(t.artist)} · ${fmtTime(t.durationSec)}</div>
                      <span class="result-badge ${t.dspReady ? 'dsp' : ''}">${t.dspReady ? 'FULL DSP · STEMS' : 'YOUTUBE DECK'} ${inCrate ? '✓' : '+'}</span>
                    </div>
                  </button>
                `;
              }).join('')}
            </div>
          ` : ''}
        </div>

        <h2 class="font-display" style="margin-top:34px;font-size:28px;color:rgba(245,245,240,0.55);letter-spacing:0.03em">OR QUICK-FILL BY VIBE</h2>
        <div class="choice-grid-2" style="margin-top:14px">
          ${LANGUAGES.map((l) => {
            const sel = state.selectedLanguages.includes(l.id);
            return `
              <button class="big-card squeeze ${sel ? 'selected' : ''}" data-lang="${l.id}">
                <span class="big-card-title">${esc(l.label)}</span>
                <span class="big-card-hint">${esc(l.hint)}</span>
              </button>
            `;
          }).join('')}
        </div>
      </section>
    `;
  } else if (step === 1) {
    bodyHtml = `
      <section class="wizard-body">
        <button class="back-btn" id="btn-wiz-back">← BACK</button>
        <h1 class="hero-h1">HOW SHOULD NOVA MIX?</h1>
        <p class="hero-sub">Pick how deep NOVA blends each track in your ${state.crate.length}-song crate.</p>
        <div class="choice-grid-3">
          ${MIX_STYLES.map((m) => `
            <button class="big-card tall squeeze ${state.playMode === m.id ? 'selected' : ''}" data-mode="${m.id}">
              <span class="big-card-title">${esc(m.label)}</span>
              <span class="big-card-hint">${esc(m.hint)}</span>
            </button>
          `).join('')}
        </div>
      </section>
    `;
  } else if (step === 2) {
    bodyHtml = `
      <section class="wizard-body">
        <button class="back-btn" id="btn-wiz-back">← BACK</button>
        <h1 class="hero-h1">WHERE IN THE NIGHT ARE WE?</h1>
        <div class="choice-grid-2">
          ${NIGHT_VIBES.map((v) => `
            <button class="big-card tall squeeze ${state.vibe === v.id ? 'selected' : ''}" data-vibe="${v.id}">
              <span class="big-card-title">${esc(v.label)}</span>
              <span class="big-card-hint">${esc(v.hint)}</span>
            </button>
          `).join('')}
        </div>
      </section>
    `;
  } else if (step === 3) {
    bodyHtml = `
      <section class="wizard-body">
        <button class="back-btn" id="btn-wiz-back">← BACK</button>
        <h1 class="hero-h1">HOW MANY PEOPLE?</h1>
        <div class="choice-grid-3">
          ${CROWD_SIZES.map((c) => `
            <button class="big-card tall squeeze" data-crowd="${c.id}">
              <span class="big-card-title">${esc(c.label)}</span>
              <span class="big-card-hint">${esc(c.hint)}</span>
            </button>
          `).join('')}
        </div>
      </section>
    `;
  }

  const canNext = step === 0
    ? (state.crate.length >= 1 || state.selectedLanguages.length >= 1) && !state.searchBusy
    : true;

  const floatingNext = (step === 0 || step === 1) ? `
    <div class="floating-next-wrap">
      ${state.crate.length ? `<button id="btn-open-crate" class="crate-floating-pill squeeze" title="Inspect &amp; edit crate"><span>${state.crate.length}</span> TRACKS READY ▾</button>` : '<div></div>'}
      <button id="btn-wiz-next" class="floating-next-btn squeeze" ${canNext ? '' : 'disabled'}>NEXT →</button>
    </div>
  ` : '';

  root.innerHTML = `
    <main class="stage-shell">
      ${renderTopBar(right)}
      ${bodyHtml}
    </main>
    ${floatingNext}
    ${state.setsModalOpen ? renderSetsModal() : ''}
    ${state.crateModalOpen ? renderCrateModal() : ''}
    ${state.brainModalOpen ? renderBrainModal({
      claudeKeySet: Boolean(state.opusKey),
      geminiKeySet: Boolean(state.geminiKey),
      openaiKeySet: Boolean(state.openaiKey),
      health: state.health,
      learningStats: getLearningStats(),
    }) : ''}
  `;

  bindWizardEvents();
}

function renderCrateModal() {
  return `
    <div class="modal-backdrop" id="crate-backdrop">
      <div class="modal-sheet" onclick="event.stopPropagation()">
        <div style="padding:22px 26px;display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid rgba(245,245,240,0.12)">
          <span class="font-display" style="font-size:32px;text-transform:uppercase">CRATE (${state.crate.length} TRACKS)</span>
          <button id="btn-close-crate" class="exit-btn">✕</button>
        </div>
        <div class="nova-scroll" style="padding:12px 26px;overflow-y:auto;flex:1">
          ${state.crate.length ? state.crate.map((t, idx) => `
            <div class="review-row" style="justify-content:space-between">
              <span class="row-idx">${idx + 1}</span>
              <div class="row-main">
                <div class="row-title" style="font-size:22px">${esc(t.title)}</div>
                <div class="row-meta">${esc(t.artist)} · ${fmtTime(t.durationSec)} · ${t.dspReady ? 'FULL DSP' : 'YT DECK'}</div>
              </div>
              <button class="remove-row-btn squeeze" data-crate-rm="${idx}" aria-label="Remove ${esc(t.title)}">✕</button>
            </div>
          `).join('') : '<p style="color:rgba(245,245,240,0.5);padding:20px 0">Your crate is empty.</p>'}
        </div>
      </div>
    </div>
  `;
}

function renderSetsModal() {
  return `
    <div class="modal-backdrop" id="sets-backdrop">
      <div class="modal-sheet">
        <div style="padding:22px 26px;display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid rgba(245,245,240,0.12)">
          <span class="font-display" style="font-size:32px;text-transform:uppercase">SAVED SETS</span>
          <button id="btn-close-sets" class="exit-btn">✕</button>
        </div>
        <div class="nova-scroll" style="padding:16px 26px;overflow-y:auto;flex:1">
          ${state.savedSets.length ? state.savedSets.map((s, idx) => `
            <div class="review-row" style="justify-content:space-between">
              <div class="row-main">
                <div class="row-title">${esc(s.name)}</div>
                <div class="row-meta">${s.tracks?.length || 0} songs · ${esc(s.vibe?.playMode || 'club').toUpperCase()}</div>
              </div>
              <button class="ingest-btn squeeze" style="height:46px;font-size:20px;padding:0 18px" data-load-set="${idx}">LOAD →</button>
            </div>
          `).join('') : '<p style="color:rgba(245,245,240,0.5);padding:20px 0">No saved sets yet. Play a set and save it to your database!</p>'}
        </div>
      </div>
    </div>
  `;
}

function renderReview() {
  const totalSec = state.sequencedSet.reduce((acc, t) => {
    const playLen = t.playFull ? (t.durationSec || 180) : Math.max(20, (t.exitSec || t.durationSec || 180) - (t.entrySec || 0));
    return acc + playLen;
  }, 0);

  const dspCount = state.sequencedSet.filter((t) => t.file || t.stemFiles || t.stemUrls || t.dspReady).length;
  const ytCount = state.sequencedSet.length - dspCount;

  const right = `
    <button id="btn-open-debug" class="nav-meta-btn" style="color:var(--amber)">✦ RECIPES &amp; GRID</button>
    <button id="btn-review-back" class="nav-meta-btn">← CHANGE SETUP</button>
    ${renderExitBtn(false)}
  `;

  const recipes = state.setPlan?.transitions || [];

  const mins = Math.max(1, Math.round(totalSec / 60));

  root.innerHTML = `
    <main class="stage-shell">
      ${renderTopBar(right)}
      <h1 class="hero-h1" style="margin-top:4vh">TONIGHT'S SET</h1>
      <p class="hero-sub">
        ${state.sequencedSet.length} songs · about ${mins} ${mins === 1 ? 'minute' : 'minutes'} ·
        <span class="text-accent">${esc(state.playMode.toUpperCase())}</span>
        ${dspCount ? ` · <span class="text-amber">${dspCount} FULL DSP</span>` : ''}
        ${ytCount ? ` · ${ytCount} YOUTUBE DECK` : ''}
        ${state.setPlan?.validation?.valid ? ' · <span style="color:#6bff95">VALIDATOR ✓</span>' : ''}
      </p>

      <div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center">
        <button id="btn-review-debug" class="pill-btn squeeze" style="border-color:var(--amber);color:var(--amber)">✦ INSPECT BEAT GRID &amp; RECIPES (${recipes.length})</button>
        ${(dspCount >= 2 && recipes.length) ? `<button id="btn-review-audit-all" class="pill-btn squeeze" style="border-color:var(--accent);color:var(--accent)" ${state.batchAuditBusy ? 'disabled' : ''}>${state.batchAuditBusy ? 'AUDITING ALL…' : `🎧 AUDIT ALL (${recipes.length})`}</button>` : ''}
        ${dspCount ? `<button id="btn-review-export" class="pill-btn squeeze" ${state.exportBusy ? 'disabled' : ''}>${state.exportBusy ? 'EXPORTING…' : '⬇ EXPORT MIX (.WAV)'}</button>` : ''}
        ${state.exportMsg ? `<span style="font-size:13px;color:var(--amber)">${esc(state.exportMsg)}</span>` : ''}
      </div>

      <ol class="review-list" id="review-list">
        ${state.sequencedSet.map((t, idx) => {
          const isDsp = Boolean(t.file || t.stemFiles || t.dspReady);
          const hasNeural = Boolean(t.neuralStems || t.analysis?.neuralStems);
          const eVal = Math.max(1, Math.min(10, Math.round(Number(t.energy) || 7)));
          const bars = Array.from({ length: 10 }, (_, b) => {
            const cls = b < eVal ? (b >= 7 ? 'energy-bar peak' : 'energy-bar on') : 'energy-bar';
            return `<div class="${cls}" style="height:${8 + b * 3}px"></div>`;
          }).join('');
          const cueLabel = t.playFull
            ? 'FULL'
            : `${fmtTime(t.entrySec || 0)}–${fmtTime(t.exitSec || t.durationSec || 180)}`;
          const nextT = state.sequencedSet[idx + 1];
          const rec = nextT ? recipes.find((r) => r.from === t.id && r.to === nextT.id) : null;

          return `
            <li class="review-row" data-song-idx="${idx}">
              <button class="drag-handle" data-drag-idx="${idx}" title="Drag to reorder" aria-label="Reorder ${esc(t.title)}">⋮⋮</button>
              <span class="row-idx">${idx + 1}</span>
              <div class="row-main">
                <div class="row-title">${esc(t.title)}</div>
                <div class="row-meta">
                  <span>${esc(t.artist)}</span>
                  <span class="row-tag ${isDsp ? '' : 'yt'}">${hasNeural ? 'NEURAL 4-STEM' : isDsp ? 'DSP · STEMS' : 'YT DECK'}</span>
                  ${t.bpm ? `<span class="font-mono-num" style="font-size:12px">${Math.round(t.bpm)} BPM</span>` : ''}
                  ${t.camelot ? `<span class="font-mono-num" style="font-size:12px;color:var(--amber)">${esc(t.camelot)}</span>` : ''}
                  ${rec ? `<span class="font-mono-num" style="font-size:11px;color:rgba(245,245,240,0.6)">↳ ${esc(rec.type.replace(/_/g, ' ').toUpperCase())} (${Math.round((rec.compatibility?.score || 0.7) * 100)}%)</span>` : ''}
                </div>
              </div>
              <div class="energy-meter" aria-label="Energy ${eVal} of 10">${bars}</div>
              <span class="cue-range">${cueLabel}</span>
              <button class="remove-row-btn squeeze" data-remove-idx="${idx}" aria-label="Remove ${esc(t.title)}">✕</button>
            </li>
          `;
        }).join('')}
      </ol>
    </main>

    <div class="sticky-approve-wrap">
      <button id="btn-approve-play" class="approve-btn squeeze" ${state.sequencedSet.length ? '' : 'disabled'}>
        APPROVE &amp; PLAY
      </button>
    </div>
    ${state.debugModalOpen ? renderDebugModal({
      plan: state.setPlan,
      tracks: state.sequencedSet,
      opusBusy: state.opusBusy,
      exportBusy: state.exportBusy,
      exportMsg: state.exportMsg,
      previewBusyIdx: state.previewBusyIdx,
      auditBusyIdx: state.auditBusyIdx,
      batchAuditBusy: state.batchAuditBusy,
      tapState: state.tapState,
      ratingsMap: state.ratingsMap,
    }) : ''}
  `;

  bindReviewEvents();
}

function renderWaveformHtml(track, pos, dur, cutAt, playFull, isLive) {
  const heat = buildFallbackHeat(track);
  const entry = playFull ? 0 : (track.entrySec || 0);
  const exit = playFull ? dur : (cutAt || track.exitSec || dur);
  const entryPct = `${Math.min(100, Math.max(0, (entry / dur) * 100))}%`;
  const exitPct = `${Math.min(100, Math.max(0, (exit / dur) * 100))}%`;
  const posPct = `${Math.min(100, Math.max(0, (pos / dur) * 100))}%`;
  const narrow = ((exit - entry) / dur) * 100 < 28;

  return `
    <div class="waveform-wrap">
      <div class="cue-marker" style="left:${entryPct}">
        <div class="cue-marker-line"></div>
        ${!(isLive && state.showDragHint) ? `<div class="cue-marker-label ${narrow ? 'right' : 'left'}">IN ${fmtTime(entry)}</div>` : ''}
      </div>
      ${exit < dur - 2 ? `
        <div class="cue-marker" style="left:${exitPct}">
          <div class="cue-marker-line"></div>
          ${!(isLive && state.showDragHint) ? `<div class="cue-marker-label ${narrow ? 'left' : 'right'}">OUT ${fmtTime(exit)}</div>` : ''}
        </div>
      ` : ''}

      <div class="waveform-bars" ${isLive ? 'id="live-waveform"' : ''}>
        ${heat.map((h, i) => {
          const barTime = ((i + 0.5) / heat.length) * dur;
          const inside = barTime >= entry && barTime <= exit;
          const played = isLive && barTime <= pos;
          const cls = !inside ? 'wave-bar outside' : played ? 'wave-bar played' : 'wave-bar';
          return `<div class="${cls}" style="height:${Math.round(h * 100)}%"></div>`;
        }).join('')}
      </div>

      ${isLive ? `<div class="playhead-line" style="left:${posPct}"></div>` : ''}

      ${isLive && state.showDragHint ? `
        <div id="drag-hint-group">
          <div class="drag-hint-ring" style="left:${posPct}"></div>
          <div class="drag-hint-bubble">
            <span class="text-accent font-display">← →</span>
            <span>Drag to your favourite drop or cue. NOVA learns it.</span>
          </div>
        </div>
      ` : ''}

      ${isLive && state.dragCueSec !== null ? `
        <div class="drag-time-badge" style="left:${Math.min(92, Math.max(8, (state.dragCueSec / dur) * 100))}%">
          ${fmtTime(state.dragCueSec)}${state.dragCueSec >= exit - 3 ? ' · PLAY FULL' : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function renderDeckCard(deckId, slotName, deckData) {
  const track = deckData?.track;
  const isLive = slotName === 'live';
  const titleText = track ? track.title : (isLive ? 'STARTING…' : 'END OF SET');
  const isLong = titleText.length > 16;
  const dur = Math.max(1, deckData?.duration || track?.durationSec || 180);
  const pos = deckData?.position || 0;
  const isDsp = deckData?.engine ? deckData.engine === 'dsp' : Boolean(track?.file || track?.dspReady);

  const statusBadge = isLive
    ? `<span class="deck-live-badge"><span class="live-dot"></span>LIVE${deckData.playFull ? ' · FULL' : ''}</span>`
    : `<span id="cue-deck-status" style="color:rgba(245,245,240,0.68)">○ ${track ? (deckData.status === 'ready' ? 'READY' : 'CUEING') : 'STANDBY'}</span>`;

  const techBadge = track
    ? `<span class="deck-dsp-pill">${isDsp ? 'DSP' : 'YT'}${track.bpm ? ` · ${Math.round(track.bpm)} BPM` : ''}${track.camelot ? ` · ${esc(track.camelot)}` : ''}</span>`
    : '';

  return `
    <section class="deck" data-deck="${deckId}" data-slot="${slotName}" aria-hidden="${!isLive}">
      <header class="deck-header">
        <span class="deck-label">DECK ${deckId}</span>
        ${statusBadge}
        ${techBadge}
      </header>

      <div class="deck-title-row">
        <div style="min-width:0;flex:1">
          <h2 class="deck-title ${isLong ? 'long' : ''}" id="${isLive ? 'live-deck-title' : 'cue-deck-title'}">${esc(titleText)}</h2>
          ${track ? `<p class="deck-artist" id="${isLive ? 'live-deck-artist' : 'cue-deck-artist'}">${esc(track.artist)}</p>` : ''}
        </div>
        ${isLive && state.pipVideoVisible && !isDsp && track ? '<div class="deck-pip-slot" data-pip-slot="true"></div>' : ''}
      </div>

      ${isLive && track ? renderWaveformHtml(track, pos, dur, deckData.cutAt, deckData.playFull, true) : ''}
    </section>
  `;
}

function renderProDrawer() {
  const snap = state.snap;
  const liveSlot = snap?.decks?.[snap?.liveId];
  const isDsp = liveSlot?.engine === 'dsp';
  const plan = snap?.transitionPlan;

  return `
    <div class="drawer-backdrop" id="drawer-backdrop">
      <aside class="pro-drawer nova-scroll" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div class="font-display text-accent" style="font-size:32px;line-height:1">PRO DJ CONSOLE</div>
            <div style="font-size:13px;color:rgba(245,245,240,0.58)">${isDsp ? 'Signalsmith Master Tempo + 4-Band Isolator Active' : 'Dual YouTube IFrame Deck Mode Active'}</div>
          </div>
          <button id="btn-close-drawer" class="exit-btn">✕</button>
        </div>

        ${isDsp ? `
          <div>
            <div class="font-display" style="font-size:20px;color:rgba(245,245,240,0.55);margin-bottom:10px">LIVE STEM ISOLATOR (DECK ${snap.liveId})</div>
            <div class="stem-grid">
              ${['vocals', 'drums', 'bass', 'other'].map((st) => `
                <button class="stem-btn squeeze ${state.stems[st] ? 'on' : 'muted'}" data-stem="${st}">
                  <span>${st.toUpperCase()}</span>
                  <span style="font-size:14px">${state.stems[st] ? 'ON' : 'MUTED'}</span>
                </button>
              `).join('')}
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:14px">
            <div class="font-display" style="font-size:20px;color:rgba(245,245,240,0.55)">MASTER FX &amp; FILTER</div>
            <div class="fx-slider-row">
              <label><span>COLOR FILTER (LPF ← FLAT → HPF)</span><span>${Math.round(state.filterNorm * 100)}%</span></label>
              <input id="fx-filter" type="range" min="-100" max="100" value="${Math.round(state.filterNorm * 100)}" />
            </div>
            <div class="fx-slider-row">
              <label><span>TEMPO-SYNCED ECHO</span><span>${Math.round(state.echoAmt * 100)}%</span></label>
              <input id="fx-echo" type="range" min="0" max="75" value="${Math.round(state.echoAmt * 100)}" />
            </div>
            <div class="fx-slider-row">
              <label><span>SPACE REVERB</span><span>${Math.round(state.reverbAmt * 100)}%</span></label>
              <input id="fx-reverb" type="range" min="0" max="70" value="${Math.round(state.reverbAmt * 100)}" />
            </div>
          </div>

          <div>
            <div class="font-display" style="font-size:20px;color:rgba(245,245,240,0.55);margin-bottom:10px">TRIGGER CLUB TRANSITION NOW</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px">
              ${[
                ['BASS_SWAP_16BAR', 'BASS SWAP'],
                ['STEM_VOCAL_PASS', 'VOCAL PASS'],
                ['DROP_SWAP', 'DROP SWAP'],
                ['TENSION_ROLL_DROP', 'BEAT ROLL'],
                ['ECHO_OUT_BRAKE', 'ECHO BRAKE'],
                ['HARMONIC_BLEND', 'HARMONIC BLEND'],
                ['BREAKDOWN_BRIDGE', 'BREAKDOWN'],
                ['PERCUSSION_BRIDGE', 'DRUM BRIDGE'],
              ].map(([code, label]) => `
                <button class="pill-btn squeeze" data-force-style="${code}">${label}</button>
              `).join('')}
            </div>
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:10px">
            <button id="btn-loop-4" class="pill-btn squeeze ${state.loopActive ? 'active' : ''}">4-BAR LOOP ${state.loopActive ? 'ON' : 'OFF'}</button>
            <button id="btn-master-tempo" class="pill-btn squeeze ${state.masterTempo ? 'active' : ''}">MASTER TEMPO ${state.masterTempo ? 'ON' : 'OFF'}</button>
            <button id="btn-drum-bridge" class="pill-btn squeeze ${state.percussionBridge ? 'active' : ''}">DHOL / DRUM BRIDGE</button>
            <button id="btn-click-track" class="pill-btn squeeze ${state.clickTrack ? 'active' : ''}">CLICK TRACK ${state.clickTrack ? 'ON' : 'OFF'}</button>
            <button id="btn-spinback" class="pill-btn squeeze">⚡ SPINBACK</button>
            <button id="btn-record-mix" class="pill-btn squeeze ${state.recording ? 'active' : ''}">${state.recording ? '● STOP & SAVE MIX' : '● RECORD MIX'}</button>
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:8px;padding-top:4px">
            <button id="btn-drawer-debug" class="pill-btn squeeze" style="border-color:var(--amber);color:var(--amber)">✦ BEAT GRID &amp; RECIPES</button>
            <button id="btn-drawer-export" class="pill-btn squeeze" ${state.exportBusy ? 'disabled' : ''}>${state.exportBusy ? 'RENDERING WAV…' : '⬇ EXPORT MIX (.WAV)'}</button>
          </div>
          ${state.exportMsg ? `<div style="font-size:12px;color:var(--amber)">${esc(state.exportMsg)}</div>` : ''}
        ` : `
          <div style="display:flex;flex-direction:column;gap:14px">
            <div class="font-display" style="font-size:20px;color:rgba(245,245,240,0.55)">YOUTUBE BLEND &amp; DECK CONSOLE</div>
            <div class="fx-slider-row">
              <label><span>BLEND OVERLAP DURATION</span><span id="yt-xfade-val">${state.ytCrossfadeSec}s</span></label>
              <input id="yt-xfade-range" type="range" min="2" max="10" step="0.5" value="${state.ytCrossfadeSec}" />
            </div>

            <div>
              <div class="font-display" style="font-size:18px;color:rgba(245,245,240,0.55);margin-bottom:8px">BLEND CHOREOGRAPHY</div>
              <div style="display:flex;flex-wrap:wrap;gap:8px">
                ${[
                  ['phrase', 'PHRASE BLEND'],
                  ['sweep_cut', 'SWEEP CUT'],
                  ['drum_bridge', 'DRUM BRIDGE'],
                  ['echo_drop', 'ECHO DROP'],
                ].map(([code, label]) => `
                  <button class="pill-btn squeeze ${state.ytTransitionStyle === code ? 'active' : ''}" data-yt-style="${code}">${label}</button>
                `).join('')}
              </div>
            </div>

            <div style="display:flex;flex-wrap:wrap;gap:8px">
              <button id="btn-yt-fx" class="pill-btn squeeze ${state.ytFxEnabled ? 'active' : ''}">TRANSITION FX ${state.ytFxEnabled ? 'ON' : 'OFF'}</button>
              <button id="btn-toggle-pip" class="pill-btn squeeze ${state.pipVideoVisible ? 'active' : ''}">
                ${state.pipVideoVisible ? 'HIDE YOUTUBE VIDEO PIP' : 'SHOW YOUTUBE VIDEO PIP'}
              </button>
            </div>

            <button class="pill-btn squeeze" style="border-color:var(--accent);color:var(--accent)" id="btn-yt-mix-now-drawer" ${!snap?.cueTrack || snap?.crossfading ? 'disabled' : ''}>
              ⚡ TRIGGER ${esc(state.ytTransitionStyle.replace(/_/g, ' ').toUpperCase())} NOW
            </button>

            <p style="font-size:13px;color:rgba(245,245,240,0.52);line-height:1.5">
              Dual YouTube Decks overlap cleanly with Web Audio sweep/drum-bridge accents. Drop local audio files or switch to Audius Full DSP for per-stem 4-band isolation &amp; Signalsmith key-locked beatmatching.
            </p>
          </div>
        `}

        ${plan ? `
          <div style="border-top:2px solid rgba(245,245,240,0.12);padding-top:14px;font-size:13px;color:rgba(245,245,240,0.65)">
            NEXT TRANSITION: <strong class="text-amber">${esc(plan.style.replace(/_/g, ' '))}</strong> (${esc(plan.harmonic?.relation || 'phrase')})
          </div>
        ` : ''}

        <div style="border-top:2px solid rgba(245,245,240,0.12);padding-top:14px;display:flex;gap:10px">
          <button id="btn-quick-save-set" class="ingest-btn squeeze" style="flex:1;height:52px;font-size:22px">SAVE SET TO DB</button>
        </div>
      </aside>
    </div>
  `;
}

function renderPlayNextModal() {
  const liveId = state.snap?.liveTrack?.id;
  const matches = state.playNextQuery.trim()
    ? state.crate.filter((t) => t.id !== liveId && `${t.title} ${t.artist}`.toLowerCase().includes(state.playNextQuery.trim().toLowerCase()))
    : state.crate.filter((t) => t.id !== liveId);

  return `
    <div class="modal-backdrop" id="playnext-backdrop">
      <div class="modal-sheet" onclick="event.stopPropagation()">
        <div style="padding:22px 26px 10px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="font-display" style="font-size:32px;text-transform:uppercase">PLAY NEXT</span>
            <button id="btn-close-playnext" class="exit-btn">✕</button>
          </div>
          <div style="display:flex;gap:10px;margin-top:14px">
            <input id="input-playnext" class="ingest-input" style="flex:1;height:54px" value="${esc(state.playNextQuery)}" placeholder="Filter crate or search YouTube…" autofocus />
            <button id="btn-playnext-search" class="ingest-btn squeeze" style="height:54px;font-size:20px;padding:0 18px">SEARCH YT</button>
          </div>
        </div>
        <div id="playnext-list" class="nova-scroll" style="padding:10px 26px 24px;overflow-y:auto;flex:1">
          ${matches.slice(0, 30).map((t) => `
            <button class="review-row squeeze" style="width:100%;text-align:left;justify-content:space-between" data-pick-next="${esc(t.id)}">
              <div class="row-main">
                <div class="row-title" style="font-size:24px">${esc(t.title)}</div>
                <div class="row-meta">${esc(t.artist)}</div>
              </div>
              <span class="font-display text-accent" style="font-size:20px;flex-shrink:0">PLAY NEXT →</span>
            </button>
          `).join('') || '<p style="color:rgba(245,245,240,0.5);padding:18px 0">No matching tracks in crate. Press Enter to search YouTube!</p>'}
        </div>
      </div>
    </div>
  `;
}

function renderVibeModal() {
  return `
    <div class="modal-backdrop" id="vibe-backdrop">
      <div class="modal-sheet" onclick="event.stopPropagation()">
        <div style="padding:22px 26px;overflow-y:auto" class="nova-scroll">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="font-display" style="font-size:32px;text-transform:uppercase">CHANGE THE VIBE</span>
            <button id="btn-close-vibe" class="exit-btn">✕</button>
          </div>
          <p style="margin-top:6px;color:rgba(245,245,240,0.55)">Live track keeps playing. Upcoming queue re-orders automatically.</p>

          <p class="font-display" style="margin-top:18px;font-size:20px;color:rgba(245,245,240,0.5)">MIX STYLE</p>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
            ${MIX_STYLES.map((m) => `
              <button class="pill-btn squeeze ${state.playMode === m.id ? 'active' : ''}" data-retune-mode="${m.id}">${esc(m.label)}</button>
            `).join('')}
          </div>

          <p class="font-display" style="margin-top:18px;font-size:20px;color:rgba(245,245,240,0.5)">NIGHT ENERGY</p>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
            ${NIGHT_VIBES.map((v) => `
              <button class="pill-btn squeeze ${state.vibe === v.id ? 'active' : ''}" data-retune-vibe="${v.id}">${esc(v.label)}</button>
            `).join('')}
          </div>

          <div class="fx-slider-row" style="margin-top:18px">
            <label><span>LIVE ENERGY ARC SLIDER (CHILL ↔ BANGERS)</span><span id="vibe-energy-val">${state.moodEnergy}%</span></label>
            <input id="vibe-energy-slider" type="range" min="15" max="100" value="${state.moodEnergy}" />
          </div>
        </div>
        <div style="padding:16px 26px;border-top:2px solid rgba(245,245,240,0.1)">
          <button id="btn-apply-vibe" class="ingest-btn squeeze" style="width:100%">APPLY &amp; RE-SEQUENCE →</button>
        </div>
      </div>
    </div>
  `;
}

function renderPlaying() {
  const snap = state.snap || {
    liveId: 'A',
    cueId: 'B',
    paused: false,
    crossfading: false,
    decks: { A: { track: state.sequencedSet[0], status: 'loading' }, B: { track: state.sequencedSet[1], status: 'empty' } },
    agentMessage: 'LOADING DECKS…',
    masterBpm: 120,
  };

  const liveSlot = snap.decks[snap.liveId];
  const cueSlot = snap.decks[snap.cueId];
  const livePos = liveSlot?.position || 0;
  const liveDur = liveSlot?.duration || liveSlot?.track?.durationSec || 180;
  const energyPulseDur = `${(2.6 - 0.16 * (liveSlot?.track?.energy || 7)).toFixed(2)}s`;
  const bpmBadge = liveSlot?.track?.bpm ? ` · ${Math.round(liveSlot.track.bpm)} BPM` : '';

  root.innerHTML = `
    <main class="play-stage" id="play-stage" data-paused="${snap.paused ? 'true' : 'false'}">
      <div class="pulse-aura" id="pulse-aura" style="--pulse-dur:${energyPulseDur}"></div>

      <div class="play-topbar">
        <span class="wordmark">NOVA</span>

        <button class="vibe-pill squeeze" id="btn-open-vibe">
          <span class="truncate">${esc(state.playMode.toUpperCase())} · ${esc(state.vibe.toUpperCase())}${bpmBadge}</span>
          <span class="vibe-cta">CHANGE</span>
        </button>

        <div class="play-topbar-right">
          <button class="clock-pill squeeze ${snap.paused ? 'paused' : ''}" id="btn-clock-pause" title="Pause / Resume (Space)">
            <span>${snap.paused ? '▶' : '❚❚'}</span>
            <span class="clock-time" id="play-clock-text">${fmtTime(livePos)} / ${fmtTime(liveDur)}</span>
          </button>

          <button class="mixer-toggle-btn squeeze ${state.drawerOpen ? 'open' : ''}" id="btn-open-drawer">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
              <line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line>
              <line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line>
              <line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line>
              <line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line>
            </svg>
            MIXER
          </button>

          ${renderExitBtn(true)}
        </div>
      </div>

      <div class="decks-stage">
        ${renderDeckCard('A', snap.liveId === 'A' ? 'live' : 'cue', snap.decks.A)}
        ${renderDeckCard('B', snap.liveId === 'B' ? 'live' : 'cue', snap.decks.B)}
      </div>

      ${snap.paused ? `
        <button id="btn-paused-resume" class="paused-overlay" aria-label="Tap to resume">
          <span class="paused-stamp">PAUSED</span>
          <span class="font-display" style="margin-top:14px;font-size:clamp(22px,2vw,32px);color:rgba(245,245,240,0.62)">
            AT ${fmtTime(livePos)} · SPACE OR TAP TO RESUME
          </span>
        </button>
      ` : ''}

      <div class="agent-bar">
        <span class="agent-tag">AGENT</span>
        <span class="agent-msg" id="agent-msg">${esc(snap.agentMessage)}</span>
        <div class="agent-actions">
          <button class="agent-pill accent squeeze" id="btn-mix-now" ${!cueSlot?.track || snap.crossfading ? 'disabled' : ''}>⚡ MIX NOW</button>
          <button class="agent-pill squeeze" id="btn-remove-next" ${!cueSlot?.track || snap.crossfading ? 'disabled' : ''}>✕ REMOVE NEXT</button>
          <button class="agent-pill accent squeeze" id="btn-play-next">＋ PLAY NEXT</button>
        </div>
      </div>

      <div class="bottom-controls">
        ${snap.paused ? `
          <button class="mega-btn primary squeeze" id="btn-mega-resume">▶ RESUME</button>
        ` : `
          <button class="mega-btn primary squeeze" id="btn-mega-skip" ${!liveSlot?.track || snap.crossfading ? 'disabled' : ''}>SKIP</button>
          <button class="mega-btn secondary squeeze ${liveSlot?.playFull ? 'active' : ''}" id="btn-mega-full" ${!liveSlot?.track || liveSlot?.playFull ? 'disabled' : ''}>
            ${liveSlot?.playFull ? 'PLAYING FULL' : 'PLAY FULL'}
          </button>
        `}
      </div>
    </main>

    ${state.drawerOpen ? renderProDrawer() : ''}
    ${state.playNextModalOpen ? renderPlayNextModal() : ''}
    ${state.vibeModalOpen ? renderVibeModal() : ''}
    ${state.debugModalOpen ? renderDebugModal({
      plan: state.setPlan,
      tracks: state.sequencedSet,
      opusBusy: state.opusBusy,
      exportBusy: state.exportBusy,
      exportMsg: state.exportMsg,
      previewBusyIdx: state.previewBusyIdx,
      auditBusyIdx: state.auditBusyIdx,
      batchAuditBusy: state.batchAuditBusy,
      tapState: state.tapState,
      ratingsMap: state.ratingsMap,
    }) : ''}
  `;

  bindPlayingEvents();
  positionPipTile();
}

function renderSummary() {
  const played = orchestrator?.playedHistory?.length ? orchestrator.playedHistory : state.sequencedSet;
  const q = state.setPlan?.quality || { tempo_smoothness: 90, bass_clashes: 0, vocal_clashes: 0, energy_flow: 92 };
  const recipes = state.setPlan?.transitions || [];
  const dspCount = played.filter((t) => t.file || t.dspReady).length;

  root.innerHTML = `
    <main class="stage-shell">
      ${renderTopBar(`<button id="btn-summary-home" class="nav-meta-btn">NEW SET →</button>`)}
      <h1 class="hero-h1" style="margin-top:4vh">THAT WAS THE SET</h1>
      <p class="hero-sub">${played.length} tracks played through NOVA AI DJ · <span class="text-amber">${esc(state.setPlan?.plannerSource || 'NOVA Engine')}</span></p>

      <div style="margin-top:18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px">
        <div style="border:2px solid rgba(245,245,240,0.14);border-radius:16px;padding:12px">
          <div class="font-mono-num" style="font-size:11px;color:rgba(245,245,240,0.5)">TEMPO SMOOTHNESS</div>
          <div class="font-display text-accent" style="font-size:32px">${q.tempo_smoothness}%</div>
        </div>
        <div style="border:2px solid rgba(245,245,240,0.14);border-radius:16px;padding:12px">
          <div class="font-mono-num" style="font-size:11px;color:rgba(245,245,240,0.5)">BASS CLASHES</div>
          <div class="font-display" style="font-size:32px;color:#6bff95">${q.bass_clashes}</div>
        </div>
        <div style="border:2px solid rgba(245,245,240,0.14);border-radius:16px;padding:12px">
          <div class="font-mono-num" style="font-size:11px;color:rgba(245,245,240,0.5)">VOCAL CLASHES</div>
          <div class="font-display text-amber" style="font-size:32px">${q.vocal_clashes}</div>
        </div>
        <div style="border:2px solid rgba(245,245,240,0.14);border-radius:16px;padding:12px">
          <div class="font-mono-num" style="font-size:11px;color:rgba(245,245,240,0.5)">ENERGY FLOW</div>
          <div class="font-display text-accent" style="font-size:32px">${q.energy_flow}%</div>
        </div>
      </div>

      <div class="ingest-box" style="margin-top:20px">
        <div class="ingest-row">
          <input id="input-set-name" class="ingest-input" value="${esc(state.setNameInput)}" placeholder="Name this set (e.g. Friday Rooftop Mix)…" maxlength="60" />
          <button id="btn-save-set" class="ingest-btn squeeze">SAVE SET</button>
          ${dspCount ? `<button id="btn-summary-export" class="ingest-btn ghost squeeze" ${state.exportBusy ? 'disabled' : ''}>${state.exportBusy ? 'RENDERING…' : '⬇ EXPORT .WAV'}</button>` : ''}
        </div>
        ${state.setSavedMsg ? `<div class="status-banner">${esc(state.setSavedMsg)}</div>` : ''}
        ${state.exportMsg ? `<div class="status-banner">${esc(state.exportMsg)}</div>` : ''}
      </div>

      <ol class="review-list">
        ${played.map((t, i) => {
          const nextT = played[i + 1];
          const rec = nextT ? recipes.find((r) => r.from === t.id && r.to === nextT.id) : null;
          const rKey = rec ? `${rec.from}->${rec.to}` : '';
          const rated = rKey ? state.ratingsMap[rKey] : '';
          return `
            <li class="review-row">
              <span class="row-idx">${i + 1}</span>
              <div class="row-main">
                <div class="row-title">${esc(t.title)}</div>
                <div class="row-meta">${esc(t.artist)}${t.bpm ? ` · ${Math.round(t.bpm)} BPM` : ''}${rec ? ` · ↳ ${esc(rec.type.replace(/_/g, ' ').toUpperCase())}` : ''}</div>
              </div>
              ${rec ? `
                <div style="display:flex;gap:6px">
                  <button class="pill-btn squeeze ${rated === 'good' ? 'active' : ''}" style="font-size:14px;padding:4px 10px" data-sum-rate="${esc(rKey)}" data-sum-val="good">👍</button>
                  <button class="pill-btn squeeze ${rated === 'bad' ? 'active' : ''}" style="font-size:14px;padding:4px 10px" data-sum-rate="${esc(rKey)}" data-sum-val="bad">👎</button>
                </div>
              ` : ''}
            </li>
          `;
        }).join('')}
      </ol>
    </main>
    <div class="sticky-approve-wrap">
      <button id="btn-summary-new" class="approve-btn squeeze">BUILD ANOTHER SET</button>
    </div>
  `;

  document.getElementById('btn-home').onclick = goHome;
  document.getElementById('btn-summary-home').onclick = goHome;
  document.getElementById('btn-summary-new').onclick = goHome;
  document.getElementById('input-set-name').oninput = (e) => { state.setNameInput = e.target.value; };
  document.getElementById('btn-save-set').onclick = () => saveCurrentSetToDb(state.setNameInput);
  const sumExp = document.getElementById('btn-summary-export');
  if (sumExp) sumExp.onclick = runOfflineWavExport;
  document.querySelectorAll('[data-sum-rate]').forEach((b) => {
    b.onclick = () => saveTransitionRating(b.dataset.sumRate, b.dataset.sumVal);
  });
}

function goHome() {
  orchestrator?.stop();
  ytHost.setAttribute('data-visible', 'false');
  state.screen = 'wizard';
  state.wizardStep = 0;
  state.drawerOpen = false;
  state.debugModalOpen = false;
  state.brainModalOpen = false;
  state.vibeModalOpen = false;
  state.playNextModalOpen = false;
  state.exitConfirm = false;
  render();
}

/* =========================================================
   EVENT BINDERS
   ========================================================= */
function bindExitHandler(confirmRequired) {
  const btn = document.getElementById('btn-exit');
  if (!btn) return;
  btn.onclick = () => {
    if (!confirmRequired) {
      goHome();
      return;
    }
    if (state.exitConfirm) {
      clearTimeout(exitConfirmTimer);
      state.exitConfirm = false;
      goHome();
    } else {
      state.exitConfirm = true;
      render();
      clearTimeout(exitConfirmTimer);
      exitConfirmTimer = setTimeout(() => {
        state.exitConfirm = false;
        if (state.screen === 'playing') render();
      }, 2500);
    }
  };
}

function bindWizardEvents() {
  const home = document.getElementById('btn-home');
  if (home) home.onclick = goHome;
  bindExitHandler(false);

  const openBrain = document.getElementById('btn-open-brain');
  if (openBrain) openBrain.onclick = () => { state.brainModalOpen = true; render(); };

  if (state.brainModalOpen) {
    document.getElementById('brain-backdrop').onclick = () => { state.brainModalOpen = false; render(); };
    document.getElementById('btn-close-brain').onclick = () => { state.brainModalOpen = false; render(); };
    document.getElementById('btn-save-opus-key').onclick = () => {
      const val = document.getElementById('input-opus-key')?.value?.trim() || '';
      const gVal = document.getElementById('input-gemini-key')?.value?.trim() || '';
      const oVal = document.getElementById('input-openai-key')?.value?.trim() || '';
      state.opusKey = val;
      if (gVal) state.geminiKey = gVal;
      if (oVal) state.openaiKey = oVal;
      try {
        if (val) sessionStorage.setItem('nova.opus.key', val);
        else sessionStorage.removeItem('nova.opus.key');
        if (gVal) sessionStorage.setItem('nova.gemini.key', gVal);
        if (oVal) sessionStorage.setItem('nova.openai.key', oVal);
      } catch {}
      state.brainModalOpen = false;
      render();
    };
  }

  const openSets = document.getElementById('btn-open-sets');
  if (openSets) openSets.onclick = () => { state.setsModalOpen = true; render(); };

  if (state.setsModalOpen) {
    document.getElementById('sets-backdrop').onclick = () => { state.setsModalOpen = false; render(); };
    document.getElementById('btn-close-sets').onclick = () => { state.setsModalOpen = false; render(); };
    document.querySelectorAll('[data-load-set]').forEach((b) => {
      b.onclick = () => {
        const s = state.savedSets[Number(b.dataset.loadSet)];
        if (s?.tracks?.length) {
          state.crate = s.tracks.map((t) => ({ ...t, heat: buildFallbackHeat(t) }));
          state.playMode = s.vibe?.playMode || 'club';
          state.vibe = s.vibe?.vibe || 'peak';
          state.setsModalOpen = false;
          buildReviewSet();
        }
      };
    });
  }

  const openCrate = document.getElementById('btn-open-crate');
  if (openCrate) openCrate.onclick = () => { state.crateModalOpen = true; render(); };

  if (state.crateModalOpen) {
    document.getElementById('crate-backdrop').onclick = () => { state.crateModalOpen = false; render(); };
    document.getElementById('btn-close-crate').onclick = () => { state.crateModalOpen = false; render(); };
    document.querySelectorAll('[data-crate-rm]').forEach((b) => {
      b.onclick = () => {
        state.crate.splice(Number(b.dataset.crateRm), 1);
        if (!state.crate.length) state.crateModalOpen = false;
        render();
      };
    });
  }

  const back = document.getElementById('btn-wiz-back');
  if (back) back.onclick = () => { state.wizardStep = Math.max(0, state.wizardStep - 1); render(); };

  const next = document.getElementById('btn-wiz-next');
  if (next) {
    next.onclick = () => {
      if (state.wizardStep === 0) advanceFromStep0();
      else {
        state.wizardStep += 1;
        render();
      }
    };
  }

  if (state.wizardStep === 0) {
    const inp = document.getElementById('input-source');
    inp.oninput = (e) => { state.searchInput = e.target.value; };
    inp.onkeydown = (e) => { if (e.key === 'Enter') handleSourceFetch(); };
    document.getElementById('btn-fetch-source').onclick = () => handleSourceFetch();

    const fileInput = document.getElementById('file-audio-input');
    document.getElementById('btn-drop-files').onclick = () => fileInput.click();
    fileInput.onchange = (e) => handleLocalFiles(e.target.files);

    const stage = document.querySelector('.stage-shell');
    if (stage) {
      stage.ondragover = (e) => { e.preventDefault(); };
      stage.ondrop = (e) => {
        e.preventDefault();
        if (e.dataTransfer?.files?.length) handleLocalFiles(e.dataTransfer.files);
      };
    }

    document.querySelectorAll('[data-provider]').forEach((b) => {
      b.onclick = () => { state.searchProvider = b.dataset.provider; render(); };
    });

    const addAll = document.getElementById('btn-add-all-results');
    if (addAll) {
      addAll.onclick = () => {
        let added = 0;
        for (const t of state.searchResults) if (addTrackToCrate(t)) added++;
        state.searchStatus = `Added ${added} tracks to crate (${state.crate.length} total).`;
        refreshCostEstimate();
        render();
      };
    }

    const clearCrate = document.getElementById('btn-clear-crate');
    if (clearCrate) {
      clearCrate.onclick = () => {
        state.crate = [];
        state.searchStatus = 'Crate cleared.';
        render();
      };
    }

    document.querySelectorAll('[data-result-idx]').forEach((b) => {
      b.onclick = () => {
        const t = state.searchResults[Number(b.dataset.resultIdx)];
        if (!t) return;
        const exists = state.crate.some((c) => c.id === t.id);
        if (exists) state.crate = state.crate.filter((c) => c.id !== t.id);
        else addTrackToCrate(t);
        render();
      };
    });

    document.querySelectorAll('[data-lang]').forEach((b) => {
      b.onclick = () => {
        const id = b.dataset.lang;
        if (state.selectedLanguages.includes(id)) {
          state.selectedLanguages = state.selectedLanguages.filter((x) => x !== id);
        } else {
          state.selectedLanguages.push(id);
        }
        render();
      };
    });
  } else if (state.wizardStep === 1) {
    document.querySelectorAll('[data-mode]').forEach((b) => {
      b.onclick = () => { state.playMode = b.dataset.mode; render(); };
    });
  } else if (state.wizardStep === 2) {
    document.querySelectorAll('[data-vibe]').forEach((b) => {
      b.onclick = () => {
        state.vibe = b.dataset.vibe;
        state.wizardStep = 3;
        render();
      };
    });
  } else if (state.wizardStep === 3) {
    document.querySelectorAll('[data-crowd]').forEach((b) => {
      b.onclick = () => {
        state.crowd = b.dataset.crowd;
        buildReviewSet();
      };
    });
  }
}

function saveTransitionRating(rKey, val, extra = null) {
  if (!rKey) return;
  state.ratingsMap[rKey] = val;
  try {
    localStorage.setItem('nova.transition.ratings.v1', JSON.stringify(state.ratingsMap));
  } catch {}
  const [fromSongId, toSongId] = rKey.split('->');
  const matched = extra || state.setPlan?.transitions?.find((r) => r.from === fromSongId && r.to === toSongId);
  const entry = {
    pair: rKey,
    rating: val,
    type: matched?.type || 'blend',
    bpmDeltaPct: matched?.compatibility?.bpm_diff_pct ?? null,
    at: Date.now(),
  };
  state.learningHistory = [entry, ...(state.learningHistory || []).filter((h) => h.pair !== rKey)].slice(0, 30);
  try {
    localStorage.setItem('nova.learning.history.v1', JSON.stringify(state.learningHistory));
  } catch {}

  fetch('/api/plan', {
    method: 'POST',
    headers: getAiHeaders(),
    body: JSON.stringify({
      action: 'rate_transition',
      sessionId: state.sessionId,
      fromSongId,
      toSongId,
      type: entry.type,
      rating: val,
    }),
  }).catch(() => {});
  render();
}

async function auditTransitionWithListener(idx) {
  state.planEpoch += 1;
  const rec = state.setPlan?.transitions?.[idx];
  if (!rec) return;
  const trackA = state.sequencedSet.find((t) => t.id === rec.from);
  const trackB = state.sequencedSet.find((t) => t.id === rec.to);
  if (!trackA || !trackB) return;

  const a = state.setPlan.analyses.find((x) => x.song_id === rec.from);
  const bSong = state.setPlan.analyses.find((x) => x.song_id === rec.to);
  const orch = initOrchestrator();
  state.auditBusyIdx = idx;
  state.exportMsg = 'Rendering isolated transition clip for AI Audio Listener…';
  render();

  const log = [];
  let activeRec = { ...rec };
  try {
    for (let iter = 1; iter <= 3; iter++) {
      state.exportMsg = `Audio Listener + Critic Iteration ${iter}/3…`;
      render();
      const { wavBase64, metrics } = await renderTransitionClipBase64(trackA, trackB, activeRec, orch.proMixer);
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: getAiHeaders(),
        body: JSON.stringify({
          action: 'critique_transition',
          iteration: iter,
          wavBase64,
          recipe: activeRec,
          metrics,
          songA: a || trackA,
          songB: bSong || trackB,
        }),
      });
      const data = await res.json();
      const score = Number(data?.listener?.score_1_to_10) || 7;
      log.push({
        iteration: iter,
        passed: Boolean(data?.passed),
        score,
        metrics,
        notes: data?.listener?.notes || (data?.listener?.issues || []).join('; '),
        criticProvider: data?.criticProvider || null,
      });

      if (data?.passed) {
        activeRec.critiqueLog = log.slice();
        activeRec.why = `${activeRec.why} [Listener Verified ${score}/10 ✓]`;
        state.setPlan.transitions[idx] = activeRec;
        break;
      }
      if (data?.revisedRecipe) {
        activeRec = {
          ...data.revisedRecipe,
          compatibility: activeRec.compatibility,
          candidates: activeRec.candidates,
          creative_candidates: activeRec.creative_candidates,
          critiqueLog: log.slice(),
        };
      } else {
        activeRec.critiqueLog = log.slice();
        state.setPlan.transitions[idx] = activeRec;
        break;
      }
      state.setPlan.transitions[idx] = activeRec;
      render();
    }
    state.setPlan.transitions[idx] = activeRec;
    if (orchestrator?.running) orchestrator.recipes = state.setPlan.transitions;
    const last = log[log.length - 1];
    state.exportMsg = `Listener Audit finished: ${last?.passed ? 'PASSED' : 'REVISED'} (${last?.score ?? '?'}/10) after ${log.length} pass(es).`;
  } catch (err) {
    state.exportMsg = err?.message || 'Audio Listener check unavailable.';
  } finally {
    state.auditBusyIdx = -1;
    render();
  }
}

async function batchAuditAllTransitions() {
  const transitions = state.setPlan?.transitions || [];
  if (!transitions.length || state.batchAuditBusy) return;
  state.batchAuditBusy = true;
  state.debugModalOpen = true;
  render();
  let passedCount = 0;
  for (let i = 0; i < transitions.length; i++) {
    state.exportMsg = `Batch Auditing Transition ${i + 1}/${transitions.length}…`;
    render();
    await auditTransitionWithListener(i);
    const last = state.setPlan?.transitions?.[i]?.critiqueLog?.slice(-1)[0];
    if (last?.passed) passedCount++;
  }
  state.batchAuditBusy = false;
  state.exportMsg = `Batch Audit Complete: ${passedCount}/${transitions.length} transitions passed >= 7/10 ✓`;
  render();
}

function recalibrateTrackGrid(idx, overrideOpts) {
  state.planEpoch += 1;
  const analyses = state.setPlan?.analyses;
  if (!analyses || !analyses[idx]) return;
  const updated = applyManualGridOverride(analyses[idx], overrideOpts);
  analyses[idx] = updated;

  const seqTrack = state.sequencedSet.find((t) => t.id === updated.song_id);
  if (seqTrack) {
    seqTrack.bpm = updated.bpm;
    seqTrack.entrySec = updated.clubEntry;
    seqTrack.exitSec = updated.clubExit;
    seqTrack.analysis = updated;
    if (orchestrator?.proMixer?.decodedCache?.has(seqTrack.id)) {
      const cached = orchestrator.proMixer.decodedCache.get(seqTrack.id);
      if (cached) cached.analysis = { ...cached.analysis, ...updated };
    }
  }
  saveAnalysisCache(updated.song_id, {
    bpm: updated.bpm,
    beat_times: updated.beat_times,
    downbeat_times: updated.downbeat_times,
    bars: updated.bars,
    manualOverride: updated.manualOverride,
  });

  // Recompute adjacent transitions & run deterministic validator immediately
  const map = {};
  for (const a of analyses) map[a.song_id] = a;
  for (let i = Math.max(0, idx - 1); i <= Math.min(analyses.length - 2, idx); i++) {
    const a = analyses[i];
    const bSong = analyses[i + 1];
    const { candidates } = scorePairCandidates(a, bSong, { arc: state.vibe, playMode: state.playMode, moodEnergy: state.moodEnergy });
    let rec = buildRecipeFromCandidate(a, bSong, candidates[0]);
    const v = validateTransitionRecipe(rec, a, bSong);
    if (!v.valid) rec = repairOrFallbackRecipe(a, bSong, state.vibe, state.playMode);
    rec.validation = validateTransitionRecipe(rec, a, bSong);
    rec.candidates = candidates;
    state.setPlan.transitions[i] = rec;
  }
  state.setPlan.master_bpm_curve = analyses.map((a) => ({ at_song: a.song_id, bpm: a.bpm }));
  state.setPlan.validation = validateSetPlan(state.setPlan, map);
  if (orchestrator?.running) orchestrator.recipes = state.setPlan.transitions;
  render();
}

function bindDebugModalEvents() {
  if (!state.debugModalOpen) return;
  const backdrop = document.getElementById('debug-backdrop');
  if (backdrop) backdrop.onclick = () => { state.debugModalOpen = false; render(); };
  const closeBtn = document.getElementById('btn-close-debug');
  if (closeBtn) closeBtn.onclick = () => { state.debugModalOpen = false; render(); };
  const expBtn = document.getElementById('btn-export-wav-debug');
  if (expBtn) expBtn.onclick = runOfflineWavExport;
  const auditAllDbg = document.getElementById('btn-audit-all-debug');
  if (auditAllDbg) auditAllDbg.onclick = batchAuditAllTransitions;

  document.querySelectorAll('[data-nudge-beats]').forEach((b) => {
    b.onclick = () => recalibrateTrackGrid(Number(b.dataset.nudgeBeats), { nudgeBeats: Number(b.dataset.delta) });
  });
  document.querySelectorAll('[data-nudge-ms]').forEach((b) => {
    b.onclick = () => recalibrateTrackGrid(Number(b.dataset.nudgeMs), { nudgeMs: Number(b.dataset.delta) });
  });
  document.querySelectorAll('[data-grid-mult]').forEach((b) => {
    b.onclick = () => recalibrateTrackGrid(Number(b.dataset.gridMult), { bpmMultiplier: Number(b.dataset.mult) });
  });
  document.querySelectorAll('[data-tap-bpm]').forEach((b) => {
    b.onclick = () => {
      const idx = Number(b.dataset.tapBpm);
      const now = performance.now();
      if (state.tapState.idx !== idx || (state.tapState.times.length && now - state.tapState.times[state.tapState.times.length - 1] > 2400)) {
        state.tapState = { idx, times: [now], bpm: null, count: 1 };
        render();
        return;
      }
      state.tapState.times.push(now);
      if (state.tapState.times.length > 8) state.tapState.times.shift();
      state.tapState.count = state.tapState.times.length;
      if (state.tapState.times.length >= 3) {
        const diffs = [];
        for (let i = 1; i < state.tapState.times.length; i++) diffs.push(state.tapState.times[i] - state.tapState.times[i - 1]);
        const avgMs = diffs.reduce((x, y) => x + y, 0) / diffs.length;
        const bpm = Math.round((60000 / Math.max(250, avgMs)) * 10) / 10;
        state.tapState.bpm = bpm;
        recalibrateTrackGrid(idx, { tapBpm: bpm });
      } else {
        render();
      }
    };
  });

  document.querySelectorAll('[data-preview-rec]').forEach((b) => {
    b.onclick = async () => {
      const idx = Number(b.dataset.previewRec);
      const rec = state.setPlan?.transitions?.[idx];
      if (!rec) return;
      const trackA = state.sequencedSet.find((t) => t.id === rec.from);
      const trackB = state.sequencedSet.find((t) => t.id === rec.to);
      if (!trackA || !trackB) return;
      state.previewBusyIdx = idx;
      render();
      try {
        await initOrchestrator().previewTransition(trackA, trackB, rec);
      } catch (err) {
        state.exportMsg = err?.message || 'Preview unavailable';
      } finally {
        state.previewBusyIdx = -1;
        render();
      }
    };
  });

  document.querySelectorAll('[data-audit-rec]').forEach((b) => {
    b.onclick = () => auditTransitionWithListener(Number(b.dataset.auditRec));
  });

  document.querySelectorAll('[data-pick-idea]').forEach((b) => {
    b.onclick = () => {
      const idx = Number(b.dataset.pickIdea);
      const ideaType = b.dataset.ideaType;
      const cur = state.setPlan?.transitions?.[idx];
      if (!cur || !ideaType) return;
      const a = state.setPlan.analyses.find((x) => x.song_id === cur.from);
      const bSong = state.setPlan.analyses.find((x) => x.song_id === cur.to);
      if (!a || !bSong) return;
      const cands = cur.candidates || scorePairCandidates(a, bSong, { arc: state.vibe, playMode: state.playMode, moodEnergy: state.moodEnergy }).candidates;
      let chosen = buildRecipeFromCandidate(a, bSong, cands[0], ideaType);
      const v = validateTransitionRecipe(chosen, a, bSong);
      if (!v.valid) chosen = repairOrFallbackRecipe(a, bSong, state.vibe, state.playMode);
      chosen.validation = validateTransitionRecipe(chosen, a, bSong);
      chosen.candidates = cands;
      chosen.critiqueLog = cur.critiqueLog;
      state.setPlan.transitions[idx] = chosen;
      if (orchestrator?.running) orchestrator.recipes = state.setPlan.transitions;
      render();
    };
  });

  document.querySelectorAll('[data-regen-rec]').forEach((b) => {
    b.onclick = () => {
      const idx = Number(b.dataset.regenRec);
      const cur = state.setPlan?.transitions?.[idx];
      if (!cur) return;
      const a = state.setPlan.analyses.find((x) => x.song_id === cur.from);
      const bSong = state.setPlan.analyses.find((x) => x.song_id === cur.to);
      if (!a || !bSong) return;
      const cands = cur.candidates || scorePairCandidates(a, bSong, { arc: state.vibe, playMode: state.playMode }).candidates;
      const styles = ['bass_swap_blend', 'long_blend', 'filter_sweep', 'drum_loop_bridge', 'build_up_drop', 'echo_out', 'reverb_wash'];
      const curStyleIdx = styles.indexOf(cur.type);
      const nextStyle = styles[(curStyleIdx + 1) % styles.length];
      let regenerated = buildRecipeFromCandidate(a, bSong, cands[0], nextStyle);
      const v = validateTransitionRecipe(regenerated, a, bSong);
      if (!v.valid) {
        regenerated = buildRecipeFromCandidate(a, bSong, cands[(idx + 1) % cands.length]);
      }
      regenerated.validation = validateTransitionRecipe(regenerated, a, bSong);
      regenerated.candidates = cands;
      state.setPlan.transitions[idx] = regenerated;
      if (orchestrator?.running) orchestrator.recipes = state.setPlan.transitions;
      render();
    };
  });

  document.querySelectorAll('[data-rate-rec]').forEach((b) => {
    b.onclick = () => {
      const idx = Number(b.dataset.rateRec);
      const rec = state.setPlan?.transitions?.[idx];
      if (!rec) return;
      saveTransitionRating(`${rec.from}->${rec.to}`, b.dataset.rateVal);
    };
  });
}

function bindReviewEvents() {
  document.getElementById('btn-home').onclick = goHome;
  document.getElementById('btn-review-back').onclick = () => {
    state.screen = 'wizard';
    state.wizardStep = 1;
    render();
  };
  bindExitHandler(false);
  const openDbg = document.getElementById('btn-open-debug');
  if (openDbg) openDbg.onclick = () => { state.debugModalOpen = true; render(); };
  const revDbg = document.getElementById('btn-review-debug');
  if (revDbg) revDbg.onclick = () => { state.debugModalOpen = true; render(); };
  const revAuditAll = document.getElementById('btn-review-audit-all');
  if (revAuditAll) revAuditAll.onclick = batchAuditAllTransitions;
  const revExp = document.getElementById('btn-review-export');
  if (revExp) revExp.onclick = runOfflineWavExport;
  bindDebugModalEvents();

  const syncPlanOrder = () => {
    const analyses = state.sequencedSet.map((t) => normalizeSongAnalysis(t));
    const transitions = [];
    for (let i = 0; i < analyses.length - 1; i++) {
      const a = analyses[i];
      const bSong = analyses[i + 1];
      const { candidates } = scorePairCandidates(a, bSong, { arc: state.vibe, playMode: state.playMode });
      let rec = buildRecipeFromCandidate(a, bSong, candidates[0]);
      if (!validateTransitionRecipe(rec, a, bSong).valid) {
        rec = repairOrFallbackRecipe(a, bSong, state.vibe, state.playMode);
      }
      rec.validation = validateTransitionRecipe(rec, a, bSong);
      rec.candidates = candidates;
      transitions.push(rec);
    }
    if (state.setPlan) {
      state.setPlan.order = analyses.map((a) => a.song_id);
      state.setPlan.analyses = analyses;
      state.setPlan.transitions = transitions;
    }
  };

  document.querySelectorAll('[data-remove-idx]').forEach((b) => {
    b.onclick = () => {
      const idx = Number(b.dataset.removeIdx);
      state.sequencedSet.splice(idx, 1);
      syncPlanOrder();
      render();
    };
  });

  // Pointer drag-to-reorder matching naux.party
  document.querySelectorAll('[data-drag-idx]').forEach((handle) => {
    handle.onpointerdown = (ev) => {
      ev.preventDefault();
      let curIdx = Number(handle.dataset.dragIdx);
      const listEl = document.getElementById('review-list');
      const rows = () => [...listEl.querySelectorAll('.review-row')];
      rows()[curIdx]?.classList.add('dragging');

      const onMove = (mEv) => {
        const y = mEv.clientY;
        if (y < 90) window.scrollBy(0, -14);
        else if (y > window.innerHeight - 160) window.scrollBy(0, 14);

        const rList = rows();
        let targetIdx = curIdx;
        for (let i = 0; i < rList.length; i++) {
          if (i === curIdx) continue;
          const rect = rList[i].getBoundingClientRect();
          const mid = rect.top + rect.height / 2;
          if (i < curIdx && y < mid) { targetIdx = i; break; }
          if (i > curIdx && y > mid) { targetIdx = i; }
        }
        if (targetIdx !== curIdx) {
          const [moved] = state.sequencedSet.splice(curIdx, 1);
          state.sequencedSet.splice(targetIdx, 0, moved);
          curIdx = targetIdx;
          render();
          document.querySelector(`[data-song-idx="${curIdx}"]`)?.classList.add('dragging');
        }
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        syncPlanOrder();
        render();
      };

      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };
  });

  document.getElementById('btn-approve-play').onclick = approveAndPlay;
}

function bindPlayingEvents() {
  bindExitHandler(true);

  document.getElementById('btn-clock-pause').onclick = () => orchestrator.togglePause();
  const pausedResume = document.getElementById('btn-paused-resume');
  if (pausedResume) pausedResume.onclick = () => orchestrator.togglePause();
  const megaResume = document.getElementById('btn-mega-resume');
  if (megaResume) megaResume.onclick = () => orchestrator.togglePause();

  const skipBtn = document.getElementById('btn-mega-skip');
  if (skipBtn) skipBtn.onclick = () => {
    const liveT = state.snap?.liveTrack;
    const cueT = state.snap?.cueTrack;
    if (liveT && cueT) saveTransitionRating(`${liveT.id}->${cueT.id}`, 'bad');
    orchestrator.skip();
  };

  const fullBtn = document.getElementById('btn-mega-full');
  if (fullBtn) fullBtn.onclick = () => {
    orchestrator.playFullLive();
    render();
  };

  document.getElementById('btn-mix-now').onclick = () => orchestrator.mixNow();
  document.getElementById('btn-remove-next').onclick = () => {
    orchestrator.dropNextFromQueue();
    render();
  };
  document.getElementById('btn-play-next').onclick = () => {
    state.playNextModalOpen = true;
    render();
  };
  document.getElementById('btn-open-vibe').onclick = () => {
    state.vibeModalOpen = true;
    render();
  };
  document.getElementById('btn-open-drawer').onclick = () => {
    state.drawerOpen = !state.drawerOpen;
    render();
  };

  // Interactive 88-Bar Waveform Scrub + Cue Learning
  const wf = document.getElementById('live-waveform');
  if (wf) {
    const calcSec = (clientX) => {
      const rect = wf.getBoundingClientRect();
      const dur = state.snap?.decks?.[state.snap?.liveId]?.duration || state.snap?.liveTrack?.durationSec || 180;
      const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return Math.round(pct * dur);
    };
    wf.onpointerdown = (ev) => {
      wf.setPointerCapture(ev.pointerId);
      state.showDragHint = false;
      state.dragCueSec = calcSec(ev.clientX);
      syncPlayingDom();
    };
    wf.onpointermove = (ev) => {
      if (state.dragCueSec === null) return;
      state.dragCueSec = calcSec(ev.clientX);
      syncPlayingDom();
    };
    const commitSeek = async () => {
      if (state.dragCueSec === null) return;
      const target = state.dragCueSec;
      state.dragCueSec = null;
      const track = await orchestrator.seekLive(target);
      const isPlayFull = Boolean(state.snap?.decks?.[state.snap?.liveId]?.playFull);
      saveCueAdjustment(track, target, isPlayFull);
      render();
    };
    wf.onpointerup = commitSeek;
    wf.onpointercancel = () => { state.dragCueSec = null; render(); };
  }

  // Drawer Events
  if (state.drawerOpen) {
    document.getElementById('drawer-backdrop').onclick = () => { state.drawerOpen = false; render(); };
    document.getElementById('btn-close-drawer').onclick = () => { state.drawerOpen = false; render(); };

    document.querySelectorAll('[data-stem]').forEach((b) => {
      b.onclick = () => {
        const st = b.dataset.stem;
        state.stems[st] = !state.stems[st];
        orchestrator.setLiveStem(st, state.stems[st] ? 1 : 0.02);
        render();
      };
    });

    const fEl = document.getElementById('fx-filter');
    if (fEl) fEl.oninput = (e) => {
      state.filterNorm = Number(e.target.value) / 100;
      orchestrator.setLiveFilter(state.filterNorm);
    };
    const eEl = document.getElementById('fx-echo');
    if (eEl) eEl.oninput = (e) => {
      state.echoAmt = Number(e.target.value) / 100;
      orchestrator.setLiveEcho(state.echoAmt);
    };
    const rEl = document.getElementById('fx-reverb');
    if (rEl) rEl.oninput = (e) => {
      state.reverbAmt = Number(e.target.value) / 100;
      orchestrator.setLiveReverb(state.reverbAmt);
    };

    document.querySelectorAll('[data-force-style]').forEach((b) => {
      b.onclick = () => {
        state.drawerOpen = false;
        orchestrator.mixNow(b.dataset.forceStyle);
        render();
      };
    });

    const loopBtn = document.getElementById('btn-loop-4');
    if (loopBtn) loopBtn.onclick = async () => {
      state.loopActive = await orchestrator.toggleLiveLoop();
      render();
    };

    const mtBtn = document.getElementById('btn-master-tempo');
    if (mtBtn) mtBtn.onclick = () => {
      state.masterTempo = !state.masterTempo;
      orchestrator.proMixer.masterTempoEnabled = state.masterTempo;
      render();
    };

    const drumBtn = document.getElementById('btn-drum-bridge');
    if (drumBtn) drumBtn.onclick = () => {
      state.percussionBridge = !state.percussionBridge;
      orchestrator.proMixer.drumBridgeEnabled = state.percussionBridge;
      render();
    };

    const clickBtn = document.getElementById('btn-click-track');
    if (clickBtn) clickBtn.onclick = () => {
      state.clickTrack = !state.clickTrack;
      orchestrator.setClickTrack(state.clickTrack);
      render();
    };

    const spinBtn = document.getElementById('btn-spinback');
    if (spinBtn) spinBtn.onclick = () => {
      orchestrator.triggerSpinbackLive();
    };

    const drawerDbg = document.getElementById('btn-drawer-debug');
    if (drawerDbg) drawerDbg.onclick = () => {
      state.drawerOpen = false;
      state.debugModalOpen = true;
      render();
    };

    const drawerExp = document.getElementById('btn-drawer-export');
    if (drawerExp) drawerExp.onclick = runOfflineWavExport;

    const recBtn = document.getElementById('btn-record-mix');
    if (recBtn) recBtn.onclick = () => {
      try {
        state.recording = orchestrator.proMixer.toggleRecording();
      } catch (err) {
        alert(err.message);
      }
      render();
    };

    const ytRange = document.getElementById('yt-xfade-range');
    if (ytRange) ytRange.oninput = (e) => {
      state.ytCrossfadeSec = Number(e.target.value);
      orchestrator.ytCrossfadeSec = state.ytCrossfadeSec;
      const lbl = document.getElementById('yt-xfade-val');
      if (lbl) lbl.textContent = `${state.ytCrossfadeSec}s`;
    };

    document.querySelectorAll('[data-yt-style]').forEach((b) => {
      b.onclick = () => {
        state.ytTransitionStyle = b.dataset.ytStyle;
        orchestrator.ytTransitionStyle = state.ytTransitionStyle;
        render();
      };
    });

    const ytFxBtn = document.getElementById('btn-yt-fx');
    if (ytFxBtn) ytFxBtn.onclick = () => {
      state.ytFxEnabled = !state.ytFxEnabled;
      orchestrator.ytFxEnabled = state.ytFxEnabled;
      render();
    };

    const ytMixNow = document.getElementById('btn-yt-mix-now-drawer');
    if (ytMixNow) ytMixNow.onclick = () => {
      state.drawerOpen = false;
      orchestrator.mixNow(state.ytTransitionStyle);
      render();
    };

    const pipBtn = document.getElementById('btn-toggle-pip');
    if (pipBtn) pipBtn.onclick = () => {
      state.pipVideoVisible = !state.pipVideoVisible;
      render();
    };

    document.getElementById('btn-quick-save-set').onclick = async () => {
      await saveCurrentSetToDb(`NOVA ${state.vibe.toUpperCase()} SET`);
      if (orchestrator && state.setSavedMsg) {
        orchestrator.agentMessage = state.setSavedMsg;
      }
      state.drawerOpen = false;
      render();
    };
  }

  // Play Next Modal
  if (state.playNextModalOpen) {
    document.getElementById('playnext-backdrop').onclick = () => { state.playNextModalOpen = false; render(); };
    document.getElementById('btn-close-playnext').onclick = () => { state.playNextModalOpen = false; render(); };
    const pnInp = document.getElementById('input-playnext');
    const bindPickNext = () => {
      document.querySelectorAll('[data-pick-next]').forEach((b) => {
        b.onclick = () => {
          const t = state.crate.find((c) => c.id === b.dataset.pickNext);
          if (t) {
            state.playNextModalOpen = false;
            orchestrator.playNextOverride(t);
            render();
          }
        };
      });
    };
    const updatePlayNextList = () => {
      const listEl = document.getElementById('playnext-list');
      if (!listEl) return;
      const liveId = state.snap?.liveTrack?.id;
      const q = state.playNextQuery.trim().toLowerCase();
      const matches = q
        ? state.crate.filter((t) => t.id !== liveId && `${t.title} ${t.artist}`.toLowerCase().includes(q))
        : state.crate.filter((t) => t.id !== liveId);
      listEl.innerHTML = matches.slice(0, 30).map((t) => `
        <button class="review-row squeeze" style="width:100%;text-align:left;justify-content:space-between" data-pick-next="${esc(t.id)}">
          <div class="row-main">
            <div class="row-title" style="font-size:24px">${esc(t.title)}</div>
            <div class="row-meta">${esc(t.artist)}</div>
          </div>
          <span class="font-display text-accent" style="font-size:20px;flex-shrink:0">PLAY NEXT →</span>
        </button>
      `).join('') || '<p style="color:rgba(245,245,240,0.5);padding:18px 0">No matching tracks in crate. Press Enter to search YouTube!</p>';
      bindPickNext();
    };
    const runPlayNextYtSearch = async () => {
      const q = state.playNextQuery.trim();
      if (!q) return;
      const btn = document.getElementById('btn-playnext-search');
      if (btn) btn.textContent = '…';
      try {
        const res = await fetch(`/api/youtube-search?q=${encodeURIComponent(q)}&limit=8`);
        const d = await res.json();
        if (d.results?.length) {
          for (const t of d.results) addTrackToCrate(t);
          updatePlayNextList();
        }
      } finally {
        if (btn) btn.textContent = 'SEARCH YT';
      }
    };
    pnInp.oninput = (e) => { state.playNextQuery = e.target.value; updatePlayNextList(); };
    pnInp.onkeydown = async (e) => {
      if (e.key === 'Enter') await runPlayNextYtSearch();
    };
    const pnSearchBtn = document.getElementById('btn-playnext-search');
    if (pnSearchBtn) pnSearchBtn.onclick = runPlayNextYtSearch;
    bindPickNext();
  }

  // Change Vibe Modal
  if (state.vibeModalOpen) {
    document.getElementById('vibe-backdrop').onclick = () => { state.vibeModalOpen = false; render(); };
    document.getElementById('btn-close-vibe').onclick = () => { state.vibeModalOpen = false; render(); };
    document.querySelectorAll('[data-retune-mode]').forEach((b) => {
      b.onclick = () => { state.playMode = b.dataset.retuneMode; render(); };
    });
    document.querySelectorAll('[data-retune-vibe]').forEach((b) => {
      b.onclick = () => { state.vibe = b.dataset.retuneVibe; render(); };
    });
    const energySlider = document.getElementById('vibe-energy-slider');
    if (energySlider) {
      energySlider.oninput = (e) => {
        state.moodEnergy = Number(e.target.value);
        const lbl = document.getElementById('vibe-energy-val');
        if (lbl) lbl.textContent = `${state.moodEnergy}%`;
      };
    }
    document.getElementById('btn-apply-vibe').onclick = () => {
      state.vibeModalOpen = false;
      const liveId = state.snap?.liveTrack?.id;
      const playedIds = new Set((orchestrator?.playedHistory || []).map((t) => t.id));
      const remaining = state.crate.filter((t) => t.id !== liveId && !playedIds.has(t.id));
      const reordered = sequenceCrate(remaining, { vibe: state.vibe, playMode: state.playMode });
      const newPlan = planSetHeuristic(reordered, { vibe: state.vibe, playMode: state.playMode, moodEnergy: state.moodEnergy });
      orchestrator.vibe = state.vibe;
      orchestrator.playMode = state.playMode;
      if (newPlan?.transitions?.length) orchestrator.recipes = newPlan.transitions;
      orchestrator.requeueRemaining(reordered);
      render();
    };
  }

  bindDebugModalEvents();
}

function render() {
  if (state.screen === 'splash') return renderSplash();
  if (state.screen === 'wizard') return renderWizard();
  if (state.screen === 'review') return renderReview();
  if (state.screen === 'playing') return renderPlaying();
  if (state.screen === 'summary') return renderSummary();
}

// Global DJ Keyboard Shortcuts (matches naux.party + pro mixer keys)
window.addEventListener('keydown', (ev) => {
  if (state.screen !== 'playing') return;
  const tag = ev.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (ev.code === 'Space' || ev.key === 'k' || ev.key === 'K') {
    ev.preventDefault();
    if (!ev.repeat) {
      orchestrator?.togglePause();
      render();
    }
  } else if (ev.key === 's' || ev.key === 'S') {
    orchestrator?.skip();
  } else if (ev.key === 'f' || ev.key === 'F') {
    orchestrator?.playFullLive();
    render();
  } else if (ev.key === 'm' || ev.key === 'M') {
    orchestrator?.mixNow();
  }
});

window.addEventListener('resize', positionPipTile);

// Boot
fetchHealth();
loadSavedSets();
render();
