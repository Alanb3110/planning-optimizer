import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import * as XLSX from "xlsx";
import { generateProject, makeWorkbook } from "./generate-benchmark.mjs";

const schema = JSON.parse(readFileSync(new URL("../../schema/planning_optimizer_schema_v1.json", import.meta.url)));
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

test("only the short fixed-seed fictional case runs in CI", () => {
  const project = generateProject(20, 31120);
  assert.equal(validate(project), true, JSON.stringify(validate.errors));
  assert.equal(project.activities.length, 20);
  assert.ok(project.systems.length >= 3 && project.packages.length >= 3);
  assert.ok(project.activities.some(x => x.preemptible));
  assert.ok(project.activities.some(x => !x.preemptible));
  assert.ok(project.activities.some(x => x.duration_basis === "ELAPSED_TIME"));
  assert.ok(project.dependencies.some(x => x.lag_h > 0));
  assert.ok(project.activity_zones.some(x => x.exclusive));
  assert.ok(project.calendars.some(x => x.calendar_id === "NIGHT"));
  const bytes = makeWorkbook(project);
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    createHash("sha256").update(makeWorkbook(generateProject(20, 31120))).digest("hex"));
  const workbook = XLSX.read(bytes, { type: "buffer" });
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.Activities).length, 20);
  assert.equal(workbook.SheetNames.length, 14);
});
