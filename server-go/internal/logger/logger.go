// Package logger writes leveled messages to stderr. stdout is reserved for
// JSON-RPC framing on the stdio MCP entry; the daemon writes to stderr too so
// it composes cleanly when run alongside the Node clients.
package logger

import (
	"fmt"
	"os"
	"sync"
	"time"
)

// Level controls minimum severity that is printed.
type Level int

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

var (
	mu       sync.Mutex
	minLevel = LevelInfo
)

// SetLevel updates the minimum severity that will be printed.
func SetLevel(level Level) {
	mu.Lock()
	defer mu.Unlock()
	minLevel = level
}

// EnableDebug honors the GODOT_MCP_DEBUG env var (matches the Node logger).
func EnableDebug() {
	v := os.Getenv("GODOT_MCP_DEBUG")
	if v == "1" || v == "true" {
		SetLevel(LevelDebug)
	}
}

func write(level Level, tag, format string, args ...any) {
	mu.Lock()
	defer mu.Unlock()
	if level < minLevel {
		return
	}
	ts := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintf(os.Stderr, "[%s] %s godot-mcp-pro-server %s\n", ts, tag, msg)
}

// Debug logs at debug level.
func Debug(format string, args ...any) { write(LevelDebug, "debug", format, args...) }

// Info logs at info level.
func Info(format string, args ...any) { write(LevelInfo, "info", format, args...) }

// Warn logs at warn level.
func Warn(format string, args ...any) { write(LevelWarn, "warn", format, args...) }

// Error logs at error level.
func Error(format string, args ...any) { write(LevelError, "error", format, args...) }
