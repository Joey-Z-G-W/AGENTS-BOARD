package collector

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	api "agents-board/backend-go/internal/api/generated"
	"agents-board/backend-go/internal/store"
	"agents-board/backend-go/probes"
	"github.com/getkin/kin-openapi/openapi3"
)

var ErrRead = errors.New("只读采集失败、超时、输出超限或协议无效。")

// Includes SSH setup and both state upload and result download. The byte
// budgets remain independent; slow links still have a bounded execution time.
const CollectionTimeout = time.Minute

type Locator struct {
	Path     string `json:"path"`
	Source   string `json:"source"`
	NativeID string `json:"nativeId"`
	Modified int64  `json:"modified,omitempty"`
}
type Result struct {
	Projects    []api.Project
	Sessions    []api.Session
	At          time.Time
	State       json.RawMessage
	Locators    map[string]Locator
	Failures    int
	Duplicates  int
	Diagnostics map[string]int
}
type Source interface {
	Collect(context.Context, api.Host, *api.Session) (Result, error)
	Accept(string, Result)
	Forget(string)
}
type Command func(context.Context, string, []string, []byte) ([]byte, error)
type Protocol struct {
	mu          sync.Mutex
	Python      string
	Run         Command
	ResolveHost func(string) string
	states      map[string]json.RawMessage
	locators    map[string]map[string]Locator
}

func New(python string) *Protocol {
	if python == "" {
		python = "python"
	}
	return &Protocol{Python: python, Run: Run, states: map[string]json.RawMessage{}, locators: map[string]map[string]Locator{}}
}
func (p *Protocol) Forget(host string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.states, host)
	delete(p.locators, host)
}
func (p *Protocol) Accept(host string, result Result) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.states[host] = append(json.RawMessage(nil), result.State...)
	if p.locators[host] == nil {
		p.locators[host] = map[string]Locator{}
	}
	for id, locator := range result.Locators {
		p.locators[host][id] = locator
	}
}
func id(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:12])
}
func (p *Protocol) Collect(ctx context.Context, host api.Host, target *api.Session) (Result, error) {
	began := time.Now().UTC()
	p.mu.Lock()
	state := append(json.RawMessage(nil), p.states[host.Id]...)
	var locator *Locator
	if target != nil {
		value, ok := p.locators[host.Id][target.Id]
		if !ok {
			p.mu.Unlock()
			return Result{}, ErrRead
		}
		locator = &value
	}
	p.mu.Unlock()
	request := struct {
		Version          int             `json:"version"`
		State            json.RawMessage `json:"state"`
		Target           *Locator        `json:"target,omitempty"`
		IncludeSubagents bool            `json:"includeSubagents"`
	}{1, state, locator, host.Local && target == nil}
	encoded, err := json.Marshal(request)
	if err != nil {
		return Result{}, ErrRead
	}
	if len(encoded) > 8*1024*1024 {
		return Result{}, ErrRead
	}
	// The script and the request travel through stdin; no probe is installed remotely.
	script := "__name__ = 'board_probe'\n" + probes.Legacy + "\n" + probes.Continuous + "\nimport base64\nrequest = json.loads(base64.b64decode('" + base64.StdEncoding.EncodeToString(encoded) + "'))\nprint(json.dumps(run_request(request), ensure_ascii=True))\n"
	command, args := p.Python, []string{"-B", "-"}
	if !host.Local {
		normalized, err := store.NormalizeTarget(host.Address)
		if err != nil {
			return Result{}, ErrRead
		}
		command = "ssh"
		args = []string{"-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "Compression=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2", "--", normalized, "python3 -B -"}
	}
	raw, err := p.Run(ctx, command, args, []byte(script))
	if err != nil {
		return Result{}, ErrRead
	}
	var response struct {
		Version    int       `json:"version"`
		ObservedAt time.Time `json:"observedAt"`
		Records    []struct {
			Session map[string]any `json:"session"`
			Locator Locator        `json:"locator"`
		} `json:"records"`
		State       json.RawMessage `json:"state"`
		Failures    int             `json:"failures"`
		Diagnostics map[string]int  `json:"diagnostics"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&response) != nil || response.Version != 1 || response.ObservedAt.IsZero() || len(response.Records) > 512 || len(response.State) > 8*1024*1024 {
		return Result{}, ErrRead
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return Result{}, ErrRead
	}
	result := Result{At: began, State: response.State, Locators: map[string]Locator{}, Projects: []api.Project{}, Sessions: []api.Session{}, Failures: response.Failures, Diagnostics: response.Diagnostics}
	spec, err := api.GetSwagger()
	if err != nil {
		return Result{}, err
	}
	seen := map[string]bool{}
	positions := map[string]int{}
	for _, record := range response.Records {
		fields := record.Session
		// Only local background reads can publish child observations.
		if !host.Local || target != nil {
			delete(fields, "subagents")
		}
		native, ok := fields["nativeId"].(string)
		source, _ := fields["source"].(string)
		if !ok || native == "" || native != record.Locator.NativeID || source != record.Locator.Source || record.Locator.Path == "" {
			return Result{}, ErrRead
		}
		sessionID := id(host.Id + ":" + source + ":" + native)
		if target != nil && sessionID != target.Id {
			return Result{}, ErrRead
		}
		directory, _ := fields["directory"].(string)
		workspaceHost, _ := fields["workspaceHost"].(string)
		common, _ := fields["commonDir"].(string)
		executionHost := any(nil)
		if directory != "" && workspaceHost == "" {
			executionHost = host.Id
		} else if directory != "" && p.ResolveHost != nil {
			if resolved := p.ResolveHost(workspaceHost); resolved != "" {
				executionHost = resolved
			}
		}
		location := directory
		if common != "" {
			location = common
		}
		if location == "" {
			location = sessionID
		}
		projectID := id(host.Id + ":" + workspaceHost + ":" + location)
		delete(fields, "nativeId")
		delete(fields, "workspaceHost")
		delete(fields, "commonDir")
		fields["id"] = sessionID
		fields["projectId"] = projectID
		fields["hostId"] = executionHost
		fields["storageHostId"] = host.Id
		if title, ok := fields["title"].(string); ok {
			runes := []rune(title)
			if len(runes) > 160 {
				fields["title"] = string(runes[:160])
			}
		}
		if err = spec.Components.Schemas["Session"].Value.VisitJSON(fields, openapi3.EnableJSONSchema2020()); err != nil {
			return Result{}, ErrRead
		}
		data, _ := json.Marshal(fields)
		var session api.Session
		if json.Unmarshal(data, &session) != nil {
			return Result{}, ErrRead
		}
		if session.Subagents != nil {
			if source != "codex_cli" && source != "codex_desktop" {
				return Result{}, ErrRead
			}
			childIDs := map[string]bool{}
			for _, child := range session.Subagents.Items {
				if child.ParentThreadId != native || child.NativeId == native || childIDs[child.NativeId] {
					return Result{}, ErrRead
				}
				childIDs[child.NativeId] = true
			}
		}
		if position, duplicate := positions[sessionID]; duplicate {
			// Multiple exports/rollouts can share one native identity. Select a
			// stable source file, never use file mtime as Agent lifecycle evidence.
			result.Failures++
			result.Duplicates++
			previous := result.Locators[sessionID]
			if record.Locator.Modified > previous.Modified || record.Locator.Modified == previous.Modified && record.Locator.Path < previous.Path {
				result.Sessions[position] = session
				result.Locators[sessionID] = record.Locator
			}
		} else {
			positions[sessionID] = len(result.Sessions)
			result.Sessions = append(result.Sessions, session)
			result.Locators[sessionID] = record.Locator
		}
		if !seen[projectID] {
			name := "工作区未解析"
			kind := api.Unresolved
			if directory != "" {
				name = filepath.Base(strings.ReplaceAll(directory, "\\", "/"))
				kind = api.HostDirectory
			}
			if common != "" {
				kind = api.GitCommonDir
			}
			result.Projects = append(result.Projects, api.Project{Id: projectID, Name: name, IdentityKind: kind, Repository: store.Null[string](), ActivityAt: store.Null[time.Time](), Sessions: []api.Session{}})
			seen[projectID] = true
		}
	}
	if target != nil && len(result.Sessions) != 1 {
		return Result{}, ErrRead
	}
	return result, nil
}

type boundedOutput struct {
	bytes.Buffer
	limit int
}

func (b *boundedOutput) Write(data []byte) (int, error) {
	if len(data) > b.limit-b.Len() {
		return 0, ErrRead
	}
	return b.Buffer.Write(data)
}
func Run(ctx context.Context, command string, args []string, input []byte) ([]byte, error) {
	deadline, cancel := context.WithTimeout(ctx, CollectionTimeout)
	defer cancel()
	cmd := exec.CommandContext(deadline, command, args...)
	cmd.Stdin = bytes.NewReader(input)
	output := &boundedOutput{limit: 16 * 1024 * 1024}
	stderr := &boundedOutput{limit: 64 * 1024}
	cmd.Stdout = output
	cmd.Stderr = stderr
	cmd.WaitDelay = time.Second
	cleanup, err := prepareProcess(cmd)
	if err != nil {
		return nil, ErrRead
	}
	defer cleanup()
	if err = cmd.Start(); err != nil {
		return nil, ErrRead
	}
	if err = attachProcess(cmd); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, ErrRead
	}
	if err = cmd.Wait(); err != nil || deadline.Err() != nil {
		return nil, ErrRead
	}
	return output.Bytes(), nil
}

func (r Result) String() string {
	return fmt.Sprintf("records=%d failures=%d", len(r.Sessions), r.Failures)
}
