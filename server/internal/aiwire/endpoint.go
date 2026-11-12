package aiwire

import "strings"

// Endpoint preserves ordinary deployment bases and explicit OpenAI-compatible request URLs.
// An explicit request URL also gives discovery its sibling models path, without inserting /v1.
func Endpoint(base, path string) string {
	base = strings.TrimRight(base, "/")
	for _, requestPath := range []string{"chat/completions", "responses"} {
		if strings.HasSuffix(base, "/"+requestPath) {
			if path == requestPath {
				return base
			}
			if path == "models" {
				return strings.TrimSuffix(base, requestPath) + path
			}
		}
	}
	if !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	return base + "/" + path
}
