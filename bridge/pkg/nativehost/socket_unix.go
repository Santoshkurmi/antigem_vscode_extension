//go:build !windows

package nativehost

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// Supported reports whether the host can run on this platform.
func Supported() error { return nil }

// SocketPaths lists where the VS Code extension may listen, in the order it prefers them: the forced path alone, else
// $XDG_RUNTIME_DIR/antigem/browser.sock and ~/.antigem/run/browser.sock. VS Code and Chrome may not share the same
// environment, so the host tries every candidate.
func SocketPaths(forced string) []string {
	if forced != "" {
		return []string{forced}
	}
	var out []string
	if rt := os.Getenv("XDG_RUNTIME_DIR"); rt != "" {
		out = append(out, filepath.Join(rt, "antigem", "browser.sock"))
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		out = append(out, filepath.Join(home, ".antigem", "run", "browser.sock"))
	}
	return out
}

// ownedSocket checks that path is a socket owned by this user (another user can never stand in for VS Code).
func ownedSocket(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("no socket at %s", path)
		}
		return err
	}
	if fi.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("%s is not a socket", path)
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Getuid() {
		return fmt.Errorf("%s belongs to another user", path)
	}
	return nil
}

// Dial connects to the first candidate that answers.
func Dial(paths []string) (net.Conn, string, error) {
	var last error = errors.New("no socket path")
	for _, p := range paths {
		if err := ownedSocket(p); err != nil {
			last = err
			continue
		}
		c, err := net.DialTimeout("unix", p, 2*time.Second)
		if err != nil {
			last = err
			continue
		}
		return c, p, nil
	}
	return nil, "", last
}
