
import { useState } from "react";
import { getMessaging, getToken } from "firebase/messaging";
import { app } from "./firebase";

export default function TokenTest() {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");

  async function generateToken() {
    try {
      setStatus("Requesting notification permission...");

      if (!("Notification" in window)) {
        throw new Error("This browser does not support notifications.");
      }

      const permission = await Notification.requestPermission();

      if (permission !== "granted") {
        throw new Error("Please allow notifications in your browser.");
      }

      const registration = await navigator.serviceWorker.register(
        "/firebase-messaging-sw.js"
      );

      await navigator.serviceWorker.ready;

      const messaging = getMessaging(app);
      const fcmToken = await getToken(messaging, {
        vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
        serviceWorkerRegistration: registration,
      });

      if (!fcmToken) {
        throw new Error("No token returned. Check Firebase configuration.");
      }

      setToken(fcmToken);
      setStatus("FCM token generated successfully.");
      console.log("FCM TOKEN:", fcmToken);
    } catch (error) {
      console.error("FCM token error:", error);
      setStatus(error.message || "Failed to generate FCM token.");
    }
  }

  return (
    <div style={{ maxWidth: 700, margin: "40px auto", padding: 20 }}>
      <h2>AURA Firebase Notification Test</h2>

      <button onClick={generateToken}>
        Generate FCM Token
      </button>

      <p>{status}</p>

      {token && (
        <>
          <textarea
            readOnly
            value={token}
            rows={6}
            style={{ width: "100%", marginTop: 12 }}
          />
          <button onClick={() => navigator.clipboard.writeText(token)}>
            Copy FCM Token
          </button>
        </>
      )}
    </div>
  );
}
