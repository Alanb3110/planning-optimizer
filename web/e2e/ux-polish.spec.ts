import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

for (const width of [1366, 390]) {
  test(`fictional workbook editing journey at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByLabel("Select a local .xlsx file").setInputFiles(resolve("../examples/synthetic_project.xlsx"));
    await expect(page.getByLabel("Workbook validation summary")).toContainText("Workbook accepted");
    await page.getByRole("searchbox", { name: "Search by ID or name" }).fill("Installation");
    await page.getByRole("button", { name: /package Installation SKID_INSTALLATION/ }).click();
    await page.getByRole("button", { name: "Add activity to SKID_INSTALLATION" }).click();
    const form = page.getByLabel("New activity form");
    await form.getByLabel("activity ID").fill("UX_FICTIONAL_CHECK");
    await form.getByLabel("Name").fill("Fictional check");
    await form.getByLabel("Nominal duration (h)").fill("2");
    await form.getByLabel("Activity calendar").selectOption("DEMO_CALENDAR");
    await form.getByRole("button", { name: "Add activity" }).click();

    await expect(page.getByLabel("Demands for UX_FICTIONAL_CHECK"))
      .toContainText("0 role demand(s) · 0 zone occupancy row(s)");
    await page.getByRole("button", { name: "Add role demand" }).click();
    await page.getByLabel("Role / pool").selectOption("INSTALL_CREW");
    await page.getByRole("button", { name: "Save change" }).click();
    await page.getByRole("button", { name: "Add zone occupancy" }).click();
    await page.getByLabel("Zone", { exact: true }).selectOption("ASSEMBLY_AREA");
    await page.getByRole("button", { name: "Save change" }).click();
    await expect(page.getByLabel("Demands for UX_FICTIONAL_CHECK"))
      .toContainText("1 role demand(s) · 1 zone occupancy row(s)");

    await page.getByRole("button", { name: "Add predecessor" }).click();
    await expect(page.getByLabel("Predecessor ID")).toContainText("POSITION_SKID · Position equipment skid");
    await page.getByLabel("Dependency ID").fill("UX_FS_LINK");
    await page.getByLabel("Predecessor ID").selectOption("POSITION_SKID");
    await page.getByLabel("Lag (h)").fill("1");
    await page.getByLabel("Justification").fill("Fictitious sequencing for UX verification");
    await page.getByRole("button", { name: "Add dependency" }).click();
    await expect(page.getByLabel("Workbook validation summary")).toContainText("Edited model valid");
    await page.getByLabel("Imported workbook explorer").screenshot({ path: testInfo.outputPath(`ux-after-${width}.jpg`), type: "jpeg", quality: 80 });

    await page.getByRole("searchbox", { name: "Search by ID or name" }).fill("PROJECT_COMPLETE");
    await page.getByRole("button", { name: /gate Synthetic project complete PROJECT_COMPLETE/ }).click();
    await expect(page.getByLabel("Rank")).toHaveValue("1");
    await page.getByRole("button", { name: "Calculate schedule" }).click();
    await expect(page.getByLabel("Schedule summary")).toContainText("Optimal", { timeout: 220_000 });
    await expect(page.getByLabel("Scrollable activity Gantt")).toContainText("UX_FICTIONAL_CHECK");
    await page.getByRole("button", { name: "Inspect UX_FICTIONAL_CHECK" }).click();
    await expect(page.getByRole("heading", { name: /Why this Activity starts/ })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download new .xlsx revision" }).click();
    const revision = await downloadPromise;
    await page.getByLabel("Select a local .xlsx file").setInputFiles(await revision.path());
    await expect(page.getByLabel("Workbook validation summary")).toContainText("Workbook accepted");
    await expect(page.getByLabel("Workbook entity counts")).toContainText(/7\s*activities/);
    await page.getByRole("searchbox", { name: "Search by ID or name" }).fill("UX_FICTIONAL_CHECK");
    await page.getByRole("button", { name: /activity Fictional check UX_FICTIONAL_CHECK/ }).click();
    await expect(page.getByLabel("Demands for UX_FICTIONAL_CHECK"))
      .toContainText("1 role demand(s) · 1 zone occupancy row(s)");
    await expect(page.getByText("UX_FS_LINK", { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
}
