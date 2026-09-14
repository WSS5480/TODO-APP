import { sortItems, dueClass, fmtWhen, toLocalInput } from "./store.js";
import { SOUNDS, SOUND_NAMES } from "./sound.js";

const PRIOS = [
  ["low", "Low"],
  ["med", "Med"],
  ["high", "High"],
];

// The row for the task currently being edited: an inline form seeded with the
// task's own values. Submitting it saves; Cancel (or Escape) leaves it untouched.
function editRow(it) {
  const li = document.createElement("li");
  li.className = "editing";

  const form = document.createElement("form");
  form.className = "edit-form";
  form.dataset.id = it.id;
  form.dataset.action = "save-edit";

  const title = document.createElement("input");
  title.className = "edit-title";
  title.name = "title";
  title.value = it.title;
  title.required = true;
  title.setAttribute("aria-label", "Task");

  const when = document.createElement("input");
  when.type = "datetime-local";
  when.className = "edit-when";
  when.name = "due";
  when.value = it.due ? toLocalInput(it.due) : "";
  when.setAttribute("aria-label", "Due date and time");

  const prio = document.createElement("select");
  prio.className = "edit-prio";
  prio.name = "prio";
  prio.setAttribute("aria-label", "Priority");
  for (const [value, label] of PRIOS) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    opt.selected = it.prio === value;
    prio.appendChild(opt);
  }

  const sound = document.createElement("select");
  sound.className = "edit-sound";
  sound.name = "sound";
  sound.setAttribute("aria-label", "Alarm sound");
  const dflt = document.createElement("option");
  dflt.value = "";
  dflt.textContent = "Default alarm";
  dflt.selected = !it.sound;
  sound.appendChild(dflt);
  for (const name of SOUND_NAMES) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = SOUNDS[name].label;
    opt.selected = it.sound === name;
    sound.appendChild(opt);
  }

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "save";
  save.textContent = "Save";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "cancel";
  cancel.textContent = "Cancel";
  cancel.dataset.action = "cancel-edit";

  form.append(title, when, prio, sound, save, cancel);
  li.appendChild(form);
  return li;
}

function taskRow(it) {
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

  if (it.sound && SOUNDS[it.sound]) {
    const s = document.createElement("span");
    s.className = "pill sound";
    s.textContent = "♪ " + SOUNDS[it.sound].label;
    meta.appendChild(s);
  }

  body.appendChild(title);
  body.appendChild(meta);

  li.appendChild(cb);
  li.appendChild(body);

  // only a task with a due time has anything to put in a calendar
  if (it.due) {
    const cal = document.createElement("button");
    cal.className = "cal";
    cal.type = "button";
    cal.title = "Add to calendar";
    cal.setAttribute("aria-label", `Add ${it.title} to calendar`);
    cal.textContent = "\u{1F4C5}";
    cal.dataset.id = it.id;
    cal.dataset.action = "ics";
    li.appendChild(cal);
  }

  const edit = document.createElement("button");
  edit.className = "edit";
  edit.type = "button";
  edit.title = "Edit";
  edit.setAttribute("aria-label", `Edit ${it.title}`);
  edit.textContent = "✎";
  edit.dataset.id = it.id;
  edit.dataset.action = "edit";

  const del = document.createElement("button");
  del.className = "del";
  del.type = "button";
  del.title = "Delete";
  del.setAttribute("aria-label", `Delete ${it.title}`);
  del.textContent = "✕";
  del.dataset.id = it.id;
  del.dataset.action = "remove";

  li.appendChild(edit);
  li.appendChild(del);
  return li;
}

export function renderList(listEl, countEl, items, editingId = null) {
  const active = items.filter((x) => !x.done).length;
  countEl.textContent = `${active} active · ${items.length} total`;

  if (items.length === 0) {
    listEl.innerHTML = '<div class="empty">Nothing here yet. Add your first task above.</div>';
    return;
  }

  listEl.innerHTML = "";
  for (const it of sortItems(items)) {
    listEl.appendChild(it.id === editingId ? editRow(it) : taskRow(it));
  }
}
