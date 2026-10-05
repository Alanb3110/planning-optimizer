import type { NormalizedProject } from "../model";

export type DurationBasis = "WORK_TIME" | "ELAPSED_TIME";
export type DependencyNodeType = "ACTIVITY" | "GATE";

export interface SchedulingMetadata {
  project_start: string;
  active_calendar?: string;
  [key: string]: unknown;
}

export interface SchedulingSystem {
  system_id: string;
  arrival_date: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface SchedulingPackage {
  package_id: string;
  system_id: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface SchedulingActivity {
  activity_id: string;
  package_id: string;
  duration_h: number;
  duration_basis: DurationBasis;
  preemptible: boolean;
  enabled?: boolean;
  calendar_id?: string;
  requires_system_arrival?: boolean;
  [key: string]: unknown;
}

export interface SchedulingGate {
  gate_id: string;
  gate_type: string;
  package_id?: string;
  system_id?: string;
  [key: string]: unknown;
}

export interface SchedulingDependency {
  dependency_id: string;
  source_type: DependencyNodeType;
  source_id: string;
  target_type: DependencyNodeType;
  target_id: string;
  lag_h?: number;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface SchedulingResource {
  resource_id: string;
  capacity: number;
  unlimited: boolean;
  calendar_id?: string;
  [key: string]: unknown;
}

export interface ActivityResourceDemand {
  activity_id: string;
  resource_id: string;
  quantity: number;
  [key: string]: unknown;
}

export interface SchedulingZone {
  zone_id: string;
  capacity: number;
  calendar_id?: string;
  [key: string]: unknown;
}

export interface ActivityZoneDemand {
  activity_id: string;
  zone_id: string;
  load: number | "ALL";
  exclusive?: boolean;
  [key: string]: unknown;
}

export interface SchedulingCalendar {
  calendar_id: string;
  timezone: string;
  valid_from?: string;
  valid_to?: string;
  [key: string]: unknown;
}

export interface SchedulingShift {
  calendar_id: string;
  weekday: "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";
  start_time: string;
  end_time: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface MilestonePriority {
  gate_id: string;
  priority?: number;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface SchedulingProject {
  metadata: SchedulingMetadata;
  systems: SchedulingSystem[];
  packages: SchedulingPackage[];
  activities: SchedulingActivity[];
  gates: SchedulingGate[];
  dependencies: SchedulingDependency[];
  resources: SchedulingResource[];
  activity_resources: ActivityResourceDemand[];
  resource_substitutions: Record<string, unknown>[];
  zones: SchedulingZone[];
  activity_zones: ActivityZoneDemand[];
  calendars: SchedulingCalendar[];
  calendar_shifts: SchedulingShift[];
  milestone_priorities: MilestonePriority[];
}

export interface ScheduledActivity {
  activityId: string;
  startH: number;
  endH: number;
  workSlots: number[];
  segments: Array<[number, number]>;
}

export interface SolveDiagnostics {
  activeActivities: number;
  horizonH: number;
  executionProfiles: number;
  columns: number;
  rows: number;
  nonzeros: number;
  optimizationPasses: number;
  estimatedModelBytes: number;
}

export type SolveErrorKind =
  | "model-error"
  | "infeasible"
  | "not-proven"
  | "wasm-abort"
  | "potential-model-size";

export interface SolveFailure {
  kind: SolveErrorKind;
  message: string;
  diagnostics?: SolveDiagnostics;
}

export class ScheduleSolveError extends Error {
  constructor(
    public readonly kind: SolveErrorKind,
    message: string,
    public readonly diagnostics?: SolveDiagnostics,
  ) {
    super(message);
    this.name = "ScheduleSolveError";
  }
}

export function formatSolveDiagnostics(diagnostics: SolveDiagnostics): string {
  const mib = diagnostics.estimatedModelBytes / (1024 * 1024);
  return [
    `active activities=${diagnostics.activeActivities}`,
    `horizon=${diagnostics.horizonH} h`,
    `execution profiles=${diagnostics.executionProfiles}`,
    `columns=${diagnostics.columns}`,
    `rows=${diagnostics.rows}`,
    `nonzeros=${diagnostics.nonzeros}`,
    `optimization passes=${diagnostics.optimizationPasses}`,
    `typed-array estimate=${diagnostics.estimatedModelBytes} B (${mib.toFixed(3)} MiB)`,
  ].join("; ");
}

export function classifyUnexpectedSolveError(message: string): SolveErrorKind {
  const normalized = message.toLowerCase();
  if (/out of memory|memory access out of bounds|allocation failed|cannot enlarge memory|array buffer allocation/i.test(normalized)) {
    return "potential-model-size";
  }
  if (/aborted\(\)|\bwasm\b|webassembly|runtimeerror/.test(normalized)) return "wasm-abort";
  if (/time[_ -]?limit|iteration[_ -]?limit|solution[_ -]?limit|did not prove.*optimal|optimum.*not proved/.test(normalized)) {
    return "not-proven";
  }
  if (/\binfeasible\b/.test(normalized) && !/unbounded.*infeasible/.test(normalized)) return "infeasible";
  return "model-error";
}

export function solveFailureFrom(error: unknown, diagnostics?: SolveDiagnostics): SolveFailure {
  if (error instanceof ScheduleSolveError) {
    return { kind: error.kind, message: error.message, diagnostics: error.diagnostics ?? diagnostics };
  }
  const message = error instanceof Error ? error.message : String(error || "The schedule could not be calculated.");
  const kind = classifyUnexpectedSolveError(message);
  if (kind === "wasm-abort" || kind === "potential-model-size") {
    const interpretation = kind === "potential-model-size"
      ? "The failure is consistent with a WebAssembly memory/allocation problem, but model size is not proven to be the cause and infeasibility is not established."
      : "This is a HiGHS/WebAssembly runtime abort, not evidence that the scheduling model is infeasible.";
    const context = diagnostics
      ? ` Model diagnostics before HiGHS: ${formatSolveDiagnostics(diagnostics)}. The size estimate is only the JavaScript typed-array payload; HiGHS/WASM internal memory and copies can be substantially larger.`
      : "";
    return { kind, message: `${message} ${interpretation}${context}`, diagnostics };
  }
  return { kind, message, diagnostics };
}

export interface ScheduleResult {
  activities: Record<string, ScheduledActivity>;
  gates: Record<string, number>;
  projectStart: string;
  objectiveGate: string;
  objectiveH: number;
  horizonH: number;
  optimal: true;
  solverMessage: string;
  diagnostics?: SolveDiagnostics;
}

export interface SolveOptions {
  horizonDays?: number;
  timeLimitS?: number;
  enforceCapacities?: boolean;
}

export type SolveProgress =
  | { stage: "building"; message: string; diagnostics?: SolveDiagnostics }
  | { stage: "loading"; message: string; diagnostics?: SolveDiagnostics }
  | { stage: "optimizing"; message: string; diagnostics?: SolveDiagnostics };

export interface SolveWorkerRequest {
  type: "solve";
  project: SchedulingProject;
  options?: SolveOptions;
}

export type SolveWorkerResponse =
  | { type: "progress"; progress: SolveProgress }
  | { type: "result"; result: ScheduleResult }
  | { type: "error"; failure: SolveFailure };

export function asSchedulingProject(project: NormalizedProject): SchedulingProject {
  return project as unknown as SchedulingProject;
}
