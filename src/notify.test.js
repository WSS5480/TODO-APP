import { describe, it, expect, beforeEach, vi } from "vitest";
import { toast } from "./notify.js";

beforeEach(() => { document.body.innerHTML = ""; });

describe("toast", () => {
  it("renders plain text and auto-removes", () => {
    vi.useFakeTimers();
    const t = toast("hello", { timeout: 1000 });
    expect(document.querySelector("#toasts .toast")).toBe(t);
    expect(t.textContent).toBe("hello");
    vi.advanceTimersByTime(1001);
    expect(document.querySelector(".toast")).toBeNull();
    vi.useRealTimers();
  });

  it("renders action buttons, runs the handler, then closes", () => {
    const onClick = vi.fn();
    const t = toast("due", { actions: [{ label: "Snooze", onClick }, { label: "Done", primary: true }] });
    const btns = t.querySelectorAll("button");
    expect([...btns].map((b) => b.textContent)).toEqual(["Snooze", "Done"]);
    expect(btns[0].classList.contains("ghost")).toBe(true);
    expect(btns[1].classList.contains("ghost")).toBe(false);
    btns[0].click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".toast")).toBeNull();
  });
});
