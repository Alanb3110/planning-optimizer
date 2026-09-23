import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { expect, test } from "@playwright/test";

test("fictional lag edit downloads a reimportable revision with unchanged Systems dates", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Select a local .xlsx file").setInputFiles(resolve("../examples/synthetic_project.xlsx"));
  await expect(page.getByLabel("Workbook validation summary")).toContainText("Workbook accepted");
  await page.getByLabel("Systems, packages, activities and gates")
    .getByRole("button", { name: /PREPARE_FOUNDATION/ }).click();
  await page.getByRole("button", { name: "Edit DEP_003" }).click();
  await page.getByLabel("Lag (h)").fill("3");
  await page.getByRole("button", { name: "Save dependency" }).click();
  await expect(page.getByLabel("Workbook validation summary")).toContainText("Workbook accepted");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download new .xlsx revision" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/_EDIT_\d+\.xlsx$/);
  const source = XLSX.read(new Uint8Array(await readFile(resolve("../examples/synthetic_project.xlsx"))), { type: "array", cellStyles: true });
  const revision = XLSX.read(new Uint8Array(await readFile(await download.path())), { type: "array", cellStyles: true });
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(revision.Sheets.Dependencies);
  expect(rows.find((row) => row.dependency_id === "DEP_003")?.lag_h).toBe(3);
  for (const address of ["D2", "D3"]) {
    expect(revision.Sheets.Systems[address].v).toBe(source.Sheets.Systems[address].v);
    expect(revision.Sheets.Systems[address].z).toBe(source.Sheets.Systems[address].z);
  }
});

test("fictitious workbook imports and solves locally in the production build", async ({ page, context }) => {
  const origin = "http://127.0.0.1:4173";
  const requests: Array<{ method: string; url: string }> = [];
  const failures: string[] = [];
  const pageErrors: string[] = [];
  const workers: string[] = [];
  const wasmResponses: string[] = [];

  context.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
  context.on("requestfailed", (request) => failures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
  context.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith(".wasm") && response.ok()) wasmResponses.push(response.url());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("worker", (worker) => workers.push(worker.url()));

  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByLabel("Select a local .xlsx file").setInputFiles(
    resolve("../examples/synthetic_project.xlsx"),
  );
  await expect(page.getByLabel("Workbook validation summary")).toContainText("Workbook accepted");
  await expect(page.getByText("synthetic_project.xlsx", { exact: true })).toBeVisible();

  await page.getByLabel("Solver time limit").fill("180");
  await page.getByRole("button", { name: "Calculate schedule" }).click();
  await expect(page.getByLabel("Schedule summary")).toContainText("Optimal", { timeout: 220_000 });
  await expect(page.getByLabel("Schedule summary")).toContainText("PROJECT_COMPLETE");
  await expect(page.getByLabel("Scrollable activity Gantt")).toContainText("Jan 2030");
  await expect(page.getByLabel("Scrollable activity Gantt")).toContainText("H+0");
  await expect(page.getByLabel("Local result export")).toContainText("UTC (Z) and");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download result ZIP" }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/_schedule\.zip$/);

  expect(workers, "a real scheduling Worker must start").toHaveLength(1);
  expect(new URL(workers[0]).origin).toBe(origin);
  expect(wasmResponses, "the Worker must fetch a working WASM asset").toHaveLength(1);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter(({ method, url }) => method !== "GET" || new URL(url).origin !== origin)).toEqual([]);
  expect(failures).toEqual([]);
  expect(pageErrors).toEqual([]);
});
