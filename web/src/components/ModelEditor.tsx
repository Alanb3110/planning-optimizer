import { useState } from "react";
import type { NormalizedProject, NormalizedRecord } from "../lib/model";

type NodeType = "ACTIVITY" | "GATE";
type Draft = { dependency_id: string; source_type: NodeType; source_id: string; target_type: NodeType; target_id: string; lag_h: string; rationale: string; enabled: boolean };
const empty: Draft = { dependency_id: "", source_type: "ACTIVITY", source_id: "", target_type: "GATE", target_id: "", lag_h: "0", rationale: "", enabled: true };

export function ModelEditor({ project, focus, onChange, onExport, canExport, disabled = false }: {
  project: NormalizedProject; onChange: (project: NormalizedProject) => void;
  focus: { kind: "SYSTEM" | "PACKAGE" | "ACTIVITY" | "GATE"; id: string } | null;
  onExport: (comment: string) => Promise<string>; canExport: boolean; disabled?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
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
    setFormOpen(true);
  };
  const begin = (side: "source" | "target") => {
    if (!focus || (focus.kind !== "ACTIVITY" && focus.kind !== "GATE")) return;
    setEditing(null);
    setDraft({ ...empty, [`${side}_type`]: focus.kind, [`${side}_id`]: focus.id });
    setFormError("");
    setFormOpen(true);
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
    setEditing(null); setDraft(empty); setFormOpen(false);
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
  const linked = project.dependencies.map((row, index) => ({ row, index })).filter(({ row }) =>
    focus !== null && ((row.source_type === focus.kind && row.source_id === focus.id) ||
    (row.target_type === focus.kind && row.target_id === focus.id)));
  const selectedGate = focus?.kind === "GATE" ? project.gates.find((row) => row.gate_id === focus.id) : undefined;
  const priorityRow = (gate: NormalizedRecord) => {
    const id = String(gate.gate_id);
    const row = project.milestone_priorities.find((item) => item.gate_id === id);
    return <div key={id} className="model-priority"><code>{id}</code>
      <label>Enabled <input type="checkbox" checked={row?.enabled === true} onChange={(event) => changePriority(id, "enabled", event.target.checked)} disabled={disabled} /></label>
      <label>Rank <input type="number" min="1" step="1" value={row?.priority === undefined ? "" : String(row.priority)} onChange={(event) => changePriority(id, "priority", event.target.value === "" ? undefined : Number(event.target.value))} disabled={disabled} /></label>
      <label>Notes <input value={String(row?.notes ?? "")} onChange={(event) => changePriority(id, "notes", event.target.value)} disabled={disabled} /></label>
    </div>;
  };
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

  return <div className="model-editor" aria-label="Model editing">
    {(focus?.kind === "ACTIVITY" || focus?.kind === "GATE") && <>
    <h4>Dependencies for {focus.id}</h4>
    {linked.length ? <ul className="model-dependencies">{linked.map(({ row, index }) => <li key={index}>
      <div><code>{String(row.dependency_id)}</code> · {String(row.source_id)} → {String(row.target_id)} · {String(row.lag_h)} h · {row.enabled === true ? "Active" : "Inactive"}</div>
      <div className="model-row-actions"><button type="button" onClick={() => pick(String(row.dependency_id))} disabled={disabled}>Edit {String(row.dependency_id)}</button>
      <button type="button" onClick={() => onChange({ ...project, dependencies: project.dependencies.map((item, i) => i === index ? { ...item, enabled: false } : item) })} disabled={disabled || row.enabled !== true}>Deactivate</button>
      <button type="button" onClick={() => onChange({ ...project, dependencies: project.dependencies.filter((_, i) => i !== index) })} disabled={disabled}>Remove</button></div>
    </li>)}</ul> : <p>No direct dependencies.</p>}
    <div className="model-row-actions"><button type="button" onClick={() => begin("target")} disabled={disabled}>Add predecessor</button>
    <button type="button" onClick={() => begin("source")} disabled={disabled}>Add successor</button></div>
    {formOpen && <div className="model-fields" aria-label="FS dependency form">
      <h4>{editing ? `Edit ${editing}` : "New FS dependency"}</h4>
      <label>Dependency ID<input value={draft.dependency_id} onChange={(event) => setDraft({ ...draft, dependency_id: event.target.value.trim() })} disabled={disabled} /></label>
      {endpoint("source")}{endpoint("target")}
      <label>Lag (h)<input type="number" min="0" step="1" value={draft.lag_h} onChange={(event) => setDraft({ ...draft, lag_h: event.target.value })} disabled={disabled} /></label>
      <label>Justification<input value={draft.rationale} onChange={(event) => setDraft({ ...draft, rationale: event.target.value })} disabled={disabled} /></label>
      <label className="model-checkbox"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} disabled={disabled} /> Active</label>
      <button type="button" onClick={save} disabled={disabled}>{editing ? "Save dependency" : "Add dependency"}</button>
      <button type="button" onClick={() => { setFormOpen(false); setFormError(""); }} disabled={disabled}>Cancel edit</button>
      {formError && <p role="alert">{formError}</p>}
    </div>}
    </>}
    {selectedGate && <><h4>Priority for this gate</h4>{priorityRow(selectedGate)}</>}
    <details className="model-all-priorities"><summary>Manage all gate priorities</summary>
      <p>Lower number means higher priority. Enabled ranks must be distinct; PROJECT_COMPLETE must stay ranked.</p>
      <div className="model-priorities">{project.gates
        .filter((gate) => gate.gate_id !== selectedGate?.gate_id)
        .sort((a, b) => {
          const rank = (gate: NormalizedRecord) => Number(project.milestone_priorities.find((row) => row.gate_id === gate.gate_id && row.enabled === true)?.priority ?? Number.MAX_SAFE_INTEGER);
          return rank(a) - rank(b) || String(a.gate_id).localeCompare(String(b.gate_id));
        }).map(priorityRow)}</div>
    </details>
    <div className="model-export">
    <p>Changes stay in this browser session. Invalid models block calculation and exports.</p>
    <label className="revision-comment">Revision comment (optional)<input value={comment} onChange={(event) => setComment(event.target.value)} disabled={disabled} /></label>
    <button type="button" onClick={exportRevision} disabled={!canExport || disabled || exporting}>Download new .xlsx revision</button>
    {exportError && <p role="alert">{exportError}</p>}
    {exported && <p role="status">Downloaded {exported}</p>}
    </div>
  </div>;
}
