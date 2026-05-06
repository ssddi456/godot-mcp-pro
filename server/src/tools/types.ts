// Shared types for the tool registry.

export type GdParamType = "string" | "int" | "bool" | "number" | "any";

export interface ParamInfo {
  name: string;
  type: GdParamType;
  required: boolean;
  default?: unknown;
}

export interface ToolMeta {
  /** JSON-RPC method name on the Godot side; also the MCP tool name. */
  name: string;
  /** Internal GDScript handler name (informational only). */
  handler: string;
  /** Category derived from the source file (e.g. "node", "scene", "runtime"). */
  category: string;
  /** Parameters detected from the GDScript source. */
  params: ParamInfo[];
}

export type Mode = "full" | "3d" | "lite" | "minimal";

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ResolvedTool {
  name: string;
  category: string;
  description: string;
  inputSchema: JsonSchema;
}
