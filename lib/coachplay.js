// The coach as an opponent: plays at a target strength and steers games toward the player's
// weaknesses (openings they lose in, tactics they miss, pieces they leave hanging, endgames).
import { Chess } from 'chess.js';
import { COLOR, NAME, VALUE, describeMove, hangingPieces, isFork, playLine } from './tactics.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const other = (c) => (c === 'w' ? 'b' : 'w');
const cpOf = (line) => (line.mate != null ? (line.mate > 0 ? 10000 - line.mate : -10000 - line.mate) : line.cp);

// Search depth and how loosely moves are chosen for a target rating. Weaker settings keep more
// candidate moves in play and pick among them more randomly, which plays far more like a human
// of that level than a full-strength engine that occasionally throws in a random blunder.
export function strengthParams(elo) {
  const e = clamp(elo || 1200, 400, 2900);
  return {
    elo: e,
    depth: e < 900 ? 5 : e < 1300 ? 7 : e < 1700 ? 9 : e < 2100 ? 11 : e < 2500 ? 13 : 16,
    multipv: e < 1300 ? 8 : 6,
    temp: clamp(220 * Math.exp(-(e - 600) / 600), 4, 180), // softmax temperature, centipawns
    maxLoss: clamp(600 * Math.exp(-(e - 600) / 600), 25, 500), // never consider worse moves than this
  };
}

// What to steer toward. `focus` is 'auto' (from the profile), 'openings', 'tactics', 'endgames' or 'none'.
export function steeringFor(profile, focus = 'auto') {
  const s = { openings: [], mode: null, reason: null };
  if (focus === 'none') return s;
  const weak = profile?.weaknesses?.filter((w) => w.severity > 1.15) || [];
  if ((focus === 'auto' || focus === 'openings') && profile?.openings?.weak?.length) s.openings = profile.openings.weak;
  const MODE = { missedTactic: 'tactics', missedMate: 'tactics', hanging: 'pressure', allowedTactic: 'pressure', allowedMate: 'pressure', endgameErr: 'endgames', middlegameErr: 'middlegame', openingErr: null };
  if (focus === 'tactics') s.mode = 'tactics';
  else if (focus === 'endgames') s.mode = 'endgames';
  else if (focus === 'auto') {
    const top = weak.find((w) => MODE[w.tag]);
    if (top) { s.mode = MODE[top.tag]; s.reason = top; }
  }
  return s;
}

function moveFromUci(chess, uci) {
  try { return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }); } catch { return null; }
}

// Pick the coach's move. Returns { uci, san, intent, comment, warnings, tactic?, opening? }.
export async function coachMove(engine, { fen, moves = [], elo, focus = 'auto', profile = null, sinceTactic = 99 }) {
  const chess = new Chess(fen);
  if (chess.isGameOver()) return null;
  const me = chess.turn();
  const you = other(me);
  const p = strengthParams(elo);
  const steer = steeringFor(profile, focus);

  // 1. Openings the player has been losing in: follow the line from their own recent game.
  if (steer.openings.length && moves.length < 14) {
    for (const o of steer.openings) {
      if (o.color !== you || !o.line || o.line.length <= moves.length) continue;
      if (!moves.every((u, i) => o.line[i] === u)) continue;
      const mv = moveFromUci(new Chess(fen), o.line[moves.length]);
      if (mv) return finish(fen, mv, { intent: 'opening', opening: o.name, openingGames: o.games });
    }
  }

  const res = await engine.analyse(fen, { depth: p.depth, multipv: p.multipv, movetime: 1500 });
  const cands = res.lines.filter((l) => l.pv?.length).map((l) => ({ uci: l.pv[0], pv: l.pv, cp: cpOf(l) }));
  if (!cands.length) {
    const any = chess.moves({ verbose: true })[0];
    return any ? finish(fen, any, { intent: 'normal' }) : null;
  }
  const best = Math.max(...cands.map((c) => c.cp));

  // 2. Tactic practice: now and then, leave the player a winning tactic to find.
  if (steer.mode === 'tactics' && sinceTactic >= 6 && moves.length >= 12 && best > -300 && best < 600 && Math.random() < 0.35) {
    const t = await findTacticGift(engine, fen, me, cands, best);
    if (t) return finish(fen, moveFromUci(new Chess(fen), t.uci), { intent: 'tactic', tactic: t });
  }

  // 3. Normal choice: a softmax over the engine's candidates, nudged by the steering mode.
  const scored = cands
    .filter((c) => c.cp === best || best - c.cp <= p.maxLoss)
    .map((c) => {
      const mv = moveFromUci(new Chess(fen), c.uci);
      let bonus = 0;
      let intent = 'normal';
      if (mv) {
        const trade = mv.captured && VALUE[mv.captured] >= VALUE[mv.piece] - 1;
        if (steer.mode === 'endgames' && Math.abs(best) < 250 && trade) { bonus += mv.captured === 'q' ? 45 : 25; intent = 'trade'; }
        if (steer.mode === 'middlegame' && trade && Math.abs(best) < 250) bonus -= 20;
        if (steer.mode === 'pressure' && describeMove(mv).some((f) => / attacks | forks /.test(` ${f} `))) { bonus += 25; intent = 'pressure'; }
      }
      return { ...c, mv, bonus, intent, loss: best - c.cp };
    })
    .filter((c) => c.mv);
  const weights = scored.map((c) => Math.exp(-Math.max(0, c.loss - c.bonus) / p.temp));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  let pick = scored[0];
  for (let i = 0; i < scored.length; i++) { r -= weights[i]; if (r <= 0) { pick = scored[i]; break; } }
  return finish(fen, pick.mv, { intent: pick.bonus > 0 ? pick.intent : 'normal', evalCp: pick.cp });
}

// Find a coach move that hands the player a real (engine-verified) tactic: after it, the player's
// best reply wins at least two pawns' worth of material. Prefers the least costly such gift.
async function findTacticGift(engine, fen, me, cands, best) {
  const you = other(me);
  const chess = new Chess(fen);
  const pool = new Map();
  // Ranked by how good a puzzle they make: allowing a fork (2) beats leaving a different piece
  // loose (1), which beats simply dropping the piece that moved (0).
  for (const mv of chess.moves({ verbose: true })) {
    const after = new Chess(mv.after);
    if (after.isGameOver()) continue;
    let rank = -1;
    if (after.moves({ verbose: true }).some((r) => isFork(r))) rank = 2;
    const hang = hangingPieces(mv.after, me).filter((h) => h.value >= 2);
    if (hang.length) rank = Math.max(rank, hang.some((h) => h.square !== mv.to) ? 1 : 0);
    if (rank >= 0) pool.set(mv.lan, { uci: mv.lan, rank });
  }
  for (const c of cands) if (playLine(fen, c.pv, me, 6).swing <= -2) pool.set(c.uci, { uci: c.uci, rank: 1 });
  const picks = [...pool.values()].sort((a, b) => b.rank - a.rank || Math.random() - 0.5).slice(0, 6);
  let chosen = null;
  for (const c of picks) {
    const after = new Chess(fen);
    const mv = moveFromUci(after, c.uci);
    if (!mv || after.isGameOver()) continue;
    const res = await engine.analyse(after.fen(), { depth: 10, multipv: 1, movetime: 700 });
    const line = res.lines[0];
    if (!line?.pv?.length) continue;
    const yours = playLine(after.fen(), line.pv, you, 6);
    const coachCp = -cpOf(line); // line is from the player's side
    // A real but modest gift: two to three pawns' worth (up to a minor piece), so the game stays a game.
    // (Stockfish rates a piece at ~6-8 pawns, so the eval drop allowed here is generous on purpose.)
    if (yours.swing >= 2 && yours.swing <= 3 && coachCp > best - 1100) {
      const score = c.rank * 1000 + coachCp;
      if (!chosen || score > chosen.score) chosen = { uci: c.uci, reply: line.pv[0], line: line.pv.slice(0, 6), gain: yours.trade, coachCp, score, kind: c.rank === 2 ? 'fork' : 'material' };
    }
  }
  return chosen;
}

// Describe the coach's move and warn about what it threatens, in short coach-style sentences.
function finish(fen, mv, extra) {
  const after = new Chess(mv.after);
  const you = other(mv.color);
  const facts = describeMove(mv);
  let comment = '';
  if (extra.intent === 'opening') comment = `Let's practice the ${extra.opening}. It cost you points in ${extra.openingGames} recent games.`;
  else if (extra.intent === 'tactic') comment = "Your move. There's a strong tactic here. Can you find it?";
  else if (extra.intent === 'trade') comment = "I'm happy to trade pieces. Let's see your endgame.";
  else if (after.isCheckmate()) comment = 'Checkmate!';
  else if (mv.captured) comment = `I take your ${NAME[mv.captured]}.`;
  else if (after.inCheck()) comment = 'Check!';
  const attack = facts.find((f) => / forks | attacks /.test(` ${f} `));
  if (attack && extra.intent !== 'tactic') {
    const said = attack.replace(/^the /, 'my ').replace(/ (attacks|forks) the /, ' $1 your ').replace(/ and the /g, ' and your ').replace(/undefended your/, 'your undefended');
    comment = `${comment} ${said[0].toUpperCase()}${said.slice(1)}.`.trim();
  }
  const warnings = hangingPieces(mv.after, you)
    .filter((h) => h.value >= 2)
    .map((h) => `Your ${NAME[h.piece]} on ${h.square} can be taken.`);
  return { uci: mv.lan, san: mv.san, from: mv.from, to: mv.to, intent: extra.intent, comment, warnings, tactic: extra.tactic || null, opening: extra.opening || null, coach: COLOR[mv.color] };
}

// A hint for the player: the best move, plus what the opponent is threatening right now.
export async function coachHint(engine, fen) {
  const chess = new Chess(fen);
  const me = chess.turn();
  const res = await engine.analyse(fen, { depth: 12, multipv: 1, movetime: 1200 });
  const best = res.lines[0]?.pv?.[0];
  const mv = best ? moveFromUci(new Chess(fen), best) : null;
  let threat = null;
  if (!chess.inCheck()) {
    // "Null move": give the opponent the move to see what they'd do.
    const parts = fen.split(' ');
    parts[1] = other(me);
    parts[3] = '-';
    try {
      const flipped = new Chess(parts.join(' '));
      const t = await engine.analyse(flipped.fen(), { depth: 10, multipv: 1, movetime: 800 });
      const pv = t.lines[0]?.pv;
      if (pv?.length) {
        const line = playLine(flipped.fen(), pv, other(me), 5);
        const tm = moveFromUci(new Chess(flipped.fen()), pv[0]);
        if (tm && (line.swing >= 1 || line.mate)) threat = { san: tm.san, from: tm.from, to: tm.to, text: line.mate ? `threatens ${tm.san} with checkmate` : `threatens ${tm.san}, winning ${line.trade}` };
      }
    } catch {}
  }
  return { best: mv ? { uci: mv.lan, san: mv.san, from: mv.from, to: mv.to, piece: NAME[mv.piece] } : null, threat };
}
