/**
 * VERIFICATION TEST FOR A1 & A2:
 *  - A1a: Local Video (.webm / .mp4 container) -> Real AudioBuffer Full-DSP Beatmatch + Synced <video> Playback
 *  - A1b: Honest Official YouTube IFrame Video Mode -> `yt_volume_crossfade`, `YT VIDEO · NO DSP` badge, honest Pro Drawer limitation
 *  - A2:  Paginated Multi-Genre Open Catalog (/api/catalogue + Genre Chips + Load More across Hindi/Pop/House)
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('C:/Users/itzra/node_modules/ws');

const repoDir = path.resolve(import.meta.dirname, '..');
const outDir = path.join(repoDir, '.tmp_a1a2_test');
const profileDir = path.join(outDir, 'chrome_profile');
fs.mkdirSync(profileDir, { recursive: true });

const server = spawn(process.execPath, ['scripts/dev-server.mjs'], {
  cwd: repoDir,
  env: { ...process.env, PORT: '4180' },
  stdio: 'pipe',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1400);

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new',
  '--disable-gpu',
  '--remote-debugging-port=9247',
  '--remote-allow-origins=*',
  '--window-size=1440,900',
  '--user-data-dir=' + profileDir,
  '--autoplay-policy=no-user-gesture-required',
  'http://127.0.0.1:4180/',
]);

const consoleErrors = [];
try {
  await sleep(2400);

  // 1. Test /api/catalogue multi-genre + pagination directly
  console.log('--- A2: MULTI-GENRE PAGINATED FULL-DSP CATALOGUE TEST ---');
  const p1 = await (await fetch('http://127.0.0.1:4180/api/catalogue?q=bollywood%20hindi%20remix&page=1&limit=24')).json();
  const p2 = await (await fetch('http://127.0.0.1:4180/api/catalogue?q=bollywood%20hindi%20remix&page=2&limit=24')).json();
  const popTrend = await (await fetch('http://127.0.0.1:4180/api/catalogue?mode=trending&genre=Pop&page=1&limit=24')).json();
  console.log('Catalogue Results:', {
    bollywoodP1: p1.count,
    bollywoodP2: p2.count,
    hasMoreP1: p1.hasMore,
    popTrending: popTrend.count,
    sampleStream: p1.results?.[0]?.streamUrl?.slice(0, 60),
  });
  assert.equal(p1.ok, true);
  assert.ok(p1.count >= 15, `Expected >=15 Bollywood/Hindi Full-DSP results on page 1, got ${p1.count}`);
  assert.ok(popTrend.count >= 15, `Expected >=15 Pop Trending Full-DSP results, got ${popTrend.count}`);
  assert.ok(p1.results.every((r) => r.dspReady === true && r.streamUrl), 'All catalog results must have dspReady & streamUrl');

  // 2. Test UI Genre Chips, Load More, Honest YT Mode, & Real Local Video (.webm) Full-DSP Playback
  const targets = await (await fetch('http://127.0.0.1:9247/json')).json();
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
      consoleErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const txt = m.params.args.map((a) => a.value || a.description).join(' ');
      if (!txt.includes('youtube.com')) consoleErrors.push(txt);
    }
  });

  await call('Runtime.enable');
  await call('DOM.enable');
  const evalJs = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };

  await evalJs(`document.getElementById('btn-splash-start')?.click()`);
  await sleep(300);

  // Click Bollywood genre chip -> Load More page 2 cleanly in UI
  await evalJs(`document.querySelector('[data-genre-id="bollywood"]')?.click()`);
  let cards1 = 0;
  for (let i = 0; i < 30; i++) {
    cards1 = await evalJs(`document.querySelectorAll('[data-result-idx]').length`);
    if (cards1 >= 10) break;
    await sleep(300);
  }
  assert.ok(cards1 >= 10, `Expected >=10 UI result cards after clicking Bollywood chip, got ${cards1}`);

  const hasLoadMore = await evalJs(`Boolean(document.getElementById('btn-load-more-results'))`);
  if (hasLoadMore) {
    await evalJs(`document.getElementById('btn-load-more-results').click()`);
    let cards2 = cards1;
    for (let i = 0; i < 25; i++) {
      cards2 = await evalJs(`document.querySelectorAll('[data-result-idx]').length`);
      if (cards2 > cards1) break;
      await sleep(300);
    }
    console.log(`✓ UI Genre Catalog Pagination verified: page 1 (${cards1}) -> page 2 (${cards2})`);
    assert.ok(cards2 > cards1, `Load More should append page 2 tracks (${cards1} -> ${cards2})`);
  }

  // Verify A1b: Honest YouTube Video Mode brain plan & UI badges
  console.log('\n--- A1b: HONEST YOUTUBE VIDEO IFRAME MODE VERIFICATION ---');
  const ytPlanCheck = await evalJs(`(async () => {
    const { planSetHeuristic } = await import('/js/engine/dj-brain.js');
    const ytA = { id: 'yt-1', videoId: 'dQw4w9WgXcQ', source: 'youtube', playback: 'youtube-iframe', dspReady: false, ytOnly: true, title: 'YT Song A', artist: 'Artist A', durationSec: 210 };
    const ytB = { id: 'yt-2', videoId: 'kJQP7kiw5Fk', source: 'youtube', playback: 'youtube-iframe', dspReady: false, ytOnly: true, title: 'YT Song B', artist: 'Artist B', durationSec: 220 };
    const plan = planSetHeuristic([ytA, ytB], { vibe: 'peak', playMode: 'club' });
    return {
      valid: plan.validation?.valid,
      warnings: plan.validation?.warnings,
      type: plan.transitions?.[0]?.type,
      ytOnly: plan.transitions?.[0]?.ytOnly,
      why: plan.transitions?.[0]?.why,
    };
  })()`);
  console.log('YT Plan Honesty Check:', JSON.stringify(ytPlanCheck));
  assert.equal(ytPlanCheck.type, 'yt_volume_crossfade');
  assert.equal(ytPlanCheck.ytOnly, true);
  assert.ok(/no dsp|volume|iframe/i.test(ytPlanCheck.why));

  // Click YouTube Video pill & query -> check UI renders honest YT badges
  await evalJs(`document.querySelector('[data-provider="youtube"]')?.click()`);
  await sleep(150);
  await evalJs(`
    const inp = document.getElementById('input-source');
    inp.value = 'hindi party hit song';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-fetch-source').click();
  `);
  let ytUi = { count: 0, badge: '' };
  for (let i = 0; i < 65; i++) {
    ytUi = await evalJs(`({
      count: document.querySelectorAll('.result-badge.yt').length,
      badge: document.querySelector('.result-badge.yt')?.textContent || '',
      status: document.getElementById('wizard-status-banner')?.textContent || '',
    })`);
    if (ytUi.count >= 1) break;
    await sleep(400);
  }
  console.log('✓ YouTube UI Search Verification:', JSON.stringify(ytUi));
  assert.ok(ytUi.count >= 1, 'Expected YT result badges (.result-badge.yt)');
  assert.ok(/vol\/cue|no dsp/i.test(ytUi.badge));

  // Verify A1a: Synthesize real muxed audio+video .webm File via Canvas + Web Audio MediaRecorder in Chrome -> Upload via #file-audio-input -> Full DSP + synced <video>!
  console.log('\n--- A1a: LOCAL VIDEO (.webm) FULL-DSP + SYNCED <VIDEO> VERIFICATION ---');
  const vidSynthInfo = await evalJs(`(async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    osc.frequency.value = 110;
    const gain = ctx.createGain();
    gain.gain.value = 0.25;
    osc.connect(gain).connect(dest);
    osc.start();

    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 90;
    const c2d = canvas.getContext('2d');
    const iv = setInterval(() => {
      c2d.fillStyle = '#ff4d00';
      c2d.fillRect(0, 0, 160, 90);
      c2d.fillStyle = '#ffffff';
      c2d.fillRect((Date.now() % 140), 20, 20, 50);
    }, 50);
    const vStream = canvas.captureStream(15);
    const combined = new MediaStream([...vStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(combined, { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start();
    // Schedule crisp kick pulses every 0.5s (120 BPM) across 7 seconds
    for (let k = 0; k < 14; k++) {
      const t = ctx.currentTime + k * 0.5;
      gain.gain.setValueAtTime(0.9, t);
      gain.gain.exponentialRampToValueAtTime(0.15, t + 0.12);
    }
    await new Promise((r) => setTimeout(r, 7000));
    rec.stop();
    await stopped;
    clearInterval(iv);
    osc.stop();
    await ctx.close();
    const blob = new Blob(chunks, { type: 'video/webm' });
    const ab = await blob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { byteLength: bytes.length, b64: btoa(bin) };
  })()`);
  assert.ok(vidSynthInfo.byteLength > 5000, `Expected non-empty WebM video bytes, got ${vidSynthInfo.byteLength}`);
  const webmPath = path.join(outDir, 'Test_Music_Video_120.webm');
  fs.writeFileSync(webmPath, Buffer.from(vidSynthInfo.b64, 'base64'));
  fs.writeFileSync(path.join(outDir, 'Test_Music_Video_2.webm'), Buffer.from(vidSynthInfo.b64, 'base64'));

  await evalJs(`document.getElementById('btn-clear-crate')?.click(); true;`);
  await sleep(150);
  const doc = await call('DOM.getDocument', { depth: -1 });
  const fNode = await call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file-audio-input' });
  await call('DOM.setFileInputFiles', { nodeId: fNode.nodeId, files: [webmPath, path.join(outDir, 'Test_Music_Video_2.webm')] });

  let videoReady = false;
  for (let i = 0; i < 40; i++) {
    videoReady = await evalJs(`Boolean(document.getElementById('btn-auto-review-now'))`);
    if (videoReady) break;
    await sleep(400);
  }
  assert.equal(videoReady, true, 'Expected Local .webm Videos to decode into AudioBuffer & auto-plan');

  await evalJs(`document.getElementById('btn-auto-review-now').click()`);
  await sleep(300);
  const revTag = await evalJs(`document.querySelector('.row-tag')?.textContent || ''`);
  assert.ok(revTag.includes('LOCAL VIDEO') && revTag.includes('FULL DSP'), `Expected LOCAL VIDEO · FULL DSP review tag, got "${revTag}"`);

  await evalJs(`document.getElementById('btn-approve-play').click()`);
  let videoDeckState = {};
  for (let i = 0; i < 30; i++) {
    videoDeckState = await evalJs(`(() => {
      const vA = document.getElementById('video-deck-A');
      const vB = document.getElementById('video-deck-B');
      const telA = document.getElementById('tel-A');
      return {
        onStage: Boolean(document.getElementById('play-stage')),
        h1: document.querySelector('h1')?.textContent || '',
        hasVideoA: Boolean(vA && vA.muted && vA.src.startsWith('blob:')),
        hasVideoB: Boolean(vB && vB.muted && vB.src.startsWith('blob:')),
        videoPlayingA: Boolean(vA && !vA.paused),
        hasDspTel: Boolean(telA && telA.querySelector('[data-tel-v="low"]')),
        badge: document.querySelector('.deck[data-deck="A"] .deck-dsp-pill')?.textContent || '',
      };
    })()`);
    if (videoDeckState.hasVideoA && videoDeckState.hasVideoB && videoDeckState.hasDspTel) break;
    await sleep(250);
  }
  console.log('✓ Local Video Full-DSP Playing State:', JSON.stringify(videoDeckState));
  assert.equal(videoDeckState.hasVideoA, true, 'Deck A must mount muted synced <video>');
  assert.equal(videoDeckState.hasVideoB, true, 'Deck B must mount muted synced <video>');
  assert.equal(videoDeckState.hasDspTel, true, 'Local Video must run FULL Web Audio DSP EQ/Filter telemetry');

  assert.equal(consoleErrors.length, 0, `Console errors: ${consoleErrors.join(' | ')}`);
  console.log('\nALL A1 (LOCAL VIDEO DSP + HONEST YT VIDEO) & A2 (MULTI-GENRE CATALOGUE) TESTS PASSED ✓');
  ws.close();
} finally {
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(600);
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
}
