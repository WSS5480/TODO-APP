// The push half of the Worker: what the app talks to, and what the clock runs.
//
// The app knows which tasks are due and when. The Worker knows nothing about
// tasks — it holds a list of times and titles per device and a subscription to
// deliver to, and once a minute it posts whatever has come due. That split is
// deliberate: all the logic about recurrence, snoozing and completion stays in
// the app where it is tested, and the server stays a timer that can be wiped
// and rebuilt from the next upload.

import { audienceOf, importVapidKeys, sendPush, vapidHeader } from "./push.mjs";
import {
  saveSubscription,
  getSubscription,
  deleteSubscription,
  replaceAlarms,
  dueAlarms,
  markSent,
  expireStale,
  notificationFor,
  MAX_SENDS_PER_RUN,
} from "./pushstore.mjs";

// A push endpoint belongs to one of the browser vendors' services. Restricting
// it keeps this from becoming a way to make the Worker POST to anywhere at all,
// for the same reason the calendar side has a host list.
export const PUSH_HOSTS = [
  "push.apple.com",
  "googleapis.com",
  "notify.windows.com",
  "push.services.mozilla.com",
  "push.microsoft.com",
];

export function isPushEndpoint(endpoint, hosts = PUSH_HOSTS) {
  let url;
  try {
    url = new URL(String(endpoint));
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function configured(env) {
  if (!env?.DB) return "the push database is not bound to this Worker";
  if (!env?.VAPID_PUBLIC_KEY || !env?.VAPID_PRIVATE_KEY) return "the VAPID keys are not set";
  return "";
}

async function keysFrom(env) {
  return importVapidKeys({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY });
}

function subjectFrom(env) {
  // RFC 8292 wants a contact the push service can use if something goes wrong.
  return env?.VAPID_SUBJECT || "mailto:nobody@example.com";
}

async function readJson(request, limit = 64 * 1024) {
  const text = await request.text();
  if (text.length > limit) throw new Error("that is more than this expects");
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Error("expected JSON");
  }
}

// Accepts both shapes a browser hands out: the PushSubscription's own JSON
// ({endpoint, keys:{p256dh, auth}}) and a flattened version.
function readSubscription(body) {
  const raw = body?.subscription || body || {};
  const endpoint = raw.endpoint;
  const p256dh = raw.keys?.p256dh || raw.p256dh;
  const auth = raw.keys?.auth || raw.auth;
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint: String(endpoint), p256dh: String(p256dh), auth: String(auth) };
}

/* ---------- requests ---------- */

// `reply` and `json` come from the Worker so CORS headers stay in one place.
export async function handlePushRequest(path, request, env, { reply, json }) {
  const problem = configured(env);

  if (path === "/push/key") {
    if (request.method !== "GET") return reply(405, "GET only");
    if (problem) return reply(503, problem);
    // The public key is meant to be public: the app needs it to subscribe.
    return json(200, { publicKey: env.VAPID_PUBLIC_KEY });
  }

  if (request.method !== "POST") return reply(405, "POST only");
  if (problem) return reply(503, problem);

  let body;
  try {
    body = await readJson(request);
  } catch (err) {
    return reply(400, err.message);
  }

  if (path === "/push/subscribe") {
    const sub = readSubscription(body);
    if (!sub) return reply(400, "that is not a push subscription");
    if (!isPushEndpoint(sub.endpoint)) return reply(400, "that endpoint is not a push service");

    await saveSubscription(env.DB, { ...sub, label: body.label }, Date.now());
    if (Array.isArray(body.alarms)) {
      await replaceAlarms(env.DB, sub.endpoint, body.alarms);
    }
    return json(200, { ok: true });
  }

  if (path === "/push/alarms") {
    const endpoint = String(body.endpoint || "");
    if (!isPushEndpoint(endpoint)) return reply(400, "that endpoint is not a push service");
    // Only for a device that has actually subscribed — otherwise this would be
    // a way to store arbitrary text keyed on a URL someone made up.
    if (!(await getSubscription(env.DB, endpoint))) return reply(404, "that device is not subscribed");

    const res = await replaceAlarms(env.DB, endpoint, body.alarms);
    await env.DB.prepare(`UPDATE subscriptions SET seen_at = ? WHERE endpoint = ?`)
      .bind(Date.now(), endpoint)
      .run();
    return json(200, { ok: true, ...res });
  }

  if (path === "/push/unsubscribe") {
    const endpoint = String(body.endpoint || "");
    if (!endpoint) return reply(400, "no endpoint given");
    await deleteSubscription(env.DB, endpoint);
    return json(200, { ok: true });
  }

  // Proves the whole chain in one tap, which is the only way to find out
  // whether notifications really work without waiting for a task to come due.
  if (path === "/push/test") {
    const endpoint = String(body.endpoint || "");
    const row = await getSubscription(env.DB, endpoint);
    if (!row) return reply(404, "that device is not subscribed");

    const keys = await keysFrom(env);
    const payload = JSON.stringify({
      title: "Notifications are working",
      body: "This is what a reminder will look like.",
      tag: "push-test",
      kind: "test",
      requireInteraction: false,
    });
    const res = await sendPush(row, payload, keys, { subject: subjectFrom(env) });

    if (res.gone) {
      await deleteSubscription(env.DB, endpoint);
      return reply(410, "this device's subscription has expired — turn notifications on again");
    }
    if (!res.ok) return reply(502, res.error || "the push service would not take it");
    return json(200, { ok: true });
  }

  return reply(404, "not found");
}

/* ---------- the clock ---------- */

// One tick. Returns a small summary, which is what shows up in the Worker's
// log and is the only way to see that it is doing anything.
export async function runScheduler(env, { now = Date.now(), log = console.log } = {}) {
  const problem = configured(env);
  if (problem) {
    log(`push scheduler idle: ${problem}`);
    return { sent: 0, failed: 0, dropped: 0, expired: 0 };
  }

  // Anything too late to be worth ringing is retired before we look at what to
  // send, so a backlog cannot buzz about this morning at four in the afternoon.
  const expired = await expireStale(env.DB, now);

  const rows = await dueAlarms(env.DB, now, MAX_SENDS_PER_RUN);
  if (!rows.length) {
    if (expired) log(`push scheduler: nothing due, ${expired} too late to ring`);
    return { sent: 0, failed: 0, dropped: 0, expired };
  }

  const keys = await keysFrom(env);
  const subject = subjectFrom(env);

  // One VAPID signature per push service rather than per message. Signing is
  // ECDSA, which costs CPU, and a Worker on the free plan has 10 ms of it per
  // run — with every alarm usually going to the same phone, this is most of
  // the budget saved for free.
  const headers = new Map();
  async function authorizationFor(endpoint) {
    const audience = audienceOf(endpoint);
    if (!headers.has(audience)) {
      headers.set(audience, await vapidHeader(endpoint, keys, { subject, now }));
    }
    return headers.get(audience);
  }

  const dead = new Set();
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    if (dead.has(row.endpoint)) continue; // that device is gone; skip its others
    const payload = JSON.stringify(notificationFor(row));
    const res = await sendPush(row, payload, keys, {
      subject,
      now,
      authorization: await authorizationFor(row.endpoint),
    });

    if (res.ok) {
      // Marked one at a time rather than in a batch at the end: if this run is
      // cut short for running out of CPU, what already went out stays sent.
      // Batching would lose that and ring the same alarms again next minute.
      await markSent(env.DB, [row], now);
      sent += 1;
    } else if (res.gone) {
      dead.add(row.endpoint);
    } else {
      failed += 1;
      // Left unsent on purpose: the next tick retries, and expireStale draws
      // the line so it cannot retry forever.
      log(`push failed (${res.status}): ${res.error}`);
    }
  }

  for (const endpoint of dead) await deleteSubscription(env.DB, endpoint);

  const summary = { sent, failed, dropped: dead.size, expired };
  log(`push scheduler: ${JSON.stringify(summary)}`);
  return summary;
}
