// Electron main process for Relay.app.
//
// Architecture: no localhost server. The UI is a static export from
// Next.js (`out/`). Electron registers an `app://` protocol that serves
// those files for HTML/CSS/JS/etc. and routes any `/api/*` request to
// backend handlers in `electron/api/`. The Chrome extension reaches the
// same handlers via Chrome's native messaging API (see electron/native-host.js).

const { app, BrowserWindow, dialog, protocol, net, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { WebSocketServer } = require('ws');

const EXT_LISTEN_PORT = 3030;
const EXT_LISTEN_HOST = '127.0.0.1';

// Override the app name BEFORE app.whenReady() so the dock tooltip + menu
// bar pull "Relay" instead of "Electron" in dev. Packaged builds inherit
// the name from electron-builder's productName and don't need this.
app.setName('Relay');

const APP_ID = 'com.jacobbrachna.relay';
// Previous app ID before the InboxPro → Relay rebrand. We migrate any data
// that lives at the legacy path on first launch so existing users don't
// lose their inbox.
const LEGACY_APP_ID = 'com.jacobbrachna.inboxpro';
const isDev = !app.isPackaged;

// ── Paths ────────────────────────────────────────────────────────────
// In dev (electron .) the static export lives in <project>/out and
// backend handlers in <project>/electron/api. In production, both ride
// alongside the bundle's app.asar.
const STATIC_DIR = isDev
  ? path.join(__dirname, '..', 'out')
  : path.join(process.resourcesPath, 'out');

const API_DIR = isDev
  ? path.join(__dirname, 'api')
  : path.join(process.resourcesPath, 'app.asar', 'electron', 'api');

// ── .env loader ───────────────────────────────────────────────────────
// Reads a .env file shipped alongside the .app (or at project root in
// dev) into process.env. Currently holds the ZoomInfo OAuth client_id +
// client_secret so they don't live in code/git. Each line: KEY=VALUE.
// Existing process.env vars win — useful for local overrides.
function loadDotenv() {
  const envPath = isDev
    ? path.join(__dirname, '..', '.env')
    : path.join(process.resourcesPath, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch {}
}
loadDotenv();

const USER_DATA_DIR = path.join(app.getPath('appData'), APP_ID);
const DB_PATH = path.join(USER_DATA_DIR, 'dev.db');
const SEED_DB = isDev
  ? path.join(__dirname, '..', 'prisma', 'dev.db.seed')
  : path.join(process.resourcesPath, 'dev.db.seed');

const LOG_DIR = path.join(app.getPath('logs'), 'Relay');
const LOG_PATH = path.join(LOG_DIR, 'main.log');

// ── Logging ──────────────────────────────────────────────────────────
fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  logStream.write(line);
  console.log(line.trim());
}

// ── DB seeding ───────────────────────────────────────────────────────
function ensureSeedDb() {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    log('user db already at', DB_PATH);
  } else {
    // Migrate from the legacy Relay data dir if one exists. We copy
    // (not move) so the user has a safety net if anything goes wrong.
    const legacyDir = path.join(app.getPath('appData'), LEGACY_APP_ID);
    const legacyDb = path.join(legacyDir, 'dev.db');
    if (fs.existsSync(legacyDb)) {
      log('migrating db from legacy path', legacyDb, '→', DB_PATH);
      fs.copyFileSync(legacyDb, DB_PATH);
    } else {
      log('seeding fresh db at', DB_PATH);
      fs.copyFileSync(SEED_DB, DB_PATH);
    }
  }
  // The bundled API handlers' Prisma client reads DATABASE_URL on
  // first require. Set it before any handler loads.
  process.env.DATABASE_URL = `file:${DB_PATH}`;
}

// ── Backend handler dispatch ─────────────────────────────────────────
// Each /api/X path maps to an electron/api/X.js module exporting GET,
// POST, etc. We support Next.js-style bracket params: a directory named
// `[slug]` in the bundle matches any single segment. We pre-scan the
// API_DIR once to build a quick lookup of "static path → file" and
// "param path pattern → file".
const handlerCache = new Map();
let routeIndex = null; // { static: Map<path,file>, dynamic: [{ regex, paramNames, file }] }

function buildRouteIndex() {
  const staticRoutes = new Map();
  const dynamicRoutes = [];
  function walk(dir, segments) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...segments, entry.name]);
      } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.js.map')) {
        // file like "state.js" — its route is segments + filename-without-ext
        const routeSegments = [...segments, entry.name.replace(/\.js$/, '')];
        const file = path.join(dir, entry.name);
        const hasParam = routeSegments.some((s) => s.startsWith('[') && s.endsWith(']'));
        if (!hasParam) {
          staticRoutes.set(routeSegments.join('/'), file);
        } else {
          const paramNames = [];
          const regexParts = routeSegments.map((s) => {
            if (s.startsWith('[') && s.endsWith(']')) {
              paramNames.push(s.slice(1, -1));
              return '([^/]+)';
            }
            return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
          });
          const regex = new RegExp('^' + regexParts.join('/') + '$');
          dynamicRoutes.push({ regex, paramNames, file });
        }
      }
    }
  }
  walk(API_DIR, []);
  return { static: staticRoutes, dynamic: dynamicRoutes };
}

function loadHandler(route) {
  if (handlerCache.has(route)) return handlerCache.get(route);
  if (!routeIndex) routeIndex = buildRouteIndex();
  let file = routeIndex.static.get(route);
  let params = {};
  if (!file) {
    for (const d of routeIndex.dynamic) {
      const m = route.match(d.regex);
      if (m) {
        file = d.file;
        // Next.js auto-decodes dynamic params before passing to handlers.
        // Mirror that — without this, URN-shaped IDs (which contain ':',
        // '(', ',', '=' that get percent-encoded in the request URL)
        // arrive at handlers in encoded form and miss every DB lookup.
        d.paramNames.forEach((name, i) => {
          try { params[name] = decodeURIComponent(m[i + 1]); }
          catch { params[name] = m[i + 1]; }
        });
        break;
      }
    }
  }
  if (!file) {
    handlerCache.set(route, null);
    return null;
  }
  const mod = require(file);
  const entry = { mod, params };
  handlerCache.set(route, entry);
  return entry;
}

async function dispatchApi(method, url, body, headers) {
  // url is like "/api/state" or "/api/contacts/search?q=foo". Strip the query
  // string before resolving the handler — the route regexes are anchored ($),
  // so a trailing "?..." would miss every match. Keep the full url (with query)
  // on the Request so handlers can still read the params.
  const pathname = url.split('?')[0].replace(/^\/api\//, '');
  log(`api ${method} ${url}`);
  const entry = loadHandler(pathname);
  if (!entry) {
    log(`api 404 ${pathname}`);
    return new Response(`No handler for /api/${pathname}`, { status: 404 });
  }
  const { mod, params } = entry;
  // The handler exports an object keyed by HTTP method: { GET, POST, ... }
  const fn = mod[method] || mod.default;
  if (!fn) {
    return new Response(`Method ${method} not allowed`, { status: 405 });
  }
  try {
    const fullUrl = `app://${url}`;
    const req = new Request(fullUrl, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    });
    // Next.js route handlers read query params via `req.nextUrl.searchParams`.
    // A plain Request has no `nextUrl`, so attach one (parsed from the full
    // url incl. query) — without this, every query-param route (search,
    // analytics, parser-health, contacts context) throws in the packaged app.
    try {
      Object.defineProperty(req, 'nextUrl', { value: new URL(fullUrl), configurable: true, writable: true });
    } catch { /* read-only env — handlers fall back to new URL(req.url) */ }
    // Next.js-style handler signature: (request, { params })
    const res = await fn(req, { params: Promise.resolve(params) });
    return res;
  } catch (e) {
    log('handler error', pathname, e?.stack || e);
    return new Response(JSON.stringify({ error: e?.message || 'error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ── app:// protocol ──────────────────────────────────────────────────
// Must be registered before app.whenReady() per Electron docs. We mark
// it as standard + secure + supportFetchAPI so fetch() works inside
// pages loaded from this origin.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

// ── Transient OAuth callback listener ─────────────────────────────────
// ZoomInfo OAuth redirects to http://localhost:54321/callback?code=...
// We spin up a one-shot HTTP server on demand, capture the auth code,
// hand it back to the renderer via a Promise, then tear down. Reuse the
// same pattern for any future OAuth provider.
let oauthServer = null;
let oauthPending = null;

function startOauthListener() {
  return new Promise((resolve, reject) => {
    if (oauthPending) return reject(new Error('OAuth already in flight'));
    oauthPending = { resolve, reject };

    oauthServer = http.createServer((req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://localhost:54321');
        if (u.pathname !== '/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        const code = u.searchParams.get('code');
        const state = u.searchParams.get('state');
        const error = u.searchParams.get('error');
        // Friendly HTML so the user sees a confirmation in their browser tab.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Relay · ZoomInfo</title>
          <style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
          .card{background:#161616;border:1px solid #262626;border-radius:14px;padding:32px 40px;text-align:center;max-width:420px}
          h1{font-size:18px;margin:0 0 8px;font-weight:600}p{font-size:13px;color:#a1a1a1;margin:0;line-height:1.5}</style></head>
          <body><div class="card"><h1>${error ? 'ZoomInfo connection failed' : 'ZoomInfo connected'}</h1>
          <p>${error ? error : 'You can close this tab and return to Relay.'}</p></div></body></html>`);
        stopOauthListener();
        if (error) oauthPending?.reject(new Error(`ZoomInfo: ${error}`));
        else if (code) oauthPending?.resolve({ code, state });
        else oauthPending?.reject(new Error('No code in callback'));
        oauthPending = null;
      } catch (e) {
        try { res.writeHead(500); res.end(String(e)); } catch {}
      }
    });
    oauthServer.on('error', (e) => {
      stopOauthListener();
      oauthPending?.reject(e);
      oauthPending = null;
    });
    oauthServer.listen(54321, '127.0.0.1', () => {
      log('oauth listener on 127.0.0.1:54321');
    });
    // Safety timeout — 5 min, then tear down so we don't hold the port forever.
    setTimeout(() => {
      if (oauthPending) {
        stopOauthListener();
        oauthPending?.reject(new Error('OAuth flow timed out'));
        oauthPending = null;
      }
    }, 5 * 60 * 1000);
  });
}

function stopOauthListener() {
  try { oauthServer?.close(); } catch {}
  oauthServer = null;
}

// Bridge so /api/zoominfo/auth/* (running inside dispatchApi) can call the
// main-process listener. Same pattern would extend to other OAuth providers.
globalThis.__relayOAuth = {
  start: startOauthListener,
  stop: stopOauthListener,
};

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    // app://./api/state → pathname is "/api/state"
    const pathname = url.pathname;

    // Backend routes
    if (pathname.startsWith('/api/')) {
      const buf = request.body
        ? await new Response(request.body).arrayBuffer()
        : undefined;
      const headers = Object.fromEntries(request.headers);
      // Include the query string (url.search) so the UI's own query-param
      // fetches (search, analytics, …) reach handlers intact.
      return dispatchApi(request.method, pathname + url.search, buf ? Buffer.from(buf) : undefined, headers);
    }

    // Static files. Strip leading slash and normalize to STATIC_DIR.
    // Next.js's static export hashes filenames so all of /_next/* is safe.
    let filePath = path.join(STATIC_DIR, pathname);
    // SECURITY: block path traversal — `path.join` normalizes `..`, but a
    // crafted pathname could still resolve outside STATIC_DIR. Reject anything
    // that escapes the static root before we touch the filesystem.
    const staticRoot = path.resolve(STATIC_DIR);
    if (filePath !== staticRoot && !path.resolve(filePath).startsWith(staticRoot + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    // SPA fallback — non-file paths get index.html.
    if (!pathname.includes('.') && !fs.existsSync(filePath)) {
      filePath = path.join(STATIC_DIR, 'index.html');
    } else if (fs.statSync(filePath, { throwIfNoEntry: false })?.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!fs.existsSync(filePath)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

// ── Extension HTTP listener ──────────────────────────────────────────
// The Chrome extension fetches /api/* from http://127.0.0.1:3030. This
// listener binds loopback-only, routes through the same dispatchApi()
// as the renderer. The user never sees this; it's a private IPC channel
// for the extension. The UI itself is on app://, not localhost.
// SECURITY: the :3030 API is a private channel for the Relay extension. Only
// allow callers whose Origin proves they are the extension (chrome-extension://),
// our LinkedIn content scripts (www.linkedin.com — they POST captures here), or
// the app itself. A web page you visit sends its own http(s) Origin (the browser
// sets it and a page cannot forge it), so rejecting those blocks the drive-by
// threat: a random site can no longer read your inbox, overwrite your API key,
// or wipe the DB via 127.0.0.1:3030. (Absent Origin = the extension service
// worker / non-browser local callers — allowed; residual local-process and
// linkedin.com-context risk is tracked in SECURITY-AUDIT.md for token hardening.)
function isAllowedOrigin(origin) {
  if (!origin || origin === 'null') return true;
  if (origin.startsWith('chrome-extension://')) return true;
  if (origin.startsWith('app://')) return true;
  if (origin === 'https://www.linkedin.com') return true;
  return false;
}

// Defense-in-depth: the extension NEVER calls these UI-only / destructive
// endpoints (verified), so block them on the :3030 channel entirely. Even a
// script running on linkedin.com (an allowed Origin) or a local process cannot
// wipe the DB, overwrite the Anthropic key, or bulk-export your data through
// this listener. The app's own UI reaches these via the trusted app:// path.
const EXT_BLOCKED_PATHS = ['/api/reset', '/api/ai/key', '/api/export', '/api/raw', '/api/repair-attribution', '/api/diagnostics'];
function isExtBlockedPath(rawUrl) {
  const p = rawUrl.split('?')[0].replace(/\/+$/, '');
  return EXT_BLOCKED_PATHS.some((b) => p === b || p.startsWith(b + '/'));
}

// The WS broker is only ever used by the extension worker (chrome-extension://)
// and the app renderer (app:// / null) — content scripts on linkedin.com use
// HTTP, never the socket. So keep the WS Origin gate tighter than HTTP's: a
// linkedin.com page must not be able to open the broker and inject/intercept
// renderer↔extension traffic.
function isAllowedWsOrigin(origin) {
  if (!origin || origin === 'null') return true;
  if (origin.startsWith('chrome-extension://')) return true;
  if (origin.startsWith('app://')) return true;
  return false;
}

function startExtensionListener() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url || '/';
      if (!url.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        log(`ext listener: blocked origin ${req.headers.origin} for ${req.method} ${url}`);
        res.writeHead(403, { 'Content-Type': 'text/plain', 'access-control-allow-origin': '*' });
        res.end('Forbidden origin');
        return;
      }
      if (isExtBlockedPath(url)) {
        log(`ext listener: blocked UI-only path ${req.method} ${url}`);
        res.writeHead(403, { 'Content-Type': 'text/plain', 'access-control-allow-origin': '*' });
        res.end('Forbidden');
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const response = await dispatchApi(req.method || 'GET', url, body, req.headers);
      const buf = Buffer.from(await response.arrayBuffer());
      const outHeaders = Object.fromEntries(response.headers);
      // Always allow the extension's origin (chrome-extension://…) since the
      // route handlers' CORS headers are wildcard. Preserve existing CORS.
      if (!outHeaders['access-control-allow-origin']) {
        outHeaders['access-control-allow-origin'] = '*';
      }
      res.writeHead(response.status, outHeaders);
      res.end(buf);
    } catch (e) {
      log('ext listener error', e?.stack || e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e?.message || 'error' }));
    }
  });

  // ── WS broker on the same port ─────────────────────────────────────
  // Two peer roles connect via ws://127.0.0.1:3030/ws:
  //   - 'renderer'  → the app's UI (replaces the old localhost-only
  //                   content-script bridge)
  //   - 'extension' → the Chrome extension's background service worker
  // The broker forwards any message from one role to all peers of the
  // other role. It also fires presence events so the renderer's
  // useExtensionReady() flips as soon as the extension connects.
  const wss = new WebSocketServer({ noServer: true });
  const peers = new Set(); // { ws, role }

  function announcePresence() {
    const extConnected = [...peers].some((p) => p.role === 'extension');
    const payload = JSON.stringify({ type: 'presence', extensionConnected: extConnected });
    for (const p of peers) {
      if (p.role === 'renderer' && p.ws.readyState === 1) p.ws.send(payload);
    }
  }

  // Broker-initiated keepalive. MV3 service workers idle out after 30s of
  // no activity, and only INCOMING WS frames reset that timer. So the
  // broker pushes a `__keepalive` to every extension peer every 20s.
  // Electron's main process never sleeps, so this is the reliable side.
  setInterval(() => {
    for (const p of peers) {
      if (p.role === 'extension' && p.ws.readyState === 1) {
        try { p.ws.send(JSON.stringify({ type: '__keepalive' })); } catch {}
      }
    }
  }, 20_000);

  wss.on('connection', (ws) => {
    const peer = { ws, role: null };
    peers.add(peer);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg && msg.type === '__hello') {
        peer.role = msg.role;
        log(`ws peer connected role=${msg.role}`);
        announcePresence();
        return;
      }
      if (msg && msg.type === '__ping') {
        // Reply with a pong on the same socket. The inbound message resets
        // the sender's MV3 service-worker idle timer — without this echo
        // the SW dies in ~30s even though we're sending pings.
        try { ws.send(JSON.stringify({ type: '__pong' })); } catch {}
        return;
      }
      // Forward to peers of the opposite role.
      const dest = peer.role === 'extension' ? 'renderer' : 'extension';
      const payload = raw.toString();
      for (const p of peers) {
        if (p.role === dest && p.ws.readyState === 1) p.ws.send(payload);
      }
    });
    ws.on('close', () => {
      peers.delete(peer);
      log(`ws peer disconnected role=${peer.role}`);
      announcePresence();
    });
    ws.on('error', () => {});
  });

  server.on('upgrade', (req, socket, head) => {
    // Same Origin gate as the HTTP API — a web page must not be able to open
    // the broker socket and inject/intercept renderer↔extension messages.
    if (req.url === '/ws' && isAllowedWsOrigin(req.headers.origin)) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`ext listener: port ${EXT_LISTEN_PORT} already in use — another Relay instance?`);
    } else {
      log('ext listener error', e.message);
    }
  });
  server.listen(EXT_LISTEN_PORT, EXT_LISTEN_HOST, () => {
    log(`ext listener: http://${EXT_LISTEN_HOST}:${EXT_LISTEN_PORT} (+ ws /ws)`);
  });
}

// ── Single-instance lock ─────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  let mainWindow;
  async function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 1024,
      minHeight: 680,
      title: 'Relay',
      titleBarStyle: 'hiddenInset',
      show: true, // show immediately so we can see what's happening
      backgroundColor: '#111111',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // Sandbox the renderer (we ship no preload, so nothing depends on a
        // non-sandboxed renderer). Defense-in-depth against a renderer compromise.
        sandbox: true,
      },
    });
    // DevTools is opt-in via env var. Even in dev we don't want it popping
    // open every launch — it adds the macOS resize HUD and burns screen
    // real estate. Cmd+Option+I still works to open it manually.
    if (isDev && process.env.INBOXPRO_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    // Capture load failures explicitly — without this they're silent.
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      log(`load failed code=${code} desc=${desc} url=${url}`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      log(`renderer crashed reason=${details.reason} exit=${details.exitCode}`);
    });
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      log(`renderer console [${level}] ${message}`);
    });

    try {
      await mainWindow.loadURL('app://./index.html');
      log('loadURL resolved');
    } catch (e) {
      log('loadURL threw:', e?.message || e);
    }
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
  }

  app.whenReady().then(async () => {
    try {
      // In dev mode the macOS Dock falls back to the default Electron
      // icon. Set ours explicitly so the brand carries through during
      // local iteration. Packaged builds use icon.icns from electron-
      // builder and don't need this.
      if (process.platform === 'darwin' && app.dock) {
        const devIcon = path.join(__dirname, '..', 'build', 'icon.png');
        try { app.dock.setIcon(devIcon); } catch {}
      }
      ensureSeedDb();
      registerAppProtocol();
      startExtensionListener();
      await createWindow();
      log('window opened');

      // Auto-update via electron-updater. Pulls latest-mac.yml from the
      // GitHub release feed configured in electron-builder.yml; if a newer
      // version is published, downloads in the background and shows a
      // restart prompt when ready. No-ops in dev (app.isPackaged === false).
      if (!isDev) {
        autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
        autoUpdater.on('error', (err) => log('updater error', err?.message || err));
        autoUpdater.on('update-available', (info) => log('update-available', info?.version));
        autoUpdater.on('update-downloaded', (info) => {
          log('update-downloaded', info?.version);
          dialog
            .showMessageBox({
              type: 'info',
              buttons: ['Restart now', 'Later'],
              defaultId: 0,
              cancelId: 1,
              title: 'Relay update ready',
              message: `Relay ${info.version} is ready to install.`,
              detail: 'Restart now to apply the update.',
            })
            .then((res) => { if (res.response === 0) autoUpdater.quitAndInstall(); });
        });
        autoUpdater.checkForUpdates().catch((e) => log('updater check failed', e?.message));
      }
    } catch (e) {
      log('boot failed:', e?.stack || e);
      dialog.showErrorBox('Relay failed to start', String(e));
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
}
