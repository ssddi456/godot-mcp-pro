#!/usr/bin/env node
// Make build/*.js executable so the npm bin shims work, and export the
// resolved tool catalog as JSON so the Go daemon (server-go/) can embed it.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(__dirname, "..", "build");

for (const f of ["server.js", "index.js", "cli.js", "setup.js"]) {
  const p = resolve(buildDir, f);
  if (existsSync(p)) {
    chmodSync(p, 0o755);
  }
}

// Export resolved tool catalog as JSON for the Go daemon to embed.
try {
  const toolsModUrl = new URL("../build/tools/index.js", import.meta.url).href;
  const { getToolsForMode } = await import(toolsModUrl);
  const modes = ["full", "3d", "lite", "minimal"];
  const out = {};
  for (const m of modes) out[m] = getToolsForMode(m);
  const goDataDir = resolve(__dirname, "..", "..", "server-go", "internal", "tools");
  mkdirSync(goDataDir, { recursive: true });
  writeFileSync(
    resolve(goDataDir, "tools.json"),
    JSON.stringify(out, null, 2) + "\n",
    "utf8",
  );
  console.log(
    `[postbuild] exported tool catalog for Go daemon (full=${out.full.length}, 3d=${out["3d"].length}, lite=${out.lite.length}, minimal=${out.minimal.length})`,
  );
} catch (err) {
  console.warn(`[postbuild] failed to export Go tool catalog: ${err.message}`);
}
