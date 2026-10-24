// One-time setup for running from source: downloads Stockfish for this OS/CPU into ./engine
// and checks whether Ollama and the coach model are available.
//   npm run setup            (or: node scripts/setup.mjs [--skip-ollama])
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { findStockfish } from '../lib/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STOCKFISH_TAG = 'sf_19';
const ASSETS = {
  'win32-x64': 'stockfish-windows-x86-64-universal.zip',
  'win32-arm64': 'stockfish-windows-arm64-universal.zip',
  'linux-x64': 'stockfish-linux-x86-64-universal.tar.gz',
  'linux-arm64': 'stockfish-linux-arm64-universal.tar.gz',
  'darwin-x64': 'stockfish-macos-universal.tar.gz',
  'darwin-arm64': 'stockfish-macos-universal.tar.gz',
};
const MODEL = process.env.COACH_MODEL || 'qwen3:4b-instruct';
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'chess-review-setup' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const total = +res.headers.get('content-length') || 0;
  let done = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    const pct = total ? Math.floor((done / total) * 100) : 0;
    if (process.stdout.isTTY && pct !== lastPct) {
      lastPct = pct;
      process.stdout.write(`\r  ${(done / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB (${pct}%)`);
    }
  });
  await pipeline(body, fs.createWriteStream(dest));
  if (process.stdout.isTTY) process.stdout.write('\n');
}

async function setupStockfish() {
  const existing = findStockfish(ROOT);
  if (existing) {
    console.log(`✓ Stockfish found: ${path.relative(ROOT, existing) || existing}`);
    return;
  }
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) {
    console.log(`! No prebuilt Stockfish for ${process.platform}-${process.arch}. Install it yourself and set STOCKFISH_PATH.`);
    process.exitCode = 1;
    return;
  }
  const dir = path.join(ROOT, 'engine');
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, asset);
  console.log(`Downloading Stockfish (${STOCKFISH_TAG}, ${asset})…`);
  await download(`https://github.com/official-stockfish/Stockfish/releases/download/${STOCKFISH_TAG}/${asset}`, archive);
  // tar ships with Windows 10+, macOS and Linux, and reads both .zip and .tar.gz. On Windows use the
  // system one explicitly: Git's GNU tar can come first on PATH and it can't read .zip.
  const winTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const tar = process.platform === 'win32' && fs.existsSync(winTar) ? winTar : 'tar';
  execFileSync(tar, ['-xf', archive, '-C', dir], { stdio: 'inherit' });
  fs.rmSync(archive);
  const exe = findStockfish(ROOT);
  if (!exe) throw new Error('Stockfish was downloaded but the executable was not found in ./engine');
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  console.log(`✓ Stockfish installed: ${path.relative(ROOT, exe)}`);
}

async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const names = ((await res.json()).models || []).map((m) => m.name);
    if (names.includes(MODEL)) console.log(`✓ Ollama is running and ${MODEL} is installed`);
    else console.log(`! Ollama is running but the coach model is missing. Run:  ollama pull ${MODEL}\n  (or use "Set up coach" inside the app)`);
  } catch {
    console.log('! Ollama is not running. The app works without it, but written explanations need it.');
    console.log(`  Install it from https://ollama.com/download, then run:  ollama pull ${MODEL}`);
  }
}

await setupStockfish();
if (!process.argv.includes('--skip-ollama')) await checkOllama();
