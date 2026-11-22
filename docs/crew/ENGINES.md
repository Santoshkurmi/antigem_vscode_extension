# Crew engine matrix (Phase 0, verified 2026-11-22)

What each engine can enforce for a Crew bot, checked live against Claude Code 2.1.322, Codex 0.167.0
(`codex app-server`), OpenCode 2.2.7 (`opencode serve`) and the Antigravity hub. Code: `src/core/crew/engines/`
(`caps.ts` holds this table for the UI). Tests: `dev/test-crew.ts` (offline), `dev/smoke-crew.ts` (Claude + Codex,
real models), `dev/smoke-crew-opencode.ts` (OpenCode with a fake model that records what OpenCode sends).

| Need | Claude Code | Codex | OpenCode | Antigravity |
|---|---|---|---|---|
| Persona | `--append-system-prompt-file` ✓ | `thread/start developerInstructions` ✓ | hidden config agent `crew-<thread>`: `system` ✓ | hidden block in the message (soft) ✓ |
| Edited persona, same chat | `--system-prompt-snapshot off` + process restart (history kept) ✓ | turn `additionalContext {kind: application}` ✓ (resume / collaborationMode ignore new instructions ✗) | rewrite agent + `/api/location/reload` ✓ | block sent again ✓ |
| Its own crew tools | `--mcp-config` per process, `--strict-mcp-config` ✓ | `config.mcp_servers.crew` per thread ✓, re-applied by `thread/resume` ✓ | one shared server `antigem`; config-wide deny `antigem_crew_*`, the bot agent allows it ✓ | global `antigem_crew` entry in `mcp_config.json`, added by the backend on a bot's first message ✓ |
| Crew tools never ask | `--allowedTools mcp__crew` ✓ | `default_tools_approval_mode: "approve"` ✓ (else refused under `approvalPolicy: never`) | agent rule `allow antigem_crew_*` ✓ | — |
| Who is calling | URL `t=<thread>&cap=<HMAC>` ✓ | URL ✓ (+ `_meta["x-codex-turn-metadata"].thread_id`) | `_meta["ai.opencode/sessionID"]` ✓ | `cap` argument ✓ |
| Talk only | `--tools ""` → only MCP tools ✓ | read-only sandbox (shell stays, can't change anything) | `deny *` + allow crew → tools list = crew + `skill` ✓ | approvals refused (soft) ✓ |
| Read only | `--tools Read,Grep,Glob,WebSearch,WebFetch,TodoWrite` ✓ | `sandbox: read-only` ✓ (touch → "read-only file system") | `deny *` + allow read, glob, grep, webfetch, websearch, skill ✓ | approvals refused (soft) |
| Edit | `acceptEdits` | `workspace-write`, `on-request` | allow all, `shell`/`execute`/`external_directory` ask | approve edits |
| Steer mid-turn | queue | `turn/steer` | — | — |

✓ = seen working live (`dev/smoke-crew.ts`; Antigravity with `CREW_SMOKE_AGY=1`, which backs up and restores
`mcp_config.json`, and needs the hub's model list loaded before a new chat's first message).

## Facts worth keeping

- **Claude** records the system prompt on a chat's first request and reuses it on every later request and resume,
  even when a later start passes another one, unless `--system-prompt-snapshot off` (the bridge passes it when the
  CLI's `--help` lists it). `--append-system-prompt-file` exists but is hidden from `--help`. MCP `tools/call` carries
  `_meta["claudecode/toolUseId"]` only (no session id), so the identity lives in the per-process URL. The CLI also
  calls a `server/discover` method first; an unknown-method error is fine.
- **Codex** `thread/resume` and a turn's `collaborationMode.settings.developer_instructions` do not change the
  instructions of an existing thread; `additionalContext` with kind `application` does. Config overrides (the MCP
  server) live only as long as the thread is loaded: after an app-server restart `turn/start` alone would load the
  thread without them, so a bot turn always runs `thread/resume` with the config first. `dynamicTools` on
  `thread/start` (calls come back as `item/tool/call` requests) is an alternative to MCP, not used.
- **OpenCode v2** has no per-message `system` or `tools` (v1 had them). Config `agents.<id>` has `system`, `hidden`,
  `mode`, `permissions` (+ `model`, `steps`). Permission rules: action = tool id (`read`, `glob`, `grep`,
  `webfetch`, `websearch`, `skill`, `shell`, `execute`, `edit`, `write`, `question`, `subagent`; MCP tools
  `<server>_<tool>`), last match wins, order config < agent < session, a denied tool is not offered at all. Agents
  are listed per location (`GET /api/agent?directory=`). Session-level rules override the agent's, so a crew session
  is created without them. After a config reload the MCP servers reconnect: the first turn waits for `connected`.
- **Every engine** sends its own `_meta` with MCP calls; the extension's MCP host now passes it to servers
  (`McpCallContext.meta`).

## Outward commands at Auto / Full (Phase 4, verified 2026-11-22)

At Auto / Full an engine may run a command without asking: Claude's `auto` permission mode has its own classifier
(live: a Full bot ran `git push` and AntiGem never heard of it), OpenCode's crew agent allows everything. So the
engines are made to ask for outward commands (`src/core/crew/access/outward.ts`), and the crew's access broker
decides — an outward one goes to the Inbox, anything else (a curl GET) runs:
- **Claude**: `permissions.ask` rules (`Bash(git push:*)`, …) in a settings file passed with `--settings` (bridge
  `CrewSpawn.ask_tools`). Checked with the CLI itself: `--permission-mode auto` + an ask rule → the call becomes a
  permission prompt (with `--permission-prompts none` it is refused instead of run).
- **OpenCode**: agent rules `shell ask "<prefix> *"` after the allow-all (last match wins).
- **Codex**: no change needed: its sandbox has no network, so a push asks to leave the sandbox (an approval).
- **Antigravity**: not enforceable (its own terminal policy decides); the broker answers what it does ask.

## Caller identity (instead of the plan's random per-turn token)

A Claude process lives across turns and survives an editor reload, so its MCP URL can't hold a token that changes
per turn. Instead: `cap = HMAC-SHA256(secret, thread id)` (secret in `~/.antigem/crew.secret`, 0600, outside the
crew folder bots may read), and a call only counts while that thread has a turn running (+15 s grace). Same effect
as revoking a per-turn token; nothing to re-issue. OpenCode needs no cap (its `_meta` names the session; a normal
chat is refused), Antigravity passes `cap: "<thread>.<hmac>"` given in its instructions.
