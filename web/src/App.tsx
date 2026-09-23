import { type ChangeEvent, useEffect, useId, useRef, useState } from "react";
import { ScheduleResults } from "./components/ScheduleResults";
import { WorkbookExplorer } from "./components/WorkbookExplorer";
import type { RunSettings } from "./lib/exports";
import { fetchLocalArrayBuffer } from "./lib/localAsset";
import type { ValidationIssue, WorkbookImportResult } from "./lib/model";
import { solveScheduleInWorker } from "./lib/scheduler/solverClient";
import { asSchedulingProject, type ScheduleResult, type SolveProgress } from "./lib/scheduler/types";
import { importWorkbook } from "./lib/workbookImport";

const EXAMPLE_NAME = "synthetic_project.xlsx";

function issueTitle(issue: ValidationIssue) {
  return issue.location ? `${issue.location}: ${issue.message}` : issue.message;
}

function errorKind(message: string): "infeasible" | "error" {
  const normalized = message.toLowerCase();
  return normalized.includes("infeasible") ||
    normalized.includes("no feasible execution profile") ||
    /status (8|9)\b/.test(normalized)
    ? "infeasible"
    : "error";
}

function App() {
  const inputId = useId();
  const horizonId = useId();
  const timeLimitId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<WorkbookImportResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleResult | null>(null);
  const [isSolving, setIsSolving] = useState(false);
  const [solveProgress, setSolveProgress] = useState<SolveProgress | null>(null);
  const [solveError, setSolveError] = useState<string | null>(null);
  const [solveDurationMs, setSolveDurationMs] = useState<number | null>(null);
  const [lastRunSettings, setLastRunSettings] = useState<RunSettings | null>(null);
  const [horizonDays, setHorizonDays] = useState("0");
  const [timeLimitS, setTimeLimitS] = useState("120");
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const solveAbortRef = useRef<AbortController | null>(null);
  const importGenerationRef = useRef(0);

  const resetSchedule = () => {
    solveAbortRef.current?.abort();
    solveAbortRef.current = null;
    setSchedule(null);
    setIsSolving(false);
    setSolveProgress(null);
    setSolveError(null);
    setSolveDurationMs(null);
    setLastRunSettings(null);
  };

  useEffect(() => () => {
    importGenerationRef.current += 1;
    solveAbortRef.current?.abort();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => { delete document.documentElement.dataset.theme; };
  }, [theme]);

  const beginImport = () => {
    const generation = ++importGenerationRef.current;
    resetSchedule();
    setResult(null);
    setIsLoading(true);
    setLoadError(null);
    return generation;
  };

  const processWorkbook = async (source: Blob | ArrayBuffer, fileName: string) => {
    const generation = beginImport();
    try {
      const imported = await importWorkbook(source, fileName);
      if (generation === importGenerationRef.current) setResult(imported);
    } catch (error) {
      if (generation === importGenerationRef.current) {
        setLoadError(error instanceof Error ? error.message : "The workbook could not be processed.");
      }
    } finally {
      if (generation === importGenerationRef.current) setIsLoading(false);
    }
  };

  const handleFileSelection = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) await processWorkbook(file, file.name);
  };

  const loadExample = async () => {
    const generation = beginImport();
    if (fileInputRef.current) fileInputRef.current.value = "";
    try {
      const workbook = await fetchLocalArrayBuffer(`${import.meta.env.BASE_URL}${EXAMPLE_NAME}`);
      if (generation !== importGenerationRef.current) return;
      const imported = await importWorkbook(workbook, EXAMPLE_NAME);
      if (generation === importGenerationRef.current) setResult(imported);
    } catch (error) {
      if (generation === importGenerationRef.current) {
        setLoadError(error instanceof Error ? error.message : "The synthetic example could not be loaded.");
      }
    } finally {
      if (generation === importGenerationRef.current) setIsLoading(false);
    }
  };

  const clearLocalData = () => {
    importGenerationRef.current += 1;
    resetSchedule();
    setResult(null);
    setLoadError(null);
    setIsLoading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const horizonValue = Number(horizonDays);
  const timeLimitValue = Number(timeLimitS);
  const horizonValid = Number.isInteger(horizonValue) && horizonValue >= 0;
  const timeLimitValid = Number.isFinite(timeLimitValue) && timeLimitValue > 0;
  const settingsValid = horizonValid && timeLimitValid;

  const calculateSchedule = async () => {
    if (!result?.isValid || isSolving || !settingsValid) return;
    resetSchedule();
    const controller = new AbortController();
    const startedAt = performance.now();
    solveAbortRef.current = controller;
    setIsSolving(true);
    setSolveProgress({ stage: "loading", message: "Starting the local scheduling worker…" });
    try {
      const nextSchedule = await solveScheduleInWorker(
        asSchedulingProject(result.data),
        {
          horizonDays: horizonValue === 0 ? undefined : horizonValue,
          timeLimitS: timeLimitValue,
        },
        setSolveProgress,
        controller.signal,
      );
      setSchedule(nextSchedule);
      setSolveDurationMs(performance.now() - startedAt);
      setLastRunSettings({ horizonDays: horizonValue, timeLimitS: timeLimitValue });
      setSolveProgress(null);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setSolveError(error instanceof Error ? error.message : "The schedule could not be calculated.");
      }
    } finally {
      if (solveAbortRef.current === controller) solveAbortRef.current = null;
      setIsSolving(false);
    }
  };

  const cancelSolve = () => {
    solveAbortRef.current?.abort();
    solveAbortRef.current = null;
    setIsSolving(false);
    setSolveProgress(null);
  };

  const errors = result?.issues.filter((issue) => issue.severity === "error") ?? [];
  const warnings = result?.issues.filter((issue) => issue.severity === "warning") ?? [];
  const project = result?.isValid ? asSchedulingProject(result.data) : null;
  const currentErrorKind = solveError ? errorKind(solveError) : null;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div><span className="product-code">AIT / SCHEDULING</span><h1>AIT Planning Optimizer</h1><small className="build-version">Version {import.meta.env.VITE_BUILD_COMMIT || "dev"}</small></div>
        </div>
        <div className="header-actions">
          <div className="privacy-note" role="note">
            <span className="privacy-dot" aria-hidden="true" />
            <div><strong>Local processing only</strong><span>No upload · no persistence · no external API</span></div>
          </div>
          <button className="theme-toggle" type="button" aria-pressed={theme === "dark"} onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
            {theme === "light" ? "Dark theme" : "Light theme"}
          </button>
        </div>
      </header>

      <section className="control-deck" aria-label="Planning controls">
        <section className="control-panel import-panel" aria-labelledby="import-title">
          <div className="panel-heading">
            <div><span className="step-index">01</span><h2 id="import-title">Workbook</h2></div>
            <span className="file-type">.xlsx</span>
          </div>
          <input
            ref={fileInputRef}
            id={inputId}
            className="visually-hidden"
            type="file"
            aria-label="Select a local .xlsx file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={handleFileSelection}
            disabled={isSolving}
          />
          <div className="import-actions">
            <label className={`file-picker${isSolving ? " disabled" : ""}`} htmlFor={inputId}>
              <span className="upload-icon" aria-hidden="true">↑</span>
              <span><strong>Select local workbook</strong><small>Read in this browser session</small></span>
              <span className="browse-label">Browse</span>
            </label>
            <span className="or-label" aria-hidden="true">OR</span>
            <button className="secondary-button" type="button" onClick={loadExample} disabled={isSolving}>
              Load synthetic example
            </button>
          </div>
          <div className="selection-status" aria-live="polite">
            {isLoading ? (
              <><span className="spinner" aria-hidden="true" /><span><strong>Validating workbook</strong><small>Reading sheets and checking the V1 model…</small></span></>
            ) : loadError ? (
              <><span className="status-symbol error" aria-hidden="true">!</span><span><strong>Import failed</strong><small>{loadError}</small></span></>
            ) : result ? (
              <>
                <span className={`status-symbol ${result.isValid ? "valid" : "error"}`} aria-hidden="true">{result.isValid ? "✓" : "!"}</span>
                <span><strong>{result.fileName}</strong><small>{result.isValid ? `Validated · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : `Rejected · ${errors.length} error${errors.length === 1 ? "" : "s"}`}</small></span>
              </>
            ) : <span className="empty-selection"><strong>No workbook loaded</strong><small>Select a V1 workbook or use the synthetic example.</small></span>}
            <button className="text-button" type="button" onClick={clearLocalData} disabled={!result && !loadError && !isLoading}>Clear local data</button>
          </div>
        </section>

        <section className="control-panel settings-panel" aria-labelledby="settings-title">
          <div className="panel-heading"><div><span className="step-index">02</span><h2 id="settings-title">Solver settings</h2></div><span className="local-badge">LOCAL WASM</span></div>
          <div className="settings-grid">
            <label htmlFor={horizonId}>
              <span>Planning horizon</span>
              <span className="number-input"><input id={horizonId} aria-label="Planning horizon" type="number" min="0" step="1" inputMode="numeric" value={horizonDays} onChange={(event) => setHorizonDays(event.target.value)} disabled={isSolving} aria-describedby={`${horizonId}-hint`} aria-invalid={!horizonValid} /><b>days</b></span>
              <small id={`${horizonId}-hint`}>{horizonValid ? (horizonValue === 0 ? "0 = automatically estimated" : `${horizonValue * 24} hourly slots`) : "Enter zero or a positive whole number."}</small>
            </label>
            <label htmlFor={timeLimitId}>
              <span>Solver time limit</span>
              <span className="number-input"><input id={timeLimitId} aria-label="Solver time limit" type="number" min="1" step="1" inputMode="numeric" value={timeLimitS} onChange={(event) => setTimeLimitS(event.target.value)} disabled={isSolving} aria-describedby={`${timeLimitId}-hint`} aria-invalid={!timeLimitValid} /><b>sec</b></span>
              <small id={`${timeLimitId}-hint`}>{timeLimitValid ? "Maximum time for each optimization pass" : "Enter a value greater than zero."}</small>
            </label>
          </div>
          <div className="solve-actions">
            <button className="primary-button" type="button" onClick={calculateSchedule} disabled={!result?.isValid || !settingsValid || isSolving}>
              {isSolving ? <><span className="button-spinner" aria-hidden="true" /> Calculating schedule…</> : schedule ? "Recalculate schedule" : "Calculate schedule"}
            </button>
            {isSolving && <button className="cancel-button" type="button" onClick={cancelSolve}>Cancel</button>}
          </div>
          {isSolving && (
            <div className="progress-state" role="status" aria-live="polite">
              <div className="progress-track"><span /></div>
              <div><strong>{solveProgress?.stage === "optimizing" ? "Optimizing" : solveProgress?.stage === "building" ? "Building model" : "Loading solver"}</strong><span>{solveProgress?.message}</span></div>
            </div>
          )}
        </section>
      </section>

      {result && (
        <section className="validation-strip" aria-label="Workbook validation summary">
          <div className={`validation-state ${result.isValid ? "valid" : "invalid"}`}><span aria-hidden="true">{result.isValid ? "✓" : "!"}</span><div><strong>{result.isValid ? "Workbook accepted" : "Workbook rejected"}</strong><small>{errors.length} errors · {warnings.length} warnings</small></div></div>
          <div className="model-counts" aria-label="Workbook entity counts">
            {Object.entries(result.summary).map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}
          </div>
        </section>
      )}

      {(errors.length > 0 || warnings.length > 0) && (
        <section className="issues-panel" aria-label="Validation issues">
          {errors.length > 0 && <IssueGroup title="Errors" issues={errors} />}
          {warnings.length > 0 && <IssueGroup title="Warnings" issues={warnings} warning />}
        </section>
      )}

      {project && <WorkbookExplorer key={importGenerationRef.current} project={project} />}

      <section className="output-panel" aria-label="Schedule output">
        {!result && !loadError && !isLoading && (
          <div className="empty-state"><span className="state-code">WAITING FOR INPUT</span><h2>Schedule output</h2><p>Load a workbook to validate the model and enable local optimization.</p><div className="empty-grid" aria-hidden="true"><span /><span /><span /><span /></div></div>
        )}
        {result && !result.isValid && (
          <div className="terminal-state invalid"><span className="state-icon" aria-hidden="true">!</span><div><span className="state-code">VALIDATION BLOCKED</span><h2>Resolve workbook errors before solving</h2><p>The source model remains in memory so you can review the issues above or select a corrected file.</p></div></div>
        )}
        {result?.isValid && !schedule && !isSolving && !solveError && (
          <div className="terminal-state ready"><span className="state-icon" aria-hidden="true">✓</span><div><span className="state-code">MODEL READY</span><h2>Ready to calculate</h2><p>Review the horizon and time limit, then run HiGHS locally in the scheduling Worker.</p></div></div>
        )}
        {result?.isValid && isSolving && (
          <div className="terminal-state solving"><span className="large-spinner" aria-hidden="true" /><div><span className="state-code">SOLVER ACTIVE</span><h2>Calculating the optimized schedule</h2><p>{solveProgress?.message ?? "Preparing the scheduling model…"}</p></div></div>
        )}
        {result?.isValid && solveError && (
          <div className={`terminal-state ${currentErrorKind}`} role="alert"><span className="state-icon" aria-hidden="true">{currentErrorKind === "infeasible" ? "∅" : "!"}</span><div><span className="state-code">{currentErrorKind === "infeasible" ? "NO FEASIBLE SCHEDULE" : "SOLVER ERROR"}</span><h2>{currentErrorKind === "infeasible" ? "The model is infeasible within these settings" : "The schedule could not be calculated"}</h2><p>{solveError}</p><button className="secondary-button retry-button" type="button" onClick={calculateSchedule}>Try again</button></div></div>
        )}
        {project && schedule && result && lastRunSettings && (
          <ScheduleResults
            project={project}
            result={schedule}
            validation={result}
            settings={lastRunSettings}
            solveDurationMs={solveDurationMs}
          />
        )}
      </section>
    </main>
  );
}

function IssueGroup({ title, issues, warning = false }: { title: string; issues: ValidationIssue[]; warning?: boolean }) {
  const titleId = `${title.toLowerCase()}-title`;
  return (
    <section className={`issue-group${warning ? " warnings" : ""}`} aria-labelledby={titleId}>
      <h3 id={titleId}>{title} <span>{issues.length}</span></h3>
      <ul>{issues.map((issue, index) => <li key={`${issue.code}-${index}`}><code>{issue.code}</code><span>{issueTitle(issue)}</span></li>)}</ul>
    </section>
  );
}

export default App;
export { errorKind };
