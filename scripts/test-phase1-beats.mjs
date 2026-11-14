/**
 * PHASE 1 ACCEPTANCE TEST SUITE (Real Browser Essentia WASM + Spectral DP Dual-Tracker + Click-Track Verification)
 * Generates 10 realistic multi-genre WAV tracks (5 Indian + 5 English/Club, ~32s each),
 * runs NOVA's actual Web Worker & ProMixerEngine in headless Chrome, renders click-track overlays,
 * measures full-song beat-to-click drift in ms, verifies Song 05 fails into `low_confidence` + `safe_transitions_only`,
 * verifies SHA-256 content-hash caching, and checks Debug Studio rendering + Source Choice 1 YouTube blocking.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('C:/Users/itzra/node_modules/ws');

const repoDir = path.resolve(import.meta.dirname, '..');
const outDir = path.join(repoDir, '.tmp_phase1_test');
const profileDir = path.join(outDir, 'chrome_profile');
fs.mkdirSync(profileDir, { recursive: true });

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

function addKick(buf, tSec, sr, amp = 0.78) {
  const start = Math.floor(tSec * sr);
  const len = Math.floor(0.24 * sr);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const dt = i / sr;
    const freq = 52 + 115 * Math.exp(-dt * 36);
    const body = Math.sin(2 * Math.PI * freq * dt) * Math.exp(-dt * 14);
    const click = Math.sin(2 * Math.PI * 1900 * dt) * Math.exp(-dt * 120) * 0.25;
    buf[start + i] += amp * (body + click);
  }
}

function addSnare(bufL, bufR, tSec, sr, amp = 0.48, dhol = false) {
  const start = Math.floor(tSec * sr);
  const len = Math.floor(0.16 * sr);
  let seed = (Math.floor(tSec * 1000) * 1103515245 + 12345) >>> 0;
  for (let i = 0; i < len && start + i < bufL.length; i++) {
    const dt = i / sr;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = ((seed / 0xffffffff) * 2 - 1) * Math.exp(-dt * 26);
    const tone = Math.sin(2 * Math.PI * (dhol ? 220 : 185) * dt) * Math.exp(-dt * 22);
    const v = amp * (tone * 0.6 + noise * 0.5);
    bufL[start + i] += v;
    bufR[start + i] += v * 0.92;
  }
}

function addHat(bufL, bufR, tSec, sr, amp = 0.16) {
  const start = Math.floor(tSec * sr);
  const len = Math.floor(0.045 * sr);
  let seed = (Math.floor(tSec * 10000) * 2654435761) >>> 0;
  for (let i = 0; i < len && start + i < bufL.length; i++) {
    const dt = i / sr;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const prev = ((seed >>> 16) / 65535) * 2 - 1;
    const v = amp * prev * Math.exp(-dt * 75);
    bufL[start + i] += v * 0.7;
    bufR[start + i] += v * 1.1;
  }
}

function synthesizeTrackSpec(spec) {
  const sr = 44100;
  const n = Math.floor(spec.durationSec * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const trueBeats = [];

  // Harmonic bed + stereo chord pad in the requested key root Hz
  const fRoot = spec.rootHz || 220;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const isIntroQuiet = spec.alaapIntroSec && t < spec.alaapIntroSec;
    const padGain = isIntroQuiet ? 0.14 : (t < 2.0 ? 0.08 : 0.12);
    const padL = padGain * (0.5 * Math.sin(2 * Math.PI * fRoot * t) + 0.35 * Math.sin(2 * Math.PI * fRoot * 1.189 * t));
    const padR = padGain * (0.5 * Math.sin(2 * Math.PI * fRoot * t + 0.4) + 0.35 * Math.sin(2 * Math.PI * fRoot * 1.498 * t));
    // Center pseudo-vocal formant active mid-song
    const vocalWin = !isIntroQuiet && t > 8 && t < spec.durationSec - 8 ? Math.max(0, Math.sin((t - 8) * 0.55)) : 0;
    const voc = 0.08 * vocalWin * Math.sin(2 * Math.PI * (fRoot * 2) * t);
    L[i] += padL + voc;
    R[i] += padR + voc;
  }

  if (spec.erraticRubato) {
    // Chaotic tempo changes & random beat jitter -> must trigger low_confidence!
    const bpms = [86, 128, 68, 138, 74, 118];
    let t = 0.4;
    let b = 0;
    let seed = 42;
    while (t < spec.durationSec - 0.5) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const jit = (((seed / 0xffffffff) - 0.5) * 0.18); // +-90ms jitter
      const curBpm = bpms[Math.floor(b / 5) % bpms.length];
      trueBeats.push(t);
      if (b % 2 === 0) addKick(L, t, sr, 0.72), addKick(R, t, sr, 0.72);
      else addSnare(L, R, t, sr, 0.55, true);
      t += Math.max(0.28, (60 / curBpm) + jit);
      b++;
    }
  } else {
    const beatDur = 60 / spec.bpm;
    const startT = 0.25;
    let idx = 0;
    for (let t = startT; t < spec.durationSec - 0.4; t += beatDur) {
      trueBeats.push(t);
      const inQuietAlaap = spec.alaapIntroSec && t < spec.alaapIntroSec;
      if (!inQuietAlaap) {
        const beatInBar = idx % 4;
        if (spec.pattern === 'four') {
          addKick(L, t, sr, beatInBar === 0 ? 0.92 : 0.74);
          addKick(R, t, sr, beatInBar === 0 ? 0.92 : 0.74);
          if (beatInBar === 1 || beatInBar === 3) addSnare(L, R, t, sr, 0.42);
          addHat(L, R, t + beatDur * 0.5, sr, 0.18);
        } else if (spec.pattern === 'dhol') {
          if (beatInBar === 0 || beatInBar === 2) addKick(L, t, sr, 0.88), addKick(R, t, sr, 0.88);
          if (beatInBar === 1 || beatInBar === 3) addSnare(L, R, t, sr, 0.52, true);
          if (beatInBar === 0) addSnare(L, R, t + beatDur * 0.75, sr, 0.34, true);
          addHat(L, R, t + beatDur * 0.5, sr, 0.14);
        } else if (spec.pattern === 'halftime_trap') {
          if (beatInBar === 0) addKick(L, t, sr, 0.95), addKick(R, t, sr, 0.95);
          if (beatInBar === 2) addSnare(L, R, t, sr, 0.58);
          addHat(L, R, t, sr, 0.16);
          addHat(L, R, t + beatDur * 0.5, sr, 0.16);
        } else if (spec.pattern === 'dnb') {
          if (beatInBar === 0 || beatInBar === 2) addKick(L, t, sr, 0.85), addKick(R, t, sr, 0.85);
          if (beatInBar === 1 || beatInBar === 3) addSnare(L, R, t, sr, 0.52);
          addHat(L, R, t + beatDur * 0.5, sr, 0.18);
        } else {
          // pop / kuthu
          if (beatInBar === 0 || beatInBar === 2) addKick(L, t, sr, beatInBar === 0 ? 0.92 : 0.78), addKick(R, t, sr, beatInBar === 0 ? 0.92 : 0.78);
          if (beatInBar === 1 || beatInBar === 3) addSnare(L, R, t, sr, 0.46);
          addHat(L, R, t + beatDur * 0.5, sr, 0.14);
        }
      }
      idx++;
    }
  }

  // Soft peak normalize
  let pk = 0.01;
  for (let i = 0; i < n; i++) {
    const m = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (m > pk) pk = m;
  }
  const scale = pk > 0.94 ? 0.94 / pk : 1;
  if (scale !== 1) {
    for (let i = 0; i < n; i++) { L[i] *= scale; R[i] *= scale; }
  }

  const filePath = path.join(outDir, `${spec.id}.wav`);
  fs.writeFileSync(filePath, encodeWav16Stereo(L, R, sr));
  return { ...spec, filePath, trueBeats };
}

const TRACK_SPECS = [
  { id: '01_Indian_Punjabi_Bhangra_96', title: 'Punjabi Bhangra', bpm: 96, durationSec: 32, pattern: 'dhol', rootHz: 220 },
  { id: '02_Indian_Bollywood_Alaap_104', title: 'Bollywood Alaap Intro', bpm: 104, durationSec: 34, pattern: 'dhol', alaapIntroSec: 6.0, rootHz: 246.94, expectFreeIntro: true },
  { id: '03_Indian_Tamil_Mass_132', title: 'Tamil Mass Kuthu', bpm: 132, durationSec: 32, pattern: 'dhol', rootHz: 196 },
  { id: '04_Indian_Desi_HipHop_78', title: 'Desi Hip-Hop', bpm: 78, durationSec: 32, pattern: 'halftime_trap', rootHz: 174.61 },
  { id: '05_Indian_Rubato_Drift_Fail', title: 'Rubato Tempo Drift', bpm: 105, durationSec: 32, erraticRubato: true, expectLowConfidence: true, rootHz: 207.65 },
  { id: '06_English_UK_House_124', title: 'UK House Club', bpm: 124, durationSec: 32, pattern: 'four', rootHz: 220 },
  { id: '07_English_Pop_Anthem_118', title: 'Pop Anthem', bpm: 118, durationSec: 32, pattern: 'pop', rootHz: 261.63 },
  { id: '08_English_Peak_Techno_134', title: 'Peak Techno', bpm: 134, durationSec: 32, pattern: 'four', rootHz: 164.81 },
  { id: '09_English_BoomBap_92', title: 'BoomBap Hip-Hop', bpm: 92, durationSec: 32, pattern: 'pop', rootHz: 196 },
  { id: '10_English_Liquid_DnB_174', title: 'Liquid DnB', bpm: 174, durationSec: 32, pattern: 'dnb', rootHz: 233.08 },
];

console.log('--- PHASE 1: GENERATING 10 MULTI-GENRE TEST TRACKS (5 INDIAN + 5 ENGLISH) ---');
const generated = TRACK_SPECS.map(synthesizeTrackSpec);
console.log(`Generated ${generated.length} stereo WAV test tracks in ${outDir}`);

const server = spawn(process.execPath, ['scripts/dev-server.mjs'], {
  cwd: repoDir,
  env: { ...process.env, PORT: '4176' },
  stdio: 'pipe',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1300);

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new',
  '--disable-gpu',
  '--remote-debugging-port=9243',
  '--remote-allow-origins=*',
  '--window-size=1440,900',
  '--user-data-dir=' + profileDir,
  '--autoplay-policy=no-user-gesture-required',
  'http://127.0.0.1:4176/',
]);

const consoleErrors = [];
try {
  await sleep(2400);
  const targets = await (await fetch('http://127.0.0.1:9243/json')).json();
  const page = targets.find((t) => t.type === 'page');
  assert.ok(page, 'Chrome page target not found');
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
      const ex = m.params.exceptionDetails;
      consoleErrors.push(`${ex?.text || 'exception'}: ${ex?.exception?.description || JSON.stringify(ex)}`);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  await call('Runtime.enable');
  await call('DOM.enable');

  const evalJs = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };

  // Serve generated WAVs via a small static helper or fetch base64 directly into Browser ProMixerEngine!
  console.log('\n--- PHASE 1: TESTING SOURCE CHOICE 1 (YOUTUBE BLOCKING) ---');
  for (let i = 0; i < 40; i++) {
    const ready = await evalJs(`Boolean(document.getElementById('input-source') || document.getElementById('btn-splash-start'))`);
    if (ready) break;
    await sleep(150);
  }
  const snapInit = await evalJs(`({ html: document.body.innerHTML, errCount: ${consoleErrors.length} })`);
  if (!snapInit.html.includes('btn-splash-start') && !snapInit.html.includes('input-source')) {
    throw new Error(`UI failed to boot cleanly: ${snapInit.html.slice(0, 400)} | errors=${consoleErrors.join('; ')}`);
  }
  await evalJs(`
    document.getElementById('btn-splash-start')?.click();
    true;
  `);
  for (let i = 0; i < 20; i++) {
    const hasInp = await evalJs(`Boolean(document.getElementById('input-source'))`);
    if (hasInp) break;
    await sleep(100);
  }
  const ytDspVerdict = await evalJs(`(async () => {
    const { ProMixerEngine } = await import('/js/engine/pro-mixer-engine.js');
    const m = new ProMixerEngine();
    try {
      await m.decodeAndAnalyze({ id: 'yt-1', videoId: 'dQw4w9WgXcQ', source: 'youtube' });
      return { blocked: false, reason: 'unexpected pass' };
    } catch (e) {
      return { blocked: true, reason: e.message };
    }
  })()`);
  console.log('YouTube PCM Block Verdict:', ytDspVerdict.blocked, '->', ytDspVerdict.reason);
  assert.equal(ytDspVerdict.blocked, true, 'ProMixerEngine must explicitly reject decoding YouTube-only tracks');

  console.log('\n--- PHASE 1: ANALYZING ALL 10 SONGS VIA BROWSER DUAL-TRACKER & RENDERING CLICK OVERLAYS ---');
  const results = [];
  for (const song of generated) {
    const wavB64 = fs.readFileSync(song.filePath).toString('base64');
    const trueBeatsJson = JSON.stringify(song.trueBeats);
    const metaJson = JSON.stringify({
      id: song.id,
      title: song.title,
      expectedBpm: song.bpm,
      alaapIntroSec: song.alaapIntroSec || 0,
      erraticRubato: Boolean(song.erraticRubato),
    });

    const out = await evalJs(`(async () => {
      const { ProMixerEngine } = await import('/js/engine/pro-mixer-engine.js');
      if (!window.__p1Mixer) window.__p1Mixer = new ProMixerEngine();
      const mixer = window.__p1Mixer;
      const meta = ${metaJson};
      const trueBeats = ${trueBeatsJson};

      const bin = atob('${wavB64}');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], meta.id + '.wav', { type: 'audio/wav' });

      const rec = await mixer.decodeAndAnalyze({
        id: meta.id,
        title: meta.title,
        artist: 'Phase1 Test',
        file,
        dspReady: true,
      });

      // Verify SHA-256 content-hash cache hit on duplicate track ID with identical audio bytes
      const dupRec = await mixer.decodeAndAnalyze({
        id: 'dup-' + meta.id,
        title: meta.title + ' Copy',
        artist: 'Phase1 Test',
        file,
        dspReady: true,
      });

      // Render sample-accurate OfflineAudioContext click overlay on detected beats
      const overlay = await mixer.renderClickOverlayBuffer(rec);
      const clickTimes = overlay.clickTimestamps.map(c => c.t);

      // Verify Beat-to-Click full-song accuracy across active rhythmic beats
      const startActive = meta.alaapIntroSec ? meta.alaapIntroSec + 0.5 : 0.8;
      const endActive = (rec.analysis.duration_sec || 32) - 1.0;
      const activeTruth = trueBeats.filter(t => t >= startActive && t <= endActive);
      const errsMs = [];
      for (const gt of activeTruth) {
        let minD = Infinity;
        for (const ct of clickTimes) {
          const d = Math.abs(ct - gt);
          if (d < minD) minD = d;
        }
        errsMs.push(minD * 1000);
      }
      const meanErrMs = errsMs.length ? Math.round((errsMs.reduce((a, b) => a + b, 0) / errsMs.length) * 10) / 10 : 999;
      const maxErrMs = errsMs.length ? Math.round(Math.max(...errsMs) * 10) / 10 : 999;
      const within25Pct = errsMs.length ? Math.round((errsMs.filter(e => e <= 25).length / errsMs.length) * 1000) / 10 : 0;

      return {
        id: meta.id,
        bpm: rec.analysis.bpm,
        expectedBpm: meta.expectedBpm,
        bpmConf: rec.analysis.bpm_confidence,
        downConf: rec.analysis.downbeat_confidence,
        driftPct: rec.analysis.tempo_stability?.drift_pct,
        spreadPct: rec.analysis.tempo_stability?.spread_pct,
        beatsCount: clickTimes.length,
        downbeatsCount: (rec.analysis.downbeat_times || []).length,
        keyCamelot: rec.analysis.key_camelot,
        barCount: rec.analysis.bar_count,
        sectionsCount: (rec.analysis.sections || []).length,
        stemsAvailable: rec.analysis.stems_available,
        stemMode: rec.analysis.stem_mode,
        contentHash: rec.analysis.content_hash,
        firstCached: rec.analysis.cached,
        dupCached: dupRec.analysis.cached,
        dupHashMatch: dupRec.analysis.content_hash === rec.analysis.content_hash,
        lowConfidence: Boolean(rec.analysis.low_confidence),
        safeTransitionsOnly: Boolean(rec.analysis.safe_transitions_only),
        warnings: rec.analysis.warnings || [],
        comparison: rec.analysis.tracker_comparison,
        meanErrMs,
        maxErrMs,
        within25Pct,
        overlayDurationSec: Math.round(overlay.rendered.duration * 10) / 10,
      };
    })()`);

    results.push(out);
    const octaveErr = Math.min(
      Math.abs(out.bpm - song.bpm) / song.bpm,
      Math.abs(out.bpm * 2 - song.bpm) / song.bpm,
      Math.abs(out.bpm * 0.5 - song.bpm) / song.bpm
    ) * 100;

    console.log(
      `${out.id.padEnd(32)} | BPM:${String(out.bpm).padStart(5)} (exp ${song.bpm}, Δ=${octaveErr.toFixed(1)}%)` +
      ` | Conf:${out.bpmConf} | A:${out.comparison?.method_a?.bpm}(${out.comparison?.method_a?.onset_ratio}) B:${out.comparison?.method_b?.bpm}(${out.comparison?.method_b?.onset_ratio})` +
      ` | Agree:${out.comparison?.agreement_pct}% Spd:${out.spreadPct}% dConf:${out.downConf} | Mean:${out.meanErrMs}ms <=25ms:${out.within25Pct}% | Low:${out.lowConfidence} W:[${out.warnings.join(',')}]`
    );
  }

  for (let i = 0; i < results.length; i++) {
    const out = results[i];
    const song = generated[i];
    const octaveErr = Math.min(
      Math.abs(out.bpm - song.bpm) / song.bpm,
      Math.abs(out.bpm * 2 - song.bpm) / song.bpm,
      Math.abs(out.bpm * 0.5 - song.bpm) / song.bpm
    ) * 100;

    assert.equal(out.dupCached, true, `${out.id} SHA-256 duplicate lookup must hit cache`);
    assert.equal(out.dupHashMatch, true, `${out.id} SHA-256 hash mismatch on duplicate`);
    assert.equal(out.stemsAvailable, false);
    assert.equal(out.stemMode, 'eq-midside-off');
    assert.ok(out.comparison?.method_a && out.comparison?.method_b, `${out.id} must report both beat trackers`);

    if (song.expectLowConfidence) {
      assert.equal(out.lowConfidence, true, `${out.id} MUST be flagged low_confidence`);
      assert.equal(out.safeTransitionsOnly, true, `${out.id} MUST be marked safe_transitions_only`);
      assert.ok(out.warnings.includes('low_confidence'), `${out.id} warnings must include low_confidence`);
    } else {
      assert.equal(out.safeTransitionsOnly, false, `${out.id} steady track wrongly marked safe_transitions_only (warnings=${out.warnings.join(',')})`);
      assert.ok(octaveErr <= 2.5, `${out.id} BPM ${out.bpm} deviated >2.5% from ${song.bpm} (even with 2x/0.5x)`);
      assert.ok(out.meanErrMs <= 14.0, `${out.id} click alignment mean error ${out.meanErrMs}ms > 14ms`);
      assert.ok(out.within25Pct >= 95.0, `${out.id} only ${out.within25Pct}% clicks stayed within 25ms of ground truth`);
      if (song.expectFreeIntro) {
        assert.ok(out.warnings.includes('free_time_intro'), `${out.id} should warn free_time_intro`);
      }
    }
  }

  console.log('\n--- PHASE 1: VERIFYING VISIBLE DEBUG PANEL IN BROWSER UI ---');
  // Drop 3 test WAVs into the actual UI file input to test live UI -> Review -> Debug Studio rendering
  const dropPaths = [generated[0].filePath, generated[4].filePath, generated[5].filePath];
  const doc = await call('DOM.getDocument', { depth: -1 });
  const inpNode = await call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file-audio-input' });
  await call('DOM.setFileInputFiles', { nodeId: inpNode.nodeId, files: dropPaths });
  await sleep(3200);

  const reviewCheck = await evalJs(`(async () => {
    document.getElementById('btn-wiz-next').click();
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('[data-mode="club"]').click();
    document.getElementById('btn-wiz-next').click();
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('[data-vibe="peak"]').click();
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('[data-crowd="medium"]').click();
    await new Promise(r => setTimeout(r, 250));
    document.getElementById('btn-review-debug').click();
    await new Promise(r => setTimeout(r, 250));
    const txt = document.body.innerText;
    const svgs = document.querySelectorAll('#debug-backdrop svg').length;
    const clickBtns = document.querySelectorAll('[data-click-check]').length;
    return {
      svgs,
      clickBtns,
      hasDualTrackerText: txt.includes('DUAL TRACKER:'),
      hasStemsOffText: txt.includes('STEMS: OFF (EQ ISOLATOR)'),
      hasLowConfWarning: txt.includes('LOW CONFIDENCE'),
      hasSafeOnlyText: txt.includes('SAFE-TRANSITIONS ONLY'),
      hasCachedBadge: txt.includes('CACHED ✓') || txt.includes('HASH '),
    };
  })()`);

  console.log('Debug Panel UI Check:', reviewCheck);
  assert.ok(reviewCheck.svgs >= 3, 'Debug panel should draw waveform+beat+downbeat+section SVG per track');
  assert.equal(reviewCheck.clickBtns, 3, 'Each track card must expose ▶ CLICK CHECK button');
  assert.equal(reviewCheck.hasDualTrackerText, true);
  assert.equal(reviewCheck.hasStemsOffText, true);
  assert.equal(reviewCheck.hasLowConfWarning, true);
  assert.equal(reviewCheck.hasSafeOnlyText, true);
  assert.equal(reviewCheck.hasCachedBadge, true);

  assert.equal(consoleErrors.length, 0, `Console errors encountered: ${consoleErrors.join('; ')}`);
  console.log('\nALL PHASE 1 ACCEPTANCE TESTS PASSED (10/10 TRACKS VERIFIED, 0 CONSOLE ERRORS) ✓');
} catch (err) {
  console.error('\nPHASE 1 TEST FAILURE:', err?.stack || err);
  if (consoleErrors.length) console.error('Browser console errors:', consoleErrors);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(600);
  try { fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch {}
}
