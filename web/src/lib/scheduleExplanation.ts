import { buildCalendarSlots, hourOffset } from "./scheduler/calendar";
import type { ScheduleResult, SchedulingProject } from "./scheduler/types";

export interface ConstraintEvidence {
  id: string;
  sourceType: "ACTIVITY" | "GATE";
  sourceId: string;
  sourceH: number;
  lagH: number;
  requiredH: number;
  binding: boolean;
}
export interface OccupancyEvidence {
  kind: "Resource" | "Zone";
  id: string;
  slotH: number;
  occupants: string[];
  used: number;
  demand: number;
  capacity: number;
}
export interface ActivityExplanation {
  activityId: string;
  startH: number;
  releaseH: number;
  predecessors: ConstraintEvidence[];
  arrival: Pick<ConstraintEvidence, "id" | "requiredH" | "binding"> | null;
  calendarIds: string[];
  calendarEarliestH: number | null;
  calendarLimited: boolean;
  earlierProfiles: number;
  earlierProfileFitsFixedSchedule: boolean;
  occupancy: OccupancyEvidence[];
  downstreamGates: Array<{ gateId: string; atH: number; direct: boolean; binding: boolean }>;
}

// This inspects the recorded solution. It does not rerun the optimizer or claim counterfactual causality.
export function explainActivity(project: SchedulingProject, result: ScheduleResult, activityId: string): ActivityExplanation {
  const activity = project.activities.find((row) => row.activity_id === activityId);
  const scheduled = result.activities[activityId];
  if (!activity || !scheduled) throw new Error(`Unknown scheduled Activity ${activityId}.`);
  const packageItem = project.packages.find((row) => row.package_id === activity.package_id)!;
  const system = project.systems.find((row) => row.system_id === packageItem.system_id)!;
  const arrivalH = Math.max(0, hourOffset(result.projectStart, system.arrival_date));
  const arrival = activity.requires_system_arrival === false ? null : {
    id: system.system_id, requiredH: arrivalH, binding: arrivalH === scheduled.startH,
  };
  const incoming = project.dependencies.filter((row) => row.enabled === true && row.target_type === "ACTIVITY" && row.target_id === activityId);
  const predecessors = incoming.map((row) => {
    const sourceH = row.source_type === "GATE" ? result.gates[row.source_id] : result.activities[row.source_id]?.endH;
    if (sourceH === undefined) return null;
    const lagH = Number(row.lag_h ?? 0);
    const requiredH = sourceH + lagH;
    return { id: row.dependency_id, sourceType: row.source_type, sourceId: row.source_id, sourceH, lagH, requiredH, binding: requiredH === scheduled.startH };
  }).filter((value): value is ConstraintEvidence => value !== null);
  const releaseH = Math.max(0, arrival?.requiredH ?? 0, ...predecessors.map((row) => row.requiredH));

  const resources = project.activity_resources.filter((row) => row.activity_id === activityId);
  const zones = project.activity_zones.filter((row) => row.activity_id === activityId);
  const calendarIds = [...new Set([
    activity.calendar_id || project.metadata.active_calendar,
    ...resources.map((row) => project.resources.find((r) => r.resource_id === row.resource_id)?.calendar_id),
    ...zones.map((row) => project.zones.find((z) => z.zone_id === row.zone_id)?.calendar_id),
  ].filter((id): id is string => Boolean(id)))];
  const calendarSlots = activity.duration_basis === "WORK_TIME" ? buildCalendarSlots(project, result.horizonH) : {};
  const available = (slot: number) => slot < result.horizonH && calendarIds.every((id) => calendarSlots[id]?.[slot]);
  const duration = Number(activity.duration_h);
  const eligible = activity.duration_basis === "WORK_TIME" && activity.preemptible
    ? Array.from({ length: result.horizonH }, (_, slot) => slot).filter(available) : [];
  const eligibleIndex = new Map(eligible.map((slot, index) => [slot, index]));
  const profile = (start: number): number[] | null => {
    if (start < 0 || start + duration > result.horizonH) return null;
    if (activity.duration_basis === "ELAPSED_TIME") return Array.from({ length: duration }, (_, offset) => start + offset);
    if (activity.preemptible) {
      if (!available(start)) return null;
      const index = eligibleIndex.get(start);
      return index !== undefined && index + duration <= eligible.length ? eligible.slice(index, index + duration) : null;
    }
    const slots = Array.from({ length: duration }, (_, offset) => start + offset);
    return slots.every(available) ? slots : null;
  };

  let calendarEarliestH: number | null = null;
  let earlierProfiles = 0;
  let earlierProfileFitsFixedSchedule = false;
  const conflicts = new Map<string, OccupancyEvidence>();
  const usageCache = new Map<string, Map<number, Array<{ id: string; used: number }>>>();
  const occupantsAt = (kind: "Resource" | "Zone", id: string, capacity: number, slot: number) => {
    const key = `${kind}:${id}`;
    if (!usageCache.has(key)) {
      const bySlot = new Map<number, Array<{ id: string; used: number }>>();
      for (const other of Object.values(result.activities)) {
        if (other.activityId === activityId) continue;
        const demand = kind === "Resource"
          ? project.activity_resources.find((row) => row.activity_id === other.activityId && row.resource_id === id)
          : project.activity_zones.find((row) => row.activity_id === other.activityId && row.zone_id === id);
        if (!demand) continue;
        const used = kind === "Resource" ? Number(demand.quantity)
          : (demand.exclusive || demand.load === "ALL" ? capacity : Number(demand.load));
        for (const hour of other.workSlots) bySlot.set(hour, [...(bySlot.get(hour) ?? []), { id: other.activityId, used }]);
      }
      usageCache.set(key, bySlot);
    }
    return usageCache.get(key)!.get(slot) ?? [];
  };
  for (let start = releaseH; start <= scheduled.startH; start++) {
    const slots = profile(start);
    if (!slots) continue;
    calendarEarliestH ??= start;
    if (start === scheduled.startH) break;
    earlierProfiles++;
    let blocked = false;
    for (const [kind, demands] of [["Resource", resources], ["Zone", zones]] as const) {
      for (const demand of demands) {
        const id = String(kind === "Resource" ? demand.resource_id : demand.zone_id);
        const record = kind === "Resource"
          ? project.resources.find((row) => row.resource_id === id)
          : project.zones.find((row) => row.zone_id === id);
        if (!record || (kind === "Resource" && "unlimited" in record && record.unlimited)) continue;
        const capacity = Number(record.capacity);
        const load = kind === "Resource" ? Number(demand.quantity)
          : (demand.exclusive || demand.load === "ALL" ? capacity : Number(demand.load));
        for (const slotH of slots) {
          const occupants = occupantsAt(kind, id, capacity, slotH);
          const used = occupants.reduce((sum, row) => sum + row.used, 0);
          if (used + load > capacity) {
            blocked = true;
            const key = `${kind}:${id}`;
            if (!conflicts.has(key)) conflicts.set(key, {
              kind, id, slotH, occupants: occupants.map((row) => row.id), used, demand: load, capacity,
            });
          }
        }
      }
    }
    if (!blocked) earlierProfileFitsFixedSchedule = true;
  }

  const downstreamGates: ActivityExplanation["downstreamGates"] = [];
  const seen = new Set<string>();
  const visit = (type: "ACTIVITY" | "GATE", id: string, direct: boolean) => {
    const key = `${type}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const dependency of project.dependencies.filter((row) => row.enabled === true && row.source_type === type && row.source_id === id)) {
      const targetH = dependency.target_type === "GATE" ? result.gates[dependency.target_id] : result.activities[dependency.target_id]?.startH;
      if (targetH === undefined) continue;
      const sourceH = type === "GATE" ? result.gates[id] : result.activities[id]?.endH;
      if (dependency.target_type === "GATE") downstreamGates.push({
        gateId: dependency.target_id, atH: targetH, direct,
        binding: direct && sourceH !== undefined && sourceH + Number(dependency.lag_h ?? 0) === targetH,
      });
      visit(dependency.target_type, dependency.target_id, false);
    }
  };
  visit("ACTIVITY", activityId, true);
  return {
    activityId, startH: scheduled.startH, releaseH, predecessors, arrival, calendarIds, calendarEarliestH,
    calendarLimited: calendarEarliestH !== null && calendarEarliestH > releaseH,
    earlierProfiles, earlierProfileFitsFixedSchedule, occupancy: [...conflicts.values()],
    downstreamGates: downstreamGates.sort((a, b) => a.atH - b.atH || a.gateId.localeCompare(b.gateId)),
  };
}
