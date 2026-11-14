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

const NON_MUSIC_RE = /\b(sfx|sound\s*effect|foley|ambience|ambient\s*noise|field\s*recording|white\s*noise|pink\s*noise|brown\s*noise|rain\s*sound|thunderstorm|doorbell|footsteps|siren\s*effect|ringtone|asmr|test\s*tone|sine\s*wave|drum\s*kit|sample\s*pack|one[\s-]shot|loop\s*pack|podcast\s*episode|audiobook|guided\s*meditation|spoken\s*word)\b/i;
const TITLE_SPAM_RE = /\s*(?:\((?:[^)]*(?:mp3cut|audiotrimmer|y2mate|ytmp3|pagalworld|pagalnew|djpunjab|mr-jatt|320\s*kbps|latest\s+.*songs?|new\s+.*songs?|official\s+(?:music\s+)?(?:video|audio|lyric(?:s)?)|full\s+(?:song|video|audio|album)|hd|hq|4k|free\s+download|no\s+copyright|royalty\s+free)[^)]*)\)|\[(?:[^\]]*(?:mp3cut|bpm|\d{2,3}\s*kbps|official|lyric(?:s)?|full\s*song|hd|hq|4k|free\s*download)[^\]]*)\])/gi;

function cleanCatalogueTrack(rawTitle, rawArtist) {
  let artist = String(rawArtist || '')
    .replace(/\s+/g, ' ')
    .replace(/(?:\.mp3|\.wav|\.flac|\.m4a|\.ogg)$/i, '')
    .trim();

  let title = String(rawTitle || 'Untitled')
    .replace(/[_]+/g, ' ')
    .replace(TITLE_SPAM_RE, '')
    .replace(/\s*(?:\||::)\s*(?:latest|new|full|official|hd|4k|t-series|zee music|speed records|saregama|sony music).*$/i, '')
    .replace(/(?:\.mp3|\.wav|\.flac|\.m4a|\.ogg)$/i, '')
    .replace(/^\d{1,2}\s*[-–.)]\s+(?=[A-Za-z\u0900-\u097F])/, '')
    .replace(/\b(?:Latest|New)\s+(?:Punjabi|Bollywood|Hindi|Tamil|English)\s+Songs?\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–|:]+|[\s\-–|:]+$/g, '')
    .trim();

  const dashSplit = title.match(/^(.{2,42}?)\s+[-–]\s+(.{2,})$/);
  if (dashSplit) {
    const left = dashSplit[1].trim();
    const right = dashSplit[2].trim();
    if (artist && left.toLowerCase() === artist.toLowerCase()) {
      title = right;
    } else if (!artist || /^(untitled|unknown|independent artist|creator)$/i.test(artist)) {
      artist = left;
      title = right;
    }
  }

  if (!title || title.length < 2) title = String(rawTitle || 'Untitled').replace(/[_]+/g, ' ').trim();
  if (!artist) artist = 'Independent Artist';
  return { title, artist };
}

function isRealMusicTrack({ title = '', genre = '', durationSec = 0, source = '', provider = '' }) {
  if (durationSec < (source === 'openverse' ? 45 : 35)) return false;
  if (durationSec > 600) return false;
  if (/^(podcast|audiobook|spoken\s*word|comedy|news)/i.test(String(genre || '').trim())) return false;
  if (source === 'openverse' && /freesound/i.test(String(provider || '')) && durationSec < 60) return false;
  if (NON_MUSIC_RE.test(title) || NON_MUSIC_RE.test(genre)) return false;
  return true;
}

async function fetchAudiusList(endpoint, genre = '') {
  const data = await fetchWithTimeout(endpoint, 6500);
  const list = Array.isArray(data?.data) ? data.data : [];
  return list
    .filter((t) => t && t.id && t.is_streamable !== false && Number(t.duration) >= 35 && Number(t.duration) <= 600)
    .map((t) => {
      const dur = Number(t.duration) || 180;
      const art = t.artwork?.['480x480'] || t.artwork?.['150x150'] || '';
      const clean = cleanCatalogueTrack(t.title, t.user?.name || 'Independent Artist');
      if (!isRealMusicTrack({ title: clean.title, genre: t.genre || genre, durationSec: dur, source: 'audius' })) {
        return null;
      }
      return {
        id: `audius-${t.id}`,
        source: 'audius',
        provider: 'Audius Full DSP',
        playback: 'web-audio-dsp',
        mixReady: true,
        dspReady: true,
        title: clean.title,
        artist: clean.artist,
        artwork: art,
        streamUrl: `https://discoveryprovider.audius.co/v1/tracks/${encodeURIComponent(t.id)}/stream?app_name=nova-ai-dj`,
        landingUrl: t.permalink ? `https://audius.co${t.permalink}` : 'https://audius.co',
        durationSec: dur,
        duration: dur,
        bpm: Number(t.bpm) || null,
        genre: t.genre || genre || '',
        mood: t.mood || '',
        energy: 7,
        entrySec: Math.min(Math.round(dur * 0.14), 24),
        exitSec: Math.max(30, Math.round(dur * 0.84)),
        playFull: false,
      };
    })
    .filter(Boolean);
}

async function queryAudius(q, limit, offset = 0, { genre = '', mode = 'search' } = {}) {
  try {
    const fetchLimit = Math.min(50, Math.max(limit * 2, 36));
    let items = [];
    if (mode === 'trending' || !q) {
      const trendUrl = `https://discoveryprovider.audius.co/v1/tracks/trending?${genre ? `genre=${encodeURIComponent(genre)}&` : ''}limit=${fetchLimit}&offset=${offset}&app_name=nova-ai-dj`;
      items = await fetchAudiusList(trendUrl, genre).catch(() => []);
    }
    const fallbackQ = q || genre || 'electronic';
    if (items.length < limit && fallbackQ) {
      const searchUrl = `https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(fallbackQ)}&limit=${fetchLimit}&offset=${offset}&app_name=nova-ai-dj`;
      const searched = await fetchAudiusList(searchUrl, genre).catch(() => []);
      const seen = new Set(items.map((i) => i.id));
      for (const it of searched) {
        if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
      }
    }
    // Audius search ANDs all tokens; broaden multi-word user queries when strict phrase returns sparse results
    if (q && items.length < Math.min(limit, 18)) {
      const words = q.split(/\s+/).filter((w) => w.length >= 3 && !/^(song|songs|hits|hit|mix|music|track)$/i.test(w)).slice(0, 2);
      if (words.length > 0 && words[0].toLowerCase() !== q.toLowerCase()) {
        const extraLists = await Promise.all(
          words.map((w) =>
            fetchAudiusList(
              `https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(w)}&limit=${fetchLimit}&offset=${offset}&app_name=nova-ai-dj`,
              genre
            ).catch(() => [])
          )
        );
        const seen = new Set(items.map((i) => i.id));
        for (const list of extraLists) {
          for (const it of list) {
            if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
          }
        }
      }
    }
    return items.slice(0, limit);
  } catch {
    return [];
  }
}

async function queryOpenverse(q, limit, page = 1) {
  try {
    const data = await fetchWithTimeout(
      `https://api.openverse.org/v1/audio/?q=${encodeURIComponent(q)}&page=${page}&page_size=${limit}&mature=false`,
      5500
    );
    const list = Array.isArray(data?.results) ? data.results : [];
    return list
      .map((t) => {
        const lic = String(t.license || '').toLowerCase();
        const isOpen = lic === 'by' || lic === 'by-sa' || lic === 'cc0';
        const isJamendo = /jamendo\.com/i.test(String(t.url || ''));
        let dur = Number(t.duration) || 0;
        if (dur > 10000) dur = Math.round(dur / 1000);
        const clean = cleanCatalogueTrack(t.title, t.creator || 'Creator');
        if (
          !t.url ||
          !isOpen ||
          isJamendo ||
          !isRealMusicTrack({ title: clean.title, durationSec: dur, source: 'openverse', provider: t.provider })
        ) return null;
        return {
          id: `openverse-${t.id}`,
          source: 'openverse',
          provider: `${t.provider || 'Openverse'} CC`,
          playback: 'web-audio-dsp',
          mixReady: true,
          dspReady: true,
          title: clean.title,
          artist: clean.artist,
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

async function queryItunes(q, limit) {
  try {
    if (!q) return [];
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=${Math.min(50, limit * 2)}`;
    const data = await fetchWithTimeout(url, 4500);
    const list = Array.isArray(data?.results) ? data.results : [];
    return list
      .filter((t) => t && t.trackId && t.previewUrl)
      .map((t) => {
        const clean = cleanCatalogueTrack(t.trackName, t.artistName);
        const art = t.artworkUrl100?.replace('100x100bb', '600x600bb') || t.artworkUrl100 || '';
        return {
          id: `itunes-${t.trackId}`,
          source: 'itunes',
          provider: 'Apple Music Audio Stream',
          playback: 'web-audio-dsp',
          mixReady: true,
          dspReady: true,
          title: clean.title,
          artist: clean.artist,
          artwork: art,
          streamUrl: t.previewUrl,
          landingUrl: t.trackViewUrl || 'https://music.apple.com',
          durationSec: 30,
          duration: 30,
          bpm: null,
          genre: t.primaryGenreName || 'Music',
          energy: 7,
          entrySec: 0,
          exitSec: 28,
          playFull: false,
        };
      });
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  const query = getQueryParams(req);
  const q = String(query.q || '').trim().slice(0, 140);
  const genre = String(query.genre || '').trim().slice(0, 60);
  const mode = String(query.mode || 'search').toLowerCase();
  if (!q && !genre && mode !== 'trending') {
    return sendJson(res, 400, { ok: false, error: 'Search query or genre required', results: [] });
  }
  const page = Math.max(1, Math.min(50, Number(query.page) || 1));
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 24));
  const offset = (page - 1) * limit;
  const provider = String(query.provider || 'all').toLowerCase();
  const effectiveQ = q || genre || 'Electronic';

  const tasks = [];
  if (provider === 'all' || provider === 'audius' || provider === 'trending') {
    tasks.push(queryAudius(effectiveQ, limit, offset, { genre, mode: mode === 'trending' || provider === 'trending' ? 'trending' : 'search' }));
  } else {
    tasks.push(Promise.resolve([]));
  }

  if ((provider === 'all' || provider === 'openverse') && mode !== 'trending') {
    tasks.push(queryOpenverse(effectiveQ, Math.min(20, limit), page));
  } else {
    tasks.push(Promise.resolve([]));
  }

  if ((provider === 'all' || provider === 'itunes') && mode !== 'trending') {
    tasks.push(queryItunes(effectiveQ, Math.min(20, limit)));
  } else {
    tasks.push(Promise.resolve([]));
  }

  tasks.push(page === 1 ? searchCachedTracks(effectiveQ, 8) : Promise.resolve([]));

  const [audius, openverse, itunes, cached] = await Promise.all(tasks);
  const seen = new Set();
  const merged = [...audius, ...itunes, ...cached, ...openverse].filter((item) => {
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
      query: effectiveQ,
      genre,
      page,
      limit,
      hasMore: audius.length >= Math.min(limit, 15) || openverse.length >= 10 || itunes.length >= 10,
      count: merged.length,
      providers: {
        audius: audius.length > 0,
        itunes: itunes.length > 0,
        openverse: openverse.length > 0,
        database: cached.length > 0,
      },
      results: merged,
    },
    's-maxage=120, stale-while-revalidate=300'
  );
}
