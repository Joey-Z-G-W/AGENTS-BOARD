// Package scheduler serializes collection per host and bounds global work.
package scheduler

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	api "agents-board/backend-go/internal/api/generated"
	"agents-board/backend-go/internal/collector"
	"agents-board/backend-go/internal/store"
	"github.com/google/uuid"
)

type active struct {
	cancel     context.CancelFunc
	generation uint64
	jobID      string
}
type completion struct {
	host       string
	generation uint64
	jobID      string
	result     collector.Result
	err        error
}
type Scheduler struct {
	mu       sync.Mutex
	memory   *store.Memory
	source   collector.Source
	ctx      context.Context
	cancel   context.CancelFunc
	now      func() time.Time
	interval time.Duration
	jobs     map[string]api.RefreshJob
	pending  map[string]bool
	active   map[string]active
	next     map[string]time.Time
	failures map[string]int
	wake     chan struct{}
	done     chan completion
	stopped  chan struct{}
	wg       sync.WaitGroup
	closed   bool
}

func New(parent context.Context, memory *store.Memory, source collector.Source, interval time.Duration) *Scheduler {
	if interval <= 0 {
		interval = 15 * time.Second
	}
	ctx, cancel := context.WithCancel(parent)
	s := &Scheduler{memory: memory, source: source, ctx: ctx, cancel: cancel, now: time.Now, interval: interval, jobs: map[string]api.RefreshJob{}, pending: map[string]bool{}, active: map[string]active{}, next: map[string]time.Time{}, failures: map[string]int{}, wake: make(chan struct{}, 1), done: make(chan completion, 3), stopped: make(chan struct{})}
	go s.loop()
	_ = s.Refresh()
	return s
}
func (s *Scheduler) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
func (s *Scheduler) Close() { s.cancel(); <-s.stopped }
func (s *Scheduler) Refresh() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.ctx.Err() != nil {
		return store.Failure(503, api.SERVICEUNAVAILABLE, "采集服务已停止。")
	}
	for _, h := range s.memory.Hosts().Hosts {
		if h.Enabled {
			s.pending[h.Id] = true
		}
	}
	s.signal()
	return nil
}
func (s *Scheduler) Changed(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if running, ok := s.active[id]; ok {
		running.cancel()
	}
	if _, _, err := s.memory.Target(id); err != nil {
		delete(s.pending, id)
		delete(s.next, id)
		delete(s.failures, id)
		s.source.Forget(id)
		for key, j := range s.jobs {
			session, err := s.memory.Session(j.SessionId)
			if err != nil {
				delete(s.jobs, key)
			} else if session.StorageHostId == id && isActive(j) {
				s.finish(&j, nil, store.Failure(409, api.HOSTDISABLED, "主机已停用。"))
				s.jobs[key] = j
			}
		}
	} else {
		s.pending[id] = true
		delete(s.next, id)
	}
	s.signal()
}
func isActive(job api.RefreshJob) bool {
	return job.Status == api.RefreshJobStatusQueued || job.Status == api.RefreshJobStatusRunning
}
func (s *Scheduler) purge() {
	now := s.now()
	for id, job := range s.jobs {
		if expiry, err := job.ExpiresAt.Get(); err == nil && !expiry.After(now) {
			delete(s.jobs, id)
		}
	}
}
func (s *Scheduler) Request(id string) (api.RefreshJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.ctx.Err() != nil {
		return api.RefreshJob{}, store.Failure(503, api.SERVICEUNAVAILABLE, "采集服务已停止。")
	}
	session, err := s.memory.Session(id)
	if err != nil {
		return api.RefreshJob{}, err
	}
	if _, _, err = s.memory.Target(session.StorageHostId); err != nil {
		return api.RefreshJob{}, err
	}
	s.purge()
	for _, job := range s.jobs {
		if job.SessionId == id && isActive(job) {
			return store.Copy(job), nil
		}
	}
	if len(s.jobs) >= 128 {
		return api.RefreshJob{}, store.Failure(429, api.RATELIMITED, "刷新作业已达上限，请稍后重试。")
	}
	job := api.RefreshJob{Id: uuid.NewString(), SessionId: id, Status: api.RefreshJobStatusQueued, RequestedAt: s.now().UTC(), StartedAt: store.Null[time.Time](), FinishedAt: store.Null[time.Time](), ExpiresAt: store.Null[time.Time](), CollectionVersion: store.Null[api.CollectionVersion](), Error: store.Null[api.Error]()}
	s.jobs[job.Id] = job
	s.signal()
	return store.Copy(job), nil
}
func (s *Scheduler) Job(id string) (api.RefreshJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.purge()
	job, ok := s.jobs[id]
	if !ok {
		return job, store.Failure(404, api.NOTFOUND, "刷新作业不存在或已过期。")
	}
	return store.Copy(job), nil
}
func (s *Scheduler) finish(job *api.RefreshJob, version *api.CollectionVersion, err error) {
	now := s.now().UTC()
	job.FinishedAt = store.Value(now)
	job.ExpiresAt = store.Value(now.Add(10 * time.Minute))
	if err != nil {
		job.Status = api.RefreshJobStatusFailed
		job.CollectionVersion = store.Null[api.CollectionVersion]()
		job.Error = store.Value(api.Error{Code: api.REFRESHFAILED, Message: "无法重新读取目标会话，已保留上次结果。"})
	} else {
		job.Status = api.RefreshJobStatusSucceeded
		job.CollectionVersion = store.Value(*version)
		job.Error = store.Null[api.Error]()
	}
}
func (s *Scheduler) dispatch() {
	if s.closed || s.ctx.Err() != nil {
		return
	}
	s.purge()
	// Oldest queued request first; each host remains single-flight.
	for len(s.active) < 3 {
		hostID, jobID := "", ""
		var chosen api.RefreshJob
		var target *api.Session
		for id, j := range s.jobs {
			if j.Status != api.RefreshJobStatusQueued {
				continue
			}
			session, err := s.memory.Session(j.SessionId)
			if err != nil {
				s.finish(&j, nil, err)
				s.jobs[id] = j
				continue
			}
			if _, busy := s.active[session.StorageHostId]; busy {
				continue
			}
			if jobID == "" || j.RequestedAt.Before(chosen.RequestedAt) {
				hostID = session.StorageHostId
				jobID = id
				chosen = j
				copy := session
				target = &copy
			}
		}
		if hostID == "" {
			for id := range s.pending {
				if _, busy := s.active[id]; !busy && (hostID == "" || s.next[id].Before(s.next[hostID])) {
					hostID = id
				}
			}
		}
		if hostID == "" {
			return
		}
		host, generation, err := s.memory.Target(hostID)
		if err != nil {
			delete(s.pending, hostID)
			if jobID != "" {
				s.finish(&chosen, nil, err)
				s.jobs[jobID] = chosen
			}
			continue
		}
		delete(s.pending, hostID)
		ctx, cancel := context.WithTimeout(s.ctx, collector.CollectionTimeout+5*time.Second)
		s.active[hostID] = active{cancel: cancel, generation: generation, jobID: jobID}
		if jobID != "" {
			chosen.Status = api.RefreshJobStatusRunning
			chosen.StartedAt = store.Value(s.now().UTC())
			s.jobs[jobID] = chosen
		}
		s.wg.Add(1)
		go func(h api.Host, g uint64, j string, t *api.Session) {
			defer s.wg.Done()
			result, err := s.source.Collect(ctx, h, t)
			if ctx.Err() != nil {
				err = ctx.Err()
			}
			s.done <- completion{h.Id, g, j, result, err}
		}(host, generation, jobID, target)
	}
}
func (s *Scheduler) completed(c completion) {
	running, ok := s.active[c.host]
	if !ok {
		return
	}
	running.cancel()
	delete(s.active, c.host)
	err := c.err
	failureStage := "none"
	if err != nil {
		failureStage = "read"
	}
	if s.ctx.Err() != nil {
		err = s.ctx.Err()
		failureStage = "cancel"
	}
	// A directed read is dispatched after its request. Prove its result by
	// identity and committed version, not wall-clock precision (Windows can
	// timestamp the request and the subsequent read in the same clock tick).
	var previousTargetVersion *api.CollectionVersion
	targetObserved := false
	if job, exists := s.jobs[c.jobID]; c.jobID != "" && exists && running.jobID == c.jobID && job.Status == api.RefreshJobStatusRunning {
		before, readErr := s.memory.Session(job.SessionId)
		if readErr == nil {
			previousTargetVersion = before.CollectionVersion
		}
		for _, session := range c.result.Sessions {
			if session.Id == job.SessionId && session.StorageHostId == c.host {
				targetObserved = true
			}
		}
	}
	if err == nil {
		err = s.memory.Commit(c.host, c.generation, c.result.Projects, c.result.Sessions, c.result.At)
		if err != nil {
			failureStage = "commit"
		}
	}
	slog.Debug("collection completed", "hostId", c.host, "sessions", len(c.result.Sessions), "partialFailures", c.result.Failures, "duplicateRecords", c.result.Duplicates, "failed", err != nil, "failureStage", failureStage, "directed", c.jobID != "")
	if err == nil {
		s.source.Accept(c.host, c.result)
		if c.jobID == "" {
			s.memory.Report(c.host, c.generation, c.result.Failures, c.result.Diagnostics)
		} else {
			s.memory.Report(c.host, c.generation, c.result.Failures)
		}
		s.failures[c.host] = 0
	} else {
		s.memory.Failed(c.host, c.generation)
		s.failures[c.host]++
	}
	delay := s.interval
	for i := 0; i < s.failures[c.host] && i < 4; i++ {
		delay *= 2
	}
	s.next[c.host] = s.now().Add(delay)
	if _, _, targetErr := s.memory.Target(c.host); targetErr != nil {
		delete(s.next, c.host)
		delete(s.failures, c.host)
		delete(s.pending, c.host)
	}
	if c.jobID != "" {
		if job, exists := s.jobs[c.jobID]; exists && isActive(job) {
			var version *api.CollectionVersion
			if err == nil {
				session, readErr := s.memory.Session(job.SessionId)
				if readErr != nil || !targetObserved || previousTargetVersion == nil || session.CollectionVersion == nil || session.CollectionVersion.Epoch != previousTargetVersion.Epoch || session.CollectionVersion.Sequence <= previousTargetVersion.Sequence {
					err = errors.New("no new target observation")
				} else {
					version = session.CollectionVersion
				}
			}
			s.finish(&job, version, err)
			s.jobs[c.jobID] = job
		}
	}
}
func (s *Scheduler) loop() {
	defer close(s.stopped)
	ticker := time.NewTicker(min(s.interval, time.Second))
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			s.mu.Lock()
			s.closed = true
			for _, a := range s.active {
				a.cancel()
			}
			for id, j := range s.jobs {
				if isActive(j) {
					s.finish(&j, nil, s.ctx.Err())
					s.jobs[id] = j
				}
			}
			s.mu.Unlock()
			s.wg.Wait()
			return
		case c := <-s.done:
			s.mu.Lock()
			s.completed(c)
			s.dispatch()
			s.mu.Unlock()
		case <-s.wake:
			s.mu.Lock()
			s.dispatch()
			s.mu.Unlock()
		case <-ticker.C:
			s.mu.Lock()
			for _, h := range s.memory.Hosts().Hosts {
				if _, busy := s.active[h.Id]; h.Enabled && !busy && !s.next[h.Id].After(s.now()) {
					s.pending[h.Id] = true
				}
			}
			s.dispatch()
			s.mu.Unlock()
		}
	}
}
