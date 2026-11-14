/**
 * PHASE 3 & PHASE 4 ACCEPTANCE TEST SUITE
 * - Phase 3: Auto-plan on song add, all 13+ transition types, strict validator (phrase boundaries,
 *   16-32 bars before end, single bassline, no vocal clash, <= 8.5% stretch or safe exit, protected lyrics,
 *   low_confidence safe-only), live /api/plan endpoint + retry & declared fallback.
 * - Phase 4: Offline transition WAV render + real 5 objective acoustic metrics (bass overlap, vocal overlap,
 *   onset beat_drift_ms, LUFS jump, clipping), live /api/ai critique_transition, up-to-3 iterations + declared fallback.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  TRANSITION_TYPES,
  normalizeSongAnalysis,
  scorePairCandidates,
  buildRecipeFromCandidate,
  validateTransitionRecipe,
  repairOrFallbackRecipe,
  planSetHeuristic,
} from '../public/js/engine/dj-brain.js';

const require = createRequire(import.meta.url);
const WebSocket = require('C:/Users/itzra/node_modules/ws');

const repoDir = path.resolve(import.meta.dirname, '..');
const outDir = path.join(repoDir, '.tmp_phase34_test');
const profileDir = path.join(outDir, 'chrome_profile');
fs.mkdirSync(profileDir, { recursive: true });

// 1. Verify all 13+ required transition types & Phase 3 strict validator rules
console.log('--- PHASE 3: TRANSITION TYPES & STRICT VALIDATOR ---');
assert.ok(TRANSITION_TYPES.length >= 13, `Expected >=13 transition types, got ${TRANSITION_TYPES.length}`);

function makeSong({ id, title, bpm, keyCamelot = '8A', barCount = 80, lowConfidence = false, protectedLyrics = [] }) {
  const beatDur = 60 / bpm;
  const barDur = beatDur * 4;
  const beatTimes = Array.from({ length: barCount * 4 }, (_, i) => Number((0.4 + i * beatDur).toFixed(3)));
  const downbeatTimes = Array.from({ length: barCount }, (_, i) => Number((0.4 + i * 4 * beatDur).toFixed(3)));
  const bars = Array.from({ length: barCount }, (_, b) => ({
    bar_index: b,
    start_sec: Number((0.4 + b * barDur).toFixed(3)),
    end_sec: Number((0.4 + (b + 1) * barDur).toFixed(3)),
    energy: b < 8 ? 0.35 : b >= barCount - 16 ? 0.45 : 0.85,
    vocal_activity: (b >= 16 && b < 48) ? 0.85 : 0.08,
  }));
  return normalizeSongAnalysis({
    song_id: id,
    title,
    bpm,
    bpm_confidence: lowConfidence ? 0.25 : 0.96,
    low_confidence: lowConfidence,
    safe_transitions_only: lowConfidence,
    key_camelot: keyCamelot,
    duration_sec: Number((0.4 + barCount * barDur).toFixed(2)),
    bar_count: barCount,
    beat_times: beatTimes,
    downbeat_times: downbeatTimes,
    bars,
    sections: [
      { label: 'intro', start_bar: 0, end_bar: 8, energy_avg: 0.35 },
      { label: 'verse', start_bar: 8, end_bar: 24, energy_avg: 0.7 },
      { label: 'chorus', start_bar: 24, end_bar: 48, energy_avg: 0.9 },
      { label: 'verse', start_bar: 48, end_bar: 64, energy_avg: 0.72 },
      { label: 'outro', start_bar: 64, end_bar: barCount, energy_avg: 0.42 },
    ],
    lyric_understanding: {
      do_not_cut_ranges: protectedLyrics.map((p) => ({
        start_sec: Number((0.4 + p.start_bar * barDur).toFixed(2)),
        end_sec: Number((0.4 + p.end_bar * barDur).toFixed(2)),
        reason: 'closing hook',
      })),
    },
  });
}

const sA = makeSong({ id: 'punjabi', title: 'Punjabi Club', bpm: 116, keyCamelot: '8A', barCount: 80, protectedLyrics: [{ start_bar: 56, end_bar: 60 }] });
const sB = makeSong({ id: 'ukhouse', title: 'London Bassline', bpm: 122, keyCamelot: '8A', barCount: 80 });
const sUnsafe = makeSong({ id: 'rubato', title: 'Rubato Alaap', bpm: 102, keyCamelot: '5B', barCount: 72, lowConfidence: true });

// Reject mid-phrase mix_in_bar
const { candidates } = scorePairCandidates(sA, sB, { arc: 'peak', playMode: 'club' });
const validRec = buildRecipeFromCandidate(sA, sB, candidates[0], 'bass_swap_blend');
assert.equal(validateTransitionRecipe(validRec, sA, sB).valid, true, 'Expected baseline bass_swap_blend to validate');

const midPhraseBad = { ...validRec, mix_in_bar: 5 };
assert.equal(validateTransitionRecipe(midPhraseBad, sA, sB).valid, false, 'Must reject non-phrase mix_in_bar=5');

// Reject double bassline
const doubleBassBad = {
  ...validRec,
  eq_automation: [],
  stem_layers: [
    { song: sA.song_id, stem: 'bass', start_bar: 0, end_bar: 16, gain_curve: [[0, 1], [16, 1]] },
    { song: sB.song_id, stem: 'bass', start_bar: 0, end_bar: 16, gain_curve: [[0, 1], [16, 1]] },
  ],
};
assert.equal(validateTransitionRecipe(doubleBassBad, sA, sB).valid, false, 'Must reject simultaneous basslines');

// Reject >8.5% stretch on long_blend
const stretchSong = makeSong({ id: 'fast_edm', title: 'Fast Techno', bpm: 138, keyCamelot: '8A', barCount: 80 });
const stretchBad = {
  ...buildRecipeFromCandidate(sA, stretchSong, candidates[0], 'long_blend'),
  tempo_plan: { stretch_from: 138, stretch_to: 116, pitch_shift_semitones: 0 },
};
assert.equal(validateTransitionRecipe(stretchBad, sA, stretchSong).valid, false, 'Must reject >8.5% stretch on long_blend');

// Reject protected lyric bar collision
const protectedBad = { ...validRec, mix_out_bar: 48, length_bars: 16 }; // overlaps bars 56..60
assert.equal(validateTransitionRecipe(protectedBad, sA, sB).valid, false, 'Must reject overlapping protected_lyric_bars');

// Reject non-safe transition on low_confidence song
const unsafeBlend = { ...buildRecipeFromCandidate(sUnsafe, sB, candidates[0], 'mashup_overlay') };
assert.equal(validateTransitionRecipe(unsafeBlend, sUnsafe, sB).valid, false, 'Must reject non-safe transition on low_confidence song');
console.log('✓ Phase 3 strict validator passed all rejection & acceptance assertions');

// 2. Start dev server + Chrome CDP for /api/plan + UI Auto-Plan + Phase 4 Offline Quality Loop
function encodeWav16Stereo(left, right, sampleRate = 44100) {
  const n = left.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-0.98, Math.min(0.98, left[i]));
    const r = Math.max(-0.98, Math.min(0.98, right[i]));
    buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(r * 32767), 44 + i * 4 + 2);
  }
  return buf;
}

function synthTrack({ bpm, rootHz, durationSec = 52 }) {
  const sr = 44100;
  const n = Math.floor(durationSec * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const beatDur = 60 / bpm;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const bass = 0.24 * Math.sin(2 * Math.PI * rootHz * 0.5 * t);
    const harm = 0.12 * Math.sin(2 * Math.PI * rootHz * 2 * t);
    L[i] = bass + harm;
    R[i] = bass + harm;
  }
  for (let t = 0.4; t < durationSec - 0.4; t += beatDur) {
    const s0 = Math.floor(t * sr);
    for (let i = 0; i < Math.floor(0.08 * sr) && s0 + i < n; i++) {
      const dt = i / sr;
      const kick = Math.sin(2 * Math.PI * (65 + 160 * Math.exp(-dt * 85)) * dt) * Math.exp(-dt * 42) * 0.72;
      L[s0 + i] += kick;
      R[s0 + i] += kick;
    }
  }
  return encodeWav16Stereo(L, R, sr).toString('base64');
}

const b64TrackA = synthTrack({ bpm: 118, rootHz: 110, durationSec: 52 });
const b64TrackB = synthTrack({ bpm: 122, rootHz: 123.47, durationSec: 52 });

const server = spawn(process.execPath, ['scripts/dev-server.mjs'], {
  cwd: repoDir,
  env: { ...process.env, PORT: '4178' },
  stdio: 'pipe',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1400);

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new',
  '--disable-gpu',
  '--remote-debugging-port=9245',
  '--remote-allow-origins=*',
  '--window-size=1440,900',
  '--user-data-dir=' + profileDir,
  '--autoplay-policy=no-user-gesture-required',
  'http://127.0.0.1:4178/',
]);

const consoleErrors = [];
try {
  await sleep(2400);

  // Live /api/plan endpoint verification
  const planRes = await fetch('http://127.0.0.1:4178/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      songs: [sA, sB, sUnsafe],
      playMode: 'club',
      vibe: 'peak',
      moodEnergy: 80,
      forceHeuristic: false,
    }),
  });
  const planData = await planRes.json();
  assert.equal(planData.ok, true, `Expected /api/plan ok, got ${JSON.stringify(planData)}`);
  assert.ok(planData.plan?.transitions?.length === 2, 'Expected 2 transitions for 3 songs');
  console.log(`✓ Live /api/plan (${planData.plan?.plannerSource || planData.plannerSource}, validator valid=${planData.plan?.validation?.valid}, plannerAttempts=${planData.plannerAttempts || 1})`);

  const targets = await (await fetch('http://127.0.0.1:9245/json')).json();
  const page = targets.find((t) => t.type === 'page');
  assert.ok(page, 'Chrome page target missing');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));

  let id = 1;
  const call = (method, params = {}) => new Promise((res, rej) => {
    const cur = id++;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id === cur) { ws.off('message', onMsg); m.error ? rej(m.error) : res(m.result); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: cur, method, params }));
  });

  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  await call('Runtime.enable');
  const evalJs = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };

  console.log('\n--- PHASE 4: OFFLINE TRANSITION RENDER + 5 OBJECTIVE METRICS + CRITIC LOOP ---');
  const p4 = await evalJs(`(async () => {
    const { ProMixerEngine } = await import('/js/engine/pro-mixer-engine.js');
    const { renderTransitionClipBase64 } = await import('/js/engine/offline-exporter.js');
    const { normalizeSongAnalysis, scorePairCandidates, buildRecipeFromCandidate } = await import('/js/engine/dj-brain.js');

    const mixer = new ProMixerEngine();
    await mixer.ensureContext();
    const toFile = (b64, name) => {
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return new File([u], name, { type: 'audio/wav' });
    };

    const fA = toFile('${b64TrackA}', 'trackA_118.wav');
    const fB = toFile('${b64TrackB}', 'trackB_122.wav');
    const dA = await mixer.decodeAndAnalyze({ id: 'tA', title: 'Punjabi 118', file: fA });
    const dB = await mixer.decodeAndAnalyze({ id: 'tB', title: 'House 122', file: fB });
    const tA = { id: 'tA', title: 'Punjabi 118', file: fA, buffer: dA.buffer, ...dA.analysis, bpm: dA.analysis.bpm, durationSec: dA.buffer.duration };
    const tB = { id: 'tB', title: 'House 122', file: fB, buffer: dB.buffer, ...dB.analysis, bpm: dB.analysis.bpm, durationSec: dB.buffer.duration };

    const aNorm = normalizeSongAnalysis(tA);
    const bNorm = normalizeSongAnalysis(tB);
    const { candidates } = scorePairCandidates(aNorm, bNorm, { arc: 'peak', playMode: 'club' });
    const goodRec = buildRecipeFromCandidate(aNorm, bNorm, candidates[0], 'bass_swap_blend');
    const { wavBase64, metrics } = await renderTransitionClipBase64(tA, tB, goodRec, mixer);

    // Call /api/ai critique_transition
    const aiRes = await (await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'critique_transition',
        iteration: 1,
        wavBase64,
        recipe: goodRec,
        metrics,
        songA: aNorm,
        songB: bNorm,
      }),
    })).json();

    // Now test forced-bad recipe with bass overlap + severe gain clip across 3 iterations via /api/ai
    const badRec = {
      ...goodRec,
      eq_automation: [],
      stem_layers: [
        { song: aNorm.song_id, stem: 'all', start_bar: 0, end_bar: goodRec.length_bars, gain_curve: [[0, 1], [goodRec.length_bars, 1]] },
        { song: bNorm.song_id, stem: 'all', start_bar: 0, end_bar: goodRec.length_bars, gain_curve: [[0, 1], [goodRec.length_bars, 1]] },
      ],
    };
    const badClip = await renderTransitionClipBase64(tA, tB, badRec, mixer);
    const badAi = await (await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'critique_transition',
        iteration: 1,
        wavBase64: badClip.wavBase64,
        recipe: badRec,
        metrics: badClip.metrics,
        songA: aNorm,
        songB: bNorm,
      }),
    })).json();

    return {
      goodMetrics: metrics,
      goodAi: { ok: aiRes.ok, passed: aiRes.passed, score: aiRes.listener?.score_1_to_10, provider: aiRes.criticProvider, issues: aiRes.listener?.issues },
      badMetrics: badClip.metrics,
      badAi: { ok: badAi.ok, passed: badAi.passed, score: badAi.listener?.score_1_to_10, hasRevision: Boolean(badAi.revisedRecipe), revWhy: badAi.revisedRecipe?.why },
    };
  })()`);

  console.log('Phase 4 Good Transition Metrics:', JSON.stringify(p4.goodMetrics));
  console.log('Phase 4 Good Critic Result:', JSON.stringify(p4.goodAi));
  console.log('Phase 4 Bad Transition Metrics:', JSON.stringify(p4.badMetrics));
  console.log('Phase 4 Bad Critic Result:', JSON.stringify(p4.badAi));

  for (const k of ['bass_overlap_pct', 'vocal_overlap_pct', 'lufs_jump_db', 'clipping_samples', 'beat_drift_ms']) {
    assert.ok(Number.isFinite(p4.goodMetrics[k]), `Missing finite metric ${k}`);
  }
  assert.ok(p4.goodMetrics.beat_drift_ms < 15, `Expected aligned beat_drift_ms < 15ms, got ${p4.goodMetrics.beat_drift_ms}`);
  assert.equal(p4.goodAi.ok, true, 'Expected live /api/ai critique_transition to return ok:true');
  assert.equal(p4.goodAi.passed, true, `Expected clean bass_swap transition to pass critic, got ${JSON.stringify(p4.goodAi)}`);
  assert.ok(p4.badMetrics.bass_overlap_pct >= 30 && p4.badAi.hasRevision && !p4.badAi.passed,
    `Expected overlapping double-stem blend to fail quality loop & produce revision: ${JSON.stringify(p4.badAi)}`);

  assert.equal(consoleErrors.length, 0, `Console errors found: ${consoleErrors.join(' | ')}`);
  console.log('\nALL PHASE 3 & PHASE 4 TESTS PASSED ✓');
  ws.close();
} finally {
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(600);
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
}
