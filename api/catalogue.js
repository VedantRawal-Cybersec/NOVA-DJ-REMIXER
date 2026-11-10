import { getQueryParams, handlePreflight, sendJson } from './_lib/http.js';
import { searchCachedTracks } from './_lib/db.js';

async function fetchWithTimeout(url, ms = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function queryAudius(q, limit) {
  try {
    const data = await fetchWithTimeout(
      `https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(q)}&limit=${limit}&app_name=nova-ai-dj`
    );
    const list = Array.isArray(data?.data) ? data.data : [];
    return list
      .filter((t) => t && t.id && t.is_streamable !== false && Number(t.duration) >= 20)
      .map((t) => {
        const dur = Number(t.duration) || 180;
        const art = t.artwork?.['480x480'] || t.artwork?.['150x150'] || '';
        return {
          id: `audius-${t.id}`,
          source: 'audius',
          provider: 'Audius DSP',
          playback: 'web-audio-dsp',
          mixReady: true,
          dspReady: true,
          title: t.title || 'Untitled',
          artist: t.user?.name || 'Independent Artist',
          artwork: art,
          streamUrl: `https://discoveryprovider.audius.co/v1/tracks/${encodeURIComponent(t.id)}/stream?app_name=nova-ai-dj`,
          landingUrl: t.permalink ? `https://audius.co${t.permalink}` : 'https://audius.co',
          durationSec: dur,
          duration: dur,
          bpm: Number(t.bpm) || null,
          genre: t.genre || '',
          mood: t.mood || '',
          energy: 7,
          entrySec: Math.min(Math.round(dur * 0.14), 24),
          exitSec: Math.max(30, Math.round(dur * 0.84)),
          playFull: false,
        };
      });
  } catch {
    return [];
  }
}

async function queryOpenverse(q, limit) {
  try {
    const data = await fetchWithTimeout(
      `https://api.openverse.org/v1/audio/?q=${encodeURIComponent(q)}&page_size=${limit}&mature=false`
    );
    const list = Array.isArray(data?.results) ? data.results : [];
    return list
      .map((t) => {
        const lic = String(t.license || '').toLowerCase();
        const isOpen = lic === 'by' || lic === 'by-sa' || lic === 'cc0';
        let dur = Number(t.duration) || 0;
        if (dur > 10000) dur = Math.round(dur / 1000);
        if (!t.url || dur < 15) return null;
        return {
          id: `openverse-${t.id}`,
          source: 'openverse',
          provider: t.provider || 'Openverse',
          playback: 'web-audio-dsp',
          mixReady: isOpen,
          dspReady: isOpen,
          title: t.title || 'Untitled',
          artist: t.creator || 'Creator',
          artwork: t.thumbnail || '',
          streamUrl: t.url,
          landingUrl: t.foreign_landing_url || '',
          durationSec: dur,
          duration: dur,
          energy: 6,
          entrySec: Math.min(16, Math.round(dur * 0.1)),
          exitSec: Math.max(25, Math.round(dur * 0.85)),
          playFull: false,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  const query = getQueryParams(req);
  const q = String(query.q || '').trim().slice(0, 140);
  if (!q) {
    return sendJson(res, 400, { ok: false, error: 'Search query required', results: [] });
  }
  const limit = Math.min(20, Math.max(1, Number(query.limit) || 12));
  const provider = String(query.provider || 'all').toLowerCase();

  const tasks = [];
  if (provider === 'all' || provider === 'audius') tasks.push(queryAudius(q, limit));
  else tasks.push(Promise.resolve([]));

  if (provider === 'all' || provider === 'openverse') tasks.push(queryOpenverse(q, Math.min(8, limit)));
  else tasks.push(Promise.resolve([]));

  tasks.push(searchCachedTracks(q, 8));

  const [audius, openverse, cached] = await Promise.all(tasks);
  const seen = new Set();
  const merged = [...audius, ...cached, ...openverse].filter((item) => {
    const key = `${item.title}|${item.artist}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return sendJson(
    res,
    200,
    {
      ok: true,
      query: q,
      count: merged.length,
      providers: {
        audius: audius.length > 0,
        openverse: openverse.length > 0,
        database: cached.length > 0,
      },
      results: merged,
    },
    's-maxage=120, stale-while-revalidate=300'
  );
}
