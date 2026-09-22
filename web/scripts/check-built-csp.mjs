import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const assetsDirectory = new URL("../dist/assets/", import.meta.url);
const assetsPath = fileURLToPath(assetsDirectory);
const files = await readdir(assetsDirectory);
const forbidden = [
  { label: "dynamic Function construction", pattern: /\bnew\s+Function\s*\(/ },
  { label: "direct eval", pattern: /\beval\s*\(/ },
  { label: "unbundled CommonJS require", pattern: /\brequire\s*\(/ },
];

for (const file of files) {
  if (extname(file) !== ".js") continue;
  const source = await readFile(join(assetsPath, file), "utf8");
  for (const check of forbidden) {
    if (check.pattern.test(source)) {
      throw new Error(`${file} contains ${check.label}, which is incompatible with the production CSP.`);
    }
  }
}

console.log("Built JavaScript is compatible with the no-unsafe-eval CSP.");
