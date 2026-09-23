import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { errorKind } from "./App";
import type { WorkbookImportResult } from "./lib/model";
import { fetchLocalArrayBuffer } from "./lib/localAsset";
import { solveScheduleInWorker } from "./lib/scheduler/solverClient";
import type { ScheduleResult } from "./lib/scheduler/types";
import { importWorkbook } from "./lib/workbookImport";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

vi.mock("./lib/workbookImport", () => ({ importWorkbook: vi.fn() }));
vi.mock("./lib/localAsset", () => ({ fetchLocalArrayBuffer: vi.fn() }));
vi.mock("./lib/scheduler/solverClient", () => ({ solveScheduleInWorker: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function selectWorkbook(name: string) {
  fireEvent.change(screen.getByLabelText("Select a local .xlsx file"), {
    target: { files: [new File(["fictional"], name)] },
  });
}

function namedWorkbook(name: string): WorkbookImportResult {
  return { ...importedWorkbook, fileName: name };
}

const importedWorkbook: WorkbookImportResult = {
  fileName: "synthetic_project.xlsx",
  sheetNames: [],
  issues: [],
  summary: { systems: 1, packages: 1, activities: 2, gates: 1 },
  isValid: true,
  data: {
    metadata: { project_start: "2026-01-05T08:00:00Z", active_calendar: "STANDARD" },
    systems: [{ system_id: "SYS_A", name: "Skid system", arrival_date: "2026-01-05T08:00:00Z", enabled: true }],
    packages: [{ package_id: "PKG_A", system_id: "SYS_A", name: "Positioning", enabled: true }],
    activities: [
      { activity_id: "ROUTE_SERVICES", package_id: "PKG_A", name: "Route services", duration_h: 10, duration_basis: "WORK_TIME", preemptible: true, enabled: true },
      { activity_id: "POSITION_SKID", package_id: "PKG_A", name: "Position skid", duration_h: 8, duration_basis: "WORK_TIME", preemptible: false, enabled: true },
    ],
    gates: [{ gate_id: "PROJECT_COMPLETE", gate_type: "PROJECT_COMPLETE", name: "Project complete" }],
    dependencies: [], resources: [], activity_resources: [], resource_substitutions: [], zones: [], activity_zones: [],
    calendars: [{ calendar_id: "STANDARD", timezone: "UTC" }], calendar_shifts: [], milestone_priorities: [],
  },
};

const schedule: ScheduleResult = {
  projectStart: "2026-01-05T08:00:00Z",
  objectiveGate: "PROJECT_COMPLETE",
  objectiveH: 132,
  horizonH: 1016,
  optimal: true,
  solverMessage: "HiGHS test: optimal",
  activities: {
    ROUTE_SERVICES: { activityId: "ROUTE_SERVICES", startH: 32, endH: 58, workSlots: [32, 33, 34, 35, 36, 37, 38, 39, 56, 57], segments: [[32, 40], [56, 58]] },
    POSITION_SKID: { activityId: "POSITION_SKID", startH: 80, endH: 88, workSlots: [80, 81, 82, 83, 84, 85, 86, 87], segments: [[80, 88]] },
  },
  gates: { PROJECT_COMPLETE: 132 },
};

describe("AIT Planning Optimizer workspace", () => {
  beforeEach(() => vi.clearAllMocks());

  it("blocks solving and revision export after a fictional cycle, then allows removal and reprioritization", async () => {
    const actual = await vi.importActual<typeof import("./lib/workbookImport")>("./lib/workbookImport");
    const bytes = new Uint8Array(await readFile(resolve(process.cwd(), "public/synthetic_project.xlsx")));
    vi.mocked(importWorkbook).mockResolvedValue(await actual.importWorkbook(bytes));
    render(<App />);
    selectWorkbook("synthetic_project.xlsx");
    await screen.findByText("Workbook accepted");
    fireEvent.change(screen.getByLabelText("Dependency ID"), { target: { value: "DEP_CYCLE" } });
    fireEvent.change(screen.getByLabelText("Predecessor type"), { target: { value: "GATE" } });
    fireEvent.change(screen.getByLabelText("Predecessor ID"), { target: { value: "PROJECT_COMPLETE" } });
    fireEvent.change(screen.getByLabelText("Successor type"), { target: { value: "ACTIVITY" } });
    fireEvent.change(screen.getByLabelText("Successor ID"), { target: { value: "PREPARE_FOUNDATION" } });
    fireEvent.change(screen.getByLabelText("Justification"), { target: { value: "Fictional cycle for validation" } });
    fireEvent.click(screen.getByRole("button", { name: "Add dependency" }));
    expect(screen.getByText(/DEPENDENCY_CYCLE/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calculate schedule" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download new .xlsx revision" })).toBeDisabled();
    const addedRow = screen.getByText("DEP_CYCLE", { selector: ".model-dependencies code" }).closest("li")!;
    fireEvent.click(within(addedRow).getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("button", { name: "Calculate schedule" })).toBeEnabled();
    const rank = screen.getByText("PROJECT_COMPLETE", { selector: ".model-priority code" })
      .closest(".model-priority")!.querySelector("input[type=number]")!;
    fireEvent.change(rank, { target: { value: "" } });
    expect(screen.getByText(/INVALID_MILESTONE_PRIORITY/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download new .xlsx revision" })).toBeDisabled();
    fireEvent.change(rank, { target: { value: "1" } });
    expect(screen.getByRole("button", { name: "Download new .xlsx revision" })).toBeEnabled();
  });

  it("shows the local workflow, solver settings, and an empty result state", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "AIT Planning Optimizer" })).toBeInTheDocument();
    expect(screen.getByText("Version dev")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByText("Local processing only")).toBeInTheDocument();
    expect(screen.getByLabelText("Select a local .xlsx file")).toHaveAttribute("accept", expect.stringContaining(".xlsx"));
    expect(screen.getByRole("button", { name: "Load synthetic example" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear local data" })).toBeDisabled();
    expect(screen.getByLabelText("Planning horizon")).toHaveValue(0);
    expect(screen.getByLabelText("Solver time limit")).toHaveValue(120);
    expect(screen.getByRole("button", { name: "Calculate schedule" })).toBeDisabled();
    expect(screen.getByText(/waiting for input/i)).toBeInTheDocument();
  });

  it("switches themes without persisting project data or changing the loaded workbook", async () => {
    vi.mocked(importWorkbook).mockResolvedValue(importedWorkbook);
    const { unmount } = render(<App />);
    const toggle = screen.getByRole("button", { name: "Light theme" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("button", { name: "Dark theme" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.change(screen.getByLabelText("Select a local .xlsx file"), {
      target: { files: [new File(["synthetic"], "synthetic_project.xlsx")] },
    });
    expect(await screen.findByText("Workbook accepted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dark theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByText("Workbook accepted")).toBeInTheDocument();
    unmount();
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("connects validated input and settings to the Worker and renders the full result", async () => {
    vi.mocked(importWorkbook).mockResolvedValue(importedWorkbook);
    vi.mocked(solveScheduleInWorker).mockImplementation(async (_project, _options, onProgress) => {
      onProgress?.({ stage: "building", message: "Building the hourly MILP…" });
      return schedule;
    });
    render(<App />);

    fireEvent.change(screen.getByLabelText("Select a local .xlsx file"), {
      target: { files: [new File(["synthetic"], "synthetic_project.xlsx")] },
    });
    expect(await screen.findByText("Workbook accepted")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Planning horizon"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Solver time limit"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate schedule" }));

    await waitFor(() => expect(solveScheduleInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ project_start: "2026-01-05T08:00:00Z" }) }),
      { horizonDays: 7, timeLimitS: 30 },
      expect.any(Function),
      expect.any(AbortSignal),
    ));
    expect(await screen.findByText("Completion date")).toBeInTheDocument();
    expect(screen.getByText("5 d 12 h")).toBeInTheDocument();
    expect(screen.getByText("Activity Gantt")).toBeInTheDocument();
    expect(screen.getByTitle("ROUTE_SERVICES: H+32 to H+40")).toBeInTheDocument();
    expect(screen.getByTitle("ROUTE_SERVICES: H+56 to H+58")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Activities" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Gates" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download result ZIP" })).toBeInTheDocument();
    expect(screen.getByText("HiGHS test: optimal", { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText("Scrollable activity Gantt")).toHaveAttribute("tabindex", "0");
    expect(screen.getAllByText("Skid system").some((item) => item.closest(".gantt-group-label"))).toBe(true);
    expect(screen.getByLabelText("Scrollable activity results table")).toHaveAttribute("tabindex", "0");
    expect(screen.getByLabelText("Scrollable gate results table")).toHaveAttribute("tabindex", "0");
    fireEvent.click(screen.getByRole("button", { name: "Clear local data" }));
    expect(screen.queryByText("Completion date")).not.toBeInTheDocument();
    expect(screen.getByText("No workbook loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calculate schedule" })).toBeDisabled();
  });

  it("announces progress and allows the local solve to be cancelled", async () => {
    vi.mocked(importWorkbook).mockResolvedValue(importedWorkbook);
    vi.mocked(solveScheduleInWorker).mockImplementation((_project, _options, onProgress, signal) =>
      new Promise((_resolve, reject) => {
        onProgress?.({ stage: "optimizing", message: "Optimizing PROJECT_COMPLETE (pass 1)…" });
        signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      }),
    );
    render(<App />);
    fireEvent.change(screen.getByLabelText("Select a local .xlsx file"), {
      target: { files: [new File(["synthetic"], "synthetic_project.xlsx")] },
    });
    await screen.findByText("Workbook accepted");
    fireEvent.click(screen.getByRole("button", { name: "Calculate schedule" }));
    await waitFor(() => expect(screen.getAllByText("Optimizing PROJECT_COMPLETE (pass 1)…")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Ready to calculate")).toBeInTheDocument();
  });

  it("shows an explicit infeasible state and keeps retry available", async () => {
    vi.mocked(importWorkbook).mockResolvedValue(importedWorkbook);
    vi.mocked(solveScheduleInWorker).mockRejectedValue(new Error("HiGHS did not prove an optimal schedule (status 8)."));
    render(<App />);
    fireEvent.change(screen.getByLabelText("Select a local .xlsx file"), {
      target: { files: [new File(["synthetic"], "synthetic_project.xlsx")] },
    });
    await screen.findByText("Workbook accepted");
    fireEvent.click(screen.getByRole("button", { name: "Calculate schedule" }));
    expect(await screen.findByText(/no feasible schedule/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("discards both a late import result and a late import error after clear", async () => {
    const first = deferred<WorkbookImportResult>();
    const second = deferred<WorkbookImportResult>();
    vi.mocked(importWorkbook).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<App />);

    selectWorkbook("fictional-first.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "Clear local data" }));
    await act(async () => first.resolve(namedWorkbook("fictional-first.xlsx")));
    expect(screen.getByText("No workbook loaded")).toBeInTheDocument();
    expect(screen.queryByText("fictional-first.xlsx")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calculate schedule" })).toBeDisabled();

    selectWorkbook("fictional-second.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "Clear local data" }));
    await act(async () => second.reject(new Error("Fictional import failed")));
    expect(screen.getByText("No workbook loaded")).toBeInTheDocument();
    expect(screen.queryByText("Fictional import failed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear local data" })).toBeDisabled();
  });

  it("keeps the latest workbook when an earlier import completes afterwards", async () => {
    const first = deferred<WorkbookImportResult>();
    const second = deferred<WorkbookImportResult>();
    vi.mocked(importWorkbook).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<App />);

    selectWorkbook("fictional-first.xlsx");
    selectWorkbook("fictional-second.xlsx");
    await act(async () => second.resolve(namedWorkbook("fictional-second.xlsx")));
    expect(screen.getByText("fictional-second.xlsx")).toBeInTheDocument();
    await act(async () => first.resolve(namedWorkbook("fictional-first.xlsx")));
    expect(screen.getByText("fictional-second.xlsx")).toBeInTheDocument();
    expect(screen.queryByText("fictional-first.xlsx")).not.toBeInTheDocument();
  });

  it("keeps loading the replacement when the earlier import finishes first", async () => {
    const first = deferred<WorkbookImportResult>();
    const second = deferred<WorkbookImportResult>();
    vi.mocked(importWorkbook).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<App />);

    selectWorkbook("fictional-first.xlsx");
    selectWorkbook("fictional-second.xlsx");
    await act(async () => first.reject(new Error("Outdated fictional import failed")));
    expect(screen.getByText("Validating workbook")).toBeInTheDocument();
    expect(screen.queryByText("Outdated fictional import failed")).not.toBeInTheDocument();
    await act(async () => second.resolve(namedWorkbook("fictional-second.xlsx")));
    expect(screen.getByText("fictional-second.xlsx")).toBeInTheDocument();
  });

  it("discards a late example fetch after clear and after a replacement workbook", async () => {
    const firstFetch = deferred<ArrayBuffer>();
    const secondFetch = deferred<ArrayBuffer>();
    vi.mocked(fetchLocalArrayBuffer).mockReturnValueOnce(firstFetch.promise).mockReturnValueOnce(secondFetch.promise);
    vi.mocked(importWorkbook).mockResolvedValue(namedWorkbook("fictional-replacement.xlsx"));
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Load synthetic example" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear local data" }));
    await act(async () => firstFetch.resolve(new ArrayBuffer(1)));
    expect(importWorkbook).not.toHaveBeenCalled();
    expect(screen.getByText("No workbook loaded")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load synthetic example" }));
    selectWorkbook("fictional-replacement.xlsx");
    expect(await screen.findByText("fictional-replacement.xlsx")).toBeInTheDocument();
    await act(async () => secondFetch.resolve(new ArrayBuffer(1)));
    expect(screen.getByText("fictional-replacement.xlsx")).toBeInTheDocument();
    expect(importWorkbook).toHaveBeenCalledTimes(1);
  });

  it("discards a late example import after clear", async () => {
    const pendingImport = deferred<WorkbookImportResult>();
    vi.mocked(fetchLocalArrayBuffer).mockResolvedValue(new ArrayBuffer(1));
    vi.mocked(importWorkbook).mockReturnValue(pendingImport.promise);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Load synthetic example" }));
    await waitFor(() => expect(importWorkbook).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Clear local data" }));
    await act(async () => pendingImport.resolve(namedWorkbook("synthetic_project.xlsx")));
    expect(screen.getByText("No workbook loaded")).toBeInTheDocument();
    expect(screen.queryByText("synthetic_project.xlsx")).not.toBeInTheDocument();
  });
});

describe("solver error classification", () => {
  it("separates infeasible outcomes from general errors", () => {
    expect(errorKind("No feasible execution profile for ACT_A.")).toBe("infeasible");
    expect(errorKind("HiGHS status 9")).toBe("infeasible");
    expect(errorKind("Worker failed to load")).toBe("error");
  });
});
