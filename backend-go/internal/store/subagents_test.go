package store

import (
	api "agents-board/backend-go/internal/api/generated"
	"testing"
	"time"
)

func TestSubagentCacheIndependentOfParentRefreshReadAndCounts(t *testing.T) {
	now := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	m := New(api.Continuous, func() time.Time { return now })
	m.AddLocal()
	p, s := fixture(t, now)
	s.Subagents = &api.SubagentCollection{Status: api.SubagentCollectionStatusComplete, ScannedAt: now, Items: []api.Subagent{{NativeId: "child", ParentThreadId: "parent", CollectedAt: now, Status: api.SubagentStatusCompleted, Freshness: api.SubagentFreshnessFresh, Nickname: Null[string](), Path: Null[string](), Role: Null[string](), Model: Value("actual"), Effort: Value("high"), ModelObservedAt: Value(now), TurnId: Value("child-turn"), Prompt: Value("child task"), Response: Value("child result"), Reason: Null[string](), StartedAt: Null[time.Time](), CompletedAt: Value(now), ActivityAt: Value(now)}}}
	if err := m.Commit("local", 1, []api.Project{p}, []api.Session{s}, now); err != nil {
		t.Fatal(err)
	}
	initial, _ := m.Session(s.Id)
	valid(t, "Session", initial)
	if len(m.Dashboard().Projects[0].Sessions) != 1 {
		t.Fatal("child counted as main session")
	}
	now = now.Add(time.Second)
	s.Subagents = nil
	if err := m.Commit("local", 1, []api.Project{p}, []api.Session{s}, now); err != nil {
		t.Fatal(err)
	}
	updated, _ := m.Session(s.Id)
	if updated.Subagents == nil || !updated.Subagents.Items[0].CollectedAt.Equal(initial.Subagents.Items[0].CollectedAt) || !updated.Subagents.ScannedAt.Equal(initial.Subagents.ScannedAt) {
		t.Fatal("parent refresh changed child observation")
	}
	if _, err := m.Read(s.Id, Get(s.TurnId)); err != nil {
		t.Fatal(err)
	}
	read, _ := m.Session(s.Id)
	if read.Subagents.Items[0].Status != api.SubagentStatusCompleted {
		t.Fatal("parent read changed child completion")
	}
	now = now.Add(time.Minute)
	if err := m.Commit("local", 1, []api.Project{p}, []api.Session{s}, now); err != nil {
		t.Fatal(err)
	}
	stale, _ := m.Session(s.Id)
	if stale.Freshness != api.Fresh || stale.Subagents.Items[0].Freshness != api.SubagentFreshnessStale {
		t.Fatal("child freshness followed parent")
	}
	stale.Subagents.Items[0].NativeId = "mutated-copy"
	original, _ := m.Session(s.Id)
	if original.Subagents.Items[0].NativeId != "child" {
		t.Fatal("returned nested cache aliases storage")
	}
}
