#!/usr/bin/env node
// Optional `node build/setup.js install` helper referenced in the README.
//
// At the moment this is a no-op aside from a friendly message — `npm install`
// + `npm run build` already does the work. We keep it so the documented
// command exists.

import { argv, stdout, exit } from "node:process";

const cmd = argv[2] ?? "help";
switch (cmd) {
  case "install":
    stdout.write(
      [
        "godot-mcp-pro setup",
        "",
        "Nothing to do — running `npm install` followed by `npm run build` is",
        "all that's required. Once built, start the long-running daemon with",
        "  node build/server.js",
        "then point your MCP-capable client at",
        "  node build/index.js",
        "in this folder. See the project README for details.",
        "",
      ].join("\n"),
    );
    break;
  case "help":
  default:
    stdout.write("Usage: node build/setup.js install\n");
    exit(cmd === "help" ? 0 : 2);
}
