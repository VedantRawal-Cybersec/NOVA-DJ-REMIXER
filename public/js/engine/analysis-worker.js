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

/**
 * Method B: Multi-band percussive onset envelope + local adaptive threshold +
 * window autocorrelation + Ellis dynamic-programming beat tracker with parabolic
 * sub-frame peak snapping.
 */
function trackBeatsSpectralDP(spec) {
  const { lowBand, drumBand, highBand, flux, frameRate, duration } = spec;
  const n = flux.length;
  if (n < 32) {
    return { name: 'spectral_dp_superflux', bpm: 120, confidence: 0.15, beats: [], rawOnset: new Float32Array(n) };
  }

  // Build weighted percussive onset envelope favoring kick (lowBand) + snare/dhol (drumBand)
  const raw = new Float32Array(n);
  for (let f = 1; f < n; f++) {
    const lo = Math.max(0, lowBand[f] - lowBand[f - 1]);
    const dr = Math.max(0, drumBand[f] - drumBand[f - 1]);
    const hi = Math.max(0, highBand[f] - highBand[f - 1]);
    raw[f] = lo * 1.45 + dr * 0.95 + flux[f] * 0.12 + hi * 0.12;
  }

  // Adaptive local mean subtraction (0.35s sliding window) + 95th-percentile normalization
  const winHalf = Math.max(4, Math.round(0.18 * frameRate));
  const env = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const a = Math.max(0, f - winHalf);
    const b = Math.min(n, f + winHalf + 1);
    let s = 0;
    for (let k = a; k < b; k++) s += raw[k];
    env[f] = Math.max(0, raw[f] - (s / (b - a)) * 0.72);
  }
  const sortedEnv = Float32Array.from(env).sort();
  const normScale = sortedEnv[Math.min(n - 1, Math.floor(n * 0.96))] || 1e-6;
  for (let f = 0; f < n; f++) env[f] = Math.min(2.5, env[f] / Math.max(normScale, 1e-6));

  // Find active rhythmic windows (ignore quiet free-time/pad intros when estimating BPM)
  const blockSec = 6.0;
  const blockFrames = Math.max(32, Math.floor(blockSec * frameRate));
  const lagMin = Math.max(4, Math.floor((frameRate * 60) / 192));
  const lagMax = Math.min(Math.floor(n / 3), Math.ceil((frameRate * 60) / 58));

  const lagVotes = new Float32Array(lagMax + 1);
  let activeBlocks = 0;
  const blockBpms = [];

  for (let b0 = 0; b0 + Math.min(n, lagMax * 2) <= n; b0 += Math.floor(blockFrames * 0.5)) {
    const b1 = Math.min(n, b0 + blockFrames);
    let bPeak = 0;
    let bSum = 0;
    for (let f = b0; f < b1; f++) {
      bSum += env[f];
      if (env[f] > bPeak) bPeak = env[f];
    }
    const bMean = bSum / Math.max(1, b1 - b0);
    if (bPeak < 0.28 || bMean < 0.03) continue; // quiet ambient/alaap section
    activeBlocks++;

    let bestBlkLag = 0;
    let bestBlkScore = -1;
    for (let lag = lagMin; lag <= Math.min(lagMax, Math.floor((b1 - b0) / 2) - 1); lag++) {
      let dot = 0;
      let aa = 0;
      let bb = 0;
      for (let i = b0 + lag; i < b1; i++) {
        dot += env[i] * env[i - lag];
        aa += env[i] * env[i];
        bb += env[i - lag] * env[i - lag];
      }
      // Also score 2x harmonic reinforcement so quarter-note pulse beats half-bar false locks
      const halfLag = Math.round(lag / 2);
      let harm = 0;
      if (halfLag >= lagMin) {
        let hDot = 0;
        let hDen = 1e-6;
        for (let i = b0 + halfLag; i < b1; i++) {
          hDot += env[i] * env[i - halfLag];
          hDen += env[i] * env[i];
        }
        harm = Math.max(0, hDot / hDen);
      }
      // Subtle perceptual prior centering dancefloor pulse around 115 BPM (wide sigma)
      const candBpm = (60 * frameRate) / lag;
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(candBpm / 116) / 0.72, 2));
      const ac = aa && bb ? dot / Math.sqrt(aa * bb) : 0;
      const score = (ac * 0.85 + harm * 0.15) * (0.78 + 0.22 * prior);
      lagVotes[lag] += score * Math.min(1.5, bMean * 6);
      if (score > bestBlkScore) {
        bestBlkScore = score;
        bestBlkLag = lag;
      }
    }
    if (bestBlkLag) {
      blockBpms.push({ t: b0 / frameRate, bpm: (60 * frameRate) / bestBlkLag, score: bestBlkScore });
    }
  }

  let bestLag = 0;
  let bestVote = -1;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    // Parabolic smooth neighborhood vote to absorb 1-frame rounding
    const v = lagVotes[lag] + 0.5 * ((lagVotes[lag - 1] || 0) + (lagVotes[lag + 1] || 0));
    if (v > bestVote) {
      bestVote = v;
      bestLag = lag;
    }
  }

  if (!bestLag || !activeBlocks) {
    return { name: 'spectral_dp_superflux', bpm: 120, confidence: 0.15, beats: [], rawOnset: env, blockBpms };
  }

  let bpm = (60 * frameRate) / bestLag;
  // Refine parabolic lag peak over full active signal
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = lagVotes[bestLag - 1];
    const y1 = lagVotes[bestLag];
    const y2 = lagVotes[bestLag + 1];
    const denom = 2 * (y0 - 2 * y1 + y2);
    if (Math.abs(denom) > 1e-6) {
      const shift = Math.max(-0.5, Math.min(0.5, (y0 - y2) / denom));
      bpm = (60 * frameRate) / (bestLag + shift);
    }
  }

  // Octave check: test bpm * 2 and bpm * 0.5 against pulse salience & standard DJ range
  const scoreOctave = (testBpm) => {
    if (testBpm < 62 || testBpm > 186) return 0;
    const step = (60 / testBpm) * frameRate;
    let bestPhaseScore = 0;
    const steps = Math.max(4, Math.ceil(step));
    for (let p = 0; p < steps; p++) {
      let s = 0;
      let c = 0;
      for (let idx = p; idx < n; idx += step) {
        const k = Math.round(idx);
        const pk = Math.max(env[Math.max(0, k - 1)], env[k], env[Math.min(n - 1, k + 1)]);
        s += pk;
        c++;
      }
      if (c > 0) bestPhaseScore = Math.max(bestPhaseScore, s / c);
    }
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(testBpm / 118) / 0.55, 2));
    return bestPhaseScore * (0.75 + 0.25 * prior);
  };
  const baseSc = scoreOctave(bpm);
  const dblSc = scoreOctave(bpm * 2);
  const hlfSc = scoreOctave(bpm * 0.5);
  if (dblSc > 0 && dblSc > baseSc * 1.12) bpm *= 2;
  else if (hlfSc > 0 && hlfSc > baseSc * 1.12) bpm *= 0.5;
  if (bpm < 62 && bpm * 2 <= 186) bpm *= 2;

  // Ellis DP beat tracker over full onset envelope
  const periodFrames = (60 / bpm) * frameRate;
  const minPrev = Math.max(3, Math.round(0.62 * periodFrames));
  const maxPrev = Math.max(minPrev + 2, Math.round(1.42 * periodFrames));
  const tightness = 36;
  const cumScore = new Float32Array(n);
  const backlink = new Int32Array(n).fill(-1);

  for (let t = 0; t < n; t++) {
    cumScore[t] = env[t];
    if (t < minPrev) continue;
    let bestPred = -Infinity;
    let bestIdx = -1;
    const pStart = Math.max(0, t - maxPrev);
    const pEnd = t - minPrev;
    for (let p = pStart; p <= pEnd; p++) {
      const dt = t - p;
      const ratio = Math.log(dt / periodFrames);
      const penalty = tightness * ratio * ratio;
      const cand = cumScore[p] - penalty;
      if (cand > bestPred) {
        bestPred = cand;
        bestIdx = p;
      }
    }
    if (bestIdx >= 0 && bestPred > 0) {
      cumScore[t] = env[t] + bestPred;
      backlink[t] = bestIdx;
    }
  }

  // Trace back from highest terminal beat score within last 2*period
  let endIdx = n - 1;
  let maxEnd = -Infinity;
  const tailStart = Math.max(0, n - Math.round(periodFrames * 2.5));
  for (let t = tailStart; t < n; t++) {
    if (cumScore[t] > maxEnd) {
      maxEnd = cumScore[t];
      endIdx = t;
    }
  }

  const dpFrames = [];
  let cur = endIdx;
  while (cur >= 0) {
    dpFrames.push(cur);
    cur = backlink[cur];
  }
  dpFrames.reverse();

  // Fill forward/backward to cover start/end cleanly and apply parabolic transient snap
  const beats = [];
  for (let i = 0; i < dpFrames.length; i++) {
    const f = dpFrames[i];
    const offset = (f > 0 && f < n - 1 && raw[f] >= raw[f - 1] && raw[f] >= raw[f + 1] && Math.abs(2 * (raw[f - 1] - 2 * raw[f] + raw[f + 1])) > 1e-6)
      ? Math.max(-0.5, Math.min(0.5, (raw[f - 1] - raw[f + 1]) / (2 * (raw[f - 1] - 2 * raw[f] + raw[f + 1]))))
      : 0;
    // Frame time corresponds to FFT window start; shift subtly toward energy rise center (+0.015s) before 2ms transient snap
    beats.push((f + offset) / frameRate);
  }

  // Fill any leading/trailing beats at median IBI if quiet intro or short tail missed
  const ibiEst = 60 / bpm;
  if (beats.length >= 2) {
    while (beats[0] - ibiEst >= 0.03) beats.unshift(beats[0] - ibiEst);
    while (beats[beats.length - 1] + ibiEst < duration - 0.12) beats.push(beats[beats.length - 1] + ibiEst);
  }

  // Recompute median IBI BPM & confidence
  const ibis = [];
  for (let i = 1; i < beats.length; i++) {
    const d = beats[i] - beats[i - 1];
    if (d > 0.25 && d < 1.35) ibis.push(d);
  }
  let tempoSpreadPct = 0;
  if (ibis.length >= 4) {
    const sorted = [...ibis].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    bpm = 60 / med;
    tempoSpreadPct = Math.round(((p90 - p10) / Math.max(0.2, med)) * 1000) / 10;
  }

  // Also check variance across local block BPMs to catch tempo jumps even when DP locks to dominant section
  if (blockBpms.length >= 2) {
    const normBlk = blockBpms.map((b) => {
      let x = b.bpm;
      if (Math.abs(x * 2 - bpm) < Math.abs(x - bpm)) x *= 2;
      else if (Math.abs(x * 0.5 - bpm) < Math.abs(x - bpm)) x *= 0.5;
      return x;
    });
    const minB = Math.min(...normBlk);
    const maxB = Math.max(...normBlk);
    const blkSpread = ((maxB - minB) / Math.max(55, bpm)) * 100;
    tempoSpreadPct = Math.max(tempoSpreadPct, Math.round(blkSpread * 10) / 10);
  }

  const bestAcNorm = activeBlocks ? Math.min(1, (bestVote / activeBlocks) * 1.15) : 0.2;
  const conf = Math.max(0.1, Math.min(0.98, bestAcNorm * (1 - Math.min(0.55, tempoSpreadPct / 45))));
  return {
    name: 'spectral_dp_superflux',
    bpm: Math.round(bpm * 10) / 10,
    confidence: Math.round(conf * 100) / 100,
    beats,
    rawOnset: env,
    tempoSpreadPct,
    blockBpms,
  };
}

/**
 * Evaluates how well a candidate beat array hits real acoustic transients vs off-beats.
 */
function scoreBeatOnsetAlignment(beats, onsetEnv, frameRate) {
  if (!beats.length || !onsetEnv?.length) return { onBeat: 0, offBeat: 0, ratio: 1 };
  let onSum = 0;
  let offSum = 0;
  let count = 0;
  const tolFrames = Math.max(1, Math.round(0.03 * frameRate));
  for (let i = 0; i < beats.length - 1; i++) {
    const f = Math.round(beats[i] * frameRate);
    const mid = Math.round(((beats[i] + beats[i + 1]) * 0.5) * frameRate);
    if (f < 0 || f >= onsetEnv.length) continue;
    let onPk = 0;
    let offPk = 0;
    for (let d = -tolFrames; d <= tolFrames; d++) {
      const k1 = f + d;
      if (k1 >= 0 && k1 < onsetEnv.length && onsetEnv[k1] > onPk) onPk = onsetEnv[k1];
      const k2 = mid + d;
      if (k2 >= 0 && k2 < onsetEnv.length && onsetEnv[k2] > offPk) offPk = onsetEnv[k2];
    }
    onSum += onPk;
    offSum += offPk;
    count++;
  }
  const onBeat = count ? onSum / count : 0;
  const offBeat = count ? offSum / count : 0;
  return {
    onBeat,
    offBeat,
    ratio: offBeat > 1e-4 ? onBeat / offBeat : (onBeat > 0.15 ? 3.0 : 1.0),
  };
}

/**
 * Compares Method A (Essentia RhythmExtractor2013) against Method B (Spectral DP Superflux),
 * resolves half/double-time octaves, picks the most accurate grid, and flags low-confidence tracks.
 */
function compareAndSelectBeatTracker(methodA, methodB, spec) {
  const hasA = Boolean(methodA && methodA.beats?.length >= 8 && methodA.bpm > 0);
  const hasB = Boolean(methodB && methodB.beats?.length >= 8 && methodB.bpm > 0);

  if (!hasA && !hasB) {
    return {
      bpm: 120,
      bpmConfidence: 0.15,
      beats: [],
      chosenMethod: 'none',
      agreementPct: 0,
      octaveResolved: false,
      lowConfidence: true,
      tempoSpreadPct: 100,
      comparison: {
        method_a: methodA ? { name: methodA.name, bpm: methodA.bpm, conf: methodA.confidence } : null,
        method_b: methodB ? { name: methodB.name, bpm: methodB.bpm, conf: methodB.confidence } : null,
        chosen: 'none',
        agreement_pct: 0,
        octave_resolved: false,
      },
    };
  }

  if (!hasA) {
    const alignB = scoreBeatOnsetAlignment(methodB.beats, methodB.rawOnset, spec.frameRate);
    const lowConf = methodB.confidence < 0.42 || (methodB.tempoSpreadPct || 0) > 7.5 || alignB.ratio < 1.2;
    return {
      bpm: methodB.bpm,
      bpmConfidence: methodB.confidence,
      beats: methodB.beats,
      chosenMethod: methodB.name,
      agreementPct: 50,
      octaveResolved: false,
      lowConfidence: lowConf,
      tempoSpreadPct: methodB.tempoSpreadPct || 0,
      comparison: {
        method_a: null,
        method_b: { name: methodB.name, bpm: methodB.bpm, conf: methodB.confidence, onset_ratio: Math.round(alignB.ratio * 100) / 100 },
        chosen: methodB.name,
        agreement_pct: 50,
        octave_resolved: false,
      },
    };
  }

  // Compute half/double-time octave relationship between A and B
  const multipliers = [1, 2, 0.5];
  let bestMult = 1;
  let minBpmErr = Infinity;
  for (const m of multipliers) {
    const err = Math.abs(methodA.bpm * m - methodB.bpm) / Math.max(methodA.bpm * m, methodB.bpm);
    if (err < minBpmErr) {
      minBpmErr = err;
      bestMult = m;
    }
  }
  const octaveResolved = bestMult !== 1 && minBpmErr <= 0.05;

  // Measure onset-hit accuracy of both methods on 2ms fastTransient (no FFT window delay!)
  const alignA = scoreBeatOnsetAlignment(methodA.beats, spec.fastTransient, spec.fastRate);
  const alignB = scoreBeatOnsetAlignment(methodB.beats, spec.fastTransient, spec.fastRate);

  // Measure beat-by-beat agreement between A and B (including octave 2x/0.5x & small phase tolerance)
  let matches = 0;
  const beatDurB = 60 / Math.max(55, methodB.bpm || 120);
  for (const ta of methodA.beats) {
    let minD = Infinity;
    for (const tb of methodB.beats) {
      let d = Math.abs(tb - ta);
      if (octaveResolved && bestMult === 0.5) {
        d = Math.min(d, Math.abs(tb + beatDurB * 0.5 - ta), Math.abs(tb - beatDurB * 0.5 - ta));
      }
      if (d < minD) minD = d;
      if (tb > ta + beatDurB) break;
    }
    if (minD <= 0.055) matches++;
  }
  const rawMatchA = matches / Math.max(1, methodA.beats.length);
  const gridMatchFrac = (minBpmErr <= 0.03) ? Math.max(rawMatchA, 0.72) : rawMatchA;
  const agreementPct = Math.round(Math.min(1, gridMatchFrac) * 100);

  // Compute per-tracker IBI CV (jitter/drift) to penalize unstable tracker outputs
  const ibiCv = (bts) => {
    const ds = [];
    for (let i = 1; i < bts.length; i++) {
      const d = bts[i] - bts[i - 1];
      if (d > 0.25 && d < 1.35) ds.push(d);
    }
    if (ds.length < 4) return 1;
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    const sd = Math.sqrt(ds.reduce((a, b) => a + (b - mean) ** 2, 0) / ds.length);
    return sd / Math.max(0.2, mean);
  };
  const cvA = ibiCv(methodA.beats);
  const cvB = ibiCv(methodB.beats);

  // Prefer tracker with stronger acoustic onset locking + steadier grid (never pick 0.17 offbeat over 2.63 onbeat!)
  const scoreA = Math.min(3.0, alignA.ratio) * 0.48 + methodA.confidence * 0.30 + (1 - Math.min(0.8, cvA * 3)) * 0.22;
  const scoreB = Math.min(3.0, alignB.ratio) * 0.48 + methodB.confidence * 0.30 + (1 - Math.min(0.8, cvB * 3)) * 0.22;
  const useA = hasA && alignA.ratio >= 0.95 && (scoreA >= scoreB || (minBpmErr <= 0.03 && cvA <= 0.035 && alignA.ratio >= 1.25));

  const chosen = useA ? methodA : methodB;
  const chosenCv = useA ? cvA : cvB;
  let finalBpm = chosen.bpm;
  let finalBeats = chosen.beats.slice();
  let finalOctaveResolved = octaveResolved;

  // Snap steady grids cleanly to 2ms acoustic transient onset phase + refine linear slope + double-time kick/snare fill check
  if (finalBeats.length >= 8 && chosenCv < 0.045 && minBpmErr <= 0.06 && spec.fastTransient?.length) {
    let ibi = 60 / Math.max(55, finalBpm);
    const maxShift = Math.min(0.055, ibi * 0.18);
    const candidateShifts = [0];
    if (Math.min(alignA.ratio, alignB.ratio) < 1.2) {
      candidateShifts.push(ibi * 0.5, -ibi * 0.5, ibi * 0.25, -ibi * 0.25);
    }
    let bestShift = 0;
    let bestScore = -1;
    for (const coarse of candidateShifts) {
      for (let ds = -maxShift; ds <= maxShift; ds += 0.002) {
        const shift = coarse + ds;
        let hitSum = 0;
        let cnt = 0;
        for (const bt of finalBeats) {
          const k = Math.round((bt + shift) * spec.fastRate);
          if (k >= 1 && k < spec.fastTransient.length - 1) {
            hitSum += Math.max(spec.fastTransient[k - 1], spec.fastTransient[k], spec.fastTransient[k + 1]);
            cnt++;
          }
        }
        const avgHit = cnt ? hitSum / cnt : 0;
        if (avgHit > bestScore) {
          bestScore = avgHit;
          bestShift = shift;
        }
      }
    }
    if (bestShift !== 0) {
      finalBeats = finalBeats
        .map((t) => t + bestShift)
        .filter((t) => t >= 0.02 && t <= spec.duration - 0.05);
      while (finalBeats.length && finalBeats[0] - ibi >= 0.03) finalBeats.unshift(finalBeats[0] - ibi);
      while (finalBeats.length && finalBeats[finalBeats.length - 1] + ibi <= spec.duration - 0.08) {
        finalBeats.push(finalBeats[finalBeats.length - 1] + ibi);
      }
    }

    // Sub-millisecond least-squares tempo/phase lock from acoustic transient peaks across full active song
    const pts = [];
    const snapRad = Math.max(4, Math.round(0.032 * spec.fastRate));
    const vals = [];
    for (let i = 0; i < finalBeats.length; i++) {
      const c = Math.round(finalBeats[i] * spec.fastRate);
      let pkIdx = c;
      let pkVal = 0;
      for (let j = Math.max(1, c - snapRad); j <= Math.min(spec.fastTransient.length - 2, c + snapRad); j++) {
        if (spec.fastTransient[j] > pkVal) {
          pkVal = spec.fastTransient[j];
          pkIdx = j;
        }
      }
      vals.push({ i, pkVal, pkT: pkIdx / spec.fastRate });
    }
    const sortedVals = [...vals].map((v) => v.pkVal).sort((a, b) => a - b);
    const medPk = sortedVals[Math.floor(sortedVals.length * 0.5)] || 0;
    for (const v of vals) {
      if (medPk > 0 && v.pkVal >= medPk * 0.42) {
        pts.push({ x: v.i, y: v.pkT });
      }
    }
    if (pts.length >= 10) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const p of pts) {
        sx += p.x;
        sy += p.y;
        sxx += p.x * p.x;
        sxy += p.x * p.y;
      }
      const nPts = pts.length;
      const denom = nPts * sxx - sx * sx;
      if (Math.abs(denom) > 1e-9) {
        const slope = (nPts * sxy - sx * sy) / denom;
        const intercept = (sy - slope * sx) / nPts;
        if (Math.abs(slope - ibi) / ibi <= 0.015) {
          ibi = slope;
          finalBpm = 60 / ibi;
          let t0 = intercept;
          while (t0 >= ibi + 0.03) t0 -= ibi;
          while (t0 < 0.03) t0 += ibi;
          const fitted = [];
          for (let t = t0; t < spec.duration - 0.05; t += ibi) fitted.push(t);
          if (fitted.length >= 8) finalBeats = fitted;
        }
      }
    }

    // Half/Double-time fill verification: if half-beats (bt + 0.5*ibi) hit strong kicks/snares (>= 32% of beat amplitude on slow <98 BPM tracks), double BPM (e.g. 87 -> 174 DnB)
    if (finalBpm < 98 && finalBpm * 2 <= 188 && finalBeats.length >= 8) {
      let beatSum = 0, midSum = 0, cnt = 0;
      const tolFast = Math.max(3, Math.round(0.024 * spec.fastRate));
      const specOnset = methodB.rawOnset;
      for (let i = 0; i < finalBeats.length - 1; i++) {
        const tB = finalBeats[i];
        const tM = finalBeats[i] + ibi * 0.5;
        const cb = Math.round(tB * spec.fastRate);
        const cm = Math.round(tM * spec.fastRate);
        let bPk = 0, mPk = 0;
        for (let d = -tolFast; d <= tolFast; d++) {
          if (cb + d >= 0 && cb + d < spec.fastTransient.length) bPk = Math.max(bPk, spec.fastTransient[cb + d]);
          if (cm + d >= 0 && cm + d < spec.fastTransient.length) mPk = Math.max(mPk, spec.fastTransient[cm + d]);
        }
        if (specOnset?.length) {
          // Account for FFT window center lead (~0.028s) when reading spectral onset strength
          const sb = Math.max(0, Math.min(specOnset.length - 1, Math.round((tB - 0.025) * spec.frameRate)));
          const sm = Math.max(0, Math.min(specOnset.length - 1, Math.round((tM - 0.025) * spec.frameRate)));
          const sBeat = Math.max(specOnset[Math.max(0, sb - 1)], specOnset[sb], specOnset[Math.min(specOnset.length - 1, sb + 1)]);
          const sMid = Math.max(specOnset[Math.max(0, sm - 1)], specOnset[sm], specOnset[Math.min(specOnset.length - 1, sm + 1)]);
          bPk = Math.max(bPk, sBeat * 0.08);
          mPk = Math.max(mPk, sMid * 0.08);
        }
        if (bPk > 1e-4) {
          beatSum += bPk;
          midSum += mPk;
          cnt++;
        }
      }
      if (cnt >= 6 && midSum / Math.max(1e-6, beatSum) >= 0.32) {
        finalBpm *= 2;
        const halfIbi = ibi * 0.5;
        const dense = [];
        let t0 = finalBeats[0];
        while (t0 >= halfIbi + 0.03) t0 -= halfIbi;
        for (let t = t0; t < spec.duration - 0.05; t += halfIbi) dense.push(t);
        finalBeats = dense;
        finalOctaveResolved = true;
      }
    }
  }

  const chosenAlign = scoreBeatOnsetAlignment(finalBeats, spec.fastTransient, spec.fastRate);
  const spreadPct = methodB.tempoSpreadPct || Math.round(chosenCv * 250 * 10) / 10;

  // Compute honest unified confidence
  let unifiedConf = chosen.confidence * 0.55 + Math.min(1, agreementPct / 100) * 0.25 + Math.min(1, chosenAlign.ratio / 2.6) * 0.2;
  if (minBpmErr > 0.07) unifiedConf *= 0.62;
  if (spreadPct > 8.5 || chosenCv > 0.10) unifiedConf *= 0.5;
  unifiedConf = Math.max(0.08, Math.min(0.99, Math.round(unifiedConf * 100) / 100));

  const lowConfidence =
    minBpmErr > 0.07 ||
    unifiedConf < 0.44 ||
    spreadPct > 8.5 ||
    chosenCv > 0.10 ||
    (agreementPct < 45 && chosenAlign.ratio < 1.25);

  return {
    bpm: finalBpm,
    bpmConfidence: unifiedConf,
    beats: finalBeats,
    chosenMethod: chosen.name,
    agreementPct,
    octaveResolved: finalOctaveResolved,
    lowConfidence,
    tempoSpreadPct: spreadPct,
    comparison: {
      method_a: { name: methodA.name, bpm: Math.round(methodA.bpm * 10) / 10, conf: Math.round(methodA.confidence * 100) / 100, onset_ratio: Math.round(alignA.ratio * 100) / 100 },
      method_b: { name: methodB.name, bpm: Math.round(methodB.bpm * 10) / 10, conf: Math.round(methodB.confidence * 100) / 100, onset_ratio: Math.round(alignB.ratio * 100) / 100 },
      chosen: chosen.name,
      agreement_pct: agreementPct,
      octave_resolved: finalOctaveResolved,
      bpm_delta_pct: Math.round(minBpmErr * 1000) / 10,
      ibi_cv: Math.round(chosenCv * 1000) / 1000,
    },
  };
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
  const H = 128; // ~11.6ms frame resolution for tight beat-to-transient snapping
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

  // 88-bar heat waveform
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

  // Fast 2ms acoustic transient-attack envelope (zero FFT window phase delay)
  const fastStep = Math.max(8, Math.round(rate * 0.002));
  const fastRate = rate / fastStep;
  const fastFrames = Math.max(2, Math.floor(dsLen / fastStep));
  const fastRms = new Float32Array(fastFrames);
  for (let i = 0; i < fastFrames; i++) {
    let s = 0;
    const o = i * fastStep;
    for (let k = 0; k < fastStep; k++) {
      const v = ds[o + k] || 0;
      s += v * v;
    }
    fastRms[i] = Math.sqrt(s / fastStep);
  }
  const fastTransient = new Float32Array(fastFrames);
  for (let i = 3; i < fastFrames; i++) {
    const prevAvg = (fastRms[i - 3] + fastRms[i - 2] + fastRms[i - 1]) / 3;
    const curAvg = (fastRms[i] + (fastRms[i + 1] || fastRms[i])) * 0.5;
    fastTransient[i] = Math.max(0, curAvg - prevAvg * 1.12);
  }

  const totalSpec = totalLow + totalDrum + totalVocal + totalHigh + 1e-6;
  return {
    duration,
    frameRate: rate / H,
    fastRate,
    fastTransient,
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
  const beatDur = 60 / Math.max(55, bpm || 120);
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
  const { rms, flux, lowBand, drumBand, vocalBand, highBand, sideRms, frameRate } = spec;
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
      // Use positive percussive onset energy so steady-state harmonic drone/alaap does not count as drums
      const prevF = Math.max(0, f - 1);
      const loRise = Math.max(0, lowBand[f] - lowBand[prevF]);
      const drRise = Math.max(0, drumBand[f] - drumBand[prevF]);
      dr += flux[f] * 0.45 + loRise * 1.6 + drRise * 1.1;
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
  const drumsNorm = normArr(rawDrums);
  const bassNorm = normArr(rawBass);
  const stem_activity = {
    bass: bassNorm,
    drums: drumsNorm,
    vocals: normArr(rawVocals),
    other: normArr(rawOther),
    drum_density: drumsNorm,
    bass_presence: bassNorm,
  };

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
    else if (grad > 0.12 && cur >= 0.48 && next >= 0.72) type = 'pre_chorus';
    else if (grad > 0.08 && cur >= 0.42) type = 'build';
    else if (cur < 0.42 && stem_activity.drums[i] < 0.28 && i > 4 && i < barCount - 4) type = 'breakdown';
    else if (cur < 0.5 && stem_activity.drums[i] < 0.38 && i > 4 && i < barCount - 4) type = 'bridge';

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

  const phrase_boundaries = [];
  for (let b = 0; b < barCount; b += 8) {
    phrase_boundaries.push({
      bar: b,
      sec: bars[b].start_sec,
      multiple: b % 32 === 0 ? 32 : b % 16 === 0 ? 16 : 8,
    });
  }

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

function detectTempoStabilityAndWarnings(beats, bpm, trackerEval, downConf, barStruct, spec) {
  const warnings = [];
  let drift_pct = 0;
  const tempo_changes = [];
  if (beats.length >= 12) {
    const ibis = [];
    for (let i = 1; i < beats.length; i++) {
      const d = beats[i] - beats[i - 1];
      if (d > 0.24 && d < 1.35) ibis.push({ d, t: beats[i] });
    }
    if (ibis.length >= 8) {
      const q1Len = Math.max(2, Math.floor(ibis.length * 0.3));
      const q1 = ibis.slice(0, q1Len).reduce((a, b) => a + b.d, 0) / q1Len;
      const q3Slice = ibis.slice(Math.floor(ibis.length * 0.7));
      const q3 = q3Slice.reduce((a, b) => a + b.d, 0) / Math.max(1, q3Slice.length);
      drift_pct = Math.round((Math.abs(q3 - q1) / Math.max(0.2, q1)) * 1000) / 10;

      let prevWinBpm = null;
      const winSize = Math.min(12, Math.max(6, Math.floor(ibis.length / 4)));
      for (let idx = 0; idx + winSize <= ibis.length; idx += winSize) {
        const avgD = ibis.slice(idx, idx + winSize).reduce((a, x) => a + x.d, 0) / winSize;
        const winBpm = Math.round((60 / avgD) * 10) / 10;
        if (prevWinBpm !== null && (Math.abs(winBpm - prevWinBpm) / Math.max(55, prevWinBpm)) * 100 >= 4.5) {
          tempo_changes.push({ at_sec: Math.round(ibis[idx].t * 100) / 100, from_bpm: prevWinBpm, to_bpm: winBpm });
        }
        prevWinBpm = winBpm;
      }
    }
  }

  // Scan directly from t=0.15s on 2ms fastTransient for first strong drum onset (handles free-time Bollywood alaap intros)
  let free_time_intro_sec = 0;
  if (spec.fastTransient?.length) {
    const sortedFt = Float32Array.from(spec.fastTransient).sort();
    const p98 = sortedFt[Math.min(sortedFt.length - 1, Math.floor(sortedFt.length * 0.98))] || 1e-6;
    const thresh = p98 * 0.36;
    const startK = Math.round(0.15 * spec.fastRate);
    for (let k = startK; k < Math.min(spec.fastTransient.length, Math.round(25 * spec.fastRate)); k++) {
      if (spec.fastTransient[k] >= thresh) {
        free_time_intro_sec = Math.round((k / spec.fastRate) * 100) / 100;
        break;
      }
    }
  }
  if (free_time_intro_sec < 3.5) {
    for (let i = 0; i < Math.min(10, barStruct.bars.length); i++) {
      if (barStruct.stem_activity.drums[i] < 0.22) {
        free_time_intro_sec = Math.max(free_time_intro_sec, barStruct.bars[i].end_sec);
      } else break;
    }
  }

  const is_variable = drift_pct > 3.5 || tempo_changes.length > 0 || (trackerEval.tempoSpreadPct || 0) > 8.0;
  if (trackerEval.bpmConfidence < 0.34 || beats.length < 8) warnings.push('no_clear_beat');
  if (is_variable) warnings.push('variable_tempo');
  if (free_time_intro_sec >= 4.0) warnings.push('free_time_intro');
  if (trackerEval.lowConfidence) warnings.push('low_confidence');

  const safe_transitions_only = Boolean(
    trackerEval.lowConfidence ||
    warnings.includes('no_clear_beat') ||
    warnings.includes('low_confidence') ||
    drift_pct > 5.0
  );

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
    danceability: Math.round(Math.min(1, (trackerEval.bpmConfidence * 0.5 + drumAvg * 0.5)) * 100) / 100,
    vocal_presence: Math.round(vocalAvg * 100) / 100,
    drum_feel: bpm >= 120 && drumAvg > 0.4 ? 'four-on-the-floor' : bpm <= 92 ? 'halftime / bounce' : 'syncopated groove',
  };

  return {
    tempo_stability: {
      drift_pct,
      is_variable,
      free_time_intro_sec,
      tempo_changes,
      spread_pct: trackerEval.tempoSpreadPct || 0,
    },
    warnings,
    safe_transitions_only,
    tags,
  };
}

function pickCuePoints(duration, bpm, beats, downbeats, sections, energyCurve) {
  const beatDur = 60 / Math.max(55, bpm || 120);
  const barDur = beatDur * 4;
  const grid = downbeats.length >= 4 ? downbeats : beats;

  let clubEntry = grid.find((t) => t >= 0.05) || 0;
  for (const t of grid) {
    if (t > Math.min(28, duration * 0.25)) break;
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

function extractEssentiaWindowed(essentia, mono, sampleRate) {
  const winSec = 180;
  const hopSec = 170;
  const winSamples = sampleRate * winSec;
  const hopSamples = sampleRate * hopSec;

  const allBeats = [];
  const bpms = [];
  const confs = [];
  let keyInfo = { key: null, camelot: null, strength: 0 };

  for (let startSample = 0; startSample < mono.length; startSample += hopSamples) {
    const endSample = Math.min(mono.length, startSample + winSamples);
    if (endSample - startSample < sampleRate * 8 && startSample > 0) break;

    const slice = mono.subarray(startSample, endSample);
    const resampled = resampleLinear(slice, sampleRate, 44100);
    const vec = essentia.arrayToVector(resampled);

    const rhythm = essentia.RhythmExtractor2013(vec, 192, 'multifeature', 64);
    const winBpm = Number(rhythm.bpm) || 0;
    const winConf = Math.min(1, Math.max(0, Number(rhythm.confidence) / 5));
    if (winBpm > 0) {
      bpms.push(winBpm);
      confs.push(winConf);
    }

    const offsetSec = startSample / sampleRate;
    const len = rhythm.ticks.size();
    for (let i = 0; i < len; i++) {
      const t = offsetSec + rhythm.ticks.get(i);
      if (!allBeats.length || t - allBeats[allBeats.length - 1] > 0.24) {
        allBeats.push(t);
      }
    }

    if (startSample === 0) {
      const keyRes = essentia.KeyExtractor(vec, true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'bgate', 44100);
      const mapped = toCamelot(keyRes.key, keyRes.scale);
      if (mapped) {
        keyInfo = {
          key: mapped.key,
          camelot: mapped.camelot,
          strength: Math.round((Number(keyRes.strength) || 0) * 100) / 100,
        };
      }
    }
    vec.delete();
    if (endSample >= mono.length) break;
  }

  return {
    methodA: {
      name: 'essentia_rhythm2013',
      bpm: bpms.length ? bpms.reduce((a, b) => a + b, 0) / bpms.length : 0,
      confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0,
      beats: allBeats,
    },
    keyInfo,
  };
}

self.onmessage = async (event) => {
  const { id, mono, side = null, sampleRate } = event.data;
  try {
    const spec = detectSpectralFeatures(mono, side, sampleRate);
    const essentia = await getEssentia();

    let methodA = null;
    let keyInfo = { key: null, camelot: null, strength: 0 };

    if (essentia) {
      try {
        const res = extractEssentiaWindowed(essentia, mono, sampleRate);
        methodA = res.methodA;
        keyInfo = res.keyInfo;
      } catch (err) {
        console.warn('Essentia runtime warning:', err?.message);
      }
    }

    // Method B always runs in parallel for dual-tracker comparison & octave verification
    const methodB = trackBeatsSpectralDP(spec);
    const trackerEval = compareAndSelectBeatTracker(methodA, methodB, spec);

    const bpm = trackerEval.bpm;
    const bpmConfidence = trackerEval.bpmConfidence;
    const beats = trackerEval.beats;

    const down = findDownbeats(beats, spec.lowBand, spec.highBand, spec.frameRate);
    const barStruct = computeBarStructure(spec.duration, bpm, down.downbeats, beats, spec);
    const meta = detectTempoStabilityAndWarnings(beats, bpm, trackerEval, down.downbeatConfidence, barStruct, spec);
    const cues = pickCuePoints(spec.duration, bpm, beats, down.downbeats, barStruct.sections, spec.energyCurve);

    const roundedBpm = Math.round(bpm * 10) / 10;
    const roundedBeats = beats.map((t) => Math.round(t * 1000) / 1000);
    const roundedDownbeats = down.downbeats.map((t) => Math.round(t * 1000) / 1000);

    self.postMessage({
      id,
      ok: true,
      analysis: {
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
        tracker_comparison: trackerEval.comparison,
        low_confidence: meta.safe_transitions_only,
        safe_transitions_only: meta.safe_transitions_only,
        stems_available: false,
        stem_mode: 'eq-midside-off',
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
        engine: essentia ? 'Dual-Tracker (Essentia WASM vs Spectral DP)' : 'Spectral DP Superflux DSP',
      },
    });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || 'Analysis failed' });
  }
};
