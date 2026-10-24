// Puzzles from the player's own mistakes. Each position comes from one of their games, where they
// played a mistake: the task is to find a better move. Results feed spaced repetition on the server.
import { Chessground } from '/vendor/chessground.js';
import { Chess } from '/vendor/chess.js';
import * as sound from '/sounds.js';
import { $, esc, badge, api, legalDests, linkify, squarePosFor, coordsHtml, pickPromotion, LABEL_NAME } from '/shared.js';

const Z = {
  cg: null,
  queue: [],
  stats: null,
  profile: null,
  idx: 0,
  cur: null,       // current puzzle
  attempts: 0,     // wrong tries on the current puzzle
  hints: 0,
  done: false,     // solved or given up
  results: [],     // per queue index: 'first' | 'later' | 'failed'
  orientation: 'white',
  preview: null,
  explain: null,   // { move, played } analyses for the finished puzzle
};

const sanOf = (fen, uci) => {
  try { return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }).san; } catch { return uci; }
};
const when = (sec) => new Date(sec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ---------- Opening the tab ----------
function show() {
  for (const v of ['picker', 'review', 'play-setup', 'play', 'puzzles']) $(v).classList.toggle('hidden', v !== 'puzzles');
  $('crumb').textContent = '';
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === 'puzzles'));
  fitBoard();
}

$('modes').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b?.dataset.mode !== 'puzzles') return;
  show();
  if (!Z.cur || Z.done && Z.idx >= Z.queue.length - 1) load();
});

async function load() {
  let data;
  try { data = await api('/api/puzzles?limit=20'); } catch (err) { return emptyState(`Couldn't load puzzles: ${esc(err.message)}`); }
  Z.queue = data.puzzles || [];
  Z.stats = data.stats;
  Z.profile = data.profile;
  Z.idx = 0;
  Z.results = [];
  renderSide();
  if (!Z.profile) {
    return emptyState('Puzzles are built from your own games. Tell the coach your username first and it will collect the positions where you went wrong.', true);
  }
  if (!Z.queue.length) {
    return emptyState(Z.profile.sync === 'syncing'
      ? 'Still learning from your games. Puzzles appear as soon as the first mistakes are found.'
      : Z.stats?.total ? 'All caught up! No puzzles are due right now. Come back tomorrow for your reviews.' : 'No mistakes found in your recent games yet.', false, Z.profile.sync === 'syncing');
  }
  start(0);
}

function emptyState(text, setup = false, retry = false) {
  ensureBoard();
  Z.cur = null;
  Z.cg.set({ fen: new Chess().fen(), lastMove: undefined, movable: { color: undefined, dests: new Map() } });
  $('pz-coords').innerHTML = coordsHtml('white');
  $('pz-fx').innerHTML = '';
  $('pz-bar-top').innerHTML = '';
  $('pz-bar-bottom').innerHTML = '';
  $('pz-bubble').innerHTML = `<div class="bubble-inner"><div class="bubble-text">${text}</div>
    ${setup ? '<div class="bubble-foot"><button class="chip-btn green" id="pz-to-play">Set up my profile</button></div>' : ''}
    ${retry ? '<div class="bubble-foot"><button class="chip-btn" id="pz-reload">Check again</button></div>' : ''}</div>`;
  $('pz-to-play')?.addEventListener('click', () => document.querySelector('#modes [data-mode=play]').click());
  $('pz-reload')?.addEventListener('click', load);
  for (const id of ['pz-hint', 'pz-solution', 'pz-skip', 'pz-next']) $(id).disabled = true;
}

// ---------- Board ----------
function ensureBoard() {
  if (Z.cg) return;
  Z.cg = Chessground($('pz-board'), {
    coordinates: false,
    animation: { enabled: true, duration: 220 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, color: undefined, showDests: true, events: { after: onMove } },
    draggable: { enabled: true, showGhost: true },
    premovable: { enabled: false },
    drawable: { enabled: true, visible: true, brushes: { green: { key: 'g', color: '#81b64c', opacity: 0.85, lineWidth: 11 }, red: { key: 'r', color: '#dd3b31', opacity: 0.8, lineWidth: 11 } } },
  });
}

function fitBoard() {
  if ($('puzzles').classList.contains('hidden')) return;
  const stage = $('pz-stage');
  let size = innerWidth > 900
    ? Math.min(stage.clientWidth - 40 - 34, stage.clientHeight - 28 - 42 * 2 - 16)
    : Math.min(innerWidth - 24 - 34, 680);
  size = Math.max(256, Math.floor(size / 8) * 8);
  document.documentElement.style.setProperty('--board', `${size}px`);
  Z.cg?.redrawAll();
}
new ResizeObserver(() => fitBoard()).observe($('pz-stage'));

function setBoard(fen, { movable = true, lastMove } = {}) {
  const c = new Chess(fen);
  const color = c.turn() === 'w' ? 'white' : 'black';
  Z.cg.set({
    fen, orientation: Z.orientation, turnColor: color, lastMove, check: c.inCheck(),
    movable: { color: movable ? color : undefined, dests: movable ? legalDests(fen) : new Map(), events: { after: onMove } },
  });
}

function mark(from, to, label) {
  const fx = $('pz-fx');
  fx.innerHTML = '';
  if (!label) return;
  const p = squarePosFor(to, Z.orientation);
  fx.innerHTML = `<div class="sq-badge" style="left:${p.left}%;top:${p.top}%">${badge(label)}</div>`;
}

// ---------- One puzzle ----------
function start(i) {
  stopPreview();
  ensureBoard();
  Z.idx = i;
  Z.cur = Z.queue[i];
  Z.attempts = 0;
  Z.hints = 0;
  Z.done = false;
  Z.explain = null;
  const pz = Z.cur;
  pz.playedSan ||= sanOf(pz.fen, pz.played);
  pz.bestSan ||= sanOf(pz.fen, pz.best);
  // Stored answers come from a quick background search; re-check with a deeper one while the
  // player thinks, and switch to the deeper answer if the stored one isn't actually good enough.
  pz.verified ||= api('/api/check-move', json({ fen: pz.fen, uci: pz.best })).then((r) => {
    if (r.legal && !r.correct && r.bestUci) { pz.best = r.bestUci; pz.bestSan = r.bestSan; }
    return r;
  }).catch(() => null);
  Z.orientation = pz.fen.split(' ')[1] === 'w' ? 'white' : 'black';
  setBoard(pz.fen);
  Z.cg.setAutoShapes([]);
  $('pz-coords').innerHTML = coordsHtml(Z.orientation);
  mark();
  renderBars();
  renderPrompt();
  renderSide();
  for (const id of ['pz-hint', 'pz-solution', 'pz-skip']) $(id).disabled = false;
  $('pz-next').disabled = true;
}

function renderBars() {
  const pz = Z.cur;
  const g = pz.game || {};
  const you = pz.fen.split(' ')[1];
  const name = Z.profile?.username || 'You';
  $('pz-bar-bottom').innerHTML = `<span class="avatar ${you}">${esc(name[0].toUpperCase())}</span>
    <div class="pb-info"><span class="pb-name">${esc(name)}</span><span class="pb-sub">${you === 'w' ? 'White' : 'Black'} to move</span></div>
    <span class="turn-dot you" id="pz-turn">Your move</span>`;
  $('pz-bar-top').innerHTML = `<span class="avatar ${you === 'w' ? 'b' : 'w'}">${esc((g.opponent || '?')[0].toUpperCase())}</span>
    <div class="pb-info"><span class="pb-name">${g.opponent ? esc(g.opponent) : 'Your opponent'}</span>
    <span class="pb-sub">${g.endTime ? `Your game on ${when(g.endTime)}` : ''}${pz.moveNo ? ` · move ${pz.moveNo}` : ''}</span></div>`;
}

function renderPrompt(extra = '') {
  const pz = Z.cur;
  $('pz-bubble').innerHTML = `<div class="bubble-inner">
    <div class="bubble-head">${badge(pz.label)}<span class="bubble-title">${esc(pz.theme.title)}</span>${pz.state ? '<span class="bubble-var">Review</span>' : ''}</div>
    <div class="bubble-text">${esc(pz.theme.prompt)} In the game you played <b>${esc(pz.playedSan)}</b>, ${pz.label === 'miss' ? 'a miss' : `a ${LABEL_NAME[pz.label].toLowerCase()}`}. Find a better move.</div>
    ${extra}</div>`;
}

async function onMove(orig, dest) {
  const pz = Z.cur;
  if (!pz || Z.done || Z.preview) return;
  const piece = new Chess(pz.fen).get(orig);
  let promo = '';
  if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
    promo = await pickPromotion($('pz-promo'), dest, piece.color, Z.orientation).promise;
    if (!promo) { setBoard(pz.fen); return; }
  }
  const uci = orig + dest + promo;
  const mv = new Chess(pz.fen).move({ from: orig, to: dest, promotion: promo || undefined });
  sound.playMove(mv.san, mv.captured);
  setBoard(mv.after, { movable: false, lastMove: [orig, dest] });
  if (uci === pz.played) return wrong(mv.san, "That's the move you played in the game.");
  renderPrompt('<div class="retry-result">Checking…</div>');
  let res;
  try { res = await api('/api/check-move', json({ fen: pz.fen, uci })); } catch { return wrong(mv.san, "Couldn't check that move."); }
  if (Z.cur !== pz) return;
  // Anything within 3% of the engine's best counts: the goal is a clearly better move than the
  // game move, not one exact answer.
  if (res.correct || res.loss < 3) solved(uci, mv, res);
  else wrong(mv.san, null, res);
}

function wrong(san, why, res) {
  const pz = Z.cur;
  Z.attempts++;
  sound.play('wrong');
  const wrap = $('pz-board-wrap');
  wrap.classList.remove('shake');
  void wrap.offsetWidth;
  wrap.classList.add('shake');
  const lost = res?.loss != null ? (res.loss >= 20 ? 'a blunder' : res.loss >= 10 ? 'a mistake' : 'not quite good enough') : '';
  const reason = why ? ` ${esc(why)}` : lost ? ` It's ${lost}.` : '';
  renderPrompt(`<div class="retry-result bad">✗ ${esc(san)} isn't it.${reason} Try again.</div>
    ${Z.attempts >= 2 ? '<div class="bubble-foot"><button class="chip-btn" data-pz="hint">Hint</button><button class="chip-btn" data-pz="solution">Show solution</button></div>' : ''}`);
  wireBubble();
  setTimeout(() => { if (Z.cur === pz && !Z.done) setBoard(pz.fen); }, 700);
}

async function solved(uci, mv, res) {
  const pz = Z.cur;
  Z.done = true;
  const first = Z.attempts === 0 && Z.hints === 0;
  Z.results[Z.idx] = first ? 'first' : 'later';
  sound.play('correct');
  mark(mv.from, mv.to, uci === res.bestUci ? 'best' : 'excellent');
  record(true, Z.attempts === 0);
  const top = uci === res.bestUci;
  finish(uci, `✓ ${first ? 'Correct!' : 'Solved!'} <b>${esc(mv.san)}</b> ${top ? 'is the best move.' : `works (the engine's top move was ${esc(res.bestSan)}).`}`, 'good');
}

async function giveUp(kind) {
  const pz = Z.cur;
  if (!pz || Z.done) return;
  await pz.verified;
  if (Z.cur !== pz || Z.done) return;
  Z.done = true;
  Z.results[Z.idx] = 'failed';
  record(false, false);
  const c = new Chess(pz.fen);
  const mv = c.move({ from: pz.best.slice(0, 2), to: pz.best.slice(2, 4), promotion: pz.best[4] || 'q' });
  setBoard(pz.fen, { movable: false });
  setTimeout(() => {
    if (Z.cur !== pz) return;
    setBoard(mv.after, { movable: false, lastMove: [mv.from, mv.to] });
    sound.playMove(mv.san, mv.captured);
    mark(mv.from, mv.to, 'best');
  }, 300);
  finish(pz.best, kind === 'skip' ? `Skipped. The best move was <b>${esc(mv.san)}</b>.` : `The solution is <b>${esc(mv.san)}</b>.`, '');
}

// After a puzzle: explain the good move and why the game move was bad (with clickable lines).
async function finish(uci, headline, cls) {
  const pz = Z.cur;
  Z.cg.setAutoShapes([]);
  $('pz-turn')?.remove();
  for (const id of ['pz-hint', 'pz-solution', 'pz-skip']) $(id).disabled = true;
  $('pz-next').disabled = false;
  renderSide();
  const render = () => {
    const e = Z.explain || {};
    const good = e.move ? `<div class="bubble-text">${linkify(e.move.template, e.move)}</div>` : '<div class="bubble-text muted">Getting the explanation…</div>';
    const bad = e.played ? `<div class="reply"><div class="reply-head"><span>In the game: ${badge(e.played.label)} <b>${esc(e.played.san)}</b></span></div><div class="bubble-text">${linkify(e.played.template, e.played)}</div></div>` : '';
    $('pz-bubble').innerHTML = `<div class="bubble-inner">
      <div class="bubble-head">${badge(pz.label)}<span class="bubble-title">${esc(pz.theme.title)}</span></div>
      <div class="retry-result ${cls}">${headline}</div>
      ${good}${bad}
      <div class="bubble-foot"><button class="chip-btn green" data-pz="next">${Z.idx < Z.queue.length - 1 ? 'Next puzzle' : 'Finish'}</button></div></div>`;
    wireBubble();
  };
  render();
  const [m, p] = await Promise.all([
    api('/api/analyze-move', json({ fen: pz.fen, uci })).catch(() => null),
    api('/api/analyze-move', json({ fen: pz.fen, uci: pz.played })).catch(() => null),
  ]);
  if (Z.cur !== pz) return;
  Z.explain = { move: m?.move || null, played: p?.move || null };
  render();
}

function record(solvedIt, firstTry) {
  const pz = Z.cur;
  if (!Z.profile) return;
  api('/api/puzzles/result', json({ ...Z.profile, id: pz.id, solved: solvedIt, firstTry, hints: Z.hints })).catch(() => {});
}

async function hint() {
  const pz = Z.cur;
  if (!pz || Z.done) return;
  await pz.verified;
  if (Z.cur !== pz || Z.done) return;
  Z.hints++;
  const from = pz.best.slice(0, 2);
  if (Z.hints === 1) {
    const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
    Z.cg.setAutoShapes([{ orig: from, brush: 'green' }]);
    renderPrompt(`<div class="retry-result">Hint: look at your ${NAME[new Chess(pz.fen).get(from)?.type] || 'piece'} on ${from}.</div>`);
  } else {
    Z.cg.setAutoShapes([{ orig: from, dest: pz.best.slice(2, 4), brush: 'green' }]);
    renderPrompt(`<div class="retry-result">Hint: the move is ${esc(pz.bestSan)}. Play it on the board.</div>`);
  }
}

function next() {
  stopPreview();
  if (Z.idx < Z.queue.length - 1) start(Z.idx + 1);
  else summary();
}

function summary() {
  const n = Z.results.filter(Boolean).length;
  const first = Z.results.filter((r) => r === 'first').length;
  const later = Z.results.filter((r) => r === 'later').length;
  Z.cur = null;
  $('pz-fx').innerHTML = '';
  for (const id of ['pz-hint', 'pz-solution', 'pz-skip', 'pz-next']) $(id).disabled = true;
  $('pz-bubble').innerHTML = `<div class="bubble-inner game-over">
    <div class="bubble-head"><span class="badge lbl-great">!</span><span class="bubble-title">Session done</span></div>
    <div class="bubble-text">You solved <b>${first}</b> of ${n} on the first try${later ? ` and ${later} more after a retry` : ''}. Puzzles you solved come back in a few days to make sure they stick; the ones you missed come back sooner.</div>
    <div class="bubble-foot"><button class="chip-btn green" data-pz="more">More puzzles</button></div></div>`;
  wireBubble();
  sound.play(first === n ? 'brilliant' : 'end');
}

function wireBubble() {
  $('pz-bubble').querySelectorAll('[data-pz]').forEach((b) => {
    b.onclick = () => ({ next, more: load, hint, solution: () => giveUp('solution') })[b.dataset.pz]();
  });
}

// Clickable ideas in explanations play the line on the board.
$('pz-bubble').addEventListener('click', (e) => {
  const b = e.target.closest('.idea');
  if (!b || !Z.explain) return;
  const a = b.closest('.reply') ? Z.explain.played : Z.explain.move;
  const link = a?.links?.[+b.dataset.li];
  if (link) previewLine(link.base === 'after' ? a.fenAfter : a.fenBefore, link.uci.slice(0, +b.dataset.n || link.uci.length));
});

function previewLine(fen, ucis) {
  stopPreview();
  const c = new Chess(fen);
  const steps = [];
  for (const u of ucis) { try { steps.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })); } catch { break; } }
  if (!steps.length) return;
  Z.preview = { i: -1 };
  setBoard(fen, { movable: false });
  $('pz-fx').innerHTML = '';
  const tick = () => {
    if (!Z.preview) return;
    const s = steps[++Z.preview.i];
    if (!s) return;
    Z.cg.set({ fen: s.after, lastMove: [s.from, s.to] });
    sound.playMove(s.san, s.captured);
    Z.preview.timer = setTimeout(tick, 850);
  };
  Z.preview.timer = setTimeout(tick, 350);
}
function stopPreview() {
  if (Z.preview) clearTimeout(Z.preview.timer);
  Z.preview = null;
}

// ---------- Side panel: session progress and the collection ----------
function renderSide() {
  const s = Z.stats;
  $('pz-count').textContent = s?.total ? `${s.total} from your games` : '';
  $('pz-progress').innerHTML = Z.queue.length
    ? Z.queue.map((_, i) => `<span class="pz-dot ${Z.results[i] || ''} ${i === Z.idx && Z.cur ? 'cur' : ''}" title="Puzzle ${i + 1}"></span>`).join('')
    : '';
  if (!s?.total) { $('pz-body').innerHTML = ''; return; }
  const themes = Object.entries(s.themes || {}).sort((a, b) => b[1] - a[1]);
  $('pz-body').innerHTML = `
    <div class="pz-stats">
      <div><b>${s.due}</b><span>due for review</span></div>
      <div><b>${s.fresh}</b><span>new</span></div>
      <div><b>${s.mastered}</b><span>mastered</span></div>
    </div>
    <h3 class="pz-h">In your collection</h3>
    ${themes.map(([t, n]) => `<div class="pz-theme"><span>${esc(t)}</span><span class="muted">${n}</span></div>`).join('')}
    <p class="muted small pz-note">Solved puzzles come back after 1, 3, 7, 14 and 30 days. Missed ones come back the same day. Recent games and your biggest weak spots come first.</p>`;
}

// ---------- Controls ----------
$('pz-hint').addEventListener('click', hint);
$('pz-solution').addEventListener('click', () => giveUp('solution'));
$('pz-skip').addEventListener('click', () => giveUp('skip'));
$('pz-next').addEventListener('click', next);
document.addEventListener('keydown', (e) => {
  if ($('puzzles').classList.contains('hidden') || e.target.matches?.('input, select, textarea')) return;
  if (e.key === 'h' || e.key === 'H') hint();
  else if ((e.key === 'ArrowRight' || e.key === 'Enter') && Z.done) next();
});
