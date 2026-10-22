import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Mail, Pencil, Plus, RefreshCw, Send, Trash2, X } from "lucide-react";

const inputStyle = {
  width: "100%", boxSizing: "border-box", padding: "10px 12px",
  border: "1px solid #d1d5db", borderRadius: 9, background: "#fff",
  color: "#111827", font: "inherit",
};
const buttonStyle = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7,
  border: "1px solid #d1d5db", borderRadius: 9, padding: "9px 12px",
  background: "#fff", color: "#111827", cursor: "pointer", fontWeight: 600,
};
const primaryStyle = { ...buttonStyle, color: "#fff", background: "#2563eb", borderColor: "#2563eb" };
const dangerStyle = { ...buttonStyle, color: "#b91c1c", borderColor: "#fecaca" };

function localDateTimeValue(value) {
  const date = value ? new Date(value) : new Date(Date.now() + 30 * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function showDate(value) {
  return value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Not set";
}
function getError(data, fallback) {
  const detail = data?.detail ?? data?.error;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((item) => item?.msg || "Invalid value").join("; ");
  return fallback;
}

export default function EmailScheduler({ apiBase }) {
  const [recipient, setRecipient] = useState("");
  const [configured, setConfigured] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sendAt, setSendAt] = useState(localDateTimeValue());
  const [emails, setEmails] = useState([]);
  const [loading, setLoading] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const minSendAt = useMemo(() => localDateTimeValue(new Date(Date.now() + 60000)), []);

  const request = useCallback(async (url, options = {}) => {
    const response = await fetch(`${apiBase}${url}`, {
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(getError(data, "The request failed."));
    return data;
  }, [apiBase]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settings, scheduled] = await Promise.all([
        request("/api/email/settings"),
        request("/api/email/scheduled"),
      ]);
      setRecipient(settings.recipient || "");
      setConfigured(Boolean(settings.configured));
      setEmails(scheduled.emails || []);
      setError("");
    } catch (err) {
      setError(err.message || "Could not load scheduled emails.");
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => { load(); }, [load]);

  async function generateDraft(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!instruction.trim()) {
      setError("Describe what the email should say first.");
      return;
    }
    setDrafting(true);
    try {
      const data = await request("/api/email/draft", {
        method: "POST",
        body: JSON.stringify({ instruction: instruction.trim() }),
      });
      setRecipient(data.recipient || recipient);
      setSubject(data.subject || "");
      setBody(data.body || "");
      setEditingId(null);
      setNotice("Draft generated. Review and edit it before scheduling.");
    } catch (err) {
      setError(err.message || "Could not generate a draft.");
    } finally {
      setDrafting(false);
    }
  }

  function editScheduledEmail(item) {
    setEditingId(item.id);
    setSubject(item.subject || "");
    setBody(item.body || "");
    setSendAt(localDateTimeValue(item.send_at));
    setInstruction("Editing scheduled email");
    setNotice("Edit the draft below and save the updated schedule.");
    setError("");
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  }

  async function schedule(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!configured || !recipient) {
      setError("Configure AURA_SAVED_EMAIL in backend/.env first.");
      return;
    }
    if (!subject.trim() || !body.trim() || !sendAt) {
      setError("Add an email subject, body, and send time.");
      return;
    }
    const due = new Date(sendAt);
    if (Number.isNaN(due.getTime()) || due.getTime() <= Date.now()) {
      setError("Choose a future send time.");
      return;
    }

    setSaving(true);
    try {
      const payload = { subject: subject.trim(), body: body.trim(), send_at: due.toISOString() };
      if (editingId) {
        await request(`/api/email/scheduled/${encodeURIComponent(editingId)}`, {
          method: "PATCH", body: JSON.stringify(payload),
        });
        setNotice("Scheduled email updated.");
      } else {
        await request("/api/email/scheduled", { method: "POST", body: JSON.stringify(payload) });
        setNotice("Email scheduled. AURA will send it at the selected time.");
      }
      setEditingId(null);
      setInstruction("");
      setSubject("");
      setBody("");
      setSendAt(localDateTimeValue());
      await load();
    } catch (err) {
      setError(err.message || "Could not schedule email.");
    } finally {
      setSaving(false);
    }
  }

  async function cancel(item) {
    if (!window.confirm(`Cancel scheduled email "${item.subject}"?`)) return;
    setError("");
    setNotice("");
    try {
      await request(`/api/email/scheduled/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      setNotice("Scheduled email cancelled.");
      await load();
    } catch (err) {
      setError(err.message || "Could not cancel scheduled email.");
    }
  }

  function clearDraft() {
    setEditingId(null);
    setInstruction("");
    setSubject("");
    setBody("");
    setSendAt(localDateTimeValue());
    setError("");
    setNotice("");
  }

  return (
    <section style={{ width: "100%", minWidth: 0, boxSizing: "border-box", background: "#fff", color: "#111827", border: "1px solid #e5e7eb", borderRadius: 16, padding: 18, boxShadow: "0 8px 24px rgba(15,23,42,.08)" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 38, height: 38, display: "grid", placeItems: "center", borderRadius: 11, background: "#dbeafe", color: "#1d4ed8" }}><Mail size={20} /></div>
          <div><h2 style={{ margin: 0, fontSize: 19 }}>Scheduled emails</h2><small style={{ color: "#6b7280" }}>Draft, review, then send later</small></div>
        </div>
        <button type="button" style={buttonStyle} onClick={load} disabled={loading} title="Refresh"><RefreshCw size={15} /></button>
      </header>

      <div style={{ border: `1px solid ${configured ? "#bbf7d0" : "#fecaca"}`, background: configured ? "#f0fdf4" : "#fef2f2", borderRadius: 10, padding: 11, marginBottom: 14, overflowWrap: "anywhere" }}>
        <strong style={{ display: "block", fontSize: 12, marginBottom: 3 }}>{configured ? "Saved recipient" : "Saved recipient not configured"}</strong>
        <span style={{ fontSize: 13 }}>{recipient || "Set AURA_SAVED_EMAIL in backend/.env and restart the backend."}</span>
      </div>

      <form onSubmit={generateDraft} style={{ display: "grid", gap: 8, marginBottom: 16 }}>
        <label htmlFor="aura-email-instruction" style={{ fontSize: 13, fontWeight: 700 }}>What should the email say?</label>
        <textarea id="aura-email-instruction" style={{ ...inputStyle, minHeight: 76, resize: "vertical" }} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Example: Write a polite email asking my manager to reschedule tomorrow's meeting." maxLength={2000} />
        <button type="submit" style={primaryStyle} disabled={drafting || !configured}><Mail size={15} />{drafting ? "Drafting…" : "Generate email draft"}</button>
      </form>

      {(subject || body || editingId) && (
        <form onSubmit={schedule} style={{ display: "grid", gap: 9, borderTop: "1px solid #e5e7eb", paddingTop: 14, marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <strong>{editingId ? "Edit scheduled email" : "Review your draft"}</strong>
            <button type="button" style={buttonStyle} onClick={clearDraft} title="Clear draft"><X size={14} /> Clear</button>
          </div>
          <label style={{ fontSize: 13, fontWeight: 700 }} htmlFor="aura-email-subject">Subject</label>
          <input id="aura-email-subject" style={inputStyle} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} required />
          <label style={{ fontSize: 13, fontWeight: 700 }} htmlFor="aura-email-body">Email body</label>
          <textarea id="aura-email-body" style={{ ...inputStyle, minHeight: 150, resize: "vertical", lineHeight: 1.5 }} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} required />
          <label style={{ fontSize: 13, fontWeight: 700 }} htmlFor="aura-email-send-at">Send date and time</label>
          <input id="aura-email-send-at" style={inputStyle} type="datetime-local" value={sendAt} min={minSendAt} onChange={(e) => setSendAt(e.target.value)} required />
          <small style={{ color: "#6b7280" }}>Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"}. The email will be sent to the saved recipient above.</small>
          <button type="submit" style={primaryStyle} disabled={saving || !configured}><CalendarClock size={16} />{saving ? "Saving…" : editingId ? "Save changes" : "Approve and schedule email"}</button>
        </form>
      )}

      {error && <div role="alert" style={{ padding: 10, margin: "10px 0", background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 9, fontSize: 13 }}>{error}</div>}
      {notice && !error && <div role="status" style={{ padding: 10, margin: "10px 0", background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1d4ed8", borderRadius: 9, fontSize: 13 }}>{notice}</div>}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 6px" }}>
        <strong>Upcoming emails ({emails.length})</strong>
      </div>
      {loading && emails.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>Loading scheduled emails…</p>}
      {!loading && emails.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>No scheduled emails yet.</p>}
      <div style={{ display: "grid", gap: 8 }}>
        {emails.map((item) => (
          <article key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 11, padding: 11, background: "#f9fafb" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
              <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                <strong style={{ fontSize: 13 }}>{item.subject}</strong>
                <div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>{showDate(item.send_at)}</div>
                <div style={{ color: "#6b7280", fontSize: 12, marginTop: 3 }}>To: {item.recipient}</div>
                <p style={{ color: "#374151", fontSize: 12, whiteSpace: "pre-wrap", margin: "8px 0 0" }}>{item.body}</p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <button type="button" style={buttonStyle} onClick={() => editScheduledEmail(item)} title="Edit scheduled email"><Pencil size={14} /></button>
                <button type="button" style={dangerStyle} onClick={() => cancel(item)} title="Cancel scheduled email"><Trash2 size={14} /></button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
