import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as XLSX from "xlsx";

const TABLES = {
  Systems: "systems", Packages: "packages", Activities: "activities", Gates: "gates",
  Dependencies: "dependencies", Resources: "resources", ActivityResources: "activity_resources",
  ResourceSubstitutions: "resource_substitutions", Zones: "zones", ActivityZones: "activity_zones",
  Calendars: "calendars", CalendarShifts: "calendar_shifts", MilestonePriorities: "milestone_priorities",
};
const HEADERS = {
  ResourceSubstitutions: ["required_resource_id", "substitute_resource_id", "conversion_ratio", "enabled"],
};
const START = Date.parse("2031-04-07T00:00:00Z"); // Arbitrary fictional UTC origin.
const iso = (hours) => new Date(START + hours * 3_600_000).toISOString();

export function generateProject(count, seed) {
  if (![20, 50, 100].includes(count) || !Number.isInteger(seed) || seed <= 0) {
    throw new Error("Use a positive integer seed and a size of 20, 50 or 100.");
  }
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
  const systemsCount = count === 20 ? 4 : 5;
  const packagesCount = count === 20 ? 8 : count === 50 ? 15 : 20;
  const data = {
    metadata: { project_id: `FICTION_${count}`, project_name: "Invented modular objects",
      revision_id: `SEED_${seed}`, project_start: iso(0), active_calendar: "ANY_HOUR",
      notes: "Entirely invented benchmark; IDs, dates, durations and quantities have no operational origin." },
    systems: [], packages: [], activities: [], gates: [], dependencies: [],
    resources: [
      { resource_id: "SHARED_ROLE", name: "Fictional shared role", type: "HUMAN", capacity: 4, unlimited: false },
      { resource_id: "DAY_TOOL", name: "Fictional day tool", type: "EQUIPMENT", capacity: 3, calendar_id: "DAY", unlimited: false },
      { resource_id: "NIGHT_TOOL", name: "Fictional night tool", type: "EQUIPMENT", capacity: 3, calendar_id: "NIGHT", unlimited: false },
    ],
    activity_resources: [], resource_substitutions: [],
    zones: [
      { zone_id: "COMMON", name: "Fictional common space", capacity: 4 },
      { zone_id: "DAY_SPACE", name: "Fictional day space", capacity: 3, calendar_id: "DAY" },
      { zone_id: "NIGHT_SPACE", name: "Fictional night space", capacity: 3, calendar_id: "NIGHT" },
    ],
    activity_zones: [],
    calendars: [
      { calendar_id: "ANY_HOUR", name: "Every hour", timezone: "UTC" },
      { calendar_id: "DAY", name: "Invented day window", timezone: "UTC" },
      { calendar_id: "NIGHT", name: "Invented night window", timezone: "UTC" },
    ],
    calendar_shifts: [], milestone_priorities: [],
  };
  for (const weekday of ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]) {
    for (const [calendar_id, start_time, end_time] of [
      ["ANY_HOUR", "00:00", "23:00"], ["ANY_HOUR", "23:00", "00:00"],
      ["DAY", "08:00", "16:00"], ["NIGHT", "18:00", "02:00"],
    ]) data.calendar_shifts.push({ calendar_id, weekday, shift_name: `${calendar_id}_${start_time}`, start_time, end_time, enabled: true });
  }
  let depNumber = 0;
  const dep = (source_type, source_id, target_type, target_id, lag_h = 0) =>
    data.dependencies.push({ dependency_id: `D_${++depNumber}`, source_type, source_id,
      target_type, target_id, relation: "FS", lag_h, enabled: true,
      rationale: "Invented benchmark precedence." });
  for (let s = 0; s < systemsCount; s++) {
    const system_id = `S_${s + 1}`;
    data.systems.push({ system_id, name: `Fictional object ${s + 1}`, family: "Generic object",
      arrival_date: iso(s * 12), enabled: true });
    const systemGate = `G_${system_id}`;
    data.gates.push({ gate_id: systemGate, system_id, name: `Object ${s + 1} ready`,
      gate_type: "READY", exposed: true });
    for (let p = s; p < packagesCount; p += systemsCount) {
      const package_id = `P_${p + 1}`;
      const gate_id = `G_${package_id}`;
      data.packages.push({ package_id, system_id, name: `Fictional batch ${p + 1}`, enabled: true });
      data.gates.push({ gate_id, package_id, name: `Batch ${p + 1} complete`, gate_type: "READY", exposed: true });
      const ids = [];
      for (let a = p; a < count; a += packagesCount) {
        const activity_id = `A_${String(a + 1).padStart(3, "0")}`;
        const kind = a % 7;
        const calendar_id = kind === 0 ? "ANY_HOUR" : a % 3 === 0 ? "NIGHT" : "DAY";
        const elapsed = kind === 0;
        const duration_h = 1 + Math.floor(random() * 3);
        data.activities.push({ activity_id, package_id, name: `Invented step ${a + 1}`,
          duration_h, duration_basis: elapsed ? "ELAPSED_TIME" : "WORK_TIME",
          preemptible: !elapsed && a % 4 === 0, calendar_id,
          requires_system_arrival: !(s > 0 && a === p), enabled: true });
        data.activity_resources.push({ activity_id, resource_id: "SHARED_ROLE", quantity: 1 });
        if (!elapsed) data.activity_resources.push({ activity_id,
          resource_id: calendar_id === "DAY" ? "DAY_TOOL" : "NIGHT_TOOL", quantity: 1 });
        data.activity_zones.push({ activity_id, zone_id: "COMMON", load: a % 19 === 0 ? "ALL" : 1,
          exclusive: a % 19 === 0 });
        if (!elapsed) data.activity_zones.push({ activity_id,
          zone_id: calendar_id === "DAY" ? "DAY_SPACE" : "NIGHT_SPACE", load: 1, exclusive: false });
        ids.push(activity_id);
      }
      // Independent first branches may overlap; converge only at the batch state.
      for (let i = 2; i < ids.length; i++) dep("ACTIVITY", ids[i - 2], "ACTIVITY", ids[i], i === 2 ? 1 : 0);
      for (const id of ids.slice(Math.max(0, ids.length - 2))) dep("ACTIVITY", id, "GATE", gate_id);
      dep("GATE", gate_id, "GATE", systemGate);
    }
  }
  data.gates.push({ gate_id: "PROJECT_COMPLETE", name: "All invented objects complete",
    gate_type: "PROJECT_COMPLETE", exposed: true, is_project_milestone: true });
  for (let s = 0; s < systemsCount; s++) dep("GATE", `G_S_${s + 1}`, "GATE", "PROJECT_COMPLETE");
  data.milestone_priorities.push({ gate_id: "PROJECT_COMPLETE", priority: 1, enabled: true });
  return data;
}

export function makeWorkbook(data) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ["Field", "Value"], ...Object.entries(data.metadata),
  ]), "Metadata");
  for (const [sheet, collection] of Object.entries(TABLES)) {
    const rows = data[collection];
    const headers = rows.length ? [...new Set(rows.flatMap((row) => Object.keys(row)))] : HEADERS[sheet];
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      headers, ...rows.map((row) => headers.map((header) => row[header] ?? null)),
    ]), sheet);
  }
  return XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const output = resolve(process.argv[2] ?? "../../benchmark-artifacts");
  mkdirSync(output, { recursive: true });
  for (const count of [20, 50, 100]) {
    const seed = 31_100 + count;
    const data = generateProject(count, seed);
    writeFileSync(resolve(output, `fiction_${count}_seed_${seed}.xlsx`), makeWorkbook(data));
    console.log(`${count} activities, seed ${seed}: ${output}`);
  }
}
