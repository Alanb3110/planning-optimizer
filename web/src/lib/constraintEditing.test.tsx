import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import loadHighs from "highs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConstraintEditor } from "../components/ConstraintEditor";
import type { NormalizedProject } from "./model";
import { solveScheduleWithHighs } from "./scheduler/highsSolver";
import { asSchedulingProject } from "./scheduler/types";
import { validateProject } from "./validation";
import { importWorkbook } from "./workbookImport";
import { createWorkbookRevision } from "./workbookRevision";

const fixture = resolve(process.cwd(), "public/synthetic_project.xlsx");

function fictionalTrials(base: NormalizedProject, exclusive = false): NormalizedProject {
  const start = "2030-01-01T00:00:00Z";
  const activities = ["TEST_A", "TEST_B"].map((id) => ({ activity_id: id, package_id: "TEST_PKG", name: id,
    duration_h: 2, duration_basis: "WORK_TIME", preemptible: false, enabled: true, requires_system_arrival: true,
    calendar_id: "TEST_CAL" }));
  return { ...base,
    metadata: { ...base.metadata, project_start: start, active_calendar: "TEST_CAL", objective_gate: "PROJECT_COMPLETE" },
    systems: [{ system_id: "TEST_SYSTEM", name: "Fictional system", family: "TEST", arrival_date: start, enabled: true }],
    packages: [{ package_id: "TEST_PKG", system_id: "TEST_SYSTEM", name: "Fictional low-pressure trials", enabled: true }],
    activities,
    gates: [{ gate_id: "PROJECT_COMPLETE", name: "Complete", gate_type: "PROJECT_COMPLETE", exposed: true }],
    dependencies: activities.map((row) => ({ dependency_id: `END_${row.activity_id}`, source_type: "ACTIVITY",
      source_id: row.activity_id, target_type: "GATE", target_id: "PROJECT_COMPLETE", relation: "FS", lag_h: 0, enabled: true })),
    resources: [{ resource_id: "OPERATORS", name: "Qualified operators", type: "HUMAN", capacity: 2, unlimited: false }],
    activity_resources: activities.map((row) => ({ activity_id: row.activity_id, resource_id: "OPERATORS", quantity: 1 })),
    resource_substitutions: [],
    zones: [{ zone_id: "LOW_PRESSURE", name: "Low pressure area", capacity: 2 }],
    activity_zones: activities.map((row) => ({ activity_id: row.activity_id, zone_id: "LOW_PRESSURE",
      load: exclusive && row.activity_id === "TEST_A" ? "ALL" : 1, exclusive: exclusive && row.activity_id === "TEST_A" })),
    calendars: [{ calendar_id: "TEST_CAL", name: "Test window", timezone: "Etc/UTC", weekend_days: ["SAT", "SUN"] }],
    calendar_shifts: ["TUE", "WED", "THU"].map((weekday) => ({ calendar_id: "TEST_CAL", weekday,
      shift_name: "Day", start_time: "00:00", end_time: "08:00", enabled: true })),
    milestone_priorities: [{ gate_id: "PROJECT_COMPLETE", priority: 1, enabled: true }],
  };
}

describe("fictional low-pressure capacity and editor", () => {
  it("shares the area while reserving two operators; exclusive work occupies the whole zone", async () => {
    const imported = await importWorkbook(new Uint8Array(await readFile(fixture)));
    const highs = await loadHighs();
    const shared = fictionalTrials(imported.data);
    const exclusive = fictionalTrials(imported.data, true);
    expect(validateProject(shared).filter((issue) => issue.severity === "error")).toEqual([]);
    expect(validateProject(exclusive).filter((issue) => issue.severity === "error")).toEqual([]);
    const first = solveScheduleWithHighs(highs, asSchedulingProject(shared), { horizonDays: 2, timeLimitS: 20 });
    expect(first.activities.TEST_A.workSlots).toEqual(first.activities.TEST_B.workSlots);
    const second = solveScheduleWithHighs(highs, asSchedulingProject(exclusive), { horizonDays: 2, timeLimitS: 20 });
    expect(second.activities.TEST_A.workSlots.some((slot) => second.activities.TEST_B.workSlots.includes(slot))).toBe(false);
  }, 60_000);

  it("previews invalid changes before saving and exports edited tables for reimport", async () => {
    const source = new Uint8Array(await readFile(fixture));
    const imported = await importWorkbook(source);
    const project = fictionalTrials(imported.data, true);
    const save = (next: NormalizedProject) => { expect(next.zones[0].capacity).toBe(0); };
    render(<ConstraintEditor project={project} activityId="TEST_A" onChange={save} disabled={false} />);
    fireEvent.change(screen.getByLabelText("Constraint table"), { target: { value: "zones" } });
    fireEvent.click(screen.getByRole("button", { name: /Edit LOW_PRESSURE/ }));
    const form = screen.getByLabelText("Edit Zones and capacities");
    fireEvent.change(within(form).getByLabelText("Capacity"), { target: { value: "0" } });
    expect(within(form).getByRole("status").textContent).toMatch(/calculation blocked/);
    expect(within(form).getByRole("status").textContent).toMatch(/1 new/);
    fireEvent.click(within(form).getByRole("button", { name: "Save change" }));

    const edited = { ...imported.data,
      resources: [...imported.data.resources, { resource_id: "TRIAL_CREW", name: "Qualified operators", type: "HUMAN", capacity: 2, unlimited: false, calendar_id: "TRIAL_CAL" }],
      zones: [...imported.data.zones, { zone_id: "TRIAL_AREA", name: "Fictional trial area", capacity: 2, calendar_id: "TRIAL_CAL" }],
      calendars: [...imported.data.calendars, { calendar_id: "TRIAL_CAL", name: "Fictional local shifts", timezone: "Etc/UTC", weekend_days: ["SAT", "SUN"] }],
      calendar_shifts: [...imported.data.calendar_shifts, { calendar_id: "TRIAL_CAL", weekday: "TUE", shift_name: "Day", start_time: "08:00", end_time: "16:00", enabled: true }],
      activity_resources: [...imported.data.activity_resources, { activity_id: String(imported.data.activities[0].activity_id), resource_id: "TRIAL_CREW", quantity: 1 }],
      activity_zones: [...imported.data.activity_zones, { activity_id: String(imported.data.activities[0].activity_id), zone_id: "TRIAL_AREA", load: "ALL", exclusive: true }],
    };
    expect(validateProject(edited).filter((issue) => issue.severity === "error")).toEqual([]);
    const revision = await createWorkbookRevision(source, edited, "Fictional constraints", new Date("2030-02-03T04:05:06Z"));
    expect(revision.reimport.isValid).toBe(true);
    for (const key of ["resources", "activity_resources", "zones", "activity_zones", "calendars", "calendar_shifts"] as const) {
      expect(revision.reimport.data[key]).toEqual(edited[key]);
    }
    expect(revision.reimport.data.activity_zones.at(-1)).toMatchObject({ load: "ALL", exclusive: true });
    expect(revision.reimport.data.calendars.at(-1)?.weekend_days).toEqual(["SAT", "SUN"]);
    expect(validateProject({ ...project, activity_zones: [{ ...project.activity_zones[0], exclusive: false }] }).map((issue) => issue.code))
      .toContain("ALL_REQUIRES_EXCLUSIVE");
  });
});
