import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { importWorkbook } from "./workbookImport";
import { createWorkbookRevision } from "./workbookRevision";
import { validateProject } from "./validation";

const fixture = resolve(process.cwd(), "public/synthetic_project.xlsx");
const fixedTime = new Date("2030-02-03T04:05:06Z");

describe("local V1 workbook revision", () => {
  it("reimports edited FS links and gate priorities while keeping other sheets, formulas and normalized data", async () => {
    const workbook = XLSX.read(new Uint8Array(await readFile(fixture)), { type: "array" });
    const extra = XLSX.utils.aoa_to_sheet([["Keep", "Formula"], [42, { f: "A2*2", v: 84 }]]);
    XLSX.utils.book_append_sheet(workbook, extra, "PrivateNotes");
    const source = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const sourceWorkbook = XLSX.read(source, { type: "array" });
    const imported = await importWorkbook(source);
    expect(imported.isValid).toBe(true);
    const dependencies = imported.data.dependencies.filter((row) => row.dependency_id !== "DEP_001")
      .map((row) => row.dependency_id === "DEP_002" ? { ...row, lag_h: 4, enabled: false, rationale: "Fictional edit" } : row);
    dependencies.push({ dependency_id: "DEP_TEST", source_type: "ACTIVITY", source_id: "PREPARE_FOUNDATION",
      target_type: "GATE", target_id: "PROJECT_COMPLETE", relation: "FS", lag_h: 1,
      enabled: true, rationale: "Fictional review" });
    const data = { ...imported.data, dependencies, milestone_priorities: [
      ...imported.data.milestone_priorities.map((row) => ({ ...row, priority: 2 })),
      { gate_id: "SKID_POSITIONED", priority: 1, enabled: true, notes: "Fictional rank" },
    ] };
    expect(validateProject(data).filter((issue) => issue.severity === "error")).toEqual([]);
    const revision = await createWorkbookRevision(source, data, "Local review", fixedTime);
    expect(revision.reimport.isValid).toBe(true);
    expect(revision.reimport.data.dependencies).toEqual(data.dependencies);
    expect(revision.reimport.data.milestone_priorities).toEqual(data.milestone_priorities);
    expect(revision.reimport.data.metadata).toMatchObject({
      revision_id: "DEMO_001_EDIT_20300203040506", parent_revision: "DEMO_001",
      revision_timestamp: fixedTime.toISOString(), revision_comment: "Local review",
    });
    for (const key of ["systems", "packages", "activities", "gates", "resources", "activity_resources",
      "resource_substitutions", "zones", "activity_zones", "calendars", "calendar_shifts"] as const) {
      expect(revision.reimport.data[key]).toEqual(imported.data[key]);
    }
    const revised = XLSX.read(revision.bytes, { type: "array" });
    expect(revised.SheetNames).toEqual(sourceWorkbook.SheetNames);
    for (const name of sourceWorkbook.SheetNames.filter((value) => !["Metadata", "Dependencies", "MilestonePriorities"].includes(value))) {
      expect(XLSX.utils.sheet_to_json(revised.Sheets[name], { header: 1, raw: true }))
        .toEqual(XLSX.utils.sheet_to_json(sourceWorkbook.Sheets[name], { header: 1, raw: true }));
    }
    expect(revised.Sheets.PrivateNotes.B2.f).toBe("A2*2");
    expect(revised.Sheets.Metadata.B5.v).toBe(sourceWorkbook.Sheets.Metadata.B5.v);
  });

  it("rejects invalid IDs, references, cycles, ranks and a missing PROJECT_COMPLETE priority", async () => {
    const source = new Uint8Array(await readFile(fixture));
    const { data } = await importWorkbook(source);
    const bad = { ...data, dependencies: [...data.dependencies,
      { dependency_id: "DEP_001", source_type: "GATE", source_id: "PROJECT_COMPLETE",
        target_type: "ACTIVITY", target_id: "PREPARE_FOUNDATION", relation: "FS", lag_h: 0, enabled: true },
      { dependency_id: "UNKNOWN_TEST", source_type: "ACTIVITY", source_id: "NO_SUCH_ACTIVITY",
        target_type: "GATE", target_id: "PROJECT_COMPLETE", relation: "FS", lag_h: 0, enabled: true },
    ], milestone_priorities: [{ gate_id: "SKID_POSITIONED", priority: 1, enabled: true }] };
    const codes = validateProject(bad).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(["DUPLICATE_ID", "UNKNOWN_REFERENCE", "DEPENDENCY_CYCLE", "PROJECT_COMPLETE_PRIORITY"]));
    await expect(createWorkbookRevision(source, bad)).rejects.toThrow("Invalid model");
    const duplicate = { ...data, milestone_priorities: [...data.milestone_priorities,
      { gate_id: "SKID_POSITIONED", priority: 1, enabled: true }] };
    expect(validateProject(duplicate).some((issue) => issue.code === "DUPLICATE_MILESTONE_PRIORITY")).toBe(true);
  });
});
