import {
  load, save, loadPrefs, savePrefs,
  addItem, toggleItem, completeItem, removeItem, clearDone, editItem,
  snoozeItem, dueAlerts, markAlerted, fmtIn, alertSound, mergeImported,
} from "./store.js";
import { renderList } from "./render.js";
import { canNotify, requestPermission, sendNotification, toast } from "./notify.js";
import { setSoundEnabled, unlockAudio, playChime, playSound, SOUNDS, SOUND_NAMES } from "./sound.js";
import {
  APP_VERSION, APP_RELEASE, APP_BUILT_AT, isOutdated, fetchDeployedVersion, reloadToVersion,
} from "./update.js";
import { buildCalendar, countExportable, icsFilename } from "./calendar.js";
import { REPEAT_CHOICES } from "./recur.js";
import { tasksFromIcs } from "./icsparse.js";
import { fetchCalendar, normalizeFeedUrl, DEFAULT_PROXY } from "./calsync.js";

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
const taskRepeatEl = $("taskRepeat");
const taskSoundEl = $("taskSound");
const buildEl = $("build");
const calUrlEl = $("calUrl");
const calSyncBtn = $("calSyncBtn");
const calEveryEl = $("calEvery");
const calPruneEl = $("calPrune");
const calProxyEl = $("calProxy");
const calFileBtn = $("calFileBtn");
const calFileEl = $("calFile");
const calPasteBtn = $("calPasteBtn");
const calPasteBox = $("calPasteBox");
const calTextEl = $("calText");
const calTextBtn = $("calTextBtn");
const calStatusEl = $("calStatus");
const updateEl = $("update");
const updateBtn = $("updateBtn");
const updateDismiss = $("updateDismiss");
const settingsBtn = $("settingsBtn");
const settingsPanel = $("settingsPanel");
const exportBtn = $("exportBtn");

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
  syncExportBtn();
}

function focusEdit() {
  const el = listEl.querySelector(".edit-title");
  if (el) {
    el.focus();
    el.select();
  }
}

/* ---------- settings ---------- */

// Settings and the sound samples live behind the gear, so the day-to-day view
// is just the add form and the list.
function setSettingsOpen(open) {
  settingsPanel.hidden = !open;
  settingsBtn.setAttribute("aria-expanded", String(open));
  settingsBtn.classList.toggle("on", open);
}

settingsBtn.addEventListener("click", () => {
  const open = settingsPanel.hidden;
  setSettingsOpen(open);
  // opening is a gesture, so it is a good moment to prime the alarm sounds
  if (open) unlockAudio(soundsInUse());
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsPanel.hidden && !editingId) setSettingsOpen(false);
});

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

// A row of tappable chips: one tap both picks the sound and plays it, which is
// far easier on a phone than opening a dropdown to audition each option.
function buildPicker(host, getValue, onPick) {
  host.innerHTML = "";
  for (const name of SOUND_NAMES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "sound-chip";
    chip.dataset.sound = name;
    chip.setAttribute("role", "radio");
    chip.innerHTML = '<span class="play" aria-hidden="true">&#9654;</span>';
    chip.append(SOUNDS[name].label);
    chip.addEventListener("click", () => {
      onPick(name);
      unlockAudio([name]);
      playChime(name); // always audition, even when re-tapping the current pick
      syncPicker(host, getValue);
    });
    host.appendChild(chip);
  }
  syncPicker(host, getValue);
}

function syncPicker(host, getValue) {
  const current = getValue();
  for (const chip of host.querySelectorAll(".sound-chip")) {
    const on = chip.dataset.sound === current;
    chip.classList.toggle("on", on);
    chip.setAttribute("aria-checked", String(on));
  }
}

// Only the sounds actually reachable get primed, so the library can grow
// without building every WAV on the first tap.
function soundsInUse() {
  return [...new Set([prefs.dueSound, prefs.soonSound, ...items.map((it) => it.sound)])].filter(Boolean);
}

fillSounds(taskSoundEl, { withDefault: true });

// The repeat picker in the add form, from the same list the edit form uses.
for (const [value, label] of REPEAT_CHOICES) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = value === "" ? "Once" : label;
  taskRepeatEl.appendChild(opt);
}

// A repeat has nothing to count from without a due date, so the picker follows
// the date field rather than silently discarding what was chosen.
function syncRepeatPicker() {
  const hasDate = !!whenEl.value;
  taskRepeatEl.disabled = !hasDate;
  if (!hasDate) taskRepeatEl.value = "";
  taskRepeatEl.title = hasDate ? "Repeat" : "Set a due date to repeat this task";
}

whenEl.addEventListener("change", syncRepeatPicker);
whenEl.addEventListener("input", syncRepeatPicker);

function syncSettingsUI() {
  soundBtn.textContent = prefs.sound ? "Sound on" : "Sound off";
  soundBtn.classList.toggle("on", prefs.sound);
  soundBtn.setAttribute("aria-pressed", String(prefs.sound));
  leadEl.value = String(prefs.lead);
  syncPicker(dueSoundEl, () => prefs.dueSound);
  syncPicker(soonSoundEl, () => prefs.soonSound);
  repeatEl.value = String(prefs.repeat);
  calUrlEl.value = prefs.calUrl || "";
  calEveryEl.value = String(prefs.calEvery);
  calPruneEl.checked = !!prefs.calPrune;
  calProxyEl.value = prefs.calProxy || "";
  setSoundEnabled(prefs.sound);
}

buildPicker(dueSoundEl, () => prefs.dueSound, (name) => {
  prefs = { ...prefs, dueSound: name };
  savePrefs(prefs);
});
buildPicker(soonSoundEl, () => prefs.soonSound, (name) => {
  prefs = { ...prefs, soonSound: name };
  savePrefs(prefs);
});

// Picking a per-task alarm previews it too, in both the add and the edit form.
taskSoundEl.addEventListener("change", () => {
  if (!taskSoundEl.value) return;
  unlockAudio([taskSoundEl.value]);
  playChime(taskSoundEl.value);
});

listEl.addEventListener("change", (e) => {
  const el = e.target.closest(".edit-sound");
  if (el && el.value) {
    unlockAudio([el.value]);
    playChime(el.value);
  }
});

repeatEl.addEventListener("change", () => {
  prefs = { ...prefs, repeat: Number(repeatEl.value) || 1 };
  savePrefs(prefs);
});

soundBtn.addEventListener("click", () => {
  prefs = { ...prefs, sound: !prefs.sound };
  savePrefs(prefs);
  syncSettingsUI();
  if (prefs.sound) {
    unlockAudio(soundsInUse());
    playChime(prefs.dueSound); // preview the alarm
  }
});

leadEl.addEventListener("change", () => {
  prefs = { ...prefs, lead: Number(leadEl.value) || 0 };
  savePrefs(prefs);
});

// Browsers only allow audio after a user gesture; unlock on the first one.
for (const ev of ["pointerdown", "keydown", "touchstart"]) {
  document.addEventListener(ev, () => unlockAudio(soundsInUse()), { once: true, passive: true });
}

/* ---------- task actions ---------- */

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  items = addItem(items, {
    title: taskEl.value,
    due: whenEl.value || null,
    prio: prioEl.value,
    sound: taskSoundEl.value || null,
    repeat: taskRepeatEl.value || null,
  });
  taskEl.value = "";
  whenEl.value = "";
  prioEl.value = "med";
  taskSoundEl.value = "";
  taskRepeatEl.value = "";
  syncRepeatPicker();
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

  const cal = e.target.closest("[data-action='ics']");
  if (cal) {
    const item = items.find((it) => it.id === cal.dataset.id);
    if (item) exportItems([item], icsFilename(item.title));
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
    repeat: data.get("repeat") || null,
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

/* ---------- calendar export ---------- */

// Hand the file to the browser. On a phone this opens the OS calendar, which
// offers to add the event — and a calendar alert still fires when this app is
// closed, which its own alarms cannot.
function downloadIcs(filename, text) {
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke late: Safari reads the blob after the click returns
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function exportItems(list, filename) {
  if (!countExportable(list)) {
    toast("Nothing to export — a task needs a due time to go in a calendar.");
    return;
  }
  downloadIcs(filename, buildCalendar(list, { leadMinutes: prefs.lead }));
}

function syncExportBtn() {
  const n = countExportable(items);
  exportBtn.textContent = n ? `Export ${n} to calendar` : "Export to calendar";
  exportBtn.disabled = n === 0;
}

exportBtn.addEventListener("click", () => exportItems(items, "to-do-reminder.ics"));

/* ---------- calendar import and pull ---------- */

// Everything in this section ends up in the same place: drafts from icsparse.js
// merged into the list by mergeImported, which keys on the calendar's own UID so
// pulling twice updates the tasks instead of duplicating them.

let pulling = false;
let pullTimer = null;

function calStatus(message, kind = "") {
  calStatusEl.textContent = message;
  calStatusEl.className = `sound-hint ${kind}`.trim();
}

function describeMerge({ added, updated, removed }, found) {
  if (!added && !updated && !removed) {
    return found ? "Already up to date." : "No upcoming events in that calendar.";
  }
  const bits = [];
  if (added) bits.push(`${added} new`);
  if (updated) bits.push(`${updated} changed`);
  if (removed) bits.push(`${removed} removed`);
  return `${bits.join(", ")}.`;
}

// Shared by the file, the pasted text and the network pull.
function importText(text, { source = "calendar", prune = false } = {}) {
  const { tasks, found, calendarName } = tasksFromIcs(text);
  if (!found) {
    calStatus("That file has no events in it.", "bad");
    return null;
  }
  const result = mergeImported(items, tasks, { source, prune });
  items = result.items;
  persist();
  return { result, found, calendarName };
}

calFileBtn.addEventListener("click", () => calFileEl.click());

calFileEl.addEventListener("change", async () => {
  const file = calFileEl.files && calFileEl.files[0];
  if (!file) return;
  calStatus(`Reading ${file.name}…`);
  try {
    const outcome = importText(await file.text());
    if (outcome) {
      calStatus(`${file.name}: ${describeMerge(outcome.result, outcome.found)}`, "good");
      toast(`Imported from ${outcome.calendarName || file.name}`);
    }
  } catch {
    calStatus("That file could not be read.", "bad");
  } finally {
    calFileEl.value = ""; // so picking the same file again still fires
  }
});

calPasteBtn.addEventListener("click", () => {
  calPasteBox.hidden = !calPasteBox.hidden;
  if (!calPasteBox.hidden) calTextEl.focus();
});

calTextBtn.addEventListener("click", () => {
  const text = calTextEl.value.trim();
  if (!text) {
    calStatus("Paste the calendar text first.", "bad");
    return;
  }
  const outcome = importText(text);
  if (outcome) {
    calStatus(describeMerge(outcome.result, outcome.found), "good");
    calTextEl.value = "";
    calPasteBox.hidden = true;
  }
});

calUrlEl.addEventListener("change", () => {
  const raw = calUrlEl.value.trim();
  const url = normalizeFeedUrl(raw);
  if (raw && !url) {
    calStatus("That does not look like a calendar link.", "bad");
    return;
  }
  prefs = { ...prefs, calUrl: url };
  savePrefs(prefs);
  calUrlEl.value = url;
  armAutoPull();
  if (url) calStatus("Saved. Tap “Pull now” to try it.");
});

calEveryEl.addEventListener("change", () => {
  prefs = { ...prefs, calEvery: Number(calEveryEl.value) || 0 };
  savePrefs(prefs);
  armAutoPull();
});

calProxyEl.addEventListener("change", () => {
  const raw = calProxyEl.value.trim();
  // Blank means "use the one the app ships with", which is the normal case.
  const url = raw ? normalizeFeedUrl(raw) : "";
  if (raw && !url) {
    calStatus("That does not look like an address.", "bad");
    return;
  }
  prefs = { ...prefs, calProxy: url };
  savePrefs(prefs);
  calProxyEl.value = url;
});

calPruneEl.addEventListener("change", () => {
  prefs = { ...prefs, calPrune: calPruneEl.checked };
  savePrefs(prefs);
});

// `quiet` is for the automatic pull, which should not shout about a calendar
// that happens to be unreachable while the app sits open.
async function pullCalendar({ quiet = false } = {}) {
  if (pulling || !prefs.calUrl) return;
  pulling = true;
  calSyncBtn.disabled = true;
  if (!quiet) calStatus("Reading your calendar…");

  try {
    const res = await fetchCalendar(prefs.calUrl, { proxy: prefs.calProxy || DEFAULT_PROXY });
    if (!res.ok) {
      if (!quiet) calStatus(res.error, "bad");
      return;
    }

    const merge = mergeImported(items, res.tasks, { source: "calendar", prune: prefs.calPrune });
    items = merge.items;
    prefs = { ...prefs, calSyncedAt: Date.now() };
    savePrefs(prefs);
    persist();

    const summary = describeMerge(merge, res.found);
    if (!quiet || merge.added || merge.updated || merge.removed) {
      calStatus(`${res.calendarName || "Calendar"} · ${summary}`, "good");
    }
    if (quiet && (merge.added || merge.updated)) {
      toast(`Calendar updated — ${summary}`);
    }
  } finally {
    pulling = false;
    calSyncBtn.disabled = false;
  }
}

calSyncBtn.addEventListener("click", () => pullCalendar());

// The app has no background life of its own, so "automatic" means while it is
// open, plus a catch-up pull whenever it comes back to the foreground.
function armAutoPull() {
  if (pullTimer) clearInterval(pullTimer);
  pullTimer = null;
  const minutes = Number(prefs.calEvery) || 0;
  if (!minutes || !prefs.calUrl) return;
  pullTimer = setInterval(() => pullCalendar({ quiet: true }), minutes * 60_000);
}

function pullIfStale() {
  const minutes = Number(prefs.calEvery) || 0;
  if (!minutes || !prefs.calUrl) return;
  if (Date.now() - (prefs.calSyncedAt || 0) < minutes * 60_000) return;
  pullCalendar({ quiet: true });
}

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
  sendNotification("To Do Reminder", label, `${item.id}:${kind}`, { sticky: isDue });
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
syncRepeatPicker();
persist();
tick();
setInterval(tick, TICK_MS);
window.addEventListener("focus", tick);
document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });

armAutoPull();
pullIfStale();
window.addEventListener("focus", pullIfStale);
document.addEventListener("visibilitychange", () => { if (!document.hidden) pullIfStale(); });

if (canNotify() && Notification.permission === "granted") {
  notifyBtn.textContent = "Notifications on ✓";
  notifyBtn.disabled = true;
} else if (!canNotify()) {
  notifyBtn.textContent = "Not supported here";
  notifyBtn.disabled = true;
}

/* ---------- new version available ---------- */

// Installed to a Home Screen there is no reload button, so the app checks for a
// newer build itself and offers it rather than making you reinstall.
const UPDATE_POLL_MS = 15 * 60_000;
let pendingVersion = null;
let dismissed = false;

async function checkForUpdate() {
  if (dismissed) return;
  const deployed = await fetchDeployedVersion();
  if (!isOutdated(deployed)) return;
  pendingVersion = deployed.version;
  updateEl.hidden = false;
}

updateDismiss.addEventListener("click", () => {
  dismissed = true; // until the next launch, so a banner can never get stuck
  updateEl.hidden = true;
});

updateBtn.addEventListener("click", () => {
  updateBtn.disabled = true;
  updateBtn.textContent = "Updating…";
  reloadToVersion(pendingVersion || String(Date.now()));
});

checkForUpdate();
setInterval(checkForUpdate, UPDATE_POLL_MS);
// Coming back to the app is the moment a new build is most likely waiting.
window.addEventListener("focus", checkForUpdate);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });

// A visible stamp, so "did my change land?" is answerable at a glance.
buildEl.textContent = `${APP_RELEASE} · ${APP_VERSION}`;
buildEl.title = APP_BUILT_AT
  ? `Built ${new Date(APP_BUILT_AT).toLocaleString()}`
  : "Development build";

console.info(`To Do Reminder ${APP_RELEASE} build ${APP_VERSION} (${new Date(APP_BUILT_AT).toISOString()})`);
