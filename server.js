// Local game-review server: chess.com games -> Stockfish review -> Ollama explanations.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EnginePool, findStockfish } from './lib/engine.js';
import { listArchives, listGames } from './lib/chesscom.js';
import { listLichessGames } from './lib/lichess.js';
import { loadBook } from './lib/openings.js';
import { reviewGame, checkMove, analyseMove, REVIEW_VERSION } from './lib/analysis.js';
import * as coach from './lib/coach.js';
import { checkForUpdate, repoSlug } from './lib/update.js';
import { ProfileStore, moveTags } from './lib/profile.js';
import { coachMove, coachHint } from './lib/coachplay.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PORT = +process.env.PORT || 3000;
const CACHE = path.join(ROOT, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

const sfPath = findStockfish(ROOT);
if (!sfPath) {
  console.error('Stockfish not found. Run "npm run setup" to download it, or set STOCKFISH_PATH.');
  process.exit(1);
}
const engine = new EnginePool(sfPath);
await engine.start();
const book = loadBook(ROOT);
const profiles = new ProfileStore(engine, book);
console.log(`Engine: ${engine.name} (${engine.size} x ${engine.threads / engine.size} threads)  Book positions: ${book.size}`);

const STATIC = {
  '/': ['public/index.html', 'text/html'],
  '/vendor/chess.js': ['node_modules/chess.js/dist/esm/chess.js', 'text/javascript'],
  '/vendor/chessground.js': ['node_modules/chessground/dist/chessground.min.js', 'text/javascript'],
  '/vendor/chessground.base.css': ['node_modules/chessground/assets/chessground.base.css', 'text/css'],
  '/vendor/chessground.cburnett.css': ['node_modules/chessground/assets/chessground.cburnett.css', 'text/css'],
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PUBLIC = path.join(ROOT, 'public');

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const explainCache = new Map();
const moveCache = new Map();

// When started by the desktop launcher, exit shortly after the last app window closes.
// Each open page holds a /api/presence event stream, which drops the moment the window goes.
const AUTOSTOP = process.env.CHESS_REVIEW_AUTOSTOP === '1';
let presence = 0;
let lastSeen = Date.now();
let busy = 0;
if (AUTOSTOP) {
  setInterval(() => {
    if (presence > 0) lastSeen = Date.now();
    if (!busy && Date.now() - lastSeen > 20_000) {
      console.log('No app window open; shutting down.');
      engine.stop();
      setTimeout(() => process.exit(0), 700);
    }
  }, 2000);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function streamText(res, cacheKey, run) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  if (explainCache.has(cacheKey)) return res.end(explainCache.get(cacheKey));
  // Stop generating when the browser moves on to another move.
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
  try {
    const full = await run((tok) => res.write(tok), ctrl.signal);
    explainCache.set(cacheKey, full);
  } catch (e) {
    if (ctrl.signal.aborted) return;
    res.write(`\n[coach unavailable: ${e.message}]`);
  }
  res.end();
}

const routes = {
  'GET /api/status': async (req, res) => {
    const [coachStatus, update] = await Promise.all([coach.status(), checkForUpdate(repoSlug(PKG), PKG.version)]);
    json(res, 200, {
      app: 'chess-review', version: PKG.version, update,
      engine: { ok: !engine.dead, name: engine.name, threads: engine.threads }, coach: coachStatus,
    });
  },

  'GET /api/presence': async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': open\n\n');
    presence++;
    const keepAlive = setInterval(() => res.write(': ka\n\n'), 25_000);
    res.on('close', () => { clearInterval(keepAlive); presence--; lastSeen = Date.now(); });
  },

  'GET /api/archives': async (req, res, url) => {
    const user = url.searchParams.get('user') || '';
    if (!/^[\w-]{2,40}$/.test(user)) return json(res, 400, { error: 'Enter a valid Chess.com username' });
    const archives = await listArchives(user);
    json(res, 200, { archives: archives.reverse() });
  },

  'GET /api/games': async (req, res, url) => {
    json(res, 200, { games: await listGames(url.searchParams.get('archive') || '') });
  },

  'GET /api/lichess/games': async (req, res, url) => {
    const user = url.searchParams.get('user') || '';
    if (!/^[\w-]{2,30}$/.test(user)) return json(res, 400, { error: 'Enter a valid Lichess username' });
    const until = +url.searchParams.get('until') || undefined;
    json(res, 200, await listLichessGames(user, { until }));
  },

  // Streams NDJSON: progress lines, then one result line.
  'POST /api/analyze': async (req, res) => {
    const { pgn, depth = 18, username } = await readBody(req);
    if (!pgn) return json(res, 400, { error: 'Missing PGN' });
    const d = Math.max(10, Math.min(26, +depth || 18));
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    const file = path.join(CACHE, `${hash(pgn + '|' + d + '|v' + REVIEW_VERSION)}.json`);
    const send = (o) => res.write(JSON.stringify(o) + '\n');
    try {
      let review;
      if (fs.existsSync(file)) review = JSON.parse(fs.readFileSync(file, 'utf8'));
      else {
        const t0 = Date.now();
        review = await reviewGame(pgn, engine, { depth: d, book, username, onProgress: (done, total) => send({ type: 'progress', done, total }) });
        review.seconds = (Date.now() - t0) / 1000;
        fs.writeFileSync(file, JSON.stringify(review));
      }
      if (username) {
        const u = username.toLowerCase();
        if (review.headers.black?.toLowerCase() === u) review.userColor = 'b';
        else if (review.headers.white?.toLowerCase() === u) review.userColor = 'w';
      }
      send({ type: 'result', review });
    } catch (e) {
      console.error(e);
      send({ type: 'error', error: e.message });
    }
    res.end();
  },

  'POST /api/explain': async (req, res) => {
    const { facts, san } = await readBody(req);
    if (!Array.isArray(facts) || !san) return json(res, 400, { error: 'Missing facts' });
    await streamText(res, hash(JSON.stringify(facts)), (onTok, signal) => coach.explainMove(facts.slice(0, 30).map(String), String(san), onTok, signal));
  },

  'POST /api/summary': async (req, res) => {
    const summary = await readBody(req);
    if (!Array.isArray(summary.keyMoments)) return json(res, 400, { error: 'Missing key moments' });
    await streamText(res, hash('summary' + JSON.stringify(summary)), (onTok, signal) => coach.summarizeGame(summary, onTok, signal));
  },

  // Streams NDJSON progress while Ollama downloads the coach model.
  'POST /api/coach/pull': async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
    try {
      await coach.pullModel((p) => res.write(JSON.stringify(p) + '\n'), ctrl.signal);
      res.write(JSON.stringify({ status: 'success', done: true }) + '\n');
    } catch (e) {
      if (!ctrl.signal.aborted) res.write(JSON.stringify({ error: e.message }) + '\n');
    }
    res.end();
  },

  // --- Player profile (learned in the background) ---
  'POST /api/profile/sync': async (req, res) => {
    const { source, username } = await readBody(req);
    if (!['chesscom', 'lichess'].includes(source) || !/^[\w-]{2,40}$/.test(username || '')) return json(res, 400, { error: 'Bad profile' });
    profiles.sync(source, username); // runs in the background
    json(res, 200, profiles.summary(source, username));
  },

  'GET /api/profile': async (req, res, url) => {
    const active = profiles.active;
    const source = url.searchParams.get('source') || active?.source;
    const username = url.searchParams.get('username') || active?.username;
    if (!source || !username) return json(res, 200, null);
    json(res, 200, profiles.summary(source, username));
  },

  // --- Playing the coach ---
  'POST /api/coach/move': async (req, res) => {
    const { fen, moves, elo, focus, sinceTactic, profile } = await readBody(req);
    if (!fen) return json(res, 400, { error: 'Missing position' });
    const summary = profile?.source && profile?.username ? profiles.summary(profile.source, profile.username) : null;
    json(res, 200, await coachMove(engine, { fen, moves: Array.isArray(moves) ? moves : [], elo: +elo || 1200, focus, sinceTactic: +sinceTactic || 0, profile: summary?.games ? summary : null }));
  },

  'POST /api/coach/hint': async (req, res) => {
    const { fen } = await readBody(req);
    if (!fen) return json(res, 400, { error: 'Missing position' });
    json(res, 200, await coachHint(engine, fen));
  },

  // A move played on the board during review: classify it like a game move.
  'POST /api/analyze-move': async (req, res) => {
    const { fen, uci, prevLabel, prevLoss } = await readBody(req);
    if (!fen || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci || '')) return json(res, 400, { error: 'Bad move' });
    const key = hash(`${fen}|${uci}|${prevLabel || ''}`);
    if (!moveCache.has(key)) {
      if (moveCache.size > 2000) moveCache.clear();
      moveCache.set(key, analyseMove(engine, fen, uci, { depth: 16, book, prevLabel, prevLoss })
        .then((r) => { if (r.move) r.move.tags = moveTags(r.move); return r; })
        .catch((e) => { moveCache.delete(key); throw e; }));
    }
    json(res, 200, await moveCache.get(key));
  },

  'POST /api/check-move': async (req, res) => {
    const { fen, uci } = await readBody(req);
    if (!fen || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci || '')) return json(res, 400, { error: 'Bad move' });
    json(res, 200, await checkMove(engine, fen, uci));
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      busy++;
      try { return await route(req, res, url); } finally { busy--; }
    }
    if (req.method !== 'GET') return json(res, 404, { error: 'Not found' });
    let file = STATIC[url.pathname] && path.join(ROOT, STATIC[url.pathname][0]);
    if (!file) {
      const p = path.join(PUBLIC, path.normalize(decodeURIComponent(url.pathname)));
      if (p.startsWith(PUBLIC + path.sep) && fs.existsSync(p) && fs.statSync(p).isFile()) file = p;
    }
    if (!file) return json(res, 404, { error: 'Not found' });
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type + (type.startsWith('text') ? '; charset=utf-8' : ''), 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Chess Review running at http://localhost:${PORT}`));
coach.warmup();
// Pick up learning where it left off: only games played since the last run get analysed.
setTimeout(() => {
  const a = profiles.active;
  if (a) profiles.sync(a.source, a.username);
}, 4000);
process.on('SIGINT', () => { engine.stop(); process.exit(0); });
