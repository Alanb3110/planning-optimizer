import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as XLSX from "xlsx";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { importWorkbook } from "./workbookImport";

const fixturePath = resolve(process.cwd(), "public/synthetic_project.xlsx");
let syntheticWorkbook: Uint8Array;

beforeAll(async () => {
  syntheticWorkbook = new Uint8Array(await readFile(fixturePath));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function incompleteWorkbook(): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Field", "Value"],
      ["project_id", "INCOMPLETE_DEMO"],
      ["revision_id", "TEST_001"],
      ["project_start", "2030-01-01T00:00:00Z"],
    ]),
    "Metadata",
  );
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}

function workbookWithCycle(): ArrayBuffer {
  const workbook = XLSX.read(syntheticWorkbook, { type: "array" });
  const dependencyRows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets.Dependencies, {
    header: 1,
    raw: true,
    defval: null,
  });
  dependencyRows.push([
    "TEST_CYCLE", "ACTIVITY", "MGF_IQC", "ACTIVITY", "MGF_RECEIVE", "FS", 0, true,
    "Fictitious regression cycle",
  ]);
  workbook.Sheets.Dependencies = XLSX.utils.aoa_to_sheet(dependencyRows);
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}

describe("browser workbook import", () => {
  it("accepts the synthetic workbook", async () => {
    const result = await importWorkbook(syntheticWorkbook, "synthetic_project.xlsx");
    expect(result.isValid).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.summary).toEqual({ systems: 6, packages: 15, activities: 54, gates: 17 });
    expect(result.data.metadata.project_start).toMatch(/T00:00:00\+04:00$/);
    expect(result.data.calendars[0].weekend_days).toEqual(["FRI", "SAT"]);
    expect(result.data.activities.find((row) => row.activity_id === "LOX_CURE")?.enabled).toBe(true);
  });

  it("rejects an incomplete workbook without throwing", async () => {
    const result = await importWorkbook(incompleteWorkbook(), "incomplete.xlsx");
    expect(result.isValid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "MISSING_SHEET")).toBe(true);
    expect(result.issues.some((issue) => issue.message.includes("Systems"))).toBe(true);
  });

  it("detects an enabled dependency cycle", async () => {
    const result = await importWorkbook(workbookWithCycle(), "cycle.xlsx");
    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DEPENDENCY_CYCLE", severity: "error" }),
      ]),
    );
  });

  it("does not issue a network request or persist workbook content", async () => {
    const fetchSpy = vi.fn();
    const sendBeaconSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: sendBeaconSpy });
    const xhrSendSpy = vi.spyOn(XMLHttpRequest.prototype, "send");
    const localStorageSpy = vi.spyOn(Storage.prototype, "setItem");

    const result = await importWorkbook(syntheticWorkbook, "local.xlsx");

    expect(result.isValid).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSendSpy).not.toHaveBeenCalled();
    expect(sendBeaconSpy).not.toHaveBeenCalled();
    expect(localStorageSpy).not.toHaveBeenCalled();
  });
});
