// Command notes-summarizer is the Executa tool for the Anna App
// "Mini Notes with LLM Summary". It speaks JSON-RPC 2.0 over stdio
// (line-delimited, UTF-8, LF) as specified in notes/01-executa-protocol.md,
// and issues the reverse RPC sampling/createMessage (notes/03) to borrow
// the host LLM for summarization.
//
// Hard rules implemented here:
//   - stdout carries JSON-RPC messages ONLY; every write is flushed
//     immediately. All logs/banners go to stderr.
//   - stdin is read in a loop until EOF (or SIGTERM/SIGINT); the process
//     never exits after a single response.
//   - The single stdin reader serves two channels: agent-initiated
//     requests (have a "method" field) and host responses to our reverse
//     RPCs (have only id + result/error). Responses are routed to the
//     matching pending channel by id; forward requests are dispatched on
//     their own goroutine so a blocked invoke never stalls the reader.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	ToolName    = "notes-summarizer"
	ToolVersion = "0.1.0"

	// Scanner limits: initial 64 KiB, max 16 MiB per line (protocol
	// ceiling is 2 MiB, file transport beyond ~512 KiB).
	scanInitial = 64 * 1024
	scanMax     = 16 * 1024 * 1024

	// How long an invoke waits for the host to answer a sampling
	// request before failing the invoke.
	samplingTimeout = 60 * time.Second
	// maxTokens for the summarization completion (host cap is 8192).
	samplingMaxTokens = 512
)

// ---- describe manifest (exported so packaging scripts and tests can reuse it) ----

type ToolParameter struct {
	Name        string          `json:"name"`
	Type        string          `json:"type"`
	Items       *ParameterItems `json:"items,omitempty"`
	Description string          `json:"description"`
	Required    bool            `json:"required"`
}

type ParameterItems struct {
	Type string `json:"type"`
}

type ToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Timeout     int             `json:"timeout"`
	Streaming   bool            `json:"streaming"`
	Parameters  []ToolParameter `json:"parameters"`
}

type RuntimeHint struct {
	Type string `json:"type"`
}

type ExecutaManifest struct {
	Name             string      `json:"name"`
	DisplayName      string      `json:"display_name"`
	Version          string      `json:"version"`
	Description      string      `json:"description"`
	HostCapabilities []string    `json:"host_capabilities"`
	Tools            []ToolDef   `json:"tools"`
	Runtime          RuntimeHint `json:"runtime"`
}

// Manifest is the bare manifest returned by describe (no wrapper object).
var Manifest = ExecutaManifest{
	Name:        ToolName,
	DisplayName: "Notes Summarizer",
	Version:     ToolVersion,
	Description: "Summarizes a batch of note texts into a concise summary using the host LLM.",
	// llm.sample unlocks the sampling/createMessage reverse RPC (notes/03).
	HostCapabilities: []string{"llm.sample"},
	Tools: []ToolDef{
		{
			Name:        "summarize",
			Description: "Summarize the given notes into a concise summary.",
			Timeout:     60,
			Streaming:   false,
			Parameters: []ToolParameter{
				{
					Name:        "notes",
					Type:        "array",
					Items:       &ParameterItems{Type: "string"},
					Description: "笔记文本数组",
					Required:    true,
				},
			},
		},
	},
	Runtime: RuntimeHint{Type: "binary"},
}

// ---- JSON-RPC envelope types ----

// rpcMessage decodes any line from stdin: agent requests carry "method",
// host responses to our reverse RPCs carry only id + result/error.
type rpcMessage struct {
	Jsonrpc string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

type rpcResponse struct {
	Jsonrpc string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcErrorResponse struct {
	Jsonrpc string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Error   *rpcError       `json:"error"`
}

func respond(id json.RawMessage, result any) []byte {
	b, err := json.Marshal(rpcResponse{Jsonrpc: "2.0", ID: id, Result: result})
	if err != nil {
		log.Printf("[marshal] result encode failed: %v", err)
		b, _ = json.Marshal(rpcErrorResponse{
			Jsonrpc: "2.0",
			ID:      id,
			Error:   &rpcError{Code: -32603, Message: "internal error"},
		})
	}
	return b
}

func respondError(id json.RawMessage, code int, message string) []byte {
	b, _ := json.Marshal(rpcErrorResponse{
		Jsonrpc: "2.0",
		ID:      id,
		Error:   &rpcError{Code: code, Message: message},
	})
	return b
}

// ---- reverse RPC hub: pending table, request ids, stdout writes ----

type rpcHub struct {
	// pending maps the JSON-quoted request id ("\"sr-1\"") to the
	// channel the issuing handler is waiting on.
	mu      sync.Mutex
	seq     uint64
	pending map[string]chan rpcMessage
	proto   string // negotiated protocol version, set by initialize

	out   *bufio.Writer
	outMu sync.Mutex // serializes stdout across forward handlers and sendRequest
}

func newRPCHub(out *bufio.Writer) *rpcHub {
	return &rpcHub{
		pending: make(map[string]chan rpcMessage),
		out:     out,
	}
}

// writeLine writes one JSON frame to stdout and flushes immediately.
// All stdout writes go through this single lock.
func (h *rpcHub) writeLine(b []byte) error {
	h.outMu.Lock()
	defer h.outMu.Unlock()
	if _, err := h.out.Write(b); err != nil {
		return err
	}
	if err := h.out.WriteByte('\n'); err != nil {
		return err
	}
	return h.out.Flush()
}

// sendRequest registers a pending entry, emits the reverse RPC request
// on stdout, and returns the id plus the channel the host response will
// arrive on.
func (h *rpcHub) sendRequest(method string, params map[string]any) (string, <-chan rpcMessage, error) {
	reqID := fmt.Sprintf("sr-%d", atomic.AddUint64(&h.seq, 1))
	ch := make(chan rpcMessage, 1)
	h.mu.Lock()
	h.pending[strconv.Quote(reqID)] = ch
	h.mu.Unlock()

	b, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      reqID,
		"method":  method,
		"params":  params,
	})
	if err != nil {
		h.resolve(reqID)
		return "", nil, err
	}
	if err := h.writeLine(b); err != nil {
		h.resolve(reqID)
		return "", nil, err
	}
	return reqID, ch, nil
}

// deliver routes a host response (no method field) to the handler
// waiting on that request id. Returns false when nothing was waiting.
func (h *rpcHub) deliver(msg rpcMessage) bool {
	key := string(msg.ID)
	h.mu.Lock()
	ch, ok := h.pending[key]
	if ok {
		delete(h.pending, key)
	}
	h.mu.Unlock()
	if ok {
		ch <- msg // buffered(1), never blocks
	}
	return ok
}

// resolve drops a pending entry (idempotent; used on timeout/failure).
func (h *rpcHub) resolve(reqID string) {
	h.mu.Lock()
	delete(h.pending, strconv.Quote(reqID))
	h.mu.Unlock()
}

// ---- method handlers ----

type initializeParams struct {
	ProtocolVersion string `json:"protocolVersion"`
}

type serverInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type initializeResult struct {
	ProtocolVersion    string         `json:"protocolVersion"`
	ServerInfo         serverInfo     `json:"serverInfo"`
	ClientCapabilities map[string]any `json:"client_capabilities"`
	Capabilities       map[string]any `json:"capabilities"`
}

func handleInitialize(params json.RawMessage, id json.RawMessage, hub *rpcHub) []byte {
	var p initializeParams
	if len(params) > 0 && !bytes.Equal(bytes.TrimSpace(params), []byte("null")) {
		if err := json.Unmarshal(params, &p); err != nil {
			return respondError(id, -32602, "invalid params")
		}
	}
	ver := p.ProtocolVersion
	if ver != "2.0" {
		// v1: no sampling capability advertised.
		ver = "1.1"
	}
	hub.mu.Lock()
	hub.proto = ver
	hub.mu.Unlock()
	res := initializeResult{
		ProtocolVersion:    ver,
		ServerInfo:         serverInfo{Name: ToolName, Version: ToolVersion},
		ClientCapabilities: map[string]any{},
		Capabilities:       map[string]any{},
	}
	if ver == "2.0" {
		res.ClientCapabilities = map[string]any{"sampling": map[string]any{}}
	}
	return respond(id, res)
}

type invokeParams struct {
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	Context   *struct {
		InvokeID string `json:"invoke_id"`
	} `json:"context"`
	// InvokeID directly on params is a compatibility fallback; the
	// protocol puts it under params.context (notes/02).
	InvokeID string `json:"invoke_id"`
}

type summarizeArgs struct {
	Notes []string `json:"notes"`
}

type invokeResult struct {
	Success bool   `json:"success"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}

func handleInvoke(params json.RawMessage, id json.RawMessage, hub *rpcHub) []byte {
	var p invokeParams
	if len(params) == 0 {
		return respondError(id, -32602, "invalid params")
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return respondError(id, -32602, "invalid params")
	}
	if p.Tool != "summarize" {
		return respondError(id, -32601, fmt.Sprintf("unknown tool: %s", p.Tool))
	}
	var args summarizeArgs
	if len(p.Arguments) > 0 && !bytes.Equal(bytes.TrimSpace(p.Arguments), []byte("null")) {
		if err := json.Unmarshal(p.Arguments, &args); err != nil {
			return respondError(id, -32602, "invalid params: arguments.notes must be an array of strings")
		}
	}
	if args.Notes == nil {
		return respondError(id, -32602, "invalid params: missing arguments.notes")
	}
	if len(args.Notes) == 0 {
		return respond(id, invokeResult{Success: false, Error: "笔记列表为空，无法总结"})
	}

	invokeID := ""
	if p.Context != nil {
		invokeID = p.Context.InvokeID
	}
	if invokeID == "" {
		invokeID = p.InvokeID
	}
	log.Printf("[invoke] tool=summarize invoke_id=%q notes=%d", invokeID, len(args.Notes))

	summary, err := handleSummarize(args.Notes, invokeID, hub)
	if err != nil {
		// Tool-level failure: the LLM/user should be told. Use
		// success=false + error, not a JSON-RPC error frame
		// (notes/01 distinction). Never let the panic escape the loop.
		log.Printf("[summarize] failed: %v", err)
		return respond(id, invokeResult{Success: false, Error: err.Error()})
	}
	return respond(id, invokeResult{
		Success: true,
		Data:    map[string]any{"summary": summary},
	})
}

// samplingResult is the host's answer to sampling/createMessage
// (notes/03): the summary text lives at result.content.text.
type samplingResult struct {
	Role    string `json:"role"`
	Content struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	Model      string `json:"model"`
	StopReason string `json:"stopReason"`
}

// handleSummarize issues one sampling/createMessage reverse RPC and
// returns the generated summary text.
func handleSummarize(notes []string, invokeID string, hub *rpcHub) (string, error) {
	hub.mu.Lock()
	proto := hub.proto
	hub.mu.Unlock()
	// 本地 harness（anna-app dev）不发 initialize，hub.proto 保持 ""。
	// 只在 host 显式协商到 v1 时才拒绝采样；""（harness 跳过握手）
	// 与 "2.0" 都放行，把采样请求发出去让 host 来回答——--no-llm
	// 下 harness 会用自己的错误拒绝采样（这才是预期行为）。
	if proto == "1.1" {
		return "", fmt.Errorf("sampling unavailable: host negotiated protocol %q (sampling requires 2.0)", proto)
	}

	prompt := buildSummaryPrompt(notes)
	reqID, ch, err := hub.sendRequest("sampling/createMessage", map[string]any{
		"messages": []map[string]any{
			{
				"role": "user",
				"content": map[string]any{
					"type": "text",
					"text": prompt,
				},
			},
		},
		"maxTokens": samplingMaxTokens,
		// Phase 1 only accepts "none" (notes/03).
		"includeContext": "none",
		// The parent invoke's id MUST be echoed back so the host can
		// attribute usage and enforce per-invoke caps (notes/02).
		// executa_invoke_id is the conventional key in the official
		// examples; invoke_id matches the doc field name.
		"metadata": map[string]any{
			"invoke_id":         invokeID,
			"executa_invoke_id": invokeID,
			"tool":              "summarize",
		},
	})
	if err != nil {
		return "", fmt.Errorf("send sampling request: %w", err)
	}
	log.Printf("[sampling] request sent id=%s invoke_id=%q", reqID, invokeID)

	select {
	case resp := <-ch:
		if resp.Error != nil {
			return "", fmt.Errorf("sampling failed (%d %s)", resp.Error.Code, resp.Error.Message)
		}
		var sr samplingResult
		if err := json.Unmarshal(resp.Result, &sr); err != nil {
			return "", fmt.Errorf("malformed sampling response: %w", err)
		}
		if strings.TrimSpace(sr.Content.Text) == "" {
			return "", fmt.Errorf("sampling returned empty content")
		}
		return sr.Content.Text, nil
	case <-time.After(samplingTimeout):
		hub.resolve(reqID) // nobody will ever answer; drop the pending entry
		return "", fmt.Errorf("sampling timed out after %s", samplingTimeout)
	}
}

func buildSummaryPrompt(notes []string) string {
	var b strings.Builder
	b.WriteString("请总结以下笔记，返回精炼要点：\n\n")
	for i, n := range notes {
		fmt.Fprintf(&b, "%d. %s\n", i+1, n)
	}
	return b.String()
}

func handleHealth(id json.RawMessage) []byte {
	return respond(id, map[string]any{
		"status":    "healthy",
		"version":   ToolVersion,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

// dispatch routes one parsed agent request to its handler.
func dispatch(method string, params json.RawMessage, id json.RawMessage, hub *rpcHub) []byte {
	switch method {
	case "initialize":
		return handleInitialize(params, id, hub)
	case "describe":
		return respond(id, Manifest)
	case "invoke":
		return handleInvoke(params, id, hub)
	case "health":
		return handleHealth(id)
	case "shutdown":
		return respond(id, map[string]any{"ok": true})
	default:
		// Unknown methods MUST answer -32601: the host's v1/v2
		// downgrade logic depends on it (notes/02).
		return respondError(id, -32601, fmt.Sprintf("method not found: %s", method))
	}
}

// safeDispatch wraps dispatch so a handler panic never kills the main
// loop; the request resolves as -32603 instead.
func safeDispatch(method string, params json.RawMessage, id json.RawMessage, hub *rpcHub) (resp []byte) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[panic] method=%q: %v", method, r)
			resp = respondError(id, -32603, "internal error")
		}
	}()
	return dispatch(method, params, id, hub)
}

func main() {
	log.SetFlags(log.LstdFlags)
	log.SetOutput(os.Stderr) // logs never touch stdout
	log.Printf("%s v%s executa listening on stdio", ToolName, ToolVersion)

	// Clean shutdown on signal: exit 0 so the Agent does not count it
	// against the restart budget (notes/01).
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		s := <-sig
		log.Printf("signal %v received, exiting", s)
		os.Exit(0)
	}()

	out := bufio.NewWriter(os.Stdout)
	hub := newRPCHub(out)

	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, scanInitial), scanMax)

	// Tracks in-flight forward handlers. On stdin EOF we drain these
	// briefly before exiting, so responses written by goroutines racing
	// the EOF are not silently dropped.
	var wg sync.WaitGroup

	for sc.Scan() {
		line := sc.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue // skip blank lines
		}
		// Copy the line: scanner reuses its buffer for the next read.
		payload := make([]byte, len(line))
		copy(payload, line)

		var msg rpcMessage
		if err := json.Unmarshal(payload, &msg); err != nil {
			log.Printf("[parse] invalid JSON line: %v", err)
			if werr := hub.writeLine(respondError(json.RawMessage("null"), -32700, "parse error")); werr != nil {
				log.Printf("[stdout] write error: %v", werr)
				os.Exit(1)
			}
			continue
		}

		if msg.Method == "" {
			// Host response to one of our reverse RPCs: id + result|error.
			if len(msg.ID) == 0 {
				log.Printf("[stdin] invalid frame: no method and no id")
				if werr := hub.writeLine(respondError(json.RawMessage("null"), -32600, "invalid request")); werr != nil {
					log.Printf("[stdout] write error: %v", werr)
					os.Exit(1)
				}
				continue
			}
			if hub.deliver(msg) {
				continue
			}
			log.Printf("[stdin] response to unknown pending id %s ignored", msg.ID)
			continue
		}

		// Agent-initiated request: handle on its own goroutine so the
		// reader loop keeps delivering sampling responses while an
		// invoke handler blocks waiting for one.
		req := msg
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp := safeDispatch(req.Method, req.Params, req.ID, hub)
			if err := hub.writeLine(resp); err != nil {
				log.Printf("[stdout] write error: %v", err)
				os.Exit(1)
			}
		}()
	}
	if err := sc.Err(); err != nil {
		log.Printf("[stdin] scanner error: %v", err)
		os.Exit(1)
	}
	// stdin EOF: give in-flight handlers a short grace (5 s, matching
	// the protocol shutdown contract) to finish and flush their
	// responses, then exit.
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		log.Printf("stdin EOF, all in-flight requests drained, exiting")
	case <-time.After(5 * time.Second):
		log.Printf("stdin EOF, drain grace expired, exiting")
	}
}
