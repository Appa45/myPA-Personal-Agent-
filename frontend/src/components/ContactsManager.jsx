import  React,{ useCallback, useEffect, useMemo, useState } from "react";
import { Search, Plus, Pencil, Trash2, X, Mail, Phone, RefreshCw, ContactRound } from "lucide-react";
import "./ContactsManager.css";

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "http://127.0.0.1:8000" : "");
const EMPTY = { name: "", email: "", phone: "", notes: "" };

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.error || data.message || `Request failed (${response.status})`);
  return data;
}

const safeText = (value) => {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  // Prevent malformed API values (objects/arrays) from crashing React rendering.
  try { return JSON.stringify(value); } catch { return ""; }
};

const normalize = (contact) => {
  const c = contact && typeof contact === "object" ? contact : {};
  return {
    id: c.id ?? c._id ?? c.contact_id ?? c.email ?? `${safeText(c.name)}-${Math.random().toString(36).slice(2)}`,
    name: safeText(c.name),
    email: safeText(c.email),
    phone: safeText(c.phone),
    notes: safeText(c.notes),
  };
};

export default function ContactsManager({ onSelectContact, selectionMode = false }) {
  const [contacts, setContacts] = useState([]);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadContacts = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await request("/api/contacts");
      const candidate = Array.isArray(data)
        ? data
        : Array.isArray(data?.contacts)
          ? data.contacts
          : Array.isArray(data?.items)
            ? data.items
            : Array.isArray(data?.data)
              ? data.data
              : [];
      setContacts(candidate.map(normalize));
    } catch (e) {
      setError(`${e.message}. Check that GET /api/contacts exists on your backend.`);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadContacts(); }, [loadContacts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? contacts.filter((c) => [c.name, c.email, c.phone, c.notes].join(" ").toLowerCase().includes(q)) : contacts;
  }, [contacts, search]);

  const closeForm = () => { setShowForm(false); setEditingId(null); setForm(EMPTY); };
  const addContact = () => { setEditingId(null); setForm(EMPTY); setError(""); setNotice(""); setShowForm(true); };
  const editContact = (c) => { setEditingId(c.id); setForm({ name: c.name, email: c.email, phone: c.phone, notes: c.notes }); setError(""); setNotice(""); setShowForm(true); };

  async function handleSubmit(e) {
    e.preventDefault(); setError(""); setNotice("");
    const payload = { name: form.name.trim(), email: form.email.trim().toLowerCase(), phone: form.phone.trim(), notes: form.notes.trim() };
    if (!payload.name) return setError("Please enter a contact name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return setError("Please enter a valid email address.");
    setSaving(true);
    try {
      if (editingId != null) {
        await request(`/api/contacts/${encodeURIComponent(editingId)}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await request("/api/contacts", { method: "POST", body: JSON.stringify(payload) });
      }
      closeForm(); setNotice(editingId != null ? "Contact updated successfully." : "Contact saved successfully.");
      await loadContacts();
    } catch (e) {
      setError(`${e.message}. Check that your backend supports ${editingId != null ? "PATCH /api/contacts/:id" : "POST /api/contacts"}.`);
    } finally { setSaving(false); }
  }

  async function deleteContact(c) {
    if (!window.confirm(`Delete ${c.name} from your contacts?`)) return;
    setError(""); setNotice("");
    try {
      await request(`/api/contacts/${encodeURIComponent(c.id)}`, { method: "DELETE" });
      setContacts((current) => current.filter((item) => String(item.id) !== String(c.id)));
      setNotice(`${c.name} was deleted.`);
    } catch (e) { setError(`${e.message}. Check that DELETE /api/contacts/:id exists.`); }
  }

  return <section className="contacts-manager">
    <header className="cm-header">
      <div className="cm-heading"><span className="cm-main-icon"><ContactRound size={21} /></span><div><h2>Contacts</h2><p>Save people and reuse their details with AURA.</p></div></div>
      <button className="cm-btn cm-primary" onClick={addContact} type="button"><Plus size={16} /> Add contact</button>
    </header>

    <div className="cm-toolbar">
      <label className="cm-search"><Search size={17} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email or phone..." aria-label="Search contacts" />{search && <button type="button" className="cm-icon-btn" onClick={() => setSearch("")} aria-label="Clear search"><X size={15} /></button>}</label>
      <button type="button" className="cm-btn cm-secondary" onClick={loadContacts} disabled={loading}><RefreshCw size={15} /> Refresh</button>
    </div>

    {error && <div className="cm-message cm-error">{error}</div>}
    {notice && <div className="cm-message cm-success">{notice}</div>}

    {showForm && <form className="cm-form" onSubmit={handleSubmit}>
      <div className="cm-form-top"><h3>{editingId != null ? "Edit contact" : "New contact"}</h3><button type="button" className="cm-icon-btn" onClick={closeForm} aria-label="Close form"><X size={18} /></button></div>
      <div className="cm-form-grid">
        <label className="cm-field"><span>Full name *</span><input name="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Priya Sharma" maxLength={100} required /></label>
        <label className="cm-field"><span>Email address *</span><input name="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" maxLength={254} required /></label>
        <label className="cm-field"><span>Phone number</span><input name="phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+91 98765 43210" maxLength={30} /></label>
        <label className="cm-field cm-full"><span>Notes</span><textarea name="notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional details or reminders..." rows={3} maxLength={1000} /></label>
      </div>
      <div className="cm-form-actions"><button type="button" className="cm-btn cm-secondary" onClick={closeForm} disabled={saving}>Cancel</button><button type="submit" className="cm-btn cm-primary" disabled={saving}>{saving ? "Saving..." : editingId != null ? "Save changes" : "Save contact"}</button></div>
    </form>}

    <div className="cm-list-heading"><span>Your contacts</span><span>{filtered.length} {filtered.length === 1 ? "contact" : "contacts"}</span></div>
    {loading ? <div className="cm-empty"><RefreshCw className="cm-spin" size={22} /><p>Loading contacts...</p></div> : filtered.length === 0 ? <div className="cm-empty"><h3>{search ? "No matching contacts" : "No contacts saved yet"}</h3><p>{search ? "Try another search." : "Add a contact to reuse their email in AURA actions."}</p>{!search && <button type="button" className="cm-btn cm-primary" onClick={addContact}><Plus size={16} /> Add your first contact</button>}</div> : <div className="cm-list">
      {filtered.map((c) => <article className="cm-contact" key={c.id ?? c.email}>
        <div className="cm-avatar">{(c.name || c.email || "?").trim().charAt(0).toUpperCase()}</div>
        <div className="cm-contact-info"><h3>{c.name}</h3><p className="cm-contact-line"><Mail size={14} /><a href={`mailto:${c.email}`}>{c.email}</a></p>{c.phone && <p className="cm-contact-line"><Phone size={14} /><a href={`tel:${c.phone}`}>{c.phone}</a></p>}{c.notes && <p className="cm-notes">{c.notes}</p>}</div>
        <div className="cm-contact-actions">{selectionMode && onSelectContact && <button type="button" className="cm-btn cm-secondary" onClick={() => onSelectContact(c)}>Use contact</button>}<button type="button" className="cm-icon-btn" onClick={() => editContact(c)} title="Edit contact" aria-label={`Edit ${c.name}`}><Pencil size={16} /></button><button type="button" className="cm-icon-btn cm-danger" onClick={() => deleteContact(c)} title="Delete contact" aria-label={`Delete ${c.name}`}><Trash2 size={16} /></button></div>
      </article>)}
    </div>}
  </section>;
}
