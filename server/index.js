import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getAdsbData, getAisData, getProviderStatus } from './providers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = config.publicDir;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const normalizedPath = path.normalize(requestedPath).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(publicDir, normalizedPath);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    });
    res.end(buffer);
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: 'Missing URL' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = url;

  try {
    if (pathname === '/api/status') {
      sendJson(res, 200, {
        ok: true,
        serverTime: new Date().toISOString(),
        providers: getProviderStatus(),
      });
      return;
    }

    if (pathname === '/api/adsb') {
      const bbox = searchParams.get('bbox') || '-180,-85,180,85';
      const payload = await getAdsbData(bbox);
      sendJson(res, 200, payload);
      return;
    }

    if (pathname === '/api/ais') {
      const bbox = searchParams.get('bbox') || '-180,-85,180,85';
      const payload = await getAisData(bbox);
      sendJson(res, 200, payload);
      return;
    }

    if (pathname === '/api/traffic') {
      const bbox = searchParams.get('bbox') || '-180,-85,180,85';
      const [adsb, ais] = await Promise.all([getAdsbData(bbox), getAisData(bbox)]);
      sendJson(res, 200, {
        updatedAt: new Date().toISOString(),
        bbox,
        counts: {
          aircraft: adsb.entities.length,
          vessels: ais.entities.length,
          total: adsb.entities.length + ais.entities.length,
        },
        providers: {
          adsb: { provider: adsb.provider, meta: adsb.sourceMeta },
          ais: { provider: ais.provider, meta: ais.sourceMeta },
        },
        entities: [...adsb.entities, ...ais.entities],
      });
      return;
    }

    serveStatic(req, res, pathname);
  } catch (error) {
    sendJson(res, 500, {
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

server.listen(config.port, () => {
  console.log(`Live Viewer running at http://localhost:${config.port}`);
  console.log(`Serving static files from ${publicDir}`);
});
