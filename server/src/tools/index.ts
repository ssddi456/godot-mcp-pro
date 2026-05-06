// Combine the auto-generated tool metadata with curated descriptions/schema
// overrides into the final list of MCP tools.

import { GENERATED_TOOLS } from "./generated.js";
import { selectTools } from "./modes.js";
import { TOOL_OVERRIDES, fallbackDescription } from "./overrides.js";
import type { JsonSchema, Mode, ParamInfo, ResolvedTool, ToolMeta } from "./types.js";

export { GENERATED_TOOLS } from "./generated.js";

function paramTypeToJsonSchema(p: ParamInfo): Record<string, unknown> {
  switch (p.type) {
    case "string":
      return { type: "string" };
    case "int":
      return { type: "integer" };
    case "number":
      return { type: "number" };
    case "bool":
      return { type: "boolean" };
    case "any":
    default:
      // Godot params accept Variant; allow any JSON value.
      return {};
  }
}

function buildSchema(meta: ToolMeta): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of meta.params) {
    const desc: Record<string, unknown> = paramTypeToJsonSchema(p);
    if (p.default !== undefined) {
      desc.default = p.default;
    }
    properties[p.name] = desc;
    if (p.required) required.push(p.name);
  }

  const schema: JsonSchema = {
    type: "object",
    properties,
    additionalProperties: true,
  };
  if (required.length > 0) schema.required = required;
  return schema;
}

function mergeSchema(base: JsonSchema, patch: Partial<JsonSchema> | undefined): JsonSchema {
  if (!patch) return base;
  return {
    type: "object",
    properties: { ...base.properties, ...(patch.properties ?? {}) },
    required: patch.required ?? base.required,
    additionalProperties:
      patch.additionalProperties !== undefined ? patch.additionalProperties : base.additionalProperties,
  };
}

export function resolveTool(meta: ToolMeta): ResolvedTool {
  const override = TOOL_OVERRIDES[meta.name];
  const description = override?.description ?? fallbackDescription(meta.name, meta.category);
  const schema = mergeSchema(buildSchema(meta), override?.schema);
  return {
    name: meta.name,
    category: meta.category,
    description,
    inputSchema: schema,
  };
}

export function getToolsForMode(mode: Mode): ResolvedTool[] {
  return selectTools(GENERATED_TOOLS, mode).map(resolveTool);
}

export function getAllToolsByName(): Map<string, ResolvedTool> {
  const map = new Map<string, ResolvedTool>();
  for (const meta of GENERATED_TOOLS) {
    map.set(meta.name, resolveTool(meta));
  }
  return map;
}

export function getCategories(): string[] {
  return Array.from(new Set(GENERATED_TOOLS.map((t) => t.category))).sort();
}
