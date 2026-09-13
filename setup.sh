#!/usr/bin/env bash
set -e

REPO="todo-reminder"
mkdir -p "$REPO" && cd "$REPO"
mkdir -p src public .github/workflows

# ---------------- .gitignore ----------------
cat > .gitignore <<'EOF'
node_modules/
dist/
.DS_Store
Thumbs.db
*.log
.vscode/
.idea/
coverage/
EOF

# ---------------- LICENSE ----------------
YEAR=$(date +%Y)
cat > LICENSE <<EOF
MIT License

Copyright (c) $YEAR

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF

# ---------------- package.json ----------------
cat > package.json <<'EOF'
{
  "name": "todo-reminder",
  "version": "1.0.0",
  "description": "A simple, dependency-free todo app with due-time reminders.",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "coverage": "vitest run --coverage"
  },
  "keywords": ["todo", "reminder", "vite", "vanilla-js"],
  "license": "MIT",
  "devDependencies": {
    "@vitest/coverage-v8": "^1.6.0",
    "jsdom": "^24.0.0",
    "vite": "^5.2.0",
    "vitest": "^1.6.0"
  }
}
EOF

# ---------------- vite.config.js ----------------
cat > vite.config.js <<'EOF'
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  test: {
    environment: "jsdom",
    globals: true,
    coverage: {
      reporter: ["text", "html"],
      include: ["src/**/*.js"],
      exclude: ["src/**/*.test.js", "src/main.js"],
    },
  },
});
EOF

# ---------------- index.html ----------------
cat > index.html <<'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <title>Todo Reminder</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="app">
    <h1>Todo Reminder</h1>
    <div class="sub">Local-only. Reminders fire while this tab is open.</div>
    <form id="form">
      <input id="task" type="text" placeholder="What needs doing?" required maxlength="200" />
      <input id="when" type="datetime-local" title="Due date & time (optional)" />
      <select id="prio" title="Priority">
        <option value="low">Low</option>
        <option value="med" selected>Medium</option>
        <option value="high">High</option>
      </select>
      <button type="submit">Add</button>
    </form>
    <div class="toolbar">
      <span id="count">0 active</span>
      <span>
        <button class="ghost" id="notifyBtn" type="button">Enable notifications</button>
        <button class="ghost" id="clearBtn" type="button">Clear done</button>
      </span>
    </div>
    <ul id="list"></ul>
  </div>
  <script type="module" src="/src/main.js"></script>
</body>
</html>
EOF

# ---------------- styles.css ----------------
cat > styles.css <<'EOF'
:root {
  --bg: #0f1115;
  --card: #181b22;
  --border: #2a2f3a;
  --text: #e8eaed;
  --muted: #8b93a1;
  --accent: #4f8cff;
  --danger: #ff5c5c;
  --warn: #ffb020;
  --ok: #35c46b;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  display: flex;
  justify-content: center;
  padding: 24px 16px 64px;
}
.app { width: 100%; max-width: 560px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
.sub { color: var(--muted); font-size: .85rem; margin-bottom: 20px; }
form {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 8px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 16px;
}
input, select, button {
  font: inherit;
  color: var(--text);
  background: #11141a;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  outline: none;
}
input:focus, select:focus { border-color: var(--accent); }
#task { grid-column: 1 / -1; }
button {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  cursor: pointer;
  font-weight: 600;
}
button:hover { filter: brightness(1.1); }
button.ghost {
  background: transparent;
  color: var(--muted);
  border-color: var(--border);
  font-weight: 500;
}
ul { list-style: none; padding: 0; margin: 0; }
li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 8px;
  transition: opacity .2s;
}
li.done { opacity: .45; }
li.done .title { text-decoration: line-through; }
li.overdue { border-color: var(--danger); }
li.due-soon { border-color: var(--warn); }
.check {
  width: 20px; height: 20px;
  margin-top: 2px;
  cursor: pointer;
  accent-color: var(--ok);
  flex-shrink: 0;
}
.body { flex: 1; min-width: 0; }
.title { word-break: break-word; }
.meta {
  font-size: .78rem;
  color: var(--muted);
  margin-top: 4px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.pill {
  padding: 1px 7px;
  border-radius: 99px;
  border: 1px solid var(--border);
  font-size: .72rem;
}
.pill.high { color: var(--danger); border-color: var(--danger); }
.pill.med  { color: var(--warn);   border-color: var(--warn); }
.pill.low  { color: var(--ok);     border-color: var(--ok); }
.pill.overdue { color: var(--danger); border-color: var(--danger); }
.del {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 1.1rem;
  padding: 0 4px;
}
.del:hover { color: var(--danger); }
.empty {
  text-align: center;
  color: var(--muted);
  padding: 32px 0;
  font-size: .9rem;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: .82rem;
  color: var(--muted);
}
EOF

# ---------------- public/favicon.svg ----------------
cat > public/favicon.svg <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#4f8cff"/>
  <path d="M18 34l9 9 20-22" stroke="#fff" stroke-width="6" fill="none"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>
EOF

# ---------------- src/store.js ----------------
cat > src/store.js <<'EOF'
export const STORAGE_KEY = "todo-reminder.items.v1";

export function load(storage = globalThis.localStorage) {
  try {
    return JSON.parse(storage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

export function save(items, storage = globalThis.localStorage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function addItem(items, { title, due, prio }) {
  const t = title.trim();
  if (!t) return items;
  return [
    ...items,
    {
      id: uid(),
      title: t,
      due: due ? new Date(due).getTime() : null,
      prio: prio || "med",
      done: false,
      createdAt: Date.now(),
    },
  ];
}

export function toggleItem(items, id) {
  return items.map((it) => (it.id === id ? { ...it, done: !it.done } : it));
}

export function removeItem(items, id) {
  return items.filter((it) => it.id !== id);
}

export function clearDone(items) {
  return items.filter((it) => !it.done);
}

const PRIO_RANK = { high: 0, med: 1, low: 2 };

export function sortItems(items) {
  return [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ad = a.due ?? Infinity;
    const bd = b.due ?? Infinity;
    if (ad !== bd) return ad - bd;
    return PRIO_RANK[a.prio] - PRIO_RANK[b.prio];
  });
}

export function dueClass(item, now = Date.now()) {
  if (!item.due || item.done) return "";
  const diff = item.due - now;
  if (diff < 0) return "overdue";
  if (diff < 3_600_000) return "due-soon";
  return "";
}

export function fmtWhen(ts, now = Date.now()) {
  const d = new Date(ts);
  const n = new Date(now);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === n.toDateString()
    ? `Today ${time}`
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
EOF

# ---------------- src/notify.js ----------------
cat > src/notify.js <<'EOF'
export function canNotify() {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function requestPermission() {
  if (!canNotify()) return "unsupported";
  return await Notification.requestPermission();
}

export function sendNotification(title, body, tag) {
  if (canNotify() && Notification.permission === "granted") {
    new Notification(title, { body, tag });
  }
}

export function toast(text, timeout = 4000) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  Object.assign(t.style, {
    position: "fixed", bottom: "20px", left: "50%",
    transform: "translateX(-50%)",
    background: "#4f8cff", color: "#fff",
    padding: "10px 16px", borderRadius: "10px",
    boxShadow: "0 6px 20px rgba(0,0,0,.4)",
    font: "600 14px system-ui", zIndex: 9999,
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), timeout);
}
EOF

# ---------------- src/render.js ----------------
cat > src/render.js <<'EOF'
import { sortItems, dueClass, fmtWhen } from "./store.js";

export function renderList(listEl, countEl, items) {
  const active = items.filter((x) => !x.done).length;
  countEl.textContent = `${active} active · ${items.length} total`;

  if (items.length === 0) {
    listEl.innerHTML = '<div class="empty">Nothing here yet. Add your first task above.</div>';
    return;
  }

  listEl.innerHTML = "";
  for (const it of sortItems(items)) {
    const li = document.createElement("li");
    li.className = [it.done ? "done" : "", dueClass(it)].filter(Boolean).join(" ");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "check";
    cb.checked = it.done;
    cb.dataset.id = it.id;
    cb.dataset.action = "toggle";

    const body = document.createElement("div");
    body.className = "body";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = it.title;

    const meta = document.createElement("div");
    meta.className = "meta";

    const p = document.createElement("span");
    p.className = `pill ${it.prio}`;
    p.textContent = it.prio.toUpperCase();
    meta.appendChild(p);

    if (it.due) {
      const w = document.createElement("span");
      w.className = "pill " + dueClass(it);
      const diff = it.due - Date.now();
      w.textContent = (diff < 0 ? "Overdue · " : "") + fmtWhen(it.due);
      meta.appendChild(w);
    }

    body.appendChild(title);
    body.appendChild(meta);

    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.title = "Delete";
    del.textContent = "✕";
    del.dataset.id = it.id;
    del.dataset.action = "remove";

    li.appendChild(cb);
    li.appendChild(body);
    li.appendChild(del);
    listEl.appendChild(li);
  }
}
EOF

# ---------------- src/main.js ----------------
cat > src/main.js <<'EOF'
import {
  load, save, addItem, toggleItem, removeItem, clearDone,
} from "./store.js";
import { renderList } from "./render.js";
import { canNotify, requestPermission, sendNotification, toast } from "./notify.js";

const listEl = document.getElementById("list");
const formEl = document.getElementById("form");
const taskEl = document.getElementById("task");
const whenEl = document.getElementById("when");
const prioEl = document.getElementById("prio");
const countEl = document.getElementById("count");
const notifyBtn = document.getElementById("notifyBtn");
const clearBtn = document.getElementById("clearBtn");

let items = load();
const notified = new Set();

function persist() {
  save(items);
  renderList(listEl, countEl, items);
}

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  items = addItem(items, {
    title: taskEl.value,
    due: whenEl.value || null,
    prio: prioEl.value,
  });
  taskEl.value = "";
  whenEl.value = "";
  prioEl.value = "med";
  taskEl.focus();
  persist();
});

listEl.addEventListener("change", (e) => {
  const el = e.target.closest("[data-action='toggle']");
  if (el) {
    items = toggleItem(items, el.dataset.id);
    notified.delete(el.dataset.id);
    persist();
  }
});

listEl.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action='remove']");
  if (el) {
    items = removeItem(items, el.dataset.id);
    notified.delete(el.dataset.id);
    persist();
  }
});

clearBtn.addEventListener("click", () => {
  items = clearDone(items);
  persist();
});

notifyBtn.addEventListener("click", async () => {
  const perm = await requestPermission();
  notifyBtn.textContent =
    perm === "granted" ? "Notifications on ✓"
    : perm === "unsupported" ? "Not supported"
    : "Notifications blocked";
  notifyBtn.disabled = perm === "granted";
});

function tick() {
  const now = Date.now();
  for (const it of items) {
    if (it.done || !it.due) continue;
    if (it.due <= now && !notified.has(it.id)) {
      notified.add(it.id);
      sendNotification("Todo Reminder", it.title, it.id);
      toast("⏰ " + it.title);
    }
  }
  renderList(listEl, countEl, items);
}

persist();
setInterval(tick, 15000);
window.addEventListener("focus", () => renderList(listEl, countEl, items));

if (canNotify() && Notification.permission === "granted") {
  notifyBtn.textContent = "Notifications on ✓";
  notifyBtn.disabled = true;
}
EOF

# ---------------- src/store.test.js ----------------
cat > src/store.test.js <<'EOF'
import { describe, it, expect, beforeEach } from "vitest";
import {
  STORAGE_KEY, load, save, addItem, toggleItem, removeItem,
  clearDone, sortItems, dueClass, fmtWhen,
} from "./store.js";

function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

describe("store: persistence", () => {
  let s;
  beforeEach(() => { s = memStorage(); });

  it("loads empty array when nothing stored", () => {
    expect(load(s)).toEqual([]);
  });

  it("saves and loads items", () => {
    const items = [{ id: "1", title: "x", done: false }];
    save(items, s);
    expect(load(s)).toEqual(items);
  });

  it("returns [] on corrupt JSON", () => {
    s.setItem(STORAGE_KEY, "{not-json");
    expect(load(s)).toEqual([]);
  });
});

describe("store: addItem", () => {
  it("adds a trimmed item", () => {
    const out = addItem([], { title: "  buy milk  ", due: null, prio: "high" });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("buy milk");
    expect(out[0].prio).toBe("high");
    expect(out[0].done).toBe(false);
  });

  it("ignores empty titles", () => {
    expect(addItem([], { title: "   " })).toEqual([]);
  });

  it("converts due date to timestamp", () => {
    const iso = "2030-01-01T10:00";
    const [it] = addItem([], { title: "t", due: iso });
    expect(it.due).toBe(new Date(iso).getTime());
  });
});

describe("store: toggle / remove / clear", () => {
  const base = [
    { id: "a", title: "A", done: false },
    { id: "b", title: "B", done: true },
  ];

  it("toggles done state", () => {
    const out = toggleItem(base, "a");
    expect(out.find((x) => x.id === "a").done).toBe(true);
    expect(base[0].done).toBe(false); // immutable
  });

  it("removes by id", () => {
    expect(removeItem(base, "a").map((x) => x.id)).toEqual(["b"]);
  });

  it("clears done items", () => {
    expect(clearDone(base).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("store: sortItems", () => {
  it("puts incomplete before done", () => {
    const out = sortItems([
      { id: "1", done: true, prio: "high", due: 1 },
      { id: "2", done: false, prio: "low", due: null },
    ]);
    expect(out[0].id).toBe("2");
  });

  it("sorts by due time, nulls last", () => {
    const out = sortItems([
      { id: "1", done: false, prio: "low", due: null },
      { id: "2", done: false, prio: "low", due: 200 },
      { id: "3", done: false, prio: "low", due: 100 },
    ]);
    expect(out.map((x) => x.id)).toEqual(["3", "2", "1"]);
  });

  it("breaks ties by priority", () => {
    const out = sortItems([
      { id: "1", done: false, prio: "low", due: 100 },
      { id: "2", done: false, prio: "high", due: 100 },
      { id: "3", done: false, prio: "med", due: 100 },
    ]);
    expect(out.map((x) => x.id)).toEqual(["2", "3", "1"]);
  });
});

describe("store: dueClass", () => {
  const NOW = 1_000_000;
  it("returns '' for no due or done", () => {
    expect(dueClass({ due: null, done: false }, NOW)).toBe("");
    expect(dueClass({ due: NOW - 1, done: true }, NOW)).toBe("");
  });
  it("flags overdue", () => {
    expect(dueClass({ due: NOW - 1, done: false }, NOW)).toBe("overdue");
  });
  it("flags due-soon within an hour", () => {
    expect(dueClass({ due: NOW + 60_000, done: false }, NOW)).toBe("due-soon");
  });
  it("returns '' far in future", () => {
    expect(dueClass({ due: NOW + 7_200_000, done: false }, NOW)).toBe("");
  });
});

describe("store: fmtWhen", () => {
  it("says Today for same-day", () => {
    const now = new Date("2030-01-01T08:00").getTime();
    const ts = new Date("2030-01-01T14:30").getTime();
    expect(fmtWhen(ts, now)).toMatch(/^Today /);
  });
  it("includes month for other days", () => {
    const now = new Date("2030-01-01T08:00").getTime();
    const ts = new Date("2030-02-14T09:00").getTime();
    expect(fmtWhen(ts, now)).toMatch(/Feb/);
  });
});
EOF

# ---------------- src/render.test.js ----------------
cat > src/render.test.js <<'EOF'
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
EOF

# ---------------- README.md ----------------
cat > README.md <<'EOF'
# Todo Reminder

A simple, dependency-free todo app with due-time reminders. Built with vanilla JS + Vite.

![CI](https://github.com/USERNAME/todo-reminder/actions/workflows/test.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

## Features
- Add / complete / delete tasks
- Optional due date & time with priority (low / med / high)
- Desktop notifications + in-page toast when a task is due
- Overdue tasks highlighted red, due-soon highlighted yellow
- Saves to `localStorage` (survives refresh & close)

## Quick start
```bash
git clone https://github.com/USERNAME/todo-reminder.git
cd todo-reminder
npm install
npm run dev
