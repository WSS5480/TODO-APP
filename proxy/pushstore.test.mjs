import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Loaded through require so the bundler leaves it alone: node:sqlite is newer
// than Vite's list of built-in modules, and a static import fails to resolve.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

// The test runs from the repo root, but reading this file by import.meta.url
// does not work under the bundler, which serves modules over http.
const SCHEMA_PATH = ["proxy/schema.sql", "schema.sql"]
  .map((p) => resolve(process.cwd(), p))
  .find((p) => existsSync(p));
const SCHEMA = readFileSync(SCHEMA_PATH, "utf8");
import {
  saveSubscription,
  getSubscription,
  deleteSubscription,
  replaceAlarms,
  dueAlarms,
  markSent,
  expireStale,
  forgetAbandoned,
  notificationFor,
  MAX_ALARMS_PER_DEVICE,
  LATE_GRACE_MS,
} from "./pushstore.mjs";

// D1's interface over SQLite proper, so these tests exercise the real SQL —
// including the schema the Worker will actually run against — rather than a
// mock that agrees with whatever it is handed.
function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);

  const num = (v) => (typeof v === "bigint" ? Number(v) : v);
  const clean = (row) =>
    row === undefined ? null : Object.fromEntries(Object.entries(row).map(([k, v]) => [k, num(v)]));

  const makeStatement = (sql, params = []) => ({
    sql,
    params,
    bind: (...args) => makeStatement(sql, args),
    async run() {
      const r = sqlite.prepare(sql).run(...params);
      return { success: true, meta: { changes: num(r.changes) } };
    },
    async all() {
      return { success: true, results: sqlite.prepare(sql).all(...params).map(clean) };
    },
    async first() {
      return clean(sqlite.prepare(sql).get(...params));
    },
  });

  return {
    prepare: (sql) => makeStatement(sql),
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
}

const sub = (over = {}) => ({
  endpoint: "https://push.example.test/send/abc",
  p256dh: "BPublicKeyBytes",
  auth: "AuthSecret",
  label: "iPhone",
  ...over,
});

const now = Date.UTC(2026, 9, 1, 12, 0, 0);
const min = (n) => now + n * 60_000;

let db;
beforeEach(() => {
  db = fakeD1();
});

describe("subscriptions", () => {
  it("stores one and reads it back", async () => {
    await saveSubscription(db, sub(), now);
    const row = await getSubscription(db, sub().endpoint);
    expect(row).toMatchObject({ p256dh: "BPublicKeyBytes", auth: "AuthSecret", label: "iPhone" });
    expect(row.created_at).toBe(now);
  });

  it("updates the keys in place when a device re-subscribes", async () => {
    await saveSubscription(db, sub(), now);
    await saveSubscription(db, sub({ p256dh: "BRotatedKey", label: "Steve's iPhone" }), now + 1000);

    const row = await getSubscription(db, sub().endpoint);
    expect(row.p256dh).toBe("BRotatedKey");
    expect(row.label).toBe("Steve's iPhone");
    expect(row.created_at).toBe(now); // the original registration date survives
    expect(row.seen_at).toBe(now + 1000);
  });

  it("takes its alarms with it when deleted", async () => {
    await saveSubscription(db, sub(), now);
    await replaceAlarms(db, sub().endpoint, [{ id: "t1:due", title: "Call", at: min(5) }], now);
    await deleteSubscription(db, sub().endpoint);

    expect(await getSubscription(db, sub().endpoint)).toBeNull();
    expect(await dueAlarms(db, min(10))).toEqual([]);
  });
});

describe("replaceAlarms", () => {
  beforeEach(async () => {
    await saveSubscription(db, sub(), now);
  });

  it("stores what is still ahead and drops what is not", async () => {
    const res = await replaceAlarms(
      db,
      sub().endpoint,
      [
        { id: "t1:due", title: "Ahead", at: min(30) },
        { id: "t2:due", title: "Already passed", at: min(-30) },
        { id: "", title: "No id", at: min(10) },
        { id: "t3:due", title: "Not a time", at: "soon" },
      ],
      now,
    );
    expect(res.stored).toBe(1);
    expect(res.skipped).toBe(3);
  });

  it("replaces wholesale, so a deleted task stops ringing", async () => {
    await replaceAlarms(db, sub().endpoint, [
      { id: "t1:due", title: "Keep", at: min(10) },
      { id: "t2:due", title: "Delete me", at: min(20) },
    ], now);
    await replaceAlarms(db, sub().endpoint, [{ id: "t1:due", title: "Keep", at: min(10) }], now);

    const rows = await dueAlarms(db, min(60));
    expect(rows.map((r) => r.id)).toEqual(["t1:due"]);
  });

  it("remembers what already rang, so re-uploading cannot buzz twice", async () => {
    const alarms = [{ id: "t1:due", title: "Call the bank", at: min(10) }];
    await replaceAlarms(db, sub().endpoint, alarms, now);

    const [row] = await dueAlarms(db, min(11));
    await markSent(db, [row], min(11));
    expect(await dueAlarms(db, min(12))).toEqual([]);

    // the app uploads the same schedule again a minute later
    await replaceAlarms(db, sub().endpoint, [{ id: "t1:due", title: "Call the bank", at: min(20) }], min(12));
    expect(await dueAlarms(db, min(30))).toEqual([]);
  });

  it("lets a genuinely new alarm through after an earlier one rang", async () => {
    await replaceAlarms(db, sub().endpoint, [{ id: "t1:due", title: "First", at: min(10) }], now);
    const [row] = await dueAlarms(db, min(11));
    await markSent(db, [row], min(11));

    await replaceAlarms(db, sub().endpoint, [
      { id: "t1:due", title: "First", at: min(10) },
      { id: "t2:due", title: "Second", at: min(20) },
    ], min(12));

    const rows = await dueAlarms(db, min(25));
    expect(rows.map((r) => r.id)).toEqual(["t2:due"]);
  });

  it("keeps the newest of a duplicated id and caps the total", async () => {
    const many = Array.from({ length: MAX_ALARMS_PER_DEVICE + 40 }, (_, i) => ({
      id: `t${i}:due`,
      title: `Task ${i}`,
      at: min(5 + i),
    }));
    many.push({ id: "t0:due", title: "Duplicate", at: min(999) });

    const res = await replaceAlarms(db, sub().endpoint, many, now);
    expect(res.stored).toBe(MAX_ALARMS_PER_DEVICE);
    const rows = await dueAlarms(db, min(100000), 1000);
    expect(rows.length).toBe(MAX_ALARMS_PER_DEVICE);
  });

  it("trims a title that would not fit a notification anyway", async () => {
    await replaceAlarms(db, sub().endpoint, [{ id: "t1:due", title: "x".repeat(500), at: min(5) }], now);
    const [row] = await dueAlarms(db, min(6));
    expect(row.title.length).toBe(200);
  });

  it("treats an unknown kind as a real due alarm", async () => {
    await replaceAlarms(db, sub().endpoint, [
      { id: "a:due", title: "A", at: min(5), kind: "soon" },
      { id: "b:due", title: "B", at: min(6), kind: "nonsense" },
    ], now);
    const rows = await dueAlarms(db, min(10));
    expect(rows.map((r) => r.kind)).toEqual(["soon", "due"]);
  });

  it("copes with no alarms at all", async () => {
    await expect(replaceAlarms(db, sub().endpoint, null, now)).resolves.toMatchObject({ stored: 0 });
    await expect(replaceAlarms(db, sub().endpoint, [], now)).resolves.toMatchObject({ stored: 0 });
  });
});

describe("dueAlarms", () => {
  beforeEach(async () => {
    await saveSubscription(db, sub(), now);
  });

  it("returns only what is owed, with the keys needed to deliver it", async () => {
    await replaceAlarms(db, sub().endpoint, [
      { id: "t1:due", title: "Now", at: min(5) },
      { id: "t2:due", title: "Later", at: min(60) },
    ], now);

    const rows = await dueAlarms(db, min(6));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "t1:due", title: "Now", p256dh: "BPublicKeyBytes", auth: "AuthSecret" });
  });

  it("hands back the oldest first and respects the limit", async () => {
    await replaceAlarms(db, sub().endpoint, [
      { id: "c", title: "C", at: min(3) },
      { id: "a", title: "A", at: min(1) },
      { id: "b", title: "B", at: min(2) },
    ], now);

    expect((await dueAlarms(db, min(10))).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect((await dueAlarms(db, min(10), 2)).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("ignores an alarm whose device has gone", async () => {
    await replaceAlarms(db, sub().endpoint, [{ id: "t1", title: "Orphan", at: min(5) }], now);
    await db.prepare(`DELETE FROM subscriptions WHERE endpoint = ?`).bind(sub().endpoint).run();
    expect(await dueAlarms(db, min(10))).toEqual([]);
  });
});

describe("expireStale", () => {
  it("drops an alarm too late to be worth ringing, and keeps a merely late one", async () => {
    await saveSubscription(db, sub(), now);
    await replaceAlarms(db, sub().endpoint, [
      { id: "ancient", title: "Hours ago", at: min(5) },
      { id: "recent", title: "A moment ago", at: min(10) },
    ], now);

    // Now it is 16 minutes past noon: the first is 11 minutes late, past the
    // grace period, while the second is 6 minutes late and still worth ringing.
    const later = min(5) + LATE_GRACE_MS + 60_000;
    const expired = await expireStale(db, later);
    expect(expired).toBe(1);

    const rows = await dueAlarms(db, later);
    expect(rows.map((r) => r.id)).toEqual(["recent"]);
  });
});

describe("forgetAbandoned", () => {
  it("removes devices that stopped checking in, and leaves current ones", async () => {
    await saveSubscription(db, sub({ endpoint: "https://push.example.test/old" }), now);
    await saveSubscription(db, sub({ endpoint: "https://push.example.test/new" }), now);
    await db
      .prepare(`UPDATE subscriptions SET seen_at = ? WHERE endpoint = ?`)
      .bind(now - 200 * 24 * 3600_000, "https://push.example.test/old")
      .run();

    expect(await forgetAbandoned(db, now)).toBe(1);
    expect(await getSubscription(db, "https://push.example.test/old")).toBeNull();
    expect(await getSubscription(db, "https://push.example.test/new")).not.toBeNull();
  });
});

describe("notificationFor", () => {
  it("says what kind of alert it is and holds a real one on screen", () => {
    expect(notificationFor({ id: "t1:due", title: "Call the bank", kind: "due", at: now })).toMatchObject({
      title: "Due now",
      body: "Call the bank",
      requireInteraction: true,
    });
    expect(notificationFor({ id: "t1:soon", title: "Call the bank", kind: "soon", at: now })).toMatchObject({
      title: "Coming up",
      requireInteraction: false,
    });
  });
});
