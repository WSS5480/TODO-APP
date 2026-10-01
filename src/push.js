// Real alarms: the ones that ring with the app closed.
//
// Everything the app does with timers stops the moment you leave it — iOS
// suspends the page, and there is no way around that from inside a web page.
// The only mechanism that survives is a push sent from a server, delivered by
// Apple, and shown by a service worker. So the app's job here is small and
// specific: subscribe once, then keep the server told about when things are
// due. The server is a clock with a list; it knows nothing about tasks.
//
// iOS adds one more condition that catches everyone out: push works only when
// the app has been added to the Home Screen. In a Safari tab the APIs exist
// and subscribing fails. That is what `needs-install` below is for.

import { isRepeating, nextOccurrence } from "./recur.js";

// How far ahead to tell the server about. Long enough that a phone left alone
// for a fortnight still rings; short enough that one upload stays small.
export const HORIZON_DAYS = 14;
export const MAX_ALARMS = 300;
// Per task, so one daily repeat cannot crowd out everything else.
export const MAX_PER_TASK = 30;

export const SUBSCRIPTION_KEY = "todo-reminder.push.v1";

/* ---------- what this device can do ---------- */

export function canPush(scope = globalThis) {
  return !!(
    scope.navigator &&
    "serviceWorker" in scope.navigator &&
    "PushManager" in scope &&
    "Notification" in scope
  );
}

// iOS only allows push from an installed app. Chrome and desktop Safari do not
// care, so this is a requirement only where the standalone check is available
// and false.
export function isStandalone(scope = globalThis) {
  const nav = scope.navigator;
  if (nav && typeof nav.standalone === "boolean") return nav.standalone;
  return !!scope.matchMedia?.("(display-mode: standalone)")?.matches;
}

export function isIOS(scope = globalThis) {
  const ua = scope.navigator?.userAgent || "";
  // iPadOS reports itself as a Mac, with a touch screen to give it away.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (scope.navigator?.maxTouchPoints || 0) > 1);
}

// One word for the settings panel to act on.
export function pushState(scope = globalThis, { subscribed = false } = {}) {
  if (!canPush(scope)) return "unsupported";
  if (isIOS(scope) && !isStandalone(scope)) return "needs-install";
  const permission = scope.Notification?.permission;
  if (permission === "denied") return "blocked";
  if (subscribed && permission === "granted") return "on";
  return "off";
}

export function describeState(state) {
  switch (state) {
    case "on":
      return "Alarms will ring even when the app is closed.";
    case "off":
      return "Turn these on and reminders ring with the app closed.";
    case "needs-install":
      return "Add this app to your Home Screen first — iOS only allows notifications from an installed app.";
    case "blocked":
      return "Notifications are blocked for this app in your settings.";
    default:
      return "This browser cannot deliver notifications when the app is closed.";
  }
}

/* ---------- talking to the service ---------- */

// The reader service's root, from the address that has "/ics" on the end.
export function serviceRoot(proxyUrl) {
  const base = String(proxyUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return base.replace(/\/ics$/i, "");
}

async function postJson(url, body, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* the body is optional */
    }
    const err = new Error(detail || `the service answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
}

// The VAPID public key, fetched rather than configured, so there is nothing to
// paste into the app when the Worker is deployed.
export async function fetchPublicKey(root, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${root}/push/key`);
  if (res.status === 404) {
    throw new Error("that reader service does not do notifications — deploy the Cloudflare Worker");
  }
  if (!res.ok) throw new Error(`the service answered ${res.status}`);
  const body = await res.json();
  if (!body.publicKey) throw new Error("the service did not return a key");
  return body.publicKey;
}

// A VAPID key travels as base64url text; subscribe() wants the raw bytes.
export function urlBase64ToUint8Array(value) {
  const s = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- turning a task list into a list of times ---------- */

// Expand the tasks into the individual moments something should ring.
//
// A repeating task contributes one entry per occurrence inside the horizon, so
// a daily 9am task still rings on day nine without the app ever being opened.
// Each id carries the occurrence's own timestamp rather than its position in
// the series: positions shift as occurrences are completed, and an id that
// shifts is an id that rings twice.
export function buildAlarms(items, prefs = {}, { now = Date.now(), horizonDays = HORIZON_DAYS, max = MAX_ALARMS } = {}) {
  const horizon = now + horizonDays * 24 * 3600_000;
  const leadMs = Math.max(0, Number(prefs.lead) || 0) * 60_000;
  const out = [];

  for (const item of items || []) {
    if (!item || item.done || !item.due) continue;

    const moments = [];
    let due = item.due;
    let repeat = item.repeat;

    for (let i = 0; i < MAX_PER_TASK; i++) {
      if (due > horizon) break;
      if (due > now) moments.push(due);
      if (!isRepeating(repeat)) break;
      const next = nextOccurrence(due, repeat, due);
      if (!next) break;
      due = next.due;
      repeat = next.repeat;
    }

    for (const at of moments) {
      out.push({ id: `${item.id}@${at}:due`, title: item.title, kind: "due", at });
      if (leadMs > 0 && at - leadMs > now) {
        out.push({ id: `${item.id}@${at}:soon`, title: item.title, kind: "soon", at: at - leadMs });
      }
    }
  }

  // Soonest first, so the cap keeps what matters next rather than an arbitrary
  // slice of a long repeating series.
  out.sort((a, b) => a.at - b.at);
  return out.slice(0, max);
}

/* ---------- the three things the app actually calls ---------- */

export async function registerWorker(scope = globalThis) {
  if (!canPush(scope)) throw new Error("this browser cannot do notifications");
  return scope.navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function currentSubscription(scope = globalThis) {
  if (!canPush(scope)) return null;
  const reg = await scope.navigator.serviceWorker.getRegistration("/");
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

// Must be called from a user gesture: iOS refuses a permission prompt raised
// any other way, and fails in a way that looks like the user said no.
export async function enablePush({ root, items = [], prefs = {}, scope = globalThis, fetchImpl = globalThis.fetch, now = Date.now() }) {
  if (!canPush(scope)) throw new Error("this browser cannot do notifications");
  if (!root) throw new Error("no reader service is configured");

  const permission = await scope.Notification.requestPermission();
  if (permission !== "granted") throw new Error("notifications were not allowed");

  const publicKey = await fetchPublicKey(root, fetchImpl);
  const registration = await registerWorker(scope);
  await scope.navigator.serviceWorker.ready;

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ||
    (await registration.pushManager.subscribe({
      // iOS requires every push to show something; promising that up front is
      // what makes subscribing legal.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = subscription.toJSON ? subscription.toJSON() : subscription;
  await postJson(
    `${root}/push/subscribe`,
    {
      subscription: json,
      label: deviceLabel(scope),
      alarms: buildAlarms(items, prefs, { now }),
    },
    fetchImpl,
  );

  return json;
}

export async function disablePush({ root, scope = globalThis, fetchImpl = globalThis.fetch }) {
  const subscription = await currentSubscription(scope);
  const endpoint = subscription?.endpoint;

  // Unsubscribe locally first: even if the service cannot be reached, the
  // phone should stop receiving. The server drops the row on its next failure.
  if (subscription) await subscription.unsubscribe().catch(() => {});
  if (root && endpoint) {
    await postJson(`${root}/push/unsubscribe`, { endpoint }, fetchImpl).catch(() => {});
  }
}

// Keep the server's copy of the schedule current. Cheap and idempotent, so the
// app calls it whenever anything changes rather than trying to be clever.
export async function syncAlarms({ root, items, prefs, scope = globalThis, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const subscription = await currentSubscription(scope);
  if (!subscription || !root) return { skipped: true };
  return postJson(
    `${root}/push/alarms`,
    { endpoint: subscription.endpoint, alarms: buildAlarms(items, prefs, { now }) },
    fetchImpl,
  );
}

export async function sendTestPush({ root, scope = globalThis, fetchImpl = globalThis.fetch }) {
  const subscription = await currentSubscription(scope);
  if (!subscription) throw new Error("notifications are not turned on for this device");
  return postJson(`${root}/push/test`, { endpoint: subscription.endpoint }, fetchImpl);
}

function deviceLabel(scope) {
  const ua = scope.navigator?.userAgent || "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "This device";
}
