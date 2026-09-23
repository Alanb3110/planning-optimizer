import type { NormalizedProject, NormalizedRecord } from "./model";

export function nextId(rows: NormalizedRecord[], field: string, sourceId: string): string {
  const used = new Set(rows.map((row) => String(row[field])));
  const base = `${sourceId}_COPY`;
  let candidate = base;
  for (let number = 2; used.has(candidate); number += 1) candidate = `${base}_${number}`;
  return candidate;
}

export function duplicateActivity(project: NormalizedProject, id: string): { project: NormalizedProject; id: string } {
  const source = project.activities.find((row) => row.activity_id === id);
  if (!source) throw new Error(`Unknown activity ${id}.`);
  const copyId = nextId(project.activities, "activity_id", id);
  return {
    id: copyId,
    project: {
      ...project,
      activities: [...project.activities, { ...source, activity_id: copyId }],
      activity_resources: [...project.activity_resources,
        ...project.activity_resources.filter((row) => row.activity_id === id).map((row) => ({ ...row, activity_id: copyId }))],
      activity_zones: [...project.activity_zones,
        ...project.activity_zones.filter((row) => row.activity_id === id).map((row) => ({ ...row, activity_id: copyId }))],
    },
  };
}

export function duplicatePackage(project: NormalizedProject, id: string): { project: NormalizedProject; id: string } {
  const source = project.packages.find((row) => row.package_id === id);
  if (!source) throw new Error(`Unknown package ${id}.`);
  const copyId = nextId(project.packages, "package_id", id);
  const activities = project.activities.filter((row) => row.package_id === id);
  // PROJECT_COMPLETE is unique in V1; a project milestone cannot be cloned as a package state.
  const gates = project.gates.filter((row) => row.package_id === id && row.gate_type !== "PROJECT_COMPLETE" && row.is_project_milestone !== true);
  const activityIds = new Map(activities.map((row) => [String(row.activity_id), nextId(project.activities, "activity_id", String(row.activity_id))]));
  const gateIds = new Map(gates.map((row) => [String(row.gate_id), nextId(project.gates, "gate_id", String(row.gate_id))]));
  const mapped = (type: unknown, nodeId: unknown) =>
    type === "ACTIVITY" ? activityIds.get(String(nodeId)) : type === "GATE" ? gateIds.get(String(nodeId)) : undefined;
  const copiedDependencies = project.dependencies.flatMap((row) => {
    const from = mapped(row.source_type, row.source_id);
    const to = mapped(row.target_type, row.target_id);
    return from && to ? [{ ...row, dependency_id: nextId(project.dependencies, "dependency_id", String(row.dependency_id)), source_id: from, target_id: to }] : [];
  });
  return {
    id: copyId,
    project: {
      ...project,
      packages: [...project.packages, { ...source, package_id: copyId }],
      activities: [...project.activities, ...activities.map((row) => ({ ...row, package_id: copyId, activity_id: activityIds.get(String(row.activity_id))! }))],
      gates: [...project.gates, ...gates.map((row) => ({ ...row, package_id: copyId, gate_id: gateIds.get(String(row.gate_id))! }))],
      activity_resources: [...project.activity_resources, ...project.activity_resources.flatMap((row) => {
        const mappedId = activityIds.get(String(row.activity_id));
        return mappedId ? [{ ...row, activity_id: mappedId }] : [];
      })],
      activity_zones: [...project.activity_zones, ...project.activity_zones.flatMap((row) => {
        const mappedId = activityIds.get(String(row.activity_id));
        return mappedId ? [{ ...row, activity_id: mappedId }] : [];
      })],
      dependencies: [...project.dependencies, ...copiedDependencies],
    },
  };
}
