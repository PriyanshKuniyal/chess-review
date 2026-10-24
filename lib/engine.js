// Thin UCI wrapper around a native Stockfish process.
// All searches go through one queue so concurrent requests never interleave.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Stockfish lookup order: STOCKFISH_PATH, anything named stockfish* under ./engine, then PATH.
export function findStockfish(root) {
  if (process.env.STOCKFISH_PATH && fs.existsSync(process.env.STOCKFISH_PATH)) return process.env.STOCKFISH_PATH;
  const win = process.platform === 'win32';
  // Unix binaries have no extension, which also skips the bundled source files.
  const isEngine = (name) => (win ? /^stockfish.*\.exe$/i.test(name) : /^stockfish(-[\w-]+)?$/i.test(name));
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 4 || !fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (isEngine(entry.name)) hits.push(p);
    }
  };
  walk(path.join(root, 'engine'), 0);
  if (hits.length) return hits[0];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, win ? 'stockfish.exe' : 'stockfish');
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

export class Engine {
  constructor(exePath, { threads, hash = 512 } = {}) {
    this.exePath = exePath;
    this.threads = threads || Math.max(1, os.cpus().length - 4);
    this.hash = hash;
    this.queue = Promise.resolve();
    this.listeners = new Set();
    this.buffer = '';
    this.name = 'Stockfish';
  }

  async start() {
    this.proc = spawn(this.exePath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) for (const fn of [...this.listeners]) fn(line);
      }
    });
    this.proc.on('exit', () => { this.dead = true; });
    await this.waitFor('uci', (l) => {
      if (l.startsWith('id name ')) this.name = l.slice(8);
      return l === 'uciok';
    });
    this.send(`setoption name Threads value ${this.threads}`);
    this.send(`setoption name Hash value ${this.hash}`);
    await this.waitFor('isready', (l) => l === 'readyok');
  }

  send(cmd) { this.proc.stdin.write(cmd + '\n'); }

  waitFor(cmd, done) {
    return new Promise((resolve) => {
      const fn = (line) => {
        if (done(line)) { this.listeners.delete(fn); resolve(line); }
      };
      this.listeners.add(fn);
      if (cmd) this.send(cmd);
    });
  }

  // Search a position. Scores are from the side to move's point of view.
  analyse(fen, { depth = 18, multipv = 1, searchmoves, movetime } = {}) {
    const job = this.queue.then(() => this.#search(fen, depth, multipv, searchmoves, movetime));
    this.queue = job.catch(() => {});
    return job;
  }

  async #search(fen, depth, multipv, searchmoves, movetime) {
    if (this.dead) throw new Error('Engine process has exited');
    this.send(`setoption name MultiPV value ${multipv}`);
    this.send(`position fen ${fen}`);
    const lines = new Map();
    // With both limits Stockfish stops at whichever comes first, so movetime caps rare endgames
    // that would otherwise take tens of seconds to reach the target depth.
    const go = `go depth ${depth}` + (movetime ? ` movetime ${movetime}` : '') + (searchmoves ? ` searchmoves ${searchmoves.join(' ')}` : '');
    const best = await this.waitFor(go, (line) => {
      if (line.startsWith('info ') && line.includes(' pv ') && !line.includes('bound')) {
        const parsed = parseInfo(line);
        if (parsed) lines.set(parsed.multipv, parsed);
      }
      return line.startsWith('bestmove');
    });
    const bestmove = best.split(' ')[1];
    const sorted = [...lines.values()].sort((a, b) => a.multipv - b.multipv);
    return { bestmove: bestmove === '(none)' ? null : bestmove, lines: sorted };
  }

  stop() {
    try { this.send('quit'); } catch {}
    setTimeout(() => this.proc?.kill(), 500);
  }
}

// Several engine processes searching different positions at once. At review depths many
// 2-thread engines get far more done than one engine with every thread (measured: 8x2 is
// ~4x faster than 1x16 on a 24-thread i7).
export class EnginePool {
  constructor(exePath, { size, threads = 2, hash = 128 } = {}) {
    const cpus = os.cpus().length;
    size = size || Math.max(1, Math.min(10, Math.floor((cpus - 4) / threads)));
    this.size = size;
    const perEngine = threads;
    this.engines = Array.from({ length: size }, () => new Engine(exePath, { threads: perEngine, hash }));
    this.threads = perEngine * size;
    this.idle = [];
    this.waiting = []; // { resolve, low }
    // Background work (learning a player's profile) may use all but two engines, and always
    // queues behind interactive requests, so reviews and coach moves stay snappy.
    this.lowLimit = Math.max(1, size - 2);
    this.lowActive = 0;
    this.lowWaiting = [];
  }

  async start() {
    await Promise.all(this.engines.map((e) => e.start()));
    this.idle = [...this.engines];
    this.name = this.engines[0].name;
  }

  get dead() { return this.engines.some((e) => e.dead); }

  // opts.priority: 'low' for background jobs; anything else is interactive.
  async analyse(fen, opts = {}) {
    const low = opts.priority === 'low';
    if (low) {
      if (this.lowActive >= this.lowLimit) await new Promise((resolve) => this.lowWaiting.push(resolve));
      this.lowActive++;
    }
    try {
      const engine = this.idle.pop() || (await new Promise((resolve) => this.waiting.push({ resolve, low })));
      try {
        return await engine.analyse(fen, opts);
      } finally {
        // Hand the engine to the oldest interactive waiter first, then background ones.
        let i = this.waiting.findIndex((w) => !w.low);
        if (i < 0) i = this.waiting.length ? 0 : -1;
        if (i >= 0) this.waiting.splice(i, 1)[0].resolve(engine);
        else this.idle.push(engine);
      }
    } finally {
      if (low) {
        this.lowActive--;
        this.lowWaiting.shift()?.();
      }
    }
  }

  stop() { this.engines.forEach((e) => e.stop()); }
}

function parseInfo(line) {
  const t = line.split(' ');
  const out = { multipv: 1, depth: 0, cp: null, mate: null, pv: [] };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': out.depth = +t[++i]; break;
      case 'multipv': out.multipv = +t[++i]; break;
      case 'score':
        if (t[i + 1] === 'cp') out.cp = +t[i + 2];
        else if (t[i + 1] === 'mate') out.mate = +t[i + 2];
        i += 2;
        break;
      case 'pv': out.pv = t.slice(i + 1); i = t.length; break;
    }
  }
  return out.pv.length ? out : null;
}
