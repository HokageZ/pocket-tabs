'use strict';
// The LAN-facing server. Exactly one VS Code window holds the port at a time;
// it serves the phone page and relays requests to every window's local server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { HttpError, readJson, sendJson, requestJson, safeEqual } = require('./httpUtil');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/editor.js': ['editor.js', 'text/javascript; charset=utf-8'],
  '/sync.js': ['sync.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon.png': ['icon.png', 'image/png'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Phone API action -> [method, path on the window's local server] */
const ACTIONS = {
  open: ['GET', '/collab/open'],
  pull: ['GET', '/collab/pull'],
  blame: ['GET', '/collab/blame'],
  push: ['POST', '/collab/push'],
  save: ['POST', '/collab/save'],
  presence: ['POST', '/collab/presence'],
  reveal: ['POST', '/reveal'],
};

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 8;

const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const normalizeCode = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

class Gateway {
  constructor({ store, port, host, mediaDir, log, version }) {
    this.store = store;
    this.port = port;
    this.host = host;
    this.mediaDir = mediaDir;
    this.log = log;
    this.version = version;
    this.cookieName = 'pocket_tabs_' + port;
    this.states = new Map();
    this.clients = new Set();
    this.failures = new Map();
    this.lastSent = '';
    this.server = null;
    this.refreshing = null;
  }

  start() {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => this.handle(req, res));
      const onError = (err) => {
        srv.removeAllListeners();
        resolve({ ok: false, code: err.code, message: err.message });
      };
      srv.once('error', onError);
      srv.listen(this.port, this.host, () => {
        srv.off('error', onError);
        srv.on('error', (err) => this.log.error('Phone server error: ' + err.message));
        this.server = srv;
        this.tick = setInterval(() => this.periodic(), 4000);
        this.keepAlive = setInterval(() => this.broadcastRaw(': ping\n\n'), 15000);
        resolve({ ok: true });
      });
    });
  }

  stop() {
    clearInterval(this.tick);
    clearInterval(this.keepAlive);
    clearTimeout(this.broadcastTimer);
    for (const c of this.clients) {
      try {
        c.end();
      } catch {
        /* closed */
      }
    }
    this.clients.clear();
    if (this.server) {
      this.server.close();
      if (this.server.closeAllConnections) this.server.closeAllConnections();
      this.server = null;
    }
  }

  get phoneCount() {
    return this.clients.size;
  }

  // ---------- auth ----------

  authed(req) {
    const token = this.store.token();
    const c = parseCookies(req.headers.cookie)[this.cookieName];
    if (c && safeEqual(c, token)) return true;
    const a = req.headers.authorization;
    return !!(a && a.startsWith('Bearer ') && safeEqual(a.slice(7).trim(), token));
  }

  cookie(value, maxAge = 31536000) {
    return `${this.cookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
  }

  async login(req, res) {
    const ip = req.socket.remoteAddress || '?';
    const now = Date.now();
    const f = this.failures.get(ip);
    if (f && now - f.first < LOGIN_WINDOW_MS && f.count >= MAX_FAILURES) {
      throw new HttpError(429, 'Too many wrong codes. Wait a few minutes and try again.');
    }
    const body = await readJson(req, 4096);
    const code = normalizeCode(body.code);
    if (!safeEqual(code, this.store.token())) {
      if (!f || now - f.first >= LOGIN_WINDOW_MS) this.failures.set(ip, { count: 1, first: now });
      else f.count++;
      throw new HttpError(403, 'That code is not right. Check the QR panel in VS Code.');
    }
    this.failures.delete(ip);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': this.cookie(code) });
  }

  // ---------- routing ----------

  async handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Bad URL' });
    }
    const p = url.pathname;
    try {
      if (p === '/_internal/ping') return sendJson(res, 200, { app: 'pocket-tabs', version: this.version, phones: this.clients.size });
      if (p === '/_internal/notify') {
        if (req.method !== 'POST' || !isLoopback(req.socket.remoteAddress) || !safeEqual(req.headers['x-pocket-key'], this.store.token())) {
          throw new HttpError(403, 'Forbidden');
        }
        this.onNotify(await readJson(req, 8 << 20));
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && STATIC[p]) {
        if (p === '/' && url.searchParams.has('code')) {
          const code = normalizeCode(url.searchParams.get('code'));
          const good = safeEqual(code, this.store.token());
          res.writeHead(302, {
            Location: good ? '/' : '/#bad-code',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            ...(good ? { 'Set-Cookie': this.cookie(code) } : {}),
          });
          return res.end();
        }
        return this.serveStatic(req, res, STATIC[p]);
      }

      if (p === '/api/session') return sendJson(res, 200, { authed: this.authed(req) });
      if (p === '/api/login') {
        if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
        return await this.login(req, res);
      }
      if (p === '/api/logout') return sendJson(res, 200, { ok: true }, { 'Set-Cookie': this.cookie('', 0) });

      if (!this.authed(req)) throw new HttpError(401, 'Not signed in');
      if (req.method === 'POST' && !/^application\/json/i.test(req.headers['content-type'] || '')) {
        throw new HttpError(415, 'Expected JSON');
      }

      if (p === '/api/instances') {
        await this.refreshAll();
        return sendJson(res, 200, { instances: this.snapshot() });
      }
      if (p === '/api/events') return await this.openEvents(req, res);

      const m = /^\/api\/i\/([a-f0-9]{6,32})\/([a-z]+)$/.exec(p);
      if (m && m[2] === 'asset') return this.proxyAsset(req, res, m[1], url);
      if (m && ACTIONS[m[2]]) return await this.proxy(req, res, m[1], m[2], url);

      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) this.log.error(`${req.method} ${p}: ${e.stack || e.message}`);
      if (!res.headersSent) sendJson(res, status, { error: e.message || 'Error', ...(e.extra || {}) });
      else res.end();
    }
  }

  serveStatic(req, res, [file, type]) {
    const full = path.join(this.mediaDir, file);
    fs.stat(full, (err, st) => {
      if (err) return sendJson(res, 404, { error: 'Not found' });
      const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      const headers = {
        'Content-Type': type,
        'Cache-Control': 'no-cache',
        ETag: etag,
        Vary: 'Accept-Encoding',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      };
      if (type.startsWith('text/html')) {
        headers['Content-Security-Policy'] = CSP;
        headers['X-Frame-Options'] = 'DENY';
      }
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && !type.startsWith('image/png');
      this.gzCache = this.gzCache || new Map();
      const cached = this.gzCache.get(full);
      const send = (body, zipped) => {
        if (zipped) headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = body.length;
        res.writeHead(200, headers);
        res.end(body);
      };
      if (gzip && cached && cached.etag === etag) return send(cached.body, true);
      fs.readFile(full, (err2, buf) => {
        if (err2) return sendJson(res, 404, { error: 'Not found' });
        if (!gzip) return send(buf, false);
        const body = zlib.gzipSync(buf);
        this.gzCache.set(full, { etag, body });
        send(body, true);
      });
    });
  }

  /** Images used by notes: streamed from the window that has the note open. */
  proxyAsset(req, res, id, url) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const inst = this.store.readInstance(id);
    if (!inst) throw new HttpError(404, 'That VS Code window is closed.');
    const q = new URLSearchParams({ doc: url.searchParams.get('doc') || '', path: url.searchParams.get('path') || '' });
    const up = http.request(
      { host: '127.0.0.1', port: inst.port, path: '/asset?' + q, headers: { 'x-pocket-key': this.store.token() }, timeout: 20000 },
      (r) => {
        const headers = {
          'Content-Type': r.headers['content-type'] || 'application/octet-stream',
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        };
        if (r.headers['content-length']) headers['Content-Length'] = r.headers['content-length'];
        res.writeHead(r.statusCode || 502, headers);
        r.pipe(res);
      }
    );
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => {
      if (!res.headersSent) sendJson(res, 502, { error: 'Could not reach that VS Code window.' });
      else res.end();
    });
    up.end();
  }

  async proxy(req, res, id, action, url) {
    const [method, target] = ACTIONS[action];
    if (req.method !== method) throw new HttpError(405, 'Method not allowed');
    const inst = this.store.readInstance(id);
    if (!inst) throw new HttpError(404, 'That VS Code window is closed.', { code: 'window-gone' });
    const body = method === 'POST' ? await readJson(req, 64 << 20) : undefined;
    let r;
    try {
      r = await requestJson({
        port: inst.port,
        method,
        path: target + (method === 'GET' ? url.search : ''),
        body,
        key: this.store.token(),
        timeout: action === 'save' || action === 'push' ? 30000 : 10000,
      });
    } catch {
      throw new HttpError(502, 'Could not reach that VS Code window.', { code: 'window-gone' });
    }
    sendJson(res, r.status, r.json);
  }

  // ---------- live updates ----------

  async openEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    res.on('error', () => this.clients.delete(res));
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
    await this.refreshAll().catch(() => {});
    res.write(`event: instances\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
  }

  broadcastRaw(msg) {
    for (const c of this.clients) {
      try {
        if (!c.writableEnded && !c.destroyed) c.write(msg);
      } catch {
        /* dropped */
      }
    }
  }

  broadcast(name, data) {
    this.broadcastRaw(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  scheduleBroadcast() {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const json = JSON.stringify(this.snapshot());
      if (json === this.lastSent) return;
      this.lastSent = json;
      this.broadcastRaw(`event: instances\ndata: ${json}\n\n`);
    }, 60);
  }

  snapshot() {
    return [...this.states.values()].sort(
      (a, b) =>
        (b.focused ? 1 : 0) - (a.focused ? 1 : 0) ||
        (b.lastFocusedAt || 0) - (a.lastFocusedAt || 0) ||
        String(a.name).localeCompare(String(b.name))
    );
  }

  async periodic() {
    if (!this.clients.size) return;
    await this.refreshAll().catch(() => {});
    this.scheduleBroadcast();
  }

  refreshAll() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const key = this.store.token();
      const next = new Map();
      await Promise.all(
        this.store.listInstances().map(async (inst) => {
          try {
            const r = await requestJson({ port: inst.port, path: '/state', key, timeout: 2500 });
            if (r.status === 200 && r.json && r.json.id) {
              next.set(r.json.id, r.json);
              return;
            }
          } catch {
            /* busy or gone */
          }
          const stale = Date.now() - inst.mtime > 90000;
          if (stale) this.store.removeInstance(inst.id);
          else if (this.states.has(inst.id)) next.set(inst.id, this.states.get(inst.id));
        })
      );
      this.states = next;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Messages from the VS Code windows (including the one hosting this gateway). */
  onNotify(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state' && msg.state && msg.state.id) {
      this.states.set(msg.state.id, msg.state);
      this.scheduleBroadcast();
    } else if (msg.type === 'gone' && msg.id) {
      this.states.delete(msg.id);
      this.scheduleBroadcast();
    } else if (msg.type === 'doc' && msg.id && msg.uri) {
      this.broadcast('doc', { id: msg.id, uri: msg.uri, version: msg.version, isDirty: msg.isDirty });
    } else if (msg.type === 'presence' && msg.id && msg.uri) {
      this.broadcast('presence', { id: msg.id, uri: msg.uri, offset: msg.offset, version: msg.version, focused: msg.focused });
    } else if (msg.type === 'blame' && msg.id && msg.uri) {
      this.broadcast('blame', { id: msg.id, uri: msg.uri });
    }
  }
}

module.exports = { Gateway };
