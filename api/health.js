import { handlePreflight, sendJson } from './_lib/http.js';
import { getDbHealth } from './_lib/db.js';
import { sanitizeApiKey } from './_lib/youtube.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  const db = await getDbHealth();
  const ytKey = sanitizeApiKey(process.env.YOUTUBE_API_KEY);
  const validYtKey = ytKey.length >= 20 && /^AIza/i.test(ytKey);

  return sendJson(res, 200, {
    ok: true,
    service: 'NOVA AI DJ v3',
    version: 'supernova-3.0',
    youtubeConfigured: Boolean(ytKey),
    youtubeMode: validYtKey ? 'data-api-v3+public-fallback' : 'public-extractor',
    opusConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
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
      'eight-club-transitions',
      'audius-full-streams',
      'db-cue-learning',
    ],
  });
}
