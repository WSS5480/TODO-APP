// The scheduler's storage, and the decisions that go with it.
//
// Separated from the Worker's request handling so it can be tested against a
// real SQL engine rather than a mock that agrees with whatever it is told.

export const MAX_ALARMS_PER_DEVICE = 300;

// How late an alarm may be and still ring. The scheduler runs every minute, so
// this only matters if it was held up — and a reminder that arrives three
// hours late is worse than none: it rings about something already passed, when
// the person has no idea why their phone is buzzing.
export const LATE_GRACE_MS = 10 * 60_000;

// A ceiling per run. The binding constraint is not the request budget but CPU:
// a Worker on the free plan gets 10 ms of it per invocation, and each message
// costs a key agreement, three key derivations and an AES-GCM seal. Waiting on
// the network does not count, so the real limit is how much crypto fits.
//
// Ten is comfortably inside that with the VAPID signature computed once per
// run, and anything left over simply goes out on the next tick a minute later.
export const MAX_SENDS_PER_RUN = 10;

export async function saveSubscription(db, { endpoint, p256dh, auth, label }, now = Date.now()) {
  await db
    .prepare(
      `INSERT INTO subscriptions (endpoint, p256dh, auth, label, created_at, seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth   = excluded.auth,
         label  = excluded.label,
         seen_at = excluded.seen_at`,
    )
    .bind(endpoint, p256dh, auth, label || null, now, now)
    .run();
}

export async function getSubscription(db, endpoint) {
  return db.prepare(`SELECT * FROM subscriptions WHERE endpoint = ?`).bind(endpoint).first();
}

export async function deleteSubscription(db, endpoint) {
  await db.prepare(`DELETE FROM alarms WHERE endpoint = ?`).bind(endpoint).run();
  await db.prepare(`DELETE FROM subscriptions WHERE endpoint = ?`).bind(endpoint).run();
}

// Replace this device's whole schedule.
//
// Wholesale replacement rather than a diff: the app knows the truth, the server
// is only a timer, and a task deleted on the phone has to stop ringing. The one
// thing carried across is which alarms have already gone out, so re-uploading
// an unchanged schedule cannot make a phone buzz twice for the same thing.
export async function replaceAlarms(db, endpoint, alarms, now = Date.now()) {
  const sentIds = new Set();
  const { results } = await db
    .prepare(`SELECT id FROM alarms WHERE endpoint = ? AND sent_at IS NOT NULL`)
    .bind(endpoint)
    .all();
  for (const row of results || []) sentIds.add(row.id);

  const fresh = [];
  const seen = new Set();
  for (const alarm of alarms || []) {
    const id = String(alarm?.id || "").slice(0, 120);
    const at = Number(alarm?.at);
    if (!id || seen.has(id) || !Number.isFinite(at)) continue;
    if (at <= now) continue; // nothing to schedule in the past
    seen.add(id);
    fresh.push({
      id,
      title: String(alarm.title || "Task").slice(0, 200),
      kind: alarm.kind === "soon" ? "soon" : "due",
      at: Math.round(at),
      sent_at: sentIds.has(id) ? now : null,
    });
    if (fresh.length >= MAX_ALARMS_PER_DEVICE) break;
  }

  const statements = [db.prepare(`DELETE FROM alarms WHERE endpoint = ?`).bind(endpoint)];
  for (const a of fresh) {
    statements.push(
      db
        .prepare(`INSERT INTO alarms (endpoint, id, title, kind, at, sent_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(endpoint, a.id, a.title, a.kind, a.at, a.sent_at),
    );
  }
  await db.batch(statements);

  return { stored: fresh.length, skipped: (alarms || []).length - fresh.length };
}

// What is owed right now, with the subscription needed to deliver it.
export async function dueAlarms(db, now = Date.now(), limit = MAX_SENDS_PER_RUN) {
  const { results } = await db
    .prepare(
      `SELECT a.endpoint, a.id, a.title, a.kind, a.at,
              s.p256dh, s.auth
         FROM alarms a
         JOIN subscriptions s ON s.endpoint = a.endpoint
        WHERE a.sent_at IS NULL AND a.at <= ?
        ORDER BY a.at ASC
        LIMIT ?`,
    )
    .bind(now, limit)
    .all();
  return results || [];
}

export async function markSent(db, rows, now = Date.now()) {
  if (!rows.length) return;
  await db.batch(
    rows.map((r) =>
      db
        .prepare(`UPDATE alarms SET sent_at = ? WHERE endpoint = ? AND id = ?`)
        .bind(now, r.endpoint, r.id),
    ),
  );
}

// Alarms whose moment passed long enough ago that ringing now would confuse
// more than it helps. They are marked sent so they stop being considered.
export async function expireStale(db, now = Date.now(), grace = LATE_GRACE_MS) {
  const cutoff = now - grace;
  const { meta } = await db
    .prepare(`UPDATE alarms SET sent_at = ? WHERE sent_at IS NULL AND at < ?`)
    .bind(now, cutoff)
    .run();
  return meta?.changes ?? 0;
}

// Tidy up devices that stopped checking in months ago, so the table does not
// grow forever on a free plan.
export async function forgetAbandoned(db, now = Date.now(), maxAgeMs = 180 * 24 * 3600_000) {
  const cutoff = now - maxAgeMs;
  const { results } = await db
    .prepare(`SELECT endpoint FROM subscriptions WHERE seen_at < ?`)
    .bind(cutoff)
    .all();
  for (const row of results || []) await deleteSubscription(db, row.endpoint);
  return (results || []).length;
}

// What the notification says. Kept here rather than in the Worker so the
// wording is testable and the service worker has one shape to render.
export function notificationFor(row) {
  const soon = row.kind === "soon";
  return {
    title: soon ? "Coming up" : "Due now",
    body: row.title,
    tag: `${row.id}`,
    kind: row.kind,
    at: row.at,
    // A heads-up can be dismissed by the next one; a task that is actually due
    // should stay on screen until it is dealt with.
    requireInteraction: !soon,
  };
}
