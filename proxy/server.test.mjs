import { describe, it, expect } from "vitest";
import { createHandler } from "./server.mjs";

const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
const FEED = "https://p1-calendars.icloud.com/published/2/abc";

// A response good enough for the handler, without a network.
const reply = (body, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});

// A res double that records what the handler wrote.
function fakeRes() {
  const out = { status: 0, headers: {}, body: "", extra: {} };
  return {
    out,
    setHeader(k, v) {
      out.extra[k] = v;
    },
    getHeader(k) {
      return out.headers[k] ?? out.extra[k];
    },
    writeHead(status, headers = {}) {
      out.status = status;
      out.headers = { ...out.headers, ...headers };
    },
    end(body = "") {
      out.body = String(body);
    },
  };
}

const req = (url, { method = "GET", headers = {} } = {}) => ({
  method,
  url,
  headers,
  socket: { remoteAddress: "203.0.113.9" },
});

const publicLookup = async () => [{ address: "17.253.144.10" }];

const run = async (request, options = {}) => {
  const res = fakeRes();
  await createHandler({ lookup: publicLookup, log: () => {}, ...options })(request, res);
  return res.out;
};

const ask = (feed = FEED, options = {}, headers = {}) =>
  run(req(`/ics?url=${encodeURIComponent(feed)}`, { headers }), options);

describe("the proxy handler", () => {
  it("answers a health check", async () => {
    const out = await run(req("/healthz"));
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).ok).toBe(true);
  });

  it("fetches a published calendar and makes it readable by the page", async () => {
    const calls = [];
    const out = await ask(FEED, {
      fetchImpl: async (url) => {
        calls.push(url);
        return reply(ICS);
      },
    });

    expect(out.status).toBe(200);
    expect(out.body).toBe(ICS);
    expect(out.headers["Content-Type"]).toContain("text/calendar");
    expect(out.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(out.headers["X-Proxy-Cache"]).toBe("miss");
    // the webcal form of the same address is what the app sends
    expect(calls).toEqual([FEED]);
  });

  it("accepts the webcal address the calendar app hands out", async () => {
    const calls = [];
    const out = await ask("webcal://p1-calendars.icloud.com/published/2/abc", {
      fetchImpl: async (url) => {
        calls.push(url);
        return reply(ICS);
      },
    });
    expect(out.status).toBe(200);
    expect(calls).toEqual([FEED]);
  });

  it("serves the second request from its cache", async () => {
    let fetched = 0;
    const handler = createHandler({
      lookup: publicLookup,
      fetchImpl: async () => {
        fetched += 1;
        return reply(ICS);
      },
    });

    const first = fakeRes();
    await handler(req(`/ics?url=${encodeURIComponent(FEED)}`), first);
    const second = fakeRes();
    await handler(req(`/ics?url=${encodeURIComponent(FEED)}`), second);

    expect(fetched).toBe(1);
    expect(second.out.headers["X-Proxy-Cache"]).toBe("hit");
    expect(second.out.body).toBe(ICS);
  });

  it("re-reads once the cache has gone stale", async () => {
    let fetched = 0;
    let clock = 1_000_000;
    const handler = createHandler({
      lookup: publicLookup,
      now: () => clock,
      cacheSeconds: 60,
      fetchImpl: async () => {
        fetched += 1;
        return reply(ICS);
      },
    });

    await handler(req(`/ics?url=${encodeURIComponent(FEED)}`), fakeRes());
    clock += 61_000;
    const again = fakeRes();
    await handler(req(`/ics?url=${encodeURIComponent(FEED)}`), again);
    expect(fetched).toBe(2);
    expect(again.out.headers["X-Proxy-Cache"]).toBe("miss");
  });

  it("follows a redirect that stays on an allowed host", async () => {
    const seen = [];
    const out = await ask(FEED, {
      fetchImpl: async (url) => {
        seen.push(url);
        return seen.length === 1
          ? reply("", { status: 302, headers: { location: "https://p2-calendars.icloud.com/x" } })
          : reply(ICS);
      },
    });
    expect(out.status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  it("refuses a redirect that leaves the allowed hosts", async () => {
    const out = await ask(FEED, {
      fetchImpl: async () =>
        reply("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    });
    expect(out.status).toBe(502);
    expect(out.body).toContain("not allowed");
  });

  it("refuses a host that resolves to a private address", async () => {
    const out = await ask(FEED, {
      lookup: async () => [{ address: "10.0.0.7" }],
      fetchImpl: async () => reply(ICS),
    });
    expect(out.status).toBe(502);
    expect(out.body).toContain("public address");
  });

  it("passes on what the calendar server said", async () => {
    expect((await ask(FEED, { fetchImpl: async () => reply("", { status: 404 }) })).status).toBe(404);
    expect((await ask(FEED, { fetchImpl: async () => reply("", { status: 500 }) })).status).toBe(502);
  });

  it("will not return a page that is not a calendar", async () => {
    const out = await ask(FEED, { fetchImpl: async () => reply("<html>Sign in</html>") });
    expect(out.status).toBe(502);
    expect(out.body).toContain("did not return a calendar");
  });

  it("refuses something too large to be a calendar", async () => {
    const out = await ask(FEED, {
      maxBytes: 100,
      fetchImpl: async () => reply(ICS + "X".repeat(500)),
    });
    expect(out.status).toBe(502);
    expect(out.body).toContain("too large");
  });

  it("reports a feed that never answers as a timeout", async () => {
    const out = await ask(FEED, {
      timeoutMs: 5,
      fetchImpl: (_url, { signal }) =>
        new Promise((_res, reject) => {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    });
    expect(out.status).toBe(504);
  });

  it("rejects an address it should never fetch, before any request", async () => {
    const fetchImpl = async () => {
      throw new Error("should not have been called");
    };
    for (const feed of [
      "https://169.254.169.254/latest/meta-data/",
      "http://p1-calendars.icloud.com/x",
      "https://icloud.com.evil.test/x",
    ]) {
      expect((await ask(feed, { fetchImpl })).status).toBe(400);
    }
    expect((await run(req("/ics"), { fetchImpl })).status).toBe(400);
  });

  it("turns away an origin that is not on the list", async () => {
    const options = {
      allowedOrigins: "https://todo-app-qpd5.onrender.com",
      fetchImpl: async () => reply(ICS),
    };
    const blocked = await ask(FEED, options, { origin: "https://evil.test" });
    expect(blocked.status).toBe(403);

    const allowed = await ask(FEED, options, { origin: "https://todo-app-qpd5.onrender.com" });
    expect(allowed.status).toBe(200);
    expect(allowed.headers["Access-Control-Allow-Origin"]).toBe("https://todo-app-qpd5.onrender.com");
  });

  it("answers a preflight without fetching anything", async () => {
    const out = await run(req("/ics", { method: "OPTIONS" }), {
      fetchImpl: async () => {
        throw new Error("should not have been called");
      },
    });
    expect(out.status).toBe(204);
    expect(out.headers["Access-Control-Allow-Methods"]).toContain("GET");
  });

  it("rejects anything but GET, and any other path", async () => {
    expect((await run(req("/ics?url=x", { method: "POST" }))).status).toBe(405);
    expect((await run(req("/whatever"))).status).toBe(404);
  });

  it("stops one caller from making this somebody else's problem", async () => {
    const handler = createHandler({
      lookup: publicLookup,
      rateMax: 2,
      cacheSeconds: 0,
      fetchImpl: async () => reply(ICS),
    });
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const res = fakeRes();
      await handler(req(`/ics?url=${encodeURIComponent(FEED)}`), res);
      statuses.push(res.out.status);
    }
    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses.slice(2)).toEqual([429, 429]);
  });
});
