import * as XLSX from "xlsx";
import {
  createEmptyProject,
  type NormalizedProject,
  type NormalizedRecord,
  type TableCollectionKey,
  type ValidationIssue,
  type WorkbookImportResult,
} from "./model";
import { validateProject } from "./validation";

type WorkbookSource = ArrayBuffer | Uint8Array | Blob;
type CellValue = string | number | boolean | Date | null | undefined;

interface TableSheetDefinition {
  sheetName: string;
  collection: TableCollectionKey;
  keyHeader: string;
}

const TABLE_SHEETS: TableSheetDefinition[] = [
  { sheetName: "Systems", collection: "systems", keyHeader: "system_id" },
  { sheetName: "Packages", collection: "packages", keyHeader: "package_id" },
  { sheetName: "Activities", collection: "activities", keyHeader: "activity_id" },
  { sheetName: "Gates", collection: "gates", keyHeader: "gate_id" },
  { sheetName: "Dependencies", collection: "dependencies", keyHeader: "dependency_id" },
  { sheetName: "Resources", collection: "resources", keyHeader: "resource_id" },
  {
    sheetName: "ActivityResources",
    collection: "activity_resources",
    keyHeader: "activity_id",
  },
  {
    sheetName: "ResourceSubstitutions",
    collection: "resource_substitutions",
    keyHeader: "required_resource_id",
  },
  { sheetName: "Zones", collection: "zones", keyHeader: "zone_id" },
  { sheetName: "ActivityZones", collection: "activity_zones", keyHeader: "activity_id" },
  { sheetName: "Calendars", collection: "calendars", keyHeader: "calendar_id" },
  { sheetName: "CalendarShifts", collection: "calendar_shifts", keyHeader: "calendar_id" },
  {
    sheetName: "MilestonePriorities",
    collection: "milestone_priorities",
    keyHeader: "gate_id",
  },
];

const REQUIRED_SHEETS = ["Metadata", ...TABLE_SHEETS.map((definition) => definition.sheetName)];
const KNOWN_INFORMATIONAL_SHEETS = new Set(["DataDictionary"]);
const BOOLEAN_FIELDS = new Set([
  "enabled",
  "preemptible",
  "exposed",
  "is_project_milestone",
  "unlimited",
  "exclusive",
  "is_override",
  "requires_system_arrival",
]);

function addIssue(
  issues: ValidationIssue[],
  severity: "error" | "warning",
  code: string,
  message: string,
  location?: string,
) {
  issues.push({ severity, code, message, location });
}

function isBlank(value: CellValue): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function normalizeScalar(value: CellValue): CellValue {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  return value;
}

function normalizeBoolean(
  value: CellValue,
  location: string,
  issues: ValidationIssue[],
): CellValue {
  if (typeof value === "boolean" || value === null || value === undefined) return value;
  if (value === 0 || value === 1) {
    addIssue(
      issues,
      "warning",
      "BOOLEAN_COERCION",
      `Converted numeric ${value} to boolean.`,
      location,
    );
    return value === 1;
  }
  if (typeof value === "string" && ["true", "false"].includes(value.trim().toLowerCase())) {
    addIssue(
      issues,
      "warning",
      "BOOLEAN_COERCION",
      `Converted text '${value}' to boolean.`,
      location,
    );
    return value.trim().toLowerCase() === "true";
  }
  return value;
}

function sheetRows(sheet: XLSX.WorkSheet): CellValue[][] {
  return XLSX.utils.sheet_to_json<CellValue[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
}

function findHeaderRow(rows: CellValue[][], keyHeader: string): number {
  return rows.slice(0, 30).findIndex((row) =>
    row.some((value) => typeof value === "string" && value.trim() === keyHeader),
  );
}

function readTable(
  sheet: XLSX.WorkSheet,
  definition: TableSheetDefinition,
  issues: ValidationIssue[],
): NormalizedRecord[] {
  const rows = sheetRows(sheet);
  const headerIndex = findHeaderRow(rows, definition.keyHeader);
  if (headerIndex < 0) {
    addIssue(
      issues,
      "error",
      "MISSING_HEADER",
      `Could not find header '${definition.keyHeader}'.`,
      definition.sheetName,
    );
    return [];
  }

  const rawHeaders = rows[headerIndex];
  const lastHeaderIndex = rawHeaders.reduce<number>(
    (lastIndex, value, index) => (isBlank(value) ? lastIndex : index),
    -1,
  );
  const headers = rawHeaders
    .slice(0, lastHeaderIndex + 1)
    .map((value) => (isBlank(value) ? "" : String(value).trim()));
  const records: NormalizedRecord[] = [];

  rows.slice(headerIndex + 1).forEach((row, rowOffset) => {
    if (row.slice(0, headers.length).every(isBlank)) return;
    const record: NormalizedRecord = {};
    headers.forEach((header, columnIndex) => {
      if (!header) return;
      let value = normalizeScalar(row[columnIndex]);
      if (BOOLEAN_FIELDS.has(header)) {
        value = normalizeBoolean(
          value,
          `${definition.sheetName}!${header} row ${headerIndex + rowOffset + 2}`,
          issues,
        );
      }
      if (!isBlank(value)) record[header] = value;
    });
    records.push(record);
  });

  return records;
}

function readMetadata(sheet: XLSX.WorkSheet, issues: ValidationIssue[]): NormalizedRecord {
  const rows = sheetRows(sheet);
  const headerIndex = rows.slice(0, 30).findIndex((row) =>
    row.some((value) => typeof value === "string" && value.trim() === "Field"),
  );
  if (headerIndex < 0) {
    addIssue(issues, "error", "MISSING_HEADER", "Could not find header 'Field'.", "Metadata");
    return {};
  }

  const metadata: NormalizedRecord = {};
  rows.slice(headerIndex + 1).forEach((row, rowOffset) => {
    const field = normalizeScalar(row[0]);
    const value = normalizeScalar(row[1]);
    if (typeof field !== "string" || isBlank(field)) return;
    if (Object.hasOwn(metadata, field)) {
      addIssue(
        issues,
        "error",
        "DUPLICATE_METADATA_FIELD",
        `Metadata field '${field}' is defined more than once.`,
        `Metadata row ${headerIndex + rowOffset + 2}`,
      );
    }
    if (!isBlank(value)) metadata[field] = value;
  });
  return metadata;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function dateParts(value: unknown): DateParts | null {
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return {
      year: parsed.y,
      month: parsed.m,
      day: parsed.d,
      hour: parsed.H,
      minute: parsed.M,
      second: Math.floor(parsed.S),
    };
  }
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate(),
      hour: value.getUTCHours(),
      minute: value.getUTCMinutes(),
      second: value.getUTCSeconds(),
    };
  }
  if (typeof value === "string") {
    const match = value.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
    );
    if (match) {
      return {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4] ?? 0),
        minute: Number(match[5] ?? 0),
        second: Number(match[6] ?? 0),
      };
    }
  }
  return null;
}

const pad = (value: number) => String(value).padStart(2, "0");

function formatDateOnly(value: unknown): string | null {
  const parts = dateParts(value);
  return parts ? `${parts.year}-${pad(parts.month)}-${pad(parts.day)}` : null;
}

function timezoneParts(date: Date, timezone: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function formatZonedDateTime(value: unknown, timezone: string): string | null {
  if (typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
  }
  const desired = dateParts(value);
  if (!desired) return null;
  const desiredAsUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second,
  );
  let instant = desiredAsUtc;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const actual = timezoneParts(new Date(instant), timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    instant += desiredAsUtc - actualAsUtc;
  }
  const offsetMinutes = Math.round((desiredAsUtc - instant) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
  return `${desired.year}-${pad(desired.month)}-${pad(desired.day)}T${pad(desired.hour)}:${pad(desired.minute)}:${pad(desired.second)}${offset}`;
}

function resolveProjectTimezone(data: NormalizedProject, issues: ValidationIssue[]): string {
  const activeCalendar = data.metadata.active_calendar;
  const calendar = data.calendars.find((row) => row.calendar_id === activeCalendar);
  const timezone = typeof calendar?.timezone === "string" ? calendar.timezone : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    addIssue(
      issues,
      "error",
      "INVALID_TIMEZONE",
      `Unknown IANA timezone '${timezone}'. Dates were normalized with UTC as a fallback.`,
      "calendars.timezone",
    );
    return "UTC";
  }
}

function normalizeDateField(
  record: NormalizedRecord,
  field: string,
  mode: "date" | "date-time",
  timezone: string,
  location: string,
  issues: ValidationIssue[],
) {
  if (!(field in record)) return;
  const normalized =
    mode === "date" ? formatDateOnly(record[field]) : formatZonedDateTime(record[field], timezone);
  if (normalized) {
    record[field] = normalized;
  } else {
    addIssue(
      issues,
      "error",
      "INVALID_DATE",
      `Could not normalize ${field}.`,
      location,
    );
  }
}

function normalizeProject(data: NormalizedProject, issues: ValidationIssue[]) {
  const timezone = resolveProjectTimezone(data, issues);
  normalizeDateField(data.metadata, "project_start", "date-time", timezone, "metadata.project_start", issues);
  normalizeDateField(data.metadata, "created_date", "date", timezone, "metadata.created_date", issues);

  data.systems.forEach((system) => {
    normalizeDateField(
      system,
      "arrival_date",
      "date-time",
      timezone,
      `systems.${String(system.system_id ?? "?")}.arrival_date`,
      issues,
    );
  });
  data.calendars.forEach((calendar) => {
    normalizeDateField(
      calendar,
      "valid_from",
      "date",
      timezone,
      `calendars.${String(calendar.calendar_id ?? "?")}.valid_from`,
      issues,
    );
    normalizeDateField(
      calendar,
      "valid_to",
      "date",
      timezone,
      `calendars.${String(calendar.calendar_id ?? "?")}.valid_to`,
      issues,
    );
    if (typeof calendar.weekend_days === "string") {
      calendar.weekend_days = calendar.weekend_days
        .split(",")
        .map((day) => day.trim().toUpperCase())
        .filter(Boolean);
    }
  });
  data.activities.forEach((activity) => {
    if (!("requires_system_arrival" in activity)) activity.requires_system_arrival = true;
  });
}

async function sourceBytes(source: WorkbookSource): Promise<ArrayBuffer | Uint8Array> {
  return source instanceof Blob ? source.arrayBuffer() : source;
}

export async function importWorkbook(
  source: WorkbookSource,
  fileName = "workbook.xlsx",
): Promise<WorkbookImportResult> {
  const data = createEmptyProject();
  const issues: ValidationIssue[] = [];
  let sheetNames: string[] = [];

  try {
    const workbook = XLSX.read(await sourceBytes(source), {
      type: "array",
      cellDates: false,
      cellFormula: true,
    });
    sheetNames = workbook.SheetNames;

    for (const sheetName of REQUIRED_SHEETS) {
      if (!workbook.Sheets[sheetName]) {
        addIssue(issues, "error", "MISSING_SHEET", `Missing worksheet '${sheetName}'.`, sheetName);
      }
    }

    const metadataSheet = workbook.Sheets.Metadata;
    if (metadataSheet) data.metadata = readMetadata(metadataSheet, issues);

    for (const definition of TABLE_SHEETS) {
      const sheet = workbook.Sheets[definition.sheetName];
      if (sheet) data[definition.collection] = readTable(sheet, definition, issues);
    }

    const supportedSheets = new Set([...REQUIRED_SHEETS, ...KNOWN_INFORMATIONAL_SHEETS]);
    for (const sheetName of sheetNames) {
      if (!supportedSheets.has(sheetName)) {
        addIssue(
          issues,
          "warning",
          "IGNORED_SHEET",
          `Worksheet '${sheetName}' is not part of the V1 import model and was ignored.`,
          sheetName,
        );
      }
    }

    normalizeProject(data, issues);
    issues.push(...validateProject(data));
  } catch (error) {
    addIssue(
      issues,
      "error",
      "WORKBOOK_READ_FAILED",
      error instanceof Error ? error.message : "The workbook could not be read.",
    );
  }

  return {
    data,
    fileName,
    sheetNames,
    issues,
    summary: {
      systems: data.systems.length,
      packages: data.packages.length,
      activities: data.activities.length,
      gates: data.gates.length,
    },
    isValid: !issues.some((validationIssue) => validationIssue.severity === "error"),
  };
}
