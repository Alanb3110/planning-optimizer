import {
  ScheduleSolveError,
  solveFailureFrom,
  type ScheduleResult,
  type SchedulingProject,
  type SolveDiagnostics,
  type SolveOptions,
  type SolveProgress,
  type SolveWorkerRequest,
  type SolveWorkerResponse,
} from "./types";

export function solveScheduleInWorker(
  project: SchedulingProject,
  options: SolveOptions = {},
  onProgress?: (progress: SolveProgress) => void,
  signal?: AbortSignal,
): Promise<ScheduleResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Scheduling was cancelled.", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("../../workers/scheduler.worker.ts", import.meta.url), {
      type: "module",
      name: "ait-planning-optimizer",
    });
    let finished = false;
    let latestDiagnostics: SolveDiagnostics | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      finish();
      reject(new DOMException("Scheduling was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      finish();
      const failure = solveFailureFrom(
        new Error(event.message || "The scheduling worker failed."),
        latestDiagnostics,
      );
      reject(new ScheduleSolveError(failure.kind, failure.message, failure.diagnostics));
    };
    worker.onmessage = (event: MessageEvent<SolveWorkerResponse>) => {
      const response = event.data;
      if (response.type === "progress") {
        latestDiagnostics = response.progress.diagnostics ?? latestDiagnostics;
        onProgress?.(response.progress);
      } else if (response.type === "result") {
        finish();
        resolve(response.result);
      } else {
        finish();
        reject(new ScheduleSolveError(
          response.failure.kind,
          response.failure.message,
          response.failure.diagnostics ?? latestDiagnostics,
        ));
      }
    };
    const request: SolveWorkerRequest = { type: "solve", project, options };
    worker.postMessage(request);
  });
}
