export type NormalizedRecord = Record<string, unknown>;

export type TableCollectionKey =
  | "systems"
  | "packages"
  | "activities"
  | "gates"
  | "dependencies"
  | "resources"
  | "activity_resources"
  | "resource_substitutions"
  | "zones"
  | "activity_zones"
  | "calendars"
  | "calendar_shifts"
  | "milestone_priorities";

export interface NormalizedProject {
  metadata: NormalizedRecord;
  systems: NormalizedRecord[];
  packages: NormalizedRecord[];
  activities: NormalizedRecord[];
  gates: NormalizedRecord[];
  dependencies: NormalizedRecord[];
  resources: NormalizedRecord[];
  activity_resources: NormalizedRecord[];
  resource_substitutions: NormalizedRecord[];
  zones: NormalizedRecord[];
  activity_zones: NormalizedRecord[];
  calendars: NormalizedRecord[];
  calendar_shifts: NormalizedRecord[];
  milestone_priorities: NormalizedRecord[];
}

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  location?: string;
}

export interface ProjectSummary {
  systems: number;
  packages: number;
  activities: number;
  gates: number;
}

export interface WorkbookImportResult {
  data: NormalizedProject;
  fileName: string;
  sheetNames: string[];
  issues: ValidationIssue[];
  summary: ProjectSummary;
  isValid: boolean;
}

export function createEmptyProject(): NormalizedProject {
  return {
    metadata: {},
    systems: [],
    packages: [],
    activities: [],
    gates: [],
    dependencies: [],
    resources: [],
    activity_resources: [],
    resource_substitutions: [],
    zones: [],
    activity_zones: [],
    calendars: [],
    calendar_shifts: [],
    milestone_priorities: [],
  };
}
