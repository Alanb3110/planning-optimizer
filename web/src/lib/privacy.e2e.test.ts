import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import loadHighs, { type Highs } from "highs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createScheduleBundle } from "./exports";
import { fetchLocalArrayBuffer } from "./localAsset";
import { solveScheduleWithHighs } from "./scheduler/highsSolver";
import { asSchedulingProject } from "./scheduler/types";
import { importWorkbook } from "./workbookImport";
import { createZip } from "./zip";

let highs: Highs;

beforeAll(async () => {
  highs = await loadHighs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function readStoredZip(bytes: Uint8Array): Map<string, string> {
  const output = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    const compressedSize = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const fileName = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    output.set(fileName, decoder.decode(bytes.slice(dataStart, dataStart + compressedSize)));
    offset = dataStart + compressedSize;
  }
  return output;
}

describe("private browser-only example workflow", () => {
  it("ships a same-origin CSP with Worker and WebAssembly permissions only", async () => {
    const html = await readFile(resolve(process.cwd(), "index.html"), "utf8");
    const validationSource = await readFile(resolve(process.cwd(), "src/lib/validation.ts"), "utf8");
    expect(html).toContain("default-src 'self'");
    expect(html).toContain("connect-src 'self'");
    expect(html).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(html).toContain("worker-src 'self' blob:");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org\/1999\/xhtml)/);
    expect(html).not.toContain("'unsafe-eval'");
    expect(validationSource).toContain("validator.generated");
    expect(validationSource).not.toContain("new Ajv");
  });

  it("loads, validates, solves and exports without external, mutating or persistent operations", async () => {
    const workbookBytes = Uint8Array.from(
      await readFile(resolve(process.cwd(), "../examples/synthetic_project.xlsx")),
    );
    const networkRequests: Array<{ method: string; url: URL }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = new URL(input instanceof Request ? input.url : input.toString(), window.location.href);
      networkRequests.push({ method, url });
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) throw new Error(`Mutating request detected: ${method}`);
      if (url.origin !== window.location.origin) throw new Error(`External request detected: ${url.origin}`);
      return new Response(workbookBytes.buffer, { status: 200 });
    });
    const storageSet = vi.spyOn(Storage.prototype, "setItem");
    const storageRemove = vi.spyOn(Storage.prototype, "removeItem");
    const storageClear = vi.spyOn(Storage.prototype, "clear");
    const indexedDbOpen = vi.fn(() => { throw new Error("IndexedDB access detected."); });
    const cacheOpen = vi.fn(() => { throw new Error("Cache Storage access detected."); });
    const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    const cachesDescriptor = Object.getOwnPropertyDescriptor(globalThis, "caches");
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open: indexedDbOpen } });
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { open: cacheOpen } });

    try {
      const workbook = await fetchLocalArrayBuffer("./synthetic_project.xlsx");
      const imported = await importWorkbook(workbook, "synthetic_project.xlsx");
      expect(imported.isValid).toBe(true);
      const project = asSchedulingProject(imported.data);
      const result = solveScheduleWithHighs(highs, project, { timeLimitS: 30 });
      expect(result.optimal).toBe(true);
      expect(result.gates.PROJECT_COMPLETE).toBe(132);

      const bundle = createScheduleBundle({
        project,
        result,
        validation: imported,
        settings: { horizonDays: 0, timeLimitS: 30 },
        solveDurationMs: 1000,
        generatedAt: new Date("2030-01-01T00:00:00.000Z"),
      });
      const files = readStoredZip(createZip(bundle.entries, bundle.generatedAt));
      expect([...files.keys()].sort()).toEqual([
        "gantt_activities.svg",
        "gates.csv",
        "normalized_project.json",
        "run_summary.json",
        "schedule.csv",
        "validation_report.json",
      ]);
      expect(files.get("schedule.csv")).toContain("ROUTE_SERVICES");
      expect(files.get("gates.csv")).toContain("PROJECT_COMPLETE");
      expect(files.get("gantt_activities.svg")).toContain("<svg");
      expect(JSON.parse(files.get("run_summary.json")!).completion_h).toBe(132);
      expect(JSON.parse(files.get("validation_report.json")!).valid).toBe(true);
      const diagnosticBundle = createScheduleBundle({
        project,
        result,
        validation: imported,
        settings: { horizonDays: 0, timeLimitS: 30 },
        solveDurationMs: 1000,
        diagnostics: [{ severity: "info", code: "TEST_DIAGNOSTIC", message: "Fictitious diagnostic" }],
        generatedAt: new Date("2030-01-01T00:00:00.000Z"),
      });
      expect(diagnosticBundle.entries.map((entry) => entry.name)).toContain("diagnostics.csv");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(networkRequests).toHaveLength(1);
      expect(networkRequests[0].method).toBe("GET");
      expect(networkRequests[0].url.origin).toBe(window.location.origin);
      expect(storageSet).not.toHaveBeenCalled();
      expect(storageRemove).not.toHaveBeenCalled();
      expect(storageClear).not.toHaveBeenCalled();
      expect(indexedDbOpen).not.toHaveBeenCalled();
      expect(cacheOpen).not.toHaveBeenCalled();
    } finally {
      if (indexedDbDescriptor) Object.defineProperty(globalThis, "indexedDB", indexedDbDescriptor);
      else Reflect.deleteProperty(globalThis, "indexedDB");
      if (cachesDescriptor) Object.defineProperty(globalThis, "caches", cachesDescriptor);
      else Reflect.deleteProperty(globalThis, "caches");
    }
  }, 60_000);

  it("rejects an off-origin example asset before issuing a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(fetchLocalArrayBuffer("https://external.invalid/project.xlsx", fetcher))
      .rejects.toThrow("External asset requests are not permitted");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
