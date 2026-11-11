const SAMPLE_NAMES = [
  'dhol_dagga',
  'dhol_tilli',
  'tabla_na',
  'tabla_ge',
  'house_kick',
  'house_clap',
  'house_hat',
  'trap_808',
];

const cachedRawFiles = new Map(); // name -> ArrayBuffer
const decodedPerCtx = new WeakMap(); // BaseAudioContext -> { [name]: AudioBuffer }

function createFallbackDrumBuffer(ctx, name) {
  const sr = ctx.sampleRate;
  const dur = name.includes('808') ? 0.45 : name.includes('hat') ? 0.06 : 0.24;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, len, sr);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    if (name === 'house_hat') ch[i] = (Math.random() * 2 - 1) * Math.exp(-t * 75);
    else if (name === 'house_clap' || name === 'dhol_tilli' || name === 'tabla_na') {
      ch[i] = (Math.sin(2 * Math.PI * 440 * t) * 0.5 + (Math.random() * 2 - 1) * 0.5) * Math.exp(-t * 28);
    } else {
      const f = 52 + 80 * Math.exp(-t * 30);
      ch[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 14);
    }
  }
  return buf;
}

/**
 * Loads the royalty-free WAV samples from /samples/*.wav and decodes them into AudioBuffers
 * for the given AudioContext or OfflineAudioContext.
 */
export async function loadDrumSamplesForContext(ctx) {
  if (!ctx) return null;
  if (decodedPerCtx.has(ctx)) return decodedPerCtx.get(ctx);

  const out = {};
  await Promise.all(
    SAMPLE_NAMES.map(async (name) => {
      try {
        let ab = cachedRawFiles.get(name);
        if (!ab) {
          const res = await fetch(`/samples/${name}.wav`);
          if (res.ok) {
            ab = await res.arrayBuffer();
            cachedRawFiles.set(name, ab);
          }
        }
        if (ab) {
          out[name] = await ctx.decodeAudioData(ab.slice(0));
        } else {
          out[name] = createFallbackDrumBuffer(ctx, name);
        }
      } catch {
        out[name] = createFallbackDrumBuffer(ctx, name);
      }
    })
  );
  decodedPerCtx.set(ctx, out);
  return out;
}

/**
 * Schedules a quantized genre-matched royalty-free drum loop bridge on any AudioContext or OfflineAudioContext.
 */
export function scheduleStudioDrumBridge(ctx, destination, {
  when,
  bpm = 122,
  bars = 4,
  style = 'house',
  peakGain = 0.24,
  samples = null,
}) {
  if (!ctx || !destination || !samples) return;
  const beat = 60 / Math.max(55, bpm);
  const totalBeats = Math.ceil(bars * 4);

  const hit = (bufName, at, gainVal, hpFreq = 0) => {
    const buf = samples[bufName];
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    let node = src;
    if (hpFreq > 0) {
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = hpFreq;
      src.connect(f);
      node = f;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gainVal, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + buf.duration * 0.94);
    node.connect(g);
    g.connect(destination);
    src.start(at);
    src.stop(at + buf.duration + 0.02);
  };

  for (let k = 0; k < totalBeats; k++) {
    const at = when + k * beat;
    if (style === 'dhol') {
      // Punjabi Bhangra chaal (Dhol Dagga + Tilli + crisp Tabla accent)
      hit('dhol_dagga', at, k % 4 === 0 ? peakGain : peakGain * 0.72);
      hit('dhol_tilli', at + beat * 0.33, peakGain * 0.56);
      hit('dhol_tilli', at + beat * 0.66, peakGain * 0.64);
      if (k % 2 === 1) hit('dhol_dagga', at + beat * 0.75, peakGain * 0.62);
      if (k % 4 === 2) hit('tabla_na', at + beat * 0.5, peakGain * 0.42);
    } else if (style === 'tabla') {
      hit('tabla_ge', at, k % 2 === 0 ? peakGain * 0.9 : peakGain * 0.68);
      hit('tabla_na', at + beat * 0.25, peakGain * 0.58);
      hit('tabla_na', at + beat * 0.75, peakGain * 0.66);
      hit('house_hat', at + beat * 0.5, peakGain * 0.22, 6500);
    } else if (style === 'trap') {
      if (k % 4 === 0) hit('trap_808', at, peakGain);
      if (k % 4 === 1) hit('house_kick', at + beat * 0.5, peakGain * 0.85);
      if (k % 4 === 2) hit('house_clap', at, peakGain * 0.75, 180);
      const subdiv = k % 4 === 3 ? 6 : 4;
      for (let s = 0; s < subdiv; s++) {
        hit('house_hat', at + (s * beat) / subdiv, peakGain * 0.28, 6200);
      }
    } else {
      // Club House four-on-the-floor + clap on 2 & 4 + offbeat hat
      hit('house_kick', at, k % 4 === 0 ? peakGain : peakGain * 0.82);
      if (k % 2 === 1) hit('house_clap', at, peakGain * 0.55, 220);
      hit('house_hat', at + beat * 0.5, peakGain * 0.28, 6200);
    }
  }
}
