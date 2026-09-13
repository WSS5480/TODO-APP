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
});
