import type { WorkbookImportResult } from "./model";
import type { ScheduleResult, SchedulingProject } from "./scheduler/types";
import { calendarTicks, localIso, resultTimezone, sortedActivities } from "./schedulePresentation";
import { createZip, type ZipEntry } from "./zip";

export interface RunSettings {
  horizonDays: number;
  timeLimitS: number;
}

export interface ExportDiagnostic {
  severity: string;
  code: string;
  message: string;
  entityId?: string;
}

export interface ScheduleBundleInput {
  project: SchedulingProject;
  result: ScheduleResult;
  validation: WorkbookImportResult;
  settings: RunSettings;
  solveDurationMs: number | null;
  diagnostics?: ExportDiagnostic[];
  generatedAt?: Date;
}

export interface ScheduleBundle {
  fileName: string;
  entries: ZipEntry[];
  generatedAt: Date;
}

const HOUR_MS = 3_600_000;
const SYSTEM_COLORS = ["#146b63", "#315c8c", "#7a5532", "#6c4f86", "#7b4c58", "#44634b"];

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function csvCell(value: unknown): string {
  const normalized = text(value);
  return /[",\r\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

function csv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function isoAt(projectStart: string, offsetH: number): string {
  return new Date(Date.parse(projectStart) + offsetH * HOUR_MS).toISOString();
}

function name(record: Record<string, unknown> | undefined, fallback: string): string {
  return record && typeof record.name === "string" && record.name.trim() ? record.name : fallback;
}

function safeFilePart(value: unknown, fallback: string): string {
  const normalized = text(value).trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function xml(value: unknown): string {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function scheduleCsv(project: SchedulingProject, result: ScheduleResult): string {
  const timezone = resultTimezone(project);
  const packageById = Object.fromEntries(project.packages.map((item) => [item.package_id, item]));
  const systemById = Object.fromEntries(project.systems.map((item) => [item.system_id, item]));
  const activityById = Object.fromEntries(project.activities.map((item) => [item.activity_id, item]));
  const projectId = project.metadata.project_id;
  const revisionId = project.metadata.revision_id;
  const rows = Object.values(result.activities)
    .sort((left, right) => left.startH - right.startH || left.activityId.localeCompare(right.activityId))
    .map((scheduled) => {
      const activity = activityById[scheduled.activityId];
      const packageItem = packageById[activity.package_id];
      const system = systemById[packageItem.system_id];
      return [
        projectId,
        revisionId,
        system.system_id,
        name(system, system.system_id),
        packageItem.package_id,
        name(packageItem, packageItem.package_id),
        activity.activity_id,
        name(activity, activity.activity_id),
        scheduled.startH,
        scheduled.endH,
        isoAt(result.projectStart, scheduled.startH),
        isoAt(result.projectStart, scheduled.endH),
        activity.duration_h,
        activity.duration_basis,
        activity.preemptible,
        scheduled.segments.map(([start, end]) => `${start}-${end}`).join(";"),
        localIso(isoAt(result.projectStart, scheduled.startH), timezone),
        localIso(isoAt(result.projectStart, scheduled.endH), timezone),
      ];
    });
  return csv(
    ["project_id", "revision_id", "system_id", "system_name", "package_id", "package_name", "activity_id", "activity_name", "start_h", "end_h", "start_datetime", "end_datetime", "duration_h", "duration_basis", "preemptible", "segments_h", "start_datetime_local", "end_datetime_local"],
    rows,
  );
}

function gatesCsv(project: SchedulingProject, result: ScheduleResult): string {
  const timezone = resultTimezone(project);
  const packageById = Object.fromEntries(project.packages.map((item) => [item.package_id, item]));
  const systemById = Object.fromEntries(project.systems.map((item) => [item.system_id, item]));
  const gateById = Object.fromEntries(project.gates.map((item) => [item.gate_id, item]));
  const rows = Object.entries(result.gates)
    .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
    .map(([gateId, offsetH]) => {
      const gate = gateById[gateId];
      const packageItem = gate?.package_id ? packageById[gate.package_id] : undefined;
      const systemId = gate?.system_id ?? packageItem?.system_id;
      const system = systemId ? systemById[systemId] : undefined;
      return [
        project.metadata.project_id,
        project.metadata.revision_id,
        gateId,
        name(gate, gateId),
        gate?.gate_type,
        systemId,
        system ? name(system, system.system_id) : "",
        packageItem?.package_id,
        packageItem ? name(packageItem, packageItem.package_id) : "",
        offsetH,
        isoAt(result.projectStart, offsetH),
        localIso(isoAt(result.projectStart, offsetH), timezone),
      ];
    });
  return csv(
    ["project_id", "revision_id", "gate_id", "gate_name", "gate_type", "system_id", "system_name", "package_id", "package_name", "time_h", "datetime", "datetime_local"],
    rows,
  );
}

function diagnosticsCsv(project: SchedulingProject, diagnostics: ExportDiagnostic[]): string {
  return csv(
    ["project_id", "revision_id", "severity", "code", "entity_id", "message"],
    diagnostics.map((item) => [
      project.metadata.project_id,
      project.metadata.revision_id,
      item.severity,
      item.code,
      item.entityId,
      item.message,
    ]),
  );
}

function ganttSvg(project: SchedulingProject, result: ScheduleResult, generatedAt: Date): string {
  const packageById = Object.fromEntries(project.packages.map((item) => [item.package_id, item]));
  const systemById = Object.fromEntries(project.systems.map((item) => [item.system_id, item]));
  const activityById = Object.fromEntries(project.activities.map((item) => [item.activity_id, item]));
  const rows = sortedActivities(project, Object.values(result.activities))
    .map((scheduled) => {
      const activity = activityById[scheduled.activityId];
      const packageItem = packageById[activity.package_id];
      return { scheduled, activity, packageItem, system: systemById[packageItem.system_id] };
    });
  const chartEnd = Math.ceil(Math.max(result.objectiveH, ...rows.map((row) => row.scheduled.endH), 24) / 24) * 24;
  const labelWidth = 310;
  const chartWidth = Math.max(720, chartEnd * 5);
  const rowHeight = 34;
  const top = 92;
  const width = labelWidth + chartWidth + 24;
  const height = top + rows.length * rowHeight + 34;
  const systems = [...new Set(rows.map((row) => row.system.system_id))];
  const colorFor = (systemId: string) => SYSTEM_COLORS[systems.indexOf(systemId) % SYSTEM_COLORS.length];
  const timezone = resultTimezone(project);
  const ticks = calendarTicks(result.projectStart, chartEnd, timezone);
  const grid = ticks.map((tick) => {
    const x = labelWidth + (tick.offsetH / chartEnd) * chartWidth;
    return `<line x1="${x}" y1="${top - 8}" x2="${x}" y2="${height - 24}" stroke="#dfe5e3"/><text x="${x + 4}" y="66" font-size="10" fill="#62767c">${xml(tick.dateLabel)}</text><text x="${x + 4}" y="79" font-size="9" fill="#62767c">${xml(tick.offsetLabel)}</text>`;
  }).join("");
  const backgrounds = rows.map((_, index) => `<rect x="0" y="${top + index * rowHeight}" width="${width}" height="${rowHeight}" fill="${index % 2 === 0 ? "#ffffff" : "#f7f9f8"}"/>`).join("");
  const body = rows.map(({ scheduled, activity, packageItem, system }, index) => {
    const y = top + index * rowHeight;
    const color = colorFor(system.system_id);
    const segments = scheduled.segments.map(([start, end]) => {
      const x = labelWidth + (start / chartEnd) * chartWidth;
      const segmentWidth = Math.max(2, ((end - start) / chartEnd) * chartWidth);
      return `<rect x="${x}" y="${y + 8}" width="${segmentWidth}" height="18" fill="${color}"/>`;
    }).join("");
    return `<g><rect x="0" y="${y}" width="5" height="${rowHeight}" fill="${color}"/><text x="14" y="${y + 14}" font-size="11" font-weight="700" fill="#19333e">${xml(name(activity, activity.activity_id))}</text><text x="14" y="${y + 27}" font-size="9" fill="#708087">${xml(system.system_id)} / ${xml(packageItem.package_id)} / ${xml(activity.activity_id)}</text>${segments}</g>`;
  }).join("");
  const metadata = xml(JSON.stringify({
    project_id: project.metadata.project_id,
    revision_id: project.metadata.revision_id,
    generated_at: generatedAt.toISOString(),
    project_start: result.projectStart,
    completion_h: result.objectiveH,
    display_timezone: timezone,
  }));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description"><title id="title">AIT activity schedule</title><desc id="description">Activity-level Gantt with preempted work shown as separate segments. Calendar axis in ${xml(timezone)}; H+ is elapsed hours from project start.</desc><metadata>${metadata}</metadata><rect width="100%" height="100%" fill="#ffffff"/><text x="14" y="24" font-size="16" font-weight="700" fill="#15323d">AIT Planning Optimizer — Activity Gantt</text><text x="14" y="41" font-size="10" fill="#64777d">${xml(text(project.metadata.project_id))} · ${xml(text(project.metadata.revision_id))} · completion H+${result.objectiveH} · ${xml(timezone)}</text>${backgrounds}${grid}${body}</svg>\n`;
}

export function createScheduleBundle(input: ScheduleBundleInput): ScheduleBundle {
  const generatedAt = input.generatedAt ?? new Date();
  const projectId = input.project.metadata.project_id;
  const revisionId = input.project.metadata.revision_id;
  const entries: ZipEntry[] = [
    { name: "schedule.csv", data: scheduleCsv(input.project, input.result) },
    { name: "gates.csv", data: gatesCsv(input.project, input.result) },
  ];
  if (input.diagnostics && input.diagnostics.length > 0) {
    entries.push({ name: "diagnostics.csv", data: diagnosticsCsv(input.project, input.diagnostics) });
  }
  entries.push(
    {
      name: "validation_report.json",
      data: json({
        project_id: projectId,
        revision_id: revisionId,
        generated_at: generatedAt.toISOString(),
        source_file: input.validation.fileName,
        valid: input.validation.isValid,
        summary: input.validation.summary,
        issues: input.validation.issues,
      }),
    },
    { name: "normalized_project.json", data: json(input.project) },
    {
      name: "run_summary.json",
      data: json({
        project_id: projectId,
        revision_id: revisionId,
        generated_at: generatedAt.toISOString(),
        project_start: input.result.projectStart,
        completion_gate: input.result.objectiveGate,
        completion_h: input.result.objectiveH,
        completion_datetime: isoAt(input.result.projectStart, input.result.objectiveH),
        display_timezone: resultTimezone(input.project),
        completion_datetime_local: localIso(isoAt(input.result.projectStart, input.result.objectiveH), resultTimezone(input.project)),
        scheduled_activity_count: Object.keys(input.result.activities).length,
        solver_status: input.result.optimal ? "optimal" : "unknown",
        solver_message: input.result.solverMessage,
        solver_duration_ms: input.solveDurationMs,
        model_horizon_h: input.result.horizonH,
        requested_horizon_days: input.settings.horizonDays,
        solver_time_limit_s: input.settings.timeLimitS,
      }),
    },
    { name: "gantt_activities.svg", data: ganttSvg(input.project, input.result, generatedAt) },
  );
  return {
    fileName: `${safeFilePart(projectId, "ait-project")}_${safeFilePart(revisionId, "results")}_schedule.zip`,
    entries,
    generatedAt,
  };
}

export function downloadScheduleBundle(input: ScheduleBundleInput): string {
  const bundle = createScheduleBundle(input);
  const bytes = createZip(bundle.entries, bundle.generatedAt);
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  const url = URL.createObjectURL(new Blob([arrayBuffer], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = bundle.fileName;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return bundle.fileName;
}
