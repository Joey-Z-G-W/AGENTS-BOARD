package collector

import (
	api "agents-board/backend-go/internal/api/generated"
	"agents-board/backend-go/internal/store"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestProtocolAndTargetIdentity(t *testing.T) {
	d := store.Demo(time.Now).Dashboard()
	session := d.Projects[0].Sessions[0]
	data, _ := json.Marshal(session)
	var fields map[string]any
	_ = json.Unmarshal(data, &fields)
	for _, key := range []string{"id", "projectId", "hostId", "storageHostId", "collectedAt", "collectionVersion"} {
		delete(fields, key)
	}
	fields["nativeId"] = "fixture"
	fields["workspaceHost"] = nil
	fields["commonDir"] = nil
	payload := map[string]any{"version": 1, "observedAt": time.Now().UTC(), "records": []any{map[string]any{"session": fields, "locator": Locator{Path: "/fixture", Source: string(session.Source), NativeID: "fixture"}}}, "state": map[string]any{}, "failures": 0}
	raw, _ := json.Marshal(payload)
	p := New("fixture-python")
	p.Run = func(_ context.Context, command string, args []string, input []byte) ([]byte, error) {
		if command != "fixture-python" || strings.Join(args, " ") != "-B -" || !strings.HasPrefix(string(input), "__name__ = 'board_probe'") {
			t.Fatal("unsafe probe transport")
		}
		return raw, nil
	}
	host := api.Host{Id: "local", Local: true}
	result, err := p.Collect(context.Background(), host, nil)
	if err != nil || len(result.Sessions) != 1 {
		t.Fatal("decode failed", err)
	}
	p.Accept(host.Id, result)
	target := result.Sessions[0]
	if _, err = p.Collect(context.Background(), host, &target); err != nil {
		t.Fatal("target unavailable", err)
	}
	target.Id = "client-path-is-not-locator"
	if _, err = p.Collect(context.Background(), host, &target); err == nil {
		t.Fatal("untrusted target accepted")
	}
	payload["version"] = 2
	raw, _ = json.Marshal(payload)
	if _, err = p.Collect(context.Background(), host, nil); err == nil {
		t.Fatal("unknown protocol accepted")
	}
}
func TestProtocolRedactsExecutionErrors(t *testing.T) {
	p := New("fixture")
	p.Run = func(context.Context, string, []string, []byte) ([]byte, error) {
		return nil, errors.New("SECRET raw stderr")
	}
	_, err := p.Collect(context.Background(), api.Host{Id: "local", Local: true}, nil)
	if err == nil || strings.Contains(err.Error(), "SECRET") {
		t.Fatal("raw error leaked")
	}
}

func TestSSHUsesCompressedAuthenticatedTransport(t *testing.T) {
	p := New("fixture")
	called := false
	p.Run = func(_ context.Context, command string, args []string, _ []byte) ([]byte, error) {
		called = true
		if command != "ssh" {
			t.Fatal("remote collection must use system SSH")
		}
		joined := strings.Join(args, " ")
		for _, expected := range []string{"-o Compression=yes", "-o BatchMode=yes", "-o StrictHostKeyChecking=yes", "-- t-11257 python3 -B -"} {
			if !strings.Contains(joined, expected) {
				t.Fatalf("missing transport option: %s", expected)
			}
		}
		return nil, errors.New("synthetic read failure")
	}
	_, err := p.Collect(context.Background(), api.Host{Id: "remote", Address: "t-11257"}, nil)
	if !called || !errors.Is(err, ErrRead) {
		t.Fatal("transport path not exercised")
	}
}

func TestDuplicateNativeIdentitySelectsStableFile(t *testing.T) {
	for _, tc := range []struct {
		name     string
		modified int64
		path     string
		want     string
	}{
		{"newer file", 20, "/z-new", "/z-new"},
		{"older file", 5, "/a-old", "/m-original"},
		{"equal timestamp", 10, "/a-tie", "/a-tie"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := store.Demo(time.Now).Dashboard().Projects[0].Sessions[0]
			data, _ := json.Marshal(s)
			var fields map[string]any
			_ = json.Unmarshal(data, &fields)
			for _, key := range []string{"id", "projectId", "hostId", "storageHostId", "collectedAt", "collectionVersion"} {
				delete(fields, key)
			}
			fields["nativeId"] = "duplicate-fixture"
			first := map[string]any{"session": fields, "locator": Locator{Path: "/m-original", Source: string(s.Source), NativeID: "duplicate-fixture", Modified: 10}}
			second := map[string]any{"session": fields, "locator": Locator{Path: tc.path, Source: string(s.Source), NativeID: "duplicate-fixture", Modified: tc.modified}}
			p := New("fixture")
			payload := map[string]any{"version": 1, "observedAt": time.Now().UTC(), "records": []any{first, second}, "state": map[string]any{}, "failures": 0}
			raw, _ := json.Marshal(payload)
			p.Run = func(context.Context, string, []string, []byte) ([]byte, error) { return raw, nil }
			host := api.Host{Id: "local", Local: true}
			result, err := p.Collect(context.Background(), host, nil)
			if err != nil || len(result.Sessions) != 1 || result.Failures != 1 {
				t.Fatalf("not consolidated: %v %d %d", err, len(result.Sessions), result.Failures)
			}
			if result.Locators[result.Sessions[0].Id].Path != tc.want {
				t.Fatal("wrong representative")
			}
			m := store.New(api.Continuous, time.Now)
			m.AddLocal()
			if err = m.Commit("local", 1, result.Projects, result.Sessions, result.At); err != nil {
				t.Fatal("deduplicated batch still rejected", err)
			}
			p.Accept("local", result)
			// A subsequent identical discovery commits and advances the real version.
			next, err := p.Collect(context.Background(), host, nil)
			if err != nil {
				t.Fatal(err)
			}
			if err = m.Commit("local", 1, next.Projects, next.Sessions, next.At); err != nil {
				t.Fatal(err)
			}
			actual, _ := m.Session(result.Sessions[0].Id)
			if actual.CollectionVersion.Sequence != 2 {
				t.Fatal("version froze")
			}
			// Every record must still validate, even a duplicate that would lose.
			second["session"] = map[string]any{"nativeId": "duplicate-fixture", "source": s.Source}
			raw, _ = json.Marshal(payload)
			if _, err = p.Collect(context.Background(), host, nil); err == nil {
				t.Fatal("invalid duplicate hidden")
			}
		})
	}
}
func TestHelperProcess(t *testing.T) {
	if os.Getenv("BOARD_EXEC_HELPER") != "1" {
		return
	}
	args := os.Args
	index := 0
	for i, arg := range args {
		if arg == "--" {
			index = i + 1
			break
		}
	}
	if index == 0 {
		return
	}
	switch args[index] {
	case "tree":
		child := exec.Command(os.Args[0], "-test.run=TestHelperProcess", "--", "child", args[index+1])
		child.Stdout = os.Stdout
		child.Stderr = os.Stderr
		if child.Start() != nil {
			os.Exit(2)
		}
		time.Sleep(time.Minute)
	case "child":
		_ = os.WriteFile(args[index+1], []byte(fmtPID()), 0600)
		time.Sleep(time.Minute)
	case "output":
		os.Stdout.WriteString("fixture-output")
	}
	os.Exit(0)
}
func TestRunProcess(t *testing.T) {
	t.Setenv("BOARD_EXEC_HELPER", "1")
	data, err := Run(context.Background(), os.Args[0], []string{"-test.run=TestHelperProcess", "--", "output"}, nil)
	if err != nil || string(data) != "fixture-output" {
		t.Fatalf("Run failed %q %v", data, err)
	}
}
