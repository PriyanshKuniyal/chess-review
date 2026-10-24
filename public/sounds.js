// Board sounds. Moves and captures use short recorded wooden knocks (Kenney "Impact Sounds",
// CC0) shaped to match a piece landing on a board: a very fast decay (about 10 ms) plus a tiny
// contact click. Captures add a second, quieter knock ~30 ms later, like one piece striking another.
// Chimes for check/retry are synthesized.
let ctx = null;
let noise = null;
let enabled = true;
const buffers = { wood: [], knock: null };
try { enabled = localStorage.getItem('cr-sound') !== 'off'; } catch {}

function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

async function load(name) {
  const res = await fetch(`/sounds/${name}.ogg`);
  return audio().decodeAudioData(await res.arrayBuffer());
}

// Decoding works while the context is still suspended, so samples are ready by the first move.
const ready = Promise.all([
  ...[1, 2, 3, 4, 5].map((i) => load(`wood-${i}`).then((b) => buffers.wood.push(b))),
  load('knock').then((b) => { buffers.knock = b; }),
]).catch(() => {});

const jitter = (x, amt) => x * (1 + (Math.random() * 2 - 1) * amt);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// One knock: a sample with a fast exponential decay, a highpass to keep it from thudding,
// and a ~4 ms band-passed noise click for the moment of contact.
function knock(t, buf, { rate = 1.15, gain = 1, tau = 0.005, hp = 180, click = 2600, clickGain = 0.25 } = {}) {
  const ac = audio();
  if (buf) {
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = jitter(rate, 0.04);
    const f = ac.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.setTargetAtTime(0, t + 0.002, tau);
    src.connect(f).connect(g).connect(ac.destination);
    src.start(t);
    src.stop(t + 0.15);
  }
  if (clickGain > 0) {
    const n = ac.createBufferSource();
    n.buffer = noise;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = jitter(click, 0.08);
    bp.Q.value = 1.4;
    const cg = ac.createGain();
    cg.gain.setValueAtTime(clickGain, t);
    cg.gain.exponentialRampToValueAtTime(0.0005, t + 0.004);
    n.connect(bp).connect(cg).connect(ac.destination);
    n.start(t);
    n.stop(t + 0.01);
  }
}

function tone(t, freq, dur, { type = 'sine', gain = 0.12 } = {}) {
  const ac = audio();
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const move = (t) => knock(t, pick(buffers.wood));
const capture = (t) => {
  knock(t, buffers.knock, { rate: 1.5, tau: 0.01, hp: 300, click: 4000, clickGain: 0.8 });
  knock(t + 0.032, pick(buffers.wood), { rate: 1.5, gain: 0.22, tau: 0.006, clickGain: 0.12 });
};

const SOUNDS = {
  move,
  capture,
  castle: (t) => { move(t); knock(t + 0.1, pick(buffers.wood), { rate: 1.05, gain: 0.85 }); },
  check: (t) => { move(t); tone(t + 0.02, 1568, 0.16, { gain: 0.07 }); tone(t + 0.06, 2093, 0.2, { gain: 0.05 }); },
  promote: (t) => { move(t); [1047, 1319, 1568].forEach((f, i) => tone(t + 0.05 + i * 0.055, f, 0.16, { gain: 0.06 })); },
  end: (t) => { [523, 659, 784].forEach((f) => tone(t, f, 0.7, { type: 'triangle', gain: 0.06 })); },
  correct: (t) => { tone(t, 784, 0.14, { gain: 0.1 }); tone(t + 0.08, 1175, 0.28, { gain: 0.1 }); },
  wrong: (t) => { tone(t, 247, 0.16, { type: 'triangle', gain: 0.12 }); tone(t + 0.09, 196, 0.22, { type: 'triangle', gain: 0.1 }); },
  brilliant: (t) => { [1047, 1319, 1568, 2093].forEach((f, i) => tone(t + 0.12 + i * 0.05, f, 0.22, { gain: 0.045 })); },
};

export function play(kind) {
  if (!enabled || !SOUNDS[kind]) return;
  try {
    const ac = audio();
    if (!buffers.wood.length) { ready.then(() => SOUNDS[kind](ac.currentTime + 0.01)); return; }
    SOUNDS[kind](ac.currentTime + 0.005);
  } catch {}
}

// Sound for a move given its SAN.
export function playMove(san, captured) {
  if (san.includes('#')) { play(captured || san.includes('x') ? 'capture' : 'move'); setTimeout(() => play('end'), 140); }
  else if (san.includes('+')) play('check');
  else if (san.includes('=')) play('promote');
  else if (san.startsWith('O-O')) play('castle');
  else if (captured || san.includes('x')) play('capture');
  else play('move');
}

export function isEnabled() { return enabled; }
export function setEnabled(on) {
  enabled = on;
  try { localStorage.setItem('cr-sound', on ? 'on' : 'off'); } catch {}
  if (on) play('move');
}
