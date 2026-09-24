import type { Highs, ModelData } from "highs";
import { segmentsFromSlots } from "./calendar";
import { buildScheduleMilp } from "./milp";
import { validateSolvedSchedule } from "./verifySchedule";
import type {
  ScheduleResult,
  SchedulingProject,
  SolveOptions,
  SolveProgress,
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

export function solveScheduleWithHighs(
  highs: Highs,
  project: SchedulingProject,
  options: SolveOptions = {},
  onProgress?: (progress: SolveProgress) => void,
): ScheduleResult {
  onProgress?.({ stage: "building", message: "Building the hourly MILP…" });
  const built = buildScheduleMilp(project, options);
  const timeLimitS = options.timeLimitS ?? 120;

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
        message: `Optimizing ${label} (pass ${solveNumber})…`,
      });
      model.zeroAllClocks();
      model.run();
      const status = model.getModelStatus();
      if (status !== highs.constants.modelStatus.optimal) {
        throw new Error(`HiGHS did not prove an optimal schedule for ${label} (status ${status}).`);
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
        throw new Error(`Activity ${activityId} selected ${selected.length} execution profiles.`);
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
      projectStart: project.metadata.project_start,
      objectiveGate: built.objectiveGate,
      objectiveH: gates[built.objectiveGate],
      horizonH: built.horizonH,
      optimal: true,
      solverMessage: `HiGHS ${highs.version.string}: optimal`,
    };
    const errors = validateSolvedSchedule(project, result);
    if (errors.length > 0) throw new Error(`Post-solve validation failed: ${errors.join(" ")}`);
    return result;
  });
}

export { validateSolvedSchedule } from "./verifySchedule";
