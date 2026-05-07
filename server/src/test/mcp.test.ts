// MCP stdio protocol integration test.
//
// Spawns `node build/index.js`, exchanges MCP JSON-RPC messages over stdio,
// and verifies the server advertises a non-empty tool list.
//
// Run:
//   node --test build/test/mcp.test.js

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Works from both src/test/ (dev) and build/test/ (compiled):
// src/test  + ../../build/index.js → server/build/index.js
// build/test + ../../build/index.js → server/build/index.js
const INDEX = resolve(HERE, "../../build/index.js");

// ── helpers ──────────────────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** Spawn the MCP stdio process and return a thin helper.
 *  `timeoutMs` sets GODOT_MCP_TIMEOUT_MS so tool calls fail fast when Godot
 *  is not connected (the Go daemon gives up after 5 s regardless; this just
 *  caps the RpcClient-side wait so the test doesn't stall for 60 s). */
function spawnMcp(args: string[] = [], timeoutMs = 8_000) {
  const proc = spawn(process.execPath, [INDEX, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GODOT_MCP_DEBUG: "",
      GODOT_MCP_TIMEOUT_MS: String(timeoutMs),
    },
  });

  const rl = createInterface({ input: proc.stdout! });
  // id → resolver for in-flight requests
  const pending = new Map<number | string, (msg: JsonRpcResponse) => void>();
  // queue for recv() calls without a specific id
  const inbox: JsonRpcResponse[] = [];
  const waiters: Array<(msg: JsonRpcResponse) => void> = [];

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (msg.id === undefined || msg.id === null) return; // skip notifications
      // Wake a specific waiter registered via recvById, or fall back to queue.
      const specific = pending.get(msg.id);
      if (specific) {
        pending.delete(msg.id);
        specific(msg);
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else inbox.push(msg);
    } catch {
      // ignore non-JSON stderr bleed-through
    }
  });

  let nextId = 1;

  /** Send a request and return its assigned id. */
  function send(method: string, params: unknown = {}): number {
    const id = nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    proc.stdin!.write(JSON.stringify(msg) + "\n");
    return id;
  }

  function sendNotify(method: string, params: unknown = {}) {
    const msg = { jsonrpc: "2.0", method, params };
    proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  /** Wait for any next response (FIFO). */
  function recv(waitMs = 10_000): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const queued = inbox.shift();
      if (queued) return resolve(queued);
      const timer = setTimeout(() => reject(new Error("recv timeout")), waitMs);
      waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
    });
  }

  /** Wait for the response with a specific id (id returned by send). */
  function recvById(id: number, waitMs = 12_000): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`recvById(${id}) timeout after ${waitMs} ms`));
      }, waitMs);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    });
  }

  function close() {
    proc.stdin!.end();
    proc.kill();
  }

  return { send, sendNotify, recv, recvById, close };
}

// ── shared MCP session for multi-tool tests ───────────────────────────────────

/** Do the MCP initialize handshake.
 *  Uses recvById to avoid FIFO race conditions with other responses. */
async function initSession(mcp: ReturnType<typeof spawnMcp>) {
  const id = mcp.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  });
  await mcp.recvById(id, 15_000);
  mcp.sendNotify("notifications/initialized");
}

/**
 * Assert a tools/call MCP response has valid structure and its content is
 * either a JSON-parseable success or a known connection-error string.
 *
 * Returns `true` when Godot responded successfully, `false` when it was a
 * known bridge/timeout error, and throws on unexpected failures.
 */
function assertToolResult(
  toolName: string,
  res: JsonRpcResponse,
  elapsed: number,
): boolean {
  assert.equal(
    res.error, undefined,
    `[${toolName}] Unexpected JSON-RPC error: ${JSON.stringify(res.error)}`,
  );
  const result = res.result as McpToolResult;
  assert.ok(Array.isArray(result.content), `[${toolName}] content not an array`);
  assert.ok(result.content.length > 0, `[${toolName}] content is empty`);
  assert.equal(result.content[0].type, "text", `[${toolName}] content[0] not text`);

  if (result.isError) {
    const text = result.content[0].text;
    const isKnownError =
      text.includes("Timed out waiting for Godot") ||
      text.includes("not connected") ||
      text.includes("Request timed out") ||
      text.includes("Server error");
    assert.ok(isKnownError, `[${toolName}] unexpected error text: ${text}`);
    // Must fail within 13 s — regression guard against the original 60 s stall.
    assert.ok(
      elapsed < 13_000,
      `[${toolName}] took ${elapsed} ms — timeout not applied (60 s stall regression?)`,
    );
    return false; // known error
  }
  // Success: result must be valid JSON.
  assert.doesNotThrow(
    () => JSON.parse(result.content[0].text),
    `[${toolName}] result is not valid JSON`,
  );
  return true;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("MCP stdio protocol", () => {
  test("initialize handshake", async () => {
    const mcp = spawnMcp();
    try {
      const id = mcp.send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      });
      const res = await mcp.recvById(id);
      assert.equal(res.error, undefined, `initialize error: ${JSON.stringify(res.error)}`);
      const result = res.result as Record<string, unknown>;
      assert.ok(result.serverInfo, "serverInfo missing");
      assert.ok(result.protocolVersion, "protocolVersion missing");
    } finally {
      mcp.close();
    }
  });

  test("tools/list returns non-empty list", async () => {
    const mcp = spawnMcp();
    try {
      await initSession(mcp);
      const id = mcp.send("tools/list");
      const res = await mcp.recvById(id);
      assert.equal(res.error, undefined, `tools/list error: ${JSON.stringify(res.error)}`);
      const tools = (res.result as { tools: unknown[] }).tools;
      assert.ok(Array.isArray(tools), "tools is not an array");
      assert.ok(tools.length > 0, "tools list is empty");
    } finally {
      mcp.close();
    }
  });

  test("tools/list --lite returns fewer tools than --full", async () => {
    const full = spawnMcp(["--full"]);
    const lite = spawnMcp(["--lite"]);
    try {
      async function listTools(mcp: ReturnType<typeof spawnMcp>) {
        await initSession(mcp);
        const id = mcp.send("tools/list");
        const res = await mcp.recvById(id);
        return (res.result as { tools: unknown[] }).tools;
      }
      const [fullTools, liteTools] = await Promise.all([listTools(full), listTools(lite)]);
      assert.ok(liteTools.length < fullTools.length,
        `expected lite (${liteTools.length}) < full (${fullTools.length})`);
    } finally {
      full.close();
      lite.close();
    }
  });

  test("tools/call get_project_info responds within 15 s", async () => {
    // Background: when calling a tool the index.js RpcClient forwards the request
    // to the Go daemon (WS:6520), which in turn forwards it to the Godot addon.
    //
    // Two expected fast-fail paths:
    //   A. Godot NOT connected → daemon's WaitForConnection expires after 5 s and
    //      returns "Timed out waiting for Godot addon to connect".
    //   B. Godot IS connected but unresponsive → daemon forwards the request;
    //      the RpcClient inside index.js times out after GODOT_MCP_TIMEOUT_MS (8 s
    //      in this test) and returns "Request timed out after 8000ms: call_tool".
    //
    // In production with the default GODOT_MCP_TIMEOUT_MS=60000 this produced
    // "Server error -32000: Request timed out after 60000ms: call_tool" — a 60 s
    // stall. The 8 s timeout below keeps tests fast while catching regressions.
    const mcp = spawnMcp();   // GODOT_MCP_TIMEOUT_MS=8000
    try {
      await initSession(mcp);

      // call the tool (no required params)
      const callStart = Date.now();
      const id = mcp.send("tools/call", { name: "get_project_info", arguments: {} });

      // Allow up to 14 s (8 s RpcClient + 5 s bridge WaitForConnection + 1 s margin).
      const res = await mcp.recvById(id, 14_000);
      const elapsed = Date.now() - callStart;

      const gotResult = assertToolResult("get_project_info", res, elapsed);

      if (!gotResult) {
        const text = (res.result as McpToolResult).content[0].text;
        // Path A: must complete within 7 s (5 s bridge wait + margin).
        const isNoGodot =
          text.includes("Timed out waiting for Godot") || text.includes("not connected");
        if (isNoGodot) {
          assert.ok(elapsed < 7_000,
            `WaitForConnection path took ${elapsed} ms — expected < 7000`);
        }
      }
    } finally {
      mcp.close();
    }
  });

  describe("read-only tools", () => {
    // These tools are all purely read-only (no side effects) and have no
    // required parameters. They are called concurrently from a single MCP
    // session to keep the overall suite runtime bounded.
    //
    // Each tool is asserted to either:
    //   • return valid JSON (Godot connected & responsive), or
    //   • return a known connection/timeout error within 13 s.

    const READ_ONLY_TOOLS: Array<{ name: string; args?: Record<string, unknown> }> = [
      { name: "get_project_info" },
      { name: "get_filesystem_tree",   args: { path: "res://", max_depth: 2 } },
      { name: "get_project_settings",  args: { section: "" } },
      { name: "get_scene_tree",        args: { max_depth: 3 } },
      { name: "get_editor_errors",     args: { max_lines: 20 } },
      { name: "get_output_log",        args: { max_lines: 20 } },
      { name: "get_editor_performance" },
      { name: "list_scripts",          args: { path: "res://", recursive: false } },
      { name: "get_editor_camera" },
    ];

    test("all read-only tools respond and return valid structure", async () => {
      // GODOT_MCP_TIMEOUT_MS=8000 — caps each per-tool wait to 8 s.
      // All requests are dispatched concurrently so total wall time ≈ 8 s
      // regardless of tool count (MCP SDK may serialize them internally, but
      // the daemon should pipeline them via separate goroutines).
      const mcp = spawnMcp();
      try {
        await initSession(mcp);

        const start = Date.now();

        // Dispatch all tool calls simultaneously, collecting their ids.
        const calls = READ_ONLY_TOOLS.map(({ name, args }) => {
          const id = mcp.send("tools/call", { name, arguments: args ?? {} });
          return { name, id, sentAt: Date.now() };
        });

        // Collect responses by id (order-independent).
        const results = await Promise.all(
          calls.map(({ name, id, sentAt }) =>
            mcp.recvById(id, 14_000).then((res) => ({
              name,
              res,
              elapsed: Date.now() - sentAt,
            })),
          ),
        );

        const wall = Date.now() - start;

        // Assert each result individually so failures name the tool.
        // Also spot-check get_project_info fields when Godot is connected
        // (reuses this same session — avoids spawning an extra process).
        for (const { name, res, elapsed } of results) {
          const isSuccess = assertToolResult(name, res, elapsed);
          if (name === "get_project_info" && isSuccess) {
            const data = JSON.parse(
              (res.result as McpToolResult).content[0].text,
            ) as Record<string, unknown>;
            const hasKnownField =
              "name" in data || "godot_version" in data || "project_name" in data ||
              "version" in data || "path" in data;
            assert.ok(
              hasKnownField,
              `get_project_info missing expected fields: ${JSON.stringify(Object.keys(data))}`,
            );
          }
        }

        // Sanity: total wall time should be well under 80 s.
        assert.ok(wall < 80_000, `All tools took ${wall} ms — possible serialization issue`);

      } finally {
        mcp.close();
      }
    });
  });
});
