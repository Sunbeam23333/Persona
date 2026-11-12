package hub

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/nwverse/persona/server/internal/i18n"
	"github.com/nwverse/persona/server/internal/proto"
	"github.com/nwverse/persona/server/internal/rpc"
)

// saveFileText only validates the transport and relays to the node; file policy and atomic replacement stay there.
func (h *Hub) saveFileText(w http.ResponseWriter, r *http.Request, m *Machine) {
	// A byte may occupy six bytes as a JSON Unicode escape; the decoded text has its own stricter limit.
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 6*proto.MaxFileTextBytes+(64<<10)))
	if err != nil {
		writeBodyErr(w, err, err)
		return
	}
	var p proto.FileTextEditRequest
	if !utf8.Valid(raw) || json.Unmarshal(raw, &p) != nil {
		writeErr(w, http.StatusBadRequest, i18n.Err("hub-files_text.invalid"))
		return
	}
	if strings.TrimSpace(p.Path) == "" || strings.TrimSpace(p.Revision) == "" || p.Text == nil {
		writeErr(w, http.StatusBadRequest, i18n.Err("hub-files_text.required"))
		return
	}
	if !utf8.ValidString(*p.Text) || strings.ContainsRune(*p.Text, 0) {
		writeErr(w, http.StatusBadRequest, i18n.Err("hub-files_text.invalid"))
		return
	}
	if len(*p.Text) > proto.MaxFileTextBytes {
		writeErrCode(w, http.StatusRequestEntityTooLarge, proto.CodeTooLarge, i18n.Err("hub-files_text.too_large"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var out proto.FileTextEditResult
	if err := m.call(ctx, "file.text", p, &out); err != nil {
		var re *rpc.Error
		switch {
		case errors.As(err, &re) && re.Code == "" && strings.HasPrefix(re.Message, "unknown method"):
			writeCode(w, http.StatusConflict, proto.CodeNodeOutdated, i18n.T(h.requestLang(r), "hub-fileedit.outdated", i18n.Args{"name": m.cfg.Name}), nil)
		case errors.As(err, &re) && re.Code == proto.CodeNotFound:
			writeCode(w, http.StatusNotFound, re.Code, re.Message, nil)
		case errors.As(err, &re) && re.Code == "bad_request":
			writeCode(w, http.StatusBadRequest, re.Code, i18n.T(h.requestLang(r), "hub-files_text.invalid"), nil)
		case errors.As(err, &re) && re.Code == proto.CodeTooLarge:
			writeCode(w, http.StatusRequestEntityTooLarge, re.Code, i18n.T(h.requestLang(r), "hub-files_text.too_large"), nil)
		case errors.As(err, &re) && re.Code == proto.CodeFileChanged:
			writeCode(w, http.StatusConflict, re.Code, i18n.T(h.requestLang(r), "hub-files_text.changed"), nil)
		default:
			callErr(w, err)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(out)
}
