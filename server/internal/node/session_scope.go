package node

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/nwverse/persona/server/internal/compat"
)

// PERSONA_NODE_SESSION_DIR opts a second resident or stdio node into discovering
// only its assistant's sessions, plus an explicitly opted-in development workspace.
// Each agent profile must be inside its own PERSONA_HOME; the user's terminal hosts
// and global hooks stay with the primary node.
const nodeSessionDirEnv = "PERSONA_NODE_SESSION_DIR"
const nodeWorkspaceDirEnv = "PERSONA_NODE_WORKSPACE_DIR"

type nodeSessionScope struct {
	dir       string
	claude    string
	codex     string
	workspace string
}

func readNodeSessionScope(home, root string) (*nodeSessionScope, error) {
	dir := os.Getenv(nodeSessionDirEnv)
	if dir == "" {
		if os.Getenv(nodeWorkspaceDirEnv) != "" {
			return nil, fmt.Errorf("%s requires %s", nodeWorkspaceDirEnv, nodeSessionDirEnv)
		}
		return nil, nil
	}
	if !filepath.IsAbs(os.Getenv("PERSONA_HOME")) || !filepath.IsAbs(root) || sameScopePath(root, home) || sameScopePath(root, filepath.Join(home, ".persona")) || sameScopePath(root, filepath.Join(home, compat.StateDir)) {
		return nil, fmt.Errorf("%s requires an independent absolute PERSONA_HOME", nodeSessionDirEnv)
	}
	s := &nodeSessionScope{dir: dir, claude: os.Getenv("CLAUDE_CONFIG_DIR"), codex: os.Getenv("CODEX_HOME")}
	for _, item := range []struct{ name, path string }{{nodeSessionDirEnv, s.dir}, {"CLAUDE_CONFIG_DIR", s.claude}, {"CODEX_HOME", s.codex}} {
		if !filepath.IsAbs(item.path) || !sessionScopeWithin(root, item.path) || sameScopePath(root, item.path) {
			return nil, fmt.Errorf("%s must be an absolute directory inside the independent PERSONA_HOME", item.name)
		}
	}
	if sessionScopeWithin(s.dir, s.claude) || sessionScopeWithin(s.dir, s.codex) || sessionScopeWithin(s.claude, s.dir) || sessionScopeWithin(s.codex, s.dir) || sessionScopeWithin(s.claude, s.codex) || sessionScopeWithin(s.codex, s.claude) {
		return nil, fmt.Errorf("assistant, Claude and Codex directories must be separate")
	}
	if workspace := os.Getenv(nodeWorkspaceDirEnv); workspace != "" {
		if err := validateSessionWorkspace(home, root, workspace); err != nil {
			return nil, err
		}
		s.workspace = workspace
	}
	return s, nil
}

func validateSessionWorkspace(home, root, workspace string) error {
	invalid := func() error {
		return fmt.Errorf("%s must be an existing canonical dedicated directory outside Persona state and agent profiles", nodeWorkspaceDirEnv)
	}
	if !filepath.IsAbs(workspace) || filepath.Clean(workspace) != workspace {
		return invalid()
	}
	real, err := filepath.EvalSymlinks(workspace)
	if err != nil || real != workspace {
		return invalid()
	}
	info, err := os.Lstat(workspace)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || filepath.Dir(workspace) == workspace || sessionScopeWithin(workspace, home) {
		return invalid()
	}
	// A parent of the state/profiles is just as broad as the profiles themselves.
	for _, protected := range []string{root, filepath.Join(home, ".claude"), filepath.Join(home, ".codex"), filepath.Join(home, ".persona"), filepath.Join(home, compat.StateDir)} {
		if sessionScopeWithin(protected, workspace) || sessionScopeWithin(workspace, protected) {
			return invalid()
		}
	}
	return nil
}

// Resolve existing ancestors too: a not-yet-created profile beneath a symlink
// must not escape the independent root.
func sessionScopePath(p string) string {
	p = filepath.Clean(p)
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return real
	}
	parent := filepath.Dir(p)
	if parent == p {
		return p
	}
	return filepath.Join(sessionScopePath(parent), filepath.Base(p))
}

func sameScopePath(a, b string) bool { return sessionScopePath(a) == sessionScopePath(b) }

func sessionScopeWithin(root, p string) bool {
	if p == "" {
		return false
	}
	rel, err := filepath.Rel(sessionScopePath(root), sessionScopePath(p))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func (n *Node) sessionScopeAllows(cwd string) bool {
	if n.sessionScope == nil || sessionScopeWithin(n.sessionScope.dir, cwd) {
		return true
	}
	workspace := n.sessionScope.workspace
	// Keep the configured canonical root pinned if someone replaces it with a link.
	return workspace != "" && sessionScopePath(workspace) == workspace && sessionScopeWithin(workspace, cwd)
}

func (n *Node) scopedTranscript(path string) bool {
	if n.sessionScope == nil {
		return true
	}
	return sessionScopeWithin(n.sessionScope.claude, path) || sessionScopeWithin(n.sessionScope.codex, path)
}

// Scope checks need only the transcript's initial cwd, not its reply text or
// activity tail. Match the metadata scanner's header bound without its tail scan.
const scopeTranscriptHeaderLimit = 256 * 1024

func scopeTranscriptCwd(reader io.Reader) string {
	r := bufio.NewReader(io.LimitReader(reader, scopeTranscriptHeaderLimit))
	for {
		line, err := r.ReadBytes('\n')
		var header struct {
			Type    string `json:"type"`
			Cwd     string `json:"cwd"`
			Payload struct {
				Cwd string `json:"cwd"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &header) == nil {
			if header.Cwd != "" {
				return header.Cwd
			}
			if (header.Type == "session_meta" || header.Type == "turn_context") && header.Payload.Cwd != "" {
				return header.Payload.Cwd
			}
		}
		if err != nil {
			return "" // missing, unreadable or incomplete metadata fails closed.
		}
	}
}

func (n *Node) scopedTranscriptAllows(path string) bool {
	if n.sessionScope == nil {
		return true
	}
	if !n.scopedTranscript(path) {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	return n.sessionScopeAllows(scopeTranscriptCwd(f))
}

func (n *Node) offlineCacheKey() string {
	if n.sessionScope != nil {
		return n.home + "\x00" + n.dir + "\x00" + n.sessionScope.dir + "\x00" + n.sessionScope.workspace
	}
	return n.home
}
