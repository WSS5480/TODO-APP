import { describe, it, expect, beforeEach } from "vitest";
import { renderList } from "./render.js";

let listEl, countEl;

beforeEach(() => {
  document.body.innerHTML = '<span id="c"></span><ul id="l"></ul>';
  listEl = document.getElementById("l");
  countEl = document.getElementById("c");
});

describe("renderList", () => {
  it("shows empty state", () => {
    renderList(listEl, countEl, []);
    expect(listEl.querySelector(".empty")).toBeTruthy();
    expect(countEl.textContent).toContain("0 active");
  });

  it("renders one li per item", () => {
    renderList(listEl, countEl, [
      { id: "1", title: "A", done: false, prio: "low", due: null },
      { id: "2", title: "B", done: true, prio: "med", due: null },
    ]);
    expect(listEl.querySelectorAll("li")).toHaveLength(2);
    expect(listEl.querySelectorAll("li.done")).toHaveLength(1);
  });

  it("marks overdue items", () => {
    renderList(listEl, countEl, [
      { id: "1", title: "late", done: false, prio: "high", due: Date.now() - 1000 },
    ]);
    expect(listEl.querySelector("li").classList.contains("overdue")).toBe(true);
  });

  it("shows priority pill", () => {
    renderList(listEl, countEl, [
      { id: "1", title: "x", done: false, prio: "high", due: null },
    ]);
    expect(listEl.querySelector(".pill.high").textContent).toBe("HIGH");
  });

  it("includes data-action attributes for delegation", () => {
    renderList(listEl, countEl, [
      { id: "abc", title: "x", done: false, prio: "low", due: null },
    ]);
    expect(listEl.querySelector("[data-action='toggle']").dataset.id).toBe("abc");
    expect(listEl.querySelector("[data-action='remove']").dataset.id).toBe("abc");
  });

  it("renders an edit button per row", () => {
    renderList(listEl, countEl, [
      { id: "abc", title: "x", done: false, prio: "low", due: null },
    ]);
    expect(listEl.querySelector("[data-action='edit']").dataset.id).toBe("abc");
  });

  it("renders the edited row as a form seeded with the task's values", () => {
    const due = new Date(2026, 4, 6, 14, 30).getTime();
    renderList(
      listEl,
      countEl,
      [{ id: "abc", title: "buy milk", done: false, prio: "high", due }],
      "abc",
    );

    const form = listEl.querySelector("[data-action='save-edit']");
    expect(form).toBeTruthy();
    expect(form.dataset.id).toBe("abc");
    expect(form.querySelector(".edit-title").value).toBe("buy milk");
    expect(form.querySelector(".edit-when").value).toBe("2026-05-06T14:30");
    expect(form.querySelector(".edit-prio").value).toBe("high");
    expect(listEl.querySelector("[data-action='cancel-edit']")).toBeTruthy();
    // the read-only row is replaced, not shown alongside
    expect(listEl.querySelector("[data-action='edit']")).toBeNull();
  });

  it("leaves an empty due time blank in the edit form", () => {
    renderList(
      listEl,
      countEl,
      [{ id: "abc", title: "someday", done: false, prio: "low", due: null }],
      "abc",
    );
    expect(listEl.querySelector(".edit-when").value).toBe("");
  });

  it("only puts the edited row into edit mode", () => {
    renderList(
      listEl,
      countEl,
      [
        { id: "1", title: "A", done: false, prio: "low", due: null },
        { id: "2", title: "B", done: false, prio: "low", due: null },
      ],
      "2",
    );
    expect(listEl.querySelectorAll("li.editing")).toHaveLength(1);
    expect(listEl.querySelectorAll("[data-action='edit']")).toHaveLength(1);
  });
});

describe("renderList: repeats and synced tasks", () => {
  const item = (over = {}) => ({
    id: "1",
    title: "Water the plants",
    done: false,
    prio: "med",
    due: Date.now() + 3_600_000,
    ...over,
  });

  it("shows a pill for a repeating task, with the full rule on hover", () => {
    renderList(listEl, countEl, [item({ repeat: { freq: "weekdays", interval: 1 } })]);
    const pill = listEl.querySelector(".pill.repeat");
    expect(pill.textContent).toBe("↻ Weekdays");
    expect(pill.title).toBe("Every weekday");
  });

  it("says how a counted series ends on hover", () => {
    renderList(listEl, countEl, [item({ repeat: { freq: "daily", count: 3 } })]);
    expect(listEl.querySelector(".pill.repeat").title).toBe("Every day, 3 more times");
  });

  it("shows no pill for a one-off task or a broken rule", () => {
    renderList(listEl, countEl, [item({ repeat: null }), item({ id: "2", repeat: { freq: "hourly" } })]);
    expect(listEl.querySelectorAll(".pill.repeat")).toHaveLength(0);
  });

  it("marks a task that came from the calendar", () => {
    renderList(listEl, countEl, [item({ extId: "ev-1" }), item({ id: "2" })]);
    expect(listEl.querySelectorAll(".pill.synced")).toHaveLength(1);
  });

  it("offers the repeat choices in the edit form, with the task's own selected", () => {
    renderList(listEl, countEl, [item({ repeat: { freq: "monthly", interval: 1 } })], "1");
    const select = listEl.querySelector(".edit-repeat");
    expect(select.name).toBe("repeat");
    expect(select.value).toBe("monthly");
    expect(select.querySelectorAll("option").length).toBeGreaterThan(4);
  });

  it("selects 'does not repeat' for a one-off task", () => {
    renderList(listEl, countEl, [item({ repeat: null })], "1");
    expect(listEl.querySelector(".edit-repeat").value).toBe("");
  });
});
