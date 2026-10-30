package store

import (
	api "agents-board/backend-go/internal/api/generated"
	"encoding/json"
	"errors"
	"github.com/getkin/kin-openapi/openapi3"
	"sync"
	"testing"
	"time"
)

func fixture(t *testing.T, now time.Time) (api.Project, api.Session) {
	t.Helper()
	d := Demo(func() time.Time { return now }).Dashboard()
	if len(d.Projects) != 1 || len(d.Projects[0].Sessions) != 1 {
		t.Fatalf("missing demo: %+v", d)
	}
	return d.Projects[0], d.Projects[0].Sessions[0]
}
func valid(t *testing.T, schema string, value any) {
	t.Helper()
	spec, err := api.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var decoded any
	if err = json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if err = spec.Components.Schemas[schema].Value.VisitJSON(decoded, openapi3.EnableJSONSchema2020()); err != nil {
		t.Fatalf("%s invalid: %v", schema, err)
	}
}
func TestFreshnessIsolationAndRead(t *testing.T) {
	now := time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC)
	p, s := fixture(t, now)
	m := New(api.Continuous, func() time.Time { return now })
	m.AddLocal()
	if err := m.Commit("local", 1, []api.Project{p}, []api.Session{s}, now); err != nil {
		t.Fatal(err)
	}
	first, _ := m.Session(s.Id)
	if first.Status != api.SessionStatusRead {
		t.Fatal("first import must be baseline")
	}
	valid(t, "Session", first)
	copy := first
	copy.Evidence.Reason.Set("changed outside")
	copy.CollectionVersion.Sequence = 400
	actual, _ := m.Session(s.Id)
	if actual.CollectionVersion.Sequence != 1 || Get(actual.Evidence.Reason) == "changed outside" {
		t.Fatal("mutable state escaped")
	}
	now = now.Add(time.Second)
	s.TurnId = Value("turn-next")
	s.Status = api.SessionStatusUnread
	if err := m.Commit("local", 1, []api.Project{p}, []api.Session{s}, now); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Read(s.Id, Get(first.TurnId)); err == nil {
		t.Fatal("old turn accepted")
	}
	read, err := m.Read(s.Id, "turn-next")
	if err != nil || read.Status != api.SessionStatusRead || read.CollectionVersion.Sequence != 2 {
		t.Fatalf("read: %+v %v", read, err)
	}
	now = now.Add(46 * time.Second)
	other := Copy(s)
	other.Id = "other"
	if err = m.Commit("local", 1, []api.Project{p}, []api.Session{other}, now); err != nil {
		t.Fatal(err)
	}
	stale, _ := m.Session(s.Id)
	if stale.Freshness != api.Stale {
		t.Fatal("host refresh washed stale session")
	}
	valid(t, "Session", stale)
	if _, err = m.Read(s.Id, "turn-next"); err == nil {
		t.Fatal("stale read accepted")
	}
	valid(t, "Dashboard", m.Dashboard())
}
func TestHostGenerationAndLateBatch(t *testing.T) {
	now := time.Now().UTC()
	p, s := fixture(t, now)
	m := New(api.Continuous, func() time.Time { return now })
	m.AddLocal()
	h, err := m.AddHost("demo-host")
	if err != nil {
		t.Fatal(err)
	}
	s.StorageHostId = h.Id
	s.HostId = Value(h.Id)
	if err = m.Commit(h.Id, 1, []api.Project{p}, []api.Session{s}, now); err != nil {
		t.Fatal(err)
	}
	if err = m.Enable(h.Id, false); err != nil {
		t.Fatal(err)
	}
	if err = m.Enable(h.Id, true); err != nil {
		t.Fatal(err)
	}
	if err = m.Commit(h.Id, 1, []api.Project{p}, []api.Session{s}, now.Add(time.Second)); err == nil {
		t.Fatal("old generation accepted")
	}
	if err = m.Remove(h.Id); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Session(s.Id); err == nil {
		t.Fatal("deleted storage host retained session")
	}
	if err = m.Commit(h.Id, 3, []api.Project{p}, []api.Session{s}, now.Add(time.Second)); err == nil {
		t.Fatal("deleted host revived")
	}
	if err = m.Commit("local", 1, nil, nil, now); err != nil {
		t.Fatal(err)
	}
	if err = m.Commit("local", 1, nil, nil, now.Add(-time.Second)); err == nil {
		t.Fatal("late batch accepted")
	}
	if !Get(m.Hosts().Hosts[0].LastSuccessAt).Equal(now) {
		t.Fatal("last success regressed")
	}
}
func TestConcurrentReadTurnChange(t *testing.T) {
	now := time.Now().UTC()
	p, s := fixture(t, now)
	m := New(api.Continuous, time.Now)
	m.AddLocal()
	if err := m.Commit("local", 1, []api.Project{p}, []api.Session{s}, now); err != nil {
		t.Fatal(err)
	}
	s.TurnId = Value("new-turn")
	s.Status = api.SessionStatusUnread
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_ = m.Commit("local", 1, []api.Project{p}, []api.Session{s}, now.Add(time.Millisecond))
	}()
	go func() { defer wg.Done(); _, _ = m.Read(s.Id, "turn-demo-2") }()
	wg.Wait()
	result, _ := m.Session(s.Id)
	if result.Status != api.SessionStatusUnread || Get(result.TurnId) != "new-turn" {
		t.Fatal("old read consumed new turn")
	}
}
func TestTargets(t *testing.T) {
	for _, target := range []string{"-oProxyCommand=x", "host;cmd", "user@host:22", "host name", "a@@b", "foo\nbar", ""} {
		if _, err := NormalizeTarget(target); err == nil {
			t.Errorf("accepted %q", target)
		}
	}
	m := New(api.InMemoryDemo, nil)
	m.AddLocal()
	for _, target := range []string{"localhost", "127.1.2.3", "[::1]"} {
		_, err := m.AddHost(target)
		var e *Error
		if !errors.As(err, &e) || e.Code != api.HOSTEXISTS {
			t.Errorf("loopback accepted: %s", target)
		}
	}
}

func TestFixedImportBaselineAndRemovedExecutionHost(t *testing.T) {
	now := time.Now().UTC()
	p, session := fixture(t, now)
	m := New(api.Continuous, func() time.Time { return now })
	m.AddLocal()
	remote, err := m.AddHost("execution-host")
	if err != nil {
		t.Fatal(err)
	}
	// The collector resolved this identity before deletion, but commits afterwards.
	session.HostId = Value(remote.Id)
	if err = m.Remove(remote.Id); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	session.CompletedAt = Value(now)
	if err = m.Commit("local", 1, []api.Project{p}, []api.Session{session}, now); err != nil {
		t.Fatal(err)
	}
	actual, _ := m.Session(session.Id)
	if actual.Status != api.SessionStatusUnread || !actual.HostId.IsNull() {
		t.Fatal("newly discovered completion lost or removed host revived")
	}
	historical := Copy(session)
	historical.Id = "late-discovered-history"
	historical.CompletedAt = Value(now.Add(-2 * time.Minute))
	if err = m.Commit("local", 1, []api.Project{p}, []api.Session{historical}, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	actual, _ = m.Session(historical.Id)
	if actual.Status != api.SessionStatusRead || actual.Evidence.Basis != api.InitialImport {
		t.Fatal("old history not baseline")
	}
	m.SetCandidates(nil)
	valid(t, "HostSettings", m.Hosts())
}
