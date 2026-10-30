package collector

import (
	api "agents-board/backend-go/internal/api/generated"
	"agents-board/backend-go/internal/store"
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestSyntheticPythonSubagentsThroughProtocolAndParentRefresh(t *testing.T) {
	python, err := exec.LookPath("python")
	if err != nil {
		t.Skip("Python unavailable")
	}
	home := t.TempDir()
	folder := filepath.Join(home, ".codex", "sessions")
	if err = os.MkdirAll(folder, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", filepath.Dir(folder))
	t.Setenv("APPDATA", filepath.Join(home, "empty"))
	parent := `{"type":"session_meta","payload":{"id":"parent","source":"cli"}}
{"type":"event_msg","timestamp":"2026-10-24T01:00:00Z","payload":{"type":"task_started","turn_id":"parent-turn"}}
`
	child := `{"type":"session_meta","payload":{"id":"child","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent","agent_path":"/root/swe"}}}}}
{"type":"event_msg","timestamp":"2026-10-24T01:00:00Z","payload":{"type":"task_started","turn_id":"child-turn"}}
{"type":"turn_context","timestamp":"2026-10-24T01:00:01Z","payload":{"turn_id":"child-turn","model":"actual","effort":"high"}}
{"type":"event_msg","timestamp":"2026-10-24T01:00:02Z","payload":{"type":"task_complete","turn_id":"child-turn","last_agent_message":"result"}}
`
	if err = os.WriteFile(filepath.Join(folder, "parent.jsonl"), []byte(parent), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(folder, "child.jsonl"), []byte(child), 0600); err != nil {
		t.Fatal(err)
	}
	protocol := New(python)
	protocol.Run = func(ctx context.Context, command string, args []string, input []byte) ([]byte, error) {
		input = bytes.Replace(input, []byte("request = json.loads"), []byte("Path.home = staticmethod(lambda: Path(os.environ['CODEX_HOME']).parent)\nrequest = json.loads"), 1)
		return Run(ctx, command, args, input)
	}
	host := api.Host{Id: "local", Local: true}
	result, err := protocol.Collect(context.Background(), host, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Sessions) != 1 || result.Sessions[0].Subagents == nil || len(result.Sessions[0].Subagents.Items) != 1 {
		t.Fatal("invalid parent/child projection", result)
	}
	s := result.Sessions[0]
	if s.Status != api.SessionStatusUnknown || s.Subagents.Items[0].Status != api.SubagentStatusCompleted || store.Get(s.Subagents.Items[0].Model) != "actual" {
		t.Fatal("lifecycle or runtime was not isolated")
	}
	m := store.New(api.Continuous, time.Now)
	m.AddLocal()
	if err = m.Commit("local", 1, result.Projects, result.Sessions, result.At); err != nil {
		t.Fatal(err)
	}
	protocol.Accept("local", result)
	refreshed, err := protocol.Collect(context.Background(), host, &s)
	if err != nil {
		t.Fatal(err)
	}
	if len(refreshed.Sessions) != 1 || refreshed.Sessions[0].Subagents != nil {
		t.Fatal("directed refresh published children")
	}
	if err = m.Commit("local", 1, refreshed.Projects, refreshed.Sessions, refreshed.At); err != nil {
		t.Fatal(err)
	}
	saved, _ := m.Session(s.Id)
	if saved.Subagents == nil || !saved.Subagents.Items[0].CollectedAt.Equal(s.Subagents.Items[0].CollectedAt) {
		t.Fatal("lost original child observation")
	}
	if len(m.Dashboard(true).Projects[0].Sessions) != 1 {
		t.Fatal("child counted as main session")
	}
}
