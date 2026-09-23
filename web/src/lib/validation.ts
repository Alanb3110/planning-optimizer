import type { ErrorObject, ValidateFunction } from "ajv";
import generatedSchemaValidator from "../schema/planning_optimizer_schema_v1.validator.generated";
import type { NormalizedProject, NormalizedRecord, ValidationIssue } from "./model";

const validateAgainstSchema = generatedSchemaValidator as ValidateFunction<NormalizedProject>;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const isEnabled = (row: NormalizedRecord): boolean => row.enabled === true;

function issue(
  code: string,
  message: string,
  location?: string,
  severity: "error" | "warning" = "error",
): ValidationIssue {
  return { severity, code, message, location };
}

function schemaIssue(error: ErrorObject): ValidationIssue {
  const missingProperty =
    error.keyword === "required"
      ? (error.params as { missingProperty?: string }).missingProperty
      : undefined;
  const location = [error.instancePath || "/", missingProperty].filter(Boolean).join("/");

  return issue(
    "JSON_SCHEMA",
    `${error.message ?? "Schema validation failed"}${missingProperty ? `: ${missingProperty}` : ""}.`,
    location,
  );
}

function idSet(records: NormalizedRecord[], field: string): Set<string> {
  return new Set(records.map((row) => asString(row[field])).filter((value): value is string => Boolean(value)));
}

function checkDuplicateIds(
  records: NormalizedRecord[],
  collection: string,
  field: string,
  issues: ValidationIssue[],
) {
  const seen = new Set<string>();
  const reported = new Set<string>();

  for (const row of records) {
    const value = asString(row[field]);
    if (!value) continue;
    if (seen.has(value) && !reported.has(value)) {
      issues.push(issue("DUPLICATE_ID", `Duplicate ${field} '${value}'.`, `${collection}.${field}`));
      reported.add(value);
    }
    seen.add(value);
  }
}

function checkReference(
  value: unknown,
  validIds: Set<string>,
  label: string,
  location: string,
  issues: ValidationIssue[],
) {
  const identifier = asString(value);
  if (identifier && !validIds.has(identifier)) {
    issues.push(issue("UNKNOWN_REFERENCE", `Unknown ${label} '${identifier}'.`, location));
  }
}

function checkDuplicateMappings(
  records: NormalizedRecord[],
  leftField: string,
  rightField: string,
  collection: string,
  issues: ValidationIssue[],
) {
  const seen = new Set<string>();
  for (const row of records) {
    const left = asString(row[leftField]);
    const right = asString(row[rightField]);
    if (!left || !right) continue;
    const key = `${left}\u0000${right}`;
    if (seen.has(key)) {
      issues.push(
        issue(
          "DUPLICATE_MAPPING",
          `Duplicate mapping '${left}' → '${right}'.`,
          collection,
        ),
      );
    }
    seen.add(key);
  }
}

function checkDependencyCycles(
  data: NormalizedProject,
  activityIds: Set<string>,
  gateIds: Set<string>,
  issues: ValidationIssue[],
) {
  const nodes = new Set<string>([
    ...[...activityIds].map((id) => `ACTIVITY:${id}`),
    ...[...gateIds].map((id) => `GATE:${id}`),
  ]);
  const indegree = new Map([...nodes].map((node) => [node, 0]));
  const adjacency = new Map([...nodes].map((node) => [node, [] as string[]]));

  for (const dependency of data.dependencies) {
    if (!isEnabled(dependency)) continue;
    const sourceType = asString(dependency.source_type);
    const sourceId = asString(dependency.source_id);
    const targetType = asString(dependency.target_type);
    const targetId = asString(dependency.target_id);
    if (!sourceType || !sourceId || !targetType || !targetId) continue;
    const source = `${sourceType}:${sourceId}`;
    const target = `${targetType}:${targetId}`;
    if (!nodes.has(source) || !nodes.has(target)) continue;
    adjacency.get(source)?.push(target);
    indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }

  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([node]) => node);
  let visited = 0;

  while (queue.length > 0) {
    const node = queue.pop()!;
    visited += 1;
    for (const target of adjacency.get(node) ?? []) {
      const nextDegree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, nextDegree);
      if (nextDegree === 0) queue.push(target);
    }
  }

  if (visited !== nodes.size) {
    const cyclicNodes = [...indegree.entries()]
      .filter(([, degree]) => degree > 0)
      .map(([node]) => node)
      .sort();
    issues.push(
      issue(
        "DEPENDENCY_CYCLE",
        `Enabled dependency graph contains a cycle involving ${cyclicNodes.join(", ")}.`,
        "dependencies",
      ),
    );
  }
}

export function validateProject(data: NormalizedProject): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!validateAgainstSchema(data)) {
    issues.push(...(validateAgainstSchema.errors ?? []).map(schemaIssue));
  }

  const idFields: Array<[keyof NormalizedProject, string]> = [
    ["systems", "system_id"],
    ["packages", "package_id"],
    ["activities", "activity_id"],
    ["gates", "gate_id"],
    ["dependencies", "dependency_id"],
    ["resources", "resource_id"],
    ["zones", "zone_id"],
    ["calendars", "calendar_id"],
  ];

  for (const [collection, field] of idFields) {
    const records = data[collection];
    if (Array.isArray(records)) checkDuplicateIds(records, collection, field, issues);
  }

  const systemIds = idSet(data.systems, "system_id");
  const packageIds = idSet(data.packages, "package_id");
  const activityIds = idSet(data.activities, "activity_id");
  const gateIds = idSet(data.gates, "gate_id");
  const resourceIds = idSet(data.resources, "resource_id");
  const zoneIds = idSet(data.zones, "zone_id");
  const calendarIds = idSet(data.calendars, "calendar_id");

  checkReference(
    data.metadata.active_calendar,
    calendarIds,
    "calendar",
    "metadata.active_calendar",
    issues,
  );
  checkReference(
    data.metadata.objective_gate,
    gateIds,
    "gate",
    "metadata.objective_gate",
    issues,
  );

  for (const row of data.systems) {
    checkReference(
      row.installation_zone,
      zoneIds,
      "zone",
      `systems.${asString(row.system_id) ?? "?"}.installation_zone`,
      issues,
    );
  }
  for (const row of data.packages) {
    checkReference(
      row.system_id,
      systemIds,
      "system",
      `packages.${asString(row.package_id) ?? "?"}.system_id`,
      issues,
    );
  }
  for (const row of data.activities) {
    const activityId = asString(row.activity_id) ?? "?";
    checkReference(row.package_id, packageIds, "package", `activities.${activityId}.package_id`, issues);
    checkReference(row.calendar_id, calendarIds, "calendar", `activities.${activityId}.calendar_id`, issues);
    if (typeof row.duration_h !== "number" || !Number.isInteger(row.duration_h) || row.duration_h <= 0) {
      issues.push(issue("INVALID_DURATION", `Activity '${activityId}' requires a positive whole-hour duration.`, `activities.${activityId}.duration_h`));
    }
    if (row.requires_system_arrival !== undefined && typeof row.requires_system_arrival !== "boolean") {
      issues.push(issue("INVALID_ARRIVAL_FLAG", `Activity '${activityId}' requires a boolean requires_system_arrival.`, `activities.${activityId}.requires_system_arrival`));
    }
  }
  for (const row of data.gates) {
    const gateId = asString(row.gate_id) ?? "?";
    checkReference(row.system_id, systemIds, "system", `gates.${gateId}.system_id`, issues);
    checkReference(row.package_id, packageIds, "package", `gates.${gateId}.package_id`, issues);
  }
  for (const row of data.resources) {
    checkReference(
      row.calendar_id,
      calendarIds,
      "calendar",
      `resources.${asString(row.resource_id) ?? "?"}.calendar_id`,
      issues,
    );
  }
  for (const row of data.zones) {
    checkReference(
      row.calendar_id,
      calendarIds,
      "calendar",
      `zones.${asString(row.zone_id) ?? "?"}.calendar_id`,
      issues,
    );
  }
  for (const row of data.calendar_shifts) {
    checkReference(row.calendar_id, calendarIds, "calendar", "calendar_shifts.calendar_id", issues);
  }
  for (const row of data.activity_resources) {
    checkReference(row.activity_id, activityIds, "activity", "activity_resources.activity_id", issues);
    checkReference(row.resource_id, resourceIds, "resource", "activity_resources.resource_id", issues);
  }
  for (const row of data.resource_substitutions) {
    checkReference(
      row.required_resource_id,
      resourceIds,
      "resource",
      "resource_substitutions.required_resource_id",
      issues,
    );
    checkReference(
      row.substitute_resource_id,
      resourceIds,
      "resource",
      "resource_substitutions.substitute_resource_id",
      issues,
    );
  }
  for (const row of data.activity_zones) {
    checkReference(row.activity_id, activityIds, "activity", "activity_zones.activity_id", issues);
    checkReference(row.zone_id, zoneIds, "zone", "activity_zones.zone_id", issues);
  }
  for (const row of data.milestone_priorities) {
    checkReference(row.gate_id, gateIds, "gate", "milestone_priorities.gate_id", issues);
  }

  checkDuplicateMappings(
    data.activity_resources,
    "activity_id",
    "resource_id",
    "activity_resources",
    issues,
  );
  checkDuplicateMappings(
    data.activity_zones,
    "activity_id",
    "zone_id",
    "activity_zones",
    issues,
  );

  for (const dependency of data.dependencies) {
    const dependencyId = asString(dependency.dependency_id) ?? "?";
    const sourceIds = dependency.source_type === "ACTIVITY" ? activityIds : gateIds;
    const targetIds = dependency.target_type === "ACTIVITY" ? activityIds : gateIds;
    checkReference(
      dependency.source_id,
      sourceIds,
      `${String(dependency.source_type).toLowerCase()} source`,
      `dependencies.${dependencyId}.source_id`,
      issues,
    );
    checkReference(
      dependency.target_id,
      targetIds,
      `${String(dependency.target_type).toLowerCase()} target`,
      `dependencies.${dependencyId}.target_id`,
      issues,
    );
  }

  checkDependencyCycles(data, activityIds, gateIds, issues);

  const seenPriorities = new Set<number>();
  const seenPriorityGates = new Set<string>();
  for (const row of data.milestone_priorities) {
    const gateId = asString(row.gate_id);
    if (gateId) {
      if (seenPriorityGates.has(gateId)) {
        issues.push(
          issue(
            "DUPLICATE_MILESTONE_GATE",
            `Milestone priority is defined more than once for gate '${gateId}'.`,
            "milestone_priorities",
          ),
        );
      }
      seenPriorityGates.add(gateId);
    }

    if (!isEnabled(row)) continue;
    const priority = row.priority;
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 1) {
      issues.push(
        issue(
          "INVALID_MILESTONE_PRIORITY",
          `Enabled milestone '${gateId ?? "?"}' requires a positive integer priority.`,
          "milestone_priorities",
        ),
      );
    } else if (seenPriorities.has(priority)) {
      issues.push(
        issue(
          "DUPLICATE_MILESTONE_PRIORITY",
          `Enabled milestone priority ${priority} is duplicated.`,
          "milestone_priorities",
        ),
      );
    } else {
      seenPriorities.add(priority);
    }
  }

  const projectCompleteGates = data.gates.filter((row) => row.gate_type === "PROJECT_COMPLETE");
  if (projectCompleteGates.length !== 1) {
    issues.push(
      issue(
        "PROJECT_COMPLETE_COUNT",
        `Exactly one PROJECT_COMPLETE gate is required; found ${projectCompleteGates.length}.`,
        "gates",
      ),
    );
  } else {
    const completionId = asString(projectCompleteGates[0].gate_id);
    const hasEnabledPriority = data.milestone_priorities.some(
      (row) => row.gate_id === completionId && isEnabled(row),
    );
    if (!hasEnabledPriority) {
      issues.push(
        issue(
          "PROJECT_COMPLETE_PRIORITY",
          "The PROJECT_COMPLETE gate must have an enabled milestone priority.",
          "milestone_priorities",
        ),
      );
    }
  }

  for (const calendar of data.calendars) {
    const timezone = asString(calendar.timezone);
    if (!timezone) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch {
      issues.push(
        issue(
          "INVALID_TIMEZONE",
          `Unknown IANA timezone '${timezone}'.`,
          `calendars.${asString(calendar.calendar_id) ?? "?"}.timezone`,
        ),
      );
    }
  }

  const unique = new Map<string, ValidationIssue>();
  for (const validationIssue of issues) {
    const key = `${validationIssue.severity}|${validationIssue.code}|${validationIssue.location}|${validationIssue.message}`;
    unique.set(key, validationIssue);
  }
  return [...unique.values()];
}
