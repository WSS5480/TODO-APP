import { describe, it, expect, vi } from "vitest";
import {
  canPush,
  isStandalone,
  isIOS,
  pushState,
  describeState,
  serviceRoot,
  urlBase64ToUint8Array,
  fetchPublicKey,
  buildAlarms,
  enablePush,
  disablePush,
  syncAlarms,
  sendTestPush,
  HORIZON_DAYS,
  MAX_PER_TASK,
} from "./push.js";

const at = (y, m, d, hh = 9, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
const parts = (ts) => {
  const d = new Date(ts);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};

// A browser, assembled piece by piece so each test can take one piece away.
function fakeScope({
  serviceWorker = true,
  pushManager = true,
  notification = "default",
  standalone = undefined,
  ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
  subscription = null,
} = {}) {
  const subscribed = { current: subscription };
  const registration = {
    pushManager: {
      getSubscription: async () => subscribed.current,
      subscribe: async (opts) => {
        subscribed.current = {
          endpoint: "https://web.push.apple.com/send/abc123",
          options: opts,
          toJSON: () => ({
            endpoint: "https://web.push.apple.com/send/abc123",
            keys: { p256dh: "BPublicKey", auth: "AuthSecret" },
          }),
          unsubscribe: async () => {
            subscribed.current = null;
            return true;
          },
        };
        return subscribed.current;
      },
    },
  };

  const scope = {
    navigator: { userAgent: ua, maxTouchPoints: 5 },
    matchMedia: () => ({ matches: false }),
  };
  if (serviceWorker) {
    scope.navigator.serviceWorker = {
      register: vi.fn(async () => registration),
      getRegistration: async () => registration,
      ready: Promise.resolve(registration),
    };
  }
  if (pushManager) scope.PushManager = function PushManager() {};
  if (notification !== null) {
    scope.Notification = {
      permission: notification,
      requestPermission: vi.fn(async () => {
        scope.Notification.permission = "granted";
        return "granted";
      }),
    };
  }
  if (standalone !== undefined) scope.navigator.standalone = standalone;
  scope.__registration = registration;
  scope.__subscribed = subscribed;
  return scope;
}

const okFetch = (routes = {}) => {
  const calls = [];
  const impl = vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const hit = routes[new URL(String(url)).pathname];
    if (hit) return hit;
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" };
  });
  impl.calls = calls;
  return impl;
};

const keyRoute = {
  "/push/key": { ok: true, status: 200, json: async () => ({ publicKey: "BAAAAA" }), text: async () => "" },
};

describe("what this device can do", () => {
  it("needs all three APIs", () => {
    expect(canPush(fakeScope())).toBe(true);
    expect(canPush(fakeScope({ serviceWorker: false }))).toBe(false);
    expect(canPush(fakeScope({ pushManager: false }))).toBe(false);
    expect(canPush(fakeScope({ notification: null }))).toBe(false);
  });

  it("knows an iPhone, including an iPad pretending to be a Mac", () => {
    expect(isIOS(fakeScope())).toBe(true);
    expect(isIOS(fakeScope({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }))).toBe(true); // touch points
    const desktop = fakeScope({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    desktop.navigator.maxTouchPoints = 0;
    expect(isIOS(desktop)).toBe(false);
  });

  it("detects an installed app either way round", () => {
    expect(isStandalone(fakeScope({ standalone: true }))).toBe(true);
    expect(isStandalone(fakeScope({ standalone: false }))).toBe(false);
    const viaMedia = fakeScope();
    viaMedia.matchMedia = () => ({ matches: true });
    expect(isStandalone(viaMedia)).toBe(true);
  });
});

describe("pushState", () => {
  it("asks for a Home Screen install on iOS in a browser tab", () => {
    expect(pushState(fakeScope({ standalone: false }))).toBe("needs-install");
    expect(describeState("needs-install")).toMatch(/Home Screen/);
  });

  it("does not ask for an install anywhere else", () => {
    const desktop = fakeScope({ ua: "Mozilla/5.0 (Windows NT 10.0)", standalone: false });
    expect(pushState(desktop)).toBe("off");
  });

  it("reports blocked, off and on", () => {
    expect(pushState(fakeScope({ standalone: true, notification: "denied" }))).toBe("blocked");
    expect(pushState(fakeScope({ standalone: true, notification: "granted" }))).toBe("off");
    expect(pushState(fakeScope({ standalone: true, notification: "granted" }), { subscribed: true })).toBe("on");
    // permission revoked behind the app's back
    expect(pushState(fakeScope({ standalone: true, notification: "default" }), { subscribed: true })).toBe("off");
  });

  it("says so when the browser simply cannot", () => {
    expect(pushState(fakeScope({ pushManager: false }))).toBe("unsupported");
    expect(describeState("unsupported")).toMatch(/cannot/);
  });
});

describe("serviceRoot", () => {
  it("strips the calendar path to leave the service itself", () => {
    expect(serviceRoot("https://todo-cal-proxy.example.workers.dev/ics")).toBe(
      "https://todo-cal-proxy.example.workers.dev",
    );
    expect(serviceRoot("https://x.test/ics/")).toBe("https://x.test");
    expect(serviceRoot("https://x.test")).toBe("https://x.test");
    expect(serviceRoot("")).toBe("");
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes a key with url-safe characters and no padding", () => {
    const bytes = urlBase64ToUint8Array("BAEC_-8");
    expect(Array.from(bytes)).toEqual([4, 1, 2, 255, 239]);
  });
});

describe("fetchPublicKey", () => {
  it("returns the key the service advertises", async () => {
    await expect(fetchPublicKey("https://x.test", okFetch(keyRoute))).resolves.toBe("BAAAAA");
  });

  it("explains a service that has no notifications", async () => {
    const f = okFetch({ "/push/key": { ok: false, status: 404, text: async () => "" } });
    await expect(fetchPublicKey("https://x.test", f)).rejects.toThrow(/Cloudflare Worker/);
  });

  it("complains about a service that answers without a key", async () => {
    const f = okFetch({ "/push/key": { ok: true, status: 200, json: async () => ({}) } });
    await expect(fetchPublicKey("https://x.test", f)).rejects.toThrow(/did not return a key/);
  });
});

describe("buildAlarms", () => {
  const now = at(2026, 3, 10, 8, 0);
  const task = (over = {}) => ({ id: "t1", title: "Water the plants", due: at(2026, 3, 10, 9, 0), done: false, ...over });

  it("makes one alarm for a one-off task", () => {
    expect(buildAlarms([task()], {}, { now })).toEqual([
      { id: `t1@${at(2026, 3, 10, 9, 0)}:due`, title: "Water the plants", kind: "due", at: at(2026, 3, 10, 9, 0) },
    ]);
  });

  it("adds the heads-up when one is configured", () => {
    const alarms = buildAlarms([task()], { lead: 10 }, { now });
    expect(alarms.map((a) => a.kind)).toEqual(["soon", "due"]);
    expect(parts(alarms[0].at)).toEqual([2026, 3, 10, 8, 50]);
  });

  it("drops a heads-up whose moment has already gone", () => {
    // five minutes before nine, with a ten-minute lead: the warning is past
    const alarms = buildAlarms([task()], { lead: 10 }, { now: at(2026, 3, 10, 8, 55) });
    expect(alarms.map((a) => a.kind)).toEqual(["due"]);
  });

  it("skips tasks that are done, undated or already past", () => {
    const alarms = buildAlarms(
      [
        task({ id: "a", done: true }),
        task({ id: "b", due: null }),
        task({ id: "c", due: at(2026, 3, 9, 9, 0) }),
        null,
      ],
      {},
      { now },
    );
    expect(alarms).toEqual([]);
  });

  it("expands a repeating task across the horizon", () => {
    const alarms = buildAlarms([task({ repeat: { freq: "daily" } })], {}, { now });
    expect(alarms.length).toBe(HORIZON_DAYS);
    expect(parts(alarms[0].at)).toEqual([2026, 3, 10, 9, 0]);
    expect(parts(alarms.at(-1).at)).toEqual([2026, 3, 23, 9, 0]);
    // every occurrence keeps nine in the morning
    expect(alarms.every((a) => new Date(a.at).getHours() === 9)).toBe(true);
  });

  it("gives each occurrence an id that does not shift when one is completed", () => {
    const all = buildAlarms([task({ repeat: { freq: "daily" } })], {}, { now });
    // the same list, a day later, after the first occurrence is gone
    const later = buildAlarms(
      [task({ due: at(2026, 3, 11, 9, 0), repeat: { freq: "daily" } })],
      {},
      { now: at(2026, 3, 11, 8, 0) },
    );
    const shared = all.filter((a) => later.some((b) => b.id === a.id));
    expect(shared.length).toBeGreaterThan(10);
    for (const a of shared) {
      expect(later.find((b) => b.id === a.id).at).toBe(a.at);
    }
  });

  it("respects a series that ends", () => {
    const alarms = buildAlarms([task({ repeat: { freq: "daily", count: 3 } })], {}, { now });
    expect(alarms.length).toBe(3);
  });

  it("will not let one repeating task fill the whole list", () => {
    const alarms = buildAlarms(
      [task({ repeat: { freq: "daily" } })],
      {},
      { now, horizonDays: 365 },
    );
    expect(alarms.length).toBe(MAX_PER_TASK);
  });

  it("keeps the soonest when there are more than the cap", () => {
    const items = Array.from({ length: 40 }, (_, i) => task({ id: `t${i}`, due: at(2026, 3, 10, 9, 0) + i * 60_000 }));
    const alarms = buildAlarms(items, {}, { now, max: 5 });
    expect(alarms).toHaveLength(5);
    expect(alarms.map((a) => a.id)).toEqual(["t0", "t1", "t2", "t3", "t4"].map((id) => `${id}@${at(2026, 3, 10, 9, 0) + Number(id.slice(1)) * 60_000}:due`));
  });

  it("returns a list sorted by time", () => {
    const items = [task({ id: "late", due: at(2026, 3, 12, 9, 0) }), task({ id: "soon", due: at(2026, 3, 10, 10, 0) })];
    const alarms = buildAlarms(items, { lead: 30 }, { now });
    const times = alarms.map((a) => a.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("copes with no tasks", () => {
    expect(buildAlarms(null, {}, { now })).toEqual([]);
    expect(buildAlarms([], {}, { now })).toEqual([]);
  });
});

describe("enablePush", () => {
  const root = "https://x.test";
  const items = [{ id: "t1", title: "Call", due: Date.now() + 600_000, done: false }];

  it("asks permission, subscribes, and registers the device with its schedule", async () => {
    const scope = fakeScope({ standalone: true });
    const fetchImpl = okFetch(keyRoute);

    const json = await enablePush({ root, items, prefs: { lead: 0 }, scope, fetchImpl });

    expect(scope.Notification.requestPermission).toHaveBeenCalled();
    expect(scope.navigator.serviceWorker.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(json.endpoint).toContain("web.push.apple.com");

    const post = fetchImpl.calls.find((c) => c.url.endsWith("/push/subscribe"));
    expect(post.body.subscription.keys.p256dh).toBe("BPublicKey");
    expect(post.body.label).toBe("iPhone");
    expect(post.body.alarms).toHaveLength(1);
  });

  it("promises a visible notification, which is what iOS requires", async () => {
    const scope = fakeScope({ standalone: true });
    await enablePush({ root, items: [], scope, fetchImpl: okFetch(keyRoute) });
    expect(scope.__subscribed.current.options.userVisibleOnly).toBe(true);
    expect(scope.__subscribed.current.options.applicationServerKey).toBeInstanceOf(Uint8Array);
  });

  it("stops if permission is refused", async () => {
    const scope = fakeScope({ standalone: true });
    scope.Notification.requestPermission = vi.fn(async () => "denied");
    const fetchImpl = okFetch(keyRoute);
    await expect(enablePush({ root, items: [], scope, fetchImpl })).rejects.toThrow(/not allowed/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reuses a subscription this device already has", async () => {
    const existing = {
      endpoint: "https://web.push.apple.com/send/old",
      toJSON: () => ({ endpoint: "https://web.push.apple.com/send/old", keys: { p256dh: "B", auth: "A" } }),
    };
    const scope = fakeScope({ standalone: true, notification: "granted", subscription: existing });
    const fetchImpl = okFetch(keyRoute);
    const json = await enablePush({ root, items: [], scope, fetchImpl });
    expect(json.endpoint).toContain("/send/old");
  });

  it("refuses without a service to talk to", async () => {
    await expect(enablePush({ root: "", items: [], scope: fakeScope({ standalone: true }) })).rejects.toThrow(
      /no reader service/,
    );
  });
});

describe("disablePush", () => {
  it("unsubscribes the device and tells the service", async () => {
    const scope = fakeScope({ standalone: true, notification: "granted" });
    const fetchImpl = okFetch(keyRoute);
    await enablePush({ root: "https://x.test", items: [], scope, fetchImpl });

    await disablePush({ root: "https://x.test", scope, fetchImpl });
    expect(scope.__subscribed.current).toBeNull();
    expect(fetchImpl.calls.some((c) => c.url.endsWith("/push/unsubscribe"))).toBe(true);
  });

  it("still unsubscribes locally when the service cannot be reached", async () => {
    const scope = fakeScope({ standalone: true, notification: "granted" });
    await enablePush({ root: "https://x.test", items: [], scope, fetchImpl: okFetch(keyRoute) });

    const failing = vi.fn(async () => {
      throw new TypeError("offline");
    });
    await expect(disablePush({ root: "https://x.test", scope, fetchImpl: failing })).resolves.toBeUndefined();
    expect(scope.__subscribed.current).toBeNull();
  });
});

describe("syncAlarms", () => {
  it("does nothing when this device is not subscribed", async () => {
    const scope = fakeScope({ standalone: true });
    const fetchImpl = okFetch();
    expect(await syncAlarms({ root: "https://x.test", items: [], prefs: {}, scope, fetchImpl })).toEqual({
      skipped: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uploads the current schedule for a subscribed device", async () => {
    const scope = fakeScope({ standalone: true, notification: "granted" });
    const fetchImpl = okFetch(keyRoute);
    await enablePush({ root: "https://x.test", items: [], scope, fetchImpl });

    // half an hour out, so the ten-minute heads-up is still ahead of us
    const items = [{ id: "t1", title: "Call", due: Date.now() + 30 * 60_000, done: false }];
    await syncAlarms({ root: "https://x.test", items, prefs: { lead: 10 }, scope, fetchImpl });

    const post = fetchImpl.calls.at(-1);
    expect(post.url).toContain("/push/alarms");
    expect(post.body.endpoint).toContain("web.push.apple.com");
    expect(post.body.alarms.map((a) => a.kind)).toEqual(["soon", "due"]);
  });
});

describe("sendTestPush", () => {
  it("needs a subscription first", async () => {
    const scope = fakeScope({ standalone: true });
    await expect(sendTestPush({ root: "https://x.test", scope })).rejects.toThrow(/not turned on/);
  });

  it("asks the service to send one", async () => {
    const scope = fakeScope({ standalone: true, notification: "granted" });
    const fetchImpl = okFetch(keyRoute);
    await enablePush({ root: "https://x.test", items: [], scope, fetchImpl });
    await sendTestPush({ root: "https://x.test", scope, fetchImpl });
    expect(fetchImpl.calls.at(-1).url).toContain("/push/test");
  });
});
