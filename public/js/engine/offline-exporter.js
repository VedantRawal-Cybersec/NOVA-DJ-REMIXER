import { loadDrumSamplesForContext, scheduleStudioDrumBridge } from './drum-pack.js';
import { createStemChannelStrip } from './stems-isolator.js';

const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];

function scheduleRecordOnOfflineStrip(offline, rec, strip, { startWhen, offset, playDur, rate = 1 }) {
  const hasNeural = rec.stemBuffers && STEM_NAMES.every((s) => rec.stemBuffers[s]);
  if (hasNeural) {
    strip.setNeuralMode(true, startWhen);
    for (const stem of STEM_NAMES) {
      const sBuf = rec.stemBuffers[stem];
      const src = offline.createBufferSource();
      src.buffer = sBuf;
      src.playbackRate.setValueAtTime(rate, startWhen);
      src.connect(strip.stemInputs[stem]);
      src.start(startWhen, Math.min(sBuf.duration - 0.5, offset), Math.min(sBuf.duration - offset, playDur));
    }
    return;
  }
  const src = offline.createBufferSource();
  src.buffer = rec.buffer;
  src.playbackRate.setValueAtTime(rate, startWhen);
  src.connect(strip.input);
  src.start(startWhen, Math.min(rec.buffer.duration - 0.5, offset), Math.min(rec.buffer.duration - offset, playDur));
}

export function encodeWavBuffer(audioBuffer, { targetSampleRate = null, forceMono = false } = {}) {
  const srcRate = audioBuffer.sampleRate;
  const dstRate = targetSampleRate || srcRate;
  const numChannels = forceMono ? 1 : Math.min(2, audioBuffer.numberOfChannels);
  const ratio = srcRate / dstRate;
  const srcFrames = audioBuffer.length;
  const numFrames = targetSampleRate ? Math.max(1, Math.floor(srcFrames / ratio)) : srcFrames;

  const blockAlign = numChannels * 2;
  const byteRate = dstRate * blockAlign;
  const dataBytes = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, dstRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const idx = targetSampleRate ? Math.min(srcFrames - 1, Math.floor(i * ratio)) : i;
    const s0 = forceMono ? Math.max(-1, Math.min(1, 0.5 * (ch0[idx] + ch1[idx]))) : Math.max(-1, Math.min(1, ch0[idx]));
    view.setInt16(offset, s0 < 0 ? s0 * 0x8000 : s0 * 0x7fff, true);
    offset += 2;
    if (numChannels > 1) {
      const s1 = Math.max(-1, Math.min(1, ch1[idx]));
      view.setInt16(offset, s1 < 0 ? s1 * 0x8000 : s1 * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

export function uint8ToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Extracts a compact 16 kHz mono WAV clip (center channel boost) for fast speech/lyric transcription.
 */
export function extractAudioSliceWavBase64(audioBuffer, startSec = 0, maxDurSec = 38) {
  const sr = audioBuffer.sampleRate;
  const startIdx = Math.max(0, Math.floor(startSec * sr));
  const sliceFrames = Math.min(audioBuffer.length - startIdx, Math.floor(maxDurSec * sr));
  if (sliceFrames < sr * 2) return '';
  const step = Math.max(1, Math.round(sr / 16000));
  const dstSr = Math.round(sr / step);
  const outFrames = Math.floor(sliceFrames / step);
  const dataBytes = outFrames * 2;
  const ab = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(ab);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, dstSr, true); v.setUint32(28, dstSr * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); ws(36, 'data'); v.setUint32(40, dataBytes, true);

  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
  let off = 44;
  for (let i = 0; i < outFrames; i++) {
    const k = startIdx + i * step;
    const mono = Math.max(-1, Math.min(1, 0.5 * (ch0[k] + ch1[k])));
    v.setInt16(off, mono < 0 ? mono * 0x8000 : mono * 0x7fff, true);
    off += 2;
  }
  return uint8ToBase64(new Uint8Array(ab));
}

/**
 * Computes objective DSP quality metrics on a rendered transition clip (Phase 5 verification).
 */
export function computeTransitionObjectiveMetrics(audioBuffer, bpm = 120) {
  const sr = audioBuffer.sampleRate;
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
  const len = ch0.length;

  let clipping_samples = 0;
  for (let i = 0; i < len; i++) {
    if (Math.abs(ch0[i]) >= 0.992 || Math.abs(ch1[i]) >= 0.992) clipping_samples++;
  }

  // First quarter vs last quarter LUFS jump + simple 1-pole lowpass sub-bass / bandpass vocal estimators
  const qLen = Math.max(1, Math.floor(len * 0.25));
  const calcRms = (s, e) => {
    let acc = 0;
    for (let i = s; i < e; i += 2) {
      const m = 0.5 * (ch0[i] + ch1[i]);
      acc += m * m;
    }
    return Math.sqrt(acc / Math.max(1, (e - s) / 2));
  };
  const lufsStart = 20 * Math.log10(Math.max(1e-5, calcRms(0, qLen))) - 0.691;
  const lufsEnd = 20 * Math.log10(Math.max(1e-5, calcRms(len - qLen, len))) - 0.691;
  const lufs_jump_db = Math.round((lufsEnd - lufsStart) * 10) / 10;

  // Compute windowed low (<145 Hz), mud (180-450 Hz), and mid-vocal (400-3400 Hz) energies
  const aLow = Math.exp((-2 * Math.PI * 145) / sr);
  const aMud = Math.exp((-2 * Math.PI * 450) / sr);
  let lp1 = 0, lp2 = 0, lp3 = 0;
  const hop = Math.floor(sr * 0.15);
  const lowVals = [], mudVals = [], vocVals = [];
  let sumLow = 0, sumMud = 0, sumVoc = 0, frameCount = 0;
  let sqTotal = 0, sqLow = 0, sqMud = 0, sqVoc = 0;

  for (let i = 0; i < len; i++) {
    const m = 0.5 * (ch0[i] + ch1[i]);
    lp1 = aLow * lp1 + (1 - aLow) * m;
    lp2 = aMud * lp2 + (1 - aMud) * m;
    lp3 = 0.72 * lp3 + 0.28 * m;
    const mud = lp2 - lp1;
    const voc = lp3 - lp2;
    sqTotal += m * m;
    sqLow += lp1 * lp1;
    sqMud += mud * mud;
    sqVoc += voc * voc;
    if ((i + 1) % hop === 0) {
      const lR = Math.sqrt(sqLow / hop);
      const mR = Math.sqrt(sqMud / hop);
      const vR = Math.sqrt(sqVoc / hop);
      lowVals.push(lR); sumLow += lR;
      mudVals.push(mR); sumMud += mR;
      vocVals.push(vR); sumVoc += vR;
      frameCount++;
      sqLow = 0; sqMud = 0; sqVoc = 0;
    }
  }

  const edgeCount = Math.max(1, Math.floor(frameCount * 0.14));
  const sortedEdgeLow = [...lowVals.slice(0, edgeCount), ...lowVals.slice(Math.max(edgeCount, frameCount - edgeCount))].sort((a, b) => a - b);
  const sortedEdgeVoc = [...vocVals.slice(0, edgeCount), ...vocVals.slice(Math.max(edgeCount, frameCount - edgeCount))].sort((a, b) => a - b);
  const baselineLow = sortedEdgeLow[Math.floor(sortedEdgeLow.length * 0.5)] || (sumLow / Math.max(1, frameCount));
  const baselineVoc = sortedEdgeVoc[Math.floor(sortedEdgeVoc.length * 0.5)] || (sumVoc / Math.max(1, frameCount));
  const midStart = Math.floor(frameCount * 0.18);
  const midEnd = Math.max(midStart + 1, Math.floor(frameCount * 0.82));
  const avgFrameLow = lowVals.reduce((a, b) => a + b, 0) / Math.max(1, frameCount);
  const edgeRmsVals = [...lowVals.slice(0, edgeCount), ...lowVals.slice(Math.max(edgeCount, frameCount - edgeCount))];
  const baselineOverall = Math.max(0.02, Math.sqrt(sqTotal / Math.max(1, len)));

  // Gate 3: Silent gap / energy hole detection across 150ms frames in the transition overlap
  let holeFrames = 0;
  let minFrameDb = 0;
  const frameRmsSq = new Float32Array(frameCount);
  let fIdx = 0, fAcc = 0;
  for (let i = 0; i < len && fIdx < frameCount; i++) {
    const m = 0.5 * (ch0[i] + ch1[i]);
    fAcc += m * m;
    if ((i + 1) % hop === 0) {
      const fRms = Math.sqrt(fAcc / hop);
      frameRmsSq[fIdx] = fRms;
      const dipDb = 20 * Math.log10(Math.max(1e-5, fRms) / baselineOverall);
      if (fIdx >= midStart && fIdx < midEnd) {
        if (dipDb < minFrameDb) minFrameDb = dipDb;
        if (dipDb < -14) holeFrames++;
      }
      fIdx++;
      fAcc = 0;
    }
  }
  const energy_hole_pct = Math.round((holeFrames / Math.max(1, midEnd - midStart)) * 100);
  const min_rms_dip_db = Math.round(minFrameDb * 10) / 10;

  let bassSpikeFrames = 0;
  let vocSpikeFrames = 0;
  for (let f = midStart; f < midEnd; f++) {
    if (lowVals[f] > baselineLow * 1.32 && lowVals[f] > 0.025) bassSpikeFrames++;
    if (vocVals[f] > baselineVoc * 1.36 && vocVals[f] > 0.02) vocSpikeFrames++;
  }
  const midCount = Math.max(1, midEnd - midStart);
  const bass_overlap_pct = Math.round((bassSpikeFrames / midCount) * 100);
  const vocal_overlap_pct = Math.round((vocSpikeFrames / midCount) * 100);
  const spectral_mud_pct = Math.round((sumMud / Math.max(1e-6, sumLow + sumMud + sumVoc)) * 100);

  // Measure real beat-onset alignment drift (ms) & cross-correlation phase offset on >145 Hz transient attack envelope
  const beatSec = 60 / Math.max(55, bpm || 120);
  const stepN = Math.max(128, Math.floor(sr * 0.008));
  const numSteps = Math.floor(len / stepN);
  const stepRms = new Float32Array(numSteps);
  let lpOnset = 0;
  let stepSum = 0;
  for (let s = 0; s < numSteps; s++) {
    let acc = 0;
    const base = s * stepN;
    for (let k = 0; k < stepN; k++) {
      const m = 0.5 * (ch0[base + k] + ch1[base + k]);
      lpOnset = aLow * lpOnset + (1 - aLow) * m;
      const tr = m - lpOnset;
      acc += tr * tr;
    }
    stepRms[s] = Math.sqrt(acc / stepN);
    stepSum += stepRms[s];
  }
  const avgStepRms = stepSum / Math.max(1, numSteps);
  const onsets = [];
  for (let s = 3; s < numSteps - 2; s++) {
    const prev = (stepRms[s - 3] + stepRms[s - 2] + stepRms[s - 1]) / 3;
    if (stepRms[s] > prev * 1.65 && stepRms[s] >= stepRms[s + 1] && stepRms[s] > Math.max(0.05, avgStepRms * 1.25)) {
      const y0 = stepRms[s - 1], y1 = stepRms[s], y2 = stepRms[s + 1];
      const denom = y0 - 2 * y1 + y2;
      const delta = Math.abs(denom) > 1e-6 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / denom)) : 0;
      const t = ((s + delta) * stepN) / sr;
      if (!onsets.length || t - onsets[onsets.length - 1] >= beatSec * 0.65) onsets.push(t);
    }
  }
  let beat_drift_ms = 0;
  let onset_phase_offset_ms = 0;
  if (onsets.length >= 4) {
    // Circular phase mean avoids ±beatSec/2 branch-cut wraparound errors
    let sumSin = 0;
    let sumCos = 0;
    for (const t of onsets) {
      const th = (2 * Math.PI * t) / beatSec;
      sumSin += Math.sin(th);
      sumCos += Math.cos(th);
    }
    const meanPhase = ((Math.atan2(sumSin, sumCos) * beatSec) / (2 * Math.PI) + beatSec) % beatSec;
    const devs = onsets.map((t) => {
      const d = ((t - meanPhase) % beatSec + beatSec) % beatSec;
      return Math.min(d, beatSec - d) * 1000;
    });
    beat_drift_ms = Math.min(60, Math.round((devs.reduce((a, b) => a + b, 0) / devs.length) * 10) / 10);

    // Split early vs late overlap onset phase lag (catches doubled/flammed kicks!)
    const split = Math.floor(onsets.length / 2);
    const early = onsets.slice(0, split);
    const late = onsets.slice(split);
    const calcMeanPhase = (arr) => {
      let s = 0, c = 0;
      for (const t of arr) {
        const th = (2 * Math.PI * t) / beatSec;
        s += Math.sin(th);
        c += Math.cos(th);
      }
      return Math.atan2(s, c);
    };
    if (early.length >= 2 && late.length >= 2) {
      let dTheta = calcMeanPhase(late) - calcMeanPhase(early);
      while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
      while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
      onset_phase_offset_ms = Math.round(((dTheta / (2 * Math.PI)) * beatSec) * 1000 * 10) / 10;
    }
  }

  return {
    bass_overlap_pct,
    vocal_overlap_pct,
    beat_drift_ms,
    onset_phase_offset_ms,
    lufs_jump_db,
    energy_hole_pct,
    min_rms_dip_db,
    spectral_mud_pct,
    clipping_samples,
    duration_sec: Math.round((len / sr) * 10) / 10,
  };
}

/**
 * Renders an isolated 10-16 second transition clip offline for Phase 5 Audio Listener + Critic evaluation.
 */
export async function renderTransitionClipBase64(trackA, trackB, recipe, proMixer, { maxClipSec = 15 } = {}) {
  const recA = await proMixer.decodeAndAnalyze(trackA);
  const recB = await proMixer.decodeAndAnalyze(trackB);
  const sr = recA.buffer.sampleRate || 44100;
  const barDur = (60 / Math.max(55, recA.analysis.bpm || 120)) * 4;
  const lenBars = Math.max(4, Math.min(16, Number(recipe.length_bars) || 8));
  const overlapSec = Math.min(maxClipSec - 3, lenBars * barDur);
  const preRollSec = 1.8;
  const postRollSec = 1.8;
  const totalSec = Math.min(maxClipSec, preRollSec + overlapSec + postRollSec);

  const outStartSec = recA.analysis.bars?.[recipe.mix_out_bar]?.start_sec ?? Math.max(0, (recipe.mix_out_bar || 8) * barDur - preRollSec);
  const aOffset = Math.max(0, outStartSec - preRollSec);
  const bOffset = recB.analysis.bars?.[recipe.mix_in_bar]?.start_sec ?? Math.max(0, (recipe.mix_in_bar || 0) * barDur);
  const bRate = recipe.tempo_plan?.stretch_from
    ? Math.max(0.91, Math.min(1.09, (recipe.tempo_plan.stretch_to || recA.analysis.bpm) / recipe.tempo_plan.stretch_from))
    : 1;

  const offline = new OfflineAudioContext(2, Math.floor(totalSec * sr), sr);
  const masterCeiling = offline.createGain();
  masterCeiling.gain.value = 0.86;
  const masterComp = offline.createDynamicsCompressor();
  masterComp.threshold.value = -3;
  masterComp.knee.value = 0;
  masterComp.ratio.value = 18;
  masterComp.attack.value = 0.001;
  masterComp.release.value = 0.08;
  masterCeiling.connect(masterComp);
  masterComp.connect(offline.destination);

  const stripA = createStemChannelStrip(offline, masterCeiling);
  const stripB = createStemChannelStrip(offline, masterCeiling);
  stripA.lufsTrim.gain.setValueAtTime(Math.pow(10, Math.max(-6, Math.min(6, -13 - (recA.analysis.lufs || -13))) / 20), 0);
  stripB.lufsTrim.gain.setValueAtTime(Math.pow(10, Math.max(-6, Math.min(6, -13 - (recB.analysis.lufs || -13))) / 20), 0);

  scheduleRecordOnOfflineStrip(offline, recA, stripA, {
    startWhen: 0,
    offset: Math.min(recA.buffer.duration - 2, aOffset),
    playDur: preRollSec + overlapSec,
    rate: 1,
  });
  scheduleRecordOnOfflineStrip(offline, recB, stripB, {
    startWhen: preRollSec,
    offset: Math.min(recB.buffer.duration - 2, bOffset),
    playDur: (overlapSec + postRollSec) * bRate,
    rate: bRate,
  });

  if (recipe.added_drums) {
    const samples = await loadDrumSamplesForContext(offline).catch(() => null);
    if (samples) {
      scheduleStudioDrumBridge(offline, masterCeiling, {
        when: preRollSec,
        bpm: recA.analysis.bpm || 120,
        bars: Math.max(2, lenBars),
        style: recipe.added_drums.style || 'house',
        peakGain: Math.min(0.28, Number(recipe.added_drums.gain) || 0.22),
        samples,
      });
    }
  }

  const barUnit = overlapSec / lenBars;
  const allLayerA = (recipe.stem_layers || []).find((s) => s.song === trackA.id && s.stem === 'all' && Array.isArray(s.gain_curve) && s.gain_curve.length >= 2);
  const allLayerB = (recipe.stem_layers || []).find((s) => s.song === trackB.id && s.stem === 'all' && Array.isArray(s.gain_curve) && s.gain_curve.length >= 2);

  stripA.deckVolume.gain.setValueAtTime(1, 0);
  if (allLayerA) {
    for (const [b, g] of allLayerA.gain_curve) {
      stripA.deckVolume.gain.linearRampToValueAtTime(Math.max(0.0001, Math.min(1.5, Number(g) || 0.0001)), preRollSec + Number(b) * barUnit);
    }
  } else {
    stripA.deckVolume.gain.setValueAtTime(1, preRollSec);
    stripA.deckVolume.gain.linearRampToValueAtTime(0.0001, preRollSec + overlapSec);
  }

  stripB.deckVolume.gain.setValueAtTime(0.0001, 0);
  stripB.deckVolume.gain.setValueAtTime(0.001, preRollSec);
  if (allLayerB) {
    for (const [b, g] of allLayerB.gain_curve) {
      stripB.deckVolume.gain.linearRampToValueAtTime(Math.max(0.0001, Math.min(1.5, Number(g) || 0.0001)), preRollSec + Number(b) * barUnit);
    }
  } else {
    stripB.deckVolume.gain.linearRampToValueAtTime(1, preRollSec + overlapSec);
  }

  for (const eq of (recipe.eq_automation || []).filter((e) => e.deck === 'A')) {
    for (const [b, db] of eq.points || []) stripA.setEqBand(eq.band, db, preRollSec + b * barUnit, 0.04);
  }
  for (const eq of (recipe.eq_automation || []).filter((e) => e.deck === 'B')) {
    for (const [b, db] of eq.points || []) stripB.setEqBand(eq.band, db, preRollSec + b * barUnit, 0.04);
  }
  for (const layer of (recipe.stem_layers || []).filter((s) => s.song === trackA.id && s.stem !== 'all')) {
    for (const [b, g] of layer.gain_curve || []) stripA.setStem(layer.stem, g, preRollSec + b * barUnit, 0.04);
  }
  for (const layer of (recipe.stem_layers || []).filter((s) => s.song === trackB.id && s.stem !== 'all')) {
    for (const [b, g] of layer.gain_curve || []) stripB.setStem(layer.stem, g, preRollSec + b * barUnit, 0.04);
  }

  const rendered = await offline.startRendering();
  const metrics = computeTransitionObjectiveMetrics(rendered, recA.analysis.bpm);
  const wavBytes = encodeWavBuffer(rendered, { targetSampleRate: 16000, forceMono: true });
  return { wavBase64: uint8ToBase64(wavBytes), metrics, durationSec: totalSec };
}

/**
 * Renders the full set + Phase 2/3 recipes offline via OfflineAudioContext into a downloadable .WAV mix.
 */
export async function exportMixToWav(tracks, recipes, proMixer, { title = 'NOVA-DJ-Mix', onProgress } = {}) {
  const dspTracks = tracks.filter((t) => t.file || t.stemFiles || t.stemUrls || (t.dspReady && t.streamUrl));
  if (!dspTracks.length) {
    throw new Error('Offline WAV export requires local audio files or Audius Full-DSP tracks (YouTube iframes cannot be rendered offline).');
  }

  onProgress?.('Decoding all stems & buffers for offline mixdown…');
  const records = [];
  for (const t of dspTracks) {
    const rec = await proMixer.decodeAndAnalyze(t);
    records.push({ track: t, buffer: rec.buffer, stemBuffers: rec.stemBuffers || null, analysis: rec.analysis });
  }

  const sampleRate = records[0].buffer.sampleRate || 44100;

  const timeline = [];
  let cursorSec = 0;
  for (let i = 0; i < records.length; i++) {
    const cur = records[i];
    const prevRec = i > 0 ? recipes.find((r) => r.from === records[i - 1].track.id && r.to === cur.track.id) : null;
    const nextRec = i + 1 < records.length ? recipes.find((r) => r.from === cur.track.id && r.to === records[i + 1].track.id) : null;

    const barDur = (60 / Math.max(55, cur.analysis.bpm || 120)) * 4;
    const inBar = prevRec?.mix_in_bar ?? 0;
    const inOffset = cur.analysis.bars?.[inBar]?.start_sec ?? inBar * barDur;

    const outBar = nextRec?.mix_out_bar ?? Math.max(4, (cur.analysis.bar_count || 16) - 8);
    const lenBars = nextRec?.length_bars ?? 8;
    const outEndSec = nextRec
      ? Math.min(cur.buffer.duration - 0.5, (cur.analysis.bars?.[outBar]?.start_sec ?? outBar * barDur) + lenBars * barDur)
      : Math.min(cur.buffer.duration - 0.5, Math.max(inOffset + 12, cur.track.exitSec ?? cur.buffer.duration - 1));

    const playDur = Math.max(6, outEndSec - inOffset);
    const rate = prevRec && prevRec.tempo_plan?.stretch_from
      ? Math.max(0.91, Math.min(1.09, (prevRec.tempo_plan.stretch_to || cur.analysis.bpm) / prevRec.tempo_plan.stretch_from))
      : 1;
    const realDur = playDur / rate;

    const overlapSec = nextRec ? Math.min(realDur * 0.45, lenBars * barDur) : 0;
    timeline.push({
      ...cur,
      startCtx: cursorSec,
      inOffset,
      playDur,
      realDur,
      rate,
      prevRec,
      nextRec,
      overlapSec,
    });
    cursorSec += Math.max(4, realDur - overlapSec);
  }

  const totalSec = Math.min(900, Math.ceil(timeline[timeline.length - 1].startCtx + timeline[timeline.length - 1].realDur + 1));
  onProgress?.(`Rendering ${Math.round(totalSec)}s stereo WAV master in OfflineAudioContext…`);

  const offline = new OfflineAudioContext(2, Math.floor(totalSec * sampleRate), sampleRate);
  const masterCeiling = offline.createGain();
  masterCeiling.gain.value = 0.88;
  const masterComp = offline.createDynamicsCompressor();
  masterComp.threshold.value = -3;
  masterComp.knee.value = 0;
  masterComp.ratio.value = 18;
  masterComp.attack.value = 0.001;
  masterComp.release.value = 0.08;
  masterCeiling.connect(masterComp);
  masterComp.connect(offline.destination);

  const offlineDrumSamples = await loadDrumSamplesForContext(offline).catch(() => null);

  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    const strip = createStemChannelStrip(offline, masterCeiling);
    const lufs = Number.isFinite(item.analysis.lufs) ? item.analysis.lufs : -13;
    const trimDb = Math.max(-6, Math.min(6, -13 - lufs));
    strip.lufsTrim.gain.setValueAtTime(Math.pow(10, trimDb / 20), item.startCtx);

    scheduleRecordOnOfflineStrip(offline, item, strip, {
      startWhen: item.startCtx,
      offset: item.inOffset,
      playDur: item.playDur,
      rate: item.rate,
    });

    if (item.prevRec) {
      const ov = timeline[i - 1].overlapSec || 8;
      const barUnit = ov / Math.max(1, item.prevRec.length_bars || 8);
      strip.deckVolume.gain.setValueAtTime(0.001, item.startCtx);
      strip.deckVolume.gain.linearRampToValueAtTime(1.0, item.startCtx + ov);
      for (const eq of (item.prevRec.eq_automation || []).filter((e) => e.deck === 'B')) {
        for (const [b, db] of eq.points || []) strip.setEqBand(eq.band, db, item.startCtx + b * barUnit, 0.04);
      }
      for (const layer of (item.prevRec.stem_layers || []).filter((s) => s.song === item.track.id && s.stem !== 'all')) {
        for (const [b, g] of layer.gain_curve || []) strip.setStem(layer.stem, g, item.startCtx + b * barUnit, 0.04);
      }
    } else {
      strip.deckVolume.gain.setValueAtTime(1.0, item.startCtx);
    }

    if (item.nextRec) {
      const ov = item.overlapSec || 8;
      const outStart = item.startCtx + item.realDur - ov;
      const barUnit = ov / Math.max(1, item.nextRec.length_bars || 8);
      strip.deckVolume.gain.setValueAtTime(1.0, outStart);
      strip.deckVolume.gain.linearRampToValueAtTime(0.0001, outStart + ov);
      for (const eq of (item.nextRec.eq_automation || []).filter((e) => e.deck === 'A')) {
        for (const [b, db] of eq.points || []) strip.setEqBand(eq.band, db, outStart + b * barUnit, 0.04);
      }
      for (const fl of (item.nextRec.filter_automation || []).filter((f) => f.deck === 'A')) {
        for (const [b, val] of fl.curve || []) strip.setColorFilter(val, outStart + b * barUnit, 0.05);
      }
      for (const layer of (item.nextRec.stem_layers || []).filter((s) => s.song === item.track.id && s.stem !== 'all')) {
        for (const [b, g] of layer.gain_curve || []) strip.setStem(layer.stem, g, outStart + b * barUnit, 0.04);
      }
      if (item.nextRec.added_drums && offlineDrumSamples) {
        scheduleStudioDrumBridge(offline, masterCeiling, {
          when: outStart,
          bpm: item.analysis.bpm || 120,
          bars: Math.max(2, Number(item.nextRec.length_bars) || 8),
          style: item.nextRec.added_drums.style || 'house',
          peakGain: Math.min(0.28, Number(item.nextRec.added_drums.gain) || 0.22),
          samples: offlineDrumSamples,
        });
      }
    } else {
      strip.deckVolume.gain.setValueAtTime(1.0, Math.max(item.startCtx, item.startCtx + item.realDur - 2.5));
      strip.deckVolume.gain.linearRampToValueAtTime(0.0001, item.startCtx + item.realDur);
    }
  }

  const rendered = await offline.startRendering();
  const wavBlob = new Blob([encodeWavBuffer(rendered)], { type: 'audio/wav' });
  const url = URL.createObjectURL(wavBlob);
  const a = document.createElement('a');
  const safeName = String(title || 'NOVA-Mix').replace(/[^a-z0-9-_]+/gi, '-');
  a.href = url;
  a.download = `${safeName}.wav`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 45000);
  return { durationSec: rendered.duration, sizeBytes: wavBlob.size };
}
