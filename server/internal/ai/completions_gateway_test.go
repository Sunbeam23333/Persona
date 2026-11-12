package ai

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChatCompletionsExactEndpointAndJSON(t *testing.T) {
	requests := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/relay/chat/completions" || r.Header.Get("Authorization") != "Bearer synthetic-key" {
			t.Errorf("unexpected request path or authentication")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"model":"returned-model","choices":[{"index":1,"message":{"content":"ignored"},"finish_reason":"stop"},{"index":0,"message":{"role":"assistant","content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":4}}}`)
	}))
	defer s.Close()
	reply, err := New(Config{API: "chat", BaseURL: s.URL + "/relay/chat/completions", APIKey: "synthetic-key", Model: "requested-model"}).Chat(context.Background(), Request{Messages: []Message{{RoleUser, "hello"}}, MaxTokens: 32})
	want := Reply{Text: "answer", Model: "returned-model", Usage: Usage{InputTokens: 8, OutputTokens: 3, CacheReadInputTokens: 4}}
	if err != nil || reply != want || requests != 1 {
		t.Fatalf("reply=%+v err=%v requests=%d", reply, err, requests)
	}
}

func TestGatewayExactResponsesEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/relay/responses" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\ndata: {\"type\":\"response.completed\"}\n\n")
	}))
	defer server.Close()
	text, err := New(Config{API: "responses", BaseURL: server.URL + "/relay/responses", APIKey: "synthetic-key", Model: "model"}).Complete(context.Background(), "", "hello", 32)
	if err != nil || text != "ok" {
		t.Fatalf("text=%q err=%v", text, err)
	}
}

func TestReadChatCompletionsJSONContract(t *testing.T) {
	for _, tc := range []struct {
		name, body             string
		ok, truncated, refused bool
	}{
		{"text", ` {"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`, true, false, false},
		{"null error", `{"error":null,"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`, true, false, false},
		{"partial text", `{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}`, true, true, false},
		{"truncated empty", `{"choices":[{"message":{"content":null},"finish_reason":"length"}]}`, true, true, false},
		{"error", `{"error":{"message":"failed"},"choices":[{"message":{"content":"misleading"},"finish_reason":"stop"}]}`, false, false, false},
		{"string error", `{"error":"failed"}`, false, false, false},
		{"empty", `{}`, false, false, false},
		{"empty content", `{"choices":[{"message":{"content":"  "},"finish_reason":"stop"}]}`, false, false, false},
		{"tool only", `{"choices":[{"message":{"content":null,"tool_calls":[{"id":"call-1"}]},"finish_reason":"tool_calls"}]}`, false, false, false},
		{"unfinished", `{"choices":[{"message":{"content":"partial"},"finish_reason":null}]}`, false, false, false},
		{"other choice", `{"choices":[{"index":1,"message":{"content":"other"},"finish_reason":"stop"}]}`, false, false, false},
		{"refusal", `{"choices":[{"message":{"content":null,"refusal":"no"},"finish_reason":"stop"}]}`, false, false, true},
		{"filter", `{"choices":[{"message":{"content":"blocked"},"finish_reason":"content_filter"}]}`, false, false, true},
		{"malformed", `{"choices":`, false, false, false},
		{"trailing data", `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]} {}`, false, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reply, err := ReadChatCompletions(strings.NewReader(tc.body))
			if (err == nil) != tc.ok || reply.Truncated != tc.truncated || errors.Is(err, ErrRefused) != tc.refused {
				t.Fatalf("reply=%+v err=%v", reply, err)
			}
		})
	}
}

func TestReadChatCompletionsResponseBounds(t *testing.T) {
	for _, body := range []string{
		strings.Repeat(" ", 8<<20),
		`{"padding":"` + strings.Repeat("x", 8<<20) + `","choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`,
	} {
		if _, err := ReadChatCompletions(strings.NewReader(body)); err == nil {
			t.Fatal("oversized response accepted")
		}
	}
	_, err := ReadChatCompletions(io.MultiReader(strings.NewReader(`{"choices":`), failingReader{}))
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("read failure lost: %v", err)
	}
}
