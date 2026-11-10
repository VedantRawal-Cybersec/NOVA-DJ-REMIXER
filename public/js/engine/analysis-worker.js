import { toCamelot } from './camelot.js';

let essentiaPromise = null;

async function getEssentia() {
  if (!essentiaPromise) {
    essentiaPromise = (async () => {
      const [{ default: Essentia }, { EssentiaWASM }] = await Promise.all([
        import('/vendor/essentia.js-core.es.min.js'),
        import('/vendor/essentia-wasm.es.js'),
      ]);
      return new Essentia(EssentiaWASM);
    })().catch((err) => {
      console.warn('Essentia WASM init fell back to pure-JS DSP:', err?.message);
      return null;
    });
  }
  return essentiaPromise;
}

function resampleLinear(input, srcRate, dstRate) {
  if (srcRate === dstRate) return input;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] || 0;
    const b = input[Math.min(idx + 1, input.length - 1)] || a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr0 = Math.cos(angle);
    const wi0 = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const u = i + j;
        const v = i + j + len / 2;
        const vr = re[v] * wr - im[v] * wi;
        const vi = re[v] * wi + im[v] * wr;
        re[v] = re[u] - vr;
        im[v] = im[u] - vi;
        re[u] += vr;
        im[u] += vi;
        const nextWr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0;
        wr = nextWr;
      }
    }
  }
}

function fallbackBpmAndGrid(flux, frameRate, duration) {
  const mean = flux.reduce((a, b) => a + b, 0) / Math.max(1, flux.length);
  const env = flux.map((v) => Math.max(0, v - mean * 0.6));
  const minLag = Math.max(4, Math.floor((frameRate * 60) / 185));
  const maxLag = Math.min(Math.floor(env.length / 3), Math.ceil((frameRate * 60) / 68));
  let bestLag = 0;
  let bestScore = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0, aa = 0, bb = 0;
    for (let i = lag; i < env.length; i++) {
      dot += env[i] * env[i - lag];
      aa += env[i] * env[i];
      bb += env[i - lag] * env[i - lag];
    }
    const score = aa && bb ? dot / Math.sqrt(aa * bb) : 0;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (!bestLag) return { bpm: 120, confidence: 0.2, beats: [] };
  let bpm = (60 * frameRate) / bestLag;
  if (bpm < 78) bpm *= 2;
  if (bpm > 172) bpm /= 2;

  const beatSec = 60 / bpm;
  let phase = 0;
  let phaseMax = -1;
  const stepCount = Math.ceil(beatSec * frameRate);
  for (let p = 0; p < stepCount; p++) {
    let sum = 0;
    for (let t = p / frameRate; t < duration; t += beatSec) {
      const idx = Math.min(env.length - 1, Math.round(t * frameRate));
      sum += env[idx];
    }
    if (sum > phaseMax) {
      phaseMax = sum;
      phase = p / frameRate;
    }
  }
  const beats = [];
  for (let t = phase; t < duration; t += beatSec) beats.push(t);
  return { bpm, confidence: Math.min(1, bestScore * 1.4), beats };
}

function detectSpectralFeatures(mono, sampleRate) {
  const duration = mono.length / sampleRate;
  const factor = Math.max(1, Math.round(sampleRate / 11025));
  const rate = sampleRate / factor;
  const dsLen = Math.floor(mono.length / factor);
  const ds = new Float32Array(dsLen);
  for (let i = 0; i < dsLen; i++) ds[i] = mono[i * factor];

  const N = 1024;
  const H = 256;
  const frames = Math.max(1, Math.floor((ds.length - N) / H) + 1);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const prevMag = new Float32Array(N / 2 + 1);

  const rms = new Float32Array(frames);
  const flux = new Float32Array(frames);
  const lowBand = new Float32Array(frames);
  const vocalBand = new Float32Array(frames);
  const highBand = new Float32Array(frames);

  let totalLow = 0, totalVocal = 0, totalHigh = 0;
  let sqTotal = 0;

  for (let f = 0; f < frames; f++) {
    const off = f * H;
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const s = ds[off + i] || 0;
      sq += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    sqTotal += sq / N;
    rms[f] = Math.sqrt(sq / N);
    fftRadix2(re, im);

    let fl = 0, lo = 0, voc = 0, hi = 0;
    for (let k = 1; k <= N / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const diff = mag - prevMag[k];
      if (diff > 0) fl += diff;
      prevMag[k] = mag;
      const freq = (k * rate) / N;
      if (freq >= 32 && freq < 150) lo += mag;
      else if (freq >= 420 && freq < 3800) voc += mag;
      else if (freq >= 4200) hi += mag;
    }
    flux[f] = fl;
    lowBand[f] = lo;
    vocalBand[f] = voc;
    highBand[f] = hi;
    totalLow += lo;
    totalVocal += voc;
    totalHigh += hi;
  }

  const meanRms = Math.sqrt(sqTotal / Math.max(1, frames));
  const lufs = Math.max(-40, Math.min(-4, 20 * Math.log10(Math.max(1e-5, meanRms)) - 0.691));

  // 88-bar heat waveform (matches NAUX waveform bar count!)
  const heat = [];
  const bars = 88;
  for (let i = 0; i < bars; i++) {
    const s = Math.floor((i * frames) / bars);
    const e = Math.max(s + 1, Math.floor(((i + 1) * frames) / bars));
    let sum = 0;
    for (let f = s; f < e; f++) sum += rms[f];
    heat.push(sum / (e - s));
  }
  const peakHeat = Math.max(...heat.slice(Math.floor(bars * 0.04), Math.ceil(bars * 0.96)), 1e-6);
  const normHeat = heat.map((v) => Math.round(Math.min(1, v / peakHeat) * 1000) / 1000);

  // 64-window section & vocal density curve
  const winCount = 64;
  const energyCurve = [];
  const bassCurve = [];
  const vocalCurve = [];
  for (let w = 0; w < winCount; w++) {
    const s = Math.floor((w * frames) / winCount);
    const e = Math.max(s + 1, Math.floor(((w + 1) * frames) / winCount));
    let rSum = 0, bSum = 0, vSum = 0, allSum = 0;
    for (let f = s; f < e; f++) {
      rSum += rms[f];
      bSum += lowBand[f];
      vSum += vocalBand[f];
      allSum += lowBand[f] + vocalBand[f] + highBand[f] + 1e-6;
    }
    const len = e - s;
    energyCurve.push(rSum / len);
    bassCurve.push(bSum / len);
    vocalCurve.push(vSum / allSum);
  }
  const maxE = Math.max(...energyCurve, 1e-6);
  const normEnergy = energyCurve.map((v) => Math.min(1, v / maxE));

  const sections = [];
  for (let i = 0; i < winCount; i++) {
    const prev = normEnergy[Math.max(0, i - 1)];
    const cur = normEnergy[i];
    const next = normEnergy[Math.min(winCount - 1, i + 1)];
    const grad = (next - prev) / 2;
    let type = 'groove';
    if (i < 6 && cur < 0.55) type = 'intro';
    else if (i > winCount - 8 && cur < 0.62) type = 'outro';
    else if (cur >= 0.78 && cur >= prev * 0.96 && cur >= next * 0.96) type = 'drop';
    else if (grad > 0.07) type = 'buildup';
    else if (grad < -0.07) type = 'breakdown';

    const start = (duration * i) / winCount;
    const end = (duration * (i + 1)) / winCount;
    const last = sections[sections.length - 1];
    if (last && last.type === type) {
      last.end = end;
      last.energy = (last.energy + cur) / 2;
      last.vocal = (last.vocal + vocalCurve[i]) / 2;
    } else {
      sections.push({ type, start, end, energy: cur, vocal: vocalCurve[i] });
    }
  }

  const totalSpec = totalLow + totalVocal + totalHigh + 1e-6;
  return {
    duration,
    frameRate: rate / H,
    flux,
    lowBand,
    highBand,
    lufs: Math.round(lufs * 10) / 10,
    heat: normHeat,
    energyCurve: normEnergy,
    vocalCurve,
    sections,
    spectrum: {
      bass: totalLow / totalSpec,
      vocal: totalVocal / totalSpec,
      high: totalHigh / totalSpec,
    },
    avgEnergy10: Math.max(1, Math.min(10, Math.round((normEnergy.reduce((a, b) => a + b, 0) / winCount) * 11))),
  };
}

function findDownbeats(beats, lowBand, highBand, frameRate) {
  if (!beats.length) return { downbeats: [], downbeatPhase: 0, downbeatConfidence: 0 };
  const phaseScore = [0, 0, 0, 0];
  const phaseCount = [0, 0, 0, 0];
  const radius = Math.max(1, Math.round(0.06 * frameRate));

  for (let i = 0; i < beats.length; i++) {
    const center = Math.round(beats[i] * frameRate);
    let lowPeak = 0;
    let highPeak = 0;
    for (let d = -radius; d <= radius; d++) {
      const j = center + d;
      if (j < 1 || j >= lowBand.length) continue;
      const loDelta = Math.max(0, lowBand[j] - lowBand[j - 1]);
      const hiDelta = Math.max(0, highBand[j] - highBand[j - 1]);
      if (loDelta > lowPeak) lowPeak = loDelta;
      if (hiDelta > highPeak) highPeak = hiDelta;
    }
    const p = i % 4;
    phaseScore[p] += Math.max(0, lowPeak - 0.55 * highPeak);
    phaseCount[p]++;
  }

  const avg = phaseScore.map((s, idx) => (phaseCount[idx] ? s / phaseCount[idx] : 0));
  const bestPhase = avg.indexOf(Math.max(...avg));
  const sorted = [...avg].sort((a, b) => b - a);
  const conf = sorted[0] > 0 ? Math.min(1, ((sorted[0] - sorted[1]) / (sorted[0] + 1e-6)) * 2.5) : 0;
  const downbeats = beats.filter((_, i) => i % 4 === bestPhase);
  return { downbeats, downbeatPhase: bestPhase, downbeatConfidence: conf };
}

function pickCuePoints(duration, bpm, beats, downbeats, sections, energyCurve) {
  const beatDur = 60 / Math.max(60, bpm || 120);
  const barDur = beatDur * 4;
  const grid = downbeats.length >= 4 ? downbeats : beats;

  // Club Mode Entry: skip only true dead silence or ultra-quiet ambient (<6% energy), start on clean Bar 1!
  let clubEntry = grid.find((t) => t >= 0.05) || 0;
  for (const t of grid) {
    if (t > Math.min(28, duration * 0.2)) break;
    const idx = Math.min(energyCurve.length - 1, Math.floor((t / duration) * energyCurve.length));
    if (energyCurve[idx] >= 0.08) {
      clubEntry = t;
      break;
    }
  }

  // Club Mode Exit: phrase-aligned outro/breakdown in the last 16-32% of track (plays full song body!)
  const targetOut = Math.max(clubEntry + barDur * 8, duration - Math.min(34, Math.max(14, barDur * 8)));
  const outMin = Math.max(clubEntry + barDur * 8, duration * 0.68);
  const outMax = Math.max(outMin + 4, duration - 6);
  const outCandidates = grid.filter((t) => t >= outMin && t <= outMax);

  let clubExit = Math.min(duration - 4, targetOut);
  if (outCandidates.length) {
    // Score by phrase boundary (every 4 or 8 downbeats) + declining energy
    clubExit = outCandidates.reduce((best, t) => {
      const idx = Math.min(energyCurve.length - 1, Math.floor((t / duration) * energyCurve.length));
      const nextIdx = Math.min(energyCurve.length - 1, idx + 2);
      const dropOff = energyCurve[idx] - energyCurve[nextIdx];
      const scoreT = -Math.abs(t - targetOut) / barDur + dropOff * 3;
      const bIdx = Math.min(energyCurve.length - 1, Math.floor((best / duration) * energyCurve.length));
      const bNext = Math.min(energyCurve.length - 1, bIdx + 2);
      const scoreB = -Math.abs(best - targetOut) / barDur + (energyCurve[bIdx] - energyCurve[bNext]) * 3;
      return scoreT > scoreB ? t : best;
    }, outCandidates[0]);
  }

  // Party Hook Mode Entry/Exit: jump straight to the strongest build->drop hook!
  const dropSection = sections.find((s) => s.type === 'drop' && s.start < duration * 0.72)
    || sections.reduce((best, s) => (s.energy > (best?.energy || 0) && s.start < duration * 0.75 ? s : best), null);
  let hookEntry = clubEntry;
  if (dropSection) {
    const preDrop = Math.max(0.2, dropSection.start - barDur * 2);
    const snap = grid.find((t) => t >= preDrop && t <= dropSection.start + barDur * 2);
    if (snap !== undefined) hookEntry = snap;
  }
  const hookExit = Math.min(duration - 4, Math.max(hookEntry + barDur * 16, Math.min(clubExit, hookEntry + 68)));

  return {
    clubEntry: Math.round(clubEntry * 100) / 100,
    clubExit: Math.round(clubExit * 100) / 100,
    hookEntry: Math.round(hookEntry * 100) / 100,
    hookExit: Math.round(hookExit * 100) / 100,
  };
}

self.onmessage = async (event) => {
  const { id, mono, sampleRate } = event.data;
  try {
    const spec = detectSpectralFeatures(mono, sampleRate);
    const essentia = await getEssentia();

    let bpm = null;
    let bpmConfidence = 0;
    let beats = [];
    let keyInfo = { key: null, camelot: null, strength: 0 };

    if (essentia) {
      try {
        // Analyze up to 180s at 44100 Hz for fast, accurate rhythm & key extraction
        const maxSamples = Math.min(mono.length, sampleRate * 180);
        const slice = mono.subarray(0, maxSamples);
        const resampled = resampleLinear(slice, sampleRate, 44100);
        const vec = essentia.arrayToVector(resampled);

        const rhythm = essentia.RhythmExtractor2013(vec, 185, 'multifeature', 68);
        bpm = Number(rhythm.bpm) || null;
        bpmConfidence = Math.min(1, Math.max(0, Number(rhythm.confidence) / 5));
        const len = rhythm.ticks.size();
        for (let i = 0; i < len; i++) beats.push(rhythm.ticks.get(i));

        // Extrapolate remaining beat grid if track > 180s
        if (spec.duration > 180 && beats.length >= 4) {
          const avgBeat = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
          let nextT = beats[beats.length - 1] + avgBeat;
          while (nextT < spec.duration - 0.1) {
            beats.push(nextT);
            nextT += avgBeat;
          }
        }

        const keyRes = essentia.KeyExtractor(vec, true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'bgate', 44100);
        const mapped = toCamelot(keyRes.key, keyRes.scale);
        if (mapped) {
          keyInfo = {
            key: mapped.key,
            camelot: mapped.camelot,
            strength: Math.round((Number(keyRes.strength) || 0) * 100) / 100,
          };
        }
        vec.delete();
      } catch (err) {
        console.warn('Essentia runtime warning:', err?.message);
      }
    }

    if (!bpm || beats.length < 8) {
      const fb = fallbackBpmAndGrid(spec.flux, spec.frameRate, spec.duration);
      bpm = fb.bpm;
      bpmConfidence = fb.confidence;
      beats = fb.beats;
    }

    const down = findDownbeats(beats, spec.lowBand, spec.highBand, spec.frameRate);
    const cues = pickCuePoints(spec.duration, bpm, beats, down.downbeats, spec.sections, spec.energyCurve);

    self.postMessage({
      id,
      ok: true,
      analysis: {
        durationSec: spec.duration,
        bpm: Math.round(bpm * 10) / 10,
        bpmConfidence: Math.round(bpmConfidence * 100) / 100,
        key: keyInfo.key,
        camelot: keyInfo.camelot,
        keyStrength: keyInfo.strength,
        lufs: spec.lufs,
        energy: spec.avgEnergy10,
        energyCurve: spec.energyCurve,
        vocalCurve: spec.vocalCurve,
        heat: spec.heat,
        spectrum: spec.spectrum,
        sections: spec.sections,
        beats,
        downbeats: down.downbeats,
        downbeatPhase: down.downbeatPhase,
        downbeatConfidence: Math.round(down.downbeatConfidence * 100) / 100,
        ...cues,
        engine: essentia ? 'Essentia.js WASM + Spectral DSP' : 'NOVA FFT DSP',
      },
    });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || 'Analysis failed' });
  }
};
