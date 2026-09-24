import { importWorkbook } from "../lib/workbookImport";
import { validateProject } from "../lib/validation";
import type { SchedulingProject, SolveOptions } from "../lib/scheduler/types";

declare global { interface Window { benchmarkResult?: unknown } }
const input = document.querySelector<HTMLInputElement>("#workbook")!;
const button = document.querySelector<HTMLButtonElement>("#run")!;
const status = document.querySelector<HTMLElement>("#status")!;

button.onclick = async () => {
  button.disabled = true;
  window.benchmarkResult = undefined;
  const file = input.files?.[0];
  if (!file || !/^fiction_(20|50|100)_seed_\d+\.xlsx$/.test(file.name)) {
    status.textContent = "Select a generated fictional workbook.";
    button.disabled = false;
    return;
  }
  const started = performance.now();
  let lastTick = started;
  let maxHeartbeatDelayMs = 0;
  let heartbeatCount = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxHeartbeatDelayMs = Math.max(maxHeartbeatDelayMs, now - lastTick - 50);
    lastTick = now;
    heartbeatCount++;
  }, 50);
  let worker: Worker | undefined;
  try {
    const bytes = await file.arrayBuffer();
    const importStart = performance.now();
    const imported = await importWorkbook(bytes, file.name);
    const importMs = performance.now() - importStart; // Includes the importer's built-in validation.
    if (!imported.isValid) throw new Error(`Import invalid: ${JSON.stringify(imported.issues.filter(x => x.severity === "error").slice(0, 5))}`);
    const validationStart = performance.now();
    const validationErrors = validateProject(imported.data).filter(x => x.severity === "error");
    const validationMs = performance.now() - validationStart;
    if (validationErrors.length) throw new Error(`Independent validation: ${JSON.stringify(validationErrors.slice(0, 5))}`);
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const options: SolveOptions = { horizonDays: 7, timeLimitS: 30 };
    const report = await new Promise<Record<string, unknown>>((resolve, reject) => {
      worker!.onmessage = (event: MessageEvent<Record<string, unknown>>) => resolve(event.data);
      worker!.onerror = (event) => reject(new Error(event.message));
      worker!.postMessage({ project: imported.data as SchedulingProject, options });
    });
    window.benchmarkResult = {
      file: file.name, activities: imported.summary.activities, importMs, validationMs,
      ...report, wallMs: performance.now() - started,
      maxHeartbeatDelayMs, heartbeatCount,
    };
    status.textContent = JSON.stringify(window.benchmarkResult, null, 2);
  } catch (error) {
    window.benchmarkResult = { file: file?.name, failure: String(error), wallMs: performance.now() - started };
    status.textContent = JSON.stringify(window.benchmarkResult, null, 2);
  } finally {
    worker?.terminate();
    clearInterval(heartbeat);
    button.disabled = false;
  }
};
