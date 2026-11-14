import assert from 'node:assert/strict';
import {
  TRANSITION_TYPES,
  applyManualGridOverride,
  buildRecipeFromCandidate,
  generateCreativeIdeas,
  normalizeSongAnalysis,
  planSetHeuristic,
  scorePairCandidates,
  validateSetPlan,
  validateTransitionRecipe,
} from '../public/js/engine/dj-brain.js';

// 1. All 19 FINAL PROMPT v2 creative transitions registered
assert.equal(TRANSITION_TYPES.length, 19);
assert.ok(TRANSITION_TYPES.includes('stutter_edit'));
assert.ok(TRANSITION_TYPES.includes('reverse_riser_drop'));
assert.ok(TRANSITION_TYPES.includes('lyric_link'));
assert.ok(TRANSITION_TYPES.includes('key_change_lift'));
assert.ok(TRANSITION_TYPES.includes('hook_over_groove'));

// 2. Half-time / double-time Punjabi (95 BPM) -> House (124 BPM) & Bollywood (126 BPM Cm)
const songA = normalizeSongAnalysis({
  id: 's1',
  title: 'Test House Groove',
  artist: 'Artist One',
  bpm: 124,
  key: 'Am',
  key_camelot: '8A',
  duration_sec: 160,
  lyric_understanding: {
    language: 'en',
    theme: 'nightclub euphoria',
    do_not_cut_ranges: [{ start_sec: 48, end_sec: 56, reason: 'chorus hook' }],
  },
});
const songB = normalizeSongAnalysis({
  id: 's2',
  title: 'Test Punjabi Anthem',
  artist: 'Diljit',
  bpm: 126,
  key: 'Em',
  key_camelot: '9A',
  duration_sec: 160,
});
const songC = normalizeSongAnalysis({
  id: 's3',
  title: 'Double Time Bhangra',
  artist: 'Karan Aujla',
  bpm: 190,
  key: 'Dm',
  key_camelot: '7A',
  duration_sec: 150,
});
const songD = normalizeSongAnalysis({
  id: 's4',
  title: 'Half Time Chill',
  artist: 'PR',
  bpm: 95,
  key: 'Dm',
  key_camelot: '7A',
  duration_sec: 150,
});

const plan = planSetHeuristic([songA, songB, songC, songD], { vibe: 'peak', playMode: 'club', moodEnergy: 80 });
assert.equal(plan.order.length, 4);
assert.equal(plan.transitions.length, 3);
assert.equal(plan.validation.valid, true, `Plan failed validation: ${plan.validation.errors.join('; ')}`);

// 3. Creativity Engine generates 3 candidate ideas scored cleanly
const { candidates } = scorePairCandidates(songA, songB, { arc: 'peak', playMode: 'club' });
const ideas = generateCreativeIdeas(songA, songB, candidates[0]);
assert.equal(ideas.length, 3);
assert.ok(ideas[0].total >= ideas[1].total);

// 4. Deterministic Validator MUST reject deliberately broken recipes!
const badBass = buildRecipeFromCandidate(songA, songB, candidates[0], 'bass_swap_blend');
badBass.eq_automation = [
  { deck: 'A', band: 'low', points: [[0, 0], [8, 0], [16, 0]] },
  { deck: 'B', band: 'low', points: [[0, 0], [8, 0], [16, 0]] },
];
assert.equal(validateTransitionRecipe(badBass, songA, songB).valid, false, 'Must reject double bassline!');

const badStretch = buildRecipeFromCandidate(songA, songB, candidates[0], 'bass_swap_blend');
badStretch.tempo_plan = { stretch_from: 100, stretch_to: 124, pitch_shift_semitones: 0 };
assert.equal(validateTransitionRecipe(badStretch, songA, songB).valid, false, 'Must reject >8.5% tempo stretch!');

const badProtectedCut = buildRecipeFromCandidate(songA, songB, candidates[0], 'bass_swap_blend');
// Force mix_out_bar inside songA's protected range (48..56s -> bar ~26 at 124 BPM)
const protBar = songA.bars.findIndex((b) => b.start_sec >= 50 && b.start_sec <= 54);
assert.ok(protBar > 0);
badProtectedCut.mix_out_bar = protBar;
badProtectedCut.length_bars = 8;
assert.equal(validateTransitionRecipe(badProtectedCut, songA, songB).valid, false, 'Must reject cutting inside do_not_cut_ranges!');

const badClip = buildRecipeFromCandidate(songA, songB, candidates[0], 'bass_swap_blend');
badClip.stem_layers = [
  { song: songA.song_id, stem: 'all', start_bar: 0, end_bar: 16, gain_curve: [[0, 1.0], [16, 1.0]] },
  { song: songB.song_id, stem: 'all', start_bar: 0, end_bar: 16, gain_curve: [[0, 1.0], [16, 1.0]] },
];
assert.equal(validateTransitionRecipe(badClip, songA, songB).valid, false, 'Must reject digital clipping gain sum!');

const keyClashTrack = normalizeSongAnalysis({ id: 'kclash', title: 'Key Clash', bpm: 124, key_camelot: '2A', duration_sec: 160 });
const badKey = buildRecipeFromCandidate(songA, keyClashTrack, { mix_out_bar: 32, mix_in_bar: 0, length_bars: 16, pitch_shift_semitones: 0, bpm_diff_pct: 0, score: 0.5 }, 'vocal_mashup');
assert.equal(validateTransitionRecipe(badKey, songA, keyClashTrack).valid, false, 'Must reject >1 Camelot distance on vocal_mashup!');

// Double-time 95 <-> 190 BPM count as 0% tempo gap
const octRec = scorePairCandidates(songC, songD, { arc: 'peak', playMode: 'club' });
assert.ok(octRec.candidates[0].bpm_diff_pct < 1, 'Half/double time 190 vs 95 must match cleanly');

const setCheck = validateSetPlan({ transitions: plan.transitions }, { s1: songA, s2: songB, s3: songC, s4: songD });
assert.equal(setCheck.valid, true);

// 5. Tap-Tempo & Beat-1 Nudge Calibration Override
const nudged = applyManualGridOverride(songA, { nudgeBeats: 1, nudgeMs: 25 });
assert.ok(nudged.downbeat_times[0] > 0.45 && nudged.downbeat_times[0] < 0.6);
assert.equal(nudged.bar_count, nudged.bars.length);
const tapped = applyManualGridOverride(songC, { bpmMultiplier: 0.5 });
assert.equal(tapped.bpm, 95);
const explicitTap = applyManualGridOverride(songB, { tapBpm: 128.5 });
assert.equal(explicitTap.bpm, 128.5);
assert.equal(explicitTap.bpm_confidence, 0.96);

// 6. Phase 3 Strict Validator Rules: mid-phrase mix-in, late last-seconds exit, low_confidence safe-only, all 13 core types
const REQUIRED_13 = [
  'bass_swap_blend', 'long_blend', 'filter_sweep', 'echo_out', 'reverb_wash',
  'drum_loop_bridge', 'loop_roll_drop', 'build_up_drop', 'vocal_mashup',
  'acapella_in', 'instrumental_in', 'half_time_switch', 'impact_cut',
];
for (const reqT of REQUIRED_13) {
  assert.ok(TRANSITION_TYPES.includes(reqT), `Missing required transition type: ${reqT}`);
}

const badMidPhraseIn = buildRecipeFromCandidate(songA, songB, candidates[0], 'bass_swap_blend');
badMidPhraseIn.mix_in_bar = 3;
assert.equal(validateTransitionRecipe(badMidPhraseIn, songA, songB).valid, false, 'Must reject mid-phrase mix_in_bar=3!');

const badLateOut = buildRecipeFromCandidate(songA, songB, candidates[0], 'bass_swap_blend');
badLateOut.mix_out_bar = songA.bar_count - 8;
badLateOut.length_bars = 8;
assert.equal(validateTransitionRecipe(badLateOut, songA, songB).valid, false, 'Must reject leaving in final 8 bars!');

const lowConfSong = normalizeSongAnalysis({
  id: 'lowc', title: 'Drifting Live', bpm: 112, duration_sec: 150,
  safe_transitions_only: true, warnings: ['low_confidence'],
});
const badLowConf = buildRecipeFromCandidate(lowConfSong, songB, { mix_out_bar: 32, mix_in_bar: 0, length_bars: 16, pitch_shift_semitones: 0, bpm_diff_pct: 5, score: 0.6 }, 'vocal_mashup');
assert.equal(validateTransitionRecipe(badLowConf, lowConfSong, songB).valid, false, 'Must reject layered mashup on safe_transitions_only track!');

const { candidates: repairedCheck } = scorePairCandidates(songA, songB, { arc: 'peak', playMode: 'club' });
assert.ok(songA.bar_count - repairedCheck[0].mix_out_bar >= 16, `mix_out_bar ${repairedCheck[0].mix_out_bar} should leave >= 16 bars before end (bar_count=${songA.bar_count})`);

console.log('ALL V2/V3 BRAIN, CREATIVITY & STRICT VALIDATOR UNIT TESTS PASSED ✓');
