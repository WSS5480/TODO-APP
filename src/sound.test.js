import { describe, it, expect, vi, afterEach } from "vitest";
import { buildChimeWav, buildWav, SOUNDS, SOUND_NAMES } from "./sound.js";

describe("buildChimeWav", () => {
  it("produces a valid 16-bit mono PCM WAV data URL", () => {
    const url = buildChimeWav();
    expect(url.startsWith("data:audio/wav;base64,")).toBe(true);
    const bytes = Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
    const ascii = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(36, 4)).toBe("data");
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(22, true)).toBe(1);      // mono
    expect(view.getUint16(34, true)).toBe(16);     // bits
    expect(view.getUint32(40, true)).toBe(bytes.length - 44);
    // not silent
    let peak = 0;
    for (let i = 44; i < bytes.length; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
    expect(peak).toBeGreaterThan(8000);
  });
});

/* ---------- unlock / playback ---------- */

// A stand-in for the <audio> element that records whether it was muted at the
// moment play() was called, and lets the test decide when play() settles.
function fakeAudio() {
  const plays = [];
  const pending = [];
  const el = {
    muted: false,
    currentTime: 0,
    preload: "",
    play: vi.fn(() => {
      plays.push({ muted: el.muted });
      return new Promise((resolve) => { pending.push(resolve); });
    }),
    pause: vi.fn(),
  };
  // unlockAudio() primes one element per sound, so settle every pending play
  return { el, plays, settle: () => { pending.splice(0).forEach((r) => r()); } };
}

// sound.js holds module-level state (the element, the unlocked flag), so every
// test needs a fresh import.
async function freshSound(el) {
  vi.resetModules();
  vi.stubGlobal("Audio", function Audio() { return el; });
  return import("./sound.js");
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { vi.unstubAllGlobals(); });

describe("unlockAudio + playChime", () => {
  it("plays the chime unmuted when an unlock from the same gesture is still in flight", async () => {
    const { el, plays, settle } = fakeAudio();
    const sound = await freshSound(el);

    // What the Sound button does: unlock, then immediately preview the chime.
    sound.unlockAudio();
    sound.playChime();
    settle();
    await flush();

    expect(plays[0].muted).toBe(true);            // the silent unlock
    expect(plays.some((p) => !p.muted)).toBe(true); // the audible chime
    expect(el.muted).toBe(false);                 // never left muted
  });

  it("plays immediately once unlocked", async () => {
    const { el, plays, settle } = fakeAudio();
    const sound = await freshSound(el);

    sound.unlockAudio();
    settle();
    await flush();
    plays.length = 0;

    expect(sound.playChime()).toBe(true);
    expect(plays).toHaveLength(1);
    expect(plays[0].muted).toBe(false);
  });

  it("stays silent while sound is disabled", async () => {
    const { el, plays } = fakeAudio();
    const sound = await freshSound(el);

    sound.setSoundEnabled(false);
    expect(sound.playChime()).toBe(false);
    expect(plays).toHaveLength(0);
  });

  it("unmutes the element if the unlock play is rejected", async () => {
    const { el } = fakeAudio();
    el.play = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
    const sound = await freshSound(el);

    sound.unlockAudio();
    await flush();
    expect(el.muted).toBe(false);
  });

  it("only unlocks once", async () => {
    const { el, settle } = fakeAudio();
    const sound = await freshSound(el);

    sound.unlockAudio();
    settle();
    await flush();
    const callsAfterFirst = el.play.mock.calls.length;

    sound.unlockAudio();
    await flush();
    expect(el.play.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe("sound library", () => {
  it("builds a distinct, non-silent WAV for every sound", () => {
    const seen = new Set();
    for (const name of SOUND_NAMES) {
      const url = buildWav(SOUNDS[name]);
      expect(url.startsWith("data:audio/wav;base64,")).toBe(true);
      const bytes = Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
      const view = new DataView(bytes.buffer);
      let peak = 0;
      for (let i = 44; i < bytes.length; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
      expect(peak, `${name} is silent`).toBeGreaterThan(8000);
      expect(seen.has(url), `${name} duplicates another sound`).toBe(false);
      seen.add(url);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("playSound", () => {
  it("repeats the alarm the requested number of times", async () => {
    vi.useFakeTimers();
    const { el, plays, settle } = fakeAudio();
    const sound = await freshSound(el);
    sound.unlockAudio();
    settle();
    await vi.advanceTimersByTimeAsync(2000);
    plays.length = 0;

    sound.playSound("chime", { repeat: 3 });
    expect(plays).toHaveLength(1);          // first ring is immediate
    await vi.advanceTimersByTimeAsync(10_000);
    expect(plays).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(plays).toHaveLength(3);          // and then it stops
    vi.useRealTimers();
  });

  it("stop() silences a repeating alarm", async () => {
    vi.useFakeTimers();
    const { el, plays, settle } = fakeAudio();
    const sound = await freshSound(el);
    sound.unlockAudio();
    settle();
    await vi.advanceTimersByTimeAsync(2000);
    plays.length = 0;

    const alarm = sound.playSound("chime", { repeat: 10 });
    alarm.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(plays).toHaveLength(1);          // only the ring already started
    expect(el.pause).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("never rings more than MAX_REPEAT times", async () => {
    vi.useFakeTimers();
    const { el, plays, settle } = fakeAudio();
    const sound = await freshSound(el);
    sound.unlockAudio();
    settle();
    await vi.advanceTimersByTimeAsync(2000);
    plays.length = 0;

    sound.playSound("chime", { repeat: 1000 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(plays).toHaveLength(sound.MAX_REPEAT);
    vi.useRealTimers();
  });

  it("falls back to the default sound for an unknown name", async () => {
    const { el, plays, settle } = fakeAudio();
    const sound = await freshSound(el);
    sound.unlockAudio();
    settle();
    await flush();
    plays.length = 0;

    sound.playSound("no-such-sound");
    expect(plays).toHaveLength(1);
  });

  it("rings anyway if the unlock never settles", async () => {
    vi.useFakeTimers();
    const { el, plays } = fakeAudio();
    const sound = await freshSound(el);

    sound.unlockAudio();   // never settled: play() stays pending
    plays.length = 0;
    sound.playSound("chime");
    expect(plays).toHaveLength(0);                  // deferred at first

    await vi.advanceTimersByTimeAsync(sound.UNLOCK_TIMEOUT_MS + 50);
    expect(plays).toHaveLength(1);                  // the guard lets it through
    vi.useRealTimers();
  });
});
