import { describe, it, expect } from "vitest";
import {
  normalizeFeedUrl,
  isICloudFeed,
  proxiedUrl,
  fetchCalendar,
} from "./calsync.js";

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Apple Inc.//iOS 18//EN",
  "X-WR-CALNAME:Work",
  "BEGIN:VEVENT",
  "UID:ev-1",
  "SUMMARY:Review",
  "DTSTART:20260510T140000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const now = Date.UTC(2026, 4, 1, 12, 0);

// A fetch stand-in: a map of url -> either a response or an Error to throw.
const fakeFetch = (routes) => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const hit = routes[url] ?? routes["*"];
    if (hit instanceof Error) throw hit;
    if (hit === undefined) throw new TypeError("Failed to fetch");
    return hit;
  };
  impl.calls = calls;
  return impl;
};

const ok = (text) => ({ ok: true, status: 200, text: async () => text });
const status = (code) => ({ ok: false, status: code, text: async () => "" });

describe("normalizeFeedUrl", () => {
  it("turns a webcal link into one fetch can use", () => {
    expect(normalizeFeedUrl("webcal://p1-calendars.icloud.com/published/2/abc")).toBe(
      "https://p1-calendars.icloud.com/published/2/abc",
    );
    expect(normalizeFeedUrl("webcals://example.com/a.ics")).toBe("https://example.com/a.ics");
  });

  it("leaves a plain http(s) link alone and tolerates a missing scheme", () => {
    expect(normalizeFeedUrl("https://example.com/a.ics")).toBe("https://example.com/a.ics");
    expect(normalizeFeedUrl("  example.com/a.ics ")).toBe("https://example.com/a.ics");
  });

  it("refuses anything that is not an address", () => {
    expect(normalizeFeedUrl("")).toBe("");
    expect(normalizeFeedUrl(null)).toBe("");
    expect(normalizeFeedUrl("my calendar")).toBe("");
    expect(normalizeFeedUrl("javascript:alert(1)")).toBe("");
  });
});

describe("isICloudFeed", () => {
  it("recognises iCloud and nothing pretending to be it", () => {
    expect(isICloudFeed("https://p1-calendars.icloud.com/published/2/x")).toBe(true);
    expect(isICloudFeed("https://icloud.com.evil.test/x")).toBe(false);
    expect(isICloudFeed("not a url")).toBe(false);
  });
});

describe("proxiedUrl", () => {
  it("hands the feed over as a query parameter", () => {
    expect(proxiedUrl("https://proxy.test/ics", "https://a.test/c.ics?x=1")).toBe(
      "https://proxy.test/ics?url=https%3A%2F%2Fa.test%2Fc.ics%3Fx%3D1",
    );
  });

  it("ignores a trailing slash and an empty base", () => {
    expect(proxiedUrl("https://proxy.test/ics/", "https://a.test/c")).toContain("/ics?url=");
    expect(proxiedUrl("", "https://a.test/c")).toBe("");
  });
});

describe("fetchCalendar", () => {
  const feed = "webcal://p1-calendars.icloud.com/published/2/abc";
  const direct = "https://p1-calendars.icloud.com/published/2/abc";

  it("uses a direct read when the host allows it", async () => {
    const fetchImpl = fakeFetch({ [direct]: ok(ICS) });
    const res = await fetchCalendar(feed, { now, fetchImpl, proxy: "https://proxy.test/ics" });
    expect(res.ok).toBe(true);
    expect(res.via).toBe("direct");
    expect(res.calendarName).toBe("Work");
    expect(res.tasks.map((t) => t.extId)).toEqual(["ev-1"]);
    expect(fetchImpl.calls).toHaveLength(1); // the proxy was never needed
  });

  it("falls back to the proxy when the browser blocks the direct read", async () => {
    const proxy = "https://proxy.test/ics";
    const fetchImpl = fakeFetch({
      [direct]: new TypeError("Failed to fetch"),
      [proxiedUrl(proxy, direct)]: ok(ICS),
    });
    const res = await fetchCalendar(feed, { now, fetchImpl, proxy });
    expect(res.ok).toBe(true);
    expect(res.via).toBe("proxy");
    expect(res.tasks).toHaveLength(1);
  });

  it("explains a block when there is no proxy to fall back to", async () => {
    const fetchImpl = fakeFetch({ [direct]: new TypeError("Failed to fetch") });
    const res = await fetchCalendar(feed, { now, fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/directly/);
  });

  it("reports what the server said", async () => {
    const fetchImpl = fakeFetch({ "*": status(404) });
    const res = await fetchCalendar(feed, { now, fetchImpl, proxy: "https://proxy.test/ics" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("404");
  });

  it("does not accept a page that is not a calendar", async () => {
    const fetchImpl = fakeFetch({ "*": ok("<html>Sign in to iCloud</html>") });
    const res = await fetchCalendar(feed, { now, fetchImpl, proxy: "https://proxy.test/ics" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a calendar/);
  });

  it("gives up on a feed that never answers", async () => {
    const fetchImpl = async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const res = await fetchCalendar(feed, { now, fetchImpl, timeoutMs: 10 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/too long/);
  });

  it("rejects a bad address without touching the network", async () => {
    const fetchImpl = fakeFetch({ "*": ok(ICS) });
    const res = await fetchCalendar("my calendar", { now, fetchImpl });
    expect(res.ok).toBe(false);
    expect(fetchImpl.calls).toHaveLength(0);
  });
});
