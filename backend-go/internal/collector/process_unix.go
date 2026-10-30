//go:build !windows

package collector

import (
	"os/exec"
	"syscall"
)

func prepareProcess(cmd *exec.Cmd) (func(), error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return func() {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
	}, nil
}
func attachProcess(cmd *exec.Cmd) error { return nil }
