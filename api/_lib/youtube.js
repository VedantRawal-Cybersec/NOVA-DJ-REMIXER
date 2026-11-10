const JUNK_PARENS = /^(?:feat\.?|ft\.?|featuring|from|official|video|audio|lyrics?|lyrical|full\s+song|full\s+video|4k|hd|hq|original\s+motion\s+picture(?:\s+soundtrack)?|video\s+song|audio\s+song|music\s+video)\b/i;
const LANG_ONLY_PARENS = /^(?:hindi|punjabi|english|tamil|telugu|gujarati|bhojpuri|haryanvi|marathi|bengali|kannada|malayalam)(?:\s*[+/&,]\s*(?:hindi|punjabi|english|tamil|telugu|gujarati|bhojpuri|haryanvi|marathi|bengali|kannada|malayalam))*(?:\s+(?:version|ver\.?))?$/i;
const TRAILING_TAGS = /\s*(?:\||::|—|-)\s*(?:official\s+(?:music\s+)?(?:video|audio|song)|full\s+(?:video|song|audio)|lyrical(?:\s+video)?|4k(?:\s+video)?|hd\s+video|t-series|zee music|yrf|sony music|tips official|speed records|saregama).*$/i;

const PUBLIC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

export function sanitizeApiKey(raw) {
  return String(raw || '').trim().replace(/^["']|["']$/g, '');
}

export function cleanTrackMetadata(rawTitle, channelTitle = '') {
  const cleanedChannel = String(channelTitle || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*VEVO$/i, '')
    .replace(/\s*Official$/i, '')
    .trim();

  const t = String(rawTitle || 'Untitled')
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

export function parseClockDuration(text) {
  if (!text || typeof text !== 'string') return 0;
  const parts = text.trim().split(':').map((n) => Number.parseInt(n, 10));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
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

function makeTrack({ videoId, rawTitle, channelTitle, durationSec, artwork }) {
  const { title, artist } = cleanTrackMetadata(rawTitle, channelTitle);
  const rawDur = Number(durationSec) || 0;
  const safeDur = rawDur >= 20 && rawDur <= 3600 ? rawDur : 210;
  const defaultEntry = Math.min(Math.round(safeDur * 0.22), 45);
  const defaultExit = Math.min(safeDur - 3, Math.max(defaultEntry + 42, Math.round(safeDur * 0.78)));

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
    rawTitle: rawTitle || title,
    artist,
    channelTitle: channelTitle || 'YouTube',
    artwork: artwork || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSec: safeDur,
    duration: safeDur,
    entrySec: defaultEntry,
    exitSec: defaultExit,
    playFull: false,
    bpm: null,
    key: null,
    camelot: null,
    energy: 7,
    heat: null,
    cueVotes: 0,
    cueConfidence: 'auto',
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    landingUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
  };
}

async function fetchYtJson(endpoint, params, apiKey) {
  const cleanKey = sanitizeApiKey(apiKey);
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  url.search = new URLSearchParams({ ...params, key: cleanKey }).toString();
  const response = await fetch(url);
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

export async function searchYouTubeTracks(query, apiKey, limit = 15) {
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
      const thumbs = item.snippet?.thumbnails || {};
      return makeTrack({
        videoId,
        rawTitle: item.snippet?.title,
        channelTitle: item.snippet?.channelTitle,
        durationSec: parseIsoDuration(details?.contentDetails?.duration || ''),
        artwork: thumbs.maxres?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url,
      });
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
  } catch {}

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

  const validItems = rawItems
    .filter((item) => {
      const vid = item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId;
      const title = item?.snippet?.title || '';
      return Boolean(vid) && title !== 'Deleted video' && title !== 'Private video';
    })
    .slice(0, maxItems);

  const ids = validItems.map((item) => item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId);
  const detailsMap = ids.length ? await fetchVideoDetailsBatch(ids, apiKey) : {};

  const tracks = validItems
    .map((item) => {
      const videoId = item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId;
      const details = detailsMap[videoId];
      if (!videoId || details?.status?.embeddable === false) return null;
      const thumbs = item.snippet?.thumbnails || {};
      return makeTrack({
        videoId,
        rawTitle: item.snippet?.title,
        channelTitle: item.snippet?.channelTitle,
        durationSec: parseIsoDuration(details?.contentDetails?.duration || ''),
        artwork: thumbs.maxres?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url,
      });
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
  const thumbs = details.snippet?.thumbnails || {};
  return makeTrack({
    videoId,
    rawTitle: details.snippet?.title,
    channelTitle: details.snippet?.channelTitle,
    durationSec: parseIsoDuration(details.contentDetails?.duration || ''),
    artwork: thumbs.maxres?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url,
  });
}

/* =====================================================================
   PUBLIC YOUTUBE EXTRACTOR FALLBACK (Zero API Key / Quota Fallback)
   ===================================================================== */
function extractJsonObjectAfter(html, markers) {
  for (const marker of markers) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    const start = html.indexOf('{', idx + marker.length);
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(html.slice(start, i + 1));
            } catch {
              break;
            }
          }
        }
      }
    }
  }
  return null;
}

function extractInitialData(html) {
  return extractJsonObjectAfter(html, [
    'var ytInitialData =',
    'window["ytInitialData"] =',
    'ytInitialData =',
  ]);
}

function extractPlayerResponse(html) {
  return extractJsonObjectAfter(html, [
    'var ytInitialPlayerResponse =',
    'window["ytInitialPlayerResponse"] =',
    'ytInitialPlayerResponse =',
  ]);
}

function extractInnertubeKey(html) {
  const m = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  return m ? m[1] : '';
}

export async function searchYouTubePublic(query, limit = 15) {
  const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
    headers: PUBLIC_HEADERS,
  });
  if (!res.ok) throw new Error(`YouTube search HTTP ${res.status}`);
  const data = extractInitialData(await res.text());
  if (!data) throw new Error('Unable to parse YouTube search results.');

  const renderers = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.videoRenderer?.videoId) renderers.push(node.videoRenderer);
    else if (Array.isArray(node)) node.forEach(walk);
    else Object.values(node).forEach(walk);
  };
  walk(data.contents);

  const seen = new Set();
  return renderers
    .filter((v) => {
      if (!v.videoId || seen.has(v.videoId)) return false;
      seen.add(v.videoId);
      return true;
    })
    .slice(0, limit)
    .map((v) => {
      const rawTitle = v.title?.runs?.map((r) => r.text).join('') || v.title?.simpleText || 'Untitled';
      const channel = v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || 'YouTube';
      const durText = v.lengthText?.simpleText || '';
      const thumbs = v.thumbnail?.thumbnails || [];
      return makeTrack({
        videoId: v.videoId,
        rawTitle,
        channelTitle: channel,
        durationSec: parseClockDuration(durText),
        artwork: thumbs[thumbs.length - 1]?.url,
      });
    });
}

export async function fetchYouTubePlaylistPublic(playlistId, maxItems = 150) {
  const res = await fetch(`https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`, {
    headers: PUBLIC_HEADERS,
  });
  if (!res.ok) throw new Error(`YouTube playlist HTTP ${res.status}`);
  const html = await res.text();
  const data = extractInitialData(html);
  if (!data) throw new Error('Could not parse public playlist page.');

  const playlistTitle = data?.metadata?.playlistMetadataRenderer?.title || 'YouTube Playlist';
  const innertubeKey = extractInnertubeKey(html);
  const tracks = [];
  const seen = new Set();

  const pushTrack = (videoId, rawTitle, channelTitle, durText, artwork) => {
    if (!videoId || seen.has(videoId)) return;
    seen.add(videoId);
    tracks.push(
      makeTrack({
        videoId,
        rawTitle,
        channelTitle,
        durationSec: parseClockDuration(durText),
        artwork,
      })
    );
  };

  let nextToken = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object' || tracks.length >= maxItems) return;
    if (node.playlistVideoRenderer?.videoId) {
      const p = node.playlistVideoRenderer;
      const thumbs = p.thumbnail?.thumbnails || [];
      pushTrack(
        p.videoId,
        p.title?.runs?.map((r) => r.text).join('') || p.title?.simpleText,
        p.shortBylineText?.runs?.[0]?.text || 'YouTube',
        p.lengthText?.simpleText || '',
        thumbs[thumbs.length - 1]?.url
      );
      return;
    }
    if (node.lockupViewModel?.contentId) {
      const l = node.lockupViewModel;
      const meta = l.metadata?.lockupMetadataViewModel;
      const rawTitle = meta?.title?.content || 'Untitled';
      const channel = meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || 'YouTube';
      const badge = l.contentImage?.thumbnailViewModel?.overlays?.[0]?.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel?.text || '';
      const thumbs = l.contentImage?.thumbnailViewModel?.image?.sources || [];
      pushTrack(l.contentId, rawTitle, channel, badge, thumbs[thumbs.length - 1]?.url);
      return;
    }
    if (!nextToken && node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
      nextToken = node.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    }
    if (Array.isArray(node)) node.forEach(walk);
    else Object.values(node).forEach(walk);
  };
  walk(data.contents);

  // Follow public continuation tokens for >100 item playlists
  let pageCount = 0;
  while (nextToken && innertubeKey && tracks.length < maxItems && pageCount < 3) {
    pageCount++;
    const token = nextToken;
    nextToken = null;
    try {
      const cRes = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(innertubeKey)}`, {
        method: 'POST',
        headers: { ...PUBLIC_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion: '2.20240701.00.00' } },
          continuation: token,
        }),
      });
      if (!cRes.ok) break;
      const cData = await cRes.json();
      walk(cData.onResponseReceivedActions || cData.contents);
    } catch {
      break;
    }
  }

  // If playlist page didn't expose renderers (e.g. Mix RD... or Watch playlist), fetch /watch?list=...
  if (!tracks.length) {
    const wRes = await fetch(`https://www.youtube.com/watch?list=${encodeURIComponent(playlistId)}`, {
      headers: PUBLIC_HEADERS,
    });
    if (wRes.ok) {
      const wData = extractInitialData(await wRes.text());
      const walkW = (node) => {
        if (!node || typeof node !== 'object' || tracks.length >= maxItems) return;
        const p = node.playlistPanelVideoRenderer;
        if (p?.videoId) {
          const thumbs = p.thumbnail?.thumbnails || [];
          pushTrack(
            p.videoId,
            p.title?.simpleText || p.title?.runs?.[0]?.text,
            p.shortBylineText?.runs?.[0]?.text || 'YouTube',
            p.lengthText?.simpleText || '',
            thumbs[thumbs.length - 1]?.url
          );
          return;
        }
        if (Array.isArray(node)) node.forEach(walkW);
        else Object.values(node).forEach(walkW);
      };
      walkW(wData);
    }
  }

  return {
    playlistId,
    title: playlistTitle,
    channel: 'YouTube',
    artwork: tracks[0]?.artwork || '',
    count: tracks.length,
    results: tracks,
  };
}

export async function fetchSingleYouTubePublic(videoId) {
  try {
    const watchRes = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
      headers: PUBLIC_HEADERS,
    });
    if (watchRes.ok) {
      const player = extractPlayerResponse(await watchRes.text());
      const vd = player?.videoDetails;
      if (vd?.title) {
        const thumbs = vd.thumbnail?.thumbnails || [];
        const lenSec = vd.isLiveContent ? 210 : (Number(vd.lengthSeconds) || 210);
        return makeTrack({
          videoId,
          rawTitle: vd.title,
          channelTitle: vd.author || 'YouTube',
          durationSec: lenSec,
          artwork: thumbs[thumbs.length - 1]?.url,
        });
      }
    }
  } catch {}

  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
  const res = await fetch(url);
  if (!res.ok) {
    return makeTrack({ videoId, rawTitle: `YouTube Track (${videoId})`, channelTitle: 'YouTube', durationSec: 210 });
  }
  const info = await res.json();
  return makeTrack({
    videoId,
    rawTitle: info.title || `YouTube Track (${videoId})`,
    channelTitle: info.author_name || 'YouTube',
    durationSec: 210,
    artwork: info.thumbnail_url,
  });
}
