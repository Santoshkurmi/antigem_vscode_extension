//go:build windows

package procgroup

import (
	"os/exec"
	"strconv"
	"syscall"
)

// Setup is a no-op on Windows; process groups are handled differently there.
func Setup(cmd *exec.Cmd) {
	// CREATE_NEW_PROCESS_GROUP lets us signal the group, but taskkill /T is simpler and reliable.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200} // CREATE_NEW_PROCESS_GROUP
}

// Terminate kills the process tree. force is ignored (Windows always force-kills via taskkill).
func Terminate(pid int, force bool) {
	_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
}