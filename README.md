# AIT Planning Optimizer

AIT Planning Optimizer is a static, browser-only application for validating and scheduling AIT and launch-site integration projects. It imports a V1 `.xlsx` workbook, validates the normalized model, solves the hourly MILP with HiGHS WebAssembly in a Web Worker, and displays Activity and Gate results.

The Python prototype remains in this repository as a development reference and regression oracle. End users do not need Python or a backend service.

## Browser application

Implemented capabilities include:

- local `.xlsx` import and a fictitious synthetic example;
- JSON Schema and semantic validation;
- System arrivals, early enablers, Finish-to-Start dependencies and elapsed lags;
- `WORK_TIME` and `ELAPSED_TIME` Activities;
- preemptible and non-preemptible execution;
- Activity, Resource and Zone calendars;
- Resource and Zone capacities and Zone exclusivity;
- zero-duration Gates and lexicographic milestone priorities;
- local HiGHS WebAssembly optimization in a Worker;
- Activity Gantt, Activity table and Gate table;
- an Activity date-inspection view with incoming FS lags, system arrival, applicable calendars, recorded capacity occupancy and reachable downstream Gates;
- local ZIP result export.

## Run locally

Node.js 20 or newer is recommended.

```bash
cd web
npm ci
npm run dev
```

Open the local URL printed by Vite. Select a V1 workbook or click **Load synthetic example**, review validation, set the planning horizon and solver time limit, then click **Calculate schedule**. A planning horizon of `0` requests automatic estimation.

Verification commands:

```bash
cd web
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

The static production files are written to `web/dist/`. Vite uses a relative base path so the build can run below a GitHub Pages repository path. The browser test starts a temporary Vite preview of that build and uses only the fictitious workbook; the Pages build job runs it and the public-data check before deployment.

The `web-v1` branch includes a GitHub Actions workflow that tests and builds `web/`, then publishes only `web/dist/` to GitHub Pages. In the repository Pages settings, select **GitHub Actions** as the deployment source; selecting a branch serves the repository root and its README rather than the Vite build.

## Local result bundle

After a successful solve, **Download result ZIP** creates a ZIP entirely in the browser. It contains:

- `schedule.csv`;
- `gates.csv`;
- `diagnostics.csv` when structured diagnostics are available;
- `validation_report.json`;
- `normalized_project.json`;
- `run_summary.json`;
- `gantt_activities.svg`.

The Gantt and SVG group packages by `display_order` within each system (package ID breaks ties). Their calendar ticks use the active project calendar's IANA timezone, shown on the result page and SVG; `H+` remains elapsed hours since project start. CSV columns `start_datetime`, `end_datetime` and `datetime`, and JSON `completion_datetime`, retain their existing UTC `Z` values. New **trailing** CSV columns `start_datetime_local` and `end_datetime_local` in `schedule.csv`, and `datetime_local` in `gates.csv`, contain the same instants in the display timezone as ISO 8601 strings with numeric offsets (including daylight saving changes). `run_summary.json` adds `display_timezone` (IANA name) and `completion_datetime_local`; existing names, order and values are preserved. `segments_h` keeps the original semicolon-separated elapsed-hour intervals; `normalized_project.json` contains the active calendar and its timezone.

The source workbook is never modified. The downloaded ZIP is a user-controlled copy outside application memory; **Clear local data** cannot delete files already downloaded by the browser.

## Editing the V1 model locally

After importing a valid workbook, **Edit FS dependencies** lets you add, edit, deactivate or remove a link. Supply its ID, Activity/Gate endpoints, non-negative whole-hour lag and justification. **Gate priorities** lets you enable ranks and assign distinct positive integers. Each change runs the existing V1 validator; errors such as duplicate IDs, unknown references, enabled cycles, duplicate ranks or a missing `PROJECT_COMPLETE` rank disable calculation and both downloads until resolved. Edits reset any previous result.

**Download new .xlsx revision** writes a separate file using the original workbook held in memory. It updates only the `Metadata`, `Dependencies` and `MilestonePriorities` worksheets; `revision_id` receives a timestamp suffix, `parent_revision` refers to the imported revision, `revision_timestamp` is UTC ISO 8601, and an optional `revision_comment` can be supplied. The app reimports the output and checks edited and non-edited normalized records, other worksheet values and formulas before offering the download. It does not overwrite the imported file. Excel features outside the V1 table model, such as embedded objects and advanced workbook features, are not covered by the preservation check; review such workbooks in Excel before using the revision.

## Inspecting calculated dates

Select an Activity in the inspection view or click its name in the results table. The view uses the existing hourly result and workbook: it reports each enabled predecessor's finish (or Gate time) plus its elapsed lag, any required System arrival, and the first eligible execution profile under the Activity, Resource and Zone calendars after those release bounds. For `ELAPSED_TIME`, calendars do not restrict execution. A binding predecessor or arrival equals the recorded start; equality alone does not establish that it caused a delay.

For earlier calendar-eligible profiles, the view checks Resource and Zone capacities with **all other scheduled Activities held fixed**. A recorded occupancy conflict rules out that particular placement under that condition; an earlier profile that fits means the inspected constraints do not explain the chosen start. The reachable Gate list marks direct binding dependencies separately from indirect paths. Neither the view nor the ZIP computes a critical path or proves that rescheduling one Activity would move a Gate. This inspection is presentation-only and does not change the solver, results or export format.

## Privacy and data lifecycle

1. A selected workbook is read into page memory.
2. Parsing, normalization and validation run locally.
3. The normalized model is copied to the same-origin scheduling Worker.
4. HiGHS builds and solves the model locally using the bundled WebAssembly asset.
5. Views and exports are generated locally.
6. **Clear local data**, page refresh or tab closure removes the imported model and calculated result from application memory.

The runtime has no backend, database, analytics, telemetry, account, external project-data API or service worker. Project data is not written to `localStorage`, `sessionStorage`, IndexedDB or Cache Storage. Runtime asset requests are restricted to the application origin by the Content Security Policy. The application issues no `POST`, `PUT`, `PATCH` or `DELETE` requests.

The fictitious example is a same-origin static asset. Build tools and the npm registry may be used during development; they are not part of the production data path.

See [SECURITY.md](SECURITY.md) for the threat model, controls and reporting guidance.

## Public repository policy

This repository may contain code, schemas, documentation, tests and fictitious examples only. Keep real project workbooks, generated operational schedules, supplier dates, organization-specific identifiers, credentials and local configuration outside the repository.

Run the publication check before publishing changes:

```bash
python scripts/check_public_data.py --root .
```

An organization-specific denylist may be supplied from outside the clone:

```bash
python scripts/check_public_data.py \
  --root . \
  --denylist /absolute/path/to/private_terms.txt
```

## Deliberate V1 limits

- Time is discretized to a 1 h grid.
- Nominal durations are used; uncertainty modelling is deferred.
- Resource substitutions and calendar exceptions are represented but not optimized.
- The time-indexed MILP targets small and representative planning models.
- Workbook inputs are limited to 20 MiB and should come from trusted sources.
- Result downloads are not encrypted by the application; protect them according to the project classification.

See [docs/product_spec_v1.md](docs/product_spec_v1.md) for the functional contract and [schema/planning_optimizer_schema_v1.json](schema/planning_optimizer_schema_v1.json) for the reference data model.

The repository schema is the canonical V1 exchange contract. The web schema is an identical copy checked by the Python tests, and the web validator is generated from it before tests/builds. V1 workbook imports may omit the `ResourceSubstitutions` sheet; disabled milestone priorities may have a blank `priority`. Scheduling still requires positive whole-hour Activity durations and an enabled priority for `PROJECT_COMPLETE`.

## Python reference

The Python package and Streamlit dashboard are retained for regression comparison. They are not required by the web application. Python-specific installation and CLI commands remain available through `pyproject.toml` and the package help.

## License

MIT. See [LICENSE](LICENSE).
