package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const stateFixture = `{"paused":false,"load":{"running":1,"queued":2,"maxWorkers":4},"setup":{"accounts":{"agent":"DO_NOT_EXPOSE"}},"health":{"error":"DO_NOT_EXPOSE"}}`
const ticketFixture = `{"id":"ticket-1","title":"Review changes","state":"open","stage":"person","action":"failed","assignments":2,"inputs":3,"undelivered":1,"actions":{"retry":true,"stop":true},"createdAt":"2026-11-12T01:00:00Z","updatedAt":"2026-11-12T02:00:00Z","environment":[{"value":"DO_NOT_EXPOSE"}],"summary":"DO_NOT_EXPOSE","deliveryError":"DO_NOT_EXPOSE"}`

func testServer(t *testing.T, allow bool, handler http.HandlerFunc) *supervisor {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	return newSupervisor(port, allow)
}

func writeJSON(w http.ResponseWriter, value string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = fmt.Fprint(w, value)
}

func TestProjectionAndRoutes(t *testing.T) {
	var paths []string
	s := testServer(t, false, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.RequestURI())
		if r.Method != "GET" || r.Header.Get("X-Orchestrator-Request") != "1" ||
			r.Header.Get("Origin") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" ||
			!strings.HasPrefix(r.Host, "127.0.0.1:") {
			t.Error("unsafe request metadata")
		}
		switch r.URL.Path {
		case "/orchestrator/api/state":
			writeJSON(w, stateFixture)
		case "/orchestrator/api/tickets":
			writeJSON(w, `{"items":[`+ticketFixture+`],"total":1,"next_offset":null}`)
		case "/orchestrator/api/tickets/ticket-1":
			detail := strings.ReplaceAll(ticketFixture, `"assignments":2,"inputs":3`, `"assignments":[{"secret":"DO_NOT_EXPOSE"}],"inputs":[]`)
			writeJSON(w, detail)
		default:
			t.Errorf("unexpected route %s", r.URL.Path)
		}
	})
	ctx := context.Background()
	d, err := s.list(ctx, "person", 20)
	if err != nil {
		t.Fatal(err)
	}
	if d.Status.Running != 1 || d.Status.Queued != 2 || d.Status.MaxWorkers != 4 || len(d.Items) != 1 || d.Items[0].Assignments != 2 {
		t.Fatalf("wrong projection: %+v", d)
	}
	if paths[1] != "/orchestrator/api/tickets?state=person&offset=20&limit=20" {
		t.Fatal(paths)
	}
	item, err := s.detail(ctx, "ticket-1")
	if err != nil || item.Assignments != 1 || item.Inputs != 0 {
		t.Fatalf("detail array projection: %+v %v", item, err)
	}
	for _, v := range []any{d, item} {
		raw, _ := json.Marshal(v)
		if strings.Contains(string(raw), "DO_NOT_EXPOSE") || strings.Contains(string(raw), "environment") {
			t.Fatal("private upstream data left the node")
		}
	}
}

func TestControlDisabledAndTargetValidation(t *testing.T) {
	var hits atomic.Int32
	s := testServer(t, false, func(w http.ResponseWriter, _ *http.Request) { hits.Add(1); writeJSON(w, ticketFixture) })
	ctx := context.Background()
	for _, op := range []string{"retry", "stop", "pause", "resume"} {
		if err := s.control(ctx, op, "ticket-1"); err == nil {
			t.Fatalf("allowed disabled %s", op)
		}
	}
	s.allowControl = true
	for _, id := range []string{"", "../state", "x/y", "x?y", "https://example.com", "x%2Fy", "x\nheader", strings.Repeat("a", 129)} {
		if _, err := s.detail(ctx, id); err == nil {
			t.Fatalf("allowed id %q", id)
		}
	}
	if err := s.control(ctx, "settings", ""); err == nil {
		t.Fatal("unknown operation allowed")
	}
	if err := s.control(ctx, "pause", "unneeded-id"); err == nil {
		t.Fatal("unexpected target allowed")
	}
	for _, f := range []string{"", "all", "open&url=https://example.com"} {
		if _, err := s.list(ctx, f, 0); err == nil {
			t.Fatalf("allowed filter %q", f)
		}
	}
	for _, port := range []int{-1, 0, 65536} {
		if _, err := newSupervisor(port, false).state(ctx); err == nil {
			t.Fatalf("allowed port %d", port)
		}
	}
	if hits.Load() != 0 {
		t.Fatal("invalid/disabled request reached HTTP")
	}
}

func TestControlRoutesNoAutomaticRetry(t *testing.T) {
	var posts []string
	var paused []bool
	s := testServer(t, true, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			writeJSON(w, ticketFixture)
			return
		}
		posts = append(posts, r.URL.Path)
		switch r.URL.Path {
		case "/orchestrator/api/tickets/ticket-1/retry":
			writeJSON(w, `{"retried":true}`)
		case "/orchestrator/api/tickets/ticket-1/stop":
			writeJSON(w, `{"stopped":true}`)
		case "/orchestrator/api/executor/pause":
			var value map[string]bool
			if json.NewDecoder(r.Body).Decode(&value) != nil {
				t.Error("bad pause body")
			}
			paused = append(paused, value["paused"])
			_ = json.NewEncoder(w).Encode(value)
		default:
			t.Errorf("unexpected control route %s", r.URL.Path)
		}
	})
	for _, op := range []string{"retry", "stop", "pause", "resume"} {
		id := ""
		if op == "retry" || op == "stop" {
			id = "ticket-1"
		}
		if err := s.control(context.Background(), op, id); err != nil {
			t.Fatal(err)
		}
	}
	if len(posts) != 4 || len(paused) != 2 || !paused[0] || paused[1] {
		t.Fatalf("wrong writes %v %v", posts, paused)
	}
	var failures atomic.Int32
	failed := testServer(t, true, func(w http.ResponseWriter, r *http.Request) {
		failures.Add(1)
		w.WriteHeader(500)
		writeJSON(w, `{"error":"TOKEN_DO_NOT_EXPOSE"}`)
	})
	err := failed.control(context.Background(), "pause", "")
	if err == nil || strings.Contains(err.Error(), "TOKEN") || failures.Load() != 1 {
		t.Fatalf("unsafe failed write: %v calls %d", err, failures.Load())
	}
}

func TestRedirectSizeTimeoutAndShape(t *testing.T) {
	var reached atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Store(true) }))
	defer target.Close()
	s := testServer(t, false, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL+"/secret", 302) })
	if _, err := s.state(context.Background()); err == nil || reached.Load() {
		t.Fatal("followed redirect")
	}
	large := testServer(t, false, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, `{"pad":"`+strings.Repeat("x", responseLimit)+`"}`)
	})
	if _, err := large.state(context.Background()); err == nil {
		t.Fatal("accepted oversized response")
	}
	for _, raw := range []string{`{}`, `null`, `{"paused":false,"load":{"running":0,"queued":-1,"maxWorkers":2}}`, `{"paused":false,"load":{"running":0,"queued":0}}`, `{"error":"SECRET"}`, `[]`} {
		bad := testServer(t, false, func(w http.ResponseWriter, r *http.Request) { writeJSON(w, raw) })
		if _, err := bad.state(context.Background()); err == nil {
			t.Fatalf("accepted shape %s", raw)
		}
	}
	slow := testServer(t, false, func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
	slow.http.Timeout = 20 * time.Millisecond
	if _, err := slow.state(context.Background()); err == nil {
		t.Fatal("timeout missing")
	}
	var raw rawTicket
	_ = json.Unmarshal([]byte(ticketFixture), &raw)
	raw.Stage = "new-status"
	if _, err := projectTicket(raw); err == nil {
		t.Fatal("silently mapped unknown stage")
	}
	if _, ok := count(json.RawMessage(`null`)); ok {
		t.Fatal("null accepted as count")
	}
}

func TestNodeControllerDispatch(t *testing.T) {
	var posts atomic.Int32
	s := testServer(t, true, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts.Add(1)
			writeJSON(w, `{"paused":true}`)
			return
		}
		writeJSON(w, ticketFixture)
	})
	a := &app{client: s}
	ctx := context.Background()
	out, err := a.handle(ctx, "query", json.RawMessage(`{"kind":"ticket","id":"ticket-1"}`))
	if err != nil || out.(ticket).ID != "ticket-1" {
		t.Fatalf("query controller: %v %v", out, err)
	}
	if _, err := a.handle(ctx, "control", json.RawMessage(`{"operation":"pause"}`)); err != nil || posts.Load() != 1 {
		t.Fatal("control not dispatched", err)
	}
	for _, raw := range []string{`{"kind":"url","url":"https://example.com"}`, `{"kind":"ticket","id":"../settings"}`, `{"kind":"ticket","id":"ticket-1","port":9}`, `null`, `{}`} {
		if _, err := a.handle(ctx, "query", json.RawMessage(raw)); err == nil {
			t.Fatalf("allowed query %s", raw)
		}
	}
	for _, raw := range []string{`{"operation":"create"}`, `{"operation":"pause","allow_control":true}`, `{"operation":"send","id":"ticket-1"}`} {
		if _, err := a.handle(ctx, "control", json.RawMessage(raw)); err == nil {
			t.Fatalf("allowed control %s", raw)
		}
	}
	s.allowControl = false
	if _, err := a.handle(ctx, "control", json.RawMessage(`{"operation":"pause"}`)); err == nil || posts.Load() != 1 {
		t.Fatal("node did not independently deny disabled write")
	}
	if _, err := a.handle(ctx, "unknown", json.RawMessage(`{}`)); err == nil {
		t.Fatal("unknown method accepted")
	}
}
