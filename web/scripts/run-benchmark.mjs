import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import { chromium } from "@playwright/test";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
const sizes = option("--sizes", "20,50,100").split(",").map(Number);
const repeats = Number(option("--repeats", "3"));
const deadlineMs = Number(option("--deadline-ms", "120000"));
if (!sizes.every(x => [20, 50, 100].includes(x)) || !Number.isInteger(repeats) || repeats < 1) {
  throw new Error("Sizes must be selected from 20,50,100 and repeats must be positive.");
}
const output = resolve(option("--output", "../../benchmark-artifacts/results.json"));
const root = resolve("..");
const browserPath = process.env.BENCHMARK_CHROMIUM_PATH;
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"],
  { stdio: ["ignore", "pipe", "pipe"] });
let serverOutput = "";
server.stdout.on("data", data => { serverOutput += String(data); });
server.stderr.on("data", data => { serverOutput += String(data); });
let browser;
try {
  let available = false;
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch("http://127.0.0.1:4173/benchmark.html"); available = response.ok; } catch { /* starting */ }
    if (available) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!available) throw new Error(`Preview failed: ${serverOutput}`);
  browser = await chromium.launch({ headless: true,
    ...(browserPath ? { executablePath: browserPath } : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const report = {
    generatedAt: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    machine: { platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length, ramGiB: +(os.totalmem() / 2 ** 30).toFixed(2) },
    browser: `Chromium ${browser.version()}`, headless: true, repeats, deadlineMs,
    options: { horizonDays: 7, timeLimitSPerPass: 30 }, samples: [],
  };
  const context = await browser.newContext();
  for (const size of sizes) for (let repetition = 1; repetition <= repeats; repetition++) {
    const page = await context.newPage();
    try {
      await page.goto("http://127.0.0.1:4173/benchmark.html");
      const file = resolve(root, "../benchmark-artifacts", `fiction_${size}_seed_${31100 + size}.xlsx`);
      await page.locator("#workbook").setInputFiles(file);
      await page.locator("#run").click();
      await page.waitForFunction(() => window.benchmarkResult !== undefined,
        undefined, { timeout: deadlineMs });
      const sample = await page.evaluate(() => window.benchmarkResult);
      // Chrome's optional nonstandard metric excludes the worker and WebAssembly memory.
      const mainHeapBytes = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
      report.samples.push({ size, repetition, ...sample, mainHeapAfterMiB:
        mainHeapBytes === null ? null : +(mainHeapBytes / 2 ** 20).toFixed(2) });
    } catch (error) {
      report.samples.push({ size, repetition, outcome: "harness_deadline_no_proof", error: String(error) });
    } finally {
      await page.close();
      mkdirSync(resolve(output, ".."), { recursive: true });
      writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(`${size} #${repetition}: ${JSON.stringify(report.samples.at(-1))}`);
    }
  }
  await context.close();
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  server.stdout.destroy();
  server.stderr.destroy();
}
