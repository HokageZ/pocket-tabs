'use strict';
// Per-window server, bound to 127.0.0.1 on a random port. Only the gateway talks to it.
const http = require('http');
const { HttpError, readJson, sendJson, safeEqual } = require('./httpUtil');

function startInstanceServer({ bridge, store, log }) {
  const server = http.createServer(async (req, res) => {
    try {
      if (!safeEqual(req.headers['x-pocket-key'], store.token())) throw new HttpError(401, 'Bad key');
      const url = new URL(req.url, 'http://127.0.0.1');
      const q = url.searchParams;
      let out;
      switch (req.method + ' ' + url.pathname) {
        case 'GET /state':
          out = bridge.getState();
          break;
        case 'GET /collab/open':
          out = await bridge.collabOpen(q.get('uri'), q.get('client'), q.get('device'));
          break;
        case 'GET /collab/pull':
          out = await bridge.collabPull(q.get('uri'), q.get('version'));
          break;
        case 'GET /collab/blame':
          out = await bridge.collabBlame(q.get('uri'));
          break;
        case 'POST /collab/push':
          out = await bridge.collabPush(await readJson(req, 64 << 20));
          break;
        case 'POST /collab/save':
          out = await bridge.collabSave(await readJson(req));
          break;
        case 'POST /collab/presence':
          out = await bridge.collabPresence(await readJson(req));
          break;
        case 'POST /reveal':
          out = await bridge.reveal(await readJson(req));
          break;
        case 'GET /asset': {
          const a = await bridge.getAsset(q.get('doc'), q.get('path'));
          res.writeHead(200, { 'Content-Type': a.type, 'Content-Length': a.buf.length });
          res.end(a.buf);
          return;
        }
        default:
          throw new HttpError(404, 'Not found');
      }
      sendJson(res, 200, out);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log.error(`[window] ${req.method} ${req.url}: ${e.stack || e.message}`);
      sendJson(res, status, { error: e.message || 'Internal error', ...(e.extra || {}) });
    }
  });
  server.keepAliveTimeout = 10000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

module.exports = { startInstanceServer };
