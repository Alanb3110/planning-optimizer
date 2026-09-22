import { type ChangeEvent, useId, useRef, useState } from "react";

type WorkbookSource = {
  kind: "local" | "example";
  name: string;
};

const EXAMPLE_NAME = "synthetic_project.xlsx";

function App() {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<WorkbookSource | null>(null);

  const handleFileSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (file) {
      setSource({ kind: "local", name: file.name });
    }
  };

  const loadExample = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    setSource({ kind: "example", name: EXAMPLE_NAME });
  };

  return (
    <main className="app-shell">
      <section className="hero" aria-labelledby="page-title">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="eyebrow">Browser-based scheduling workspace</p>
        <h1 id="page-title">AIT Planning Optimizer</h1>
        <p className="intro">
          Start with a local Excel workbook or the fictitious example. Scheduling
          capabilities will be added incrementally.
        </p>

        <div className="privacy-note" role="note">
          <span className="privacy-dot" aria-hidden="true" />
          <div>
            <strong>Local processing only</strong>
            <span>Your workbook is not uploaded or sent to a server.</span>
          </div>
        </div>
      </section>

      <section className="import-card" aria-labelledby="import-title">
        <div className="card-heading">
          <div>
            <p className="step-label">Step 01</p>
            <h2 id="import-title">Choose a workbook</h2>
          </div>
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
        />

        <label className="file-picker" htmlFor={inputId}>
          <span className="upload-icon" aria-hidden="true">↑</span>
          <span>
            <strong>Select a local .xlsx file</strong>
            <small>The workbook remains in this browser session.</small>
          </span>
          <span className="browse-label">Browse</span>
        </label>

        <div className="separator" aria-hidden="true">
          <span>or</span>
        </div>

        <button className="example-button" type="button" onClick={loadExample}>
          Load synthetic example
        </button>

        <div className="selection-status" aria-live="polite">
          {source ? (
            <>
              <span className="status-check" aria-hidden="true">✓</span>
              <div>
                <strong>{source.name}</strong>
                <span>
                  {source.kind === "example" ? "Synthetic example" : "Local workbook"} ready.
                  Parsing is not enabled yet.
                </span>
              </div>
            </>
          ) : (
            <span>No workbook selected.</span>
          )}
        </div>
      </section>
    </main>
  );
}

export default App;
