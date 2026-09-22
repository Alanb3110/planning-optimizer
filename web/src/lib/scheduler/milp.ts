import { buildCalendarSlots, hourOffset } from "./calendar";
import type {
  MilestonePriority,
  SchedulingActivity,
  SchedulingProject,
  SolveOptions,
} from "./types";

interface VariableIndex {
  index: number;
  lower: number;
  upper: number;
}

export interface ExecutionChoice {
  variable: number;
  slots: number[];
  candidateStart: number;
}

export interface SparseMilpModel {
  numCols: number;
  numRows: number;
  colCost: Float64Array;
  colLower: Float64Array;
  colUpper: Float64Array;
  rowLower: Float64Array;
  rowUpper: Float64Array;
  integrality: Int32Array;
  matrix: {
    format: "csr";
    numRows: number;
    numCols: number;
    starts: Int32Array;
    indices: Int32Array;
    values: Float64Array;
  };
}

export interface BuiltScheduleMilp {
  model: SparseMilpModel;
  project: SchedulingProject;
  horizonH: number;
  activeActivities: Record<string, SchedulingActivity>;
  startVariables: Record<string, number>;
  endVariables: Record<string, number>;
  gateVariables: Record<string, number>;
  executionChoices: Record<string, ExecutionChoice[]>;
  milestonePriorities: MilestonePriority[];
  objectiveGate: string;
}

interface RowEntry {
  column: number;
  value: number;
}

class ModelBuilder {
  readonly lower: number[] = [];
  readonly upper: number[] = [];
  readonly integrality: number[] = [];
  readonly rowLower: number[] = [];
  readonly rowUpper: number[] = [];
  readonly starts: number[] = [0];
  readonly indices: number[] = [];
  readonly values: number[] = [];

  addVariable(lower: number, upper: number): VariableIndex {
    const variable = { index: this.lower.length, lower, upper };
    this.lower.push(lower);
    this.upper.push(upper);
    this.integrality.push(1);
    return variable;
  }

  addRow(entries: RowEntry[], lower = Number.NEGATIVE_INFINITY, upper = Number.POSITIVE_INFINITY) {
    const consolidated = new Map<number, number>();
    for (const entry of entries) {
      if (entry.value === 0) continue;
      consolidated.set(entry.column, (consolidated.get(entry.column) ?? 0) + entry.value);
    }
    for (const [column, value] of [...consolidated.entries()].sort(([left], [right]) => left - right)) {
      if (value === 0) continue;
      this.indices.push(column);
      this.values.push(value);
    }
    this.rowLower.push(lower);
    this.rowUpper.push(upper);
    this.starts.push(this.indices.length);
  }

  finish(): SparseMilpModel {
    const numCols = this.lower.length;
    const numRows = this.rowLower.length;
    return {
      numCols,
      numRows,
      colCost: new Float64Array(numCols),
      colLower: Float64Array.from(this.lower),
      colUpper: Float64Array.from(this.upper),
      rowLower: Float64Array.from(this.rowLower),
      rowUpper: Float64Array.from(this.rowUpper),
      integrality: Int32Array.from(this.integrality),
      matrix: {
        format: "csr",
        numRows,
        numCols,
        starts: Int32Array.from(this.starts),
        indices: Int32Array.from(this.indices),
        values: Float64Array.from(this.values),
      },
    };
  }
}

type Usage = Map<string, Map<number, RowEntry[]>>;

function addUsage(usage: Usage, id: string, slot: number, entry: RowEntry) {
  const bySlot = usage.get(id) ?? new Map<number, RowEntry[]>();
  const entries = bySlot.get(slot) ?? [];
  entries.push(entry);
  bySlot.set(slot, entries);
  usage.set(id, bySlot);
}

function activeById<T extends Record<string, unknown>>(
  rows: T[],
  idField: keyof T,
): Record<string, T> {
  return Object.fromEntries(
    rows
      .filter((row) => row.enabled !== false)
      .map((row) => [String(row[idField]), row]),
  );
}

function computeHorizon(project: SchedulingProject, activities: SchedulingActivity[], options: SolveOptions) {
  if (options.horizonDays !== undefined) {
    if (!Number.isInteger(options.horizonDays) || options.horizonDays <= 0) {
      throw new Error("Planning horizon must be a positive whole number of days.");
    }
    return options.horizonDays * 24;
  }
  const latestArrival = Math.max(
    0,
    ...project.systems
      .filter((system) => system.enabled !== false)
      .map((system) => Math.max(0, hourOffset(project.metadata.project_start, system.arrival_date))),
  );
  const totalDuration = activities.reduce((total, activity) => total + Number(activity.duration_h), 0);
  return Math.ceil(latestArrival + Math.max(30 * 24, totalDuration * 1.5) + 10 * 24);
}

function integerHours(value: number, label: string): number {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(value) || Math.abs(Number(value) - rounded) > 1e-9) {
    throw new Error(`${label} is not aligned to the 1 h scheduling grid.`);
  }
  return rounded;
}

export function buildScheduleMilp(
  project: SchedulingProject,
  options: SolveOptions = {},
): BuiltScheduleMilp {
  const systems = activeById(project.systems, "system_id");
  const packages = Object.fromEntries(
    project.packages
      .filter((row) => row.enabled !== false && systems[row.system_id])
      .map((row) => [row.package_id, row]),
  );
  const activities = Object.fromEntries(
    project.activities
      .filter((row) => row.enabled !== false && packages[row.package_id])
      .map((row) => [row.activity_id, row]),
  );
  const gates = Object.fromEntries(
    project.gates
      .filter(
        (row) =>
          (!row.package_id || packages[row.package_id]) &&
          (!row.system_id || systems[row.system_id]),
      )
      .map((row) => [row.gate_id, row]),
  );
  const resources = Object.fromEntries(project.resources.map((row) => [row.resource_id, row]));
  const zones = Object.fromEntries(project.zones.map((row) => [row.zone_id, row]));
  const horizonH = computeHorizon(project, Object.values(activities), options);
  const calendarSlots = buildCalendarSlots(project, horizonH);
  const builder = new ModelBuilder();
  const startVariables: Record<string, number> = {};
  const endVariables: Record<string, number> = {};
  const gateVariables: Record<string, number> = {};
  const executionChoices: Record<string, ExecutionChoice[]> = {};
  const resourceUsage: Usage = new Map();
  const zoneUsage: Usage = new Map();

  const resourcesByActivity = new Map<string, Array<[string, number]>>();
  for (const demand of project.activity_resources) {
    if (!activities[demand.activity_id]) continue;
    const list = resourcesByActivity.get(demand.activity_id) ?? [];
    list.push([demand.resource_id, Number(demand.quantity)]);
    resourcesByActivity.set(demand.activity_id, list);
  }
  const zonesByActivity = new Map<string, Array<[string, number]>>();
  for (const demand of project.activity_zones) {
    if (!activities[demand.activity_id]) continue;
    const zone = zones[demand.zone_id];
    const load = demand.exclusive || demand.load === "ALL" ? Number(zone.capacity) : Number(demand.load);
    const list = zonesByActivity.get(demand.activity_id) ?? [];
    list.push([demand.zone_id, load]);
    zonesByActivity.set(demand.activity_id, list);
  }

  const activitySystem = (activityId: string) => packages[activities[activityId].package_id].system_id;
  const releaseHour = (activityId: string) => {
    if (activities[activityId].requires_system_arrival === false) return 0;
    return Math.max(
      0,
      hourOffset(project.metadata.project_start, systems[activitySystem(activityId)].arrival_date),
    );
  };
  const effectiveAvailability = (activityId: string) => {
    const activity = activities[activityId];
    const calendarIds: string[] = [];
    const activityCalendar = activity.calendar_id || project.metadata.active_calendar;
    if (activityCalendar) calendarIds.push(activityCalendar);
    for (const [resourceId] of resourcesByActivity.get(activityId) ?? []) {
      if (resources[resourceId].calendar_id) calendarIds.push(resources[resourceId].calendar_id!);
    }
    for (const [zoneId] of zonesByActivity.get(activityId) ?? []) {
      if (zones[zoneId].calendar_id) calendarIds.push(zones[zoneId].calendar_id!);
    }
    if (calendarIds.length === 0) return Array.from({ length: horizonH }, () => true);
    return Array.from({ length: horizonH }, (_, slot) =>
      calendarIds.every((calendarId) => {
        const calendar = calendarSlots[calendarId];
        if (!calendar) throw new Error(`Unknown calendar '${calendarId}' while building the MILP.`);
        return calendar[slot];
      }),
    );
  };
  const registerUsage = (activityId: string, variable: number, slots: number[]) => {
    for (const [resourceId, quantity] of resourcesByActivity.get(activityId) ?? []) {
      if (resources[resourceId].unlimited) continue;
      for (const slot of slots) addUsage(resourceUsage, resourceId, slot, { column: variable, value: quantity });
    }
    for (const [zoneId, load] of zonesByActivity.get(activityId) ?? []) {
      for (const slot of slots) addUsage(zoneUsage, zoneId, slot, { column: variable, value: load });
    }
  };

  for (const [activityId, activity] of Object.entries(activities)) {
    const start = builder.addVariable(0, horizonH).index;
    const end = builder.addVariable(0, horizonH).index;
    startVariables[activityId] = start;
    endVariables[activityId] = end;
    const duration = integerHours(activity.duration_h, `Activity ${activityId} duration`);
    const release = releaseHour(activityId);
    const profiles: Array<{ candidateStart: number; slots: number[] }> = [];

    if (activity.duration_basis === "ELAPSED_TIME") {
      for (let candidateStart = release; candidateStart <= horizonH - duration; candidateStart += 1) {
        profiles.push({
          candidateStart,
          slots: Array.from({ length: duration }, (_, offset) => candidateStart + offset),
        });
      }
    } else {
      const availability = effectiveAvailability(activityId);
      if (activity.preemptible) {
        const eligible = availability
          .map((available, slot) => ({ available, slot }))
          .filter(({ available, slot }) => available && slot >= release)
          .map(({ slot }) => slot);
        for (let index = 0; index <= eligible.length - duration; index += 1) {
          profiles.push({ candidateStart: eligible[index], slots: eligible.slice(index, index + duration) });
        }
      } else {
        for (let candidateStart = release; candidateStart <= horizonH - duration; candidateStart += 1) {
          const slots = Array.from({ length: duration }, (_, offset) => candidateStart + offset);
          if (slots.every((slot) => availability[slot])) profiles.push({ candidateStart, slots });
        }
      }
    }

    if (profiles.length === 0) {
      const continuity = activity.preemptible ? "calendar-spanning" : "continuous";
      throw new Error(
        `Activity ${activityId} has no ${continuity} ${duration} h feasible profile. Check duration, calendars and horizon.`,
      );
    }

    const choices = profiles.map((profile) => {
      const variable = builder.addVariable(0, 1).index;
      registerUsage(activityId, variable, profile.slots);
      return { variable, ...profile };
    });
    executionChoices[activityId] = choices;
    builder.addRow(choices.map(({ variable }) => ({ column: variable, value: 1 })), 1, 1);
    builder.addRow(
      [
        { column: start, value: 1 },
        ...choices.map(({ variable, candidateStart }) => ({ column: variable, value: -candidateStart })),
      ],
      0,
      0,
    );
    builder.addRow(
      [
        { column: end, value: 1 },
        ...choices.map(({ variable, slots }) => ({ column: variable, value: -(slots.at(-1)! + 1) })),
      ],
      0,
      0,
    );
  }

  for (const gateId of Object.keys(gates)) gateVariables[gateId] = builder.addVariable(0, horizonH).index;

  const nodeVariable = (nodeType: "ACTIVITY" | "GATE", nodeId: string, source: boolean) => {
    if (nodeType === "GATE") return gateVariables[nodeId];
    return source ? endVariables[nodeId] : startVariables[nodeId];
  };
  for (const dependency of project.dependencies) {
    if (!dependency.enabled) continue;
    const sourceActive = dependency.source_type === "ACTIVITY"
      ? activities[dependency.source_id]
      : gates[dependency.source_id];
    const targetActive = dependency.target_type === "ACTIVITY"
      ? activities[dependency.target_id]
      : gates[dependency.target_id];
    if (!sourceActive || !targetActive) continue;
    const lag = integerHours(Number(dependency.lag_h ?? 0), `Dependency ${dependency.dependency_id} lag`);
    builder.addRow(
      [
        { column: nodeVariable(dependency.target_type, dependency.target_id, false), value: 1 },
        { column: nodeVariable(dependency.source_type, dependency.source_id, true), value: -1 },
      ],
      lag,
    );
  }

  if (options.enforceCapacities !== false) {
    for (const [resourceId, bySlot] of resourceUsage) {
      for (const entries of bySlot.values()) builder.addRow(entries, Number.NEGATIVE_INFINITY, resources[resourceId].capacity);
    }
    for (const [zoneId, bySlot] of zoneUsage) {
      for (const entries of bySlot.values()) builder.addRow(entries, Number.NEGATIVE_INFINITY, zones[zoneId].capacity);
    }
  }

  const milestonePriorities = project.milestone_priorities
    .filter((row) => row.enabled && gateVariables[row.gate_id] !== undefined)
    .sort((left, right) =>
      (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER) ||
      left.gate_id.localeCompare(right.gate_id),
    );
  if (milestonePriorities.length === 0) {
    throw new Error("At least one enabled milestone priority is required.");
  }
  const completionGates = Object.values(gates).filter((gate) => gate.gate_type === "PROJECT_COMPLETE");
  if (completionGates.length !== 1) throw new Error("Exactly one active PROJECT_COMPLETE gate is required.");

  return {
    model: builder.finish(),
    project,
    horizonH,
    activeActivities: activities,
    startVariables,
    endVariables,
    gateVariables,
    executionChoices,
    milestonePriorities,
    objectiveGate: completionGates[0].gate_id,
  };
}
