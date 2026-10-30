package scheduler

import (
	api "agents-board/backend-go/internal/api/generated"
	"agents-board/backend-go/internal/collector"
	"agents-board/backend-go/internal/store"
	"context"
	"encoding/json"
	"errors"
	"github.com/getkin/kin-openapi/openapi3"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type call struct {
	host    api.Host
	target  *api.Session
	release chan error
}
type fakeSource struct {
	calls    chan call
	session  api.Session
	project  api.Project
	accepted atomic.Int32
}

func (f *fakeSource) Collect(ctx context.Context, h api.Host, target *api.Session) (collector.Result, error) {
	c := call{h, target, make(chan error, 1)}
	f.calls <- c
	select {
	case <-ctx.Done():
		return collector.Result{}, ctx.Err()
	case err := <-c.release:
		if err != nil {
			return collector.Result{}, err
		}
	}
	session := store.Copy(f.session)
	session.StorageHostId = h.Id
	return collector.Result{At: time.Now().UTC(), Sessions: []api.Session{session}, Projects: []api.Project{f.project}}, nil
}
func (f *fakeSource) Accept(string, collector.Result) { f.accepted.Add(1) }
func (f *fakeSource) Forget(string)                   {}
func setup(t *testing.T) (*Scheduler, *fakeSource, *store.Memory) {
	t.Helper()
	d := store.Demo(time.Now).Dashboard()
	p := d.Projects[0]
	session := p.Sessions[0]
	m := store.New(api.Continuous, time.Now)
	m.AddLocal()
	if err := m.Commit("local", 1, []api.Project{p}, []api.Session{session}, time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	f := &fakeSource{calls: make(chan call, 10), session: session, project: p}
	s := New(context.Background(), m, f, time.Hour)
	t.Cleanup(s.Close)
	return s, f, m
}
func nextCall(t *testing.T, f *fakeSource) call {
	t.Helper()
	select {
	case c := <-f.calls:
		return c
	case <-time.After(3 * time.Second):
		t.Fatal("no collection dispatched")
		return call{}
	}
}
func terminal(t *testing.T, s *Scheduler, id string) api.RefreshJob {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		j, err := s.Job(id)
		if err != nil {
			t.Fatal(err)
		}
		if !isActive(j) {
			return j
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("job did not finish")
	return api.RefreshJob{}
}
func validateJob(t *testing.T, job api.RefreshJob) {
	t.Helper()
	spec, _ := api.GetSwagger()
	data, _ := json.Marshal(job)
	var value any
	_ = json.Unmarshal(data, &value)
	if err := spec.Components.Schemas["RefreshJob"].Value.VisitJSON(value, openapi3.EnableJSONSchema2020()); err != nil {
		t.Fatal(err)
	}
}
func TestRefreshDoesNotReuseEarlierBackgroundRead(t *testing.T) {
	s, f, m := setup(t)
	background := nextCall(t, f)
	if background.target != nil {
		t.Fatal("expected discovery")
	}
	job, err := s.Request(f.session.Id)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := s.Request(f.session.Id)
	if err != nil || duplicate.Id != job.Id {
		t.Fatal("not merged")
	}
	validateJob(t, job)
	background.release <- nil
	targeted := nextCall(t, f)
	if targeted.target == nil || targeted.target.Id != f.session.Id {
		t.Fatal("target not read")
	}
	current, _ := s.Job(job.Id)
	if current.Status != api.RefreshJobStatusRunning {
		t.Fatal("background wrongly completed job")
	}
	validateJob(t, current)
	targeted.release <- nil
	result := terminal(t, s, job.Id)
	validateJob(t, result)
	if result.Status != api.RefreshJobStatusSucceeded {
		t.Fatal(result)
	}
	session, _ := m.Session(f.session.Id)
	if store.Get(result.CollectionVersion) != *session.CollectionVersion {
		t.Fatal("wrong version")
	}
	next, err := s.Request(f.session.Id)
	if err != nil || next.Id == job.Id {
		t.Fatal("terminal job reused")
	}
}
func TestFailureRetainsVersionAndTTL(t *testing.T) {
	s, f, m := setup(t)
	background := nextCall(t, f)
	background.release <- nil
	for f.accepted.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	before, _ := m.Session(f.session.Id)
	job, err := s.Request(f.session.Id)
	if err != nil {
		t.Fatal(err)
	}
	target := nextCall(t, f)
	target.release <- errors.New("secret fixture must not escape")
	failed := terminal(t, s, job.Id)
	validateJob(t, failed)
	if failed.Status != api.RefreshJobStatusFailed {
		t.Fatal(failed.Status)
	}
	after, _ := m.Session(f.session.Id)
	if *after.CollectionVersion != *before.CollectionVersion || !after.CollectedAt.Equal(*before.CollectedAt) {
		t.Fatal("failure advanced version/time")
	}
	encoded, _ := json.Marshal(failed)
	if len(encoded) == 0 || strings.Contains(string(encoded), "secret fixture") {
		t.Fatal("empty job or leaked raw error")
	}
	s.mu.Lock()
	s.now = func() time.Time { return store.Get(failed.ExpiresAt).Add(time.Second) }
	s.mu.Unlock()
	if _, err = s.Job(job.Id); err == nil {
		t.Fatal("expired job accessible")
	}
}

func TestDirectedResultUsesCommittedVersionNotWallClock(t *testing.T) {
	for _, tc := range []struct {
		name          string
		includeTarget bool
		obsolete      bool
		want          api.RefreshJobStatus
	}{
		{"same-clock-tick", true, false, api.RefreshJobStatusSucceeded},
		{"missing-target-does-not-reuse-cache", false, false, api.RefreshJobStatusFailed},
		{"obsolete-batch-does-not-reuse-version", true, true, api.RefreshJobStatusFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now().UTC()
			p := store.Demo(func() time.Time { return now }).Dashboard().Projects[0]
			target := p.Sessions[0]
			target.StorageHostId = "local"
			m := store.New(api.Continuous, func() time.Time { return now })
			m.AddLocal()
			if err := m.Commit("local", 1, []api.Project{p}, []api.Session{target}, now.Add(-time.Second)); err != nil {
				t.Fatal(err)
			}
			f := &fakeSource{}
			s := &Scheduler{ctx: context.Background(), memory: m, source: f, now: func() time.Time { return now }, interval: time.Hour,
				active:   map[string]active{"local": {cancel: func() {}, generation: 1, jobID: "job"}},
				jobs:     map[string]api.RefreshJob{"job": {Id: "job", SessionId: target.Id, Status: api.RefreshJobStatusRunning, RequestedAt: now}},
				failures: map[string]int{}, next: map[string]time.Time{}, pending: map[string]bool{}}
			result := collector.Result{At: now, Projects: []api.Project{p}}
			if tc.includeTarget {
				result.Sessions = []api.Session{target}
			}
			if tc.obsolete {
				result.At = now.Add(-time.Second)
			}
			s.completed(completion{host: "local", generation: 1, jobID: "job", result: result})
			job := s.jobs["job"]
			if job.Status != tc.want {
				t.Fatalf("got %s, want %s", job.Status, tc.want)
			}
			if tc.want == api.RefreshJobStatusSucceeded && store.Get(job.CollectionVersion).Sequence != 2 {
				t.Fatal("target version did not advance")
			}
		})
	}
}
func TestCancellationReapsWorkers(t *testing.T) {
	s, f, _ := setup(t)
	_ = nextCall(t, f)
	finished := make(chan struct{})
	go func() { s.Close(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("close did not wait/cancel")
	}
	if _, err := s.Request(f.session.Id); err == nil {
		t.Fatal("closed scheduler accepted work")
	}
}
func TestDisableRejectsLateCollection(t *testing.T) {
	s, f, m := setup(t)
	first := nextCall(t, f)
	first.release <- nil
	for f.accepted.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	h, err := m.AddHost("synthetic-remote")
	if err != nil {
		t.Fatal(err)
	}
	s.Changed(h.Id)
	pending := nextCall(t, f)
	if pending.host.Id != h.Id {
		t.Fatal("wrong host")
	}
	if err = m.Enable(h.Id, false); err != nil {
		t.Fatal(err)
	}
	s.Changed(h.Id)
	pending.release <- nil
	time.Sleep(20 * time.Millisecond)
	for _, host := range m.Hosts().Hosts {
		if host.Id == h.Id && host.Connection == api.HostConnectionOnline {
			t.Fatal("late collection revived disabled host")
		}
	}
}

func TestGlobalConcurrencyAndSlowHostIsolation(t *testing.T) {
	d := store.Demo(time.Now).Dashboard()
	f := &fakeSource{calls: make(chan call, 20), session: d.Projects[0].Sessions[0], project: d.Projects[0]}
	m := store.New(api.Continuous, time.Now)
	for _, name := range []string{"one", "two", "three", "four", "five"} {
		if _, err := m.AddHost(name); err != nil {
			t.Fatal(err)
		}
	}
	s := New(context.Background(), m, f, time.Hour)
	t.Cleanup(s.Close)
	first := nextCall(t, f)
	second := nextCall(t, f)
	_ = nextCall(t, f)
	select {
	case <-f.calls:
		t.Fatal("exceeded three workers")
	case <-time.After(30 * time.Millisecond):
	}
	// One completed worker makes room despite the two remaining slow hosts.
	first.release <- nil
	fourth := nextCall(t, f)
	if fourth.host.Id == first.host.Id {
		t.Fatal("unfair redispatch")
	}
	second.release <- errors.New("synthetic timeout")
	_ = nextCall(t, f)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		failures, next := s.failures[second.host.Id], s.next[second.host.Id]
		s.mu.Unlock()
		if failures == 1 {
			if time.Until(next) < 119*time.Minute {
				t.Fatal("failure did not back off")
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("failed host never completed")
}
