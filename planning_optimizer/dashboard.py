from __future__ import annotations

import csv
from hashlib import sha256
from io import BytesIO, StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
import zipfile

import streamlit as st

from planning_optimizer.loader import load_project
from planning_optimizer.reporting import schedule_validation_errors, write_outputs
from planning_optimizer.solver import TimeIndexedScheduler, validate_schedule


def _rows(csv_bytes: bytes) -> list[dict[str, str]]:
    return list(csv.DictReader(StringIO(csv_bytes.decode("utf-8"))))


def _zip_outputs(artifacts: dict[str, bytes]) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(artifacts.items()):
            archive.writestr(name, content)
    return buffer.getvalue()


def _solve(data: dict, report: dict, horizon_days: int | None, time_limit_s: float) -> dict:
    actual = TimeIndexedScheduler(
        data,
        horizon_days=horizon_days,
        time_limit_s=time_limit_s,
        enforce_capacities=True,
    ).solve()
    technical = TimeIndexedScheduler(
        data,
        horizon_days=max(1, actual.horizon_h // 24),
        time_limit_s=time_limit_s,
        enforce_capacities=False,
    ).solve()
    post_errors = validate_schedule(data, actual) + schedule_validation_errors(data, actual)
    if post_errors:
        raise RuntimeError("Post-solve validation failed: " + " | ".join(post_errors))

    with TemporaryDirectory(prefix="planning-optimizer-") as temporary_directory:
        output_dir = Path(temporary_directory)
        summary = write_outputs(data, actual, technical, output_dir, report)
        artifacts = {path.name: path.read_bytes() for path in output_dir.iterdir() if path.is_file()}

    return {
        "summary": summary,
        "schedule": _rows(artifacts["schedule.csv"]),
        "gates": _rows(artifacts["gates.csv"]),
        "diagnostics": _rows(artifacts["diagnostics.csv"]),
        "gantt": artifacts["gantt.png"],
        "gantt_activities": artifacts["gantt_activities.png"],
        "archive": _zip_outputs(artifacts),
    }


def main() -> None:
    st.set_page_config(page_title="Planning Optimizer", layout="wide")
    st.title("Planning Optimizer")
    st.caption("Local prototype. Uploaded project data is processed by the local Python process.")

    uploaded = st.file_uploader("Project workbook", type=["xlsx"], accept_multiple_files=False)
    if uploaded is None:
        st.info("Select a local .xlsx project workbook to validate and schedule.")
        return

    payload = uploaded.getvalue()
    input_hash = sha256(payload).hexdigest()
    if st.session_state.get("input_hash") != input_hash:
        st.session_state["input_hash"] = input_hash
        st.session_state.pop("schedule_result", None)

    try:
        project = load_project(BytesIO(payload), strict=False)
    except Exception as error:
        st.error(f"The workbook could not be read: {error}")
        return

    report = project.report.as_dict()
    if report["errors"]:
        st.error(f"Validation failed with {len(report['errors'])} error(s).")
        for error in report["errors"]:
            st.write(f"- {error}")
    else:
        st.success("Workbook validation passed.")

    if report["warnings"]:
        with st.expander(f"Validation warnings ({len(report['warnings'])})"):
            for warning in report["warnings"]:
                st.write(f"- {warning}")

    if not project.data:
        return

    columns = st.columns(4)
    columns[0].metric("Systems", len(project.data.get("systems", [])))
    columns[1].metric("Packages", len(project.data.get("packages", [])))
    columns[2].metric("Activities", len(project.data.get("activities", [])))
    columns[3].metric("Gates", len(project.data.get("gates", [])))

    settings = st.columns(2)
    horizon = settings[0].number_input(
        "Planning horizon (days, 0 = automatic)", min_value=0, max_value=730, value=0, step=1
    )
    time_limit = settings[1].number_input(
        "Solver time limit (s)", min_value=1, max_value=600, value=60, step=1
    )

    if st.button("Calculate schedule", type="primary", disabled=bool(report["errors"])):
        try:
            with st.spinner("Validating and optimizing the schedule..."):
                st.session_state["schedule_result"] = _solve(
                    project.data,
                    report,
                    None if horizon == 0 else int(horizon),
                    float(time_limit),
                )
        except Exception as error:
            st.session_state.pop("schedule_result", None)
            st.error(f"Scheduling failed: {error}")

    result = st.session_state.get("schedule_result")
    if result is None:
        return

    summary = result["summary"]
    st.subheader("Schedule result")
    metrics = st.columns(4)
    metrics[0].metric("Completion", summary["project_complete"])
    metrics[1].metric("Elapsed duration", f"{summary['project_duration_h']} h")
    metrics[2].metric("Scheduled activities", summary["activity_count"])
    metrics[3].metric("Optimal", "Yes" if summary["optimal"] else "No")

    st.image(result["gantt"], caption="Package-level Gantt", use_container_width=True)
    with st.expander("Activity-level Gantt"):
        st.image(result["gantt_activities"], use_container_width=True)

    st.subheader("Activity schedule")
    st.dataframe(result["schedule"], use_container_width=True, hide_index=True)

    with st.expander("Scheduling diagnostics"):
        st.dataframe(result["diagnostics"], use_container_width=True, hide_index=True)
    with st.expander("Gate dates"):
        st.dataframe(result["gates"], use_container_width=True, hide_index=True)

    st.download_button(
        "Download all results",
        data=result["archive"],
        file_name="planning_optimizer_results.zip",
        mime="application/zip",
    )


if __name__ == "__main__":
    main()
