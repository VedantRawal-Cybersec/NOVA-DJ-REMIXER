import { getQueryParams, handlePreflight, sendJson } from './_lib/http.js';
import {
  getCachedPlaylist,
  getTracksByIds,
  saveCachedPlaylist,
  upsertTracks,
} from './_lib/db.js';
import {
  fetchSingleYouTubePublic,
  fetchSingleYouTubeTrack,
  fetchYouTubePlaylistPublic,
  fetchYouTubePlaylistTracks,
  parseYouTubeInput,
  sanitizeApiKey,
  searchYouTubePublic,
  searchYouTubeTracks,
} from './_lib/youtube.js';

function mergeCachedTrackData(tracks, cachedMap) {
  return tracks.map((t) => {
    const c = cachedMap[t.id];
    if (!c) return t;
    return {
      ...t,
      bpm: c.bpm ?? t.bpm,
      key: c.key ?? t.key,
      camelot: c.camelot ?? t.camelot,
      energy: c.energy ?? t.energy,
      entrySec: Number.isFinite(Number(c.entrySec)) ? c.entrySec : t.entrySec,
      exitSec: Number.isFinite(Number(c.exitSec)) ? c.exitSec : t.exitSec,
      playFull: typeof c.playFull === 'boolean' ? c.playFull : t.playFull,
      heat: Array.isArray(c.heat) ? c.heat : t.heat,
      cueVotes: c.cueVotes || t.cueVotes || 0,
      cueConfidence: c.cueConfidence || t.cueConfidence,
    };
  });
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const query = getQueryParams(req);
  const rawInput = String(query.url || query.q || query.playlistId || query.videoId || '').trim();
  const limit = Math.max(1, Math.min(25, Number.parseInt(query.limit || '15', 10) || 15));
  const maxItems = Math.max(10, Math.min(200, Number.parseInt(query.maxItems || '150', 10) || 150));
  const refresh = query.refresh === '1' || query.refresh === 'true';

  if (!rawInput) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Paste a YouTube playlist URL, video URL, or enter a search query.',
    });
  }

  const parsed = parseYouTubeInput(rawInput);
  if (parsed.kind === 'empty') {
    return sendJson(res, 400, { ok: false, error: 'Empty YouTube input.' });
  }

  if (parsed.kind === 'playlist' && !refresh) {
    const cachedPlaylist = await getCachedPlaylist(parsed.playlistId, 24);
    if (cachedPlaylist && Array.isArray(cachedPlaylist.results) && cachedPlaylist.results.length) {
      const cachedMap = await getTracksByIds(cachedPlaylist.results.map((t) => t.id));
      return sendJson(
        res,
        200,
        {
          ok: true,
          kind: 'playlist',
          ...cachedPlaylist,
          results: mergeCachedTrackData(cachedPlaylist.results, cachedMap),
        },
        's-maxage=120, stale-while-revalidate=300'
      );
    }
  }

  const apiKey = sanitizeApiKey(process.env.YOUTUBE_API_KEY);
  const useApiKey = apiKey.length >= 20 && /^AIza/i.test(apiKey);

  try {
    if (parsed.kind === 'playlist') {
      let playlist = null;
      if (useApiKey) {
        try {
          playlist = await fetchYouTubePlaylistTracks(parsed.playlistId, apiKey, maxItems);
        } catch (err) {
          console.warn('YouTube Data API playlist fallback triggered:', err?.message);
        }
      }
      if (!playlist || !playlist.results?.length) {
        playlist = await fetchYouTubePlaylistPublic(parsed.playlistId, maxItems);
      }
      if (!playlist.results.length) {
        return sendJson(res, 404, {
          ok: false,
          kind: 'playlist',
          error: 'No playable videos found in this playlist (it may be private or empty).',
        });
      }
      await upsertTracks(playlist.results);
      await saveCachedPlaylist(playlist);
      const cachedMap = await getTracksByIds(playlist.results.map((t) => t.id));
      return sendJson(
        res,
        200,
        {
          ok: true,
          kind: 'playlist',
          ...playlist,
          results: mergeCachedTrackData(playlist.results, cachedMap),
        },
        's-maxage=120, stale-while-revalidate=300'
      );
    }

    if (parsed.kind === 'video') {
      let track = null;
      if (useApiKey) {
        try {
          track = await fetchSingleYouTubeTrack(parsed.videoId, apiKey);
        } catch (err) {
          if (err?.status === 422) {
            return sendJson(res, 422, { ok: false, error: err.message });
          }
          console.warn('YouTube Data API single-video fallback triggered:', err?.message);
        }
      }
      if (!track) {
        track = await fetchSingleYouTubePublic(parsed.videoId);
      }
      await upsertTracks([track]);
      const cachedMap = await getTracksByIds([track.id]);
      return sendJson(
        res,
        200,
        {
          ok: true,
          kind: 'video',
          count: 1,
          results: mergeCachedTrackData([track], cachedMap),
        },
        's-maxage=120, stale-while-revalidate=300'
      );
    }

    // Search query
    let tracks = null;
    if (useApiKey) {
      try {
        tracks = await searchYouTubeTracks(parsed.query, apiKey, limit);
      } catch (err) {
        console.warn('YouTube Data API search fallback triggered:', err?.message);
      }
    }
    if (!tracks || !tracks.length) {
      tracks = await searchYouTubePublic(parsed.query, limit);
    }
    await upsertTracks(tracks);
    const cachedMap = await getTracksByIds(tracks.map((t) => t.id));
    return sendJson(
      res,
      200,
      {
        ok: true,
        kind: 'search',
        query: parsed.query,
        count: tracks.length,
        results: mergeCachedTrackData(tracks, cachedMap),
      },
      's-maxage=120, stale-while-revalidate=300'
    );
  } catch (err) {
    console.error('YouTube handler error:', err?.message);
    return sendJson(res, 502, {
      ok: false,
      error: err?.message || 'YouTube search/playlist failed.',
    });
  }
}
