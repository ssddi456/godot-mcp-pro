// Package bridge implements the WebSocket server side of the connection to the
// Godot editor plugin. The Godot addon is a WebSocket client that dials the
// Node/Go daemon on the addon port range (default 6505-6509). One addon
// connection is allowed at a time. Communication is JSON-RPC 2.0 with periodic
// ping/pong heartbeats.
package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/ssddi456/godot-mcp-pro/server-go/internal/jsonrpc"
	"github.com/ssddi456/godot-mcp-pro/server-go/internal/logger"
)

// Options configures the bridge.
type Options struct {
	Host              string
	Port              int           // 0 disables single-port mode
	PortRangeLow      int           // inclusive
	PortRangeHigh     int           // inclusive
	HeartbeatInterval time.Duration // 0 disables
	PongTimeout       time.Duration // max wait for pong after ping; 0 = 2×HeartbeatInterval
	DefaultTimeout    time.Duration
}

// Defaults applied when fields are zero-valued.
func (o *Options) applyDefaults() {
	if o.Host == "" {
		o.Host = "127.0.0.1"
	}
	if o.Port == 0 && (o.PortRangeLow == 0 || o.PortRangeHigh == 0) {
		o.PortRangeLow, o.PortRangeHigh = 6505, 6509
	}
	if o.HeartbeatInterval == 0 {
		o.HeartbeatInterval = 10 * time.Second
	}
	if o.PongTimeout == 0 {
		o.PongTimeout = 2 * o.HeartbeatInterval
	}
	if o.DefaultTimeout == 0 {
		o.DefaultTimeout = 60 * time.Second
	}
}

type pendingRequest struct {
	resolve chan<- *jsonrpc.Response
}

// Bridge owns the WebSocket connection to the Godot addon.
type Bridge struct {
	opts Options

	listener  net.Listener
	httpSrv   *http.Server
	upgrader  websocket.Upgrader
	boundPort int

	mu          sync.Mutex
	conn        *websocket.Conn
	writeMu     sync.Mutex
	nextID      int64
	pending     map[int64]pendingRequest
	connectedCh chan struct{}
	closed      bool

	// lastPong stores a time.Time: updated on every pong from the addon.
	// Used by runHeartbeat to detect zombie connections.
	lastPong atomic.Value
}

// New constructs a bridge with defaults applied.
func New(opts Options) *Bridge {
	opts.applyDefaults()
	return &Bridge{
		opts: opts,
		upgrader: websocket.Upgrader{
			CheckOrigin:     func(r *http.Request) bool { return true },
			ReadBufferSize:  64 * 1024,
			WriteBufferSize: 64 * 1024,
		},
		pending:     map[int64]pendingRequest{},
		connectedCh: make(chan struct{}),
	}
}

// Start binds the first available port in the configured range and listens
// for the Godot addon connection. Returns the bound port.
func (b *Bridge) Start() (int, error) {
	ports := b.candidatePorts()
	var lastErr error
	for _, p := range ports {
		l, err := net.Listen("tcp", net.JoinHostPort(b.opts.Host, strconv.Itoa(p)))
		if err != nil {
			lastErr = err
			logger.Debug("addon port %d unavailable: %v", p, err)
			continue
		}
		b.listener = l
		b.boundPort = p
		break
	}
	if b.listener == nil {
		return 0, fmt.Errorf("could not bind to any addon port in range %v: %w", ports, lastErr)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", b.handleHTTP)
	b.httpSrv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		if err := b.httpSrv.Serve(b.listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("addon HTTP server stopped: %v", err)
		}
	}()
	logger.Info("Godot bridge listening on ws://%s:%d", b.opts.Host, b.boundPort)
	return b.boundPort, nil
}

func (b *Bridge) candidatePorts() []int {
	if b.opts.Port != 0 {
		return []int{b.opts.Port}
	}
	out := make([]int, 0, b.opts.PortRangeHigh-b.opts.PortRangeLow+1)
	for p := b.opts.PortRangeLow; p <= b.opts.PortRangeHigh; p++ {
		out = append(out, p)
	}
	return out
}

func (b *Bridge) handleHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := b.upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Warn("addon upgrade failed: %v", err)
		return
	}
	b.handleConn(conn)
}

func (b *Bridge) handleConn(conn *websocket.Conn) {
	b.mu.Lock()
	if b.conn != nil {
		b.mu.Unlock()
		logger.Warn("rejecting additional Godot connection (already connected)")
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "already connected"),
			time.Now().Add(time.Second))
		_ = conn.Close()
		return
	}
	b.conn = conn
	prevCh := b.connectedCh
	b.connectedCh = make(chan struct{})
	b.mu.Unlock()
	close(prevCh) // wake any waitForConnection callers

	// Seed lastPong so the first heartbeat check doesn't immediately evict.
	b.lastPong.Store(time.Now())

	logger.Info("Godot addon connected on port %d", b.boundPort)

	conn.SetReadLimit(16 * 1024 * 1024)
	// Set initial read deadline. It is reset on every incoming message.
	// If nothing arrives within PongTimeout (default 20 s), the connection
	// is considered dead (half-open TCP) and is closed automatically.
	if b.opts.PongTimeout > 0 {
		_ = conn.SetReadDeadline(time.Now().Add(b.opts.PongTimeout))
	}
	stopHeartbeat := make(chan struct{})
	if b.opts.HeartbeatInterval > 0 {
		go b.runHeartbeat(conn, stopHeartbeat)
	}

	defer func() {
		close(stopHeartbeat)
		_ = conn.Close()
		b.mu.Lock()
		if b.conn == conn {
			b.conn = nil
		}
		// Reject in-flight requests so callers can retry.
		for id, p := range b.pending {
			delete(b.pending, id)
			p.resolve <- &jsonrpc.Response{Error: &jsonrpc.Error{
				Code:    jsonrpc.CodeBridgeError,
				Message: "Godot disconnected before responding",
			}}
		}
		b.mu.Unlock()
		logger.Info("Godot addon disconnected from port %d", b.boundPort)
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				logger.Debug("addon read error: %v", err)
			}
			return
		}
		b.handleAddonMessage(conn, data)
	}
}

func (b *Bridge) handleAddonMessage(conn *websocket.Conn, data []byte) {
	// Reset read deadline: any incoming data proves the connection is alive.
	if b.opts.PongTimeout > 0 {
		_ = conn.SetReadDeadline(time.Now().Add(b.opts.PongTimeout))
	}
	logger.Info("bridge ← addon raw (truncated): %s", truncate(data, 120))
	var msg struct {
		ID     json.RawMessage `json:"id,omitempty"`
		Method string          `json:"method,omitempty"`
		Result json.RawMessage `json:"result,omitempty"`
		Error  *jsonrpc.Error  `json:"error,omitempty"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		logger.Warn("non-JSON message from addon (truncated): %s", truncate(data, 200))
		return
	}

	// Notification (no id): handle ping/pong, ignore others except logging.
	if len(msg.ID) == 0 || string(msg.ID) == "null" {
		switch msg.Method {
		case "ping":
			b.sendNotificationLocked(conn, "pong", map[string]any{})
		case "pong":
			b.lastPong.Store(time.Now())
		default:
			logger.Debug("addon notification %q (ignored)", msg.Method)
		}
		return
	}

	id, err := parseNumericID(msg.ID)
	if err != nil {
		logger.Debug("ignoring response with non-numeric id: %s", string(msg.ID))
		return
	}

	b.mu.Lock()
	pending, ok := b.pending[id]
	if ok {
		delete(b.pending, id)
	}
	b.mu.Unlock()
	if !ok {
		logger.Debug("ignoring response with unknown id %d", id)
		return
	}
	resp := &jsonrpc.Response{Result: msg.Result, Error: msg.Error}
	pending.resolve <- resp
}

func (b *Bridge) runHeartbeat(conn *websocket.Conn, stop <-chan struct{}) {
	ticker := time.NewTicker(b.opts.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			// Evict zombie connection: if no pong has arrived within PongTimeout,
			// the TCP session is dead (e.g. Godot crashed without sending FIN).
			if lp, ok := b.lastPong.Load().(time.Time); ok {
				if time.Since(lp) > b.opts.PongTimeout {
					logger.Warn("Godot addon pong timeout (last pong %s ago) — closing zombie connection",
						time.Since(lp).Round(time.Second))
					_ = conn.Close()
					return
				}
			}
			b.sendNotificationLocked(conn, "ping", map[string]any{})
		}
	}
}

func (b *Bridge) sendNotificationLocked(conn *websocket.Conn, method string, params any) {
	payload, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		logger.Debug("addon notification %q send failed: %v", method, err)
	}
}

// IsConnected returns whether an addon socket is currently active.
func (b *Bridge) IsConnected() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.conn != nil
}

// Port returns the bound addon port (0 before Start succeeds).
func (b *Bridge) Port() int { return b.boundPort }

// WaitForConnection blocks until an addon connects or the context expires.
func (b *Bridge) WaitForConnection(ctx context.Context) error {
	b.mu.Lock()
	if b.conn != nil {
		b.mu.Unlock()
		return nil
	}
	ch := b.connectedCh
	b.mu.Unlock()
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return &jsonrpc.Error{
			Code: jsonrpc.CodeBridgeError,
			Message: fmt.Sprintf(
				"Timed out waiting for Godot addon to connect on port %d. Make sure the Godot editor is running with the godot_mcp plugin enabled.",
				b.boundPort),
		}
	}
}

// Call sends a JSON-RPC request to the addon and waits for the response.
func (b *Bridge) Call(ctx context.Context, method string, params map[string]any) (json.RawMessage, error) {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil, &jsonrpc.Error{Code: jsonrpc.CodeBridgeError, Message: "Bridge is closed"}
	}
	conn := b.conn
	if conn == nil {
		b.mu.Unlock()
		return nil, &jsonrpc.Error{
			Code:    jsonrpc.CodeBridgeError,
			Message: "Godot addon is not connected. Open the editor with the godot_mcp plugin enabled.",
		}
	}
	b.nextID++
	id := b.nextID
	resCh := make(chan *jsonrpc.Response, 1)
	b.pending[id] = pendingRequest{resolve: resCh}
	b.mu.Unlock()

	if params == nil {
		params = map[string]any{}
	}
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	})
	if err != nil {
		b.removePending(id)
		return nil, &jsonrpc.Error{Code: jsonrpc.CodeBridgeError, Message: fmt.Sprintf("marshal request: %v", err)}
	}

	b.writeMu.Lock()
	if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		b.writeMu.Unlock()
		b.removePending(id)
		return nil, &jsonrpc.Error{Code: jsonrpc.CodeBridgeError, Message: fmt.Sprintf("Failed to send request: %v", err)}
	}
	b.writeMu.Unlock()
	logger.Info("bridge → addon id=%d method=%s", id, method)

	select {
	case resp := <-resCh:
		logger.Info("bridge ← addon id=%d hasError=%v", id, resp.Error != nil)
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	case <-ctx.Done():
		b.removePending(id)
		logger.Warn("bridge.Call timeout: no response from Godot for method=%s id=%d (is connection half-open?)", method, id)
		return nil, &jsonrpc.Error{Code: jsonrpc.CodeBridgeError, Message: fmt.Sprintf("Request timed out: %s", method)}
	}
}

func (b *Bridge) removePending(id int64) {
	b.mu.Lock()
	delete(b.pending, id)
	b.mu.Unlock()
}

// Close stops the listener and closes the addon socket.
func (b *Bridge) Close() error {
	b.mu.Lock()
	b.closed = true
	conn := b.conn
	b.conn = nil
	for id, p := range b.pending {
		delete(b.pending, id)
		p.resolve <- &jsonrpc.Response{Error: &jsonrpc.Error{Code: jsonrpc.CodeBridgeError, Message: "Bridge closed"}}
	}
	b.mu.Unlock()

	if conn != nil {
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "server shutting down"),
			time.Now().Add(time.Second))
		_ = conn.Close()
	}
	if b.httpSrv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = b.httpSrv.Shutdown(ctx)
	}
	return nil
}

func parseNumericID(raw json.RawMessage) (int64, error) {
	var n int64
	if err := json.Unmarshal(raw, &n); err == nil {
		return n, nil
	}
	// Godot's JSON serializer may emit integers as floats (e.g. 1.0).
	// Accept float values that are whole numbers.
	var f float64
	if err := json.Unmarshal(raw, &f); err == nil {
		if f == math.Trunc(f) {
			return int64(f), nil
		}
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		v, err := strconv.ParseInt(s, 10, 64)
		if err == nil {
			return v, nil
		}
	}
	return 0, fmt.Errorf("not a numeric id")
}

func truncate(data []byte, max int) string {
	if len(data) <= max {
		return string(data)
	}
	return string(data[:max])
}
