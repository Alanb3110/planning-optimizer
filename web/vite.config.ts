import { execFileSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [react()],
  define: {
    "import.meta.env.VITE_BUILD_COMMIT": JSON.stringify(
      command === "build" ? execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim() : "dev",
    ),
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    exclude: ["e2e/**", ...configDefaults.exclude],
  },
}));
