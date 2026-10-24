// Opening book built from lichess-org/chess-openings (CC0). Every prefix of every
// named line counts as "book"; the deepest named line gives the opening name.
import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';

let book = null;

export function epd(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function loadBook(root) {
  if (book) return book;
  book = new Map(); // epd -> { eco, name } (name only set where a line ends)
  const dir = path.join(root, 'data');
  for (const f of ['a', 'b', 'c', 'd', 'e']) {
    const file = path.join(dir, `${f}.tsv`);
    if (!fs.existsSync(file)) continue;
    const rows = fs.readFileSync(file, 'utf8').split('\n').slice(1);
    for (const row of rows) {
      const [eco, name, pgn] = row.split('\t');
      if (!pgn) continue;
      const chess = new Chess();
      const sans = pgn.replace(/\d+\.(\.\.)?/g, ' ').trim().split(/\s+/);
      try {
        for (const san of sans) {
          chess.move(san);
          const key = epd(chess.fen());
          if (!book.has(key)) book.set(key, { eco: null, name: null });
        }
        const entry = book.get(epd(chess.fen()));
        entry.eco = eco;
        entry.name = name.trim();
      } catch {
        // skip malformed line
      }
    }
  }
  return book;
}
