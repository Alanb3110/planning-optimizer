import { useId, useMemo, useState } from "react";
import type { SchedulingDependency, SchedulingProject } from "../lib/scheduler/types";

type Kind = "SYSTEM" | "PACKAGE" | "ACTIVITY" | "GATE";
type Entity = { kind: Kind; id: string; name: string; row: Record<string, unknown> };
type Link = { dependency: SchedulingDependency; other: Entity };

const label = (row: Record<string, unknown>, id: string): string =>
  typeof row.name === "string" && row.name.trim() ? row.name : id;
const matches = (entity: Entity, query: string) =>
  `${entity.id} ${entity.name}`.toLocaleLowerCase().includes(query);
const keyOf = (kind: Kind, id: string) => `${kind}:${id}`;

export function WorkbookExplorer({ project }: { project: SchedulingProject }) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const entities = useMemo(() => {
    const map = new Map<string, Entity>();
    const add = (kind: Kind, id: string, row: Record<string, unknown>) =>
      map.set(keyOf(kind, id), { kind, id, name: label(row, id), row });
    project.systems.forEach((row) => add("SYSTEM", row.system_id, row));
    project.packages.forEach((row) => add("PACKAGE", row.package_id, row));
    project.activities.forEach((row) => add("ACTIVITY", row.activity_id, row));
    project.gates.forEach((row) => add("GATE", row.gate_id, row));
    return map;
  }, [project]);
  const selected = selection ? entities.get(selection) : undefined;
  const term = query.trim().toLocaleLowerCase();
  const visible = (kind: Kind, id: string) => !term || matches(entities.get(keyOf(kind, id))!, term);
  const gatesFor = (packageId?: string, systemId?: string) => project.gates.filter((gate) =>
    packageId ? gate.package_id === packageId
      : systemId ? !gate.package_id && gate.system_id === systemId
        : !gate.package_id && !gate.system_id);
  const sortedPackages = (systemId: string) => project.packages
    .filter((row) => row.system_id === systemId)
    .sort((a, b) => (typeof a.display_order === "number" ? a.display_order : Number.MAX_SAFE_INTEGER)
      - (typeof b.display_order === "number" ? b.display_order : Number.MAX_SAFE_INTEGER)
      || a.package_id.localeCompare(b.package_id));
  const links = (direction: "in" | "out"): Link[] =>
    selected && (selected.kind === "ACTIVITY" || selected.kind === "GATE")
      ? project.dependencies.flatMap((dependency) => {
        const endpointType = direction === "in" ? dependency.target_type : dependency.source_type;
        const endpointId = direction === "in" ? dependency.target_id : dependency.source_id;
        if (endpointType !== selected.kind || endpointId !== selected.id) return [];
        const otherType = direction === "in" ? dependency.source_type : dependency.target_type;
        const otherId = direction === "in" ? dependency.source_id : dependency.target_id;
        const other = entities.get(keyOf(otherType, otherId));
        return other ? [{ dependency, other }] : [];
      })
      : [];
  const select = (entity: Entity) => setSelection(keyOf(entity.kind, entity.id));
  const entry = (kind: Kind, id: string) => {
    const entity = entities.get(keyOf(kind, id))!;
    return (
      <button type="button" className="workbook-item" aria-current={selected === entity ? "true" : undefined}
        onClick={() => select(entity)}>
        <span className="workbook-kind">{kind.toLowerCase()}</span>
        <strong>{entity.name}</strong><code>{id}</code>
        {kind !== "GATE" && <small>{entity.row.enabled === true ? "Active" : "Inactive"}</small>}
      </button>
    );
  };
  const packageEntry = (packageId: string, systemMatch: boolean) => {
    const item = project.packages.find((row) => row.package_id === packageId)!;
    const activities = project.activities.filter((row) => row.package_id === packageId);
    const gates = gatesFor(packageId);
    const own = visible("PACKAGE", packageId);
    const showActivities = systemMatch || own ? activities : activities.filter((row) => visible("ACTIVITY", row.activity_id));
    const showGates = systemMatch || own ? gates : gates.filter((row) => visible("GATE", row.gate_id));
    if (!systemMatch && !own && !showActivities.length && !showGates.length) return null;
    return <li key={packageId}>{entry("PACKAGE", packageId)}
      {(showActivities.length > 0 || showGates.length > 0) && <ul>
        {showActivities.map((row) => <li key={row.activity_id}>{entry("ACTIVITY", row.activity_id)}</li>)}
        {showGates.map((row) => <li key={row.gate_id}>{entry("GATE", row.gate_id)}</li>)}
      </ul>}
    </li>;
  };
  const systemEntry = (systemId: string) => {
    const own = visible("SYSTEM", systemId);
    const packages = sortedPackages(systemId).map((row) => packageEntry(row.package_id, own)).filter((row) => row !== null);
    const gates = gatesFor(undefined, systemId).filter((row) => own || visible("GATE", row.gate_id));
    if (!own && !packages.length && !gates.length) return null;
    return <li key={systemId}>{entry("SYSTEM", systemId)}
      {(packages.length > 0 || gates.length > 0) && <ul>{packages}
        {gates.map((row) => <li key={row.gate_id}>{entry("GATE", row.gate_id)}</li>)}
      </ul>}
    </li>;
  };
  const systemRows = project.systems.map((row) => systemEntry(row.system_id)).filter((row) => row !== null);
  const projectGates = gatesFor().filter((row) => visible("GATE", row.gate_id));
  const relationList = (direction: "in" | "out") => {
    const edges = links(direction);
    return <div className="workbook-relations">
      <h4>{direction === "in" ? "Direct predecessors" : "Direct successors"} ({edges.length})</h4>
      {edges.length ? <ul>{edges.map(({ dependency, other }) =>
        <li key={dependency.dependency_id}>
          <button type="button" className="workbook-jump" onClick={() => select(other)}>
            {other.name} <code>{other.id}</code> <span>({other.kind.toLowerCase()})</span>
          </button>
          <span className="workbook-lag">FS · lag {dependency.lag_h ?? 0} h · {dependency.enabled === true ? "Active" : "Inactive"}</span>
          <code className="workbook-edge-id">{dependency.dependency_id}</code>
        </li>)}</ul> : <p>No direct {direction === "in" ? "predecessors" : "successors"} in this workbook.</p>}
    </div>;
  };

  return <section className="workbook-explorer" aria-label="Imported workbook explorer">
    <div className="section-heading"><div><span className="section-kicker">Source model · V1</span><h2>Explore workbook</h2></div></div>
    <p>Browse the imported model before solving. Links show declared FS dependencies and their lags; they do not identify a critical path.</p>
    <div className="workbook-layout">
      <div className="workbook-browser">
        <label htmlFor={searchId}>Search by ID or name</label>
        <input id={searchId} type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="e.g. LOX_DRY_RELEASED" />
        <div className="workbook-tree" aria-label="Systems, packages, activities and gates">
          {systemRows.length > 0 && <ul>{systemRows}</ul>}
          {projectGates.length > 0 && <div className="workbook-global"><h3>Project gates</h3><ul>
            {projectGates.map((row) => <li key={row.gate_id}>{entry("GATE", row.gate_id)}</li>)}
          </ul></div>}
          {!systemRows.length && !projectGates.length && <p>No matching elements.</p>}
        </div>
      </div>
      <div className="workbook-details" aria-live="polite">
        {selected ? <>
          <span className="workbook-kind">{selected.kind.toLowerCase()}</span>
          <h3>{selected.name}</h3><code>{selected.id}</code>
          {selected.kind === "ACTIVITY" && <p>Duration: {String(selected.row.duration_h)} h ({String(selected.row.duration_basis)}) · {selected.row.enabled === true ? "Active" : "Inactive"}</p>}
          {selected.kind === "GATE" && <p>Gate type: {String(selected.row.gate_type)} · Gates have no active flag in V1.</p>}
          {(selected.kind === "SYSTEM" || selected.kind === "PACKAGE") && <p>{selected.row.enabled === true ? "Active" : "Inactive"} · Dependencies connect activities and gates in V1. Select a child to inspect its links.</p>}
          {(selected.kind === "ACTIVITY" || selected.kind === "GATE") && <>
            {relationList("in")}{relationList("out")}
            <p className="workbook-caveat">Follow a linked element to inspect the next step. Inactive links are shown for review and do not constrain the schedule. This view does not calculate a critical path.</p>
          </>}
        </> : <p>Select an element to see its direct links. Search for a gate such as LOX_DRY_RELEASED, then follow its predecessors.</p>}
      </div>
    </div>
  </section>;
}
