const UPSTREAM = 'https://nova-source-archive-nov9.vercel.app';

module.exports = async function handler(req, res) {
  try {
    const requestUrl = new URL(req.url, 'https://nova-ai-dj.vercel.app');
    let upstreamPath = requestUrl.searchParams.get('path') || '/';
    if (!upstreamPath.startsWith('/')) upstreamPath = '/' + upstreamPath;

    const upstreamUrl = new URL(upstreamPath, UPSTREAM);
    requestUrl.searchParams.forEach((value, key) => {
      if (key !== 'path') upstreamUrl.searchParams.append(key, value);
    });

    const headers = {};
    for (const key of ['accept', 'accept-language', 'range', 'if-modified-since']) {
      if (req.headers[key]) headers[key] = req.headers[key];
    }

    const init = { method: req.method, headers, redirect: 'follow' };
    if (!['GET', 'HEAD'].includes(req.method) && req.body !== undefined) {
      init.body = typeof req.body === 'string' || Buffer.isBuffer(req.body)
        ? req.body
        : JSON.stringify(req.body);
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    }

    const upstream = await fetch(upstreamUrl.toString(), init);
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    let body = Buffer.from(await upstream.arrayBuffer());

    if (
      req.method !== 'HEAD' &&
      upstream.status >= 200 &&
      upstream.status < 300 &&
      (upstreamPath === '/' || upstreamPath === '/index.html') &&
      contentType.toLowerCase().includes('text/html')
    ) {
      let html = body.toString('utf8');
      if (!html.includes('/youtube-integration.js')) {
        const scriptTag = '<script src="/youtube-integration.js" defer></script>';
        const bodyEnd = html.toLowerCase().lastIndexOf('</body>');
        html = bodyEnd >= 0
          ? html.slice(0, bodyEnd) + scriptTag + html.slice(bodyEnd)
          : html + scriptTag;
      }
      body = Buffer.from(html, 'utf8');
    }

    res.statusCode = upstream.status;
    res.setHeader('Content-Type', contentType);
    for (const key of ['cache-control', 'last-modified', 'accept-ranges', 'content-range']) {
      const value = upstream.headers.get(key);
      if (value) res.setHeader(key, value);
    }
    res.setHeader('X-NOVA-Source', 'preserved');
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  } catch (error) {
    return res.status(502).json({
      error: 'NOVA source proxy failed',
      message: 'The original site remains preserved at https://nova-source-archive-nov9.vercel.app/.'
    });
  }
};