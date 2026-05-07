// Bridge between the Node.js process and the Godot editor plugin.
//
// The Godot addon (addons/godot_mcp/websocket_server.gd) connects out as a
// WebSocket *client* to ports 6505-6514. This module runs a WebSocket *server*
// on the first available port in a configurable range, accepts one connection
// from the addon, and exposes a simple JSON-RPC 2.0 request/response API plus
// a heartbeat (ping/pong) every HEARTBEAT_INTERVAL_MS.
//
// Default port ranges (matching the addon):
//   MCP mode:  6505-6509
//   CLI mode:  6510-6514
//
// On request:
//   - assigns a unique numeric id
//   - sends `{"jsonrpc":"2.0","id":<n>,"method":<m>,"params":<p>}` to the addon
//   - returns a Promise that resolves with the `result` field, or rejects with
//     a typed `GodotError` containing the JSON-RPC error code/message/data.
//
// If the addon disconnects, in-flight requests are rejected with code -32000
// and new requests are queued (and rejected after a configurable timeout) until
// reconnect.

import { WebSocket, WebSocketServer } from "ws";
import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { log } from "./log.js";

export interface BridgeOptions {
  /** Inclusive port range to try. Default: 6505-6509. */
  portRange?: [number, number];
  /** If set, only try this exact port (overrides portRange). */
  port?: number;
  /** ms between ping/pong probes (0 disables). Default: 10_000. */
  heartbeatIntervalMs?: number;
  /** Default per-request timeout in ms. Default: 60_000. */
  defaultTimeoutMs?: number;
  /** Bind host. Default: 127.0.0.1. */
  host?: string;
}

export class GodotError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "GodotError";
    this.code = code;
    this.data = data;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  timer: NodeJS.Timeout | null;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export class GodotBridge extends EventEmitter {
  private readonly opts: Required<Omit<BridgeOptions, "port">> & { port?: number };
  private httpServer: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private boundPort: number | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: BridgeOptions = {}) {
    super();
    this.opts = {
      portRange: options.portRange ?? [6505, 6509],
      port: options.port,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 60_000,
      host: options.host ?? "127.0.0.1",
    };
  }

  /** Bind to the first available port and start listening. Resolves with the bound port. */
  async start(): Promise<number> {
    const ports = this.opts.port !== undefined
      ? [this.opts.port]
      : range(this.opts.portRange[0], this.opts.portRange[1]);

    let lastErr: Error | null = null;
    for (const p of ports) {
      try {
        await this.bindOn(p);
        this.boundPort = p;
        log.info(`Godot bridge listening on ws://${this.opts.host}:${p}`);
        return p;
      } catch (err) {
        lastErr = err as Error;
        log.debug(`Port ${p} unavailable: ${(err as Error).message}`);
      }
    }
    throw new Error(
      `Could not bind to any port in range ${ports[0]}-${ports[ports.length - 1]}: ${lastErr?.message ?? "unknown error"}`,
    );
  }

  private bindOn(port: number): Promise<void> {
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

      http.listen(port, this.opts.host, () => {
        http.removeListener("error", onError);
        this.httpServer = http;
        this.wsServer = wss;
        wss.on("connection", (sock) => this.handleConnection(sock));
        // After bind, surface later errors as bridge events.
        http.on("error", (e) => log.warn(`HTTP server error on port ${port}: ${e.message}`));
        resolve();
      });
    });
  }

  private handleConnection(socket: WebSocket): void {
    if (this.socket) {
      // Only accept one Godot client at a time per port; close extras.
      log.warn("Rejecting additional Godot connection (already connected)");
      socket.close(1013, "already connected");
      return;
    }
    this.socket = socket;
    log.info(`Godot addon connected on port ${this.boundPort}`);
    this.emit("connect");
    this.startHeartbeat();

    socket.on("message", (data) => this.handleMessage(data.toString()));
    socket.on("close", (code, reason) => {
      log.info(`Godot addon disconnected (${code} ${reason.toString()})`);
      this.cleanupSocket();
      this.emit("disconnect");
    });
    socket.on("error", (err) => {
      log.warn(`Socket error: ${err.message}`);
    });
  }

  private cleanupSocket(): void {
    this.socket = null;
    this.stopHeartbeat();
    // Reject all in-flight requests; the caller can retry.
    for (const [id, req] of this.pending) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(new GodotError(-32000, "Godot disconnected before responding"));
      this.pending.delete(id);
    }
  }

  private startHeartbeat(): void {
    if (this.opts.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket) return;
      try {
        this.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "ping", params: {} }));
      } catch (err) {
        log.warn(`Heartbeat send failed: ${(err as Error).message}`);
      }
    }, this.opts.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleMessage(text: string): void {
    let msg: JsonRpcResponse | JsonRpcNotification;
    try {
      msg = JSON.parse(text);
    } catch {
      log.warn(`Received non-JSON from addon: ${text.slice(0, 200)}`);
      return;
    }

    // Notifications (ping/pong) carry no id; requests/responses do.
    if (!("id" in msg) || (msg as JsonRpcResponse).id === null || (msg as JsonRpcResponse).id === undefined) {
      const note = msg as JsonRpcNotification;
      if (note.method === "pong" || note.method === "ping") {
        // Heartbeat — addon sometimes initiates ping; reply with pong.
        if (note.method === "ping" && this.socket) {
          try {
            this.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "pong", params: {} }));
          } catch {
            /* ignore */
          }
        }
        return;
      }
      this.emit("notification", note);
      return;
    }

    const resp = msg as JsonRpcResponse;
    const id = typeof resp.id === "number" ? resp.id : Number.parseInt(String(resp.id), 10);
    const pending = this.pending.get(id);
    if (!pending) {
      log.debug(`Ignoring response with unknown id ${resp.id}`);
      return;
    }
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);

    if (resp.error) {
      pending.reject(new GodotError(resp.error.code, resp.error.message, resp.error.data));
    } else {
      pending.resolve(resp.result ?? {});
    }
  }

  /** Whether a Godot addon is currently connected. */
  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /** Wait until a Godot addon connects, or reject after `timeoutMs`. */
  waitForConnection(timeoutMs = 30_000): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("connect", onConnect);
        reject(
          new GodotError(
            -32000,
            `Timed out waiting for Godot addon to connect on port ${this.boundPort ?? "?"}. ` +
              "Make sure the Godot editor is running with the godot_mcp plugin enabled.",
          ),
        );
      }, timeoutMs);
      const onConnect = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once("connect", onConnect);
    });
  }

  /** Send a JSON-RPC method call to the addon and await the result. */
  call(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new GodotError(-32000, "Bridge is closed"));
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new GodotError(
          -32000,
          "Godot addon is not connected. Open the editor with the godot_mcp plugin enabled.",
        ),
      );
    }

    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const effectiveTimeout = timeoutMs ?? this.opts.defaultTimeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      const timer =
        effectiveTimeout > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new GodotError(-32000, `Request timed out after ${effectiveTimeout}ms: ${method}`));
            }, effectiveTimeout)
          : null;
      this.pending.set(id, { resolve, reject, method, timer });

      try {
        this.socket!.send(JSON.stringify(req));
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new GodotError(-32000, `Failed to send request: ${(err as Error).message}`));
      }
    });
  }

  /** Stop listening and close the connection. */
  async close(): Promise<void> {
    this.closed = true;
    this.stopHeartbeat();
    if (this.socket) {
      try {
        this.socket.close(1000, "server shutting down");
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    for (const [id, req] of this.pending) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(new GodotError(-32000, "Bridge closed"));
      this.pending.delete(id);
    }
    if (this.wsServer) {
      await new Promise<void>((res) => this.wsServer!.close(() => res()));
      this.wsServer = null;
    }
    if (this.httpServer) {
      await new Promise<void>((res) => this.httpServer!.close(() => res()));
      this.httpServer = null;
    }
  }

  /** The port we bound to (after start()). */
  port(): number | null {
    return this.boundPort;
  }
}

function range(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}
