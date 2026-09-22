import { type ChangeEvent, useId, useRef, useState } from "react";
import type { ValidationIssue, WorkbookImportResult } from "./lib/model";
import { importWorkbook } from "./lib/workbookImport";

const EXAMPLE_NAME = "synthetic_project.xlsx";

function issueTitle(issue: ValidationIssue) {
  return issue.location ? `${issue.location}: ${issue.message}` : issue.message;
}

function App() {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<WorkbookImportResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const processWorkbook = async (source: Blob | ArrayBuffer, fileName: string) => {
    setIsLoading(true);
    setLoadError(null);
    try {
      setResult(await importWorkbook(source, fileName));
    } catch (error) {
      setResult(null);
      setLoadError(error instanceof Error ? error.message : "The workbook could not be processed.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileSelection = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) await processWorkbook(file, file.name);
  };

  const loadExample = async () => {
    if (fileInputRef.current) fileInputRef.current.value = "";
    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}${EXAMPLE_NAME}`, {
        method: "GET",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`Could not load the synthetic example (${response.status}).`);
      setResult(await importWorkbook(await response.arrayBuffer(), EXAMPLE_NAME));
    } catch (error) {
      setResult(null);
      setLoadError(error instanceof Error ? error.message : "The synthetic example could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  };

  const clearLocalData = () => {
    setResult(null);
    setLoadError(null);
    setIsLoading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const errors = result?.issues.filter((issue) => issue.severity === "error") ?? [];
  const warnings = result?.issues.filter((issue) => issue.severity === "warning") ?? [];

  return (
    <main className="app-shell">
      <section className="hero" aria-labelledby="page-title">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <p className="eyebrow">Browser-based scheduling workspace</p>
        <h1 id="page-title">AIT Planning Optimizer</h1>
        <p className="intro">
          Import and check an AIT planning workbook before scheduling. Validation runs in
          this browser.
        </p>
        <div className="privacy-note" role="note">
          <span className="privacy-dot" aria-hidden="true" />
          <div>
            <strong>Local processing only</strong>
            <span>Your workbook is not uploaded, persisted, or sent to an external API.</span>
          </div>
        </div>
      </section>

      <section className="workspace" aria-label="Workbook import and validation">
        <section className="import-card" aria-labelledby="import-title">
          <div className="card-heading">
            <div><p className="step-label">Import</p><h2 id="import-title">Choose a workbook</h2></div>
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
            disabled={isLoading}
          />
          <label className={`file-picker${isLoading ? " disabled" : ""}`} htmlFor={inputId}>
            <span className="upload-icon" aria-hidden="true">↑</span>
            <span>
              <strong>Select a local .xlsx file</strong>
              <small>The source file remains in this browser session.</small>
            </span>
            <span className="browse-label">Browse</span>
          </label>

          <div className="separator" aria-hidden="true"><span>or</span></div>
          <button className="example-button" type="button" onClick={loadExample} disabled={isLoading}>
            Load synthetic example
          </button>

          <div className="action-row">
            <span className="session-note">No automatic browser storage</span>
            <button
              className="clear-button"
              type="button"
              onClick={clearLocalData}
              disabled={!result && !loadError && !isLoading}
            >
              Clear local data
            </button>
          </div>

          <div className="selection-status" aria-live="polite">
            {isLoading ? (
              <><span className="spinner" aria-hidden="true" /><span>Reading and validating workbook…</span></>
            ) : loadError ? (
              <><span className="status-symbol error" aria-hidden="true">!</span><span>{loadError}</span></>
            ) : result ? (
              <>
                <span className={`status-symbol ${result.isValid ? "valid" : "error"}`} aria-hidden="true">
                  {result.isValid ? "✓" : "!"}
                </span>
                <div>
                  <strong>{result.fileName}</strong>
                  <span>
                    {result.isValid
                      ? `Accepted with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`
                      : `Rejected with ${errors.length} error${errors.length === 1 ? "" : "s"}.`}
                  </span>
                </div>
              </>
            ) : <span>No workbook selected.</span>}
          </div>
        </section>

        {result && (
          <section className="results" aria-label="Validation results">
            <div className="summary-grid" aria-label="Workbook summary">
              {Object.entries(result.summary).map(([label, value]) => (
                <div className="summary-card" key={label}><span>{label}</span><strong>{value}</strong></div>
              ))}
            </div>
            <div className={`validation-banner ${result.isValid ? "valid" : "invalid"}`}>
              <strong>{result.isValid ? "Workbook accepted" : "Workbook rejected"}</strong>
              <span>{errors.length} errors · {warnings.length} warnings</span>
            </div>

            {errors.length > 0 && (
              <section className="issue-group" aria-labelledby="errors-title">
                <h3 id="errors-title">Errors</h3>
                <ul>{errors.map((validationIssue, index) => (
                  <li key={`${validationIssue.code}-${index}`}>
                    <code>{validationIssue.code}</code><span>{issueTitle(validationIssue)}</span>
                  </li>
                ))}</ul>
              </section>
            )}
            {warnings.length > 0 && (
              <section className="issue-group warnings" aria-labelledby="warnings-title">
                <h3 id="warnings-title">Warnings</h3>
                <ul>{warnings.map((validationIssue, index) => (
                  <li key={`${validationIssue.code}-${index}`}>
                    <code>{validationIssue.code}</code><span>{issueTitle(validationIssue)}</span>
                  </li>
                ))}</ul>
              </section>
            )}
          </section>
        )}
      </section>
    </main>
  );
}

export default App;
