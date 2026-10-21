
import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getMessaging,
  getToken,
  deleteToken,
  isSupported,
} from "firebase/messaging";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;

export const app = getApps().length
  ? getApp()
  : initializeApp(firebaseConfig);

async function getMessagingInstance() {
  const supported = await isSupported();

  if (!supported) {
    throw new Error(
      "Firebase Messaging is not supported in this browser."
    );
  }

  return getMessaging(app);
}

export async function enableNotifications() {
  if (!("Notification" in window)) {
    throw new Error("Notifications are not supported.");
  }

  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers are not supported.");
  }

  if (!("PushManager" in window)) {
    throw new Error("Push notifications are not supported.");
  }

  if (!vapidKey) {
    throw new Error(
      "VITE_FIREBASE_VAPID_KEY is missing."
    );
  }

  const requiredConfig = [
    "apiKey",
    "authDomain",
    "projectId",
    "messagingSenderId",
    "appId",
  ];

  const missingConfig = requiredConfig.filter(
    (key) => !firebaseConfig[key]
  );

  if (missingConfig.length > 0) {
    throw new Error(
      `Missing Firebase configuration: ${missingConfig.join(", ")}`
    );
  }

  let permission = Notification.permission;

  if (permission === "default") {
    permission = await Notification.requestPermission();
  }

  if (permission !== "granted") {
    throw new Error(
      `Notification permission is ${permission}.`
    );
  }

  const registration = await navigator.serviceWorker.register(
    "/firebase-messaging-sw.js"
  );

  await navigator.serviceWorker.ready;

  if (!registration.active) {
    throw new Error(
      "Firebase messaging service worker is not active."
    );
  }

  const messaging = await getMessagingInstance();

  console.log("Firebase project:", firebaseConfig.projectId);
  console.log("Service worker:", registration.active.scriptURL);
  console.log("VAPID key present:", Boolean(vapidKey));

  const token = await getToken(messaging, {
    vapidKey,
    serviceWorkerRegistration: registration,
  });

  if (!token) {
    throw new Error("Firebase did not return an FCM token.");
  }

  console.log("FCM token generated successfully.");

  return token;
}

export async function getFcmToken() {
  return enableNotifications();
}

export async function disableNotifications() {
  const messaging = await getMessagingInstance();
  const deleted = await deleteToken(messaging);

  return deleted;
}
