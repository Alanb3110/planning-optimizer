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
  return Object.values(result.activities)
    .map((scheduled) => {
      const activity = project.activities.find((item) => item.activity_id === scheduled.activityId);
      if (!activity) return null;
      const packageItem = packages[activity.package_id];
      const system = packageItem ? systems[packageItem.system_id] : undefined;
      if (!packageItem || !system) return null;
      return { activity, scheduled, package: packageItem, system };
    })
    .filter((row): row is ActivityRow => row !== null)
    .sort((left, right) =>
      left.system.system_id.localeCompare(right.system.system_id) ||
      left.package.package_id.localeCompare(right.package.package_id) ||
      left.scheduled.startH - right.scheduled.startH ||
      left.activity.activity_id.localeCompare(right.activity.activity_id),
    );
}

function GanttChart({ rows, result }: { rows: ActivityRow[]; result: ScheduleResult }) {
  const chartEnd = Math.max(
    24,
    result.objectiveH,
    ...rows.map(({ scheduled }) => scheduled.endH),
    ...Object.values(result.gates),
  );
  const roundedEnd = Math.ceil(chartEnd / 24) * 24;
  const tickStep = roundedEnd <= 168 ? 24 : roundedEnd <= 336 ? 48 : 96;
  const ticks = Array.from({ length: Math.floor(roundedEnd / tickStep) + 1 }, (_, index) => index * tickStep);
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
        <div className="gantt" style={{ "--chart-width": `${Math.max(720, roundedEnd * 5)}px` } as React.CSSProperties}>
          <div className="gantt-axis-label">System / package / activity</div>
          <div className="gantt-axis" aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick} style={{ left: `${(tick / roundedEnd) * 100}%` }}>H+{tick}</span>
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
                  <div className="gantt-system" style={{ "--system-color": color } as React.CSSProperties}>
                    <span>System</span>
                    <strong>{displayName(system, system.system_id)}</strong>
                    <code>{system.system_id}</code>
                  </div>
                )}
                {startsPackage && (
                  <div className="gantt-package" style={{ "--system-color": color } as React.CSSProperties}>
                    <span>Package</span>
                    <strong>{displayName(packageItem, packageItem.package_id)}</strong>
                    <code>{packageItem.package_id}</code>
                  </div>
                )}
                <div className="gantt-row">
                  <div className="gantt-label">
                    <strong>{displayName(activity, activity.activity_id)}</strong>
                    <span>{activity.activity_id} · {activity.duration_h} h</span>
                  </div>
                  <div className="gantt-track" style={{ "--system-color": color } as React.CSSProperties}>
                    {ticks.map((tick) => (
                      <i className="gantt-gridline" key={tick} style={{ left: `${(tick / roundedEnd) * 100}%` }} />
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

export function ScheduleResults({ project, result, solveDurationMs }: ScheduleResultsProps) {
  const rows = buildRows(project, result);
  const activeCalendar = project.calendars.find(
    (calendar) => calendar.calendar_id === project.metadata.active_calendar,
  );
  const timezone = activeCalendar?.timezone ?? project.calendars[0]?.timezone;
  const packageById = Object.fromEntries(project.packages.map((item) => [item.package_id, item]));
  const systemById = Object.fromEntries(project.systems.map((item) => [item.system_id, item]));
  const gateRows = Object.entries(result.gates)
    .map(([gateId, offsetH]) => ({
      gate: project.gates.find((item) => item.gate_id === gateId),
      gateId,
      offsetH,
    }))
    .sort((left, right) => left.offsetH - right.offsetH || left.gateId.localeCompare(right.gateId));

  return (
    <div className="schedule-output" aria-live="polite">
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

      <GanttChart rows={rows} result={result} />

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
                  <td><strong>{displayName(activity, activity.activity_id)}</strong><code>{activity.activity_id}</code></td>
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
