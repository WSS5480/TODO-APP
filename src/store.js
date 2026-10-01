import { isRepeating, nextOccurrence, normalizeRepeat } from "./recur.js";

export const STORAGE_KEY = "todo-reminder.items.v1";
export const PREFS_KEY = "todo-reminder.prefs.v1";

// sound: master on/off; lead: minutes of heads-up before due (0 = off)
// dueSound / soonSound: which alarm to play for each kind, so a heads-up is
// distinguishable from the real thing; repeat: how many times a due alarm rings.
// calUrl: the published calendar to pull from; calEvery: minutes between pulls
// while the app is open (0 = only on demand); calPrune: whether an event deleted
// in the calendar also removes its task; calSyncedAt: when the last pull worked.
export const DEFAULT_PREFS = {
  sound: true,
  lead: 10,
  dueSound: "chime",
  soonSound: "ping",
  repeat: 1,
  calUrl: "",
  // calProxy: the reader service that fetches the feed; blank uses the built-in
  // one, which is what a fresh install wants.
  calProxy: "",
  calEvery: 60,
  calPrune: false,
  calSyncedAt: 0,
};

export function load(storage = globalThis.localStorage) {
  try {
    return JSON.parse(storage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

export function save(items, storage = globalThis.localStorage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export function loadPrefs(storage = globalThis.localStorage) {
  try {
    const stored = JSON.parse(storage.getItem(PREFS_KEY)) || {};
    return { ...DEFAULT_PREFS, ...stored };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs, storage = globalThis.localStorage) {
  storage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

export function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function addItem(items, { title, due, prio, sound, repeat }) {
  const t = title.trim();
  if (!t) return items;
  const when = due ? new Date(due).getTime() : null;
  return [
    ...items,
    {
      id: uid(),
      title: t,
      due: when,
      // A repeat needs a date to repeat from, so it is only kept with one.
      repeat: when ? normalizeRepeat(repeat) : null,
      prio: prio || "med",
      sound: sound || null, // null = use the default alarm from prefs
      done: false,
      createdAt: Date.now(),
      alertedAt: null,     // when the "due now" alarm fired
      preAlertedAt: null,  // when the heads-up alert fired
    },
  ];
}

// Ticking off a repeating task does not finish it: it moves on to its next
// occurrence with the alarms re-armed and one fewer left in the series. The
// task only really closes when the series has run out.
function completeOrRoll(it, now) {
  const next = isRepeating(it.repeat) ? nextOccurrence(it.due, it.repeat, now) : null;
  if (!next) return { ...it, done: true, lastDoneAt: now };

  return {
    ...it,
    done: false,
    due: next.due,
    repeat: next.repeat,
    alertedAt: null,
    preAlertedAt: null,
    lastDoneAt: now,
    doneCount: (it.doneCount || 0) + 1,
  };
}

export function toggleItem(items, id, now = Date.now()) {
  return items.map((it) => {
    if (it.id !== id) return it;
    // re-opening a task re-arms its alarm
    return it.done
      ? { ...it, done: false, alertedAt: null, preAlertedAt: null }
      : completeOrRoll(it, now);
  });
}

export function completeItem(items, id, now = Date.now()) {
  return items.map((it) => (it.id === id ? completeOrRoll(it, now) : it));
}

// Apply an edit to one task. Fields left undefined keep their current value.
// Changing the due time re-arms both alarms, so a task moved to a later time
// rings again even if it already fired at the old one.
export function editItem(items, id, { title, due, prio, sound, repeat } = {}) {
  return items.map((it) => {
    if (it.id !== id) return it;

    const nextTitle = title === undefined ? it.title : String(title).trim();
    if (!nextTitle) return it; // an edit must never blank out a task

    const nextDue =
      due === undefined ? it.due : due ? new Date(due).getTime() : null;
    const rearm = nextDue !== it.due;

    const askedRepeat = repeat === undefined ? (it.repeat ?? null) : repeat;

    return {
      ...it,
      title: nextTitle,
      due: nextDue,
      // Clearing the date clears the repeat with it; there is nothing left for
      // it to count from.
      repeat: nextDue ? normalizeRepeat(askedRepeat) : null,
      prio: prio === undefined ? it.prio : prio || it.prio,
      sound: sound === undefined ? (it.sound ?? null) : sound || null,
      ...(rearm ? { alertedAt: null, preAlertedAt: null } : {}),
    };
  });
}

export function removeItem(items, id) {
  return items.filter((it) => it.id !== id);
}

export function clearDone(items) {
  return items.filter((it) => !it.done);
}

/* ---------- tasks that came from a calendar ---------- */

// Merge drafts from an imported or synced calendar into the list.
//
// The calendar's own UID is kept on the task as `extId`, which is what makes a
// second sync an update rather than a pile of duplicates. Tasks typed into the
// app have no extId and are never touched here.
//
// `prune` drops previously-imported tasks the calendar no longer offers — right
// for a repeated sync of one calendar, wrong for importing a file that is only
// part of the picture, so the caller decides.
export function mergeImported(items, drafts, { now = Date.now(), source = "calendar", prune = false } = {}) {
  const byExt = new Map();
  for (const it of items) if (it.extId) byExt.set(it.extId, it);

  const seen = new Set();
  const next = [...items];
  let added = 0;
  let updated = 0;

  for (const draft of drafts || []) {
    if (!draft || !draft.title) continue;
    const extId = draft.extId || null;
    if (extId) seen.add(extId);

    const existing = extId ? byExt.get(extId) : null;

    if (!existing) {
      next.push({
        id: uid(),
        title: draft.title,
        due: draft.due ?? null,
        repeat: normalizeRepeat(draft.repeat),
        prio: "med",
        sound: null,
        done: false,
        createdAt: now,
        alertedAt: null,
        preAlertedAt: null,
        extId,
        source,
        allDay: !!draft.allDay,
      });
      added += 1;
      continue;
    }

    const movedDue = (existing.due ?? null) !== (draft.due ?? null);
    const changedTitle = existing.title !== draft.title;
    const changedRepeat = toRepeatKey(existing.repeat) !== toRepeatKey(draft.repeat);
    if (!movedDue && !changedTitle && !changedRepeat) continue;

    const at = next.indexOf(existing);
    next[at] = {
      ...existing,
      title: draft.title,
      due: draft.due ?? null,
      repeat: normalizeRepeat(draft.repeat),
      allDay: !!draft.allDay,
      // An event that moved is a new commitment: re-open it and re-arm both
      // alarms, so a rescheduled meeting still rings.
      ...(movedDue ? { done: false, alertedAt: null, preAlertedAt: null } : {}),
    };
    updated += 1;
  }

  const kept = prune
    ? next.filter((it) => !it.extId || it.source !== source || seen.has(it.extId))
    : next;

  return { items: kept, added, updated, removed: next.length - kept.length };
}

function toRepeatKey(repeat) {
  const rule = normalizeRepeat(repeat);
  return rule ? `${rule.freq}:${rule.interval}:${rule.until}:${rule.count}` : "";
}

// Push the due time out by `minutes` and re-arm the alarm. The heads-up is
// skipped for a snoozed task (preAlertedAt set) so it rings once, at the new time.
export function snoozeItem(items, id, minutes, now = Date.now()) {
  return items.map((it) =>
    it.id === id
      ? {
          ...it,
          due: now + minutes * 60_000,
          done: false,
          alertedAt: null,
          preAlertedAt: now,
          snoozed: (it.snoozed || 0) + 1,
        }
      : it,
  );
}

// Which tasks need an alert right now. kind "due" = at/after due time,
// kind "soon" = within the heads-up window. Each fires once per task.
export function dueAlerts(items, now = Date.now(), leadMs = 0) {
  const out = [];
  for (const it of items) {
    if (it.done || !it.due) continue;
    if (it.due <= now) {
      if (!it.alertedAt) out.push({ item: it, kind: "due" });
    } else if (leadMs > 0 && it.due - now <= leadMs && !it.preAlertedAt) {
      out.push({ item: it, kind: "soon" });
    }
  }
  return out;
}

export function markAlerted(items, id, kind, now = Date.now()) {
  const key = kind === "due" ? "alertedAt" : "preAlertedAt";
  return items.map((it) => (it.id === id ? { ...it, [key]: now } : it));
}

const PRIO_RANK = { high: 0, med: 1, low: 2 };

export function sortItems(items) {
  return [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ad = a.due ?? Infinity;
    const bd = b.due ?? Infinity;
    if (ad !== bd) return ad - bd;
    return PRIO_RANK[a.prio] - PRIO_RANK[b.prio];
  });
}

export function dueClass(item, now = Date.now()) {
  if (!item.due || item.done) return "";
  const diff = item.due - now;
  if (diff < 0) return "overdue";
  if (diff < 3_600_000) return "due-soon";
  return "";
}

export function fmtWhen(ts, now = Date.now()) {
  const d = new Date(ts);
  const n = new Date(now);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === n.toDateString()
    ? `Today ${time}`
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// "in 8 min" / "in 2 h" for heads-up messages
export function fmtIn(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  return `in ${h} h`;
}

// Timestamp -> the value an <input type="datetime-local"> expects, in local time.
// toISOString() would shift by the UTC offset and show the wrong time in the editor.
export function toLocalInput(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Which sound an alert should use: a task's own choice wins for its due alarm,
// otherwise the configured default. The heads-up always uses the heads-up
// sound, so an early warning never sounds like the task is actually due.
export function alertSound(item, kind, prefs) {
  if (kind === "soon") return prefs.soonSound;
  return item.sound || prefs.dueSound;
}
