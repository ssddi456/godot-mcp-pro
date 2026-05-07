# `server-go/` — Godot MCP Pro daemon (Go implementation)

This directory contains a Go rewrite of the long-running Godot MCP Pro daemon.
The runtime architecture is identical to the Node implementation under
[`../server`](../server):

```
AI Assistant ←—stdio/MCP—→ ../server/build/index.js ←—WS:6520—→ server-go/godot-mcp-pro-server ←—WS:6505-6509—→ Godot Editor Plugin
Terminal     ←—CLI args———→ ../server/build/cli.js   ←—WS:6520—→ server-go/godot-mcp-pro-server ←—WS:6505-6509—→ Godot Editor Plugin
```

Either daemon (`node ../server/build/server.js` or `./godot-mcp-pro-server`)
can be used; the stdio/CLI Node clients in `../server` connect to whichever is
running.

## Build

```bash
cd server-go
go build -o godot-mcp-pro-server ./cmd/godot-mcp-pro-server
```

The tool catalog is embedded into the binary at compile time from
`internal/tools/tools.json`. That file is written by the Node build pipeline
(`../server/scripts/postbuild.mjs`); regenerate it whenever Godot addon
commands change:

```bash
cd ../server
npm run build       # also writes server-go/internal/tools/tools.json
cd ../server-go
go build ./...
```

## Run

```bash
./godot-mcp-pro-server
```

Configure with flags or environment variables (the env vars match the Node
daemon, so existing setups keep working):

| Flag | Env | Default | Purpose |
|---|---|---|---|
| `--host` | `GODOT_MCP_SERVER_HOST` | `127.0.0.1` | Bind host for both ports |
| `--port` | `GODOT_MCP_SERVER_PORT` | `6520` | Local stdio/CLI client port |
| `--godot-port` | `GODOT_MCP_PORT` | unset | Force a specific addon port |
| `--godot-port-range` | `GODOT_MCP_PORT_RANGE` | `6505-6509` | Addon port range |
| `--timeout-ms` | `GODOT_MCP_TIMEOUT_MS` | `60000` | Per-request timeout |
| (n/a) | `GODOT_MCP_DEBUG=1` | off | Verbose stderr logging |

## Client RPC API

The daemon exposes a JSON-RPC 2.0 WebSocket API on `ws://127.0.0.1:6520`:

- `status` → `{ godotConnected, godotPort, tools }`
- `list_tools { mode? }` → `{ tools: ResolvedTool[] }`
  - `mode` ∈ `full` (default) | `3d` | `lite` | `minimal`
- `call_tool { name, arguments? }` → forwarded to the addon, returns the
  addon's `result` (or the addon's JSON-RPC error)

Heartbeats use `ping` notifications with `pong` replies.

## Layout

| Path | Role |
|---|---|
| `cmd/godot-mcp-pro-server/main.go` | CLI entry point |
| `internal/bridge/bridge.go` | Godot addon WebSocket server (port 6505-6509), JSON-RPC client to addon |
| `internal/daemon/daemon.go` | Local WebSocket JSON-RPC server (port 6520) for stdio/CLI clients |
| `internal/tools/tools.go` | Loader for the embedded tool catalog |
| `internal/tools/tools.json` | **Generated** — written by the Node `npm run build` step |
| `internal/jsonrpc/jsonrpc.go` | Shared JSON-RPC 2.0 types |
| `internal/logger/logger.go` | stderr logger (matches the Node logger format) |
