import { Chessground } from '/vendor/chessground.js';
import { Chess } from '/vendor/chess.js';
import * as sound from '/sounds.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LABEL_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];
const LABEL_NAME = {
  brilliant: 'Brilliant', great: 'Great', best: 'Best', excellent: 'Excellent', good: 'Good', book: 'Book',
  inaccuracy: 'Inaccuracy', mistake: 'Mistake', miss: 'Miss', blunder: 'Blunder', forced: 'Forced',
};
const BAD = new Set(['inaccuracy', 'mistake', 'miss', 'blunder']);
const RING = new Set(['brilliant', 'great', 'blunder', 'miss']);
const svg = (d) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const ICON = {
  star: svg('M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3 6.1 20.6l1.3-6.6L2.5 9.4l6.6-.8z'),
  check: svg('M9.5 16.2L5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z'),
  book: svg('M4 4.5C4 3.7 4.7 3 5.5 3H11v17H5.5C4.7 20 4 19.3 4 18.5zM13 3h5.5c.8 0 1.5.7 1.5 1.5v14c0 .8-.7 1.5-1.5 1.5H13z'),
  play: svg('M8 5v14l11-7z'),
  pause: svg('M6 5h4v14H6zm8 0h4v14h-4z'),
  soundOn: svg('M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0014 8v8a4.5 4.5 0 002.5-4zM14 3.2v2.1a7 7 0 010 13.4v2.1a9 9 0 000-17.6z'),
  soundOff: svg('M16.5 12A4.5 4.5 0 0014 8v2.2l2.4 2.4c.1-.2.1-.4.1-.6zM19 12c0 .9-.2 1.8-.5 2.6l1.5 1.5A9 9 0 0014 3.2v2.1a7 7 0 015 6.7zM4.3 3L3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.3a7 7 0 01-2.3 1.1v2.1a9 9 0 003.7-1.8l2 2 1.3-1.3zM12 4L9.9 6.1 12 8.2z'),
  bullet: svg('M12 2c3 2.5 4.5 6 4.5 10.5V20h-9v-7.5C7.5 8 9 4.5 12 2zm-4.5 19h9v1h-9z'),
  blitz: svg('M13 2L4 14h6l-1 8 9-12h-6z'),
  rapid: svg('M12 2a10 10 0 110 20 10 10 0 010-20zm0 2a8 8 0 100 16 8 8 0 000-16zm1 3v5.2l3.6 2.1-1 1.7L11 13V7z'),
  daily: svg('M7 2v2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2h-2V2h-2v2H9V2zm-2 8h14v10H5z'),
  classical: svg('M6 2h12v2h-1v3.6L13.4 12l3.6 4.4V20h1v2H6v-2h1v-3.6l3.6-4.4L7 7.6V4H6zm3 2v2.9l3 3.7 3-3.7V4z'),
};
const GLYPH = {
  brilliant: '!!', great: '!', best: ICON.star, excellent: ICON.check, good: ICON.check, book: ICON.book,
  inaccuracy: '?!', mistake: '?', miss: '✕', blunder: '??', forced: '→',
};
const badge = (label) => `<span class="badge lbl-${label}" title="${LABEL_NAME[label]}">${GLYPH[label]}</span>`;

const state = {
  source: 'chesscom', lichessNext: null,
  user: '', games: [], depth: 18, timeFilter: '', review: null, ply: -1, orientation: 'white',
  explained: new Map(), abort: null, explainTimer: null, retry: null, coachModel: '', coachOk: false,
  tab: 'report', playing: null, preview: false, evalShown: 0,
};

// ---------- Status, sound toggle, heartbeat ----------
async function loadStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    setStatus('engine-pill', s.engine.ok, s.engine.ok ? s.engine.name : 'Engine offline');
    state.coachModel = s.coach.model;
    state.coachOk = s.coach.ok;
    state.coachInfo = s.coach;
    state.version = s.version;
    setStatus('coach-pill', s.coach.ok, s.coach.ok ? `Coach · ${s.coach.model}` : 'Set up coach');
    $('coach-pill').classList.toggle('clickable', !s.coach.ok);
    $('coach-pill').title = s.coach.ok ? '' : `${s.coach.error}. Click to set up.`;
    $('coach-notice').classList.toggle('hidden', s.coach.ok);
    if (s.update) showUpdate(s.update);
  } catch {
    setStatus('engine-pill', false, 'Server offline');
  }
}

function showUpdate(u) {
  if ($('update-pill')) return;
  const a = document.createElement('a');
  a.id = 'update-pill';
  a.className = 'status ok clickable update';
  a.href = u.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = `You have v${state.version}. Click to download v${u.version}.`;
  a.innerHTML = `<i></i><span>Update ${esc(u.version)} available</span>`;
  $('engine-pill').before(a);
}

// ---------- Coach setup (Ollama + model download) ----------
function openCoachSetup() {
  const c = state.coachInfo || {};
  $('coach-setup').classList.remove('hidden');
  $('setup-bar').classList.add('hidden');
  $('setup-status').textContent = '';
  if (c.ok) {
    $('setup-text').innerHTML = `The coach is ready: <b>${esc(c.model)}</b>.`;
    $('setup-actions').innerHTML = '<button class="btn primary" id="setup-done">Done</button>';
    $('setup-done').onclick = closeCoachSetup;
  } else if (!c.ollama) {
    $('setup-text').innerHTML = 'Explanations are written by a small AI model that runs on your PC through <b>Ollama</b> (free). Install Ollama, start it, then come back here.';
    $('setup-actions').innerHTML = '<a class="btn primary" href="https://ollama.com/download" target="_blank" rel="noopener">Download Ollama</a><button class="btn" id="setup-recheck">Check again</button>';
    $('setup-recheck').onclick = async () => { $('setup-status').textContent = 'Checking…'; await loadStatus(); openCoachSetup(); };
  } else {
    const size = c.model === 'qwen3:4b-instruct' ? 'about 2.5 GB, ' : '';
    $('setup-text').innerHTML = `Ollama is running. The coach needs the <b>${esc(c.model)}</b> model (${size}downloaded once).`;
    $('setup-actions').innerHTML = '<button class="btn primary" id="setup-pull">Download model</button>';
    $('setup-pull').onclick = pullCoachModel;
  }
}

function closeCoachSetup() { $('coach-setup').classList.add('hidden'); }

async function pullCoachModel() {
  $('setup-actions').innerHTML = '';
  $('setup-bar').classList.remove('hidden');
  $('setup-status').textContent = 'Starting download…';
  try {
    const res = await fetch('/api/coach/pull', { method: 'POST' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        if (msg.error) throw new Error(msg.error);
        if (msg.total) {
          $('setup-fill').style.width = `${(msg.completed / msg.total) * 100}%`;
          $('setup-status').textContent = `${(msg.completed / 1e9).toFixed(2)} / ${(msg.total / 1e9).toFixed(2)} GB`;
        } else if (msg.status) {
          $('setup-status').textContent = msg.status[0].toUpperCase() + msg.status.slice(1);
        }
      }
    }
    await loadStatus();
    $('setup-fill').style.width = '100%';
    sound.play('correct');
    openCoachSetup();
  } catch (err) {
    $('setup-status').textContent = `Download failed: ${err.message}`;
    $('setup-actions').innerHTML = '<button class="btn primary" id="setup-pull">Try again</button>';
    $('setup-pull').onclick = pullCoachModel;
  }
}

function setStatus(id, ok, text) {
  const el = $(id);
  el.className = 'status ' + (ok ? 'ok' : 'bad');
  el.querySelector('span').textContent = text;
}

function renderSoundBtn() {
  $('sound-btn').innerHTML = sound.isEnabled() ? ICON.soundOn : ICON.soundOff;
  $('sound-btn').title = sound.isEnabled() ? 'Sound on (M)' : 'Sound off (M)';
}

// An open connection tells the server this window is alive, so it can shut itself down
// shortly after the app window closes (only when started from the desktop launcher).
new EventSource('/api/presence');

// ---------- Game picker ----------
function showError(msg) {
  const el = $('picker-error');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const skeletons = () => Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');

// ---------- Game sources: Chess.com, Lichess, PGN ----------
const SOURCE_HINT = { chesscom: 'Chess.com username', lichess: 'Lichess username' };
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

function placeSourceInk() {
  const on = document.querySelector('#source button.on');
  $('source-ink').style.left = `${on.offsetLeft}px`;
  $('source-ink').style.width = `${on.offsetWidth}px`;
}

function setSource(src, { auto = false } = {}) {
  state.source = src;
  store.set('cr-source', src);
  document.querySelectorAll('#source button').forEach((b) => b.classList.toggle('on', b.dataset.src === src));
  placeSourceInk();
  const isPgn = src === 'pgn';
  $('user-form').classList.toggle('hidden', isPgn);
  $('pgn-box').classList.toggle('hidden', !isPgn);
  $('filters').classList.add('hidden');
  $('more-wrap').classList.add('hidden');
  $('game-list').innerHTML = '';
  showError('');
  if (!isPgn) {
    $('username').placeholder = SOURCE_HINT[src];
    $('username').value = store.get(`cr-user-${src}`) || (src === 'chesscom' ? store.get('cr-user') : '');
    if ($('username').value && auto) findGames();
  }
}

async function findGames(e) {
  e?.preventDefault();
  const user = $('username').value.trim();
  if (!user) return;
  showError('');
  $('game-list').innerHTML = skeletons();
  $('more-wrap').classList.add('hidden');
  state.user = user;
  store.set(`cr-user-${state.source}`, user);
  if (state.source === 'lichess') return loadLichess();
  try {
    const { archives } = await api(`/api/archives?user=${encodeURIComponent(user)}`);
    if (!archives.length) {
      $('game-list').innerHTML = '<div class="empty">No games found for this player.</div>';
      return;
    }
    $('month').innerHTML = archives.map((a) => {
      const [y, m] = a.split('/').slice(-2);
      const label = new Date(+y, +m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      return `<option value="${esc(a)}">${esc(label)}</option>`;
    }).join('');
    $('month-wrap').classList.remove('hidden');
    $('filters').classList.remove('hidden');
    await loadMonth();
  } catch (err) {
    $('game-list').innerHTML = '';
    showError(err.message);
  }
}

async function loadLichess(more = false) {
  const btn = $('load-more');
  btn.disabled = true;
  try {
    const q = `/api/lichess/games?user=${encodeURIComponent(state.user)}` + (more && state.lichessNext ? `&until=${state.lichessNext}` : '');
    const { games, next } = await api(q);
    state.games = more ? state.games.concat(games) : games;
    state.lichessNext = next;
    $('month-wrap').classList.add('hidden');
    $('filters').classList.remove('hidden');
    renderGameList();
    $('more-wrap').classList.toggle('hidden', !next);
  } catch (err) {
    if (!more) $('game-list').innerHTML = '';
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
}

// Split a PGN file into games and pull out enough headers to show them as cards.
function parsePgnFile(text) {
  const chunks = text.replace(/\r/g, '').split(/\n(?=\[Event\s)/).map((s) => s.trim()).filter((s) => /\d\.\s*\S/.test(s));
  const SPEEDS = [[180, 'bullet'], [480, 'blitz'], [1500, 'rapid'], [Infinity, 'classical']];
  return chunks.map((pgn, i) => {
    const h = {};
    for (const m of pgn.matchAll(/^\[(\w+)\s+"([^"]*)"\]/gm)) h[m[1]] = m[2];
    const res = h.Result || '*';
    const side = (color) => {
      const won = (color === 'w' && res === '1-0') || (color === 'b' && res === '0-1');
      const lost = (color === 'w' && res === '0-1') || (color === 'b' && res === '1-0');
      return {
        username: (color === 'w' ? h.White : h.Black) || (color === 'w' ? 'White' : 'Black'),
        rating: (color === 'w' ? h.WhiteElo : h.BlackElo) || '',
        result: won ? 'win' : lost ? 'lose' : res === '1/2-1/2' ? 'agreed' : 'unknown',
      };
    };
    const tc = h.TimeControl && h.TimeControl !== '-' ? h.TimeControl : '';
    let timeClass = 'classical';
    if (tc.includes('/')) timeClass = 'daily';
    else if (tc) { const [b, inc = 0] = tc.split('+').map(Number); timeClass = SPEEDS.find(([lim]) => b + 40 * inc < lim)[1]; }
    const date = (h.UTCDate || h.Date || '').replace(/\./g, '-');
    const endTime = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(date) / 1000 : 0;
    return { id: `pgn-${i}`, pgn, endTime, timeClass, timeControl: tc, accuracies: null, white: side('w'), black: side('b') };
  });
}

function loadPgn(text) {
  showError('');
  const games = parsePgnFile(text || $('pgn-text').value);
  if (!games.length) {
    showError("Couldn't find any games in that PGN. Paste the full game including the moves.");
    return;
  }
  state.user = $('pgn-user').value.trim();
  state.games = games;
  $('month-wrap').classList.add('hidden');
  $('filters').classList.remove('hidden');
  renderGameList();
  if (games.length === 1) analyze(games[0]);
}

async function loadMonth() {
  $('game-list').innerHTML = skeletons();
  try {
    const { games } = await api(`/api/games?archive=${encodeURIComponent($('month').value)}`);
    state.games = games;
    renderGameList();
  } catch (err) {
    $('game-list').innerHTML = '';
    showError(err.message);
  }
}

function formatTc(tc) {
  if (!tc) return '';
  if (tc.includes('/')) return `${Math.round(+tc.split('/')[1] / 86400)} day`;
  const [base, inc] = tc.split('+');
  const min = +base / 60;
  const b = min >= 1 ? `${+min.toFixed(1)}` : `${base}s`;
  return inc ? `${b} | ${inc}` : `${b} min`;
}

const DRAWS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);
function userResult(g) {
  const lc = state.user.toLowerCase();
  const me = g.white.username.toLowerCase() === lc ? g.white : g.black.username.toLowerCase() === lc ? g.black : null;
  if (!me) {
    // Nobody to root for (e.g. a PGN of someone else's game): show the plain result.
    if (g.white.result === 'win') return ['draw', '1–0'];
    if (g.black.result === 'win') return ['draw', '0–1'];
    return ['draw', DRAWS.has(g.white.result) ? '½–½' : '–'];
  }
  if (me.result === 'win') return ['win', 'Won'];
  if (DRAWS.has(me.result)) return ['draw', 'Draw'];
  return ['loss', 'Lost'];
}

function renderGameList() {
  const games = state.games.filter((g) => !state.timeFilter || g.timeClass === state.timeFilter);
  if (!games.length) {
    $('game-list').innerHTML = '<div class="empty">No standard chess games here.</div>';
    return;
  }
  const lc = state.user.toLowerCase();
  $('game-list').innerHTML = games.map((g, i) => {
    const [cls, txt] = userResult(g);
    const date = g.endTime ? new Date(g.endTime * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: g.endTime * 1000 < Date.now() - 300 * 864e5 ? 'numeric' : undefined }) : '';
    const score = (p) => (p.result === 'win' ? '1' : DRAWS.has(p.result) ? '½' : p.result === 'unknown' ? '' : '0');
    const player = (p, c) => `<div class="gp ${p.username.toLowerCase() === lc ? 'me' : ''}">
        <span class="piece-dot ${c}"></span><span class="name">${esc(p.username)}</span><span class="elo">${p.rating}</span>
        <span class="score ${p.result === 'win' ? 'won' : ''}">${score(p)}</span></div>`;
    const acc = g.accuracies ? `<span class="acc-chip">${g.accuracies.white.toFixed(1)}% · ${g.accuracies.black.toFixed(1)}%</span>` : '';
    return `<button class="game ${cls}" data-i="${state.games.indexOf(g)}" style="animation-delay:${Math.min(i, 18) * 28}ms">
      <div class="game-top">${ICON[g.timeClass] || ICON.rapid}<span class="tc">${esc(formatTc(g.timeControl))} ${esc(g.timeClass)}</span><span class="date">${esc(date)}</span></div>
      <div class="game-players">${player(g.white, 'w')}${player(g.black, 'b')}</div>
      <div class="game-foot"><span class="result-tag ${cls}">${txt}</span>${acc}<span class="review-cta">Review →</span></div>
    </button>`;
  }).join('');
}

function bindSeg(id, onPick) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    onPick(b.dataset.v);
  });
}

// ---------- Analysis ----------
async function analyze(game) {
  $('progress').classList.remove('hidden');
  $('progress-title').textContent = 'Analyzing game';
  $('progress-sub').textContent = `${game.white.username} vs ${game.black.username}`;
  $('progress-fill').style.width = '0%';
  $('progress-text').textContent = 'Starting engine…';
  const t0 = performance.now();
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pgn: game.pgn, depth: state.depth, username: state.user }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let review = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        if (msg.type === 'progress') {
          $('progress-fill').style.width = `${(msg.done / msg.total) * 100}%`;
          const secs = (performance.now() - t0) / 1000;
          const left = msg.done > 4 ? Math.max(0, Math.round((secs / msg.done) * (msg.total - msg.done))) : null;
          $('progress-text').textContent = `Position ${msg.done} of ${msg.total}` + (left != null ? ` · about ${left}s left` : '');
        } else if (msg.type === 'result') review = msg.review;
        else if (msg.type === 'error') throw new Error(msg.error);
      }
    }
    if (!review) throw new Error('Analysis ended without a result');
    $('progress-fill').style.width = '100%';
    $('progress-text').textContent = 'Done!';
    await sleep(250);
    openReview(review);
  } catch (err) {
    showError(`Analysis failed: ${err.message}`);
  } finally {
    $('progress').classList.add('hidden');
  }
}

// ---------- Board sizing ----------
let cg;
function fitBoard() {
  if ($('review').classList.contains('hidden')) return;
  const stage = $('stage');
  let size;
  if (innerWidth > 900) {
    const w = stage.clientWidth - 40 - 34;
    const h = stage.clientHeight - 28 - 42 * 2 - 16;
    size = Math.min(w, h);
  } else {
    size = Math.min(innerWidth - 24 - 34, 680);
  }
  size = Math.max(256, Math.floor(size / 8) * 8);
  const prev = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--board'), 10);
  if (size === prev && cg) return;
  document.documentElement.style.setProperty('--board', `${size}px`);
  if (cg) {
    cg.redrawAll();
    renderFx(state.retry ? null : currentMove(), { still: true });
  }
}
new ResizeObserver(() => fitBoard()).observe($('stage'));

// ---------- Review view ----------
function openReview(review) {
  stopPlay();
  state.review = review;
  state.ply = -1;
  state.retry = null;
  state.preview = false;
  state.orientation = review.userColor === 'b' ? 'black' : 'white';
  $('picker').classList.add('hidden');
  $('review').classList.remove('hidden');
  $('retry-btn').classList.remove('on');
  $('retry-btn').querySelector('span').textContent = 'Retry mistakes';
  const h = review.headers;
  $('crumb').innerHTML = `<b>${esc(h.white)}</b> vs <b>${esc(h.black)}</b> · ${esc([h.result, review.opening].filter(Boolean).join(' · '))}`;
  fitBoard();
  if (!cg) {
    cg = Chessground($('board'), {
      coordinates: true,
      animation: { enabled: true, duration: 220 },
      highlight: { lastMove: false, check: true },
      movable: { free: false, color: undefined },
      draggable: { enabled: true, showGhost: true },
      premovable: { enabled: false },
      drawable: {
        enabled: true,
        visible: true,
        brushes: {
          green: { key: 'g', color: '#81b64c', opacity: 0.85, lineWidth: 11 },
          blue: { key: 'b', color: '#5c9fe0', opacity: 0.8, lineWidth: 11 },
        },
      },
    });
  }
  renderMoves();
  renderGraph();
  renderReport();
  setTab('report');
  render();
}

function currentMove() {
  return state.ply >= 0 ? state.review.moves[state.ply] : null;
}

function render({ still = false } = {}) {
  const r = state.review;
  const m = currentMove();
  const pos = r.positions[state.ply + 1];
  const chess = new Chess(pos.fen);
  const inRetry = !!state.retry;
  state.preview = false;
  const config = {
    fen: pos.fen,
    orientation: state.orientation,
    turnColor: chess.turn() === 'w' ? 'white' : 'black',
    lastMove: m ? [m.from, m.to] : undefined,
    check: chess.inCheck(),
  };
  // In retry mode showPuzzle() owns the movable config; passing cg.state.movable back in
  // would wipe its dests (chessground clears dests before merging).
  if (!inRetry) config.movable = { color: undefined, dests: new Map() };
  cg.set(config);
  const shapes = [];
  if (m && !inRetry && m.bestUci && !m.isBest && !['book', 'forced', 'best', 'brilliant', 'great'].includes(m.label)) {
    shapes.push({ orig: m.bestUci.slice(0, 2), dest: m.bestUci.slice(2, 4), brush: 'green' });
  }
  cg.setAutoShapes(shapes);
  renderFx(inRetry ? null : m, { still });
  renderEval(pos);
  renderBars();
  updateMoveHighlight();
  updateGraphCursor();
  if (!inRetry) renderCoach();
}

function squarePos(sq) {
  const file = sq.charCodeAt(0) - 97;
  const rank = +sq[1] - 1;
  const white = state.orientation === 'white';
  return { left: (white ? file : 7 - file) * 12.5, top: (white ? 7 - rank : rank) * 12.5 };
}

// Colored from/to squares (under the pieces) and the classification badge (above them).
function renderFx(m, { still = false, color } = {}) {
  const board = document.querySelector('#board cg-board');
  if (!board) return;
  board.querySelectorAll('.tint').forEach((el) => el.remove());
  const fx = $('fx-layer');
  fx.innerHTML = '';
  if (!m) return;
  const label = color || m.label;
  const glow = !still && (label === 'brilliant' || label === 'great');
  for (const sq of [m.from, m.to]) {
    const p = squarePos(sq);
    const el = document.createElement('div');
    el.className = 'tint' + (glow ? ' glow' : '') + (still ? ' still' : '');
    el.style.cssText = `left:${p.left}%;top:${p.top}%;background:color-mix(in srgb, var(--c-${label}) ${sq === m.to ? 60 : 45}%, transparent)`;
    if (still) el.style.animation = 'none';
    board.prepend(el);
  }
  const p = squarePos(m.to);
  const anim = still ? 'style="animation:none"' : '';
  fx.innerHTML = `<div class="sq-badge" style="left:${p.left}%;top:${p.top}%">${badge(label).replace('<span class', `<span ${anim} class`)}</div>` +
    (!still && RING.has(label) ? `<div class="ring" style="left:${p.left}%;top:${p.top}%;--ring:var(--c-${label})"></div>` : '');
}

function renderEval(pos) {
  const flipped = state.orientation === 'black';
  $('eval-bar').classList.toggle('flipped', flipped);
  $('eval-fill').style.height = `${Math.max(3, Math.min(97, pos.win))}%`;
  const label = $('eval-label');
  const whiteAhead = !pos.eval.startsWith('-') && pos.eval !== '0-1';
  label.className = 'eval-label ' + (whiteAhead !== flipped ? 'bottom' : 'top');
  const score = pos.score;
  if (score.mate != null) {
    label.textContent = pos.eval.replace('-', '');
    return;
  }
  // Count the number toward the new evaluation.
  const from = state.evalShown;
  const to = Math.abs(score.cp) / 100;
  state.evalShown = to;
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 450);
    const v = from + (to - from) * (1 - (1 - k) ** 3);
    label.textContent = v >= 10 ? v.toFixed(0) : v.toFixed(1);
    if (k < 1 && state.evalShown === to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function clockAt(color) {
  const moves = state.review.moves;
  for (let i = state.ply; i >= 0; i--) if (moves[i].color === color && moves[i].clock) return moves[i].clock;
  const first = moves.find((m) => m.color === color && m.clock);
  return first ? first.clock : null;
}
const fmtClock = (c) => (c ? c.replace(/^0:(?=\d\d:)/, '').replace(/^0(?=\d:)/, '').replace(/\.\d$/, '') : '');

// Captured pieces and material balance, like the strip above/below a chess.com board.
function material(fen) {
  const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const ch of fen.split(' ')[0]) {
    const t = ch.toLowerCase();
    if (!(t in START)) continue;
    count[ch === t ? 'b' : 'w'][t]++;
  }
  const score = (c) => Object.entries(count[c]).reduce((a, [t, n]) => a + VAL[t] * n, 0);
  const glyph = { w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕' }, b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' } };
  const caps = (by) => {
    const victim = by === 'w' ? 'b' : 'w';
    return ['p', 'b', 'n', 'r', 'q'].map((t) => glyph[victim][t].repeat(Math.max(0, START[t] - count[victim][t]))).join('');
  };
  const diff = score('w') - score('b');
  return { w: caps('w'), b: caps('b'), diff };
}

function renderBars() {
  const r = state.review;
  const h = r.headers;
  const fen = r.positions[state.ply + 1].fen;
  const toMove = fen.split(' ')[1];
  const mat = material(fen);
  const bar = (c) => {
    const name = c === 'w' ? h.white : h.black;
    const elo = c === 'w' ? h.whiteElo : h.blackElo;
    const clk = clockAt(c);
    const adv = c === 'w' ? mat.diff : -mat.diff;
    return `<span class="avatar ${c}">${esc((name || '?')[0].toUpperCase())}</span>
      <div class="pb-info"><span class="pb-name">${esc(name)} <span class="elo">${elo ? '(' + esc(elo) + ')' : ''}</span></span>
      <span class="pb-caps">${mat[c]}${adv > 0 ? `<b>+${adv}</b>` : ''}</span></div>
      ${clk ? `<span class="clock ${toMove === c ? 'active' : ''}">${esc(fmtClock(clk))}</span>` : ''}`;
  };
  const bottom = state.orientation === 'white' ? 'w' : 'b';
  $('bar-bottom').innerHTML = bar(bottom);
  $('bar-top').innerHTML = bar(bottom === 'w' ? 'b' : 'w');
}

// ---------- Tabs ----------
function setTab(tab) {
  if (state.tab !== tab) $('panel-body').scrollTop = 0;
  state.tab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('report').classList.toggle('hidden', tab !== 'report');
  $('moves').classList.toggle('hidden', tab !== 'moves');
  const on = document.querySelector('#tabs button.on');
  $('tab-ink').style.left = `${on.offsetLeft}px`;
  $('tab-ink').style.width = `${on.offsetWidth}px`;
  if (tab === 'moves') updateMoveHighlight();
}

// ---------- Move list ----------
function renderMoves() {
  const moves = state.review.moves;
  let html = '';
  for (let i = 0; i < moves.length; i += 2) {
    const cell = (m) => (m ? `<button class="mv" data-ply="${m.ply}">${badge(m.label)}<span>${esc(m.san)}</span>${m.clock ? `<span class="clk">${esc(fmtClock(m.clock))}</span>` : ''}</button>` : '<span></span>');
    html += `<div class="move-row"><span class="move-no">${i / 2 + 1}.</span>${cell(moves[i])}${cell(moves[i + 1])}</div>`;
  }
  $('moves').innerHTML = html;
}

function updateMoveHighlight() {
  document.querySelectorAll('.mv.on').forEach((el) => el.classList.remove('on'));
  const el = document.querySelector(`.mv[data-ply="${state.ply}"]`);
  if (!el || state.tab !== 'moves') return;
  el.classList.add('on');
  const box = $('panel-body');
  const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  if (top < box.scrollTop + 20 || top > box.scrollTop + box.clientHeight - 50) {
    box.scrollTo({ top: top - box.clientHeight / 2, behavior: 'smooth' });
  }
}

// ---------- Eval graph ----------
const GW = 400, GH = 92;
const gx = (i) => { const n = state.review.positions.length; return n === 1 ? 0 : (i / (n - 1)) * GW; };
const gy = (w) => GH - (w / 100) * (GH - 4) - 2;

function renderGraph() {
  const pos = state.review.positions;
  let d = `M0,${GH} `;
  pos.forEach((p, i) => { d += `L${gx(i).toFixed(1)},${gy(p.win).toFixed(1)} `; });
  d += `L${GW},${GH} Z`;
  const dots = state.review.moves
    .filter((m) => ['blunder', 'mistake', 'miss', 'brilliant', 'great'].includes(m.label))
    .map((m) => `<circle cx="${gx(m.ply + 1).toFixed(1)}" cy="${gy(pos[m.ply + 1].win).toFixed(1)}" r="3.4" fill="var(--c-${m.label})" stroke="#262421" stroke-width="1.2"/>`)
    .join('');
  const g = $('graph');
  g.setAttribute('viewBox', `0 0 ${GW} ${GH}`);
  g.innerHTML = `
    <defs><clipPath id="reveal"><rect x="0" y="0" width="0" height="${GH}"><animate attributeName="width" from="0" to="${GW}" dur="0.9s" fill="freeze" calcMode="spline" keySplines="0.2 0.8 0.2 1" keyTimes="0;1"/></rect></clipPath></defs>
    <g clip-path="url(#reveal)">
      <path d="${d}" fill="#f2f0eb"/>
      ${dots}
    </g>
    <line x1="0" x2="${GW}" y1="${GH / 2}" y2="${GH / 2}" stroke="#8b877f" stroke-width="0.7" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
    <line id="graph-hover" x1="0" x2="0" y1="0" y2="${GH}" stroke="#ffffff" stroke-opacity=".35" stroke-width="1" vector-effect="non-scaling-stroke" visibility="hidden"/>
    <g id="graph-cursor" class="graph-cursor"><line x1="0" x2="0" y1="0" y2="${GH}" stroke="#81b64c" stroke-width="2" vector-effect="non-scaling-stroke"/></g>`;
}

function updateGraphCursor() {
  const c = $('graph-cursor');
  if (c) c.style.transform = `translateX(${gx(state.ply + 1)}px)`;
}

function graphIndex(e) {
  const rect = $('graph').getBoundingClientRect();
  const n = state.review.positions.length;
  return Math.max(0, Math.min(n - 1, Math.round(((e.clientX - rect.left) / rect.width) * (n - 1))));
}

// ---------- Report ----------
function countUp(el, to, decimals = 1, dur = 900) {
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    el.textContent = (to * (1 - (1 - k) ** 3)).toFixed(decimals);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderReport() {
  const r = state.review;
  const s = r.stats;
  const h = r.headers;
  let i = 0;
  const delay = () => `style="animation-delay:${80 + i++ * 35}ms"`;
  const row = (l) => {
    const w = s.w.counts[l], b = s.b.counts[l];
    return `<tr ${delay()}><td class="n ${w ? 'txt-' + l : 'zero'}">${w}</td><td class="lab"><span>${badge(l)} ${LABEL_NAME[l]}</span></td><td class="n ${b ? 'txt-' + l : 'zero'}">${b}</td></tr>`;
  };
  const phaseDot = (v) => {
    if (v == null) return '<span class="rp-phase" style="color:var(--faint)">–</span>';
    const c = v >= 90 ? 'best' : v >= 80 ? 'excellent' : v >= 70 ? 'good' : v >= 60 ? 'inaccuracy' : v >= 50 ? 'mistake' : 'blunder';
    return `<span class="rp-phase"><i style="background:var(--c-${c})"></i>${v.toFixed(0)}</span>`;
  };
  const player = (c, name) => `<div class="rp-player ${c}">
      <span class="avatar ${c}">${esc((name || '?')[0].toUpperCase())}</span>
      <span class="rp-name">${esc(name)}</span>
      <span class="rp-acc" data-acc="${s[c].accuracy}">0.0</span>
      <span class="rp-label">Accuracy</span></div>`;
  $('report').innerHTML = `
    <div class="rp-players">${player('w', h.white)}${player('b', h.black)}</div>
    <table class="rp-table">
      ${LABEL_ORDER.map(row).join('')}
      <tr class="rp-sep rp-rating" ${delay()}><td class="n">${s.w.rating}</td><td class="lab"><span>Game rating</span></td><td class="n">${s.b.rating}</td></tr>
      ${['opening', 'middlegame', 'endgame'].map((p) => `<tr ${delay()}><td class="n">${phaseDot(s.w.phases[p])}</td><td class="lab"><span>${p[0].toUpperCase() + p.slice(1)}</span></td><td class="n">${phaseDot(s.b.phases[p])}</td></tr>`).join('')}
    </table>
    <button class="btn primary big rp-start" id="start-review">Start review</button>
    <div class="rp-meta">${esc(r.engine)} · depth ${r.depth}${r.seconds ? ` · analyzed in ${r.seconds.toFixed(0)}s` : ''}</div>`;
  document.querySelectorAll('.rp-acc').forEach((el) => countUp(el, +el.dataset.acc));
  $('start-review').onclick = () => go(0, { sound: true });
}

// ---------- Coach ----------
function setBubble(html, { talking = false } = {}) {
  $('bubble').innerHTML = `<div class="bubble-inner">${html}</div>`;
  $('coach').classList.toggle('talking', talking);
}

function titleFor(m) {
  const s = esc(m.san);
  return {
    brilliant: `${s} is brilliant`, great: `${s} is a great move`, best: `${s} is best`, excellent: `${s} is excellent`,
    good: `${s} is good`, book: `${s} is a book move`, inaccuracy: `${s} is an inaccuracy`, mistake: `${s} is a mistake`,
    miss: `${s} is a miss`, blunder: `${s} is a blunder`, forced: `${s} is forced`,
  }[m.label] || s;
}

function evalChip(ev) {
  const neg = ev.startsWith('-') || ev === '0-1';
  return `<span class="bubble-eval ${neg ? 'neg' : ''}">${esc(ev)}</span>`;
}

function renderCoach() {
  const m = currentMove();
  clearTimeout(state.explainTimer);
  state.abort?.abort();
  if (!m) return renderSummaryCoach();
  const ev = state.review.positions[m.ply + 1].eval;
  const showBest = !m.isBest && m.bestSan && !['book', 'forced'].includes(m.label);
  setBubble(`
    <div class="bubble-head">${badge(m.label)}<span class="bubble-title txt-${m.label}">${titleFor(m)}</span>${evalChip(ev)}</div>
    <div class="bubble-text" id="coach-text"></div>
    <div class="bubble-foot">
      ${showBest ? `<span class="best-line">Best was <b>${esc(m.bestSan)}</b></span><button class="chip-btn" id="show-best">Show best</button>` : ''}
      <span class="ai-tag" id="ai-tag"></span>
    </div>`);
  if (showBest) $('show-best').onclick = () => toggleBestPreview(m);
  const textEl = $('coach-text');
  const key = `${state.review.moves.length}:${m.ply}:${m.fenAfter}`;
  if (state.explained.has(key)) {
    textEl.textContent = state.explained.get(key);
    return;
  }
  textEl.textContent = m.template;
  if (!state.coachOk || m.label === 'book' || m.label === 'forced') return;
  textEl.classList.add('muted');
  $('ai-tag').innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  // Wait a moment so scrolling through moves doesn't queue a request per move.
  state.explainTimer = setTimeout(() => streamInto('/api/explain', { facts: m.facts, san: m.san }, textEl, key, () => currentMove() === m && !state.retry), 260);
}

async function streamInto(url, body, el, key, stillCurrent) {
  const ctrl = new AbortController();
  state.abort = ctrl;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (!stillCurrent()) return;
      el.classList.remove('muted');
      el.innerHTML = esc(text) + '<span class="caret"></span>';
      $('coach').classList.add('talking');
    }
    text = text.trim();
    if (!stillCurrent()) return;
    el.textContent = text;
    $('coach').classList.remove('talking');
    if (text && !text.includes('[coach unavailable')) state.explained.set(key, text);
    const tag = $('ai-tag');
    if (tag) tag.textContent = '';
  } catch (err) {
    if (err.name !== 'AbortError' && stillCurrent()) {
      el.classList.remove('muted');
      $('coach').classList.remove('talking');
      const tag = $('ai-tag');
      if (tag) tag.textContent = 'Coach unavailable';
    }
  }
}

function renderSummaryCoach() {
  const r = state.review;
  const h = r.headers;
  setBubble(`
    <div class="bubble-head"><span class="badge lbl-best">${ICON.star}</span><span class="bubble-title">Game review</span><span class="bubble-eval">${esc(h.result || '')}</span></div>
    <div class="bubble-text muted" id="coach-text">Here's how the game went. Press → or Start review to step through every move.</div>
    <div class="bubble-foot"><button class="chip-btn green" id="bubble-start">Start review</button><span class="ai-tag" id="ai-tag"></span></div>`);
  $('bubble-start').onclick = () => go(0, { sound: true });
  if (!state.coachOk) return;
  const key = 'summary:' + r.positions.length + ':' + r.positions.at(-1).fen;
  const textEl = $('coach-text');
  if (state.explained.has(key)) {
    textEl.classList.remove('muted');
    textEl.textContent = state.explained.get(key);
    return;
  }
  $('ai-tag').innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  const userColor = r.userColor;
  streamInto('/api/summary', {
    white: h.white, black: h.black, result: h.result, opening: r.opening,
    player: userColor === 'b' ? h.black : h.white, playerColor: userColor === 'b' ? 'Black' : 'White',
    whiteAcc: r.stats.w.accuracy.toFixed(1), blackAcc: r.stats.b.accuracy.toFixed(1),
    keyMoments: r.keyMoments,
  }, textEl, key, () => state.ply === -1 && !state.retry);
}

// Animate the engine's best move on the board in place of the game move.
async function toggleBestPreview(m) {
  const btn = $('show-best');
  if (state.preview) { render({ still: true }); return; }
  stopPlay();
  state.preview = true;
  btn.textContent = 'Back to game';
  const c = new Chess(m.fenBefore);
  const best = c.move({ from: m.bestUci.slice(0, 2), to: m.bestUci.slice(2, 4), promotion: m.bestUci[4] || 'q' });
  cg.setAutoShapes([]);
  renderFx(null);
  cg.set({ fen: m.fenBefore, lastMove: undefined, check: false });
  await sleep(300);
  if (!state.preview || currentMove() !== m) return;
  cg.set({ fen: best.after, lastMove: [best.from, best.to], check: c.inCheck() });
  sound.playMove(best.san, best.captured);
  renderFx({ from: best.from, to: best.to, label: 'best' });
}

// ---------- Navigation ----------
function go(ply, { sound: withSound = false } = {}) {
  if (!state.review) return;
  const max = state.review.moves.length - 1;
  const prev = state.ply;
  const next = Math.max(-1, Math.min(max, ply));
  if (next === prev && !state.preview) return;
  state.ply = next;
  if (prev === -1 && next >= 0 && state.tab === 'report') setTab('moves');
  if (next === -1 && prev !== -1) setTab('report');
  render();
  if (withSound && Math.abs(next - prev) === 1) {
    const m = state.review.moves[Math.max(next, prev)];
    sound.playMove(m.san, m.captured);
    if (next > prev && m.label === 'brilliant') sound.play('brilliant');
  }
}

function nav(action) {
  if (state.retry) return;
  if (action !== 'play') stopPlay();
  if (action === 'start') go(-1);
  else if (action === 'prev') go(state.ply - 1, { sound: true });
  else if (action === 'next') go(state.ply + 1, { sound: true });
  else if (action === 'end') go(Infinity);
}

function renderPlayBtn() {
  $('play-btn').innerHTML = state.playing ? ICON.pause : ICON.play;
  $('play-btn').title = state.playing ? 'Pause (Space)' : 'Play (Space)';
}

function togglePlay() {
  if (state.retry || !state.review) return;
  if (state.playing) return stopPlay();
  if (state.ply >= state.review.moves.length - 1) go(-1);
  state.playing = setInterval(() => {
    if (state.ply >= state.review.moves.length - 1) return stopPlay();
    go(state.ply + 1, { sound: true });
  }, 1100);
  go(state.ply + 1, { sound: true });
  renderPlayBtn();
}

function stopPlay() {
  clearInterval(state.playing);
  state.playing = null;
  renderPlayBtn();
}

// ---------- Retry mistakes ----------
function startRetry() {
  const r = state.review;
  if (!r) return;
  stopPlay();
  const list = r.moves.filter((m) => m.color === r.userColor && BAD.has(m.label)).map((m) => m.ply);
  if (!list.length) {
    setBubble(`<div class="bubble-head"><span class="badge lbl-best">${ICON.star}</span><span class="bubble-title">Nothing to retry</span></div><div class="bubble-text">You didn't make any inaccuracies, mistakes or blunders in this game. Nice!</div>`);
    return;
  }
  state.retry = { list, idx: 0, solved: new Set() };
  $('retry-btn').classList.add('on');
  $('retry-btn').querySelector('span').textContent = 'Exit retry';
  setTab('moves');
  showPuzzle();
}

function stopRetry() {
  state.retry = null;
  $('retry-btn').classList.remove('on');
  $('retry-btn').querySelector('span').textContent = 'Retry mistakes';
  cg.set({ movable: { color: undefined, dests: new Map() } });
  render();
}

function legalDests(fen) {
  const chess = new Chess(fen);
  const dests = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}

function showPuzzle() {
  const rt = state.retry;
  const m = state.review.moves[rt.list[rt.idx]];
  state.ply = m.ply - 1;
  const color = m.color === 'w' ? 'white' : 'black';
  cg.set({ movable: { free: false, color, dests: legalDests(m.fenBefore), showDests: true, events: { after: onRetryMove } } });
  render();
  cg.set({ lastMove: undefined });
  setBubble(`
    <div class="bubble-head">${badge(m.label)}<span class="bubble-title">Find a better move</span><span class="bubble-eval">${rt.idx + 1} / ${rt.list.length}</span></div>
    <div class="bubble-text">In the game you played <b>${esc(m.san)}</b> (${LABEL_NAME[m.label].toLowerCase()}). Find a better move for ${color === 'white' ? 'White' : 'Black'}.</div>
    <div class="retry-result hidden" id="retry-result"></div>
    <div class="bubble-foot">
      <button class="chip-btn" id="rt-hint">Hint</button>
      <button class="chip-btn" id="rt-show">Show answer</button>
      <button class="chip-btn" id="rt-prev" ${rt.idx === 0 ? 'disabled' : ''}>◀</button>
      <button class="chip-btn green" id="rt-next">${rt.idx === rt.list.length - 1 ? 'Finish' : 'Next ▶'}</button>
    </div>`);
  $('rt-hint').onclick = () => {
    cg.setAutoShapes([{ orig: m.bestUci.slice(0, 2), brush: 'green' }]);
    setRetryResult(`Hint: move the piece on ${m.bestUci.slice(0, 2)}.`, '');
  };
  $('rt-show').onclick = () => {
    cg.setAutoShapes([{ orig: m.bestUci.slice(0, 2), dest: m.bestUci.slice(2, 4), brush: 'green' }]);
    setRetryResult(`The best move was ${m.bestSan}.`, '');
  };
  $('rt-prev').onclick = () => { rt.idx--; showPuzzle(); };
  $('rt-next').onclick = () => {
    if (rt.idx === rt.list.length - 1) {
      const solved = rt.solved.size, total = rt.list.length;
      stopRetry();
      sound.play(solved === total ? 'brilliant' : 'end');
      setBubble(`<div class="bubble-head"><span class="badge lbl-great">!</span><span class="bubble-title">Retry finished</span><span class="bubble-eval">${solved} / ${total}</span></div><div class="bubble-text">You found a better move in ${solved} of ${total} positions.</div>`);
      return;
    }
    rt.idx++;
    showPuzzle();
  };
}

function setRetryResult(text, cls) {
  const el = $('retry-result');
  if (!el) return;
  el.textContent = text;
  el.className = 'retry-result ' + cls;
}

async function onRetryMove(orig, dest) {
  const rt = state.retry;
  if (!rt) return;
  const m = state.review.moves[rt.list[rt.idx]];
  const piece = new Chess(m.fenBefore).get(orig);
  const promo = piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1') ? 'q' : '';
  const tryMove = new Chess(m.fenBefore).move({ from: orig, to: dest, promotion: promo || undefined });
  sound.playMove(tryMove.san, tryMove.captured);
  cg.set({ movable: { color: undefined } });
  setRetryResult('Checking…', '');
  try {
    const res = await api('/api/check-move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen: m.fenBefore, uci: orig + dest + promo }) });
    if (state.retry !== rt) return;
    if (res.correct) {
      rt.solved.add(m.ply);
      sound.play('correct');
      renderFx({ from: orig, to: dest, label: res.bestUci === orig + dest + promo ? 'best' : 'excellent' });
      setRetryResult(res.bestUci === orig + dest + promo ? `✓ Correct! ${res.san} is the best move.` : `✓ Good find! ${res.san} works just as well (best was ${res.bestSan}).`, 'good');
      cg.setAutoShapes([]);
    } else {
      sound.play('wrong');
      renderFx({ from: orig, to: dest, label: 'blunder' });
      const wrap = $('board-wrap');
      wrap.classList.remove('shake');
      void wrap.offsetWidth;
      wrap.classList.add('shake');
      setRetryResult(`✗ ${res.san} isn't it. Try again.`, 'bad');
      setTimeout(() => {
        if (state.retry !== rt) return;
        const color = m.color === 'w' ? 'white' : 'black';
        renderFx(null);
        cg.set({ fen: m.fenBefore, lastMove: undefined, turnColor: color, movable: { color, dests: legalDests(m.fenBefore) } });
      }, 750);
    }
  } catch (err) {
    setRetryResult(`Could not check the move: ${err.message}`, 'bad');
  }
}

// ---------- Wiring ----------
function showPicker() {
  if (state.retry) stopRetry();
  stopPlay();
  state.abort?.abort();
  $('crumb').innerHTML = '';
  $('review').classList.add('hidden');
  $('picker').classList.remove('hidden');
}

$('user-form').addEventListener('submit', findGames);
$('month').addEventListener('change', loadMonth);
$('source').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && b.dataset.src !== state.source) setSource(b.dataset.src, { auto: true });
});
$('load-more').addEventListener('click', () => loadLichess(true));
$('coach-pill').addEventListener('click', () => { if (!state.coachOk) openCoachSetup(); });
$('coach-notice-btn').addEventListener('click', openCoachSetup);
$('setup-close').addEventListener('click', closeCoachSetup);
$('pgn-load').addEventListener('click', () => loadPgn());
$('pgn-user').value = store.get('cr-pgn-user');
$('pgn-user').addEventListener('change', () => store.set('cr-pgn-user', $('pgn-user').value.trim()));
const readPgnFile = (file) => {
  if (!file) return;
  file.text().then((text) => { $('pgn-text').value = text; loadPgn(text); });
};
$('pgn-file').addEventListener('change', (e) => readPgnFile(e.target.files[0]));
$('pgn-box').addEventListener('dragover', (e) => { e.preventDefault(); $('pgn-box').classList.add('drag'); });
$('pgn-box').addEventListener('dragleave', () => $('pgn-box').classList.remove('drag'));
$('pgn-box').addEventListener('drop', (e) => {
  e.preventDefault();
  $('pgn-box').classList.remove('drag');
  readPgnFile(e.dataTransfer.files[0]);
});
bindSeg('time-filter', (v) => { state.timeFilter = v; renderGameList(); });
bindSeg('depth', (v) => { state.depth = +v; });
$('game-list').addEventListener('click', (e) => {
  const el = e.target.closest('.game');
  if (el) analyze(state.games[+el.dataset.i]);
});
$('moves').addEventListener('click', (e) => {
  const el = e.target.closest('.mv');
  if (el && !state.retry) { stopPlay(); go(+el.dataset.ply, { sound: true }); }
});
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setTab(b.dataset.tab);
});
document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => nav(b.dataset.nav)));
$('play-btn').addEventListener('click', togglePlay);
$('flip').addEventListener('click', () => {
  state.orientation = state.orientation === 'white' ? 'black' : 'white';
  cg.set({ orientation: state.orientation });
  render({ still: true });
});
$('back').addEventListener('click', showPicker);
$('home-link').addEventListener('click', showPicker);
$('retry-btn').addEventListener('click', () => (state.retry ? stopRetry() : startRetry()));
$('sound-btn').addEventListener('click', () => { sound.setEnabled(!sound.isEnabled()); renderSoundBtn(); });

const graphWrap = $('graph-wrap');
graphWrap.addEventListener('click', (e) => {
  if (state.retry || !state.review) return;
  stopPlay();
  go(graphIndex(e) - 1, { sound: true });
});
graphWrap.addEventListener('mousemove', (e) => {
  if (!state.review) return;
  const i = graphIndex(e);
  const m = state.review.moves[i - 1];
  const tip = $('graph-tip');
  const rect = graphWrap.getBoundingClientRect();
  const x = (gx(i) / GW) * rect.width;
  tip.classList.remove('hidden');
  tip.style.left = `${Math.max(48, Math.min(rect.width - 48, x))}px`;
  tip.textContent = m ? `${Math.floor(m.ply / 2) + 1}${m.color === 'w' ? '.' : '…'} ${m.san}  ${state.review.positions[i].eval}` : 'Start';
  const hover = $('graph-hover');
  hover.setAttribute('x1', gx(i));
  hover.setAttribute('x2', gx(i));
  hover.setAttribute('visibility', 'visible');
});
graphWrap.addEventListener('mouseleave', () => {
  $('graph-tip').classList.add('hidden');
  $('graph-hover')?.setAttribute('visibility', 'hidden');
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'm' || e.key === 'M') { $('sound-btn').click(); return; }
  if ($('review').classList.contains('hidden')) return;
  const map = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'start', End: 'end' };
  if (map[e.key]) { e.preventDefault(); nav(map[e.key]); }
  else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'f' || e.key === 'F') $('flip').click();
});
addEventListener('resize', () => {
  if (state.review) setTab(state.tab);
  placeSourceInk();
});

renderSoundBtn();
renderPlayBtn();
loadStatus();
setSource(['chesscom', 'lichess', 'pgn'].includes(store.get('cr-source')) ? store.get('cr-source') : 'chesscom', { auto: true });
