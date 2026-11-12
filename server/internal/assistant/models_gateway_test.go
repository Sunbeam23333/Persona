package assistant

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nwverse/persona/server/internal/ai"
)

func TestChatGatewayImportProbeAndRuntimeAgree(t *testing.T) {
	for _, suffix := range []string{"/relay/chat/completions", "/v1/chat/completions"} {
		t.Run(suffix, func(t *testing.T) {
			var paths []string
			gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				paths = append(paths, r.URL.Path)
				if r.Header.Get("Authorization") != "Bearer "+fakeKey {
					t.Error("incorrect authentication")
				}
				fmt.Fprint(w, `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`)
			}))
			defer gw.Close()
			parsed := parsePaste(fmt.Sprintf(`curl %s%s -H 'Authorization: Bearer %s' -d '{"model":"test-model"}'`, gw.URL, suffix, fakeKey))
			if len(parsed.Drafts) != 1 {
				t.Fatalf("drafts=%+v", parsed)
			}
			p := parsed.Drafts[0].Provider
			s, _ := launcherTestService(t)
			out := s.providerTest(context.Background(), probeInput{API: p.API, BaseURL: p.BaseURL, APIKey: p.APIKey, Model: p.Model})
			if out["ok"] != true {
				t.Fatalf("probe=%v", out)
			}
			reply, err := ai.New(ai.Config{API: p.API, BaseURL: p.BaseURL, APIKey: p.APIKey, Model: p.Model}).Complete(context.Background(), "", "hello", 32)
			if err != nil || reply != "ok" || len(paths) != 2 || paths[0] != suffix || paths[1] != suffix {
				t.Fatalf("reply=%q err=%v paths=%v", reply, err, paths)
			}
		})
	}
}

func TestChatGatewayProbeRejectsInvalidJSONReply(t *testing.T) {
	for _, body := range []string{
		`{"error":{"message":"failed"}}`,
		`{"choices":[{"message":{"content":null,"tool_calls":[]},"finish_reason":"tool_calls"}]}`,
		`{"choices":[{"message":{"content":""},"finish_reason":"length"}]}`,
		`{"choices":[{"message":{"content":"partial"}}]}`,
	} {
		gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
		s, _ := launcherTestService(t)
		out := s.providerTest(context.Background(), probeInput{API: "chat", BaseURL: gw.URL + "/relay/chat/completions", Model: "test-model"})
		gw.Close()
		if out["ok"] != false {
			t.Fatalf("invalid reply passed: %v", out)
		}
	}
}

func TestGatewayExactEndpointDiscovery(t *testing.T) {
	for _, api := range []string{"chat", "responses"} {
		suffix := "/responses"
		if api == "chat" {
			suffix = "/chat/completions"
		}
		target := probeTarget{api: api, base: "https://gateway.example.com/relay" + suffix}
		if got := target.modelsEndpoint(); got != "https://gateway.example.com/relay/models" {
			t.Fatalf("%s models endpoint=%s", api, got)
		}
	}
}

func TestChatGatewayProbeRejectsResponseBeyondLimit(t *testing.T) {
	valid := `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`
	body := valid + strings.Repeat(" ", (8<<20)-len(valid)) + "x"
	if chatProbeCompleted(strings.NewReader(body)) {
		t.Fatal("probe hid trailing data beyond its response limit")
	}
}
