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

export interface ScheduleResult {
  activities: Record<string, ScheduledActivity>;
  gates: Record<string, number>;
  projectStart: string;
  objectiveGate: string;
  objectiveH: number;
  horizonH: number;
  optimal: true;
  solverMessage: string;
}

export interface SolveOptions {
  horizonDays?: number;
  timeLimitS?: number;
  enforceCapacities?: boolean;
}

export type SolveProgress =
  | { stage: "building"; message: string }
  | { stage: "loading"; message: string }
  | { stage: "optimizing"; message: string };

export interface SolveWorkerRequest {
  type: "solve";
  project: SchedulingProject;
  options?: SolveOptions;
}

export type SolveWorkerResponse =
  | { type: "progress"; progress: SolveProgress }
  | { type: "result"; result: ScheduleResult }
  | { type: "error"; message: string };

export function asSchedulingProject(project: NormalizedProject): SchedulingProject {
  return project as unknown as SchedulingProject;
}
