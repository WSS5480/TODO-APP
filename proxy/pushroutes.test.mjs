import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { isPushEndpoint, handlePushRequest, runScheduler } from "./pushroutes.mjs";
import { generateVapidKeys } from "./push.mjs";
import { saveSubscription, getSubscription, replaceAlarms, dueAlarms } from "./pushstore.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const SCHEMA_PATH = ["proxy/schema.sql", "schema.sql"]
  .map((p) => resolve(process.cwd(), p))
  .find((p) => existsSync(p));
const SCHEMA = readFileSync(SCHEMA_PATH, "utf8");

function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const num = (v) => (typeof v === "bigint" ? Number(v) : v);
  const clean = (row) =>
    row === undefined ? null : Object.fromEntries(Object.entries(row).map(([k, v]) => [k, num(v)]));

  const make = (sql, params = []) => ({
    bind: (...args) => make(sql, args),
    async run() {
      return { success: true, meta: { changes: num(sqlite.prepare(sql).run(...params).changes) } };
    },
    async all() {
      return { success: true, results: sqlite.prepare(sql).all(...params).map(clean) };
    },
    async first() {
      return clean(sqlite.prepare(sql).get(...params));
    },
  });

  return {
    prepare: (sql) => make(sql),
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
}

const ENDPOINT = "https://web.push.apple.com/send/abc123";
const SUBSCRIPTION = {
  endpoint: ENDPOINT,
  keys: { p256dh: "BPublicKey", auth: "AuthSecret" },
};

// The two helpers the Worker injects so CORS lives in one place.
const reply = (status, body) => ({ status, body });
const json = (status, value) => ({ status, body: value });

const post = (body) => new Request("https://proxy.test/push/x", { method: "POST", body: JSON.stringify(body) });
const get = () => new Request("https://proxy.test/push/key");

let env;
let keys;

beforeEach(async () => {
  keys = await generateVapidKeys();
  env = {
    DB: fakeD1(),
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    VAPID_SUBJECT: "mailto:steve.smith@buddyrents.com",
  };
});

describe("isPushEndpoint", () => {
  it("accepts the real push services", () => {
    for (const url of [
      "https://web.push.apple.com/Qx/y",
      "https://fcm.googleapis.com/fcm/send/abc:123",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://db5p.notify.windows.com/w/?token=x",
    ]) {
      expect(isPushEndpoint(url), url).toBe(true);
    }
  });

  it("refuses anything else, including a look-alike host", () => {
    for (const url of [
      "https://push.apple.com.evil.test/send",
      "http://web.push.apple.com/send",
      "https://169.254.169.254/latest/meta-data/",
      "https://example.test/send",
      "not a url",
      "",
    ]) {
      expect(isPushEndpoint(url), url).toBe(false);
    }
  });
});

describe("the push routes", () => {
  it("hands out the public key so the app needs no configuration", async () => {
    const res = await handlePushRequest("/push/key", get(), env, { reply, json });
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe(keys.publicKey);
  });

  it("says plainly when it has not been set up", async () => {
    const bare = await handlePushRequest("/push/key", get(), {}, { reply, json });
    expect(bare.status).toBe(503);
    expect(bare.body).toMatch(/database/);

    const noKeys = await handlePushRequest("/push/key", get(), { DB: env.DB }, { reply, json });
    expect(noKeys.status).toBe(503);
    expect(noKeys.body).toMatch(/VAPID/);
  });

  it("stores a subscription, with its alarms in the same call", async () => {
    const res = await handlePushRequest(
      "/push/subscribe",
      post({
        subscription: SUBSCRIPTION,
        label: "iPhone",
        alarms: [{ id: "t1:due", title: "Call the bank", at: Date.now() + 600_000 }],
      }),
      env,
      { reply, json },
    );
    expect(res.status).toBe(200);

    const row = await getSubscription(env.DB, ENDPOINT);
    expect(row).toMatchObject({ p256dh: "BPublicKey", auth: "AuthSecret", label: "iPhone" });
    expect(await dueAlarms(env.DB, Date.now() + 700_000)).toHaveLength(1);
  });

  it("takes a flattened subscription too", async () => {
    const res = await handlePushRequest(
      "/push/subscribe",
      post({ endpoint: ENDPOINT, p256dh: "BKey", auth: "Secret" }),
      env,
      { reply, json },
    );
    expect(res.status).toBe(200);
    expect(await getSubscription(env.DB, ENDPOINT)).toMatchObject({ p256dh: "BKey" });
  });

  it("refuses a subscription that is missing its keys or points somewhere else", async () => {
    expect((await handlePushRequest("/push/subscribe", post({ endpoint: ENDPOINT }), env, { reply, json })).status).toBe(400);
    expect(
      (
        await handlePushRequest(
          "/push/subscribe",
          post({ endpoint: "https://evil.test/send", p256dh: "k", auth: "a" }),
          env,
          { reply, json },
        )
      ).status,
    ).toBe(400);
  });

  it("only accepts an alarm schedule for a device that subscribed", async () => {
    const unknown = await handlePushRequest(
      "/push/alarms",
      post({ endpoint: ENDPOINT, alarms: [] }),
      env,
      { reply, json },
    );
    expect(unknown.status).toBe(404);

    await saveSubscription(env.DB, { endpoint: ENDPOINT, p256dh: "k", auth: "a" });
    const known = await handlePushRequest(
      "/push/alarms",
      post({ endpoint: ENDPOINT, alarms: [{ id: "t1:due", title: "X", at: Date.now() + 60_000 }] }),
      env,
      { reply, json },
    );
    expect(known.status).toBe(200);
    expect(known.body).toMatchObject({ ok: true, stored: 1 });
  });

  it("forgets a device on request", async () => {
    await saveSubscription(env.DB, { endpoint: ENDPOINT, p256dh: "k", auth: "a" });
    const res = await handlePushRequest("/push/unsubscribe", post({ endpoint: ENDPOINT }), env, { reply, json });
    expect(res.status).toBe(200);
    expect(await getSubscription(env.DB, ENDPOINT)).toBeNull();
  });

  it("rejects a body that is not JSON, and an unknown route", async () => {
    const bad = new Request("https://proxy.test/push/alarms", { method: "POST", body: "{nope" });
    expect((await handlePushRequest("/push/alarms", bad, env, { reply, json })).status).toBe(400);
    expect((await handlePushRequest("/push/nope", post({}), env, { reply, json })).status).toBe(404);
  });

  it("insists on the right method", async () => {
    const res = await handlePushRequest("/push/key", post({}), env, { reply, json });
    expect(res.status).toBe(405);
  });
});

describe("the test notification", () => {
  beforeEach(async () => {
    // real keys, so the payload is genuinely encrypted on the way out
    const generated = await generateVapidKeys();
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const b64 = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    env.VAPID_PUBLIC_KEY = generated.publicKey;
    env.VAPID_PRIVATE_KEY = generated.privateKey;
    await saveSubscription(env.DB, {
      endpoint: ENDPOINT,
      p256dh: b64(raw),
      auth: b64(crypto.getRandomValues(new Uint8Array(16))),
    });
  });

  it("posts one straight away", async () => {
    let sent = null;
    globalThis.fetch = vi.fn(async (url, init) => {
      sent = { url, init };
      return { ok: true, status: 201, text: async () => "" };
    });

    const res = await handlePushRequest("/push/test", post({ endpoint: ENDPOINT }), env, { reply, json });
    expect(res.status).toBe(200);
    expect(sent.url).toBe(ENDPOINT);
    expect(sent.init.headers["Content-Encoding"]).toBe("aes128gcm");
  });

  it("drops a device the push service says is gone", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 410, text: async () => "" }));
    const res = await handlePushRequest("/push/test", post({ endpoint: ENDPOINT }), env, { reply, json });
    expect(res.status).toBe(410);
    expect(await getSubscription(env.DB, ENDPOINT)).toBeNull();
  });
});

describe("the scheduler", () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);
  const min = (n) => now + n * 60_000;

  beforeEach(async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const b64 = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await saveSubscription(env.DB, {
      endpoint: ENDPOINT,
      p256dh: b64(raw),
      auth: b64(crypto.getRandomValues(new Uint8Array(16))),
    }, now);
  });

  it("sends what is due and leaves what is not", async () => {
    await replaceAlarms(env.DB, ENDPOINT, [
      { id: "t1:due", title: "Water the plants", at: min(5) },
      { id: "t2:due", title: "Much later", at: min(120) },
    ], now);

    const posted = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      posted.push({ url, bytes: init.body.length });
      return { ok: true, status: 201, text: async () => "" };
    });

    const summary = await runScheduler(env, { now: min(6), log: () => {} });
    expect(summary).toMatchObject({ sent: 1, failed: 0, dropped: 0 });
    expect(posted).toHaveLength(1);

    // and it does not send the same one twice
    const again = await runScheduler(env, { now: min(7), log: () => {} });
    expect(again.sent).toBe(0);
  });

  it("retires an alarm that is too late to be worth ringing", async () => {
    await replaceAlarms(env.DB, ENDPOINT, [{ id: "t1:due", title: "This morning", at: min(5) }], now);
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 201, text: async () => "" }));

    const summary = await runScheduler(env, { now: min(300), log: () => {} });
    expect(summary).toMatchObject({ sent: 0, expired: 1 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("drops a dead device and skips the rest of its alarms", async () => {
    await replaceAlarms(env.DB, ENDPOINT, [
      { id: "a", title: "One", at: min(1) },
      { id: "b", title: "Two", at: min(2) },
    ], now);
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 410, text: async () => "" }));

    const summary = await runScheduler(env, { now: min(5), log: () => {} });
    expect(summary).toMatchObject({ sent: 0, dropped: 1 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // not once per alarm
    expect(await getSubscription(env.DB, ENDPOINT)).toBeNull();
  });

  it("leaves a failed send to be retried on the next tick", async () => {
    await replaceAlarms(env.DB, ENDPOINT, [{ id: "t1:due", title: "Retry me", at: min(1) }], now);

    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }));
    expect(await runScheduler(env, { now: min(2), log: () => {} })).toMatchObject({ sent: 0, failed: 1 });

    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 201, text: async () => "" }));
    expect(await runScheduler(env, { now: min(3), log: () => {} })).toMatchObject({ sent: 1 });
  });

  it("does nothing, loudly, when it has not been set up", async () => {
    const lines = [];
    const summary = await runScheduler({}, { now, log: (l) => lines.push(l) });
    expect(summary.sent).toBe(0);
    expect(lines.join(" ")).toMatch(/database/);
  });

  it("is quiet when there is nothing to do", async () => {
    const lines = [];
    const summary = await runScheduler(env, { now: min(1), log: (l) => lines.push(l) });
    expect(summary).toMatchObject({ sent: 0, expired: 0 });
    expect(lines).toEqual([]);
  });
});
