# `server/` — Godot MCP Pro Node.js server

This directory contains the Node.js implementation of the MCP server that
brokers between an MCP-capable AI client (Claude Code, Cursor, VS Code Copilot,
…) and the Godot editor plugin shipped under `addons/godot_mcp/`.

```
AI Assistant ←—stdio/MCP—→ Node.js Server (this folder) ←—WebSocket:6505-6514—→ Godot Editor Plugin
```

The Godot addon is a WebSocket **client** (see
`addons/godot_mcp/websocket_server.gd`) that connects out to ports
`6505-6514`. This server binds the first available port in that range and
speaks JSON-RPC 2.0 with the addon (the same protocol the addon implements
internally).

## Quick start

```bash
cd server
npm install
npm run build
```

Add to your client's MCP config (Claude Code / Cursor / VS Code Copilot / …):

```json
{
  "mcpServers": {
    "godot-mcp-pro": {
      "command": "node",
      "args": ["/abs/path/to/server/build/index.js"],
      "env": { "GODOT_MCP_PORT": "6505" }
    }
  }
}
```

Open a Godot 4 project with the `godot_mcp` plugin enabled. The addon will
auto-connect to the server.

## Modes

```bash
node build/index.js            # full   (default, all 171 tools)
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

The CLI binds to ports `6510-6514` by default (`GODOT_MCP_CLI_PORT_RANGE` to
override).

## Environment variables

| Var | Purpose |
|---|---|
| `GODOT_MCP_PORT` | Force a specific port (else 6505-6509) |
| `GODOT_MCP_PORT_RANGE` | Override port range, e.g. `6505-6509` |
| `GODOT_MCP_TIMEOUT_MS` | Per-request timeout (default 60000) |
| `GODOT_MCP_DEBUG=1` | Verbose stderr logging |
| `GODOT_MCP_CLI_PORT` | Force CLI port |
| `GODOT_MCP_CLI_PORT_RANGE` | CLI port range (default `6510-6514`) |

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
| `src/index.ts` | MCP stdio server entry (`build/index.js`) |
| `src/cli.ts` | Direct CLI (`build/cli.js`) |
| `src/setup.ts` | `node build/setup.js install` helper |
| `src/godot-bridge.ts` | WebSocket server + JSON-RPC bridge to the addon |
| `src/log.ts` | stderr-only logger (stdout is reserved for MCP framing) |
| `src/tools/types.ts` | Shared types |
| `src/tools/modes.ts` | full / 3d / lite / minimal mode filters |
| `src/tools/overrides.ts` | Curated descriptions |
| `src/tools/index.ts` | Final tool list assembly |
| `src/tools/generated.ts` | **Generated** — do not edit |
| `scripts/generate-tools.mjs` | GDScript scanner |
| `scripts/postbuild.mjs` | Marks `build/*.js` executable |
