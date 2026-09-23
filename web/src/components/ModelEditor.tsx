import { useState } from "react";
import type { NormalizedProject, NormalizedRecord } from "../lib/model";

type NodeType = "ACTIVITY" | "GATE";
type Draft = { dependency_id: string; source_type: NodeType; source_id: string; target_type: NodeType; target_id: string; lag_h: string; rationale: string; enabled: boolean };
const empty: Draft = { dependency_id: "", source_type: "ACTIVITY", source_id: "", target_type: "GATE", target_id: "", lag_h: "0", rationale: "", enabled: true };

export function ModelEditor({ project, onChange, onExport, canExport, disabled = false }: {
  project: NormalizedProject; onChange: (project: NormalizedProject) => void;
  onExport: (comment: string) => Promise<string>; canExport: boolean; disabled?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [formError, setFormError] = useState("");
  const [comment, setComment] = useState("");
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState("");

  const pick = (id: string) => {
    const row = project.dependencies.find((item) => item.dependency_id === id);
    if (!row) return;
    setEditing(id);
    setDraft({ dependency_id: String(row.dependency_id), source_type: row.source_type as NodeType,
      source_id: String(row.source_id), target_type: row.target_type as NodeType,
      target_id: String(row.target_id), lag_h: String(row.lag_h ?? 0),
      rationale: String(row.rationale ?? ""), enabled: row.enabled === true });
    setFormError("");
  };
  const save = () => {
    const lag = Number(draft.lag_h);
    if (!/^[A-Za-z0-9_-]+$/.test(draft.dependency_id)) { setFormError("Enter an ID using letters, digits, _ or -."); return; }
    if (!draft.source_id || !draft.target_id) { setFormError("Select both endpoints."); return; }
    if (!draft.lag_h.trim() || !Number.isInteger(lag) || lag < 0) { setFormError("Lag must be a non-negative whole number of hours."); return; }
    if (!draft.rationale.trim()) { setFormError("Enter the technical or operational justification."); return; }
    setFormError("");
    const row: NormalizedRecord = { dependency_id: draft.dependency_id, source_type: draft.source_type,
      source_id: draft.source_id, target_type: draft.target_type, target_id: draft.target_id,
      relation: "FS", lag_h: lag, enabled: draft.enabled, rationale: draft.rationale.trim() };
    onChange({ ...project, dependencies: editing === null
      ? [...project.dependencies, row]
      : project.dependencies.map((item) => item.dependency_id === editing ? { ...item, ...row } : item) });
    setEditing(null); setDraft(empty);
  };
  const changePriority = (gateId: string, field: "enabled" | "priority" | "notes", value: unknown) => {
    const found = project.milestone_priorities.some((row) => row.gate_id === gateId);
    const update = (row: NormalizedRecord) => ({ ...row, [field]: value });
    onChange({ ...project, milestone_priorities: found
      ? project.milestone_priorities.map((row) => row.gate_id === gateId ? update(row) : row)
      : [...project.milestone_priorities, update({ gate_id: gateId, enabled: false })] });
  };
  const options = (type: NodeType) => (type === "ACTIVITY" ? project.activities : project.gates)
    .map((row) => String(row[type === "ACTIVITY" ? "activity_id" : "gate_id"]));
  const exportRevision = async () => {
    setExportError(""); setExported(""); setExporting(true);
    try { setExported(await onExport(comment)); }
    catch (error) { setExportError(error instanceof Error ? error.message : "Revision export failed."); }
    finally { setExporting(false); }
  };
  const endpoint = (side: "source" | "target") => <div className="model-endpoint">
    <label>{side === "source" ? "Predecessor type" : "Successor type"}
      <select value={draft[`${side}_type`]} onChange={(event) => setDraft({ ...draft, [`${side}_type`]: event.target.value, [`${side}_id`]: "" })} disabled={disabled}>
        <option value="ACTIVITY">Activity</option><option value="GATE">Gate</option>
      </select>
    </label>
    <label>{side === "source" ? "Predecessor ID" : "Successor ID"}
      <select value={draft[`${side}_id`]} onChange={(event) => setDraft({ ...draft, [`${side}_id`]: event.target.value })} disabled={disabled}>
        <option value="">Select…</option>{options(draft[`${side}_type`]).map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
    </label>
  </div>;

  return <div className="model-editor">
    <h3>Edit FS dependencies</h3>
    <p>Changes stay in this browser session. Invalid models block calculation and all exports.</p>
    <ul className="model-dependencies">{project.dependencies.map((row, index) => <li key={index}>
      <code>{String(row.dependency_id)}</code> · {String(row.source_id)} → {String(row.target_id)} · {String(row.lag_h)} h · {row.enabled === true ? "Active" : "Inactive"}
      <button type="button" onClick={() => pick(String(row.dependency_id))} disabled={disabled}>Edit {String(row.dependency_id)}</button>
      <button type="button" onClick={() => onChange({ ...project, dependencies: project.dependencies.map((item, i) => i === index ? { ...item, enabled: false } : item) })} disabled={disabled || row.enabled !== true}>Deactivate</button>
      <button type="button" onClick={() => onChange({ ...project, dependencies: project.dependencies.filter((_, i) => i !== index) })} disabled={disabled}>Remove</button>
    </li>)}</ul>
    <button type="button" onClick={() => { setEditing(null); setDraft(empty); setFormError(""); }} disabled={disabled}>New dependency</button>
    <div className="model-fields" aria-label="FS dependency form">
      <label>Dependency ID<input value={draft.dependency_id} onChange={(event) => setDraft({ ...draft, dependency_id: event.target.value.trim() })} disabled={disabled} /></label>
      {endpoint("source")}{endpoint("target")}
      <label>Lag (h)<input type="number" min="0" step="1" value={draft.lag_h} onChange={(event) => setDraft({ ...draft, lag_h: event.target.value })} disabled={disabled} /></label>
      <label>Justification<input value={draft.rationale} onChange={(event) => setDraft({ ...draft, rationale: event.target.value })} disabled={disabled} /></label>
      <label className="model-checkbox"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} disabled={disabled} /> Active</label>
      <button type="button" onClick={save} disabled={disabled}>{editing ? "Save dependency" : "Add dependency"}</button>
      {formError && <p role="alert">{formError}</p>}
    </div>
    <h3>Gate priorities</h3>
    <p>Lower number means higher priority. Enabled ranks must be distinct; PROJECT_COMPLETE must stay ranked.</p>
    <div className="model-priorities">{project.gates.map((gate) => {
      const id = String(gate.gate_id);
      const row = project.milestone_priorities.find((item) => item.gate_id === id);
      return <div key={id} className="model-priority"><code>{id}</code>
        <label>Enabled <input type="checkbox" checked={row?.enabled === true} onChange={(event) => changePriority(id, "enabled", event.target.checked)} disabled={disabled} /></label>
        <label>Rank <input type="number" min="1" step="1" value={row?.priority === undefined ? "" : String(row.priority)} onChange={(event) => changePriority(id, "priority", event.target.value === "" ? undefined : Number(event.target.value))} disabled={disabled} /></label>
        <label>Notes <input value={String(row?.notes ?? "")} onChange={(event) => changePriority(id, "notes", event.target.value)} disabled={disabled} /></label>
      </div>;
    })}</div>
    <label className="revision-comment">Revision comment (optional)<input value={comment} onChange={(event) => setComment(event.target.value)} disabled={disabled} /></label>
    <button type="button" onClick={exportRevision} disabled={!canExport || disabled || exporting}>Download new .xlsx revision</button>
    {exportError && <p role="alert">{exportError}</p>}
    {exported && <p role="status">Downloaded {exported}</p>}
  </div>;
}
