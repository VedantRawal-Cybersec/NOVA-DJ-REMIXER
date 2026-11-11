import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'samples');

function deterministicNoise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return (s / 0x80000000) - 1;
  };
}

function renderSample(durationSec, fn, sampleRate = 44100) {
  const len = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(len);
  let peak = 1e-6;
  for (let i = 0; i < len; i++) {
    const val = fn(i / sampleRate, i, sampleRate);
    out[i] = val;
    if (Math.abs(val) > peak) peak = Math.abs(val);
  }
  const scale = 0.84 / peak;
  for (let i = 0; i < len; i++) out[i] *= scale;
  return out;
}

function writeWavMono(filePath, samples, sampleRate = 44100) {
  const numFrames = samples.length;
  const dataBytes = numFrames * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < numFrames; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
}

export function generateStudioDrumPack() {
  fs.mkdirSync(outDir, { recursive: true });
  const n1 = deterministicNoise(4201);
  const n2 = deterministicNoise(8402);
  const n3 = deterministicNoise(9911);

  const specs = {
    // 1. Punjabi Dhol Dagga (deep bass barrel head + warm second partial)
    dhol_dagga: renderSample(0.38, (t) => {
      const f = 62 + 78 * Math.exp(-t * 28);
      const body = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9.5);
      const overtone = 0.28 * Math.sin(2 * Math.PI * (f * 1.52) * t) * Math.exp(-t * 18);
      const slap = 0.22 * n1() * Math.exp(-t * 95);
      return Math.tanh((body + overtone + slap) * 1.35);
    }),

    // 2. Punjabi Dhol Tilli (crisp cane-stick rim snap)
    dhol_tilli: renderSample(0.16, (t) => {
      const m1 = Math.sin(2 * Math.PI * 425 * t) * Math.exp(-t * 32);
      const m2 = 0.65 * Math.sin(2 * Math.PI * 845 * t) * Math.exp(-t * 42);
      const m3 = 0.35 * Math.sin(2 * Math.PI * 1420 * t) * Math.exp(-t * 58);
      const crack = 0.72 * n2() * Math.exp(-t * 110);
      return Math.tanh((m1 + m2 + m3 + crack) * 1.25);
    }),

    // 3. Tuned Indian Tabla Dayan "Na" (singing harmonic modal ring)
    tabla_na: renderSample(0.34, (t) => {
      const base = 311.1; // D#4 harmonic syahi overtones
      const h1 = 0.45 * Math.sin(2 * Math.PI * base * t) * Math.exp(-t * 11);
      const h2 = 0.72 * Math.sin(2 * Math.PI * base * 2.0 * t) * Math.exp(-t * 13);
      const h3 = 0.38 * Math.sin(2 * Math.PI * base * 2.98 * t) * Math.exp(-t * 20);
      const edge = 0.42 * n1() * Math.exp(-t * 140);
      return Math.tanh((h1 + h2 + h3 + edge) * 1.15);
    }),

    // 4. Tabla Bayan "Ge" (gliding warm low resonance)
    tabla_ge: renderSample(0.36, (t) => {
      const f = 78 + 86 * Math.exp(-t * 14);
      const ring = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 8.2);
      const sub = 0.45 * Math.sin(2 * Math.PI * (f * 0.5) * t) * Math.exp(-t * 12);
      return Math.tanh((ring + sub) * 1.2);
    }),

    // 5. Club House 909 Kick (tight beater click + clean 52Hz punch)
    house_kick: renderSample(0.28, (t) => {
      const click = 0.55 * Math.sin(2 * Math.PI * 1850 * t) * Math.exp(-t * 210);
      const pitch = 49 + 145 * Math.exp(-t * 44);
      const sub = Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t * 15.5);
      return Math.tanh((sub + click) * 1.45);
    }),

    // 6. Club Layered Stereo-Feel Clap (4 micro-flam bursts + warm tail)
    house_clap: renderSample(0.24, (t) => {
      const burster = (offset) => (t >= offset ? Math.exp(-(t - offset) * 95) : 0);
      const env = burster(0) * 0.75 + burster(0.011) * 0.8 + burster(0.023) * 0.85 + Math.exp(-t * 19) * 0.45;
      const noise = n3() * env;
      const body = 0.25 * Math.sin(2 * Math.PI * 1050 * t) * Math.exp(-t * 65);
      return Math.tanh((noise + body) * 1.3);
    }),

    // 7. Analog Metallic Closed Hat
    house_hat: renderSample(0.075, (t) => {
      const freqs = [2450, 3680, 5120, 6840, 8450];
      let sum = 0;
      for (const f of freqs) sum += Math.sin(2 * Math.PI * f * t);
      const metallic = (sum / freqs.length) * 0.55 + n2() * 0.65;
      return metallic * Math.exp(-t * 78);
    }),

    // 8. Heavy 808 Sub Trap Hit
    trap_808: renderSample(0.55, (t) => {
      const f = 43 + 72 * Math.exp(-t * 36);
      const sub = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 4.8);
      const click = 0.35 * Math.sin(2 * Math.PI * 950 * t) * Math.exp(-t * 180);
      return Math.tanh((sub * 1.6 + click));
    }),
  };

  for (const [name, samples] of Object.entries(specs)) {
    writeWavMono(path.join(outDir, `${name}.wav`), samples);
  }
  return Object.keys(specs).map((name) => `public/samples/${name}.wav`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = generateStudioDrumPack();
  console.log(`Generated ${files.length} studio percussion WAV files in public/samples/`);
}
