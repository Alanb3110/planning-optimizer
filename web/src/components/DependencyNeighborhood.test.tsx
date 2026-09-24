import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { useState } from "react";
import loadHighs from "highs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NormalizedProject } from "../lib/model";
import { asSchedulingProject } from "../lib/scheduler/types";
import { solveScheduleWithHighs } from "../lib/scheduler/highsSolver";
import { validateProject } from "../lib/validation";
import { importWorkbook } from "../lib/workbookImport";
import { createWorkbookRevision } from "../lib/workbookRevision";
import { ModelEditor } from "./ModelEditor";

const sourceFile = resolve(process.cwd(), "public/synthetic_project.xlsx");

function denseFiction(base: NormalizedProject): NormalizedProject {
  const original = base.activities[0];
  const activities = [...base.activities,
    ...["NODE_1", "NODE_10"].map((id) => ({ ...original, activity_id: id, name: `Fictional ${id}`, duration_h: 1 }))];
  const predecessorIds = activities.map((row) => String(row.activity_id));
  return { ...base, activities,
    gates: [...base.gates, { gate_id: "G_LOCAL", name: "Fictional dense gate", gate_type: "TECHNICAL", exposed: true },
      { gate_id: "G_NEXT", name: "Fictional next gate", gate_type: "TECHNICAL", exposed: true }],
    dependencies: [...base.dependencies,
      ...predecessorIds.map((id, i) => ({ dependency_id: `LOCAL_${i}`, source_type: "ACTIVITY", source_id: id,
        target_type: "GATE", target_id: "G_LOCAL", relation: "FS", lag_h: i, enabled: true, rationale: "Fictional test" })),
      { dependency_id: "LOCAL_END", source_type: "GATE", source_id: "G_LOCAL", target_type: "GATE",
        target_id: "PROJECT_COMPLETE", relation: "FS", lag_h: 0, enabled: true, rationale: "Fictional completion" },
      { dependency_id: "NEXT_END", source_type: "GATE", source_id: "G_NEXT", target_type: "GATE",
        target_id: "PROJECT_COMPLETE", relation: "FS", lag_h: 0, enabled: true, rationale: "Fictional completion" },
      { dependency_id: "LOCAL_DISABLED", source_type: "GATE", source_id: "PROJECT_COMPLETE", target_type: "GATE",
        target_id: "G_LOCAL", relation: "FS", lag_h: 2, enabled: false, rationale: "Fictional inactive link" }],
  };
}

describe("direct dependency graph", () => {
  it("navigates exact IDs in a dense graph, confirms FS fields, rejects a cycle and round-trips the revision", async () => {
    const source = new Uint8Array(await readFile(sourceFile));
    const imported = await importWorkbook(source);
    let latest = denseFiction(imported.data);
    expect(validateProject(latest).filter((issue) => issue.severity === "error")).toEqual([]);
    function Harness() {
      const [project, setProject] = useState(latest);
      const [focus, setFocus] = useState<{ kind: "ACTIVITY" | "GATE" | "SYSTEM" | "PACKAGE"; id: string }>({ kind: "GATE", id: "G_LOCAL" });
      return <ModelEditor project={project} focus={focus} onChange={(next) => { latest = next; setProject(next); }}
        onSelect={(node) => { if (node.kind === "ACTIVITY" || node.kind === "GATE") setFocus(node); }}
        onExport={async () => "fiction.xlsx"} canExport disabled={false} />;
    }
    render(<Harness />);
    let graph = screen.getByLabelText("Direct dependency graph for G_LOCAL");
    expect(within(graph).getByRole("heading", { name: "Predecessors (9)" })).toBeInTheDocument();
    expect(within(graph).getByText("LOCAL_DISABLED").closest(".inactive")).toBeTruthy();
    expect(within(graph).getByText("NODE_1", { exact: true })).toBeInTheDocument();
    expect(within(graph).getByText("NODE_10", { exact: true })).toBeInTheDocument();
    fireEvent.click(within(graph).getByRole("button", { name: /Fictional NODE_10.*NODE_10/ }));
    expect(screen.getByLabelText("Direct dependency graph for NODE_10")).toBeInTheDocument();
    fireEvent.click(within(screen.getByLabelText("Graph successors")).getByRole("button", { name: /Fictional dense gate.*G_LOCAL/ }));
    graph = screen.getByLabelText("Direct dependency graph for G_LOCAL");

    const connect = within(graph).getByLabelText("Select two elements for an FS link");
    fireEvent.change(within(connect).getByLabelText("Choose successor"), { target: { value: "GATE:G_NEXT" } });
    fireEvent.click(within(connect).getByRole("button", { name: "Review FS lag and justification" }));
    const form = screen.getByLabelText("FS dependency form");
    expect(within(form).getByLabelText("Predecessor ID")).toHaveValue("G_LOCAL");
    expect(within(form).getByLabelText("Successor ID")).toHaveValue("G_NEXT");
    fireEvent.change(within(form).getByLabelText("Dependency ID"), { target: { value: "LOCAL_NEXT" } });
    fireEvent.change(within(form).getByLabelText("Lag (h)"), { target: { value: "3" } });
    fireEvent.change(within(form).getByLabelText("Justification"), { target: { value: "Fictional handoff" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add dependency" }));
    expect(latest.dependencies.at(-1)).toMatchObject({ source_id: "G_LOCAL", target_id: "G_NEXT", lag_h: 3, rationale: "Fictional handoff", enabled: true });
    expect(within(screen.getByLabelText("Graph successors")).getByText("LOCAL_NEXT")).toBeInTheDocument();

    fireEvent.change(within(connect).getByLabelText("Direction"), { target: { value: "in" } });
    fireEvent.change(within(connect).getByLabelText("Choose predecessor"), { target: { value: "GATE:PROJECT_COMPLETE" } });
    fireEvent.click(within(connect).getByRole("button", { name: "Review FS lag and justification" }));
    const cycleForm = screen.getByLabelText("FS dependency form");
    fireEvent.change(within(cycleForm).getByLabelText("Dependency ID"), { target: { value: "CYCLE_ATTEMPT" } });
    fireEvent.change(within(cycleForm).getByLabelText("Justification"), { target: { value: "Fictional test" } });
    fireEvent.click(within(cycleForm).getByRole("button", { name: "Add dependency" }));
    expect(within(cycleForm).getByRole("alert")).toHaveTextContent(/dependency cycle/);
    expect(latest.dependencies.some((row) => row.dependency_id === "CYCLE_ATTEMPT")).toBe(false);
    expect(validateProject(latest).filter((issue) => issue.severity === "error")).toEqual([]);

    const highs = await loadHighs();
    const solved = solveScheduleWithHighs(highs, asSchedulingProject(latest), { horizonDays: 30, timeLimitS: 20 });
    expect(solved.optimal).toBe(true);
    expect(solved.gates.G_NEXT).toBeGreaterThanOrEqual(solved.gates.G_LOCAL + 3);
    const revision = await createWorkbookRevision(source, latest, "Fictional graph check", new Date("2030-02-03T04:05:06Z"));
    expect(revision.reimport.isValid).toBe(true);
    expect(revision.reimport.data.dependencies).toEqual(latest.dependencies);
  }, 60_000);
});
