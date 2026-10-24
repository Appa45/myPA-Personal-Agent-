import React, { Component, useEffect, useRef, useState } from "react";
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
  ContactRound,
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

import ContactsManager from "./components/ContactsManager";
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

function isEmailCompositionCommand(message) {
  const text = message.trim();
  const asksToCompose =
    /\b(?:send|draft|write|compose|create)\b.{0,50}\b(?:an?\s+)?e-?mail\b/i.test(text) ||
    /\b(?:e-?mail)\s+to\s+[\w]/i.test(text);
  const asksToRead =
    /\b(?:read|check|fetch|retrieve|pull|summari[sz]e|show|get|list)\b.{0,35}\b(?:my\s+)?(?:latest|recent|inbox|emails?)\b/i.test(text);
  return asksToCompose && !asksToRead;
}

function isBulkEmailCommand(message) {
  const text = message.trim();
  const targetsAllContacts =
    /\b(?:all|every|each)\s+(?:of\s+)?(?:my\s+)?(?:saved\s+)?contacts\b/i.test(text) ||
    /\b(?:all|every)\s+(?:of\s+)?(?:my\s+)?(?:saved\s+)?contact\s+(?:emails|email addresses)\b/i.test(text);
  const isEmailAction =
    /\b(?:send|draft|write|compose|create|email|message)\b/i.test(text) &&
    /\b(?:email|e-mail|message|contacts?)\b/i.test(text);
  return targetsAllContacts && isEmailAction;
}

function extractBulkEmailInstruction(command) {
  let instruction = command.trim();

  // Remove the command and audience, preserving the actual message details.
  instruction = instruction.replace(
    /^\s*(?:please\s+)?(?:send|draft|write|compose|create)\s+(?:me\s+)?(?:an?\s+)?e-?mail\s+to\s+(?:all|every|each)\s+(?:of\s+)?(?:my\s+)?(?:saved\s+)?contacts?\s*/i,
    ""
  );
  instruction = instruction.replace(
    /^\s*(?:please\s+)?(?:email|message)\s+(?:all|every|each)\s+(?:of\s+)?(?:my\s+)?(?:saved\s+)?contacts?\s*/i,
    ""
  );
  instruction = instruction.replace(/^\s*(?:saying|that|with the message|message is|message:)\s*/i, "").trim();

  // If the command includes an explicit subject, separate it from the body.
  const subjectMatch = instruction.match(/^\s*(?:subject|with subject)\s*[:\-]\s*(.+?)(?:\s+\b(?:saying|message|body)\b\s*[:\-]?\s*|\n)([\s\S]*)$/i);
  if (subjectMatch) {
    return {
      subject: subjectMatch[1].trim().slice(0, 200) || "Message to all contacts",
      bodyInstruction: subjectMatch[2].trim(),
    };
  }

  instruction = instruction.replace(/^\s*(?:about|regarding)\s+/i, "I wanted to share an update regarding ");
  if (!instruction) {
    return {
      subject: "Message to all contacts",
      bodyInstruction: "",
    };
  }

  const lower = instruction.toLowerCase();
  let subject = "Message to all contacts";
  if (/\b(meeting|call|interview)\b/.test(lower)) subject = "Meeting Update";
  else if (/\b(reschedule|postpone|schedule change)\b/.test(lower)) subject = "Scheduling Update";
  else if (/\b(announcement|update|information)\b/.test(lower)) subject = "Important Update";

  return { subject, bodyInstruction: instruction };
}

function extractContactEmailInstruction(command) {
  const text = command.trim();
  // Accept "send an email to Salu saying ...", "email to Salu about ...",
  // and "draft an email to Salu that ...".
  const contactMatch = text.match(
    /\b(?:e-?mail|message)\s+to\s+(.+?)(?=\s+\b(?:saying|that|about|regarding|with subject|subject|to say|tell them|asking|ask|requesting)\b|[,;]|$)/i
  );

  if (!contactMatch?.[1]) {
    return {
      contactName: "",
      instruction: "",
    };
  }

  const contactName = contactMatch[1]
    .replace(/^(?:my\s+saved\s+contact|the\s+contact|contact)\s+/i, "")
    .trim();

  if (/^(?:my saved recipient|my contact|saved contact|my saved contact|recipient|contact)$/i.test(contactName)) {
    return { contactName: "", instruction: "" };
  }

  let instruction = text
    .replace(/\b(?:send|draft|write|compose|create)\s+(?:me\s+)?(?:an?\s+)?e-?mail\s+to\s+/i, "")
    .replace(/\b(?:e-?mail|message)\s+to\s+/i, "");

  instruction = instruction.replace(
    new RegExp(`^${contactName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"),
    ""
  );
  instruction = instruction.replace(/^\s*(?:saying|that|to say)\s+/i, "").trim();
  instruction = instruction.replace(/^\s*(?:about|regarding)\s+/i, "About ");
  if (!instruction) {
    instruction = "Draft a suitable email. Ask me for the email details if needed.";
  }

  return { contactName, instruction };
}

class ContactsManagerErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error("Contacts Manager render error:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, color: "#f4f5f7", background: "#151821", borderRadius: 14 }}>
          <h2 style={{ marginTop: 0 }}>Contacts could not be displayed</h2>
          <p style={{ color: "#b7bdcc" }}>
            The Contacts component encountered a rendering error. Check the browser console and
            confirm that ./components/ContactsManager.jsx and its CSS file exist.
          </p>
          <button type="button" onClick={() => this.setState({ hasError: false })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
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
  const [emailDraft, setEmailDraft] = useState(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailNotice, setEmailNotice] = useState("");
  const emailDraftRef = useRef(null);
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

  function updateEmailDraft(draft) {
    emailDraftRef.current = draft;
    setEmailDraft(draft);
  }

  async function prepareBulkEmailDraft(command) {
    setEmailBusy(true);
    setEmailNotice("");

    try {
      const contactsResponse = await fetch(`${API_BASE}/api/contacts`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      const contactsText = await contactsResponse.text();
      let contactsData = {};
      if (contactsText.trim()) {
        try {
          contactsData = JSON.parse(contactsText);
        } catch {
          throw new Error(`Contacts API returned invalid JSON (HTTP ${contactsResponse.status}).`);
        }
      }
      if (!contactsResponse.ok) {
        throw new Error(formatApiError(contactsData, "Could not load saved contacts."));
      }

      const contacts = Array.isArray(contactsData)
        ? contactsData
        : contactsData.contacts || contactsData.items || [];
      if (!Array.isArray(contacts) || contacts.length === 0) {
        throw new Error("You don't have any saved contacts with email addresses yet. Add contacts first.");
      }

      const recipients = contacts.filter(
        (contact) => typeof contact.email === "string" && contact.email.trim()
      );
      if (recipients.length === 0) {
        throw new Error("None of your saved contacts has an email address.");
      }

      const { subject, bodyInstruction } = extractBulkEmailInstruction(command);
      const body = bodyInstruction
        ? `Hello everyone,\n\n${bodyInstruction.charAt(0).toUpperCase()}${bodyInstruction.slice(1)}\n\nBest regards`
        : "Hello everyone,\n\n[Please add the message you want to send to all contacts.]\n\nBest regards";

      const draft = {
        isBulk: true,
        contact_name: "All saved contacts",
        recipient_count: recipients.length,
        subject,
        body,
        instruction: bodyInstruction,
      };
      updateEmailDraft(draft);

      const confirmation =
        `I've prepared a bulk email draft for ${recipients.length} saved contact${recipients.length === 1 ? "" : "s"}. Review the subject and message below, then choose Send email to send a separate email to each contact. Nothing will be sent until you confirm.`;
      setEmailNotice(confirmation);
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: `${confirmation}\n\nSubject: ${draft.subject}\n\n${draft.body}`,
        },
      ]);
      setStatus("Bulk email draft ready for review");
      say(confirmation);
    } catch (error) {
      console.error("Bulk email draft failed:", error);
      const errorMessage = error.message || "Could not prepare the bulk email draft.";
      setEmailNotice(errorMessage);
      setMessages((previous) => [
        ...previous,
        { role: "assistant", content: errorMessage, error: true },
      ]);
      setStatus("Could not prepare bulk email");
      say(errorMessage);
    } finally {
      setEmailBusy(false);
    }
  }

  async function prepareContactEmailDraft(command) {
    const { contactName, instruction } = extractContactEmailInstruction(command);

    if (!contactName) {
      const reply =
        "I can draft that email, but I couldn't identify the saved contact name. Please say: “Send an email to Salu saying …” using the exact name saved in Contacts.";
      setEmailNotice(reply);
      setMessages((previous) => [...previous, { role: "assistant", content: reply }]);
      setStatus("Contact name needed");
      say(reply);
      return;
    }

    setEmailBusy(true);
    setEmailNotice("");
    try {
      const response = await fetch(`${API_BASE}/api/email/draft-to-contact`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          contact_name: contactName,
          instruction,
        }),
      });

      const responseText = await response.text();
      let data = {};
      if (responseText.trim()) {
        try {
          data = JSON.parse(responseText);
        } catch {
          throw new Error(`Email draft API returned invalid JSON (HTTP ${response.status}).`);
        }
      }

      if (!response.ok) {
        throw new Error(
          formatApiError(data, `Could not draft the email (HTTP ${response.status}).`)
        );
      }

      if (!data.subject || !data.body) {
        throw new Error("The email draft endpoint did not return both a subject and a body.");
      }

      const draft = {
        ...data,
        contact_name: data.contact_name || contactName,
        instruction,
      };
      updateEmailDraft(draft);

      const confirmation =
        `I've prepared an email draft for ${draft.contact_name}. Please review the subject and message, then choose Send email or Cancel. I won't send it until you confirm.`;
      setEmailNotice(confirmation);
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: `${confirmation}\n\nSubject: ${draft.subject}\n\n${draft.body}`,
        },
      ]);
      setStatus("Email draft ready for review");
      say(confirmation);
    } catch (error) {
      console.error("Contact email draft failed:", error);
      const message = error.message || "Could not prepare the email draft.";
      setEmailNotice(message);
      setMessages((previous) => [
        ...previous,
        { role: "assistant", content: message, error: true },
      ]);
      setStatus("Could not draft email");
      say(message);
    } finally {
      setEmailBusy(false);
    }
  }

  async function confirmContactEmailSend() {
    const draft = emailDraftRef.current;
    if (!draft || emailBusy) return;

    setEmailBusy(true);
    setEmailNotice("");
    try {
      const endpoint = draft.isBulk
        ? `${API_BASE}/api/email/send-to-all-contacts`
        : `${API_BASE}/api/email/send-to-contact`;
      const payload = draft.isBulk
        ? {
            subject: draft.subject,
            body: draft.body,
            confirmed: true,
          }
        : {
            contact_name: draft.contact_name,
            subject: draft.subject,
            body: draft.body,
            confirmed: true,
          };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();
      let data = {};
      if (responseText.trim()) {
        try {
          data = JSON.parse(responseText);
        } catch {
          throw new Error(`Email send API returned invalid JSON (HTTP ${response.status}).`);
        }
      }

      if (!response.ok) {
        throw new Error(formatApiError(data, `Could not send the email (HTTP ${response.status}).`));
      }

      const reply = draft.isBulk
        ? (data.message ||
          `Bulk email complete: ${Number(data.sent_count) || 0} sent, ${Number(data.failed_count) || 0} failed.`)
        : (data.message || data.reply || `Email sent to ${draft.contact_name}.`);
      updateEmailDraft(null);
      setEmailNotice(reply);
      setMessages((previous) => [...previous, { role: "assistant", content: reply }]);
      setStatus("Email sent");
      say(reply);
    } catch (error) {
      console.error("Sending contact email failed:", error);
      const message = error.message || "Could not send the email.";
      setEmailNotice(message);
      setMessages((previous) => [
        ...previous,
        { role: "assistant", content: message, error: true },
      ]);
      setStatus("Email sending failed");
      say(message);
    } finally {
      setEmailBusy(false);
    }
  }

  function cancelContactEmailDraft() {
    updateEmailDraft(null);
    const reply = "Email draft cancelled. Nothing was sent.";
    setEmailNotice(reply);
    setStatus("Email draft cancelled");
    setMessages((previous) => [...previous, { role: "assistant", content: reply }]);
    say(reply);
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

    if (emailDraftRef.current && /^(yes|yeah|yep|confirm|send|send it|confirm email|send email)$/i.test(spoken)) {
      setInput("");
      setMessages((previous) => [...previous, { role: "user", content: message }]);
      await confirmContactEmailSend();
      return;
    }

    if (emailDraftRef.current && /^(no|nope|cancel|cancel email|don't send|do not send)$/i.test(spoken)) {
      setInput("");
      setMessages((previous) => [...previous, { role: "user", content: message }]);
      cancelContactEmailDraft();
      return;
    }

    if (reminderDraftRef.current && /^(yes|yeah|yep|confirm|confirm reminder|schedule it|yes schedule it)$/i.test(spoken)) {
      setInput("");
      setMessages((previous) => [...previous, { role: "user", content: message }]);
      await confirmVoiceReminder();
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

    // Email composition must be handled before reminder detection because an email
    // mentioning a future meeting time should not become a reminder.
    if (isEmailCompositionCommand(message) || isBulkEmailCommand(message)) {
      setInput("");
      setMessages((previous) => [...previous, { role: "user", content: message }]);

      // Bulk-email intent must be checked first so "all my contacts" is never
      // parsed as a single saved contact name.
      if (isBulkEmailCommand(message)) {
        await prepareBulkEmailDraft(message);
      } else {
        await prepareContactEmailDraft(message);
      }
      return;
    }

    // Route reminder queries and day-planning requests BEFORE reminder creation.
    // These commands read existing reminders; they must not call the preview parser.
    const normalizedActionMessage = message.toLowerCase().trim();

    const isPlanMyDayCommand =
      /\b(?:plan my day|help me plan my day|plan my schedule|organize my day|organise my day)\b/i.test(
        normalizedActionMessage
      );

    const isListRemindersCommand =
      /\b(?:show|list|get|view|check|display|what|what are|what's|whats|upcoming|do i have)\b/i.test(
        normalizedActionMessage
      ) && /\b(?:reminders?|scheduled reminders?)\b/i.test(normalizedActionMessage) &&
      !isPlanMyDayCommand;

    // Load saved reminders using the existing GET endpoint.
    async function fetchUpcomingReminders() {
      const response = await fetch(`${API_BASE}/api/reminders`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      const responseText = await response.text();
      let data = [];

      if (responseText.trim()) {
        try {
          data = JSON.parse(responseText);
        } catch {
          throw new Error("The reminders API returned invalid JSON.");
        }
      }

      if (!response.ok) {
        throw new Error(
          formatApiError(data, `Could not load reminders (HTTP ${response.status}).`)
        );
      }

      const rows = Array.isArray(data)
        ? data
        : data.reminders || data.items || data.results || data.jobs || [];

      if (!Array.isArray(rows)) {
        throw new Error("The reminders API response does not contain a reminder list.");
      }

      const now = Date.now();
      return rows
        .map((reminder) => {
          const dueAt =
            reminder.due_at ||
            reminder.scheduled_at ||
            reminder.remind_at ||
            reminder.datetime ||
            reminder.next_run_time ||
            reminder.nextRunTime;
          return { reminder, dueAt, timestamp: dueAt ? new Date(dueAt).getTime() : NaN };
        })
        .filter(({ reminder, timestamp }) => {
          if (!Number.isFinite(timestamp) || timestamp < now) return false;
          const status = String(reminder.status || "").toLowerCase();
          return !["completed", "cancelled", "canceled", "fired", "done"].includes(status);
        })
        .sort((a, b) => a.timestamp - b.timestamp);
    }

    async function handleReminderReadAction(action) {
      setInput("");
      setMessages((previous) => [...previous, { role: "user", content: message }]);
      setBusy(true);
      setStatus(action === "plan" ? "Planning your day…" : "Loading upcoming reminders…");

      try {
        const upcoming = await fetchUpcomingReminders();
        let reply;

        if (action === "plan") {
          if (upcoming.length === 0) {
            reply =
              "You don't have any upcoming reminders to plan around. Tell me your tasks and priorities, and I can help organize your day.";
          } else {
            reply =
              "Here's your day plan based on your upcoming reminders:\n\n" +
              upcoming
                .map(({ reminder, dueAt }, index) => {
                  const title = reminder.title || reminder.name || reminder.body || "Reminder";
                  const dateText = new Date(dueAt).toLocaleString("en-IN", {
                    timeZone: reminder.timezone || "Asia/Kolkata",
                    dateStyle: "medium",
                    timeStyle: "short",
                  });
                  return `${index + 1}. ${dateText} — ${title}`;
                })
                .join("\n") +
              "\n\nSuggestion: handle time-sensitive tasks first and leave buffer time between activities.";
          }
        } else if (upcoming.length === 0) {
          reply = "You don't have any upcoming reminders.";
        } else {
          reply =
            "Your upcoming reminders:\n\n" +
            upcoming
              .map(({ reminder, dueAt }, index) => {
                const title = reminder.title || reminder.name || reminder.body || "Reminder";
                const dateText = new Date(dueAt).toLocaleString("en-IN", {
                  timeZone: reminder.timezone || "Asia/Kolkata",
                  dateStyle: "medium",
                  timeStyle: "short",
                });
                return `${index + 1}. ${title} — ${dateText}`;
              })
              .join("\n");
        }

        setMessages((previous) => [...previous, { role: "assistant", content: reply }]);
        setReminderListVersion((version) => version + 1);
        setStatus(action === "plan" ? "Day plan ready" : "Reminders loaded");
        say(reply);
      } catch (error) {
        console.error(`[AURA] ${action === "plan" ? "Plan my day" : "List reminders"} failed:`, error);
        const errorMessage = error.message || "Could not load your reminders.";
        setMessages((previous) => [
          ...previous,
          { role: "assistant", content: errorMessage, error: true },
        ]);
        setStatus(action === "plan" ? "Could not plan your day" : "Could not load reminders");
      } finally {
        setBusy(false);
      }
    }

    if (isPlanMyDayCommand) {
      await handleReminderReadAction("plan");
      return;
    }

    if (isListRemindersCommand) {
      await handleReminderReadAction("list");
      return;
    }

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


      <style>{`
        /* Compact voice controls so the conversation gets the most space. */
        .aura-dashboard .aura-hero {
          gap: 14px;
          min-width: 0;
        }
        .aura-dashboard .aura-orb-zone {
          min-height: 96px;
          height: 96px;
          margin: 0 auto;
          transform: scale(0.78);
          transform-origin: center;
        }
        .aura-dashboard .aura-orb-button {
          width: 68px !important;
          height: 68px !important;
          min-width: 68px !important;
          min-height: 68px !important;
        }
        .aura-dashboard .aura-orb-button svg {
          width: 30px;
          height: 30px;
        }
        .aura-dashboard .aura-tap {
          margin-top: -10px;
          font-size: 12px;
        }
        .aura-dashboard .aura-quick-grid {
          gap: 8px;
        }
        .aura-dashboard .aura-quick {
          min-height: 66px;
          padding: 10px 12px;
          gap: 4px;
        }
        .aura-dashboard .aura-quick svg {
          width: 17px;
          height: 17px;
        }
        .aura-dashboard .aura-quick strong {
          font-size: 12px;
        }
        .aura-dashboard .aura-quick span {
          font-size: 11px;
        }
        .aura-dashboard .aura-chat-window {
          display: flex;
          flex-direction: column;
          gap: 12px;
          width: 100%;
          min-height: 260px;
          max-height: min(42vh, 440px);
          overflow-y: auto;
          padding: 18px;
          border: 1px solid rgba(148, 174, 220,  0.22);
          border-radius: 18px;
          background: rgba(7, 16, 35,  0.58);
          text-align: left;
          scroll-behavior: smooth;
          overflow-wrap: anywhere;
        }
        .aura-dashboard .aura-chat-window-heading {
          position: sticky;
          top: -18px;
          z-index: 1;
          margin: -18px -18px 2px;
          padding: 13px 18px;
          border-bottom: 1px solid rgba(148, 174, 220, 0.16);
          background: rgba(7, 16, 35, 0.96);
          color: #dce8ff;
          font-size: 14px;
          font-weight: 700;
        }
        .aura-dashboard .aura-chat-message {
          max-width: 88%;
          padding: 12px 15px;
          border-radius: 14px;
          color: #edf4ff;
          font-size: 15px;
          line-height: 1.65;
          white-space: pre-wrap;
        }
        .aura-dashboard .aura-chat-message.assistant {
          align-self: flex-start;
          background: rgba(38, 57, 91, 0.78);
          border: 1px solid rgba(148, 174, 220, 0.16);
        }
        .aura-dashboard .aura-chat-message.user {
          align-self: flex-end;
          background: linear-gradient(135deg, #2857b8, #4c70d8);
          color: #fff;
        }
        .aura-dashboard .aura-chat-message-label {
          display: block;
          margin-bottom: 5px;
          color: #a9c7f3;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .aura-dashboard .aura-chat-message.user .aura-chat-message-label {
          color: #dce7ff;
        }
        .aura-dashboard .aura-composer {
          width: 100%;
          min-height: 58px;
        }
        .aura-dashboard .aura-composer input {
          min-width: 0;
          font-size: 16px;
        }
        @media (max-width: 700px) {
          .aura-dashboard .aura-chat-window {
            min-height: 220px;
            max-height: 38vh;
            padding: 13px;
          }
          .aura-dashboard .aura-chat-window-heading {
            top: -13px;
            margin: -13px -13px 2px;
            padding: 11px 13px;
          }
          .aura-dashboard .aura-chat-message {
            max-width: 96%;
            font-size: 14px;
            padding: 10px 12px;
          }
        }
      `}</style>

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
          <button className={activeSidePanel === "contacts" ? "active" : ""} type="button" onClick={() => setActiveSidePanel("contacts")}><ContactRound size={19} /><span>Contacts</span></button>
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
            <button className={`aura-orb-button ${listening ? "listening" : ""}`} type="button" onClick={toggleMic} aria-label={voiceMode ? "Stop voice assistant" : "Start voice assistant"} aria-pressed={voiceMode}><Mic size={30} strokeWidth={1.8} /></button>
            <div className="aura-wave right" aria-hidden="true" />
          </div>
          <div className="aura-tap">{listening ? "Listening… speak now" : voiceMode ? "Voice mode active · tap to stop" : "Tap to speak"}</div>

          <div className="aura-quick-grid aura-action-prompts">
            <button className="aura-quick" type="button" onClick={() => sendMessage("Remind me to call [person] at 5 PM today")}><AlarmClock color="#ffb84e" /><strong>Set a reminder</strong><span>Choose a task and time</span></button>
            <button className="aura-quick" type="button" onClick={() => sendMessage("Draft an email to my saved recipient asking to reschedule a meeting")}><Mail color="#54c8ff" /><strong>Draft an email</strong><span>Review before scheduling</span></button>
            <button className="aura-quick" type="button" onClick={() => sendMessage("Read my latest emails and summarize the important ones")}><Inbox color="#a99bff" /><strong>Read my emails</strong><span>Summarize recent messages</span></button>
            <button className="aura-quick" type="button" onClick={() => sendMessage("Show my upcoming reminders")}><Bell color="#ff6677" /><strong>Upcoming reminders</strong><span>Check what is next</span></button>
          </div>

          <section className="aura-chat-window" aria-label="Conversation with AURA" aria-live="polite">
            <div className="aura-chat-window-heading">Conversation</div>
            {messages.map((message, index) => (
              <article
                className={`aura-chat-message ${message.role === "user" ? "user" : "assistant"}`}
                key={message.id || `${message.role}-${index}`}
              >
                <span className="aura-chat-message-label">
                  {message.role === "user" ? "You" : "AURA"}
                </span>
                <span>{message.content}</span>
              </article>
            ))}
            {busy && (
              <article className="aura-chat-message assistant">
                <span className="aura-chat-message-label">AURA</span>
                <span>Thinking…</span>
              </article>
            )}
            <div ref={bottomRef} />
          </section>

          <form className="aura-composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
            <Sparkles size={18} color="#c3d5ff" />
            <input id="aura-message-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask anything…" aria-label="Message AURA" disabled={busy} />
            <button type="submit" className="send" aria-label="Send message" disabled={busy || !input.trim()}><Send size={17} /></button>
            <button type="button" onClick={toggleMic} aria-label={voiceMode ? "Stop voice mode" : "Start voice mode"} title={voiceMode ? "Stop voice mode" : "Start voice mode"}>{voiceMode ? <MicOff size={18} /> : <Mic size={18} />}</button>
          </form>
        </section>

        {emailDraft && (
          <section className="aura-confirm" aria-live="polite">
            <h3>Review email draft</h3>
            <p><strong>To:</strong> {emailDraft.isBulk
              ? `All saved contacts (${emailDraft.recipient_count} recipients; each receives a separate email)`
              : `${emailDraft.contact_name}${emailDraft.recipient ? ` (${emailDraft.recipient})` : ""}`}</p>
            <p><strong>Subject:</strong> {emailDraft.subject}</p>
            <p><strong>Message:</strong></p>
            <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: "12px", borderRadius: "10px", background: "rgba(7,16,35,0.55)", marginBottom: "14px" }}>{emailDraft.body}</div>
            <p>{emailDraft.isBulk
              ? `Review carefully: this will send the same message to ${emailDraft.recipient_count} contacts. Each recipient receives a separate email.`
              : "Review the details before sending. The email will not be sent unless you confirm."}</p>
            <div className="aura-confirm-actions">
              <button type="button" onClick={confirmContactEmailSend} disabled={emailBusy}>
                {emailBusy ? "Sending…" : "Send email"}
              </button>
              <button type="button" onClick={cancelContactEmailDraft} disabled={emailBusy}>Cancel</button>
            </div>
          </section>
        )}
        {emailNotice && !emailDraft && !emailBusy && (
          <div className="aura-status-alert" role="status" style={{ top: "auto", bottom: 112 }}>
            {emailNotice}
          </div>
        )}
        {reminderDraft && <section className="aura-confirm" aria-live="polite"><h3>Confirm reminder</h3><p><strong>Task:</strong> {reminderDraft.title}</p><p><strong>Date and time:</strong> {new Date(reminderDraft.due_at).toLocaleString("en-IN",{timeZone:reminderDraft.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",dateStyle:"medium",timeStyle:"short"})}</p><div className="aura-confirm-actions"><button type="button" onClick={confirmVoiceReminder} disabled={reminderBusy}>{reminderBusy ? "Scheduling…" : "Confirm and schedule"}</button><button type="button" onClick={cancelVoiceReminder} disabled={reminderBusy}>Cancel</button></div></section>}
        {reminderNotice && !reminderDraft && !reminderBusy && <div className="aura-status-alert" role="status" style={{top:"auto",bottom:70}}>{reminderNotice}</div>}
      </main>

      <aside className="aura-right aura-explore-panel" aria-label={activeSidePanel === "emails" ? "Scheduled emails" : activeSidePanel === "contacts" ? "Contacts" : activeSidePanel === "reminders" ? "Reminder list" : "AURA actions"}>
        {activeSidePanel === "emails" ? (
          <EmailScheduler apiBase={API_BASE} />
        ) : activeSidePanel === "contacts" ? (
          <div
            className="contacts-panel-wrapper"
            style={{ width: "100%", minWidth: 0, minHeight: 0, height: "100%", overflowY: "auto", padding: "16px", boxSizing: "border-box" }}
          >
            <ContactsManagerErrorBoundary>
              <ContactsManager />
            </ContactsManagerErrorBoundary>
          </div>
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
