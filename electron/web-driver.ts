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
//
// Device pairing: POST /pair (ephemeral-token-only — see its handler below)
// trades that per-launch token for a persistent per-device credential, so a
// phone doesn't need to be told the token again on every visit. The
// credential travels as "device.<id>.<secret>" in the exact same slots as
// the ephemeral token (no new headers/params, no CORS allowlist change). A
// paired device can never itself pair new devices — only the raw ephemeral
// token works against /pair — so a compromised device credential can't
// silently mint siblings. Device secrets are persisted in plaintext in
// config.json, same as every other setting in AppConfig; that's not a new
// weakness, just worth being explicit that pairing adds no extra at-rest
// protection. The LAN mDNS advertisement below broadcasts only the
// hostname — never a token or device secret — since mDNS multicast is
// unauthenticated and visible to anything on the LAN, not just the intended
// phone.
import * as http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import Bonjour from 'bonjour-service';
import type { AppState, TrustedDevice } from '../src/types';
import { savePastedImage } from './pasted-images';

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

// Tailscale always assigns its IPv4 address from this CGNAT range — that's
// a hard product guarantee, not configurable — so it's the only reliable
// signal. The adapter being named "Tailscale" is not enough by itself: a
// present-but-not-actually-connected Tailscale adapter (daemon not
// running/logged out) can still show up with a useless 169.254.x.x
// link-local fallback address, which would be confusing to show as if it
// were a usable remote address.
function isTailscaleCgnatAddress(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

// Unlike getLanAddress() above (which deliberately excludes this), a
// Tailscale address is exactly what you want when connecting from outside
// the LAN — it's routable to any device on the same tailnet regardless of
// network. The web driver already listens on 0.0.0.0, so no server changes
// are needed to make this reachable; this only surfaces the address in the
// UI (see android plan's Tailscale follow-up). Returns null if Tailscale
// isn't installed, or is installed but not actually connected.
export function getTailscaleAddress(): string | null {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && isTailscaleCgnatAddress(net.address)) return net.address;
    }
  }
  return null;
}

// Tailscale's MagicDNS name (e.g. "my-pc.tailnet-name.ts.net") is nicer to
// type once than a raw 100.x.y.z address and — unlike a plain LAN IP —
// reliably resolves from anywhere on the tailnet, not just this machine's
// current network. Shells out to the `tailscale` CLI since there's no other
// way to ask for this; best-effort only, resolves to null on any failure
// (not installed, not on PATH, not logged in, timeout, unexpected output)
// rather than rejecting — this is a convenience hint, never load-bearing.
export function getTailscaleMagicDnsName(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 3000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const dnsName: string | undefined = parsed?.Self?.DNSName;
        resolve(dnsName ? dnsName.replace(/\.$/, '') : null);
      } catch {
        resolve(null);
      }
    });
  });
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
  listTrustedDevices: () => TrustedDevice[];
  addTrustedDevice: (device: TrustedDevice) => void;
  touchTrustedDevice: (deviceId: string) => void;
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

// Hashes both sides to a fixed-length digest before comparing so
// timingSafeEqual never throws on the differing lengths of the ephemeral
// UUID token vs. a 64-char hex device secret.
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

const DEVICE_TOKEN = /^device\.([^.]+)\.([0-9a-f]{64})$/;

function verifyCredential(
  supplied: string | undefined,
  ephemeralToken: string,
  deps: WebDriverDeps
): { ok: boolean; deviceId?: string } {
  if (!supplied) return { ok: false };
  if (timingSafeEqualStr(supplied, ephemeralToken)) return { ok: true };
  const match = DEVICE_TOKEN.exec(supplied);
  if (!match) return { ok: false };
  const device = deps.listTrustedDevices().find((d) => d.id === match[1]);
  if (!device || !timingSafeEqualStr(match[2], device.secret)) return { ok: false };
  return { ok: true, deviceId: device.id };
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
      <button id="scrollUpBtn">▲ Scroll</button>
      <button id="scrollDownBtn">▼ Scroll</button>
      <button id="scrollBottomBtn">⤓ Bottom</button>
    </div>
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
    const DEVICE_STORAGE_KEY = 'terminalapp_device_credential';
    let deviceCred = null;
    try {
      deviceCred = JSON.parse(localStorage.getItem(DEVICE_STORAGE_KEY) || 'null');
    } catch (e) {
      deviceCred = null;
    }
    let ephemeralToken = new URLSearchParams(location.search).get('token');
    let pairingOffered = false;

    function currentAuthValue() {
      if (deviceCred) return 'device.' + deviceCred.id + '.' + deviceCred.secret;
      return ephemeralToken;
    }

    function forgetDeviceCredential() {
      deviceCred = null;
      try {
        localStorage.removeItem(DEVICE_STORAGE_KEY);
      } catch (e) {
        // best-effort
      }
    }

    async function ensureAuthed() {
      while (!currentAuthValue()) {
        ephemeralToken = prompt('Driver token:') || '';
      }
    }

    async function maybeOfferPairing() {
      if (pairingOffered || deviceCred || !ephemeralToken) return;
      pairingOffered = true;
      const name = prompt('Remember this device so you are not asked for the token again? Enter a name, or Cancel to skip:', 'My phone');
      if (!name) return;
      try {
        const res = await fetch('/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Driver-Token': ephemeralToken },
          body: JSON.stringify({ name: name }),
        });
        if (!res.ok) return;
        const paired = await res.json();
        deviceCred = { id: paired.deviceId, secret: paired.deviceSecret };
        localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(deviceCred));
      } catch (e) {
        // best-effort — staying on the ephemeral token for this visit is fine
      }
    }

    const windowsBuildNumber = ${JSON.stringify(Number(os.release().split('.')[2]) || 0)};
    const statusEl = document.getElementById('status');
    const foldersEl = document.getElementById('folders');
    const listView = document.getElementById('listView');
    const terminalView = document.getElementById('terminalView');
    const termTitleEl = document.getElementById('termTitle');
    const termContainerEl = document.getElementById('termContainer');

    function authedFetch(url, opts) {
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers, { 'X-Driver-Token': currentAuthValue() });
      return fetch(url, opts).then((res) => {
        if (res.status === 401) {
          forgetDeviceCredential();
          ephemeralToken = null;
          location.reload();
        }
        return res;
      });
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
        maybeOfferPairing();
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

    // Capture phase so this runs before xterm's own paste handling, which
    // only ever reads text/plain off ClipboardEvent.clipboardData -- an
    // image-only clipboard just gets silently dropped there. This reads
    // clipboardData directly rather than the async navigator.clipboard API
    // because the driver is typically opened over plain HTTP on the LAN,
    // where that API is unavailable outside a secure context.
    document.addEventListener('paste', (ev) => {
      if (!currentSessionId || !ev.clipboardData) return;
      const item = Array.prototype.find.call(ev.clipboardData.items, (it) => it.type.indexOf('image/') === 0);
      if (!item) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const file = item.getAsFile();
      const reader = new FileReader();
      reader.onload = () => {
        const dataBase64 = reader.result.slice(reader.result.indexOf(',') + 1);
        authedFetch('/session/' + currentSessionId + '/paste-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataBase64: dataBase64, ext: item.type.split('/')[1] }),
        }).catch(() => {});
      };
      reader.readAsDataURL(file);
    }, true);

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

      eventSource = new EventSource('/session/' + sessionId + '/stream?token=' + encodeURIComponent(currentAuthValue()));
      eventSource.onmessage = (ev) => {
        term.write(JSON.parse(ev.data));
      };
    }

    for (const btn of document.querySelectorAll('.keys button[data-byte]')) {
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

    // xterm.js manages scrollback itself (it redraws rows rather than growing
    // a real scrollable DOM element), so a touch device's native scroll
    // gesture doesn't reliably drive it — these call its own scroll API
    // directly, which works regardless of touch/trackpad/wheel quirks.
    document.getElementById('scrollUpBtn').addEventListener('click', () => term && term.scrollLines(-10));
    document.getElementById('scrollDownBtn').addEventListener('click', () => term && term.scrollLines(10));
    document.getElementById('scrollBottomBtn').addEventListener('click', () => term && term.scrollToBottom());

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
    ensureAuthed().then(route);
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

      // Pairing is deliberately excluded from the generic credential check
      // below: it only ever accepts the raw ephemeral token, never a
      // device.<id>.<secret> credential, so an already-paired device can
      // never silently mint sibling devices.
      if (req.method === 'POST' && pathname === '/pair') {
        const suppliedToken = (req.headers['x-driver-token'] as string) || '';
        if (!timingSafeEqualStr(suppliedToken, token)) {
          sendJson(res, 401, { ok: false, error: 'bad or missing driver token' });
          return;
        }
        readBody(req)
          .then((body) => {
            let parsed: { name?: string };
            try {
              parsed = JSON.parse(body);
            } catch {
              parsed = {};
            }
            const name = (parsed.name || 'Unnamed device').toString().trim().slice(0, 60) || 'Unnamed device';
            const device: TrustedDevice = {
              id: randomUUID(),
              secret: randomBytes(32).toString('hex'),
              name,
              pairedAt: Date.now(),
              lastSeenAt: Date.now(),
            };
            deps.addTrustedDevice(device);
            sendJson(res, 200, { deviceId: device.id, deviceSecret: device.secret });
          })
          .catch((e) => sendJson(res, 500, { ok: false, error: (e as Error).message }));
        return;
      }

      // Everything below requires the token (ephemeral, or a paired
      // device's persistent credential). EventSource can't set headers, so
      // the stream route accepts it as a query param instead.
      const sessionMatch = /^\/session\/([^/]+)\/(buffer|stream|input|resize|paste-image)$/.exec(pathname);
      const isStream = sessionMatch && sessionMatch[2] === 'stream';
      const suppliedToken = isStream ? query.get('token') || undefined : (req.headers['x-driver-token'] as string | undefined);

      if (pathname === '/sessions' || sessionMatch) {
        const auth = verifyCredential(suppliedToken, token, deps);
        if (!auth.ok) {
          sendJson(res, 401, { ok: false, error: 'bad or missing driver token' });
          return;
        }
        if (auth.deviceId) deps.touchTrustedDevice(auth.deviceId);
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

      if (req.method === 'POST' && route === 'paste-image') {
        readBody(req)
          .then((body) => {
            let parsed: { dataBase64?: string; ext?: string };
            try {
              parsed = JSON.parse(body);
            } catch {
              sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
              return;
            }
            if (!parsed.dataBase64) {
              sendJson(res, 400, { ok: false, error: 'missing dataBase64' });
              return;
            }
            const filePath = savePastedImage(Buffer.from(parsed.dataBase64, 'base64'), parsed.ext || 'png');
            const ok = deps.writeToSession(sessionId, `@"${filePath}" `);
            sendJson(res, ok ? 200 : 404, { ok });
          })
          .catch((e) => sendJson(res, 500, { ok: false, error: (e as Error).message }));
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    });

    const bonjour = new Bonjour();

    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      // TXT carries only the hostname — never the token or a device
      // secret — since mDNS multicast is unauthenticated and visible to
      // anything on the LAN, not just the intended phone.
      bonjour.publish({
        name: `terminalApp on ${os.hostname()}`,
        type: 'terminalapp',
        protocol: 'tcp',
        port,
        txt: { hostname: os.hostname() },
      });
      resolve({
        port,
        token,
        stop: () =>
          new Promise((r) => {
            bonjour.unpublishAll(() => {
              bonjour.destroy(() => {
                server.close(() => r());
              });
            });
          }),
      });
    });
  });
}
