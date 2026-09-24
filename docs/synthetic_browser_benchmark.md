# Reproducible fictional V1 browser benchmark

All workbook contents are invented by `web/scripts/generate-benchmark.mjs`. Fixed seeds
31120, 31150 and 31200 produce 20, 50 and 100 Activities. The origin
`2031-04-07T00:00:00Z`, names, IDs, durations, quantities and arrival offsets are
arbitrary synthetic inputs, with no operational source. The generator covers 4–5
Systems, 8–20 Packages, package and system Gates, arrivals and early work, independent
branches converging at Gates, FS lag, day and cross-midnight night shifts, shared
roles and tools, capacitated and occasionally exclusive Zones, preemptible and
continuous WORK_TIME, and ELAPSED_TIME. Exactly one prioritized PROJECT_COMPLETE
Gate receives all System Gates. The 7 d horizon (168 h) is fixed for all runs.

## Reproduction

From the repository root, with Node.js 20+ and a Chromium binary compatible with
Playwright installed:

```sh
cd web
npm ci
npm run generate:benchmark
npm run test:benchmark-fixture
npm run build:benchmark
BENCHMARK_CHROMIUM_PATH=/absolute/path/to/chromium npm run benchmark -- --sizes 20,50,100 --repeats 3 --deadline-ms 120000
npm run build
npm test
python3 ../scripts/check_public_data.py --root ..
```

Omit `BENCHMARK_CHROMIUM_PATH` when `npx playwright install chromium` works.
Generated `.xlsx` workbooks and raw `results.json` reside in `../benchmark-artifacts/`,
outside the repository. No benchmark ZIP is generated. `build:benchmark` adds an
isolated benchmark page to a production Vite build; the regular `build` does not
publish that page. The measured modules are the same production import, validator,
MILP builder and HiGHS solver. Instrumentation wraps the HiGHS library's `run()`
calls in a separate benchmark worker; it does not edit the solver or its model.
Only the 20 Activity fixture's deterministic structure and XLSX roundtrip run in
CI, alongside the existing short fictional application browser test.

The import measurement includes the importer's built-in validation. A separate
validation call measures the same project again. The independent MILP construction
records size and construction time; `solveScheduleWithHighs` then builds it once
more internally. Consequently, the total wall time includes two builds and is not
the exact normal dashboard time. It includes file read, worker startup, Wasm load,
post-solve verification and messaging. Each HiGHS pass has a separate wall clock
duration and model status. A limit on any pass is reported as **unproven**, not as
infeasible. The benchmark worker follows the same policy as the app and does not
return a schedule unless all passes are proven optimal and post-solve checks pass.

## Baseline results (three runs per size)

Machine: Linux x64 6.18.44, AMD EPYC 9V74 (9 logical CPUs exposed), 9.73 GiB RAM;
headless Chromium 141.0.7390.0; HiGHS 1.15.1; source base
`caadf349029b86a75795fcf44f258659d43a391c`. Each HiGHS pass has a 30 s
limit, and the harness deadline is 120 s. Times are medians of three runs, in
milliseconds unless otherwise indicated; they are observations on this host,
not confidence intervals.

| Activities | Import¹ | Validation² | MILP build² | HiGHS Gate pass | HiGHS compactness pass | Total wall (s) | MILP columns / rows / nonzeros | Proven status and Gate objective | UI max heartbeat delay³ |
|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| 20 | 32.9 | 0.5 | 15.9 | 414.4 | 71.4 | 0.614 | 1,309 / 652 / 12,224 | 3/3 fully optimal; 59 h | 0.8 ms |
| 50 | 36.1 | 0.7 | 22.1 | 1,040.5 | 554.3 | 1.744 | 3,300 / 780 / 27,604 | 3/3 fully optimal; 58 h | 1.4 ms |
| 100 | 48.7 | 1.3 | 42.0 | 26,079.7 | 30,011.9 | 56.298 | 6,250 / 985 / 56,872 | Gate optimum 112 h proven 3/3; compactness timed out 3/3; no complete schedule returned | 17.8 ms |

¹ Import includes validation. ² These are additional, separately timed passes.
³ Maximum excess over a 50 ms page heartbeat, median of the three per-run maxima;
the 100 Activity per-run maxima ranged from 15.4 to 19.0 ms. The UI remained
responsive during the worker solve on this host; background tab throttling and
different hardware can change this measure. The browser exposed a page JavaScript
heap value of 9.54 MiB after every run, but it excludes the Worker and Wasm heap.
Total process memory **could not be measured reliably** here; 9.54 MiB must not be
interpreted as optimizer memory use.

The 20 and 50 cases have different seeds and dependency graphs: the 58 h versus
59 h objectives do not imply that more work completes faster under identical
inputs. The 100 Activity failure is a time limit during compaction, **not a proof
of infeasibility**. Larger horizons, priorities or activity durations may change
the formulation size and timing sharply. Reproduce on target hardware and with
other wholly fictional scenarios before drawing performance conclusions.
