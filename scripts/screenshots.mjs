// Regenerates the README screenshots by driving a headless Edge/Chrome over the DevTools protocol.
// Start the app first (npm start), then:  node scripts/screenshots.mjs [port]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = `http://localhost:${process.argv[2] || 3000}`;
const OUT = path.join(ROOT, 'docs', 'screenshots');
const DEBUG_PORT = 9333;
const OPERA = `[Event "Paris Opera"]
[Date "1858.11.02"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7 8.Nc3 c6 9.Bg5 b5
10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7 14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0`;

const browsers = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];
const exe = browsers.find((p) => fs.existsSync(p));
if (!exe) throw new Error('No Edge/Chrome found');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-shots-'));
const browser = spawn(exe, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  '--hide-scrollbars', '--mute-audio', '--no-first-run', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const run = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
  console.log(`saved docs/screenshots/${name}`);
};
// Waits in the page until `cond` is truthy (polling), up to `ms`.
const until = (cond, ms = 60000) => run(`const t = Date.now(); while (!(${cond})) { if (Date.now() - t > ${ms}) throw new Error('timeout: ${cond.replace(/'/g, '')}'); await new Promise(r => setTimeout(r, 150)); } return true;`);

fs.mkdirSync(OUT, { recursive: true });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1.5, mobile: false });
await send('Page.navigate', { url: APP });
await sleep(1500);

try {
  // 1. Game list from Lichess
  await run(`localStorage.setItem('cr-sound', 'off'); document.querySelector('#source [data-src=lichess]').click();
    document.getElementById('username').value = 'DrNykterstein'; document.getElementById('user-form').requestSubmit();`);
  await until(`document.querySelectorAll('.game').length > 8`);
  await sleep(1200);
  await shot('games.png');

  // 2. Review of the Opera Game at the queen sacrifice, after the coach finishes writing
  await run(`document.querySelector('#source [data-src=pgn]').click(); document.getElementById('pgn-text').value = ${JSON.stringify(OPERA)};
    document.getElementById('pgn-load').click();`);
  await until(`!document.getElementById('review').classList.contains('hidden')`, 120000);
  await until(`!document.querySelector('#ai-tag .typing') && !document.querySelector('.caret')`, 90000);
  await sleep(800);
  await shot('report.png');
  await run(`document.querySelector('.mv[data-ply="30"]').click();`);
  await until(`document.querySelector('.bubble-title')?.textContent.includes('Qb8+') && !document.querySelector('#ai-tag .typing') && !document.querySelector('.caret')`, 90000);
  await sleep(1200);
  await shot('review.png');
} finally {
  ws.close();
  browser.kill();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(process.exitCode || 0); }, 800);
}
