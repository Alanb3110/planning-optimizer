from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
from typing import Any, Iterable

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import coo_matrix, vstack

from .calendars import build_calendar_slots, hour_offset, parse_datetime, segments_from_slots


@dataclass
class ScheduledActivity:
    activity_id: str
    start_h: int
    end_h: int
    work_slots: list[int]
    segments: list[tuple[int, int]]


@dataclass
class ScheduleResult:
    activities: dict[str, ScheduledActivity]
    gates: dict[str, int]
    project_start: datetime
    objective_gate: str
    objective_h: int
    horizon_h: int
    optimal: bool
    solver_message: str


class ConstraintBuilder:
    def __init__(self) -> None:
        self.row: list[int] = []
        self.col: list[int] = []
        self.value: list[float] = []
        self.lower: list[float] = []
        self.upper: list[float] = []

    def add(self, coefficients: Iterable[tuple[int, float]], lower: float = -np.inf, upper: float = np.inf) -> None:
        row_number = len(self.lower)
        for column, value in coefficients:
            if value:
                self.row.append(row_number)
                self.col.append(column)
                self.value.append(float(value))
        self.lower.append(float(lower))
        self.upper.append(float(upper))

    def matrix(self, variable_count: int):
        return coo_matrix((self.value, (self.row, self.col)), shape=(len(self.lower), variable_count)).tocsr()


class TimeIndexedScheduler:
    """Hourly time-indexed MILP for the V1 prototype."""

    def __init__(
        self,
        data: dict[str, Any],
        *,
        horizon_days: int | None = None,
        time_limit_s: float = 120.0,
        enforce_capacities: bool = True,
    ) -> None:
        self.data = data
        self.project_start = parse_datetime(data["metadata"]["project_start"])
        self.time_limit_s = time_limit_s
        self.enforce_capacities = enforce_capacities
        self.systems = {row["system_id"]: row for row in data["systems"] if row.get("enabled", True)}
        self.packages = {
            row["package_id"]: row
            for row in data["packages"]
            if row.get("enabled", True) and row.get("system_id") in self.systems
        }
        self.activities = {
            row["activity_id"]: row
            for row in data["activities"]
            if row.get("enabled", True) and row.get("package_id") in self.packages
        }
        self.gates = {
            row["gate_id"]: row
            for row in data["gates"]
            if (row.get("package_id") is None or row.get("package_id") in self.packages)
            and (row.get("system_id") is None or row.get("system_id") in self.systems)
        }
        self.dependencies = [
            row for row in data["dependencies"]
            if row.get("enabled")
            and self._node_active(row["source_type"], row["source_id"])
            and self._node_active(row["target_type"], row["target_id"])
        ]
        self.resources = {row["resource_id"]: row for row in data["resources"]}
        self.zones = {row["zone_id"]: row for row in data["zones"]}
        self.activity_resources: dict[str, list[tuple[str, float]]] = defaultdict(list)
        for row in data["activity_resources"]:
            if row["activity_id"] in self.activities:
                self.activity_resources[row["activity_id"]].append((row["resource_id"], float(row["quantity"])))
        self.activity_zones: dict[str, list[tuple[str, float]]] = defaultdict(list)
        for row in data["activity_zones"]:
            if row["activity_id"] not in self.activities:
                continue
            zone = self.zones[row["zone_id"]]
            load = float(zone["capacity"]) if row.get("exclusive") or row.get("load") == "ALL" else float(row["load"])
            self.activity_zones[row["activity_id"]].append((row["zone_id"], load))

        if horizon_days is None:
            latest_arrival = max(
                [0, *[max(0, hour_offset(self.project_start, row["arrival_date"])) for row in self.systems.values()]]
            )
            total_duration = sum(float(row["duration_h"]) for row in self.activities.values())
            # Compact heuristic for the local POC. It gives the input data
            # roughly 40 days after its latest delivery while avoiding a very
            # large time-indexed matrix. Larger projects can pass --horizon-days.
            horizon_h = math.ceil(latest_arrival + max(30 * 24, total_duration * 1.5) + 10 * 24)
        else:
            horizon_h = horizon_days * 24
        self.horizon_h = int(horizon_h)
        self.calendar_slots = build_calendar_slots(data, self.project_start, self.horizon_h)

        self.names: list[str] = []
        self.lower_bounds: list[float] = []
        self.upper_bounds: list[float] = []
        self.integrality: list[int] = []
        self.start_var: dict[str, int] = {}
        self.end_var: dict[str, int] = {}
        self.gate_var: dict[str, int] = {}
        self.execution_vars: dict[str, list[tuple[int, tuple[int, ...], int]]] = defaultdict(list)
        self.builder = ConstraintBuilder()
        self.usage_resource: dict[tuple[str, int], list[tuple[int, float]]] = defaultdict(list)
        self.usage_zone: dict[tuple[str, int], list[tuple[int, float]]] = defaultdict(list)

    def _node_active(self, node_type: str, node_id: str) -> bool:
        return node_id in (self.activities if node_type == "ACTIVITY" else self.gates)

    def _add_variable(self, name: str, lower: float, upper: float, integer: bool) -> int:
        index = len(self.names)
        self.names.append(name)
        self.lower_bounds.append(lower)
        self.upper_bounds.append(upper)
        self.integrality.append(1 if integer else 0)
        return index

    def _activity_system(self, activity_id: str) -> str:
        package_id = self.activities[activity_id]["package_id"]
        return self.packages[package_id]["system_id"]

    def _release_h(self, activity_id: str) -> int:
        activity = self.activities[activity_id]
        if not activity.get("requires_system_arrival", True):
            return 0
        system = self.systems[self._activity_system(activity_id)]
        return max(0, hour_offset(self.project_start, system["arrival_date"]))

    def _effective_availability(self, activity_id: str) -> list[bool]:
        activity = self.activities[activity_id]
        calendar_ids: list[str] = []
        activity_calendar = activity.get("calendar_id") or self.data["metadata"].get("active_calendar")
        if activity_calendar:
            calendar_ids.append(activity_calendar)
        for resource_id, _ in self.activity_resources[activity_id]:
            calendar_id = self.resources[resource_id].get("calendar_id")
            if calendar_id:
                calendar_ids.append(calendar_id)
        for zone_id, _ in self.activity_zones[activity_id]:
            calendar_id = self.zones[zone_id].get("calendar_id")
            if calendar_id:
                calendar_ids.append(calendar_id)
        if not calendar_ids:
            return [True] * self.horizon_h
        return [all(self.calendar_slots[calendar_id][t] for calendar_id in calendar_ids) for t in range(self.horizon_h)]

    def _register_usage(self, activity_id: str, variable: int, slots: tuple[int, ...]) -> None:
        for resource_id, quantity in self.activity_resources[activity_id]:
            if self.resources[resource_id].get("unlimited"):
                continue
            for slot in slots:
                self.usage_resource[(resource_id, slot)].append((variable, quantity))
        for zone_id, load in self.activity_zones[activity_id]:
            for slot in slots:
                self.usage_zone[(zone_id, slot)].append((variable, load))

    def _build_variables_and_activity_constraints(self) -> None:
        for activity_id, activity in self.activities.items():
            start = self._add_variable(f"start:{activity_id}", 0, self.horizon_h, True)
            end = self._add_variable(f"end:{activity_id}", 0, self.horizon_h, True)
            self.start_var[activity_id] = start
            self.end_var[activity_id] = end
            duration = int(round(float(activity["duration_h"])))
            if abs(duration - float(activity["duration_h"])) > 1e-9:
                raise ValueError(f"Activity {activity_id} duration is not aligned to the 1 h grid.")
            release = self._release_h(activity_id)
            basis = activity["duration_basis"]
            preemptible = bool(activity["preemptible"])

            candidates: list[tuple[int, tuple[int, ...], int]] = []
            if basis == "ELAPSED_TIME":
                candidate_starts = range(release, self.horizon_h - duration + 1)
                profiles = ((s, tuple(range(s, s + duration))) for s in candidate_starts)
            else:
                availability = self._effective_availability(activity_id)
                if preemptible:
                    eligible = [t for t in range(release, self.horizon_h) if availability[t]]
                    profiles = (
                        (eligible[index], tuple(eligible[index : index + duration]))
                        for index in range(0, len(eligible) - duration + 1)
                    )
                else:
                    profiles = (
                        (s, tuple(range(s, s + duration)))
                        for s in range(release, self.horizon_h - duration + 1)
                        if all(availability[t] for t in range(s, s + duration))
                    )
            for candidate_start, profile in profiles:
                variable = self._add_variable(f"start_choice:{activity_id}:{candidate_start}", 0, 1, True)
                candidates.append((variable, profile, candidate_start))
                self._register_usage(activity_id, variable, profile)
            if not candidates:
                continuity = "calendar-spanning" if preemptible else "continuous"
                raise ValueError(
                    f"Activity {activity_id} has no {continuity} {duration} h feasible profile. "
                    "Check duration, calendars and horizon."
                )
            self.execution_vars[activity_id] = candidates
            self.builder.add([(variable, 1) for variable, _, _ in candidates], lower=1, upper=1)
            self.builder.add(
                [(start, 1), *[(variable, -candidate_start) for variable, _, candidate_start in candidates]],
                lower=0,
                upper=0,
            )
            self.builder.add(
                [(end, 1), *[(variable, -(profile[-1] + 1)) for variable, profile, _ in candidates]],
                lower=0,
                upper=0,
            )

        for gate_id in self.gates:
            self.gate_var[gate_id] = self._add_variable(f"gate:{gate_id}", 0, self.horizon_h, True)

    def _node_time_variable(self, node_type: str, node_id: str, source: bool) -> int:
        if node_type == "GATE":
            return self.gate_var[node_id]
        return self.end_var[node_id] if source else self.start_var[node_id]

    def _build_precedence_constraints(self) -> None:
        for dependency in self.dependencies:
            source = self._node_time_variable(dependency["source_type"], dependency["source_id"], True)
            target = self._node_time_variable(dependency["target_type"], dependency["target_id"], False)
            lag = float(dependency.get("lag_h", 0))
            if abs(lag - round(lag)) > 1e-9:
                raise ValueError(f"Dependency {dependency['dependency_id']} lag is not aligned to the 1 h grid.")
            self.builder.add([(target, 1), (source, -1)], lower=round(lag))

    def _build_capacity_constraints(self) -> None:
        if not self.enforce_capacities:
            return
        for (resource_id, _slot), coefficients in self.usage_resource.items():
            self.builder.add(coefficients, upper=float(self.resources[resource_id]["capacity"]))
        for (zone_id, _slot), coefficients in self.usage_zone.items():
            self.builder.add(coefficients, upper=float(self.zones[zone_id]["capacity"]))

    def _milp_solve(self, objective: np.ndarray, fixed: list[tuple[int, int]]) -> Any:
        variable_count = len(self.names)
        base = self.builder.matrix(variable_count)
        lower = np.asarray(self.builder.lower, dtype=float)
        upper = np.asarray(self.builder.upper, dtype=float)
        if fixed:
            extra_rows = coo_matrix(
                (
                    np.ones(len(fixed)),
                    (np.arange(len(fixed)), np.asarray([index for index, _ in fixed])),
                ),
                shape=(len(fixed), variable_count),
            ).tocsr()
            matrix = vstack([base, extra_rows], format="csr")
            lower = np.concatenate([lower, np.asarray([value for _, value in fixed], dtype=float)])
            upper = np.concatenate([upper, np.asarray([value for _, value in fixed], dtype=float)])
        else:
            matrix = base
        return milp(
            c=objective,
            integrality=np.asarray(self.integrality, dtype=np.uint8),
            bounds=Bounds(np.asarray(self.lower_bounds), np.asarray(self.upper_bounds)),
            constraints=LinearConstraint(matrix, lower, upper),
            # All scheduling times are integer hours. A 1e-4 relative MIP gap is
            # smaller than one hour over the intended prototype horizons, so
            # an integer incumbent matching the bound is still objective-exact.
            options={"time_limit": self.time_limit_s, "mip_rel_gap": 1e-4, "presolve": True},
        )

    def solve(self) -> ScheduleResult:
        self._build_variables_and_activity_constraints()
        self._build_precedence_constraints()
        self._build_capacity_constraints()
        variable_count = len(self.names)
        fixed: list[tuple[int, int]] = []
        priorities = sorted(
            [row for row in self.data["milestone_priorities"] if row.get("enabled") and row.get("gate_id") in self.gate_var],
            key=lambda row: (row.get("priority") is None, row.get("priority") or 10**9, row["gate_id"]),
        )
        if not priorities:
            raise ValueError("At least one enabled milestone priority is required.")

        last_result = None
        for priority in priorities:
            gate_id = priority["gate_id"]
            objective = np.zeros(variable_count)
            objective[self.gate_var[gate_id]] = 1
            result = self._milp_solve(objective, fixed)
            if result.status != 0 or result.x is None:
                raise RuntimeError(f"MILP did not prove an optimal schedule: {result.message}")
            value = int(round(result.x[self.gate_var[gate_id]]))
            fixed.append((self.gate_var[gate_id], value))
            last_result = result

        compactness = np.zeros(variable_count)
        for variable in self.end_var.values():
            compactness[variable] = 1
        for variable in self.gate_var.values():
            compactness[variable] += 0.1
        result = self._milp_solve(compactness, fixed)
        if result.status != 0 or result.x is None:
            raise RuntimeError(f"MILP tie-break did not prove an optimal schedule: {result.message}")
        last_result = result

        scheduled: dict[str, ScheduledActivity] = {}
        for activity_id, variables in self.execution_vars.items():
            slots: list[int] = []
            for variable, profile, _ in variables:
                if last_result.x[variable] > 0.5:
                    slots.extend(profile)
            slots = sorted(set(slots))
            scheduled[activity_id] = ScheduledActivity(
                activity_id=activity_id,
                start_h=min(slots),
                end_h=max(slots) + 1,
                work_slots=slots,
                segments=segments_from_slots(slots),
            )
        gate_times = {gate_id: int(round(last_result.x[variable])) for gate_id, variable in self.gate_var.items()}
        completion_gates = [
            gate_id for gate_id, gate in self.gates.items() if gate.get("gate_type") == "PROJECT_COMPLETE"
        ]
        if len(completion_gates) != 1:
            raise ValueError("Exactly one active PROJECT_COMPLETE gate is required.")
        objective_gate = completion_gates[0]
        return ScheduleResult(
            activities=scheduled,
            gates=gate_times,
            project_start=self.project_start,
            objective_gate=objective_gate,
            objective_h=gate_times[objective_gate],
            horizon_h=self.horizon_h,
            optimal=True,
            solver_message=last_result.message,
        )


def validate_schedule(data: dict[str, Any], result: ScheduleResult) -> list[str]:
    """Independent post-solve checks on the extracted schedule."""
    errors: list[str] = []
    activities = {row["activity_id"]: row for row in data["activities"] if row.get("enabled", True)}
    for activity_id, scheduled in result.activities.items():
        expected = int(round(float(activities[activity_id]["duration_h"])))
        if len(scheduled.work_slots) != expected:
            errors.append(f"{activity_id}: scheduled {len(scheduled.work_slots)} h, expected {expected} h.")
        if activities[activity_id]["duration_basis"] == "WORK_TIME" and not activities[activity_id]["preemptible"]:
            if scheduled.segments != [(scheduled.start_h, scheduled.end_h)]:
                errors.append(f"{activity_id}: non-interruptible work is split into {scheduled.segments}.")

    for dependency in data["dependencies"]:
        if not dependency.get("enabled"):
            continue
        source_id, target_id = dependency["source_id"], dependency["target_id"]
        if dependency["source_type"] == "ACTIVITY":
            if source_id not in result.activities:
                continue
            source_time = result.activities[source_id].end_h
        else:
            if source_id not in result.gates:
                continue
            source_time = result.gates[source_id]
        if dependency["target_type"] == "ACTIVITY":
            if target_id not in result.activities:
                continue
            target_time = result.activities[target_id].start_h
        else:
            if target_id not in result.gates:
                continue
            target_time = result.gates[target_id]
        if target_time + 1e-9 < source_time + float(dependency.get("lag_h", 0)):
            errors.append(f"{dependency['dependency_id']}: FS constraint violated.")
    return errors


def hour_to_datetime(result: ScheduleResult, hour: int) -> datetime:
    return (result.project_start.astimezone(timezone.utc) + timedelta(hours=hour)).astimezone(result.project_start.tzinfo)
