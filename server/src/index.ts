#!/usr/bin/env node
// Godot MCP Pro server — stdio MCP entry point.
//
// CLI usage (set in claude/cursor/etc.'s mcp config):
//   node build/index.js                # full mode (172 tools)
//   node build/index.js --3d           # drop 2D-only tools
//   node build/index.js --lite         # essential set (~81 tools)
//   node build/index.js --minimal      # ~35 tools
//
// Environment variables:
//   GODOT_MCP_PORT       force a specific port (else 6505-6509)
//   GODOT_MCP_PORT_RANGE "lo-hi" override port range
//   GODOT_MCP_TIMEOUT_MS per-request timeout (ms)
//   GODOT_MCP_DEBUG=1    verbose stderr logging

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GodotBridge, GodotError } from "./godot-bridge.js";
import { getToolsForMode } from "./tools/index.js";
import type { Mode } from "./tools/types.js";
import { log } from "./log.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ParsedArgs {
  mode: Mode;
}

function parseArgs(argv: string[]): ParsedArgs {
  let mode: Mode = "full";
  for (const arg of argv) {
    switch (arg) {
      case "--full":
        mode = "full";
        break;
      case "--3d":
        mode = "3d";
        break;
      case "--lite":
        mode = "lite";
        break;
      case "--minimal":
        mode = "minimal";
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      // ignore unknown
    }
  }
  return { mode };
}

function printHelp(): void {
  process.stderr.write(
    [
      "godot-mcp-pro — MCP stdio server for the Godot editor",
      "",
      "Usage: node build/index.js [--full|--3d|--lite|--minimal]",
      "",
      "Modes:",
      "  --full      All 171 tools (default)",
      "  --3d        Drop 2D-only categories (tilemap, ...)",
      "  --lite      Essential 8 categories",
      "  --minimal   ~35 hand-picked essential tools",
      "",
      "Env:",
      "  GODOT_MCP_PORT=6505           force a specific port",
      "  GODOT_MCP_PORT_RANGE=6505-6509 override the port range",
      "  GODOT_MCP_TIMEOUT_MS=60000    per-request timeout",
      "  GODOT_MCP_DEBUG=1             verbose logging to stderr",
    ].join("\n") + "\n",
  );
}

function getServerVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parsePortRange(): { port?: number; portRange?: [number, number] } {
  const single = process.env.GODOT_MCP_PORT;
  if (single) {
    const n = Number.parseInt(single, 10);
    if (Number.isFinite(n)) return { port: n };
  }
  const range = process.env.GODOT_MCP_PORT_RANGE;
  if (range) {
    const m = range.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) return { portRange: [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10)] };
  }
  return {};
}

async function main(): Promise<void> {
  const { mode } = parseArgs(process.argv.slice(2));
  const tools = getToolsForMode(mode);
  log.info(`Starting Godot MCP Pro server (mode=${mode}, tools=${tools.length})`);

  const portCfg = parsePortRange();
  const timeoutMs = Number.parseInt(process.env.GODOT_MCP_TIMEOUT_MS ?? "", 10);
  const bridge = new GodotBridge({
    ...portCfg,
    defaultTimeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  });

  await bridge.start();

  const toolsByName = new Map(tools.map((t) => [t.name, t] as const));

  const server = new Server(
    { name: "godot-mcp-pro", version: getServerVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = toolsByName.get(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }

    try {
      // Best-effort: wait briefly for the addon if it's not yet connected.
      if (!bridge.isConnected()) {
        await bridge.waitForConnection(5_000);
      }
      const result = await bridge.call(name, (args ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = formatError(err);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP stdio transport ready");

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down`);
    try {
      await bridge.close();
    } catch (err) {
      log.warn(`Bridge close error: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function formatError(err: unknown): string {
  if (err instanceof GodotError) {
    const data = err.data ? `\n  data: ${JSON.stringify(err.data)}` : "";
    return `Godot error ${err.code}: ${err.message}${data}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

main().catch((err) => {
  log.error(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
