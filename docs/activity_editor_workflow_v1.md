# V1 activity composition check (fictional workbook)

The selected package now offers a create action and a copy selector. Selecting an activity
shows six live review items: nominal duration and effective calendar (explicit activity
calendar or project default), system arrival, role demand, zone occupancy, and active FS
predecessors and successors with lags. The action on each item opens its existing editor.
An empty demand or FS list is marked **To confirm**, not treated as an error: the model
cannot decide whether that constraint is needed. No demand or dependency is inserted.

## Action count

Count one action for each button click, field entry, or select choice; count a selection
change when the detail pane changes between a package and an activity, or between two
activities. Start with the workbook imported and the explorer visible. Create two
activities in one package with ID, name, and duration, leaving the effective project
calendar and arrival requirement at their defaults. This is the same fictional path
used by the `App.test.tsx` guided activity test.

| Step | Before (`8418224`) | After |
| --- | ---: | ---: |
| Select package | 1 | 1 |
| Add first activity, enter three fields, save | 5 | 5 |
| Return to package, or use Create next activity | 2 | 1 |
| Enter three fields, save second activity | 4 | 4 |
| **Total actions** | **12** | **11** |
| **Detail-pane selection changes** | **3** | **2** |

For each additional activity, the shortcut saves one click and one pane change. Adding
one role demand, zone occupancy, predecessor and successor takes the same field entries
as before; the guide makes the controls visible together and updates the review after
each save. Duplicating an activity directly from its package takes two actions (select
source, duplicate) and immediately opens the copy. Existing package duplication and
new revision export remain available.

`web/e2e/ux-polish.spec.ts` contains a 1366 px and 390 px test for two new activities,
a copy, the review, revision download and reimport, and horizontal overflow. The existing
browser test exercises role, zone, predecessor, successor, solve, and reimport at both
widths. `web/src/lib/modelEdits.test.ts` checks revision roundtrip of entity and
constraint rows independently of the UI.
