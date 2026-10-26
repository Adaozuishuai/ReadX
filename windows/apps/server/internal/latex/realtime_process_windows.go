package latex

import (
	"os/exec"
	"syscall"
)

func hideRealtimeWindow(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
