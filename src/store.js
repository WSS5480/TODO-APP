export const STORAGE_KEY = "todo-reminder.items.v1";
export const PREFS_KEY = "todo-reminder.prefs.v1";

// sound: play a chime when a task comes due; lead: minutes of heads-up before due (0 = off)
export const DEFAULT_PREFS = { sound: true, lead: 10 };

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

export function addItem(items, { title, due, prio }) {
  const t = title.trim();
  if (!t) return items;
  return [
    ...items,
    {
      id: uid(),
      title: t,
      due: due ? new Date(due).getTime() : null,
      prio: prio || "med",
      done: false,
      createdAt: Date.now(),
      alertedAt: null,     // when the "due now" alarm fired
      preAlertedAt: null,  // when the heads-up alert fired
    },
  ];
}

export function toggleItem(items, id) {
  return items.map((it) => {
    if (it.id !== id) return it;
    // re-opening a task re-arms its alarm
    return it.done
      ? { ...it, done: false, alertedAt: null, preAlertedAt: null }
      : { ...it, done: true };
  });
}

export function completeItem(items, id) {
  return items.map((it) => (it.id === id ? { ...it, done: true } : it));
}

// Apply an edit to one task. Fields left undefined keep their current value.
// Changing the due time re-arms both alarms, so a task moved to a later time
// rings again even if it already fired at the old one.
export function editItem(items, id, { title, due, prio } = {}) {
  return items.map((it) => {
    if (it.id !== id) return it;

    const nextTitle = title === undefined ? it.title : String(title).trim();
    if (!nextTitle) return it; // an edit must never blank out a task

    const nextDue =
      due === undefined ? it.due : due ? new Date(due).getTime() : null;
    const rearm = nextDue !== it.due;

    return {
      ...it,
      title: nextTitle,
      due: nextDue,
      prio: prio === undefined ? it.prio : prio || it.prio,
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
