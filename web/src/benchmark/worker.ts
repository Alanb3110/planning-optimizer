import loadHighs from "highs";
import highsWasmUrl from "highs/runtime?url";
import type { Highs } from "highs";
import { buildScheduleMilp } from "../lib/scheduler/milp";
import { solveScheduleWithHighs } from "../lib/scheduler/highsSolver";
import type { SchedulingProject, SolveOptions } from "../lib/scheduler/types";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ project: SchedulingProject; options: SolveOptions }>) => void) | null;
  postMessage(value: unknown): void;
};
scope.onmessage = async (event: MessageEvent<{ project: SchedulingProject; options: SolveOptions }>) => {
  const { project, options } = event.data;
  const report: Record<string, unknown> = { passes: [] };
  try {
    const buildStart = performance.now();
    const built = buildScheduleMilp(project, options);
    report.buildMs = performance.now() - buildStart;
    report.horizonH = built.horizonH;
    report.variables = built.model.numCols;
    report.rows = built.model.numRows;
    report.coefficients = built.model.matrix.values.length;
    const loadStart = performance.now();
    const highs = await loadHighs({ locateFile: () => highsWasmUrl });
    report.wasmLoadMs = performance.now() - loadStart;
    report.highsVersion = highs.version.string;
    const passStatuses = Object.fromEntries(Object.entries(highs.constants.modelStatus)
      .map(([key, value]) => [String(value), key]));
    const passes: Array<{ pass: number; durationMs: number; status: string; objective: number | null }> = [];
    report.passes = passes;
    // Wrap the library boundary only. The solver, MILP and optimization calls stay untouched.
    const instrumented = new Proxy(highs, {
      get(target, key) {
        if (key !== "withModel") return Reflect.get(target, key, target);
        return (data: unknown, callback: (model: unknown) => unknown) => target.withModel(
          data as Parameters<Highs["withModel"]>[0],
          (model) => {
            const measured = new Proxy(model, {
              get(actual, property) {
                if (property === "run") return () => {
                  const start = performance.now();
                  const outcome = actual.run();
                  const code = actual.getModelStatus();
                  passes.push({ pass: passes.length + 1, durationMs: performance.now() - start,
                    status: passStatuses[String(code)] ?? String(code),
                    objective: code === highs.constants.modelStatus.optimal ? actual.getObjectiveValue() : null });
                  return outcome;
                };
                const value: unknown = Reflect.get(actual, property, actual);
                return typeof value === "function" ? value.bind(actual) : value;
              },
            });
            return callback(measured);
          },
        );
      },
    });
    const solveStart = performance.now();
    try {
      const result = solveScheduleWithHighs(instrumented, project, options);
      report.outcome = "proven_optimal";
      report.objectiveH = result.objectiveH;
    } catch (error) {
      report.error = String(error);
      const last = passes.at(-1)?.status ?? "";
      report.outcome = last === "infeasible" ? "proven_infeasible"
        : /timeLimit|time_limit|limit/i.test(last) ? "time_limit_without_proof" : "error_or_unproven";
    }
    report.solveMs = performance.now() - solveStart; // Includes the solver's own second MILP build.
  } catch (error) {
    report.outcome = "error_or_unproven";
    report.error = String(error);
  }
  scope.postMessage(report);
};
