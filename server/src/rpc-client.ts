// JSON-RPC 2.0 WebSocket client used by the stdio MCP process and direct CLI.
//
// In the daemon architecture, these short-lived processes never talk to the
// Godot addon directly. They connect to the long-running Node.js server over a
// local WebSocket and ask it to list tools, report status, or forward a tool
// call to the addon.

import WebSocket from "ws";

export interface RpcClientOptions {
  url?: string;
  host?: string;
  port?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export class RpcClient {
  private readonly url: string;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(options: RpcClientOptions = {}) {
    const port = options.port ?? Number.parseInt(process.env.GODOT_MCP_SERVER_PORT ?? "6520", 10);
    const host = options.host ?? process.env.GODOT_MCP_SERVER_HOST ?? "127.0.0.1";
    this.url = options.url ?? process.env.GODOT_MCP_SERVER_URL ?? `ws://${host}:${port}`;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url, { maxPayload: 16 * 1024 * 1024 });
      const timer = setTimeout(() => {
        socket.close();
        reject(new RpcError(-32000, `Timed out connecting to Node.js server at ${this.url}`));
      }, this.connectTimeoutMs);

      socket.once("open", () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.on("message", (data) => this.handleMessage(data.toString()));
        socket.on("close", () => this.handleClose());
        socket.on("error", (err) => this.rejectAll(new RpcError(-32000, err.message)));
        resolve();
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(
          new RpcError(
            -32000,
            `Could not connect to Node.js server at ${this.url}: ${err.message}. Start it with \`node build/server.js\`.`,
          ),
        );
      });
    });
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    await this.connect();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new RpcError(-32000, "Node.js server connection is not open");
    }

    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        effectiveTimeout > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new RpcError(-32000, `Request timed out after ${effectiveTimeout}ms: ${method}`));
            }, effectiveTimeout)
          : null;

      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (err) => {
        if (!err) return;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new RpcError(-32000, `Failed to send request to Node.js server: ${err.message}`));
      });
    });
  }

  close(): void {
    if (this.socket) {
      this.socket.close(1000, "client shutting down");
      this.socket = null;
    }
    this.rejectAll(new RpcError(-32000, "Client closed"));
  }

  private handleMessage(text: string): void {
    let msg: { id?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    } else {
      pending.resolve(msg.result ?? {});
    }
  }

  private handleClose(): void {
    this.socket = null;
    this.rejectAll(new RpcError(-32000, "Node.js server connection closed"));
  }

  private rejectAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}

