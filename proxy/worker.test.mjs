import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "./worker.mjs";

const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
const FEED = "https://p1-calendars.icloud.com/published/2/abc";

const ask = (feed = FEED, { env = {}, headers = {} } = {}) =>
  worker.fetch(
    new Request(`https://proxy.test/ics?url=${encodeURIComponent(feed)}`, { headers }),
    env,
  );

// The Worker runtime's cache API, enough of it to run the handler. Vitest runs
// this under Node, which has no caches.default of its own.
function installCache() {
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(req) {
        const hit = store.get(req.url);
        return hit ? hit.clone() : undefined;
      },
      async put(req, res) {
        store.set(req.url, res.clone());
      },
    },
  };
  return store;
}

beforeEach(() => {
  installCache();
  vi.restoreAllMocks();
});

const stub = (impl) => vi.spyOn(globalThis, "fetch").mockImplementation(impl);

describe("the proxy worker", () => {
  it("answers a health check", async () => {
    const res = await worker.fetch(new Request("https://proxy.test/healthz"), {});
    expect(res.status).toBe(200);
    expect((await res.json()).runtime).toBe("worker");
  });

  it("fetches the calendar and makes it readable by the page", async () => {
    const calls = [];
    stub(async (url) => {
      calls.push(String(url));
      return new Response(ICS, { status: 200 });
    });

    const res = await ask("webcal://p1-calendars.icloud.com/published/2/abc");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ICS);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-proxy-cache")).toBe("miss");
    expect(calls).toEqual([FEED]); // webcal rewritten to https
  });

  it("serves a second request from the edge cache", async () => {
    let fetched = 0;
    stub(async () => {
      fetched += 1;
      return new Response(ICS, { status: 200 });
    });

    await ask();
    const second = await ask();
    expect(fetched).toBe(1);
    expect(second.headers.get("x-proxy-cache")).toBe("hit");
    expect(await second.text()).toBe(ICS);
    expect(second.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("follows a redirect that stays on an allowed host", async () => {
    let n = 0;
    stub(async () => {
      n += 1;
      return n === 1
        ? new Response("", { status: 302, headers: { location: "https://p2-calendars.icloud.com/x" } })
        : new Response(ICS, { status: 200 });
    });
    expect((await ask()).status).toBe(200);
    expect(n).toBe(2);
  });

  it("refuses a redirect that leaves the allowed hosts", async () => {
    stub(async () =>
      new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    );
    const res = await ask();
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("not allowed");
  });

  it("will not return a page that is not a calendar", async () => {
    stub(async () => new Response("<html>Sign in</html>", { status: 200 }));
    const res = await ask();
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("did not return a calendar");
  });

  it("passes on what the calendar server said", async () => {
    stub(async () => new Response("", { status: 404 }));
    expect((await ask()).status).toBe(404);
    stub(async () => new Response("", { status: 503 }));
    expect((await ask()).status).toBe(502);
  });

  it("rejects an address it should never fetch, without a request", async () => {
    const f = stub(async () => {
      throw new Error("should not have been called");
    });
    for (const feed of [
      "https://169.254.169.254/latest/meta-data/",
      "http://p1-calendars.icloud.com/x",
      "https://icloud.com.evil.test/x",
      "not a url",
    ]) {
      expect((await ask(feed)).status, feed).toBe(400);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("can be opened up to another calendar host by configuration", async () => {
    stub(async () => new Response(ICS, { status: 200 }));
    expect((await ask("https://cal.example.test/x")).status).toBe(400);
    expect(
      (await ask("https://cal.example.test/x", { env: { EXTRA_HOSTS: "example.test" } })).status,
    ).toBe(200);
  });

  it("turns away an origin that is not on the list", async () => {
    stub(async () => new Response(ICS, { status: 200 }));
    const env = { ALLOWED_ORIGINS: "https://todo-app-qpd5.onrender.com" };

    const blocked = await ask(FEED, { env, headers: { Origin: "https://evil.test" } });
    expect(blocked.status).toBe(403);

    const allowed = await ask(FEED, {
      env,
      headers: { Origin: "https://todo-app-qpd5.onrender.com" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://todo-app-qpd5.onrender.com",
    );
  });

  it("answers a preflight and refuses other methods and paths", async () => {
    const pre = await worker.fetch(new Request("https://proxy.test/ics", { method: "OPTIONS" }), {});
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("GET");

    const post = await worker.fetch(
      new Request("https://proxy.test/ics?url=x", { method: "POST" }),
      {},
    );
    expect(post.status).toBe(405);
    expect((await worker.fetch(new Request("https://proxy.test/nope"), {})).status).toBe(404);
  });
});
