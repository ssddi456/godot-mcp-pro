# `server/` — Godot MCP Pro Node.js server

This directory contains the Node.js implementation for Godot MCP Pro.

The runtime is split into two layers:

1. A long-running Node.js daemon (`build/server.js`) that stays connected to
   the Godot editor plugin over WebSocket and owns all addon state.
2. Short-lived stdio/CLI clients (`build/index.js`, `build/cli.js`) that talk
   to the daemon over a local WebSocket. They read data or submit commands; the
   daemon forwards tool calls to the addon for execution.

```
AI Assistant ←—stdio/MCP—→ build/index.js ←—WebSocket:6520—→ build/server.js ←—WebSocket:6505-6509—→ Godot Editor Plugin
Terminal     ←—CLI args———→ build/cli.js   ←—WebSocket:6520—→ build/server.js ←—WebSocket:6505-6509—→ Godot Editor Plugin
```

The Godot addon is a WebSocket **client** (see
`addons/godot_mcp/websocket_server.gd`) that connects out to ports
`6505-6514`. The daemon binds the first available addon port in `6505-6509` and
speaks JSON-RPC 2.0 with the addon. stdio/CLI clients connect only to the
daemon (default `ws://127.0.0.1:6520`).

## Quick start

```bash
cd server
npm install
npm run build
```

Start the daemon and keep it running. You can use either the Node daemon
in this folder or the Go daemon under [`../server-go`](../server-go) — both
implement the same WebSocket JSON-RPC API on port `6520`:

```bash
# Node daemon
node build/server.js

# Or the Go daemon (see ../server-go/README.md)
../server-go/godot-mcp-pro-server
```

Add to your client's MCP config (Claude Code / Cursor / VS Code Copilot / …):

```json
{
  "mcpServers": {
    "godot-mcp-pro": {
      "command": "node",
      "args": ["/abs/path/to/server/build/index.js"],
      "env": { "GODOT_MCP_SERVER_PORT": "6520" }
    }
  }
}
```

Open a Godot 4 project with the `godot_mcp` plugin enabled. The addon will
auto-connect to the server.

## Modes

```bash
node build/index.js            # full   (default, all tools)
node build/index.js --3d       # drop 2D-only categories
node build/index.js --lite     # 8 essential categories
node build/index.js --minimal  # ~35 hand-picked tools
```

## CLI

For clients without MCP support, or to drive Godot from a shell:

```bash
node build/cli.js --help
node build/cli.js project info
node build/cli.js scene play --mode main
node build/cli.js node add --type CharacterBody3D --name Player --parent-path .
node build/cli.js call get_scene_tree --params '{}'
```

The CLI connects to the daemon; it does not bind any addon port or talk to
Godot directly.

## Environment variables

| Var | Purpose |
|---|---|
| `GODOT_MCP_SERVER_URL` | stdio/CLI client URL for the daemon, e.g. `ws://127.0.0.1:6520` |
| `GODOT_MCP_SERVER_HOST` | Daemon bind host and client default host (default `127.0.0.1`) |
| `GODOT_MCP_SERVER_PORT` | Daemon client WebSocket port (default `6520`) |
| `GODOT_MCP_PORT` | Force daemon's Godot addon port (else 6505-6509) |
| `GODOT_MCP_PORT_RANGE` | Override daemon's addon port range, e.g. `6505-6509` |
| `GODOT_MCP_TIMEOUT_MS` | stdio client per-request timeout (default 60000) |
| `GODOT_MCP_DEBUG=1` | Verbose stderr logging |

## How tools are defined

Tool metadata is **auto-generated** from the GDScript addon source at build
time:

* `scripts/generate-tools.mjs` scans `addons/godot_mcp/commands/*.gd`,
  pulls method names from each `get_commands()` Dictionary, and walks each
  handler body to discover `require_*` / `optional_*` parameter usage.
* The result is written to `src/tools/generated.ts`.
* `src/tools/overrides.ts` holds curated descriptions and any schema
  refinements that aren't expressible in GDScript.
* `src/tools/index.ts` merges the two sources into the final tool list and
  applies mode filtering (`full`/`3d`/`lite`/`minimal`).

To refresh after editing addon code:

```bash
npm run generate    # regenerate src/tools/generated.ts
npm run build       # then rebuild
```

## Files

| File | Role |
|---|---|
| `src/server.ts` | Long-running daemon (`build/server.js`) |
| `src/index.ts` | MCP stdio client entry (`build/index.js`) |
| `src/cli.ts` | Direct CLI client (`build/cli.js`) |
| `src/setup.ts` | `node build/setup.js install` helper |
| `src/godot-bridge.ts` | Daemon-side WebSocket server + JSON-RPC bridge to the addon |
| `src/rpc-client.ts` | stdio/CLI JSON-RPC WebSocket client for the daemon |
| `src/log.ts` | stderr-only logger (stdout is reserved for MCP framing) |
| `src/tools/types.ts` | Shared types |
| `src/tools/modes.ts` | full / 3d / lite / minimal mode filters |
| `src/tools/overrides.ts` | Curated descriptions |
| `src/tools/index.ts` | Final tool list assembly |
| `src/tools/generated.ts` | **Generated** — do not edit |
| `scripts/generate-tools.mjs` | GDScript scanner |
| `scripts/postbuild.mjs` | Marks `build/*.js` executable |
