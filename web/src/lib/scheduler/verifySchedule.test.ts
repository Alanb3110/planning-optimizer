import { describe, expect, it } from "vitest";
import { validateSolvedSchedule } from "./verifySchedule";
import type { ScheduleResult, SchedulingProject } from "./types";

const start = "2026-09-21T00:00:00Z"; // Monday, fictitious data.
const project: SchedulingProject = {
  metadata: { project_start: start, active_calendar: "WORK" },
  systems: [{ system_id: "S", arrival_date: "2026-09-21T08:00:00Z" }],
  packages: [{ package_id: "P", system_id: "S" }],
  activities: [
    { activity_id: "A", package_id: "P", duration_h: 2, duration_basis: "WORK_TIME", preemptible: false },
    { activity_id: "B", package_id: "P", duration_h: 2, duration_basis: "WORK_TIME", preemptible: false },
  ],
  gates: [{ gate_id: "X", gate_type: "READY" }, { gate_id: "DONE", gate_type: "PROJECT_COMPLETE" }],
  dependencies: [
    { dependency_id: "AX", source_type: "ACTIVITY", source_id: "A", target_type: "GATE", target_id: "X", lag_h: 0, enabled: true },
    { dependency_id: "BD", source_type: "ACTIVITY", source_id: "B", target_type: "GATE", target_id: "DONE", lag_h: 0, enabled: true },
    { dependency_id: "XD", source_type: "GATE", source_id: "X", target_type: "GATE", target_id: "DONE", lag_h: 0, enabled: true },
  ],
  resources: [{ resource_id: "R", capacity: 2, unlimited: false }],
  activity_resources: [{ activity_id: "A", resource_id: "R", quantity: 1 }, { activity_id: "B", resource_id: "R", quantity: 1 }],
  resource_substitutions: [],
  zones: [{ zone_id: "Z", capacity: 2 }],
  activity_zones: [{ activity_id: "A", zone_id: "Z", load: 1, exclusive: false }, { activity_id: "B", zone_id: "Z", load: 1, exclusive: false }],
  calendars: [
    { calendar_id: "WORK", timezone: "UTC" },
    { calendar_id: "LATE", timezone: "UTC" },
  ],
  calendar_shifts: [
    { calendar_id: "WORK", weekday: "MON", start_time: "07:00", end_time: "12:00", enabled: true },
    { calendar_id: "LATE", weekday: "MON", start_time: "10:00", end_time: "12:00", enabled: true },
  ],
  milestone_priorities: [{ gate_id: "DONE", priority: 1, enabled: true }],
};
const result: ScheduleResult = {
  activities: {
    A: { activityId: "A", startH: 8, endH: 10, workSlots: [8, 9], segments: [[8, 10]] },
    B: { activityId: "B", startH: 8, endH: 10, workSlots: [8, 9], segments: [[8, 10]] },
  },
  gates: { X: 10, DONE: 14 }, projectStart: start,
  objectiveGate: "DONE", objectiveH: 14, horizonH: 24, optimal: true, solverMessage: "fictitious",
};

type Mutate = (p: SchedulingProject, r: ScheduleResult) => void;
function check(mutate: Mutate): string[] {
  const p = structuredClone(project);
  const r = structuredClone(result);
  mutate(p, r);
  return validateSolvedSchedule(p, r);
}
function slots(r: ScheduleResult, id: "A" | "B", values: number[], segments: Array<[number, number]>) {
  r.activities[id] = { activityId: id, startH: values[0], endH: values.at(-1)! + 1, workSlots: values, segments };
}

describe("independent extracted-schedule verification", () => {
  it("accepts a valid timetable and a legitimate early enabler", () => {
    expect(check(() => {})).toEqual([]);
    expect(check((p, r) => { p.activities[0].requires_system_arrival = false; p.metadata.active_calendar = undefined; slots(r, "A", [6, 7], [[6, 8]]); })).toEqual([]);
  });

  const cases: Array<[string, Mutate, RegExp]> = [
    ["missing enabled Activity", (_p, r) => { delete r.activities.B; }, /Activity B is missing/],
    ["extra inactive Activity", (_p, r) => { r.activities.EXTRA = { ...r.activities.A, activityId: "EXTRA" }; }, /Unexpected or inactive Activity EXTRA/],
    ["System arrival", (_p, r) => { slots(r, "B", [7, 8], [[7, 9]]); }, /before System S arrival/],
    ["activity calendar", (p) => { p.activities[0].calendar_id = "LATE"; }, /outside Calendar LATE/],
    ["resource calendar", (p) => { p.resources[0].calendar_id = "LATE"; }, /outside Calendar LATE/],
    ["zone calendar", (p) => { p.zones[0].calendar_id = "LATE"; }, /outside Calendar LATE/],
    ["WORK_TIME hours", (p) => { p.activities[0].duration_h = 3; }, /scheduled 2 h, expected 3 h/],
    ["ELAPSED_TIME hours", (p) => { p.activities[0].duration_basis = "ELAPSED_TIME"; p.activities[0].duration_h = 3; }, /scheduled 2 h, expected 3 h/],
    ["non-preemptible continuity", (_p, r) => { slots(r, "B", [8, 10], [[8, 9], [10, 11]]); }, /non-preemptible work is split/],
    ["elapsed continuity", (p, r) => { p.activities[1].duration_basis = "ELAPSED_TIME"; slots(r, "B", [8, 10], [[8, 9], [10, 11]]); }, /ELAPSED_TIME must advance continuously/],
    ["resource demand and capacity", (p) => { p.activity_resources[0].quantity = 2; }, /Resource R: H\+8 uses 3 \/ 2/],
    ["zone demand and capacity", (p) => { p.activity_zones[0].load = 2; }, /Zone Z: H\+8 uses 3 \/ 2/],
    ["zone exclusivity", (p) => { p.activity_zones[0].exclusive = true; }, /Zone Z: H\+8 uses 3 \/ 2/],
    ["zone ALL reservation", (p) => { p.activity_zones[0].load = "ALL"; p.activity_zones[0].exclusive = true; }, /Zone Z: H\+8 uses 3 \/ 2/],
    ["Activity-to-Gate FS lag", (p) => { p.dependencies[0].lag_h = 1; }, /Dependency AX: FS lag violated/],
    ["Gate-to-Gate FS lag", (p) => { p.dependencies[2].lag_h = 5; }, /Dependency XD: FS lag violated/],
    ["Activity-to-Activity FS lag", (p, r) => {
      slots(r, "B", [10, 11], [[10, 12]]);
      p.dependencies.push({ dependency_id: "AB", source_type: "ACTIVITY", source_id: "A", target_type: "ACTIVITY", target_id: "B", lag_h: 1, enabled: true });
    }, /Dependency AB: FS lag violated/],
    ["Gate-to-Activity FS lag", (p, r) => {
      slots(r, "B", [10, 11], [[10, 12]]);
      p.dependencies.push({ dependency_id: "XB", source_type: "GATE", source_id: "X", target_type: "ACTIVITY", target_id: "B", lag_h: 1, enabled: true });
    }, /Dependency XB: FS lag violated/],
    ["Gate time", (_p, r) => { r.gates.X = 10.5; }, /Gate X: time is not an integer hour/],
    ["missing Gate", (_p, r) => { delete r.gates.X; }, /Gate X is missing/],
    ["completion objective", (_p, r) => { r.objectiveH = 13; }, /PROJECT_COMPLETE DONE: objective Gate\/time disagree/],
    ["completion priority", (p) => { p.milestone_priorities[0].enabled = false; }, /PROJECT_COMPLETE DONE: enabled milestone priority is missing/],
    ["completion after all work", (p, r) => {
      p.activities.push({ activity_id: "C", package_id: "P", duration_h: 2, duration_basis: "ELAPSED_TIME", preemptible: false });
      r.activities.C = { activityId: "C", startH: 14, endH: 16, workSlots: [14, 15], segments: [[14, 16]] };
    }, /PROJECT_COMPLETE DONE: Activity C ends after completion/],
  ];
  it.each(cases)("rejects %s", (_name, mutate, expected) => {
    expect(check(mutate)).toEqual(expect.arrayContaining([expect.stringMatching(expected)]));
  });

  it("reserves capacity for the full ELAPSED_TIME duration outside shifts", () => {
    expect(check((p, r) => {
      p.activities[0].duration_basis = "ELAPSED_TIME";
      p.activities[0].duration_h = 6;
      slots(r, "A", [8, 9, 10, 11, 12, 13], [[8, 14]]);
      r.gates.X = 14;
    })).toEqual([]);
  });
  it("allows preemptible work to resume after a calendar gap but rejects skipping an available slot", () => {
    expect(check((p, r) => {
      p.activities[0].preemptible = true;
      p.activities[0].calendar_id = "GAP";
      p.calendars.push({ calendar_id: "GAP", timezone: "UTC" });
      p.calendar_shifts.push(
        { calendar_id: "GAP", weekday: "MON", start_time: "08:00", end_time: "09:00", enabled: true },
        { calendar_id: "GAP", weekday: "MON", start_time: "10:00", end_time: "11:00", enabled: true },
      );
      slots(r, "A", [8, 10], [[8, 9], [10, 11]]);
      r.gates.X = 11;
    })).toEqual([]);
    expect(check((p, r) => {
      p.activities[0].preemptible = true;
      slots(r, "A", [8, 10], [[8, 9], [10, 11]]);
      r.gates.X = 11;
    })).toContain("Activity A: preemptible work skips available H+9.");
  });
  it("detects duplicated slots and mismatched extracted segments independently", () => {
    expect(check((_p, r) => { r.activities.B.workSlots = [8, 8]; })).toContain("Activity B: work slots must be strictly increasing without duplicates.");
    expect(check((_p, r) => { r.activities.B.segments = [[8, 9]]; })).toContain("Activity B: segments disagree with occupied slots.");
  });
});
