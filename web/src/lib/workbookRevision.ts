import * as XLSX from "xlsx";
import type { NormalizedProject, TableCollectionKey } from "./model";
import { importWorkbook } from "./workbookImport";
import { validateProject } from "./validation";

type Source = Blob | ArrayBuffer | Uint8Array;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && !Array.isArray(item) && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function sheetContents(sheet: XLSX.WorkSheet): string {
  // sheet_to_json can return a Date for a formatted numeric cell before an XLSX
  // roundtrip and its Excel serial afterwards. Compare stored cells instead.
  const cells = Object.entries(sheet)
    .filter(([address, cell]) => !address.startsWith("!") && cell && (cell.v !== undefined || cell.f !== undefined))
    .map(([address, cell]) => ({ address, type: cell.t, value: cell.v, formula: cell.f, format: cell.z }))
    .sort((a, b) => a.address.localeCompare(b.address));
  return canonical(cells);
}

function updateTable(sheet: XLSX.WorkSheet, key: string, rows: Record<string, unknown>[], originalRows: Record<string, unknown>[]) {
  const cells = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
  const headerIndex = cells.slice(0, 30).findIndex((row) => row.some((value) => value === key));
  if (headerIndex < 0) throw new Error(`Missing ${key} header in source workbook.`);
  const headers = cells[headerIndex].map((value) => String(value ?? "").trim());
  const extra = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((field) => !headers.includes(field));
  const allHeaders = [...headers, ...extra];
  // Preserve original cells (in particular formatted Excel dates and formulas)
  // when edits only change fields or append rows without reordering source IDs.
  const appendOrEdit = originalRows.every((row, index) => rows[index]?.[key] === row[key]);
  if (appendOrEdit) {
    if (extra.length) XLSX.utils.sheet_add_aoa(sheet, [allHeaders], { origin: { r: headerIndex, c: 0 } });
    const dataRows = cells.map((row, index) => ({ row, index })).filter(({ row, index }) =>
      index > headerIndex && row.some((value) => value !== null && value !== undefined && value !== ""));
    if (dataRows.length === originalRows.length) {
      for (let index = 0; index < originalRows.length; index += 1) {
        for (const [field, column] of allHeaders.map((field, column) => [field, column] as const)) {
          if (canonical(originalRows[index][field]) === canonical(rows[index][field])) continue;
          const address = XLSX.utils.encode_cell({ r: dataRows[index].index, c: column });
          const value = rows[index][field];
          if (value === undefined || value === null) delete sheet[address];
          else XLSX.utils.sheet_add_aoa(sheet, [[value as string | number | boolean]], { origin: address });
        }
      }
      XLSX.utils.sheet_add_aoa(sheet, rows.slice(originalRows.length).map((row) => allHeaders.map((field) =>
        (row[field] ?? null) as string | number | boolean | null)), {
        origin: { r: (dataRows.at(-1)?.index ?? headerIndex) + 1, c: 0 },
      });
      return;
    }
  }
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
  const original = await importWorkbook(source, "source.xlsx");
  if (!original.isValid) throw new Error("Source workbook is invalid; import a valid V1 workbook first.");
  const editableTables: Array<[string, TableCollectionKey, string]> = [
    ["Systems", "systems", "system_id"], ["Packages", "packages", "package_id"],
    ["Activities", "activities", "activity_id"], ["Gates", "gates", "gate_id"],
    ["Dependencies", "dependencies", "dependency_id"],
    ["ActivityResources", "activity_resources", "activity_id"],
    ["ActivityZones", "activity_zones", "activity_id"],
    ["MilestonePriorities", "milestone_priorities", "gate_id"],
  ];
  const changedSheets = new Set(["Metadata"]);
  updateMetadata(workbook.Sheets.Metadata, metadata);
  for (const [sheetName, collection, key] of editableTables) {
    if (canonical(project[collection]) === canonical(original.data[collection])) continue;
    changedSheets.add(sheetName);
    updateTable(workbook.Sheets[sheetName], key, project[collection], original.data[collection]);
  }
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx", cellStyles: true }) as ArrayBuffer;
  const reimport = await importWorkbook(bytes, `${revision}.xlsx`);
  if (!reimport.isValid) throw new Error(`Revision failed reimport: ${reimport.issues.find((issue) => issue.severity === "error")?.message}`);
  for (const field of ["systems", "packages", "activities", "gates", "dependencies", "resources",
    "activity_resources", "resource_substitutions", "zones", "activity_zones", "calendars",
    "calendar_shifts", "milestone_priorities"] as const) {
    if (canonical(reimport.data[field]) !== canonical(project[field])) {
      throw new Error(`Revision failed reimport: ${field} changed during export.`);
    }
  }
  for (const [key, value] of Object.entries(project.metadata)) {
    if (canonical(reimport.data.metadata[key]) !== canonical(value) && !["revision_id", "parent_revision", "revision_timestamp", "revision_comment"].includes(key)) {
      throw new Error(`Revision failed reimport: metadata.${key} changed unexpectedly.`);
    }
  }
  const reread = XLSX.read(bytes, { type: "array", cellFormula: true, cellStyles: true });
  for (const sheetName of workbook.SheetNames.filter((name) => !changedSheets.has(name))) {
    const original = workbook.Sheets[sheetName];
    const revised = reread.Sheets[sheetName];
    if (!revised || sheetContents(original) !== sheetContents(revised)) {
      throw new Error(`Revision failed verification: worksheet '${sheetName}' changed.`);
    }
  }
  return { bytes, fileName: `${String(project.metadata.project_id).replace(/[^a-zA-Z0-9._-]/g, "-")}_${revision.replace(/[^a-zA-Z0-9._-]/g, "-")}.xlsx`, revision, reimport };
}
