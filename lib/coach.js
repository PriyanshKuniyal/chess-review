// Written explanations from a local LLM served by Ollama.
// The engine and board code work out *what* happened; the model only puts it into words.
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
// The instruct build answers directly; plain qwen3:4b is a thinking-only model and ~20x slower here.
export const MODEL = process.env.COACH_MODEL || 'qwen3:4b-instruct';

const SYSTEM = `You are a friendly, concise chess coach doing a post-game review, like a strong club player explaining a move to a student.
Rules:
- Use ONLY the facts you are given. Never invent moves, pieces, squares or tactics that are not in the facts.
- Write 2 or 3 short sentences in plain English. No lists, no headings, no emojis.
- Do not mention engines, centipawns, percentages or evaluation numbers.
- Write moves exactly as given (e.g. Nf3, exd5, O-O).
- Say why the move is good or bad and, if a better move is given, what it would have achieved.
- If the facts don't say why something is good or bad, keep it simple instead of guessing at strategy. Never claim things like "central control", "pressure", "king safety" or "an attack" unless a fact says so.`;

// Load the model into memory ahead of the first explanation (cold start is ~20s).
export async function warmup() {
  try {
    await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model: MODEL, prompt: '', keep_alive: '30m' }) });
  } catch {}
}

export async function status() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name);
    const ok = names.includes(MODEL);
    return { ok, ollama: true, model: MODEL, available: names, error: ok ? undefined : `Model ${MODEL} is not installed` };
  } catch {
    return { ok: false, ollama: false, model: MODEL, available: [], error: 'Ollama is not running' };
  }
}

// Download the coach model through Ollama, reporting { status, total, completed } as it goes.
export async function pullModel(onProgress, signal) {
  const res = await fetch(`${OLLAMA}/api/pull`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      onProgress({ status: msg.status, total: msg.total || 0, completed: msg.completed || 0 });
    }
  }
  await warmup();
}

async function streamChat(messages, onToken, { maxTokens = 180, signal } = {}) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      think: false,
      keep_alive: '30m',
      options: { temperature: 0.4, num_predict: maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const tok = msg.message?.content || '';
      if (tok) { full += tok; onToken(tok); }
    }
  }
  return full.replace(/<\/?think>/g, '').trim();
}

export function explainMove(facts, san, onToken, signal) {
  const user = `Facts about this moment in the game:\n- ${facts.join('\n- ')}\n\nExplain ${san} to the player.`;
  return streamChat([{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], onToken, { signal });
}

export function summarizeGame(summary, onToken, signal) {
  const lines = summary.keyMoments.map((k) =>
    `Move ${k.moveNo}, ${k.color === 'w' ? 'White' : 'Black'} played ${k.san}: ${k.label}${k.bestSan && k.bestSan !== k.san ? ` (best was ${k.bestSan})` : ''}.${k.key ? ' ' + String(k.key) : ''}`);
  const user = `Game: ${summary.white} (White) vs ${summary.black} (Black). Result: ${summary.result}. Opening: ${summary.opening || 'unknown'}.
The player you are coaching is ${summary.player} (${summary.playerColor}).
Accuracy: White ${summary.whiteAcc}%, Black ${summary.blackAcc}%.
Key moments:
- ${lines.join('\n- ') || 'No big mistakes or brilliant moves.'}

Give the player a 3-4 sentence summary of how the game went and one concrete thing to work on. Talk to them directly ("you").
Only mention moves and reasons listed above; keep the move order exactly as given.`;
  return streamChat([{ role: 'system', content: SYSTEM.replace('2 or 3 short sentences', '3 or 4 short sentences') }, { role: 'user', content: user }], onToken, { maxTokens: 260, signal });
}
