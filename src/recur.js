// Repeating tasks.
//
// A repeat is stored on the task as { freq, interval, until, count }:
//
//   freq     "daily" | "weekdays" | "weekly" | "monthly" | "yearly"
//   interval every N of those (ignored for weekdays, which is always every week)
//   until    timestamp of the last moment the series may run, or null
//   count    how many occurrences are LEFT including the current one, or null
//
// Dates advance by local calendar fields rather than by adding milliseconds, so
// a 9am task is still 9am after the clocks change — adding 24h would make it
// 8am or 10am for half the year.
//
// A monthly or yearly repeat SKIPS months where the day does not exist: the
// 31st repeats in January and March but not February. That is what RFC 5545
// says and what Calendar does with the same event, so the app and the calendar
// entry it exports never drift apart.

export const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WORKDAYS = ["MO", "TU", "WE", "TH", "FR"];

// What the pickers offer. value "" = does not repeat.
export const REPEAT_CHOICES = [
  ["", "Does not repeat"],
  ["daily", "Every day"],
  ["weekdays", "Weekdays (Mon–Fri)"],
  ["weekly", "Every week"],
  ["monthly", "Every month"],
  ["yearly", "Every year"],
];

const FREQS = new Set(["daily", "weekdays", "weekly", "monthly", "yearly"]);

// Guard against a rule that can never produce another date (a monthly 31st
// repeat has to look ahead a few months; a broken one would spin forever).
const MAX_PROBE = 400;

// The longest counted series worth tracking. An imported COUNT=100000 is not a
// todo list, and the cap is what keeps the catch-up loop below bounded.
const MAX_SERIES = 9999;

// How many occurrences may be walked while catching a stale series up to today.
const MAX_CATCHUP = MAX_SERIES + 1;

export function isRepeating(repeat) {
  return !!(repeat && FREQS.has(repeat.freq));
}

// Accept whatever the form or an imported file produced and return a clean rule
// (or null for "does not repeat"), so nothing downstream has to re-check.
export function normalizeRepeat(input) {
  if (!input) return null;
  const freq = typeof input === "string" ? input : input.freq;
  if (!FREQS.has(freq)) return null;

  const rawInterval = Number(typeof input === "string" ? 1 : input.interval);
  const interval =
    freq === "weekdays" ? 1 : Math.max(1, Math.min(Math.round(rawInterval) || 1, 999));

  const untilRaw = typeof input === "string" ? null : input.until;
  const until = untilRaw ? new Date(untilRaw).getTime() : null;

  const countRaw = typeof input === "string" ? null : Number(input.count);
  const count =
    Number.isFinite(countRaw) && countRaw > 0
      ? Math.min(Math.round(countRaw), MAX_SERIES)
      : null;

  return {
    freq,
    interval,
    until: Number.isFinite(until) ? until : null,
    count,
  };
}

/* ---------- walking the calendar ---------- */

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Step whole months keeping the day of the month, and report when that day does
// not exist in the target month so the caller can skip it (RFC 5545 behaviour).
function addMonths(d, n) {
  const day = d.getDate();
  const x = new Date(d);
  x.setDate(1); // park on a day every month has, so setMonth cannot overflow
  x.setMonth(x.getMonth() + n);
  const lastDay = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  if (day > lastDay) return null; // e.g. the 31st in February
  x.setDate(day);
  return x;
}

function addYears(d, n) {
  // Feb 29 only exists in a leap year; addMonths does the same check for us.
  return addMonths(d, n * 12);
}

// The next occurrence strictly after `ts`, or null when the rule cannot produce
// one. Ignores `until` and `count` — those are the series' business, handled by
// nextOccurrence below.
export function stepDate(ts, repeat) {
  const rule = normalizeRepeat(repeat);
  if (!rule) return null;
  const from = new Date(ts);

  if (rule.freq === "weekdays") {
    let next = addDays(from, 1);
    // 6 = Saturday, 0 = Sunday
    while (next.getDay() === 0 || next.getDay() === 6) next = addDays(next, 1);
    return next.getTime();
  }

  if (rule.freq === "daily") return addDays(from, rule.interval).getTime();
  if (rule.freq === "weekly") return addDays(from, 7 * rule.interval).getTime();

  const step = rule.freq === "monthly" ? addMonths : addYears;
  for (let i = 1; i <= MAX_PROBE; i++) {
    const next = step(from, rule.interval * i);
    if (next) return next.getTime();
  }
  return null;
}

// Catching a series up one step at a time works, but a calendar event that has
// repeated daily since 2015 is three thousand steps of it. For the frequencies
// whose spacing is a fixed number of days the distance can be covered in a
// single jump, landing deliberately short so the loop still walks the last few
// and the answer is identical either way.
//
// Only safe when the rule has no count: every occurrence jumped over would
// otherwise have to be counted off the remaining total.
function fastForward(ts, rule, after) {
  if (rule.count !== null || ts >= after) return ts;

  let strideDays;
  if (rule.freq === "daily") strideDays = rule.interval;
  else if (rule.freq === "weekly") strideDays = 7 * rule.interval;
  else if (rule.freq === "weekdays") {
    // Five occurrences repeating exactly weekly — but only once the series is
    // on a weekday at all, so a Saturday start is left to the loop.
    const day = new Date(ts).getDay();
    if (day === 0 || day === 6) return ts;
    strideDays = 7;
  } else return ts; // monthly and yearly are few enough steps to just walk

  const gapDays = Math.floor((after - ts) / 86_400_000);
  const strides = Math.floor(gapDays / strideDays) - 1;
  if (strides < 1) return ts;

  const jumped = addDays(new Date(ts), strides * strideDays).getTime();
  return jumped < after ? jumped : ts;
}

// The next occurrence of a task due at `due`, given the rule, that also lands
// after `after` — so completing a task that is three days overdue schedules the
// next one in the future, not in the past.
//
// Returns { due, repeat } with the rule's remaining count decremented, or null
// when the series has run out (count exhausted, or past its end date).
export function nextOccurrence(due, repeat, after = Date.now()) {
  const rule = normalizeRepeat(repeat);
  if (!rule || !Number.isFinite(due)) return null;

  let count = rule.count;
  let ts = fastForward(due, rule, after);

  for (let i = 0; i < MAX_CATCHUP; i++) {
    if (count !== null) {
      if (count <= 1) return null; // this was the last one
      count -= 1;
    }
    const next = stepDate(ts, rule);
    if (next === null) return null;
    if (rule.until !== null && next > rule.until) return null;
    ts = next;
    if (ts > after) return { due: ts, repeat: { ...rule, count } };
  }
  return null;
}

/* ---------- describing a rule ---------- */

const EVERY = {
  daily: ["Every day", "day"],
  weekly: ["Every week", "week"],
  monthly: ["Every month", "month"],
  yearly: ["Every year", "year"],
};

export function describeRepeat(repeat, { short = false } = {}) {
  const rule = normalizeRepeat(repeat);
  if (!rule) return "";

  let base;
  if (rule.freq === "weekdays") base = short ? "Weekdays" : "Every weekday";
  else if (rule.interval === 1) base = EVERY[rule.freq][0];
  else base = `Every ${rule.interval} ${EVERY[rule.freq][1]}s`;

  if (short) return base;

  if (rule.count !== null) {
    return `${base}, ${rule.count} more time${rule.count === 1 ? "" : "s"}`;
  }
  if (rule.until !== null) {
    const d = new Date(rule.until);
    return `${base} until ${d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return base;
}

/* ---------- RRULE (RFC 5545) ---------- */

// Same stamp format calendar.js writes for DTSTART, so UNTIL cannot disagree
// with it: 20261231T235900Z.
function rruleStamp(ts) {
  return new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function toRRULE(repeat) {
  const rule = normalizeRepeat(repeat);
  if (!rule) return "";

  const parts = [];
  if (rule.freq === "weekdays") {
    parts.push("FREQ=WEEKLY", `BYDAY=${WORKDAYS.join(",")}`);
  } else {
    parts.push(`FREQ=${rule.freq.toUpperCase()}`);
    if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  }
  // COUNT and UNTIL are mutually exclusive in the spec; COUNT wins here because
  // it is what the app tracks as the series runs down.
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  else if (rule.until !== null) parts.push(`UNTIL=${rruleStamp(rule.until)}`);
  return parts.join(";");
}

// Parse the RRULE of an imported event. Anything richer than this app can model
// (BYMONTHDAY lists, BYSETPOS, odd BYDAY sets) comes back as the plain
// frequency, which keeps the task roughly right rather than dropping it.
export function fromRRULE(text) {
  if (!text || typeof text !== "string") return null;

  const parts = {};
  for (const chunk of text.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = chunk.split("=");
    if (k && v !== undefined) parts[k.trim().toUpperCase()] = v.trim();
  }

  const freqRaw = (parts.FREQ || "").toUpperCase();
  const byday = (parts.BYDAY || "")
    .toUpperCase()
    .split(",")
    .map((s) => s.replace(/^[+-]?\d+/, "").trim()) // drop "2MO"-style ordinals
    .filter(Boolean);

  let freq;
  if (freqRaw === "DAILY") freq = "daily";
  else if (freqRaw === "WEEKLY") {
    const isWorkweek =
      byday.length === 5 && WORKDAYS.every((d) => byday.includes(d));
    freq = isWorkweek ? "weekdays" : "weekly";
  } else if (freqRaw === "MONTHLY") freq = "monthly";
  else if (freqRaw === "YEARLY") freq = "yearly";
  else return null; // SECONDLY/MINUTELY/HOURLY have no place in a todo list

  const until = parts.UNTIL ? parseRRuleUntil(parts.UNTIL) : null;

  return normalizeRepeat({
    freq,
    interval: Number(parts.INTERVAL) || 1,
    until,
    count: Number(parts.COUNT) || null,
  });
}

// UNTIL travels as 20261231T235900Z, or as a bare date 20261231.
export function parseRRuleUntil(value) {
  const m = String(value).trim().match(
    /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/,
  );
  if (!m) return null;
  const [, y, mo, d, hh = "23", mi = "59", ss = "59", z] = m;
  const nums = [Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss)];
  return z ? Date.UTC(...nums) : new Date(...nums).getTime();
}
