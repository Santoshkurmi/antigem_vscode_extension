# AntiGem for VS Code — feature plan (items 1–26 of problem.md)

Goal: everything the Android app does that makes sense on a PC, with the app's exact UI. Excluded: terminal MCP,
REA (later), Antigravity cloud agents, voice output, Android-only tools (ADB, X11, automation, keep-awake).

## Phase 1 — fixes 1–19 (in progress)

| Item | Where | Status |
|---|---|---|
| 1 version/plan in profile · 3 not-installed → Install · 8 agent pages = links, CLI page first · 11 no endless loading · 13 big settings.json editor · 17/18 usage text = remaining, agy decimals | backends (`src/core/*/…Settings.ts`, `status()`) + UI | backends: agent running; host: done (`SettingsPage.error`, 12 s timeout, `settingDone`) |
| 2 current folder first in picker · 4 power button · 5 first-run agent picker · 6/7 settings root & Agents page · 9 exact app layout · 10 busy buttons · 12 same MCP UI · 14 run-preview scroll · 15 marker-in-code bug · 19 Ctrl+Enter newline | UI (+ host where noted) | host done (power off/on, `firstRun`, root/Agents pages, CLI paths with `~/`); UI agent running |
| 16 Claude/GPT 5 h bar | `agy/quota.ts` | done: disabled buckets are shown like the app; nothing hard-coded |

## Phase 2 — built-in MCP host + presets (items 22, 25, theme/dev MCPs)

Status: MCP host (`src/core/mcp/server.ts`), notes (`notes.ts`) and theme (`theme.ts`) done and tested over HTTP
(auth 401, GET 405, initialize, tools/list, calls, batch 202, -32601). Next: Notes screen (UI), presets on every
agent's MCP page, plugin developer MCP (with Phase 5).

**MCP host** in the extension host (`src/core/mcp/`): one HTTP server on `127.0.0.1:<antigem.mcpPort, default 1246>`,
the app's protocol exactly (`AndroidLocalBridgeServer.kt`): JSON-RPC 2.0 over POST (single or batch), `initialize`
→ `protocolVersion 2024-11-05` + per-server `instructions`, notifications → 202, GET → 405, `X-Device-Id` header
(random id kept in the extension's store) on every request, `-32601` unknown tool, results
`{content:[{type:"text"|"image"}], isError?}`. One path per server:

| Path | Server | Port of | Notes |
|---|---|---|---|
| `/notes` | notes_mcp | `data/notes/NotesMcp.kt` + `NotesRepository.kt` (9 tools) | storage `~/.antigem/notes.json` (same JSON as the app); + Notes screen in the UI (`ui/notes`) |
| `/theme` | theme_mcp | `theme/ThemeMcp.kt` (11 tools) | acts on the host's `uiPrefs` (theme, lightTheme, darkTheme, customThemes) → every view updates live |
| `/extension_developer` | custom_plugin_developer_mcp | `WebViewExtensionDeveloper.kt` + `extension_docs/developer-tools.json` (12 tools) | drafts through the bridge `/api/custom-plugins/drafts/*` |
| `/jarvis` | jarvis_mcp | Phase 3 | stateful (`Mcp-Session-Id`) |
| `/browser` | browser_mcp | Phase 4 | proxies to the Chrome extension |
| `/mcp?extension=<id>` | plugin MCPs | Phase 5 | plugin runtime |

Several VS Code windows: the first window binds the port and serves everyone; the others use it.

**Presets** on every agent's MCP page (agy, Claude, Codex, OpenCode), same tiles/order as the app
(`SettingsDialog.kt:2644`, `ClaudeSettingsScreen.kt:553`, `CodexMcpPage.kt:141`, `OpenCodeMcpPage.kt:143`):
Custom Plugin MCP (picker) · Plugin Developer · Browser · Notes & To-dos · Jarvis · Theme · Stitch · Google Flow
(DeepX) · Custom server. Each writes the agent's own config the app's way (agy `mcp_config.json` `serverUrl+headers`;
Claude `claude mcp add --scope user --transport http --header`; Codex `config/batchWrite mcp_servers.<name>` +
reload; OpenCode `PUT /api/opencode/mcp/<name>` remote) and shows "Added" when present; the list shows status,
tool counts and Test & Refresh like the app.

## Phase 3 — Jarvis (items 20, 21)

Status: engine + `/jarvis` MCP + settings in progress (agent); UI after its protocol lands (`docs/JARVIS.md`).

Port of `data/jarvis/*` + `ui/jarvis/*` minus voice/wake word/Android services:
- `src/core/jarvis/`: managers (missions, teams), tasks (state machine every 1.5 s: starting, running, waiting for
  approval, asking, no progress, done, failed, stopped; 25 s grace; stall minutes; last 3500 chars), events (queue per
  manager, batch 2 s, `⚡ Jarvis · <title>: done` labelled hidden messages, re-queue after 30 s), driver (sends to Jarvis
  chats off-screen through the normal backends — the bridge keeps every chat running without a view), controller
  (approval policy/permission loop, question routing, wait guard, autopilot nudges), skill texts
  (`JarvisSkill.kt` boot pack / preamble / mission brief / live context, rewritten for VS Code), preferences.
- `/jarvis` MCP: the app's tool set (tasks, mission/teams, chats, models/settings, approvals, timers, memory, state,
  help, IDE tools mapped to VS Code: open file/project, search code, open screen). Voice tools answer "no voice on PC".
- UI: Jarvis tab/filter + "New Jarvis chat" in the drawer, bot icon, command strip above the composer (mission,
  steps progress, autopilot, task pills, board), event cards in the feed, overlay (status pill, idle orb,
  notices, activity card) inside the webview, Jarvis panel, settings pages (agent & model, personality, setup =
  register the MCP with each agent, manager & tasks, approvals, show Jarvis chats in the list).
- Storage: the extension store (managers, tasks ≤30, log ≤500, prefs). Loops run in the window that owns the MCP
  port.

## Phase 4 — AntiGem browser extension + browser MCP (item 23) and Google Flow preset (26)

Status: built and tested end to end (headless Chrome for Testing 156): `chrome-extension/` (id
`kbdjcdlfeoijcchepbldpldeaeijgibi`), `antigem-bridge --native-host` (`bridge/pkg/nativehost`), `src/core/browser/`
(socket, registration, `/browser` = the app's 16 tools + `browser_batch` + 3 hidden legacy), Settings → Browser.
Windows: not yet (host and socket answer "not supported").

- Transport = Chrome Native Messaging, like Claude in Chrome (verified on this PC: `com.anthropic.claude_code_browser_extension`
  → `claude --chrome-native-host` → per-user Unix socket). No TCP port: the VS Code extension registers
  `com.antigem.browser_bridge` for Chrome/Chromium/Brave/Edge with `allowed_origins` = our pinned extension id (manifest
  `key`); the native host is the bridge binary (`antigem-bridge --native-host`), which connects to the extension's
  socket (per-user dir 0700 / Windows named pipe). Never a localhost WebSocket (DeepX's `ws://127.0.0.1:8792` can be
  reached by any local program or web page).
- `chrome-extension/` (MV3): `chrome.runtime.connectNative` (HELLO, heartbeat, `{id, command, payload}` ↔
  `{id, success, result|error}`), injects the app's
  `page-agent.js` (element refs), uses `chrome.debugger` for trusted input / screenshots / eval / console / network /
  dialogs / uploads / UA, a content-script lock overlay + agent cursor, popup with connection status.
- `/browser` MCP = the app's 15 browser tools (+ `browser_batch` with Claude-in-Chrome aliases), executed through the
  extension.
- Google Flow: preset for the existing DeepX extension + `flow_mcp/deepx-mcp` server (stdio `node …/bin/deepx-mcp.mjs`).

## Phase 5 — custom plugins (item 24)

App-compatible plugins (manifest v2/v3, `skills/*.md`, optional `mcp_tools` + worker): install from ZIP or GitHub
repositories (`antigem-plugins.json`, defaults dipeshkrydv/antigem_plugins + Santoshkurmi/antigem_plugins),
enable/disable, update check, export, remove — through the bridge's `/api/custom-plugins/*`; `/plu:<id>[:<skill>]`
expansion in the composer; skills served as MCP (`get_skills`, `get_skill`, `get_skill_file`) at
`/mcp?extension=<id>`; plugin tools run in the app's Node plugin runtime (`assets/browser-runtime/*.mjs`) with its
browser API backed by the Chrome extension where possible. Settings pages = the app's Plugins screen (Installed /
Repositories / Store).
