# Extracted schedule verification (Product Specification v1.1 §8.4)

The Worker calls `validateSolvedSchedule` after HiGHS reports an optimum and after extracting the Activity slots and Gate offsets. This standalone check reads the input project and extracted result; it does not inspect or reuse MILP rows, variables, or execution profiles. Any finding prevents the result from being published as a valid optimal schedule.

It checks the exact enabled System → Package → Activity set; the active Gate set; integer-hour bounds and agreement among Activity IDs, slots, start/end and segments; nominal hours for both duration bases; continuous occupied slots for `ELAPSED_TIME` and non-preemptible `WORK_TIME`; no skipped available hour for preemptible `WORK_TIME`; System arrival unless explicitly waived; all applicable Activity (or project default), Resource, and Zone calendars for `WORK_TIME`; Resource demand against capacity per occupied hour (except unlimited Resources); Zone demand and full-capacity exclusive/`ALL` reservations; enabled FS dependencies with elapsed lags across all four endpoint combinations; and Gate times, `PROJECT_COMPLETE` priority, objective identity/time, and completion no earlier than every active Activity and Gate. `ELAPSED_TIME` reserves assigned capacities continuously even outside shifts. Calendar availability uses the same calendar-to-UTC conversion helper as the model; this is an independent **timetable** check, not a second implementation of time-zone conversion.

An enabled Activity not connected to `PROJECT_COMPLETE` can end after that Gate: the current MILP only applies explicit dependencies. The verifier rejects that extracted timetable. Connect all project work and terminal Gates through meaningful FS dependencies if they belong to project completion. This increment does not change the MILP, auto-create dependencies, or redefine the objective. Fictitious adversarial tests alter one scheduling rule at a time, and the existing synthetic workbook still exercises the end-to-end solve.

## Specification v1.1 and repository V1 schema differences

The schema is an exchange shape, not the complete scheduling contract. The following semantic restrictions from the specification cannot be inferred from the schema alone; the existing pre-solve semantic validator remains responsible for input checks. No schema or workbook migration is included here.

| Item | Specification v1.1 | Repository JSON Schema V1 | Treatment |
| --- | --- | --- | --- |
| Activity duration | Positive whole hours | `duration_h` allows zero and fractions (`minimum: 0`, `number`) | Existing semantic validation rejects non-positive and non-integer values; post-solve checks exact nominal hours. |
| Dependency lag | Non-negative whole hours on the grid | `lag_h` allows non-negative fractions | Existing semantic validation checks the grid; extracted FS times are checked. |
| Zone `ALL` load | Valid only with `exclusive=true` | `load: "ALL"` and `exclusive: false` pass structural validation | Existing semantic validation rejects this combination. |
| Active `PROJECT_COMPLETE` | Exactly one, with an enabled priority | `gate_type` is arbitrary text; no cross-table uniqueness or enabled-priority condition | Existing semantic validation handles this; post-solve checks objective and finishing time. |
| Enabled priority | Distinct positive integer for every enabled row | Priority is optional or null and uniqueness is not expressed | Existing semantic validation checks enabled rows. |
| System arrival waiver | Only explicit `requires_system_arrival=false` releases early work | Optional boolean with declarative `default: true` | Importer applies the default explicitly; verifier checks actual start time. |
| Resource demand and capacity | Demand must fit available capacity in each occupied hour | Only row-level positive quantities and non-negative capacities | Pre-solve semantic checks and post-solve per-hour checks. |

Compared with the **original supplied V1 schema**, the repository schema explicitly declares `requires_system_arrival` with a default of `true`; its `additionalProperties` previously admitted the field without typing it. This repository change predates the present increment. Both schema copies inside the repository stay identical and unchanged here.
