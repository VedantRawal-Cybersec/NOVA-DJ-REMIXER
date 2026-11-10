import { getQueryParams, handlePreflight, readJsonBody, sendJson } from './_lib/http.js';
import { deleteSetRecord, listSavedSets, saveSetRecord } from './_lib/db.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;

  const q = getQueryParams(req);
  const sessionId = String(q.sessionId || req.headers['x-nova-session'] || 'anon').slice(0, 80);

  if (req.method === 'GET') {
    const data = await listSavedSets(sessionId);
    return sendJson(res, 200, { ok: true, ...data });
  }

  if (req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body || !Array.isArray(body.tracks) || !body.tracks.length) {
        return sendJson(res, 400, { ok: false, error: 'tracks array is required' });
      }
      const id = String(body.id || `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
      const setObj = {
        id,
        sessionId: String(body.sessionId || sessionId),
        name: String(body.name || 'NOVA Party Set').slice(0, 80),
        vibe: body.vibe || {},
        tracks: body.tracks.slice(0, 150),
        createdAt: new Date().toISOString(),
      };
      const result = await saveSetRecord(setObj);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err?.message || 'Invalid JSON' });
    }
  }

  if (req.method === 'DELETE') {
    const id = String(q.id || '');
    if (!id) return sendJson(res, 400, { ok: false, error: 'id required' });
    const result = await deleteSetRecord(id, sessionId);
    return sendJson(res, 200, { ok: true, ...result });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}
