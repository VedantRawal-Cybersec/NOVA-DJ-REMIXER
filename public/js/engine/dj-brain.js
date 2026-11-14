import { camelotDistance, shiftCamelot } from './camelot.js';

export const TRANSITION_TYPES = [
  'bass_swap_blend',
  'long_blend',
  'filter_sweep',
  'echo_out',
  'reverb_wash',
  'drum_loop_bridge',
  'loop_roll_drop',
  'build_up_drop',
  'vocal_mashup',
  'acapella_in',
  'instrumental_in',
  'half_time_switch',
  'impact_cut',
  'spinback',
  'stutter_edit',
  'reverse_riser_drop',
  'lyric_link',
  'key_change_lift',
  'hook_over_groove',
];

export const SAFE_TRANSITIONS = new Set([
  'echo_out',
  'reverb_wash',
  'filter_sweep',
  'impact_cut',
  'spinback',
]);

// Vande Veire & De Bie (2018) State Machine Families: prevents adjacent transitions repeating the same move
export const TRANSITION_FAMILIES = {
  rolling: new Set(['bass_swap_blend', 'drum_loop_bridge', 'filter_sweep', 'half_time_switch']),
  relaxed: new Set(['long_blend', 'reverb_wash', 'echo_out', 'lyric_link', 'key_change_lift']),
  double_drop: new Set([
    'build_up_drop',
    'loop_roll_drop',
    'reverse_riser_drop',
    'impact_cut',
    'stutter_edit',
    'spinback',
    'vocal_mashup',
    'hook_over_groove',
    'acapella_in',
    'instrumental_in',
  ]),
};

export function getTransitionFamily(type) {
  for (const [fam, set] of Object.entries(TRANSITION_FAMILIES)) {
    if (set.has(type)) return fam;
  }
  return 'rolling';
}

export const GENRE_PLAYBOOKS = {
  punjabi: {
    label: 'Punjabi / Bhangra',
    drumStyle: 'dhol',
    typicalBpm: [85, 105],
    note: 'Dhol-driven bounce, vocal-forward; treat 85-105 & 170-210 equally; prefer dhol bridge or vocal-tag echo-out.',
  },
  bollywood: {
    label: 'Bollywood',
    drumStyle: 'dhol',
    typicalBpm: [80, 130],
    note: 'Melody & vocals first; watch free-time intros & mukhda hooks; use instrumental gaps and reverb washes.',
  },
  tamil_telugu: {
    label: 'Tamil / Telugu',
    drumStyle: 'dhol',
    typicalBpm: [90, 160],
    note: 'Heavy percussion fills & dramatic drops; loop rolls on drum fills or build-up into drop work best.',
  },
  hiphop: {
    label: 'Hip-Hop / Trap',
    drumStyle: 'trap',
    typicalBpm: [65, 90],
    note: 'Sparse 808 low-end; strict bass swaps only; acapella-in or vocal-over-instrumental mashups.',
  },
  pop: {
    label: 'Pop / Global',
    drumStyle: 'house',
    typicalBpm: [95, 130],
    note: 'Clean quantized grids; long blends and key-matched vocal handoffs.',
  },
  house: {
    label: 'House / Afro / Tech',
    drumStyle: 'house',
    typicalBpm: [120, 128],
    note: 'Extended 16-32 bar bass-swap blends, filter sweeps, and percussion layering.',
  },
  techno: {
    label: 'Techno',
    drumStyle: 'house',
    typicalBpm: [125, 140],
    note: 'Hypnotic percussion & subtle rising filters.',
  },
  chill: {
    label: 'R&B / Chill',
    drumStyle: 'house',
    typicalBpm: [60, 100],
    note: 'Smooth reverb washes, warm low-pass fades, zero harsh cuts.',
  },
};

export function inferGenreKey(track) {
  const txt = `${track.genre || ''} ${track.tags?.genre || ''} ${track.title || ''} ${track.artist || ''}`.toLowerCase();
  if (/punjabi|bhangra|diljit|aujla|sidhu|ap dhillon|shubh|badshah/.test(txt)) return 'punjabi';
  if (/tamil|telugu|kuthu|anirudh|thaman|vijay|pushpa/.test(txt)) return 'tamil_telugu';
  if (/hindi|bollywood|arijit|pritam|rahman|t-series|yrf|shreya|neha/.test(txt)) return 'bollywood';
  if (/trap|hip.?hop|rap|drill|808|krsna|divine|drake|travis|kendrick/.test(txt)) return 'hiphop';
  if (/techno|minimal|rave|hardstyle/.test(txt)) return 'techno';
  if (/house|afro|edm|club|remix|deep|melodic/.test(txt)) return 'house';
  if (/r&b|lofi|chill|acoustic|ballad/.test(txt)) return 'chill';
  return 'pop';
}

export function normalizeSongAnalysis(track) {
  const a = track.analysis || track;
  const id = track.id || track.song_id || `track-${Math.random().toString(36).slice(2, 8)}`;
  const durationSec = Math.max(20, Number(a.duration_sec || a.durationSec || track.durationSec) || 210);
  const gKey = inferGenreKey(track);
  const playbook = GENRE_PLAYBOOKS[gKey] || GENRE_PLAYBOOKS.pop;
  const fallbackBpm = Math.round((playbook.typicalBpm[0] + playbook.typicalBpm[1]) / 2);
  const bpm = Math.max(55, Math.min(200, Number(a.bpm || track.bpm) || fallbackBpm));
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;

  let bars = Array.isArray(a.bars) && a.bars.length ? a.bars : null;
  let downbeats = Array.isArray(a.downbeat_times || a.downbeats) && (a.downbeat_times || a.downbeats).length
    ? (a.downbeat_times || a.downbeats)
    : null;
  let beats = Array.isArray(a.beat_times || a.beats) && (a.beat_times || a.beats).length
    ? (a.beat_times || a.beats)
    : null;

  if (bars) {
    bars = bars.map((b, i) => ({
      ...b,
      bar: Number.isFinite(b.bar) ? b.bar : (Number.isFinite(b.bar_index) ? b.bar_index : i),
    }));
  } else {
    bars = [];
    const barCountEst = Math.max(8, Math.floor(durationSec / barSec));
    for (let i = 0; i < barCountEst; i++) {
      bars.push({
        bar: i,
        start_sec: Math.round(i * barSec * 1000) / 1000,
        end_sec: Math.round(Math.min(durationSec, (i + 1) * barSec) * 1000) / 1000,
      });
    }
  }
  const barCount = bars.length;

  if (!downbeats) {
    downbeats = bars.map((b) => b.start_sec);
  }
  if (!beats) {
    beats = [];
    for (const b of bars) {
      for (let k = 0; k < 4; k++) {
        beats.push(Math.round((b.start_sec + k * beatSec) * 1000) / 1000);
      }
    }
  }

  const heat = Array.isArray(a.heat || track.heat) && (a.heat || track.heat).length
    ? (a.heat || track.heat)
    : Array.from({ length: 88 }, (_, i) => {
        const p = i / 87;
        return Math.round(Math.max(0.15, Math.min(0.95, Math.min(p * 5, (1 - p) * 6, 0.72 + 0.2 * Math.sin(p * 12)))) * 100) / 100;
      });

  const energyPerBar = Array.isArray(a.energy_per_bar) && a.energy_per_bar.length === barCount
    ? a.energy_per_bar
    : bars.map((_, i) => {
        const idx = Math.min(heat.length - 1, Math.floor((i / Math.max(1, barCount)) * heat.length));
        return heat[idx];
      });

  const stemActivity = a.stem_activity && Array.isArray(a.stem_activity.vocals) && a.stem_activity.vocals.length === barCount
    ? a.stem_activity
    : {
        vocals: bars.map((_, i) => {
          const p = i / Math.max(1, barCount);
          return p < 0.1 || p > 0.86 ? 0.16 : 0.65;
        }),
        drums: bars.map((_, i) => {
          const p = i / Math.max(1, barCount);
          return p < 0.06 || p > 0.92 ? 0.35 : 0.75;
        }),
        bass: bars.map((_, i) => {
          const p = i / Math.max(1, barCount);
          return p < 0.08 || p > 0.9 ? 0.3 : 0.72;
        }),
        other: bars.map(() => 0.6),
      };

  const sections = Array.isArray(a.sections) && a.sections.length
    ? a.sections.map((s) => ({
        type: s.type || s.label || 'verse',
        start_bar: Number.isFinite(s.start_bar) ? s.start_bar : Math.max(0, Math.round((s.start_sec || 0) / barSec)),
        end_bar: Number.isFinite(s.end_bar) ? s.end_bar : Math.min(barCount, Math.round((s.end_sec || durationSec) / barSec)),
        start_sec: s.start_sec ?? 0,
        end_sec: s.end_sec ?? durationSec,
        energy: s.energy ?? s.energy_avg ?? 0.6,
      }))
    : [
        { type: 'intro', start_bar: 0, end_bar: Math.min(8, barCount), start_sec: 0, end_sec: Math.min(durationSec, 8 * barSec), energy: 0.45 },
        { type: 'chorus', start_bar: Math.min(8, barCount), end_bar: Math.max(8, barCount - 8), start_sec: Math.min(durationSec, 8 * barSec), end_sec: Math.max(8 * barSec, durationSec - 8 * barSec), energy: 0.8 },
        { type: 'outro', start_bar: Math.max(0, barCount - 8), end_bar: barCount, start_sec: Math.max(0, durationSec - 8 * barSec), end_sec: durationSec, energy: 0.48 },
      ];

  const phraseBoundaries = Array.isArray(a.phrase_boundaries) && a.phrase_boundaries.length
    ? a.phrase_boundaries
    : bars.filter((_, i) => i % 8 === 0).map((b) => ({
        bar: b.bar,
        sec: b.start_sec,
        multiple: b.bar % 32 === 0 ? 32 : b.bar % 16 === 0 ? 16 : 8,
      }));

  const instrumentalGaps = Array.isArray(a.instrumental_gaps)
    ? a.instrumental_gaps
    : (() => {
        const gaps = [];
        let gStart = null;
        for (let i = 0; i <= barCount; i++) {
          const quiet = i < barCount && (stemActivity.vocals[i] ?? 0.5) < 0.38;
          if (quiet && gStart === null) gStart = i;
          else if (!quiet && gStart !== null) {
            if (i - gStart >= 2) {
              gaps.push({
                start_bar: gStart,
                end_bar: i,
                start_sec: bars[gStart].start_sec,
                end_sec: bars[i - 1].end_sec,
                duration_sec: Math.round((bars[i - 1].end_sec - bars[gStart].start_sec) * 10) / 10,
                avg_vocal: 0.18,
              });
            }
            gStart = null;
          }
        }
        return gaps;
      })();

  return {
    id,
    song_id: id,
    title: track.title || a.title || 'Untitled',
    artist: track.artist || a.artist || 'Artist',
    duration_sec: durationSec,
    bpm,
    bpm_confidence: Number(a.bpm_confidence ?? a.bpmConfidence ?? (track.dspReady ? 0.85 : 0.45)),
    beat_times: beats,
    downbeat_times: downbeats,
    bar_count: barCount,
    bars,
    phrase_boundaries: phraseBoundaries,
    sections,
    key: a.key || track.key || null,
    key_camelot: a.key_camelot || a.camelot || track.key_camelot || track.camelot || null,
    key_confidence: Number(a.key_confidence ?? a.keyStrength ?? track.key_confidence ?? 0.6),
    energy_per_bar: energyPerBar,
    stem_activity: stemActivity,
    instrumental_gaps: instrumentalGaps,
    lyrics: Array.isArray(track.lyrics || a.lyrics) ? (track.lyrics || a.lyrics) : [],
    language: track.language || a.language || null,
    lyric_understanding: track.lyric_understanding || a.lyric_understanding || {
      language: track.language || a.language || 'unknown',
      romanised: '',
      translation: '',
      theme: playbook.label,
      mood: (track.energy || 7) >= 8 ? 'hype' : 'groovy',
      emotional_arc: 'rising',
      hook_line: '',
      hook_sec: null,
      repeated_phrases: [],
      call_and_response: '',
      spoken_intro: (a.tempo_stability?.free_time_intro_sec || 0) >= 6,
      explicit_flag: false,
      do_not_cut_ranges: [],
    },
    tags: a.tags || {
      genre: playbook.label,
      mood: (track.energy || 7) >= 8 ? 'energetic' : 'groovy',
      danceability: 0.78,
      vocal_presence: 0.55,
      drum_feel: playbook.drumStyle,
    },
    genreKey: track.genreKey || gKey,
    bpm_confidence: a.bpm_confidence ?? a.bpmConfidence ?? 0.75,
    warnings: Array.isArray(a.warnings) ? a.warnings : (track.warnings || []),
    tempo_stability: a.tempo_stability || { drift_pct: 0, is_variable: false, free_time_intro_sec: 0, tempo_changes: [] },
    content_hash: a.content_hash || track.content_hash || null,
    cached: Boolean(a.cached ?? track.cached),
    tracker_comparison: a.tracker_comparison || track.tracker_comparison || null,
    low_confidence: Boolean(a.low_confidence ?? track.low_confidence),
    safe_transitions_only: Boolean(a.safe_transitions_only ?? track.safe_transitions_only),
    neuralStems: Boolean(a.neuralStems || track.neuralStems || a.stems_available || track.stems_available),
    stems_available: Boolean(a.stems_available ?? track.stems_available ?? a.neuralStems ?? track.neuralStems),
    stem_mode: a.stem_mode || track.stem_mode || ((a.neuralStems || track.neuralStems) ? 'demucs-4stem' : 'eq-midside-off'),
    heat,
    isDsp: Boolean(track.file || track.stemFiles || track.stemUrls || track.neuralStems || track.isDsp || (track.dspReady && track.streamUrl)),
  };
}

function findProtectedRangeOverlap(song, startBar, lenBars = 1) {
  const ranges = song?.lyric_understanding?.do_not_cut_ranges || [];
  if (!ranges.length || !song?.bars?.length) return null;
  const sIdx = Math.max(0, Math.min(song.bars.length - 1, Number(startBar) || 0));
  const eIdx = Math.max(sIdx, Math.min(song.bars.length - 1, sIdx + Math.max(0, (Number(lenBars) || 1) - 1)));
  const winStart = song.bars[sIdx]?.start_sec;
  const winEnd = song.bars[eIdx]?.end_sec ?? winStart;
  if (!Number.isFinite(winStart) || !Number.isFinite(winEnd)) return null;
  for (const r of ranges) {
    const rStart = Number(r.start_sec);
    const rEnd = Number(r.end_sec);
    if ((winStart > rStart + 0.8 && winStart < rEnd - 0.8) || (rStart + 0.8 < winEnd && rEnd - 0.8 > winStart)) {
      return { reason: r.reason || 'hook', winStart, winEnd, rStart, rEnd };
    }
  }
  return null;
}

/**
 * Exact Tempo Fit T (with half-time / double-time octave invariance):
 * T = clamp01(1 - bpm_gap / 8)
 */
export function computeTempoFit(bpmA, bpmB) {
  if (!bpmA || !bpmB) return { T: 0.65, targetBpmB: bpmA || 120, stretchRatio: 1, octaveMode: 'direct' };
  const candidates = [
    { eff: bpmB, mode: 'direct' },
    { eff: bpmB * 2, mode: 'double_time' },
    { eff: bpmB * 0.5, mode: 'half_time' },
  ];
  let best = { diffPct: Infinity, eff: bpmB, mode: 'direct' };
  for (const c of candidates) {
    const diffPct = (Math.abs(bpmA - c.eff) / Math.max(60, bpmA)) * 100;
    if (diffPct < best.diffPct) best = { diffPct, eff: c.eff, mode: c.mode };
  }
  const T = Math.max(0, Math.min(1, 1 - best.diffPct / 8));
  const stretchRatio = bpmA / best.eff;
  return {
    T: Math.round(T * 1000) / 1000,
    diffPct: Math.round(best.diffPct * 10) / 10,
    effectiveBpmB: best.eff,
    stretchRatio: Math.round(stretchRatio * 10000) / 10000,
    octaveMode: best.mode,
  };
}

/**
 * Exact Key Fit K with +-2 semitone pitch-shifting optimizer
 */
export function computeKeyFit(camA, camB) {
  if (!camA || !camB) return { K: 0.6, bestShift: 0, distance: null, shiftedCamelotB: camB };
  let best = { K: 0, shift: 0, dist: 99, camB };
  for (const shift of [0, -1, 1, -2, 2]) {
    const shifted = shiftCamelot(camB, shift);
    const dist = camelotDistance(camA, shifted);
    const base = dist === 0 ? 1.0 : dist === 1 ? 0.8 : dist === 2 ? 0.4 : 0;
    const cost = Math.abs(shift) * 0.1;
    const K = Math.max(0, base - cost);
    if (K > best.K || (K === best.K && Math.abs(shift) < Math.abs(best.shift))) {
      best = { K, shift, dist, camB: shifted };
    }
  }
  return {
    K: Math.round(best.K * 1000) / 1000,
    bestShift: best.shift,
    distance: best.dist,
    shiftedCamelotB: best.camB,
  };
}

function barSectionAt(song, barIdx) {
  return song.sections.find((s) => barIdx >= s.start_bar && barIdx < s.end_bar) || song.sections[0] || { type: 'verse', energy: 0.6 };
}

function getArcDir(arc = 'peak', moodEnergy = null) {
  if (Number.isFinite(moodEnergy)) {
    if (moodEnergy < 42) return -1;
    if (moodEnergy > 68) return 1;
    return 0;
  }
  if (arc === 'warmup') return 1;
  if (arc === 'winddown') return -1;
  return 0; // peak / bangers hold high energy
}

/**
 * DJustify Cue Card Shortlist Generator:
 * Precomputes phrase-aligned candidate cut-out and entry-in bars (phrase ends,
 * section boundaries, harmonic restarts, post-vocal phrase ends, and bass onsets)
 * so both heuristic & LLM planners choose from clean DJ cues instead of a blank timeline.
 */
export function buildCueCard(song, role = 'out', playMode = 'club') {
  const barCount = Math.max(1, song.bar_count || 16);
  const barDur = 240 / Math.max(55, song.bpm || 120);
  const cues = [];
  const pushCue = (bar, reason, scoreBias = 0) => {
    const b = Math.max(0, Math.min(barCount - 1, Math.round(bar)));
    if (!cues.some((c) => c.bar === b)) {
      cues.push({ bar, b, sec: Math.round((song.bars?.[b]?.start_sec ?? b * barDur) * 10) / 10, reason, scoreBias });
    }
  };

  if (role === 'out') {
    const maxSafeOut = Math.max(1, barCount - (barCount >= 40 ? 16 : 6));
    const minSafeOut = barCount >= 40 ? Math.max(8, barCount - 32) : Math.max(2, Math.floor(barCount * 0.45));

    // Vocal-phrase end cues (strictly after protected vocal phrases)
    const protRanges = song.lyric_understanding?.do_not_cut_ranges || [];
    for (const r of protRanges) {
      const endBar = Math.ceil((Number(r.end_sec) || 0) / barDur);
      const aligned = endBar + ((4 - (endBar % 4)) % 4);
      if (aligned >= minSafeOut && aligned <= maxSafeOut) {
        pushCue(aligned, 'vocal_phrase_end', 0.08);
      }
    }

    if (playMode === 'hooks' && barCount >= 12) {
      const mid = Math.min(maxSafeOut, Math.max(8, Math.round(barCount * 0.55)));
      pushCue(Math.min(maxSafeOut, Math.max(4, mid - (mid % 8))), 'hook_exit', 0.06);
    }

    const preOutroBar = song.sections.find((s) => s.type === 'outro')?.start_bar;
    if (preOutroBar && preOutroBar >= 8) {
      const targetPhrase = Math.max(8, preOutroBar - (preOutroBar % 8));
      if (targetPhrase <= maxSafeOut) pushCue(targetPhrase, 'section_pre_outro', 0.09);
    }

    const latePhrase = (song.phrase_boundaries || [])
      .map((p) => p.bar)
      .filter((b) => b >= minSafeOut && b <= maxSafeOut && (song.energy_per_bar[b] ?? 0.6) >= 0.35);
    for (const b of latePhrase) pushCue(b, b % 16 === 0 ? '16bar_phrase_end' : '8bar_phrase_end', b % 16 === 0 ? 0.05 : 0.02);

    // Bass dropout cue in outgoing energy/bass curve
    const bassArr = song.stem_activity?.bass || [];
    for (let b = minSafeOut; b <= maxSafeOut; b += 4) {
      if ((bassArr[b] ?? 0.6) < 0.35 && (bassArr[Math.max(0, b - 4)] ?? 0.6) >= 0.55) {
        pushCue(b, 'bass_dropout', 0.06);
      }
    }

    if (!cues.length) {
      const defBar = Math.min(maxSafeOut, Math.max(0, Math.floor(barCount * 0.6) - (Math.floor(barCount * 0.6) % 4)));
      pushCue(Math.min(maxSafeOut, defBar), 'fallback_phrase', 0);
    }
    return cues.slice(0, 5).map(({ b, sec, reason, scoreBias }) => ({ bar: b, sec, reason, scoreBias }));
  }

  // role === 'in'
  if (song.tempo_stability?.free_time_intro_sec >= 4.0) {
    const afterIntroBar = Math.ceil(song.tempo_stability.free_time_intro_sec / barDur);
    const aligned = afterIntroBar + ((4 - (afterIntroBar % 4)) % 4);
    if (aligned < barCount - 12) pushCue(aligned, 'post_free_time_intro', 0.1);
  }

  const chorusOrDrop = song.sections.find((s) => s.type === 'chorus' || s.type === 'drop');
  if (chorusOrDrop && chorusOrDrop.start_bar < barCount - 12) {
    const cb = Math.max(0, chorusOrDrop.start_bar - (chorusOrDrop.start_bar % 4));
    if (playMode === 'hooks' || playMode === 'festival') {
      pushCue(cb, 'chorus_drop_restart', 0.1);
    } else {
      pushCue(cb, 'chorus_restart', 0.04);
    }
  }

  const introSec = song.sections.find((s) => s.type === 'intro');
  if (introSec && introSec.end_bar < barCount - 16) {
    const harmonicRestart = Math.max(0, introSec.end_bar - (introSec.end_bar % 4));
    pushCue(harmonicRestart, 'harmonic_restart_verse', 0.08);
  }

  const buildBar = song.sections.find((s) => s.type === 'build')?.start_bar;
  if (buildBar && buildBar < barCount - 16) {
    pushCue(buildBar - (buildBar % 4), 'build_onset', 0.06);
  }

  // Bass onset bar (first beat where bass hits full groove)
  const bassArr = song.stem_activity?.bass || [];
  const bassOnsetIdx = bassArr.findIndex((v, i) => i < barCount - 14 && i % 4 === 0 && v >= 0.62);
  if (bassOnsetIdx > 0) pushCue(bassOnsetIdx, 'bass_onset', 0.05);

  pushCue(0, 'bar_0_intro', 0);
  return cues.slice(0, 4).map(({ b, sec, reason, scoreBias }) => ({ bar: b, sec, reason, scoreBias }));
}

/**
 * Computes Pair Compatibility Score (Mosaikbox ISMIR 2024: acoustic/structural metrics only, zero lyric-similarity dilution):
 * S = 0.25*T + 0.20*K + 0.15*E + 0.15*P + 0.15*V + 0.10*G - R
 * Returns top 5 ranked candidate transition mix points drawn from DJustify Cue Cards.
 */
export function scorePairCandidates(songA, songB, { arc = 'peak', playMode = 'club', moodEnergy = null, prevFamily = null } = {}) {
  const tempo = computeTempoFit(songA.bpm, songB.bpm);
  const keyFit = computeKeyFit(songA.key_camelot, songB.key_camelot);
  const bpmGapAbs = Math.abs((songA.bpm || 120) - (tempo.effectiveBpmB || songB.bpm || 120));

  // Genre & mood bridge G
  const sameGenre = songA.genreKey === songB.genreKey;
  const G = sameGenre ? 1.0 : ((songA.genreKey === 'house' && songB.genreKey === 'pop') || (songA.genreKey === 'punjabi' && songB.genreKey === 'bollywood') ? 0.8 : 0.45);

  // Risk penalty R (up to 0.30)
  let R = 0;
  if (songA.warnings.includes('no_clear_beat') || songB.warnings.includes('no_clear_beat')) R += 0.16;
  if (songA.warnings.includes('variable_tempo') || songB.warnings.includes('variable_tempo')) R += 0.08;
  if (songA.warnings.includes('low_confidence') || songB.warnings.includes('low_confidence')) R += 0.05;
  R = Math.min(0.3, Math.round(R * 1000) / 1000);

  // DJustify Cue Cards shortlist
  const cueOutCard = buildCueCard(songA, 'out', playMode);
  const cueInCard = buildCueCard(songB, 'in', playMode);

  const arcDir = getArcDir(arc, moodEnergy);
  const unsafeSong = Boolean(
    songA.safe_transitions_only ||
    songB.safe_transitions_only ||
    songA.warnings.includes('no_clear_beat') ||
    songB.warnings.includes('no_clear_beat') ||
    songA.warnings.includes('variable_tempo') ||
    songB.warnings.includes('variable_tempo') ||
    songA.warnings.includes('low_confidence') ||
    songB.warnings.includes('low_confidence')
  );

  const scored = [];
  for (const cOut of cueOutCard) {
    const outBar = cOut.bar;
    for (const cIn of cueInCard) {
      const inBar = cIn.bar;
      // Tighten tempo blend window: long 16-bar blends within +-3.2 BPM, shorter 8-bar up to 8%, else 4-bar quick cut
      const lengthBars = bpmGapAbs <= 3.2 ? 16 : tempo.diffPct <= 8 ? 8 : 4;
      const safeLen = Math.max(4, Math.min(lengthBars, songA.bar_count - outBar, songB.bar_count - inBar));
      const secA = barSectionAt(songA, outBar);
      const secB = barSectionAt(songB, inBar + Math.min(4, Math.floor(safeLen / 2)));

      // Structure Gate guard: avoid landing inside a low-energy incoming intro during peak/festival sets
      const introTrap = (secB.type === 'intro' && (secB.energy ?? 0.5) < 0.42 && arc !== 'warmup' && cIn.reason === 'bar_0_intro') ? 0.08 : 0;

      // Energy fit E
      const eDelta = (secB.energy ?? 0.65) - (secA.energy ?? 0.65);
      let E = 0.7;
      if (arcDir > 0) E = eDelta >= -0.05 ? Math.min(1, 0.7 + eDelta) : Math.max(0.15, 0.7 + eDelta * 1.5);
      else if (arcDir < 0) E = eDelta <= 0.05 ? Math.min(1, 0.7 - eDelta) : Math.max(0.15, 0.7 - eDelta * 1.5);
      else E = Math.max(0.25, 1 - Math.abs(eDelta) * 1.2);
      E = Math.round(E * 1000) / 1000;

      // Phrase fit P
      let P = (outBar % 16 === 0 && inBar % 16 === 0) ? 0.9 : (outBar % 8 === 0 && inBar % 8 === 0) ? 0.72 : 0.48;
      if (secA.type === 'outro' && (secB.type === 'intro' || secB.type === 'build' || secB.type === 'verse')) P = Math.min(1, P + 0.15);
      P = Math.round(P * 1000) / 1000;

      // Vocal clearance V across overlap window
      let clashBars = 0;
      for (let k = 0; k < safeLen; k++) {
        const va = songA.stem_activity.vocals[Math.min(songA.bar_count - 1, outBar + k)] ?? 0.5;
        const vb = songB.stem_activity.vocals[Math.min(songB.bar_count - 1, inBar + k)] ?? 0.5;
        if (va > 0.45 && vb > 0.45) clashBars++;
      }
      const V = Math.round((1 - clashBars / Math.max(1, safeLen)) * 1000) / 1000;

      // Choose best transition template with Pro +-3.2 BPM rule & Vande Veire family variety
      let type = 'bass_swap_blend';
      if (unsafeSong) {
        type = 'echo_out';
      } else if (tempo.octaveMode !== 'direct' && tempo.diffPct <= 6) {
        type = 'half_time_switch';
      } else if (tempo.diffPct > 8 || (bpmGapAbs > 4.5 && tempo.diffPct > 5)) {
        type = eDelta > 0.18 ? 'build_up_drop' : 'echo_out';
      } else if (!sameGenre && (songA.genreKey === 'punjabi' || songB.genreKey === 'punjabi' || songA.genreKey === 'bollywood')) {
        type = 'drum_loop_bridge';
      } else if (keyFit.distance !== null && keyFit.distance >= 2) {
        type = 'filter_sweep';
      } else if (V >= 0.72 && (songA.instrumental_gaps.length || songB.instrumental_gaps.length)) {
        type = 'vocal_mashup';
      } else if (eDelta > 0.2) {
        type = 'build_up_drop';
      } else if (eDelta < -0.2) {
        type = 'reverb_wash';
      } else if (keyFit.distance === 0 && bpmGapAbs <= 3.2 && safeLen >= 16) {
        type = 'long_blend';
      }

      // Vande Veire State Machine: avoid repeating the same family back-to-back
      if (prevFamily && getTransitionFamily(type) === prevFamily && !unsafeSong) {
        if (prevFamily === 'rolling') {
          type = eDelta >= 0.08 ? 'reverse_riser_drop' : 'reverb_wash';
        } else if (prevFamily === 'double_drop') {
          type = bpmGapAbs <= 3.2 && keyFit.distance <= 1 ? 'bass_swap_blend' : 'filter_sweep';
        } else {
          type = eDelta >= 0 ? 'build_up_drop' : 'bass_swap_blend';
        }
      }

      const cueBonus = (cOut.scoreBias || 0) + (cIn.scoreBias || 0) - introTrap;
      const rawScore = 0.25 * tempo.T + 0.2 * keyFit.K + 0.15 * E + 0.15 * P + 0.15 * V + 0.1 * G - R + cueBonus * 0.25;
      const protA = findProtectedRangeOverlap(songA, outBar, safeLen);
      const protB = findProtectedRangeOverlap(songB, inBar, safeLen);
      const protPenalty = (protA || protB) ? 0.65 : 0;
      const S = Math.round(Math.max(0.05, Math.min(1, rawScore - protPenalty)) * 1000) / 1000;

      scored.push({
        mix_out_bar: outBar,
        mix_in_bar: inBar,
        cue_out_reason: cOut.reason,
        cue_in_reason: cIn.reason,
        length_bars: safeLen,
        type,
        family: getTransitionFamily(type),
        pitch_shift_semitones: keyFit.bestShift,
        stretch_ratio: tempo.diffPct <= 8 ? tempo.stretchRatio : 1,
        octave_mode: tempo.octaveMode,
        bpm_diff_pct: tempo.diffPct,
        bpm_gap_abs: Math.round(bpmGapAbs * 10) / 10,
        score: S,
        breakdown: {
          T: tempo.T,
          K: keyFit.K,
          E,
          P,
          V,
          G: Math.round(G * 1000) / 1000,
          R,
        },
        vocal_clash_bars: clashBars,
        key_distance: keyFit.distance,
        unsafe: unsafeSong,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return {
    bestScore: scored[0]?.score ?? 0.5,
    candidates: scored.slice(0, 5),
    cueOutCard,
    cueInCard,
  };
}

/**
 * Creativity Engine: generates 3 contrasting creative transition concepts for a pair,
 * scores each on surprise, smoothness, and crowd_energy, and selects the winner.
 */
export function generateCreativeIdeas(songA, songB, cand, arc = 'peak') {
  const sameKey = cand.key_distance === 0 || cand.key_distance === 1;
  const dStyle = (GENRE_PLAYBOOKS[songB.genreKey] || GENRE_PLAYBOOKS.pop).drumStyle;
  const idea1 = {
    type: cand.type || 'bass_swap_blend',
    idea: `${String(cand.type || 'bass_swap_blend').replace(/_/g, ' ')}: phrase-aligned downbeat handoff.`,
    surprise: 0.65,
    smoothness: Math.min(0.96, 0.72 + (cand.breakdown?.P || 0.7) * 0.24),
    crowd_energy: arc === 'bangers' ? 0.85 : 0.78,
  };
  const idea2 = cand.unsafe
    ? {
        type: 'reverb_wash',
        idea: 'Ambient reverb wash & low-pass melt into incoming downbeat.',
        surprise: 0.62,
        smoothness: 0.9,
        crowd_energy: 0.72,
      }
    : sameKey && (songA.instrumental_gaps?.length || songB.instrumental_gaps?.length)
      ? {
          type: 'hook_over_groove',
          idea: `Layer ${songB.title}'s vocal hook over ${songA.title}'s stripped drum & bass groove.`,
          surprise: 0.92,
          smoothness: 0.86,
          crowd_energy: 0.9,
        }
      : {
          type: 'reverse_riser_drop',
          idea: `Reverse noise riser + 1/2-beat tension sweep slamming ${songB.title}'s chorus.`,
          surprise: 0.86,
          smoothness: 0.78,
          crowd_energy: 0.93,
        };
  const idea3 = cand.unsafe
    ? {
        type: 'impact_cut',
        idea: 'Clean Beat-1 sub impact cut with zero vocal bleed.',
        surprise: 0.68,
        smoothness: 0.82,
        crowd_energy: 0.79,
      }
    : (songA.lyric_understanding?.theme && songB.lyric_understanding?.theme && songA.lyric_understanding.theme === songB.lyric_understanding.theme)
      ? {
          type: 'lyric_link',
          idea: `Thematic call-and-response handoff across matching mood (${songA.lyric_understanding.theme}).`,
          surprise: 0.94,
          smoothness: 0.84,
          crowd_energy: 0.86,
        }
      : {
          type: 'drum_loop_bridge',
          idea: `Lock an 8-bar quantized ${dStyle.toUpperCase()} groove bridge between ${songA.title} and ${songB.title}.`,
          surprise: 0.84,
          smoothness: 0.85,
          crowd_energy: 0.84,
        };

  return [idea1, idea2, idea3].map((it) => ({
    ...it,
    total: Math.round((it.surprise * 0.34 + it.smoothness * 0.36 + it.crowd_energy * 0.3) * 1000) / 1000,
  })).sort((a, b) => b.total - a.total);
}

/**
 * Generates a full schema-compliant, validator-safe transition recipe from a scored candidate.
 */
export function buildRecipeFromCandidate(songA, songB, cand, overrideType = null) {
  const type = overrideType || cand.type || 'bass_swap_blend';
  const len = Math.max(4, Math.min(cand.length_bars || 16, songA.bar_count - cand.mix_out_bar, songB.bar_count - cand.mix_in_bar));
  const mid = Math.max(1, Math.floor(len / 2));
  const stretchTo = cand.bpm_diff_pct <= 8 ? songA.bpm : songB.bpm;

  // Enforce Bass Rule + Vocal Rule inside every recipe!
  let stem_layers = [
    { song: songA.song_id, stem: 'all', start_bar: 0, end_bar: len, gain_curve: [[0, 1], [mid, 0.85], [len, 0]] },
    { song: songB.song_id, stem: 'all', start_bar: 0, end_bar: len, gain_curve: [[0, 0.05], [mid, 0.88], [len, 1]] },
  ];

  // Clean bass swap: A keeps bass [0..mid], cuts at [mid..len]; B cuts bass [0..mid], slams in at [mid..len]!
  // Vande Veire & De Bie EQ pattern: also keep only ONE song's treble audible across layered handover!
  let eq_automation = [
    { deck: 'A', band: 'low', points: [[0, 0], [mid - 0.1, 0], [mid, -28], [len, -28]] },
    { deck: 'B', band: 'low', points: [[0, -28], [mid - 0.1, -28], [mid, 0], [len, 0]] },
  ];
  const incompatibleHarmonics = (cand.key_distance ?? 0) >= 2;
  if (type === 'bass_swap_blend' || type === 'long_blend') {
    eq_automation.push(
      { deck: 'A', band: 'high', points: [[0, 0], [mid - 0.1, -3], [mid, -14], [len, -22]] },
      { deck: 'B', band: 'high', points: [[0, -14], [mid - 0.1, -10], [mid, 0], [len, 0]] }
    );
  }

  let filter_automation = [];
  let fx = [];
  let added_drums = null;
  let why = `Matched ${songA.bpm} -> ${songB.bpm} BPM (${cand.bpm_diff_pct}% diff), compatibility ${(cand.score * 100).toFixed(0)}%.`;

  if (type === 'bass_swap_blend') {
    eq_automation.push({ deck: 'A', band: 'mid', points: [[0, 0], [mid, -1.5], [len, -5]] });
    filter_automation = [{ deck: 'A', curve: [[0, 0], [mid, 0.14], [len, 0.34]] }];
  } else if (type === 'long_blend') {
    eq_automation = [
      { deck: 'A', band: 'low', points: [[0, 0], [mid, -18], [len, -28]] },
      { deck: 'B', band: 'low', points: [[0, -28], [mid - 0.5, -24], [mid, 0], [len, 0]] },
      { deck: 'A', band: 'high', points: [[0, 0], [mid, -12], [len, -22]] },
      { deck: 'B', band: 'high', points: [[0, -14], [mid - 0.5, -10], [mid, 0], [len, 0]] },
    ];
    stem_layers = [
      { song: songA.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 1], [mid, 0.15], [len, 0]] },
      { song: songB.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.05], [mid, 0.95], [len, 1]] },
    ];
    why = `Compatible Camelot lock & tight <=3 BPM fit -> extended ${len}-bar single-bass/single-treble blend.`;
  } else if (type === 'vocal_mashup' || type === 'acapella_in' || type === 'instrumental_in' || type === 'hook_over_groove') {
    stem_layers = [
      { song: songA.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.14], [len, 0.02]] },
      { song: songA.song_id, stem: 'drums', start_bar: 0, end_bar: len, gain_curve: [[0, 1], [len - 2, 0.6], [len, 0]] },
      { song: songA.song_id, stem: 'other', start_bar: 0, end_bar: len, gain_curve: [[0, type === 'hook_over_groove' ? 0.45 : 0.7], [len, 0]] },
      { song: songB.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.95], [len, 1]] },
      { song: songB.song_id, stem: 'drums', start_bar: 0, end_bar: len, gain_curve: [[0, 0.25], [mid, 0.85], [len, 1]] },
    ];
    why = type === 'hook_over_groove'
      ? `Layered ${songB.title}'s hook vocal over ${songA.title}'s stripped drum & bass groove with zero clash.`
      : `Instrumental gap & harmonic key fit -> layered B's vocals over A's instrumental cleanly with zero vocal clash.`;
  } else if (type === 'stutter_edit') {
    fx.push({ type: 'stutter', start_bar: Math.max(0, mid - 2), params: { division_beats: 0.25, repeats: 8 } });
    filter_automation = [{ deck: 'A', curve: [[0, 0], [mid, 0.55], [len, 0.78]] }];
    stem_layers = [
      { song: songA.song_id, stem: 'all', start_bar: 0, end_bar: len, gain_curve: [[0, 1], [mid, 0.85], [mid + 1, 0]] },
      { song: songB.song_id, stem: 'all', start_bar: 0, end_bar: len, gain_curve: [[0, 0.01], [mid - 0.1, 0.02], [mid, 1]] },
    ];
    why = `1/4-beat rhythmic stutter gate on ${songA.title} dropping squarely into ${songB.title}'s Beat 1.`;
  } else if (type === 'reverse_riser_drop') {
    fx.push({ type: 'reverse_riser', start_bar: 0, params: { drop_at_ratio: 0.75 } });
    filter_automation = [{ deck: 'A', curve: [[0, 0], [len * 0.74, 0.76], [len, 0.85]] }];
    stem_layers = [
      { song: songA.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.9], [len * 0.62, 0.12], [len, 0]] },
      { song: songB.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.04], [len * 0.74, 1], [len, 1]] },
    ];
    why = `Reversed breath & cymbal tension swell releasing cleanly onto ${songB.title}'s peak chorus downbeat.`;
  } else if (type === 'lyric_link') {
    fx.push({ type: 'echo', start_bar: Math.max(0, mid - 1), params: { feedback: 0.42, level: 0.45 } });
    stem_layers = [
      { song: songA.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 1], [mid - 0.5, 0.92], [mid, 0.08], [len, 0]] },
      { song: songB.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.02], [mid - 0.1, 0.02], [mid, 1], [len, 1]] },
    ];
    why = `Thematic lyric handoff (${songA.lyric_understanding?.theme || 'call & response'}) preserving clean phrase boundaries.`;
  } else if (type === 'key_change_lift') {
    fx.push({ type: 'key_lift', start_bar: 0, params: { semitones: Math.max(-2, Math.min(2, cand.pitch_shift_semitones || 1)) } });
    stem_layers = [
      { song: songA.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.85], [mid, 0.12], [len, 0]] },
      { song: songB.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.04], [mid, 0.96], [len, 1]] },
    ];
    why = `Harmonic +${Math.abs(cand.pitch_shift_semitones || 1)}st energy key-lift transition into ${songB.title}.`;
  } else if (type === 'filter_sweep') {
    filter_automation = [
      { deck: 'A', curve: [[0, 0], [len * 0.7, 0.72], [len, 0.85]] },
      { deck: 'B', curve: [[0, 0.45], [mid, 0.1], [len, 0]] },
    ];
    stem_layers = [
      { song: songA.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.85], [mid, 0.1], [len, 0]] },
      { song: songB.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.05], [mid, 0.9], [len, 1]] },
    ];
    why = `Masked harmonic tension with high-pass filter sweep while swapping kick & bass at bar ${mid}.`;
  } else if (type === 'echo_out') {
    fx.push({ type: 'echo', start_bar: 0, params: { feedback: 0.48, level: 0.55 } });
    stem_layers = [
      { song: songA.song_id, stem: 'all', start_bar: 0, end_bar: len, gain_curve: [[0, 1], [len * 0.55, 0.7], [len * 0.72, 0]] },
      { song: songB.song_id, stem: 'all', start_bar: 0, end_bar: len, gain_curve: [[0, 0.01], [len * 0.55, 0.05], [len * 0.72, 1]] },
    ];
    why = `Tempo/grid safety -> tempo-locked 1/2-beat echo tail on A drops cleanly onto B's downbeat.`;
  } else if (type === 'reverb_wash') {
    fx.push({ type: 'reverb', start_bar: 0, params: { level: 0.62 } });
    filter_automation = [{ deck: 'A', curve: [[0, 0], [len, -0.68]] }];
    stem_layers = [
      { song: songA.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.8], [mid, 0.1], [len, 0]] },
      { song: songB.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.05], [mid, 0.85], [len, 1]] },
    ];
    why = `Smoothing energy step-down -> warm low-pass + reverb tail washes A cleanly into B's intro.`;
  } else if (type === 'drum_loop_bridge') {
    const dStyle = (GENRE_PLAYBOOKS[songB.genreKey] || GENRE_PLAYBOOKS.pop).drumStyle;
    added_drums = { style: dStyle, pattern: `${dStyle}_groove`, start_bar: 0, end_bar: len, gain: 0.24 };
    filter_automation = [{ deck: 'A', curve: [[0, 0], [mid, 0.22], [len, 0.48]] }];
    stem_layers = [
      { song: songA.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.9], [mid, 0.08], [len, 0]] },
      { song: songB.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.02], [mid + 0.5, 0.95], [len, 1]] },
    ];
    why = `Cross-genre rhythmic bridge using quantized ${dStyle.toUpperCase()} drum pattern to unite grooves seamlessly.`;
  } else if (type === 'loop_roll_drop') {
    fx.push({ type: 'loop_roll', start_bar: 0, params: { divisions: [2, 1, 0.5] } });
    filter_automation = [{ deck: 'A', curve: [[0, 0], [len * 0.8, 0.78], [len, 0.85]] }];
    stem_layers = [
      { song: songA.song_id, stem: 'all', start_bar: 0, end_bar: len, gain_curve: [[0, 1], [len * 0.82, 1], [len, 0]] },
      { song: songB.song_id, stem: 'all', start_bar: 0, end_bar: len, gain_curve: [[0, 0.01], [len * 0.8, 0.01], [len * 0.86, 1]] },
    ];
    why = `Tension loop-roll (2->1->1/2 beat) & HPF rise slamming hard onto B's drop downbeat.`;
  } else if (type === 'build_up_drop') {
    fx.push({ type: 'riser_impact', start_bar: 0, params: { drop_at_ratio: 0.75 } });
    filter_automation = [{ deck: 'A', curve: [[0, 0], [len * 0.72, 0.75], [len, 0.85]] }];
    stem_layers = [
      { song: songA.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.9], [len * 0.65, 0.15], [len, 0]] },
      { song: songB.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.05], [len * 0.72, 1], [len, 1]] },
    ];
    why = `Rising tension filter + snare build releasing straight onto ${songB.title}'s peak drop.`;
  } else if (type === 'half_time_switch') {
    fx.push({ type: 'echo', start_bar: Math.max(0, mid - 1), params: { feedback: 0.4, level: 0.4 } });
    stem_layers = [
      { song: songA.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.9], [mid, 0.1], [len, 0]] },
      { song: songB.song_id, stem: 'vocals', start_bar: 0, end_bar: len, gain_curve: [[0, 0.05], [mid, 0.9], [len, 1]] },
    ];
    why = `Double/half-time octave alignment (${songA.bpm} ↔ ${songB.bpm} BPM) with quantized beat lock.`;
  } else if (type === 'spinback') {
    fx.push({ type: 'spinback', start_bar: Math.max(0, len - 2), params: { brake_sec: 0.85 } });
    stem_layers = [
      { song: songA.song_id, stem: 'all', start_bar: 0, end_bar: len, gain_curve: [[0, 1], [len * 0.65, 0.9], [len * 0.82, 0]] },
      { song: songB.song_id, stem: 'all', start_bar: 0, end_bar: len, gain_curve: [[0, 0.01], [len * 0.75, 0.05], [len * 0.82, 1]] },
    ];
    why = `Classic vinyl spinback brake dropping straight into ${songB.title}.`;
  } else if (type === 'impact_cut') {
    fx.push({ type: 'impact', start_bar: Math.max(0, mid), params: { sub_drop: true } });
    stem_layers = [
      { song: songA.song_id, stem: 'all', start_bar: 0, end_bar: len, gain_curve: [[0, 1], [mid, 0.75], [mid + 0.5, 0]] },
      { song: songB.song_id, stem: 'all', start_bar: 0, end_bar: len, gain_curve: [[0, 0.01], [mid - 0.1, 0.01], [mid, 1]] },
    ];
    why = `Clean downbeat cut with sub-drop impact on Beat 1.`;
  }

  // Mosaikbox (ISMIR 2024): rule-based removal of incompatible melodic stems when Camelot key clashes (>= 2 steps)
  if (incompatibleHarmonics && !['echo_out', 'impact_cut', 'spinback', 'stutter_edit', 'loop_roll_drop'].includes(type)) {
    const hasCustomOtherA = stem_layers.some((s) => s.song === songA.song_id && s.stem === 'other');
    if (!hasCustomOtherA) {
      stem_layers.push(
        { song: songA.song_id, stem: 'other', start_bar: 0, end_bar: len, gain_curve: [[0, 0.72], [mid - 0.5, 0.08], [len, 0]] },
        { song: songB.song_id, stem: 'other', start_bar: 0, end_bar: len, gain_curve: [[0, 0.06], [mid + 0.5, 0.92], [len, 1]] }
      );
    }
    why = `${why} (Mosaikbox incompatible-stem removal: masked colliding melody across overlap).`;
  }

  const creativeCandidates = generateCreativeIdeas(songA, songB, cand);
  return {
    from: songA.song_id,
    to: songB.song_id,
    mix_out_bar: cand.mix_out_bar,
    mix_in_bar: cand.mix_in_bar,
    cue_out_reason: cand.cue_out_reason || 'phrase_end',
    cue_in_reason: cand.cue_in_reason || 'downbeat',
    length_bars: len,
    type,
    family: getTransitionFamily(type),
    tempo_plan: {
      stretch_from: songB.bpm,
      stretch_to: stretchTo,
      pitch_shift_semitones: Math.max(-2, Math.min(2, cand.pitch_shift_semitones || 0)),
    },
    stem_layers,
    eq_automation,
    filter_automation,
    fx,
    added_drums,
    creative_idea: creativeCandidates.find((c) => c.type === type)?.idea || why,
    creative_candidates: creativeCandidates,
    why,
    risk: cand.unsafe ? 'high' : cand.score >= 0.72 ? 'low' : 'medium',
    fallback: cand.unsafe ? 'echo_out' : 'bass_swap_blend',
    compatibility: cand,
  };
}

/**
 * PHASE 3: DETERMINISTIC RECIPE VALIDATOR
 * Rejects any recipe that breaks bar limits, tempo stretch limits, key rules,
 * double basslines, overlapping vocals, or unsafe tracks without safe fallback.
 */
export function validateTransitionRecipe(recipe, songA, songB) {
  const errors = [];
  const warnings = [];
  if (!recipe || !songA || !songB) {
    return { valid: false, errors: ['Missing song analysis or recipe.'], warnings: [] };
  }

  const hasYtOnly = songA.isDsp === false || songB.isDsp === false;
  if (hasYtOnly && recipe.type === 'yt_volume_crossfade') {
    return {
      valid: true,
      errors: [],
      warnings: ['YouTube IFrame deck: volume/cue crossfade only (Web Audio EQ/filters/stems/beatmatch disabled).'],
    };
  }

  if (!TRANSITION_TYPES.includes(recipe.type)) {
    errors.push(`Unknown transition type "${recipe.type}".`);
  }
  if (!Number.isFinite(recipe.mix_out_bar) || recipe.mix_out_bar < 0 || recipe.mix_out_bar >= songA.bar_count) {
    errors.push(`mix_out_bar (${recipe.mix_out_bar}) out of range for ${songA.title} (0..${songA.bar_count - 1}).`);
  }
  if (!Number.isFinite(recipe.mix_in_bar) || recipe.mix_in_bar < 0 || recipe.mix_in_bar >= songB.bar_count) {
    errors.push(`mix_in_bar (${recipe.mix_in_bar}) out of range for ${songB.title} (0..${songB.bar_count - 1}).`);
  }
  const len = Number(recipe.length_bars) || 0;
  if (len < 1 || recipe.mix_out_bar + len > songA.bar_count || recipe.mix_in_bar + len > songB.bar_count) {
    errors.push(`Transition window (${len} bars) overflows song bounds.`);
  }

  // Phrase boundary / downbeat & high-energy exit rules
  const sectionStartsA = new Set((songA.sections || []).map((s) => s.start_bar));
  const sectionStartsB = new Set((songB.sections || []).map((s) => s.start_bar));
  if (songA.bar_count >= 24 && recipe.mix_out_bar % 4 !== 0 && !sectionStartsA.has(recipe.mix_out_bar)) {
    errors.push(`mix_out_bar (${recipe.mix_out_bar}) is off phrase boundary (expected 4/8/16-bar downbeat or section start).`);
  }
  if (songB.bar_count >= 24 && recipe.mix_in_bar % 4 !== 0 && !sectionStartsB.has(recipe.mix_in_bar)) {
    errors.push(`mix_in_bar (${recipe.mix_in_bar}) enters mid-phrase (must enter on intro, build, chorus, or phrase downbeat).`);
  }
  if (songA.bar_count >= 40 && !recipe.allowLateExit && (songA.bar_count - recipe.mix_out_bar) < 12) {
    errors.push(`mix_out_bar (${recipe.mix_out_bar}) leaves only ${songA.bar_count - recipe.mix_out_bar} bars; must leave outgoing song 16-32 bars before end.`);
  }

  // Tempo stretch limit check:
  // - Pro +-3.5 BPM cap for extended long_blend
  // - <= 8.5% ceiling for other layered blends (allowing half/double time)
  const stretchTo = Number(recipe.tempo_plan?.stretch_to || songA.bpm);
  const fromBpm = Number(recipe.tempo_plan?.stretch_from || songB.bpm);
  if (fromBpm > 0) {
    const absDirect = Math.abs(stretchTo - fromBpm);
    const absDouble = Math.abs(stretchTo - fromBpm * 2);
    const absHalf = Math.abs(stretchTo - fromBpm * 0.5);
    const minAbsBpm = Math.min(absDirect, absDouble, absHalf);
    if (recipe.type === 'long_blend' && minAbsBpm > 3.5) {
      errors.push(`Tempo gap ${minAbsBpm.toFixed(1)} BPM exceeds +-3.5 BPM limit for long_blend (use bass_swap_blend or echo_out).`);
    }

    const gapDirect = absDirect / fromBpm;
    const gapDouble = absDouble / (fromBpm * 2);
    const gapHalf = absHalf / (fromBpm * 0.5);
    const minGap = Math.min(gapDirect, gapDouble, gapHalf);
    if (minGap > 0.085 && !SAFE_TRANSITIONS.has(recipe.type) && recipe.type !== 'build_up_drop' && recipe.type !== 'loop_roll_drop') {
      errors.push(`Tempo stretch ${(minGap * 100).toFixed(1)}% exceeds 8% cap for layered blend.`);
    }
  }

  const semi = Number(recipe.tempo_plan?.pitch_shift_semitones || 0);
  if (Math.abs(semi) > 2) {
    errors.push(`Pitch shift ${semi} semitones exceeds +-2 semitone natural limit.`);
  }

  // Unsafe / low-confidence track check
  const unsafe = Boolean(
    songA.safe_transitions_only ||
    songB.safe_transitions_only ||
    songA.warnings.includes('no_clear_beat') ||
    songB.warnings.includes('no_clear_beat') ||
    songA.warnings.includes('variable_tempo') ||
    songB.warnings.includes('variable_tempo') ||
    songA.warnings.includes('low_confidence') ||
    songB.warnings.includes('low_confidence')
  );
  if (unsafe && !SAFE_TRANSITIONS.has(recipe.type)) {
    errors.push(`Track warnings / low_confidence require safe transition, got "${recipe.type}".`);
  }

  // Sample 5 checkpoints across overlap [0 .. len] for Bass Clash, Vocal Clash, and Harmonic Key rule
  const sampleGain = (curve, barOffset, defVal = 1) => {
    if (!Array.isArray(curve) || !curve.length) return defVal;
    const sorted = [...curve].sort((a, b) => a[0] - b[0]);
    if (barOffset <= sorted[0][0]) return sorted[0][1];
    if (barOffset >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1];
    for (let i = 0; i < sorted.length - 1; i++) {
      if (barOffset >= sorted[i][0] && barOffset <= sorted[i + 1][0]) {
        const span = Math.max(0.001, sorted[i + 1][0] - sorted[i][0]);
        const frac = (barOffset - sorted[i][0]) / span;
        return sorted[i][1] + (sorted[i + 1][1] - sorted[i][1]) * frac;
      }
    }
    return defVal;
  };

  const getLowGain01 = (deckChar, barOff) => {
    const songId = deckChar === 'A' ? songA.song_id : songB.song_id;
    const eq = (recipe.eq_automation || []).find((e) => e.deck === deckChar && e.band === 'low');
    if (eq?.points?.length) {
      const db = sampleGain(eq.points, barOff, 0);
      if (db <= -12) return 0.1;
    }
    const layers = (recipe.stem_layers || []).filter((s) => s.song === songId);
    const bassLayer = layers.find((s) => s.stem === 'bass');
    const allLayer = layers.find((s) => s.stem === 'all');
    const chosen = bassLayer || allLayer;
    if (chosen) {
      const start = Number.isFinite(chosen.start_bar) ? chosen.start_bar : 0;
      const end = Number.isFinite(chosen.end_bar) ? chosen.end_bar : len;
      if (barOff < start || barOff > end) return 0.0;
      if (chosen.gain_curve?.length) return sampleGain(chosen.gain_curve, barOff, 0.5);
      return 1.0;
    }
    if (eq?.points?.length) return 1.0;
    return deckChar === 'A' ? (barOff < len * 0.5 ? 1 : 0.1) : (barOff >= len * 0.5 ? 1 : 0.1);
  };

  for (let i = 0; i <= 4; i++) {
    const bOff = (len * i) / 4;
    const lowA = getLowGain01('A', bOff);
    const lowB = getLowGain01('B', bOff);
    if (lowA > 0.55 && lowB > 0.55) {
      errors.push(`Double bassline clash at overlap offset ${bOff.toFixed(1)} bars.`);
      break;
    }
  }

  // Check vocal overlap when both tracks are active without vocal ducking
  const getVocalGain = (songId, barOff) => {
    const vl = (recipe.stem_layers || []).find((s) => s.song === songId && s.stem === 'vocals');
    if (vl?.gain_curve?.length) return sampleGain(vl.gain_curve, barOff, 0.5);
    const al = (recipe.stem_layers || []).find((s) => s.song === songId && s.stem === 'all');
    if (al?.gain_curve?.length) return sampleGain(al.gain_curve, barOff, 0.5);
    return barOff < len * 0.5 ? 0.5 : 0.5;
  };

  let overlapVocalBars = 0;
  for (let b = 0; b < len; b++) {
    const actA = songA.stem_activity.vocals[Math.min(songA.bar_count - 1, recipe.mix_out_bar + b)] ?? 0.5;
    const actB = songB.stem_activity.vocals[Math.min(songB.bar_count - 1, recipe.mix_in_bar + b)] ?? 0.5;
    const gA = getVocalGain(songA.song_id, b + 0.5);
    const gB = getVocalGain(songB.song_id, b + 0.5);
    if (actA * gA > 0.42 && actB * gB > 0.42) overlapVocalBars++;
  }
  if (overlapVocalBars > Math.max(2, len * 0.45)) {
    if (recipe.type === 'vocal_mashup' || recipe.type === 'hook_over_groove' || recipe.type === 'lyric_link') {
      errors.push(`Two lead vocals clash for ${overlapVocalBars} bars during "${recipe.type}".`);
    } else {
      warnings.push(`High simultaneous vocal activity (${overlapVocalBars} bars); ensure vocal ducking is active.`);
    }
  }

  // Protected lyric ranges check ("do not cut through" crucial sung phrases)
  const hitA = findProtectedRangeOverlap(songA, recipe.mix_out_bar, len);
  if (hitA) {
    errors.push(`Mix-out window (${hitA.winStart.toFixed(1)}s-${hitA.winEnd.toFixed(1)}s) cuts through protected lyric phrase (${hitA.reason || 'hook'}).`);
  }
  const hitB = findProtectedRangeOverlap(songB, recipe.mix_in_bar, len);
  if (hitB) {
    errors.push(`Mix-in window (${hitB.winStart.toFixed(1)}s-${hitB.winEnd.toFixed(1)}s) lands inside protected lyric phrase (${hitB.reason || 'hook'}).`);
  }

  // Clipping headroom guard across full-mix overlaps
  for (let i = 0; i <= 4; i++) {
    const bOff = (len * i) / 4;
    const alA = (recipe.stem_layers || []).find((s) => s.song === songA.song_id && s.stem === 'all');
    const alB = (recipe.stem_layers || []).find((s) => s.song === songB.song_id && s.stem === 'all');
    if (alA && alB) {
      const gSum = sampleGain(alA.gain_curve, bOff, 0.5) + sampleGain(alB.gain_curve, bOff, 0.5);
      if (gSum > 1.88) {
        errors.push(`Summed deck gain (${gSum.toFixed(2)}) risks digital clipping at offset ${bOff.toFixed(1)} bars.`);
        break;
      }
    }
  }

  // Harmonic key rule for layered melodic stems
  if (songA.key_camelot && songB.key_camelot && (recipe.type === 'vocal_mashup' || recipe.type === 'long_blend' || recipe.type === 'hook_over_groove')) {
    const dist = camelotDistance(songA.key_camelot, shiftCamelot(songB.key_camelot, semi));
    if (dist > 1) {
      errors.push(`Melodic layered type "${recipe.type}" requires shifted Camelot distance <= 1 (got ${dist}).`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function repairOrFallbackRecipe(songA, songB, arc = 'peak', playMode = 'club') {
  const { candidates } = scorePairCandidates(songA, songB, { arc, playMode });
  const best = candidates[0] || {
    mix_out_bar: Math.max(0, songA.bar_count - 8),
    mix_in_bar: 0,
    length_bars: Math.min(8, songA.bar_count, songB.bar_count),
    type: 'echo_out',
    pitch_shift_semitones: 0,
    bpm_diff_pct: 10,
    score: 0.6,
    unsafe: true,
    breakdown: { T: 0.5, K: 0.5, E: 0.5, P: 0.5, V: 0.5, G: 0.5, R: 0.1 },
  };
  let rec = buildRecipeFromCandidate(songA, songB, best);
  const check = validateTransitionRecipe(rec, songA, songB);
  if (!check.valid) {
    const safeType = best.bpm_diff_pct <= 8 && !best.unsafe ? 'bass_swap_blend' : 'echo_out';
    rec = buildRecipeFromCandidate(songA, songB, { ...best, type: safeType, pitch_shift_semitones: 0 }, safeType);
  }
  rec.validation = validateTransitionRecipe(rec, songA, songB);
  return rec;
}

export function validateSetPlan(plan, songsMap) {
  const errors = [];
  const warnings = [];
  const results = [];
  for (const rec of plan.transitions || []) {
    const a = songsMap[rec.from];
    const b = songsMap[rec.to];
    const v = validateTransitionRecipe(rec, a, b);
    results.push({ from: rec.from, to: rec.to, ...v });
    if (!v.valid) errors.push(...v.errors.map((e) => `${rec.from}->${rec.to}: ${e}`));
    if (v.warnings.length) warnings.push(...v.warnings);
  }
  return { valid: errors.length === 0, errors, warnings, results };
}

/**
 * 9 DJustify + Pro DJ Acoustic Checker Gates:
 * Evaluates rendered audio metrics + recipe structure and produces exact, actionable repair instructions
 * for the Critic repair loop (up to 4 iterations).
 */
export const CHECKER_GATES = [
  { id: 'vocal_integrity', label: 'Vocal Cut Integrity', fix: 'Move mix_out_bar / mix_in_bar past protected phrase end' },
  { id: 'vocal_clash', label: 'Vocal Collision', fix: 'Shorten overlap, mute one vocal stem (<=0.12), or cut' },
  { id: 'energy_hole', label: 'Energy / Silent Gap', fix: 'Eliminate silent gap: tighten overlap or switch to rolling/build_up_drop' },
  { id: 'structure_intro_trap', label: 'Structure (Intro Trap)', fix: 'Entry stuck in flat incoming intro — re-cue mix_in_bar to verse or chorus' },
  { id: 'pairing_mismatch', label: 'Pairing / Tempo Jump', fix: 'Tempo or mood jump too large — switch to echo_out, build_up_drop, or re-order' },
  { id: 'beat_phase', label: 'Beat Phase Lock', fix: 'Onsets misaligned in overlap — re-align by cross-correlation or switch to echo_out' },
  { id: 'bass_overlap', label: 'Single Bassline', fix: 'Two kicks/basslines overlap — force strict low EQ <= -24dB bass swap at midpoint' },
  { id: 'loudness_clip', label: 'Loudness & Headroom', fix: 'Clipping or LUFS jump detected — apply -1.5dB gain trim & balance deck trim' },
  { id: 'key_clash', label: 'Harmonic Key Fit', fix: 'Key clash during overlap — pitch-shift <= +-2st, remove melodic stems, or use filter_sweep' },
];

export function evaluateCheckerGates(metrics = {}, recipe = null, songA = null, songB = null) {
  const gates = {};
  const failed_gates = [];
  const repair_instructions = [];
  const mark = (id, pass, detail) => {
    gates[id] = { pass: Boolean(pass), detail };
    if (!pass) {
      const def = CHECKER_GATES.find((g) => g.id === id);
      failed_gates.push({ id, label: def?.label || id, detail, fix: def?.fix || detail });
      repair_instructions.push(`[${id.toUpperCase()}] ${detail} -> FIX: ${def?.fix || 'adjust recipe'}`);
    }
  };

  const len = Math.max(1, Number(recipe?.length_bars) || 8);
  const a = songA ? normalizeSongAnalysis(songA) : null;
  const b = songB ? normalizeSongAnalysis(songB) : null;

  // 1. Vocal mid-phrase cut
  const hitA = a && recipe ? findProtectedRangeOverlap(a, recipe.mix_out_bar, len) : null;
  const hitB = b && recipe ? findProtectedRangeOverlap(b, recipe.mix_in_bar, len) : null;
  mark('vocal_integrity', !hitA && !hitB, hitA ? `Mix-out cuts "${hitA.reason}"` : hitB ? `Mix-in lands inside "${hitB.reason}"` : 'Clean phrase cut');

  // 2. Vocal collision
  const vocOverlap = Number(metrics.vocal_overlap_pct) || 0;
  mark('vocal_clash', vocOverlap <= 38, vocOverlap > 38 ? `Vocal overlap ${vocOverlap}% (>38%)` : `Vocal overlap ${vocOverlap}%`);

  // 3. Energy hole / silent gap
  const holePct = Number(metrics.energy_hole_pct) || 0;
  const minDip = Number(metrics.min_rms_dip_db) || 0;
  mark('energy_hole', holePct <= 24 && minDip >= -18, (holePct > 24 || minDip < -18) ? `Energy hole ${holePct}% / dip ${minDip}dB` : `Flow intact (min ${minDip}dB)`);

  // 4. Structure: entry stuck in flat incoming intro
  let introTrap = false;
  if (b && recipe) {
    const inSec = barSectionAt(b, recipe.mix_in_bar || 0);
    const hasBetterCue = b.sections.some((s) => (s.type === 'verse' || s.type === 'chorus' || s.type === 'drop') && s.start_bar < b.bar_count - 12);
    if (inSec.type === 'intro' && (inSec.energy ?? 0.5) < 0.36 && (recipe.mix_in_bar || 0) === 0 && hasBetterCue && b.bar_count >= 36 && !SAFE_TRANSITIONS.has(recipe.type) && len < 8) {
      introTrap = true;
    }
  }
  mark('structure_intro_trap', !introTrap, introTrap ? 'Entry stuck in low-energy bar-0 intro during quick cut' : 'Incoming structure OK');

  // 5. Pairing / tempo mismatch
  const tempoPct = a && b && recipe?.tempo_plan?.stretch_from
    ? (Math.abs((recipe.tempo_plan.stretch_to || a.bpm) - recipe.tempo_plan.stretch_from) / Math.max(55, recipe.tempo_plan.stretch_from)) * 100
    : (recipe?.compatibility?.bpm_diff_pct ?? 0);
  const tempoOctaveOk = a && b ? computeTempoFit(a.bpm, b.bpm).diffPct <= 8.5 : tempoPct <= 8.5;
  const pairingFail = recipe && !tempoOctaveOk && !SAFE_TRANSITIONS.has(recipe.type) && recipe.type !== 'build_up_drop' && recipe.type !== 'loop_roll_drop';
  mark('pairing_mismatch', !pairingFail, pairingFail ? `Tempo diff exceeds 8.5% without safe cut (${recipe.type})` : 'Tempo/pairing OK');

  // 6. Beat phase misalignment (onset jitter + cross-correlation phase shift)
  const driftMs = Number(metrics.beat_drift_ms) || 0;
  const phaseLagMs = Math.abs(Number(metrics.onset_phase_offset_ms) || 0);
  mark('beat_phase', driftMs <= 28 && phaseLagMs <= 26, (driftMs > 28 || phaseLagMs > 26) ? `Beat drift ${driftMs}ms / phase offset ${phaseLagMs}ms` : `Tight beat lock (${driftMs}ms drift)`);

  // 7. Bass overlap
  const bassPct = Number(metrics.bass_overlap_pct) || 0;
  mark('bass_overlap', bassPct <= 32, bassPct > 32 ? `Sub-bass overlap ${bassPct}% (>32%)` : `Bass overlap ${bassPct}%`);

  // 8. Loudness & clipping
  const clips = Number(metrics.clipping_samples) || 0;
  const lufsJump = Math.abs(Number(metrics.lufs_jump_db) || 0);
  mark('loudness_clip', clips === 0 && lufsJump <= 6.5, (clips > 0 || lufsJump > 6.5) ? `Clip=${clips} samples, LUFS jump=${lufsJump}dB` : `Headroom clean (${clips} clips, ${lufsJump}dB jump)`);

  // 9. Key clash with active melodic stems
  let keyClash = false;
  let keyDist = 0;
  if (a?.key_camelot && b?.key_camelot && recipe) {
    const semi = Number(recipe.tempo_plan?.pitch_shift_semitones || 0);
    keyDist = camelotDistance(a.key_camelot, shiftCamelot(b.key_camelot, semi));
    const melodicLayers = (recipe.stem_layers || []).some((s) => s.stem === 'vocals' || s.stem === 'other');
    if (keyDist >= 2 && (recipe.type === 'long_blend' || recipe.type === 'vocal_mashup' || recipe.type === 'hook_over_groove') && melodicLayers) {
      keyClash = true;
    }
  }
  mark('key_clash', !keyClash, keyClash ? `Camelot distance ${keyDist} in melodic blend "${recipe?.type}"` : 'Harmonic compatibility OK');

  return {
    passed: failed_gates.length === 0,
    total_gates: CHECKER_GATES.length,
    passed_count: CHECKER_GATES.length - failed_gates.length,
    failed_gates,
    repair_instructions,
    gates,
  };
}

/**
 * PHASE 2 BUILT-IN PLANNER (Running Order TSP + Top 5 Pair Scoring + Validated Recipes
 * + Vande Veire State Machine + Mosaikbox Set-Level Emotional Arc)
 */
export function planSetHeuristic(tracks, { vibe = 'peak', playMode = 'club', moodEnergy = null } = {}) {
  const analyses = tracks.map((t) => normalizeSongAnalysis(t));
  const map = {};
  for (const a of analyses) map[a.song_id] = a;

  if (analyses.length <= 1) {
    return {
      set_title: 'NOVA Set',
      order: analyses.map((a) => a.song_id),
      master_bpm_curve: analyses.map((a) => ({ at_song: a.song_id, bpm: a.bpm })),
      energy_plan: vibe,
      analyses,
      transitions: [],
      validation: { valid: true, errors: [], warnings: [], results: [] },
      quality: { tempo_smoothness: 100, bass_clashes: 0, vocal_clashes: 0, energy_flow: 100 },
      plannerSource: 'NOVA Pair-Compatibility Engine',
    };
  }

  // Greedy TSP / Beam ordering: acoustic pair fit + Mosaikbox set-level emotional arc placement + avoid back-to-back artists
  const pool = [...analyses];
  const avgEnergy = (a) => a.energy_per_bar.reduce((x, y) => x + y, 0) / Math.max(1, a.energy_per_bar.length);
  const moodArcFit = (song, idxFrac) => {
    const moodTxt = String(song.lyric_understanding?.mood || song.tags?.mood || '').toLowerCase();
    const highMood = /euphoric|hype|party|energetic|banger|aggressive/.test(moodTxt);
    const chillMood = /chill|tender|romantic|sad|melancholic|ambient/.test(moodTxt);
    if (vibe === 'warmup') return idxFrac > 0.6 && highMood ? 0.04 : idxFrac < 0.3 && chillMood ? 0.04 : 0;
    if (vibe === 'winddown') return idxFrac > 0.5 && chillMood ? 0.05 : 0;
    return 0;
  };

  let startIdx = 0;
  if (vibe === 'warmup') {
    startIdx = pool.reduce((b, x, i) => (avgEnergy(x) < avgEnergy(pool[b]) ? i : b), 0);
  } else if (vibe === 'winddown' || vibe === 'bangers') {
    startIdx = pool.reduce((b, x, i) => (avgEnergy(x) > avgEnergy(pool[b]) ? i : b), 0);
  }

  const ordered = [pool.splice(startIdx, 1)[0]];
  while (pool.length) {
    const prev = ordered[ordered.length - 1];
    const progressFrac = ordered.length / Math.max(1, analyses.length - 1);
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      const { bestScore } = scorePairCandidates(prev, cand, { arc: vibe, playMode, moodEnergy });
      let adj = bestScore + moodArcFit(cand, progressFrac);
      const a1 = String(prev.artist || '').toLowerCase().split(/[,&]/)[0].trim();
      const a2 = String(cand.artist || '').toLowerCase().split(/[,&]/)[0].trim();
      if (a1 && a2 && a1 === a2) adj -= 0.25;
      if (adj > bestVal) {
        bestVal = adj;
        bestIdx = i;
      }
    }
    ordered.push(pool.splice(bestIdx, 1)[0]);
  }

  const transitions = [];
  let tempoSmoothSum = 0;
  let vocalClashTotal = 0;
  let prevFamily = null;
  for (let i = 0; i < ordered.length - 1; i++) {
    const songA = ordered[i];
    const songB = ordered[i + 1];
    if (songA.isDsp === false || songB.isDsp === false) {
      const lenBars = 4;
      const outBar = Math.max(2, songA.bar_count - 4);
      const ytRec = {
        from: songA.song_id,
        to: songB.song_id,
        mix_out_bar: outBar,
        mix_in_bar: 0,
        length_bars: lenBars,
        type: 'yt_volume_crossfade',
        ytOnly: true,
        tempo_plan: { stretch_from: songB.bpm, stretch_to: songB.bpm, pitch_shift_semitones: 0 },
        stem_layers: [],
        eq_automation: [],
        filter_automation: [],
        fx: [],
        added_drums: null,
        why: 'YT VIDEO MODE (NO DSP): Discrete cue seek & equal-power volume crossfade only (Web Audio EQ/stems/stretch blocked by browser iframe policy).',
        risk: 'medium',
        fallback: 'yt_volume_crossfade',
        compatibility: { score: 0.55, bpm_diff_pct: 0, unsafe: false, breakdown: { T: 0.5, K: 0.5, E: 0.6, P: 0.6, V: 0.5, G: 0.5, R: 0 } },
      };
      ytRec.validation = validateTransitionRecipe(ytRec, songA, songB);
      transitions.push(ytRec);
      tempoSmoothSum += 0.5;
      vocalClashTotal += 1;
      continue;
    }
    // Vande Veire & De Bie state machine: pass prevFamily so identical transition types never repeat consecutively
    const { candidates } = scorePairCandidates(songA, songB, { arc: vibe, playMode, moodEnergy, prevFamily });
    let recipe = buildRecipeFromCandidate(songA, songB, candidates[0]);
    const v = validateTransitionRecipe(recipe, songA, songB);
    if (!v.valid) {
      recipe = repairOrFallbackRecipe(songA, songB, vibe, playMode);
    } else {
      recipe.validation = v;
    }
    recipe.candidates = candidates;
    prevFamily = getTransitionFamily(recipe.type);
    transitions.push(recipe);
    tempoSmoothSum += (candidates[0]?.breakdown?.T ?? 0.8);
    vocalClashTotal += (v.warnings?.length ? 1 : 0);
  }

  const plan = {
    set_title: `NOVA ${vibe.toUpperCase()} SET`,
    order: ordered.map((a) => a.song_id),
    master_bpm_curve: ordered.map((a) => ({ at_song: a.song_id, bpm: a.bpm })),
    energy_plan: vibe,
    analyses: ordered,
    transitions,
    plannerSource: 'NOVA DJustify + Vande Veire + Rule Validator',
  };
  plan.validation = validateSetPlan(plan, map);
  plan.quality = {
    tempo_smoothness: Math.round((tempoSmoothSum / Math.max(1, transitions.length)) * 100),
    bass_clashes: 0,
    vocal_clashes: vocalClashTotal,
    energy_flow: Math.round((transitions.reduce((acc, r) => acc + (r.compatibility?.breakdown?.E ?? 0.75), 0) / Math.max(1, transitions.length)) * 100),
  };
  return plan;
}

/**
 * Tap-Tempo & Beat-1 Phase Calibration Override:
 * Shifts downbeats cleanly for Indian free-time intros / offbeat Bar-1 grids and rebuilds phrase maps.
 */
export function applyManualGridOverride(song, { tapBpm = null, nudgeBeats = 0, nudgeMs = 0, bpmMultiplier = 1 } = {}) {
  const a = normalizeSongAnalysis(song);
  const dur = Math.max(12, Number(a.duration_sec) || 180);
  const prevBpm = a.bpm || 120;
  let newBpm = tapBpm ? Number(tapBpm) : prevBpm * (Number(bpmMultiplier) || 1);
  newBpm = Math.round(Math.max(55, Math.min(210, newBpm)) * 10) / 10;

  const beatSec = 60 / newBpm;
  const barSec = beatSec * 4;
  const prevBeatSec = 60 / prevBpm;
  const curAnchor = a.downbeat_times?.[0] ?? a.bars?.[0]?.start_sec ?? 0;
  const newAnchor = Math.max(0, Math.min(dur * 0.45, Math.round((curAnchor + nudgeBeats * prevBeatSec + nudgeMs / 1000) * 1000) / 1000));

  const beats = [];
  for (let t = newAnchor; t < dur - 0.1; t += beatSec) beats.push(Math.round(t * 1000) / 1000);
  const downbeats = [];
  const bars = [];
  for (let t = newAnchor; t < dur - 0.35; t += barSec) {
    const start_sec = Math.round(t * 1000) / 1000;
    const end_sec = Math.round(Math.min(dur, t + barSec) * 1000) / 1000;
    if (end_sec - start_sec >= 0.35) {
      downbeats.push(start_sec);
      bars.push({ bar: bars.length, start_sec, end_sec });
    }
  }
  const barCount = Math.max(1, bars.length);

  const resampleArr = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return bars.map(() => 0.6);
    return bars.map((_, i) => arr[Math.min(arr.length - 1, Math.floor((i / barCount) * arr.length))]);
  };

  const stem_activity = {
    vocals: resampleArr(a.stem_activity?.vocals),
    drums: resampleArr(a.stem_activity?.drums),
    bass: resampleArr(a.stem_activity?.bass),
    other: resampleArr(a.stem_activity?.other),
    drum_density: resampleArr(a.stem_activity?.drums),
    bass_presence: resampleArr(a.stem_activity?.bass),
  };

  const sections = (a.sections || []).map((s) => ({
    ...s,
    start_bar: Math.max(0, Math.min(barCount - 1, Math.round(Math.max(0, (s.start_sec || 0) - newAnchor) / barSec))),
    end_bar: Math.max(1, Math.min(barCount, Math.round(Math.max(barSec, (s.end_sec || dur) - newAnchor) / barSec))),
  }));

  const phrase_boundaries = bars
    .filter((_, i) => i % 8 === 0)
    .map((b) => ({ bar: b.bar, sec: b.start_sec, multiple: b.bar % 32 === 0 ? 32 : b.bar % 16 === 0 ? 16 : 8 }));

  return {
    ...a,
    bpm: newBpm,
    bpm_confidence: 0.96,
    bpmConfidence: 0.96,
    downbeat_confidence: 0.95,
    beat_times: beats,
    beats,
    downbeat_times: downbeats,
    downbeats,
    bar_count: barCount,
    bars,
    phrase_boundaries,
    sections,
    energy_per_bar: resampleArr(a.energy_per_bar),
    stem_activity,
    warnings: (a.warnings || []).filter((w) => w !== 'no_clear_beat' && w !== 'low_confidence'),
    manualOverride: { bpm: newBpm, anchorSec: newAnchor },
    clubEntry: downbeats[0] ?? 0,
    clubExit: Math.max((downbeats[0] ?? 0) + barSec * 4, Math.round((dur - Math.min(28, barSec * 8)) * 100) / 100),
  };
}
