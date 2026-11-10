import { createStemChannelStrip } from './stems-isolator.js';

function encodeWavBlob(audioBuffer) {
  const numChannels = Math.min(2, audioBuffer.numberOfChannels);
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const blockAlign = numChannels * 2;
  const byteRate = sampleRate * blockAlign;
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
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = numChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const s0 = Math.max(-1, Math.min(1, ch0[i]));
    view.setInt16(offset, s0 < 0 ? s0 * 0x8000 : s0 * 0x7fff, true);
    offset += 2;
    if (numChannels > 1) {
      const s1 = Math.max(-1, Math.min(1, ch1[i]));
      view.setInt16(offset, s1 < 0 ? s1 * 0x8000 : s1 * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Renders the full set + Phase 2/3 recipes offline via OfflineAudioContext into a downloadable .WAV mix.
 */
export async function exportMixToWav(tracks, recipes, proMixer, { title = 'NOVA-DJ-Mix', onProgress } = {}) {
  const dspTracks = tracks.filter((t) => t.file || (t.dspReady && t.streamUrl));
  if (!dspTracks.length) {
    throw new Error('Offline WAV export requires local audio files or Audius Full-DSP tracks (YouTube iframes cannot be rendered offline).');
  }

  onProgress?.('Decoding all stems & buffers for offline mixdown…');
  const records = [];
  for (const t of dspTracks) {
    const rec = await proMixer.decodeAndAnalyze(t);
    records.push({ track: t, buffer: rec.buffer, analysis: rec.analysis });
  }

  const sampleRate = records[0].buffer.sampleRate || 44100;

  // Compute exact timeline segments in seconds
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
  const masterComp = offline.createDynamicsCompressor();
  masterComp.threshold.value = -6;
  masterComp.knee.value = 8;
  masterComp.ratio.value = 4;
  masterComp.connect(offline.destination);

  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    const strip = createStemChannelStrip(offline, masterComp);
    const lufs = Number.isFinite(item.analysis.lufs) ? item.analysis.lufs : -13;
    const trimDb = Math.max(-6, Math.min(6, -13 - lufs));
    strip.lufsTrim.gain.setValueAtTime(Math.pow(10, trimDb / 20), item.startCtx);

    const src = offline.createBufferSource();
    src.buffer = item.buffer;
    src.playbackRate.setValueAtTime(item.rate, item.startCtx);
    src.connect(strip.input);
    src.start(item.startCtx, item.inOffset, item.playDur);

    // Apply incoming overlap recipe EQ/stem automation
    if (item.prevRec) {
      const ov = timeline[i - 1].overlapSec || 8;
      const barUnit = ov / Math.max(1, item.prevRec.length_bars || 8);
      strip.deckVolume.gain.setValueAtTime(0.001, item.startCtx);
      strip.deckVolume.gain.linearRampToValueAtTime(1.0, item.startCtx + ov);
      for (const eq of (item.prevRec.eq_automation || []).filter((e) => e.deck === 'B')) {
        for (const [b, db] of eq.points || []) {
          strip.setEqBand(eq.band, db, item.startCtx + b * barUnit, 0.04);
        }
      }
      for (const layer of (item.prevRec.stem_layers || []).filter((s) => s.song === item.track.id && s.stem !== 'all')) {
        for (const [b, g] of layer.gain_curve || []) {
          strip.setStem(layer.stem, g, item.startCtx + b * barUnit, 0.04);
        }
      }
    } else {
      strip.deckVolume.gain.setValueAtTime(1.0, item.startCtx);
    }

    // Apply outgoing overlap recipe EQ/stem/fade automation
    if (item.nextRec) {
      const ov = item.overlapSec || 8;
      const outStart = item.startCtx + item.realDur - ov;
      const barUnit = ov / Math.max(1, item.nextRec.length_bars || 8);
      strip.deckVolume.gain.setValueAtTime(1.0, outStart);
      strip.deckVolume.gain.linearRampToValueAtTime(0.0001, outStart + ov);
      for (const eq of (item.nextRec.eq_automation || []).filter((e) => e.deck === 'A')) {
        for (const [b, db] of eq.points || []) {
          strip.setEqBand(eq.band, db, outStart + b * barUnit, 0.04);
        }
      }
      for (const fl of (item.nextRec.filter_automation || []).filter((f) => f.deck === 'A')) {
        for (const [b, val] of fl.curve || []) {
          strip.setColorFilter(val, outStart + b * barUnit, 0.05);
        }
      }
      for (const layer of (item.nextRec.stem_layers || []).filter((s) => s.song === item.track.id && s.stem !== 'all')) {
        for (const [b, g] of layer.gain_curve || []) {
          strip.setStem(layer.stem, g, outStart + b * barUnit, 0.04);
        }
      }
    } else {
      strip.deckVolume.gain.setValueAtTime(1.0, Math.max(item.startCtx, item.startCtx + item.realDur - 2.5));
      strip.deckVolume.gain.linearRampToValueAtTime(0.0001, item.startCtx + item.realDur);
    }
  }

  const rendered = await offline.startRendering();
  const wavBlob = encodeWavBlob(rendered);
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
