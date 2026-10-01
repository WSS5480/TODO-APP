import { describe, it, expect } from "vitest";
import {
  normalizeRepeat,
  isRepeating,
  stepDate,
  nextOccurrence,
  describeRepeat,
  toRRULE,
  fromRRULE,
  parseRRuleUntil,
} from "./recur.js";

// Local-time helper: the engine walks calendar fields, so the tests have to
// build their dates the same way rather than from UTC strings.
const at = (y, m, d, hh = 9, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
const parts = (ts) => {
  const d = new Date(ts);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};

describe("normalizeRepeat", () => {
  it("accepts a bare frequency string", () => {
    expect(normalizeRepeat("daily")).toEqual({ freq: "daily", interval: 1, until: null, count: null });
  });

  it("returns null for nothing, junk and unknown frequencies", () => {
    expect(normalizeRepeat(null)).toBeNull();
    expect(normalizeRepeat("")).toBeNull();
    expect(normalizeRepeat("hourly")).toBeNull();
    expect(normalizeRepeat({ freq: "fortnightly" })).toBeNull();
  });

  it("clamps the interval and forces weekdays to every week", () => {
    expect(normalizeRepeat({ freq: "daily", interval: 0 }).interval).toBe(1);
    expect(normalizeRepeat({ freq: "daily", interval: 2.6 }).interval).toBe(3);
    expect(normalizeRepeat({ freq: "daily", interval: 10_000 }).interval).toBe(999);
    expect(normalizeRepeat({ freq: "weekdays", interval: 4 }).interval).toBe(1);
  });

  it("keeps a usable count and drops a meaningless one", () => {
    expect(normalizeRepeat({ freq: "daily", count: 3 }).count).toBe(3);
    expect(normalizeRepeat({ freq: "daily", count: 0 }).count).toBeNull();
    expect(normalizeRepeat({ freq: "daily", count: "x" }).count).toBeNull();
  });

  it("isRepeating only accepts a real rule", () => {
    expect(isRepeating(normalizeRepeat("weekly"))).toBe(true);
    expect(isRepeating(null)).toBe(false);
    expect(isRepeating({ freq: "nope" })).toBe(false);
  });
});

describe("stepDate", () => {
  it("steps a day, a week and an interval", () => {
    expect(parts(stepDate(at(2026, 3, 10), "daily"))).toEqual([2026, 3, 11, 9, 0]);
    expect(parts(stepDate(at(2026, 3, 10), "weekly"))).toEqual([2026, 3, 17, 9, 0]);
    expect(parts(stepDate(at(2026, 3, 10), { freq: "daily", interval: 3 }))).toEqual([2026, 3, 13, 9, 0]);
  });

  it("keeps the wall-clock time, so a 9am task stays 9am", () => {
    // Stepping by calendar fields rather than by +24h is what survives a clock
    // change; the hour must be identical on both sides of any step.
    let ts = at(2026, 3, 1, 9, 30);
    for (let i = 0; i < 400; i++) {
      ts = stepDate(ts, "daily");
      const [, , , hh, mm] = parts(ts);
      expect([hh, mm]).toEqual([9, 30]);
    }
  });

  it("jumps the weekend for weekdays", () => {
    // 2026-03-13 is a Friday
    expect(new Date(at(2026, 3, 13)).getDay()).toBe(5);
    expect(parts(stepDate(at(2026, 3, 13), "weekdays"))).toEqual([2026, 3, 16, 9, 0]);
    expect(parts(stepDate(at(2026, 3, 16), "weekdays"))).toEqual([2026, 3, 17, 9, 0]);
  });

  it("skips months that have no such day, as a calendar does", () => {
    // the 31st: January to March, never February
    expect(parts(stepDate(at(2026, 1, 31), "monthly"))).toEqual([2026, 3, 31, 9, 0]);
    expect(parts(stepDate(at(2026, 3, 31), "monthly"))).toEqual([2026, 5, 31, 9, 0]);
    // a normal day is untouched by that rule
    expect(parts(stepDate(at(2026, 1, 15), "monthly"))).toEqual([2026, 2, 15, 9, 0]);
  });

  it("holds Feb 29 to leap years", () => {
    expect(parts(stepDate(at(2028, 2, 29), "yearly"))).toEqual([2032, 2, 29, 9, 0]);
  });

  it("returns null without a rule", () => {
    expect(stepDate(at(2026, 3, 10), null)).toBeNull();
  });
});

describe("nextOccurrence", () => {
  const due = at(2026, 3, 10, 9, 0);

  it("moves to the next date after now", () => {
    const next = nextOccurrence(due, "daily", at(2026, 3, 10, 9, 5));
    expect(parts(next.due)).toEqual([2026, 3, 11, 9, 0]);
  });

  it("catches up past an overdue task instead of landing in the past", () => {
    // four days late: the next one is tomorrow, not four days ago
    const next = nextOccurrence(due, "daily", at(2026, 3, 14, 10, 0));
    expect(parts(next.due)).toEqual([2026, 3, 15, 9, 0]);
  });

  it("counts down the remaining occurrences", () => {
    const first = nextOccurrence(due, { freq: "daily", count: 3 }, due);
    expect(first.repeat.count).toBe(2);
    const second = nextOccurrence(first.due, first.repeat, first.due);
    expect(second.repeat.count).toBe(1);
    expect(nextOccurrence(second.due, second.repeat, second.due)).toBeNull();
  });

  it("consumes a count for each occurrence skipped while catching up", () => {
    // Four left from the 10th covers the 10th, 11th, 12th and 13th. Two days
    // late, the next one owed is the 13th and it is the last of the series.
    const next = nextOccurrence(due, { freq: "daily", count: 4 }, at(2026, 3, 12, 10, 0));
    expect(parts(next.due)).toEqual([2026, 3, 13, 9, 0]);
    expect(next.repeat.count).toBe(1);
  });

  it("ends the series when catching up uses up every remaining occurrence", () => {
    // Three left from the 10th runs out on the 12th, which has already passed.
    expect(nextOccurrence(due, { freq: "daily", count: 3 }, at(2026, 3, 12, 10, 0))).toBeNull();
  });

  it("stops at the end date", () => {
    const until = at(2026, 3, 12, 23, 59);
    const a = nextOccurrence(due, { freq: "daily", until }, due);
    expect(parts(a.due)).toEqual([2026, 3, 11, 9, 0]);
    const b = nextOccurrence(a.due, a.repeat, a.due);
    expect(parts(b.due)).toEqual([2026, 3, 12, 9, 0]);
    expect(nextOccurrence(b.due, b.repeat, b.due)).toBeNull();
  });

  it("returns null without a rule or a due time", () => {
    expect(nextOccurrence(due, null, due)).toBeNull();
    expect(nextOccurrence(null, "daily", Date.now())).toBeNull();
  });
});

describe("describeRepeat", () => {
  it("describes the plain rules", () => {
    expect(describeRepeat("daily")).toBe("Every day");
    expect(describeRepeat("weekdays")).toBe("Every weekday");
    expect(describeRepeat({ freq: "weekly", interval: 2 })).toBe("Every 2 weeks");
    expect(describeRepeat(null)).toBe("");
  });

  it("mentions how the series ends", () => {
    expect(describeRepeat({ freq: "daily", count: 3 })).toBe("Every day, 3 more times");
    expect(describeRepeat({ freq: "daily", count: 1 })).toBe("Every day, 1 more time");
    expect(describeRepeat({ freq: "weekly", until: at(2026, 12, 1) })).toMatch(/^Every week until /);
  });

  it("has a short form for the row pill", () => {
    expect(describeRepeat({ freq: "daily", count: 3 }, { short: true })).toBe("Every day");
    expect(describeRepeat("weekdays", { short: true })).toBe("Weekdays");
  });
});

describe("RRULE", () => {
  it("writes the frequencies a calendar expects", () => {
    expect(toRRULE("daily")).toBe("FREQ=DAILY");
    expect(toRRULE({ freq: "daily", interval: 3 })).toBe("FREQ=DAILY;INTERVAL=3");
    expect(toRRULE("weekdays")).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    expect(toRRULE("monthly")).toBe("FREQ=MONTHLY");
    expect(toRRULE(null)).toBe("");
  });

  it("writes COUNT or UNTIL, never both", () => {
    expect(toRRULE({ freq: "daily", count: 4 })).toBe("FREQ=DAILY;COUNT=4");
    const until = Date.UTC(2026, 11, 31, 23, 59, 0);
    expect(toRRULE({ freq: "daily", until })).toBe("FREQ=DAILY;UNTIL=20261231T235900Z");
    const both = toRRULE({ freq: "daily", count: 4, until });
    expect(both).toContain("COUNT=4");
    expect(both).not.toContain("UNTIL");
  });

  it("reads back what it writes", () => {
    for (const rule of [
      "daily",
      "weekdays",
      "weekly",
      "monthly",
      "yearly",
      { freq: "weekly", interval: 2 },
      { freq: "daily", count: 5 },
    ]) {
      expect(fromRRULE(toRRULE(rule))).toEqual(normalizeRepeat(rule));
    }
  });

  it("reads rules written by other calendars", () => {
    expect(fromRRULE("RRULE:FREQ=DAILY;INTERVAL=2")).toEqual(normalizeRepeat({ freq: "daily", interval: 2 }));
    expect(fromRRULE("FREQ=WEEKLY;BYDAY=MO,WE,FR").freq).toBe("weekly"); // not the work week
    expect(fromRRULE("FREQ=WEEKLY;BYDAY=FR,TH,WE,TU,MO").freq).toBe("weekdays"); // order is irrelevant
    expect(fromRRULE("FREQ=MONTHLY;BYDAY=2MO").freq).toBe("monthly"); // ordinal weekday: close enough
    expect(fromRRULE("FREQ=HOURLY")).toBeNull();
    expect(fromRRULE("")).toBeNull();
    expect(fromRRULE(undefined)).toBeNull();
  });

  it("parses UNTIL in both shapes", () => {
    expect(parseRRuleUntil("20261231T235900Z")).toBe(Date.UTC(2026, 11, 31, 23, 59, 0));
    expect(parseRRuleUntil("20261231")).toBe(at(2026, 12, 31, 23, 59) + 59_000);
    expect(parseRRuleUntil("nonsense")).toBeNull();
  });
});
