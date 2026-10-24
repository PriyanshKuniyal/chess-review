// Board-level pattern detection used to explain moves: hanging pieces,
// sacrifices, forks, material swings along engine lines.
import { Chess } from 'chess.js';

export const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
export const COLOR = { w: 'White', b: 'Black' };
const other = (c) => (c === 'w' ? 'b' : 'w');

export function material(chess, color) {
  let sum = 0;
  for (const row of chess.board()) for (const sq of row) if (sq && sq.color === color) sum += VALUE[sq.type];
  return sum;
}

export function balance(chess, color) {
  return material(chess, color) - material(chess, other(color));
}

// Same position with the other side to move (en passant cleared). Null if chess.js rejects it.
function flipTurn(fen) {
  const p = fen.split(' ');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  p[3] = '-';
  try { return new Chess(p.join(' ')); } catch { return null; }
}

// Static exchange on `square`, side to move starts capturing. Returns material won (>= 0).
function seeRec(chess, square, depth) {
  if (depth > 10) return 0;
  const caps = chess.moves({ verbose: true }).filter((m) => m.to === square && m.captured);
  if (!caps.length) return 0;
  caps.sort((a, b) => (VALUE[a.piece] || 100) - (VALUE[b.piece] || 100));
  const m = caps[0];
  const gain = VALUE[m.captured] + (m.promotion ? VALUE[m.promotion] - 1 : 0);
  chess.move(m);
  const v = gain - seeRec(chess, square, depth + 1);
  chess.undo();
  return Math.max(0, v);
}

// Pieces of `color` that the opponent (who must be to move in `chess`) can win by capturing.
function hangingFor(chess, color) {
  const out = [];
  const board = chess.board();
  for (const row of board) {
    for (const sq of row) {
      if (!sq || sq.color !== color || sq.type === 'k') continue;
      if (!chess.isAttacked(sq.square, other(color))) continue;
      const value = seeRec(chess, sq.square, 0);
      if (value > 0) out.push({ square: sq.square, piece: sq.type, value });
    }
  }
  return out;
}

// Pieces `color` would lose if it were the opponent's move in `fen`.
export function hangingPieces(fen, color) {
  const parts = fen.split(' ');
  const chess = parts[1] === color ? flipTurn(fen) : new Chess(fen);
  if (!chess) return [];
  try { return hangingFor(chess, color); } catch { return []; }
}

// Does playing `move` offer material (a sacrifice)? Returns { piece, square, value } or null.
// The moved piece, or a piece the move left newly en prise, must be winnable for at least
// a minor piece's worth more than whatever the move itself captured.
export function findSacrifice(fenBefore, move) {
  const mover = move.color;
  const before = new Map(hangingPieces(fenBefore, mover).map((h) => [h.square, h.value]));
  const after = hangingPieces(move.after, mover);
  const captured = move.captured ? VALUE[move.captured] : 0;
  let best = null;
  for (const h of after) {
    if (VALUE[h.piece] < 3) continue;
    const newlyHanging = h.square === move.to || !before.has(h.square) || h.value > before.get(h.square);
    if (!newlyHanging) continue;
    const net = h.value - captured;
    if (net >= 2 && (!best || net > best.value)) best = { piece: h.piece, square: h.square, value: net };
  }
  return best;
}

// Opponent pieces attacked by the piece that just moved.
function attackedBy(chess, fromSquare, color) {
  const targets = [];
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.color === color) continue;
      if (chess.attackers(sq.square, color).includes(fromSquare)) targets.push(sq);
    }
  }
  return targets;
}

// Human-readable facts about a single move (for templates and the LLM prompt).
const describeCache = new Map();
export function describeMove(move) {
  const key = move.before + move.lan;
  if (!describeCache.has(key)) {
    if (describeCache.size > 5000) describeCache.clear();
    describeCache.set(key, describeUncached(move));
  }
  return describeCache.get(key);
}

function describeUncached(move) {
  const facts = [];
  const who = COLOR[move.color];
  const piece = NAME[move.piece];
  const after = new Chess(move.after);
  if (move.flags.includes('k')) facts.push(`${who} castles kingside`);
  else if (move.flags.includes('q')) facts.push(`${who} castles queenside`);
  if (move.captured) facts.push(`the ${piece} captures a ${NAME[move.captured]} on ${move.to}`);
  if (move.promotion) facts.push(`the pawn promotes to a ${NAME[move.promotion]}`);
  if (after.isCheckmate()) facts.push('it is checkmate');
  else if (after.inCheck()) facts.push('it gives check');

  const targets = attackedBy(after, move.to, move.color).filter((t) => t.type !== 'p');
  const defended = (sq) => after.attackers(sq, other(move.color)).length > 0;
  const juicy = targets.filter((t) => t.type === 'k' || VALUE[t.type] > VALUE[move.piece] || !defended(t.square));
  if (juicy.length >= 2) {
    facts.push(`the ${piece} on ${move.to} forks ` + juicy.map((t) => (t.type === 'k' ? 'the king' : `the ${NAME[t.type]} on ${t.square}`)).join(' and '));
  } else if (juicy.length === 1 && juicy[0].type !== 'k') {
    const t = juicy[0];
    facts.push(`the ${piece} attacks the ${defended(t.square) ? '' : 'undefended '}${NAME[t.type]} on ${t.square}`);
  }

  // A piece that captured something worth as much isn't "hanging", it's a trade.
  const captured = move.captured ? VALUE[move.captured] : 0;
  const hanging = hangingPieces(move.after, move.color)
    .filter((h) => h.value - (h.square === move.to ? captured : 0) >= 2);
  for (const h of hanging.slice(0, 2)) facts.push(`it leaves the ${NAME[h.piece]} on ${h.square} en prise`);
  return facts;
}

// Play a UCI line from `fen`; return SAN list and the material change for `color`.
export function playLine(fen, uciMoves, color, maxPlies = 8) {
  const chess = new Chess(fen);
  const start = balance(chess, color);
  const san = [];
  const moves = [];
  const balances = [];
  const won = [], lost = []; // piece types captured by / from `color`, per ply
  for (const uci of uciMoves.slice(0, Math.max(maxPlies, 12))) {
    let m;
    try { m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { break; }
    san.push(m.san);
    moves.push(m);
    balances.push(balance(chess, color) - start);
    won.push(m.captured && m.color === color ? m.captured : null);
    lost.push(m.captured && m.color !== color ? m.captured : null);
  }
  // Count material at the last quiet point (next move isn't a capture) so a snapshot taken
  // mid-exchange doesn't mislead. Exchanges may run past maxPlies, so look a little further.
  let end = balances.length - 1;
  for (let i = Math.min(balances.length, maxPlies) - 1; i >= 0; i--) {
    const next = moves[i + 1];
    if (!next || !next.captured) { end = i; break; }
  }
  const swing = end >= 0 ? balances[end] : 0;
  const trade = describeTrade(won.slice(0, end + 1).filter(Boolean), lost.slice(0, end + 1).filter(Boolean), swing);
  // `end` is the index of the move where the material count settles (the quiet point).
  return { san: san.slice(0, maxPlies), moves, balances, swing, trade, end, mate: chess.isCheckmate() };
}

// First fork or mate that `color` gets within the first few plies of a line, as a short phrase.
export function lineMotif(line, color, plies = 7) {
  for (let i = 0; i < Math.min(plies, line.moves.length); i++) {
    const mv = line.moves[i];
    if (mv.color !== color) continue;
    const f = describeMove(mv).find((x) => x.includes('forks') || x.includes('checkmate'));
    if (f) return { ply: i, san: mv.san, text: f.includes('checkmate') ? `${mv.san} is checkmate` : `${mv.san} ${f.replace(/^the \w+ on \w\d /, '')}` };
  }
  return null;
}

// "a knight", "the exchange", "a rook for a bishop"... from the side that comes out behind.
function describeTrade(won, lost, swing) {
  const a = swing < 0 ? [...lost] : [...won];
  const b = swing < 0 ? [...won] : [...lost];
  for (let i = a.length - 1; i >= 0; i--) {
    const j = b.indexOf(a[i]);
    if (j >= 0) { a.splice(i, 1); b.splice(j, 1); }
  }
  const art = (t) => (t === 'q' ? 'the queen' : `a ${NAME[t]}`);
  const list = (xs) => {
    const counts = {};
    for (const t of xs) counts[t] = (counts[t] || 0) + 1;
    return Object.entries(counts).sort((x, y) => VALUE[y[0]] - VALUE[x[0]])
      .map(([t, n]) => (n === 1 ? art(t) : `${n} ${NAME[t]}s`)).join(' and ');
  };
  if (!a.length) return materialWord(swing);
  if (a.length === 1 && a[0] === 'r' && b.length === 1 && (b[0] === 'n' || b[0] === 'b')) return 'the exchange (a rook for a minor piece)';
  return b.length ? `${list(a)} for ${list(b)}` : list(a);
}

export function materialWord(n) {
  const a = Math.abs(n);
  if (a >= 9) return 'the queen';
  if (a >= 5) return 'a rook';
  if (a >= 3) return 'a piece';
  if (a >= 2) return 'two pawns';
  return 'a pawn';
}

export function gamePhase(chess, ply, inBook) {
  if (inBook || ply < 16) return 'opening';
  let nonPawn = 0;
  let queens = 0;
  for (const row of chess.board()) for (const sq of row) {
    if (!sq || sq.type === 'p' || sq.type === 'k') continue;
    nonPawn += VALUE[sq.type];
    if (sq.type === 'q') queens++;
  }
  if (nonPawn <= 26 || (queens === 0 && nonPawn <= 32)) return 'endgame';
  return 'middlegame';
}
