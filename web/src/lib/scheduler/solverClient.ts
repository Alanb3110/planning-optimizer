import type {
  ScheduleResult,
  SchedulingProject,
  SolveOptions,
  SolveProgress,
  SolveWorkerRequest,
  SolveWorkerResponse,
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
      reject(new Error(event.message || "The scheduling worker failed."));
    };
    worker.onmessage = (event: MessageEvent<SolveWorkerResponse>) => {
      const response = event.data;
      if (response.type === "progress") {
        onProgress?.(response.progress);
      } else if (response.type === "result") {
        finish();
        resolve(response.result);
      } else {
        finish();
        reject(new Error(response.message));
      }
    };
    const request: SolveWorkerRequest = { type: "solve", project, options };
    worker.postMessage(request);
  });
}
