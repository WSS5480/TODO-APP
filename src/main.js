import {
  load, save, loadPrefs, savePrefs,
  addItem, toggleItem, completeItem, removeItem, clearDone, editItem,
  snoozeItem, dueAlerts, markAlerted, fmtIn, alertSound,
} from "./store.js";
import { renderList } from "./render.js";
import { canNotify, requestPermission, sendNotification, toast } from "./notify.js";
import { setSoundEnabled, unlockAudio, playChime, playSound, SOUNDS, SOUND_NAMES } from "./sound.js";

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
const dueSoundEl = $("dueSound");
const soonSoundEl = $("soonSound");
const repeatEl = $("repeat");
const taskSoundEl = $("taskSound");

const BASE_TITLE = document.title;
const SNOOZE_MIN = 10;
const TICK_MS = 15_000;

let items = load();
let prefs = loadPrefs();
let editingId = null; // task whose row is currently an inline edit form
let activeAlarm = null; // handle for the alarm currently ringing, so it can be stopped

function updateTitle() {
  const now = Date.now();
  const overdue = items.filter((it) => !it.done && it.due && it.due <= now).length;
  document.title = overdue ? `(${overdue}) ⏰ ${BASE_TITLE}` : BASE_TITLE;
}

function persist() {
  save(items);
  renderList(listEl, countEl, items, editingId);
  updateTitle();
}

function focusEdit() {
  const el = listEl.querySelector(".edit-title");
  if (el) {
    el.focus();
    el.select();
  }
}

/* ---------- settings ---------- */

// One source of truth for the sound list: the library in sound.js.
function fillSounds(select, { withDefault = false } = {}) {
  if (withDefault) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Default alarm";
    select.appendChild(opt);
  }
  for (const name of SOUND_NAMES) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = SOUNDS[name].label;
    select.appendChild(opt);
  }
}

fillSounds(dueSoundEl);
fillSounds(soonSoundEl);
fillSounds(taskSoundEl, { withDefault: true });

function syncSettingsUI() {
  soundBtn.textContent = prefs.sound ? "Sound on" : "Sound off";
  soundBtn.classList.toggle("on", prefs.sound);
  soundBtn.setAttribute("aria-pressed", String(prefs.sound));
  leadEl.value = String(prefs.lead);
  dueSoundEl.value = prefs.dueSound;
  soonSoundEl.value = prefs.soonSound;
  repeatEl.value = String(prefs.repeat);
  setSoundEnabled(prefs.sound);
}

// Changing a sound previews it, so you can hear what you picked.
for (const [el, key] of [[dueSoundEl, "dueSound"], [soonSoundEl, "soonSound"]]) {
  el.addEventListener("change", () => {
    prefs = { ...prefs, [key]: el.value };
    savePrefs(prefs);
    unlockAudio();
    playChime(el.value);
  });
}

repeatEl.addEventListener("change", () => {
  prefs = { ...prefs, repeat: Number(repeatEl.value) || 1 };
  savePrefs(prefs);
});

soundBtn.addEventListener("click", () => {
  prefs = { ...prefs, sound: !prefs.sound };
  savePrefs(prefs);
  syncSettingsUI();
  if (prefs.sound) {
    unlockAudio();
    playChime(prefs.dueSound); // preview the alarm
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
    sound: taskSoundEl.value || null,
  });
  taskEl.value = "";
  whenEl.value = "";
  prioEl.value = "med";
  taskSoundEl.value = "";
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
  const rm = e.target.closest("[data-action='remove']");
  if (rm) {
    if (editingId === rm.dataset.id) editingId = null;
    items = removeItem(items, rm.dataset.id);
    persist();
    return;
  }

  const ed = e.target.closest("[data-action='edit']");
  if (ed) {
    editingId = ed.dataset.id;
    persist();
    focusEdit();
    return;
  }

  if (e.target.closest("[data-action='cancel-edit']")) {
    editingId = null;
    persist();
  }
});

listEl.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-action='save-edit']");
  if (!form) return;
  e.preventDefault();
  const data = new FormData(form);
  items = editItem(items, form.dataset.id, {
    title: data.get("title"),
    due: data.get("due") || null,
    prio: data.get("prio"),
    sound: data.get("sound") || null,
  });
  editingId = null;
  persist();
});

listEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && editingId) {
    editingId = null;
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

  // Only one alarm rings at a time, and it keeps ringing until it is dealt with.
  activeAlarm?.stop();
  const alarm = playSound(alertSound(item, kind, prefs), {
    repeat: isDue ? prefs.repeat : 1,
  });
  activeAlarm = alarm;
  // Silence this toast's own alarm: a later alarm may already have replaced it.
  const silence = () => {
    alarm.stop();
    if (activeAlarm === alarm) activeAlarm = null;
  };
  sendNotification("Todo Reminder", label, `${item.id}:${kind}`, { sticky: isDue });
  toast((isDue ? "⏰ " : "⏳ ") + label, {
    actions: [
      {
        label: `Snooze ${SNOOZE_MIN} min`,
        onClick: () => { silence(); items = snoozeItem(items, item.id, SNOOZE_MIN); persist(); },
      },
      {
        label: "Done",
        primary: true,
        onClick: () => { silence(); items = completeItem(items, item.id); persist(); },
      },
    ],
  });
}

function tick() {
  const alerts = dueAlerts(items, Date.now(), prefs.lead * 60_000);
  for (const a of alerts) fire(a);
  if (alerts.length) save(items);
  // Re-rendering would throw away whatever is half-typed in the edit form.
  if (!editingId) renderList(listEl, countEl, items, editingId);
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
