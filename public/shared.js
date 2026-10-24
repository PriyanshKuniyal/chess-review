// Helpers shared by the review screen (app.js) and the play-the-coach screen (play.js).
import { Chess } from '/vendor/chess.js';

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const LABEL_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];
export const LABEL_NAME = {
  brilliant: 'Brilliant', great: 'Great', best: 'Best', excellent: 'Excellent', good: 'Good', book: 'Book',
  inaccuracy: 'Inaccuracy', mistake: 'Mistake', miss: 'Miss', blunder: 'Blunder', forced: 'Forced',
};
export const BAD = new Set(['inaccuracy', 'mistake', 'miss', 'blunder']);
export const RING = new Set(['brilliant', 'great', 'blunder', 'miss']);
export const svg = (d) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
export const ICON = {
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
export const GLYPH = {
  brilliant: '!!', great: '!', best: ICON.star, excellent: ICON.check, good: ICON.check, book: ICON.book,
  inaccuracy: '?!', mistake: '?', miss: '✕', blunder: '??', forced: '→',
};
export const badge = (label) => `<span class="badge lbl-${label}" title="${LABEL_NAME[label]}">${GLYPH[label]}</span>`;

export async function api(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export function legalDests(fen) {
  const chess = new Chess(fen);
  const dests = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}

// Captures are counted against the game's own starting position, so games set up from a FEN
// (endgames, puzzles) don't show a full army as "captured".
export function material(fen, startFen) {
  const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const tally = (f) => {
    const c = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
    for (const ch of f.split(' ')[0]) {
      const t = ch.toLowerCase();
      if (t in VAL) c[ch === t ? 'b' : 'w'][t]++;
    }
    return c;
  };
  const count = tally(fen);
  const start = tally(startFen || fen);
  const score = (c) => Object.entries(count[c]).reduce((a, [t, n]) => a + VAL[t] * n, 0);
  const glyph = { w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕' }, b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' } };
  const caps = (by) => {
    const victim = by === 'w' ? 'b' : 'w';
    return ['p', 'b', 'n', 'r', 'q'].map((t) => glyph[victim][t].repeat(Math.max(0, start[victim][t] - count[victim][t]))).join('');
  };
  const diff = score('w') - score('b');
  return { w: caps('w'), b: caps('b'), diff };
}

export function titleFor(m) {
  const s = esc(m.san);
  return {
    brilliant: `${s} is brilliant`, great: `${s} is a great move`, best: `${s} is best`, excellent: `${s} is excellent`,
    good: `${s} is good`, book: `${s} is a book move`, inaccuracy: `${s} is an inaccuracy`, mistake: `${s} is a mistake`,
    miss: `${s} is a miss`, blunder: `${s} is a blunder`, forced: `${s} is forced`,
  }[m.label] || s;
}

export function evalChip(ev) {
  const neg = ev.startsWith('-') || ev === '0-1';
  return `<span class="bubble-eval ${neg ? 'neg' : ''}">${esc(ev)}</span>`;
}

export function linkSans(node, link) {
  link.sans ||= (() => {
    const c = new Chess(link.base === 'after' ? node.fenAfter : node.fenBefore);
    const out = [];
    for (const u of link.uci) {
      try { out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); } catch { break; }
    }
    return out;
  })();
  return link.sans;
}

export const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function linkify(text, node) {
  const links = node?.links || [];
  const spans = [];
  const free = (s, e) => spans.every((x) => e <= x.s || s >= x.e);
  links.forEach((l, li) => {
    for (const src of l.patterns) {
      const m = new RegExp(src, 'i').exec(text);
      if (m && free(m.index, m.index + m[0].length)) { spans.push({ s: m.index, e: m.index + m[0].length, li, n: 0, kind: l.kind }); break; }
    }
  });
  // Moves the coach names, e.g. "the opponent plays Qxg5", link to the line up to that move.
  links.forEach((l, li) => {
    linkSans(node, l).forEach((san, k) => {
      if (san === node.san) return;
      const bare = san.replace(/[+#]$/, '');
      // Two-character pawn moves ("e5") are often squares, so only link them after a verb.
      const pre = bare.length > 2 ? '(?:^|[^\\w])' : '(?:play|plays|played|playing|with|after|reply|replies|was|is|move)\\s+';
      const m = new RegExp(`${pre}(${escRe(bare)}[+#]?)(?![\\w])`, 'i').exec(text);
      if (!m) return;
      const s = m.index + m[0].length - m[1].length;
      if (free(s, s + m[1].length)) spans.push({ s, e: s + m[1].length, li, n: k + 1, kind: 'move' });
    });
  });
  spans.sort((a, b) => a.s - b.s);
  let html = '';
  let at = 0;
  for (const sp of spans) {
    const l = links[sp.li];
    const title = sp.n ? `Show ${linkSans(node, l).slice(0, sp.n).join(' ')}` : l.label;
    html += esc(text.slice(at, sp.s)) + `<button class="idea idea-${sp.kind}" data-li="${sp.li}" data-n="${sp.n}" title="${esc(title)}">${esc(text.slice(sp.s, sp.e))}</button>`;
    at = sp.e;
  }
  return html + esc(text.slice(at));
}

// The model sometimes echoes a fact label ("Main reason: ...") at the start; drop it.
export const cleanCoach = (t) => t.replace(/^\s*(main reason|key point)[^:]*:\s*/i, '').trim();

// Square position (percent from the top-left) for a given board orientation.
export function squarePosFor(sq, orientation) {
  const file = sq.charCodeAt(0) - 97;
  const rank = +sq[1] - 1;
  const white = orientation === 'white';
  return { left: (white ? file : 7 - file) * 12.5, top: (white ? 7 - rank : rank) * 12.5 };
}

// Coordinates drawn inside the edge squares, like chess.com.
export function coordsHtml(orientation) {
  const white = orientation === 'white';
  let html = '';
  for (let i = 0; i < 8; i++) {
    const rank = white ? 8 - i : i + 1;
    const edgeFile = white ? 0 : 7;
    html += `<span class="coord rank ${(edgeFile + rank - 1) % 2 === 0 ? 'on-dark' : 'on-light'}" style="top:${i * 12.5}%">${rank}</span>`;
    const f = white ? i : 7 - i;
    const edgeRank = white ? 0 : 7;
    html += `<span class="coord file ${(f + edgeRank) % 2 === 0 ? 'on-dark' : 'on-light'}" style="left:${i * 12.5}%">${'abcdefgh'[f]}</span>`;
  }
  return html;
}

// Promotion picker over the promotion file, like chess.com: queen, knight, rook, bishop.
// `layer` is an overlay element with the .promo.cg-wrap classes. Returns { promise, cancel };
// the promise resolves to 'q' | 'n' | 'r' | 'b', or null if cancelled (click outside).
export function pickPromotion(layer, dest, color, orientation) {
  let done;
  const promise = new Promise((resolve) => {
    const p = squarePosFor(dest, orientation);
    const down = p.top === 0;
    const NAME = { q: 'queen', n: 'knight', r: 'rook', b: 'bishop' };
    layer.innerHTML = ['q', 'n', 'r', 'b'].map((t, i) => `<button class="promo-choice" data-t="${t}" title="${NAME[t]}"
      style="left:${p.left}%;top:${p.top + (down ? i : -i) * 12.5}%;animation-delay:${i * 30}ms"><piece class="${NAME[t]} ${color === 'w' ? 'white' : 'black'}"></piece></button>`).join('');
    layer.classList.remove('hidden');
    done = (t) => {
      layer.classList.add('hidden');
      layer.innerHTML = '';
      layer.onclick = null;
      resolve(t);
    };
    layer.onclick = (e) => done(e.target.closest('.promo-choice')?.dataset.t || null);
  });
  return { promise, cancel: () => done(null) };
}
