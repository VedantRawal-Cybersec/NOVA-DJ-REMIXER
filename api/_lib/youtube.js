const JUNK_PARENS = /^(?:feat\.?|ft\.?|featuring|from|official|video|audio|lyrics?|lyrical|full\s+song|full\s+video|4k|hd|hq|original\s+motion\s+picture(?:\s+soundtrack)?|video\s+song|audio\s+song|music\s+video)\b/i;
const LANG_ONLY_PARENS = /^(?:hindi|punjabi|english|tamil|telugu|gujarati|bhojpuri|haryanvi|marathi|bengali|kannada|malayalam)(?:\s*[+/&,]\s*(?:hindi|punjabi|english|tamil|telugu|gujarati|bhojpuri|haryanvi|marathi|bengali|kannada|malayalam))*(?:\s+(?:version|ver\.?))?$/i;
const TRAILING_TAGS = /\s*(?:\||::|—|-)\s*(?:official\s+(?:music\s+)?(?:video|audio|song)|full\s+(?:video|song|audio)|lyrical(?:\s+video)?|t-series|zee music|yrf|sony music|tips official|speed records|saregama).*$/i;

export function cleanTrackMetadata(rawTitle, channelTitle = '') {
  const cleanedChannel = String(channelTitle || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*VEVO$/i, '')
    .replace(/\s*Official$/i, '')
    .trim();

  let t = String(rawTitle || 'Untitled')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*\(([^)]*)\)/g, (full, inner) =>
      JUNK_PARENS.test(inner.trim()) || LANG_ONLY_PARENS.test(inner.trim()) ? '' : full
    )
    .replace(TRAILING_TAGS, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  let artist = cleanedChannel || 'YouTube';
  let title = t || String(rawTitle || 'Untitled');

  const dashMatch = title.match(/^(.{2,45}?)\s+[-–—:]\s+(.{2,})$/);
  if (dashMatch) {
    const left = dashMatch[1].trim();
    const right = dashMatch[2].trim();
    if (!/^(official|full|new|latest|best|top)/i.test(left)) {
      artist = left;
      title = right;
    }
  }

  return { title, artist };
}

export function parseIsoDuration(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

export function parseYouTubeInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return { kind: 'empty' };

  if (/^(?:PL|OLAK5uy_|UU|LL|RD)[A-Za-z0-9_-]{8,}$/.test(raw)) {
    return { kind: 'playlist', playlistId: raw };
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) {
    return { kind: 'video', videoId: raw };
  }

  try {
    const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    const isYt = host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
    if (!isYt) return { kind: 'query', query: raw };

    const listId = url.searchParams.get('list');
    let videoId = null;

    if (host === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0] || null;
    } else if (url.pathname === '/watch') {
      videoId = url.searchParams.get('v');
    } else {
      const parts = url.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) {
        videoId = parts[1] || null;
      }
    }

    if (listId && (url.pathname.includes('/playlist') || listId.startsWith('PL') || listId.startsWith('OLAK') || listId.startsWith('UU') || !videoId)) {
      return { kind: 'playlist', playlistId: listId, videoId };
    }
    if (videoId) {
      return { kind: 'video', videoId, playlistId: listId || null };
    }
    if (listId) {
      return { kind: 'playlist', playlistId: listId };
    }
  } catch {
    // Plain text search query
  }

  return { kind: 'query', query: raw };
}

async function fetchYtJson(endpoint, params, apiKey) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, {
    headers: { 'x-goog-api-key': apiKey },
  });
  const data = await response.json();
  if (!response.ok) {
    const reason = data?.error?.errors?.[0]?.reason || 'youtube_api_error';
    const message = data?.error?.message || 'YouTube Data API rejected the request.';
    const error = new Error(message);
    error.code = reason;
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function fetchVideoDetailsBatch(videoIds, apiKey) {
  const detailsMap = {};
  const unique = [...new Set(videoIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const data = await fetchYtJson(
      'videos',
      { part: 'snippet,contentDetails,status', id: chunk.join(',') },
      apiKey
    );
    for (const v of data.items || []) {
      detailsMap[v.id] = v;
    }
  }
  return detailsMap;
}

function buildTrackRecord(videoId, snippet, details, cachedTrack) {
  const durationSec = parseIsoDuration(details?.contentDetails?.duration || '') || cachedTrack?.durationSec || 210;
  const thumbs = snippet?.thumbnails || details?.snippet?.thumbnails || {};
  const artwork =
    thumbs.maxres?.url ||
    thumbs.high?.url ||
    thumbs.medium?.url ||
    thumbs.default?.url ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const { title, artist } = cleanTrackMetadata(
    snippet?.title || details?.snippet?.title || 'Untitled',
    snippet?.channelTitle || details?.snippet?.channelTitle || ''
  );

  // Smart default hook/cue estimate until Essentia/user drag refines it
  const safeDur = Math.max(30, durationSec);
  const defaultEntry = cachedTrack?.entrySec ?? Math.min(Math.round(safeDur * 0.22), 45);
  const defaultExit = cachedTrack?.exitSec ?? Math.max(defaultEntry + 42, Math.round(safeDur * 0.78));

  return {
    id: `yt-${videoId}`,
    videoId,
    youtubeIds: [videoId],
    source: 'youtube',
    provider: 'YouTube',
    playback: 'youtube-iframe',
    mixReady: true,
    dspReady: false,
    title,
    rawTitle: snippet?.title || title,
    artist,
    channelTitle: snippet?.channelTitle || details?.snippet?.channelTitle || 'YouTube',
    artwork,
    durationSec: safeDur,
    duration: safeDur,
    entrySec: defaultEntry,
    exitSec: Math.min(safeDur - 3, defaultExit),
    playFull: Boolean(cachedTrack?.playFull),
    bpm: cachedTrack?.bpm || null,
    key: cachedTrack?.key || null,
    camelot: cachedTrack?.camelot || null,
    energy: cachedTrack?.energy || 7,
    heat: cachedTrack?.heat || null,
    cueVotes: cachedTrack?.cueVotes || 0,
    cueConfidence: cachedTrack?.cueConfidence || 'auto',
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    landingUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
  };
}

export async function searchYouTubeTracks(query, apiKey, limit = 12) {
  let searchData = await fetchYtJson(
    'search',
    {
      part: 'snippet',
      type: 'video',
      q: query,
      maxResults: String(Math.min(25, Math.max(1, limit))),
      videoEmbeddable: 'true',
      videoCategoryId: '10',
      safeSearch: 'none',
    },
    apiKey
  );

  let items = Array.isArray(searchData.items) ? searchData.items : [];
  if (items.length < 4) {
    searchData = await fetchYtJson(
      'search',
      {
        part: 'snippet',
        type: 'video',
        q: query,
        maxResults: String(Math.min(25, Math.max(1, limit))),
        videoEmbeddable: 'true',
      },
      apiKey
    );
    items = Array.isArray(searchData.items) ? searchData.items : [];
  }

  const ids = items.map((x) => x?.id?.videoId).filter(Boolean);
  const detailsMap = ids.length ? await fetchVideoDetailsBatch(ids, apiKey) : {};

  return items
    .map((item) => {
      const videoId = item?.id?.videoId;
      if (!videoId) return null;
      const details = detailsMap[videoId];
      if (details?.status?.embeddable === false) return null;
      return buildTrackRecord(videoId, item.snippet, details, null);
    })
    .filter(Boolean);
}

export async function fetchYouTubePlaylistTracks(playlistId, apiKey, maxItems = 150) {
  let playlistMeta = { title: 'YouTube Playlist', channel: 'YouTube', artwork: '' };
  try {
    const metaResp = await fetchYtJson(
      'playlists',
      { part: 'snippet,contentDetails', id: playlistId },
      apiKey
    );
    const p = metaResp.items?.[0];
    if (p?.snippet) {
      const th = p.snippet.thumbnails || {};
      playlistMeta = {
        title: p.snippet.title || 'YouTube Playlist',
        channel: p.snippet.channelTitle || 'YouTube',
        artwork: th.high?.url || th.medium?.url || th.default?.url || '',
      };
    }
  } catch {
    // Radio/Mix playlists (RD...) may not expose playlists.list metadata; playlistItems still works!
  }

  const rawItems = [];
  let pageToken = '';
  const maxPages = Math.ceil(maxItems / 50);

  for (let page = 0; page < maxPages; page++) {
    const params = {
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: '50',
    };
    if (pageToken) params.pageToken = pageToken;
    const pageData = await fetchYtJson('playlistItems', params, apiKey);
    const items = Array.isArray(pageData.items) ? pageData.items : [];
    rawItems.push(...items);
    pageToken = pageData.nextPageToken || '';
    if (!pageToken || rawItems.length >= maxItems) break;
  }

  const validItems = rawItems.filter((item) => {
    const vid = item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId;
    const title = item?.snippet?.title || '';
    return Boolean(vid) && title !== 'Deleted video' && title !== 'Private video';
  }).slice(0, maxItems);

  const ids = validItems.map((item) => item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId);
  const detailsMap = ids.length ? await fetchVideoDetailsBatch(ids, apiKey) : {};

  const tracks = validItems
    .map((item) => {
      const videoId = item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId;
      const details = detailsMap[videoId];
      if (!videoId || details?.status?.embeddable === false) return null;
      return buildTrackRecord(videoId, item.snippet, details, null);
    })
    .filter(Boolean);

  return {
    playlistId,
    ...playlistMeta,
    count: tracks.length,
    results: tracks,
  };
}

export async function fetchSingleYouTubeTrack(videoId, apiKey) {
  const detailsMap = await fetchVideoDetailsBatch([videoId], apiKey);
  const details = detailsMap[videoId];
  if (!details) {
    const err = new Error('Video not found or unavailable.');
    err.status = 404;
    throw err;
  }
  if (details.status?.embeddable === false) {
    const err = new Error('This YouTube video has embedding disabled by the uploader.');
    err.status = 422;
    throw err;
  }
  return buildTrackRecord(videoId, details.snippet, details, null);
}
