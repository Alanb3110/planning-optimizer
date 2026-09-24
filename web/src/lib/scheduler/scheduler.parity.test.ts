import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import loadHighs, { type Highs } from "highs";
import { beforeAll, describe, expect, it } from "vitest";
import { importWorkbook } from "../workbookImport";
import { solveScheduleWithHighs } from "./highsSolver";
import { asSchedulingProject } from "./types";

let highs: Highs;

beforeAll(async () => {
  highs = await loadHighs();
});

describe("HiGHS WebAssembly parity with the Python oracle", () => {
  it("matches the synthetic reference schedule", async () => {
    const workbook = new Uint8Array(
      await readFile(resolve(process.cwd(), "../examples/synthetic_project.xlsx")),
    );
    const imported = await importWorkbook(workbook, "synthetic_project.xlsx");
    expect(imported.issues.filter((issue) => issue.severity === "error")).toEqual([]);

    const result = solveScheduleWithHighs(highs, asSchedulingProject(imported.data), {
      timeLimitS: 30,
    });

    expect(result.horizonH).toBe(1016);
    expect(result.objectiveGate).toBe("PROJECT_COMPLETE");
    expect(result.gates.PROJECT_COMPLETE).toBe(132);
    expect(result.gates.SKID_AVAILABLE).toBe(60);
    expect(result.gates.SKID_POSITIONED).toBe(88);
    expect(result.activities.ROUTE_SERVICES.segments).toEqual([
      [32, 40],
      [56, 58],
    ]);
    expect(result.activities.POSITION_SKID.startH).toBe(80);

    expect(result.activities.ACCEPT_SKID.startH).toBeGreaterThanOrEqual(56);
    expect(result.activities.ROUTE_SERVICES.startH).toBeLessThan(56);
    expect(result.activities.POSITION_SKID.segments).toEqual([[80, 88]]);
    expect(result.activities.SEAL_CURE.endH - result.activities.SEAL_CURE.startH).toBe(24);
    expect(result.activities.SEAL_CURE.endH).toBe(result.gates.PROJECT_COMPLETE);
    expect(
      result.activities.PREPARE_FOUNDATION.workSlots.some((slot) =>
        result.activities.ROUTE_SERVICES.workSlots.includes(slot),
      ),
    ).toBe(false);
  }, 60_000);

  it("keeps a fictional newly added terminal Activity before PROJECT_COMPLETE", async () => {
    const workbook = new Uint8Array(await readFile(resolve(process.cwd(), "../examples/synthetic_project.xlsx")));
    const imported = await importWorkbook(workbook, "synthetic_project.xlsx");
    const project = asSchedulingProject(imported.data);
    project.activities.push({
      activity_id: "UX_FICTIONAL_CHECK", package_id: "SKID_INSTALLATION", duration_h: 2,
      duration_basis: "WORK_TIME", preemptible: false, calendar_id: "DEMO_CALENDAR",
      requires_system_arrival: true, enabled: true,
    });
    project.activity_resources.push({ activity_id: "UX_FICTIONAL_CHECK", resource_id: "INSTALL_CREW", quantity: 1 });
    project.activity_zones.push({ activity_id: "UX_FICTIONAL_CHECK", zone_id: "ASSEMBLY_AREA", load: 1, exclusive: false });
    project.dependencies.push(
      { dependency_id: "UX_FS_LINK", source_type: "ACTIVITY", source_id: "POSITION_SKID", target_type: "ACTIVITY", target_id: "UX_FICTIONAL_CHECK", lag_h: 1, enabled: true },
      { dependency_id: "UX_TO_COMPLETE", source_type: "ACTIVITY", source_id: "UX_FICTIONAL_CHECK", target_type: "GATE", target_id: "PROJECT_COMPLETE", lag_h: 0, enabled: true },
    );
    const result = solveScheduleWithHighs(highs, project, { timeLimitS: 30 });
    expect(result.activities.UX_FICTIONAL_CHECK.endH).toBeLessThanOrEqual(result.gates.PROJECT_COMPLETE);
  }, 60_000);
});
