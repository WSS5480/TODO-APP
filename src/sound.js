// Alarm chime, synthesized once as a small WAV and played through an <audio>
// element. An <audio> element (unlike the Web Audio API) is treated as media
// playback on iOS, so it is not muted by the ringer switch, and once it has
// been "unlocked" by a user gesture it can play later from a timer.

const RATE = 22050;

function addTone(buf, startSec, freq, durSec, gain) {
  const start = Math.floor(startSec * RATE);
  const n = Math.min(Math.floor(durSec * RATE), buf.length - start);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const attack = Math.min(1, t / 0.008);
    const decay = Math.exp(-3.2 * t);
    // fundamental plus a touch of 2nd/3rd harmonic for a bell-like timbre
    const s =
      Math.sin(2 * Math.PI * freq * t) +
      0.35 * Math.sin(2 * Math.PI * freq * 2 * t) +
      0.12 * Math.sin(2 * Math.PI * freq * 3 * t);
    buf[start + i] += s * gain * attack * decay;
  }
}

export function buildChimeWav() {
  const dur = 1.2;
  const n = Math.floor(RATE * dur);
  const pcm = new Float32Array(n);
  addTone(pcm, 0.0, 659.25, 1.0, 0.45);  // E5
  addTone(pcm, 0.16, 880.0, 1.0, 0.45);  // A5
  addTone(pcm, 0.32, 1318.5, 0.85, 0.22); // E6 sparkle

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

let audio = null;
let enabled = true;
let unlocked = false;
let unlocking = null; // in-flight unlock, so a chime fired in the same gesture can wait

function getAudio() {
  if (!audio) {
    audio = new Audio(buildChimeWav());
    audio.preload = "auto";
  }
  return audio;
}

export function setSoundEnabled(on) {
  enabled = !!on;
}

// Call from a user gesture (click/tap/keydown). Plays muted for an instant so the
// browser's autoplay policy lets the same element play later from a timer.
// Resolves once the element is unmuted and idle again: the same gesture often also
// previews the chime, and that must not play into the element while it is muted.
export function unlockAudio() {
  if (unlocked) return Promise.resolve();
  if (unlocking) return unlocking;

  const a = getAudio();
  a.muted = true;

  const done = () => {
    a.pause();
    a.currentTime = 0;
    a.muted = false;
    unlocked = true;
    unlocking = null;
  };
  const fail = () => {
    a.muted = false;
    unlocking = null;
  };

  let p;
  try {
    p = a.play();
  } catch {
    fail();
    return Promise.resolve();
  }
  unlocking = Promise.resolve(p).then(done, fail);
  return unlocking;
}

export function playChime() {
  if (!enabled) return false;
  const a = getAudio();

  const start = () => {
    a.muted = false; // an unlock may have left it muted
    try { a.currentTime = 0; } catch { /* not seekable yet */ }
    const p = a.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  };

  // An unlock from this same gesture still has the element muted and will pause
  // it when it settles; wait for that instead of ringing into it.
  if (unlocking) {
    unlocking.then(start, start);
    return true;
  }

  try {
    start();
  } catch {
    return false;
  }
  return true;
}
