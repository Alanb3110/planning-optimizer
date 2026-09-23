import { useState } from "react";
import type { NormalizedProject, NormalizedRecord } from "../lib/model";
import { validateProject } from "../lib/validation";

type Kind = "resources" | "zones" | "calendars" | "activity_resources" | "activity_zones" | "calendar_shifts";
type Field = { key: string; label: string; type?: "number" | "checkbox" | "select" | "date" | "time"; options?: string[] };
const days = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const fields: Record<Kind, Field[]> = {
  resources: [{ key: "resource_id", label: "Role / pool ID" }, { key: "name", label: "Role / pool name" },
    { key: "type", label: "Type", type: "select", options: ["HUMAN", "EQUIPMENT", "WORKFRONT"] },
    { key: "capacity", label: "Capacity", type: "number" }, { key: "unlimited", label: "Unlimited", type: "checkbox" },
    { key: "calendar_id", label: "Calendar", type: "select" }, { key: "notes", label: "Notes" }],
  zones: [{ key: "zone_id", label: "Zone ID" }, { key: "name", label: "Name" },
    { key: "capacity", label: "Capacity", type: "number" }, { key: "calendar_id", label: "Calendar", type: "select" },
    { key: "notes", label: "Notes" }],
  calendars: [{ key: "calendar_id", label: "Calendar ID" }, { key: "name", label: "Name" },
    { key: "timezone", label: "IANA timezone" }, { key: "valid_from", label: "Valid from", type: "date" },
    { key: "valid_to", label: "Valid to", type: "date" }, { key: "notes", label: "Notes" }],
  activity_resources: [{ key: "activity_id", label: "Activity", type: "select" },
    { key: "resource_id", label: "Role / pool", type: "select" }, { key: "quantity", label: "Required capacity", type: "number" }],
  activity_zones: [{ key: "activity_id", label: "Activity", type: "select" },
    { key: "zone_id", label: "Zone", type: "select" }, { key: "load", label: "Load (number or ALL when exclusive)" },
    { key: "exclusive", label: "Exclusive occupancy", type: "checkbox" }],
  calendar_shifts: [{ key: "calendar_id", label: "Calendar", type: "select" },
    { key: "weekday", label: "Weekday", type: "select", options: days }, { key: "shift_name", label: "Shift name" },
    { key: "start_time", label: "Start (local)", type: "time" }, { key: "end_time", label: "End (local)", type: "time" },
    { key: "enabled", label: "Enabled", type: "checkbox" }],
};
const labels: Record<Kind, string> = {
  resources: "Roles and capacities", zones: "Zones and capacities", calendars: "Calendars",
  activity_resources: "Activity role demand", activity_zones: "Activity zone occupancy", calendar_shifts: "Calendar shifts",
};
const ids: Partial<Record<Kind, string>> = { resources: "resource_id", zones: "zone_id", calendars: "calendar_id" };
const str = (value: unknown) => String(value ?? "");

export function ConstraintEditor({ project, activityId, onChange, disabled }: {
  project: NormalizedProject; activityId?: string; onChange: (project: NormalizedProject) => void; disabled: boolean;
}) {
  const [kind, setKind] = useState<Kind>(activityId ? "activity_resources" : "resources");
  const [scope, setScope] = useState("");
  const [index, setIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<NormalizedRecord | null>(null);
  const rows = project[kind];
  const scoped = rows.map((row, i) => ({ row, i })).filter(({ row }) =>
    (kind === "activity_resources" || kind === "activity_zones") ? (!activityId || row.activity_id === activityId)
      : kind === "calendar_shifts" ? (!scope || row.calendar_id === scope) : true);
  const options = (key: string) => key === "calendar_id" ? project.calendars.map((row) => str(row.calendar_id))
    : key === "resource_id" ? project.resources.map((row) => str(row.resource_id))
    : key === "zone_id" ? project.zones.map((row) => str(row.zone_id))
    : key === "activity_id" ? project.activities.map((row) => str(row.activity_id)) : days;
  const modified = draft === null ? null : { ...project, [kind]: index === null ? [...rows, draft]
    : rows.map((row, i) => i === index ? draft : row) } as NormalizedProject;
  const baseline = validateProject(project).filter((issue) => issue.severity === "error");
  const preview = modified ? validateProject(modified).filter((issue) => issue.severity === "error") : [];
  const issueKey = (issue: { code: string; location?: string; message: string }) => `${issue.code}:${issue.location}:${issue.message}`;
  const before = new Set(baseline.map(issueKey));
  const after = new Set(preview.map(issueKey));
  const added = preview.filter((issue) => !before.has(issueKey(issue)));
  const resolved = baseline.filter((issue) => !after.has(issueKey(issue)));
  const begin = (i: number | null, table: Kind = kind) => {
    if (table !== kind) setKind(table);
    setIndex(i);
    setDraft(i === null ? table === "resources" ? { type: "HUMAN", capacity: 1, unlimited: false }
      : table === "zones" ? { capacity: 1 }
      : table === "calendars" ? {}
      : table === "activity_resources" ? { activity_id: activityId ?? "", quantity: 1 }
      : table === "activity_zones" ? { activity_id: activityId ?? "", load: 1, exclusive: false }
      : { calendar_id: scope, weekday: "MON", shift_name: "", start_time: "08:00", end_time: "16:00", enabled: true }
      : { ...rows[i] });
  };
  const update = (key: string, value: unknown) => setDraft((current) => {
    if (!current) return current;
    const next = { ...current };
    if (value === "" || (key === "weekend_days" && Array.isArray(value) && value.length === 0)) delete next[key];
    else next[key] = key === "load" && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value) : value;
    return next;
  });
  const save = () => {
    if (!modified) return;
    onChange(modified);
    setDraft(null);
  };
  const remove = (i: number) => {
    onChange({ ...project, [kind]: rows.filter((_, rowIndex) => rowIndex !== i) });
    setDraft(null);
  };
  const describe = (row: NormalizedRecord) => kind === "resources" ? `${str(row.resource_id)} · ${str(row.name)} · ${str(row.capacity)}${row.unlimited ? " (unlimited)" : ""}`
    : kind === "zones" ? `${str(row.zone_id)} · ${str(row.name)} · capacity ${str(row.capacity)}`
    : kind === "calendars" ? `${str(row.calendar_id)} · ${str(row.name)} · ${str(row.timezone)}`
    : kind === "activity_resources" ? `${str(row.activity_id)} · ${str(row.resource_id)} × ${str(row.quantity)}`
    : kind === "activity_zones" ? `${str(row.activity_id)} · ${str(row.zone_id)} · ${str(row.load)}${row.exclusive ? " · exclusive" : ""}`
    : `${str(row.calendar_id)} · ${str(row.weekday)} ${str(row.start_time)}–${str(row.end_time)} · ${str(row.shift_name)}${row.enabled ? "" : " (disabled)"}`;

  return <section className="constraint-editor" aria-label="Resource, zone and calendar editing">
    <h4>Resources, zones and calendars</h4>
    <p>Resources are roles or pools. Activity demands reserve capacity; a zone can be shared up to its capacity or blocked by an exclusive activity.</p>
    {activityId && <div className="activity-demands" aria-label={`Demands for ${activityId}`}>
      <strong>Demands for <code>{activityId}</code></strong>
      <span>{project.activity_resources.filter((row) => row.activity_id === activityId).length} role demand(s) · {project.activity_zones.filter((row) => row.activity_id === activityId).length} zone occupancy row(s)</span>
      <div className="model-row-actions">
        <button type="button" onClick={() => begin(null, "activity_resources")} disabled={disabled}>Add role demand</button>
        <button type="button" onClick={() => begin(null, "activity_zones")} disabled={disabled}>Add zone occupancy</button>
      </div>
    </div>}
    <label>Constraint table<select aria-label="Constraint table" value={kind} onChange={(event) => { setKind(event.target.value as Kind); setDraft(null); }} disabled={disabled}>
      {(Object.keys(labels) as Kind[]).map((key) => <option key={key} value={key}>{labels[key]}</option>)}
    </select></label>
    {kind === "calendar_shifts" && <label>Show shifts for calendar<select aria-label="Shift calendar filter" value={scope} onChange={(event) => { setScope(event.target.value); setDraft(null); }}>
      <option value="">All calendars</option>{options("calendar_id").map((value) => <option key={value}>{value}</option>)}
    </select></label>}
    <div className="constraint-rows">{scoped.map(({ row, i }) => <div className="constraint-row" key={`${kind}-${i}`}>
      <span>{describe(row)}</span><button type="button" disabled={disabled} onClick={() => begin(i)} aria-label={`Edit ${describe(row)}`}>Edit</button>
      <button type="button" disabled={disabled} onClick={() => remove(i)} aria-label={`Remove ${describe(row)}`}>Remove</button>
    </div>)}</div>
    <button type="button" onClick={() => begin(null)} disabled={disabled}>Add {labels[kind].toLowerCase()}</button>
    {draft && <div className="model-fields" aria-label={`Edit ${labels[kind]}`}>
      <h4>{index === null ? "Add" : "Edit"} {labels[kind].toLowerCase()}</h4>
      {fields[kind].map((field) => <label key={field.key}>{field.label}
        {field.type === "checkbox" ? <input type="checkbox" checked={draft[field.key] === true} disabled={disabled} onChange={(event) => update(field.key, event.target.checked)} />
          : field.type === "select" ? <select value={str(draft[field.key])} disabled={disabled || (index !== null && (ids[kind] === field.key || (Boolean(activityId) && field.key === "activity_id")))} onChange={(event) => update(field.key, event.target.value)}>
            <option value="">Select…</option>{(field.options ?? options(field.key)).map((value) => {
              const collection = field.key === "activity_id" ? project.activities : field.key === "resource_id" ? project.resources
                : field.key === "zone_id" ? project.zones : field.key === "calendar_id" ? project.calendars : [];
              const name = collection.find((row) => row[field.key] === value)?.name;
              return <option key={value} value={value}>{name ? `${value} · ${String(name)}` : value}</option>;
            })}
          </select> : <input type={field.type ?? "text"} step={field.type === "number" ? "any" : undefined}
            value={str(draft[field.key])} disabled={disabled || (index !== null && ids[kind] === field.key)}
            onChange={(event) => update(field.key, field.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value)} />}
      </label>)}
      {kind === "calendars" && <fieldset className="constraint-weekends"><legend>Weekend days (descriptive; only enabled shifts determine working slots)</legend>{days.map((day) => <label key={day}>
        <input type="checkbox" checked={Array.isArray(draft.weekend_days) && draft.weekend_days.includes(day)} disabled={disabled}
          onChange={(event) => update("weekend_days", event.target.checked ? [...(Array.isArray(draft.weekend_days) ? draft.weekend_days : []), day]
            : (Array.isArray(draft.weekend_days) ? draft.weekend_days : []).filter((item) => item !== day))} />{day}</label>)}</fieldset>}
      <div className="constraint-preview" role="status" aria-live="polite">
        <strong>Validation before recalculation: {preview.length ? `${preview.length} error(s), calculation blocked` : "valid, ready to calculate"}</strong>
        <span>{added.length} new · {resolved.length} resolved. Saving clears the previous schedule.</span>
        {added.length > 0 && <ul>{added.slice(0, 5).map((issue, i) => <li key={i}>{issue.location}: {issue.message}</li>)}</ul>}
      </div>
      <div className="model-row-actions"><button type="button" onClick={save} disabled={disabled}>Save change</button>
        <button type="button" onClick={() => setDraft(null)} disabled={disabled}>Cancel</button></div>
    </div>}
  </section>;
}
