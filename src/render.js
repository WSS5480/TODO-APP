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
