#!/usr/bin/env node
// Godot MCP Pro — direct CLI for invoking tools without an MCP client.
//
// Usage:
//   node build/cli.js --help
//   node build/cli.js <category> --help
//   node build/cli.js <category> <command> [--option value ...]
//   node build/cli.js call <tool_name> --params '{"json":"object"}'
//
// The CLI connects to the long-running Node.js server over WebSocket. It never
// connects to the Godot addon directly.

import { Command, Option } from "commander";
import { getAllToolsByName, getCategories, GENERATED_TOOLS } from "./tools/index.js";
import { RpcClient, RpcError } from "./rpc-client.js";
import type { ResolvedTool } from "./tools/types.js";

const PROGRAM_NAME = "godot-mcp-pro-cli";

interface ParsedTool {
  tool: ResolvedTool;
}

function buildProgram(): Command {
  const program = new Command(PROGRAM_NAME)
    .description(
      "Direct CLI client for the Godot MCP Pro daemon. Invoke tools without going through MCP.\n\n" +
        "Requires `node build/server.js` to be running and the Godot editor plugin enabled.",
    )
    .showHelpAfterError();

  const allTools = getAllToolsByName();
  const categories = getCategories();

  // Group commands by category.
  for (const cat of categories) {
    const group = program
      .command(cat)
      .description(`Tools in the "${cat}" category`)
      .showHelpAfterError();

    const toolsInCat = GENERATED_TOOLS.filter((t) => t.category === cat);
    for (const meta of toolsInCat) {
      const tool = allTools.get(meta.name)!;
      // Strip the `<category>_` prefix from the command if present, for terser CLI usage.
      // e.g. tilemap_set_cell -> tilemap set-cell
      const prefix = `${cat}_`;
      const sub = meta.name.startsWith(prefix) ? meta.name.slice(prefix.length) : meta.name;
      const subCmd = group.command(sub).description(tool.description);
      addToolOptions(subCmd, tool);
      subCmd.action(async (opts: Record<string, unknown>) => {
        await runTool(tool, opts);
      });
    }
  }

  // Generic `call <tool> --params <json>` escape hatch.
  program
    .command("call <tool>")
    .description("Invoke a tool by its raw name with a JSON --params payload.")
    .option("--params <json>", "Tool arguments as a JSON object", "{}")
    .action(async (toolName: string, opts: { params: string }) => {
      const tool = allTools.get(toolName);
      if (!tool) {
        process.stderr.write(`Unknown tool: ${toolName}\n`);
        process.exit(2);
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(opts.params);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("--params must be a JSON object");
        }
      } catch (err) {
        process.stderr.write(`Invalid --params JSON: ${(err as Error).message}\n`);
        process.exit(2);
      }
      await runTool(tool, parsed);
    });

  // `list` helper for discovery.
  program
    .command("list")
    .description("List every tool grouped by category.")
    .option("-c, --category <name>", "Restrict to one category")
    .action((opts: { category?: string }) => {
      for (const cat of categories) {
        if (opts.category && cat !== opts.category) continue;
        const tools = GENERATED_TOOLS.filter((t) => t.category === cat);
        process.stdout.write(`\n[${cat}] (${tools.length})\n`);
        for (const t of tools) {
          process.stdout.write(`  ${t.name}\n`);
        }
      }
    });

  return program;
}

function addToolOptions(cmd: Command, tool: ResolvedTool): void {
  const props = tool.inputSchema.properties as Record<
    string,
    { type?: string; default?: unknown }
  >;
  const required = new Set(tool.inputSchema.required ?? []);
  for (const [name, schema] of Object.entries(props)) {
    const flag = `--${name.replace(/_/g, "-")}`;
    const isBool = schema.type === "boolean";
    const isRequired = required.has(name);
    const placeholder = isBool ? "" : ` <${schema.type ?? "value"}>`;
    const opt = new Option(`${flag}${placeholder}`, describeOpt(name, schema));
    if (isRequired) opt.makeOptionMandatory();
    if (schema.default !== undefined && !isBool) opt.default(schema.default);
    cmd.addOption(opt);
  }
}

function describeOpt(name: string, schema: { type?: string; default?: unknown }): string {
  const t = schema.type ?? "any";
  return `${name}: ${t}`;
}

function coerce(value: unknown, type: string | undefined): unknown {
  if (value === undefined) return undefined;
  if (type === "integer") {
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) ? n : value;
  }
  if (type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const s = String(value).toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
    return value;
  }
  return value;
}

function buildArgs(tool: ResolvedTool, opts: Record<string, unknown>): Record<string, unknown> {
  const props = tool.inputSchema.properties as Record<string, { type?: string }>;
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(props)) {
    // commander stores --foo-bar as opts.fooBar
    const camel = name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const v = opts[camel] ?? opts[name];
    if (v === undefined) continue;
    out[name] = coerce(v, schema.type);
  }
  return out;
}

async function runTool(tool: ResolvedTool, rawOpts: Record<string, unknown>): Promise<void> {
  const args = buildArgs(tool, rawOpts);
  const rpc = new RpcClient();

  try {
    const result = await rpc.call("call_tool", { name: tool.name, arguments: args });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = 0;
  } catch (err) {
    if (err instanceof RpcError) {
      process.stderr.write(`Error ${err.code}: ${err.message}\n`);
      if (err.data) process.stderr.write(`  data: ${JSON.stringify(err.data)}\n`);
    } else {
      process.stderr.write(`${(err as Error).message ?? err}\n`);
    }
    process.exitCode = 1;
  } finally {
    rpc.close();
  }
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

void main();

// Silence unused warning when we only export ParsedTool conditionally.
export type { ParsedTool };
