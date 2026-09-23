# Planning Optimizer — Product Specification V1

## 1. Scope

The application generates a local project schedule from technical precedence, release dates, calendars, resource capacities, and physical work-area constraints. The generated Gantt is an output; the input model remains the source of truth.

V1 uses nominal durations and a 1 h scheduling grid. Duration uncertainty, named-person assignment, costs, calendar exceptions, and resource-substitution optimization are deferred.

## 2. Objective

Enabled milestone priorities are minimized lexicographically in ascending `priority` order. `PROJECT_COMPLETE` must be enabled in the list. Therefore:

- with only `PROJECT_COMPLETE`, the solver minimizes total project completion time;
- with an intermediate milestone ranked first, the solver first minimizes that milestone and then minimizes later priorities without degrading earlier optima.

V1 requires each enabled priority number to be unique.

## 3. Hierarchy

```text
Project
└── System
    └── Package
        ├── Activity
        └── Gate
```

An Activity performs work and has positive duration. A Gate has zero duration and represents a state or milestone. Dependencies are stored once as graph edges; successors are derived.

## 4. Scheduling entities and semantics

### System

A System groups related Packages. `arrival_date` is the physical arrival or release date of that system. Activities with `requires_system_arrival=true` cannot start before it.

Equipment is operationally available only after its reception or acceptance activity completes and produces an `AVAILABLE` gate. Downstream work must depend on that gate. Activities that do not require the delivered hardware, such as early enabling work, set `requires_system_arrival=false`.

### Package

A Package groups Activities and Gates for presentation and reuse. Packages do not impose scheduling constraints by themselves.

### Activity

Required scheduling fields are:

- `activity_id`, `package_id`, `name`;
- `duration_h > 0`;
- `duration_basis = WORK_TIME | ELAPSED_TIME`;
- `preemptible`, `enabled`;
- optional `calendar_id`;
- `requires_system_arrival`, defaulting to `true` when omitted during import.

`WORK_TIME` advances only in hourly slots allowed by the intersection of the Activity, Resource, and Zone calendars. An interruptible Activity may pause at calendar gaps. A non-interruptible Activity must occupy one continuous allowed interval. Adjacent shifts form one continuous interval, including when the team changes at the boundary.

`ELAPSED_TIME` advances continuously in wall-clock time, including off-shift periods. Any assigned Resource or Zone capacity remains reserved for its full elapsed duration.

### Gate

A Gate occurs no earlier than all enabled incoming dependencies permit. Exactly one active Gate must have `gate_type=PROJECT_COMPLETE`.

Typical generic types include `AVAILABLE`, `READY`, `RELEASED`, `QUALIFIED`, and `PROJECT_COMPLETE`.

### Dependency

V1 supports Finish-to-Start only:

\[
S_j \ge E_i + L_{ij}
\]

where `lag_h = L_ij` is elapsed time in hours. Sources and targets may each be an Activity or Gate.

### Resource

A Resource is a human role, equipment pool, or workfront. For each resource `r` and time slot `t`:

\[
\sum_i q_{i,r,t} \le C_r
\]

where `q` is Activity demand and `C` is capacity. An unlimited resource is not capacity constrained.

### Zone

A Zone has numeric capacity. Normal Activities consume a numeric load. An exclusive assignment consumes the complete Zone capacity, preventing concurrent occupancy.

### Calendar

A Calendar defines timezone, validity dates, and recurring weekday shifts. Cross-midnight shifts are allowed. The active project calendar applies when an Activity has no explicit calendar. Resource and Zone calendars further restrict `WORK_TIME` availability.

Shift weekdays, times and validity dates are interpreted in each Calendar's own IANA timezone. A cross-midnight shift is anchored on its starting local date. The hourly scheduling grid counts elapsed instants from `project_start`; the intersection of Calendar windows is made on that grid. On a daylight-saving transition, a missing local boundary advances to the first real time after the gap; a repeated boundary uses the earlier instant for a shift start and the later instant for its end. A slot is available only when its full elapsed hour falls inside a shift.

## 5. Input and validation

The V1 import format is an Excel workbook with these worksheets:

`Metadata`, `Systems`, `Packages`, `Activities`, `Gates`, `Dependencies`, `Resources`, `ActivityResources`, `ResourceSubstitutions`, `Zones`, `ActivityZones`, `Calendars`, `CalendarShifts`, and `MilestonePriorities`.

The loader:

1. locates each table by its identifier header;
2. omits blank optional cells from the normalized model;
3. performs narrow Boolean normalization for Excel values;
4. normalizes date-times into the active calendar timezone when the workbook value is naive;
5. validates required fields, references, types, duplicates, cycles, calendars, capacities, and milestone priorities.

The canonical V1 exchange contract is [`schema/planning_optimizer_schema_v1.json`](../schema/planning_optimizer_schema_v1.json), based on the supplied AIT Planning Optimizer schema V1. The browser copy is byte-for-byte identical, enforced by a regression test; the browser's generated AJV validator is compiled from that copy before tests and builds. The Python reference validates against the canonical file. The runtime performs additional graph and scheduling checks that JSON Schema cannot express.

`resource_substitutions` and its workbook sheet `ResourceSubstitutions` are optional; absence means no substitutions. A disabled milestone row may omit `priority` or leave it null, while every enabled milestone needs a distinct positive integer priority. `metadata.objective_gate` is optional and, if supplied, refers to an existing Gate; lexicographic priorities still define the scheduling objective. The exchange schema permits `duration_h = 0` structurally, but V1 scheduling rejects it: Activities require a positive whole number of hours on the 1 h grid. `requires_system_arrival` is optional and defaults to `true` at workbook import; only an explicit `false` enables work before system arrival. The supplied schema omitted its explicit definition while allowing extra Activity fields; both repository copies now declare this established boolean and default from Product Specification v1.1. JSON Schema `default` is descriptive; importers apply it explicitly.

## 6. Solver

For each feasible execution profile `p` of Activity `i`, the solver selects one binary variable:

\[
\sum_{p \in P_i} x_{i,p}=1,\qquad x_{i,p}\in\{0,1\}.
\]

Resource and Zone capacities are enforced for every occupied hourly slot. Priority Gates are optimized sequentially and each optimum is fixed before solving the next priority. A final compactness objective removes arbitrary slack.

## 7. Outputs

The application writes:

- normalized input and validation report;
- Activity schedule with execution segments;
- Gate dates;
- delay diagnostics comparing the constrained schedule with a capacity-unconstrained technical schedule;
- package-level and Activity-level Gantt charts;
- run summary with project completion time and solver status.

## 8. Data isolation

Operational workbooks, generated schedules, and organization-specific denylist terms remain outside the public repository. The repository contains only the generic implementation and a neutral synthetic acceptance dataset.
