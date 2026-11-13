package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/nwverse/persona/sdk/go/ext"
)

const responseLimit = 8 << 20
const pageSize = 20

var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

func validID(s string) bool { return idPattern.MatchString(s) }

// Fault messages contain no upstream text, URLs, response bodies or transport errors.
func fault(code string) error {
	return &ext.Error{Code: code, Message: "Supervisor request failed (" + code + ")."}
}

type supervisor struct {
	port         int
	allowControl bool
	http         *http.Client
}

func newSupervisor(port int, allow bool) *supervisor {
	return &supervisor{port: port, allowControl: allow, http: &http.Client{
		Timeout:       8 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") },
		Transport: &http.Transport{
			Proxy: nil, DisableCompression: true,
			DialContext:           (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
			ResponseHeaderTimeout: 5 * time.Second, MaxResponseHeaderBytes: 32 << 10,
			MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second,
		},
	}}
}

// request is internal: callers cannot supply a URL, host, port, headers or arbitrary route.
// No application retry is performed, including when a write's outcome is ambiguous.
func (s *supervisor) request(ctx context.Context, method, route string, body any, out any) error {
	if s.port < 1 || s.port > 65535 {
		return fault("invalid_config")
	}
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	url := "http://127.0.0.1:" + strconv.Itoa(s.port) + "/orchestrator/api/" + route
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(data))
	if err != nil {
		return fault("invalid_request")
	}
	req.Header.Set("X-Orchestrator-Request", "1")
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := s.http.Do(req)
	if err != nil {
		return fault("unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fault("upstream_status")
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, responseLimit+1))
	if err != nil || len(raw) > responseLimit {
		return fault("invalid_response")
	}
	if json.Unmarshal(raw, out) != nil {
		return fault("invalid_response")
	}
	return nil
}

// These DTOs are the only values allowed across the node -> hub boundary.
// Raw setup, accounts, health errors, environment, prompts and transcripts never leave the node.
type status struct {
	Paused     bool `json:"paused"`
	Running    int  `json:"running"`
	Queued     int  `json:"queued"`
	MaxWorkers int  `json:"max_workers"`
}

type ticket struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	State       string `json:"state"`
	Stage       string `json:"stage"`
	Action      string `json:"action,omitempty"`
	CreatedAt   string `json:"created_at,omitempty"`
	UpdatedAt   string `json:"updated_at,omitempty"`
	Assignments int    `json:"assignments"`
	Inputs      int    `json:"inputs"`
	Undelivered int    `json:"undelivered"`
	CanRetry    bool   `json:"can_retry"`
	CanStop     bool   `json:"can_stop"`
}

type dashboard struct {
	Status status   `json:"status"`
	Items  []ticket `json:"items"`
	Total  int      `json:"total"`
	Next   *int     `json:"next,omitempty"`
}

type rawTicket struct {
	ID, Title, State, Stage, Action string
	CreatedAt, UpdatedAt            string
	Assignments, Inputs             json.RawMessage
	Undelivered                     *int
	Actions                         *struct{ Retry, Stop bool }
}

func count(raw json.RawMessage) (int, bool) {
	var n int
	if json.Unmarshal(raw, &n) == nil && string(raw) != "null" && n >= 0 {
		return n, true
	}
	var rows []json.RawMessage
	if json.Unmarshal(raw, &rows) == nil && rows != nil {
		return len(rows), true
	}
	return 0, false
}

func textLimit(s string, max int) string {
	r := []rune(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s))
	if len(r) > max {
		r = r[:max]
	}
	return string(r)
}

func timestamp(s string) string {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func projectTicket(raw rawTicket) (ticket, error) {
	a, okA := count(raw.Assignments)
	i, okI := count(raw.Inputs)
	if !validID(raw.ID) || raw.Title == "" || !oneOf(raw.State, "open", "ended") ||
		!oneOf(raw.Stage, "person", "working", "idle", "ended") ||
		!oneOf(raw.Action, "", "delivery", "answer", "review", "blocked", "failed", "queued") ||
		!okA || !okI || raw.Undelivered == nil || *raw.Undelivered < 0 || raw.Actions == nil {
		return ticket{}, fault("invalid_response")
	}
	return ticket{ID: raw.ID, Title: textLimit(raw.Title, 200), State: raw.State, Stage: raw.Stage,
		Action: raw.Action, CreatedAt: timestamp(raw.CreatedAt), UpdatedAt: timestamp(raw.UpdatedAt),
		Assignments: a, Inputs: i, Undelivered: *raw.Undelivered, CanRetry: raw.Actions.Retry, CanStop: raw.Actions.Stop}, nil
}

func oneOf(s string, options ...string) bool {
	for _, v := range options {
		if s == v {
			return true
		}
	}
	return false
}

func (s *supervisor) state(ctx context.Context) (status, error) {
	var raw struct {
		Paused *bool
		Load   *struct{ Running, Queued, MaxWorkers *int }
	}
	if err := s.request(ctx, "GET", "state", nil, &raw); err != nil {
		return status{}, err
	}
	if raw.Paused == nil || raw.Load == nil || raw.Load.Running == nil || raw.Load.Queued == nil ||
		raw.Load.MaxWorkers == nil || *raw.Load.Running < 0 || *raw.Load.Queued < 0 || *raw.Load.MaxWorkers < 1 {
		return status{}, fault("invalid_response")
	}
	return status{*raw.Paused, *raw.Load.Running, *raw.Load.Queued, *raw.Load.MaxWorkers}, nil
}

func (s *supervisor) list(ctx context.Context, filter string, offset int) (dashboard, error) {
	if !oneOf(filter, "open", "person", "working", "idle", "ended") || offset < 0 || offset > 1000000 {
		return dashboard{}, fault("invalid_request")
	}
	st, err := s.state(ctx)
	if err != nil {
		return dashboard{}, err
	}
	var raw struct {
		Items []rawTicket `json:"items"`
		Total *int        `json:"total"`
		Next  *int        `json:"next_offset"`
	}
	route := fmt.Sprintf("tickets?state=%s&offset=%d&limit=%d", filter, offset, pageSize)
	if err := s.request(ctx, "GET", route, nil, &raw); err != nil {
		return dashboard{}, err
	}
	if raw.Items == nil || len(raw.Items) > pageSize || raw.Total == nil || *raw.Total < 0 ||
		(raw.Next != nil && (*raw.Next != offset+pageSize || *raw.Next > 1000000)) {
		return dashboard{}, fault("invalid_response")
	}
	out := dashboard{Status: st, Items: []ticket{}, Total: *raw.Total, Next: raw.Next}
	for _, item := range raw.Items {
		t, err := projectTicket(item)
		if err != nil {
			return dashboard{}, err
		}
		out.Items = append(out.Items, t)
	}
	return out, nil
}

func (s *supervisor) detail(ctx context.Context, id string) (ticket, error) {
	if !validID(id) {
		return ticket{}, fault("invalid_request")
	}
	var raw rawTicket
	if err := s.request(ctx, "GET", "tickets/"+id, nil, &raw); err != nil {
		return ticket{}, err
	}
	if raw.ID != id {
		return ticket{}, fault("invalid_response")
	}
	return projectTicket(raw)
}

func (s *supervisor) control(ctx context.Context, op, id string) error {
	if !s.allowControl {
		return fault("control_disabled")
	}
	if !oneOf(op, "retry", "stop", "pause", "resume") {
		return fault("invalid_request")
	}
	if op == "retry" || op == "stop" {
		t, err := s.detail(ctx, id)
		if err != nil {
			return err
		}
		if (op == "retry" && !t.CanRetry) || (op == "stop" && !t.CanStop) {
			return fault("not_allowed")
		}
		var out struct{ Retried, Stopped *bool }
		if err := s.request(ctx, "POST", "tickets/"+id+"/"+op, nil, &out); err != nil {
			return err
		}
		if (op == "retry" && (out.Retried == nil || !*out.Retried)) ||
			(op == "stop" && (out.Stopped == nil || !*out.Stopped)) {
			return fault("invalid_response")
		}
		return nil
	}
	if id != "" {
		return fault("invalid_request")
	}
	var out struct{ Paused *bool }
	if err := s.request(ctx, "POST", "executor/pause", map[string]bool{"paused": op == "pause"}, &out); err != nil {
		return err
	}
	if out.Paused == nil || *out.Paused != (op == "pause") {
		return fault("invalid_response")
	}
	return nil
}

type queryParams struct {
	Kind   string `json:"kind"`
	ID     string `json:"id,omitempty"`
	Filter string `json:"filter,omitempty"`
	Offset int    `json:"offset,omitempty"`
}

type controlParams struct {
	Operation string `json:"operation"`
	ID        string `json:"id,omitempty"`
}

func decodeParams(raw json.RawMessage, out any) error {
	if len(raw) == 0 || len(raw) > 8192 || raw[0] != '{' {
		return fault("invalid_request")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil {
		return fault("invalid_request")
	}
	return nil
}

func (a *app) handle(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	switch method {
	case "query":
		var p queryParams
		if err := decodeParams(raw, &p); err != nil {
			return nil, err
		}
		switch p.Kind {
		case "dashboard":
			if p.ID != "" {
				return nil, fault("invalid_request")
			}
			return a.client.list(ctx, p.Filter, p.Offset)
		case "ticket":
			if p.Filter != "" || p.Offset != 0 {
				return nil, fault("invalid_request")
			}
			return a.client.detail(ctx, p.ID)
		default:
			return nil, fault("invalid_request")
		}
	case "control":
		var p controlParams
		if err := decodeParams(raw, &p); err != nil {
			return nil, err
		}
		if err := a.client.control(ctx, p.Operation, p.ID); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	default:
		return nil, ext.UnknownMethod("supervisor." + method)
	}
}
