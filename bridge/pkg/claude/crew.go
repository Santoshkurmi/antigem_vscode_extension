package claude

// Crew bots (the extension's src/core/crew): a bot's chat is a normal session started with the bot's persona, its
// own MCP servers and its tool limits. They are spawn options like the model; a change restarts the process before
// the next prompt (the chat resumes from its transcript, so nothing is lost).

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// CrewSpawn sets a Crew bot's chat up. Key identifies the whole setup (the extension hashes it): a different key
// while the process runs means "restart before the next prompt". An empty key removes the setup.
type CrewSpawn struct {
	Key string `json:"key"`
	// AppendSystemPrompt: the bot's persona and crew rules (--append-system-prompt-file).
	AppendSystemPrompt string `json:"append_system_prompt,omitempty"`
	// McpServers: --mcp-config's "mcpServers" (the bot's own crew server, with its identity in the URL).
	McpServers map[string]json.RawMessage `json:"mcp_servers,omitempty"`
	// StrictMcp: only McpServers, none of the user's (--strict-mcp-config).
	StrictMcp bool `json:"strict_mcp,omitempty"`
	// Tools: the built-in tools it has (--tools); nil = all, empty = none.
	Tools *[]string `json:"tools,omitempty"`
	// AllowedTools run without asking (--allowedTools), DisallowedTools are removed (--disallowedTools).
	AllowedTools    []string `json:"allowed_tools,omitempty"`
	DisallowedTools []string `json:"disallowed_tools,omitempty"`
	// AddDirs: folders it may read without asking (--add-dir).
	AddDirs []string `json:"add_dirs,omitempty"`
	// AskTools: permission rules that always ask (settings permissions.ask, via --settings), even in auto mode: the
	// extension's access broker then decides (outward commands such as "Bash(git push:*)" at Auto / Full).
	AskTools []string `json:"ask_tools,omitempty"`
}

// crewDir holds a session's persona and MCP config files (private: the MCP config has the extension's device id).
func (m *Manager) crewDir(sessionID string) string {
	return filepath.Join(m.HomeDir, ".antigem_bridge", "crew", "claude", sessionID)
}

// crewArgs writes the setup's files and returns its CLI flags.
func (m *Manager) crewArgs(sessionID string, c *CrewSpawn) ([]string, error) {
	dir := m.crewDir(sessionID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	var args []string
	if c.AppendSystemPrompt != "" {
		f := filepath.Join(dir, "prompt.md")
		if err := writeFilePrivate(f, []byte(c.AppendSystemPrompt)); err != nil {
			return nil, err
		}
		args = append(args, "--append-system-prompt-file", f)
		// the CLI records the system prompt on a chat's first request and reuses it, even when a later start passes
		// another one: off renders it every request, so an edited persona reaches the bot (same text = same cache)
		if m.cliHasFlag("--system-prompt-snapshot") {
			args = append(args, "--system-prompt-snapshot", "off")
		}
	}
	if len(c.McpServers) > 0 {
		data, err := json.Marshal(map[string]interface{}{"mcpServers": c.McpServers})
		if err != nil {
			return nil, err
		}
		f := filepath.Join(dir, "mcp.json")
		if err := writeFilePrivate(f, data); err != nil {
			return nil, err
		}
		args = append(args, "--mcp-config", f)
	}
	if c.StrictMcp {
		args = append(args, "--strict-mcp-config")
	}
	if c.Tools != nil {
		// "" = no built-in tools at all (only MCP tools are left)
		args = append(args, "--tools", strings.Join(*c.Tools, ","))
	}
	if len(c.AllowedTools) > 0 {
		args = append(args, "--allowedTools", strings.Join(c.AllowedTools, ","))
	}
	if len(c.DisallowedTools) > 0 {
		args = append(args, "--disallowedTools", strings.Join(c.DisallowedTools, ","))
	}
	for _, d := range c.AddDirs {
		if fi, err := os.Stat(d); err == nil && fi.IsDir() {
			args = append(args, "--add-dir", d)
		}
	}
	if len(c.AskTools) > 0 && m.cliHasFlag("--settings") {
		data, err := json.Marshal(map[string]interface{}{"permissions": map[string]interface{}{"ask": c.AskTools}})
		if err != nil {
			return nil, err
		}
		f := filepath.Join(dir, "settings.json")
		if err := writeFilePrivate(f, data); err != nil {
			return nil, err
		}
		args = append(args, "--settings", f)
	}
	return args, nil
}

// removeCrewFiles deletes a chat's persona and MCP config files (the chat is deleted).
func (m *Manager) removeCrewFiles(sessionID string) {
	if sessionIDRe.MatchString(sessionID) {
		_ = os.RemoveAll(m.crewDir(sessionID))
	}
}

func writeFilePrivate(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// NeedsCrewRestart: the process runs on another crew setup than the one configured now.
func (s *Session) NeedsCrewRestart() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cmd != nil && s.crewKey != crewKeyOf(s.opts.Crew)
}

// RestartForCrew restarts the process on the configured crew setup when it changed and no turn is running (a
// running turn finishes first; the next prompt restarts it then).
func (s *Session) RestartForCrew() {
	if !s.NeedsCrewRestart() {
		return
	}
	s.mu.Lock()
	busy := s.pendingTurns > 0
	s.mu.Unlock()
	if busy {
		return
	}
	log.Printf("[claude] session %s: crew setup changed, restarting", s.ID)
	s.Restart()
}

func crewKeyOf(c *CrewSpawn) string {
	if c == nil {
		return ""
	}
	return c.Key
}

// --- CLI flag support ---------------------------------------------------------------------------

var helpCache struct {
	sync.Mutex
	stamp string
	text  string
}

// cliHasFlag tells whether the installed CLI knows a flag (its --help, read once per binary version).
func (m *Manager) cliHasFlag(flag string) bool {
	bin, err := m.ResolveBinary()
	if err != nil {
		return false
	}
	stamp := bin
	if fi, err := os.Stat(bin); err == nil {
		stamp = fmt.Sprintf("%s|%d|%d", bin, fi.Size(), fi.ModTime().UnixNano())
	}
	helpCache.Lock()
	defer helpCache.Unlock()
	if helpCache.stamp != stamp {
		out, err := m.runCLI(20*time.Second, "--help")
		if err != nil && len(out) == 0 {
			return false
		}
		helpCache.stamp, helpCache.text = stamp, string(out)
	}
	return strings.Contains(helpCache.text, flag)
}
