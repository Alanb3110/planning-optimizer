import { useState } from "react";
import type { NormalizedProject, NormalizedRecord } from "../lib/model";
import { duplicateActivity, duplicatePackage } from "../lib/modelEdits";

type Kind = "SYSTEM" | "PACKAGE" | "ACTIVITY" | "GATE";
type Selection = { kind: Kind; id: string };
const config = {
  SYSTEM: { collection: "systems", id: "system_id" },
  PACKAGE: { collection: "packages", id: "package_id" },
  ACTIVITY: { collection: "activities", id: "activity_id" },
  GATE: { collection: "gates", id: "gate_id" },
} as const;
const bool = (value: unknown) => value === true;
const str = (value: unknown) => String(value ?? "");

export function EntityEditor({ project, focus, onChange, onSelect, disabled }: {
  project: NormalizedProject; focus: Selection | null;
  onChange: (project: NormalizedProject) => void;
  onSelect: (selection: Selection) => void; disabled: boolean;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<NormalizedRecord>({});
  const [error, setError] = useState("");
  const start = (nextKind: Kind, existing = false) => {
    const { collection, id } = config[nextKind];
    const row = existing ? project[collection].find((item) => item[id] === focus?.id) : undefined;
    setKind(nextKind); setEditing(existing); setError("");
    setDraft(row ? { ...row } : nextKind === "SYSTEM" ? { enabled: true }
      : nextKind === "PACKAGE" ? { enabled: true, system_id: focus?.kind === "SYSTEM" ? focus.id : "" }
      : nextKind === "ACTIVITY" ? { enabled: true, preemptible: false, requires_system_arrival: true,
        duration_basis: "WORK_TIME", package_id: focus?.kind === "PACKAGE" ? focus.id : "" }
      : { exposed: true, is_project_milestone: false,
        system_id: focus?.kind === "SYSTEM" ? focus.id : "",
        package_id: focus?.kind === "PACKAGE" ? focus.id : "" });
  };
  const field = (name: string, label: string, required = false, type = "text") => <label key={name}>{label}
    <input type={type} required={required} value={str(draft[name])} disabled={disabled || (editing && config[kind!].id === name)}
      onChange={(event) => setDraft({ ...draft, [name]: event.target.value })} />
  </label>;
  const choice = (name: string, label: string, items: Array<{ id: string; label?: string }>, required = false) =>
    <label key={name}>{label}<select required={required} value={str(draft[name])} disabled={disabled}
      onChange={(event) => setDraft({ ...draft, [name]: event.target.value || undefined })}>
      <option value="">{required ? "Select…" : "None"}</option>
      {items.map((item) => <option key={item.id} value={item.id}>{item.label ? `${item.id} · ${item.label}` : item.id}</option>)}
    </select></label>;
  const checkbox = (name: string, label: string) => <label key={name} className="model-checkbox">
    <input type="checkbox" checked={bool(draft[name])} disabled={disabled}
      onChange={(event) => setDraft({ ...draft, [name]: event.target.checked })} /> {label}
  </label>;
  const systems = project.systems.map((row) => ({ id: str(row.system_id), label: str(row.name) }));
  const packages = project.packages.map((row) => ({ id: str(row.package_id), label: str(row.name) }));
  const calendars = project.calendars.map((row) => ({ id: str(row.calendar_id), label: str(row.name) }));
  const zones = project.zones.map((row) => ({ id: str(row.zone_id), label: str(row.name) }));
  const save = () => {
    if (!kind) return;
    const { collection, id } = config[kind];
    const identifier = str(draft[id]).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(identifier)) { setError("ID must contain only letters, digits, _ or -."); return; }
    if (!editing && project[collection].some((row) => row[id] === identifier)) { setError("This ID already exists."); return; }
    if (!str(draft.name).trim() || (kind === "SYSTEM" && (!str(draft.family).trim() ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/.test(str(draft.arrival_date)) ||
      !Number.isFinite(Date.parse(str(draft.arrival_date)))))) {
      setError("Enter a name, and for a system a family and an arrival with timezone offset (e.g. 2030-01-02T08:00:00+04:00)."); return;
    }
    if ((kind === "PACKAGE" || kind === "ACTIVITY") && !str(draft[kind === "PACKAGE" ? "system_id" : "package_id"])) {
      setError("Select the parent system or package."); return;
    }
    if (kind === "ACTIVITY" && (!Number.isInteger(Number(draft.duration_h)) || Number(draft.duration_h) <= 0 || !str(draft.duration_h).trim())) {
      setError("Nominal duration must be a positive whole number of hours."); return;
    }
    if (kind === "GATE" && !str(draft.gate_type).trim()) { setError("Enter a gate type."); return; }
    if (kind === "PACKAGE" && str(draft.display_order) && (!Number.isInteger(Number(draft.display_order)) || Number(draft.display_order) < 0)) {
      setError("Display order must be a non-negative whole number."); return;
    }
    const row: NormalizedRecord = { ...draft, [id]: identifier, name: str(draft.name).trim() };
    if (kind === "SYSTEM") row.arrival_date = new Date(str(draft.arrival_date)).toISOString();
    if (kind === "ACTIVITY") row.duration_h = Number(draft.duration_h);
    if (kind === "PACKAGE" && str(draft.display_order)) row.display_order = Number(draft.display_order);
    for (const optional of ["calendar_id", "system_id", "package_id", "installation_zone", "template", "display_order"]) {
      if (row[optional] === "" || row[optional] === undefined) delete row[optional];
    }
    onChange({ ...project, [collection]: editing
      ? project[collection].map((item) => item[id] === focus?.id ? row : item)
      : [...project[collection], row] });
    setKind(null); setError("");
    onSelect({ kind, id: identifier });
  };
  const duplicate = () => {
    if (!focus) return;
    const result = focus.kind === "ACTIVITY" ? duplicateActivity(project, focus.id)
      : duplicatePackage(project, focus.id);
    onChange(result.project);
    onSelect({ kind: focus.kind, id: result.id });
  };

  return <section className="entity-editor" aria-label="Edit workbook entities">
    <h4>Systems, packages, activities and gates</h4>
    {focus && <div className="model-row-actions contextual-actions">
      {focus?.kind === "PACKAGE" && <button type="button" onClick={() => start("ACTIVITY")} disabled={disabled}>Add activity to {focus.id}</button>}
      {focus && <button type="button" onClick={() => start(focus.kind, true)} disabled={disabled}>Edit {focus.kind.toLowerCase()} {focus.id}</button>}
      {(focus?.kind === "ACTIVITY" || focus?.kind === "PACKAGE") &&
        <button type="button" onClick={duplicate} disabled={disabled}>Duplicate {focus.kind.toLowerCase()} {focus.id}</button>}
    </div>}
    <div className="model-row-actions general-actions">
      {(["SYSTEM", "PACKAGE", "ACTIVITY", "GATE"] as Kind[]).map((value) =>
        <button type="button" key={value} onClick={() => start(value)} disabled={disabled}>Add {value.toLowerCase()}</button>)}
    </div>
    {kind && <div className="model-fields" aria-label={`${editing ? "Edit" : "New"} ${kind.toLowerCase()} form`}>
      <h4>{editing ? `Edit ${focus?.id}` : `New ${kind.toLowerCase()}`}</h4>
      {field(config[kind].id, `${kind.toLowerCase()} ID`, true)}
      {field("name", "Name", true)}
      {kind === "SYSTEM" && <>
        {field("family", "Family", true)}
        {field("arrival_date", "Arrival (ISO date/time with offset)", true)}
        {field("delivery_state", "Delivery state")}{field("assembly_location", "Assembly location")}
        {choice("installation_zone", "Installation zone", zones)}
        {field("template_version", "Template version")}{checkbox("enabled", "Enabled")}{field("notes", "Notes")}
      </>}
      {kind === "PACKAGE" && <>
        {choice("system_id", "System", systems, true)}{field("template", "Template")}
        {field("display_order", "Display order", false, "number")}{checkbox("enabled", "Enabled")}
      </>}
      {kind === "ACTIVITY" && <>
        {choice("package_id", "Package", packages, true)}
        {field("duration_h", "Nominal duration (h)", true, "number")}
        {choice("duration_basis", "Duration basis", [{ id: "WORK_TIME" }, { id: "ELAPSED_TIME" }], true)}
        {choice("calendar_id", "Activity calendar", calendars)}
        {checkbox("preemptible", "Interruptible")}{checkbox("requires_system_arrival", "Requires system arrival")}
        {checkbox("enabled", "Enabled")}{field("notes", "Notes")}
        <p className="activity-next-step">After saving, review role demand, zone occupancy and FS links for this activity. They are edited in the selected activity view.</p>
      </>}
      {kind === "GATE" && <>
        {choice("system_id", "System (optional)", systems)}{choice("package_id", "Package (optional)", packages)}
        {field("gate_type", "Gate type", true)}{checkbox("exposed", "Exposed")}
        {checkbox("is_project_milestone", "Project milestone")}{field("notes", "Notes")}
      </>}
      <div className="model-row-actions"><button type="button" onClick={save} disabled={disabled}>{editing ? "Save" : "Add"} {kind.toLowerCase()}</button>
        <button type="button" onClick={() => { setKind(null); setError(""); }} disabled={disabled}>Cancel</button></div>
      {error && <p role="alert">{error}</p>}
    </div>}
    <p>New activities have no resource or zone demand until you add it in Resources, zones and calendars. Review these constraints before operational use. After adding an activity, link existing gates or activities with Add predecessor / Add successor; set an FS lag and justification.</p>
    <p>Duplicating a package copies its activities, package gates, resource and zone demands, and links internal to that package. Cross-package links and milestone priorities require explicit review.</p>
  </section>;
}
