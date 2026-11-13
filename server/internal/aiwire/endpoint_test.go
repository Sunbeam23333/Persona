package aiwire

import "testing"

func TestEndpoint(t *testing.T) {
	for _, tc := range []struct{ base, path, want string }{
		{"https://api.example.com", "chat/completions", "https://api.example.com/v1/chat/completions"},
		{"https://api.example.com/team/v1/", "responses", "https://api.example.com/team/v1/responses"},
		{"https://api.example.com/team", "messages", "https://api.example.com/team/v1/messages"},
		{"https://api.example.com/relay/chat/completions/", "chat/completions", "https://api.example.com/relay/chat/completions"},
		{"https://api.example.com/relay/chat/completions", "models", "https://api.example.com/relay/models"},
		{"https://api.example.com/v1/chat/completions", "models", "https://api.example.com/v1/models"},
		{"https://api.example.com/relay/responses", "responses", "https://api.example.com/relay/responses"},
		{"https://api.example.com/relay/responses", "models", "https://api.example.com/relay/models"},
		{"https://api.example.com/chat/completions-extra", "chat/completions", "https://api.example.com/chat/completions-extra/v1/chat/completions"},
	} {
		t.Run(tc.base+"/"+tc.path, func(t *testing.T) {
			if got := Endpoint(tc.base, tc.path); got != tc.want {
				t.Fatalf("Endpoint = %q, want %q", got, tc.want)
			}
		})
	}
}
