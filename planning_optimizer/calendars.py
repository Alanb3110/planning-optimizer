from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any


WEEKDAY = {"MON": 0, "TUE": 1, "WED": 2, "THU": 3, "FRI": 4, "SAT": 5, "SUN": 6}


def parse_datetime(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def hour_offset(project_start: datetime, value: str | datetime) -> int:
    delta_h = (parse_datetime(value) - project_start).total_seconds() / 3600
    rounded = round(delta_h)
    if abs(delta_h - rounded) > 1e-9:
        raise ValueError(f"Date-time {value!r} is not aligned to the 1 h scheduling grid.")
    return int(rounded)


def _parse_time(value: str) -> time:
    return datetime.strptime(value, "%H:%M").time()


def build_calendar_slots(data: dict[str, Any], project_start: datetime, horizon_h: int) -> dict[str, list[bool]]:
    calendars = {row["calendar_id"]: row for row in data["calendars"]}
    shifts_by_calendar: dict[str, list[dict[str, Any]]] = {key: [] for key in calendars}
    for shift in data["calendar_shifts"]:
        if shift.get("enabled"):
            shifts_by_calendar.setdefault(shift["calendar_id"], []).append(shift)

    end = project_start + timedelta(hours=horizon_h)
    output: dict[str, list[bool]] = {}
    for calendar_id, calendar in calendars.items():
        intervals: list[tuple[datetime, datetime]] = []
        start_date = project_start.date() - timedelta(days=1)
        end_date = end.date() + timedelta(days=1)
        valid_from = date.fromisoformat(calendar["valid_from"]) if calendar.get("valid_from") else None
        valid_to = date.fromisoformat(calendar["valid_to"]) if calendar.get("valid_to") else None
        current = start_date
        while current <= end_date:
            if (valid_from is None or current >= valid_from) and (valid_to is None or current <= valid_to):
                for shift in shifts_by_calendar.get(calendar_id, []):
                    if WEEKDAY[shift["weekday"]] != current.weekday():
                        continue
                    shift_start = datetime.combine(current, _parse_time(shift["start_time"]), tzinfo=project_start.tzinfo)
                    shift_end = datetime.combine(current, _parse_time(shift["end_time"]), tzinfo=project_start.tzinfo)
                    if shift_end <= shift_start:
                        shift_end += timedelta(days=1)
                    intervals.append((shift_start, shift_end))
            current += timedelta(days=1)
        availability: list[bool] = []
        for t in range(horizon_h):
            slot_start = project_start + timedelta(hours=t)
            slot_end = slot_start + timedelta(hours=1)
            availability.append(any(slot_start >= start and slot_end <= finish for start, finish in intervals))
        output[calendar_id] = availability
    return output


def contiguous_runs(slots: list[bool]) -> list[tuple[int, int]]:
    """Return half-open index intervals for True runs."""
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, enabled in enumerate([*slots, False]):
        if enabled and start is None:
            start = index
        elif not enabled and start is not None:
            runs.append((start, index))
            start = None
    return runs


def segments_from_slots(slots: list[int]) -> list[tuple[int, int]]:
    if not slots:
        return []
    ordered = sorted(slots)
    result: list[tuple[int, int]] = []
    start = previous = ordered[0]
    for slot in ordered[1:]:
        if slot != previous + 1:
            result.append((start, previous + 1))
            start = slot
        previous = slot
    result.append((start, previous + 1))
    return result
