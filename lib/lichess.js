// Lichess public API (no auth). Docs: https://lichess.org/api#tag/Games/operation/apiGamesUser
import { RESULT_TEXT } from './chesscom.js';

const UA = 'chess-review (https://github.com/PriyanshKuniyal/chess-review)';
const SPEED = { ultraBullet: 'bullet', bullet: 'bullet', blitz: 'blitz', rapid: 'rapid', classical: 'classical', correspondence: 'daily' };
const LOSS = { mate: 'checkmated', resign: 'resigned', outoftime: 'timeout', timeout: 'abandoned', noStart: 'abandoned' };

function player(p, color, winner, status) {
  const name = p.user?.name || (p.aiLevel ? `Stockfish level ${p.aiLevel}` : 'Anonymous');
  let result;
  if (!winner) result = status === 'stalemate' ? 'stalemate' : 'agreed';
  else result = winner === color ? 'win' : LOSS[status] || 'lose';
  return { username: name, rating: p.rating ?? '', result, resultText: RESULT_TEXT[result] || result };
}

// Newest games first. `until` (ms timestamp) pages back through older games.
export async function listLichessGames(username, { until, max = 40 } = {}) {
  const params = new URLSearchParams({ max: String(max), pgnInJson: 'true', clocks: 'true', opening: 'true', accuracy: 'true' });
  if (until) params.set('until', String(until));
  const res = await fetch(`https://lichess.org/api/games/user/${encodeURIComponent(username.trim())}?${params}`, {
    headers: { Accept: 'application/x-ndjson', 'User-Agent': UA },
  });
  if (res.status === 404) throw Object.assign(new Error('Player not found on Lichess'), { status: 404 });
  if (res.status === 429) throw Object.assign(new Error('Lichess is rate limiting requests. Wait a minute and try again.'), { status: 429 });
  if (!res.ok) throw Object.assign(new Error(`Lichess returned ${res.status}`), { status: 502 });
  const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const games = lines
    .filter((g) => g.variant === 'standard' && g.pgn && g.moves && !['aborted', 'noStart', 'created', 'started'].includes(g.status))
    .map((g) => {
      const acc = g.players.white.analysis?.accuracy != null && g.players.black.analysis?.accuracy != null
        ? { white: g.players.white.analysis.accuracy, black: g.players.black.analysis.accuracy } : null;
      return {
        id: g.id,
        url: `https://lichess.org/${g.id}`,
        pgn: g.pgn,
        endTime: Math.round((g.lastMoveAt || g.createdAt) / 1000),
        timeClass: SPEED[g.speed] || g.speed,
        timeControl: g.clock ? `${g.clock.initial}${g.clock.increment ? '+' + g.clock.increment : ''}` : g.daysPerTurn ? `1/${g.daysPerTurn * 86400}` : '',
        rated: g.rated,
        accuracies: acc,
        white: player(g.players.white, 'white', g.winner, g.status),
        black: player(g.players.black, 'black', g.winner, g.status),
      };
    });
  const last = lines.at(-1);
  return { games, next: lines.length >= max && last ? last.createdAt - 1 : null };
}
