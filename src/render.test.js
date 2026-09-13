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
