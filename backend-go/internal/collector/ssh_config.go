package collector

import (
	"bufio"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	api "agents-board/backend-go/internal/api/generated"
	"agents-board/backend-go/internal/store"
	sshconfig "github.com/kevinburke/ssh_config"
)

// SSHCandidates enumerates literal aliases only. OpenSSH remains the authority
// for effective settings, Match, ProxyJump and credentials when connecting.
// Library Include expansion is deliberately bypassed to enforce I/O budgets.
func SSHCandidates(config string) ([]api.SshCandidate, error) {
	aliases := map[string]bool{}
	seen := map[string]bool{}
	base := filepath.Dir(config)
	total := 0
	operations := 0
	budget := func() bool {
		operations++
		return operations <= 512 && total < 4*1024*1024
	}
	partial := false
	var visit func(string, int)
	visit = func(path string, depth int) {
		if !budget() || depth > 5 || len(seen) >= 32 {
			partial = true
			return
		}
		resolved, err := filepath.EvalSymlinks(path)
		if os.IsNotExist(err) {
			return
		}
		if err != nil {
			partial = true
			return
		}
		if seen[resolved] {
			return
		}
		seen[resolved] = true
		file, err := os.Open(resolved)
		if err != nil {
			partial = true
			return
		}
		data, err := io.ReadAll(io.LimitReader(file, 512*1024+1))
		file.Close()
		total += len(data)
		if err != nil || len(data) > 512*1024 || total > 4*1024*1024 {
			partial = true
			return
		}
		scanner := bufio.NewScanner(strings.NewReader(string(data)))
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			cut := strings.IndexAny(line, " \t=")
			if cut < 0 {
				continue
			}
			key := strings.ToLower(line[:cut])
			if key != "host" && key != "include" {
				continue
			}
			value := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line[cut:]), "="))
			if key == "host" {
				cfg, err := sshconfig.Decode(strings.NewReader("Host " + value + "\n"))
				if err != nil {
					partial = true
					continue
				}
				for _, host := range cfg.Hosts {
					for _, pattern := range host.Patterns {
						alias := pattern.String()
						if strings.ContainsAny(alias, "*?!") || !host.Matches(alias) {
							continue
						}
						if normalized, err := store.NormalizeTarget(alias); err == nil && !strings.Contains(normalized, "@") {
							if len(aliases) < 256 {
								aliases[normalized] = true
							} else {
								partial = true
							}
						}
					}
				}
				continue
			}
			patterns, err := includePaths(value)
			if err != nil {
				partial = true
				continue
			}
			for _, pattern := range patterns {
				if !budget() {
					partial = true
					return
				}
				if strings.HasPrefix(pattern, "~/") {
					home, _ := os.UserHomeDir()
					pattern = filepath.Join(home, pattern[2:])
				}
				if !filepath.IsAbs(pattern) {
					pattern = filepath.Join(base, pattern)
				}
				if !strings.ContainsAny(pattern, "*?[") {
					visit(pattern, depth+1)
					continue
				}
				// Bound directory enumeration; nested wildcard directory paths are not enumerated.
				directory, name := filepath.Split(pattern)
				if strings.ContainsAny(directory, "*?[") {
					partial = true
					continue
				}
				dir, err := os.Open(directory)
				if os.IsNotExist(err) {
					continue
				}
				if err != nil {
					partial = true
					continue
				}
				names, readErr := dir.Readdirnames(1025)
				dir.Close()
				if len(names) > 1024 || readErr != nil && readErr != io.EOF {
					partial = true
					continue
				}
				sort.Strings(names)
				for _, entry := range names {
					if matched, _ := filepath.Match(name, entry); matched {
						visit(filepath.Join(directory, entry), depth+1)
					}
				}
			}
		}
		if scanner.Err() != nil {
			partial = true
		}
	}
	visit(config, 0)
	result := make([]api.SshCandidate, 0, len(aliases))
	for alias := range aliases {
		result = append(result, api.SshCandidate{Alias: alias, Address: alias})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Alias < result[j].Alias })
	if partial {
		return result, errors.New("SSH 候选配置部分未解析；仍可手动输入系统 SSH 目标")
	}
	return result, nil
}

// Include is a list of paths, not a shell command. Preserve Windows backslashes;
// no expansion or execution is allowed here. Complex escaped quotes are reported
// as unsupported and users can still select the target through system OpenSSH.
func includePaths(value string) ([]string, error) {
	var paths []string
	for value = strings.TrimSpace(value); value != "" && value[0] != '#'; value = strings.TrimSpace(value) {
		if value[0] == '"' || value[0] == '\'' {
			quote := value[0]
			end := strings.IndexByte(value[1:], quote)
			if end < 0 {
				return nil, errors.New("unclosed include path")
			}
			paths = append(paths, value[1:end+1])
			value = value[end+2:]
			if value != "" && value[0] != ' ' && value[0] != '\t' && value[0] != '#' {
				return nil, errors.New("unsupported include syntax")
			}
		} else {
			end := strings.IndexAny(value, " \t#")
			if end < 0 {
				end = len(value)
			}
			path := value[:end]
			if strings.ContainsAny(path, "\"'") {
				return nil, errors.New("unsupported include quoting")
			}
			paths = append(paths, path)
			value = value[end:]
		}
	}
	return paths, nil
}
