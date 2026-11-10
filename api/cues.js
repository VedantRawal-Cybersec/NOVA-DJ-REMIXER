import { getQueryParams, handlePreflight, readJsonBody, sendJson } from './_lib/http.js';
import { getTracksByIds, updateTrackCue, upsertTracks } from './_lib/db.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;

  if (req.method === 'GET') {
    const q = getQueryParams(req);
    const ids = String(q.ids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) {
      return sendJson(res, 200, { ok: true, tracks: {} });
    }
    const tracks = await getTracksByIds(ids);
    return sendJson(res, 200, { ok: true, tracks });
  }

  if (req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (Array.isArray(body?.tracks)) {
        const result = await upsertTracks(body.tracks);
        return sendJson(res, 200, { ok: true, ...result });
      }
      if (!body?.trackId) {
        return sendJson(res, 400, { ok: false, error: 'trackId required' });
      }
      const result = await updateTrackCue(body);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err?.message || 'Invalid JSON' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}
