import { describe, expect, it } from "vitest";
import { buildScheduleMilp } from "./milp";
import { solveFailureFrom, type SchedulingProject } from "./types";

const project: SchedulingProject = {
  metadata: { project_start: "2030-01-07T00:00:00Z" },
  systems: [{ system_id: "S", arrival_date: "2030-01-07T00:00:00Z" }],
  packages: [{ package_id: "P", system_id: "S" }],
  activities: [
    {
      activity_id: "A",
      package_id: "P",
      duration_h: 1,
      duration_basis: "ELAPSED_TIME",
      preemptible: false,
      enabled: true,
    },
  ],
  gates: [{ gate_id: "DONE", gate_type: "PROJECT_COMPLETE" }],
  dependencies: [
    {
      dependency_id: "A_DONE",
      source_type: "ACTIVITY",
      source_id: "A",
      target_type: "GATE",
      target_id: "DONE",
      lag_h: 0,
      enabled: true,
    },
  ],
  resources: [],
  activity_resources: [],
  resource_substitutions: [],
  zones: [],
  activity_zones: [],
  calendars: [],
  calendar_shifts: [],
  milestone_priorities: [{ gate_id: "DONE", priority: 1, enabled: true }],
};

describe("solver diagnostics", () => {
  it("counts the built hourly MILP before HiGHS is called", () => {
    const built = buildScheduleMilp(project, { horizonDays: 1 });
    expect(built.diagnostics).toEqual({
      activeActivities: 1,
      horizonH: 24,
      executionProfiles: 24,
      columns: 27,
      rows: 4,
      nonzeros: 75,
      optimizationPasses: 2,
      estimatedModelBytes: 1740,
    });
  });

  it("keeps a generic WASM abort distinct from infeasibility and includes model context", () => {
    const diagnostics = buildScheduleMilp(project, { horizonDays: 1 }).diagnostics;
    const failure = solveFailureFrom(
      new Error("Aborted(). Build with -sASSERTIONS for more info."),
      diagnostics,
    );
    expect(failure.kind).toBe("wasm-abort");
    expect(failure.message).toContain("not evidence that the scheduling model is infeasible");
    expect(failure.message).toContain("execution profiles=24");
    expect(failure.message).toContain("typed-array estimate=1740 B");
  });

  it("classifies allocation failures and unproven limits separately", () => {
    expect(solveFailureFrom(new Error("RuntimeError: memory access out of bounds")).kind)
      .toBe("potential-model-size");
    expect(solveFailureFrom(new Error("HiGHS time limit reached before optimum was proved.")).kind)
      .toBe("not-proven");
  });
});
