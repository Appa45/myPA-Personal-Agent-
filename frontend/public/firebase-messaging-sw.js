importScripts(
  "https://www.gstatic.com/firebasejs/11.10.0/firebase-app-compat.js"
);

importScripts(
  "https://www.gstatic.com/firebasejs/11.10.0/firebase-messaging-compat.js"
);

importScripts("/firebase-config.js");

firebase.initializeApp(self.FIREBASE_CONFIG);

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  if (payload.notification) {
    return;
  }

  const title = payload.data?.title || "myPAgent Reminder";

  self.registration.showNotification(title, {
    body: payload.data?.body || "You have a reminder.",
    icon: "/favicon.ico",
    data: {
      url: payload.data?.url || "/",
    },
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    }).then((windowClients) => {
      for (const client of windowClients) {
        if (
          "focus" in client &&
          new URL(client.url).origin === self.location.origin
        ) {
          return client.focus();
        }
      }

      return clients.openWindow(url);
    })
  );
});