package opencode

// Crew bots (the extension's src/core/crew) on OpenCode. OpenCode v2 has no per-message system prompt or tool list,
// but its config agents have both: each bot runs as a hidden agent ("crew-<id>") of AntiGem's own config, whose
// system prompt is the bot's persona and whose permission rules are its tool limits (a denied tool is not offered
// at all). The crew MCP server is added next to the user's servers; Deny keeps its tools out of every other chat.
// Stored in crew.json next to the config; writeConfig merges it. Verified against OpenCode 2.2.7 (2026-11-22).

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
)

type crewDoc struct {
	Agents  map[string]json.RawMessage `json:"agents"`
	Servers map[string]json.RawMessage `json:"servers"`
	// Deny: tool patterns ("antigem_crew_*") denied to every chat; crew agents allow them in their own rules.
	Deny []string `json:"deny,omitempty"`
}

// crewAgentRe: crew agents never replace the user's or OpenCode's own agents.
var crewAgentRe = regexp.MustCompile(`^crew-[A-Za-z0-9_-]{1,64}$`)

func (m *Manager) crewPath() string { return filepath.Join(m.dataDir(), "crew.json") }

func (m *Manager) loadCrew() (crewDoc, error) {
	doc := crewDoc{Agents: map[string]json.RawMessage{}, Servers: map[string]json.RawMessage{}}
	data, err := os.ReadFile(m.crewPath())
	if errors.Is(err, os.ErrNotExist) {
		return doc, nil
	}
	if err != nil {
		return doc, err
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return doc, fmt.Errorf("crew.json: %w", err)
	}
	if doc.Agents == nil {
		doc.Agents = map[string]json.RawMessage{}
	}
	if doc.Servers == nil {
		doc.Servers = map[string]json.RawMessage{}
	}
	return doc, nil
}

// crewChange: entries to add or replace; a null value removes one. Deny replaces the list when present.
type crewChange struct {
	Agents  map[string]json.RawMessage `json:"agents"`
	Servers map[string]json.RawMessage `json:"servers"`
	Deny    *[]string                  `json:"deny"`
}

// handleCrew: GET the stored crew agents and servers; POST a crewChange (the config is rewritten and reloaded).
func (m *Manager) handleCrew(w http.ResponseWriter, r *http.Request) {
	m.provMu.Lock()
	doc, err := m.loadCrew()
	m.provMu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": false, "error": err.Error()})
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "agents": doc.Agents, "servers": doc.Servers, "deny": doc.Deny})
		return
	case http.MethodPost:
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]interface{}{"success": false, "error": "method not allowed"})
		return
	}
	var ch crewChange
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&ch); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"success": false, "error": "invalid JSON"})
		return
	}
	for id, raw := range ch.Agents {
		if !crewAgentRe.MatchString(id) {
			writeJSON(w, http.StatusOK, map[string]interface{}{"success": false, "error": "invalid crew agent id " + id})
			return
		}
		if isNull(raw) {
			delete(doc.Agents, id)
		} else {
			doc.Agents[id] = raw
		}
	}
	for name, raw := range ch.Servers {
		if !mcpNameRe.MatchString(name) {
			writeJSON(w, http.StatusOK, map[string]interface{}{"success": false, "error": "invalid server name " + name})
			return
		}
		if isNull(raw) {
			delete(doc.Servers, name)
		} else {
			doc.Servers[name] = raw
		}
	}
	if ch.Deny != nil {
		doc.Deny = *ch.Deny
	}
	m.provMu.Lock()
	err = writePrivate(m.crewPath(), doc)
	m.provMu.Unlock()
	if err == nil {
		err = m.writeConfig()
	}
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": false, "error": err.Error()})
		return
	}
	m.reloadQuietly(r.Context())
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

func isNull(raw json.RawMessage) bool {
	return len(raw) == 0 || string(raw) == "null"
}

// mergeCrew adds the crew agents, servers and deny rules to the config writeConfig is building.
func mergeCrew(cfg map[string]interface{}, servers map[string]json.RawMessage, doc crewDoc) {
	if len(doc.Agents) > 0 {
		cfg["agents"] = doc.Agents
	}
	for name, raw := range doc.Servers {
		// the user's own server of that name stays
		if _, taken := servers[name]; !taken {
			servers[name] = raw
		}
	}
	if len(doc.Deny) > 0 {
		rules := make([]map[string]string, 0, len(doc.Deny))
		for _, p := range doc.Deny {
			rules = append(rules, map[string]string{"action": p, "resource": "*", "effect": "deny"})
		}
		cfg["permissions"] = rules
	}
}
