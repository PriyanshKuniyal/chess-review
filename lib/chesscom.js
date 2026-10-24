// Chess.com public API (no auth). Docs: https://www.chess.com/news/view/published-data-api
const UA = 'chess-review (https://github.com/PriyanshKuniyal/chess-review)';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 404) throw Object.assign(new Error('Player not found on Chess.com'), { status: 404 });
  if (!res.ok) throw Object.assign(new Error(`Chess.com returned ${res.status}`), { status: 502 });
  return res.json();
}

export async function listArchives(username) {
  const user = encodeURIComponent(username.trim().toLowerCase());
  const data = await getJson(`https://api.chess.com/pub/player/${user}/games/archives`);
  return data.archives || [];
}

export const RESULT_TEXT = {
  win: 'won', checkmated: 'checkmated', agreed: 'draw agreed', repetition: 'repetition',
  timeout: 'timeout', resigned: 'resigned', stalemate: 'stalemate', lose: 'lost',
  insufficient: 'insufficient material', '50move': '50-move rule', abandoned: 'abandoned',
  timevsinsufficient: 'timeout vs insufficient material', kingofthehill: 'king of the hill',
  threecheck: 'three-check', bughousepartnerlose: 'partner lost',
};

export async function listGames(archiveUrl) {
  if (!/^https:\/\/api\.chess\.com\/pub\/player\/[^/]+\/games\/\d{4}\/\d{2}$/.test(archiveUrl)) {
    throw Object.assign(new Error('Bad archive URL'), { status: 400 });
  }
  const data = await getJson(archiveUrl);
  return (data.games || [])
    .filter((g) => g.rules === 'chess' && g.pgn)
    .map((g) => ({
      id: g.uuid || g.url,
      url: g.url,
      pgn: g.pgn,
      endTime: g.end_time,
      timeClass: g.time_class,
      timeControl: g.time_control,
      rated: g.rated,
      accuracies: g.accuracies || null,
      white: { username: g.white.username, rating: g.white.rating, result: g.white.result, resultText: RESULT_TEXT[g.white.result] || g.white.result },
      black: { username: g.black.username, rating: g.black.rating, result: g.black.result, resultText: RESULT_TEXT[g.black.result] || g.black.result },
    }))
    .sort((a, b) => b.endTime - a.endTime);
}
