//go:build windows

package collector

import (
	"context"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestCancellationKillsDescendants(t *testing.T) {
	t.Setenv("BOARD_EXEC_HELPER", "1")
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		_, err := Run(ctx, os.Args[0], []string{"-test.run=TestHelperProcess", "--", "tree", pidFile}, nil)
		finished <- err
	}()
	deadline := time.Now().Add(5 * time.Second)
	var pid int
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(pidFile)
		if err == nil {
			pid, _ = strconv.Atoi(string(data))
			if pid > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if pid == 0 {
		cancel()
		t.Fatal("helper child never started")
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	cancel()
	select {
	case err = <-finished:
		if err == nil {
			t.Fatal("cancellation succeeded unexpectedly")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runner did not stop")
	}
	status, err := windows.WaitForSingleObject(handle, 3000)
	if err != nil || status != windows.WAIT_OBJECT_0 {
		t.Fatalf("descendant survived: %d %v", status, err)
	}
}
