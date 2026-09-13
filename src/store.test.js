import { describe, it, expect, beforeEach } from "vitest";
import {
  STORAGE_KEY, PREFS_KEY, DEFAULT_PREFS, load, save, loadPrefs, savePrefs,
  addItem, toggleItem, completeItem, removeItem, clearDone, snoozeItem,
  dueAlerts, markAlerted, sortItems, dueClass, fmtWhen, fmtIn,
} from "./store.js";

function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

describe("store: persistence", () => {
  let s;
  beforeEach(() => { s = memStorage(); });

  it("loads empty array when nothing stored", () => {
    expect(load(s)).toEqual([]);
  });

  it("saves and loads items", () => {
    const items = [{ id: "1", title: "x", done: false }];
    save(items, s);
    expect(load(s)).toEqual(items);
  });

  it("returns [] on corrupt JSON", () => {
    s.setItem(STORAGE_KEY, "{not-json");
    expect(load(s)).toEqual([]);
  });
});

describe("store: addItem", () => {
  it("adds a trimmed item", () => {
    const out = addItem([], { title: "  buy milk  ", due: null, prio: "high" });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("buy milk");
    expect(out[0].prio).toBe("high");
    expect(out[0].done).toBe(false);
  });

  it("ignores empty titles", () => {
    expect(addItem([], { title: "   " })).toEqual([]);
  });

  it("converts due date to timestamp", () => {
    const iso = "2030-01-01T10:00";
    const [it] = addItem([], { title: "t", due: iso });
    expect(it.due).toBe(new Date(iso).getTime());
  });
});

describe("store: toggle / remove / clear", () => {
  const base = [
    { id: "a", title: "A", done: false },
    { id: "b", title: "B", done: true },
  ];

  it("toggles done state", () => {
    const out = toggleItem(base, "a");
    expect(out.find((x) => x.id === "a").done).toBe(true);
    expect(base[0].done).toBe(false); // immutable
  });

  it("removes by id", () => {
    expect(removeItem(base, "a").map((x) => x.id)).toEqual(["b"]);
  });

  it("clears done items", () => {
    expect(clearDone(base).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("store: sortItems", () => {
  it("puts incomplete before done", () => {
    const out = sortItems([
      { id: "1", done: true, prio: "high", due: 1 },
      { id: "2", done: false, prio: "low", due: null },
    ]);
    expect(out[0].id).toBe("2");
  });

  it("sorts by due time, nulls last", () => {
    const out = sortItems([
      { id: "1", done: false, prio: "low", due: null },
      { id: "2", done: false, prio: "low", due: 200 },
      { id: "3", done: false, prio: "low", due: 100 },
    ]);
    expect(out.map((x) => x.id)).toEqual(["3", "2", "1"]);
  });

  it("breaks ties by priority", () => {
    const out = sortItems([
      { id: "1", done: false, prio: "low", due: 100 },
      { id: "2", done: false, prio: "high", due: 100 },
      { id: "3", done: false, prio: "med", due: 100 },
    ]);
    expect(out.map((x) => x.id)).toEqual(["2", "3", "1"]);
  });
});

describe("store: dueClass", () => {
  const NOW = 1_000_000;
  it("returns '' for no due or done", () => {
    expect(dueClass({ due: null, done: false }, NOW)).toBe("");
    expect(dueClass({ due: NOW - 1, done: true }, NOW)).toBe("");
  });
  it("flags overdue", () => {
    expect(dueClass({ due: NOW - 1, done: false }, NOW)).toBe("overdue");
  });
  it("flags due-soon within an hour", () => {
    expect(dueClass({ due: NOW + 60_000, done: false }, NOW)).toBe("due-soon");
  });
  it("returns '' far in future", () => {
    expect(dueClass({ due: NOW + 7_200_000, done: false }, NOW)).toBe("");
  });
});

describe("store: fmtWhen", () => {
  it("says Today for same-day", () => {
    const now = new Date("2030-01-01T08:00").getTime();
    const ts = new Date("2030-01-01T14:30").getTime();
    expect(fmtWhen(ts, now)).toMatch(/^Today /);
  });
  it("includes month for other days", () => {
    const now = new Date("2030-01-01T08:00").getTime();
    const ts = new Date("2030-02-14T09:00").getTime();
    expect(fmtWhen(ts, now)).toMatch(/Feb/);
  });
});

describe("store: alarms", () => {
  const NOW = 10_000_000;
  const MIN = 60_000;

  it("toggling a done task back re-arms its alarm", () => {
    const out = toggleItem(
      [{ id: "a", done: true, alertedAt: 5, preAlertedAt: 4 }], "a",
    );
    expect(out[0]).toMatchObject({ done: false, alertedAt: null, preAlertedAt: null });
  });

  it("completeItem marks done without toggling back", () => {
    const out = completeItem([{ id: "a", done: true }, { id: "b", done: false }], "a");
    expect(out.map((x) => x.done)).toEqual([true, false]);
  });

  it("snoozeItem pushes due out, re-arms, skips the heads-up", () => {
    const [it] = snoozeItem(
      [{ id: "a", due: NOW - MIN, done: false, alertedAt: NOW - 5, preAlertedAt: NOW - 20 * MIN }],
      "a", 10, NOW,
    );
    expect(it.due).toBe(NOW + 10 * MIN);
    expect(it.alertedAt).toBeNull();
    expect(it.preAlertedAt).toBe(NOW);
    expect(it.done).toBe(false);
    expect(it.snoozed).toBe(1);
  });

  it("dueAlerts fires 'due' once for overdue tasks", () => {
    const items = [
      { id: "a", due: NOW - 1, done: false, alertedAt: null },
      { id: "b", due: NOW - 1, done: false, alertedAt: NOW - 30 * MIN },
      { id: "c", due: NOW - 1, done: true, alertedAt: null },
      { id: "d", due: null, done: false, alertedAt: null },
    ];
    expect(dueAlerts(items, NOW, 10 * MIN)).toEqual([{ item: items[0], kind: "due" }]);
  });

  it("dueAlerts fires 'soon' inside the heads-up window only", () => {
    const items = [
      { id: "in", due: NOW + 8 * MIN, done: false, preAlertedAt: null },
      { id: "out", due: NOW + 12 * MIN, done: false, preAlertedAt: null },
      { id: "already", due: NOW + 8 * MIN, done: false, preAlertedAt: NOW - MIN },
    ];
    expect(dueAlerts(items, NOW, 10 * MIN).map((a) => a.item.id + ":" + a.kind)).toEqual(["in:soon"]);
    expect(dueAlerts(items, NOW, 0)).toEqual([]);
  });

  it("a snoozed task does not get a second heads-up", () => {
    const snoozed = snoozeItem([{ id: "a", due: NOW - MIN, done: false }], "a", 10, NOW);
    expect(dueAlerts(snoozed, NOW + MIN, 10 * MIN)).toEqual([]);
    expect(dueAlerts(snoozed, NOW + 10 * MIN, 10 * MIN)).toEqual([{ item: snoozed[0], kind: "due" }]);
  });

  it("markAlerted stamps the right field", () => {
    const base = [{ id: "a", alertedAt: null, preAlertedAt: null }];
    expect(markAlerted(base, "a", "due", NOW)[0].alertedAt).toBe(NOW);
    expect(markAlerted(base, "a", "soon", NOW)[0].preAlertedAt).toBe(NOW);
  });

  it("fmtIn rounds to minutes then hours", () => {
    expect(fmtIn(30_000)).toBe("in 1 min");
    expect(fmtIn(8.4 * MIN)).toBe("in 8 min");
    expect(fmtIn(125 * MIN)).toBe("in 2 h");
  });

  it("loadPrefs merges stored values over defaults and survives corrupt JSON", () => {
    const s = memStorage();
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
    savePrefs({ sound: false }, s);
    expect(loadPrefs(s)).toEqual({ sound: false, lead: DEFAULT_PREFS.lead });
    s.setItem(PREFS_KEY, "{nope");
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
  });
});
