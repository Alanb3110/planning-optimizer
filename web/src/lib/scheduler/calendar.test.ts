import { describe, expect, it } from "vitest";
import loadHighs from "highs";
import { buildCalendarSlots, hourOffset } from "./calendar";
import { solveScheduleWithHighs } from "./highsSolver";
import { buildScheduleMilp } from "./milp";
import type { SchedulingProject, SchedulingShift } from "./types";

function project(start: string, shifts: SchedulingShift[]): SchedulingProject {
  return {
    metadata: { project_start: start, active_calendar: "WORK" },
    systems: [{ system_id: "S", arrival_date: start }],
    packages: [{ package_id: "P", system_id: "S" }],
    activities: [{ activity_id: "A", package_id: "P", duration_h: 1, duration_basis: "WORK_TIME", preemptible: false }],
    gates: [{ gate_id: "DONE", gate_type: "PROJECT_COMPLETE" }],
    dependencies: [{ dependency_id: "A_DONE", source_type: "ACTIVITY", source_id: "A", target_type: "GATE", target_id: "DONE", relation: "FS", lag_h: 0, enabled: true }],
    resources: [{ resource_id: "R", capacity: 1, unlimited: false, calendar_id: "CREW" }],
    activity_resources: [{ activity_id: "A", resource_id: "R", quantity: 1 }], resource_substitutions: [],
    zones: [{ zone_id: "Z", capacity: 1, calendar_id: "AREA" }],
    activity_zones: [{ activity_id: "A", zone_id: "Z", load: 1 }],
    calendars: [
      { calendar_id: "WORK", timezone: "Europe/Paris" },
      { calendar_id: "CREW", timezone: "UTC" },
      { calendar_id: "AREA", timezone: "Asia/Tokyo" },
    ], calendar_shifts: shifts,
    milestone_priorities: [{ gate_id: "DONE", priority: 1, enabled: true }],
  };
}

function shift(calendar_id: string, weekday: SchedulingShift["weekday"], start_time: string, end_time: string): SchedulingShift {
  return { calendar_id, weekday, start_time, end_time, enabled: true };
}

function hours(start: string, flags: boolean[]): string[] {
  const origin = Date.parse(start);
  return flags.flatMap((yes, h) => yes ? [new Date(origin + h * 3_600_000).toISOString()] : []);
}

describe("calendar local time to absolute hourly slots", () => {
  it("uses each calendar's zone and intersects activity, resource and zone windows", async () => {
    const start = "2026-03-29T00:00:00Z";
    const data = project(start, [
      shift("WORK", "SUN", "01:00", "05:00"),
      shift("CREW", "SUN", "01:00", "04:00"),
      shift("AREA", "SUN", "10:00", "12:00"),
    ]);
    const slots = buildCalendarSlots(data, 6);
    expect(hours(start, slots.WORK)).toEqual(["2026-03-29T00:00:00.000Z", "2026-03-29T01:00:00.000Z", "2026-03-29T02:00:00.000Z"]);
    expect(hours(start, slots.CREW)).toEqual(["2026-03-29T01:00:00.000Z", "2026-03-29T02:00:00.000Z", "2026-03-29T03:00:00.000Z"]);
    expect(hours(start, slots.AREA)).toEqual(["2026-03-29T01:00:00.000Z", "2026-03-29T02:00:00.000Z"]);
    expect(buildScheduleMilp(data, { horizonDays: 1 }).executionChoices.A.map((choice) => choice.slots)).toEqual([[1], [2]]);
    const highs = await loadHighs();
    expect(solveScheduleWithHighs(highs, data, { horizonDays: 1, timeLimitS: 10 }).activities.A.workSlots).toEqual([1]);
  }, 20_000);

  it("counts two real hours across the spring gap", () => {
    const start = "2026-03-29T00:00:00Z";
    const data = project(start, [shift("WORK", "SUN", "01:00", "04:00")]);
    expect(hours(start, buildCalendarSlots(data, 5).WORK)).toEqual([
      "2026-03-29T00:00:00.000Z", "2026-03-29T01:00:00.000Z",
    ]);
  });

  it("counts four real hours across the autumn repeated hour", () => {
    const start = "2026-10-24T23:00:00Z";
    const data = project(start, [shift("WORK", "SUN", "01:00", "04:00")]);
    expect(hours(start, buildCalendarSlots(data, 6).WORK)).toEqual([
      "2026-10-24T23:00:00.000Z", "2026-10-25T00:00:00.000Z",
      "2026-10-25T01:00:00.000Z", "2026-10-25T02:00:00.000Z",
    ]);
    expect(hourOffset("2026-10-25T01:00:00+02:00", "2026-10-25T02:00:00+01:00")).toBe(2);
  });

  it("extends a shift past local midnight, even on its final valid date", () => {
    const start = "2026-03-28T20:00:00Z";
    const data = project(start, [shift("WORK", "SAT", "22:00", "04:00")]);
    data.calendars[0].valid_from = "2026-03-28";
    data.calendars[0].valid_to = "2026-03-28";
    expect(hours(start, buildCalendarSlots(data, 9).WORK)).toEqual([
      "2026-03-28T21:00:00.000Z", "2026-03-28T22:00:00.000Z",
      "2026-03-28T23:00:00.000Z", "2026-03-29T00:00:00.000Z",
      "2026-03-29T01:00:00.000Z",
    ]);
  });

  it("preserves fixed-offset Asia/Muscat scheduling and a project start before DST", () => {
    const muscatStart = "2026-03-29T00:00:00+04:00";
    const muscat = project(muscatStart, [shift("WORK", "SUN", "08:00", "16:00")]);
    muscat.calendars[0].timezone = "Asia/Muscat";
    expect(hours(muscatStart, buildCalendarSlots(muscat, 24).WORK)).toEqual([
      "2026-03-29T04:00:00.000Z", "2026-03-29T05:00:00.000Z",
      "2026-03-29T06:00:00.000Z", "2026-03-29T07:00:00.000Z",
      "2026-03-29T08:00:00.000Z", "2026-03-29T09:00:00.000Z",
      "2026-03-29T10:00:00.000Z", "2026-03-29T11:00:00.000Z",
    ]);
    const parisStart = "2026-03-29T00:00:00+01:00";
    const paris = project(parisStart, [shift("WORK", "SUN", "01:00", "04:00")]);
    expect(hours(parisStart, buildCalendarSlots(paris, 6).WORK)).toEqual([
      "2026-03-29T00:00:00.000Z", "2026-03-29T01:00:00.000Z",
    ]);
  });
});
