import { useState } from "react";
import type { NormalizedProject, NormalizedRecord } from "../lib/model";

type Kind = "ACTIVITY" | "GATE";
type Node = { kind: Kind; id: string; name: string };
type Edge = { row: NormalizedRecord; node: Node };
const nodeKey = (node: Pick<Node, "kind" | "id">) => `${node.kind}:${node.id}`;

export function DependencyNeighborhood({ project, focus, onSelect, onConnect, disabled }: {
  project: NormalizedProject; focus: { kind: Kind; id: string };
  onSelect: (node: { kind: Kind; id: string }) => void;
  onConnect: (direction: "in" | "out", node: Node) => void;
  disabled: boolean;
}) {
  const [direction, setDirection] = useState<"in" | "out">("out");
  const [choice, setChoice] = useState("");
  const nodes: Node[] = [
    ...project.activities.map((row) => ({ kind: "ACTIVITY" as const, id: String(row.activity_id), name: String(row.name || row.activity_id) })),
    ...project.gates.map((row) => ({ kind: "GATE" as const, id: String(row.gate_id), name: String(row.name || row.gate_id) })),
  ];
  const byKey = new Map(nodes.map((node) => [nodeKey(node), node]));
  const current = byKey.get(nodeKey(focus));
  const edges = (side: "in" | "out"): Edge[] => project.dependencies.flatMap((row) => {
    const atFocus = side === "in" ? row.target_type === focus.kind && row.target_id === focus.id
      : row.source_type === focus.kind && row.source_id === focus.id;
    const other = byKey.get(`${side === "in" ? row.source_type : row.target_type}:${side === "in" ? row.source_id : row.target_id}`);
    return atFocus && other ? [{ row, node: other }] : [];
  });
  const card = (node: Node, selected = false) => <button type="button" className={`dependency-node ${node.kind.toLowerCase()}${selected ? " selected" : ""}`}
    onClick={() => onSelect(node)} aria-current={selected ? "true" : undefined}>
    <span>{node.kind === "GATE" ? "◇ Gate" : "▣ Activity"}</span>
    <strong>{node.name}</strong><code>{node.id}</code>
  </button>;
  const lane = (side: "in" | "out") => <div className="dependency-lane" aria-label={side === "in" ? "Graph predecessors" : "Graph successors"}>
    <h5>{side === "in" ? "Predecessors" : "Successors"} ({edges(side).length})</h5>
    {edges(side).length ? edges(side).map(({ row, node }) => <div key={String(row.dependency_id)} className={`dependency-edge${row.enabled === true ? "" : " inactive"}`}>
      {side === "in" && card(node)}
      <div className="dependency-connector" aria-label={`${node.id} ${side === "in" ? "to" : "from"} ${focus.id}: FS lag ${String(row.lag_h ?? 0)} hours, ${row.enabled === true ? "active" : "inactive"}`}>
        <span className="dependency-arrow" aria-hidden="true">→</span>
        <span>FS · +{String(row.lag_h ?? 0)} h · {row.enabled === true ? "Active" : "Inactive"}</span>
        <code>{String(row.dependency_id)}</code>
      </div>
      {side === "out" && card(node)}
    </div>) : <p>No direct {side === "in" ? "predecessor" : "successor"}.</p>}
  </div>;
  const choices = nodes.filter((node) => nodeKey(node) !== nodeKey(focus))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  return <section className="dependency-neighborhood" aria-label={`Direct dependency graph for ${focus.id}`}>
    <h4>Direct dependency graph</h4>
    <p>Declared FS links only. Inactive links are shown but do not constrain the schedule; this view does not calculate a critical path.</p>
    <div className="dependency-graph">
      {lane("in")}
      <div className="dependency-center" aria-label="Selected graph node"><h5>Selected element</h5>
        {current && card(current, true)}</div>
      {lane("out")}
    </div>
    <div className="dependency-connect" aria-label="Select two elements for an FS link">
      <strong>Connect {current?.name ?? focus.id} <code>{focus.id}</code></strong>
      <label>Direction
        <select value={direction} onChange={(event) => { setDirection(event.target.value as "in" | "out"); setChoice(""); }} disabled={disabled}>
          <option value="out">Selected → successor</option><option value="in">Predecessor → selected</option>
        </select>
      </label>
      <label>{direction === "in" ? "Choose predecessor" : "Choose successor"}
        <select value={choice} onChange={(event) => setChoice(event.target.value)} disabled={disabled}>
          <option value="">Select activity or Gate…</option>
          {choices.map((node) => <option key={nodeKey(node)} value={nodeKey(node)}>{node.kind === "GATE" ? "Gate" : "Activity"} · {node.name} · {node.id}</option>)}
        </select>
      </label>
      <button type="button" disabled={disabled || !choice} onClick={() => {
        const node = byKey.get(choice);
        if (node) onConnect(direction, node);
      }}>Review FS lag and justification</button>
    </div>
  </section>;
}
