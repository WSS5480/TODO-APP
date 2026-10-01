// Pulling a calendar over the network.
//
// A published iCloud calendar is a plain .ics file at a webcal:// address. Two
// things stand between this app and it:
//
//   * webcal:// is not a scheme fetch() understands. It is http(s) underneath,
//     so swapping the scheme is all it takes.
//   * iCloud sends no CORS headers, so the browser refuses to let a page read
//     the response even though the file is public. Nothing the page can do
//     fixes that — it has to be read by something that is not a browser.
//
// Hence the proxy: a few lines of server whose only job is to fetch the .ics
// and hand it back with permission to read it. The direct fetch is still tried
// first, because some calendar hosts do send the header and then no proxy is
// needed at all.

import { tasksFromIcs } from "./icsparse.js";

export const DEFAULT_TIMEOUT_MS = 20_000;

// What a one-off "bring in everything" will take. Far above the routine pull's
// ceiling, and still a stop so a shared calendar with a decade of history
// cannot wedge the app.
export const MAX_HISTORY_EVENTS = 5000;

// The companion service that reads the feed on the app's behalf. It holds no
// data and no credentials — it fetches a public .ics and returns it — so the
// app can ship knowing where it is. On a free plan it sleeps when idle, which
// is why the first pull of the day can take a few seconds longer.
export const DEFAULT_PROXY = "https://todo-cal-proxy.onrender.com/ics";

// webcal://p1-calendars.icloud.com/... -> https://p1-calendars.icloud.com/...
export function normalizeFeedUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (/^webcals?:\/\//i.test(raw)) return raw.replace(/^webcals?:/i, "https:");
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[\w.-]+\.[a-z]{2,}\//i.test(raw)) return `https://${raw}`;
  return "";
}

// Looks like an iCloud published calendar, which is what the help text in the
// app talks the user through producing.
export function isICloudFeed(url) {
  return /(^|\.)icloud\.com$/i.test(hostOf(url));
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// Where to actually send the request. The proxy takes the feed as a query
// parameter so it never has to parse a path.
export function proxiedUrl(proxyBase, feedUrl) {
  const base = String(proxyBase || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return `${base}?url=${encodeURIComponent(feedUrl)}`;
}

function looksLikeCalendar(text) {
  return typeof text === "string" && /BEGIN:VCALENDAR/i.test(text);
}

async function getText(url, { fetchImpl, timeoutMs }) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      signal: controller ? controller.signal : undefined,
      // a published calendar is public; sending credentials only invites a 401
      credentials: "omit",
      redirect: "follow",
    });
    if (!res || !res.ok) {
      throw new Error(`the calendar server answered ${res ? res.status : "nothing"}`);
    }
    return await res.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Fetch the feed and return task drafts.
//
// Resolves to { ok, tasks, found, calendarName, via, error }. `via` says which
// route worked, which is what the settings panel reports back to the user: a
// direct pull means the proxy is not needed for this calendar.
export async function fetchCalendar(
  feedUrl,
  {
    proxy = "",
    now = Date.now(),
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    max,
    includePast = false,
  } = {},
) {
  const url = normalizeFeedUrl(feedUrl);
  if (!url) return fail("That does not look like a calendar address.");
  if (typeof fetchImpl !== "function") return fail("This browser cannot fetch the calendar.");

  const attempts = [["direct", url]];
  const viaProxy = proxiedUrl(proxy, url);
  if (viaProxy) attempts.push(["proxy", viaProxy]);

  let lastError = "";

  for (const [via, target] of attempts) {
    try {
      const text = await getText(target, { fetchImpl, timeoutMs });
      if (!looksLikeCalendar(text)) {
        lastError = "That address returned something that is not a calendar.";
        continue;
      }
      const { tasks, calendarName, found } = tasksFromIcs(text, { now, max, includePast });
      return { ok: true, tasks, found, calendarName, via, error: "" };
    } catch (err) {
      lastError = describeError(err, via);
    }
  }

  return fail(lastError || "The calendar could not be read.");
}

function describeError(err, via) {
  const name = err && err.name;
  if (name === "AbortError") return "The calendar took too long to answer.";
  if (via === "direct") {
    // The browser blocks a cross-origin read without telling the page why, so
    // this is a guess — but it is the right guess nearly every time.
    return "The calendar would not let this page read it directly.";
  }
  return (err && err.message) || "The calendar could not be read.";
}

function fail(error) {
  return { ok: false, tasks: [], found: 0, calendarName: "", via: "", error };
}
