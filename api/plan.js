import { handlePreflight, readJsonBody, sendJson } from './_lib/http.js';
import { updateTrackCue } from './_lib/db.js';
import { extractRequestKeys } from './_lib/env.js';
import { invokeAiRole } from './_lib/llm-router.js';
import {
  GENRE_PLAYBOOKS,
  TRANSITION_TYPES,
  buildCueCard,
  generateCreativeIdeas,
  planSetHeuristic,
  repairOrFallbackRecipe,
  scorePairCandidates,
  validateSetPlan,
} from '../public/js/engine/dj-brain.js';

const PLANNER_SYSTEM_PROMPT = `You are NOVA's DJ brain: a principal club and festival DJ, remixer and mashup producer with deep mastery of Indian film music, Punjabi, Hindi pop, Tamil and Telugu cinema, hip-hop, house, techno and global pop (following DJustify arXiv Oct 2026, Vande Veire & De Bie, and Mosaikbox ISMIR 2024 principles).

You receive:
1. USER_BRIEF: mood, crowd, energy arc, playMode, moodEnergy (0-100).
2. SONGS: array of compact song JSONs (song_id, title, artist, bpm, key_camelot, bar_count, sections, stem_activity summary, instrumental_gaps, short lyrics + theme/do_not_cut_ranges, tags, warnings).
3. CANDIDATES: for each adjacent pair:
   - cue_card_out: precomputed shortlist of phrase ends, section boundaries, post-vocal phrase ends & bass dropouts.
   - cue_card_in: precomputed shortlist of harmonic restarts, chorus/drop onsets, verse entries & bass onsets.
   - top_5_candidates: mix points already scored by S = 0.25*T + 0.20*K + 0.15*E + 0.15*P + 0.15*V + 0.10*G - R.
4. RATINGS: optional few-shot good/bad transition feedback examples from past sets.

PRINCIPLES & CREATIVITY ENGINE:
- MENU-BASED PLANNING (CUE CARDS): For each track pair, pick cue-out and cue-in bars strictly from the precomputed CUE CARDS. Never invent arbitrary cut points off phrase.
- TIGHT TEMPO RULE: Long phrase blends (long_blend) strictly restricted to within +-3.2 BPM. For bigger jumps, use echo_out, power-down/tape stop, drum_loop_bridge, or breakdown/drop slam.
- VOCAL INTEGRITY RULE: Never cut a sung phrase mid-line. Always respect 'do_not_cut_ranges'.
- SINGLE BASSLINE & SINGLE TREBLE: Only one track's low EQ (<= -24dB) and high EQ audible at any moment during crossfade (Vande Veire & De Bie EQ pattern).
- STATE MACHINE VARIETY: Do not repeat the same transition family (rolling, relaxed, double_drop) consecutively.
- LYRIC MEANING AT SET LEVEL: Weight lyric themes at set level for the overall emotional narrative arc and hook placement (Mosaikbox ISMIR 2024).
- For EACH adjacent pair, write 3 distinct candidate creative ideas, score each for surprise, smoothness, and crowd_energy, put them in "creative_candidates", and execute the BEST idea ("ONE strong idea per transition — never pile five tricks into one").
- Warnings Rule: tracks with no_clear_beat or variable_tempo get SAFE transitions ONLY (echo_out, reverb_wash, filter_sweep, impact_cut, spinback).
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
    "creative_idea": "short summary of chosen transition idea",
    "creative_candidates": [{"idea": "...", "type": "bass_swap_blend", "surprise": 0.7, "smoothness": 0.9, "crowd_energy": 0.85, "total": 0.82}],
    "why": "plain english rationale referencing beat, key, energy or lyric hook",
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
    sections: a.sections.slice(0, 10),
    instrumental_gaps: a.instrumental_gaps.slice(0, 5),
    lyrics: (a.lyrics || []).slice(0, 8),
    lyric_understanding: a.lyric_understanding
      ? {
          language: a.lyric_understanding.language,
          theme: a.lyric_understanding.theme,
          mood: a.lyric_understanding.mood,
          hook_line: a.lyric_understanding.hook_line,
          explicit_flag: Boolean(a.lyric_understanding.explicit_flag),
          do_not_cut_ranges: (a.lyric_understanding.do_not_cut_ranges || []).slice(0, 4),
        }
      : null,
    tags: a.tags,
    warnings: a.warnings,
    vocal_avg: Math.round((a.stem_activity.vocals.reduce((x, y) => x + y, 0) / Math.max(1, a.bar_count)) * 100) / 100,
    drums_avg: Math.round((a.stem_activity.drums.reduce((x, y) => x + y, 0) / Math.max(1, a.bar_count)) * 100) / 100,
  };
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  let body;
  try {
    body = await readJsonBody(req, 1.5 * 1024 * 1024);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err?.message || 'Invalid JSON body' });
  }

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
  const moodEnergy = Number.isFinite(Number(brief.moodEnergy)) ? Number(brief.moodEnergy) : null;
  const fewShotExamples = Array.isArray(body?.fewShotExamples) ? body.fewShotExamples.slice(0, 6) : [];

  const heuristicPlan = planSetHeuristic(rawSongs, {
    vibe: brief.vibe || 'peak',
    playMode: brief.playMode || 'club',
    moodEnergy,
  });

  const songsMap = {};
  for (const a of heuristicPlan.analyses) songsMap[a.song_id] = a;

  const keys = extractRequestKeys(req);
  if (!keys.anthropic && !keys.gemini && !keys.openai) {
    return sendJson(res, 200, {
      ok: true,
      aiUsed: false,
      opusUsed: false,
      provider: 'deterministic-tsp',
      retryCount: 0,
      plan: heuristicPlan,
    });
  }

  const compactSongs = heuristicPlan.analyses.map(compactSongForPrompt);
  const candidatePairs = [];
  for (let i = 0; i < heuristicPlan.analyses.length - 1; i++) {
    const a = heuristicPlan.analyses[i];
    const b = heuristicPlan.analyses[i + 1];
    candidatePairs.push({
      from: a.song_id,
      to: b.song_id,
      cue_card_out: buildCueCard(a, 'out', brief.playMode),
      cue_card_in: buildCueCard(b, 'in', brief.playMode),
      top_5_candidates: scorePairCandidates(a, b, { arc: brief.vibe, playMode: brief.playMode, moodEnergy }).candidates,
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
  let aiUsed = false;
  let providerUsed = 'deterministic-tsp';
  let modelUsed = null;
  let retryCount = 0;
  let aiError = null;
  const plannerTrace = [];

  try {
    const firstCall = await invokeAiRole({
      role: 'PLANNER',
      req,
      temperature: 0.6,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt: JSON.stringify(promptPayload),
    });
    plannerTrace.push(...(firstCall.trace || []));

    if (firstCall.ok && firstCall.data) {
      let planJson = firstCall.data;
      providerUsed = firstCall.provider;
      modelUsed = firstCall.model;

      let validation = validateSetPlan(planJson, songsMap);
      if (!validation.valid) {
        retryCount = 1;
        const retryCall = await invokeAiRole({
          role: 'PLANNER',
          req,
          temperature: 0.6,
          systemPrompt: PLANNER_SYSTEM_PROMPT,
          preferredProviders: [providerUsed],
          userPrompt: `${JSON.stringify(promptPayload)}\n\nPREVIOUS OUTPUT FAILED DETERMINISTIC VALIDATION:\n${validation.errors.join('\n')}\nFix EVERY validation error strictly and return ONLY corrected JSON.`,
        });
        plannerTrace.push(...(retryCall.trace || []));
        if (retryCall.ok && retryCall.data) {
          planJson = retryCall.data;
          validation = validateSetPlan(planJson, songsMap);
        }
      }

      const cleanTransitions = (planJson.transitions || []).map((rec) => {
        const a = songsMap[rec.from];
        const b = songsMap[rec.to];
        if (!a || !b) return rec;
        const v = validateSetPlan({ transitions: [rec] }, songsMap);
        const { candidates } = scorePairCandidates(a, b, { arc: brief.vibe, playMode: brief.playMode, moodEnergy });
        if (!v.valid) {
          const rep = repairOrFallbackRecipe(a, b, brief.vibe, brief.playMode);
          rep.fallbackUsed = true;
          rep.validatorErrorsFixed = v.errors;
          return rep;
        }
        return {
          ...rec,
          creative_candidates: Array.isArray(rec.creative_candidates) && rec.creative_candidates.length
            ? rec.creative_candidates
            : generateCreativeIdeas(a, b, candidates[0] || {}),
          validation: v,
          compatibility: candidates[0] || heuristicPlan.transitions[0]?.compatibility,
          candidates,
        };
      });

      finalPlan = {
        ...heuristicPlan,
        set_title: planJson.set_title || heuristicPlan.set_title,
        order: Array.isArray(planJson.order) && planJson.order.length ? planJson.order : heuristicPlan.order,
        master_bpm_curve: planJson.master_bpm_curve || heuristicPlan.master_bpm_curve,
        energy_plan: planJson.energy_plan || heuristicPlan.energy_plan,
        transitions: cleanTransitions.length ? cleanTransitions : heuristicPlan.transitions,
        plannerSource: `${providerUsed.toUpperCase()} (${modelUsed}) + Rule Validator`,
      };
      finalPlan.validation = validateSetPlan(finalPlan, songsMap);
      aiUsed = true;
    } else {
      aiError = plannerTrace.map((t) => `${t.provider}: ${t.error || 'skipped'}`).join(' | ');
    }
  } catch (err) {
    aiError = err?.message || 'AI Planner call fell back to deterministic engine';
    finalPlan = heuristicPlan;
  }

  return sendJson(res, 200, {
    ok: true,
    aiUsed,
    opusUsed: providerUsed === 'anthropic',
    provider: providerUsed,
    model: modelUsed,
    retryCount,
    plannerTrace,
    ...(aiError ? { aiFallbackReason: aiError } : {}),
    plan: finalPlan,
  });
}
