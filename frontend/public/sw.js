// Friday service worker: shows a notification when a reply finishes while the tab is closed
// (the backend keeps generating after disconnect and sends a Web Push when it's done).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* ignore malformed payload */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Friday", {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { conversationId: data.conversationId },
      tag: data.conversationId || "friday",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.conversationId;
  const url = id ? `/c/${id}` : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
