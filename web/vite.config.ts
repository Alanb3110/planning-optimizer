import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [react()],
  build: process.env.BENCHMARK_BUILD === "1" ? {
    rollupOptions: { input: { index: resolve(__dirname, "index.html"), benchmark: resolve(__dirname, "benchmark.html") } },
  } : undefined,
  define: {
    "import.meta.env.VITE_BUILD_COMMIT": JSON.stringify(
      command === "build" ? execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim() : "dev",
    ),
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    exclude: ["e2e/**", "scripts/**", ...configDefaults.exclude],
  },
}));
