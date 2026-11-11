//go:build windows

package procgroup

import (
	"os/exec"
	"strconv"
	"syscall"
)

const (
	createNewProcessGroup = 0x00000200 // CREATE_NEW_PROCESS_GROUP
	createNoWindow        = 0x08000000 // CREATE_NO_WINDOW
)

// Setup starts the command in a new process group, without a console window.
func Setup(cmd *exec.Cmd) {
	// CREATE_NEW_PROCESS_GROUP lets us signal the group, but taskkill /T is simpler and reliable.
	HideConsole(cmd)
	cmd.SysProcAttr.CreationFlags |= createNewProcessGroup
}

// HideConsole keeps a console program (agy, claude, codex, git, rg…) from opening a console window: the bridge is
// started by the editor without a console, so each console child would otherwise get a new, visible one.
func HideConsole(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
}

// Terminate kills the process tree. force is ignored (Windows always force-kills via taskkill).
func Terminate(pid int, force bool) {
	kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid))
	HideConsole(kill)
	_ = kill.Run()
}
