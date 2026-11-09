function send(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { error: 'Method not allowed' });
  }

  const query = String(req.query.q || '').trim().slice(0, 160);
  const limit = Math.max(1, Math.min(12, Number.parseInt(req.query.limit || '10', 10) || 10));
  if (!query) return send(res, 400, { error: 'Enter a song, artist, remix or genre.' });

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return send(res, 503, {
      setupRequired: true,
      error: 'YouTube search is not configured.',
      message: 'Add YOUTUBE_API_KEY to this Vercel project’s Production environment. Pasted YouTube links can still be played in the embedded player.'
    });
  }

  try {
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.search = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      q: query,
      maxResults: String(limit),
      videoEmbeddable: 'true',
      videoSyndicated: 'true',
      safeSearch: 'moderate',
      regionCode: 'IN',
      key: apiKey
    }).toString();

    const searchResponse = await fetch(searchUrl);
    const searchData = await searchResponse.json();
    if (!searchResponse.ok) {
      const reason = searchData?.error?.errors?.[0]?.reason;
      return send(res, 502, {
        error: reason === 'quotaExceeded'
          ? 'YouTube search quota has been reached. Try again later or review the Google Cloud quota.'
          : 'YouTube search failed. Check the API key and YouTube Data API v3 restrictions.',
        code: reason || 'youtube_api_error'
      });
    }

    const items = Array.isArray(searchData.items) ? searchData.items : [];
    const ids = items.map(item => item?.id?.videoId).filter(Boolean);
    const videoDetails = {};

    if (ids.length) {
      const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
      detailsUrl.search = new URLSearchParams({
        part: 'contentDetails,status',
        id: ids.join(','),
        key: apiKey
      }).toString();

      const detailsResponse = await fetch(detailsUrl);
      if (detailsResponse.ok) {
        const detailsData = await detailsResponse.json();
        for (const video of detailsData.items || []) videoDetails[video.id] = video;
      }
    }

    const results = items.map(item => {
      const videoId = item?.id?.videoId;
      const snippet = item?.snippet || {};
      const details = videoDetails[videoId] || {};
      if (!videoId || details.status?.embeddable === false) return null;

      const thumbnails = snippet.thumbnails || {};
      return {
        videoId,
        title: snippet.title || 'Untitled video',
        channelTitle: snippet.channelTitle || 'YouTube creator',
        publishedAt: snippet.publishedAt || '',
        thumbnail:
          thumbnails.high?.url ||
          thumbnails.medium?.url ||
          thumbnails.default?.url ||
          '',
        duration: details.contentDetails?.duration || '',
        url: 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId),
        source: 'YouTube',
        playback: 'embedded-player'
      };
    }).filter(Boolean);

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).end(JSON.stringify({
      query,
      provider: 'YouTube Data API v3',
      count: results.length,
      results,
      nextPageToken: searchData.nextPageToken || null
    }));
  } catch (error) {
    return send(res, 502, {
      error: 'YouTube search is temporarily unavailable. Please try again.'
    });
  }
};