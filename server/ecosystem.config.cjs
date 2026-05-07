// PM2 ecosystem config for Godot MCP Pro daemon (Go implementation).
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 reload ecosystem.config.cjs   (zero-downtime reload)
//   pm2 stop godot-mcp-pro
//   pm2 delete godot-mcp-pro

const path = require("path");

module.exports = {
  apps: [
    {
      name: "godot-mcp-pro",
      script: path.join(__dirname, "../server-go/godot-mcp-pro-server.exe"),
      // Go binary — no Node/Bun interpreter needed
      interpreter: "none",
      cwd: path.join(__dirname, "../server-go"),

      // Automatically restart on crash
      autorestart: true,
      // Max restarts within watch_delay window before marking as errored
      max_restarts: 10,
      // Wait 3 s before restarting
      restart_delay: 3000,

      // Environment variables
      env: {
        // Port the daemon listens on for stdio/CLI clients (default 6520)
        // GODOT_MCP_SERVER_PORT: "6520",
        // Godot addon WebSocket port range (default 6505-6509)
        // GODOT_MCP_PORT_RANGE: "6505-6509",
        // GODOT_MCP_DEBUG: "1",
      },

      // Log settings
      out_file: path.join(__dirname, "logs/server-out.log"),
      error_file: path.join(__dirname, "logs/server-error.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,

      // Kill timeout before forcing SIGKILL (ms)
      kill_timeout: 5000,
    },
  ],
};
