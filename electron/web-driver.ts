// An opt-in HTTP driver for the app's own BrowserWindow. Mirrors the
// command set of scripts/electron-drive.mjs (click/type/press/wait/eval/
// state/screenshot/sleep) but drives the real running window directly via
// webContents, instead of relaunching a separate Playwright instance.
// Never started automatically — see app:toggle-web-driver in main.ts,
// which is wired to a UI toggle that defaults to off every launch.
//
// Security: listens on all interfaces (0.0.0.0), so it's reachable from
// any device on the local network (e.g. a phone), not just this machine —
// that's deliberate, so the link can be opened off-PC. Every request still
// requires a random per-session token (shown in the UI when enabled, with
// a copy-to-clipboard button) via the X-Driver-Token header; the token,
// not the network boundary, is what gates access. `eval` runs arbitrary JS
// in the renderer (which has full Node access), so treat the token like a
// root credential for anyone on the LAN for as long as the driver is on.
import * as http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import * as os from 'os';
import type { BrowserWindow, KeyboardInputEvent, MouseInputEvent } from 'electron';

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

type Cmd = 'click' | 'mouseclick' | 'tap' | 'type' | 'press' | 'wait' | 'eval' | 'state' | 'screenshot' | 'sleep';

interface CmdRequest {
  cmd: Cmd;
  arg?: string;
}

const STATE_SNIPPET = `[...document.querySelectorAll('[data-testid="session-row"]')].map((el) => ({
  id: el.dataset.sessionId,
  name: el.querySelector('.session-name')?.textContent,
  status: el.dataset.status,
  activity: el.dataset.activity,
  attention: el.dataset.attention === 'true',
}))`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSelector(win: BrowserWindow, selector: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const expr = `!!document.querySelector(${JSON.stringify(selector)})`;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expr)) return true;
    await sleep(100);
  }
  return false;
}

const KEY_ALIASES: Record<string, string> = { esc: 'Escape', return: 'Enter', del: 'Delete' };
const MODIFIER_ALIASES: Record<string, string> = { ctrl: 'control', cmd: 'meta', option: 'alt' };

function parseKeyCombo(combo: string): { modifiers: KeyboardInputEvent['modifiers']; keyCode: string } {
  const parts = combo.split('+').map((p) => p.trim());
  const keyPart = parts.pop() || '';
  const modifiers = parts.map((p) => {
    const lower = p.toLowerCase();
    return (MODIFIER_ALIASES[lower] || lower) as NonNullable<KeyboardInputEvent['modifiers']>[number];
  });
  const keyCode = KEY_ALIASES[keyPart.toLowerCase()] || keyPart;
  return { modifiers, keyCode };
}

async function runCommand(win: BrowserWindow, req: CmdRequest): Promise<unknown> {
  const arg = req.arg || '';
  switch (req.cmd) {
    case 'click': {
      const found = await win.webContents.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(arg)});
        if (!el) return false;
        el.click();
        return true;
      })()`);
      return { found };
    }
    case 'mouseclick': {
      const box: { x: number; y: number } | null = await win.webContents.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(arg)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!box) return { found: false };
      const base: Omit<MouseInputEvent, 'type'> = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
      win.webContents.sendInputEvent({ type: 'mouseDown', ...base });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...base });
      return { found: true, x: box.x, y: box.y };
    }
    case 'tap': {
      // fx/fy are fractional (0..1) coordinates within the window's content
      // area — used by the live-mirror page, which only knows where a tap
      // landed on the displayed screenshot image, not the window's actual
      // pixel size.
      const [fxStr, fyStr] = arg.split(',');
      const [width, height] = win.getContentSize();
      const x = Math.round(Number(fxStr) * width);
      const y = Math.round(Number(fyStr) * height);
      const base: Omit<MouseInputEvent, 'type'> = { x, y, button: 'left', clickCount: 1 };
      win.webContents.sendInputEvent({ type: 'mouseDown', ...base });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...base });
      return { x, y };
    }
    case 'type': {
      for (const ch of arg) {
        win.webContents.sendInputEvent({ type: 'char', keyCode: ch } as KeyboardInputEvent);
      }
      return { typed: arg.length };
    }
    case 'press': {
      const { modifiers, keyCode } = parseKeyCombo(arg);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      return { pressed: arg };
    }
    case 'wait': {
      return { found: await waitForSelector(win, arg) };
    }
    case 'eval': {
      return await win.webContents.executeJavaScript(arg);
    }
    case 'state': {
      return await win.webContents.executeJavaScript(STATE_SNIPPET);
    }
    case 'screenshot': {
      const image = await win.webContents.capturePage();
      return { pngBase64: image.toPNG().toString('base64') };
    }
    case 'sleep': {
      await sleep(Number(arg) || 500);
      return {};
    }
    default:
      throw new Error(`unknown command: ${req.cmd}`);
  }
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

function controlPage(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>terminalApp driver</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: Consolas, monospace; background:#1e1e1e; color:#ddd; margin:0; padding:10px;
    -webkit-tap-highlight-color: transparent;
  }
  h3 { margin: 0 0 8px; font-size: 14px; color: #eee; }
  #mirror-wrap { position: relative; border: 1px solid #444; border-radius: 6px; overflow: hidden; background: #111; }
  #mirror { width: 100%; display: block; cursor: crosshair; }
  #status { font-size: 11px; color: #888; margin: 6px 0 10px; }
  .row { display: flex; gap: 6px; margin-bottom: 8px; }
  input, button, select { font-family: inherit; font-size: 13px; }
  input {
    flex: 1; background:#1e1e1e; color:#fff; border:1px solid #444; border-radius:4px; padding:6px 8px;
  }
  button {
    background:#3a3d3e; color:#ddd; border:1px solid #444; border-radius:4px; padding:6px 10px; cursor:pointer;
  }
  button:hover { filter: brightness(1.15); }
  #typeSend { background:#0e639c; border-color:#0e639c; color:#fff; }
  .keys { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
  .keys button { flex: 1; min-width: 56px; }
  details { border-top: 1px solid #333; padding-top: 10px; }
  summary { cursor: pointer; color: #aaa; font-size: 12px; margin-bottom: 8px; }
  #arg { width: auto; }
  pre { white-space:pre-wrap; word-break:break-all; background:#111; border:1px solid #333; padding:8px; min-height:60px; font-size: 12px; }
</style>
</head>
<body>
  <h3>🖥️ terminalApp — live remote control</h3>
  <div id="mirror-wrap">
    <img id="mirror" alt="live app view — tap to click">
  </div>
  <div id="status">connecting…</div>

  <div class="row">
    <input id="typeInput" placeholder="Type text, then Send or Enter" autocapitalize="off" autocorrect="off" />
    <button id="typeSend">Send</button>
  </div>
  <div class="keys">
    <button id="keyEnter">⏎ Enter</button>
    <button id="keyTab">Tab</button>
    <button id="keyEsc">Esc</button>
    <button id="keyBack">⌫</button>
    <button id="keyCtrlC">Ctrl+C</button>
  </div>

  <details>
    <summary>Advanced: raw commands</summary>
    <div class="row">
      <select id="cmd">
        <option>click</option><option>mouseclick</option><option>type</option><option>press</option>
        <option>wait</option><option>eval</option><option>state</option><option>screenshot</option><option>sleep</option>
      </select>
      <input id="arg" placeholder="arg (selector / text / js expr / ms)" />
      <button id="send">Send</button>
    </div>
    <pre id="out"></pre>
  </details>

  <script>
    const token = new URLSearchParams(location.search).get('token') || prompt('Driver token:');
    const statusEl = document.getElementById('status');
    const img = document.getElementById('mirror');

    async function sendCmd(cmd, arg) {
      const res = await fetch('/cmd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Driver-Token': token },
        body: JSON.stringify({ cmd, arg }),
      });
      return res.json();
    }

    let refreshTimer = null;
    function scheduleRefresh(delay) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshShot, delay);
    }
    function refreshShot() {
      img.src = '/screenshot?token=' + encodeURIComponent(token) + '&t=' + Date.now();
    }
    img.addEventListener('load', () => {
      statusEl.textContent = 'live — updated ' + new Date().toLocaleTimeString();
      scheduleRefresh(500);
    });
    img.addEventListener('error', () => {
      statusEl.textContent = 'could not reach the app — retrying…';
      scheduleRefresh(1500);
    });
    refreshShot();

    img.addEventListener('click', async (ev) => {
      const rect = img.getBoundingClientRect();
      const fx = (ev.clientX - rect.left) / rect.width;
      const fy = (ev.clientY - rect.top) / rect.height;
      await sendCmd('tap', fx.toFixed(4) + ',' + fy.toFixed(4));
      scheduleRefresh(150);
    });

    async function sendTyped() {
      const el = document.getElementById('typeInput');
      if (el.value) await sendCmd('type', el.value);
      el.value = '';
      scheduleRefresh(150);
    }
    document.getElementById('typeSend').addEventListener('click', sendTyped);
    document.getElementById('typeInput').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        sendTyped();
      }
    });

    const quickKeys = {
      keyEnter: 'Enter',
      keyTab: 'Tab',
      keyEsc: 'Escape',
      keyBack: 'Backspace',
      keyCtrlC: 'Control+c',
    };
    for (const id of Object.keys(quickKeys)) {
      document.getElementById(id).addEventListener('click', async () => {
        await sendCmd('press', quickKeys[id]);
        scheduleRefresh(150);
      });
    }

    document.getElementById('send').addEventListener('click', async () => {
      const cmd = document.getElementById('cmd').value;
      const arg = document.getElementById('arg').value;
      const json = await sendCmd(cmd, arg);
      document.getElementById('out').textContent = JSON.stringify(json, null, 2);
      scheduleRefresh(150);
    });
  </script>
</body>
</html>`;
}

export function startWebDriver(getWindow: () => BrowserWindow | null, port: number): Promise<WebDriverHandle> {
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

      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(controlPage());
        return;
      }

      // A plain <img src> request can't carry the X-Driver-Token header, so
      // this one route (only) accepts the token as a query param instead —
      // used by the live-mirror page's auto-refreshing screenshot.
      if (req.method === 'GET' && pathname === '/screenshot') {
        const query = new URLSearchParams((req.url || '').split('?')[1] || '');
        if (query.get('token') !== token) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad or missing token' }));
          return;
        }
        const win = getWindow();
        if (!win || win.isDestroyed()) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'app window is not available' }));
          return;
        }
        win.webContents
          .capturePage()
          .then((image) => {
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
            res.end(image.toPNG());
          })
          .catch((e) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
          });
        return;
      }

      if (req.method !== 'POST' || pathname !== '/cmd') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not found' }));
        return;
      }

      if (req.headers['x-driver-token'] !== token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad or missing X-Driver-Token header' }));
        return;
      }

      readBody(req)
        .then(async (body) => {
          let parsed: CmdRequest;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
            return;
          }
          const win = getWindow();
          if (!win || win.isDestroyed()) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'app window is not available' }));
            return;
          }
          try {
            const result = await runCommand(win, parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, result }));
          } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
          }
        })
        .catch((e) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
        });
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
