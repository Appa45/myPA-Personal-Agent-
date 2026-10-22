import React, { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlarmClock,
  AudioLines,
  Bell,
  Bot,
  Compass,
  ExternalLink,
  MapPin,
  Mic,
  MicOff,
  Navigation,
  Send,
  ShieldCheck,
  Sparkles,
  Volume2,
  VolumeX,
} from "lucide-react";

import NotificationSettings from "./components/NotificationSettings";
import RemindersManager from "./components/RemindersManager";
import ChatMessages from "./components/ChatMessages";
import { enableNotifications } from "./firebase";
// import Testtoken from "./TokenTest"

const API_BASE =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? "http://127.0.0.1:8000" : "");

const initialMessages = [
  {
    role: "assistant",
    content:
      "Hello! I’m AURA. Ask me a question, check your approximate location, read your latest Gmail messages, or get current news.",
  },
];

const REMINDER_SEEN_KEY = "aura_seen_reminder_event";

// FastAPI returns `detail` as a string for HTTP errors but as a list of objects
// for 422 validation errors; turn either into readable text.
function formatApiError(data, fallback) {
  const detail = data?.detail ?? data?.error;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((item) => {
        const field = Array.isArray(item?.loc) ? item.loc.slice(1).join(".") : "";
        return field ? `${field}: ${item?.msg || "invalid"}` : item?.msg || JSON.stringify(item);
      })
      .join("; ");
  }
  if (detail && typeof detail === "object") return JSON.stringify(detail);
  return fallback;
}

export default function App() {
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(true);
  const [apiOnline, setApiOnline] = useState(false);
  const [location, setLocation] = useState(null);
  const [locationLoading, setLocationLoading] = useState(false);
  const [status, setStatus] = useState("Ready when you are");
  const [voiceMode, setVoiceMode] = useState(false);
  const [reminderDraft, setReminderDraft] = useState(null);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [reminderNotice, setReminderNotice] = useState("");
  const voiceModeRef = useRef(false);
  // Ref mirrors reminderDraft so voice callbacks (created once) never see stale state.
  const reminderDraftRef = useRef(null);
  const [reminderAlert, setReminderAlert] = useState(null);
  const [firedReminders, setFiredReminders] = useState([]); // newest first
  const [seenEventId, setSeenEventId] = useState(0);
  const [showReminderPanel, setShowReminderPanel] = useState(false);
  const lastEventIdRef = useRef(0);
  const processedEventIdsRef = useRef(new Set());
  const reminderPollInFlightRef = useRef(false);
  const [showReminders, setShowReminders] = useState(false);
  const [reminderListVersion, setReminderListVersion] = useState(0);
  const sayRef = useRef(null);

  const bottomRef = useRef(null);
  const recognitionRef = useRef(null);
  const restartTimerRef = useRef(null);

  // Check the Python backend without returning a Promise from useEffect.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function checkBackend() {
      try {
        const response = await fetch(`${API_BASE}/api/health`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error("Backend health check failed");
        }

        const data = await response.json();

        if (!cancelled) {
          setApiOnline(Boolean(data.ok));
        }
      } catch (error) {
        if (!cancelled && error.name !== "AbortError") {
          setApiOnline(false);
          console.error("Backend connection check failed:", error);
        }
      }
    }

    checkBackend();

    return () => {
      cancelled = true;
      controller.abort();

      if (recognitionRef.current) {
        const recognition = recognitionRef.current;

        recognition.onstart = null;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;

        try {
          recognition.stop();
        } catch {
          // Recognition may already be stopped.
        }

        recognitionRef.current = null;
      }

      if (restartTimerRef.current) {
        window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }

      voiceModeRef.current = false;

      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // Load reminder history once, then announce each newly fired event only once.
  useEffect(() => {
    let cancelled = false;
    let initialised = false;

    async function pollFiredReminders() {
      // Prevent overlapping requests from processing the same event twice.
      if (reminderPollInFlightRef.current) return;
      reminderPollInFlightRef.current = true;

      try {
        const response = await fetch(
          `${API_BASE}/api/reminders/events?after_id=${lastEventIdRef.current}&limit=200`
        );
        if (!response.ok || cancelled) return;

        const data = await response.json();
        const events = Array.isArray(data.events) ? data.events : [];
        const latestId = Number(data.latest_id) || 0;

        // Initial load is history only: do not replay old reminders on page render.
        if (!initialised) {
          initialised = true;
          let stored = null;
          try {
            stored = window.localStorage.getItem(REMINDER_SEEN_KEY);
          } catch {
            // Storage may be unavailable.
          }

          setSeenEventId(stored === null ? latestId : Number(stored) || 0);
          for (const event of events) {
            if (event?.id != null) processedEventIdsRef.current.add(Number(event.id));
          }
          lastEventIdRef.current = Math.max(
            lastEventIdRef.current,
            latestId,
            ...events.map((event) => Number(event.id) || 0)
          );
          setFiredReminders(
            [...events].reverse().filter((event, index, all) =>
              all.findIndex((item) => String(item.id) === String(event.id)) === index
            )
          );
          return;
        }

        // Defensively deduplicate by database event ID, even if the API repeats rows.
        const newEvents = events.filter((event) => {
          if (event?.id == null) return false;
          const id = Number(event.id);
          if (processedEventIdsRef.current.has(id)) return false;
          processedEventIdsRef.current.add(id);
          return true;
        });

        lastEventIdRef.current = Math.max(
          lastEventIdRef.current,
          latestId,
          ...events.map((event) => Number(event.id) || 0)
        );

        if (!newEvents.length || cancelled) return;

        setReminderListVersion((version) => version + 1);
        setFiredReminders((previous) => {
          const byId = new Map(previous.map((event) => [String(event.id), event]));
          for (const event of newEvents) byId.set(String(event.id), event);
          return [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id));
        });

        setMessages((previous) => {
          const existingEventIds = new Set(
            previous.map((message) => message.reminderEventId).filter(Boolean).map(String)
          );
          const additions = newEvents
            .filter((event) => !existingEventIds.has(String(event.id)))
            .map((event) => ({
              id: `reminder-event-${event.id}`,
              reminderEventId: event.id,
              role: "assistant",
              content: `⏰ Reminder: ${event.title}`,
            }));
          return additions.length ? [...previous, ...additions] : previous;
        });

        const last = newEvents[newEvents.length - 1];
        setReminderAlert({ title: last.title, firedAt: last.fired_at });
        setStatus(`Reminder: ${last.title}`);
        sayRef.current?.(
          newEvents.length === 1
            ? `Reminder: ${last.title}`
            : `You have ${newEvents.length} reminders: ${newEvents.map((event) => event.title).join(", ")}`
        );

        // Show one native notification per newly processed event.
        try {
          if (
            "Notification" in window &&
            Notification.permission === "granted" &&
            document.visibilityState === "visible"
          ) {
            newEvents.forEach((event) => {
              new Notification("⏰ AURA Reminder", {
                body: event.title,
                icon: "/favicon.ico",
                tag: `aura-reminder-${event.id}`,
                requireInteraction: true,
              });
            });
          }
        } catch (error) {
          console.debug("Local notification failed:", error);
        }
      } catch (error) {
        if (!cancelled) console.debug("Reminder poll failed:", error);
      } finally {
        reminderPollInFlightRef.current = false;
      }
    }

    void pollFiredReminders();
    const timer = window.setInterval(() => void pollFiredReminders(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Mark reminders as read while the notification panel is open.
  useEffect(() => {
    if (!showReminderPanel || !firedReminders.length) return;
    const newest = Math.max(...firedReminders.map((event) => event.id));
    if (newest > seenEventId) {
      setSeenEventId(newest);
      try {
        window.localStorage.setItem(REMINDER_SEEN_KEY, String(newest));
      } catch {
        // ignore
      }
    }
  }, [showReminderPanel, firedReminders, seenEventId]);

  // Scroll to the newest conversation message.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [messages, busy]);

function say(text) {
  if (!speakReplies || !("speechSynthesis" in window)) {
    if (voiceModeRef.current) {
      restartTimerRef.current = window.setTimeout(() => {
        if (voiceModeRef.current) startListening();
      }, 400);
    }
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-IN";
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;

  utterance.onstart = () => {
    setStatus("AURA is speaking…");
  };

  utterance.onend = () => {
    if (voiceModeRef.current) {
      setStatus("Listening again…");
      restartTimerRef.current = window.setTimeout(() => {
        if (voiceModeRef.current) startListening();
      }, 400);
    } else {
      setStatus("Ready when you are");
    }
  };

  utterance.onerror = (event) => {
    console.error("Speech output error:", event.error);
    setStatus("Reply received, but speech playback failed");
    if (voiceModeRef.current) {
      restartTimerRef.current = window.setTimeout(() => {
        if (voiceModeRef.current) startListening();
      }, 500);
    }
  };

  window.speechSynthesis.speak(utterance);
}

sayRef.current = say;

function startListening() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    voiceModeRef.current = false;
    setVoiceMode(false);
    setListening(false);
    setStatus("Voice recognition is not supported. Try Chrome or Edge.");
    return;
  }

  if (!voiceModeRef.current || busy || recognitionRef.current) return;

  const recognition = new SpeechRecognition();
  recognitionRef.current = recognition;
  recognition.lang = "en-IN";
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalTranscript = "";
  let hadRecognitionError = false;

  recognition.onstart = () => {
    setListening(true);
    setStatus("Listening… speak now");
    console.log("[AURA] Voice recognition started");
  };

  recognition.onresult = (event) => {
    let interimTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalTranscript += `${transcript} `;
      else interimTranscript += transcript;
    }

    const transcript = `${finalTranscript}${interimTranscript}`.trim();
    if (transcript) setInput(transcript);
  };

  recognition.onerror = (event) => {
    hadRecognitionError = true;
    setListening(false);

    const messages = {
      "not-allowed": "Microphone permission denied. Allow microphone access in browser settings.",
      "no-speech": "I couldn't hear anything. Please try speaking again.",
      "audio-capture": "No microphone detected. Check your microphone connection.",
      network: "Voice recognition network error. Try Chrome/Edge again or use text input.",
    };

    setStatus(messages[event.error] || `Microphone error: ${event.error}`);
    console.error("[AURA] Speech recognition error:", event.error);

    // Stop automatic retries on errors, especially network errors, to avoid a retry loop.
    voiceModeRef.current = false;
    setVoiceMode(false);
  };

  recognition.onend = () => {
    setListening(false);
    if (recognitionRef.current === recognition) recognitionRef.current = null;

    const transcript = finalTranscript.trim();
    if (transcript && !hadRecognitionError) {
      setInput("");
      setStatus("Sending your message to AURA…");
      void sendMessage(transcript);
      return;
    }

    if (voiceModeRef.current && !hadRecognitionError) {
      setStatus("Listening again…");
      restartTimerRef.current = window.setTimeout(() => {
        if (voiceModeRef.current) startListening();
      }, 500);
    } else if (!voiceModeRef.current) {
      setStatus("Ready when you are");
    }
  };

  try {
    recognition.start();
  } catch (error) {
    if (recognitionRef.current === recognition) recognitionRef.current = null;
    setListening(false);
    voiceModeRef.current = false;
    setVoiceMode(false);
    setStatus("Could not start microphone");
    console.error("[AURA] Unable to start recognition:", error);
  }
}

function toggleMic() {
  if (voiceModeRef.current) {
    voiceModeRef.current = false;
    setVoiceMode(false);
    setStatus("Voice mode stopped");

    if (restartTimerRef.current) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Recognition may already have stopped.
      }
    }
    setListening(false);
    return;
  }

  voiceModeRef.current = true;
  setVoiceMode(true);
  setStatus("Starting voice mode…");
  startListening();
}


function sendTestNotification() {
  if (!("Notification" in window)) {
    return {
      success: false,
      message: "This browser does not support notifications.",
    };
  }

  if (Notification.permission !== "granted") {
    return {
      success: false,
      message:
        "Notifications are not enabled yet. Click Enable Push Notifications in the sidebar first.",
    };
  }

  try {
    new Notification("AURA Test Notification", {
      body: "Your voice assistant notification test is working!",
      icon: "/favicon.ico",
    });

    return {
      success: true,
      message:
        "I've triggered a test notification. Check your device. This is a local browser notification, not yet a Firebase push.",
    };
  } catch (error) {
    console.error("Could not show test notification:", error);
    return {
      success: false,
      message: "I couldn't display the test notification.",
    };
  }
}

  function updateReminderDraft(draft) {
    reminderDraftRef.current = draft;
    setReminderDraft(draft);
  }

  // Parse a natural-language reminder using the backend, then ask the user to confirm it.
  async function prepareVoiceReminder(command) {
    setReminderBusy(true);
    setReminderNotice("");

    try {
      const token = await enableNotifications();
      const response = await fetch(`${API_BASE}/api/reminders/voice/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: command, // accepted by every backend version
          command,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
          token,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(formatApiError(data, "Could not understand the reminder. Check the backend reminder preview endpoint."));
      }

      if (data.success === false) {
        throw new Error(data.error || "I couldn't understand that reminder.");
      }

      if (!data.title || !data.due_at) {
        throw new Error("The backend did not return a reminder title and due_at date/time.");
      }

      const draft = { ...data, token, command };
      updateReminderDraft(draft);
      const dueText = new Date(data.due_at).toLocaleString("en-IN", {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      });
      const confirmation = `I understood: ${data.title}, scheduled for ${dueText}. Please confirm it below.`;
      setReminderNotice(confirmation);
      setMessages((previous) => [
        ...previous,
        { role: "assistant", content: confirmation },
      ]);
      setStatus("Waiting for reminder confirmation");
      say(confirmation);
    } catch (error) {
      console.error("Reminder preview failed:", error);
      const message = error.message || "Could not prepare reminder.";
      setReminderNotice(message);
      setMessages((previous) => [
        ...previous,
        { role: "assistant", content: message, error: true },
      ]);
      setStatus("Could not prepare reminder");
      say(message);
    } finally {
      setReminderBusy(false);
    }
  }

  async function confirmVoiceReminder() {
    const draft = reminderDraftRef.current;
    if (!draft || reminderBusy) return;

    setReminderBusy(true);
    try {
      const response = await fetch(`${API_BASE}/api/reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: draft.title,
          due_at: draft.due_at,
          timezone: draft.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
          token: draft.token,
          body: draft.body || `Reminder: ${draft.title}`,
          url: "/",
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(formatApiError(data, "Could not schedule reminder."));
      }

      const message = data.message || `Reminder scheduled: ${draft.title}`;
      updateReminderDraft(null);
      setReminderNotice(message);
      setMessages((previous) => [
        ...previous,
        { role: "assistant", content: message },
      ]);
      setStatus("Reminder scheduled");
      setReminderListVersion((v) => v + 1);
      say(message);
    } catch (error) {
      console.error("Reminder scheduling failed:", error);
      const message = error.message || "Could not schedule reminder.";
      setReminderNotice(message);
      setStatus("Reminder scheduling failed");
      setMessages((previous) => [
        ...previous,
        { role: "assistant", content: message, error: true },
      ]);
      say(message);
    } finally {
      setReminderBusy(false);
    }
  }

  function cancelVoiceReminder() {
    updateReminderDraft(null);
    setReminderNotice("Reminder cancelled.");
    setStatus("Reminder cancelled");
  }

async function sendMessage(text = input) {
  const message = text.trim();

  if (!message || busy) {
    console.log("[AURA] Request skipped:", {
      emptyMessage: !message,
      busy,
    });
    return;
  }

    // Allow voice or text confirmation/cancellation for a pending reminder.
    // Speech recognition adds punctuation ("Yes."), so strip it before matching.
    const spoken = message.replace(/[.!?,]+$/g, "").trim();

    if (reminderDraftRef.current && /^(yes|yeah|yep|confirm|confirm reminder|schedule it|yes schedule it)$/i.test(spoken)) {
      setInput("");
      setMessages((previous) => [...previous, { role: "user", content: message }]);
      await confirmVoiceReminder();
      return;
    }

    if (reminderDraftRef.current && /^(no|nope|cancel|cancel reminder|don't schedule it|do not schedule it)$/i.test(spoken)) {
      setInput("");
      setMessages((previous) => [...previous, { role: "user", content: message }]);
      cancelVoiceReminder();
      return;
    }

    // Route reminder commands to the reminder preview flow.
    const isReminderCommand =
      !/^\s*(what|how|why|who|when|where|is|are|does|do)\b/i.test(message) &&
      /\b(?:remind|reminders?|remainders?|remember\s+me\s+to|timer|alarm)\b/i.test(message);

    console.log("[AURA] Heard:", JSON.stringify(message), "| reminder command:", isReminderCommand);

    if (isReminderCommand) {
      setInput("");
      setMessages((previous) => [...previous, { role: "user", content: message }]);
      await prepareVoiceReminder(message);
      return;
    }

  // Handle a test notification command locally, without calling the AI backend.
  const normalizedMessage = message.toLowerCase();
  const isTestNotificationCommand =
    normalizedMessage.includes("test notification") ||
    normalizedMessage.includes("send me a notification") ||
    normalizedMessage.includes("send a test notification");

  if (isTestNotificationCommand) {
    const result = sendTestNotification();

    setInput("");
    setMessages((previous) => [
      ...previous,
      { role: "user", content: message },
      { role: "assistant", content: result.message },
    ]);
    setStatus(result.success ? "Test notification sent" : result.message);
    say(result.message);
    return;
  }

  const requestId = `AURA-${Date.now()}`;
  const start = performance.now();

  const logTime = (stage) => {
    console.log(
      `[${requestId}] ${stage}:`,
      `${((performance.now() - start) / 1000).toFixed(2)}s`
    );
  };

  setInput("");
  setMessages((previous) => [
    ...previous,
    { role: "user", content: message },
  ]);
  setBusy(true);
  setStatus("AURA is thinking…");

  logTime("Chat request started");

  try {
    logTime("Sending POST /api/chat");

  
const response = await fetch(`${API_BASE}/api/chat`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({ message }),
});

logTime(`HTTP response received (${response.status})`);

// Read the response body only once.
const responseText = await response.text();

let data = {};

if (responseText.trim()) {
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Server returned invalid JSON (HTTP ${response.status}): ` +
      responseText.slice(0, 300)
    );
  }
}

logTime("Response parsed");

if (!response.ok) {
  throw new Error(
    data.detail ||
    data.error ||
    `Request failed with HTTP ${response.status}`
  );
}

const reply = data.reply;

if (typeof reply !== "string" || !reply.trim()) {
  throw new Error("The backend returned no assistant reply.");
}

setMessages((previous) => [
  ...previous,
  { role: "assistant", content: reply },
]);

setStatus("Ready when you are");
say(reply);

    
    logTime("Speech playback requested");
  } catch (error) {
    logTime("Request failed");
    console.error(`[${requestId}] Error:`, error);

    setMessages((previous) => [
      ...previous,
      {
        role: "assistant",
        content:
          `${error.message} Check that the Python API is running ` +
          "and backend/.env contains your Groq key.",
        error: true,
      },
    ]);

    setStatus("Connection needs attention");
  } finally {
    setBusy(false);
    logTime("Chat request finished");
  }
}



  function getDeviceLocation() {
    if (!navigator.geolocation) {
      setStatus("Device geolocation is not supported");
      return;
    }

    setLocationLoading(true);
    setStatus("Waiting for location permission…");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const loc = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: Math.round(position.coords.accuracy),
        };

        setLocation(loc);
        setLocationLoading(false);
        setStatus("Device location retrieved");

        setMessages((previous) => [
          ...previous,
          {
            role: "assistant",
            content:
              `Your browser provided device coordinates: ` +
              `latitude ${loc.latitude.toFixed(6)}, ` +
              `longitude ${loc.longitude.toFixed(6)}. ` +
              `Reported accuracy: about ${loc.accuracy} metres. ` +
              "Accuracy depends on your device and available location signals.",
          },
        ]);
      },
      (error) => {
        setLocationLoading(false);

        setStatus(
          error.code === 1
            ? "Location permission denied"
            : "Could not retrieve device location"
        );

        setMessages((previous) => [
          ...previous,
          {
            role: "assistant",
            content:
              `I couldn't access device location: ${error.message}. ` +
              "Allow location access in your browser and try again.",
          },
        ]);
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 30000,
      }
    );
  }

  async function getApproxLocation() {
    setLocationLoading(true);
    setStatus("Finding approximate location…");

    try {
      const response = await fetch(`${API_BASE}/api/location`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Location lookup failed");
      }

      setLocation(data);

      const place = [data.city, data.region, data.country]
        .filter(Boolean)
        .join(", ");

      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content:
            `Your approximate IP location is ${place || "not available"}. ` +
            "This is network-based and may not match your exact device location.",
        },
      ]);

      setStatus("Approximate location retrieved");
    } catch (error) {
      setStatus(error.message);

      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: `Could not retrieve approximate location: ${error.message}`,
          error: true,
        },
      ]);
    } finally {
      setLocationLoading(false);
    }
  }

  const unreadReminders = firedReminders.filter((event) => event.id > seenEventId).length;

  const mapUrl =
    location?.latitude != null && location?.longitude != null
      ? `https://www.google.com/maps?q=${location.latitude},${location.longitude}`
      : null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <AudioLines size={24} />
          </div>
          <div>
            <strong>AURA</strong>
            <span>PERSONAL AI</span>
          </div>
        </div>

        <div className="side-label">WORKSPACE</div>

        <button className="nav-item active" type="button">
          <Sparkles size={18} />
          Assistant
          <span className="nav-dot" />
        </button>

        <button
          className="nav-item"
          type="button"
          onClick={getDeviceLocation}
          disabled={locationLoading}
        >
          <MapPin size={18} />
          Device location
        </button>

        <button
          className="nav-item"
          type="button"
          onClick={getApproxLocation}
          disabled={locationLoading}
        >
          <Compass size={18} />
          Approx. IP location
        </button>

        <button
          className="nav-item"
          type="button"
          onClick={() => setShowReminders(true)}
        >
          <AlarmClock size={18} />
          Set reminder
        </button>

        <div className="notification-sidebar">
  <NotificationSettings />
</div>

        <div className="sidebar-bottom">
          <div className="secure-card">
            <ShieldCheck size={18} />
            <div>
              <strong>Privacy first</strong>
              <p>
                Location is requested only when you ask. Email access is
                read-only.
              </p>
            </div>
          </div>

          <div className="profile">
            <div className="avatar">A</div>
            <div>
              <strong>AURA Assistant</strong>
              <span>Local web interface</span>
            </div>
            <Activity size={17} className="profile-activity" />
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="mobile-brand">
            <div className="brand-mark">
              <AudioLines size={19} />
            </div>
            <strong>AURA</strong>
          </div>

          <div className="connection">
            <span
              className={`connection-dot ${apiOnline ? "online" : ""}`}
            />
            {apiOnline ? "Backend connected" : "Backend not connected"}
          </div>

          <div style={{ position: "relative" }}>
            <button
              className="icon-button"
              type="button"
              title="Reminder notifications"
              aria-label="Reminder notifications"
              onClick={() => setShowReminderPanel((value) => !value)}
            >
              <Bell size={18} />
              {unreadReminders > 0 && (
                <span
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -4,
                    minWidth: 18,
                    height: 18,
                    padding: "0 5px",
                    borderRadius: 9,
                    background: "#ef4444",
                    color: "#fff",
                    fontSize: 11,
                    lineHeight: "18px",
                    textAlign: "center",
                  }}
                >
                  {unreadReminders}
                </span>
              )}
            </button>

            {showReminderPanel && (
              <div
                role="dialog"
                aria-label="Triggered reminders"
                style={{
                  position: "absolute",
                  top: "calc(100% + 8px)",
                  right: 0,
                  width: 340,
                  maxWidth: "90vw",
                  maxHeight: "70vh",
                  overflowY: "auto",
                  zIndex: 50,
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid #374151",
                  background: "#1f2937",
                  color: "#f9fafb",
                  boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
                }}
              >
                <strong style={{ display: "block", marginBottom: 8 }}>
                  Triggered reminders
                </strong>
                {firedReminders.length === 0 ? (
                  <p style={{ opacity: 0.7, margin: 0 }}>
                    No reminders have triggered yet.
                  </p>
                ) : (
                  firedReminders.map((event) => (
                    <div
                      key={event.id}
                      style={{
                        padding: "8px 0",
                        borderTop: "1px solid #374151",
                      }}
                    >
                      <div>⏰ {event.title}</div>
                      <small style={{ opacity: 0.7 }}>
                        {new Date(event.fired_at).toLocaleString("en-IN", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                        {event.status === "push_failed" && " · push failed"}
                      </small>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          <button
            className="icon-button"
            type="button"
            title={speakReplies ? "Mute replies" : "Enable spoken replies"}
            onClick={() => {
              setSpeakReplies((value) => !value);

              if (speakReplies && "speechSynthesis" in window) {
                window.speechSynthesis.cancel();
              }
            }}
            aria-label="Toggle spoken replies"
          >
            {speakReplies ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
        </header>

        {reminderAlert && (
          <div
            role="alert"
            style={{
              margin: "12px 16px 0",
              padding: "14px 16px",
              borderRadius: "12px",
              border: "1px solid #f59e0b",
              background: "rgba(245, 158, 11, 0.15)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "12px",
            }}
          >
            <span>
              <strong>⏰ Reminder:</strong> {reminderAlert.title}
              {reminderAlert.firedAt && (
                <small style={{ marginLeft: 8, opacity: 0.7 }}>
                  {new Date(reminderAlert.firedAt).toLocaleTimeString("en-IN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </small>
              )}
            </span>
            <button type="button" onClick={() => setReminderAlert(null)}>
              Dismiss
            </button>
          </div>
        )}

        <section className="content-area">
          <div className="hero">
            <div className="eyebrow">
              <span className="pulse" />
              YOUR AI COMPANION
            </div>

            <div className="orb-wrap">
              <div className="orb-halo" />
              <div className="orb">
                <div className="orb-core" />
                <div className="orb-shine" />
              </div>
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />
            </div>

            <h1>
              How can I help <span>you today?</span>
            </h1>

            <p className="hero-sub">
              Your voice, your assistant. Ask naturally and let’s get things
              done.
            </p>

            <div className="quick-actions">
              <button
                type="button"
                onClick={() =>
                  sendMessage("Read my latest 3 unread emails and summarize them.")
                }
              >
                <span className="quick-icon mail-icon">✉</span>
                <span>
                  <strong>Read my emails</strong>
                  <small>Summarize unread Gmail</small>
                </span>
              </button>

              <button
                type="button"
                onClick={() => sendMessage("Give me the latest technology news.")}
              >
                <span className="quick-icon news-icon">↗</span>
                <span>
                  <strong>Latest news</strong>
                  <small>Headlines that matter</small>
                </span>
              </button>

              <button type="button" onClick={getDeviceLocation}>
                <span className="quick-icon location-icon">
                  <Navigation size={17} />
                </span>
                <span>
                  <strong>My location</strong>
                  <small>Use device permission</small>
                </span>
              </button>
            </div>
          </div>

          <section className="chat-panel">
            <div className="chat-heading">
              <div>
                <span className="chat-heading-icon">
                  <Bot size={17} />
                </span>
                <strong>Conversation</strong>
              </div>

              <span className="live-status">
                <span className="tiny-green" />
                {status}
              </span>
            </div>

            <ChatMessages messages={messages} busy={busy} bottomRef={bottomRef} />

            {reminderDraft && (
              <section
                className="reminder-confirmation"
                aria-live="polite"
                style={{
                  margin: "12px 16px",
                  padding: "16px",
                  border: "1px solid var(--border-color, #d1d5db)",
                  borderRadius: "12px",
                }}
              >
                <h3 style={{ marginTop: 0 }}>Confirm reminder</h3>
                <p><strong>Task:</strong> {reminderDraft.title}</p>
                <p>
                  <strong>Date and time:</strong>{" "}
                  {new Date(reminderDraft.due_at).toLocaleString("en-IN", {
                    timeZone: reminderDraft.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
                    dateStyle: "full",
                    timeStyle: "short",
                  })}
                </p>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <button type="button" onClick={confirmVoiceReminder} disabled={reminderBusy}>
                    {reminderBusy ? "Scheduling…" : "Confirm and schedule"}
                  </button>
                  <button type="button" onClick={cancelVoiceReminder} disabled={reminderBusy}>
                    Cancel
                  </button>
                </div>
              </section>
            )}
            {reminderBusy && !reminderDraft && (
              <p style={{ padding: "0 16px" }} role="status">Preparing reminder…</p>
            )}
            {reminderNotice && !reminderDraft && !reminderBusy && (
              <p style={{ padding: "0 16px" }} role="status">{reminderNotice}</p>
            )}

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                sendMessage();
              }}
            >
              <button
                type="button"
                className={`mic-button ${voiceMode ? "is-listening" : ""}`}
                onClick={toggleMic}
                title={voiceMode ? "Stop voice mode" : "Start voice mode"}
                aria-label={voiceMode ? "Stop voice mode" : "Start voice mode"}
              >
                {voiceMode ? <MicOff size={19} /> : <Mic size={19} />}
              </button>

              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Message AURA…"
                aria-label="Message AURA"
                disabled={busy}
              />

              <button
                className="send-button"
                type="submit"
                disabled={busy || !input.trim()}
                aria-label="Send message"
              >
                <Send size={17} />
              </button>
            </form>

            <div className="composer-foot">
              <span>
                <ShieldCheck size={12} />
                Your API key stays on the backend
              </span>
              <span>{voiceMode ? "VOICE MODE ON · CLICK MIC TO STOP" : "ENTER TO SEND · CLICK MIC FOR VOICE MODE"}</span>
            </div>
          </section>

          {location && (
            <div className="location-card">
              <div className="location-symbol">
                <MapPin size={20} />
              </div>

              <div className="location-info">
                <strong>Location details</strong>
                <span>
                  {location.city
                    ? [location.city, location.region, location.country]
                        .filter(Boolean)
                        .join(", ")
                    : `${location.latitude}, ${location.longitude}`}
                </span>
                <small>
                  {typeof location.accuracy === "number"
                    ? `Reported accuracy: about ${location.accuracy} m`
                    : location.accuracy || "Location data"}
                </small>
              </div>

              {mapUrl && (
                <a
                  href={mapUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="map-link"
                >
                  Open map <ExternalLink size={14} />
                </a>
              )}
            </div>
          )}

          <div className="location-actions">
            <button
              type="button"
              onClick={getDeviceLocation}
              disabled={locationLoading}
            >
              <Navigation size={15} />
              {locationLoading ? "Getting location…" : "Get device location"}
            </button>

            <button
              type="button"
              onClick={getApproxLocation}
              disabled={locationLoading}
            >
              <Compass size={15} />
              Approximate IP location
            </button>
          </div>
        </section>

        <footer className="footer">
          AURA <span>•</span> Built for helpful conversations <span>•</span>
          Location access requires your permission
        </footer>
      </main>

      <RemindersManager
        open={showReminders}
        onClose={() => setShowReminders(false)}
        apiBase={API_BASE}
        refreshKey={reminderListVersion}
        onChanged={() => setReminderListVersion((v) => v + 1)}
      />
    </div>
  );
}