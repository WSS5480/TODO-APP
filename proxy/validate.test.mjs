import { describe, it, expect } from "vitest";
import {
  hostAllowed,
  isPrivateAddress,
  normalizeTarget,
  resolvesPublicly,
  originAllowed,
} from "./validate.mjs";

describe("hostAllowed", () => {
  it("accepts the calendar services and their subdomains", () => {
    expect(hostAllowed("p1-calendars.icloud.com")).toBe(true);
    expect(hostAllowed("icloud.com")).toBe(true);
    expect(hostAllowed("calendar.google.com")).toBe(true);
    expect(hostAllowed("P1-CALENDARS.ICLOUD.COM.")).toBe(true); // case and trailing dot
  });

  it("is not fooled by a host that merely contains an allowed name", () => {
    expect(hostAllowed("icloud.com.evil.test")).toBe(false);
    expect(hostAllowed("noticloud.com")).toBe(false);
    expect(hostAllowed("evil-icloud.com")).toBe(false);
    expect(hostAllowed("")).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  it("catches every range a proxy must not be pointed at", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // the cloud metadata endpoint
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("lets ordinary public addresses through", () => {
    for (const ip of ["17.253.144.10", "8.8.8.8", "172.32.0.1", "2606:2800:220::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("treats anything it cannot parse as private", () => {
    expect(isPrivateAddress("")).toBe(true);
    expect(isPrivateAddress("not an ip")).toBe(true);
    expect(isPrivateAddress("1.2.3")).toBe(true);
    expect(isPrivateAddress("1.2.3.999")).toBe(true);
  });
});

describe("normalizeTarget", () => {
  it("accepts a published iCloud calendar in either form", () => {
    const webcal = normalizeTarget("webcal://p1-calendars.icloud.com/published/2/abc");
    expect(webcal).toMatchObject({
      ok: true,
      url: "https://p1-calendars.icloud.com/published/2/abc",
      hostname: "p1-calendars.icloud.com",
    });
    expect(normalizeTarget("https://calendar.google.com/calendar/ical/x/basic.ics").ok).toBe(true);
  });

  it("refuses everything that is not a calendar on a known host", () => {
    const cases = [
      ["", "no url given"],
      ["   ", "no url given"],
      ["not a url", "not a url"],
      ["http://p1-calendars.icloud.com/x", "https only"],
      ["file:///etc/passwd", "https only"],
      ["ftp://icloud.com/x", "https only"],
      ["https://169.254.169.254/latest/meta-data/", "known calendar"],
      ["https://localhost/x", "known calendar"],
      ["https://icloud.com.evil.test/x", "known calendar"],
    ];
    for (const [input, fragment] of cases) {
      const res = normalizeTarget(input);
      expect(res.ok, input).toBe(false);
      expect(res.error, input).toContain(fragment);
    }
  });

  it("refuses an address carrying credentials", () => {
    const res = normalizeTarget("https://user:pass@p1-calendars.icloud.com/x");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("credentials");
  });

  it("refuses an absurdly long address", () => {
    const res = normalizeTarget(`https://icloud.com/${"a".repeat(2100)}`);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("too long");
  });

  it("can be given a different host list", () => {
    expect(normalizeTarget("https://cal.example.test/x", ["example.test"]).ok).toBe(true);
    expect(normalizeTarget("https://p1-calendars.icloud.com/x", ["example.test"]).ok).toBe(false);
  });
});

describe("resolvesPublicly", () => {
  const lookup = (answers) => async () => answers;

  it("accepts a host that resolves only to public addresses", async () => {
    await expect(resolvesPublicly("a.test", lookup([{ address: "17.253.144.10" }]))).resolves.toBe(true);
  });

  it("refuses a host with any private answer, and one that will not resolve", async () => {
    await expect(
      resolvesPublicly("a.test", lookup([{ address: "17.253.144.10" }, { address: "10.0.0.5" }])),
    ).resolves.toBe(false);
    await expect(resolvesPublicly("a.test", lookup([]))).resolves.toBe(false);
    await expect(resolvesPublicly("a.test")).resolves.toBe(false); // no lookup given
    await expect(
      resolvesPublicly("a.test", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).resolves.toBe(false);
  });
});

describe("originAllowed", () => {
  it("allows any origin when nothing is configured", () => {
    expect(originAllowed("https://todo-app-qpd5.onrender.com", "*")).toBe("*");
    expect(originAllowed("https://anything.test", "")).toBe("*");
  });

  it("echoes back only a listed origin", () => {
    const list = "https://todo-app-qpd5.onrender.com, https://todo.example.test";
    expect(originAllowed("https://todo-app-qpd5.onrender.com", list)).toBe(
      "https://todo-app-qpd5.onrender.com",
    );
    expect(originAllowed("https://todo-app-qpd5.onrender.com/", list)).toBe(
      "https://todo-app-qpd5.onrender.com",
    );
    expect(originAllowed("https://evil.test", list)).toBe("");
    expect(originAllowed("", list)).toBe("");
  });
});
