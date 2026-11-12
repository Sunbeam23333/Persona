package main

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/nwverse/persona/sdk/go/ext"
	"github.com/nwverse/persona/sdk/go/wire"
)

type pageState struct {
	Filter string `json:"filter"`
	Offset int    `json:"offset,omitempty"`
	ID     string `json:"id,omitempty"`
}

func readPage(r *ext.UIRequest) (pageState, error) {
	s := pageState{Filter: "open"}
	if err := r.DecodeState(&s); err != nil || len(r.State) > 8192 ||
		!oneOf(s.Filter, "open", "person", "working", "idle", "ended") ||
		s.Offset < 0 || s.Offset > 1000000 || (s.ID != "" && !validID(s.ID)) {
		return s, fault("invalid_request")
	}
	return s, nil
}

func (a *app) callNode(ctx context.Context, r *ext.UIRequest, method string, params, out any) error {
	if len(a.cfg.Machines) != 1 || r.Hub == nil {
		return fault("not_configured")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return r.Hub.Call(ctx, "nodes.call", struct {
		Machine string `json:"machine"`
		Method  string `json:"method"`
		Params  any    `json:"params"`
	}{a.cfg.Machines[0], "supervisor." + method, params}, out)
}

func button(title, action, confirm string) wire.Component {
	return wire.Component{Type: wire.ComponentButton, Title: title, Action: &wire.Action{ID: action, Confirm: confirm}}
}

func row(title, value string) wire.Component {
	return wire.Component{Type: wire.ComponentRow, Title: title, Subtitle: value}
}

func (a *app) render(ctx context.Context, r *ext.UIRequest) (*wire.View, error) {
	t := translate(r.Locale)
	s, err := readPage(r)
	if err != nil {
		return notice(t, "invalid"), nil
	}
	if len(a.cfg.Machines) != 1 {
		return notice(t, "setup"), nil
	}
	v := &wire.View{Title: t("title"), State: ext.EncodeState(s), RefreshAfter: 30, Sections: []wire.Section{}}
	toolbar := []wire.Component{button(t("refresh"), "refresh", "")}
	if s.ID != "" {
		toolbar = append(toolbar, button(t("back"), "back", ""))
		var item ticket
		if err := a.callNode(ctx, r, "query", queryParams{Kind: "ticket", ID: s.ID}, &item); err != nil {
			return failedView(v, toolbar, t), nil
		}
		items := []wire.Component{
			row(t("ticket"), item.Title), row(t("id"), item.ID), row(t("stage"), stageText(t, item)),
			row(t("assignments"), strconv.Itoa(item.Assignments)), row(t("inputs"), strconv.Itoa(item.Inputs)),
			row(t("undelivered"), strconv.Itoa(item.Undelivered)),
		}
		if item.CreatedAt != "" {
			items = append(items, row(t("created"), item.CreatedAt))
		}
		if item.UpdatedAt != "" {
			items = append(items, row(t("updated"), item.UpdatedAt))
		}
		if a.cfg.AllowControl {
			if item.CanRetry {
				toolbar = append(toolbar, button(t("retry"), "retry", t("confirm_retry")))
			}
			if item.CanStop {
				toolbar = append(toolbar, button(t("stop"), "stop", t("confirm_stop")))
			}
		}
		v.Sections = []wire.Section{{Items: toolbar}, {Items: items, Footer: t("detail_note")}}
		return v, nil
	}
	var data dashboard
	if err := a.callNode(ctx, r, "query", queryParams{Kind: "dashboard", Filter: s.Filter, Offset: s.Offset}, &data); err != nil {
		return failedView(v, toolbar, t), nil
	}
	state := t("active")
	if data.Status.Paused {
		state = t("paused")
	}
	if a.cfg.AllowControl {
		op := "pause"
		if data.Status.Paused {
			op = "resume"
		}
		toolbar = append(toolbar, button(t(op), op, t("confirm_"+op)))
	}
	filters := []wire.Choice{}
	for _, f := range []string{"open", "person", "working", "idle", "ended"} {
		filters = append(filters, wire.Choice{Value: f, Title: t(f)})
	}
	v.Filter = &wire.Filter{Name: "filter", Title: t("filter"), Value: s.Filter, Choices: filters, Action: wire.Action{ID: "filter"}}
	items := []wire.Component{}
	for _, item := range data.Items {
		items = append(items, wire.Component{Type: wire.ComponentRow, Title: item.Title, Subtitle: stageText(t, item),
			Action: &wire.Action{ID: "open:" + item.ID}})
	}
	if len(items) == 0 {
		items = append(items, wire.Component{Type: wire.ComponentText, Text: t("empty")})
	}
	if s.Offset > 0 {
		items = append(items, button(t("previous"), "previous", ""))
	}
	if data.Next != nil {
		items = append(items, button(t("next"), "next:"+strconv.Itoa(*data.Next), ""))
	}
	mode := t("readonly")
	if a.cfg.AllowControl {
		mode = t("controls_on")
	}
	v.Sections = []wire.Section{
		{Items: toolbar, Footer: mode},
		{Title: t("executor"), Items: []wire.Component{row(t("status"), state),
			row(t("running"), strconv.Itoa(data.Status.Running)), row(t("queued"), strconv.Itoa(data.Status.Queued)),
			row(t("workers"), strconv.Itoa(data.Status.MaxWorkers))}},
		{Title: t("tickets") + " (" + strconv.Itoa(data.Total) + ")", Items: items, Footer: t("intake")},
	}
	return v, nil
}

func stageText(t func(string) string, item ticket) string {
	s := t(item.Stage)
	if item.Action != "" {
		s += " · " + t(item.Action)
	}
	return s
}

func notice(t func(string) string, key string) *wire.View {
	return &wire.View{Title: t("title"), Sections: []wire.Section{{Items: []wire.Component{{Type: wire.ComponentText, Text: t(key)}}}}}
}

func failedView(v *wire.View, toolbar []wire.Component, t func(string) string) *wire.View {
	v.RefreshAfter = 0
	v.Sections = []wire.Section{{Items: toolbar}, {Items: []wire.Component{{Type: wire.ComponentText, Text: t("unavailable")}}}}
	return v
}

func (a *app) action(ctx context.Context, r *ext.UIRequest) (*wire.ActionResult, error) {
	t := translate(r.Locale)
	s, err := readPage(r)
	if err != nil {
		return &wire.ActionResult{Toast: t("invalid")}, nil
	}
	switch {
	case r.Action == "refresh":
	case r.Action == "back":
		s.ID = ""
	case r.Action == "filter":
		if !oneOf(r.Values["filter"], "open", "person", "working", "idle", "ended") {
			return &wire.ActionResult{Toast: t("invalid")}, nil
		}
		s.Filter, s.Offset, s.ID = r.Values["filter"], 0, ""
	case r.Action == "previous":
		s.Offset -= pageSize
		if s.Offset < 0 {
			s.Offset = 0
		}
	case strings.HasPrefix(r.Action, "next:"):
		n, err := strconv.Atoi(strings.TrimPrefix(r.Action, "next:"))
		if err != nil || n != s.Offset+pageSize || n > 1000000 {
			return &wire.ActionResult{Toast: t("invalid")}, nil
		}
		s.Offset = n
	case strings.HasPrefix(r.Action, "open:"):
		s.ID = strings.TrimPrefix(r.Action, "open:")
		if !validID(s.ID) {
			return &wire.ActionResult{Toast: t("invalid")}, nil
		}
	case oneOf(r.Action, "retry", "stop", "pause", "resume"):
		if !a.cfg.AllowControl {
			return &wire.ActionResult{Toast: t("readonly")}, nil
		}
		id := ""
		if r.Action == "retry" || r.Action == "stop" {
			id = s.ID
			if !validID(id) {
				return &wire.ActionResult{Toast: t("invalid")}, nil
			}
		} else if s.ID != "" {
			return &wire.ActionResult{Toast: t("invalid")}, nil
		}
		var result struct {
			OK bool `json:"ok"`
		}
		if err := a.callNode(ctx, r, "control", controlParams{Operation: r.Action, ID: id}, &result); err != nil || !result.OK {
			return &wire.ActionResult{Toast: t("control_error")}, nil
		}
		view, err := a.render(ctx, r)
		return &wire.ActionResult{View: view, Toast: t("accepted")}, err
	default:
		return &wire.ActionResult{Toast: t("invalid")}, nil
	}
	r.State = ext.EncodeState(s)
	return nil, nil
}
