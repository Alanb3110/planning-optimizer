import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

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

  expect(workers, "a real scheduling Worker must start").toHaveLength(1);
  expect(new URL(workers[0]).origin).toBe(origin);
  expect(wasmResponses, "the Worker must fetch a working WASM asset").toHaveLength(1);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter(({ method, url }) => method !== "GET" || new URL(url).origin !== origin)).toEqual([]);
  expect(failures).toEqual([]);
  expect(pageErrors).toEqual([]);
});
