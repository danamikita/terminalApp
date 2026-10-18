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

export function getLanAddress(): string | null {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

export interface WebDriverHandle {
  port: number;
  token: string;
  stop: () => Promise<void>;
}

type Cmd = 'click' | 'mouseclick' | 'type' | 'press' | 'wait' | 'eval' | 'state' | 'screenshot' | 'sleep';

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
<head><meta charset="utf-8"><title>terminalApp driver</title>
<style>
  body { font-family: Consolas, monospace; background:#1e1e1e; color:#ddd; margin:0; padding:16px; }
  select, input, button { font-family: inherit; font-size: 13px; }
  input { background:#111; color:#eee; border:1px solid #444; padding:4px 6px; }
  #arg { width: 60%; }
  pre { white-space:pre-wrap; word-break:break-all; background:#111; border:1px solid #333; padding:8px; min-height:120px; }
  img { max-width:100%; display:none; border:1px solid #444; margin-top:8px; }
</style>
</head>
<body>
  <h3>terminalApp web driver</h3>
  <p>cmd + arg, sent one at a time to <code>POST /cmd</code>.</p>
  <select id="cmd">
    <option>click</option><option>mouseclick</option><option>type</option><option>press</option>
    <option>wait</option><option>eval</option><option>state</option><option>screenshot</option><option>sleep</option>
  </select>
  <input id="arg" placeholder="arg (selector / text / js expr / ms)" />
  <button id="send">Send</button>
  <pre id="out"></pre>
  <img id="shot" />
  <script>
    const token = new URLSearchParams(location.search).get('token') || prompt('Driver token:');
    document.getElementById('send').addEventListener('click', async () => {
      const cmd = document.getElementById('cmd').value;
      const arg = document.getElementById('arg').value;
      const res = await fetch('/cmd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Driver-Token': token },
        body: JSON.stringify({ cmd, arg }),
      });
      const json = await res.json();
      document.getElementById('out').textContent = JSON.stringify(json, null, 2);
      const shot = document.getElementById('shot');
      if (json.ok && json.result && json.result.pngBase64) {
        shot.src = 'data:image/png;base64,' + json.result.pngBase64;
        shot.style.display = 'block';
      } else {
        shot.style.display = 'none';
      }
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

      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(controlPage());
        return;
      }

      if (req.method !== 'POST' || req.url !== '/cmd') {
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
