import { describe, it, expect } from "vitest";
import {
  unfold,
  unescapeText,
  parseLine,
  parseDate,
  zonedToTimestamp,
  parseIcs,
  eventsToTasks,
  tasksFromIcs,
  ALL_DAY_HOUR,
} from "./icsparse.js";
import { buildCalendar } from "./calendar.js";

const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
const parts = (ts) => {
  const d = new Date(ts);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};

const wrap = (body) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", body, "END:VCALENDAR"].join("\r\n");

describe("unfold", () => {
  it("joins continuation lines split with a space or a tab", () => {
    expect(unfold("SUMMARY:Long\r\n  rest")).toBe("SUMMARY:Long rest");
    expect(unfold("SUMMARY:Long\n\trest")).toBe("SUMMARY:Longrest");
  });

  it("leaves ordinary lines alone", () => {
    expect(unfold("A:1\r\nB:2")).toBe("A:1\nB:2");
  });
});

describe("unescapeText", () => {
  it("reverses the escaping the exporter applies", () => {
    expect(unescapeText("a\\, b\\; c\\nd")).toBe("a, b; c\nd");
    expect(unescapeText("back\\\\slash")).toBe("back\\slash");
    // a literal backslash before an n must not become a newline
    expect(unescapeText("back\\\\nope")).toBe("back\\nope");
  });
});

describe("parseLine", () => {
  it("splits name, parameters and value", () => {
    expect(parseLine("SUMMARY:Call the bank")).toEqual({
      name: "SUMMARY",
      params: {},
      value: "Call the bank",
    });
    expect(parseLine("DTSTART;TZID=America/Chicago:20260506T143000")).toEqual({
      name: "DTSTART",
      params: { TZID: "America/Chicago" },
      value: "20260506T143000",
    });
  });

  it("ignores a colon inside a quoted parameter", () => {
    const line = 'DTSTART;TZID="Weird:Zone":20260506T143000';
    expect(parseLine(line).params.TZID).toBe("Weird:Zone");
    expect(parseLine(line).value).toBe("20260506T143000");
  });

  it("returns null for a line with no value", () => {
    expect(parseLine("JUNK")).toBeNull();
  });
});

describe("parseDate", () => {
  it("reads UTC", () => {
    expect(parseDate("20260506T143000Z")).toEqual({
      ts: Date.UTC(2026, 4, 6, 14, 30, 0),
      allDay: false,
    });
  });

  it("reads floating local time", () => {
    expect(parseDate("20260506T143000")).toEqual({ ts: at(2026, 5, 6, 14, 30), allDay: false });
  });

  it("reads a named zone", () => {
    // 14:30 in Chicago on that date is 19:30 UTC (CDT, UTC-5)
    const { ts } = parseDate("20260506T143000", { TZID: "America/Chicago" });
    expect(ts).toBe(Date.UTC(2026, 4, 6, 19, 30, 0));
  });

  it("falls back to local time for a zone it does not know", () => {
    const { ts } = parseDate("20260506T143000", { TZID: "Mars/Olympus" });
    expect(ts).toBe(at(2026, 5, 6, 14, 30));
  });

  it("gives an all-day event a morning time rather than midnight", () => {
    const got = parseDate("20260506", { VALUE: "DATE" });
    expect(got.allDay).toBe(true);
    expect(parts(got.ts)).toEqual([2026, 5, 6, ALL_DAY_HOUR, 0]);
  });

  it("returns null for something that is not a date", () => {
    expect(parseDate("later")).toBeNull();
  });
});

describe("zonedToTimestamp", () => {
  it("resolves both sides of a daylight-saving change", () => {
    // US clocks go forward on 2026-03-08: 1:30am is CST (-6), 3:30am is CDT (-5)
    expect(zonedToTimestamp(2026, 3, 8, 1, 30, 0, "America/Chicago")).toBe(Date.UTC(2026, 2, 8, 7, 30));
    expect(zonedToTimestamp(2026, 3, 8, 3, 30, 0, "America/Chicago")).toBe(Date.UTC(2026, 2, 8, 8, 30));
  });
});

describe("parseIcs", () => {
  it("reads an event", () => {
    const { events } = parseIcs(
      wrap(
        [
          "BEGIN:VEVENT",
          "UID:abc-123",
          "SUMMARY:Dentist",
          "DTSTART:20260506T143000Z",
          "END:VEVENT",
        ].join("\r\n"),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ uid: "abc-123", title: "Dentist", allDay: false });
    expect(events[0].due).toBe(Date.UTC(2026, 4, 6, 14, 30));
  });

  it("does not take DTSTART from a VTIMEZONE block", () => {
    const text = wrap(
      [
        "BEGIN:VTIMEZONE",
        "TZID:America/Chicago",
        "BEGIN:DAYLIGHT",
        "DTSTART:19700308T020000",
        "TZOFFSETFROM:-0600",
        "END:DAYLIGHT",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        "UID:real",
        "SUMMARY:The actual event",
        "DTSTART:20260506T143000Z",
        "END:VEVENT",
      ].join("\r\n"),
    );
    const { events } = parseIcs(text);
    expect(events).toHaveLength(1);
    expect(events[0].uid).toBe("real");
    expect(events[0].due).toBe(Date.UTC(2026, 4, 6, 14, 30));
  });

  it("does not take a SUMMARY from a VALARM", () => {
    const text = wrap(
      [
        "BEGIN:VEVENT",
        "UID:x",
        "SUMMARY:Pay rent",
        "DTSTART:20260506T143000Z",
        "BEGIN:VALARM",
        "ACTION:EMAIL",
        "SUMMARY:Alarm subject line",
        "TRIGGER:-PT15M",
        "END:VALARM",
        "END:VEVENT",
      ].join("\r\n"),
    );
    const { events } = parseIcs(text);
    expect(events[0].title).toBe("Pay rent");
  });

  it("reads a repeat rule and the calendar's name", () => {
    const text = wrap(
      [
        "X-WR-CALNAME:Steve's calendar",
        "BEGIN:VEVENT",
        "UID:r1",
        "SUMMARY:Standup",
        "DTSTART:20260504T140000Z",
        "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
        "END:VEVENT",
      ].join("\r\n"),
    );
    const { events, calendarName } = parseIcs(text);
    expect(calendarName).toBe("Steve's calendar");
    expect(events[0].repeat).toMatchObject({ freq: "weekdays", interval: 1 });
  });

  it("flags a cancelled event and skips one with no start", () => {
    const text = wrap(
      [
        "BEGIN:VEVENT",
        "UID:c1",
        "SUMMARY:Called off",
        "DTSTART:20260506T143000Z",
        "STATUS:CANCELLED",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:c2",
        "SUMMARY:No start at all",
        "END:VEVENT",
      ].join("\r\n"),
    );
    const { events } = parseIcs(text);
    expect(events).toHaveLength(1);
    expect(events[0].cancelled).toBe(true);
  });

  it("survives junk without throwing", () => {
    expect(parseIcs("").events).toEqual([]);
    expect(parseIcs("not a calendar at all").events).toEqual([]);
  });
});

describe("eventsToTasks", () => {
  const now = at(2026, 5, 6, 12, 0);

  it("keeps what is still ahead and drops old history", () => {
    const events = [
      { uid: "past", title: "Last year", due: at(2025, 5, 6, 9, 0), allDay: false, repeat: null, cancelled: false },
      { uid: "soon", title: "Tomorrow", due: at(2026, 5, 7, 9, 0), allDay: false, repeat: null, cancelled: false },
    ];
    const tasks = eventsToTasks(events, { now });
    expect(tasks.map((t) => t.extId)).toEqual(["soon"]);
  });

  it("keeps an event from earlier today", () => {
    const events = [
      { uid: "am", title: "This morning", due: at(2026, 5, 6, 8, 0), allDay: false, repeat: null, cancelled: false },
    ];
    expect(eventsToTasks(events, { now })).toHaveLength(1);
  });

  it("rolls an old repeating series forward instead of dropping it", () => {
    const events = [
      {
        uid: "standup",
        title: "Standup",
        due: at(2024, 1, 1, 9, 0),
        allDay: false,
        repeat: { freq: "daily", interval: 1, until: null, count: null },
        cancelled: false,
      },
    ];
    const [task] = eventsToTasks(events, { now });
    expect(parts(task.due)).toEqual([2026, 5, 6, 9, 0]); // today's one
    expect(task.repeat.freq).toBe("daily");
  });

  it("drops a repeating series that has already finished", () => {
    const events = [
      {
        uid: "done",
        title: "Old standup",
        due: at(2024, 1, 1, 9, 0),
        allDay: false,
        repeat: { freq: "daily", interval: 1, until: at(2024, 1, 10), count: null },
        cancelled: false,
      },
    ];
    expect(eventsToTasks(events, { now })).toEqual([]);
  });

  it("skips cancelled events and caps how many come in", () => {
    const events = [
      { uid: "x", title: "Off", due: at(2026, 5, 7), allDay: false, repeat: null, cancelled: true },
      ...Array.from({ length: 10 }, (_, i) => ({
        uid: `e${i}`,
        title: `Event ${i}`,
        due: at(2026, 5, 8, 9, 0),
        allDay: false,
        repeat: null,
        cancelled: false,
      })),
    ];
    const tasks = eventsToTasks(events, { now, max: 4 });
    expect(tasks).toHaveLength(4);
    expect(tasks.every((t) => t.title !== "Off")).toBe(true);
  });

  it("falls back to a title and an id when the event has neither", () => {
    const events = [
      { uid: "", title: "", due: at(2026, 5, 8, 9, 0), allDay: false, repeat: null, cancelled: false },
    ];
    const [task] = eventsToTasks(events, { now });
    expect(task.title).toBe("(untitled event)");
    expect(task.extId).toContain("@");
  });
});

describe("round trip with the exporter", () => {
  it("reads back what calendar.js writes, repeat and all", () => {
    const now = at(2026, 5, 1, 8, 0);
    const items = [
      { id: "t1", title: "Pay rent; and, note\\this", due: at(2026, 5, 6, 9, 0), prio: "high", done: false, repeat: null },
      {
        id: "t2",
        title: "Standup",
        due: at(2026, 5, 7, 9, 30),
        prio: "med",
        done: false,
        repeat: { freq: "weekdays", interval: 1, until: null, count: null },
      },
    ];
    const text = buildCalendar(items, { now, leadMinutes: 10 });
    const { tasks } = tasksFromIcs(text, { now });

    expect(tasks).toHaveLength(2);
    const [rent, standup] = tasks;
    expect(rent.title).toBe("Pay rent; and, note\\this");
    expect(rent.due).toBe(items[0].due);
    expect(standup.repeat).toMatchObject({ freq: "weekdays" });
    expect(standup.due).toBe(items[1].due);
  });
});

describe("eventsToTasks: the one-off import of everything", () => {
  const now = at(2026, 5, 6, 12, 0);
  const ev = (over = {}) => ({
    uid: "e1",
    title: "Thing",
    due: at(2026, 5, 7, 9, 0),
    allDay: false,
    repeat: null,
    cancelled: false,
    ...over,
  });

  it("reaches back past today when asked", () => {
    const events = [
      ev({ uid: "old", title: "Last year", due: at(2025, 5, 6, 9, 0) }),
      ev({ uid: "ancient", title: "Years ago", due: at(2019, 1, 2, 14, 0) }),
      ev({ uid: "soon", title: "Tomorrow" }),
    ];
    const tasks = eventsToTasks(events, { now, includePast: true });
    expect(tasks.map((t) => t.extId)).toEqual(["old", "ancient", "soon"]);
  });

  it("brings history in already ticked off, and leaves what is ahead open", () => {
    const events = [
      ev({ uid: "past", due: at(2025, 5, 6, 9, 0) }),
      ev({ uid: "earlier-today", due: at(2026, 5, 6, 8, 0) }),
      ev({ uid: "ahead" }),
    ];
    const tasks = eventsToTasks(events, { now, includePast: true });
    expect(tasks.map((t) => [t.extId, t.done])).toEqual([
      ["past", true],
      // earlier today still counts as today, not history
      ["earlier-today", false],
      ["ahead", false],
    ]);
  });

  it("still brings a repeating series in at its next occurrence, not as history", () => {
    const events = [
      ev({
        uid: "standup",
        title: "Standup",
        due: at(2019, 1, 2, 9, 0),
        repeat: { freq: "daily", interval: 1, until: null, count: null },
      }),
    ];
    const [task] = eventsToTasks(events, { now, includePast: true });
    expect(parts(task.due)).toEqual([2026, 5, 6, 9, 0]);
    expect(task.done).toBe(false);
    expect(task.repeat.freq).toBe("daily");
  });

  it("drops a repeating series that finished, however far the import reaches", () => {
    const events = [
      ev({
        uid: "finished",
        due: at(2019, 1, 2, 9, 0),
        repeat: { freq: "daily", interval: 1, until: at(2019, 2, 1), count: null },
      }),
    ];
    expect(eventsToTasks(events, { now, includePast: true })).toEqual([]);
  });

  it("leaves history behind by default, as a routine pull should", () => {
    const events = [ev({ uid: "past", due: at(2025, 5, 6, 9, 0) }), ev({ uid: "ahead" })];
    expect(eventsToTasks(events, { now }).map((t) => t.extId)).toEqual(["ahead"]);
    expect(eventsToTasks(events, { now })[0].done).toBe(false);
  });

  it("still stops at the cap", () => {
    const events = Array.from({ length: 40 }, (_, i) =>
      ev({ uid: `e${i}`, due: at(2019, 1, 2, 9, 0) + i * 86_400_000 }),
    );
    expect(eventsToTasks(events, { now, includePast: true, max: 7 })).toHaveLength(7);
  });

  it("skips a cancelled event even when reaching into the past", () => {
    const events = [ev({ uid: "off", due: at(2025, 5, 6), cancelled: true })];
    expect(eventsToTasks(events, { now, includePast: true })).toEqual([]);
  });
});
