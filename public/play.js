// "Play the coach": a sparring game against an engine that adapts to the player's profile
// (learned in the background from their recent games) and comments on every move.
import { Chessground } from '/vendor/chessground.js';
import { Chess } from '/vendor/chess.js';
import * as sound from '/sounds.js';
import { $, esc, sleep, badge, api, legalDests, material, titleFor, linkify, cleanCoach, squarePosFor, coordsHtml, pickPromotion, BAD, BRUSHES, arrow, setEvalBar } from '/shared.js';

const store = {
  get: (k, d = null) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

const HELP_NOTE = {
  lots: 'Every move graded and explained in detail, warnings about threats, and a heads-up when there is a tactic to find.',
  some: 'Every move graded with a short tip, plus warnings about the mistakes you tend to make.',
  none: 'No help during the game. You get the full breakdown at the end.',
};
const GOOD = new Set(['brilliant', 'great', 'best', 'excellent']);

const P = {
  profile: null,          // summary from /api/profile
  poll: null,
  settings: { autoElo: true, elo: 1200, color: 'w', help: 'some', focus: 'auto', ...store.get('cr-play-settings', {}) },
  game: null,
  cg: null,
  preview: null,          // { timer } while a line is being shown
  hintStep: 0,
  orientation: 'white',
  showEval: store.get('cr-play-eval', false),
};

// ---------- Mode switching (Review / Play the coach) ----------
function setModeButtons(mode) {
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
}

function showPlayView(id) {
  for (const v of ['picker', 'review', 'play-setup', 'play', 'puzzles']) $(v).classList.toggle('hidden', v !== id);
  $('crumb').textContent = '';
  setModeButtons('play');
  if (id === 'play') fitBoard();
}

function openPlay() {
  if (P.game && !P.game.over) showPlayView('play');
  else { showPlayView('play-setup'); renderSetup(); }
}

$('modes').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.mode === 'play') openPlay();
  else if (b.dataset.mode === 'review') {
    stopPolling();
    $('play-setup').classList.add('hidden');
    $('play').classList.add('hidden');
    window.dispatchEvent(new CustomEvent('cr:show-review'));
  } else stopPolling();
});

// ---------- Profile (what the coach has learned) ----------
const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

async function loadProfile() {
  try { P.profile = await api('/api/profile'); } catch { P.profile = null; }
  renderProfile();
  if (P.profile?.sync?.state === 'syncing') startPolling();
}

function startPolling() {
  if (P.poll) return;
  P.poll = setInterval(async () => {
    const p = P.profile;
    if (!p) return stopPolling();
    try { P.profile = await api(`/api/profile?source=${p.source}&username=${encodeURIComponent(p.username)}`); } catch { return; }
    renderProfile();
    if (P.profile.sync.state !== 'syncing') stopPolling();
  }, 2000);
}
function stopPolling() { clearInterval(P.poll); P.poll = null; }

async function learnFrom(source, username) {
  try {
    P.profile = await api('/api/profile/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, username }) });
    renderProfile();
    startPolling();
  } catch (err) {
    $('profile-error').textContent = err.message;
  }
}
// The review screen tells us whenever a username is searched, so learning starts right away.
window.addEventListener('cr:user', (e) => {
  const { source, username } = e.detail;
  if (P.profile?.username?.toLowerCase() === username.toLowerCase() && P.profile.source === source) return;
  learnFrom(source, username);
});

function renderProfile() {
  const card = $('profile-card');
  const p = P.profile;
  if (!p || p.changing) {
    const src = p?.source || store.get('cr-play-src', 'chesscom');
    card.innerHTML = `
      <h2>Teach the coach about you</h2>
      <p class="muted">Enter your username and the coach studies your recent games in the background to find your weak spots. You can start playing right away.</p>
      <div class="seg" id="pf-source"><button data-v="chesscom" class="${src === 'chesscom' ? 'on' : ''}">Chess.com</button><button data-v="lichess" class="${src === 'lichess' ? 'on' : ''}">Lichess</button></div>
      <form class="search pf-form" id="pf-form">
        <input id="pf-user" placeholder="Your username" autocomplete="off" spellcheck="false" required value="${esc(p?.username || '')}">
        <button class="btn primary" type="submit">Learn from my games</button>
      </form>
      <p class="error" id="profile-error"></p>`;
    let source = src;
    $('pf-source').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      source = b.dataset.v;
      store.set('cr-play-src', source);
      $('pf-source').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    };
    $('pf-form').onsubmit = (e) => { e.preventDefault(); learnFrom(source, $('pf-user').value.trim()); };
    updateElo();
    return;
  }
  const sync = p.sync || {};
  const syncing = sync.state === 'syncing';
  const weak = (p.weaknesses || []).filter((w) => w.severity > 1.15).slice(0, 4);
  const shown = weak.length ? weak : (p.weaknesses || []).slice(0, 3);
  const bars = shown.map((w) => `
    <div class="weak">
      <div class="weak-head"><span>${esc(w.label)}</span><span class="muted">${w.severity >= 1.6 ? 'big focus' : w.severity > 1.15 ? 'focus' : 'typical'}</span></div>
      <div class="weak-bar"><i style="width:${Math.min(100, (w.severity / 2.5) * 100).toFixed(0)}%"></i></div>
      <div class="weak-detail">${esc(w.detail)}</div>
    </div>`).join('');
  const openings = (p.openings?.weak || []).slice(0, 3).map((o) => `<span class="chip">${esc(o.name)} <span class="muted">as ${o.color === 'w' ? 'White' : 'Black'} · ${Math.round(o.score * 100)}%</span></span>`).join('');
  card.innerHTML = `
    <div class="pf-head">
      <span class="avatar w">${esc((p.username || '?')[0].toUpperCase())}</span>
      <div class="pf-name"><b>${esc(p.username)}</b><span class="muted">${p.source === 'lichess' ? 'Lichess' : 'Chess.com'}${p.rating ? ` · rated about ${p.rating}` : ''}</span></div>
      <button class="btn ghost small" id="pf-change">Change</button>
    </div>
    ${syncing ? `<div class="pf-sync"><div class="pf-sync-text">Learning from your games… ${sync.done}/${sync.total || '?'}${sync.current ? ` <span class="muted">· ${esc(sync.current)}</span>` : ''}</div><div class="bar"><div class="bar-fill" style="width:${sync.total ? (sync.done / sync.total) * 100 : 3}%"></div></div></div>` : ''}
    ${sync.state === 'error' ? `<p class="error">Couldn't update: ${esc(sync.error)}</p>` : ''}
    ${p.games ? `
      <p class="muted pf-meta">Learned from ${p.games} game${p.games === 1 ? '' : 's'}${p.syncedAt ? ` · updated ${ago(p.syncedAt)}` : ''}. Recent games count more: one from ${p.halfLifeDays} days ago counts half as much as today's.</p>
      <h3>What the coach will work on</h3>
      ${bars}
      ${openings ? `<h3>Openings that cost you points</h3><div class="chips">${openings}</div>` : ''}`
    : `<p class="muted pf-meta">${syncing ? 'The first games take a few seconds each. You can start a game now; the coach adapts as it learns.' : 'No games found yet.'}</p>`}`;
  $('pf-change').onclick = () => { P.profile = { ...p, changing: true }; renderProfile(); };
  updateElo();
}

// ---------- Settings ----------
function autoElo() {
  const r = P.profile?.rating || P.profile?.estRating;
  return Math.max(400, Math.min(2800, Math.round(((r || 1100) + 100) / 50) * 50)); // the slider's range
}

function updateElo() {
  const s = P.settings;
  if (s.autoElo) s.elo = autoElo();
  $('elo').value = s.elo;
  $('elo').disabled = s.autoElo;
  $('elo-auto').checked = s.autoElo;
  $('elo-val').textContent = `~${s.elo}`;
}

function bindSeg(id, key) {
  const el = $(id);
  el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === P.settings[key]));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    P.settings[key] = b.dataset.v;
    el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    if (key === 'help') $('help-note').textContent = HELP_NOTE[b.dataset.v];
    store.set('cr-play-settings', P.settings);
  });
}

function renderSetup() {
  $('help-note').textContent = HELP_NOTE[P.settings.help];
  $('play-resume').classList.toggle('hidden', !store.get('cr-play-game'));
  updateElo();
  loadProfile();
}

bindSeg('play-color', 'color');
bindSeg('play-help', 'help');
bindSeg('play-focus', 'focus');
$('elo').addEventListener('input', () => { P.settings.elo = +$('elo').value; $('elo-val').textContent = `~${P.settings.elo}`; store.set('cr-play-settings', P.settings); });
$('elo-auto').addEventListener('change', () => { P.settings.autoElo = $('elo-auto').checked; updateElo(); store.set('cr-play-settings', P.settings); });

// ---------- Board ----------
function ensureBoard() {
  if (P.cg) return;
  P.cg = Chessground($('pboard'), {
    coordinates: false,
    animation: { enabled: true, duration: 220 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, color: undefined, showDests: true, events: { after: onUserMove } },
    draggable: { enabled: true, showGhost: true },
    premovable: { enabled: false },
    drawable: {
      enabled: true,
      visible: true,
      brushes: { ...BRUSHES, red: { key: 'r', color: '#dd3b31', opacity: 0.8, lineWidth: 11 } },
    },
  });
}

function fitBoard() {
  if ($('play').classList.contains('hidden')) return;
  const stage = $('play-stage');
  let size = innerWidth > 900
    ? Math.min(stage.clientWidth - 40 - 44, stage.clientHeight - 28 - 42 * 2 - 16)
    : Math.min(innerWidth - 24 - 44, 680);
  size = Math.max(256, Math.floor(size / 8) * 8);
  document.documentElement.style.setProperty('--board', `${size}px`);
  P.cg?.redrawAll();
  renderFx();
}
new ResizeObserver(() => fitBoard()).observe($('play-stage'));

const g = () => P.game;
const lastMove = () => g().moves.at(-1);
const youToMove = () => g().chess.turn() === g().you && !g().over;

function render({ still = false } = {}) {
  const game = g();
  const chess = game.chess;
  const fen = chess.fen();
  const mine = youToMove() && !P.preview && !game.thinking;
  P.cg.set({
    fen,
    orientation: P.orientation,
    turnColor: chess.turn() === 'w' ? 'white' : 'black',
    lastMove: lastMove() ? [lastMove().from, lastMove().to] : undefined,
    check: chess.inCheck(),
    movable: { color: mine ? (game.you === 'w' ? 'white' : 'black') : undefined, dests: mine ? legalDests(fen) : new Map(), events: { after: onUserMove } },
  });
  P.cg.setAutoShapes([]);
  $('pcoords').innerHTML = coordsHtml(P.orientation);
  renderFx({ still });
  renderBars();
  renderMoves();
  renderEval();
  $('p-takeback').disabled = game.over || !game.moves.some((m) => m.by === 'you') || game.thinking;
  $('p-hint').disabled = !mine;
  $('p-resign').disabled = game.over;
}

function renderFx({ still = false } = {}) {
  const fx = $('pfx');
  fx.innerHTML = '';
  const m = g()?.moves.at(-1);
  if (!m || m.by !== 'you' || !m.analysis || P.settings.help === 'none' || P.preview) return;
  const label = m.analysis.move.label;
  const p = squarePosFor(m.to, P.orientation);
  fx.innerHTML = `<div class="sq-badge" style="left:${p.left}%;top:${p.top}%">${badge(label).replace('<span class', `<span ${still ? 'style="animation:none"' : ''} class`)}</div>`;
}

function renderBars() {
  const game = g();
  const fen = game.chess.fen();
  const mat = material(fen, game.startFen);
  const toMove = fen.split(' ')[1];
  const youName = P.profile?.username || 'You';
  const bar = (c) => {
    const isYou = c === game.you;
    const adv = c === 'w' ? mat.diff : -mat.diff;
    const name = isYou ? youName : 'Coach';
    const sub = isYou ? (P.profile?.rating ? `(${P.profile.rating})` : '') : `(~${game.elo})`;
    return `<span class="avatar ${c}">${isYou ? esc(name[0].toUpperCase()) : '<img src="/icon.png" alt="" class="avatar-img">'}</span>
      <div class="pb-info"><span class="pb-name">${esc(name)} <span class="elo">${esc(sub)}</span></span>
      <span class="pb-caps">${mat[c]}${adv > 0 ? `<b>+${adv}</b>` : ''}</span></div>
      ${!game.over && toMove === c ? `<span class="turn-dot ${isYou ? 'you' : ''}">${isYou ? 'Your move' : game.thinking ? 'Thinking…' : ''}</span>` : ''}`;
  };
  const bottom = P.orientation === 'white' ? 'w' : 'b';
  $('pbar-bottom').innerHTML = bar(bottom);
  $('pbar-top').innerHTML = bar(bottom === 'w' ? 'b' : 'w');
}

function renderMoves() {
  const moves = g().moves;
  let html = '';
  const startBlack = g().startFen.split(' ')[1] === 'b';
  const list = startBlack ? [null, ...moves] : moves;
  for (let i = 0; i < list.length; i += 2) {
    const cell = (m) => {
      if (!m) return '<span></span>';
      const b = m.by === 'you' && m.analysis && P.settings.help !== 'none' ? badge(m.analysis.move.label) : m.by === 'you' && !m.analysis && P.settings.help !== 'none' ? '<span class="spin"></span>' : m.by === 'coach' ? '<span class="coach-dot" title="Coach"></span>' : '';
      return `<span class="mv static">${b}<span>${esc(m.san)}</span></span>`;
    };
    html += `<div class="move-row"><span class="move-no">${i / 2 + 1}.</span>${cell(list[i])}${cell(list[i + 1])}</div>`;
  }
  $('pmoves').innerHTML = html || '<div class="empty small">No moves yet.</div>';
  const box = $('pmoves-wrap');
  box.scrollTop = box.scrollHeight;
}

function renderEval() {
  const bar = $('peval-bar');
  bar.style.visibility = P.showEval ? 'visible' : 'hidden';
  $('p-eval').classList.toggle('on', P.showEval);
  const m = [...g().moves].reverse().find((x) => x.after);
  setEvalBar(bar, m?.after, { flipped: P.orientation === 'black', label: m?.analysis?.move?.label, key: m?.fenAfter });
}

// ---------- The coach's bubble ----------
function setBubble(html) {
  $('pbubble').innerHTML = `<div class="bubble-inner">${html}</div>`;
}

function topWeakTags() {
  return new Set((P.profile?.weaknesses || []).filter((w) => w.severity > 1.15).map((w) => w.tag));
}

// One turn's message: feedback on your move (if any) followed by the coach's reply.
function renderTurn() {
  const game = g();
  const parts = [];
  const yours = game.moves.at(-1)?.by === 'coach' ? game.moves.at(-2) : game.moves.at(-1);
  const reply = game.moves.at(-1)?.by === 'coach' ? game.moves.at(-1) : null;
  const help = P.settings.help;
  if (game.intro && !game.moves.length) parts.push(`<div class="bubble-text">${game.intro}</div>`);
  if (yours?.by === 'you' && help !== 'none') parts.push(feedbackHtml(yours));
  if (reply) parts.push(replyHtml(reply));
  if (game.thinking) parts.push('<div class="bubble-foot"><span class="typing"><i></i><i></i><i></i></span><span class="muted small">Coach is thinking…</span></div>');
  if (game.over) parts.push(game.summaryHtml);
  setBubble(parts.join('') || '<div class="bubble-text muted">Your move.</div>');
  wireBubble();
}

function feedbackHtml(m) {
  if (!m.analysis) return `<div class="bubble-head"><span class="spin"></span><span class="bubble-title">${esc(m.san)}</span></div><div class="bubble-text muted">Checking your move…</div>`;
  const a = m.analysis.move;
  let html = `<div class="bubble-head">${badge(a.label)}<span class="bubble-title txt-${a.label}">${titleFor(a)}</span></div>`;
  html += `<div class="bubble-text" id="p-explain">${m.explanation ? linkify(m.explanation, a) : linkify(a.template, a)}</div>`;
  const pattern = (a.tags || []).find((t) => topWeakTags().has(t));
  if (pattern) {
    const w = P.profile.weaknesses.find((x) => x.tag === pattern);
    html += `<div class="pattern-note">This is a pattern from your games: <b>${esc(w.label.toLowerCase())}</b>.</div>`;
  }
  if (m.tacticResult) html += `<div class="tactic-note ${m.tacticResult.found ? 'good' : 'bad'}">${m.tacticResult.text}</div>`;
  const foot = [];
  if (BAD.has(a.label) && !g().over) foot.push('<button class="chip-btn green" data-act="takeback">Take back and try again</button>');
  if (!a.isBest && a.bestSan) foot.push(`<button class="chip-btn" data-act="show-best">Best was ${esc(a.bestSan)}</button>`);
  if (foot.length) html += `<div class="bubble-foot">${foot.join('')}</div>`;
  return html;
}

function replyHtml(m) {
  const help = P.settings.help;
  let text = m.comment || '';
  if (m.intent === 'tactic' && help === 'none') text = '';
  const warn = help === 'lots' || (help === 'some' && (topWeakTags().has('hanging') || topWeakTags().has('allowedTactic')))
    ? (m.warnings || []).slice(0, 2) : [];
  return `<div class="reply"><div class="reply-head"><span class="coach-dot"></span><b>${esc(m.san)}</b>${text ? `<span>${esc(text)}</span>` : ''}</div>
    ${warn.length && help !== 'none' ? `<div class="warn">${warn.map(esc).join(' ')}</div>` : ''}
    ${m.intent === 'tactic' && help === 'lots' ? '<div class="bubble-foot"><button class="chip-btn" data-act="hint">Give me a hint</button></div>' : ''}</div>`;
}

function wireBubble() {
  $('pbubble').querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.act === 'takeback') takeBack();
      else if (b.dataset.act === 'show-best') showBest();
      else if (b.dataset.act === 'hint') hint();
      else if (b.dataset.act === 'review') reviewGame();
      else if (b.dataset.act === 'again') startGame();
      else if (b.dataset.act === 'setup') { P.game = null; openPlay(); }
      else if (b.dataset.act === 'back') endPreview();
    };
  });
}

// Idea links in the explanation (e.g. "loses a knight") play the line on the board.
$('pbubble').addEventListener('click', (e) => {
  const b = e.target.closest('.idea');
  if (!b) return;
  const m = g().moves.filter((x) => x.by === 'you').at(-1);
  const a = m?.analysis?.move;
  const link = a?.links?.[+b.dataset.li];
  if (!link) return;
  const n = +b.dataset.n || link.uci.length;
  previewLine(link.base === 'after' ? a.fenAfter : a.fenBefore, link.uci.slice(0, n));
});

// ---------- Playing ----------
function intro() {
  const game = g();
  const p = P.profile;
  const focus = P.settings.focus;
  const weak = (p?.weaknesses || []).filter((w) => w.severity > 1.15).slice(0, 2).map((w) => w.label.toLowerCase());
  let s = `Let's play! I'll play like a ${game.elo}.`;
  if (focus === 'none') return `${s} No special practice this time, just a game.`;
  if (focus === 'auto' && p?.games && weak.length) s += ` From your recent games, we'll work on: <b>${esc(weak.join(' and '))}</b>.`;
  else if (focus === 'tactics') s += " I'll leave you some tactics to find.";
  else if (focus === 'endgames') s += " I'll aim for endgames.";
  else if (focus === 'openings' && p?.openings?.weak?.length) s += ` We'll practice openings you've struggled with, like the ${esc(p.openings.weak[0].name)}.`;
  else if (!p?.games) s += ' Tell me your username on the setup page and I will adapt to your games.';
  return s;
}

function newGameState({ you, startFen, moves = [] }) {
  const chess = new Chess(startFen);
  const list = [];
  for (const u of moves) {
    const mv = chess.move({ from: u.uci.slice(0, 2), to: u.uci.slice(2, 4), promotion: u.uci[4] });
    list.push({ ...u, san: mv.san, from: mv.from, to: mv.to, color: mv.color, fenBefore: mv.before, fenAfter: mv.after });
  }
  return { chess, startFen, you, elo: P.settings.elo, focus: P.settings.focus, moves: list, sinceTactic: 99, tacticsSet: 0, tacticsFound: 0, hints: 0, over: false, thinking: false };
}

function startGame(saved = null) {
  stopPreview();
  ensureBoard();
  const color = saved?.you || (P.settings.color === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : P.settings.color);
  if (P.settings.autoElo) P.settings.elo = autoElo();
  P.game = newGameState({ you: color, startFen: saved?.startFen || new Chess().fen(), moves: saved?.moves || [] });
  if (saved?.elo) P.game.elo = saved.elo;
  P.game.intro = intro();
  P.orientation = color === 'w' ? 'white' : 'black';
  P.hintStep = 0;
  showPlayView('play');
  renderFocus();
  render();
  renderTurn();
  save();
  if (!youToMove() && !P.game.chess.isGameOver()) coachTurn();
}

function renderFocus() {
  const p = P.profile;
  const chips = [];
  if (P.settings.focus === 'auto' && p?.games) {
    for (const w of (p.weaknesses || []).filter((x) => x.severity > 1.15).slice(0, 2)) chips.push(w.label);
    if (p.openings?.weak?.length) chips.push(p.openings.weak[0].name);
  } else if (P.settings.focus !== 'auto' && P.settings.focus !== 'none') chips.push({ openings: 'Openings', tactics: 'Tactics', endgames: 'Endgames' }[P.settings.focus]);
  $('focus-strip').innerHTML = chips.length ? `<span class="muted small">Practicing</span>${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}` : '';
}

function save() {
  const game = g();
  if (!game || game.over) { store.del('cr-play-game'); return; }
  store.set('cr-play-game', { you: game.you, startFen: game.startFen, elo: game.elo, moves: game.moves.map((m) => ({ uci: m.uci, by: m.by })) });
}

async function onUserMove(orig, dest) {
  const game = g();
  if (!game || !youToMove() || P.preview) return;
  const before = game.chess.fen();
  const piece = game.chess.get(orig);
  let promotion;
  if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
    promotion = await pickPromotion($('ppromo'), dest, piece.color, P.orientation).promise;
    if (!promotion || game.chess.fen() !== before) { render({ still: true }); return; }
  }
  let mv;
  try { mv = game.chess.move({ from: orig, to: dest, promotion }); } catch { render({ still: true }); return; }
  sound.playMove(mv.san, mv.captured);
  const pending = game.pendingTactic;
  game.pendingTactic = null;
  const m = { by: 'you', uci: mv.lan, san: mv.san, from: mv.from, to: mv.to, color: mv.color, fenBefore: mv.before, fenAfter: mv.after };
  game.moves.push(m);
  P.hintStep = 0;
  save();
  render({ still: true });
  renderTurn();
  const analysed = analyseYourMove(m, pending);
  if (game.chess.isGameOver()) { await analysed; return endGame(); }
  await coachTurn(analysed);
}

async function analyseYourMove(m, pending) {
  const game = g();
  const prev = game.moves[game.moves.indexOf(m) - 1];
  try {
    const r = await api('/api/analyze-move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen: m.fenBefore, uci: m.uci, prevLabel: prev?.analysis?.move?.label }),
    });
    m.analysis = r;
    m.after = r.after;
    if (pending) {
      const a = r.move;
      const found = m.uci === pending.reply || (GOOD.has(a.label) && a.bestUci === pending.reply);
      if (found) game.tacticsFound++;
      m.tacticResult = found
        ? { found: true, text: `You found it! That wins ${esc(pending.gain)}.` }
        : { found: false, text: `There was a tactic: <button class="idea idea-gain" data-tactic="1">${esc(pending.gain)} for you</button>. Click to see it.` };
      m.tactic = pending;
      if (found) sound.play('correct');
    }
    if (g() === game) {
      render({ still: false });
      renderTurn();
      if (P.settings.help === 'lots' && r.move.label !== 'book' && document.body.dataset.coachOk === '1') explainMore(m);
    }
  } catch {
    m.analysis = null;
  }
}

// Detailed explanation from the AI coach (help: Lots).
async function explainMore(m) {
  try {
    const res = await fetch('/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ facts: m.analysis.move.facts, san: m.san, sides: m.analysis.move.sides, template: m.analysis.move.template }) });
    const text = cleanCoach(await res.text());
    if (!text || text.includes('[coach unavailable')) return;
    m.explanation = text;
    const el = $('p-explain');
    if (el && g().moves.filter((x) => x.by === 'you').at(-1) === m) el.innerHTML = linkify(text, m.analysis.move);
  } catch {}
}

async function coachTurn(waitFor) {
  const game = g();
  if (!game || game.over) return;
  game.thinking = true;
  render({ still: true });
  renderTurn();
  const t0 = Date.now();
  let r;
  try {
    r = await api('/api/coach/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fen: game.chess.fen(),
        moves: game.moves.map((m) => m.uci),
        elo: game.elo,
        focus: game.focus,
        sinceTactic: game.sinceTactic,
        profile: P.profile?.games ? { source: P.profile.source, username: P.profile.username } : null,
      }),
    });
  } catch (err) {
    game.thinking = false;
    setBubble(`<div class="bubble-text">The coach couldn't move: ${esc(err.message)}</div>`);
    return;
  }
  await waitFor;
  await sleep(Math.max(0, 650 - (Date.now() - t0))); // a natural pause
  if (g() !== game || !r) return;
  const mv = game.chess.move({ from: r.uci.slice(0, 2), to: r.uci.slice(2, 4), promotion: r.uci[4] });
  game.thinking = false;
  game.sinceTactic = r.intent === 'tactic' ? 0 : game.sinceTactic + 1;
  if (r.intent === 'tactic') { game.pendingTactic = r.tactic; game.tacticsSet++; }
  game.moves.push({ by: 'coach', uci: mv.lan, san: mv.san, from: mv.from, to: mv.to, color: mv.color, fenBefore: mv.before, fenAfter: mv.after, intent: r.intent, comment: r.comment, warnings: r.warnings, tactic: r.tactic });
  sound.playMove(mv.san, mv.captured);
  save();
  render();
  renderTurn();
  if (game.chess.isGameOver()) endGame();
}

function takeBack() {
  const game = g();
  if (!game || game.thinking) return;
  stopPreview();
  // Undo back to before your last move (the coach's reply too, if it came).
  let i = game.moves.length - 1;
  while (i >= 0 && game.moves[i].by !== 'you') i--;
  if (i < 0) return;
  const keep = game.moves.slice(0, i);
  P.game = newGameState({ you: game.you, startFen: game.startFen, moves: keep.map((m) => ({ uci: m.uci, by: m.by })) });
  Object.assign(P.game, { elo: game.elo, focus: game.focus, sinceTactic: game.sinceTactic, tacticsSet: game.tacticsSet, tacticsFound: game.tacticsFound, hints: game.hints, intro: null });
  P.game.moves.forEach((m, k) => Object.assign(m, keep[k]));
  // If the coach had just set up a tactic, it's still there to find.
  const prevCoach = keep.at(-1);
  P.game.pendingTactic = prevCoach?.intent === 'tactic' ? prevCoach.tactic : null;
  sound.play('move');
  render();
  setBubble('<div class="bubble-text">Move taken back. Have another look and try again.</div>');
}

// Hint, one step per click: what the coach threatens, then which piece to move, then the move.
async function hint() {
  const game = g();
  if (!youToMove()) return;
  const fen = game.chess.fen();
  if (!P.hintData || P.hintData.fen !== fen) {
    try { P.hintData = { fen, ...(await api('/api/coach/hint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen }) })) }; } catch { return; }
    P.hintStep = 0;
  }
  if (g() !== game || game.chess.fen() !== fen) return;
  const h = P.hintData;
  game.hints++;
  const steps = [];
  if (h.threat) steps.push(() => { P.cg.setAutoShapes([{ orig: h.threat.from, dest: h.threat.to, brush: 'red' }]); return `Watch out: the coach ${esc(h.threat.text)}.`; });
  if (h.best) steps.push(() => { P.cg.setAutoShapes([{ orig: h.best.from, brush: 'green' }]); return `Look at your ${esc(h.best.piece)} on ${h.best.from}.`; });
  if (h.best) steps.push(() => { P.cg.setAutoShapes([arrow(fen, h.best.from + h.best.to, 'green', P.orientation)]); return `The best move is <b>${esc(h.best.san)}</b>.`; });
  if (!steps.length) return;
  const text = steps[Math.min(P.hintStep, steps.length - 1)]();
  P.hintStep++;
  setBubble(`<div class="bubble-head"><span class="badge lbl-great">!</span><span class="bubble-title">Hint</span></div><div class="bubble-text">${text}</div>${P.hintStep < steps.length ? '<div class="bubble-foot"><button class="chip-btn" data-act="hint">More help</button></div>' : ''}`);
  wireBubble();
}

function showBest() {
  const m = g().moves.filter((x) => x.by === 'you').at(-1);
  const a = m?.analysis?.move;
  if (!a) return;
  previewLine(a.fenBefore, a.bestLineUci?.length ? a.bestLineUci.slice(0, 6) : [a.bestUci]);
}

// Show a line on the board (animated), then a "Back to game" button.
function previewLine(fen, ucis) {
  stopPreview();
  const c = new Chess(fen);
  const steps = [];
  for (const u of ucis) {
    try { steps.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })); } catch { break; }
  }
  if (!steps.length) return;
  P.preview = { i: -1 };
  P.cg.set({ fen, lastMove: undefined, movable: { color: undefined, dests: new Map() } });
  P.cg.setAutoShapes([]);
  $('pfx').innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'preview-bar';
  bar.innerHTML = `<span>Showing ${esc(steps.map((s) => s.san).join(' '))}</span><button class="chip-btn green" data-act="back">Back to game</button>`;
  $('pbubble').querySelector('.bubble-inner')?.append(bar);
  wireBubble();
  const tick = () => {
    if (!P.preview) return;
    P.preview.i++;
    const s = steps[P.preview.i];
    if (!s) return;
    P.cg.set({ fen: s.after, lastMove: [s.from, s.to] });
    sound.playMove(s.san, s.captured);
    P.preview.timer = setTimeout(tick, 850);
  };
  P.preview.timer = setTimeout(tick, 350);
}
function stopPreview() {
  if (P.preview) clearTimeout(P.preview.timer);
  P.preview = null;
}
function endPreview() {
  stopPreview();
  render({ still: true });
  renderTurn();
}
$('pbubble').addEventListener('click', (e) => {
  if (!e.target.closest('[data-tactic]')) return;
  const m = g().moves.filter((x) => x.by === 'you').at(-1);
  if (m?.tactic) previewLine(m.fenBefore, m.tactic.line);
});

// ---------- End of game ----------
function endGame(reason) {
  const game = g();
  if (!game || game.over) return;
  game.over = true;
  game.thinking = false;
  const c = game.chess;
  let result;
  if (reason === 'resign') result = { text: 'You resigned. The coach wins.', score: 0 };
  else if (c.isCheckmate()) result = c.turn() === game.you ? { text: 'Checkmate. The coach wins this one.', score: 0 } : { text: 'Checkmate! You win!', score: 1 };
  else if (c.isStalemate()) result = { text: 'Stalemate: a draw.', score: 0.5 };
  else if (c.isThreefoldRepetition()) result = { text: 'Draw by repetition.', score: 0.5 };
  else if (c.isInsufficientMaterial()) result = { text: 'Draw: not enough material to mate.', score: 0.5 };
  else result = { text: 'Draw.', score: 0.5 };
  game.result = result;
  const yours = game.moves.filter((m) => m.by === 'you' && m.analysis);
  const acc = yours.length ? yours.reduce((a, m) => a + m.analysis.move.accuracy, 0) / yours.length : null;
  const counts = {};
  for (const m of yours) counts[m.analysis.move.label] = (counts[m.analysis.move.label] || 0) + 1;
  const tagCount = {};
  for (const m of yours) for (const t of m.analysis.move.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
  const weakNow = (P.profile?.weaknesses || []).filter((w) => w.severity > 1.15 && tagCount[w.tag]).map((w) => `${w.label.toLowerCase()} (${tagCount[w.tag]}×)`);
  const lines = [];
  if (acc != null) lines.push(`Accuracy: <b>${acc.toFixed(0)}%</b>`);
  const bad = ['blunder', 'mistake', 'miss', 'inaccuracy'].filter((l) => counts[l]).map((l) => `${counts[l]} ${l}${counts[l] > 1 ? (l === 'miss' ? 'es' : 's') : ''}`);
  lines.push(bad.length ? `You made ${bad.join(', ')}.` : 'No mistakes at all. Excellent!');
  if (game.tacticsSet) lines.push(`Tactics found: <b>${game.tacticsFound} of ${game.tacticsSet}</b>.`);
  if (weakNow.length) lines.push(`Old habits that showed up: ${esc(weakNow.join(', '))}.`);
  else if (P.profile?.games && yours.length > 8) lines.push('None of your usual weak spots showed up. Nice work.');
  if (game.hints) lines.push(`Hints used: ${game.hints}.`);
  game.summaryHtml = `<div class="game-over"><div class="bubble-head"><span class="badge ${result.score === 1 ? 'lbl-best' : result.score === 0.5 ? 'lbl-book' : 'lbl-mistake'}">${result.score === 1 ? '★' : result.score === 0.5 ? '½' : '✕'}</span><span class="bubble-title">${result.text}</span></div>
    <div class="bubble-text">${lines.join('<br>')}</div>
    <div class="bubble-foot"><button class="chip-btn green" data-act="review">Review this game</button><button class="chip-btn" data-act="again">Play again</button><button class="chip-btn" data-act="setup">Settings</button></div></div>`;
  sound.play(result.score === 1 ? 'brilliant' : 'end');
  store.del('cr-play-game');
  render();
  renderTurn();
}

function pgnOf(game) {
  const youName = P.profile?.username || 'You';
  const c = new Chess(game.startFen);
  for (const m of game.moves) c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
  const res = !game.over ? '*' : game.result.score === 0.5 ? '1/2-1/2' : (game.result.score === 1) === (game.you === 'w') ? '1-0' : '0-1';
  c.setHeader('Event', 'Practice vs the coach');
  c.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
  c.setHeader('White', game.you === 'w' ? youName : `Coach (~${game.elo})`);
  c.setHeader('Black', game.you === 'b' ? youName : `Coach (~${game.elo})`);
  c.setHeader('Result', res);
  return c.pgn();
}

function reviewGame() {
  const game = g();
  const youName = P.profile?.username || 'You';
  window.dispatchEvent(new CustomEvent('cr:review-pgn', { detail: { pgn: pgnOf(game), username: youName } }));
}

// ---------- Controls ----------
$('play-start').addEventListener('click', () => startGame());
$('play-resume').addEventListener('click', () => { const s = store.get('cr-play-game'); if (s) startGame(s); });
$('play-exit').addEventListener('click', () => { stopPreview(); showPlayView('play-setup'); renderSetup(); });
$('p-new').addEventListener('click', () => { if (g() && !g().over && g().moves.length > 2 && !confirm('Start a new game? This one will be lost.')) return; startGame(); });
$('p-resign').addEventListener('click', () => { if (g() && !g().over && confirm('Resign this game?')) endGame('resign'); });
$('p-takeback').addEventListener('click', takeBack);
$('p-hint').addEventListener('click', hint);
$('p-eval').addEventListener('click', () => { P.showEval = !P.showEval; store.set('cr-play-eval', P.showEval); if (g()) renderEval(); });
$('p-flip').addEventListener('click', () => { P.orientation = P.orientation === 'white' ? 'black' : 'white'; if (g()) render({ still: true }); });
document.addEventListener('keydown', (e) => {
  if ($('play').classList.contains('hidden') || e.target.matches?.('input, select, textarea')) return;
  if (e.key === 'h' || e.key === 'H') hint();
  else if (e.key === 'Backspace') { e.preventDefault(); takeBack(); }
  else if (e.key === 'f' || e.key === 'F') $('p-flip').click();
  else if (e.key === 'Escape' && P.preview) endPreview();
});

// Coach status (for "Lots" help explanations) comes from the main app's status check.
window.addEventListener('cr:status', (e) => { document.body.dataset.coachOk = e.detail.coachOk ? '1' : '0'; });
loadProfile();
