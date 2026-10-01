import { describe, it, expect, beforeEach } from "vitest";
import {
  STORAGE_KEY, PREFS_KEY, DEFAULT_PREFS, load, save, loadPrefs, savePrefs,
  addItem, toggleItem, completeItem, removeItem, clearDone, snoozeItem,
  dueAlerts, markAlerted, sortItems, dueClass, fmtWhen, fmtIn, editItem, toLocalInput, alertSound,
  mergeImported,
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
    expect(loadPrefs(s)).toEqual({ ...DEFAULT_PREFS, sound: false });
    s.setItem(PREFS_KEY, "{nope");
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
  });
});

describe("editItem", () => {
  const base = () => addItem([], { title: "write tests", due: "2026-01-01T09:00", prio: "low" });

  it("updates title, due and priority", () => {
    const [before] = base();
    const [after] = editItem([before], before.id, {
      title: "  write better tests  ",
      due: "2026-01-02T10:30",
      prio: "high",
    });
    expect(after.title).toBe("write better tests"); // trimmed
    expect(after.prio).toBe("high");
    expect(after.due).toBe(new Date("2026-01-02T10:30").getTime());
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toBe(before.createdAt);
  });

  it("re-arms both alarms when the due time moves", () => {
    const [item] = base();
    const fired = { ...item, alertedAt: 111, preAlertedAt: 222 };
    const [after] = editItem([fired], item.id, { due: "2026-03-04T08:00" });
    expect(after.alertedAt).toBeNull();
    expect(after.preAlertedAt).toBeNull();
  });

  it("leaves the alarm state alone when the due time is unchanged", () => {
    const [item] = base();
    const fired = { ...item, alertedAt: 111, preAlertedAt: 222 };
    const [after] = editItem([fired], item.id, { title: "renamed only" });
    expect(after.alertedAt).toBe(111);
    expect(after.preAlertedAt).toBe(222);
  });

  it("clears the due time when given null", () => {
    const [item] = base();
    const [after] = editItem([item], item.id, { due: null });
    expect(after.due).toBeNull();
  });

  it("refuses to blank out a title", () => {
    const [item] = base();
    const [after] = editItem([item], item.id, { title: "   " });
    expect(after.title).toBe("write tests");
  });

  it("leaves other tasks untouched", () => {
    const items = addItem(base(), { title: "second", prio: "med" });
    const edited = editItem(items, items[0].id, { title: "changed" });
    expect(edited[1]).toBe(items[1]);
  });
});

describe("toLocalInput", () => {
  it("formats a timestamp as local datetime-local value", () => {
    const d = new Date(2026, 0, 9, 7, 5); // 2026-01-09 07:05 local
    expect(toLocalInput(d.getTime())).toBe("2026-01-09T07:05");
  });

  it("round-trips through the datetime-local parser", () => {
    const d = new Date(2026, 10, 3, 18, 45);
    expect(new Date(toLocalInput(d.getTime())).getTime()).toBe(d.getTime());
  });
});

describe("alertSound", () => {
  const prefs = { dueSound: "chime", soonSound: "ping" };

  it("uses the configured due sound when the task has no preference", () => {
    expect(alertSound({ sound: null }, "due", prefs)).toBe("chime");
  });

  it("lets a task override the due sound", () => {
    expect(alertSound({ sound: "urgent" }, "due", prefs)).toBe("urgent");
  });

  it("always uses the heads-up sound for an early warning", () => {
    // a heads-up must not sound like the task is actually due
    expect(alertSound({ sound: null }, "soon", prefs)).toBe("ping");
    expect(alertSound({ sound: "urgent" }, "soon", prefs)).toBe("ping");
  });
});

describe("per-task sound", () => {
  it("defaults to null and round-trips through addItem", () => {
    const [plain] = addItem([], { title: "a", prio: "med" });
    expect(plain.sound).toBeNull();
    const [custom] = addItem([], { title: "b", prio: "med", sound: "bell" });
    expect(custom.sound).toBe("bell");
  });

  it("can be set and cleared by editItem", () => {
    const items = addItem([], { title: "a", prio: "med" });
    const set = editItem(items, items[0].id, { sound: "urgent" });
    expect(set[0].sound).toBe("urgent");
    const cleared = editItem(set, items[0].id, { sound: null });
    expect(cleared[0].sound).toBeNull();
  });

  it("is left alone by an edit that does not mention it", () => {
    const items = addItem([], { title: "a", prio: "med", sound: "bell" });
    const renamed = editItem(items, items[0].id, { title: "b" });
    expect(renamed[0].sound).toBe("bell");
  });
});

/* ---------- repeating tasks ---------- */

const at = (y, m, d, hh = 9, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
const parts = (ts) => {
  const d = new Date(ts);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};

describe("store: repeats", () => {
  const addRepeating = (repeat, due = at(2026, 3, 10)) =>
    addItem([], { title: "Water the plants", due: new Date(due), repeat });

  it("keeps a normalized rule on the new task", () => {
    const [it] = addRepeating("daily");
    expect(it.repeat).toEqual({ freq: "daily", interval: 1, until: null, count: null });
  });

  it("refuses a repeat with no date to repeat from", () => {
    const [it] = addItem([], { title: "Someday", due: "", repeat: "daily" });
    expect(it.repeat).toBeNull();
  });

  it("moves a ticked-off repeating task to its next occurrence instead of closing it", () => {
    const items = addRepeating("daily");
    const [next] = toggleItem(items, items[0].id, at(2026, 3, 10, 9, 5));
    expect(next.done).toBe(false);
    expect(parts(next.due)).toEqual([2026, 3, 11, 9, 0]);
    expect(next.doneCount).toBe(1);
    expect(next.lastDoneAt).toBe(at(2026, 3, 10, 9, 5));
  });

  it("re-arms the alarms for the next occurrence", () => {
    let items = addRepeating("daily");
    items = markAlerted(items, items[0].id, "due");
    expect(items[0].alertedAt).not.toBeNull();
    const [next] = completeItem(items, items[0].id, at(2026, 3, 10, 9, 5));
    expect(next.alertedAt).toBeNull();
    expect(next.preAlertedAt).toBeNull();
  });

  it("closes the task once the series runs out", () => {
    const items = addRepeating({ freq: "daily", count: 1 });
    const [next] = completeItem(items, items[0].id, at(2026, 3, 10, 9, 5));
    expect(next.done).toBe(true);
    expect(parts(next.due)).toEqual([2026, 3, 10, 9, 0]); // left where it was
  });

  it("closes a one-off task as before", () => {
    const items = addItem([], { title: "Buy milk", due: new Date(at(2026, 3, 10)) });
    expect(completeItem(items, items[0].id)[0].done).toBe(true);
    expect(toggleItem(items, items[0].id)[0].done).toBe(true);
  });

  it("re-opens a finished task without rolling it anywhere", () => {
    let items = addRepeating({ freq: "daily", count: 1 });
    items = completeItem(items, items[0].id, at(2026, 3, 10, 9, 5));
    const [back] = toggleItem(items, items[0].id);
    expect(back.done).toBe(false);
    expect(parts(back.due)).toEqual([2026, 3, 10, 9, 0]);
  });

  it("edits the rule, and drops it when the date goes", () => {
    const items = addRepeating("daily");
    const id = items[0].id;
    expect(editItem(items, id, { repeat: "weekly" })[0].repeat.freq).toBe("weekly");
    expect(editItem(items, id, { repeat: "" })[0].repeat).toBeNull();
    expect(editItem(items, id, { due: "" })[0].repeat).toBeNull();
    // an edit that says nothing about the repeat leaves it alone
    expect(editItem(items, id, { title: "Renamed" })[0].repeat.freq).toBe("daily");
  });
});

/* ---------- imported from a calendar ---------- */

describe("store: mergeImported", () => {
  const now = at(2026, 3, 10, 8, 0);
  const draft = (over = {}) => ({
    extId: "ev-1",
    title: "Dentist",
    due: at(2026, 3, 11, 14, 0),
    repeat: null,
    allDay: false,
    ...over,
  });

  it("adds an event as a task, marked with where it came from", () => {
    const res = mergeImported([], [draft()], { now });
    expect(res.added).toBe(1);
    expect(res.items[0]).toMatchObject({
      title: "Dentist",
      extId: "ev-1",
      source: "calendar",
      done: false,
      prio: "med",
    });
  });

  it("updates the same event rather than duplicating it", () => {
    const first = mergeImported([], [draft()], { now }).items;
    const again = mergeImported(first, [draft()], { now });
    expect(again.items).toHaveLength(1);
    expect(again.added).toBe(0);
    expect(again.updated).toBe(0); // nothing changed, so nothing to write

    const moved = mergeImported(first, [draft({ due: at(2026, 3, 12, 15, 0) })], { now });
    expect(moved.items).toHaveLength(1);
    expect(moved.updated).toBe(1);
    expect(parts(moved.items[0].due)).toEqual([2026, 3, 12, 15, 0]);
  });

  it("re-opens and re-arms a task whose event was moved", () => {
    let items = mergeImported([], [draft()], { now }).items;
    items = completeItem(items, items[0].id, now);
    items = markAlerted(items, items[0].id, "due");
    const res = mergeImported(items, [draft({ due: at(2026, 3, 13, 9, 0) })], { now });
    expect(res.items[0]).toMatchObject({ done: false, alertedAt: null, preAlertedAt: null });
  });

  it("follows a renamed event without touching the rest of the task", () => {
    let items = mergeImported([], [draft()], { now }).items;
    items = editItem(items, items[0].id, { prio: "high" });
    const res = mergeImported(items, [draft({ title: "Dentist (moved rooms)" })], { now });
    expect(res.items[0].title).toBe("Dentist (moved rooms)");
    expect(res.items[0].prio).toBe("high"); // the user's own edit survives
  });

  it("carries a repeat rule in and notices when it changes", () => {
    const first = mergeImported([], [draft({ repeat: "weekly" })], { now });
    expect(first.items[0].repeat.freq).toBe("weekly");
    const res = mergeImported(first.items, [draft({ repeat: "daily" })], { now });
    expect(res.updated).toBe(1);
    expect(res.items[0].repeat.freq).toBe("daily");
  });

  it("leaves the user's own tasks completely alone", () => {
    const mine = addItem([], { title: "My own thing", due: new Date(at(2026, 3, 11)) });
    const res = mergeImported(mine, [draft()], { now, prune: true });
    expect(res.items).toHaveLength(2);
    expect(res.items[0].title).toBe("My own thing");
    expect(res.removed).toBe(0);
  });

  it("drops a previously-synced task when the event is gone, but only if asked", () => {
    const items = mergeImported([], [draft(), draft({ extId: "ev-2", title: "Haircut" })], { now }).items;
    expect(mergeImported(items, [draft()], { now }).items).toHaveLength(2);

    const pruned = mergeImported(items, [draft()], { now, prune: true });
    expect(pruned.items.map((t) => t.extId)).toEqual(["ev-1"]);
    expect(pruned.removed).toBe(1);
  });

  it("only prunes within the source it was given", () => {
    const items = mergeImported([], [draft()], { now, source: "work" }).items;
    const res = mergeImported(items, [], { now, source: "home", prune: true });
    expect(res.items).toHaveLength(1);
  });

  it("ignores empty drafts and a missing list", () => {
    expect(mergeImported([], null, { now }).items).toEqual([]);
    expect(mergeImported([], [null, { title: "" }], { now }).added).toBe(0);
  });
});
