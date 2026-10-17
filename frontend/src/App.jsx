
import React, { useEffect, useRef, useState } from "react";
import {
  Activity,
  AudioLines,
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
  const voiceModeRef = useRef(false);

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


async function sendMessage(text = input) {
  const message = text.trim();

  if (!message || busy) {
    console.log("[AURA] Request skipped:", {
      emptyMessage: !message,
      busy,
    });
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

            <div className="messages" aria-live="polite">
              {messages.map((msg, index) => (
                <div
                  key={`${index}-${msg.role}`}
                  className={`message-row ${
                    msg.role === "user" ? "user-row" : ""
                  }`}
                >
                  <div
                    className={`message-avatar ${
                      msg.role === "user" ? "user-avatar" : ""
                    }`}
                  >
                    {msg.role === "user" ? "Y" : <Bot size={17} />}
                  </div>

                  <div
                    className={`message-bubble ${
                      msg.role === "user" ? "user-bubble" : ""
                    } ${msg.error ? "error-bubble" : ""}`}
                  >
                    <span className="message-name">
                      {msg.role === "user" ? "YOU" : "AURA"}
                    </span>
                    <p>{msg.content}</p>
                  </div>
                </div>
              ))}

              {busy && (
                <div className="message-row">
                  <div className="message-avatar">
                    <Bot size={17} />
                  </div>
                  <div className="message-bubble">
                    <span className="message-name">AURA</span>
                    <div className="typing">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>

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
    </div>
  );
}
