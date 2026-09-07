package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	guides "github.com/Olorinm/agent-router/docs/guides"
)

type app struct {
	ctx         context.Context
	o           options
	in          io.Reader
	out, errOut io.Writer
	base        string
	http        *http.Client
}

func Run(ctx context.Context, args []string, in io.Reader, out, errOut io.Writer, version string) error {
	o, pos, err := parse(args, errOut)
	if err != nil {
		return err
	}
	a := &app{ctx: ctx, o: o, in: in, out: out, errOut: errOut}
	if o.version {
		return a.output(map[string]string{"version": version, "implementation": "go"})
	}
	if o.help || len(pos) == 0 {
		_, err = io.WriteString(out, help)
		return err
	}
	command, args := pos[0], pos[1:]
	if err = validateArgs(command, args); err != nil {
		return err
	}
	if command == "agent-guide" {
		_, err = io.WriteString(out, guides.AgentConnect)
		return err
	}
	if handled, err := a.account(command, args); handled {
		return err
	}
	if command == "connect" {
		return a.connect()
	}
	if err = a.gateway(); err != nil {
		return err
	}
	return a.command(command, args)
}
func validateArgs(command string, args []string) error {
	limits := map[string][2]int{
		"register": {2, 2}, "login": {0, 2}, "logout": {0, 0}, "whoami": {0, 0}, "bind": {1, 1}, "configure": {0, 0}, "discover": {1, 1}, "find": {1, 1}, "lookup": {0, 1}, "profile-set": {1, 1},
		"connect": {0, 0}, "doctor": {0, 0}, "status": {0, 0}, "contacts": {0, 0}, "conversations": {0, 0}, "contact-add": {1, 1}, "contact-remove": {1, 1}, "blocked": {0, 0}, "block": {1, 1}, "unblock": {1, 1},
		"invites": {0, 0}, "invite-accept": {1, 1}, "invite-reject": {1, 1}, "requests": {0, 0}, "approve": {1, 1}, "reject": {1, 1}, "inbox": {0, 0}, "claim": {0, 1}, "work": {1, 1},
		"progress": {2, 2}, "reply": {1, 2}, "need-input": {2, 2}, "fail": {2, 2}, "cancelled": {1, 1}, "conversation-open": {1, 1}, "history": {1, 1}, "read": {1, 2}, "leave": {1, 1}, "watch": {0, 0},
		"send": {2, 2}, "get": {2, 2}, "list": {1, 1}, "cancel": {2, 2}, "say": {2, 2}, "agent-guide": {0, 0},
	}
	limit, ok := limits[command]
	if !ok || len(args) < limit[0] || len(args) > limit[1] {
		return errors.New("unknown_or_incomplete_command: run agent-router --help")
	}
	for _, arg := range args {
		if arg == "" {
			return errors.New("empty_argument")
		}
	}
	return nil
}
func (a *app) output(value any) error {
	e := json.NewEncoder(a.out)
	e.SetEscapeHTML(false)
	e.SetIndent("", "  ")
	return e.Encode(value)
}
func (a *app) text(value string) (string, error) {
	if value != "-" {
		return value, nil
	}
	data, err := io.ReadAll(io.LimitReader(a.in, 1<<20+1))
	if err != nil {
		return "", err
	}
	if len(data) > 1<<20 {
		return "", errors.New("message_too_large")
	}
	return string(data), nil
}
func (a *app) gateway() error {
	var token string
	if a.o.profile != "" || os.Getenv("MATRIX_PROFILE") != "" || (os.Getenv("CONNECTOR_API_TOKEN") == "" && os.Getenv("CONNECTOR_API_TOKEN_FILE") == "") {
		s, err := newStore(a.o.profile)
		if err != nil {
			return err
		}
		p, err := s.require()
		if err != nil {
			return err
		}
		a.base = p.ConnectorURL
		token = p.GatewayToken
	} else {
		a.base = os.Getenv("CONNECTOR_URL")
		if a.base == "" {
			a.base = os.Getenv("PUBLIC_BASE_URL")
		}
		if a.base == "" {
			a.base = "http://127.0.0.1:8787"
		}
		token = os.Getenv("CONNECTOR_API_TOKEN")
		if file := os.Getenv("CONNECTOR_API_TOKEN_FILE"); file != "" {
			data, err := os.ReadFile(file)
			if err != nil {
				return errors.New("cannot_read_gateway_token_file")
			}
			token = strings.TrimSpace(string(data))
		}
	}
	if token == "" || strings.ContainsAny(token, "\r\n \t") {
		return errors.New("invalid_gateway_token")
	}
	a.base = strings.TrimRight(a.base, "/")
	c, err := newHTTP(a.base, token)
	if err != nil {
		return err
	}
	a.http = c
	return nil
}
func (a *app) api(path, method string, body any, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(a.ctx, timeout)
	defer cancel()
	data, err := request(ctx, a.http, a.base, path, method, body)
	if err != nil {
		return err
	}
	if data == nil {
		return nil
	}
	return a.output(data)
}
func (a *app) command(command string, args []string) error {
	target, arg := "", ""
	if len(args) > 0 {
		target = args[0]
	}
	if len(args) > 1 {
		arg = args[1]
	}
	id := url.PathEscape(target)
	path, method, body, timeout := "", "GET", any(nil), 30*time.Second
	switch command {
	case "doctor":
		path = "/health/ready"
	case "status":
		path = "/api/status"
	case "inbox":
		path = fmt.Sprintf("/api/inbox?all=%t", a.o.all)
	case "work":
		path = "/api/work/" + id
	case "claim":
		if strings.TrimSpace(a.o.worker) == "" {
			return errors.New("claim_requires_worker_name")
		}
		wait, err := a.o.waitSeconds(60)
		if err != nil {
			return err
		}
		b := map[string]any{"worker": a.o.worker, "wait": wait}
		if target != "" {
			b["id"] = target
		}
		path = "/api/work/claim"
		method = "POST"
		body = b
		timeout = time.Duration(wait+30) * time.Second
	case "progress", "reply", "need-input", "fail", "cancelled":
		text, err := a.text(arg)
		if err != nil {
			return err
		}
		b := map[string]any{"action": command, "text": text}
		if a.o.dataFile != "" {
			data, err := os.ReadFile(a.o.dataFile)
			if err != nil {
				return errors.New("cannot_read_data_file")
			}
			var object map[string]any
			if json.Unmarshal(data, &object) != nil || object == nil {
				return errors.New("data_file_must_contain_a_json_object")
			}
			b["data"] = object
		}
		path = "/api/work/" + id + "/update"
		method = "POST"
		body = b
	case "conversations":
		path = "/api/conversations"
	case "conversation-open":
		path = "/api/conversations"
		method = "POST"
		body = map[string]string{"address": target}
	case "say":
		text, err := a.text(arg)
		if err != nil {
			return err
		}
		b := map[string]string{"address": target, "text": text}
		if a.o.contextID != "" {
			b["contextId"] = a.o.contextID
		}
		if a.o.messageID != "" {
			b["messageId"] = a.o.messageID
		}
		path = "/api/messages"
		method = "POST"
		body = b
	case "contacts":
		path = "/api/contacts"
	case "contact-add":
		receive, execution := "ask", "ask"
		if a.o.receive {
			receive = "allow"
		}
		if a.o.execution {
			execution = "allow"
		}
		tags := a.o.tags
		if tags == nil {
			tags = []string{}
		}
		path = "/api/contacts"
		method = "POST"
		body = map[string]any{"address": target, "note": a.o.note, "tags": tags, "receive": receive, "execution": execution}
	case "contact-remove":
		path = "/api/contacts/" + id
		method = "DELETE"
	case "blocked":
		path = "/api/blocked"
	case "block", "unblock":
		path = "/api/blocked/" + id
		method = "POST"
		if command == "unblock" {
			method = "DELETE"
		}
	case "requests":
		path = "/api/requests"
	case "invites":
		path = "/api/invites"
	case "invite-accept", "invite-reject":
		action := "accept"
		if command == "invite-reject" {
			action = "reject"
		}
		path = "/api/invites/" + id + "/" + action
		method = "POST"
	case "approve", "reject":
		path = "/api/requests/" + id + "/" + command
		method = "POST"
	case "history":
		path = "/api/rooms/" + id + "/history"
		if a.o.from != "" {
			path += "?" + url.Values{"from": {a.o.from}}.Encode()
		}
	case "read":
		path = "/api/rooms/" + id + "/read"
		method = "POST"
		b := map[string]string{}
		if arg != "" {
			b["eventId"] = arg
		}
		body = b
	case "leave":
		path = "/api/rooms/" + id + "/leave"
		method = "POST"
	case "watch":
		return a.watch()
	case "send", "get", "list", "cancel":
		return a.taskCommand(command, target, arg)
	default:
		return errors.New("unknown_command")
	}
	return a.api(path, method, body, timeout)
}
func (a *app) watch() error {
	query := url.Values{}
	if a.o.since != "" {
		query.Set("since", a.o.since)
	}
	if a.o.room != "" {
		query.Set("room", a.o.room)
	}
	req, err := http.NewRequestWithContext(a.ctx, "GET", a.base+"/api/events?"+query.Encode(), nil)
	if err != nil {
		return errors.New("invalid_event_url")
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := a.http.Do(req)
	if err != nil {
		if a.ctx.Err() != nil {
			return nil
		}
		return errors.New("event_connection_failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("connector_http_%d", resp.StatusCode)
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		return errors.New("expected_event_stream")
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 4096), maxResponse)
	var parts []string
	emit := func() error {
		if len(parts) == 0 {
			return nil
		}
		data := strings.Join(parts, "\n")
		parts = nil
		if !json.Valid([]byte(data)) {
			return errors.New("invalid_event_json")
		}
		var compact strings.Builder
		var value json.RawMessage = []byte(data)
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		compact.Write(encoded)
		compact.WriteByte('\n')
		_, err = io.WriteString(a.out, compact.String())
		return err
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := emit(); err != nil {
				return err
			}
		} else if strings.HasPrefix(line, "data:") {
			parts = append(parts, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if a.ctx.Err() != nil {
		return nil
	}
	if err := scanner.Err(); err != nil {
		return errors.New("event_stream_read_failed")
	}
	return nil
}
func (a *app) connect() error {
	runtime := a.o.connectorRuntime
	if runtime == "" {
		runtime = os.Getenv("AGENT_ROUTER_CONNECTOR_ENTRY")
	}
	env := os.Environ()
	if a.o.profile != "" {
		filtered := env[:0]
		for _, value := range env {
			if !strings.HasPrefix(value, "MATRIX_PROFILE=") {
				filtered = append(filtered, value)
			}
		}
		env = append(filtered, "MATRIX_PROFILE="+a.o.profile)
	}
	if runtime != "" {
		absolute, err := filepath.Abs(runtime)
		if err != nil {
			return err
		}
		info, err := os.Stat(absolute)
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("connector_runtime_not_found")
		}
		node := os.Getenv("AGENT_ROUTER_NODE")
		if node == "" {
			node = "node"
		}
		program, err := exec.LookPath(node)
		if err != nil {
			return errors.New("connector_service_requires_node_24")
		}
		return syscall.Exec(program, []string{program, absolute}, env)
	}
	if program, err := exec.LookPath("agent-router-connector"); err == nil {
		return syscall.Exec(program, []string{program}, env)
	}
	return errors.New("connector_service_not_installed: install the separate connector package, or use --connector-runtime /path/to/dist/matrix/index.js (Node 24 required on the connector host)")
}
