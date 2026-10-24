// End-to-end check without the UI: reviews Morphy's Opera Game and checks the results make sense.
//   node scripts/smoke-test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnginePool, findStockfish } from '../lib/engine.js';
import { loadBook } from '../lib/openings.js';
import { reviewGame } from '../lib/analysis.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PGN = `[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7 8.Nc3 c6 9.Bg5 b5
10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7 14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0`;

const exe = findStockfish(ROOT);
assert.ok(exe, 'Stockfish not found (run npm run setup)');
const engine = new EnginePool(exe, { size: 2 });
await engine.start();
const t0 = Date.now();
try {
  const r = await reviewGame(PGN, engine, { depth: 14, book: loadBook(ROOT) });
  assert.equal(r.moves.length, 33);
  assert.equal(r.moves.at(-1).san, 'Rd8#');
  assert.equal(r.moves[0].label, 'book');
  assert.equal(r.moves.find((m) => m.san === 'Qb8+').label, 'brilliant', 'the queen sacrifice should be brilliant');
  for (const c of ['w', 'b']) assert.ok(Number.isFinite(r.stats[c].accuracy) && r.stats[c].accuracy > 0);
  assert.ok(r.stats.w.accuracy > r.stats.b.accuracy, 'Morphy should be more accurate');
  console.log(`OK: ${r.moves.length} moves reviewed in ${((Date.now() - t0) / 1000).toFixed(1)}s, accuracy ${r.stats.w.accuracy.toFixed(1)} / ${r.stats.b.accuracy.toFixed(1)}`);
} finally {
  engine.stop();
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}
