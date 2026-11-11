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

## Phase 6 — Windows and macOS (audit 2026-11-11, code reading only; nothing tested on those systems yet)

macOS mostly works; Windows is not usable yet. Items marked (likely) were not fully confirmed.

**Status 2026-11-11:** 6.1 and 6.2 done in code (shared helper `src/core/paths.ts`; bridge: `procgroup.HideConsole`,
`config.PrependPath`, Windows/macOS branches), plus the 6.3 basenames, PowerShell command unwrapping and per-OS
install hints. Bridge compiles for windows/darwin/linux; nothing run on Windows or macOS yet — needs real-machine
testing. Not done (by choice): browser control on Windows, the phone-app-only endpoints (`fsProtected`,
`fsValidName`, `fsMove`, zip import, drive letters), the macOS Chrome picker hint, the unused `/api/system-prompt`
saying "linux / bash", OpenCode install on Windows (npm hint instead), agy install on Windows (link instead).

**Review 2026-11-11:** the webview still cut `file://` off by hand (images, artifacts, attachments, tool images, HTML
apps, "run in terminal" folder, project picker's current-folder match, file names) → `webview/src/util/paths.ts`
(`fileLinkToPath`, `pathBaseName`, `samePath`); host `uriToPath` also takes a cut-off `/C:/…`. Chat markdown opens
Windows paths (`C:\…` / `c:/…` in links and inline code, `file:///C:/…`, `%20`). ffprobe/ffmpeg for plugins without a
console window. A bridge is only replaced by a newer program (two windows on different versions no longer swap it back
and forth). Still open: macOS notification clicks (AppleScript cannot open a link; needs a helper app).

**Browser control on Windows, 2026-11-11** (6.3 item; built, tested only on Linux with a simulated Windows pipe):
- the extension host listens on `\\.\pipe\antigem-browser-<random>` and writes the name to `~/.antigem/run/browser.pipe`;
- the native host (`nativehost/socket_windows.go`) reads that file on every try and opens the pipe for overlapped I/O,
  using only the standard library;
- registration writes one manifest naming the bridge `.exe` (Chrome's `chrome-extension://` argument starts
  native-host mode), plus `HKCU\Software\<browser>\NativeMessagingHosts\…` keys written with `reg.exe`;
- the upload tool's key-folder check also works with `\` and Windows' credential folders;
- macOS: the *Load unpacked* step says Cmd+Shift+. shows the hidden `.antigem` folder.

Still to check on a real Windows PC: which registry key Chrome Beta / Dev / Canary, Brave and Vivaldi read (both their
own and Chrome's are written).

### 6.1 Windows core (makes it usable)
- One shared file-link ↔ path helper (`url.fileURLToPath` / `pathToFileURL`, `path.isAbsolute`) used everywhere.
  Today `file:///c%3A/...` becomes `/c:/...` and `file://${path}` is built by hand:
  - host: `host.ts` `pathOf` / readImage / saveArtifact / drop handling / projects, `extension.ts` workspaceFolders,
    `preview/server.ts`, `jarvis/mcp.ts`, `jarvis/tasks.ts`;
  - backends: `ClaudeSession.ts` spawnConfig, `ClaudeBackend.ts` cwd → URI, `CodexBackend.ts` `pathOfUri` and
    thread URIs, `OpenCodeBackend.ts` directory and URIs, `AgyBackend.ts` `toFileUri` / `pathOf` / `HubMedia.isLocal`,
    `AgySettings.ts` SKILL.md open.
  Effects: Claude/Codex/OpenCode run in the wrong folder, duplicate projects in the chat list, drag-and-drop does
  nothing, folders with spaces or `%` break on every OS.
- `CodexBackend.buildInput`: `a.path.startsWith('/')` drops every file/folder attachment on Windows → `path.isAbsolute`.
- Bridge `pkg/hub/manager.go`: agy started through `sh -c` (no sh on Windows) → run it directly; PATH built with `:` and
  Unix dirs → `os.PathListSeparator`, replace the `Path` key case-insensitively.
- Bridge agy discovery (`hub/manager.go` FindAllAgyBinaries, `config.go` SafeLookPath, InstallerAgyPath): only looks
  for `agy` → also `agy.exe` / `exec.LookPath`.
- Bridge `claude/manager.go`: fallback `~/.local/bin/claude` without `.exe`.
- Console windows (likely): `BridgeManager.ts` spawn without `windowsHide`; agents spawned by the bridge without
  `HideWindow` / `CREATE_NO_WINDOW`.
- Claude stop (likely): Interrupt unsupported on Windows (always waits 3 s), `claude.cmd` → only cmd.exe killed →
  procgroup + taskkill /T. Hub `Stop()`: call `procgroup.Terminate` before `cancel()`.

### 6.2 Feature fixes
- `codex/install.go` `releaseTarget()` always Linux musl → per-OS target (or refuse like opencode); check the binary
  before replacing `~/.local/bin/codex`.
- Claude / agy install via `bash -lc "curl | bash"` (fails or installs into WSL) → PowerShell installer on Windows, or
  hide the button.
- `/api/search` (Jarvis): rg output split on `:` breaks on `C:\` → `rg --json` or `--null`; add `--` before the query.
- macOS: Claude voice reads `~/.claude/.credentials.json` only → Keychain fallback (`security find-generic-password -s
  "Claude Code-credentials" -w`).
- macOS: sandbox check only knows bubblewrap → `sandbox-exec` on darwin; "not supported" on Windows.
- `mcp/server.ts` start promise never settles on errors other than EADDRINUSE (reserved ports on Hyper-V/WSL/Docker
  PCs → EACCES) → resolve false + "port reserved, change antigem.mcpPort"; same for the bridge ports.
- Windows on ARM: no `win32-arm64` bridge → fall back to the x64 exe (or build arm64).
- Bridge from an older extension keeps running after an update (`BridgeManager.doStart` reuses any healthy bridge;
  on Windows it also locks the old folder) → compare versions, restart.
- Bridge binary loses +x if a darwin VSIX is packaged on Windows → `chmod 0755` before spawning (non-win32).
- `HOME` used instead of `os.homedir()`: `host.ts` agy history counts, `~` shortening/expansion, `jarvis/mcp.ts`.
- Notes / plugin host `rename` over an open file → EPERM on Windows → short retry.
- OpenCode allow rule `*/.antigem/uploads/*` uses `/` → add the `\` form on win32.
- Notifications: `xdg-open` only on Linux (skip elsewhere); macOS notification clicks do not open the chat.

### 6.3 Cosmetic / phone-app-only
- Basenames via `split('/')` show full Windows paths (`text.ts`, transcripts, `host.ts`, `jarvis/controller.ts`,
  webview `format.ts` `workspaceName`); case-insensitive / NFC project grouping on macOS and Windows.
- Codex commands shown wrapped in `powershell.exe -Command` (`CodexTranscript.unwrapShell`).
- Install hints (`curl | bash`, `~/.local/bin`) wrong on Windows.
- Phone-app-only bridge endpoints: git service through `sh -c`, zip import `\` names, `fsMove` across drives,
  `fsProtected` / `fsValidName` per-OS rules, drive letters in `/api/fs/roots`.
- Browser control on Windows (by design off today): registry keys, `.bat` host, named pipe, no chmod/getuid.
- macOS: Chrome "Load unpacked" picker hides `~/.antigem/chrome-extension` (Cmd+Shift+.).
