import React, { useEffect, useRef, useState } from "react";
import "./App.css";
import {
  Activity,
  AlarmClock,
  Bell,
  Bot,
  Mic,
  Mail,
  Inbox,
  ChevronRight,
  MicOff,
  Send,
  ShieldCheck,
  Sparkles,
  Volume2,
} from "lucide-react";

import NotificationSettings from "./components/NotificationSettings";
import RemindersManager from "./components/RemindersManager";
import EmailScheduler from "./EmailScheduler";
import { enableNotifications } from "./firebase";
// import Testtoken from "./TokenTest"

const API_BASE =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? "http://127.0.0.1:8000" : "");

const initialMessages = [
  {
    role: "assistant",
    content:
      "Hello! I’m AURA. I can set reminders, draft and schedule emails, read your latest emails, summarize messages, and help with everyday tasks. Try one of the prompts below or speak naturally.",
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

function isNaturalLanguageReminder(message) {
  const text = message.toLowerCase().trim();

  // Existing explicit reminder commands always qualify.
  const explicitReminder =
    /\b(?:remind(?:er|ers)?|remainders?|remember me to|set an alarm|set a timer|wake me)\b/i.test(
      text
    );

  if (explicitReminder) return true;

  // Detect future dates and times.
  const futureTime =
    /\b(?:today|tonight|tomorrow|day after tomorrow|next week|this evening|this afternoon|this morning)\b/i.test(
      text
    ) ||
    /\b(?:in\s+\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?))\b/i.test(
      text
    ) ||
    /\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(
      text
    ) ||
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
      text
    ) ||
    /\b(?:at|by|before|after)\s+\d{1,2}(?::\d{2})?\b/i.test(text);

  // Detect an action or event to remember.
  const taskIntent =
    /\b(?:call|meet|attend|pay|submit|send|take|drink|buy|pick up|visit|finish|start|go|check|prepare|study|exercise|book|collect|complete|renew|review|join|discuss|appointment|meeting|interview|deadline|birthday|bill|medicine|medication|don't forget|do not forget|need to|make sure)\b/i.test(
      text
    );

  return futureTime && taskIntent;
}

export default function App() {
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [activeSidePanel, setActiveSidePanel] = useState("actions");
  const [reminderItems, setReminderItems] = useState([]);
  const [remindersLoading, setRemindersLoading] = useState(false);
  const [remindersError, setRemindersError] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(true);
  const [apiOnline, setApiOnline] = useState(false);
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

  const toggleMicRef = useRef(null);

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

  console.error("[AURA] Recognition error:", event.error);
  console.log("[AURA] Voice mode before error:", voiceModeRef.current);

  setListening(false);

  const messages = {
    "not-allowed": "Microphone permission denied. Allow microphone access.",
    "no-speech": "No speech detected. Please try again.",
    "audio-capture": "No microphone detected. Check your microphone.",
    network: "Speech recognition network error.",
    aborted: "Speech recognition was interrupted.",
    "service-not-allowed": "Speech recognition service is not allowed.",
  };

  setStatus(messages[event.error] || `Microphone error: ${event.error}`);

  // Stop retrying after a real recognition error.
  voiceModeRef.current = false;
  setVoiceMode(false);
};

  recognition.onend = () => {
     console.log("[AURA] Recognition ended", {
    voiceMode: voiceModeRef.current,
    transcript: finalTranscript,
    hadRecognitionError,
  });
  
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

// Keep the latest toggleMic function in the ref.
toggleMicRef.current = toggleMic;

// Listen for clicks from the floating Electron emoji.
useEffect(() => {
  if (!window.auraDesktop?.onToggleListening) {
    console.log("[AURA] Running without the Electron floating assistant");
    return;
  }

  const unsubscribe = window.auraDesktop.onToggleListening(() => {
    console.log("[AURA] Floating emoji clicked");

    toggleMicRef.current?.();
  });

  console.log("[AURA] Electron bridge connected");

  return () => {
    if (typeof unsubscribe === "function") {
      unsubscribe();
    }
  };
}, []);


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
    // const isReminderCommand =
    //   !/^\s*(what|how|why|who|when|where|is|are|does|do)\b/i.test(message) &&
    //   /\b(?:remind|reminders?|remainders?|remember\s+me\s+to|timer|alarm)\b/i.test(message);

    // console.log("[AURA] Heard:", JSON.stringify(message), "| reminder command:", isReminderCommand);

    // if (isReminderCommand) {
    //   setInput("");
    //   setMessages((previous) => [...previous, { role: "user", content: message }]);
    //   await prepareVoiceReminder(message);
    //   return;
    // }

    // Detect reminders expressed in natural language,
// even when the user doesn't say "reminder".
const isReminderCommand = isNaturalLanguageReminder(message);

console.log(
  "[AURA] Heard:",
  JSON.stringify(message),
  "| reminder command:",
  isReminderCommand
);

if (isReminderCommand) {
  setInput("");

  setMessages((previous) => [
    ...previous,
    { role: "user", content: message },
  ]);

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
  async function loadReminderList() {
    setRemindersLoading(true);
    setRemindersError("");
    try {
      const response = await fetch(`${API_BASE}/api/reminders`);
      const data = await response.json();
      if (!response.ok) throw new Error(formatApiError(data, "Could not load reminders."));
      const rows = Array.isArray(data) ? data : (data.reminders || data.items || data.results || []);
      setReminderItems(rows);
    } catch (error) {
      console.error("Reminder list load failed:", error);
      setRemindersError(error.message || "Could not load reminders.");
      setReminderItems([]);
    } finally {
      setRemindersLoading(false);
    }
  }

  useEffect(() => {
    if (activeSidePanel === "reminders") void loadReminderList();
  }, [activeSidePanel, reminderListVersion]);
  const unreadReminders = firedReminders.filter((event) => event.id > seenEventId).length;

  return (
    <div className="aura-dashboard">


      <div className="aura-sunset" aria-hidden="true" />
      <div className="aura-skyline" aria-hidden="true" />

      <aside className="aura-sidebar">
        <div className="aura-brand">
          <div className="aura-brand-mark"><Bot size={25} /></div>
          <div className="aura-brand-copy">AURA Voice<br />Assistant</div>
        </div>
        <div className="aura-nav-label">WORKSPACE</div>
        <nav className="aura-nav" aria-label="Main navigation">
          <button className={activeSidePanel === "actions" ? "active" : ""} type="button" onClick={() => setActiveSidePanel("actions")}><Sparkles size={19} /><span>AURA Actions</span></button>
          <button className={activeSidePanel === "reminders" ? "active" : ""} type="button" onClick={() => { setActiveSidePanel("reminders"); setShowReminders(false); loadReminderList(); }}><AlarmClock size={19} /><span>Reminders</span></button>
          <button className={activeSidePanel === "emails" ? "active" : ""} type="button" onClick={() => setActiveSidePanel("emails")}><Mail size={19} /><span>Scheduled Emails</span></button>
        </nav>
        <div className="aura-notification-settings"><NotificationSettings /></div>
        <div className="aura-sidebar-spacer" />
        <div className="aura-privacy"><ShieldCheck size={17} /><span><strong>Privacy first</strong><br />Email access is read-only unless you approve a scheduled email.</span></div>
        <div className="aura-profile"><div className="aura-avatar">A</div><div className="aura-profile-copy"><strong>AURA Assistant</strong><br /><span style={{color:"#a9c7f3",fontSize:10}}>Personal AI companion</span></div><ChevronRight size={16} className="aura-profile-chevron" /></div>
      </aside>

      <main className="aura-center">
        <header className="aura-topline">
          <div className="aura-online"><span className="aura-dot" />{apiOnline ? "Backend connected" : "AURA assistant"}</div>
          <button className="aura-top-icon" type="button" title={speakReplies ? "Mute spoken replies" : "Enable spoken replies"} onClick={() => { setSpeakReplies((value) => !value); if (speakReplies && "speechSynthesis" in window) window.speechSynthesis.cancel(); }}><Volume2 size={17} /></button>
          <div style={{position:"relative"}}>
            <button className="aura-top-icon" type="button" aria-label="Reminder notifications" onClick={() => setShowReminderPanel((value) => !value)}><Bell size={17} />{unreadReminders > 0 && <span style={{position:"absolute",top:-3,right:-3,minWidth:16,height:16,borderRadius:9,background:"#f05267",color:"white",fontSize:9,lineHeight:"16px"}}>{unreadReminders}</span>}</button>
            {showReminderPanel && <div className="aura-reminder-pop" role="dialog" aria-label="Triggered reminders"><strong>Triggered reminders</strong>{firedReminders.length === 0 ? <p>No reminders have triggered yet.</p> : firedReminders.map((event) => <div className="aura-reminder-pop-item" key={event.id}>⏰ {event.title}<div style={{color:"#71809c",fontSize:10,marginTop:4}}>{new Date(event.fired_at).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short"})}</div></div>)}</div>}
          </div>
        </header>

        {reminderAlert && <div className="aura-reminder-alert" role="alert"><AlarmClock size={16} /><span><strong>Reminder:</strong> {reminderAlert.title}</span><button type="button" onClick={() => setReminderAlert(null)} aria-label="Dismiss reminder">×</button></div>}
        {status && status !== "Ready when you are" && <div className="aura-status-alert" role="status">{status}</div>}

        <section className="aura-hero">
          <div className="aura-pill"><Sparkles size={15} /> AURA VOICE ASSISTANT</div>
          <h1>{listening ? "I'm listening 🎙️" : "Hello! 👋"}<span>{listening ? "Speak naturally, I'm here to help" : "How can I help you today?"}</span></h1>
          <div className="aura-orb-zone">
            <div className="aura-orb-halo" />
            <div className="aura-wave" aria-hidden="true" />
            <button className={`aura-orb-button ${listening ? "listening" : ""}`} type="button" onClick={toggleMic} aria-label={voiceMode ? "Stop voice assistant" : "Start voice assistant"} aria-pressed={voiceMode}><Mic size={48} strokeWidth={1.8} /></button>
            <div className="aura-wave right" aria-hidden="true" />
          </div>
          <div className="aura-tap">{listening ? "Listening… speak now" : voiceMode ? "Voice mode active · tap to stop" : "Tap to speak"}</div>

          <div className="aura-quick-grid aura-action-prompts">
            <button className="aura-quick" type="button" onClick={() => sendMessage("Remind me to call [person] at 5 PM today")}><AlarmClock color="#ffb84e" /><strong>Set a reminder</strong><span>Choose a task and time</span></button>
            <button className="aura-quick" type="button" onClick={() => sendMessage("Draft an email to my saved recipient asking to reschedule a meeting")}><Mail color="#54c8ff" /><strong>Draft an email</strong><span>Review before scheduling</span></button>
            <button className="aura-quick" type="button" onClick={() => sendMessage("Read my latest emails and summarize the important ones")}><Inbox color="#a99bff" /><strong>Read my emails</strong><span>Summarize recent messages</span></button>
            <button className="aura-quick" type="button" onClick={() => sendMessage("Show my upcoming reminders")}><Bell color="#ff6677" /><strong>Upcoming reminders</strong><span>Check what is next</span></button>
          </div>

          <div className="aura-chat-peek" aria-live="polite">
            {busy ? <span><strong>AURA:</strong> Thinking…</span> : messages.length > 1 ? <><strong>{messages[messages.length - 1]?.role === "user" ? "You" : "AURA"}:</strong> {messages[messages.length - 1]?.content}</> : <span><strong>AURA:</strong> Try: set a reminder, draft an email, read my emails, or summarize an inbox.</span>}
          </div>

          <form className="aura-composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
            <Sparkles size={18} color="#c3d5ff" />
            <input id="aura-message-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask anything…" aria-label="Message AURA" disabled={busy} />
            <button type="submit" className="send" aria-label="Send message" disabled={busy || !input.trim()}><Send size={17} /></button>
            <button type="button" onClick={toggleMic} aria-label={voiceMode ? "Stop voice mode" : "Start voice mode"} title={voiceMode ? "Stop voice mode" : "Start voice mode"}>{voiceMode ? <MicOff size={18} /> : <Mic size={18} />}</button>
          </form>
        </section>

        {reminderDraft && <section className="aura-confirm" aria-live="polite"><h3>Confirm reminder</h3><p><strong>Task:</strong> {reminderDraft.title}</p><p><strong>Date and time:</strong> {new Date(reminderDraft.due_at).toLocaleString("en-IN",{timeZone:reminderDraft.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",dateStyle:"medium",timeStyle:"short"})}</p><div className="aura-confirm-actions"><button type="button" onClick={confirmVoiceReminder} disabled={reminderBusy}>{reminderBusy ? "Scheduling…" : "Confirm and schedule"}</button><button type="button" onClick={cancelVoiceReminder} disabled={reminderBusy}>Cancel</button></div></section>}
        {reminderNotice && !reminderDraft && !reminderBusy && <div className="aura-status-alert" role="status" style={{top:"auto",bottom:70}}>{reminderNotice}</div>}
      </main>

      <aside className="aura-right aura-explore-panel" aria-label={activeSidePanel === "emails" ? "Scheduled emails" : activeSidePanel === "reminders" ? "Reminder list" : "AURA actions"}>
        {activeSidePanel === "emails" ? (
          <EmailScheduler apiBase={API_BASE} />
        ) : activeSidePanel === "reminders" ? (
          <>
            <div className="aura-explore-title">
              <div className="aura-explore-icon"><AlarmClock size={19} /></div>
              <div><strong>Your reminders</strong><span>Scheduled reminders and their times</span></div>
              <button className="aura-panel-refresh" type="button" onClick={loadReminderList} aria-label="Refresh reminders">↻</button>
            </div>
            {remindersLoading ? <div className="aura-panel-message">Loading your reminders…</div> : remindersError ? <div className="aura-panel-error">{remindersError}<button type="button" onClick={loadReminderList}>Try again</button></div> : reminderItems.length === 0 ? <div className="aura-panel-empty"><AlarmClock size={28} /><strong>No reminders found</strong><span>Ask AURA to remind you of something, and it will appear here.</span></div> : (
              <div className="aura-side-list">
                {reminderItems.map((item, index) => {
                  const due = item.due_at || item.scheduled_at || item.remind_at || item.datetime;
                  return <article className="aura-side-reminder" key={item.id ?? item._id ?? `${item.title}-${index}`}>
                    <div className="aura-side-reminder-icon"><AlarmClock size={16} /></div>
                    <div className="aura-side-reminder-copy"><strong>{item.title || item.name || item.body || "Reminder"}</strong><span>{due ? new Date(due).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : item.status || "Scheduled reminder"}</span>{item.status && <small>{item.status}</small>}</div>
                  </article>;
                })}
              </div>
            )}
            <div className="aura-reminders-manage-inline">
              <div className="aura-reminders-manage-heading">
                <strong>Manage reminders</strong>
                <span>Create, edit, or remove your scheduled reminders.</span>
              </div>
              <RemindersManager
                open={true}
                inline
                onClose={() => setActiveSidePanel("actions")}
                apiBase={API_BASE}
                refreshKey={reminderListVersion}
                onChanged={() => {
                  setReminderListVersion((v) => v + 1);
                  loadReminderList();
                }}
              />
            </div>
          </>
        ) : (
          <>
            <div className="aura-explore-title">
              <div className="aura-explore-icon"><Sparkles size={19} /></div>
              <div><strong>Try an AURA action</strong><span>Tap a prompt to start</span></div>
            </div>
            <div className="aura-action-list">
              <button type="button" onClick={() => sendMessage("Remind me to take a break in 30 minutes")}><AlarmClock size={17} /><span><strong>Set a reminder</strong><small>“Remind me to take a break in 30 minutes”</small></span></button>
              <button type="button" onClick={() => sendMessage("Draft an email to my saved recipient about rescheduling a meeting")}><Mail size={17} /><span><strong>Draft an email</strong><small>“Draft an email about rescheduling a meeting”</small></span></button>
              <button type="button" onClick={() => sendMessage("Read my latest emails and summarize them")}><Inbox size={17} /><span><strong>Read my emails</strong><small>“Read my latest emails and summarize them”</small></span></button>
              <button type="button" onClick={() => sendMessage("Show my upcoming reminders")}><Bell size={17} /><span><strong>Upcoming reminders</strong><small>“What reminders do I have?”</small></span></button>
              <button type="button" onClick={() => sendMessage("Help me plan my day based on my upcoming reminders")}><Activity size={17} /><span><strong>Plan my day</strong><small>“Help me plan my day”</small></span></button>
            </div>
            <div className="aura-panel-empty"><Bot size={26} /><strong>Speak or type naturally</strong><span>AURA will respond in chat. For actions such as scheduling a reminder or email, review and confirm before it is saved or sent.</span></div>
          </>
        )}
      </aside>

    </div>
  );
}
