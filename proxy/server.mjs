// The calendar proxy.
//
// iCloud publishes a calendar as a public .ics file and sends no CORS headers
// with it, so a browser will fetch it and then refuse to let the page read a
// single byte. Nothing in the app can change that: the header has to come from
// the server, and the server belongs to Apple.
//
// This is the smallest thing that fixes it — one endpoint that fetches a
// published calendar and returns it with permission to read it. It stores
// nothing, holds no credentials and has no database. What it does have is a
// list of hosts it will talk to, because an unrestricted version of this would
// be an open proxy sitting inside a hosting provider's network (see
// validate.mjs for what that would be worth to someone).
//
//   GET /ics?url=webcal://p1-calendars.icloud.com/published/2/...
//   GET /healthz
//
// Run it with: node proxy/server.mjs

import http from "node:http";
import { promises as dns } from "node:dns";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_HOSTS,
  normalizeTarget,
  resolvesPublicly,
  originAllowed,
  MAX_BYTES,
  MAX_REDIRECTS,
  FETCH_TIMEOUT_MS,
} from "./validate.mjs";

const RATE_WINDOW_MS = 60_000;

// Everything the request handler depends on arrives through here, so the tests
// can hand it a calendar without a network and a clock without waiting.
export function createHandler({
  fetchImpl = globalThis.fetch,
  lookup = dns.lookup,
  hosts = ALLOWED_HOSTS,
  allowedOrigins = "*",
  // A calendar does not change by the second, and a cached answer is what stops
  // several devices pulling at once from hammering iCloud.
  cacheSeconds = 300,
  rateMax = 30,
  maxBytes = MAX_BYTES,
  timeoutMs = FETCH_TIMEOUT_MS,
  now = () => Date.now(),
  log = console.warn,
} = {}) {
  const cache = new Map(); // url -> { at, body }
  const hits = new Map(); // ip -> recent timestamps

  function rateLimited(ip) {
    const t = now();
    const recent = (hits.get(ip) || []).filter((x) => t - x < RATE_WINDOW_MS);
    recent.push(t);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear(); // a crude bound on memory, never reached in practice
    return recent.length > rateMax;
  }

  // Fetch the calendar, re-checking every redirect against the same rules: a
  // permitted host that redirects elsewhere must not become a way around them.
  async function readCalendar(target) {
    let url = target;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const checked = normalizeTarget(url, hosts);
      if (!checked.ok) throw new Error(`redirected somewhere not allowed: ${checked.error}`);
      if (!(await resolvesPublicly(checked.hostname, lookup))) {
        throw new Error("that host does not resolve to a public address");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(checked.url, {
          redirect: "manual", // each hop is checked rather than followed blindly
          signal: controller.signal,
          headers: { Accept: "text/calendar, text/plain, */*", "User-Agent": "todo-cal-proxy/1" },
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        if (!next) throw new Error("the calendar server redirected to nowhere");
        url = new URL(next, checked.url).toString();
        continue;
      }

      if (!res.ok) {
        const err = new Error(`the calendar server answered ${res.status}`);
        err.status = res.status === 404 ? 404 : 502;
        throw err;
      }

      const body = await readCapped(res, maxBytes);
      if (!/BEGIN:VCALENDAR/i.test(body)) {
        throw new Error("that address did not return a calendar");
      }
      return body;
    }

    throw new Error("too many redirects");
  }

  return async function handle(req, res) {
    const origin = req.headers.origin;
    let path = "/";
    let params = new URLSearchParams();
    try {
      const parsed = new URL(req.url, "http://localhost");
      path = parsed.pathname;
      params = parsed.searchParams;
    } catch {
      /* falls through to the 404 below */
    }

    const allow = originAllowed(origin, allowedOrigins);
    const corsHeaders = {
      ...(allow ? { "Access-Control-Allow-Origin": allow } : {}),
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    };

    const send = (status, body, type = "text/plain; charset=utf-8") => {
      res.writeHead(status, { ...corsHeaders, "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (path === "/healthz" || path === "/") {
      send(200, JSON.stringify({ ok: true, service: "todo-cal-proxy" }), "application/json");
      return;
    }

    if (path !== "/ics") return send(404, "not found");
    if (req.method !== "GET") return send(405, "GET only");

    if (origin && !allow) {
      // No CORS header was set, so the browser would reject the body anyway;
      // saying so plainly is more use than a silent failure in the console.
      return send(403, "this origin is not allowed to use this proxy");
    }

    const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
      .split(",")[0]
      .trim();
    if (rateLimited(ip)) {
      res.setHeader("Retry-After", "60");
      return send(429, "too many requests — try again in a minute");
    }

    const checked = normalizeTarget(params.get("url"), hosts);
    if (!checked.ok) return send(400, checked.error);

    const serve = (body, cacheState) => {
      res.writeHead(200, {
        ...corsHeaders,
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": `public, max-age=${cacheSeconds}`,
        "X-Proxy-Cache": cacheState,
      });
      res.end(body);
    };

    const hit = cache.get(checked.url);
    if (hit && now() - hit.at < cacheSeconds * 1000) return serve(hit.body, "hit");

    try {
      const body = await readCalendar(checked.url);
      cache.set(checked.url, { at: now(), body });
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      serve(body, "miss");
    } catch (err) {
      const status = err?.status ? err.status : err?.name === "AbortError" ? 504 : 502;
      log(`ics failed: ${checked.hostname} — ${err?.message || err}`);
      send(status, err?.message || "could not read that calendar");
    }
  };
}

// Read with a ceiling: a published calendar is small, and the proxy should not
// be talked into buffering something that is not one.
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("that calendar is too large");
  }

  // A real response streams; a stub may just hand over text.
  if (!res.body || typeof res.body[Symbol.asyncIterator] !== "function") {
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error("that calendar is too large");
    return text;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("that calendar is too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createServer(options) {
  return http.createServer(createHandler(options));
}

// Only listen when started directly, so importing this for a test does not
// open a port.
const startedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (startedDirectly) {
  const port = Number(process.env.PORT) || 10_000;
  const allowedOrigins = process.env.ALLOWED_ORIGINS || "*";
  // Another calendar provider can be added without touching the code.
  const extra = String(process.env.EXTRA_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  createServer({
    allowedOrigins,
    hosts: [...ALLOWED_HOSTS, ...extra],
    cacheSeconds: Number(process.env.CACHE_SECONDS) || 300,
    rateMax: Number(process.env.RATE_MAX) || 30,
  }).listen(port, () => {
    console.log(`todo-cal-proxy listening on ${port}; origins: ${allowedOrigins}`);
  });
}
