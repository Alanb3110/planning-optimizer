import loadHighs from "highs";
import highsWasmUrl from "highs/runtime?url";
import { solveScheduleWithHighs } from "../lib/scheduler/highsSolver";
import type { SolveWorkerRequest, SolveWorkerResponse } from "../lib/scheduler/types";

interface WorkerScope {
  onmessage: ((event: MessageEvent<SolveWorkerRequest>) => void) | null;
  postMessage(message: SolveWorkerResponse): void;
}

const scope = self as unknown as WorkerScope;
let runtimePromise: ReturnType<typeof loadHighs> | undefined;

scope.onmessage = async (event) => {
  if (event.data.type !== "solve") return;
  try {
    scope.postMessage({
      type: "progress",
      progress: { stage: "loading", message: "Loading the local HiGHS WebAssembly solver…" },
    });
    runtimePromise ??= loadHighs({ locateFile: () => highsWasmUrl });
    const highs = await runtimePromise;
    const result = solveScheduleWithHighs(
      highs,
      event.data.project,
      event.data.options,
      (progress) => scope.postMessage({ type: "progress", progress }),
    );
    scope.postMessage({ type: "result", result });
  } catch (error) {
    scope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "The schedule could not be calculated.",
    });
  }
};
