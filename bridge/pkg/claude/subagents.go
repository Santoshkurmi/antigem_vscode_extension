package claude

// Subagents of a session. Claude Code keeps every Agent/Task run of a session in
// <project>/<session id>/subagents/agent-<agent id>.jsonl, next to agent-<agent id>.meta.json
// ({agentType, description, toolUseId, parentAgentId?, requestShape, finished?}). Their lines are all
// `isSidechain: true`, so the session's own history never contains them.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var agentIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// A subagent without `finished` whose transcript changed this recently is still running (the CLI writes a line per
// model request, so a working agent touches its file often; one whose process died never gets `finished`).
const subagentRunningWindow = 15 * time.Minute

// SubagentSummary is one subagent run of a session.
type SubagentSummary struct {
	AgentID       string `json:"agent_id"`
	AgentType     string `json:"agent_type"`
	Description   string `json:"description"`
	ToolUseID     string `json:"tool_use_id"`
	ParentAgentID string `json:"parent_agent_id,omitempty"`
	Background    bool   `json:"background"`
	Finished      bool   `json:"finished"`
	Running       bool   `json:"running"`
	CreatedAt     int64  `json:"created_at"`
	UpdatedAt     int64  `json:"updated_at"`
	SizeBytes     int64  `json:"size_bytes"`
}

type subagentMeta struct {
	AgentType     string `json:"agentType"`
	Description   string `json:"description"`
	ToolUseID     string `json:"toolUseId"`
	ParentAgentID string `json:"parentAgentId"`
	RequestShape  string `json:"requestShape"`
	Finished      bool   `json:"finished"`
}

type cachedMeta struct {
	mod  time.Time
	meta subagentMeta
}

var (
	metaCacheMu sync.Mutex
	metaCache   = map[string]cachedMeta{}
)

func readSubagentMeta(path string) (subagentMeta, bool) {
	fi, err := os.Stat(path)
	if err != nil {
		return subagentMeta{}, false
	}
	metaCacheMu.Lock()
	c, ok := metaCache[path]
	metaCacheMu.Unlock()
	if ok && c.mod.Equal(fi.ModTime()) {
		return c.meta, true
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return subagentMeta{}, false
	}
	var m subagentMeta
	if json.Unmarshal(data, &m) != nil {
		return subagentMeta{}, false
	}
	metaCacheMu.Lock()
	metaCache[path] = cachedMeta{mod: fi.ModTime(), meta: m}
	metaCacheMu.Unlock()
	return m, true
}

// subagentDir is <project>/<session id>/subagents for a transcript path.
func subagentDir(transcript string) string {
	return filepath.Join(strings.TrimSuffix(transcript, ".jsonl"), "subagents")
}

// listSubagents reads a session's subagents (oldest first). nil when there are none.
func listSubagents(transcript string) []SubagentSummary {
	dir := subagentDir(transcript)
	if _, err := os.Stat(dir); err != nil {
		return nil
	}
	files, _ := filepath.Glob(filepath.Join(dir, "agent-*.jsonl"))
	var out []SubagentSummary
	now := time.Now()
	for _, f := range files {
		id := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(f), "agent-"), ".jsonl")
		if !agentIDRe.MatchString(id) {
			continue
		}
		fi, err := os.Stat(f)
		if err != nil || fi.Size() == 0 {
			continue
		}
		s := SubagentSummary{AgentID: id, UpdatedAt: fi.ModTime().UnixMilli(), SizeBytes: fi.Size()}
		if m, ok := readSubagentMeta(strings.TrimSuffix(f, ".jsonl") + ".meta.json"); ok {
			s.AgentType = m.AgentType
			s.Description = m.Description
			s.ToolUseID = m.ToolUseID
			s.ParentAgentID = m.ParentAgentID
			s.Background = m.RequestShape == "background"
			s.Finished = m.Finished
		}
		s.Running = !s.Finished && now.Sub(fi.ModTime()) < subagentRunningWindow
		s.CreatedAt = firstTimestamp(f)
		if s.CreatedAt == 0 {
			s.CreatedAt = s.UpdatedAt
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out
}

var (
	createdCacheMu sync.Mutex
	createdCache   = map[string]int64{}
)

// firstTimestamp is the time of a transcript's first line (cached: it never changes).
func firstTimestamp(path string) int64 {
	createdCacheMu.Lock()
	t, ok := createdCache[path]
	createdCacheMu.Unlock()
	if ok {
		return t
	}
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	head := make([]byte, 16<<10)
	n, _ := f.Read(head)
	forEachLine(head[:n], func(l transcriptLine) {
		if t == 0 && l.Timestamp != "" {
			if ts, err := time.Parse(time.RFC3339Nano, l.Timestamp); err == nil {
				t = ts.UnixMilli()
			}
		}
	})
	if t != 0 {
		createdCacheMu.Lock()
		createdCache[path] = t
		createdCacheMu.Unlock()
	}
	return t
}

// Subagents lists a session's subagent runs.
func (m *Manager) Subagents(id string) []SubagentSummary {
	t := m.FindTranscript(id)
	if t == "" {
		return nil
	}
	return listSubagents(t)
}

// SubagentHistory returns a subagent's transcript entries (user / assistant / system) in file order, starting at
// byte offset from (0 = the whole transcript; a subagent's transcript only grows), and the offset to continue from
// (the end of the last complete line).
func (m *Manager) SubagentHistory(id, agentID string, from int64) ([]json.RawMessage, int64, error) {
	if !agentIDRe.MatchString(agentID) {
		return nil, 0, os.ErrNotExist
	}
	t := m.FindTranscript(id)
	if t == "" {
		return nil, 0, os.ErrNotExist
	}
	f, err := os.Open(filepath.Join(subagentDir(t), "agent-"+agentID+".jsonl"))
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, 0, err
	}
	if from < 0 || from > fi.Size() {
		from = 0
	}
	data := make([]byte, fi.Size()-from)
	n, _ := f.ReadAt(data, from)
	data = data[:n]
	// a line still being written is read next time
	end := bytes.LastIndexByte(data, '\n') + 1
	data = data[:end]
	out := []json.RawMessage{}
	for _, b := range bytes.Split(data, []byte{'\n'}) {
		if len(b) == 0 || b[0] != '{' {
			continue
		}
		var l transcriptLine
		if json.Unmarshal(b, &l) != nil || l.UUID == "" {
			continue
		}
		if l.Type == "user" || l.Type == "assistant" || l.Type == "system" {
			out = append(out, append(json.RawMessage{}, b...))
		}
	}
	return out, from + int64(end), nil
}
