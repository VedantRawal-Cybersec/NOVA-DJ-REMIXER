import { handlePreflight, sendJson } from './_lib/http.js';
import { getDbHealth } from './_lib/db.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  const db = await getDbHealth();
  return sendJson(res, 200, {
    ok: true,
    service: 'NOVA AI DJ v2',
    version: 'supernova-2.0',
    youtubeConfigured: Boolean(process.env.YOUTUBE_API_KEY),
    audioWorkerConfigured: Boolean(process.env.AUDIO_WORKER_URL),
    database: db,
    capabilities: [
      'youtube-search',
      'youtube-playlist-import',
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
