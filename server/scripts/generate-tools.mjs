#!/usr/bin/env node
// Scan addons/godot_mcp/commands/*.gd and emit src/tools/generated.ts.
//
// For each command file we extract:
//   - the methods returned from get_commands()  (method name -> private handler)
//   - for each handler, the parameters it reads via require_*/optional_* helpers
//
// This metadata is enough to build a JSON Schema for every tool. Descriptions
// and richer typing live in src/tools/overrides.ts and are merged at runtime.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const cmdDir = join(repoRoot, "addons", "godot_mcp", "commands");
const outFile = resolve(__dirname, "..", "src", "tools", "generated.ts");

/** @typedef {{name: string, type: "string"|"int"|"bool"|"number"|"any", required: boolean, default?: unknown}} ParamInfo */
/** @typedef {{name: string, handler: string, category: string, params: ParamInfo[]}} ToolMeta */

/** @returns {ToolMeta[]} */
function scanFile(filePath, category) {
  const src = readFileSync(filePath, "utf8");

  // Find the get_commands() body. It returns a Dictionary literal.
  // We accept any whitespace and stop at the matching closing brace.
  const cmdMatch = src.match(/func\s+get_commands\s*\([^)]*\)[^{]*?return\s*\{([\s\S]*?)\n\s*\}/);
  if (!cmdMatch) return [];
  const body = cmdMatch[1];

  /** @type {Array<[string,string]>} */
  const entries = [];
  const entryRe = /"([a-zA-Z_][\w]*)"\s*:\s*([a-zA-Z_][\w]*)/g;
  let m;
  while ((m = entryRe.exec(body)) !== null) {
    entries.push([m[1], m[2]]);
  }

  /** @type {ToolMeta[]} */
  const tools = [];
  for (const [name, handler] of entries) {
    const params = extractParams(src, handler);
    tools.push({ name, handler, category, params });
  }
  return tools;
}

/** @returns {ParamInfo[]} */
function extractParams(src, handler) {
  // Locate `func <handler>(` then capture body up to the next top-level `func ` (or EOF).
  const startRe = new RegExp(`(^|\\n)func\\s+${escapeRe(handler)}\\s*\\(`);
  const startMatch = startRe.exec(src);
  if (!startMatch) return [];
  const startIdx = startMatch.index + startMatch[0].length;
  const restAfter = src.slice(startIdx);
  const nextFunc = restAfter.search(/\nfunc\s+/);
  const body = nextFunc === -1 ? restAfter : restAfter.slice(0, nextFunc);

  /** @type {Map<string, ParamInfo>} */
  const found = new Map();

  // require_string(params, "name")
  for (const m of body.matchAll(/require_string\s*\(\s*params\s*,\s*"([^"]+)"\s*\)/g)) {
    found.set(m[1], { name: m[1], type: "string", required: true });
  }
  // optional_string(params, "name", "default")
  for (const m of body.matchAll(/optional_string\s*\(\s*params\s*,\s*"([^"]+)"(?:\s*,\s*([^)]+))?\)/g)) {
    found.set(m[1], { name: m[1], type: "string", required: false, default: parseDefault(m[2], "string") });
  }
  // optional_int(params, "name", default)
  for (const m of body.matchAll(/optional_int\s*\(\s*params\s*,\s*"([^"]+)"(?:\s*,\s*([^)]+))?\)/g)) {
    found.set(m[1], { name: m[1], type: "int", required: false, default: parseDefault(m[2], "int") });
  }
  // optional_bool(params, "name", default)
  for (const m of body.matchAll(/optional_bool\s*\(\s*params\s*,\s*"([^"]+)"(?:\s*,\s*([^)]+))?\)/g)) {
    found.set(m[1], { name: m[1], type: "bool", required: false, default: parseDefault(m[2], "bool") });
  }
  // params.has("name") / params.get("name", ...) / params["name"]
  // Treat these as additional optional params with unknown type.
  for (const m of body.matchAll(/params\.has\s*\(\s*"([^"]+)"\s*\)/g)) {
    if (!found.has(m[1])) found.set(m[1], { name: m[1], type: "any", required: false });
  }
  for (const m of body.matchAll(/params\.get\s*\(\s*"([^"]+)"/g)) {
    if (!found.has(m[1])) found.set(m[1], { name: m[1], type: "any", required: false });
  }
  for (const m of body.matchAll(/params\[\s*"([^"]+)"\s*\]/g)) {
    if (!found.has(m[1])) found.set(m[1], { name: m[1], type: "any", required: false });
  }

  return [...found.values()];
}

function parseDefault(raw, type) {
  if (raw == null) return undefined;
  const s = raw.trim();
  if (s.length === 0) return undefined;
  if (type === "string") {
    const sm = s.match(/^"([^"]*)"$/);
    if (sm) return sm[1];
    return undefined;
  }
  if (type === "int") {
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "bool") {
    if (s === "true") return true;
    if (s === "false") return false;
    return undefined;
  }
  return undefined;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function categoryFromFile(file) {
  // node_commands.gd -> node
  return file.replace(/_commands\.gd$/, "");
}

function main() {
  const files = readdirSync(cmdDir).filter((f) => f.endsWith("_commands.gd"));
  /** @type {ToolMeta[]} */
  const allTools = [];
  for (const file of files) {
    const cat = categoryFromFile(file);
    const tools = scanFile(join(cmdDir, file), cat);
    for (const t of tools) allTools.push(t);
  }

  // Sort by category then name for stable output.
  allTools.sort((a, b) => (a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category)));

  // Detect duplicate method names — should not happen, but guard against it.
  const seen = new Set();
  for (const t of allTools) {
    if (seen.has(t.name)) {
      throw new Error(`Duplicate tool name: ${t.name}`);
    }
    seen.add(t.name);
  }

  const header =
    "// AUTO-GENERATED by scripts/generate-tools.mjs from addons/godot_mcp/commands/*.gd\n" +
    "// Do not edit by hand. Run `npm run generate` to refresh.\n\n" +
    'import type { ToolMeta } from "./types.js";\n\n';

  const json = JSON.stringify(allTools, null, 2);
  const body = `export const GENERATED_TOOLS: ToolMeta[] = ${json};\n\nexport const GENERATED_COUNT = ${allTools.length};\n`;

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, header + body, "utf8");

  console.log(`[generate-tools] wrote ${allTools.length} tools across ${new Set(allTools.map((t) => t.category)).size} categories -> ${outFile}`);
}

main();
