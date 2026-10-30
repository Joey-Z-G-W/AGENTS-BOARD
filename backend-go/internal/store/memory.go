// Package store owns atomic, process-local board state. Returned values are copies.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	api "agents-board/backend-go/internal/api/generated"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

type Error struct {
	Status  int
	Code    api.ErrorCode
	Message string
}

func (e *Error) Error() string { return e.Message }
func Failure(status int, code api.ErrorCode, message string) error {
	return &Error{status, code, message}
}
func Null[T any]() nullable.Nullable[T] {
	var value nullable.Nullable[T]
	value.SetNull()
	return value
}
func Value[T any](value T) nullable.Nullable[T] {
	var result nullable.Nullable[T]
	result.Set(value)
	return result
}
func Get[T any](value nullable.Nullable[T]) T { result, _ := value.Get(); return result }
func Copy[T any](value T) T {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var result T
	if err = json.Unmarshal(data, &result); err != nil {
		panic(err)
	}
	return result
}

type Memory struct {
	mu          sync.RWMutex
	now         func() time.Time
	epoch       string
	mode        api.HealthMode
	hosts       map[string]api.Host
	generations map[string]uint64
	projects    map[string]api.Project
	sessions    map[string]api.Session
	candidates  []api.SshCandidate
	baseline    map[string]time.Time
	partial     map[string]int
	diagnostics map[string]map[string]int
}

func New(mode api.HealthMode, now func() time.Time) *Memory {
	if now == nil {
		now = time.Now
	}
	return &Memory{now: now, epoch: uuid.NewString(), mode: mode, hosts: map[string]api.Host{}, generations: map[string]uint64{}, projects: map[string]api.Project{}, sessions: map[string]api.Session{}, candidates: []api.SshCandidate{}, baseline: map[string]time.Time{}, partial: map[string]int{}, diagnostics: map[string]map[string]int{}}
}
func (m *Memory) Mode() api.HealthMode { return m.mode }
func (m *Memory) AddLocal() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.hosts["local"]; ok {
		return
	}
	m.hosts["local"] = api.Host{Id: "local", Name: "本机", Address: "localhost", Local: true, Enabled: true, Connection: api.HostConnectionUnknown, LastSuccessAt: Null[time.Time](), Error: Null[string]()}
	m.generations["local"] = 1
	m.baseline["local"] = m.now()
}
func (m *Memory) SetCandidates(candidates []api.SshCandidate) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.candidates = Copy(candidates)
	if m.candidates == nil {
		m.candidates = []api.SshCandidate{}
	}
}
func (m *Memory) Hosts() api.HostSettings {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := api.HostSettings{Hosts: []api.Host{}, Candidates: Copy(m.candidates)}
	for _, host := range m.hosts {
		result.Hosts = append(result.Hosts, Copy(host))
	}
	sort.Slice(result.Hosts, func(i, j int) bool { return result.Hosts[i].Id < result.Hosts[j].Id })
	return result
}
func (m *Memory) Target(id string) (api.Host, uint64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	h, ok := m.hosts[id]
	if !ok {
		return h, 0, Failure(404, api.NOTFOUND, "主机不存在。")
	}
	if !h.Enabled {
		return h, 0, Failure(409, api.HOSTDISABLED, "主机已停用。")
	}
	return Copy(h), m.generations[id], nil
}

var targetUser = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$`)
var targetLabel = regexp.MustCompile(`^[a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?$`)

func NormalizeTarget(target string) (string, error) {
	invalid := Failure(400, api.INVALIDTARGET, "目标必须是 SSH 别名或 user@host，不能包含选项、端口或 shell 语法。")
	if target == "" || len(target) > 255 {
		return "", invalid
	}
	parts := strings.Split(target, "@")
	if len(parts) > 2 || len(parts) == 2 && !targetUser.MatchString(parts[0]) {
		return "", invalid
	}
	host := parts[len(parts)-1]
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	if net.ParseIP(host) == nil {
		for _, label := range strings.Split(host, ".") {
			if !targetLabel.MatchString(label) {
				return "", invalid
			}
		}
	}
	prefix := ""
	if len(parts) == 2 {
		prefix = parts[0] + "@"
	}
	return prefix + strings.ToLower(host), nil
}
func (m *Memory) AddHost(target string) (api.Host, error) {
	address, err := NormalizeTarget(target)
	if err != nil {
		return api.Host{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	hostpart := strings.Split(address, "@")
	name := hostpart[len(hostpart)-1]
	ip := net.ParseIP(name)
	if strings.EqualFold(name, "localhost") || ip != nil && ip.IsLoopback() {
		return api.Host{}, Failure(409, api.HOSTEXISTS, "本机已存在。")
	}
	for _, host := range m.hosts {
		if host.Address == address {
			return api.Host{}, Failure(409, api.HOSTEXISTS, "监控目标已存在。")
		}
	}
	if len(m.hosts) >= 64 {
		return api.Host{}, Failure(503, api.SERVICEUNAVAILABLE, "监控主机数量已达上限。")
	}
	host := api.Host{Id: uuid.NewString(), Name: target, Address: address, Enabled: true, Connection: api.HostConnectionUnknown, LastSuccessAt: Null[time.Time](), Error: Null[string]()}
	m.hosts[host.Id] = host
	m.generations[host.Id] = 1
	m.baseline[host.Id] = m.now()
	return Copy(host), nil
}
func (m *Memory) Enable(id string, enabled bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	h, ok := m.hosts[id]
	if !ok {
		return Failure(404, api.NOTFOUND, "主机不存在。")
	}
	if h.Local && !enabled {
		return Failure(409, api.LOCALHOSTPROTECTED, "本机不能停用。")
	}
	if h.Enabled != enabled {
		h.Enabled = enabled
		h.Connection = api.HostConnectionUnknown
		m.hosts[id] = h
		m.generations[id]++
	}
	return nil
}
func (m *Memory) Remove(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	h, ok := m.hosts[id]
	if !ok {
		return Failure(404, api.NOTFOUND, "主机不存在。")
	}
	if h.Local {
		return Failure(409, api.LOCALHOSTPROTECTED, "本机不能删除。")
	}
	delete(m.hosts, id)
	delete(m.generations, id)
	delete(m.baseline, id)
	delete(m.partial, id)
	delete(m.diagnostics, id)
	for key, s := range m.sessions {
		if s.StorageHostId == id {
			delete(m.sessions, key)
		} else if Get(s.HostId) == id {
			s.HostId = Null[string]()
			m.sessions[key] = s
		}
	}
	m.pruneProjects()
	return nil
}
func (m *Memory) pruneProjects() {
	used := map[string]bool{}
	for _, s := range m.sessions {
		used[s.ProjectId] = true
	}
	for id := range m.projects {
		if !used[id] {
			delete(m.projects, id)
		}
	}
}
func (m *Memory) Report(host string, generation uint64, failures int, diagnostics ...map[string]int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.generations[host] == generation {
		m.partial[host] = failures
		if len(diagnostics) > 0 {
			m.diagnostics[host] = Copy(diagnostics[0])
		}
	}
}
func (m *Memory) snapshot(s api.Session) api.Session {
	s = Copy(s)
	h, ok := m.hosts[s.StorageHostId]
	at := s.CollectedAt
	if at == nil && m.mode != api.Continuous {
		if value, err := h.LastSuccessAt.Get(); err == nil {
			at = &value
		}
	}
	if !ok || !h.Enabled || h.Connection != api.HostConnectionOnline || at == nil || m.now().Sub(*at) > 45*time.Second {
		s.Freshness = api.Stale
		s.Reason = Value("来源停用、最近检查失败或采集已过期；仅显示最后成功样本。")
	}
	if s.Subagents != nil {
		for i := range s.Subagents.Items {
			child := &s.Subagents.Items[i]
			if !ok || !h.Enabled || h.Connection != api.HostConnectionOnline || s.Subagents.Status != api.SubagentCollectionStatusComplete || m.now().Sub(child.CollectedAt) > 45*time.Second {
				child.Freshness = api.SubagentFreshnessStale
			}
		}
	}
	return s
}
func (m *Memory) Session(id string) (api.Session, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[id]
	if !ok {
		return s, Failure(404, api.NOTFOUND, "会话不存在。")
	}
	return m.snapshot(s), nil
}
func (m *Memory) Read(id, turn string) (api.Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return s, Failure(404, api.NOTFOUND, "会话不存在。")
	}
	if Get(s.TurnId) == "" {
		return s, Failure(409, api.TURNIDUNAVAILABLE, "无法确定最新任务。")
	}
	if Get(s.TurnId) != turn {
		return s, Failure(409, api.TURNCHANGED, "任务已更新，请重新打开详情。")
	}
	if m.snapshot(s).Freshness == api.Stale {
		return s, Failure(409, api.SNAPSHOTSTALE, "采集样本已过期。")
	}
	if s.Status != api.SessionStatusRead && s.Status != api.SessionStatusUnread {
		return s, Failure(409, api.NOTCOMPLETED, "任务尚未确认完成。")
	}
	s.Status = api.SessionStatusRead
	s.Evidence.Basis = api.WebRead
	m.sessions[id] = s
	return m.snapshot(s), nil
}

var priority = map[api.SessionStatus]int{api.SessionStatusWaiting: 0, api.SessionStatusUnread: 1, api.SessionStatusRunning: 2, api.SessionStatusRead: 3, api.SessionStatusUnknown: 4}

func (m *Memory) Dashboard(includeHistory ...bool) api.Dashboard {
	m.mu.RLock()
	defer m.mu.RUnlock()
	now := m.now()
	history := len(includeHistory) > 0 && includeHistory[0]
	result := api.Dashboard{Projects: []api.Project{}, Warnings: []api.Warning{}, SampledAt: now}
	if m.mode == api.InMemoryDemo {
		result.Warnings = append(result.Warnings, api.Warning{Code: api.PARTIALCOLLECTION, HostId: Null[string](), Source: Null[api.WarningSource](), Message: "内存演示：合成数据，不执行真实采集；重启重置。"})
	}
	unknown := false
	for _, project := range m.projects {
		p := Copy(project)
		p.Sessions = []api.Session{}
		latest := time.Time{}
		uncertain := false
		count := 0
		for _, s := range m.sessions {
			if s.ProjectId != p.Id {
				continue
			}
			count++
			at, err := s.ActivityAt.Get()
			if err != nil {
				uncertain = true
				unknown = true
			} else if at.After(latest) {
				latest = at
			}
			if !history && s.Status == api.SessionStatusRead && !Get(s.CompletedAt).IsZero() && now.Sub(Get(s.CompletedAt)) > 24*time.Hour {
				continue
			}
			p.Sessions = append(p.Sessions, m.snapshot(s))
		}
		if count == 0 || !history && !uncertain && now.Sub(latest) > 7*24*time.Hour {
			continue
		}
		p.ActivityAt = Null[time.Time]()
		if !latest.IsZero() {
			p.ActivityAt = Value(latest)
		}
		sort.Slice(p.Sessions, func(i, j int) bool {
			a, b := p.Sessions[i], p.Sessions[j]
			if priority[a.Status] != priority[b.Status] {
				return priority[a.Status] < priority[b.Status]
			}
			if !Get(a.ActivityAt).Equal(Get(b.ActivityAt)) {
				return Get(a.ActivityAt).After(Get(b.ActivityAt))
			}
			return a.Id < b.Id
		})
		result.Projects = append(result.Projects, p)
	}
	sort.Slice(result.Projects, func(i, j int) bool {
		a, b := result.Projects[i], result.Projects[j]
		if !Get(a.ActivityAt).Equal(Get(b.ActivityAt)) {
			return Get(a.ActivityAt).After(Get(b.ActivityAt))
		}
		return a.Id < b.Id
	})
	for _, h := range m.hosts {
		d := m.diagnostics[h.Id]
		if d["codexExcluded"] > 0 || d["oversizedRecords"] > 0 || d["codexErrors"] > 0 || d["codexIncomplete"] > 0 {
			result.Warnings = append(result.Warnings, api.Warning{Code: api.PARTIALCOLLECTION, HostId: Value(h.Id), Source: Null[api.WarningSource](), Message: fmt.Sprintf("Codex本轮检查：排除子代理或不支持来源%d个，追读中%d个，读取错误%d个；受跟踪会话累计跳过超大记录%d条。来源数量仅统计已入库会话。", d["codexExcluded"], d["codexIncomplete"], d["codexErrors"], d["oversizedRecords"])})
		}
		if m.partial[h.Id] > 0 {
			result.Warnings = append(result.Warnings, api.Warning{Code: api.PARTIALCOLLECTION, HostId: Value(h.Id), Source: Null[api.WarningSource](), Message: "部分来源未读完、达到预算或读取失败；仅成功读取的会话更新采集时间。"})
		}
		if h.Enabled && h.Connection != api.HostConnectionOnline {
			result.Warnings = append(result.Warnings, api.Warning{Code: api.PARTIALCOLLECTION, HostId: Value(h.Id), Source: Null[api.WarningSource](), Message: "该主机尚无成功采集或最近检查失败；保留最后样本。"})
		}
	}
	if unknown {
		result.Warnings = append(result.Warnings, api.Warning{Code: api.TIMEUNVERIFIED, HostId: Null[string](), Source: Null[api.WarningSource](), Message: "部分会话缺少可靠活动时间，保守保留。"})
	}
	counts := []api.SourceCount{}
	for _, source := range []api.SourceCountSource{"codex_cli", "codex_desktop", "cursor_cli", "cursor_ide"} {
		count := api.SourceCount{Source: source}
		for _, session := range m.sessions {
			if string(session.Source) == string(source) {
				count.Collected++
			}
		}
		for _, project := range result.Projects {
			for _, session := range project.Sessions {
				if string(session.Source) == string(source) {
					count.Visible++
				}
			}
		}
		count.Hidden = count.Collected - count.Visible
		counts = append(counts, count)
	}
	result.SourceCounts = &counts
	return result
}

// Commit accepts only sessions actually read in this batch. Unseen sessions are
// retained with their original collection time; host success cannot refresh them.
func (m *Memory) Commit(host string, generation uint64, projects []api.Project, sessions []api.Session, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	h, ok := m.hosts[host]
	if !ok || !h.Enabled || m.generations[host] != generation {
		return Failure(409, api.HOSTDISABLED, "主机配置已改变，丢弃旧采集。")
	}
	if previous, err := h.LastSuccessAt.Get(); err == nil && !at.After(previous) {
		return errors.New("obsolete collection batch")
	}
	newCount := 0
	for _, s := range sessions {
		if _, exists := m.sessions[s.Id]; !exists {
			newCount++
		}
	}
	if len(m.sessions)+newCount > 20000 {
		return Failure(503, api.SERVICEUNAVAILABLE, "会话容量已达上限。")
	}
	projectIDs := map[string]bool{}
	for _, p := range projects {
		projectIDs[p.Id] = true
	}
	identities := map[string]bool{}
	for _, s := range sessions {
		if s.StorageHostId != host || s.Id == "" || s.ProjectId == "" {
			return errors.New("invalid collection identity")
		}
		if identities[s.Id] {
			return errors.New("duplicate collection identity")
		}
		identities[s.Id] = true
		if _, ok := m.projects[s.ProjectId]; !ok && !projectIDs[s.ProjectId] {
			return errors.New("missing collection project")
		}
	}
	for _, p := range projects {
		p.Sessions = []api.Session{}
		m.projects[p.Id] = Copy(p)
	}
	for _, incoming := range sessions {
		s := Copy(incoming)
		if executionHost := Get(s.HostId); executionHost != "" {
			if _, exists := m.hosts[executionHost]; !exists {
				s.HostId = Null[string]()
			}
		}
		old, exists := m.sessions[s.Id]
		if s.Subagents == nil && exists {
			s.Subagents = Copy(old.Subagents)
		}
		sequence := 1
		if exists && old.CollectedAt != nil && !at.After(*old.CollectedAt) {
			continue
		}
		if exists && old.CollectionVersion != nil {
			sequence = old.CollectionVersion.Sequence + 1
		}
		if exists && Get(old.TurnId) != "" && Get(old.TurnId) == Get(s.TurnId) && old.Status == api.SessionStatusRead && (s.Status == api.SessionStatusRead || s.Status == api.SessionStatusUnread) {
			s.Status = api.SessionStatusRead
			s.Evidence.Basis = old.Evidence.Basis
		}
		// First imported completions establish the baseline; later completions are unread.
		if !exists && s.Status == api.SessionStatusUnread && !Get(s.CompletedAt).After(m.baseline[host]) {
			s.Status = api.SessionStatusRead
			s.Evidence.Basis = api.InitialImport
		}
		s.CollectedAt = &at
		s.CollectionVersion = &api.CollectionVersion{Epoch: m.epoch, Sequence: sequence}
		s.Freshness = api.Fresh
		m.sessions[s.Id] = s
	}
	h.Connection = api.HostConnectionOnline
	h.LastSuccessAt = Value(at)
	h.Error = Null[string]()
	m.hosts[host] = h
	m.pruneProjects()
	return nil
}
func (m *Memory) Failed(host string, generation uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	h, ok := m.hosts[host]
	if !ok || !h.Enabled || m.generations[host] != generation {
		return
	}
	h.Connection = api.HostConnectionUnknown
	h.Error = Value("采集失败、超时或来源不可用；未使用示例替代。")
	m.hosts[host] = h
}

// Demo is explicit and never used as fallback for a failed real collector.
func Demo(now func() time.Time) *Memory {
	m := New(api.InMemoryDemo, now)
	m.AddLocal()
	spec, err := api.GetSwagger()
	if err != nil {
		panic(err)
	}
	data, err := json.Marshal(spec.Components.Schemas["Dashboard"].Value.Examples[0])
	if err != nil {
		panic(err)
	}
	var dashboard api.Dashboard
	if err = json.Unmarshal(data, &dashboard); err != nil {
		panic(err)
	}
	at := m.now()
	for _, p := range dashboard.Projects {
		p.ActivityAt = Value(at)
		for _, s := range p.Sessions {
			s.StorageHostId = "local"
			s.HostId = Value("local")
			s.ActivityAt = Value(at)
			s.StartedAt = Value(at.Add(-2 * time.Minute))
			s.CompletedAt = Value(at)
			s.Evidence.ObservedAt = Value(at)
			s.Status = api.SessionStatusUnread
			s.CollectedAt = &at
			m.sessions[s.Id] = s
		}
		p.Sessions = []api.Session{}
		m.projects[p.Id] = p
	}
	h := m.hosts["local"]
	h.Connection = api.HostConnectionOnline
	h.LastSuccessAt = Value(at)
	m.hosts["local"] = h
	return m
}
