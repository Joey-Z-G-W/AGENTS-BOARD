package collector

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBoundedSSHCandidates(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("config", "Host primary *.wild !negated\n Hostname secret-address\nInclude \"with spaces\" missing *.inc\nMatch exec \"must-not-run\"\n User secret-user\n")
	write("with spaces", "Host secondary primary\nInclude config\n")
	write("extra.inc", "Host tertiary\nIdentityFile private-key-must-not-be-read\n")
	got, err := SSHCandidates(filepath.Join(dir, "config"))
	if err != nil || len(got) != 3 {
		t.Fatalf("aliases=%d error=%v", len(got), err)
	}
	for i, want := range []string{"primary", "secondary", "tertiary"} {
		if got[i].Alias != want || got[i].Address != want {
			t.Fatal("unexpected candidate")
		}
	}
	write("config", "Include \"unterminated\nHost surviving\n")
	got, err = SSHCandidates(filepath.Join(dir, "config"))
	if err == nil || len(got) != 1 || got[0].Alias != "surviving" {
		t.Fatal("partial parse not reported")
	}
	got, err = SSHCandidates(filepath.Join(dir, "does-not-exist"))
	if err != nil || len(got) != 0 {
		t.Fatal("missing config should be empty")
	}
	write("config", strings.Repeat("Include absent *.inc\n", 600)+"Host beyond-budget\n")
	got, err = SSHCandidates(filepath.Join(dir, "config"))
	if err == nil {
		t.Fatal("repeated missing/glob paths exceeded operation budget silently")
	}
	for _, candidate := range got {
		if candidate.Alias == "beyond-budget" {
			t.Fatal("enumeration did not stop at budget")
		}
	}
	write("config", strings.Repeat("#", 512*1024+1))
	if _, err = SSHCandidates(filepath.Join(dir, "config")); err == nil {
		t.Fatal("oversized configuration accepted")
	}
}

func TestIncludeWindowsPathsAreNotShellEscapes(t *testing.T) {
	got, err := includePaths(`"C:\Users\Example User\.ssh\parts\config" C:\plain\config # ignored`)
	if err != nil || len(got) != 2 || got[0] != `C:\Users\Example User\.ssh\parts\config` || got[1] != `C:\plain\config` {
		t.Fatalf("paths=%q err=%v", got, err)
	}
}
