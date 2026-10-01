// The calendar proxy, as a Cloudflare Worker.
//
// Same job as server.mjs and the same rules from validate.mjs — fetch a
// published calendar and return it with permission for the app to read it. The
// difference is where it runs: a Worker on the free plan does not sleep, so the
// first pull of the day is as quick as the rest, and there is nothing to pay.
//
// Deploy with:  npx wrangler deploy        (from this folder)
// Try locally:  npx wrangler dev
//
// There is no DNS check here, unlike the Node version. A Worker has no DNS API,
// and it has no route into a private network to be tricked into taking — the
// metadata-service problem that check exists for does not apply. The host
// allowlist and the per-redirect re-check still do all their work.

import {
  ALLOWED_HOSTS,
  normalizeTarget,
  originAllowed,
  MAX_BYTES,
  MAX_REDIRECTS,
  FETCH_TIMEOUT_MS,
} from "./validate.mjs";
import { handlePushRequest, runScheduler } from "./pushroutes.mjs";

const CACHE_SECONDS = 300;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allow = originAllowed(origin, env?.ALLOWED_ORIGINS || "*");
    const cors = {
      ...(allow ? { "Access-Control-Allow-Origin": allow } : {}),
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    };
    const text = (status, body, type = "text/plain; charset=utf-8") =>
      new Response(body, { status, headers: { ...cors, "Content-Type": type, "Cache-Control": "no-store" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === "/healthz" || url.pathname === "/") {
      return text(
        200,
        JSON.stringify({
          ok: true,
          service: "todo-cal-proxy",
          runtime: "worker",
          push: !!(env?.DB && env?.VAPID_PUBLIC_KEY),
        }),
        "application/json",
      );
    }

    if (url.pathname.startsWith("/push/")) {
      const json = (status, value) => text(status, JSON.stringify(value), "application/json");
      if (origin && !allow) return text(403, "this origin is not allowed to use this service");
      return handlePushRequest(url.pathname, request, env, { reply: text, json });
    }

    if (url.pathname !== "/ics") return text(404, "not found");
    if (request.method !== "GET") return text(405, "GET only");
    if (origin && !allow) return text(403, "this origin is not allowed to use this proxy");

    const hosts = [
      ...ALLOWED_HOSTS,
      ...String(env?.EXTRA_HOSTS || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ];

    const checked = normalizeTarget(url.searchParams.get("url"), hosts);
    if (!checked.ok) return text(400, checked.error);

    // Cloudflare's own cache does what the Map in the Node version does, and
    // does it across every instance of the Worker.
    const cacheKey = new Request(`https://cache.invalid/ics?u=${encodeURIComponent(checked.url)}`);
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const out = new Response(cached.body, cached);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      out.headers.set("X-Proxy-Cache", "hit");
      return out;
    }

    let body;
    try {
      body = await readCalendar(checked.url, hosts);
    } catch (err) {
      const status = err?.status ? err.status : err?.name === "AbortError" ? 504 : 502;
      return text(status, err?.message || "could not read that calendar");
    }

    const res = new Response(body, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
        "X-Proxy-Cache": "miss",
      },
    });
    // Cache a copy without waiting for it to be written.
    await caches.default.put(cacheKey, res.clone());
    return res;
  },

  // The cron trigger in wrangler.toml, once a minute. This is the whole reason
  // alarms can fire with the app closed: nothing on the phone is running, so
  // something else has to be watching the clock.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduler(env));
  },
};

// Follow redirects by hand so each hop is checked against the same rules: a
// permitted host that redirects elsewhere must not become a way around them.
async function readCalendar(target, hosts) {
  let next = target;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = normalizeTarget(next, hosts);
    if (!checked.ok) throw new Error(`redirected somewhere not allowed: ${checked.error}`);

    const res = await fetch(checked.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "text/calendar, text/plain, */*", "User-Agent": "todo-cal-proxy/1" },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("the calendar server redirected to nowhere");
      next = new URL(location, checked.url).toString();
      continue;
    }

    if (!res.ok) {
      const err = new Error(`the calendar server answered ${res.status}`);
      err.status = res.status === 404 ? 404 : 502;
      throw err;
    }

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      throw new Error("that calendar is too large");
    }

    const body = await res.text();
    if (body.length > MAX_BYTES) throw new Error("that calendar is too large");
    if (!/BEGIN:VCALENDAR/i.test(body)) throw new Error("that address did not return a calendar");
    return body;
  }

  throw new Error("too many redirects");
}
