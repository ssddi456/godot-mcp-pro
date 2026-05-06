#!/usr/bin/env node
// Long-running Godot MCP Pro daemon.
//
// This process owns the durable connection to the Godot addon and exposes a
// local WebSocket JSON-RPC API for stdio MCP/CLI clients:
//
//   Godot addon <--ws:6505-6509--> this daemon <--ws:6520--> stdio MCP / CLI
//
// Client RPC methods:
//   - status
//   - list_tools { mode? }
//   - call_tool { name, arguments? }

import { createServer, type Server as HttpServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { GodotBridge, GodotError } from "./godot-bridge.js";
import { log } from "./log.js";
import { getAllToolsByName, getToolsForMode } from "./tools/index.js";
import type { Mode } from "./tools/types.js";

interface ServerOptions {
  host: string;
  clientPort: number;
  godotPort?: number;
  godotPortRange?: [number, number];
}

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

function parseOptions(argv: string[]): ServerOptions {
  let host = process.env.GODOT_MCP_SERVER_HOST ?? "127.0.0.1";
  let clientPort = Number.parseInt(process.env.GODOT_MCP_SERVER_PORT ?? "6520", 10);
  let godotPort: number | undefined;
  let godotPortRange: [number, number] | undefined;

  const single = process.env.GODOT_MCP_PORT;
  if (single) {
    const n = Number.parseInt(single, 10);
    if (Number.isFinite(n)) godotPort = n;
  }
  const range = process.env.GODOT_MCP_PORT_RANGE;
  if (range) {
    const m = range.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) godotPortRange = [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10)];
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--host" || arg === "-H") && next) {
      host = next;
      i++;
    } else if ((arg === "--port" || arg === "-p") && next) {
      clientPort = Number.parseInt(next, 10);
      i++;
    } else if (arg === "--godot-port" && next) {
      godotPort = Number.parseInt(next, 10);
      i++;
    } else if (arg === "--godot-port-range" && next) {
      const m = next.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) godotPortRange = [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10)];
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return { host, clientPort, godotPort, godotPortRange };
}

function printHelp(): void {
  process.stdout.write(
    [
      "godot-mcp-pro-server — long-running daemon",
      "",
      "Usage: node build/server.js [--host 127.0.0.1] [--port 6520] [--godot-port 6505]",
      "",
      "Env:",
      "  GODOT_MCP_SERVER_HOST=127.0.0.1",
      "  GODOT_MCP_SERVER_PORT=6520",
      "  GODOT_MCP_PORT=6505",
      "  GODOT_MCP_PORT_RANGE=6505-6509",
      "",
    ].join("\n"),
  );
}

class Daemon {
  private readonly options: ServerOptions;
  private readonly bridge: GodotBridge;
  private readonly toolsByName = getAllToolsByName();
  private httpServer: HttpServer | null = null;
  private wsServer: WebSocketServer | null = null;

  constructor(options: ServerOptions) {
    this.options = options;
    this.bridge = new GodotBridge({
      port: options.godotPort,
      portRange: options.godotPortRange,
    });
  }

  async start(): Promise<void> {
    await this.bridge.start();
    await this.startClientServer();
    log.info(
      `Daemon ready: addon ws port=${this.bridge.port()}, client ws=ws://${this.options.host}:${this.options.clientPort}`,
    );
  }

  private startClientServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const http = createServer();
      const wss = new WebSocketServer({ server: http, maxPayload: 16 * 1024 * 1024 });

      const onError = (err: Error) => {
        http.removeListener("error", onError);
        wss.close();
        http.close();
        reject(err);
      };

      http.once("error", onError);
      http.listen(this.options.clientPort, this.options.host, () => {
        http.removeListener("error", onError);
        this.httpServer = http;
        this.wsServer = wss;
        wss.on("connection", (socket) => this.handleClient(socket));
        resolve();
      });
    });
  }

  private handleClient(socket: WebSocket): void {
    log.debug("stdio/CLI client connected");
    socket.on("message", (data) => {
      void this.handleClientMessage(socket, data.toString());
    });
    socket.on("close", () => log.debug("stdio/CLI client disconnected"));
  }

  private async handleClientMessage(socket: WebSocket, text: string): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(text);
    } catch {
      this.send(socket, null, undefined, { code: -32700, message: "Parse error" });
      return;
    }

    if (req.method === "ping") {
      this.sendNotification(socket, "pong", {});
      return;
    }

    if (req.id === undefined || req.id === null || typeof req.method !== "string") {
      this.send(socket, req.id ?? null, undefined, { code: -32600, message: "Invalid request" });
      return;
    }

    try {
      const result = await this.dispatch(req.method, req.params);
      this.send(socket, req.id, result);
    } catch (err) {
      if (err instanceof GodotError) {
        this.send(socket, req.id, undefined, { code: err.code, message: err.message, data: err.data });
      } else {
        this.send(socket, req.id, undefined, {
          code: err instanceof RpcDispatchError ? err.code : -32603,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    const p = isRecord(params) ? params : {};
    switch (method) {
      case "status":
        return {
          godotConnected: this.bridge.isConnected(),
          godotPort: this.bridge.port(),
          tools: this.toolsByName.size,
        };
      case "list_tools": {
        const mode = parseMode(typeof p.mode === "string" ? p.mode : "full");
        return { tools: getToolsForMode(mode) };
      }
      case "call_tool": {
        const name = typeof p.name === "string" ? p.name : "";
        if (!name) throw new RpcDispatchError(-32602, "Missing required parameter: name");
        if (!this.toolsByName.has(name)) throw new RpcDispatchError(-32601, `Unknown tool: ${name}`);
        const args = isRecord(p.arguments) ? p.arguments : {};
        if (!this.bridge.isConnected()) {
          await this.bridge.waitForConnection(5_000);
        }
        return await this.bridge.call(name, args);
      }
      default:
        throw new RpcDispatchError(-32601, `Unknown daemon method: ${method}`);
    }
  }

  private send(
    socket: WebSocket,
    id: number | string | null,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown },
  ): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id };
    if (error) payload.error = error;
    else payload.result = result ?? {};
    socket.send(JSON.stringify(payload));
  }

  private sendNotification(socket: WebSocket, method: string, params: Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async close(): Promise<void> {
    if (this.wsServer) {
      await new Promise<void>((resolve) => this.wsServer!.close(() => resolve()));
      this.wsServer = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
    await this.bridge.close();
  }
}

class RpcDispatchError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcDispatchError";
    this.code = code;
  }
}

function parseMode(raw: string): Mode {
  if (raw === "3d" || raw === "lite" || raw === "minimal" || raw === "full") return raw;
  return "full";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const daemon = new Daemon(parseOptions(process.argv.slice(2)));
  await daemon.start();

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down daemon`);
    await daemon.close().catch((err) => log.warn(`Daemon close error: ${(err as Error).message}`));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
