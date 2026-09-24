import { buildCalendarSlots, hourOffset, segmentsFromSlots } from "./calendar";
import type { ScheduleResult, SchedulingProject } from "./types";

// Checks the extracted timetable, without inspecting MILP variables or selected profiles.
export function validateSolvedSchedule(project: SchedulingProject, result: ScheduleResult): string[] {
  const errors: string[] = [];
  const validHour = (value: number) => Number.isInteger(value) && value >= 0 && value <= result.horizonH;
  const systems = new Map(project.systems.filter((row) => row.enabled !== false).map((row) => [row.system_id, row]));
  const packages = new Map(project.packages.filter((row) => row.enabled !== false && systems.has(row.system_id)).map((row) => [row.package_id, row]));
  const activities = new Map(project.activities.filter((row) => row.enabled !== false && packages.has(row.package_id)).map((row) => [row.activity_id, row]));
  const gates = new Map(project.gates.filter((row) => (!row.system_id || systems.has(row.system_id)) && (!row.package_id || packages.has(row.package_id))).map((row) => [row.gate_id, row]));
  const resources = new Map(project.resources.map((row) => [row.resource_id, row]));
  const zones = new Map(project.zones.map((row) => [row.zone_id, row]));
  const resourceDemands = new Map<string, typeof project.activity_resources>();
  const zoneDemands = new Map<string, typeof project.activity_zones>();
  for (const demand of project.activity_resources) {
    const list = resourceDemands.get(demand.activity_id) ?? [];
    list.push(demand);
    resourceDemands.set(demand.activity_id, list);
  }
  for (const demand of project.activity_zones) {
    const list = zoneDemands.get(demand.activity_id) ?? [];
    list.push(demand);
    zoneDemands.set(demand.activity_id, list);
  }

  if (result.projectStart !== project.metadata.project_start) errors.push("Project start differs from the input model.");
  if (!Number.isInteger(result.horizonH) || result.horizonH <= 0) {
    errors.push("Planning horizon is not a positive integer hour count.");
    return errors;
  }
  const calendarSlots = buildCalendarSlots(project, result.horizonH);
  const resourceUsage = new Map<string, Map<number, number>>();
  const zoneUsage = new Map<string, Map<number, number>>();
  const addUsage = (usage: Map<string, Map<number, number>>, id: string, slot: number, quantity: number) => {
    const slots = usage.get(id) ?? new Map<number, number>();
    slots.set(slot, (slots.get(slot) ?? 0) + quantity);
    usage.set(id, slots);
  };

  for (const id of Object.keys(result.activities)) {
    if (!activities.has(id)) errors.push(`Unexpected or inactive Activity ${id} in schedule.`);
  }
  for (const [id, activity] of activities) {
    const scheduled = result.activities[id];
    if (!scheduled) { errors.push(`Activity ${id} is missing from schedule.`); continue; }
    const slots = scheduled.workSlots;
    if (scheduled.activityId !== id) errors.push(`Activity ${id}: mismatched activityId.`);
    if (slots.length !== activity.duration_h) errors.push(`Activity ${id}: scheduled ${slots.length} h, expected ${activity.duration_h} h.`);
    if (slots.length === 0 || slots.some((slot) => !Number.isInteger(slot) || slot < 0 || slot >= result.horizonH || slot + 1 > result.horizonH || !Number.isSafeInteger(slot))) {
      errors.push(`Activity ${id}: work slots are outside the hourly horizon.`);
      continue;
    }
    if (slots.some((slot, index) => index > 0 && slot <= slots[index - 1])) {
      errors.push(`Activity ${id}: work slots must be strictly increasing without duplicates.`);
      continue;
    }
    if (scheduled.startH !== slots[0] || scheduled.endH !== slots.at(-1)! + 1) {
      errors.push(`Activity ${id}: start/end disagree with occupied slots.`);
    }
    const segments = segmentsFromSlots(slots);
    if (JSON.stringify(scheduled.segments) !== JSON.stringify(segments)) errors.push(`Activity ${id}: segments disagree with occupied slots.`);
    if (activity.duration_basis === "ELAPSED_TIME" && segments.length !== 1) errors.push(`Activity ${id}: ELAPSED_TIME must advance continuously.`);
    if (activity.duration_basis === "WORK_TIME" && !activity.preemptible && segments.length !== 1) errors.push(`Activity ${id}: non-preemptible work is split.`);
    if (activity.requires_system_arrival !== false) {
      const system = systems.get(packages.get(activity.package_id)!.system_id)!;
      const release = Math.max(0, hourOffset(project.metadata.project_start, system.arrival_date));
      if (slots[0] < release) errors.push(`Activity ${id}: starts before System ${system.system_id} arrival at H+${release}.`);
    }
    if (activity.duration_basis === "WORK_TIME") {
      const calendars = [activity.calendar_id || project.metadata.active_calendar,
        ...(resourceDemands.get(id) ?? []).map((demand) => resources.get(demand.resource_id)?.calendar_id),
        ...(zoneDemands.get(id) ?? []).map((demand) => zones.get(demand.zone_id)?.calendar_id)].filter((value): value is string => !!value);
      if (activity.preemptible) {
        const occupied = new Set(slots);
        for (let slot = slots[0]; slot < slots.at(-1)!; slot++) {
          if (!occupied.has(slot) && calendars.every((calendarId) => calendarSlots[calendarId]?.[slot])) {
            errors.push(`Activity ${id}: preemptible work skips available H+${slot}.`);
          }
        }
      }
      for (const slot of slots) {
        for (const calendarId of calendars) {
          if (!calendarSlots[calendarId]?.[slot]) errors.push(`Activity ${id}: H+${slot} is outside Calendar ${calendarId}.`);
        }
      }
    }
    for (const demand of resourceDemands.get(id) ?? []) {
      const resource = resources.get(demand.resource_id);
      if (!resource) { errors.push(`Activity ${id}: unknown Resource ${demand.resource_id}.`); continue; }
      if (!resource.unlimited) for (const slot of slots) addUsage(resourceUsage, demand.resource_id, slot, Number(demand.quantity));
    }
    for (const demand of zoneDemands.get(id) ?? []) {
      const zone = zones.get(demand.zone_id);
      if (!zone) { errors.push(`Activity ${id}: unknown Zone ${demand.zone_id}.`); continue; }
      const load = demand.exclusive || demand.load === "ALL" ? Number(zone.capacity) : Number(demand.load);
      for (const slot of slots) addUsage(zoneUsage, demand.zone_id, slot, load);
    }
  }
  for (const [id, slots] of resourceUsage) {
    const capacity = resources.get(id)!.capacity;
    for (const [slot, used] of slots) if (used > capacity + 1e-9) errors.push(`Resource ${id}: H+${slot} uses ${used} / ${capacity}.`);
  }
  for (const [id, slots] of zoneUsage) {
    const capacity = zones.get(id)!.capacity;
    for (const [slot, used] of slots) if (used > capacity + 1e-9) errors.push(`Zone ${id}: H+${slot} uses ${used} / ${capacity} (including exclusive reservations).`);
  }

  for (const id of Object.keys(result.gates)) if (!gates.has(id)) errors.push(`Unexpected or inactive Gate ${id} in schedule.`);
  for (const id of gates.keys()) {
    if (result.gates[id] === undefined) errors.push(`Gate ${id} is missing from schedule.`);
    else if (!validHour(result.gates[id])) errors.push(`Gate ${id}: time is not an integer hour within the horizon.`);
  }
  for (const dependency of project.dependencies) {
    if (!dependency.enabled) continue;
    const source = dependency.source_type === "ACTIVITY" ? result.activities[dependency.source_id]?.endH : result.gates[dependency.source_id];
    const target = dependency.target_type === "ACTIVITY" ? result.activities[dependency.target_id]?.startH : result.gates[dependency.target_id];
    if (source === undefined || target === undefined) continue; // Missing nodes reported above.
    if (target < source + Number(dependency.lag_h ?? 0) - 1e-9) errors.push(`Dependency ${dependency.dependency_id}: FS lag violated.`);
  }
  const completion = [...gates.values()].filter((gate) => gate.gate_type === "PROJECT_COMPLETE");
  if (completion.length !== 1) errors.push("Exactly one active PROJECT_COMPLETE Gate is required.");
  else {
    const id = completion[0].gate_id;
    const end = result.gates[id];
    if (result.objectiveGate !== id || result.objectiveH !== end) errors.push(`PROJECT_COMPLETE ${id}: objective Gate/time disagree with schedule.`);
    if (!project.milestone_priorities.some((row) => row.enabled && row.gate_id === id)) errors.push(`PROJECT_COMPLETE ${id}: enabled milestone priority is missing.`);
    if (validHour(end)) {
      for (const [activityId, scheduled] of Object.entries(result.activities)) {
        if (activities.has(activityId) && scheduled.endH > end) errors.push(`PROJECT_COMPLETE ${id}: Activity ${activityId} ends after completion.`);
      }
      for (const [gateId, time] of Object.entries(result.gates)) {
        if (gates.has(gateId) && time > end) errors.push(`PROJECT_COMPLETE ${id}: Gate ${gateId} occurs after completion.`);
      }
    }
  }
  return errors;
}
