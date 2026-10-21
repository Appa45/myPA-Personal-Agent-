import React, { useState } from "react";
import { enableNotifications } from "../firebase";

export default function NotificationSettings() {
  const [message, setMessage] = useState("");

  const handleEnable = async () => {
    try {
      const token = await enableNotifications();
      setMessage("Notifications enabled successfully!");
      console.log("FCM Token:", token);
    } catch (error) {
      console.error("Notification error:", error);
      setMessage(error.message || "Failed to enable notifications.");
    }
  };

  return (
    <div>
      <button onClick={handleEnable}>
        Enable Notifications
      </button>

      {message && <p>{message}</p>}
    </div>
  );
}