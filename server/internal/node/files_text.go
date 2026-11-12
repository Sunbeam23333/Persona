package node

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/nwverse/persona/server/internal/proto"
	"github.com/nwverse/persona/server/internal/rpc"
)

// File API mutations in this process serialize their commits. External tools and Agents do not take this lock;
// the final identity, metadata and content checks are optimistic, not a filesystem-wide compare-and-swap.
var fileMutationMu sync.Mutex

func textEditBad(message string) error { return &rpc.Error{Code: "bad_request", Message: message} }
func textEditChanged() error {
	return &rpc.Error{Code: proto.CodeFileChanged, Message: "file changed; reload it before saving"}
}

func (n *Node) fileTextCall(params json.RawMessage) (any, error) {
	if !utf8.Valid(params) {
		return nil, textEditBad("request must be valid UTF-8")
	}
	var p proto.FileTextEditRequest
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, textEditBad("invalid text edit request")
	}
	return n.writeFileText(p)
}

func (n *Node) writeFileText(p proto.FileTextEditRequest) (*proto.FileTextEditResult, error) {
	if strings.TrimSpace(p.Path) == "" || strings.TrimSpace(p.Revision) == "" || p.Text == nil {
		return nil, textEditBad("path, text and revision are required")
	}
	if !utf8.ValidString(*p.Text) || strings.ContainsRune(*p.Text, 0) {
		return nil, textEditBad("text must be complete UTF-8 without NUL bytes")
	}
	if len(*p.Text) > proto.MaxFileTextBytes {
		return nil, &rpc.Error{Code: proto.CodeTooLarge, Message: "text edits are limited to 1 MiB"}
	}
	fileMutationMu.Lock()
	defer fileMutationMu.Unlock()
	e, err := n.entry(p.Path, p.Cwd)
	if err != nil {
		return nil, err
	}
	// Do not replace symlinks, directories or special files. A read-only file is not made writable by rename.
	if !e.info.Mode().IsRegular() || e.info.Mode().Perm()&0o222 == 0 {
		return nil, errReadOnly(p.Path)
	}
	if e.info.Size() > proto.MaxFileTextBytes {
		return nil, &rpc.Error{Code: proto.CodeTooLarge, Message: "text edits are limited to 1 MiB"}
	}
	if fileRevision(e.info) != p.Revision {
		return nil, textEditChanged()
	}
	parent := filepath.Dir(e.real)
	parentInfo, err := os.Stat(parent)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(parent)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	openedParent, err := root.Stat(".")
	if err != nil {
		return nil, err
	}
	if !os.SameFile(parentInfo, openedParent) {
		return nil, textEditChanged()
	}
	name := filepath.Base(e.real)
	readChecked := func() ([]byte, error) {
		st, err := root.Lstat(name)
		if err != nil || !sameFileRead(e.info, st) {
			return nil, textEditChanged()
		}
		f, err := root.Open(name)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		before, err := f.Stat()
		if err != nil || !sameFileRead(e.info, before) {
			return nil, textEditChanged()
		}
		data, err := io.ReadAll(io.LimitReader(f, proto.MaxFileTextBytes+1))
		if err != nil {
			return nil, err
		}
		after, err := f.Stat()
		if err != nil || !sameFileRead(e.info, after) || int64(len(data)) != e.info.Size() {
			return nil, textEditChanged()
		}
		if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
			return nil, textEditBad("only complete UTF-8 text files can be edited")
		}
		return data, nil
	}
	original, err := readChecked()
	if err != nil {
		return nil, err
	}
	tmpName := ".persona-edit-" + randHex(12)
	tmp, err := root.OpenFile(tmpName, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tmp.Close(); _ = root.Remove(tmpName) }()
	if _, err := io.WriteString(tmp, *p.Text); err != nil {
		return nil, err
	}
	if err := tmp.Chmod(e.info.Mode()); err != nil {
		return nil, err
	}
	if err := tmp.Sync(); err != nil {
		return nil, err
	}
	next, err := tmp.Stat()
	if err != nil {
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	if n.fileTextBeforeCommit != nil {
		n.fileTextBeforeCommit()
	}
	// Repeat path-policy checks after writing the temporary file, including any newly protected parent.
	current, err := n.entry(p.Path, p.Cwd)
	if err != nil {
		return nil, err
	}
	if current.real != e.real || !sameFileRead(e.info, current.info) {
		return nil, textEditChanged()
	}
	currentParent, err := os.Stat(parent)
	if err != nil || !os.SameFile(openedParent, currentParent) {
		return nil, textEditChanged()
	}
	latest, err := readChecked()
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(original, latest) {
		return nil, textEditChanged()
	}
	// Check current OS write permission as well as the path policy, without truncating or modifying the file.
	writable, err := root.OpenFile(name, os.O_WRONLY, 0)
	if err != nil {
		return nil, explainDenied(p.Path, n.home, err)
	}
	writeInfo, err := writable.Stat()
	_ = writable.Close()
	if err != nil || !sameFileRead(e.info, writeInfo) {
		return nil, textEditChanged()
	}
	// The temporary name must still refer to the file we wrote, not a replaced file or a symlink.
	pending, err := root.Lstat(tmpName)
	if err != nil || !sameFileRead(next, pending) {
		return nil, textEditChanged()
	}
	if err := root.Rename(tmpName, name); err != nil {
		return nil, fmt.Errorf("save text: %w", err)
	}
	return &proto.FileTextEditResult{Revision: fileRevision(next)}, nil
}
