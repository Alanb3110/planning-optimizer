# Planning Optimizer

A small local-first prototype for resource-constrained project scheduling. It loads an Excel workbook, validates the planning model, solves an hourly mixed-integer schedule, and writes CSV diagnostics and Gantt charts.

The repository contains only code, a generic schema, and a neutral synthetic example. Keep operational project inputs and generated results outside the repository.

## Implemented in V1

- Systems, packages, activities, zero-duration gates, and Finish-to-Start dependencies with optional elapsed-time lag.
- System arrival constraints and explicit early-enabler activities.
- `WORK_TIME` and `ELAPSED_TIME` durations.
- Interruptible work across calendar gaps and continuous non-interruptible work.
- Activity, resource, and zone calendars, including adjacent and cross-midnight shifts.
- Resource capacity, zone capacity, and exclusive zone occupancy.
- Lexicographic milestone priorities, always including project completion.
- Structural, referential, semantic, and post-solve validation.
- Schedule, gate, diagnostic, and Gantt outputs.

## Local data layout

Recommended layout:

```text
~/code/planning-optimizer/       # this public repository
~/planning-data/inputs/          # private workbooks
~/planning-data/outputs/         # private schedules and diagnostics
```

Do not copy private workbooks into the repository, even when a path is ignored by Git.

## Installation

Python 3.11 or newer is required.

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
python -m pip install -e .
```

## Run the neutral synthetic example

```bash
planning-optimizer audit \
  --input examples/synthetic_project.xlsx

planning-optimizer schedule \
  --input examples/synthetic_project.xlsx \
  --output /tmp/planning-optimizer-demo
```

## Start the local Dashboard

```bash
planning-optimizer dashboard
```

The application binds to `127.0.0.1` and opens at `http://127.0.0.1:8501`. Select a workbook with the file picker, review its validation report, and calculate the schedule. Uploaded input stays in process memory. Generated files are created in an automatically deleted temporary directory and retained in memory only for preview and download.

For private data, replace `--input` and `--output` with paths outside the clone.

Generated outputs are:

- `schedule.csv`
- `gates.csv`
- `diagnostics.csv`
- `validation_report.json`
- `normalized_project.json`
- `run_summary.json`
- `gantt.png`
- `gantt_activities.png`

## Tests and publication check

```bash
python -m unittest discover -s tests -v
python scripts/check_public_data.py --root .
```

An additional private denylist can be supplied without storing it in the repository:

```bash
python scripts/check_public_data.py \
  --root . \
  --denylist /absolute/path/to/private_terms.txt
```

The denylist contains one case-insensitive term per line. Blank lines and lines beginning with `#` are ignored.

## Deliberate limits

- Time is discretized to 1 h. Durations, lags, arrivals, and shift boundaries must align to the grid.
- Interruptible work may pause at calendar gaps. Arbitrary extra mid-shift fragmentation is not yet modeled.
- Resource substitutions and calendar exceptions are represented in the data model but are not optimized in this prototype.
- The time-indexed MILP is intended to prove the model on small datasets, not yet to scale to a large operational plan.
- The first interface is a local Streamlit Dashboard; there is no hosted backend.

See [docs/product_spec_v1.md](docs/product_spec_v1.md) for the functional contract and [schema/planning_optimizer_schema_v1.json](schema/planning_optimizer_schema_v1.json) for the reference data model.

## License

MIT. See [LICENSE](LICENSE).
