package claude

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeCLI writes a `claude` that prints a help text (with or without the snapshot flag).
func fakeCLI(t *testing.T, withSnapshot bool) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell script CLI")
	}
	help := "  --tools <tools...>\n  --mcp-config <configs...>\n  --settings <file-or-json>\n"
	if withSnapshot {
		help += "  --system-prompt-snapshot <on|off>\n"
	}
	bin := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\ncat <<'EOF'\n"+help+"EOF\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

func TestCrewArgsTalkOnly(t *testing.T) {
	home := t.TempDir()
	m := &Manager{HomeDir: home, BinPath: fakeCLI(t, true), sessions: map[string]*Session{}}
	none := []string{}
	extra := t.TempDir()
	c := &CrewSpawn{
		Key:                "k1",
		AppendSystemPrompt: "You are Ada.",
		McpServers:         map[string]json.RawMessage{"crew": json.RawMessage(`{"type":"http","url":"http://127.0.0.1:1/crew?t=x&cap=y","headers":{"X-Device-Id":"d"}}`)},
		StrictMcp:          true,
		Tools:              &none,
		AllowedTools:       []string{"mcp__crew"},
		AddDirs:            []string{extra, filepath.Join(home, "missing")},
	}
	args, err := m.crewArgs("sess-1", c)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	dir := m.crewDir("sess-1")
	want := []string{
		"--append-system-prompt-file " + filepath.Join(dir, "prompt.md"),
		"--system-prompt-snapshot off",
		"--mcp-config " + filepath.Join(dir, "mcp.json"),
		"--strict-mcp-config",
		"--allowedTools mcp__crew",
		"--add-dir " + extra,
	}
	for _, w := range want {
		if !strings.Contains(joined, w) {
			t.Errorf("missing %q in %q", w, joined)
		}
	}
	// --tools with an empty value: no built-in tools
	found := false
	for i, a := range args {
		if a == "--tools" && i+1 < len(args) && args[i+1] == "" {
			found = true
		}
	}
	if !found {
		t.Errorf("--tools \"\" missing: %q", args)
	}
	if strings.Contains(joined, "missing") {
		t.Errorf("a folder that does not exist was added: %q", joined)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "prompt.md")); string(b) != "You are Ada." {
		t.Errorf("prompt file = %q", b)
	}
	var cfg struct {
		McpServers map[string]map[string]interface{} `json:"mcpServers"`
	}
	b, _ := os.ReadFile(filepath.Join(dir, "mcp.json"))
	if json.Unmarshal(b, &cfg) != nil || cfg.McpServers["crew"]["type"] != "http" {
		t.Errorf("mcp.json = %s", b)
	}
	if fi, err := os.Stat(filepath.Join(dir, "mcp.json")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("mcp.json must be private: %v %v", fi.Mode(), err)
	}
}

func TestCrewArgsOlderCLI(t *testing.T) {
	helpCache.stamp = ""
	m := &Manager{HomeDir: t.TempDir(), BinPath: fakeCLI(t, false), sessions: map[string]*Session{}}
	args, err := m.crewArgs("s2", &CrewSpawn{Key: "k", AppendSystemPrompt: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(args, " "), "snapshot") {
		t.Errorf("snapshot flag passed to a CLI without it: %q", args)
	}
	// no tool list = the default tools (no --tools flag at all)
	if strings.Contains(strings.Join(args, " "), "--tools") {
		t.Errorf("--tools without a list: %q", args)
	}
}

func TestCrewConfigureAndRestartNeed(t *testing.T) {
	m := &Manager{HomeDir: t.TempDir(), sessions: map[string]*Session{}}
	s := &Session{ID: "s3", mgr: m, subs: map[*subscriber]struct{}{}}
	s.Configure(SpawnOptions{Crew: &CrewSpawn{Key: "a"}})
	if s.opts.Crew == nil || s.opts.Crew.Key != "a" {
		t.Fatalf("crew not configured: %+v", s.opts.Crew)
	}
	if s.NeedsCrewRestart() {
		t.Error("no process: nothing to restart")
	}
	// a process started on "a", then the setup changes to "b"
	s.cmd = &exec.Cmd{}
	s.crewKey = "a"
	if s.NeedsCrewRestart() {
		t.Error("same key must not restart")
	}
	s.Configure(SpawnOptions{Crew: &CrewSpawn{Key: "b"}})
	if !s.NeedsCrewRestart() {
		t.Error("changed key must restart")
	}
	// other options never touch the crew setup
	s.Configure(SpawnOptions{Model: "haiku"})
	if s.opts.Crew == nil || s.opts.Crew.Key != "b" {
		t.Error("a model change dropped the crew setup")
	}
	s.Configure(SpawnOptions{Crew: &CrewSpawn{Key: ""}})
	if s.opts.Crew != nil {
		t.Error("an empty key must remove the setup")
	}
}

func TestCrewArgsAskTools(t *testing.T) {
	m := &Manager{HomeDir: t.TempDir(), BinPath: fakeCLI(t, true), sessions: map[string]*Session{}}
	args, err := m.crewArgs("sess-ask", &CrewSpawn{Key: "k", AskTools: []string{"Bash(git push:*)", "Bash(npm publish:*)"}})
	if err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(m.crewDir("sess-ask"), "settings.json")
	if !strings.Contains(strings.Join(args, " "), "--settings "+f) {
		t.Fatalf("no --settings in %q", args)
	}
	data, err := os.ReadFile(f)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Permissions struct {
			Ask []string `json:"ask"`
		} `json:"permissions"`
	}
	if err := json.Unmarshal(data, &doc); err != nil || len(doc.Permissions.Ask) != 2 || doc.Permissions.Ask[0] != "Bash(git push:*)" {
		t.Fatalf("settings %s (%v)", data, err)
	}
}
