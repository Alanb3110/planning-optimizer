from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest

from planning_optimizer.calendars import build_calendar_slots, hour_offset
from planning_optimizer.solver import TimeIndexedScheduler, ScheduleResult, hour_to_datetime


def fixture(start: str, shifts: list[tuple[str, str, str, str]]) -> dict:
    return {
        "metadata": {"project_start": start, "active_calendar": "WORK"},
        "systems": [{"system_id": "S", "arrival_date": start}],
        "packages": [{"package_id": "P", "system_id": "S"}],
        "activities": [{"activity_id": "A", "package_id": "P", "duration_h": 1,
                        "duration_basis": "WORK_TIME", "preemptible": False}],
        "gates": [{"gate_id": "DONE", "gate_type": "PROJECT_COMPLETE"}],
        "dependencies": [],
        "resources": [{"resource_id": "R", "capacity": 1, "calendar_id": "CREW"}],
        "activity_resources": [{"activity_id": "A", "resource_id": "R", "quantity": 1}],
        "zones": [{"zone_id": "Z", "capacity": 1, "calendar_id": "AREA"}],
        "activity_zones": [{"activity_id": "A", "zone_id": "Z", "load": 1}],
        "calendars": [
            {"calendar_id": "WORK", "timezone": "Europe/Paris"},
            {"calendar_id": "CREW", "timezone": "UTC"},
            {"calendar_id": "AREA", "timezone": "Asia/Tokyo"},
        ],
        "calendar_shifts": [
            {"calendar_id": calendar, "weekday": day, "start_time": begin,
             "end_time": finish, "enabled": True}
            for calendar, day, begin, finish in shifts
        ],
        "milestone_priorities": [{"gate_id": "DONE", "priority": 1, "enabled": True}],
    }


def enabled_hours(data: dict, calendar: str, horizon: int) -> list[str]:
    start = datetime.fromisoformat(data["metadata"]["project_start"])
    slots = build_calendar_slots(data, start, horizon)[calendar]
    return [(start.astimezone(timezone.utc) + timedelta(hours=index)).isoformat()
            for index, enabled in enumerate(slots) if enabled]


class CalendarTimezoneTests(unittest.TestCase):
    def test_three_timezones_intersect_for_work_resource_and_zone(self):
        start = "2026-03-29T00:00:00+00:00"
        data = fixture(start, [("WORK", "SUN", "01:00", "05:00"),
                               ("CREW", "SUN", "01:00", "04:00"),
                               ("AREA", "SUN", "10:00", "12:00")])
        self.assertEqual(enabled_hours(data, "WORK", 6), [
            "2026-03-29T00:00:00+00:00", "2026-03-29T01:00:00+00:00", "2026-03-29T02:00:00+00:00"])
        self.assertEqual(enabled_hours(data, "CREW", 6), [
            "2026-03-29T01:00:00+00:00", "2026-03-29T02:00:00+00:00", "2026-03-29T03:00:00+00:00"])
        self.assertEqual(enabled_hours(data, "AREA", 6), [
            "2026-03-29T01:00:00+00:00", "2026-03-29T02:00:00+00:00"])
        scheduler = TimeIndexedScheduler(data, horizon_days=1)
        self.assertEqual([index for index, enabled in enumerate(scheduler._effective_availability("A")) if enabled], [1, 2])
        self.assertEqual(scheduler.solve().activities["A"].work_slots, [1])

    def test_spring_gap_uses_elapsed_hours(self):
        data = fixture("2026-03-29T00:00:00+00:00", [("WORK", "SUN", "01:00", "04:00")])
        self.assertEqual(enabled_hours(data, "WORK", 5), [
            "2026-03-29T00:00:00+00:00", "2026-03-29T01:00:00+00:00"])

    def test_autumn_repeated_hour_and_offsets(self):
        data = fixture("2026-10-24T23:00:00+00:00", [("WORK", "SUN", "01:00", "04:00")])
        self.assertEqual(enabled_hours(data, "WORK", 6), [
            "2026-10-24T23:00:00+00:00", "2026-10-25T00:00:00+00:00",
            "2026-10-25T01:00:00+00:00", "2026-10-25T02:00:00+00:00"])
        start = datetime.fromisoformat("2026-10-25T01:00:00+02:00")
        self.assertEqual(hour_offset(start, "2026-10-25T02:00:00+01:00"), 2)
        result = ScheduleResult({}, {}, start, "DONE", 0, 6, True, "test")
        self.assertEqual(hour_to_datetime(result, 2).astimezone(timezone.utc).isoformat(), "2026-10-25T01:00:00+00:00")

    def test_overnight_shift_continues_after_last_valid_local_date(self):
        data = fixture("2026-03-28T20:00:00+00:00", [("WORK", "SAT", "22:00", "04:00")])
        data["calendars"][0].update(valid_from="2026-03-28", valid_to="2026-03-28")
        self.assertEqual(enabled_hours(data, "WORK", 9), [
            "2026-03-28T21:00:00+00:00", "2026-03-28T22:00:00+00:00",
            "2026-03-28T23:00:00+00:00", "2026-03-29T00:00:00+00:00",
            "2026-03-29T01:00:00+00:00"])

    def test_muscat_fixed_offset_and_project_zone_before_dst(self):
        data = fixture("2026-03-29T00:00:00+04:00", [("WORK", "SUN", "08:00", "16:00")])
        data["calendars"][0]["timezone"] = "Asia/Muscat"
        self.assertEqual(enabled_hours(data, "WORK", 24), [
            "2026-03-29T04:00:00+00:00", "2026-03-29T05:00:00+00:00",
            "2026-03-29T06:00:00+00:00", "2026-03-29T07:00:00+00:00",
            "2026-03-29T08:00:00+00:00", "2026-03-29T09:00:00+00:00",
            "2026-03-29T10:00:00+00:00", "2026-03-29T11:00:00+00:00"])
        data = fixture("2026-03-29T00:00:00+01:00", [("WORK", "SUN", "01:00", "04:00")])
        self.assertEqual(enabled_hours(data, "WORK", 6), [
            "2026-03-29T00:00:00+00:00", "2026-03-29T01:00:00+00:00"])


if __name__ == "__main__":
    unittest.main()
