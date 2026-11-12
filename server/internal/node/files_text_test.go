package node

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/nwverse/persona/server/internal/proto"
)

func textEditRequest(t *testing.T, n *Node, path, text string) proto.FileTextEditRequest {
	t.Helper()
	f, err := n.readFile(path, "", 0, false)
	if err != nil || f.Revision == "" {
		t.Fatalf("read revision: %+v %v", f, err)
	}
	return proto.FileTextEditRequest{Path: path, Text: &text, Revision: f.Revision}
}

func TestFileTextEditSavesAtomicallyAndPreservesMode(t *testing.T) {
	n, home := writeNode(t)
	n.state = newState() // handle's session routing has the same state store as a running node.
	path := filepath.Join(home, "proj", "script.sh")
	makeFile(t, path, "before")
	if err := os.Chmod(path, 0o750); err != nil {
		t.Fatal(err)
	}
	p := textEditRequest(t, n, path, "after\n")
	raw, _ := json.Marshal(p)
	out, err := n.handle(context.Background(), "file.text", raw)
	if err != nil {
		t.Fatal(err)
	}
	result, ok := out.(*proto.FileTextEditResult)
	if !ok || result.Revision == "" || result.Revision == p.Revision {
		t.Fatalf("result=%+v", out)
	}
	if got := fileText(t, path); got != "after\n" {
		t.Fatalf("content=%q", got)
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0o750 || fileRevision(st) != result.Revision {
		t.Fatalf("mode/revision=%v %+v", st.Mode(), result)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("temporary files left: %v", entries)
	}
}

func TestFileTextEditConflictDoesNotOverwrite(t *testing.T) {
	n, home := writeNode(t)
	path := filepath.Join(home, "proj", "a.txt")
	makeFile(t, path, "before")
	p := textEditRequest(t, n, path, "draft")
	makeFile(t, path, "agent changed this")
	_, err := n.writeFileText(p)
	wantCode(t, err, proto.CodeFileChanged)
	if fileText(t, path) != "agent changed this" {
		t.Fatal("overwrote a concurrent edit")
	}
}

func TestFileTextEditRejectsInvalidContent(t *testing.T) {
	for _, tc := range []struct {
		name, original, replacement string
		noRevision, noText          bool
	}{
		{"missing revision", "text", "new", true, false},
		{"missing text", "text", "", false, true},
		{"binary source", "a\x00b", "new", false, false},
		{"invalid source", "a\xff", "new", false, false},
		{"nul replacement", "text", "a\x00b", false, false},
		{"invalid replacement", "text", "a\xff", false, false},
		{"large replacement", "text", strings.Repeat("x", proto.MaxFileTextBytes+1), false, false},
		{"large source", strings.Repeat("x", proto.MaxFileTextBytes+1), "new", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n, home := writeNode(t)
			path := filepath.Join(home, "proj", "a.txt")
			makeFile(t, path, tc.original)
			st, _ := os.Stat(path)
			p := proto.FileTextEditRequest{Path: path, Text: &tc.replacement, Revision: fileRevision(st)}
			if tc.noRevision {
				p.Revision = ""
			}
			if tc.noText {
				p.Text = nil
			}
			if _, err := n.writeFileText(p); err == nil {
				t.Fatal("invalid edit accepted")
			}
			if fileText(t, path) != tc.original {
				t.Fatal("invalid edit changed source")
			}
		})
	}
}

func TestFileTextEditPathGuards(t *testing.T) {
	n, home := writeNode(t)
	outside := filepath.Join(t.TempDir(), "outside.txt")
	makeFile(t, outside, "outside")
	for _, path := range []string{outside, filepath.Join(home, ".ssh", "config"), filepath.Join(home, "Library", "settings.txt"), filepath.Join(home, ".persona", "state.txt")} {
		makeFile(t, path, "keep")
		st, _ := os.Stat(path)
		text := "new"
		if _, err := n.writeFileText(proto.FileTextEditRequest{Path: path, Text: &text, Revision: fileRevision(st)}); err == nil {
			t.Errorf("unguarded path: %s", path)
		}
		if fileText(t, path) != "keep" {
			t.Fatal("guarded file modified")
		}
	}
	link := filepath.Join(home, "proj", "link.txt")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(outside)
	text := "new"
	if _, err := n.writeFileText(proto.FileTextEditRequest{Path: link, Text: &text, Revision: fileRevision(st)}); err == nil {
		t.Fatal("symlink accepted")
	}
	path := filepath.Join(home, "proj", "readonly.txt")
	makeFile(t, path, "keep")
	p := textEditRequest(t, n, path, "new")
	if err := os.Chmod(path, 0o444); err != nil {
		t.Fatal(err)
	}
	if _, err := n.writeFileText(p); err == nil {
		t.Fatal("read-only file replaced")
	}
	if fileText(t, path) != "keep" {
		t.Fatal("read-only source changed")
	}
}

func TestFileTextEditRechecksBeforeCommit(t *testing.T) {
	for _, change := range []string{"content", "same metadata content", "mode", "symlink", "parent", "temporary symlink"} {
		t.Run(change, func(t *testing.T) {
			n, home := writeNode(t)
			path := filepath.Join(home, "proj", "a.txt")
			makeFile(t, path, "before")
			originalInfo, _ := os.Stat(path)
			p := textEditRequest(t, n, path, "draft")
			outside := t.TempDir()
			makeFile(t, filepath.Join(outside, "a.txt"), "outside")
			n.fileTextBeforeCommit = func() {
				switch change {
				case "content":
					makeFile(t, path, "agent")
				case "same metadata content":
					makeFile(t, path, "change")
					if err := os.Chtimes(path, originalInfo.ModTime(), originalInfo.ModTime()); err != nil {
						t.Fatal(err)
					}
				case "mode":
					if err := os.Chmod(path, 0o444); err != nil {
						t.Fatal(err)
					}
				case "symlink":
					if err := os.Remove(path); err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(filepath.Join(outside, "a.txt"), path); err != nil {
						t.Fatal(err)
					}
				case "parent":
					if err := os.Rename(filepath.Dir(path), filepath.Join(home, "old-project")); err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(outside, filepath.Dir(path)); err != nil {
						t.Fatal(err)
					}
				case "temporary symlink":
					entries, err := os.ReadDir(filepath.Dir(path))
					if err != nil {
						t.Fatal(err)
					}
					for _, entry := range entries {
						if strings.HasPrefix(entry.Name(), ".persona-edit-") {
							temporary := filepath.Join(filepath.Dir(path), entry.Name())
							if err := os.Remove(temporary); err != nil {
								t.Fatal(err)
							}
							if err := os.Symlink(filepath.Join(outside, "a.txt"), temporary); err != nil {
								t.Fatal(err)
							}
						}
					}
				}
			}
			if _, err := n.writeFileText(p); err == nil {
				t.Fatal("changed target accepted")
			}
			if fileText(t, filepath.Join(outside, "a.txt")) != "outside" {
				t.Fatal("escaped checked directory")
			}
			if change == "content" && fileText(t, path) != "agent" {
				t.Fatal("overwrote agent edit")
			}
			if change == "same metadata content" && fileText(t, path) != "change" {
				t.Fatal("overwrote same-metadata edit")
			}
			if change == "temporary symlink" && fileText(t, path) != "before" {
				t.Fatal("replaced source with a tampered temporary file")
			}
		})
	}
}

func TestFileTextEditConcurrentRevision(t *testing.T) {
	n, home := writeNode(t)
	path := filepath.Join(home, "proj", "a.txt")
	makeFile(t, path, "before")
	p := textEditRequest(t, n, path, "after")
	var wg sync.WaitGroup
	errors := make([]error, 2)
	for i := range errors {
		wg.Add(1)
		go func() { defer wg.Done(); _, errors[i] = n.writeFileText(p) }()
	}
	wg.Wait()
	success := 0
	for _, err := range errors {
		if err == nil {
			success++
		} else {
			wantCode(t, err, proto.CodeFileChanged)
		}
	}
	if success != 1 {
		t.Fatalf("successful writes=%d", success)
	}
}
