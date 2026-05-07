// stderr-only logger.
//
// In MCP stdio mode, stdout is reserved for the JSON-RPC framing — anything
// written to stdout corrupts the protocol. We always log to stderr.

type Level = "debug" | "info" | "warn" | "error";

const ENABLED: Record<Level, boolean> = {
  debug: process.env.GODOT_MCP_DEBUG === "1" || process.env.GODOT_MCP_DEBUG === "true",
  info: true,
  warn: true,
  error: true,
};

function fmt(level: Level, args: unknown[]): string {
  const ts = new Date().toISOString();
  const parts = args.map((a) => (typeof a === "string" ? a : safeStringify(a)));
  return `[${ts}] [${level.toUpperCase()}] ${parts.join(" ")}`;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug(...args: unknown[]): void {
    if (ENABLED.debug) process.stderr.write(fmt("debug", args) + "\n");
  },
  info(...args: unknown[]): void {
    if (ENABLED.info) process.stderr.write(fmt("info", args) + "\n");
  },
  warn(...args: unknown[]): void {
    if (ENABLED.warn) process.stderr.write(fmt("warn", args) + "\n");
  },
  error(...args: unknown[]): void {
    if (ENABLED.error) process.stderr.write(fmt("error", args) + "\n");
  },
};
