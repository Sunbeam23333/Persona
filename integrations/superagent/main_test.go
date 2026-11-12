package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/nwverse/persona/sdk/go/ext"
	"github.com/nwverse/persona/sdk/go/exttest"
	"github.com/nwverse/persona/sdk/go/wire"
)

//go:embed l10n/*.json
var localeFiles embed.FS

func TestConformance(t *testing.T) {
	exttest.Check(t, manifest, exttest.Serve(t, program(false)))
}

func TestManifestAndConfiguration(t *testing.T) {
	var m wire.Manifest
	if err := json.Unmarshal(manifest, &m); err != nil {
		t.Fatal(err)
	}
	if m.Node == nil || m.Node.Machines != "machines" || len(m.Node.Args) != 1 || m.Node.Args[0] != "--node" ||
		m.Node.HTTP || m.Node.Permissions.Files || m.Node.Permissions.MacosPrivacy || len(m.Node.Secrets) != 0 ||
		len(m.Node.Permissions.Network) != 1 || m.Node.Permissions.Network[0] != "127.0.0.1" {
		t.Fatal("node must be least-privilege stdio")
	}
	if m.Permissions != nil {
		t.Fatal("hub must not request network or secrets")
	}
	if len(m.Contributes.UI) != 1 || m.Contributes.UI[0].Placement != "nav_page" {
		t.Fatal("missing standard extension UI")
	}
	for _, raw := range []string{`{"port":0}`, `{"port":65536}`, `{"machines":["one","two"]}`, `{"machines":["../../x"]}`, `{"port":"3082"}`} {
		p := program(false)
		_, err := p.Init(context.Background(), &ext.Init{InitializeParams: wire.InitializeParams{Config: json.RawMessage(raw)}}, nil)
		if err == nil {
			t.Fatalf("accepted invalid config %s", raw)
		}
	}
}

func startUI(t *testing.T, allow bool) *exttest.Host {
	t.Helper()
	config, _ := json.Marshal(map[string]any{"machines": []string{"computer-1"}, "port": 3082, "allow_control": allow})
	return exttest.Start(t, manifest, exttest.Serve(t, program(false)), config)
}

func uiParams(locale string) wire.UIParams {
	return wire.UIParams{Contribution: "supervisor", Placement: "nav_page", Size: "full", UIVersion: 6, Locale: locale, Platform: "web"}
}

func TestHubNodeRoundTripAndLocales(t *testing.T) {
	for _, locale := range []string{"en-US", "zh-Hans-CN", "ja-JP"} {
		t.Run(locale, func(t *testing.T) {
			h := startUI(t, true)
			var controls int
			h.Answer("nodes.call", func(raw json.RawMessage) (any, error) {
				var req struct {
					Machine, Method string
					Params          json.RawMessage
				}
				if json.Unmarshal(raw, &req) != nil || req.Machine != "computer-1" {
					t.Fatal("wrong selected node")
				}
				switch req.Method {
				case "supervisor.query":
					var q queryParams
					_ = json.Unmarshal(req.Params, &q)
					item := ticket{ID: "ticket-1", Title: "Review changes", Stage: "person", Action: "failed", CanRetry: true, CanStop: true}
					if q.Kind == "ticket" {
						return item, nil
					}
					return dashboard{Status: status{Running: 1, MaxWorkers: 4}, Items: []ticket{item}, Total: 1}, nil
				case "supervisor.control":
					var c controlParams
					_ = json.Unmarshal(req.Params, &c)
					if c.Operation != "retry" || c.ID != "ticket-1" {
						t.Fatal("wrong control DTO")
					}
					controls++
					return map[string]bool{"ok": true}, nil
				default:
					t.Fatalf("unexpected hub callback %s", req.Method)
					return nil, nil
				}
			})
			p := uiParams(locale)
			var view wire.View
			if err := h.Call("ui.render", p, &view); err != nil {
				t.Fatal(err)
			}
			checkView(t, view)
			if view.Title != translate(locale)("title") {
				t.Fatal("wrong locale", view.Title)
			}
			if !hasAction(view, "pause", true) {
				t.Fatal("pause must be confirmed")
			}
			p.State, p.Action = view.State, "open:ticket-1"
			var result wire.ActionResult
			if err := h.Call("ui.action", p, &result); err != nil || result.View == nil {
				t.Fatalf("open: %v %+v", err, result)
			}
			checkView(t, *result.View)
			if !hasAction(*result.View, "retry", true) || !hasAction(*result.View, "stop", true) {
				t.Fatal("ticket controls must be confirmed")
			}
			p.State, p.Action = result.View.State, "retry"
			if err := h.Call("ui.action", p, &result); err != nil || controls != 1 {
				t.Fatalf("retry: %v", err)
			}
			if result.Toast != translate(locale)("accepted") {
				t.Fatal("unlocalized result")
			}
		})
	}
}

func checkView(t *testing.T, v wire.View) {
	t.Helper()
	raw, _ := json.Marshal(v)
	if err := exttest.CheckView(raw, false); err != nil {
		t.Fatal(err)
	}
}

func hasAction(v wire.View, id string, confirmed bool) bool {
	for _, s := range v.Sections {
		for _, c := range s.Items {
			if c.Action != nil && c.Action.ID == id {
				return !confirmed || c.Action.Confirm != ""
			}
		}
	}
	return false
}

func TestReadOnlyUIAndErrorPrivacy(t *testing.T) {
	h := startUI(t, false)
	var called []string
	h.Answer("nodes.call", func(raw json.RawMessage) (any, error) {
		var r struct{ Method string }
		_ = json.Unmarshal(raw, &r)
		called = append(called, r.Method)
		return dashboard{Status: status{MaxWorkers: 4}, Items: []ticket{}, Total: 0}, nil
	})
	p := uiParams("zh-Hans")
	var view wire.View
	if err := h.Call("ui.render", p, &view); err != nil {
		t.Fatal(err)
	}
	if hasAction(view, "pause", false) {
		t.Fatal("read-only control shown")
	}
	p.Action = "pause"
	var result wire.ActionResult
	if err := h.Call("ui.action", p, &result); err != nil || len(called) != 1 || result.Toast != translate(p.Locale)("readonly") {
		t.Fatal("forged control reached node", err)
	}
	h.Answer("nodes.call", func(json.RawMessage) (any, error) { return nil, errors.New("TOKEN_DO_NOT_EXPOSE") })
	p.Action = ""
	view = wire.View{}
	if err := h.Call("ui.render", p, &view); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(view)
	if strings.Contains(string(raw), "TOKEN") || view.RefreshAfter != 0 {
		t.Fatal("upstream error leaked or retried on a timer")
	}
	if !strings.Contains(string(raw), translate(p.Locale)("unavailable")) {
		t.Fatal("missing localized explanation")
	}
}

func TestNodeProgramRegistration(t *testing.T) {
	p := program(true)
	if len(p.UI) != 0 || p.Namespaces["supervisor"] == nil {
		t.Fatal("node role not registered correctly")
	}
	h := exttest.Start(t, manifest, exttest.Serve(t, p))
	if len(h.Init.Contributes) != 0 {
		t.Fatal("node advertised hub UI")
	}
	if err := h.Call("supervisor.control", controlParams{Operation: "pause"}, nil); err == nil {
		t.Fatal("default node permits control")
	}
	if err := h.Call("supervisor.query", map[string]any{"kind": "ticket", "id": "../settings"}, nil); err == nil {
		t.Fatal("node protocol bypassed target validation")
	}
}

func TestTranslationCompleteness(t *testing.T) {
	for key, values := range messages {
		for _, value := range values {
			if strings.TrimSpace(value) == "" {
				t.Fatal("missing translation", key)
			}
		}
	}
	for _, locale := range []string{"en", "zh-Hans", "ja"} {
		raw, err := localeFiles.ReadFile("l10n/" + locale + ".json")
		if err != nil || !json.Valid(raw) {
			t.Fatal("invalid manifest translation", locale, err)
		}
	}
}
