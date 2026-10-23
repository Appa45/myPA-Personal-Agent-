import { useState } from "react";
import { Plus, X, Sparkles, Trash2 } from "lucide-react";

/**
 * AddAuraAction
 * Props:
 *  - onAdd(action): called with { id, title, description, prompt }
 *  - onClose(): optional callback to close/hide the form
 *  - actions: optional array of saved actions, displayed beneath the form
 *  - onRun(action): optional callback when a saved action is clicked
 *  - onDelete(id): optional callback to remove a saved action
 */
export default function AddAuraAction({
  onAdd,
  onClose,
  actions = [],
  onRun,
  onDelete,
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(event) {
    event.preventDefault();
    const cleanTitle = title.trim();
    const cleanPrompt = prompt.trim();

    if (!cleanTitle || !cleanPrompt) {
      setError("Enter an action name and the prompt AURA should run.");
      return;
    }

    const action = {
      id: typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `aura-${Date.now()}`,
      title: cleanTitle,
      description: description.trim() || "Custom AURA action",
      prompt: cleanPrompt,
    };

    onAdd?.(action);
    setTitle("");
    setDescription("");
    setPrompt("");
    setError("");
  }

  return (
    <section className="add-aura-action">
      <style>{`
        .add-aura-action{color:#edf3ff;background:rgba(13,24,47,.88);border:1px solid rgba(151,180,235,.2);border-radius:20px;padding:20px;width:100%;box-sizing:border-box}
        .add-aura-action *{box-sizing:border-box}
        .add-aura-action__heading{display:flex;align-items:center;gap:12px;margin-bottom:18px}
        .add-aura-action__icon{width:42px;height:42px;display:grid;place-items:center;border-radius:14px;color:#a9c6ff;background:rgba(93,135,255,.16)}
        .add-aura-action__heading h2{font-size:17px;margin:0 0 4px;font-weight:700}
        .add-aura-action__heading p{font-size:12px;color:#9eacc7;margin:0;line-height:1.5}
        .add-aura-action__close{margin-left:auto;border:0;background:transparent;color:#9eacc7;cursor:pointer;padding:6px;border-radius:8px}
        .add-aura-action__form{display:grid;gap:13px}
        .add-aura-action__field{display:grid;gap:6px}
        .add-aura-action__field label{font-size:12px;font-weight:600;color:#d6e0f5}
        .add-aura-action__field input,.add-aura-action__field textarea{width:100%;font:inherit;font-size:13px;color:#f3f6ff;background:rgba(4,12,28,.65);border:1px solid rgba(151,180,235,.22);border-radius:11px;padding:11px 12px;outline:none}
        .add-aura-action__field textarea{min-height:88px;resize:vertical;line-height:1.5}
        .add-aura-action__field input:focus,.add-aura-action__field textarea:focus{border-color:#86aaff;box-shadow:0 0 0 3px rgba(111,151,255,.12)}
        .add-aura-action__hint{font-size:11px;color:#8392b0;line-height:1.5}
        .add-aura-action__error{font-size:12px;color:#ff9da8}
        .add-aura-action__submit{display:flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:11px;padding:12px 14px;color:#09142a;background:linear-gradient(110deg,#b7d4ff,#8aafff);font-size:13px;font-weight:750;cursor:pointer}
        .add-aura-action__submit:hover{filter:brightness(1.06)}
        .add-aura-action__saved{display:grid;gap:8px;margin-top:20px}
        .add-aura-action__saved-title{font-size:12px;color:#aebbd4;font-weight:700;margin-bottom:2px}
        .add-aura-action__item{display:flex;align-items:center;gap:10px;text-align:left;padding:11px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid rgba(151,180,235,.12);color:inherit;min-width:0}
        .add-aura-action__run{display:flex;flex:1;flex-direction:column;gap:4px;text-align:left;min-width:0;background:transparent;border:0;color:inherit;cursor:pointer}
        .add-aura-action__run strong{font-size:12px;overflow-wrap:anywhere}
        .add-aura-action__run span{font-size:11px;color:#94a4c1;line-height:1.4;overflow-wrap:anywhere}
        .add-aura-action__delete{border:0;background:transparent;color:#94a4c1;cursor:pointer;padding:6px;border-radius:8px}
        .add-aura-action__delete:hover,.add-aura-action__close:hover{background:rgba(255,255,255,.08);color:white}
        @media(max-width:480px){.add-aura-action{padding:15px;border-radius:16px}.add-aura-action__heading h2{font-size:16px}}
      `}</style>

      <div className="add-aura-action__heading">
        <div className="add-aura-action__icon"><Sparkles size={21} /></div>
        <div>
          <h2>Create an AURA action</h2>
          <p>Save a reusable prompt you can run anytime.</p>
        </div>
        {onClose && (
          <button className="add-aura-action__close" type="button" onClick={onClose} aria-label="Close form">
            <X size={18} />
          </button>
        )}
      </div>

      <form className="add-aura-action__form" onSubmit={handleSubmit}>
        <div className="add-aura-action__field">
          <label htmlFor="aura-action-title">Action name *</label>
          <input id="aura-action-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Daily stand-up summary" maxLength={60} required />
        </div>
        <div className="add-aura-action__field">
          <label htmlFor="aura-action-description">Short description</label>
          <input id="aura-action-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this action do?" maxLength={120} />
        </div>
        <div className="add-aura-action__field">
          <label htmlFor="aura-action-prompt">Prompt for AURA *</label>
          <textarea id="aura-action-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Help me prepare a concise daily stand-up update with completed work, blockers, and next steps." maxLength={1000} required />
          <span className="add-aura-action__hint">When you select this action, its prompt is sent to AURA as a normal chat request.</span>
        </div>
        {error && <div className="add-aura-action__error" role="alert">{error}</div>}
        <button className="add-aura-action__submit" type="submit"><Plus size={17} /> Save action</button>
      </form>

      {actions.length > 0 && (
        <div className="add-aura-action__saved">
          <div className="add-aura-action__saved-title">Your custom actions ({actions.length})</div>
          {actions.map((action) => (
            <div className="add-aura-action__item" key={action.id}>
              <button className="add-aura-action__run" type="button" onClick={() => onRun?.(action)}>
                <strong>{action.title}</strong>
                <span>{action.description || action.prompt}</span>
              </button>
              {onDelete && <button className="add-aura-action__delete" type="button" onClick={() => onDelete(action.id)} aria-label={`Delete ${action.title}`}><Trash2 size={16} /></button>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
