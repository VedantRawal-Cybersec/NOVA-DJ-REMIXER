import fs from 'node:fs';
import path from 'node:path';

let loaded = false;

/**
 * Loads server-side `.env` variables once into `process.env` when running locally,
 * without overwriting platform variables already injected by Vercel or Docker.
 */
export function loadServerEnv() {
  if (loaded) return process.env;
  loaded = true;
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return process.env;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env) || !process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch {
    // Ignore read errors on read-only serverless bundles
  }
  return process.env;
}

export function extractRequestKeys(req) {
  loadServerEnv();
  const h = req?.headers || {};
  return {
    gemini: String(h['x-gemini-key'] || process.env.GEMINI_API_KEY || '').trim(),
    openai: String(h['x-openai-key'] || process.env.OPENAI_API_KEY || '').trim(),
    anthropic: String(h['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY || '').trim(),
  };
}
