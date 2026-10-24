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
- Every fact says which side plays each move (White or Black). Keep that straight: never say a move is played by, or allowed for, the other side.
- Never copy the labels of the facts (like "Main reason:") into your answer; just explain.
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

// Drops thinking tags and any fact label the model echoed back (e.g. "Main reason:").
export const cleanText = (t) => t.replace(/<\/?think>/g, '').replace(/^\s*(main reason|key point)[^:]*:\s*/i, '').trim();

async function streamChat(messages, onToken, { maxTokens = 180, signal, temperature = 0.4 } = {}) {
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
      options: { temperature, num_predict: maxTokens },
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
  return cleanText(full);
}

const SIDE_NAME = { w: 'White', b: 'Black' };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Words that turn "White ... f6" into a claim that White plays f6 ("allowed White to play f6",
// "White could answer with f6", "White's best move was f6").
const PLAY_VERBS = 'play|plays|played|playing|reply|replies|replied|answer|answers|answered|respond|responds|responded|'
  + 'continue|continues|continued|go|goes|went|push|pushes|pushed|take|takes|took|capture|captures|captured|'
  + 'move|moves|was|is|with';
// ...unless the words in between say the move is aimed at that side ("White can't deal with f6").
const NOT_PLAYING = 'deal|cope|struggle|face|faces|facing|stop|prevent|meet|handle|after|against|attacked|hit';
// "White's bishop" is the object of a sentence, not White making a move.
const OWNED = String.raw`(?:\w+\s+)?(?:king|queen|rook|bishop|knight|pawn|pieces?|position|camp|side|army)\b`;

// Finds moves the text credits to the wrong side. `sides` maps each move named in the facts
// (SAN without +/#) to the side that plays it; `san` is the move being explained.
export function checkSides(text, sides, san) {
  const sans = Object.keys(sides || {}).sort((a, b) => b.length - a.length);
  if (!sans.length) return [];
  const mover = sides[String(san).replace(/[+#]$/, '')];
  const move = String.raw`(?:\d+\s*(?:\.\.\.|…|\.)\s*)?(?<![\w-])(${sans.map(escapeRe).join('|')})[+#]?(?![\w-])`;
  const side = '(White|Black|[Tt]he opponent)';
  const patterns = [
    String.raw`${side}(?:'s(?!\s+${OWNED}))?\s+(?:(?!(?:${NOT_PLAYING})\b)[a-z']+\s+){0,4}?(?:to\s+)?(?:${PLAY_VERBS})\s+(?:with\s+|by\s+)?(?:the\s+move\s+)?${move}`,
    String.raw`${side}'s\s+${move}`,
    String.raw`allow(?:s|ed|ing)?\s+${side}\s+(?:to\s+)?(?:play\s+)?${move}`,
  ];
  const who = (word) => (word === 'White' ? 'w' : word === 'Black' ? 'b' : mover && (mover === 'w' ? 'b' : 'w'));
  const bad = [];
  for (const p of patterns) {
    for (const m of text.matchAll(new RegExp(p, 'g'))) {
      const claimed = who(m[1]);
      const played = sides[m[2]];
      if (claimed && played && claimed !== played && !bad.some((b) => b.san === m[2])) bad.push({ san: m[2], side: played, claimed });
    }
  }
  return bad;
}

// Streams the explanation a sentence at a time, checking each one against `sides`. If a sentence
// credits a move to the wrong side, the coach gets one chance to rewrite it; if that's still wrong,
// the built-in `template` text is used. A form feed (\f) tells the page to drop what it has shown.
export async function explainMove(facts, san, onToken, signal, { sides, template } = {}) {
  const user = `Facts about this moment in the game:\n- ${facts.join('\n- ')}\n\nExplain ${san} to the player.`;
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
  if (!sides || !Object.keys(sides).length) return streamChat(messages, onToken, { signal });

  const stop = new AbortController();
  let raw = '';
  let pending = '';
  let shown = '';
  let bad = [];
  const pass = (sentence) => {
    bad = checkSides(sentence, sides, san);
    if (bad.length) return stop.abort();
    shown += sentence;
    onToken(sentence);
  };
  try {
    await streamChat(messages, (tok) => {
      raw += tok;
      if (bad.length) return;
      pending += tok;
      // Hand on each sentence once the next one has started (the dots in "16... f6" don't end one).
      let end;
      while (!bad.length && (end = pending.search(/(?<!(?:^|\s)\d+\.{0,2})[.!?]\s/)) >= 0) {
        const sentence = pending.slice(0, end + 2);
        pending = pending.slice(end + 2);
        pass(sentence);
      }
    }, { signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal });
    if (!bad.length && pending) pass(pending);
  } catch (e) {
    if (!stop.signal.aborted) throw e;
  }
  if (!bad.length) return cleanText(shown);

  const fix = bad.map((b) => `${b.san} is a move for ${SIDE_NAME[b.side]}, not ${SIDE_NAME[b.claimed]}`).join('; ');
  const retry = await streamChat([
    ...messages,
    { role: 'assistant', content: raw },
    { role: 'user', content: `That's wrong: ${fix}. Rewrite the explanation so every move is credited to the side that plays it.` },
  ], () => {}, { signal, temperature: 0.2 });
  const final = checkSides(retry, sides, san).length ? (template || cleanText(shown)) : retry;
  onToken('\f' + final);
  return cleanText(final);
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
