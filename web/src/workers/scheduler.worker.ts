import loadHighs from "highs";
import highsWasmUrl from "highs/runtime?url";
import { solveBuiltScheduleWithHighs } from "../lib/scheduler/highsSolver";
import { buildScheduleMilp, type BuiltScheduleMilp } from "../lib/scheduler/milp";
import {
  ScheduleSolveError,
  formatSolveDiagnostics,
  solveFailureFrom,
  type SolveDiagnostics,
  type SolveWorkerRequest,
  type SolveWorkerResponse,
} from "../lib/scheduler/types";

interface WorkerScope {
  onmessage: ((event: MessageEvent<SolveWorkerRequest>) => void) | null;
  postMessage(message: SolveWorkerResponse): void;
}

const scope = self as unknown as WorkerScope;
let runtimePromise: ReturnType<typeof loadHighs> | undefined;

scope.onmessage = async (event) => {
  if (event.data.type !== "solve") return;
  let diagnostics: SolveDiagnostics | undefined;
  try {
    scope.postMessage({
      type: "progress",
      progress: { stage: "building", message: "Building the hourly MILP before loading HiGHS…" },
    });
    let built: BuiltScheduleMilp;
    try {
      built = buildScheduleMilp(event.data.project, event.data.options);
    } catch (error) {
      throw new ScheduleSolveError(
        "model-error",
        error instanceof Error ? error.message : "The scheduling model could not be built.",
      );
    }
    diagnostics = built.diagnostics;
    scope.postMessage({
      type: "progress",
      progress: {
        stage: "building",
        message: `Built hourly MILP: ${formatSolveDiagnostics(diagnostics)}.`,
        diagnostics,
      },
    });
    scope.postMessage({
      type: "progress",
      progress: {
        stage: "loading",
        message: "Loading the local HiGHS WebAssembly solver…",
        diagnostics,
      },
    });
    runtimePromise ??= loadHighs({ locateFile: () => highsWasmUrl });
    const highs = await runtimePromise;
    const result = solveBuiltScheduleWithHighs(
      highs,
      built,
      event.data.options,
      (progress) => scope.postMessage({ type: "progress", progress }),
    );
    scope.postMessage({ type: "result", result });
  } catch (error) {
    scope.postMessage({
      type: "error",
      failure: solveFailureFrom(error, diagnostics),
    });
  }
};
