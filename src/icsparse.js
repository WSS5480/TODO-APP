// Reading iCalendar (RFC 5545), the other direction from calendar.js.
//
// This is what turns a calendar into tasks: an .ics file exported from Calendar,
// pasted text, or the body of a published iCloud calendar feed. It is a reader
// for the parts a todo list can act on — when something happens, what it is
// called, and whether it repeats — and it deliberately ignores the rest.
//
// Two details the format makes easy to get wrong, both handled below:
//
//   * A VEVENT can contain a VALARM, and a file begins with VTIMEZONE blocks
//     that have DTSTART lines of their own. Properties are therefore only read
//     at the depth of the event itself, never from a nested component.
//   * A time can arrive in three shapes — UTC, a named zone, or "floating"
//     local time — and all-day events carry a date with no time at all.

import { fromRRULE, nextOccurrence, normalizeRepeat } from "./recur.js";

// An all-day event has no time to ring at. Morning is the least surprising
// choice: midnight would put the alarm in the middle of the night before.
export const ALL_DAY_HOUR = 9;

// A calendar can hold years of history; a todo list has no use for it.
export const DEFAULT_MAX_EVENTS = 500;

/* ---------- lexing ---------- */

// Long lines are split with CRLF + a single space or tab. Join them back before
// anything else looks at the text.
export function unfold(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "");
}

// The escaping rules are calendar.js's escapeText in reverse. This walks the
// string once rather than running four replacements: an escaped backslash has
// to be consumed whole, or "back\\nope" — a backslash followed by the word
// "nope" — would come out with a newline in the middle of it.
export function unescapeText(value) {
  const text = String(value);
  let out = "";

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\\") {
      out += text[i];
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) {
      out += "\\"; // a trailing backslash is just a backslash
      break;
    }
    i += 1;
    // \n is the only sequence that stands for a different character; \\ \, \;
    // and anything else an exporter escaped all mean the character itself.
    out += next === "n" || next === "N" ? "\n" : next;
  }

  return out;
}

// NAME;PARAM=value;PARAM2="quoted:value":THE VALUE
export function parseLine(line) {
  const colon = findValueColon(line);
  if (colon < 0) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramChunks] = head.split(";");

  const params = {};
  for (const chunk of paramChunks) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    const key = chunk.slice(0, eq).trim().toUpperCase();
    params[key] = chunk.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }

  return { name: name.trim().toUpperCase(), params, value };
}

// The first colon that is not inside a quoted parameter value — a TZID may
// legitimately contain one.
function findValueColon(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) return i;
  }
  return -1;
}

/* ---------- time ---------- */

// How far `timeZone` is from UTC at a given instant, in milliseconds.
function zoneOffset(utcMs, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asIfUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24, // some runtimes render midnight as hour 24
    Number(p.minute),
    Number(p.second),
  );
  return asIfUtc - utcMs;
}

// A wall-clock reading in a named zone -> a real instant. Solved twice because
// the offset that applies depends on the instant we are still working out; the
// second pass settles it either side of a clock change.
export function zonedToTimestamp(y, mo, d, hh, mi, ss, timeZone) {
  const wall = Date.UTC(y, mo - 1, d, hh, mi, ss);
  try {
    let ts = wall;
    for (let i = 0; i < 2; i++) ts = wall - zoneOffset(ts, timeZone);
    return ts;
  } catch {
    // An unknown TZID is not worth losing the event over: read it as local time.
    return new Date(y, mo - 1, d, hh, mi, ss).getTime();
  }
}

// DTSTART in any of its shapes. Returns { ts, allDay } or null.
export function parseDate(value, params = {}, { allDayHour = ALL_DAY_HOUR } = {}) {
  const raw = String(value).trim();

  const dateOnly = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly || String(params.VALUE).toUpperCase() === "DATE") {
    const m = dateOnly || raw.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), allDayHour, 0, 0).getTime();
    return { ts, allDay: true };
  }

  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m.map((x) => x);
  const nums = [Number(y), Number(mo), Number(d), Number(hh), Number(mi), Number(ss)];

  if (z) return { ts: Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5]), allDay: false };
  if (params.TZID) return { ts: zonedToTimestamp(...nums, params.TZID), allDay: false };
  // No zone and no Z: "floating" time, which means local wherever it is read.
  return { ts: new Date(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5]).getTime(), allDay: false };
}

/* ---------- events ---------- */

// Every VEVENT in the text, as plain objects. Properties are only taken at the
// event's own depth, so VTIMEZONE and VALARM blocks cannot contribute a
// DTSTART or a SUMMARY that is not the event's.
export function parseIcs(text, { allDayHour = ALL_DAY_HOUR } = {}) {
  const events = [];
  let calendarName = "";
  const stack = [];
  let current = null;

  for (const line of unfold(text).split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;

    if (name === "BEGIN") {
      stack.push(value.trim().toUpperCase());
      if (stack[stack.length - 1] === "VEVENT" && stack.length <= 2) {
        current = { uid: "", title: "", due: null, allDay: false, repeat: null, cancelled: false };
      }
      continue;
    }

    if (name === "END") {
      const closed = stack.pop();
      if (closed === "VEVENT" && current) {
        if (current.due !== null) events.push(current);
        current = null;
      }
      continue;
    }

    if (stack.length === 1 && stack[0] === "VCALENDAR" && name === "X-WR-CALNAME") {
      calendarName = unescapeText(value).trim();
      continue;
    }

    // only the event's own properties, never a nested component's
    if (!current || stack[stack.length - 1] !== "VEVENT") continue;

    if (name === "UID") current.uid = value.trim();
    else if (name === "SUMMARY") current.title = unescapeText(value).trim();
    else if (name === "STATUS") current.cancelled = value.trim().toUpperCase() === "CANCELLED";
    else if (name === "RRULE") current.repeat = fromRRULE(value);
    else if (name === "DTSTART") {
      const when = parseDate(value, params, { allDayHour });
      if (when) {
        current.due = when.ts;
        current.allDay = when.allDay;
      }
    }
  }

  return { events, calendarName };
}

/* ---------- events -> tasks ---------- */

// Turn parsed events into task drafts the store can merge.
//
// Anything already over is dropped — a calendar holds years of history and none
// of it is a todo. A repeating event whose series started in the past is not
// history though: it is rolled forward to its next occurrence, which is the one
// that still needs doing.
export function eventsToTasks(events, { now = Date.now(), since = null, max = DEFAULT_MAX_EVENTS } = {}) {
  const floor = since === null ? startOfDay(now) : since;
  const out = [];

  for (const ev of events) {
    if (ev.cancelled || ev.due === null) continue;

    let due = ev.due;
    let repeat = normalizeRepeat(ev.repeat);

    if (repeat && due < floor) {
      // first occurrence at or after the cut-off — the same test the one-off
      // events below get, so both kinds of event survive the filter alike
      const next = nextOccurrence(due, repeat, floor - 1);
      if (!next) continue; // the series finished in the past
      due = next.due;
      repeat = next.repeat;
    }

    if (due < floor) continue;

    out.push({
      extId: ev.uid || `${ev.title}@${due}`,
      title: ev.title || "(untitled event)",
      due,
      repeat,
      allDay: ev.allDay,
    });
    if (out.length >= max) break;
  }

  return out;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// The whole job in one call: text in, task drafts out.
export function tasksFromIcs(text, options = {}) {
  const { events, calendarName } = parseIcs(text, options);
  return { tasks: eventsToTasks(events, options), calendarName, found: events.length };
}
