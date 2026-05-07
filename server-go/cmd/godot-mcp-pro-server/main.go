// godot-mcp-pro-server is the Go implementation of the long-running daemon.
//
// Architecture (unchanged from the Node prototype):
//
//	Godot addon  <-- ws:6505-6509 --  this daemon  -- ws:6520 -->  stdio MCP / CLI clients
//
// The daemon owns the addon connection and forwards `call_tool` requests from
// stdio/CLI clients into JSON-RPC calls on the addon socket.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ssddi456/godot-mcp-pro/server-go/internal/bridge"
	"github.com/ssddi456/godot-mcp-pro/server-go/internal/daemon"
	"github.com/ssddi456/godot-mcp-pro/server-go/internal/logger"
	"github.com/ssddi456/godot-mcp-pro/server-go/internal/tools"
)

func main() {
	logger.EnableDebug()

	host := flag.String("host", envOr("GODOT_MCP_SERVER_HOST", "127.0.0.1"), "Bind host for the client API and the addon listener")
	clientPort := flag.Int("port", envIntOr("GODOT_MCP_SERVER_PORT", 6520), "Local WebSocket port for stdio/CLI clients")
	godotPort := flag.Int("godot-port", envIntOr("GODOT_MCP_PORT", 0), "Force a specific addon port (0 = use range)")
	godotPortRange := flag.String("godot-port-range", os.Getenv("GODOT_MCP_PORT_RANGE"), `Addon port range "lo-hi" (default "6505-6509")`)
	timeoutMs := flag.Int("timeout-ms", envIntOr("GODOT_MCP_TIMEOUT_MS", 60000), "Default per-request timeout in ms")

	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "godot-mcp-pro-server — Go daemon")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "Usage:")
		fmt.Fprintln(os.Stderr, "  godot-mcp-pro-server [--host 127.0.0.1] [--port 6520]")
		fmt.Fprintln(os.Stderr, "                       [--godot-port 6505 | --godot-port-range 6505-6509]")
		fmt.Fprintln(os.Stderr, "                       [--timeout-ms 60000]")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "Env (matching the Node implementation):")
		fmt.Fprintln(os.Stderr, "  GODOT_MCP_SERVER_HOST  GODOT_MCP_SERVER_PORT")
		fmt.Fprintln(os.Stderr, "  GODOT_MCP_PORT         GODOT_MCP_PORT_RANGE")
		fmt.Fprintln(os.Stderr, "  GODOT_MCP_TIMEOUT_MS   GODOT_MCP_DEBUG=1")
	}
	flag.Parse()

	low, high := 6505, 6509
	if *godotPortRange != "" {
		l, h, err := parseRange(*godotPortRange)
		if err != nil {
			fmt.Fprintf(os.Stderr, "invalid --godot-port-range %q: %v\n", *godotPortRange, err)
			os.Exit(2)
		}
		low, high = l, h
	}

	catalog, err := tools.Load()
	if err != nil {
		logger.Error("Fatal: %v", err)
		os.Exit(1)
	}
	logger.Info("Loaded tool catalog: %d tools, modes=%v", catalog.Count(), catalog.ValidModes())

	br := bridge.New(bridge.Options{
		Host:           *host,
		Port:           *godotPort,
		PortRangeLow:   low,
		PortRangeHigh:  high,
		DefaultTimeout: time.Duration(*timeoutMs) * time.Millisecond,
	})
	d := daemon.New(daemon.Options{
		Host:           *host,
		ClientPort:     *clientPort,
		RequestTimeout: time.Duration(*timeoutMs) * time.Millisecond,
	}, br, catalog)

	if err := d.Start(); err != nil {
		logger.Error("Fatal: %v", err)
		os.Exit(1)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	s := <-sig
	logger.Info("Received %s, shutting down daemon", s)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := d.Close(ctx); err != nil {
		logger.Warn("Daemon close error: %v", err)
	}
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func envIntOr(name string, fallback int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func parseRange(raw string) (int, int, error) {
	parts := strings.SplitN(raw, "-", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("expected lo-hi")
	}
	lo, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil {
		return 0, 0, err
	}
	hi, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil {
		return 0, 0, err
	}
	if lo > hi {
		return 0, 0, fmt.Errorf("lo > hi")
	}
	return lo, hi, nil
}
