/* global self, clients */
// Handler de Web Push inyectado en el service worker (vía workbox importScripts).
// Los push llegan SIN payload: mostramos un aviso genérico y al tocarlo abrimos la app.

self.addEventListener("push", (event) => {
  let title = "Smartkids";
  let body = "Tienes novedades. Toca para abrir.";
  // Por si en el futuro se envía payload JSON { title, body }:
  try {
    if (event.data) {
      const d = event.data.json();
      if (d && typeof d === "object") {
        title = d.title || title;
        body = d.body || body;
      }
    }
  } catch {
    /* sin payload */
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "smartkids",
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) return w.focus();
      }
      if (clients.openWindow) return clients.openWindow("/");
    })(),
  );
});
