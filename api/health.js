import { handlePreflight, sendJson } from './_lib/http.js';
import { getDbHealth } from './_lib/db.js';
import { loadServerEnv } from './_lib/env.js';
import { getAiHealth } from './_lib/llm-router.js';
import { sanitizeApiKey } from './_lib/youtube.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  loadServerEnv();
  const db = await getDbHealth();
  const ai = getAiHealth(req);
  const ytKey = sanitizeApiKey(process.env.YOUTUBE_API_KEY);
  const validYtKey = ytKey.length >= 20 && /^AIza/i.test(ytKey);

  return sendJson(res, 200, {
    ok: true,
    service: 'NOVA AI DJ v3',
    version: 'supernova-3.1',
    youtubeConfigured: Boolean(ytKey),
    youtubeMode: validYtKey ? 'data-api-v3+public-fallback' : 'public-extractor',
    opusConfigured: ai.providers.anthropic.configured,
    geminiConfigured: ai.providers.gemini.configured,
    openaiConfigured: ai.providers.openai.configured,
    ai,
    audioWorkerConfigured: Boolean(process.env.AUDIO_WORKER_URL),
    database: db,
    capabilities: [
      'youtube-search',
      'youtube-playlist-import',
      'youtube-continuation-pagination',
      'dual-deck-youtube-iframe',
      'essentia-wasm-beatgrid-key',
      'signalsmith-pitch-preserving-stretch',
      'spectral-and-stem-mixing',
      'nineteen-creative-transitions',
      'multi-provider-ai-router',
      'audio-listener-critique-loop',
      'multilingual-lyrics-and-protected-ranges',
      'audius-full-streams',
      'db-cue-learning',
    ],
  });
}
