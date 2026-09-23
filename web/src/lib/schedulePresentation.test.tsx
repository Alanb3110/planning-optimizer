import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ScheduleResults } from "../components/ScheduleResults";
import { createScheduleBundle } from "./exports";
import { calendarTicks, localIso } from "./schedulePresentation";
import type { WorkbookImportResult } from "./model";
import type { ScheduleResult, SchedulingProject } from "./scheduler/types";

const project: SchedulingProject = {
  metadata: { project_id: "FICTIONAL", revision_id: "TEST", project_start: "2027-01-03T00:00:00+04:00", active_calendar: "LOCAL" },
  systems: [{ system_id: "SYS", arrival_date: "2027-01-03T00:00:00+04:00" }],
  packages: [
    { package_id: "A", system_id: "SYS", name: "Later", display_order: 2 },
    { package_id: "Z", system_id: "SYS", name: "Earlier", display_order: 1 },
  ],
  activities: [
    { activity_id: "A_JOB", package_id: "A", name: "Later job", duration_h: 2, duration_basis: "WORK_TIME", preemptible: true },
    { activity_id: "Z_JOB", package_id: "Z", name: "Earlier job", duration_h: 1, duration_basis: "ELAPSED_TIME", preemptible: false },
  ],
  gates: [{ gate_id: "DONE", gate_type: "PROJECT_COMPLETE" }],
  dependencies: [], resources: [], activity_resources: [], resource_substitutions: [], zones: [], activity_zones: [],
  calendars: [{ calendar_id: "LOCAL", timezone: "Asia/Muscat" }], calendar_shifts: [], milestone_priorities: [],
};
const result: ScheduleResult = {
  projectStart: project.metadata.project_start, objectiveGate: "DONE", objectiveH: 1041,
  horizonH: 1824, optimal: true, solverMessage: "Fictitious optimal result",
  activities: {
    A_JOB: { activityId: "A_JOB", startH: 5, endH: 30, workSlots: [5, 29], segments: [[5, 6], [29, 30]] },
    Z_JOB: { activityId: "Z_JOB", startH: 6, endH: 7, workSlots: [6], segments: [[6, 7]] },
  },
  gates: { DONE: 1041 },
};
const validation: WorkbookImportResult = {
  fileName: "fictional.xlsx", sheetNames: [], data: project, isValid: true,
  issues: [], summary: { systems: 1, packages: 2, activities: 2, gates: 1 },
};

describe("result presentation", () => {
  it("orders packages in both views, keeps IDs and preempted segments, and pairs UTC with local export instants", () => {
    render(<ScheduleResults project={project} result={result} validation={validation} settings={{ horizonDays: 0, timeLimitS: 30 }} solveDurationMs={1000} />);
    const gantt = screen.getByLabelText("Scrollable activity Gantt");
    expect(within(gantt).getAllByText("Earlier")[0].compareDocumentPosition(within(gantt).getAllByText("Later")[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTitle("A_JOB: H+5 to H+6")).toBeInTheDocument();
    expect(screen.getByTitle("A_JOB: H+29 to H+30")).toBeInTheDocument();
    expect(within(gantt).getByText("10 Jan 2027")).toBeInTheDocument();

    const entries = createScheduleBundle({ project, result, validation, settings: { horizonDays: 0, timeLimitS: 30 }, solveDurationMs: 1000, generatedAt: new Date("2027-01-01T00:00:00Z") }).entries;
    const get = (name: string): string => {
      const data = entries.find((entry) => entry.name === name)!.data;
      if (typeof data !== "string") throw new Error(`Expected text export: ${name}`);
      return data;
    };
    const svg = get("gantt_activities.svg");
    expect(svg.indexOf("SYS / Z / Z_JOB")).toBeLessThan(svg.indexOf("SYS / A / A_JOB"));
    expect(svg).toContain("10 Jan 2027");
    expect(svg).toContain("Asia/Muscat");
    expect(svg).toContain('x="335" y="134" width="5"'); // first work segment at H+5
    expect(svg).toContain('x="455" y="134" width="5"'); // second work segment at H+29
    const schedule = get("schedule.csv");
    expect(schedule.split("\r\n")[0]).toMatch(/segments_h,start_datetime_local,end_datetime_local$/);
    expect(schedule).toContain("5-6;29-30,2027-01-03T05:00:00+04:00,2027-01-04T06:00:00+04:00");
    expect(schedule).toContain("2027-01-03T01:00:00.000Z");
    expect(get("gates.csv")).toContain("2027-02-15T09:00:00+04:00");
    const summary = JSON.parse(get("run_summary.json"));
    expect(summary.display_timezone).toBe("Asia/Muscat");
    expect(summary.completion_datetime).toBe("2027-02-15T05:00:00.000Z");
    expect(summary.completion_datetime_local).toBe("2027-02-15T09:00:00+04:00");
  });

  it("places calendar ticks at local midnight across daylight saving, while H+ remains elapsed time", () => {
    const start = "2027-03-27T00:00:00+01:00";
    const ticks = calendarTicks(start, 72, "Europe/Paris");
    expect(ticks.map(({ offsetH, dateLabel }) => [offsetH, dateLabel])).toEqual([
      [0, "27 Mar 2027"], [24, "28 Mar 2027"], [47, "29 Mar 2027"], [71, "30 Mar 2027"],
    ]);
    expect(localIso("2027-03-28T01:00:00Z", "Europe/Paris")).toBe("2027-03-28T03:00:00+02:00");
    expect(localIso("2027-10-31T01:00:00Z", "Europe/Paris")).toBe("2027-10-31T02:00:00+01:00");
  });
});
