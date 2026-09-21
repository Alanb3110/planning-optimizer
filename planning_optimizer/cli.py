from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .loader import ProjectValidationError, load_project
from .reporting import schedule_validation_errors, write_outputs
from .solver import TimeIndexedScheduler, validate_schedule


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local planning optimizer prototype")
    subparsers = parser.add_subparsers(dest="command", required=True)
    audit = subparsers.add_parser("audit", help="Load and validate an Excel project")
    audit.add_argument("--input", required=True, type=Path)
    schedule = subparsers.add_parser("schedule", help="Validate, optimize and write schedule outputs")
    schedule.add_argument("--input", required=True, type=Path)
    schedule.add_argument("--output", required=True, type=Path, help="Output directory (preferably outside the repository)")
    schedule.add_argument("--horizon-days", type=int, default=None)
    schedule.add_argument("--time-limit", type=float, default=120.0)
    dashboard = subparsers.add_parser("dashboard", help="Start the local Streamlit dashboard")
    dashboard.add_argument("--port", type=int, default=8501)
    return parser


def _launch_dashboard(port: int) -> int:
    from streamlit.web import cli as streamlit_cli

    app_path = Path(__file__).with_name("dashboard.py")
    sys.argv = [
        "streamlit",
        "run",
        str(app_path),
        "--server.address=127.0.0.1",
        f"--server.port={port}",
        "--server.headless=true",
        "--browser.gatherUsageStats=false",
    ]
    result = streamlit_cli.main()
    return int(result or 0)


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "dashboard":
        return _launch_dashboard(args.port)

    try:
        project = load_project(args.input, strict=True)
    except ProjectValidationError as error:
        print(json.dumps(error.report.as_dict(), indent=2), file=sys.stderr)
        return 2

    if args.command == "audit":
        print(json.dumps(project.report.as_dict(), indent=2))
        return 0

    try:
        actual = TimeIndexedScheduler(
            project.data,
            horizon_days=args.horizon_days,
            time_limit_s=args.time_limit,
            enforce_capacities=True,
        ).solve()
        technical = TimeIndexedScheduler(
            project.data,
            horizon_days=max(1, actual.horizon_h // 24),
            time_limit_s=args.time_limit,
            enforce_capacities=False,
        ).solve()
    except (RuntimeError, ValueError) as error:
        print(f"Scheduling failed: {error}", file=sys.stderr)
        return 3

    post_errors = validate_schedule(project.data, actual) + schedule_validation_errors(project.data, actual)
    if post_errors:
        print(json.dumps({"post_solve_errors": post_errors}, indent=2), file=sys.stderr)
        return 4
    summary = write_outputs(project.data, actual, technical, args.output, project.report.as_dict())
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
