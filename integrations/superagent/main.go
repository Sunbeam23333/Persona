package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"os"

	"github.com/nwverse/persona/sdk/go/ext"
)

//go:embed persona-extension.json
var manifest json.RawMessage

type config struct {
	Machines     []string `json:"machines"`
	Port         int      `json:"port"`
	AllowControl bool     `json:"allow_control"`
}

type app struct {
	cfg    config
	client *supervisor
}

func program(node bool) ext.Program {
	a := &app{}
	p := ext.Program{ID: "dsh-supervisor", Version: "0.1.0", Manifest: manifest}
	p.Init = func(_ context.Context, init *ext.Init, _ *ext.Hub) (map[string]any, error) {
		a.cfg = config{Port: 3082}
		if err := init.Config(&a.cfg); err != nil || a.cfg.Port < 1 || a.cfg.Port > 65535 || len(a.cfg.Machines) > 1 {
			return nil, fault("invalid_config")
		}
		for _, id := range a.cfg.Machines {
			if !validID(id) {
				return nil, fault("invalid_config")
			}
		}
		if node {
			a.client = newSupervisor(a.cfg.Port, a.cfg.AllowControl)
			return map[string]any{}, nil
		}
		return nil, nil
	}
	if node {
		p.Namespaces = map[string]ext.Handler{"supervisor": a.handle}
	} else {
		p.UI = map[string]ext.Page{"supervisor": {Render: a.render, Action: a.action}}
	}
	return p
}

func main() {
	if len(os.Args) > 2 || (len(os.Args) == 2 && os.Args[1] != "--node" && os.Args[1] != "manifest") {
		os.Exit(2)
	}
	ext.Main(program(len(os.Args) == 2 && os.Args[1] == "--node"))
}
