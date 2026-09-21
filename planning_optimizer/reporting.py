from __future__ import annotations

import csv
from collections import defaultdict
from datetime import datetime, timedelta
import json
from pathlib import Path
from typing import Any

import matplotlib.dates as mdates
import matplotlib.pyplot as plt

from .solver import ScheduleResult, hour_to_datetime


def _activity_maps(data: dict[str, Any]):
    packages = {row["package_id"]: row for row in data["packages"]}
    systems = {row["system_id"]: row for row in data["systems"]}
    activities = {row["activity_id"]: row for row in data["activities"]}
    return systems, packages, activities


def _usage(data: dict[str, Any], result: ScheduleResult):
    resources = {row["resource_id"]: row for row in data["resources"]}
    zones = {row["zone_id"]: row for row in data["zones"]}
    demands_r: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for row in data["activity_resources"]:
        demands_r[row["activity_id"]].append((row["resource_id"], float(row["quantity"])))
    demands_z: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for row in data["activity_zones"]:
        load = float(zones[row["zone_id"]]["capacity"]) if row.get("exclusive") or row.get("load") == "ALL" else float(row["load"])
        demands_z[row["activity_id"]].append((row["zone_id"], load))
    usage_r: dict[tuple[str, int], list[tuple[str, float]]] = defaultdict(list)
    usage_z: dict[tuple[str, int], list[tuple[str, float]]] = defaultdict(list)
    for activity_id, scheduled in result.activities.items():
        for slot in scheduled.work_slots:
            for resource_id, quantity in demands_r[activity_id]:
                if not resources[resource_id].get("unlimited"):
                    usage_r[(resource_id, slot)].append((activity_id, quantity))
            for zone_id, load in demands_z[activity_id]:
                usage_z[(zone_id, slot)].append((activity_id, load))
    return demands_r, demands_z, usage_r, usage_z


def schedule_validation_errors(data: dict[str, Any], result: ScheduleResult) -> list[str]:
    errors: list[str] = []
    systems, packages, activities = _activity_maps(data)
    resources = {row["resource_id"]: row for row in data["resources"]}
    zones = {row["zone_id"]: row for row in data["zones"]}
    demands_r, demands_z, usage_r, usage_z = _usage(data, result)
    for (resource_id, slot), uses in usage_r.items():
        total = sum(value for _, value in uses)
        if total > float(resources[resource_id]["capacity"]) + 1e-9:
            errors.append(f"Resource {resource_id} exceeds capacity at hour {slot}: {total}.")
    for (zone_id, slot), uses in usage_z.items():
        total = sum(value for _, value in uses)
        if total > float(zones[zone_id]["capacity"]) + 1e-9:
            errors.append(f"Zone {zone_id} exceeds capacity at hour {slot}: {total}.")

    for activity_id, scheduled in result.activities.items():
        activity = activities[activity_id]
        if activity.get("requires_system_arrival", True):
            system_id = packages[activity["package_id"]]["system_id"]
            arrival = systems[system_id]["arrival_date"]
            arrival_h = round((datetime.fromisoformat(arrival) - result.project_start).total_seconds() / 3600)
            if scheduled.start_h < arrival_h:
                errors.append(f"{activity_id} starts before system arrival.")
        if activity["duration_basis"] == "ELAPSED_TIME" and scheduled.segments != [(scheduled.start_h, scheduled.end_h)]:
            errors.append(f"{activity_id}: ELAPSED_TIME activity is not continuous.")
    return errors


def build_diagnostics(
    data: dict[str, Any], actual: ScheduleResult, technical: ScheduleResult
) -> list[dict[str, Any]]:
    systems, packages, activities = _activity_maps(data)
    resources = {row["resource_id"]: row for row in data["resources"]}
    zones = {row["zone_id"]: row for row in data["zones"]}
    demands_r, demands_z, usage_r, usage_z = _usage(data, actual)
    incoming: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for dependency in data["dependencies"]:
        if dependency.get("enabled") and dependency["target_type"] == "ACTIVITY":
            incoming[dependency["target_id"]].append(dependency)

    rows: list[dict[str, Any]] = []
    for activity_id, scheduled in actual.activities.items():
        baseline = technical.activities[activity_id]
        blockers: set[str] = set()
        for slot in baseline.work_slots:
            for resource_id, demand in demands_r[activity_id]:
                other = [(aid, qty) for aid, qty in usage_r.get((resource_id, slot), []) if aid != activity_id]
                if sum(qty for _, qty in other) + demand > float(resources[resource_id]["capacity"]) + 1e-9:
                    blockers.add(f"resource {resource_id}: {','.join(aid for aid, _ in other)}")
            for zone_id, demand in demands_z[activity_id]:
                other = [(aid, qty) for aid, qty in usage_z.get((zone_id, slot), []) if aid != activity_id]
                if sum(qty for _, qty in other) + demand > float(zones[zone_id]["capacity"]) + 1e-9:
                    blockers.add(f"zone {zone_id}: {','.join(aid for aid, _ in other)}")

        predecessor_ready: list[tuple[float, str]] = []
        for dependency in incoming[activity_id]:
            source_id = dependency["source_id"]
            if dependency["source_type"] == "ACTIVITY" and source_id in actual.activities:
                ready = actual.activities[source_id].end_h + float(dependency.get("lag_h", 0))
            elif dependency["source_type"] == "GATE" and source_id in actual.gates:
                ready = actual.gates[source_id] + float(dependency.get("lag_h", 0))
            else:
                continue
            predecessor_ready.append((ready, source_id))
        max_ready = max([value for value, _ in predecessor_ready], default=0)
        binding_predecessors = sorted(source for value, source in predecessor_ready if abs(value - max_ready) < 1e-9)

        system_id = packages[activities[activity_id]["package_id"]]["system_id"]
        delay_h = scheduled.start_h - baseline.start_h
        if delay_h <= 0:
            primary_reason = "technical, arrival and calendar constraints"
        elif blockers:
            primary_reason = "resource or zone contention"
        elif max_ready > baseline.start_h:
            primary_reason = "predecessor completion"
        else:
            primary_reason = "global makespan optimization / downstream contention"
        rows.append(
            {
                "activity_id": activity_id,
                "system_id": system_id,
                "package_id": activities[activity_id]["package_id"],
                "earliest_technical_start": hour_to_datetime(technical, baseline.start_h).isoformat(),
                "actual_start": hour_to_datetime(actual, scheduled.start_h).isoformat(),
                "actual_end": hour_to_datetime(actual, scheduled.end_h).isoformat(),
                "start_delay_h": delay_h,
                "binding_predecessors": ";".join(binding_predecessors),
                "resource_or_zone_blockers": ";".join(sorted(blockers)),
                "primary_reason": primary_reason,
            }
        )
    return sorted(rows, key=lambda row: (row["actual_start"], row["system_id"], row["activity_id"]))


def _write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str] | None = None) -> None:
    if not rows and fieldnames is None:
        return
    fieldnames = fieldnames or list(rows[0])
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def _plot_gantt(data: dict[str, Any], result: ScheduleResult, path: Path, detail: bool) -> None:
    systems, packages, activities = _activity_maps(data)
    colors = {
        system_id: plt.get_cmap("tab10")(index % 10)
        for index, system_id in enumerate(sorted(systems))
    }
    if detail:
        entries = []
        for activity_id, scheduled in result.activities.items():
            activity = activities[activity_id]
            package = packages[activity["package_id"]]
            entries.append((package["system_id"], package.get("display_order", 0), package["package_id"], activity_id, scheduled.segments))
        entries.sort(key=lambda item: (item[0], item[1], item[2], result.activities[item[3]].start_h, item[3]))
        labels = [f"{system_id} / {package_id} / {activity_id}" for system_id, _, package_id, activity_id, _ in entries]
        segments = [(system_id, activity_segments) for system_id, _, _, _, activity_segments in entries]
        figure_height = max(10, 0.28 * len(entries))
        title = "Optimized schedule — activity detail"
    else:
        grouped: dict[str, list[int]] = defaultdict(list)
        for activity_id, scheduled in result.activities.items():
            grouped[activities[activity_id]["package_id"]].extend(scheduled.work_slots)
        entries = []
        for package_id, slots in grouped.items():
            package = packages[package_id]
            entries.append((package["system_id"], package.get("display_order", 0), package_id, min(slots), max(slots) + 1))
        entries.sort(key=lambda item: (item[0], item[1], item[2]))
        labels = [f"{system_id} / {package_id}" for system_id, _, package_id, _, _ in entries]
        segments = [(system_id, [(start, end)]) for system_id, _, _, start, end in entries]
        figure_height = max(6, 0.45 * len(entries))
        title = "Optimized schedule — package summary"

    fig, ax = plt.subplots(figsize=(16, figure_height), constrained_layout=True)
    for y, (system_id, activity_segments) in enumerate(segments):
        for start, end in activity_segments:
            start_date = mdates.date2num(hour_to_datetime(result, start))
            end_date = mdates.date2num(hour_to_datetime(result, end))
            ax.broken_barh([(start_date, end_date - start_date)], (y - 0.35, 0.7), facecolors=colors[system_id])
    completion = mdates.date2num(hour_to_datetime(result, result.objective_h))
    ax.axvline(completion, color="#9B1C1C", linestyle="--", linewidth=1.2, label=result.objective_gate)
    ax.set_yticks(range(len(labels)), labels=labels)
    ax.invert_yaxis()
    ax.xaxis.set_major_locator(mdates.WeekdayLocator(interval=1))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m-%d"))
    ax.grid(axis="x", color="#D9D9D9", linewidth=0.6)
    ax.set_xlabel(f"Local date/time ({result.project_start.tzinfo})")
    ax.set_title(title)
    ax.legend(loc="upper right")
    fig.autofmt_xdate(rotation=35, ha="right")
    fig.savefig(path, dpi=160)
    plt.close(fig)


def write_outputs(
    data: dict[str, Any],
    actual: ScheduleResult,
    technical: ScheduleResult,
    output_dir: str | Path,
    validation_report: dict[str, Any],
) -> dict[str, Any]:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    systems, packages, activities = _activity_maps(data)
    schedule_rows: list[dict[str, Any]] = []
    for activity_id, scheduled in sorted(actual.activities.items(), key=lambda item: (item[1].start_h, item[0])):
        activity = activities[activity_id]
        package = packages[activity["package_id"]]
        schedule_rows.append(
            {
                "system_id": package["system_id"],
                "package_id": activity["package_id"],
                "activity_id": activity_id,
                "name": activity["name"],
                "duration_h": activity["duration_h"],
                "duration_basis": activity["duration_basis"],
                "preemptible": activity["preemptible"],
                "start": hour_to_datetime(actual, scheduled.start_h).isoformat(),
                "end": hour_to_datetime(actual, scheduled.end_h).isoformat(),
                "segments": ";".join(
                    f"{hour_to_datetime(actual, start).isoformat()}->{hour_to_datetime(actual, end).isoformat()}"
                    for start, end in scheduled.segments
                ),
            }
        )
    gate_rows = [
        {"gate_id": gate_id, "time": hour_to_datetime(actual, hour).isoformat(), "hour": hour}
        for gate_id, hour in sorted(actual.gates.items(), key=lambda item: (item[1], item[0]))
    ]
    diagnostics = build_diagnostics(data, actual, technical)
    _write_csv(output_dir / "schedule.csv", schedule_rows)
    _write_csv(output_dir / "gates.csv", gate_rows)
    _write_csv(output_dir / "diagnostics.csv", diagnostics)
    (output_dir / "validation_report.json").write_text(json.dumps(validation_report, indent=2), encoding="utf-8")
    (output_dir / "normalized_project.json").write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    _plot_gantt(data, actual, output_dir / "gantt.png", detail=False)
    _plot_gantt(data, actual, output_dir / "gantt_activities.png", detail=True)
    summary = {
        "optimal": actual.optimal,
        "objective_gate": actual.objective_gate,
        "project_start": actual.project_start.isoformat(),
        "project_complete": hour_to_datetime(actual, actual.objective_h).isoformat(),
        "project_duration_h": actual.objective_h,
        "activity_count": len(actual.activities),
        "gate_count": len(actual.gates),
        "solver_message": actual.solver_message,
    }
    (output_dir / "run_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary
