from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from io import BytesIO
import json
from pathlib import Path
import unittest

from jsonschema import Draft202012Validator, FormatChecker
from openpyxl import load_workbook

from planning_optimizer.loader import load_project, validate_project
from planning_optimizer.reporting import schedule_validation_errors
from planning_optimizer.solver import TimeIndexedScheduler, validate_schedule
from planning_optimizer.dashboard import _solve

from project_factory import synthetic_project


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "synthetic_project.xlsx"


class PrototypeTests(unittest.TestCase):
    def test_reference_schema_matches_browser_copy(self):
        reference = (ROOT / "schema" / "planning_optimizer_schema_v1.json").read_bytes()
        browser = (ROOT / "web" / "src" / "schema" / "planning_optimizer_schema_v1.json").read_bytes()
        self.assertEqual(reference, browser, "V1 schema copies diverged; update both together")
        Draft202012Validator.check_schema(json.loads(reference))

    def test_reference_schema_follows_v1_exchange_contract(self):
        schema = json.loads((ROOT / "schema" / "planning_optimizer_schema_v1.json").read_text(encoding="utf-8"))
        self.assertIn("objective_gate", schema["properties"]["metadata"]["properties"])
        self.assertNotIn("resource_substitutions", schema["required"])
        self.assertEqual(schema["$defs"]["activity"]["properties"]["duration_h"]["minimum"], 0)
        self.assertIn("requires_system_arrival", schema["$defs"]["activity"]["properties"])

    def test_synthetic_workbook_loads(self):
        project = load_project(EXAMPLE)
        self.assertTrue(project.report.ok, project.report.errors)
        self.assertEqual(project.data["metadata"]["project_id"], "SYNTHETIC_DEMO")
        self.assertEqual(len(project.data["activities"]), 6)
        schema = json.loads((ROOT / "schema" / "planning_optimizer_schema_v1.json").read_text(encoding="utf-8"))
        errors = sorted(
            Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(project.data),
            key=lambda error: list(error.path),
        )
        self.assertEqual([error.message for error in errors], [])

    def test_synthetic_workbook_loads_from_memory(self):
        project = load_project(BytesIO(EXAMPLE.read_bytes()))
        self.assertTrue(project.report.ok, project.report.errors)
        self.assertEqual(project.data["metadata"]["project_id"], "SYNTHETIC_DEMO")

    def test_end_to_end_schedule_semantics(self):
        data = synthetic_project()
        report = validate_project(data)
        self.assertEqual(report.errors, [])

        result = TimeIndexedScheduler(data, horizon_days=14, time_limit_s=30).solve()
        self.assertEqual(validate_schedule(data, result), [])
        self.assertEqual(schedule_validation_errors(data, result), [])

        activities = result.activities
        arrival_h = int(
            (
                datetime.fromisoformat("2030-01-09T08:00:00+00:00")
                - datetime.fromisoformat(data["metadata"]["project_start"])
            ).total_seconds()
            / 3600
        )
        self.assertLess(activities["ROUTE_SERVICES"].start_h, arrival_h)
        self.assertGreaterEqual(activities["ACCEPT_SKID"].start_h, arrival_h)
        self.assertGreater(len(activities["ROUTE_SERVICES"].segments), 1)

        positioned = activities["POSITION_SKID"]
        self.assertEqual(positioned.end_h - positioned.start_h, 8)
        self.assertEqual(positioned.segments, [(positioned.start_h, positioned.end_h)])
        self.assertGreaterEqual(positioned.start_h, result.gates["SKID_AVAILABLE"])

        final_connection = activities["FINAL_CONNECTION"]
        self.assertGreaterEqual(final_connection.start_h, result.gates["SKID_POSITIONED"])
        self.assertGreaterEqual(final_connection.start_h, activities["ROUTE_SERVICES"].end_h)

        cure = activities["SEAL_CURE"]
        self.assertEqual(cure.end_h - cure.start_h, 24)
        self.assertEqual(cure.segments, [(cure.start_h, cure.end_h)])
        self.assertEqual(result.gates["PROJECT_COMPLETE"], cure.end_h)

        prep_slots = set(activities["PREPARE_FOUNDATION"].work_slots)
        routing_slots = set(activities["ROUTE_SERVICES"].work_slots)
        self.assertFalse(prep_slots & routing_slots)

    def test_duplicate_enabled_priority_is_rejected(self):
        data = deepcopy(synthetic_project())
        data["milestone_priorities"].insert(
            0,
            {"gate_id": "SKID_POSITIONED", "priority": 1, "enabled": True, "notes": "Invalid tie"},
        )
        report = validate_project(data)
        self.assertTrue(any("priority 1 is duplicated" in error for error in report.errors))

    def test_optional_v1_fields_and_semantic_duration(self):
        data = deepcopy(synthetic_project())
        data.pop("resource_substitutions")
        data["activities"][0].pop("requires_system_arrival")
        data["milestone_priorities"].append({"gate_id": "SKID_POSITIONED", "enabled": False})
        self.assertEqual(validate_project(data).errors, [])
        data["activities"][0]["duration_h"] = 0
        self.assertTrue(any("duration_h" in error for error in validate_project(data).errors))
        data["activities"][0]["duration_h"] = 0.5
        self.assertTrue(any("whole number" in error for error in validate_project(data).errors))

    def test_optional_substitutions_worksheet(self):
        workbook = load_workbook(EXAMPLE)
        del workbook["ResourceSubstitutions"]
        buffer = BytesIO()
        workbook.save(buffer)
        project = load_project(buffer)
        self.assertEqual(project.data["resource_substitutions"], [])
        self.assertTrue(project.report.ok, project.report.errors)

    def test_dashboard_backend_returns_downloadable_results_in_memory(self):
        data = synthetic_project()
        report = validate_project(data)
        result = _solve(data, report.as_dict(), horizon_days=14, time_limit_s=30)
        self.assertGreater(len(result["archive"]), 1000)
        self.assertGreater(len(result["gantt"]), 1000)
        self.assertEqual(len(result["schedule"]), len(data["activities"]))


if __name__ == "__main__":
    unittest.main()
