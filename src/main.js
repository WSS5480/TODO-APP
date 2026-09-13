import {
  load, save, loadPrefs, savePrefs,
  addItem, toggleItem, completeItem, removeItem, clearDone,
  snoozeItem, dueAlerts, markAlerted, fmtIn,
} from "./store.js";
import { renderList } from "./render.js";
import { canNotify, requestPermission, sendNotification, toast } from "./notify.js";
import { setSoundEnabled, unlockAudio, playChime } from "./sound.js";

const $ = (id) => document.getElementById(id);
const listEl = $("list");
const formEl = $("form");
const taskEl = $("task");
const whenEl = $("when");
const prioEl = $("prio");
const countEl = $("count");
const notifyBtn = $("notifyBtn");
const clearBtn = $("clearBtn");
const soundBtn = $("soundBtn");
const leadEl = $("lead");

const BASE_TITLE = document.title;
const SNOOZE_MIN = 10;
const TICK_MS = 15_000;

let items = load();
let prefs = loadPrefs();

function updateTitle() {
  const now = Date.now();
  const overdue = items.filter((it) => !it.done && it.due && it.due <= now).length;
  document.title = overdue ? `(${overdue}) ⏰ ${BASE_TITLE}` : BASE_TITLE;
}

function persist() {
  save(items);
  renderList(listEl, countEl, items);
  updateTitle();
}

/* ---------- settings ---------- */

function syncSettingsUI() {
  soundBtn.textContent = prefs.sound ? "Sound on" : "Sound off";
  soundBtn.classList.toggle("on", prefs.sound);
  soundBtn.setAttribute("aria-pressed", String(prefs.sound));
  leadEl.value = String(prefs.lead);
  setSoundEnabled(prefs.sound);
}

soundBtn.addEventListener("click", () => {
  prefs = { ...prefs, sound: !prefs.sound };
  savePrefs(prefs);
  syncSettingsUI();
  if (prefs.sound) {
    unlockAudio();
    playChime(); // preview the chime
  }
});

leadEl.addEventListener("change", () => {
  prefs = { ...prefs, lead: Number(leadEl.value) || 0 };
  savePrefs(prefs);
});

// Browsers only allow audio after a user gesture; unlock on the first one.
for (const ev of ["pointerdown", "keydown", "touchstart"]) {
  document.addEventListener(ev, unlockAudio, { once: true, passive: true });
}

/* ---------- task actions ---------- */

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
    persist();
  }
});

listEl.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action='remove']");
  if (el) {
    items = removeItem(items, el.dataset.id);
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
    : perm === "unsupported" ? "Not supported here"
    : "Notifications blocked";
  notifyBtn.disabled = perm === "granted";
});

/* ---------- alarms ---------- */

function fire({ item, kind }) {
  const isDue = kind === "due";
  const label = isDue
    ? `Due now: ${item.title}`
    : `Due ${fmtIn(item.due - Date.now())}: ${item.title}`;

  items = markAlerted(items, item.id, kind);
  playChime();
  sendNotification("Todo Reminder", label, `${item.id}:${kind}`, { sticky: isDue });
  toast((isDue ? "⏰ " : "⏳ ") + label, {
    actions: [
      {
        label: `Snooze ${SNOOZE_MIN} min`,
        onClick: () => { items = snoozeItem(items, item.id, SNOOZE_MIN); persist(); },
      },
      {
        label: "Done",
        primary: true,
        onClick: () => { items = completeItem(items, item.id); persist(); },
      },
    ],
  });
}

function tick() {
  const alerts = dueAlerts(items, Date.now(), prefs.lead * 60_000);
  for (const a of alerts) fire(a);
  if (alerts.length) save(items);
  renderList(listEl, countEl, items);
  updateTitle();
}

syncSettingsUI();
persist();
tick();
setInterval(tick, TICK_MS);
window.addEventListener("focus", tick);
document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });

if (canNotify() && Notification.permission === "granted") {
  notifyBtn.textContent = "Notifications on ✓";
  notifyBtn.disabled = true;
} else if (!canNotify()) {
  notifyBtn.textContent = "Not supported here";
  notifyBtn.disabled = true;
}
