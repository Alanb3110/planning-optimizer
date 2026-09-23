import { useMemo, useState, type CSSProperties } from "react";
import { downloadScheduleBundle, type RunSettings } from "../lib/exports";
import { calendarTicks, resultTimezone, sortedActivities } from "../lib/schedulePresentation";
import { explainActivity } from "../lib/scheduleExplanation";
import type { WorkbookImportResult } from "../lib/model";
import type {
  ScheduleResult,
  ScheduledActivity,
  SchedulingActivity,
  SchedulingPackage,
  SchedulingProject,
  SchedulingSystem,
} from "../lib/scheduler/types";

interface ScheduleResultsProps {
  project: SchedulingProject;
  result: ScheduleResult;
  validation: WorkbookImportResult;
  settings: RunSettings;
  solveDurationMs: number | null;
}

interface ActivityRow {
  activity: SchedulingActivity;
  scheduled: ScheduledActivity;
  package: SchedulingPackage;
  system: SchedulingSystem;
}

const HOUR_MS = 3_600_000;
const SYSTEM_COLORS = ["#146b63", "#315c8c", "#7a5532", "#6c4f86", "#7b4c58", "#44634b"];

function displayName(record: Record<string, unknown>, fallback: string): string {
  return typeof record.name === "string" && record.name.trim() ? record.name : fallback;
}

function formatHours(hours: number): string {
  const days = Math.floor(hours / 24);
  const remaining = hours % 24;
  if (days === 0) return `${hours} h`;
  return remaining === 0 ? `${days} d` : `${days} d ${remaining} h`;
}

function projectDate(projectStart: string, offsetH: number, timezone?: string): string {
  const date = new Date(Date.parse(projectStart) + offsetH * HOUR_MS);
  if (Number.isNaN(date.valueOf())) return `H+${offsetH}`;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

function compactDate(projectStart: string, offsetH: number, timezone?: string): string {
  const date = new Date(Date.parse(projectStart) + offsetH * HOUR_MS);
  if (Number.isNaN(date.valueOf())) return `H+${offsetH}`;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return `H+${offsetH}`;
  }
}

function executionLabel(scheduled: ScheduledActivity): string {
  return scheduled.segments.map(([start, end]) => `H+${start}–${end}`).join(", ");
}

function buildRows(project: SchedulingProject, result: ScheduleResult): ActivityRow[] {
  const packages = Object.fromEntries(project.packages.map((item) => [item.package_id, item]));
  const systems = Object.fromEntries(project.systems.map((item) => [item.system_id, item]));
  return sortedActivities(project, Object.values(result.activities))
    .map((scheduled) => {
      const activity = project.activities.find((item) => item.activity_id === scheduled.activityId);
      if (!activity) return null;
      const packageItem = packages[activity.package_id];
      const system = packageItem ? systems[packageItem.system_id] : undefined;
      if (!packageItem || !system) return null;
      return { activity, scheduled, package: packageItem, system };
    })
    .filter((row): row is ActivityRow => row !== null);
}

function GanttChart({ rows, result, timezone }: { rows: ActivityRow[]; result: ScheduleResult; timezone: string }) {
  const chartEnd = Math.max(
    24,
    result.objectiveH,
    ...rows.map(({ scheduled }) => scheduled.endH),
    ...Object.values(result.gates),
  );
  const roundedEnd = Math.ceil(chartEnd / 24) * 24;
  const ticks = calendarTicks(result.projectStart, roundedEnd, timezone);
  const systemIndex = new Map<string, number>();
  rows.forEach(({ system }) => {
    if (!systemIndex.has(system.system_id)) systemIndex.set(system.system_id, systemIndex.size);
  });

  return (
    <section className="result-section" aria-labelledby="gantt-title">
      <div className="section-heading">
        <div>
          <span className="section-kicker">Timeline</span>
          <h3 id="gantt-title">Activity Gantt</h3>
        </div>
        <div className="gantt-legend" aria-label="Gantt legend">
          <span><i className="legend-solid" /> Work segment</span>
          <span><i className="legend-gap" /> Preemption gap</span>
        </div>
      </div>
      <div className="gantt-scroll" tabIndex={0} aria-label="Scrollable activity Gantt">
        <div className="gantt" style={{ "--chart-width": `${Math.max(720, roundedEnd * 5)}px` } as CSSProperties}>
          <div className="gantt-axis-label">System / package / activity</div>
          <div className="gantt-axis" aria-label={`Calendar dates in ${timezone}; H+ is elapsed hours from project start`}>
            {ticks.map((tick) => (
              <span key={tick.offsetH} style={{ left: `${(tick.offsetH / roundedEnd) * 100}%` }}>
                <strong>{tick.dateLabel}</strong><small>{tick.offsetLabel}</small>
              </span>
            ))}
          </div>
          {rows.map(({ activity, scheduled, package: packageItem, system }, index) => {
            const previous = rows[index - 1];
            const startsSystem = !previous || previous.system.system_id !== system.system_id;
            const startsPackage = startsSystem || previous.package.package_id !== packageItem.package_id;
            const color = SYSTEM_COLORS[systemIndex.get(system.system_id)! % SYSTEM_COLORS.length];
            return (
              <div className="gantt-entry" key={activity.activity_id}>
                {startsSystem && (
                  <div className="gantt-system" style={{ "--system-color": color } as CSSProperties}>
                    <div className="gantt-group-label">
                      <span>System</span>
                      <strong>{displayName(system, system.system_id)}</strong>
                      <code>{system.system_id}</code>
                    </div>
                  </div>
                )}
                {startsPackage && (
                  <div className="gantt-package" style={{ "--system-color": color } as CSSProperties}>
                    <div className="gantt-group-label">
                      <span>Package</span>
                      <strong>{displayName(packageItem, packageItem.package_id)}</strong>
                      <code>{packageItem.package_id}</code>
                    </div>
                  </div>
                )}
                <div className="gantt-row">
                  <div className="gantt-label">
                    <strong>{displayName(activity, activity.activity_id)}</strong>
                    <span>{activity.activity_id} · {activity.duration_h} h</span>
                  </div>
                  <div className="gantt-track" style={{ "--system-color": color } as CSSProperties}>
                    {ticks.map((tick) => (
                      <i className="gantt-gridline" key={tick.offsetH} style={{ left: `${(tick.offsetH / roundedEnd) * 100}%` }} />
                    ))}
                    {scheduled.segments.map(([start, end]) => (
                      <span
                        className="gantt-segment"
                        key={`${start}-${end}`}
                        style={{ left: `${(start / roundedEnd) * 100}%`, width: `${((end - start) / roundedEnd) * 100}%` }}
                        title={`${activity.activity_id}: H+${start} to H+${end}`}
                      />
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function ScheduleResults({ project, result, validation, settings, solveDurationMs }: ScheduleResultsProps) {
  const [downloadedFile, setDownloadedFile] = useState<string | null>(null);
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const rows = buildRows(project, result);
  const selectedId = rows.some((row) => row.activity.activity_id === selectedActivityId) ? selectedActivityId : rows[0]?.activity.activity_id;
  const explanation = useMemo(() => selectedId ? explainActivity(project, result, selectedId) : null, [project, result, selectedId]);
  const timezone = resultTimezone(project);
  const packageById = Object.fromEntries(project.packages.map((item) => [item.package_id, item]));
  const systemById = Object.fromEntries(project.systems.map((item) => [item.system_id, item]));
  const gateRows = Object.entries(result.gates)
    .map(([gateId, offsetH]) => ({
      gate: project.gates.find((item) => item.gate_id === gateId),
      gateId,
      offsetH,
    }))
    .sort((left, right) => left.offsetH - right.offsetH || left.gateId.localeCompare(right.gateId));
  const downloadBundle = () => {
    setDownloadedFile(downloadScheduleBundle({
      project,
      result,
      validation,
      settings,
      solveDurationMs,
    }));
  };

  return (
    <div className="schedule-output" aria-live="polite">
      <section className="export-toolbar" aria-label="Local result export">
        <div>
          <span className="section-kicker">Local export</span>
          <strong>Download the complete result bundle</strong>
          <small>ZIP generated in this browser. Dates: UTC (Z) and {timezone} local. No project data is uploaded.</small>
        </div>
        <div>
          <button className="export-button" type="button" onClick={downloadBundle}>Download result ZIP</button>
          {downloadedFile && <span className="download-status" role="status">Downloaded {downloadedFile}</span>}
        </div>
      </section>
      <section className="result-metrics" aria-label="Schedule summary">
        <div className="metric primary">
          <span>Completion date</span>
          <strong>{projectDate(result.projectStart, result.objectiveH, timezone)}</strong>
          <small>{result.objectiveGate}</small>
        </div>
        <div className="metric">
          <span>Elapsed duration</span>
          <strong>{formatHours(result.objectiveH)}</strong>
          <small>H+{result.objectiveH} from project start</small>
        </div>
        <div className="metric">
          <span>Scheduled activities</span>
          <strong>{rows.length}</strong>
          <small>{rows.reduce((sum, row) => sum + row.scheduled.segments.length, 0)} work segments</small>
        </div>
        <div className="metric">
          <span>Solver status</span>
          <strong className="optimal-status"><i /> Optimal</strong>
          <small>{result.solverMessage}{solveDurationMs === null ? "" : ` · ${(solveDurationMs / 1000).toFixed(1)} s`}</small>
        </div>
      </section>

      <GanttChart rows={rows} result={result} timezone={timezone} />

      {explanation && (
        <section className="result-section explanation" aria-labelledby="explanation-title">
          <div className="section-heading">
            <div><span className="section-kicker">Date inspection</span><h3 id="explanation-title">Why this Activity starts at H+{explanation.startH}</h3></div>
            <label htmlFor="explain-activity">Activity <select id="explain-activity" value={selectedId ?? ""} onChange={(event) => setSelectedActivityId(event.target.value)}>
              {rows.map((row) => <option key={row.activity.activity_id} value={row.activity.activity_id}>{displayName(row.activity, row.activity.activity_id)} ({row.activity.activity_id})</option>)}
            </select></label>
          </div>
          <div className="explanation-content">
            <p><strong>{selectedId}</strong> · {projectDate(result.projectStart, explanation.startH, timezone)} · H+ offsets are elapsed hours.</p>
            <h4>Required release · H+{explanation.releaseH}</h4>
            <ul>
              {explanation.predecessors.map((row) => <li key={row.id}>Dependency <code>{row.id}</code>: {row.sourceType === "ACTIVITY" ? "finish" : "time"} of {row.sourceType} <code>{row.sourceId}</code> H+{row.sourceH} + {row.lagH} h elapsed lag = H+{row.requiredH}. {row.binding ? "Binding at this start." : "Satisfied before this start."}</li>)}
              {explanation.arrival && <li>System arrival <code>{explanation.arrival.id}</code> requires H+{explanation.arrival.requiredH}. {explanation.arrival.binding ? "Binding at this start." : "Satisfied before this start."}</li>}
              {!explanation.predecessors.length && !explanation.arrival && <li>Project start H+0; no arrival requirement or incoming dependency.</li>}
            </ul>
            <h4>Calendar and capacity</h4>
            <p>{explanation.calendarIds.length ? `Calendars: ${explanation.calendarIds.join(", ")}. ` : "No calendar assigned. "}
              {explanation.calendarEarliestH === null ? "No eligible execution profile found from the release to the recorded start."
                : `First calendar-eligible start after release: H+${explanation.calendarEarliestH}. ${explanation.calendarLimited ? "Calendar availability rules out earlier starts after release." : "Calendars do not postpone the first start after release."}`}
            </p>
            {explanation.earlierProfiles > 0 && <p>{explanation.earlierProfiles} earlier calendar-eligible start(s) examined with the other scheduled activities held fixed. {explanation.earlierProfileFitsFixedSchedule
              ? "At least one fits the recorded capacity usage; these checks alone do not explain the chosen start."
              : "Every examined earlier profile exceeds at least one recorded Resource or Zone capacity. This is conditional on the other scheduled activities staying in place."}</p>}
            {explanation.occupancy.length > 0 && <ul>{explanation.occupancy.map((row) => <li key={`${row.kind}:${row.id}`}>{row.kind} <code>{row.id}</code>: at H+{row.slotH}, {row.occupants.join(", ")} use {row.used} / {row.capacity}; this Activity needs {row.demand}. Earlier placement here would exceed capacity.</li>)}</ul>}
            {explanation.earlierProfiles === 0 && <p>No calendar-eligible start exists between the release and the recorded start.</p>}
            <h4>Downstream Gates</h4>
            {explanation.downstreamGates.length ? <ul>{explanation.downstreamGates.map((gate) => <li key={gate.gateId}><code>{gate.gateId}</code> · H+{gate.atH} · {gate.direct ? (gate.binding ? "Direct dependency binding at the recorded Gate time." : "Direct dependency satisfied before the recorded Gate time.") : "Reachable through other nodes; timing effect not established."}</li>)}</ul> : <p>No reachable scheduled Gate through enabled dependencies.</p>}
            <p className="explanation-caveat">Binding means equality in this result, not proof that moving this Activity alone would change a Gate. Capacity conflicts hold only with the other Activities fixed. No critical path or causal delay is calculated.</p>
          </div>
        </section>
      )}

      <section className="result-section" aria-labelledby="activities-title">
        <div className="section-heading">
          <div><span className="section-kicker">Detailed output</span><h3 id="activities-title">Activities</h3></div>
          <span className="row-count">{rows.length} rows</span>
        </div>
        <div className="table-scroll" tabIndex={0} aria-label="Scrollable activity results table">
          <table>
            <thead><tr><th>System</th><th>Package</th><th>Activity</th><th>Start</th><th>Finish</th><th>Work</th><th>Basis</th><th>Execution segments</th></tr></thead>
            <tbody>
              {rows.map(({ activity, scheduled, package: packageItem, system }) => (
                <tr key={activity.activity_id}>
                  <td><span className="entity system-entity">SYS</span>{displayName(system, system.system_id)}<code>{system.system_id}</code></td>
                  <td><span className="entity package-entity">PKG</span>{displayName(packageItem, packageItem.package_id)}<code>{packageItem.package_id}</code></td>
                  <td><button className="activity-inspect" type="button" onClick={() => setSelectedActivityId(activity.activity_id)} aria-label={`Inspect ${activity.activity_id}`}>{displayName(activity, activity.activity_id)}</button><code>{activity.activity_id}</code></td>
                  <td><strong>H+{scheduled.startH}</strong><small>{compactDate(result.projectStart, scheduled.startH, timezone)}</small></td>
                  <td><strong>H+{scheduled.endH}</strong><small>{compactDate(result.projectStart, scheduled.endH, timezone)}</small></td>
                  <td>{activity.duration_h} h</td>
                  <td><span className="basis-badge">{activity.duration_basis}</span></td>
                  <td><code>{executionLabel(scheduled)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="result-section" aria-labelledby="gates-title">
        <div className="section-heading">
          <div><span className="section-kicker">Milestones</span><h3 id="gates-title">Gates</h3></div>
          <span className="row-count">{gateRows.length} rows</span>
        </div>
        <div className="table-scroll" tabIndex={0} aria-label="Scrollable gate results table">
          <table>
            <thead><tr><th>Gate</th><th>Type</th><th>System</th><th>Package</th><th>Time</th><th>Date</th></tr></thead>
            <tbody>
              {gateRows.map(({ gate, gateId, offsetH }) => {
                const packageItem = gate?.package_id ? packageById[gate.package_id] : undefined;
                const systemId = gate?.system_id ?? packageItem?.system_id;
                const system = systemId ? systemById[systemId] : undefined;
                return (
                  <tr key={gateId}>
                    <td><strong>{displayName(gate ?? {}, gateId)}</strong><code>{gateId}</code></td>
                    <td><span className="gate-badge">{gate?.gate_type ?? "GATE"}</span></td>
                    <td>{system ? displayName(system, system.system_id) : "—"}</td>
                    <td>{packageItem ? displayName(packageItem, packageItem.package_id) : "—"}</td>
                    <td><strong>H+{offsetH}</strong></td>
                    <td>{projectDate(result.projectStart, offsetH, timezone)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export { formatHours, projectDate };
