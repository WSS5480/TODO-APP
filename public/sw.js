// The service worker. It exists for exactly one reason: on iOS, a web app can
// only receive a push through one of these, and a push is the only way a
// reminder fires while the app is closed. iOS suspends the page's own timers
// the moment you leave it.
//
// Note what is NOT here: no fetch handler, no caching. That is deliberate. The
// app finds new versions by asking the server for version.json, and a service
// worker that cached requests would answer that from its own store and pin the
// app on an old build — the exact problem the update banner was written to
// solve. This worker only listens for pushes.

self.addEventListener("install", () => {
  // Take over straight away rather than waiting for every tab to close; there
  // is nothing cached for an old worker to be holding on to.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // iOS requires a visible notification for every push received. If the
  // payload is ever unreadable, showing something generic is still better than
  // showing nothing — a silent push can cost the app its push permission.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || "To Do Reminder";
  const options = {
    body: data.body || "Something is due.",
    tag: data.tag || "todo-reminder",
    // Replace an earlier alert for the same task rather than stacking up.
    renotify: true,
    requireInteraction: !!data.requireInteraction,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    timestamp: data.at || Date.now(),
    data: { kind: data.kind || "due", at: data.at || null },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification should land in the app, reusing the window that is
// already open rather than starting a second copy.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow("/");
    })(),
  );
});

// The push service can retire a subscription on its own — after a long silence,
// or when the keys rotate. The app re-subscribes on its next launch; this just
// makes sure the old registration is not left behind.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
      if (!applicationServerKey) return;
      try {
        await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      } catch {
        // Nothing useful to do from here; the app handles it when next opened.
      }
    })(),
  );
});
