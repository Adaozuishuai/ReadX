//go:build !windows

package latex

import "os/exec"

func hideRealtimeWindow(cmd *exec.Cmd) {}
