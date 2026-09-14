import { describe, it, expect } from "vitest";
import {
  icsStamp, escapeText, foldLine, buildEvent, buildCalendar, countExportable,
  icsFilename, EVENT_MINUTES,
} from "./calendar.js";

const task = (over = {}) => ({
  id: "abc123",
  title: "Buy milk",
  due: Date.UTC(2026, 4, 6, 14, 30),
  prio: "med",
  done: false,
  ...over,
});

describe("icsStamp", () => {
  it("formats UTC basic-format timestamps", () => {
    expect(icsStamp(Date.UTC(2026, 4, 6, 14, 30, 5))).toBe("20260506T143005Z");
  });

  it("pads single digits", () => {
    expect(icsStamp(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("20260102T030405Z");
  });
});

describe("escapeText", () => {
  it("escapes the delimiters the format reserves", () => {
    expect(escapeText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
  });

  it("turns newlines into a literal \\n", () => {
    expect(escapeText("one\ntwo")).toBe("one\\ntwo");
    expect(escapeText("one\r\ntwo")).toBe("one\\ntwo");
  });

  it("escapes the backslash first, not twice", () => {
    // a naive ordering would turn "\," into "\\\\," and corrupt the line
    expect(escapeText("\\,")).toBe("\\\\\\,");
  });
});

describe("foldLine", () => {
  it("leaves short lines alone", () => {
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("folds long lines with CRLF and a leading space", () => {
    const folded = foldLine("SUMMARY:" + "x".repeat(200));
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].length).toBeLessThanOrEqual(75);
    for (const part of parts.slice(1)) {
      expect(part.startsWith(" ")).toBe(true);
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
    // unfolding restores the original
    expect(folded.split("\r\n ").join("")).toBe("SUMMARY:" + "x".repeat(200));
  });

  it("never splits a multi-byte character across the fold", () => {
    const folded = foldLine("SUMMARY:" + "😀".repeat(40));
    for (const part of folded.split("\r\n")) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
      expect(part.includes("�")).toBe(false);
    }
    expect(folded.split("\r\n ").join("")).toBe("SUMMARY:" + "😀".repeat(40));
  });
});

describe("buildEvent", () => {
  it("writes the core fields", () => {
    const lines = buildEvent(task(), { now: Date.UTC(2026, 4, 1) });
    expect(lines[0]).toBe("BEGIN:VEVENT");
    expect(lines.at(-1)).toBe("END:VEVENT");
    expect(lines).toContain("UID:abc123@todo-reminder");
    expect(lines).toContain("DTSTART:20260506T143000Z");
    expect(lines).toContain("SUMMARY:Buy milk");
  });

  it("gives the event a duration, since a task only has a due time", () => {
    const lines = buildEvent(task(), {});
    const end = Date.UTC(2026, 4, 6, 14, 30) + EVENT_MINUTES * 60_000;
    expect(lines).toContain(`DTEND:${icsStamp(end)}`);
  });

  it("attaches an alarm at the due time", () => {
    const lines = buildEvent(task(), {});
    expect(lines).toContain("BEGIN:VALARM");
    expect(lines).toContain("TRIGGER:PT0S");
  });

  it("adds a second, earlier alarm for the heads-up", () => {
    const lines = buildEvent(task(), { leadMinutes: 10 });
    expect(lines).toContain("TRIGGER:-PT10M");
    expect(lines.filter((l) => l === "BEGIN:VALARM")).toHaveLength(2);
  });

  it("skips alarms for a task already done, and marks it cancelled", () => {
    const lines = buildEvent(task({ done: true }), { leadMinutes: 10 });
    expect(lines).toContain("STATUS:CANCELLED");
    expect(lines).not.toContain("BEGIN:VALARM");
  });

  it("maps priority", () => {
    expect(buildEvent(task({ prio: "high" }), {})).toContain("PRIORITY:1");
    expect(buildEvent(task({ prio: "low" }), {})).toContain("PRIORITY:9");
    expect(buildEvent(task({ prio: "nonsense" }), {})).toContain("PRIORITY:5");
  });

  it("returns nothing for a task with no due time", () => {
    expect(buildEvent(task({ due: null }), {})).toBeNull();
  });

  it("keeps the same UID across exports so a re-export updates in place", () => {
    const a = buildEvent(task(), { now: 1 });
    const b = buildEvent(task({ title: "Buy oat milk" }), { now: 2 });
    const uid = (l) => l.find((x) => x.startsWith("UID:"));
    expect(uid(a)).toBe(uid(b));
  });
});

describe("buildCalendar", () => {
  it("wraps events and uses CRLF throughout", () => {
    const ics = buildCalendar([task()], {});
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0");
    expect(ics.split("\n").every((l) => l === "" || l.endsWith("\r"))).toBe(true);
  });

  it("includes every task that has a due time and skips the rest", () => {
    const ics = buildCalendar(
      [task({ id: "a" }), task({ id: "b", due: null }), task({ id: "c" })],
      {},
    );
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain("UID:a@todo-reminder");
    expect(ics).not.toContain("UID:b@todo-reminder");
  });

  it("produces a valid empty calendar when nothing is schedulable", () => {
    const ics = buildCalendar([task({ due: null })], {});
    expect(ics).not.toContain("BEGIN:VEVENT");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("escapes a title that would otherwise break the format", () => {
    const ics = buildCalendar([task({ title: "Pay, then; call\nBob" })], {});
    expect(ics).toContain("SUMMARY:Pay\\, then\\; call\\nBob");
  });
});

describe("countExportable", () => {
  it("counts only tasks with a due time", () => {
    expect(countExportable([task(), task({ due: null }), task()])).toBe(2);
  });
});

describe("icsFilename", () => {
  it("slugifies the title", () => {
    expect(icsFilename("Buy Milk!")).toBe("buy-milk.ics");
  });

  it("falls back when nothing usable is left", () => {
    expect(icsFilename("!!!")).toBe("tasks.ics");
    expect(icsFilename("")).toBe("tasks.ics");
  });

  it("keeps the name a sane length", () => {
    expect(icsFilename("x".repeat(200)).length).toBeLessThanOrEqual(44);
  });
});
