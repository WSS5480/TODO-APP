// Alarm sounds, synthesized as small WAVs and played through <audio> elements.
// An <audio> element (unlike the Web Audio API) is treated as media playback on
// iOS, so it is not muted by the ringer switch, and once it has been "unlocked"
// by a user gesture it can play later from a timer.

const RATE = 22050;

// Each sound is a set of tones: [startSec, freq, durSec, gain].
// `decay` is the exponential fall-off: higher is shorter and more staccato.
export const SOUNDS = {
  chime: {
    label: "Chime",
    dur: 1.2,
    decay: 3.2,
    tones: [[0, 659.25, 1.0, 0.45], [0.16, 880.0, 1.0, 0.45], [0.32, 1318.5, 0.85, 0.22]],
  },
  bell: {
    label: "Bell",
    dur: 2.0,
    decay: 1.5,
    tones: [[0, 440.0, 1.95, 0.5], [0.015, 659.25, 1.6, 0.2], [0, 880.0, 1.2, 0.1]],
  },
  ping: {
    label: "Ping",
    dur: 0.5,
    decay: 7.0,
    tones: [[0, 1046.5, 0.45, 0.4]],
  },
  urgent: {
    label: "Urgent",
    dur: 1.2,
    decay: 11.0,
    tones: [
      [0, 987.77, 0.2, 0.5],
      [0.22, 987.77, 0.2, 0.5],
      [0.44, 987.77, 0.2, 0.5],
      [0.66, 1318.5, 0.35, 0.45],
    ],
  },
  marimba: {
    label: "Marimba",
    dur: 1.3,
    decay: 6.0,
    tones: [[0, 523.25, 0.6, 0.5], [0.13, 659.25, 0.6, 0.5], [0.26, 783.99, 0.9, 0.5]],
  },
  digital: {
    label: "Digital",
    dur: 1.5,
    decay: 16.0,
    tones: [
      [0, 1760.0, 0.12, 0.42], [0.14, 1760.0, 0.12, 0.42],
      [0.5, 1760.0, 0.12, 0.42], [0.64, 1760.0, 0.12, 0.42],
      [1.0, 1760.0, 0.12, 0.42], [1.14, 1760.0, 0.12, 0.42],
    ],
  },
  klaxon: {
    label: "Klaxon",
    dur: 1.8,
    decay: 1.2,
    tones: [
      [0, 329.63, 0.55, 0.55], [0.6, 392.0, 0.55, 0.55], [1.2, 329.63, 0.6, 0.55],
    ],
  },
  soft: {
    label: "Soft",
    dur: 1.6,
    decay: 2.2,
    tones: [[0, 392.0, 1.5, 0.4], [0.25, 523.25, 1.2, 0.22]],
  },
};

export const SOUND_NAMES = Object.keys(SOUNDS);
export const DEFAULT_DUE_SOUND = "chime";
export const DEFAULT_SOON_SOUND = "ping";

// "Until dismissed" is capped so a forgotten alarm cannot ring forever.
export const MAX_REPEAT = 30;

// Longest we wait for the unlock handshake before ringing anyway.
export const UNLOCK_TIMEOUT_MS = 1500;

export function soundSpec(name) {
  return SOUNDS[name] || SOUNDS[DEFAULT_DUE_SOUND];
}

function addTone(buf, startSec, freq, durSec, gain, decay) {
  const start = Math.floor(startSec * RATE);
  const n = Math.min(Math.floor(durSec * RATE), buf.length - start);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const attack = Math.min(1, t / 0.008);
    const fall = Math.exp(-decay * t);
    // fundamental plus a touch of 2nd/3rd harmonic for a bell-like timbre
    const s =
      Math.sin(2 * Math.PI * freq * t) +
      0.35 * Math.sin(2 * Math.PI * freq * 2 * t) +
      0.12 * Math.sin(2 * Math.PI * freq * 3 * t);
    buf[start + i] += s * gain * attack * fall;
  }
}

export function buildWav(spec) {
  const n = Math.floor(RATE * spec.dur);
  const pcm = new Float32Array(n);
  for (const [at, freq, dur, gain] of spec.tones) {
    addTone(pcm, at, freq, dur, gain, spec.decay);
  }

  const bytes = new Uint8Array(44 + n * 2);
  const view = new DataView(bytes.buffer);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, "RIFF"); view.setUint32(4, 36 + n * 2, true); str(8, "WAVE");
  str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return "data:audio/wav;base64," + btoa(bin);
}

export function buildChimeWav() {
  return buildWav(SOUNDS.chime);
}

const elements = new Map();
const unlockedNames = new Set();
let enabled = true;
let unlocking = null; // in-flight unlock, so a sound played in the same gesture can wait

function getAudio(name) {
  const key = SOUNDS[name] ? name : DEFAULT_DUE_SOUND;
  if (!elements.has(key)) {
    const a = new Audio(buildWav(SOUNDS[key]));
    a.preload = "auto";
    elements.set(key, a);
  }
  return elements.get(key);
}

export function setSoundEnabled(on) {
  enabled = !!on;
}

function unlockOne(a) {
  a.muted = true;
  const done = () => {
    a.pause();
    try { a.currentTime = 0; } catch { /* not seekable yet */ }
    a.muted = false;
  };
  let p;
  try {
    p = a.play();
  } catch {
    a.muted = false;
    return Promise.resolve();
  }
  return Promise.resolve(p).then(done, () => { a.muted = false; });
}

// Call from a user gesture (click/tap/keydown). Every sound needs its own
// element unlocked, since iOS grants playback per element, not per page.
// Resolves once they are all unmuted and idle again, so a preview played in the
// same gesture can wait rather than ring into a muted element.
export function unlockAudio(names = SOUND_NAMES) {
  const todo = names.filter((name) => SOUNDS[name] && !unlockedNames.has(name));
  if (!todo.length) return unlocking || Promise.resolve();

  const all = Promise.all(
    todo.map((name) => unlockOne(getAudio(name)).then(() => unlockedNames.add(name))),
  );
  // A play() promise that never settles must not leave every later alarm
  // waiting on it forever, which would silence the app for the whole session.
  const guard = new Promise((resolve) => setTimeout(resolve, UNLOCK_TIMEOUT_MS));
  const finish = () => { unlocking = null; };

  unlocking = Promise.race([all, guard]).then(finish, finish);
  return unlocking;
}

const NO_ALARM = { stop() {} };

// Play a sound, optionally repeating it. Returns a handle whose stop() silences
// it — the caller stops the alarm when the task is snoozed or marked done.
export function playSound(name, { repeat = 1 } = {}) {
  if (!enabled) return NO_ALARM;

  const key = SOUNDS[name] ? name : DEFAULT_DUE_SOUND;
  const a = getAudio(key);
  const gap = Math.round(SOUNDS[key].dur * 1000) + 250;

  let left = Math.max(1, Math.min(repeat, MAX_REPEAT));
  let cancelled = false;
  let timer = null;

  const once = () => {
    if (cancelled) return;
    a.muted = false; // an unlock may have left it muted
    try { a.currentTime = 0; } catch { /* not seekable yet */ }
    const p = a.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    if (--left > 0) timer = setTimeout(once, gap);
  };

  // An unlock from this same gesture still has the element muted and will pause
  // it when it settles; wait for that instead of ringing into it.
  if (unlocking) unlocking.then(once, once);
  else once();

  return {
    stop() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      try { a.pause(); a.currentTime = 0; } catch { /* already idle */ }
    },
  };
}

// Single ring, used for previews.
export function playChime(name = DEFAULT_DUE_SOUND) {
  if (!enabled) return false;
  playSound(name);
  return true;
}
