import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlarmClock, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";

import { enableNotifications } from "../firebase";

// FastAPI returns `detail` as a string for HTTP errors, or a list for 422 errors.
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
  return fallback;
}

const pad = (n) => String(n).padStart(2, "0");

// Date -> value for <input type="datetime-local"> in the browser's local time.
function toInputValue(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function formatDue(iso) {
  if (!iso) return "No time set";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function formatRelative(iso) {
  if (!iso) return "";
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (minutes < 1) return "due now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

const styles = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    zIndex: 100,
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    padding: "6vh 16px",
    overflowY: "auto",
  },
  panel: {
    width: "100%",
    maxWidth: 560,
    background: "#1f2937",
    color: "#f9fafb",
    border: "1px solid #374151",
    borderRadius: 16,
    padding: 20,
    boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
  },
  row: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  input: {
    flex: "1 1 160px",
    minWidth: 0,
    padding: "9px 10px",
    borderRadius: 8,
    border: "1px solid #4b5563",
    background: "#111827",
    color: "#f9fafb",
    colorScheme: "dark",
  },
  button: {
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid #4b5563",
    background: "#374151",
    color: "#f9fafb",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  },
  primary: { background: "#2563eb", borderColor: "#2563eb" },
  danger: { background: "#7f1d1d", borderColor: "#991b1b" },
  card: {
    padding: "12px 0",
    borderTop: "1px solid #374151",
  },
  error: {
    margin: "10px 0",
    padding: "8px 10px",
    borderRadius: 8,
    background: "rgba(239,68,68,0.15)",
    border: "1px solid #ef4444",
  },
};

export default function RemindersManager({ open, onClose, apiBase, refreshKey = 0, onChanged, inline = false }) {
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Create form
  const [newTitle, setNewTitle] = useState("");
  const [newWhen, setNewWhen] = useState("");
  const [creating, setCreating] = useState(false);

  // Inline edit
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [editWhen, setEditWhen] = useState("");
  const [savingId, setSavingId] = useState(null);

  const minWhen = useMemo(() => toInputValue(new Date(Date.now() + 60000)), [open]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${apiBase}/api/reminders`);
      const data = await response.json();
      if (!response.ok) throw new Error(formatApiError(data, "Could not load reminders."));
      const list = (data.reminders || []).slice().sort((a, b) => {
        if (!a.due_at) return 1;
        if (!b.due_at) return -1;
        return new Date(a.due_at) - new Date(b.due_at);
      });
      setReminders(list);
      setError("");
    } catch (err) {
      setError(err.message || "Could not load reminders.");
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  // Load when opened, whenever the app says something changed, and keep fresh while open.
  useEffect(() => {
    if (!open) return undefined;
    load();
    const timer = window.setInterval(load, 15000);
    return () => window.clearInterval(timer);
  }, [open, refreshKey, load]);

  // Close on Escape.
  useEffect(() => {
    if (!open || inline) return undefined;
    const onKey = (event) => event.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, inline]);

  if (!open) return null;

  async function createReminder(event) {
    event.preventDefault();
    setError("");
    setNotice("");

    const title = newTitle.trim();
    if (!title || !newWhen) {
      setError("Enter what to be reminded about and when.");
      return;
    }
    const due = new Date(newWhen);
    if (Number.isNaN(due.getTime()) || due.getTime() <= Date.now()) {
      setError("Pick a time in the future.");
      return;
    }

    setCreating(true);
    try {
      const token = await enableNotifications();
      const response = await fetch(`${apiBase}/api/reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, due_at: due.toISOString(), token, url: "/" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(formatApiError(data, "Could not schedule reminder."));

      setNewTitle("");
      setNewWhen("");
      setNotice(`Scheduled: ${title}`);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message || "Could not schedule reminder.");
    } finally {
      setCreating(false);
    }
  }

  function startEdit(reminder) {
    setEditingId(reminder.id);
    setEditTitle(reminder.title || "");
    setEditWhen(reminder.due_at ? toInputValue(new Date(reminder.due_at)) : "");
    setError("");
    setNotice("");
  }

  async function saveEdit(reminder) {
    const title = editTitle.trim();
    if (!title) {
      setError("The title can't be empty.");
      return;
    }

    // Send only what changed.
    const changes = {};
    if (title !== reminder.title) changes.title = title;

    const originalWhen = reminder.due_at ? toInputValue(new Date(reminder.due_at)) : "";
    if (editWhen && editWhen !== originalWhen) {
      const due = new Date(editWhen);
      if (Number.isNaN(due.getTime()) || due.getTime() <= Date.now()) {
        setError("Pick a time in the future.");
        return;
      }
      changes.due_at = due.toISOString();
    }

    if (Object.keys(changes).length === 0) {
      setEditingId(null);
      return;
    }

    setSavingId(reminder.id);
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/reminders/${encodeURIComponent(reminder.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(formatApiError(data, "Could not update reminder."));

      setEditingId(null);
      setNotice("Reminder updated.");
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message || "Could not update reminder.");
    } finally {
      setSavingId(null);
    }
  }

  async function cancelReminder(reminder) {
    if (!window.confirm(`Cancel reminder "${reminder.title}"?`)) return;

    setSavingId(reminder.id);
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/reminders/${encodeURIComponent(reminder.id)}`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(formatApiError(data, "Could not cancel reminder."));

      setNotice("Reminder cancelled.");
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message || "Could not cancel reminder.");
    } finally {
      setSavingId(null);
    }
  }

  const managerPanel = (
      <section
        style={inline ? {
          width: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          background: "#ffffff",
          color: "#111827",
          border: "1px solid #e5e7eb",
          borderRadius: 16,
          padding: 20,
          boxShadow: "0 8px 24px rgba(15, 23, 42, 0.10)",
        } : styles.panel}
        role="region"
        aria-label="Manage reminders"
      >
        <div style={{ ...styles.row, justifyContent: "space-between", marginBottom: 14 }}>
          <h2 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, fontSize: 20 }}>
            <AlarmClock size={20} /> Reminders
          </h2>
          <div style={styles.row}>
            <button type="button" style={styles.button} onClick={load} disabled={loading} title="Refresh">
              <RefreshCw size={15} />
            </button>
            {!inline && (
              <button type="button" style={styles.button} onClick={onClose} aria-label="Close">
                <X size={15} />
              </button>
            )}
          </div>
        </div>

        <form onSubmit={createReminder} style={{ marginBottom: 16 }}>
          <strong style={{ display: "block", marginBottom: 8 }}>Set a new reminder</strong>
          <div style={styles.row}>
            <input
              style={{ ...styles.input, flex: "2 1 200px" }}
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="What should I remind you about?"
              aria-label="Reminder title"
              maxLength={200}
            />
            <input
              style={styles.input}
              type="datetime-local"
              value={newWhen}
              min={minWhen}
              onChange={(event) => setNewWhen(event.target.value)}
              aria-label="Reminder date and time"
            />
            <button type="submit" style={{ ...styles.button, ...styles.primary }} disabled={creating}>
              <Plus size={15} />
              {creating ? "Scheduling…" : "Add"}
            </button>
          </div>
          <small style={{ opacity: 0.65, display: "block", marginTop: 6 }}>
            Tip: you can also just say or type “Remind me tomorrow at 9 AM to …”.
          </small>
        </form>

        {error && (
          <div role="alert" style={styles.error}>
            {error}
          </div>
        )}
        {notice && !error && (
          <div role="status" style={{ margin: "10px 0", color: inline ? "#166534" : "#86efac" }}>
            {notice}
          </div>
        )}

        <strong style={{ display: "block", marginBottom: 4 }}>
          Upcoming ({reminders.length})
        </strong>

        {loading && reminders.length === 0 && <p style={{ opacity: 0.7 }}>Loading…</p>}
        {!loading && reminders.length === 0 && !error && (
          <p style={{ opacity: 0.7 }}>No upcoming reminders. Add one above.</p>
        )}

        {reminders.map((reminder) => {
          const isEditing = editingId === reminder.id;
          const isBusy = savingId === reminder.id;

          return (
            <div key={reminder.id} style={styles.card}>
              {isEditing ? (
                <div style={styles.row}>
                  <input
                    style={{ ...styles.input, flex: "2 1 180px" }}
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                    aria-label="Edit title"
                    maxLength={200}
                  />
                  <input
                    style={styles.input}
                    type="datetime-local"
                    value={editWhen}
                    min={minWhen}
                    onChange={(event) => setEditWhen(event.target.value)}
                    aria-label="Edit date and time"
                  />
                  <button
                    type="button"
                    style={{ ...styles.button, ...styles.primary }}
                    onClick={() => saveEdit(reminder)}
                    disabled={isBusy}
                  >
                    {isBusy ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    style={styles.button}
                    onClick={() => setEditingId(null)}
                    disabled={isBusy}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={{ ...styles.row, justifyContent: "space-between" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>⏰ {reminder.title}</div>
                    <small style={{ opacity: 0.75 }}>
                      {formatDue(reminder.due_at)} · {formatRelative(reminder.due_at)}
                    </small>
                  </div>
                  <div style={styles.row}>
                    <button
                      type="button"
                      style={styles.button}
                      onClick={() => startEdit(reminder)}
                      disabled={isBusy}
                      aria-label={`Edit ${reminder.title}`}
                    >
                      <Pencil size={14} /> Edit
                    </button>
                    <button
                      type="button"
                      style={{ ...styles.button, ...styles.danger }}
                      onClick={() => cancelReminder(reminder)}
                      disabled={isBusy}
                      aria-label={`Cancel ${reminder.title}`}
                    >
                      <Trash2 size={14} /> {isBusy ? "…" : "Cancel"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </section>
  );

  if (inline) return managerPanel;

  return (
    <div
      style={styles.backdrop}
      onClick={(event) => event.target === event.currentTarget && onClose?.()}
    >
      {managerPanel}
    </div>
  );
}