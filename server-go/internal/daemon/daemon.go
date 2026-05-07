// Package daemon implements the long-running Go server. It owns the Godot
// addon WebSocket connection (via internal/bridge) and exposes a local
// JSON-RPC 2.0 WebSocket API for stdio MCP and CLI clients on a separate port.
//
// Client RPC methods (matching the original Node daemon):
//   - status
//   - list_tools  { mode? }
//   - call_tool   { name, arguments? }
package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/ssddi456/godot-mcp-pro/server-go/internal/bridge"
	"github.com/ssddi456/godot-mcp-pro/server-go/internal/jsonrpc"
	"github.com/ssddi456/godot-mcp-pro/server-go/internal/logger"
	"github.com/ssddi456/godot-mcp-pro/server-go/internal/tools"
)

// Options configures the daemon's client-facing API.
type Options struct {
	Host           string
	ClientPort     int
	RequestTimeout time.Duration
}

func (o *Options) applyDefaults() {
	if o.Host == "" {
		o.Host = "127.0.0.1"
	}
	if o.ClientPort == 0 {
		o.ClientPort = 6520
	}
	if o.RequestTimeout == 0 {
		o.RequestTimeout = 60 * time.Second
	}
}

// Daemon owns both ports.
type Daemon struct {
	opts    Options
	bridge  *bridge.Bridge
	catalog *tools.Catalog

	httpSrv  *http.Server
	listener net.Listener
	upgrader websocket.Upgrader
}

// New creates a Daemon. The bridge must already be configured (but not yet
// started) and the tool catalog already loaded.
func New(opts Options, b *bridge.Bridge, c *tools.Catalog) *Daemon {
	opts.applyDefaults()
	return &Daemon{
		opts:    opts,
		bridge:  b,
		catalog: c,
		upgrader: websocket.Upgrader{
			CheckOrigin:     func(r *http.Request) bool { return true },
			ReadBufferSize:  64 * 1024,
			WriteBufferSize: 64 * 1024,
		},
	}
}

// Start launches the addon bridge and the client API server.
func (d *Daemon) Start() error {
	if _, err := d.bridge.Start(); err != nil {
		return err
	}
	l, err := net.Listen("tcp", net.JoinHostPort(d.opts.Host, strconv.Itoa(d.opts.ClientPort)))
	if err != nil {
		return fmt.Errorf("bind client port %d: %w", d.opts.ClientPort, err)
	}
	d.listener = l

	mux := http.NewServeMux()
	mux.HandleFunc("/", d.handleHTTP)
	d.httpSrv = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}

	go func() {
		if err := d.httpSrv.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("client API server stopped: %v", err)
		}
	}()

	logger.Info(
		"Daemon ready: addon ws port=%d, client ws=ws://%s:%d, tools=%d",
		d.bridge.Port(), d.opts.Host, d.opts.ClientPort, d.catalog.Count(),
	)
	return nil
}

func (d *Daemon) handleHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := d.upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Warn("client upgrade failed: %v", err)
		return
	}
	d.handleClient(conn)
}

type client struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
}

func (c *client) sendJSON(payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.WriteMessage(websocket.TextMessage, data)
}

func (d *Daemon) handleClient(conn *websocket.Conn) {
	logger.Debug("stdio/CLI client connected")
	defer logger.Debug("stdio/CLI client disconnected")
	defer conn.Close()

	conn.SetReadLimit(16 * 1024 * 1024)
	c := &client{conn: conn}

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		go d.handleClientMessage(c, data)
	}
}

func (d *Daemon) handleClientMessage(c *client, data []byte) {
	var req jsonrpc.Request
	if err := json.Unmarshal(data, &req); err != nil {
		c.sendJSON(map[string]any{
			"jsonrpc": "2.0",
			"id":      nil,
			"error":   &jsonrpc.Error{Code: jsonrpc.CodeParseError, Message: "Parse error"},
		})
		return
	}

	if req.Method == "ping" {
		c.sendJSON(map[string]any{
			"jsonrpc": "2.0",
			"method":  "pong",
			"params":  map[string]any{},
		})
		return
	}

	idIsNull := len(req.ID) == 0 || string(req.ID) == "null"
	if idIsNull || req.Method == "" {
		var idVal any
		if !idIsNull {
			_ = json.Unmarshal(req.ID, &idVal)
		}
		c.sendJSON(map[string]any{
			"jsonrpc": "2.0",
			"id":      idVal,
			"error":   &jsonrpc.Error{Code: jsonrpc.CodeInvalidRequest, Message: "Invalid request"},
		})
		return
	}

	result, rpcErr := d.dispatch(req.Method, req.Params)
	resp := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(req.ID)}
	if rpcErr != nil {
		resp["error"] = rpcErr
	} else {
		if result == nil {
			result = map[string]any{}
		}
		resp["result"] = result
	}
	c.sendJSON(resp)
}

func (d *Daemon) dispatch(method string, rawParams json.RawMessage) (any, *jsonrpc.Error) {
	params := map[string]any{}
	if len(rawParams) > 0 {
		if err := json.Unmarshal(rawParams, &params); err != nil {
			// Some clients omit params or send a non-object; ignore parse errors.
			params = map[string]any{}
		}
	}

	switch method {
	case "status":
		return map[string]any{
			"godotConnected": d.bridge.IsConnected(),
			"godotPort":      d.bridge.Port(),
			"tools":          d.catalog.Count(),
		}, nil

	case "list_tools":
		mode, _ := params["mode"].(string)
		if mode == "" {
			mode = "full"
		}
		return map[string]any{"tools": d.catalog.ForMode(mode)}, nil

	case "call_tool":
		name, _ := params["name"].(string)
		if name == "" {
			return nil, &jsonrpc.Error{Code: jsonrpc.CodeInvalidParams, Message: "Missing required parameter: name"}
		}
		if !d.catalog.Has(name) {
			return nil, &jsonrpc.Error{Code: jsonrpc.CodeMethodNotFound, Message: "Unknown tool: " + name}
		}
		args, _ := params["arguments"].(map[string]any)
		if args == nil {
			args = map[string]any{}
		}
		ctx, cancel := context.WithTimeout(context.Background(), d.opts.RequestTimeout)
		defer cancel()
		if !d.bridge.IsConnected() {
			waitCtx, waitCancel := context.WithTimeout(context.Background(), 5*time.Second)
			err := d.bridge.WaitForConnection(waitCtx)
			waitCancel()
			if err != nil {
				if rpcErr, ok := err.(*jsonrpc.Error); ok {
					return nil, rpcErr
				}
				return nil, &jsonrpc.Error{Code: jsonrpc.CodeBridgeError, Message: err.Error()}
			}
		}
		raw, err := d.bridge.Call(ctx, name, args)
		if err != nil {
			if rpcErr, ok := err.(*jsonrpc.Error); ok {
				return nil, rpcErr
			}
			return nil, &jsonrpc.Error{Code: jsonrpc.CodeBridgeError, Message: err.Error()}
		}
		// Pass through whatever the addon returned.
		var out any
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &out); err != nil {
				return nil, &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: "Invalid result from addon: " + err.Error()}
			}
		}
		if out == nil {
			out = map[string]any{}
		}
		return out, nil

	default:
		return nil, &jsonrpc.Error{Code: jsonrpc.CodeMethodNotFound, Message: "Unknown daemon method: " + method}
	}
}

// Close stops both servers.
func (d *Daemon) Close(ctx context.Context) error {
	if d.httpSrv != nil {
		_ = d.httpSrv.Shutdown(ctx)
	}
	return d.bridge.Close()
}
