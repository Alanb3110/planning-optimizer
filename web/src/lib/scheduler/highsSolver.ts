import type { Highs, ModelData } from "highs";
import { segmentsFromSlots } from "./calendar";
import { buildScheduleMilp, type BuiltScheduleMilp } from "./milp";
import { validateSolvedSchedule } from "./verifySchedule";
import {
  ScheduleSolveError,
  formatSolveDiagnostics,
  solveFailureFrom,
  type ScheduleResult,
  type SchedulingProject,
  type SolveDiagnostics,
  type SolveOptions,
  type SolveProgress,
} from "./types";

function objectiveSetter(model: ReturnType<Highs["createModel"]>) {
  let current = new Map<number, number>();
  return (next: Map<number, number>) => {
    for (const [variable] of current) {
      if (!next.has(variable)) model.changeColCost(variable, 0);
    }
    for (const [variable, cost] of next) {
      if (current.get(variable) !== cost) model.changeColCost(variable, cost);
    }
    current = next;
  };
}

function modelStatusName(highs: Highs, status: number): string {
  return Object.entries(highs.constants.modelStatus)
    .find(([, value]) => Number(value) === status)?.[0] ?? String(status);
}

function normalizedStatusName(name: string): string {
  return name.replace(/^k/i, "").replace(/[_\s-]/g, "").toLowerCase();
}

function statusFailureKind(name: string): "infeasible" | "not-proven" | "model-error" | "potential-model-size" {
  const normalized = normalizedStatusName(name);
  if (normalized === "infeasible") return "infeasible";
  if (normalized === "memorylimit") return "potential-model-size";
  if (["loaderror", "modelerror", "presolveerror", "solveerror", "postsolveerror"].includes(normalized)) {
    return "model-error";
  }
  return "not-proven";
}

function asScheduleSolveError(error: unknown, diagnostics: SolveDiagnostics): ScheduleSolveError {
  const failure = solveFailureFrom(error, diagnostics);
  return new ScheduleSolveError(failure.kind, failure.message, failure.diagnostics);
}

export function solveBuiltScheduleWithHighs(
  highs: Highs,
  built: BuiltScheduleMilp,
  options: SolveOptions = {},
  onProgress?: (progress: SolveProgress) => void,
): ScheduleResult {
  const timeLimitS = options.timeLimitS ?? 120;

  try {
    return highs.withModel(built.model as ModelData, (model) => {
      model.options.set({
        output_flag: false,
        presolve: "on",
        mip_rel_gap: 1e-4,
        time_limit: timeLimitS,
      });
      const setObjective = objectiveSetter(model);
      let solveNumber = 0;
      const solveOptimal = (label: string) => {
        solveNumber += 1;
        onProgress?.({
          stage: "optimizing",
          message: `Optimizing ${label} (pass ${solveNumber}/${built.diagnostics.optimizationPasses})…`,
          diagnostics: built.diagnostics,
        });
        model.zeroAllClocks();
        model.run();
        const status = Number(model.getModelStatus());
        if (status !== Number(highs.constants.modelStatus.optimal)) {
          const statusName = modelStatusName(highs, status);
          const kind = statusFailureKind(statusName);
          if (kind === "infeasible") {
            throw new ScheduleSolveError(
              kind,
              `HiGHS proved the model infeasible while optimizing ${label} (status ${statusName}, code ${status}).`,
              built.diagnostics,
            );
          }
          if (kind === "potential-model-size") {
            throw new ScheduleSolveError(
              kind,
              `HiGHS reached its memory limit while optimizing ${label} (status ${statusName}, code ${status}). The model may be too large for the available solver memory, but infeasibility is not established. Model diagnostics: ${formatSolveDiagnostics(built.diagnostics)}. The size estimate excludes HiGHS/WASM internal structures and copies.`,
              built.diagnostics,
            );
          }
          if (kind === "model-error") {
            throw new ScheduleSolveError(
              kind,
              `HiGHS reported a model/solver processing error while optimizing ${label} (status ${statusName}, code ${status}).`,
              built.diagnostics,
            );
          }
          throw new ScheduleSolveError(
            kind,
            `HiGHS did not prove an optimal schedule for ${label} (status ${statusName}, code ${status}). This is not an infeasibility proof.`,
            built.diagnostics,
          );
        }
        return model.getSolution().colValue;
      };

      let solution: Float64Array<ArrayBufferLike> = new Float64Array(built.model.numCols);
      for (const priority of built.milestonePriorities) {
        const gateVariable = built.gateVariables[priority.gate_id];
        setObjective(new Map([[gateVariable, 1]]));
        solution = solveOptimal(priority.gate_id);
        const optimum = Math.round(solution[gateVariable]);
        model.changeColBounds(gateVariable, optimum, optimum);
      }

      const compactness = new Map<number, number>();
      for (const variable of Object.values(built.endVariables)) compactness.set(variable, 1);
      for (const variable of Object.values(built.gateVariables)) compactness.set(variable, 0.1);
      setObjective(compactness);
      solution = solveOptimal("schedule compactness");

      const activities: ScheduleResult["activities"] = {};
      for (const [activityId, choices] of Object.entries(built.executionChoices)) {
        const selected = choices.filter(({ variable }) => solution[variable] > 0.5);
        if (selected.length !== 1) {
          throw new ScheduleSolveError(
            "model-error",
            `Activity ${activityId} selected ${selected.length} execution profiles.`,
            built.diagnostics,
          );
        }
        const workSlots = [...selected[0].slots].sort((left, right) => left - right);
        activities[activityId] = {
          activityId,
          startH: workSlots[0],
          endH: workSlots.at(-1)! + 1,
          workSlots,
          segments: segmentsFromSlots(workSlots),
        };
      }
      const gates = Object.fromEntries(
        Object.entries(built.gateVariables).map(([gateId, variable]) => [gateId, Math.round(solution[variable])]),
      );
      const result: ScheduleResult = {
        activities,
        gates,
        projectStart: built.project.metadata.project_start,
        objectiveGate: built.objectiveGate,
        objectiveH: gates[built.objectiveGate],
        horizonH: built.horizonH,
        optimal: true,
        solverMessage: `HiGHS ${highs.version.string}: optimal`,
        diagnostics: built.diagnostics,
      };
      const errors = validateSolvedSchedule(built.project, result);
      if (errors.length > 0) {
        throw new ScheduleSolveError(
          "model-error",
          `Post-solve validation failed: ${errors.join(" ")}`,
          built.diagnostics,
        );
      }
      return result;
    });
  } catch (error) {
    if (error instanceof ScheduleSolveError) throw error;
    throw asScheduleSolveError(error, built.diagnostics);
  }
}

export function solveScheduleWithHighs(
  highs: Highs,
  project: SchedulingProject,
  options: SolveOptions = {},
  onProgress?: (progress: SolveProgress) => void,
): ScheduleResult {
  onProgress?.({ stage: "building", message: "Building the hourly MILP…" });
  let built: BuiltScheduleMilp;
  try {
    built = buildScheduleMilp(project, options);
  } catch (error) {
    throw new ScheduleSolveError(
      "model-error",
      error instanceof Error ? error.message : "The scheduling model could not be built.",
    );
  }
  onProgress?.({
    stage: "building",
    message: `Built hourly MILP: ${formatSolveDiagnostics(built.diagnostics)}.`,
    diagnostics: built.diagnostics,
  });
  return solveBuiltScheduleWithHighs(highs, built, options, onProgress);
}

export { validateSolvedSchedule } from "./verifySchedule";
