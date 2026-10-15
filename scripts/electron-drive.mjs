// Drives the Folders Electron app via Playwright's CDP attachment, so it can
// be tested by selector/eval instead of blind screen-coordinate automation.
// Runs with TERMINALAPP_TEST=1 — an isolated config dir (~/.terminalapp-test)
// that never auto-resumes real sessions, kept separate from both the
// installed app and a manually-run `npm start` dev instance.
//
// Usage (one command per line on stdin, executed in order):
//   node scripts/electron-drive.mjs <<'EOF'
//   screenshot before
//   click [data-testid=new-session-btn]
//   wait #session-overlay:not(.hidden)
//   type powershell
//   click #session-start
//   wait [data-testid=session-row]
//   state
//   EOF
//
// Commands:
//   screenshot [name]   save a PNG to .test-shots/<name>.png
//   click <css-sel>     dispatch a real DOM click (not coordinates)
//   type <text>         keyboard.type into whatever has focus
//   press <key>         keyboard.press (e.g. Enter, Escape, Control+a)
//   wait <css-sel>      waitForSelector, 10s timeout
//   eval <js-expr>      page.evaluate, prints JSON result
//   state               dump every session row's data-* state as JSON
//                        (status/activity/attention — ground truth, no
//                        pixel-color guessing needed)
//   sleep <ms>
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.test-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const electronBin = path.join(
  APP_DIR,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'
);

const app = await electron.launch({
  executablePath: electronBin,
  args: [APP_DIR],
  env: { ...process.env, TERMINALAPP_TEST: '1' },
  timeout: 30_000,
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
console.log('launched.');

async function run(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(' ');
  if (!cmd) return;
  switch (cmd) {
    case 'screenshot': {
      const f = path.join(SHOT_DIR, `${arg || 'shot-' + Date.now()}.png`);
      await page.screenshot({ path: f });
      console.log('screenshot:', f);
      break;
    }
    case 'click': {
      const ok = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.click();
        return true;
      }, arg);
      console.log('click', arg, '->', ok ? 'ok' : 'NOT_FOUND');
      break;
    }
    case 'type':
      await page.keyboard.type(arg, { delay: 20 });
      console.log('typed:', arg);
      break;
    case 'press':
      await page.keyboard.press(arg);
      console.log('pressed:', arg);
      break;
    case 'wait':
      try {
        await page.waitForSelector(arg, { timeout: 10_000 });
        console.log('found:', arg);
      } catch {
        console.log('TIMEOUT:', arg);
      }
      break;
    case 'eval': {
      try {
        const result = await page.evaluate(arg);
        console.log(JSON.stringify(result));
      } catch (e) {
        console.log('ERROR:', e.message);
      }
      break;
    }
    case 'state': {
      const result = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="session-row"]')].map((el) => ({
          id: el.dataset.sessionId,
          name: el.querySelector('.session-name')?.textContent,
          status: el.dataset.status,
          activity: el.dataset.activity,
          attention: el.dataset.attention === 'true',
        }))
      );
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'sleep':
      await new Promise((r) => setTimeout(r, Number(arg) || 500));
      break;
    default:
      console.log('unknown command:', cmd);
  }
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  try {
    await run(line);
  } catch (e) {
    console.log('ERROR:', e.message);
  }
}

// Plain app.close() can hang forever: the app shows a native "N sessions
// still running, quit anyway?" confirm dialog on close, which Playwright
// can't click through. Force-kill the process instead of waiting on it.
try {
  await Promise.race([
    app.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 5_000)),
  ]);
} catch {
  app.process()?.kill();
}
