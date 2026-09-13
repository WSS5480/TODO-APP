// iCalendar (RFC 5545) export.
//
// A web page cannot touch the phone's calendar — iOS only exposes that to native
// apps. It can hand over an .ics file, which Calendar offers to import. That is
// worth doing for more than tidiness: a calendar alert fires when this app is
// closed, which the app's own alarms never can, because iOS suspends its timers
// the moment you leave it.

const PRODID = "-//To Do Reminder//EN";
const CRLF = "\r\n";

// Default length of the event written for a task, which has a due time but no duration.
export const EVENT_MINUTES = 30;

const PRIORITY = { high: 1, med: 5, low: 9 };

// 2026-05-06T14:30:00Z -> 20260506T143000Z. UTC keeps it unambiguous, so no
// VTIMEZONE block is needed and no calendar can misread the offset.
export function icsStamp(ts) {
  return new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Backslash, semicolon and comma are delimiters in this format, and a newline
// has to travel as a literal \n.
export function escapeText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Content lines are limited to 75 octets, continued by CRLF + one space. The
// limit counts octets, not characters, so a multi-byte character must not be
// split across the fold.
export function foldLine(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;

  const out = [];
  let chunk = "";
  let used = 0;
  let limit = 75;

  for (const ch of line) {
    const size = new TextEncoder().encode(ch).length;
    if (used + size > limit) {
      out.push(chunk);
      chunk = "";
      used = 0;
      limit = 74; // continuation lines carry a leading space
    }
    chunk += ch;
    used += size;
  }
  if (chunk) out.push(chunk);

  return out.join(CRLF + " ");
}

function alarm(trigger, description) {
  return [
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(description)}`,
    `TRIGGER:${trigger}`,
    "END:VALARM",
  ];
}

// One task as a VEVENT. leadMinutes adds a second, earlier alert mirroring the
// app's own heads-up.
export function buildEvent(item, { now = Date.now(), leadMinutes = 0 } = {}) {
  if (!item.due) return null;

  const lines = [
    "BEGIN:VEVENT",
    // Stable per task, so re-exporting updates the event rather than adding a
    // second copy in calendars that honour UID.
    `UID:${item.id}@todo-reminder`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${icsStamp(item.due)}`,
    `DTEND:${icsStamp(item.due + EVENT_MINUTES * 60_000)}`,
    `SUMMARY:${escapeText(item.title)}`,
    `PRIORITY:${PRIORITY[item.prio] ?? PRIORITY.med}`,
    `STATUS:${item.done ? "CANCELLED" : "CONFIRMED"}`,
  ];

  if (!item.done) {
    lines.push(...alarm("PT0S", item.title));
    if (leadMinutes > 0) {
      lines.push(...alarm(`-PT${Math.round(leadMinutes)}M`, `Soon: ${item.title}`));
    }
  }

  lines.push("END:VEVENT");
  return lines;
}

// Wrap events in a VCALENDAR. Tasks with no due time have nothing to schedule
// and are skipped.
export function buildCalendar(items, { now = Date.now(), leadMinutes = 0 } = {}) {
  const events = items
    .map((item) => buildEvent(item, { now, leadMinutes }))
    .filter(Boolean)
    .flat();

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events,
    "END:VCALENDAR",
  ];

  return lines.map(foldLine).join(CRLF) + CRLF;
}

export function countExportable(items) {
  return items.filter((it) => it.due).length;
}

// A filename the phone will show when opening the file.
export function icsFilename(title) {
  const slug = String(title || "tasks")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "tasks"}.ics`;
}
