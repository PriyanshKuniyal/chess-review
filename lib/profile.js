// Player profiles: learn a player's weaknesses from their recent games, in the background.
// Each game is analysed once (quick, low-priority engine work) and stored on disk, so learning
// survives restarts and only new games are analysed next time. Summaries weight games by age:
// a game from HALF_LIFE_DAYS ago counts half as much as one played today.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listArchives, listGames } from './chesscom.js';
import { listLichessGames } from './lichess.js';
import { reviewGame } from './analysis.js';

export const HALF_LIFE_DAYS = 30;
const MAX_GAMES = +process.env.CHESS_REVIEW_PROFILE_GAMES || 60; // newest games learned from
const MAX_AGE_DAYS = 180;      // older games barely count anyway (1/64 weight)
const PROFILE_VERSION = 1;
const BAD = new Set(['inaccuracy', 'mistake', 'miss', 'blunder']);
const DRAWS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

// Kept outside the app folder so profiles survive updating to a new release.
export function dataDir() {
  if (process.env.CHESS_REVIEW_DATA) return process.env.CHESS_REVIEW_DATA;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'ChessReview');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ChessReview');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'chess-review');
}

// What each weakness means, how to spot it in a reviewed move, and a rough "typical" rate per
// 40 moves used to judge how much of a problem it is for this player.
export const WEAKNESSES = {
  hanging: { label: 'Leaves pieces undefended', detail: 'You often leave a piece where it can be taken for free.', typical: 0.9 },
  allowedTactic: { label: 'Walks into tactics', detail: 'Opponents find forks and other tactics against you.', typical: 1.0 },
  missedTactic: { label: 'Misses tactics', detail: "You miss chances to win material when your opponent slips.", typical: 0.8 },
  missedMate: { label: 'Misses checkmates', detail: 'You sometimes miss a forced mate.', typical: 0.12 },
  allowedMate: { label: 'Overlooks mating threats', detail: 'You sometimes miss that your king is in danger.', typical: 0.1 },
  openingErr: { label: 'Opening mistakes', detail: 'You lose ground early in the game.', typical: 0.7 },
  middlegameErr: { label: 'Middlegame mistakes', detail: 'Your errors cluster in the middlegame.', typical: 1.4 },
  endgameErr: { label: 'Endgame technique', detail: 'You let advantages slip in the endgame.', typical: 0.8 },
};

// Weakness tags for one reviewed move (empty for good moves). Shared with the coach so in-game
// feedback can say "this is a pattern from your games".
export function moveTags(m) {
  if (!BAD.has(m.label)) return [];
  const kinds = new Set((m.links || []).map((l) => `${l.kind}:${l.base}`));
  const tags = [];
  if (kinds.has('hang:after')) tags.push('hanging');
  if (kinds.has('fork:after') || kinds.has('loss:after')) tags.push('allowedTactic');
  if (m.label === 'miss' || kinds.has('gain:before') || kinds.has('fork:before')) tags.push('missedTactic');
  if (kinds.has('mate:before')) tags.push('missedMate');
  if (kinds.has('mate:after')) tags.push('allowedMate');
  if (m.label !== 'inaccuracy') tags.push(`${m.phase}Err`);
  return tags;
}

function gameRecord(game, review, username) {
  const lc = username.toLowerCase();
  const color = review.headers.white?.toLowerCase() === lc ? 'w' : review.headers.black?.toLowerCase() === lc ? 'b' : null;
  if (!color) return null;
  const me = color === 'w' ? game.white : game.black;
  const opp = color === 'w' ? game.black : game.white;
  const mine = review.moves.filter((m) => m.color === color);
  const tags = Object.fromEntries(Object.keys(WEAKNESSES).map((k) => [k, 0]));
  const examples = [];
  for (const m of mine) {
    const t = moveTags(m);
    for (const k of t) if (k in tags) tags[k]++;
    if (t.length && examples.length < 8 && (m.label === 'mistake' || m.label === 'blunder' || m.label === 'miss')) {
      examples.push({ fen: m.fenBefore, played: m.uci, playedSan: m.san, best: m.bestUci, bestSan: m.bestSan, label: m.label, tags: t, phase: m.phase, moveNo: Math.floor(m.ply / 2) + 1 });
    }
  }
  const stats = review.stats[color];
  return {
    id: game.id,
    endTime: game.endTime,
    color,
    result: me.result === 'win' ? 'win' : DRAWS.has(me.result) ? 'draw' : 'loss',
    timeClass: game.timeClass,
    rating: +me.rating || null,
    oppRating: +opp.rating || null,
    accuracy: stats.accuracy,
    estRating: stats.rating,
    phases: stats.phases,
    moves: mine.length,
    counts: stats.counts,
    opening: review.opening || null,
    line: review.moves.slice(0, 12).map((m) => m.uci),
    tags,
    examples,
    opponent: opp.username,
  };
}

export class ProfileStore {
  constructor(engine, book) {
    this.engine = engine;
    this.book = book;
    this.dir = path.join(dataDir(), 'profiles');
    fs.mkdirSync(this.dir, { recursive: true });
    this.cache = new Map();
    this.jobs = new Map(); // key -> { state, done, total, error, current }
  }

  key(source, username) { return `${source}-${username.trim().toLowerCase()}`; }
  file(key) { return path.join(this.dir, `${key.replace(/[^\w-]/g, '_')}.json`); }

  load(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    let p = null;
    try { p = JSON.parse(fs.readFileSync(this.file(key), 'utf8')); } catch {}
    if (p && p.version !== PROFILE_VERSION) p = null;
    this.cache.set(key, p);
    return p;
  }

  save(p) {
    p.updatedAt = Date.now();
    const f = this.file(p.key);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(p));
    fs.renameSync(`${f}.tmp`, f); // atomic: a crash mid-write never corrupts the profile
    this.cache.set(p.key, p);
  }

  // The profile the app opens with (the last one used).
  get active() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'active.json'), 'utf8')); } catch { return null; }
  }
  setActive(source, username) {
    fs.writeFileSync(path.join(this.dir, 'active.json'), JSON.stringify({ source, username }));
  }

  status(key) { return this.jobs.get(key) || { state: 'idle', done: 0, total: 0 }; }

  // Starts (or joins) a background sync. Resolves when it finishes; callers usually don't wait.
  sync(source, username) {
    const key = this.key(source, username);
    const job = this.jobs.get(key);
    if (job?.state === 'syncing') return job.promise;
    const state = { state: 'syncing', done: 0, total: 0, error: null };
    this.jobs.set(key, state);
    this.setActive(source, username);
    state.promise = this.#run(key, source, username, state)
      .then(() => { state.state = 'done'; })
      .catch((e) => { state.state = 'error'; state.error = e.message; console.error(`Profile sync failed for ${key}:`, e.message); });
    return state.promise;
  }

  async #fetchRecent(source, username) {
    const cutoff = Date.now() / 1000 - MAX_AGE_DAYS * 86400;
    let games = [];
    if (source === 'lichess') {
      let until;
      while (games.length < MAX_GAMES) {
        const page = await listLichessGames(username, { until, max: 40 });
        games = games.concat(page.games);
        if (!page.next || page.games.at(-1)?.endTime < cutoff) break;
        until = page.next;
      }
    } else {
      const archives = (await listArchives(username)).reverse(); // newest month first
      for (const a of archives) {
        const month = await listGames(a);
        games = games.concat(month);
        if (games.length >= MAX_GAMES || (month.at(-1)?.endTime ?? 0) < cutoff) break;
      }
    }
    const lc = username.toLowerCase();
    return games
      .filter((g) => g.endTime >= cutoff && [g.white.username, g.black.username].some((n) => n.toLowerCase() === lc))
      .sort((a, b) => b.endTime - a.endTime)
      .slice(0, MAX_GAMES);
  }

  async #run(key, source, username, state) {
    const profile = this.load(key) || { version: PROFILE_VERSION, key, source, username, games: {}, createdAt: Date.now() };
    profile.username = username;
    const recent = await this.#fetchRecent(source, username);
    const todo = recent.filter((g) => !profile.games[g.id]);
    state.total = todo.length;
    for (const g of todo) {
      state.current = `${g.white.username} vs ${g.black.username}`;
      try {
        const review = await reviewGame(g.pgn, this.engine, { depth: 12, movetime: 900, book: this.book, username, quick: true, priority: 'low' });
        const rec = gameRecord(g, review, username);
        profile.games[g.id] = rec || { id: g.id, skipped: true, endTime: g.endTime };
      } catch (e) {
        profile.games[g.id] = { id: g.id, skipped: true, endTime: g.endTime, error: e.message };
      }
      state.done++;
      this.save(profile); // after every game, so closing the app loses nothing
    }
    // Forget games that have aged out entirely.
    const cutoff = Date.now() / 1000 - MAX_AGE_DAYS * 86400;
    for (const [id, rec] of Object.entries(profile.games)) if (rec.endTime < cutoff) delete profile.games[id];
    profile.syncedAt = Date.now();
    this.save(profile);
  }

  // --- Puzzles from the player's own mistakes, with spaced repetition ---
  // Every stored mistake position becomes a puzzle: find a better move than the one played.
  // Solving one first try (no hint) pushes it out along REVIEW_DAYS; missing it brings it back soon.
  puzzles(source, username, { limit = 20 } = {}) {
    const p = this.load(this.key(source, username));
    if (!p) return { puzzles: [], stats: { total: 0, due: 0, fresh: 0, mastered: 0 } };
    const now = Date.now();
    const top = new Set(summarize(p).weaknesses?.filter((w) => w.severity > 1.15).map((w) => w.tag) || []);
    const state = p.puzzleState || {};
    const all = [];
    for (const g of Object.values(p.games)) {
      if (g.skipped) continue;
      for (const e of g.examples || []) {
        if (!e.best || e.best === e.played) continue;
        const id = puzzleId(e);
        const st = state[id] || null;
        // Priority for new puzzles: recent games and the player's biggest weak spots first.
        const weight = weightOf(g, now / 1000) * (e.tags.some((t) => top.has(t)) ? 1.6 : 1) * (e.label === 'blunder' ? 1.2 : 1);
        all.push({
          id, fen: e.fen, played: e.played, playedSan: e.playedSan || null, best: e.best, bestSan: e.bestSan || null,
          label: e.label, tags: e.tags, theme: puzzleTheme(e.tags), phase: e.phase, moveNo: e.moveNo || null,
          game: { id: g.id, endTime: g.endTime, opponent: g.opponent || null, color: g.color, timeClass: g.timeClass },
          state: st, weight, due: st ? st.due <= now : true, fresh: !st,
        });
      }
    }
    const mastered = all.filter((x) => x.state?.box >= REVIEW_DAYS.length).length;
    // Due reviews (oldest due first), then new puzzles by priority.
    const queue = [
      ...all.filter((x) => x.due && !x.fresh).sort((a, b) => a.state.due - b.state.due),
      ...all.filter((x) => x.fresh).sort((a, b) => b.weight - a.weight),
    ];
    return {
      puzzles: queue.slice(0, limit),
      stats: {
        total: all.length, due: all.filter((x) => x.due && !x.fresh).length, fresh: all.filter((x) => x.fresh).length, mastered,
        themes: all.reduce((acc, x) => { acc[x.theme.title] = (acc[x.theme.title] || 0) + 1; return acc; }, {}),
      },
    };
  }

  recordPuzzle(source, username, id, { solved, firstTry, hints = 0 }) {
    const p = this.load(this.key(source, username));
    if (!p) return null;
    p.puzzleState ||= {};
    const st = p.puzzleState[id] || { box: 0, attempts: 0, solvedCount: 0 };
    st.attempts++;
    st.last = Date.now();
    if (solved && firstTry && !hints) {
      st.solvedCount++;
      st.box = Math.min(st.box + 1, REVIEW_DAYS.length);
      st.due = Date.now() + REVIEW_DAYS[st.box - 1] * 86400e3;
    } else {
      if (solved) st.solvedCount++;
      st.box = 0;
      st.due = Date.now() + 10 * 60e3; // try it again later today
    }
    p.puzzleState[id] = st;
    this.save(p);
    return st;
  }

  summary(source, username) {
    const key = this.key(source, username);
    const p = this.load(key);
    const job = this.status(key);
    const base = { key, source, username, sync: { state: job.state, done: job.done, total: job.total, error: job.error, current: job.current } };
    if (!p) return { ...base, games: 0 };
    return { ...base, ...summarize(p) };
  }
}

const REVIEW_DAYS = [1, 3, 7, 14, 30];
const puzzleId = (e) => crypto.createHash('sha1').update(`${e.fen}|${e.played}`).digest('hex').slice(0, 12);

// What the puzzle trains, from the mistake's tags.
function puzzleTheme(tags) {
  if (tags.includes('missedMate')) return { key: 'mate', title: 'Find the checkmate', prompt: 'There was a forced mate here.' };
  if (tags.includes('allowedMate')) return { key: 'defend', title: 'Stop the mate', prompt: 'Your king was in danger here. Find the move that keeps it safe.' };
  if (tags.includes('missedTactic')) return { key: 'tactic', title: 'Find the tactic', prompt: 'There was a way to win material here.' };
  if (tags.includes('hanging')) return { key: 'safe', title: 'Keep your pieces safe', prompt: 'Your game move left a piece hanging. Find a move that keeps everything protected.' };
  if (tags.includes('allowedTactic')) return { key: 'threat', title: 'Spot the danger', prompt: 'Your game move walked into a tactic. Find a move that avoids it.' };
  return { key: 'better', title: 'Find a better move', prompt: 'Your game move let the advantage slip.' };
}

const weightOf = (rec, now) => 0.5 ** (Math.max(0, now - rec.endTime) / 86400 / HALF_LIFE_DAYS);

// Everything the UI and the coach need, with every game weighted by how recent it is.
export function summarize(p, now = Date.now() / 1000) {
  const games = Object.values(p.games).filter((g) => !g.skipped);
  if (!games.length) return { games: 0, syncedAt: p.syncedAt || null };
  let W = 0, moveW = 0, accW = 0, ratingW = 0, ratingSum = 0, estSum = 0;
  const tagW = Object.fromEntries(Object.keys(WEAKNESSES).map((k) => [k, 0]));
  const phase = { opening: [0, 0], middlegame: [0, 0], endgame: [0, 0] };
  const openings = new Map();
  for (const g of games) {
    const w = weightOf(g, now);
    W += w;
    moveW += w * g.moves;
    accW += w * g.accuracy;
    estSum += w * g.estRating;
    if (g.rating) { ratingW += w; ratingSum += w * g.rating; }
    for (const k in tagW) tagW[k] += w * (g.tags[k] || 0);
    for (const ph in phase) if (g.phases?.[ph] != null) { phase[ph][0] += w * g.phases[ph]; phase[ph][1] += w; }
    if (g.opening) {
      const family = g.opening.split(':')[0].trim();
      const id = `${g.color}|${family}`;
      const o = openings.get(id) || { name: family, color: g.color, weight: 0, games: 0, score: 0, line: g.line, lineTime: 0 };
      o.weight += w;
      o.games++;
      o.score += w * (g.result === 'win' ? 1 : g.result === 'draw' ? 0.5 : 0);
      if (g.endTime > o.lineTime) { o.line = g.line; o.lineTime = g.endTime; } // most recent example line
      openings.set(id, o);
    }
  }
  // Rates per 40 moves, blended with a "typical" prior worth ~5 games so that one rare event in a
  // handful of games doesn't look like a major weakness.
  const PRIOR_MOVES = 200;
  const per40 = (k) => ((tagW[k] + (WEAKNESSES[k].typical * PRIOR_MOVES) / 40) / (moveW + PRIOR_MOVES)) * 40;
  const phaseAcc = Object.fromEntries(Object.entries(phase).map(([k, [s, n]]) => [k, n ? s / n : null]));
  const accuracy = accW / W;
  const weaknesses = Object.entries(WEAKNESSES)
    .map(([tag, def]) => ({ tag, label: def.label, detail: def.detail, rate: per40(tag), severity: per40(tag) / def.typical }))
    .sort((a, b) => b.severity - a.severity);
  const ops = [...openings.values()].map((o) => ({ ...o, score: o.score / o.weight, lineTime: undefined }));
  const weakOpenings = ops.filter((o) => o.games >= 2 && o.score < 0.45).sort((a, b) => a.score - b.score || b.weight - a.weight);
  const latest = games.reduce((a, g) => Math.max(a, g.endTime), 0);
  return {
    games: games.length,
    weight: W,
    halfLifeDays: HALF_LIFE_DAYS,
    syncedAt: p.syncedAt || null,
    latestGame: latest,
    accuracy,
    phases: phaseAcc,
    rating: ratingW ? Math.round(ratingSum / ratingW) : null,
    estRating: Math.round(estSum / W),
    weaknesses,
    openings: { weak: weakOpenings.slice(0, 5), common: ops.sort((a, b) => b.weight - a.weight).slice(0, 6) },
    examples: games.sort((a, b) => b.endTime - a.endTime).flatMap((g) => g.examples || []).slice(0, 30),
  };
}
