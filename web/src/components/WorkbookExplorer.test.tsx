import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkbookExplorer } from "./WorkbookExplorer";
import type { SchedulingProject } from "../lib/scheduler/types";

const fictional: SchedulingProject = {
  metadata: { project_start: "2026-01-05T08:00:00Z" },
  systems: [{ system_id: "LOX_SYS", name: "Fictional oxidizer", arrival_date: "2026-01-05T08:00:00Z", enabled: true }],
  packages: [{ package_id: "LOX_PKG", system_id: "LOX_SYS", name: "Dry checks", enabled: true, display_order: 2 }],
  activities: [
    { activity_id: "LOX_DRY_TEST", package_id: "LOX_PKG", name: "Fictional dry test", duration_h: 2, duration_basis: "WORK_TIME", preemptible: false, enabled: true },
    { activity_id: "LOX_LEAK_TEST", package_id: "LOX_PKG", name: "Fictional leak test", duration_h: 1, duration_basis: "WORK_TIME", preemptible: false, enabled: false },
  ],
  gates: [
    { gate_id: "LOX_DRY_RELEASED", package_id: "LOX_PKG", gate_type: "RELEASE", name: "Dry released" },
    { gate_id: "NEXT_GATE", gate_type: "PROJECT_COMPLETE", name: "Next gate" },
  ],
  dependencies: [
    { dependency_id: "D_DRY", source_type: "ACTIVITY", source_id: "LOX_DRY_TEST", target_type: "GATE", target_id: "LOX_DRY_RELEASED", lag_h: 3, enabled: true },
    { dependency_id: "D_LEAK", source_type: "ACTIVITY", source_id: "LOX_LEAK_TEST", target_type: "GATE", target_id: "LOX_DRY_RELEASED", lag_h: 0, enabled: false },
    { dependency_id: "D_NEXT", source_type: "GATE", source_id: "LOX_DRY_RELEASED", target_type: "GATE", target_id: "NEXT_GATE", lag_h: 1, enabled: true },
  ],
  resources: [], activity_resources: [], resource_substitutions: [], zones: [], activity_zones: [], calendars: [], calendar_shifts: [], milestone_priorities: [],
};

describe("imported workbook explorer (fictional V1 data)", () => {
  it("searches the hierarchy by ID or name, including package and project gates", () => {
    render(<WorkbookExplorer project={fictional} />);
    const tree = screen.getByLabelText("Systems, packages, activities and gates");
    expect(within(tree).getByRole("button", { name: /Fictional oxidizer/ })).toBeInTheDocument();
    expect(within(tree).getByRole("button", { name: /Dry checks/ })).toBeInTheDocument();
    expect(within(tree).getByRole("button", { name: /Next gate/ })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search by ID or name" }), { target: { value: "LOX_DRY_RELEASED" } });
    expect(within(tree).getByRole("button", { name: /LOX_DRY_RELEASED/ })).toBeInTheDocument();
    expect(within(tree).getByRole("button", { name: /Dry checks/ })).toBeInTheDocument();
    expect(within(tree).queryByRole("button", { name: /LOX_LEAK_TEST/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search by ID or name" }), { target: { value: "fictional leak" } });
    expect(within(tree).getByRole("button", { name: /LOX_LEAK_TEST/ })).toBeInTheDocument();
  });

  it("follows the direct prerequisites of LOX_DRY_RELEASED with lag and active status", () => {
    render(<WorkbookExplorer project={fictional} />);
    const tree = screen.getByLabelText("Systems, packages, activities and gates");
    fireEvent.click(within(tree).getByRole("button", { name: /LOX_DRY_RELEASED/ }));
    expect(screen.getByRole("heading", { name: "Direct predecessors (2)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Direct successors (1)" })).toBeInTheDocument();
    expect(screen.getByText("FS · lag 3 h · Active")).toBeInTheDocument();
    expect(screen.getByText("FS · lag 0 h · Inactive")).toBeInTheDocument();
    expect(screen.getByText("FS · lag 1 h · Active")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("heading", { name: "Direct predecessors (2)" }).parentElement!).getByRole("button", { name: /Fictional dry test.*LOX_DRY_TEST/ }));
    expect(within(tree).getByRole("button", { name: /LOX_DRY_TEST/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("heading", { name: "Direct successors (1)" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Dry released.*LOX_DRY_RELEASED/ }).length).toBeGreaterThan(0);
    expect(screen.getByText(/This view does not calculate a critical path/)).toBeInTheDocument();
  });
});
