#!/usr/bin/env node
// Godot MCP Pro stdio entry point.
//
// New daemon architecture:
//   Godot addon <--ws:6505-6509--> node build/server.js <--ws:6520--> this stdio process
//
// This process only speaks MCP over stdio to the AI client and forwards all
// data/commands to the long-running Node.js server over WebSocket.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";
import { RpcClient, RpcError } from "./rpc-client.js";
import type { Mode, ResolvedTool } from "./tools/types.js";

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
      // ignore unknown args for client compatibility
    }
  }
  return { mode };
}

function printHelp(): void {
  process.stderr.write(
    [
      "godot-mcp-pro — MCP stdio client for the long-running Godot MCP Pro server",
      "",
      "Usage: node build/index.js [--full|--3d|--lite|--minimal]",
      "",
      "Start the daemon first:",
      "  node build/server.js",
      "",
      "Modes:",
      "  --full      All tools (default)",
      "  --3d        3D-focused set",
      "  --lite      Essential 8 categories",
      "  --minimal   ~35 hand-picked essential tools",
      "",
      "Env:",
      "  GODOT_MCP_SERVER_URL=ws://127.0.0.1:6520",
      "  GODOT_MCP_SERVER_HOST=127.0.0.1",
      "  GODOT_MCP_SERVER_PORT=6520",
      "  GODOT_MCP_TIMEOUT_MS=60000",
      "  GODOT_MCP_DEBUG=1",
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

async function main(): Promise<void> {
  const { mode } = parseArgs(process.argv.slice(2));
  const timeoutMs = Number.parseInt(process.env.GODOT_MCP_TIMEOUT_MS ?? "", 10);
  const rpc = new RpcClient({
    requestTimeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  });

  await rpc.connect();
  log.info(`Connected MCP stdio process to Node.js server (mode=${mode})`);

  let cachedTools: ResolvedTool[] | null = null;
  const loadTools = async (): Promise<ResolvedTool[]> => {
    const result = await rpc.call("list_tools", { mode });
    if (isToolList(result)) {
      cachedTools = result.tools;
      return result.tools;
    }
    throw new RpcError(-32603, "Node.js server returned invalid tool list");
  };

  const server = new Server(
    { name: "godot-mcp-pro", version: getServerVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await loadTools();
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      if (cachedTools && !cachedTools.some((t) => t.name === name)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool in active mode (${mode}): ${name}` }],
        };
      }
      const result = await rpc.call("call_tool", {
        name,
        arguments: (args ?? {}) as Record<string, unknown>,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: formatError(err) }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP stdio transport ready");

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down stdio process`);
    rpc.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function isToolList(value: unknown): value is { tools: ResolvedTool[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { tools?: unknown }).tools)
  );
}

function formatError(err: unknown): string {
  if (err instanceof RpcError) {
    const data = err.data ? `\n  data: ${JSON.stringify(err.data)}` : "";
    return `Server error ${err.code}: ${err.message}${data}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

main().catch((err) => {
  log.error(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});

