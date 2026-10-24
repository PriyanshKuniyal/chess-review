// Turns a PGN + engine evaluations into a full game review:
// move classifications, accuracy, estimated rating, phases and explanation facts.
import { Chess } from 'chess.js';
import { epd } from './openings.js';
import {
  COLOR, NAME, VALUE, describeMove, findSacrifice, gamePhase, lineMotif, playLine,
} from './tactics.js';

// Bump when classification or facts change so cached reviews are recomputed.
export const REVIEW_VERSION = 9;
export const LABELS = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder', 'forced'];

// Win probability (0-100) for White from a White-POV score. Same curve lichess uses.
export function winPercent(score) {
  if (score.mate != null) return score.mate > 0 ? 100 : score.mate < 0 ? 0 : (score.matedSide === 'w' ? 0 : 100);
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * score.cp)) - 1);
}

function cpClamp(score) {
  if (score.mate != null) return score.mate > 0 ? 1000 : score.mate < 0 ? -1000 : (score.matedSide === 'w' ? -1000 : 1000);
  return Math.max(-1000, Math.min(1000, score.cp));
}

// Convert an engine line (side-to-move POV) to White POV.
function toWhite(line, turn) {
  const s = turn === 'w' ? 1 : -1;
  if (line.mate != null) return { mate: line.mate * s };
  return { cp: line.cp * s };
}

export function formatScore(score) {
  if (score.mate != null) {
    if (score.mate === 0) return score.matedSide === 'w' ? '0-1' : '1-0';
    return (score.mate > 0 ? 'M' : '-M') + Math.abs(score.mate);
  }
  const v = score.cp / 100;
  return (v > 0 ? '+' : '') + v.toFixed(2);
}

function uciToSan(fen, uci) {
  try {
    const c = new Chess(fen);
    return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch { return uci; }
}

// --- Accuracy (lichess method: per-move accuracy, volatility-weighted + harmonic mean) ---
export function moveAccuracy(winBefore, winAfter) {
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * Math.max(0, winBefore - winAfter)) - 3.166924740191411;
  return Math.min(100, Math.max(0, raw + 1));
}

function stdDev(xs) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

function gameAccuracy(whiteWins, moves) {
  const n = whiteWins.length;
  const win = Math.min(8, Math.max(2, Math.floor(moves.length / 10)));
  const windows = [];
  const first = whiteWins.slice(0, Math.min(win, n));
  for (let i = 0; i < Math.min(win, n) - 2; i++) windows.push(first);
  for (let i = 0; i + win <= n; i++) windows.push(whiteWins.slice(i, i + win));
  const weights = windows.map((w) => Math.min(12, Math.max(0.5, stdDev(w))));
  const result = {};
  for (const color of ['w', 'b']) {
    let wsum = 0, wtot = 0, hsum = 0, count = 0;
    moves.forEach((m, i) => {
      if (m.color !== color) return;
      const w = weights[i] ?? 1;
      wsum += m.accuracy * w;
      wtot += w;
      hsum += 1 / Math.max(m.accuracy, 1);
      count++;
    });
    if (!count) { result[color] = null; continue; }
    const weighted = wsum / wtot;
    const harmonic = count / hsum;
    result[color] = (weighted + harmonic) / 2;
  }
  return result;
}

// Rough performance estimate. Accuracy alone is noisy (short or one-sided games score high),
// so like Chess.com's game rating it is pulled toward the player's actual rating when known.
function estimateRating(accuracy, elo) {
  const pts = [[0, 100], [40, 250], [50, 400], [60, 700], [70, 1100], [75, 1400], [80, 1800], [85, 2200], [90, 2600], [95, 2900], [98, 3100], [100, 3200]];
  let fromAcc = 100;
  for (let i = 1; i < pts.length; i++) {
    if (accuracy <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      fromAcc = y0 + ((accuracy - x0) / (x1 - x0)) * (y1 - y0);
      break;
    }
  }
  const est = elo > 0 ? 0.7 * fromAcc + 0.3 * elo : fromAcc;
  return Math.round(Math.max(100, Math.min(3300, est)) / 50) * 50;
}

// --- Classification ---
function classify(ctx) {
  const { legalCount, inBook, loss, isBest, gap, wpBefore, wpAfter, sacrifice, prev, recapture, bestScoreMover } = ctx;
  if (legalCount === 1) return 'forced';
  if (inBook) return 'book';
  // Sacrifices in an already-won position only count when they force mate (e.g. a queen sac mate).
  const forcesMate = bestScoreMover.mate != null && bestScoreMover.mate > 0 && isBest;
  if (sacrifice && loss <= 2 && wpAfter >= 50 && (wpBefore <= 97 || forcesMate)) return 'brilliant';
  if (isBest && gap >= 18 && !recapture && wpBefore <= 95 && legalCount > 2) return 'great';
  // Finding the only move that punishes the opponent's blunder also counts as great.
  if (isBest && prev && (prev.label === 'blunder' || prev.label === 'mistake') && gap >= 10 && !recapture && wpBefore <= 95) return 'great';
  if (isBest) return 'best';
  let label;
  if (loss < 2) label = 'excellent';
  else if (loss < 5) label = 'good';
  else if (loss < 10) label = 'inaccuracy';
  else if (loss < 20) label = 'mistake';
  else label = 'blunder';

  if (label === 'inaccuracy' || label === 'mistake' || label === 'blunder') {
    const oppErred = prev && prev.loss >= 10;
    const missedMate = bestScoreMover.mate != null && bestScoreMover.mate > 0;
    const stillOk = wpAfter >= 30; // a "miss" leaves you fine; throwing the game is a blunder
    if ((oppErred || missedMate) && wpBefore >= 60 && stillOk) return 'miss';
  }
  return label;
}

// --- Facts and template explanations ---
const BAD_LABELS = ['inaccuracy', 'mistake', 'blunder', 'miss'];
const joinFacts = (fs) => fs.join(', ').replace(/^the /, 'The ');

// The single most important reason a move is good or bad, in plain words (or null).
function keyPoint(m, ctx) {
  const r = ctx.refute;
  const bl = ctx.bestLine;
  const reply = r.san[0];
  const replyFacts = r.moves[0] ? describeMove(r.moves[0]).filter((f) => !f.includes('en prise')) : [];
  const hang = describeMove(ctx.move).find((f) => f.includes('en prise'));
  const opp = m.color === 'w' ? 'b' : 'w';
  const line = (l, n = 5) => l.san.slice(0, n).join(' ');
  // Only claim material is won/lost when the evaluation moved by a matching amount; engine lines
  // can be cut off mid-sequence, and a claim the eval doesn't back up misleads the coach.
  const backed = (pawns) => ctx.cpDrop >= 60 * pawns;
  if (m.label === 'brilliant') {
    let s = `${m.san} sacrifices the ${NAME[ctx.sacrifice.piece]} on ${ctx.sacrifice.square}, and the sacrifice works${ctx.bestScoreMover.mate > 0 ? ' (it leads to checkmate)' : ''}.`;
    const them = COLOR[opp], us = COLOR[m.color];
    if (r.moves[0]?.to === ctx.sacrifice.square) {
      s += ` If ${them} takes it with ${reply}, ${us} continues ${r.san.slice(1, 5).join(' ') || 'with a winning position'}${r.mate ? ' (checkmate)' : ''}.`;
    } else if (reply) s += ` ${them}'s best is not to take it but to play ${reply}.`;
    return s;
  }
  if (!BAD_LABELS.includes(m.label)) return null;
  if (m.label === 'miss') {
    const motif = lineMotif(bl, m.color);
    if (ctx.bestScoreMover.mate > 0) return `${m.bestSan} would have forced checkmate (${line(bl)}), but ${m.san} misses it.`;
    if (bl.swing >= 1 && backed(bl.swing)) return `${m.bestSan} would have won ${bl.trade}${motif ? `; in that line ${motif.text}` : ''}, but ${m.san} misses it.`;
    if (motif) return `${m.bestSan} would have punished the opponent's error: in the line ${line(bl, motif.ply + 1)}, ${motif.text}. ${m.san} lets the chance go.`;
    return `The opponent's last move (${ctx.prev?.san}) was an error, and ${m.bestSan} would have punished it; ${m.san} lets the chance go.`;
  }
  if (ctx.afterScoreMover.mate != null && ctx.afterScoreMover.mate < 0) {
    return `After ${m.san} the opponent can force checkmate in ${-ctx.afterScoreMover.mate}: ${line(r, 7)}.`;
  }
  // Missing a forced mate matters more than any material.
  if (!m.isBest && ctx.bestScoreMover.mate > 0) {
    return `${m.bestSan} was checkmate${ctx.bestScoreMover.mate > 1 ? ` in ${ctx.bestScoreMover.mate} (${line(bl, ctx.bestScoreMover.mate * 2 - 1)})` : ''}, but ${m.san} misses it.`;
  }
  if (r.swing <= -1 && backed(-r.swing)) {
    const how = replyFacts.length ? ` (${replyFacts.join(', ')})` : '';
    return `After ${m.san} the opponent plays ${reply}${how} and ${COLOR[m.color]} loses ${r.trade}.`;
  }
  const threat = lineMotif(r, opp);
  if (threat) return `After ${m.san} the opponent has a tactic: in the line ${line(r, threat.ply + 1)}, ${threat.text}.`;
  if (hang) return `${m.san} is risky: ${hang}.`;
  if (ctx.bestScoreMover.mate > 0) return `${m.bestSan} would have forced checkmate.`;
  if (bl.swing >= 1 && backed(bl.swing)) return `${m.bestSan} would have won ${bl.trade}.`;
  return null;
}

// Phrases the coach is likely to use for each idea (matched case-insensitively in the UI).
const MAT = '(?:a |an |the |two |three |his |her |your |its )?(?:pawn|knight|bishop|rook|queen|piece|exchange|material)s?(?: for (?:a |an |two )?(?:pawn|knight|bishop|rook|queen|piece)s?)?';
const PATTERNS = {
  loss: [`\\b(?:los(?:e|es|ing|t)|drop(?:s|ped|ping)?|giv(?:e|es|ing) up|gave up|hang(?:s|ing)?|blunder(?:s|ed|ing)?(?: away)?) ${MAT}`, '\\blos(?:e|es|ing|t) material\\b'],
  gain: [`\\b(?:win(?:s|ning)?|won|gain(?:s|ed|ing)?|pick(?:s|ed|ing)? up|grab(?:s|bed|bing)?|net(?:s|ted)?) ${MAT}`],
  mate: ['\\bforced (?:check)?mate\\b', '\\bcheckmate\\b', '\\bmate in \\d+\\b', '\\bmating (?:attack|net|pattern)\\b'],
  fork: ['\\bfork(?:s|ed|ing)?\\b', '\\bdouble attack\\b'],
  tactic: ['\\btactic(?:s|al)?\\b', '\\bthreat(?:s|en|ens|ened)?\\b'],
  hang: ['\\ben prise\\b', '\\bhanging\\b', '\\bundefended\\b', '\\bunprotected\\b', '\\bleft (?:the \\w+ )?unguarded\\b'],
  sac: ['\\bsacrific(?:e|es|ed|ing)\\b'],
};

// Lines that show an idea on the board: clicking "loses a knight" in the explanation plays the
// moves where the knight is lost, so an idea that only pays off a few moves later is easy to see.
// base 'after' = continues after the move; 'before' = an alternative to the move (e.g. the best line).
function ideaLinks(m, ctx, pbPv, paPv) {
  const links = [];
  const add = (kind, base, uci, patterns, label) => {
    if (uci.length) links.push({ kind, base, uci: uci.slice(0, 12), patterns, label });
  };
  const us = COLOR[m.color];
  const them = COLOR[m.color === 'w' ? 'b' : 'w'];
  const r = ctx.refute;
  const bl = ctx.bestLine;
  const backed = (pawns) => ctx.cpDrop >= 60 * pawns;
  const gainShown = !m.isBest && bl.swing >= 1 && backed(bl.swing);
  // Where a clicked line should stop: the first quiet point (no capture pending) at which the
  // material is worst (dir -1, a loss) or best (dir +1, a gain) for the mover.
  const settle = (line, dir) => {
    let at = -1;
    for (let i = 0; i < (line.balances?.length || 0); i++) {
      if (line.moves[i + 1]?.captured) continue;
      if (at < 0 || dir * line.balances[i] > dir * line.balances[at]) at = i;
    }
    return at;
  };
  const mateBefore = !m.isBest && ctx.bestScoreMover.mate > 0;

  if (ctx.afterScoreMover.mate != null && ctx.afterScoreMover.mate < 0) add('mate', 'after', paPv, PATTERNS.mate, `Show how ${them} mates`);
  if (mateBefore) add('mate', 'before', pbPv, PATTERNS.mate, `Show the mate ${us} could have had`);
  if (ctx.afterScoreMover.mate > 0 && paPv.length) add('mate', 'after', paPv, PATTERNS.mate, `Show the mate ${us} has`);
  if (m.label === 'brilliant') add('sac', 'after', paPv.slice(0, 6), PATTERNS.sac, 'Show why the sacrifice works');
  const netEnd = ctx.net ? settle(ctx.net, -1) : -1; // index 0 is the move itself
  if (r.swing <= -1 && backed(-r.swing) && netEnd > 0) {
    // With no better line to point at, "wins a knight" in the text is about the opponent's gain.
    const loss = gainShown ? PATTERNS.loss : PATTERNS.loss.concat(PATTERNS.gain);
    add('loss', 'after', paPv.slice(0, netEnd), loss, `Show how ${us} loses ${r.trade}`);
  }
  if (gainShown && !mateBefore) add('gain', 'before', pbPv.slice(0, settle(bl, 1) + 1), PATTERNS.gain, `Show how ${m.bestSan} wins ${bl.trade}`);
  const threat = paPv.length ? lineMotif(r, m.color === 'w' ? 'b' : 'w') : null;
  if (threat && BAD_LABELS.includes(m.label)) add('fork', 'after', paPv.slice(0, threat.ply + 3), PATTERNS.fork.concat(PATTERNS.tactic), `Show the ${them} tactic`);
  const motif = !m.isBest && !mateBefore && pbPv.length ? lineMotif(bl, m.color) : null;
  if (motif) add('fork', 'before', pbPv.slice(0, motif.ply + 3), PATTERNS.fork, `Show the ${us} tactic`);
  if (describeMove(ctx.move).some((f) => f.includes('en prise'))) add('hang', 'after', paPv.slice(0, 2), PATTERNS.hang, `Show how ${them} takes it`);
  // Whole lines, so any move the coach names can be clicked.
  if (!m.isBest) add('line', 'before', pbPv.slice(0, 8), [], 'Best line');
  add('line', 'after', paPv.slice(0, 8), [], 'Engine line');
  return links;
}

function buildFacts(m, ctx) {
  const who = COLOR[m.color];
  const facts = [];
  facts.push(`${who} played ${m.san} (move ${Math.floor(m.ply / 2) + 1}). Classification: ${m.label}.`);
  const key = keyPoint(m, ctx);
  if (key) facts.push(`Main reason (say this first, in your own words): ${key}`);
  const own = describeMove(ctx.move);
  if (own.length) facts.push(`What ${m.san} does: ${joinFacts(own)}.`);
  if (m.label === 'book' && ctx.openingName) facts.push(`This is a known opening move (${ctx.openingName}).`);

  const wpTxt = (x) => (x >= 90 ? 'winning' : x >= 70 ? 'clearly better' : x >= 55 ? 'slightly better' : x > 45 ? 'about equal' : x > 30 ? 'slightly worse' : x > 10 ? 'clearly worse' : 'losing');
  facts.push(`Before the move ${who} was ${wpTxt(m.wpBefore)}; after it ${who} is ${wpTxt(m.wpAfter)}.`);

  if (!m.isBest && m.bestSan) {
    const bl = ctx.bestLine;
    // The engine's choice can't really hang a piece, so leave out "en prise" here.
    const bf = describeMove(bl.moves[0]).filter((f) => !f.includes('en prise'));
    facts.push(`The best move was ${m.bestSan}${bf.length ? ` (${bf.join(', ')})` : ''}${bl.san.length > 1 ? `; best line: ${bl.san.slice(0, 5).join(' ')}` : ''}.`);
  }
  if (BAD_LABELS.includes(m.label) && ctx.refute.san.length && m.label !== 'miss') {
    const r = ctx.refute;
    facts.push(`The opponent's best reply is ${r.san[0]}; line: ${r.san.slice(0, 5).join(' ')}.`);
    if (!key) facts.push(`${m.san} does not lose material directly; it is a positional or timing error that lets the opponent improve. Don't guess a deeper reason.`);
  }
  if (m.label === 'miss' && ctx.prev) facts.push(`The opponent had just made a ${ctx.prev.label} with ${ctx.prev.san}.`);
  if (m.label === 'great') facts.push(`${m.san} was the only good move; every alternative was clearly worse.`);
  return facts;
}

function templateText(m, ctx) {
  const L = m.label;
  const best = m.bestSan;
  const key = keyPoint(m, ctx);
  switch (L) {
    case 'book': return `${m.san} is a known opening move${ctx.openingName ? ` (${ctx.openingName})` : ''}.`;
    case 'forced': return `${m.san} was the only legal move.`;
    case 'brilliant': return `${m.san} is brilliant! ${key}`;
    case 'great': return `${m.san} is a great find: it was the only move that keeps the position together.`;
    case 'best': return `${m.san} is the best move here.`;
    case 'excellent': return `${m.san} is an excellent move, almost as strong as ${best}.`;
    case 'good': return `${m.san} is a solid move, but ${best} was a bit stronger.`;
    default: {
      let t = `${m.san} is ${L === 'inaccuracy' ? 'an inaccuracy' : L === 'miss' ? 'a missed opportunity' : 'a ' + L}.`;
      if (key) t += ` ${key}`;
      else if (ctx.refute.san[0]) t += ` The opponent can answer with ${ctx.refute.san[0]}.`;
      if (L !== 'miss' && !key?.startsWith(best)) t += ` ${best} was the better choice.`;
      return t;
    }
  }
}

// --- Engine work per position ---
const EMPTY_LINE = { san: [], moves: [], swing: 0, trade: '' };

// Searches one position. `playedUci` is the move actually played from it: when that move is the
// engine's choice we also search the best alternative, which "great" (only-move) detection needs.
export async function analysePosition(engine, fen, { depth = 18, movetime, playedUci } = {}) {
  const chess = new Chess(fen);
  const turn = fen.split(' ')[1];
  const legalMoves = chess.moves({ verbose: true });
  let lines = [];
  let second = null;
  let score;
  if (chess.isCheckmate()) score = { mate: 0, matedSide: turn };
  else if (chess.isStalemate() || chess.isInsufficientMaterial()) score = { cp: 0 };
  else {
    const res = await engine.analyse(fen, { depth, multipv: 1, movetime });
    lines = res.lines.map((l) => ({ ...toWhite(l, turn), pv: l.pv }));
    score = lines[0] ? { cp: lines[0].cp, mate: lines[0].mate } : { cp: 0 };
    if (score.mate == null) delete score.mate; else delete score.cp;
    const bestUci = lines[0]?.pv[0];
    if (playedUci && playedUci === bestUci && legalMoves.length > 1) {
      const others = legalMoves.map((m) => m.lan).filter((m) => m !== bestUci);
      const alt = await engine.analyse(fen, { depth: Math.max(10, depth - 4), multipv: 1, searchmoves: others, movetime });
      if (alt.lines[0]) second = { ...toWhite(alt.lines[0], turn), pv: alt.lines[0].pv };
    }
  }
  return { fen, turn, score, lines, second, legal: legalMoves.length, win: winPercent(score) };
}

// Everything about one move: classification, accuracy, best line, coach facts and template.
// `h` is a chess.js verbose move; `pb`/`pa` are analysePosition() results before and after it.
function buildMove({ h, ply, pb, pa, prev = null, prevH = null, inBook = false, openingName = null, clock = null }) {
  const color = h.color;
  const sign = color === 'w' ? 1 : -1;
  const moverWin = (w) => (color === 'w' ? w : 100 - w);
  const uci = h.from + h.to + (h.promotion || '');

  const wpBefore = moverWin(pb.win);
  const wpAfter = moverWin(pa.win);
  const loss = Math.max(0, wpBefore - wpAfter);
  const bestUci = pb.lines[0]?.pv[0] || null;
  // Equal to the engine's choice within search noise also counts as best.
  const isBest = uci === bestUci || (loss < 1 && pa.score.mate == null && Math.abs(pa.score.cp - (pb.score.cp ?? 1e9)) <= 10);
  const gap = pb.second ? wpBefore - moverWin(winPercent(pb.second)) : 0;

  // Recaptures, even trades and grabbing a loose piece are obvious, so they never count as "great".
  const recapture = !!(h.captured && (
    (prevH && prevH.captured && prevH.to === h.to) ||
    VALUE[h.captured] >= VALUE[h.piece] || VALUE[h.captured] >= 3));
  const sacrifice = loss <= 2 && !inBook ? findSacrifice(h.before, h) : null;

  const bestScoreMover = pb.score.mate != null ? { mate: pb.score.mate * sign } : { cp: pb.score.cp * sign };
  // mate 0 after a move means the mover just delivered checkmate.
  const afterScoreMover = pa.score.mate != null
    ? { mate: pa.score.mate === 0 ? 1 : pa.score.mate * sign }
    : { cp: pa.score.cp * sign };
  const cpBefore = cpClamp(pb.score) * sign;
  const cpAfter = cpClamp(pa.score) * sign;

  const ctx = {
    legalCount: pb.legal, inBook, loss, isBest, gap, wpBefore, wpAfter, sacrifice, prev, recapture,
    bestScoreMover, afterScoreMover, move: h, openingName, cpDrop: Math.max(0, cpBefore - cpAfter),
  };
  const label = classify(ctx);

  ctx.bestLine = bestUci ? playLine(h.before, pb.lines[0].pv, color) : EMPTY_LINE;
  ctx.refute = pa.lines[0] ? playLine(h.after, pa.lines[0].pv, color) : EMPTY_LINE;
  if (pa.lines[0]) {
    // Material is counted from before the move, so a capture followed by a recapture nets out.
    const net = playLine(h.before, [uci, ...pa.lines[0].pv], color, 9);
    ctx.refute = { ...ctx.refute, swing: net.swing, trade: net.trade };
    ctx.net = net;
  }

  const m = {
    ply, color, san: h.san, uci, from: h.from, to: h.to, piece: h.piece, captured: h.captured || null,
    fenBefore: h.before, fenAfter: h.after, label, loss, wpBefore, wpAfter, isBest,
    cpLoss: Math.max(0, cpBefore - cpAfter),
    accuracy: inBook || label === 'forced' ? 100 : moveAccuracy(wpBefore, wpAfter),
    bestUci, bestSan: bestUci ? uciToSan(h.before, bestUci) : null,
    bestLineSan: ctx.bestLine.san, bestLineUci: bestUci ? pb.lines[0].pv.slice(0, 12) : [],
    refuteSan: ctx.refute.san,
    // The engine's expected continuation after this move (for "Engine line" in the UI).
    nextLineUci: pa.lines[0] ? pa.lines[0].pv.slice(0, 12) : [],
    evalAfter: formatScore(pa.score), clock,
    phase: gamePhase(new Chess(h.after), ply, inBook),
  };
  m.key = keyPoint(m, ctx);
  m.facts = buildFacts(m, ctx);
  m.template = templateText(m, ctx);
  m.links = ideaLinks(m, ctx, pb.lines[0]?.pv || [], pa.lines[0]?.pv || []);
  return m;
}

// --- Main entry ---
export async function reviewGame(pgn, engine, { depth = 18, book, username, onProgress } = {}) {
  const game = new Chess();
  game.loadPgn(pgn);
  const headers = game.getHeaders();
  const history = game.history({ verbose: true });
  if (!history.length) throw new Error('This game has no moves to review.');

  // Clock times from [%clk h:mm:ss] comments, keyed by position after the move.
  const clocks = new Map();
  for (const { fen, comment } of game.getComments()) {
    const m = /\[%clk\s+([\d:.]+)\]/.exec(comment || '');
    if (m) clocks.set(fen, m[1]);
  }

  const fens = [history[0].before, ...history.map((h) => h.after)];
  let done = 0;
  // Per-position time cap; most positions reach the target depth well before it.
  const movetime = depth <= 14 ? 1200 : depth <= 18 ? 3000 : 8000;
  // Searched concurrently across the engine pool.
  const positions = await Promise.all(fens.map(async (fen, i) => {
    const p = await analysePosition(engine, fen, { depth, movetime, playedUci: history[i]?.lan });
    onProgress?.(++done, fens.length);
    return p;
  }));

  // Book detection: consecutive moves from the start that stay in the opening database.
  let inBookStreak = true;
  let openingName = headers.Opening || null;
  const eco = headers.ECOUrl ? decodeURIComponent(headers.ECOUrl.split('/').pop()).replace(/-/g, ' ') : null;

  const moves = [];
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    const bookEntry = book?.get(epd(h.after));
    const inBook = inBookStreak && !!bookEntry;
    if (!inBook) inBookStreak = false;
    if (inBook && bookEntry.name) openingName = bookEntry.name;
    moves.push(buildMove({
      h, ply: i, pb: positions[i], pa: positions[i + 1], prev: moves[i - 1] || null, prevH: history[i - 1] || null,
      inBook, openingName, clock: clocks.get(h.after) || null,
    }));
  }

  const accuracy = gameAccuracy(positions.map((p) => p.win), moves);
  const stats = {};
  for (const c of ['w', 'b']) {
    const mine = moves.filter((m) => m.color === c);
    const counts = Object.fromEntries(LABELS.map((l) => [l, 0]));
    for (const m of mine) counts[m.label]++;
    const acpl = mine.length ? mine.reduce((a, m) => a + Math.min(m.cpLoss, 1000), 0) / mine.length : 0;
    const phases = {};
    for (const ph of ['opening', 'middlegame', 'endgame']) {
      const pm = mine.filter((m) => m.phase === ph);
      phases[ph] = pm.length ? pm.reduce((a, m) => a + m.accuracy, 0) / pm.length : null;
    }
    const acc = accuracy[c] ?? 0;
    const elo = parseInt(c === 'w' ? headers.WhiteElo : headers.BlackElo, 10);
    stats[c] = { accuracy: acc, acpl, rating: estimateRating(acc, elo), counts, phases };
  }

  const userLc = username?.toLowerCase();
  const userColor = userLc && headers.Black?.toLowerCase() === userLc ? 'b' : 'w';

  // Biggest swings, for the coach summary.
  const keyMoments = moves
    .filter((m) => ['blunder', 'mistake', 'miss', 'brilliant', 'great'].includes(m.label))
    .sort((a, b) => (b.label === 'brilliant') - (a.label === 'brilliant') || b.loss - a.loss)
    .slice(0, 6)
    .sort((a, b) => a.ply - b.ply)
    .map((m) => ({ ply: m.ply, color: m.color, san: m.san, label: m.label, bestSan: m.bestSan, key: m.key, moveNo: Math.floor(m.ply / 2) + 1 }));

  return {
    version: REVIEW_VERSION,
    depth,
    engine: engine.name,
    headers: {
      white: headers.White, black: headers.Black, whiteElo: headers.WhiteElo, blackElo: headers.BlackElo,
      result: headers.Result, date: headers.Date, termination: headers.Termination, timeControl: headers.TimeControl,
      link: headers.Link || null,
    },
    opening: openingName || eco,
    userColor,
    positions: positions.map((p) => ({ fen: p.fen, score: p.score, eval: formatScore(p.score), win: p.win })),
    moves,
    stats,
    keyMoments,
  };
}

// Analyse one move played on the board during review (a variation). Same classification and
// coach facts as a game move; `prevLabel` lets "miss" fire after an opponent's mistake.
export async function analyseMove(engine, fen, uci, { depth = 16, book, prevLabel, prevLoss } = {}) {
  const chess = new Chess(fen);
  let h;
  try { h = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }); } catch { return { legal: false }; }
  const movetime = 2500;
  const [pb, pa] = await Promise.all([
    analysePosition(engine, fen, { depth, movetime, playedUci: h.lan }),
    analysePosition(engine, h.after, { depth, movetime }),
  ]);
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
  const entry = book?.get(epd(h.after));
  const inBook = !!entry && (epd(fen) === START || !!book.get(epd(fen)));
  const prev = prevLabel ? { label: prevLabel, loss: +prevLoss || (BAD_LABELS.includes(prevLabel) ? 10 : 0), san: '' } : null;
  const ply = (parseInt(fen.split(' ')[5], 10) - 1) * 2 + (h.color === 'b' ? 1 : 0);
  const m = buildMove({ h, ply, pb, pa, prev, inBook, openingName: entry?.name || null });
  return { legal: true, move: m, after: { score: pa.score, eval: formatScore(pa.score), win: pa.win } };
}

// Engine check for "Retry" mode: is `uci` (nearly) as good as the best move in `fen`?
export async function checkMove(engine, fen, uci, depth = 16) {
  const chess = new Chess(fen);
  const turn = chess.turn();
  let played;
  try { played = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }); } catch { return { legal: false }; }
  const best = await engine.analyse(fen, { depth, multipv: 1 });
  const bestLine = best.lines[0];
  const bestUci = best.bestmove;
  const bestSan = bestUci ? uciToSan(fen, bestUci) : null;
  const winFor = (score) => (turn === 'w' ? winPercent(score) : 100 - winPercent(score));
  const wpBest = bestLine ? winFor(toWhite(bestLine, turn)) : 50;
  let wpPlayed;
  if (chess.isCheckmate()) wpPlayed = 100;
  else if (chess.isDraw()) wpPlayed = 50;
  else {
    const after = await engine.analyse(chess.fen(), { depth, multipv: 1 });
    wpPlayed = after.lines[0] ? winFor(toWhite(after.lines[0], chess.turn())) : 50;
  }
  const loss = Math.max(0, wpBest - wpPlayed);
  const correct = played.lan === bestUci || loss < 2;
  return { legal: true, correct, loss, san: played.san, bestSan, bestUci };
}
