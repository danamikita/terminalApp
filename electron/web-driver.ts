// An opt-in HTTP server giving real remote control of this app's terminal
// sessions — a session list you pick from, and a real xterm.js terminal
// (fed by the actual PTY output, not a screenshot) once you open one.
// Never started automatically — see app:toggle-web-driver in main.ts,
// which is wired to a UI toggle that defaults to off every launch.
//
// Security: listens on all interfaces (0.0.0.0), so it's reachable from
// any device on the local network (e.g. a phone), not just this machine —
// that's deliberate, so the link can be opened off-PC. Every request still
// requires a random per-session token (shown in the UI when enabled, with
// a copy-to-clipboard button) via the X-Driver-Token header (or a ?token=
// query param for the one route — the SSE stream — that a browser's
// EventSource can't attach headers to); the token, not the network
// boundary, is what gates access. Anyone with the token can type into any
// of your running shell sessions, same as sitting at the keyboard — treat
// it like a credential for as long as the driver is on.
import * as http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { AppState } from '../src/types';

// Interface names that are virtual/VPN adapters rather than the NIC a phone
// on the same Wi-Fi can actually reach — e.g. Tailscale assigns a CGNAT
// address (100.64.0.0/10) that's only routable to other devices on the same
// tailnet, and Hyper-V's default switch is NAT-only. Picking "the first
// non-internal IPv4" blindly tends to grab one of these instead of the real
// Wi-Fi/Ethernet address, which just times out from another device.
const VIRTUAL_ADAPTER_NAME = /tailscale|vpn|virtual|vethernet|hyper-v|docker|wsl|zerotier|wireguard|vmware|virtualbox/i;
const PHYSICAL_ADAPTER_NAME = /^(wi-?fi|ethernet|en\d|eth\d|wlan\d)/i;

export function getLanAddress(): string | null {
  const nets = os.networkInterfaces();
  const candidates: { name: string; address: string }[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) candidates.push({ name, address: net.address });
    }
  }
  if (candidates.length === 0) return null;

  const physical = candidates.filter((c) => !VIRTUAL_ADAPTER_NAME.test(c.name));
  const preferred = physical.find((c) => PHYSICAL_ADAPTER_NAME.test(c.name)) || physical[0];
  return (preferred || candidates[0]).address;
}

export interface WebDriverHandle {
  port: number;
  token: string;
  stop: () => Promise<void>;
}

export interface WebDriverDeps {
  listState: () => AppState;
  getSessionBuffer: (sessionId: string) => string | null;
  subscribeSessionData: (sessionId: string, cb: (data: string) => void) => (() => void) | null;
  writeToSession: (sessionId: string, data: string) => boolean;
  resizeSession: (sessionId: string, cols: number, rows: number) => boolean;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// node_modules/@xterm/... is already shipped (it's a production dependency
// the renderer requires directly), so these are always present alongside a
// running build — read once and cached, not re-read per request.
const vendorCache = new Map<string, Buffer>();
function readVendorFile(relPath: string): Buffer | null {
  const cached = vendorCache.get(relPath);
  if (cached) return cached;
  try {
    const full = path.join(__dirname, '..', '..', 'node_modules', relPath);
    const buf = fs.readFileSync(full);
    vendorCache.set(relPath, buf);
    return buf;
  } catch {
    return null;
  }
}

function controlPage(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>terminalApp remote control</title>
<link rel="stylesheet" href="/vendor/xterm.css">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: Consolas, monospace; background:#1e1e1e; color:#ddd;
    display: flex; flex-direction: column; -webkit-tap-highlight-color: transparent;
  }
  h3 { margin: 0; font-size: 14px; color: #eee; }
  header { display:flex; align-items:center; gap:10px; padding:10px; border-bottom:1px solid #333; }
  #status { font-size: 11px; color: #888; }
  #listView, #terminalView { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  #listView.hidden, #terminalView.hidden { display: none; }
  #folders { flex: 1; overflow-y: auto; padding: 8px; }
  .folder-name { font-size: 12px; color: #999; margin: 12px 4px 4px; text-transform: uppercase; letter-spacing: .04em; }
  .session-row {
    display: flex; align-items: center; gap: 8px; padding: 10px 8px; border-radius: 6px; cursor: pointer;
  }
  .session-row:active { background: #2a2d2e; }
  .session-row .name { flex: 1; font-size: 14px; }
  .session-row .last-cmd { font-size: 11px; color: #888; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .dot.idle { background: #3c9d3c; }
  .dot.busy { background: #3a9fd9; box-shadow: 0 0 6px #3a9fd9; }
  .dot.exited { background: #666; }
  .attn { color: #e5a93c; }
  #empty { padding: 20px; color: #888; font-size: 13px; }
  button {
    background:#3a3d3e; color:#ddd; border:1px solid #444; border-radius:4px; padding:6px 10px; cursor:pointer;
    font-family: inherit; font-size: 13px;
  }
  button:hover { filter: brightness(1.15); }
  #backBtn { background:#0e639c; border-color:#0e639c; color:#fff; }
  #termTitle { flex: 1; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #termContainer { flex: 1; min-height: 0; padding: 4px; }
  .keys { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #333; }
  .keys button { flex: 1; }
</style>
</head>
<body>
  <header>
    <h3>🖥️ Remote control</h3>
    <div id="status"></div>
  </header>

  <div id="listView">
    <div id="folders"></div>
  </div>

  <div id="terminalView" class="hidden">
    <header>
      <button id="backBtn">← Back</button>
      <div id="termTitle"></div>
    </header>
    <div id="termContainer"></div>
    <div class="keys">
      <button data-byte="\\u001b">Esc</button>
      <button data-byte="\\t">Tab</button>
      <button data-byte="\\u0003">Ctrl+C</button>
      <button data-byte="\\u0004">Ctrl+D</button>
    </div>
  </div>

  <script src="/vendor/xterm.js"></script>
  <script src="/vendor/addon-fit.js"></script>
  <script>
    const token = new URLSearchParams(location.search).get('token') || prompt('Driver token:');
    const windowsBuildNumber = ${JSON.stringify(Number(os.release().split('.')[2]) || 0)};
    const statusEl = document.getElementById('status');
    const foldersEl = document.getElementById('folders');
    const listView = document.getElementById('listView');
    const terminalView = document.getElementById('terminalView');
    const termTitleEl = document.getElementById('termTitle');
    const termContainerEl = document.getElementById('termContainer');

    function authedFetch(url, opts) {
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers, { 'X-Driver-Token': token });
      return fetch(url, opts);
    }

    function statusDotClass(session) {
      if (session.status === 'exited') return 'exited';
      return session.activity === 'busy' ? 'busy' : 'idle';
    }

    const sessionNames = {};
    let listPoll = null;
    async function refreshList() {
      try {
        const res = await authedFetch('/sessions');
        const state = await res.json();
        renderList(state);
        statusEl.textContent = 'connected';
      } catch (e) {
        statusEl.textContent = 'could not reach the app — retrying…';
      }
    }

    function renderList(state) {
      foldersEl.innerHTML = '';
      const folders = (state.folders || []).filter((f) => f.sessions.length > 0);
      if (folders.length === 0) {
        const empty = document.createElement('div');
        empty.id = 'empty';
        empty.textContent = 'No running sessions.';
        foldersEl.appendChild(empty);
        return;
      }
      for (const folder of folders) {
        const heading = document.createElement('div');
        heading.className = 'folder-name';
        heading.textContent = folder.name;
        foldersEl.appendChild(heading);
        for (const session of folder.sessions) {
          sessionNames[session.id] = session.name;
          const row = document.createElement('div');
          row.className = 'session-row';
          row.innerHTML =
            '<div class="dot ' + statusDotClass(session) + '"></div>' +
            '<div class="name">' + (session.attention ? '<span class="attn">●</span> ' : '') +
              escapeHtml(session.name) + '</div>' +
            '<div class="last-cmd">' + escapeHtml(session.lastCommand || '') + '</div>';
          row.addEventListener('click', () => {
            location.hash = '#/session/' + session.id;
          });
          foldersEl.appendChild(row);
        }
      }
    }

    function escapeHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    let term = null;
    let fitAddon = null;
    let eventSource = null;
    let resizeDebounce = null;
    // Each keystroke fires its own POST; without serializing them, concurrent
    // fetches can land at the server out of the order they were typed in
    // (observed with fast/automated typing). Chaining through one promise
    // guarantees in-order delivery without blocking the UI.
    let inputChain = Promise.resolve();

    function closeSession() {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      if (term) {
        term.dispose();
        term = null;
      }
      window.removeEventListener('resize', scheduleResizeSend);
      termContainerEl.innerHTML = '';
    }

    function scheduleResizeSend() {
      clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(sendResize, 200);
    }

    async function sendResize() {
      if (!term || !fitAddon || !currentSessionId) return;
      fitAddon.fit();
      await authedFetch('/session/' + currentSessionId + '/resize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: term.cols, rows: term.rows }),
      });
    }

    let currentSessionId = null;
    async function openSession(sessionId) {
      closeSession();
      currentSessionId = sessionId;
      termTitleEl.textContent = sessionNames[sessionId] || sessionId;

      term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Consolas, "Courier New", monospace',
        windowsPty: { backend: 'conpty', buildNumber: windowsBuildNumber },
        theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      });
      fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.open(termContainerEl);
      fitAddon.fit();

      inputChain = Promise.resolve();
      term.onData((data) => {
        inputChain = inputChain.then(() =>
          authedFetch('/session/' + sessionId + '/input', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data }),
          }).catch(() => {})
        );
      });

      window.addEventListener('resize', scheduleResizeSend);

      try {
        const bufRes = await authedFetch('/session/' + sessionId + '/buffer');
        if (bufRes.ok) {
          const { data } = await bufRes.json();
          if (data) term.write(data);
        }
      } catch {
        // best-effort — live stream still works even if the initial buffer fetch fails
      }

      await sendResize();

      eventSource = new EventSource('/session/' + sessionId + '/stream?token=' + encodeURIComponent(token));
      eventSource.onmessage = (ev) => {
        term.write(JSON.parse(ev.data));
      };
    }

    for (const btn of document.querySelectorAll('.keys button')) {
      btn.addEventListener('click', () => {
        if (!currentSessionId) return;
        const data = JSON.parse('"' + btn.dataset.byte + '"');
        inputChain = inputChain.then(() =>
          authedFetch('/session/' + currentSessionId + '/input', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data }),
          }).catch(() => {})
        );
      });
    }

    document.getElementById('backBtn').addEventListener('click', () => {
      location.hash = '';
    });

    function route() {
      const match = /^#\\/session\\/(.+)$/.exec(location.hash);
      if (match) {
        clearInterval(listPoll);
        listView.classList.add('hidden');
        terminalView.classList.remove('hidden');
        if (match[1] !== currentSessionId) openSession(match[1]);
      } else {
        closeSession();
        currentSessionId = null;
        terminalView.classList.add('hidden');
        listView.classList.remove('hidden');
        refreshList();
        clearInterval(listPoll);
        listPoll = setInterval(refreshList, 2000);
      }
    }

    window.addEventListener('hashchange', route);
    route();
  </script>
</body>
</html>`;
}

function serveVendorFile(res: ServerResponse, relPath: string, contentType: string): void {
  const buf = readVendorFile(relPath);
  if (!buf) {
    sendJson(res, 404, { ok: false, error: 'vendor asset not found' });
    return;
  }
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
  res.end(buf);
}

export function startWebDriver(deps: WebDriverDeps, port: number): Promise<WebDriverHandle> {
  return new Promise((resolve, reject) => {
    const token = randomUUID();

    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Driver-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const pathname = (req.url || '').split('?')[0];
      const query = new URLSearchParams((req.url || '').split('?')[1] || '');

      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(controlPage());
        return;
      }

      if (req.method === 'GET' && pathname === '/vendor/xterm.js') {
        serveVendorFile(res, path.join('@xterm', 'xterm', 'lib', 'xterm.js'), 'text/javascript');
        return;
      }
      if (req.method === 'GET' && pathname === '/vendor/xterm.css') {
        serveVendorFile(res, path.join('@xterm', 'xterm', 'css', 'xterm.css'), 'text/css');
        return;
      }
      if (req.method === 'GET' && pathname === '/vendor/addon-fit.js') {
        serveVendorFile(res, path.join('@xterm', 'addon-fit', 'lib', 'addon-fit.js'), 'text/javascript');
        return;
      }

      // Everything below requires the token. EventSource can't set headers,
      // so the stream route accepts it as a query param instead.
      const sessionMatch = /^\/session\/([^/]+)\/(buffer|stream|input|resize)$/.exec(pathname);
      const isStream = sessionMatch && sessionMatch[2] === 'stream';
      const suppliedToken = isStream ? query.get('token') : req.headers['x-driver-token'];

      if (pathname === '/sessions' || sessionMatch) {
        if (suppliedToken !== token) {
          sendJson(res, 401, { ok: false, error: 'bad or missing driver token' });
          return;
        }
      } else {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }

      if (req.method === 'GET' && pathname === '/sessions') {
        sendJson(res, 200, deps.listState());
        return;
      }

      if (!sessionMatch) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const sessionId = sessionMatch[1];
      const route = sessionMatch[2];

      if (req.method === 'GET' && route === 'buffer') {
        const data = deps.getSessionBuffer(sessionId);
        if (data === null) {
          sendJson(res, 404, { ok: false, error: 'session not found' });
          return;
        }
        sendJson(res, 200, { data });
        return;
      }

      if (req.method === 'GET' && route === 'stream') {
        if (deps.getSessionBuffer(sessionId) === null) {
          sendJson(res, 404, { ok: false, error: 'session not found' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        const unsubscribe = deps.subscribeSessionData(sessionId, (data) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        });
        const keepalive = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(keepalive);
          unsubscribe?.();
        });
        return;
      }

      if (req.method === 'POST' && route === 'input') {
        readBody(req)
          .then((body) => {
            let parsed: { data?: string };
            try {
              parsed = JSON.parse(body);
            } catch {
              sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
              return;
            }
            const ok = deps.writeToSession(sessionId, parsed.data || '');
            sendJson(res, ok ? 200 : 404, { ok });
          })
          .catch((e) => sendJson(res, 500, { ok: false, error: (e as Error).message }));
        return;
      }

      if (req.method === 'POST' && route === 'resize') {
        readBody(req)
          .then((body) => {
            let parsed: { cols?: number; rows?: number };
            try {
              parsed = JSON.parse(body);
            } catch {
              sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
              return;
            }
            const cols = Number(parsed.cols);
            const rows = Number(parsed.rows);
            if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
              sendJson(res, 400, { ok: false, error: 'invalid cols/rows' });
              return;
            }
            const ok = deps.resizeSession(sessionId, Math.round(cols), Math.round(rows));
            sendJson(res, ok ? 200 : 404, { ok });
          })
          .catch((e) => sendJson(res, 500, { ok: false, error: (e as Error).message }));
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    });

    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve({
        port,
        token,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
