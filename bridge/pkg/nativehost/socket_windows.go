//go:build windows

package nativehost

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// On Windows the VS Code extension listens on a named pipe with a new random name each time
// (\\.\pipe\antigem-browser-<random>) and writes that name to ~/.antigem/run/browser.pipe. Only this user can read their
// profile folder, so another user can neither learn the name in advance (to put up a pipe of the same name first) nor
// find out where to connect; the default pipe security gives other users read access at most, never write.

const (
	pipePrefix = `\\.\pipe\`
	// pipeNamePrefix is what every pipe of the VS Code extension is called (a name file naming anything else is refused).
	pipeNamePrefix = pipePrefix + "antigem-browser-"

	// SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION: the pipe's server may learn who connects, never act as this user.
	securitySqosPresent    = 0x00100000
	securityIdentification = 0x00010000
)

// Supported reports whether the host can run on this platform.
func Supported() error { return nil }

// pipeNameFile is where the VS Code window that serves the browser link writes its pipe's name.
func pipeNameFile() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".antigem", "run", "browser.pipe")
}

// SocketPaths lists where to find VS Code: the forced pipe (or name file) alone, else the name file. The file is read
// again on every try, since VS Code picks a new pipe name each time it starts.
func SocketPaths(forced string) []string {
	if forced != "" {
		return []string{forced}
	}
	if f := pipeNameFile(); f != "" {
		return []string{f}
	}
	return nil
}

// Dial connects to the first candidate that answers: a pipe name (\\.\pipe\…), or a file holding one.
func Dial(paths []string) (io.ReadWriteCloser, string, error) {
	var last error = errors.New("no pipe name")
	for _, p := range paths {
		name := p
		if !strings.HasPrefix(strings.ToLower(p), pipePrefix) {
			b, err := os.ReadFile(p)
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					last = fmt.Errorf("no pipe name in %s", p)
				} else {
					last = err
				}
				continue
			}
			name = strings.TrimSpace(string(b))
			if !strings.HasPrefix(strings.ToLower(name), pipeNamePrefix) {
				last = fmt.Errorf("%s does not name an AntiGem pipe", p)
				continue
			}
		}
		f, err := openPipe(name)
		if err != nil {
			last = fmt.Errorf("%s: %w", name, err)
			continue
		}
		return f, name, nil
	}
	return nil, "", last
}

// openPipe opens the client end of a named pipe for overlapped I/O: the runtime poller then lets one goroutine read
// while another writes (a pipe opened for blocking I/O runs one operation at a time, so a waiting read would hold
// every write back).
func openPipe(name string) (*os.File, error) {
	p, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_OVERLAPPED|securitySqosPresent|securityIdentification, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(h), name), nil
}
