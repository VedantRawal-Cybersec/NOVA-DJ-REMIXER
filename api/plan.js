import { handlePreflight, readJsonBody, sendJson } from './_lib/http.js';
import { updateTrackCue } from './_lib/db.js';
import {
  GENRE_PLAYBOOKS,
  TRANSITION_TYPES,
  normalizeSongAnalysis,
  planSetHeuristic,
  repairOrFallbackRecipe,
  scorePairCandidates,
  validateSetPlan,
} from '../public/js/engine/dj-brain.js';

const OPUS_SYSTEM_PROMPT = `You are NOVA's DJ brain: a world-class club and festival DJ, remixer and mashup producer with deep knowledge of Indian film music, Punjabi, Hindi pop, Tamil and Telugu cinema, hip-hop, house, techno and global pop.

You receive:
1. USER_BRIEF: mood, crowd, energy arc, playMode.
2. SONGS: array of compact song JSONs (song_id, title, artist, bpm, key_camelot, bar_count, sections, energy_per_bar, stem_activity summary, instrumental_gaps, short lyrics, tags, warnings).
3. CANDIDATES: for each adjacent pair, the 5 best mix points already scored by S = 0.25*T + 0.20*K + 0.15*E + 0.15*P + 0.15*V + 0.10*G - R.
4. RATINGS: optional few-shot good/bad transition feedback examples.

PRINCIPLES:
- Transitions start and end on phrase boundaries (8/16/32 bars) and downbeats.
- Leave the outgoing song while it still has energy: 16 to 32 bars before outro ends, not after.
- Enter the new song on a downbeat of an intro, build, or chorus — never mid-phrase.
- NEVER play two lead vocals at once. Use instrumental_gaps or mute/duck outgoing vocals <= 0.18.
- NEVER play two basslines at once. Cut outgoing low EQ <= -24dB before/as incoming bass enters (bass swap).
- Key rule: layering two melodic stems requires shifted Camelot distance 0 or 1 (+-2 semitones max). Otherwise use drums+bass only, filter_sweep, echo_out, or drum_loop_bridge.
- Tempo rule: time-stretch up to 8% (or use half-time / double-time). Larger gaps use echo_out, build_up_drop, or impact_cut.
- Warnings rule: songs with no_clear_beat or variable_tempo get SAFE transitions ONLY (echo_out, reverb_wash, filter_sweep, impact_cut, spinback).
- Only pick transition type from: ${TRANSITION_TYPES.join(', ')}.

OUTPUT STRICT VALID JSON ONLY (NO PROSE, NO MARKDOWN FENCES):
{
  "set_title": "string",
  "order": ["song_id"],
  "master_bpm_curve": [{"at_song": "song_id", "bpm": 124}],
  "energy_plan": "string",
  "transitions": [{
    "from": "song_id",
    "to": "song_id",
    "mix_out_bar": 80,
    "mix_in_bar": 0,
    "length_bars": 16,
    "type": "bass_swap_blend",
    "tempo_plan": {"stretch_from": 126, "stretch_to": 124, "pitch_shift_semitones": 0},
    "stem_layers": [{"song": "song_id", "stem": "vocals", "start_bar": 0, "end_bar": 16, "gain_curve": [[0, 1], [8, 0.1], [16, 0]]}],
    "eq_automation": [{"deck": "A", "band": "low", "points": [[0, 0], [8, -28], [16, -28]]}, {"deck": "B", "band": "low", "points": [[0, -28], [8, 0], [16, 0]]}],
    "filter_automation": [],
    "fx": [],
    "added_drums": null,
    "why": "plain english rationale",
    "risk": "low",
    "fallback": "bass_swap_blend"
  }]
}`;

function compactSongForPrompt(a) {
  return {
    song_id: a.song_id,
    title: a.title,
    artist: a.artist,
    bpm: a.bpm,
    key_camelot: a.key_camelot,
    bar_count: a.bar_count,
    sections: a.sections.slice(0, 12),
    instrumental_gaps: a.instrumental_gaps.slice(0, 6),
    lyrics: (a.lyrics || []).slice(0, 10),
    tags: a.tags,
    warnings: a.warnings,
    vocal_avg: Math.round((a.stem_activity.vocals.reduce((x, y) => x + y, 0) / Math.max(1, a.bar_count)) * 100) / 100,
    drums_avg: Math.round((a.stem_activity.drums.reduce((x, y) => x + y, 0) / Math.max(1, a.bar_count)) * 100) / 100,
  };
}

function extractJsonText(raw) {
  const txt = String(raw || '').trim();
  const fenced = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : txt;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Planner did not return JSON.');
  return JSON.parse(body.slice(start, end + 1));
}

async function callClaudeOpus(apiKey, messages) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-1-20250805';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7200);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 3200,
        temperature: 0.25,
        system: OPUS_SYSTEM_PROMPT,
        messages,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic HTTP ${res.status}: ${errText.slice(0, 160)}`);
    }
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || '').join('\n');
    return extractJsonText(text);
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err?.message || 'Invalid JSON body' });
  }

  // Handle transition rating persistence if submitted here cleanly
  if (body?.action === 'rate_transition') {
    const resDb = await updateTrackCue({
      trackId: body.toSongId || body.fromSongId || 'set-rating',
      sessionId: body.sessionId || 'anon',
      action: 'transition_rating',
      rating: `${body.rating || 'good'}:${body.type || 'blend'}:${body.note || ''}`,
    });
    return sendJson(res, 200, { ok: true, ...resDb });
  }

  const rawSongs = Array.isArray(body?.songs) ? body.songs : [];
  if (!rawSongs.length) {
    return sendJson(res, 400, { ok: false, error: 'songs array is required' });
  }

  const brief = body?.brief || { vibe: 'peak', playMode: 'club', crowd: 'medium' };
  const fewShotExamples = Array.isArray(body?.fewShotExamples) ? body.fewShotExamples.slice(0, 6) : [];

  // Always compute baseline scored plan + candidates first (grounds Opus & guarantees deterministic fallback!)
  const heuristicPlan = planSetHeuristic(rawSongs, {
    vibe: brief.vibe || 'peak',
    playMode: brief.playMode || 'club',
  });

  const songsMap = {};
  for (const a of heuristicPlan.analyses) songsMap[a.song_id] = a;

  const apiKey = String(req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    return sendJson(res, 200, {
      ok: true,
      opusUsed: false,
      retryCount: 0,
      plan: heuristicPlan,
    });
  }

  // Send ordered songs + Top 5 candidates per adjacent pair to Claude Opus
  const compactSongs = heuristicPlan.analyses.map(compactSongForPrompt);
  const candidatePairs = [];
  for (let i = 0; i < heuristicPlan.analyses.length - 1; i++) {
    const a = heuristicPlan.analyses[i];
    const b = heuristicPlan.analyses[i + 1];
    candidatePairs.push({
      from: a.song_id,
      to: b.song_id,
      top_5_candidates: scorePairCandidates(a, b, { arc: brief.vibe, playMode: brief.playMode }).candidates,
    });
  }

  const promptPayload = {
    USER_BRIEF: brief,
    GENRE_PLAYBOOKS,
    SONGS: compactSongs,
    CANDIDATES: candidatePairs,
    RATINGS: fewShotExamples,
  };

  let finalPlan = heuristicPlan;
  let opusUsed = false;
  let retryCount = 0;
  let opusError = null;

  try {
    const messages = [{ role: 'user', content: JSON.stringify(promptPayload) }];
    let opusJson = await callClaudeOpus(apiKey, messages);
    let validation = validateSetPlan(opusJson, songsMap);

    // Phase 3: Retry ONCE with validator error feedback if any rule failed!
    if (!validation.valid) {
      retryCount = 1;
      messages.push({ role: 'assistant', content: JSON.stringify(opusJson) });
      messages.push({
        role: 'user',
        content: `VALIDATOR REJECTED YOUR PLAN:\n${validation.errors.join('\n')}\nFix every error strictly and output ONLY corrected JSON.`,
      });
      opusJson = await callClaudeOpus(apiKey, messages);
      validation = validateSetPlan(opusJson, songsMap);
    }

    // Merge validated Opus recipes (or deterministic safe fallback per invalid pair)
    const cleanTransitions = (opusJson.transitions || []).map((rec) => {
      const a = songsMap[rec.from];
      const b = songsMap[rec.to];
      if (!a || !b) return rec;
      const v = validateSetPlan({ transitions: [rec] }, songsMap);
      if (!v.valid) {
        return repairOrFallbackRecipe(a, b, brief.vibe, brief.playMode);
      }
      const { candidates } = scorePairCandidates(a, b, { arc: brief.vibe, playMode: brief.playMode });
      return {
        ...rec,
        validation: v,
        compatibility: candidates[0] || heuristicPlan.transitions[0]?.compatibility,
        candidates,
      };
    });

    finalPlan = {
      ...heuristicPlan,
      set_title: opusJson.set_title || heuristicPlan.set_title,
      order: Array.isArray(opusJson.order) && opusJson.order.length ? opusJson.order : heuristicPlan.order,
      master_bpm_curve: opusJson.master_bpm_curve || heuristicPlan.master_bpm_curve,
      energy_plan: opusJson.energy_plan || heuristicPlan.energy_plan,
      transitions: cleanTransitions.length ? cleanTransitions : heuristicPlan.transitions,
      plannerSource: 'Claude Opus + Deterministic Validator',
    };
    finalPlan.validation = validateSetPlan(finalPlan, songsMap);
    opusUsed = true;
  } catch (err) {
    opusError = err?.message || 'Claude Opus call skipped';
    finalPlan = heuristicPlan;
  }

  return sendJson(res, 200, {
    ok: true,
    opusUsed,
    retryCount,
    ...(opusError ? { opusFallbackReason: opusError } : {}),
    plan: finalPlan,
  });
}
