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

function detectSpectralFeatures(mono, side, sampleRate) {
  const duration = mono.length / sampleRate;
  const factor = Math.max(1, Math.round(sampleRate / 11025));
  const rate = sampleRate / factor;
  const dsLen = Math.floor(mono.length / factor);
  const ds = new Float32Array(dsLen);
  const dsSide = side ? new Float32Array(dsLen) : null;
  for (let i = 0; i < dsLen; i++) {
    ds[i] = mono[i * factor];
    if (dsSide) dsSide[i] = side[i * factor];
  }

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
  const drumBand = new Float32Array(frames);
  const vocalBand = new Float32Array(frames);
  const highBand = new Float32Array(frames);
  const sideRms = new Float32Array(frames);

  let totalLow = 0, totalDrum = 0, totalVocal = 0, totalHigh = 0;
  let sqTotal = 0;

  for (let f = 0; f < frames; f++) {
    const off = f * H;
    let sq = 0;
    let sqSide = 0;
    for (let i = 0; i < N; i++) {
      const s = ds[off + i] || 0;
      const sd = dsSide ? (dsSide[off + i] || 0) : 0;
      sq += s * s;
      sqSide += sd * sd;
      re[i] = s * win[i];
      im[i] = 0;
    }
    sqTotal += sq / N;
    rms[f] = Math.sqrt(sq / N);
    sideRms[f] = Math.sqrt(sqSide / N);
    fftRadix2(re, im);

    let fl = 0, lo = 0, dr = 0, voc = 0, hi = 0;
    for (let k = 1; k <= N / 2; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const diff = mag - prevMag[k];
      if (diff > 0) fl += diff;
      prevMag[k] = mag;
      const freq = (k * rate) / N;
      if (freq >= 32 && freq < 145) lo += mag;
      else if (freq >= 145 && freq < 380) dr += mag;
      else if (freq >= 380 && freq < 3800) voc += mag;
      else if (freq >= 3800) hi += mag;
    }
    flux[f] = fl;
    lowBand[f] = lo;
    drumBand[f] = dr + fl * 0.12;
    // Center concentration boosts vocal isolation estimate vs stereo pads/guitars
    const centerFocus = dsSide ? Math.max(0.35, 1 - Math.min(0.65, sideRms[f] / (rms[f] + 1e-5))) : 0.85;
    vocalBand[f] = voc * centerFocus;
    highBand[f] = hi;
    totalLow += lo;
    totalDrum += drumBand[f];
    totalVocal += vocalBand[f];
    totalHigh += hi;
  }

  const meanRms = Math.sqrt(sqTotal / Math.max(1, frames));
  const lufs = Math.max(-40, Math.min(-4, 20 * Math.log10(Math.max(1e-5, meanRms)) - 0.691));

  // 88-bar heat waveform (matches NAUX waveform bar count)
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

  // 64-window curve for quick visual/section overview
  const winCount = 64;
  const energyCurve = [];
  const vocalCurve = [];
  for (let w = 0; w < winCount; w++) {
    const s = Math.floor((w * frames) / winCount);
    const e = Math.max(s + 1, Math.floor(((w + 1) * frames) / winCount));
    let rSum = 0, vSum = 0, allSum = 0;
    for (let f = s; f < e; f++) {
      rSum += rms[f];
      vSum += vocalBand[f];
      allSum += lowBand[f] + drumBand[f] + vocalBand[f] + highBand[f] + 1e-6;
    }
    const len = e - s;
    energyCurve.push(rSum / len);
    vocalCurve.push(vSum / allSum);
  }
  const maxE = Math.max(...energyCurve, 1e-6);
  const normEnergy = energyCurve.map((v) => Math.min(1, v / maxE));

  const totalSpec = totalLow + totalDrum + totalVocal + totalHigh + 1e-6;
  return {
    duration,
    frameRate: rate / H,
    rms,
    flux,
    lowBand,
    drumBand,
    vocalBand,
    highBand,
    sideRms,
    lufs: Math.round(lufs * 10) / 10,
    heat: normHeat,
    energyCurve: normEnergy,
    vocalCurve,
    spectrum: {
      bass: totalLow / totalSpec,
      drums: totalDrum / totalSpec,
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

function computeBarStructure(duration, bpm, downbeats, beats, spec) {
  const beatDur = 60 / Math.max(60, bpm || 120);
  const barDur = beatDur * 4;
  let barStarts = downbeats.length >= 2 ? [...downbeats] : [];

  if (barStarts.length < 2) {
    const first = beats[0] || 0;
    barStarts = [];
    for (let t = first; t < duration - 0.5; t += barDur) barStarts.push(t);
  }

  const bars = [];
  for (let i = 0; i < barStarts.length; i++) {
    const start_sec = Math.round(barStarts[i] * 1000) / 1000;
    const end_sec = Math.round(Math.min(duration, i + 1 < barStarts.length ? barStarts[i + 1] : start_sec + barDur) * 1000) / 1000;
    if (end_sec - start_sec < 0.35) continue;
    bars.push({ bar: bars.length, start_sec, end_sec });
  }

  const barCount = bars.length;
  const { rms, lowBand, drumBand, vocalBand, highBand, sideRms, frameRate } = spec;
  const totalFrames = rms.length;

  const rawRms = [];
  const rawBass = [];
  const rawDrums = [];
  const rawVocals = [];
  const rawOther = [];

  for (const b of bars) {
    const f0 = Math.max(0, Math.floor(b.start_sec * frameRate));
    const f1 = Math.min(totalFrames, Math.max(f0 + 1, Math.ceil(b.end_sec * frameRate)));
    let r = 0, ba = 0, dr = 0, vo = 0, ot = 0;
    for (let f = f0; f < f1; f++) {
      r += rms[f];
      ba += lowBand[f];
      dr += drumBand[f];
      vo += vocalBand[f];
      ot += (highBand[f] * 0.5 + sideRms[f] * 1200 + vocalBand[f] * 0.25);
    }
    const len = f1 - f0;
    rawRms.push(r / len);
    rawBass.push(ba / len);
    rawDrums.push(dr / len);
    rawVocals.push(vo / len);
    rawOther.push(ot / len);
  }

  const normArr = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 1e-6;
    return arr.map((v) => Math.round(Math.min(1, v / Math.max(p95, 1e-6)) * 1000) / 1000);
  };

  const energy_per_bar = normArr(rawRms);
  const stem_activity = {
    bass: normArr(rawBass),
    drums: normArr(rawDrums),
    vocals: normArr(rawVocals),
    other: normArr(rawOther),
  };

  // Detect sections on bar grid (intro, verse, build, chorus, bridge, outro)
  const sections = [];
  for (let i = 0; i < barCount; i++) {
    const prev = energy_per_bar[Math.max(0, i - 1)];
    const cur = energy_per_bar[i];
    const next = energy_per_bar[Math.min(barCount - 1, i + 1)];
    const grad = (next - prev) / 2;
    let type = 'verse';
    if (i < Math.min(8, Math.floor(barCount * 0.14)) && cur < 0.62) type = 'intro';
    else if (i >= Math.max(barCount - 8, Math.floor(barCount * 0.85)) && cur < 0.68) type = 'outro';
    else if (cur >= 0.76 && stem_activity.drums[i] >= 0.48) type = 'chorus';
    else if (grad > 0.08 && cur >= 0.42) type = 'build';
    else if (cur < 0.48 && stem_activity.drums[i] < 0.35 && i > 4 && i < barCount - 6) type = 'bridge';

    const last = sections[sections.length - 1];
    if (last && last.type === type) {
      last.end_bar = i + 1;
      last.end_sec = bars[i].end_sec;
      last.energy = Math.round(((last.energy + cur) / 2) * 1000) / 1000;
    } else {
      sections.push({
        type,
        start_bar: i,
        end_bar: i + 1,
        start_sec: bars[i].start_sec,
        end_sec: bars[i].end_sec,
        energy: cur,
      });
    }
  }

  // Merge tiny 1-bar section blips smoothly
  const cleanSections = [];
  for (const s of sections) {
    if (cleanSections.length && (s.end_bar - s.start_bar) < 2) {
      const prev = cleanSections[cleanSections.length - 1];
      prev.end_bar = s.end_bar;
      prev.end_sec = s.end_sec;
    } else {
      cleanSections.push(s);
    }
  }

  // Phrase boundaries every 8, 16, 32 bars
  const phrase_boundaries = [];
  for (let b = 0; b < barCount; b += 8) {
    phrase_boundaries.push({
      bar: b,
      sec: bars[b].start_sec,
      multiple: b % 32 === 0 ? 32 : b % 16 === 0 ? 16 : 8,
    });
  }

  // Instrumental gaps (consecutive >= 2 bars where vocal activity < 0.38)
  const instrumental_gaps = [];
  let gapStart = null;
  for (let b = 0; b <= barCount; b++) {
    const isQuiet = b < barCount && stem_activity.vocals[b] < 0.38;
    if (isQuiet && gapStart === null) gapStart = b;
    else if (!isQuiet && gapStart !== null) {
      if (b - gapStart >= 2) {
        const sSec = bars[gapStart].start_sec;
        const eSec = bars[b - 1].end_sec;
        const avgVoc =
          stem_activity.vocals.slice(gapStart, b).reduce((a, v) => a + v, 0) / (b - gapStart);
        instrumental_gaps.push({
          start_bar: gapStart,
          end_bar: b,
          start_sec: sSec,
          end_sec: eSec,
          duration_sec: Math.round((eSec - sSec) * 100) / 100,
          avg_vocal: Math.round(avgVoc * 100) / 100,
        });
      }
      gapStart = null;
    }
  }

  return { bars, barCount, energy_per_bar, stem_activity, sections: cleanSections, phrase_boundaries, instrumental_gaps };
}

function detectTempoStabilityAndWarnings(beats, bpm, bpmConf, downConf, barStruct, spec) {
  const warnings = [];
  let drift_pct = 0;
  if (beats.length >= 12) {
    const ibis = [];
    for (let i = 1; i < beats.length; i++) {
      const d = beats[i] - beats[i - 1];
      if (d > 0.25 && d < 1.2) ibis.push(d);
    }
    if (ibis.length >= 8) {
      const q1 = ibis.slice(0, Math.floor(ibis.length * 0.3)).reduce((a, b) => a + b, 0) / Math.floor(ibis.length * 0.3);
      const q3 = ibis.slice(Math.floor(ibis.length * 0.7)).reduce((a, b) => a + b, 0) / (ibis.length - Math.floor(ibis.length * 0.7));
      drift_pct = Math.round((Math.abs(q3 - q1) / Math.max(0.2, q1)) * 1000) / 10;
    }
  }

  let free_time_intro_sec = 0;
  for (let i = 0; i < Math.min(8, barStruct.bars.length); i++) {
    if (barStruct.stem_activity.drums[i] < 0.22 && barStruct.energy_per_bar[i] < 0.38) {
      free_time_intro_sec = barStruct.bars[i].end_sec;
    } else break;
  }

  const is_variable = drift_pct > 3.5;
  if (bpmConf < 0.32 || beats.length < 8) warnings.push('no_clear_beat');
  if (is_variable) warnings.push('variable_tempo');
  if (free_time_intro_sec >= 6) warnings.push('free_time_intro');
  if (downConf < 0.15) warnings.push('low_confidence');

  const vocalAvg = barStruct.stem_activity.vocals.reduce((a, b) => a + b, 0) / Math.max(1, barStruct.barCount);
  const drumAvg = barStruct.stem_activity.drums.reduce((a, b) => a + b, 0) / Math.max(1, barStruct.barCount);
  let genre = 'pop / dance';
  if (bpm >= 120 && bpm <= 130 && drumAvg > 0.45 && vocalAvg < 0.45) genre = 'house / club';
  else if (bpm > 130 && drumAvg > 0.5) genre = 'techno / high-energy';
  else if (bpm >= 68 && bpm <= 92 && spec.spectrum.bass > 0.25) genre = 'hip-hop / trap / bhangra';
  else if (bpm >= 92 && bpm <= 118 && vocalAvg >= 0.4) genre = 'bollywood / pop';

  const mood = spec.avgEnergy10 >= 8 ? 'energetic' : spec.avgEnergy10 <= 4 ? 'chill' : 'groovy';
  const tags = {
    genre,
    mood,
    danceability: Math.round(Math.min(1, (bpmConf * 0.5 + drumAvg * 0.5)) * 100) / 100,
    vocal_presence: Math.round(vocalAvg * 100) / 100,
    drum_feel: bpm >= 120 && drumAvg > 0.4 ? 'four-on-the-floor' : bpm <= 92 ? 'halftime / bounce' : 'syncopated groove',
  };

  return { tempo_stability: { drift_pct, is_variable, free_time_intro_sec }, warnings, tags };
}

function pickCuePoints(duration, bpm, beats, downbeats, sections, energyCurve) {
  const beatDur = 60 / Math.max(60, bpm || 120);
  const barDur = beatDur * 4;
  const grid = downbeats.length >= 4 ? downbeats : beats;

  let clubEntry = grid.find((t) => t >= 0.05) || 0;
  for (const t of grid) {
    if (t > Math.min(28, duration * 0.2)) break;
    const idx = Math.min(energyCurve.length - 1, Math.floor((t / duration) * energyCurve.length));
    if (energyCurve[idx] >= 0.08) {
      clubEntry = t;
      break;
    }
  }

  const targetOut = Math.max(clubEntry + barDur * 8, duration - Math.min(34, Math.max(14, barDur * 8)));
  const outMin = Math.max(clubEntry + barDur * 8, duration * 0.68);
  const outMax = Math.max(outMin + 4, duration - 6);
  const outCandidates = grid.filter((t) => t >= outMin && t <= outMax);

  let clubExit = Math.min(duration - 4, targetOut);
  if (outCandidates.length) {
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

  const dropSection = sections.find((s) => (s.type === 'chorus' || s.type === 'drop') && s.start_sec < duration * 0.72)
    || sections.reduce((best, s) => (s.energy > (best?.energy || 0) && s.start_sec < duration * 0.75 ? s : best), null);
  let hookEntry = clubEntry;
  if (dropSection) {
    const preDrop = Math.max(0.2, dropSection.start_sec - barDur * 2);
    const snap = grid.find((t) => t >= preDrop && t <= dropSection.start_sec + barDur * 2);
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
  const { id, mono, side = null, sampleRate } = event.data;
  try {
    const spec = detectSpectralFeatures(mono, side, sampleRate);
    const essentia = await getEssentia();

    let bpm = null;
    let bpmConfidence = 0;
    let beats = [];
    let keyInfo = { key: null, camelot: null, strength: 0 };

    if (essentia) {
      try {
        const maxSamples = Math.min(mono.length, sampleRate * 180);
        const slice = mono.subarray(0, maxSamples);
        const resampled = resampleLinear(slice, sampleRate, 44100);
        const vec = essentia.arrayToVector(resampled);

        const rhythm = essentia.RhythmExtractor2013(vec, 185, 'multifeature', 68);
        bpm = Number(rhythm.bpm) || null;
        bpmConfidence = Math.min(1, Math.max(0, Number(rhythm.confidence) / 5));
        const len = rhythm.ticks.size();
        for (let i = 0; i < len; i++) beats.push(rhythm.ticks.get(i));

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
    const barStruct = computeBarStructure(spec.duration, bpm, down.downbeats, beats, spec);
    const meta = detectTempoStabilityAndWarnings(beats, bpm, bpmConfidence, down.downbeatConfidence, barStruct, spec);
    const cues = pickCuePoints(spec.duration, bpm, beats, down.downbeats, barStruct.sections, spec.energyCurve);

    const roundedBpm = Math.round(bpm * 10) / 10;
    const roundedBeats = beats.map((t) => Math.round(t * 1000) / 1000);
    const roundedDownbeats = down.downbeats.map((t) => Math.round(t * 1000) / 1000);

    self.postMessage({
      id,
      ok: true,
      analysis: {
        // Documented Phase 1 Schema
        duration_sec: Math.round(spec.duration * 100) / 100,
        durationSec: spec.duration,
        bpm: roundedBpm,
        bpm_confidence: Math.round(bpmConfidence * 100) / 100,
        bpmConfidence: Math.round(bpmConfidence * 100) / 100,
        beat_times: roundedBeats,
        beats: roundedBeats,
        downbeat_times: roundedDownbeats,
        downbeats: roundedDownbeats,
        downbeatPhase: down.downbeatPhase,
        downbeat_confidence: Math.round(down.downbeatConfidence * 100) / 100,
        downbeatConfidence: Math.round(down.downbeatConfidence * 100) / 100,
        bar_count: barStruct.barCount,
        bars: barStruct.bars,
        phrase_boundaries: barStruct.phrase_boundaries,
        sections: barStruct.sections,
        key: keyInfo.key,
        key_camelot: keyInfo.camelot,
        camelot: keyInfo.camelot,
        key_confidence: keyInfo.strength,
        keyStrength: keyInfo.strength,
        energy_per_bar: barStruct.energy_per_bar,
        stem_activity: barStruct.stem_activity,
        instrumental_gaps: barStruct.instrumental_gaps,
        tags: meta.tags,
        warnings: meta.warnings,
        tempo_stability: meta.tempo_stability,
        lufs: spec.lufs,
        energy: spec.avgEnergy10,
        energyCurve: spec.energyCurve,
        vocalCurve: spec.vocalCurve,
        heat: spec.heat,
        spectrum: spec.spectrum,
        ...cues,
        engine: essentia ? 'Essentia.js WASM + Spectral Mid-Side DSP' : 'NOVA FFT DSP',
      },
    });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || 'Analysis failed' });
  }
};
