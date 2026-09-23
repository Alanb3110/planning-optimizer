import { describe, expect, it } from "vitest";
import { explainActivity } from "./scheduleExplanation";
import type { ScheduleResult, SchedulingProject } from "./scheduler/types";

const project: SchedulingProject = {
  metadata: { project_start: "2027-01-04T00:00:00Z", active_calendar: "DAY" },
  systems: [{ system_id: "SYS", arrival_date: "2027-01-04T07:00:00Z" }],
  packages: [{ package_id: "P", system_id: "SYS" }],
  activities: [
    { activity_id: "PRE", package_id: "P", duration_h: 1, duration_basis: "ELAPSED_TIME", preemptible: false, requires_system_arrival: false },
    { activity_id: "OTHER", package_id: "P", duration_h: 1, duration_basis: "ELAPSED_TIME", preemptible: false, requires_system_arrival: false },
    { activity_id: "JOB", package_id: "P", duration_h: 1, duration_basis: "WORK_TIME", preemptible: false },
    { activity_id: "LATER", package_id: "P", duration_h: 1, duration_basis: "ELAPSED_TIME", preemptible: false },
  ],
  gates: [{ gate_id: "FIRST", gate_type: "PACKAGE_COMPLETE" }, { gate_id: "DONE", gate_type: "PROJECT_COMPLETE" }],
  dependencies: [
    { dependency_id: "D_PRE", source_type: "ACTIVITY", source_id: "PRE", target_type: "ACTIVITY", target_id: "JOB", lag_h: 2, enabled: true },
    { dependency_id: "D_FIRST", source_type: "ACTIVITY", source_id: "JOB", target_type: "GATE", target_id: "FIRST", lag_h: 0, enabled: true },
    { dependency_id: "D_LATER", source_type: "GATE", source_id: "FIRST", target_type: "ACTIVITY", target_id: "LATER", lag_h: 0, enabled: true },
    { dependency_id: "D_DONE", source_type: "ACTIVITY", source_id: "LATER", target_type: "GATE", target_id: "DONE", lag_h: 0, enabled: true },
  ],
  resources: [{ resource_id: "CREW", capacity: 1, unlimited: false }],
  activity_resources: [{ activity_id: "JOB", resource_id: "CREW", quantity: 1 }, { activity_id: "OTHER", resource_id: "CREW", quantity: 1 }],
  resource_substitutions: [],
  zones: [{ zone_id: "PAD", capacity: 1 }],
  activity_zones: [{ activity_id: "JOB", zone_id: "PAD", load: "ALL" }, { activity_id: "OTHER", zone_id: "PAD", load: 1 }],
  calendars: [{ calendar_id: "DAY", timezone: "UTC" }],
  calendar_shifts: [{ calendar_id: "DAY", weekday: "MON", start_time: "08:00", end_time: "12:00", enabled: true }],
  milestone_priorities: [],
};
const scheduled = (activityId: string, startH: number) => ({ activityId, startH, endH: startH + 1, workSlots: [startH], segments: [[startH, startH + 1] as [number, number]] });
const result: ScheduleResult = {
  projectStart: project.metadata.project_start, objectiveGate: "DONE", objectiveH: 12, horizonH: 24,
  optimal: true, solverMessage: "Fictitious",
  activities: { PRE: scheduled("PRE", 5), OTHER: scheduled("OTHER", 8), JOB: scheduled("JOB", 9), LATER: scheduled("LATER", 11) },
  gates: { FIRST: 10, DONE: 12 },
};

describe("recorded schedule explanation", () => {
  it("separates elapsed lag and arrival bounds, calendar window, conditional occupancy and downstream gates", () => {
    const explanation = explainActivity(project, result, "JOB");
    expect(explanation.predecessors).toEqual([{ id: "D_PRE", sourceType: "ACTIVITY", sourceId: "PRE", sourceH: 6, lagH: 2, requiredH: 8, binding: false }]);
    expect(explanation.arrival).toEqual({ id: "SYS", requiredH: 7, binding: false });
    expect(explanation.releaseH).toBe(8);
    expect(explanation.calendarEarliestH).toBe(8);
    expect(explanation.calendarLimited).toBe(false);
    expect(explanation.earlierProfiles).toBe(1);
    expect(explanation.earlierProfileFitsFixedSchedule).toBe(false);
    expect(explanation.occupancy).toEqual([
      { kind: "Resource", id: "CREW", slotH: 8, occupants: ["OTHER"], used: 1, demand: 1, capacity: 1 },
      { kind: "Zone", id: "PAD", slotH: 8, occupants: ["OTHER"], used: 1, demand: 1, capacity: 1 },
    ]);
    expect(explanation.downstreamGates).toEqual([
      { gateId: "FIRST", atH: 10, direct: true, binding: true },
      { gateId: "DONE", atH: 12, direct: false, binding: false },
    ]);
  });

  it("identifies a calendar bound without attributing unexplained slack to capacity", () => {
    const copy = structuredClone(project);
    copy.dependencies[0].lag_h = 1; // PRE finishes at H+6; release is arrival H+7
    const later = structuredClone(result);
    later.activities.OTHER = scheduled("OTHER", 10);
    later.activities.JOB = scheduled("JOB", 9);
    const explanation = explainActivity(copy, later, "JOB");
    expect(explanation.releaseH).toBe(7);
    expect(explanation.calendarEarliestH).toBe(8);
    expect(explanation.calendarLimited).toBe(true);
    expect(explanation.earlierProfileFitsFixedSchedule).toBe(true);
    expect(explanation.occupancy).toEqual([]);
  });

  it("reports a binding arrival or lag only when it equals the actual start", () => {
    const arrival = structuredClone(project);
    arrival.systems[0].arrival_date = "2027-01-04T09:00:00Z";
    expect(explainActivity(arrival, result, "JOB").arrival?.binding).toBe(true);
    const lag = structuredClone(project);
    lag.dependencies[0].lag_h = 3;
    expect(explainActivity(lag, result, "JOB").predecessors[0]).toMatchObject({ requiredH: 9, binding: true });
  });
});
