package hub

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/nwverse/persona/server/internal/db"
	"github.com/nwverse/persona/server/internal/proto"
	"github.com/nwverse/persona/server/internal/rpc"
)

func TestFileTextRelay(t *testing.T) {
	mux := fileEditHub(t, func(method string, params map[string]any) (any, error) {
		if method != "file.text" || params["path"] != "a.txt" || params["cwd"] != "/project" || params["text"] != "" || params["revision"] != "r1" {
			t.Fatalf("unexpected relay: %s %v", method, params)
		}
		return proto.FileTextEditResult{Revision: "r2"}, nil
	})
	status, out := postEdit(mux, "text", `{"path":"a.txt","cwd":"/project","text":"","revision":"r1"}`)
	if status != 200 || out["revision"] != "r2" {
		t.Fatalf("status=%d result=%v", status, out)
	}
}

func TestFileTextRelayRejectsInvalidRequests(t *testing.T) {
	mux := fileEditHub(t, func(string, map[string]any) (any, error) { t.Error("invalid request reached node"); return nil, nil })
	for _, body := range []string{
		`{}`, `{"path":"a","text":"new"}`, `{"path":"a","revision":"r1"}`,
		`{"path":"a","text":null,"revision":"r1"}`,
		`{"path":"a","text":"a\u0000b","revision":"r1"}`,
		"{\"path\":\"a\",\"text\":\"\xff\",\"revision\":\"r1\"}",
		`{"path":"a","text":"new","revision":"r1"} {}`,
	} {
		if status, _ := postEdit(mux, "text", body); status != 400 {
			t.Errorf("invalid request status=%d", status)
		}
	}
	body, _ := json.Marshal(map[string]string{"path": "a", "text": strings.Repeat("x", proto.MaxFileTextBytes+1), "revision": "r1"})
	if status, out := postEdit(mux, "text", string(body)); status != 413 || out["code"] != proto.CodeTooLarge {
		t.Fatalf("oversized: %d %v", status, out)
	}
}

func TestFileTextRelayErrors(t *testing.T) {
	var failure error
	mux := fileEditHub(t, func(string, map[string]any) (any, error) { return nil, failure })
	for _, tc := range []struct {
		failure error
		status  int
		code    string
	}{
		{&rpc.Error{Code: proto.CodeFileChanged, Message: "changed"}, 409, proto.CodeFileChanged},
		{&rpc.Error{Code: proto.CodeReadOnly, Message: "read only"}, 409, proto.CodeReadOnly},
		{&rpc.Error{Code: proto.CodeNotFound, Message: "missing"}, 404, proto.CodeNotFound},
		{&rpc.Error{Code: proto.CodeTooLarge, Message: "too large"}, 413, proto.CodeTooLarge},
		{&rpc.Error{Code: "bad_request", Message: "not text"}, 400, "bad_request"},
		{errors.New("unknown method file.text"), 409, proto.CodeNodeOutdated},
	} {
		failure = tc.failure
		status, out := postEdit(mux, "text", `{"path":"a","text":"new","revision":"r1"}`)
		if status != tc.status || out["code"] != tc.code {
			t.Errorf("failure=%v status=%d output=%v", failure, status, out)
		}
	}
}

func TestFileTextEditRequiresFullAuthentication(t *testing.T) {
	h := newTestHub(t)
	h.store = &tokenStore{memStore: *newMemStore(), rows: map[string]db.DeviceToken{}, rev: map[string]bool{}}
	mux := h.routes()
	status, watch := call(t, mux, http.MethodPost, "/api/v1/auth/tokens", h.cfg.Token, `{"name":"watch","kind":"watch"}`)
	if status != 200 {
		t.Fatalf("watch token: %d %v", status, watch)
	}
	path := "/api/v1/machines/unknown/files/text"
	for _, tc := range []struct {
		token  string
		status int
	}{{"", 401}, {"not-a-token", 401}, {watch["token"].(string), 403}, {h.cfg.Token, 404}} {
		if status, _ := call(t, mux, http.MethodPost, path, tc.token, `{}`); status != tc.status {
			t.Errorf("auth status=%d want=%d", status, tc.status)
		}
	}
}
