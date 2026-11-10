//go:build windows

package nativehost

import (
	"errors"
	"net"
)

// ErrWindows: the VS Code side would listen on a named pipe; not implemented in v1 (PC v1 is Linux/macOS).
var ErrWindows = errors.New("browser control is not supported on Windows yet (AntiGem v1 supports Linux and macOS)")

// Supported reports whether the host can run on this platform.
func Supported() error { return ErrWindows }

// SocketPaths has no candidates on Windows.
func SocketPaths(forced string) []string {
	if forced != "" {
		return []string{forced}
	}
	return nil
}

// Dial always fails on Windows.
func Dial(paths []string) (net.Conn, string, error) { return nil, "", ErrWindows }
