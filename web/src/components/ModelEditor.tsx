import { useState } from "react";
import type { NormalizedProject, NormalizedRecord } from "../lib/model";
import { duplicateActivity } from "../lib/modelEdits";
import { EntityEditor } from "./EntityEditor";
import { ConstraintEditor } from "./ConstraintEditor";

type NodeType = "ACTIVITY" | "GATE";
type Draft = { dependency_id: string; source_type: NodeType; source_id: string; target_type: NodeType; target_id: string; lag_h: string; rationale: string; enabled: boolean };
const empty: Draft = { dependency_id: "", source_type: "ACTIVITY", source_id: "", target_type: "GATE", target_id: "", lag_h: "0", rationale: "", enabled: true };

export function ModelEditor({ project, focus, onChange, onSelect, onExport, canExport, disabled = false }: {
  project: NormalizedProject; onChange: (project: NormalizedProject) => void;
  focus: { kind: "SYSTEM" | "PACKAGE" | "ACTIVITY" | "GATE"; id: string } | null;
  onSelect: (selection: { kind: "SYSTEM" | "PACKAGE" | "ACTIVITY" | "GATE"; id: string }) => void;
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
  const [copySource, setCopySource] = useState("");
  const [editRequest, setEditRequest] = useState<{ token: number; mode: "edit" | "new" }>();
  const [addRequest, setAddRequest] = useState<{ token: number; kind: "activity_resources" | "activity_zones" }>();

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
    .map((row) => ({ id: String(row[type === "ACTIVITY" ? "activity_id" : "gate_id"]), name: String(row.name ?? "") }));
  const linked = project.dependencies.map((row, index) => ({ row, index })).filter(({ row }) =>
    focus !== null && ((row.source_type === focus.kind && row.source_id === focus.id) ||
    (row.target_type === focus.kind && row.target_id === focus.id)));
  const selectedGate = focus?.kind === "GATE" ? project.gates.find((row) => row.gate_id === focus.id) : undefined;
  const activity = focus?.kind === "ACTIVITY" ? project.activities.find((row) => row.activity_id === focus.id) : undefined;
  const activityPackage = activity && project.packages.find((row) => row.package_id === activity.package_id);
  const activitySystem = activityPackage && project.systems.find((row) => row.system_id === activityPackage.system_id);
  const siblings = project.activities.filter((row) => row.package_id === (activityPackage?.package_id ?? (focus?.kind === "PACKAGE" ? focus.id : undefined)));
  const roleRows = project.activity_resources.filter((row) => row.activity_id === focus?.id);
  const zoneRows = project.activity_zones.filter((row) => row.activity_id === focus?.id);
  const inbound = linked.filter(({ row }) => row.target_type === "ACTIVITY" && row.target_id === focus?.id && row.enabled === true);
  const outbound = linked.filter(({ row }) => row.source_type === "ACTIVITY" && row.source_id === focus?.id && row.enabled === true);
  const calendar = activity?.calendar_id || project.metadata.active_calendar;
  const reviewItems = activity ? [
    { label: "Duration and calendar", detail: `${String(activity.duration_h)} h · ${String(activity.duration_basis)} · ${calendar ? `${calendar}${activity.calendar_id ? " (activity)" : " (project default)"}` : "no calendar"} · ${activity.preemptible ? "interruptible" : "continuous"}`, pending: !calendar, target: "activity-identity" },
    { label: "System arrival", detail: `${activity.requires_system_arrival === false ? "Not required" : "Required"} · ${String(activitySystem?.arrival_date ?? "arrival not set")}`, pending: !activitySystem || !activitySystem.arrival_date || activity.requires_system_arrival === false, target: "activity-identity" },
    { label: "Role demand", detail: roleRows.length ? roleRows.map((row) => `${String(row.resource_id)} × ${String(row.quantity)}`).join("; ") : "No role demand", pending: !roleRows.length, target: "activity-constraints" },
    { label: "Zone occupancy", detail: zoneRows.length ? zoneRows.map((row) => `${String(row.zone_id)} · ${String(row.load)}${row.exclusive ? " exclusive" : ""}`).join("; ") : "No zone occupancy", pending: !zoneRows.length, target: "activity-constraints" },
    { label: "FS predecessors", detail: inbound.length ? inbound.map(({ row }) => `${String(row.source_id)} + ${String(row.lag_h ?? 0)} h`).join("; ") : "No active predecessor", pending: !inbound.length, target: "activity-links" },
    { label: "FS successors", detail: outbound.length ? outbound.map(({ row }) => `${String(row.target_id)} + ${String(row.lag_h ?? 0)} h`).join("; ") : "No active successor", pending: !outbound.length, target: "activity-links" },
  ] : [];
  const openReview = (label: string, target: string) => {
    if (label === "Duration and calendar" || label === "System arrival") setEditRequest((value) => ({ token: (value?.token ?? 0) + 1, mode: "edit" }));
    else if (label === "Role demand" || label === "Zone occupancy") setAddRequest((current) => ({ token: (current?.token ?? 0) + 1, kind: label === "Role demand" ? "activity_resources" : "activity_zones" }));
    else begin(label === "FS predecessors" ? "target" : "source");
    window.setTimeout(() => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };
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
        <option value="">Select…</option>{options(draft[`${side}_type`]).map(({ id, name }) => <option key={id} value={id}>{name ? `${id} · ${name}` : id}</option>)}
      </select>
    </label>
  </div>;

  return <div className="model-editor" aria-label="Model editing">
    {focus?.kind === "PACKAGE" && <section className="activity-guide" aria-label={`Compose activities in ${focus.id}`}>
      <h4>Compose activities in {focus.id}</h4>
      <p>Create an activity below, or copy one already in this package. Copies retain duration, calendar, role and zone rows; review all fields and add only justified FS links.</p>
      <a className="guide-create" href="#activity-identity">Create an activity in this package ↓</a>
      {siblings.length > 0 && <div className="guide-copy"><label>Copy an activity
        <select aria-label="Activity to duplicate" value={copySource} onChange={(event) => setCopySource(event.target.value)} disabled={disabled}>
          <option value="">Select an activity…</option>{siblings.map((row) => <option key={String(row.activity_id)} value={String(row.activity_id)}>{String(row.activity_id)} · {String(row.name)}</option>)}
        </select></label>
        <button type="button" disabled={disabled || !copySource} onClick={() => {
          const result = duplicateActivity(project, copySource);
          onChange(result.project); onSelect({ kind: "ACTIVITY", id: result.id });
        }}>Duplicate selected activity</button></div>}
      <p>{siblings.length} activit{siblings.length === 1 ? "y" : "ies"} in this package. Select each activity to review its constraints before moving on.</p>
    </section>}
    {activity && <section className="activity-guide" aria-label={`Review activity ${focus?.id}`}>
      <div className="guide-heading"><div><h4>Review activity {focus?.id}</h4><p>Package {String(activity.package_id)} · Review before selecting another activity.</p></div>
        {activityPackage && <button type="button" onClick={() => onSelect({ kind: "PACKAGE", id: String(activityPackage.package_id) })}>Back to package</button>}</div>
      <p className="guide-notice" role="status">{reviewItems.filter((item) => item.pending).length} item(s) to confirm. Empty demands or links can be intentional; nothing is added automatically. A populated item still needs an operational review.</p>
      <ol className="guide-checklist">{reviewItems.map((item) => <li key={item.label}>
        <strong>{item.label}</strong><span>{item.detail}</span><em>{item.pending ? "To confirm" : "Recorded · review"}</em>
        <button type="button" disabled={disabled} onClick={() => openReview(item.label, item.target)}>{item.label.startsWith("FS") ? "Add / review link" : item.label === "Role demand" || item.label === "Zone occupancy" ? "Add / review" : "Edit / review"}</button>
      </li>)}</ol>
      <div className="guide-siblings"><strong>Continue in this package</strong><div className="model-row-actions">
        <button type="button" disabled={disabled} onClick={() => { setEditRequest((value) => ({ token: (value?.token ?? 0) + 1, mode: "new" })); window.setTimeout(() => document.getElementById("activity-identity")?.scrollIntoView({ behavior: "smooth" }), 0); }}>Create next activity</button>
        {siblings.filter((row) => row.activity_id !== focus?.id).map((row) =>
        <button key={String(row.activity_id)} type="button" onClick={() => onSelect({ kind: "ACTIVITY", id: String(row.activity_id) })}>{String(row.activity_id)}</button>)}</div></div>
    </section>}
    <div id="activity-identity">
    <EntityEditor project={project} focus={focus} onChange={onChange} onSelect={onSelect} disabled={disabled} editRequest={editRequest} />
    </div>
    <div id="activity-constraints">
    <ConstraintEditor project={project} activityId={focus?.kind === "ACTIVITY" ? focus.id : undefined} onChange={onChange} disabled={disabled} addRequest={addRequest} />
    </div>
    {(focus?.kind === "ACTIVITY" || focus?.kind === "GATE") && <>
    <div id="activity-links">
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
    </div>
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
