package store

import (
	api "agents-board/backend-go/internal/api/generated"
	"testing"
	"time"
)

func TestHistoryProjectionCountsAndReadIsolation(t *testing.T) {
	now := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	p, s := fixture(t, now)
	m := New(api.Continuous, func() time.Time { return now })
	m.AddLocal()
	s.Source = api.SessionSourceCodexCli
	s.Status = api.SessionStatusUnread
	s.CompletedAt = Value(now.Add(-48 * time.Hour))
	s.ActivityAt = s.CompletedAt
	desktop := Copy(s)
	desktop.Id = "desktop-history"
	desktop.ProjectId = "old-project"
	desktop.Source = api.SessionSourceCodexDesktop
	desktop.Status = api.SessionStatusUnknown
	desktop.Reason = Value("历史会话缺少可靠运行状态证据。")
	desktop.CompletedAt = Null[time.Time]()
	desktop.ActivityAt = Value(now.Add(-8 * 24 * time.Hour))
	oldProject := Copy(p)
	oldProject.Id = desktop.ProjectId
	if err := m.Commit("local", 1, []api.Project{p, oldProject}, []api.Session{s, desktop}, now); err != nil {
		t.Fatal(err)
	}
	current := m.Dashboard()
	history := m.Dashboard(true)
	valid(t, "Dashboard", current)
	valid(t, "Dashboard", history)
	if current.SourceCounts == nil || len(*current.SourceCounts) != 4 {
		t.Fatal("missing source coverage")
	}
	for _, count := range *current.SourceCounts {
		if count.Collected != count.Visible+count.Hidden {
			t.Fatal("unbalanced source counts")
		}
		if count.Source == api.SourceCountSourceCodexCli || count.Source == api.SourceCountSourceCodexDesktop {
			if count.Collected != 1 || count.Visible != 0 || count.Hidden != 1 {
				t.Fatalf("current count: %+v", count)
			}
		}
	}
	for _, count := range *history.SourceCounts {
		if count.Hidden != 0 || count.Visible != count.Collected {
			t.Fatalf("history count: %+v", count)
		}
	}
	after, _ := m.Session(s.Id)
	if after.Status != api.SessionStatusRead || after.CollectionVersion.Sequence != 1 {
		t.Fatal("history read mutated session state")
	}
	// Unknown time in a shared project must preserve its other old Unknown session.
	uncertain := Copy(desktop)
	uncertain.Id = "unknown-time"
	uncertain.ActivityAt = Null[time.Time]()
	now = now.Add(time.Second)
	if err := m.Commit("local", 1, []api.Project{oldProject}, []api.Session{uncertain}, now); err != nil {
		t.Fatal(err)
	}
	for _, count := range *m.Dashboard().SourceCounts {
		if count.Source == api.SourceCountSourceCodexDesktop && (count.Visible != 2 || count.Hidden != 0) {
			t.Fatalf("shared unknown project: %+v", count)
		}
	}
}
