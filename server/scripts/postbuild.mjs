#!/usr/bin/env node
// Make build/index.js and build/cli.js executable so the npm bin shims work.
import { chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(__dirname, "..", "build");

for (const f of ["index.js", "cli.js", "setup.js"]) {
  const p = resolve(buildDir, f);
  if (existsSync(p)) {
    chmodSync(p, 0o755);
  }
}
