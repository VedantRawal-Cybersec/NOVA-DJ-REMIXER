import { getQueryParams, handlePreflight, readJsonBody, sendJson } from './_lib/http.js';
import { loadServerEnv } from './_lib/env.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  loadServerEnv();

  const workerUrl = String(process.env.AUDIO_WORKER_URL || '').trim().replace(/\/+$/, '');
  if (!workerUrl) {
    return sendJson(res, 200, {
      ok: true,
      workerConfigured: false,
      mode: 'browser-wasm',
      message: 'Python GPU worker (AUDIO_WORKER_URL) is not attached; browser Essentia WASM + Mid-Side stems engine is handling Phase 1 analysis locally.',
    });
  }

  try {
    const q = getQueryParams(req);
    if (req.method === 'GET' && q.stemPath) {
      const target = `${workerUrl}/${String(q.stemPath).replace(/^\/+/, '')}`;
      const upstream = await fetch(target);
      if (!upstream.ok) return sendJson(res, upstream.status, { ok: false, error: 'Stem not found' });
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/wav');
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.status(200).end(buf);
    }

    if (req.method === 'GET') {
      const r = await fetch(`${workerUrl}/health`);
      const data = await r.json().catch(() => ({}));
      return sendJson(res, 200, { ok: r.ok, workerConfigured: true, worker: data });
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const r = await fetch(`${workerUrl}/analyze-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({ ok: false }));
      return sendJson(res, r.status, { ...data, workerConfigured: true });
    }
  } catch (err) {
    return sendJson(res, 502, {
      ok: false,
      workerConfigured: true,
      error: err?.message || 'GPU analysis worker unreachable; falling back to browser WASM.',
    });
  }
}
