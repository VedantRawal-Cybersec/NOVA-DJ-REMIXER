import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const apiDir = path.join(root, 'api');
const port = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
};

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(reqUrl.pathname);

    if (pathname.startsWith('/api/')) {
      const slug = pathname.replace(/^\/api\//, '').replace(/\/+$/, '').replace(/\.js$/, '');
      if (!slug || slug.startsWith('_') || slug.includes('..') || slug.includes('/')) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      const modPath = path.join(apiDir, `${slug}.js`);
      if (!fs.existsSync(modPath)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'API route not found' }));
        return;
      }
      req.query = Object.fromEntries(reqUrl.searchParams.entries());
      const mod = await import(`${pathToFileURL(modPath).href}?t=${Date.now()}`);
      res.status = (code) => {
        res.statusCode = code;
        return res;
      };
      res.json = (obj) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(obj));
      };
      await mod.default(req, res);
      return;
    }

    let filePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
    if (!filePath.startsWith(publicDir)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!fs.existsSync(filePath)) {
      filePath = path.join(publicDir, 'index.html');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('Dev server error:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`NOVA AI DJ v2 local server listening on http://127.0.0.1:${port}`);
});
