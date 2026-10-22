import React from "react";
import { Bot } from "lucide-react";

/** Renders the conversation transcript and typing indicator. */
export default function ChatMessages({ messages, busy, bottomRef }) {
  return (
    <div className="messages" aria-live="polite">
      {messages.map((msg, index) => (
        <div
          key={msg.id || `${index}-${msg.role}`}
          className={`message-row ${msg.role === "user" ? "user-row" : ""}`}
        >
          <div
            className={`message-avatar ${msg.role === "user" ? "user-avatar" : ""}`}
          >
            {msg.role === "user" ? "Y" : <Bot size={17} />}
          </div>

          <div
            className={`message-bubble ${msg.role === "user" ? "user-bubble" : ""} ${
              msg.error ? "error-bubble" : ""
            }`}
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
  );
}
