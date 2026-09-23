import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { duplicateActivity, duplicatePackage } from "./modelEdits";
import { importWorkbook } from "./workbookImport";
import { createWorkbookRevision } from "./workbookRevision";
import { validateProject } from "./validation";

const fixture = resolve(process.cwd(), "public/synthetic_project.xlsx");

describe("fictional TGBT / GN2 / LOX local editing", () => {
  it("adds V1 entities and FS links, clones a package and an activity, and reimports a revision without changing source IDs", async () => {
    const source = new Uint8Array(await readFile(fixture));
    const imported = await importWorkbook(source);
    expect(imported.isValid).toBe(true);
    const originalIds = {
      systems: imported.data.systems.map((row) => row.system_id),
      packages: imported.data.packages.map((row) => row.package_id),
      activities: imported.data.activities.map((row) => row.activity_id),
      gates: imported.data.gates.map((row) => row.gate_id),
    };
    let project = imported.data;
    for (const id of ["TGBT", "GN2", "LOX"]) {
      project = { ...project,
        systems: [...project.systems, { system_id: id, name: `Fictional ${id}`, family: id,
          arrival_date: "2030-01-02T04:00:00.000Z", enabled: true }],
        packages: [...project.packages, { package_id: `${id}_PKG`, system_id: id, name: `${id} checks`, enabled: true }],
        activities: [...project.activities, { activity_id: `${id}_CHECK`, package_id: `${id}_PKG`, name: `${id} check`,
          duration_h: 2, duration_basis: id === "GN2" ? "ELAPSED_TIME" : "WORK_TIME", preemptible: id === "LOX",
          requires_system_arrival: true, calendar_id: "DEMO_CALENDAR", enabled: true }],
        gates: [...project.gates, { gate_id: `${id}_READY`, system_id: id, package_id: `${id}_PKG`,
          name: `${id} ready`, gate_type: "READY", exposed: true }],
        dependencies: [...project.dependencies, { dependency_id: `${id}_LINK`, source_type: "ACTIVITY", source_id: `${id}_CHECK`,
          target_type: "GATE", target_id: `${id}_READY`, relation: "FS", lag_h: 0, enabled: true,
          rationale: "Fictional check complete" }],
      };
    }
    const activityCopy = duplicateActivity(project, "LOX_CHECK");
    project = activityCopy.project;
    expect(activityCopy.id).toBe("LOX_CHECK_COPY");
    expect(project.dependencies.some((row) => row.source_id === activityCopy.id)).toBe(false);
    const packageCopy = duplicatePackage(project, "SKID_ACCEPTANCE");
    project = packageCopy.project;
    expect(packageCopy.id).toBe("SKID_ACCEPTANCE_COPY");
    expect(project.gates.some((row) => row.gate_id === "SKID_AVAILABLE_COPY")).toBe(true);
    expect(project.dependencies.some((row) => row.source_id === "ACCEPT_SKID_COPY" && row.target_id === "SKID_AVAILABLE_COPY")).toBe(true);
    expect(project.activity_resources.some((row) => row.activity_id === "ACCEPT_SKID_COPY")).toBe(true);
    expect(project.activity_zones.filter((row) => row.activity_id === "ACCEPT_SKID_COPY").length)
      .toBe(imported.data.activity_zones.filter((row) => row.activity_id === "ACCEPT_SKID").length);
    expect(validateProject(project).filter((issue) => issue.severity === "error")).toEqual([]);
    const revision = await createWorkbookRevision(source, project, "Fictional model only", new Date("2030-02-03T04:05:06Z"));
    expect(revision.reimport.isValid).toBe(true);
    const sourceSheet = XLSX.read(source, { type: "array", cellStyles: true }).Sheets.Systems;
    const revisedSheet = XLSX.read(revision.bytes, { type: "array", cellStyles: true }).Sheets.Systems;
    for (const address of ["D2", "D3"]) {
      expect(revisedSheet[address].v).toBe(sourceSheet[address].v);
      expect(revisedSheet[address].z).toBe(sourceSheet[address].z);
    }
    for (const [collection, ids] of Object.entries(originalIds) as Array<[keyof typeof originalIds, unknown[]]>) {
      const field = { systems: "system_id", packages: "package_id", activities: "activity_id", gates: "gate_id" }[collection];
      expect(revision.reimport.data[collection].slice(0, ids.length).map((row) => row[field])).toEqual(ids);
      expect(revision.reimport.data[collection]).toEqual(project[collection]);
    }
    expect(revision.reimport.data.activity_resources).toEqual(project.activity_resources);
    expect(revision.reimport.data.activity_zones).toEqual(project.activity_zones);
    expect(revision.reimport.data.dependencies).toEqual(project.dependencies);
    expect(revision.reimport.data.metadata.parent_revision).toBe(imported.data.metadata.revision_id);
  });
});
