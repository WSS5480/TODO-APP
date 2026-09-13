import { describe, it, expect } from "vitest";
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
