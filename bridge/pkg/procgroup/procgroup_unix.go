//go:build unix

package procgroup

import (
	"os/exec"
	"syscall"
)

// Setup puts the command in its own process group so the whole tree can be
// signalled together. Unix only (Linux/macOS).
func Setup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// Terminate signals the process group. force=false sends SIGTERM, force=true SIGKILL.
func Terminate(pid int, force bool) {
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	_ = syscall.Kill(-pid, sig)
}

// HideConsole is a no-op on Unix: child processes never open a console window there.
func HideConsole(cmd *exec.Cmd) {}
