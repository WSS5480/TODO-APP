import { describe, it, expect, vi, afterEach } from "vitest";
import { buildChimeWav } from "./sound.js";

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
  let settlePlay;
  const el = {
    muted: false,
    currentTime: 0,
    preload: "",
    play: vi.fn(() => {
      plays.push({ muted: el.muted });
      return new Promise((resolve) => { settlePlay = resolve; });
    }),
    pause: vi.fn(),
  };
  return { el, plays, settle: () => settlePlay && settlePlay() };
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
