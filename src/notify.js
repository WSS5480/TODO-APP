export function canNotify() {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function requestPermission() {
  if (!canNotify()) return "unsupported";
  return await Notification.requestPermission();
}

// sticky: keep the desktop notification up until the user dismisses it (alarm-style)
export function sendNotification(title, body, tag, { sticky = false } = {}) {
  if (!(canNotify() && Notification.permission === "granted")) return null;
  try {
    const n = new Notification(title, {
      body,
      tag,
      requireInteraction: sticky,
      icon: "./favicon.svg",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return n;
  } catch {
    return null;
  }
}

function toastHost() {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    host.className = "toasts";
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  return host;
}

// toast("text") — plain, auto-hides.
// toast("text", { actions: [{ label, onClick, primary }] }) — stays up to 60s with buttons.
export function toast(text, { timeout = 4000, actions = [] } = {}) {
  const t = document.createElement("div");
  t.className = "toast";
  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = text;
  t.appendChild(msg);

  const close = () => t.remove();
  for (const a of actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = a.primary ? "" : "ghost";
    b.textContent = a.label;
    b.addEventListener("click", () => {
      try { a.onClick?.(); } finally { close(); }
    });
    t.appendChild(b);
  }

  toastHost().appendChild(t);
  const ttl = actions.length ? Math.max(timeout, 60_000) : timeout;
  if (ttl > 0) setTimeout(close, ttl);
  return t;
}
