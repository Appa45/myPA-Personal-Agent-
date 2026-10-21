
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

export const app = getApps().length
  ? getApp()
  : initializeApp(firebaseConfig);

async function getMessagingInstance() {
  if (!(await isSupported())) {
    throw new Error("Firebase Messaging is not supported in this browser.");
  }

  return getMessaging(app);
}

export async function enableNotifications() {
  if (!("Notification" in window)) {
    throw new Error("Notifications are not supported.");
  }

  const permission = await Notification.requestPermission();

  if (permission !== "granted") {
    throw new Error("Notification permission denied.");
  }

  const messaging = await getMessagingInstance();
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;

  if (!vapidKey) {
    throw new Error("VITE_FIREBASE_VAPID_KEY is missing.");
  }

  const token = await getToken(messaging, { vapidKey });

  if (!token) {
    throw new Error("Unable to generate FCM token.");
  }

  console.log("FCM Token:", token);
  return token;
}

export async function getFcmToken() {
  return enableNotifications();
}

export async function disableNotifications() {
  const messaging = await getMessagingInstance();
  await deleteToken(messaging);
  return true;
}
