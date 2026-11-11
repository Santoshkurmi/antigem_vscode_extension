package config

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Config holds global runtime configuration parameters.
type Config struct {
	Port            string
	Bind            string
	HomeDir         string
	WorkspaceDir    string
	AppDataDir      string
	BrainDir        string
	TokenFile       string
	ProjectsBaseDir string
}

// LoadConfig initializes configuration with sensible defaults and environment overrides.
func LoadConfig() *Config {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		if h := os.Getenv("HOME"); h != "" {
			home = h
		} else {
			home = "."
		}
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "1234"
	}

	// loopback only unless asked otherwise: 0.0.0.0 would expose the bridge to every network the machine is on
	bind := os.Getenv("BIND")
	if bind == "" {
		bind = "127.0.0.1"
	}

	workspace := os.Getenv("WORKSPACE_DIR")
	if workspace == "" {
		candidates := []string{
			filepath.Join(home, "extra"),
			filepath.Join(home, "projects", "gemini"),
			filepath.Join(home, "projects"),
		}
		for _, c := range candidates {
			if fi, err := os.Stat(c); err == nil && fi.IsDir() {
				workspace = c
				break
			}
		}
		if workspace == "" {
			if wd, err := os.Getwd(); err == nil {
				workspace = wd
			}
		}
	}

	appData := filepath.Join(home, ".gemini", "antigravity-cli")
	brain := filepath.Join(appData, "brain")
	tokenFile := filepath.Join(appData, "antigravity-oauth-token")
	projectsBase := filepath.Join(home, "projects")
	if fi, err := os.Stat(projectsBase); err != nil || !fi.IsDir() {
		if fi2, err2 := os.Stat(workspace); err2 == nil && fi2.IsDir() {
			projectsBase = workspace
		}
	}

	return &Config{
		Port:            port,
		Bind:            bind,
		HomeDir:         home,
		WorkspaceDir:    workspace,
		AppDataDir:      appData,
		BrainDir:        brain,
		TokenFile:       tokenFile,
		ProjectsBaseDir: projectsBase,
	}
}

// ExpandHome expands tilde (~) in file paths to the user's home directory.
func ExpandHome(p string) string {
	p = strings.TrimSpace(p)
	if strings.HasPrefix(p, "~/") || p == "~" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			home = os.Getenv("HOME")
		}
		if p == "~" {
			return home
		}
		return filepath.Join(home, strings.TrimPrefix(p, "~/"))
	}
	return p
}

// SafeLookPath finds an executable in PATH or standard Android/Linux locations without triggering faccessat2 syscall (which causes SIGSYS on Android seccomp)
func SafeLookPath(name string) string {
	if runtime.GOOS == "windows" {
		return lookPathWindows(name)
	}
	if filepath.IsAbs(name) {
		if fi, err := os.Stat(name); err == nil && !fi.IsDir() {
			return name
		}
		return ""
	}

	home, _ := os.UserHomeDir()
	var candidates []string
	if home != "" {
		candidates = append(candidates,
			filepath.Join(home, ".local", "bin", name),
			filepath.Join(home, ".gemini", "bin", name),
			filepath.Join(home, ".antigravity", "bin", name),
			filepath.Join(home, "usr", "bin", name),
			filepath.Join(home, "..", "usr", "bin", name),
		)
	}
	if prefix := os.Getenv("PREFIX"); prefix != "" {
		candidates = append([]string{filepath.Join(prefix, "bin", name)}, candidates...)
	}
	candidates = append(candidates,
		"/usr/bin/"+name,
		"/usr/local/bin/"+name,
		"/system/bin/"+name,
		"/system/xbin/"+name,
		"/bin/"+name,
	)
	if runtime.GOOS == "darwin" {
		// Homebrew on Apple silicon; an editor started from the Dock often has it missing from PATH
		candidates = append(candidates, "/opt/homebrew/bin/"+name)
	}

	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c
		}
	}

	pathEnv := os.Getenv("PATH")
	for _, dir := range filepath.SplitList(pathEnv) {
		if dir == "" {
			continue
		}
		target := filepath.Join(dir, name)
		if fi, err := os.Stat(target); err == nil && !fi.IsDir() {
			return target
		}
	}

	return ""
}

// lookPathWindows is SafeLookPath on Windows: the same home folders, then PATH, both with exec.LookPath, which
// adds the PATHEXT extensions (.exe, .cmd…) that Windows programs need.
func lookPathWindows(name string) string {
	var candidates []string
	if filepath.IsAbs(name) {
		candidates = append(candidates, name)
	} else if home, _ := os.UserHomeDir(); home != "" {
		candidates = append(candidates,
			filepath.Join(home, ".local", "bin", name),
			filepath.Join(home, ".gemini", "bin", name),
			filepath.Join(home, ".antigravity", "bin", name),
		)
	}
	for _, c := range candidates {
		// a path without an extension is tried with the PATHEXT ones (agy -> agy.exe)
		if p, err := exec.LookPath(c); err == nil {
			return p
		}
	}
	if filepath.IsAbs(name) {
		return ""
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return ""
}

// PrependPath returns env with dirs put in front of its PATH, using the OS's list separator. On Windows the
// variable is usually spelled `Path`, so the key is matched case-insensitively there and keeps its spelling.
func PrependPath(env []string, dirs ...string) []string {
	var parts []string
	for _, d := range dirs {
		if d != "" {
			parts = append(parts, d)
		}
	}
	sep := string(os.PathListSeparator)
	for i, e := range env {
		k, v, ok := strings.Cut(e, "=")
		if !ok || (k != "PATH" && !(runtime.GOOS == "windows" && strings.EqualFold(k, "PATH"))) {
			continue
		}
		if v != "" {
			parts = append(parts, v)
		}
		out := append([]string(nil), env...)
		out[i] = k + "=" + strings.Join(parts, sep)
		return out
	}
	return append(env, "PATH="+strings.Join(parts, sep))
}
