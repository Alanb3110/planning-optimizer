import * as XLSX from "xlsx";
import type { NormalizedProject } from "./model";
import { importWorkbook } from "./workbookImport";
import { validateProject } from "./validation";

type Source = Blob | ArrayBuffer | Uint8Array;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && !Array.isArray(item) && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function updateTable(sheet: XLSX.WorkSheet, key: string, rows: Record<string, unknown>[]) {
  const cells = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
  const headerIndex = cells.slice(0, 30).findIndex((row) => row.some((value) => value === key));
  if (headerIndex < 0) throw new Error(`Missing ${key} header in source workbook.`);
  const headers = cells[headerIndex].map((value) => String(value ?? "").trim());
  const extra = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((field) => !headers.includes(field));
  const allHeaders = [...headers, ...extra];
  // Clear old data cells, including deleted rows. Keep the header, preamble and any sheet formatting.
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1");
  for (let r = headerIndex + 1; r <= range.e.r; r += 1) {
    for (let c = 0; c <= range.e.c; c += 1) delete sheet[XLSX.utils.encode_cell({ r, c })];
  }
  XLSX.utils.sheet_add_aoa(sheet, [allHeaders], { origin: { r: headerIndex, c: 0 } });
  XLSX.utils.sheet_add_aoa(sheet, rows.map((row) => allHeaders.map((field) => {
    const value = row[field];
    return value === undefined || value === null ? null : value as string | number | boolean;
  })), { origin: { r: headerIndex + 1, c: 0 } });
}

function updateMetadata(sheet: XLSX.WorkSheet, metadata: Record<string, unknown>) {
  const cells = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
  const headerIndex = cells.slice(0, 30).findIndex((row) => typeof row[0] === "string" && row[0].toLowerCase() === "field");
  if (headerIndex < 0) throw new Error("Missing Field header in Metadata sheet.");
  const positions = new Map<string, number>();
  cells.forEach((row, index) => {
    if (index > headerIndex && typeof row[0] === "string") positions.set(row[0], index);
  });
  for (const [field, value] of Object.entries(metadata)) {
    const index = positions.get(field) ?? cells.length;
    if (!positions.has(field)) { positions.set(field, index); cells.push([]); }
    XLSX.utils.sheet_add_aoa(sheet, [[field, value as string | number | boolean]], { origin: { r: index, c: 0 } });
  }
}

export async function createWorkbookRevision(source: Source, project: NormalizedProject, comment = "", now = new Date()) {
  const issues = validateProject(project).filter((issue) => issue.severity === "error");
  if (issues.length) throw new Error(`Invalid model: ${issues[0].message}`);
  const parent = String(project.metadata.revision_id);
  const revision = `${parent}_EDIT_${now.toISOString().slice(0, 19).replace(/\D/g, "")}`;
  const metadata = {
    revision_id: revision,
    parent_revision: parent,
    revision_timestamp: now.toISOString(),
    ...(comment.trim() ? { revision_comment: comment.trim() } : {}),
  };
  const workbook = XLSX.read(source instanceof Blob ? await source.arrayBuffer() : source, {
    type: "array", cellStyles: true, cellFormula: true,
  });
  updateMetadata(workbook.Sheets.Metadata, metadata);
  updateTable(workbook.Sheets.Dependencies, "dependency_id", project.dependencies);
  updateTable(workbook.Sheets.MilestonePriorities, "gate_id", project.milestone_priorities);
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx", cellStyles: true }) as ArrayBuffer;
  const reimport = await importWorkbook(bytes, `${revision}.xlsx`);
  if (!reimport.isValid) throw new Error(`Revision failed reimport: ${reimport.issues.find((issue) => issue.severity === "error")?.message}`);
  const unaffected = ["systems", "packages", "activities", "gates", "resources", "activity_resources",
    "resource_substitutions", "zones", "activity_zones", "calendars", "calendar_shifts"] as const;
  for (const field of unaffected) {
    if (canonical(reimport.data[field]) !== canonical(project[field])) {
      throw new Error(`Revision failed reimport: ${field} was modified unexpectedly.`);
    }
  }
  for (const field of ["dependencies", "milestone_priorities"] as const) {
    if (canonical(reimport.data[field]) !== canonical(project[field])) {
      throw new Error(`Revision failed reimport: ${field} changed during export.`);
    }
  }
  for (const [key, value] of Object.entries(project.metadata)) {
    if (canonical(reimport.data.metadata[key]) !== canonical(value) && !["revision_id", "parent_revision", "revision_timestamp", "revision_comment"].includes(key)) {
      throw new Error(`Revision failed reimport: metadata.${key} changed unexpectedly.`);
    }
  }
  const reread = XLSX.read(bytes, { type: "array", cellFormula: true });
  for (const sheetName of workbook.SheetNames.filter((name) => !["Metadata", "Dependencies", "MilestonePriorities"].includes(name))) {
    const original = workbook.Sheets[sheetName];
    const revised = reread.Sheets[sheetName];
    if (!revised || canonical(XLSX.utils.sheet_to_json(original, { header: 1, raw: true }))
      !== canonical(XLSX.utils.sheet_to_json(revised, { header: 1, raw: true }))) {
      throw new Error(`Revision failed verification: worksheet '${sheetName}' changed.`);
    }
    for (const [cell, record] of Object.entries(original)) {
      if (cell.startsWith("!") || !record?.f) continue;
      if (revised[cell]?.f !== record.f) throw new Error(`Revision failed verification: formula ${sheetName}!${cell} changed.`);
    }
  }
  return { bytes, fileName: `${String(project.metadata.project_id).replace(/[^a-zA-Z0-9._-]/g, "-")}_${revision.replace(/[^a-zA-Z0-9._-]/g, "-")}.xlsx`, revision, reimport };
}
