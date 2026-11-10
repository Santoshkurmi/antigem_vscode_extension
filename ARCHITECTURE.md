# AntiGem for VS Code: architecture and source guide

This document is for **extension reviewers, security auditors and contributors**. It explains:
- what the extension runs, and which ports and sockets it opens;
- which files it reads and writes, and what goes over the network;
- where each part of the source lives.

Build and packaging steps are in [BUILDING.md](BUILDING.md). User documentation is in [README.md](README.md).

The extension is the VS Code version of the AntiGem Android app (<https://github.com/santoshkurmi/antigem>). Most
host and UI code is a TypeScript / SolidJS port of the app's Kotlin code, and the comments often name the Kotlin file
they port.

---

## 1. The big picture

```
 VS Code window
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ Webview UI (SolidJS, webview/)       renders only; no network access (CSP)   │
 │        ▲ postMessage (shared/protocol.ts)                                    │
 │        ▼                                                                     │
 │ Extension host (src/extension.ts + src/core/)                                │
 │   AppHost: views ⇄ agent backends, settings, projects, search                │
 │   Backends: agy · claude · codex · opencode                                  │
 │   Built-in MCP servers (HTTP 127.0.0.1:1246)                                 │
 │   Jarvis engine, notes, themes, plugins, browser link                        │
 └───────┬────────────────────────┬─────────────────────────────┬───────────────┘
         │ HTTP / WebSocket       │ fork (Node)                 │ Unix socket (0600)
         │ 127.0.0.1:1244         ▼                             ▼
         │ token header     plugin runtime            antigem-bridge --native-host
         ▼                  (user-installed                 ▲ stdio (Chrome native messaging)
 ┌──────────────────┐        plugins only)                  │
 │ antigem-bridge   │                                AntiGem Chrome extension
 │ (Go, bin/)       │                                (dist/chrome-extension/)
 └─┬──────┬──────┬──┘
   │      │      └─ spawns the agent CLIs the user installed:
   │      │           claude (stream-json) · codex app-server (stdio) · opencode serve (127.0.0.1, random port)
   │      └─ spawns agy (Antigravity CLI) as its language-server hub on 127.0.0.1:1245
   └─ the extension host talks gRPC (HTTP/2 cleartext) to the hub, with the hub's CSRF token
```

**The core rules:**
- **The webview never touches the network.** Every request runs in the extension host.
- **Everything AntiGem serves is local.** It listens on `127.0.0.1` or on a per-user Unix socket, never on another
  interface.
- **The agent CLIs are third-party programs the user installs.** AntiGem starts them, but it doesn't patch or modify
  them (the agy binary is started unmodified: `--no-agy-patch`).

## 2. Where to start reading

| If you want to see… | Start at |
|---|---|
| Activation, commands, webview HTML / CSP, editor integration | `src/extension.ts` |
| How the UI and host talk (every message type) | `shared/protocol.ts`, `shared/model.ts` |
| Routing between views and agents, settings pages, diffs sent to the UI | `src/core/host.ts` |
| Starting / reusing the bridge, its token, its arguments | `src/core/bridge/BridgeManager.ts` |
| One agent end to end | `src/core/claude/ClaudeBackend.ts` (or `agy/`, `codex/`, `opencode/`) |
| The local MCP server and its auth | `src/core/mcp/server.ts` |
| The browser link (native messaging) | `src/core/browser/bridge.ts`, `nativeHost.ts`, `bridge/pkg/nativehost/` |
| Plugin execution | `src/core/plugins/runtime.ts`, `src/core/plugins/runtime/*.mjs` |
| The bridge's HTTP routes | `bridge/main.go`, `bridge/pkg/handlers/`, `bridge/pkg/<agent>/handlers.go` |

## 3. Repository layout

| Path | What it is |
|---|---|
| `src/extension.ts` | VS Code glue. It registers:<ul><li>the activity-bar webview and chats in editor tabs;</li><li>commands, key bindings and context menus;</li><li>editor-selection tracking, file search for `@` mentions, terminals;</li><li>the `Platform` implementation the core uses.</li></ul> |
| `src/core/` | Host logic with **no `vscode` import** (it also runs under `dev/server.ts` for browser testing). |
| `src/core/host.ts` | `AppHost`. It routes views to backends, sends only changed messages to each view, owns the settings root, projects, search and notes. |
| `src/core/settings.ts`, `text.ts`, `types.ts` | Host-owned settings pages (slash commands, global context, connection), text helpers, backend interfaces. |
| `src/core/bridge/` | `BridgeManager`: finds or starts the bridge binary, reads its token, does HTTP/WebSocket with the auth header, power off / on. |
| `src/core/agy/` | Antigravity. Native gRPC over HTTP/2 (`grpc.ts`), protobuf runtime loading (`proto.ts`), port of the app's `TrajectoryEngine.kt` (`trajectory.ts`), settings, quota. |
| `src/core/claude/` | Claude Code through the bridge's session WebSocket. Transcript parser, sessions, read-only subagent views, settings, custom providers, approvals, quota. |
| `src/core/codex/` | Codex through the bridge's `app-server` JSON-RPC relay. |
| `src/core/opencode/` | OpenCode through the bridge's relay to `opencode serve` (REST + SSE). |
| `src/core/mcp/` | The built-in MCP HTTP server (`server.ts`) plus the Notes and Theme servers and the MCP presets. |
| `src/core/jarvis/` | Jarvis mode: managers, tasks, events, approval policy and the `/jarvis` MCP server. |
| `src/core/browser/` | The browser link:<ul><li>a Unix-socket server for the native host (`bridge.ts`);</li><li>native-host registration (`nativeHost.ts`);</li><li>the `/browser` MCP server (`mcp.ts`, `tools.ts`).</li></ul> |
| `src/core/plugins/` | Custom plugins:<ul><li>the plugin manager (`service.ts`);</li><li>repositories (`repos.ts`) and skills;</li><li>`/plu:` expansion;</li><li>the Plugin Developer MCP;</li><li>the forked runtime (`runtime.ts`). `runtime/*.mjs` are the app's plugin runtime files, unchanged.</li></ul> |
| `shared/` | The contract between host and UI: `model.ts` mirrors the app's `Models.kt`, `protocol.ts` lists every message. |
| `webview/` | The UI: a SolidJS port of the app's Jetpack Compose UI. `webview/src/dev/mock.ts` is a fake host for UI work (`?mock`). |
| `proto/` | The Antigravity hub's `LanguageServerService.proto`, loaded at runtime with protobufjs. |
| `bridge/` | The Go bridge, a fork of the AntiGem app's IDE bridge. One static binary (`CGO_ENABLED=0`). |
| `bin/` | The prebuilt bridge binaries, one per platform, built from `bridge/` (see section 9). |
| `dist/chrome-extension/` (in the VSIX) | The AntiGem Chrome extension (Manifest V3, plain JavaScript, no build step). Its source is its own repository, `antigem-chrome-extension`, next to this one; `esbuild.mjs` copies it into `dist/` and the VSIX ships it, so reviewers can read it there. |
| `media/` | Icons. |
| `scripts/` | Bridge build and VSIX packaging scripts. |
| `dev/` | Developer tools, not shipped:<ul><li>`server.ts` runs `src/core` behind a WebSocket so the UI can run in a browser;</li><li>`test-*.ts` are offline and end-to-end test suites.</li></ul> |
| `docs/` | Internal planning notes (not shipped). |

## 4. Processes

| Process | Started by | When | Notes |
|---|---|---|---|
| `bin/antigem-bridge-<platform>-<arch>` | Extension host (`BridgeManager`) | On activation, if no bridge answers on `antigem.bridgePort` | Detached and shared by all VS Code windows. Stopped by the power button or *Restart Bridge*. Arguments: `-f --no-agy-patch -p <port> --hub-port <port> --bind 127.0.0.1 -d <workspace>`, plus the user's CLI paths. |
| `agy` (Antigravity CLI) | Bridge | When agy is installed and enabled | Runs as the language-server hub on `127.0.0.1:<hubPort>` with `--app_data_dir=<chosen history folder>`. |
| `claude` | Bridge | One per running Claude chat; short-lived ones for account info, usage and login | `--output-format stream-json`. The bridge relays stdin/stdout over a WebSocket. |
| `codex app-server --listen stdio://` | Bridge | While Codex is used | JSON-RPC over stdio, relayed by the bridge. |
| `opencode serve --hostname 127.0.0.1 --port <free port>` | Bridge | While OpenCode is used | Reached only through the bridge. |
| Plugin runtime (`runtime/host-ipc.mjs`) | Extension host (`child_process.fork`, `ELECTRON_RUN_AS_NODE=1`) | Only if a plugin with MCP tools / a worker is installed and enabled, and only in the window that owns the MCP port | Runs **user-installed** plugin code. It is a separate process, so a plugin cannot block VS Code. Skills-only plugins never start it. |
| `antigem-bridge --native-host` | Chrome | Only after the user registered the native host and the Chrome extension connects | Passes framed messages between Chrome (stdio) and the extension host's Unix socket. |
| Official CLI installers (`curl … install.sh \| bash`, or a download of the vendor's build) | Bridge | Only when the user presses *Install* / *Update* on an agent's *Account & CLI* page | Each command is shown on that page. |

## 5. Network

### Listening (all `127.0.0.1` only)
| Port / socket | What | Who may call |
|---|---|---|
| `1244` (`antigem.bridgePort`) | Bridge REST + WebSocket | Requests with the token header (see 6.1) |
| `1245` (`antigem.hubPort`) | Antigravity hub (gRPC) | Requests with the hub's `x-codeium-csrf-token` |
| `1246` (`antigem.mcpPort`) | Built-in MCP servers: `/notes`, `/theme`, `/jarvis`, `/browser`, `/extension_developer`, `/mcp?extension=<id>` | Requests with the `X-Device-Id` header and **no** `Origin` header (see 6.2) |
| random port | `opencode serve` | The bridge |
| `$XDG_RUNTIME_DIR/antigem/browser.sock` (fallback `~/.antigem/run/browser.sock`) | Browser link | The current user only (folder `0700`, socket `0600`, owner checked) |

### Outbound requests made by AntiGem itself
- **Plugin repositories:** `api.github.com` / `raw.githubusercontent.com`. This happens when the user opens the plugin
  store, and in a 12-hour update check that only runs if a plugin was installed from a repository. The check only
  **notifies**; an update is installed only when the user presses *Update*.
- **Agent installers** (see the processes table), only when the user presses *Install* or *Update*:
  `antigravity.google`, `claude.ai`, OpenAI's Codex releases, `opencode.ai`.
- **Model lists of custom Claude providers** (e.g. DeepSeek, Moonshot, Z.ai, OpenRouter), only for providers the user
  configures.
- **Images in chat messages:** the webview CSP allows `img-src https:` so images in replies can render.

The agent CLIs make their own connections to their providers. AntiGem does not proxy, inspect or log that traffic.
**AntiGem has no telemetry and no analytics.**

### Webview Content Security Policy (`src/extension.ts`, `webviewHtml`)
`default-src 'none'; img-src <webview> data: blob: https:; media-src <webview> data: blob:; style-src <webview>
'unsafe-inline'; font-src <webview> data:; script-src 'nonce-…' <webview>`.

There is no `connect-src`, so the UI cannot make network requests. Scripts are the extension's own bundle, loaded
with a per-load nonce.

## 6. Authentication and isolation

### 6.1 Bridge
- **Token:** `~/.antigem_bridge/csrf_token.txt`. The bridge creates it if missing; the extension only reads it and
  never passes `-t`, which would overwrite it.
- **Header:** every request, including WebSocket upgrades, must carry a header whose *name* contains the token
  (`x-ag<token>_9qx`). The token is never accepted in a URL.
- **Lockout:** repeated failures from one address are blocked for 5 minutes.

### 6.2 Built-in MCP servers (`src/core/mcp/server.ts`)
- **Device id:** a random device id is kept in the extension's global state. Requests must send it as `X-Device-Id`;
  otherwise the answer is `401`.
- **No browser access:**
  - No CORS headers are ever sent.
  - `OPTIONS` requests and any request with an `Origin` header get `403`, so web pages cannot call these servers.
- **Protocol:** JSON-RPC 2.0 over POST only.
- **Who gets the address:** agents receive the URL and header only when the user adds a preset on an agent's MCP
  page.

### 6.3 Browser link
- **Pinned extension:** the Chrome extension's ID is pinned by the public `key` in the Chrome extension's `manifest.json`
  (`kbdjcdlfeoijcchepbldpldeaeijgibi`).
- **Native host registration:**
  - It is written only when the user presses *Register with Chrome*, never at activation.
  - It writes `com.antigem.browser_bridge.json` (with `allowed_origins` = that ID only) into the browsers'
    `NativeMessagingHosts` folders.
  - It writes a small wrapper script at `~/.antigem/chrome/antigem-native-host`.
- **Handshake:** the extension host refuses a native host started for another origin, and an extension whose hello
  carries another ID.
- **No outside access:** the Chrome extension has no `externally_connectable`, so web pages and other extensions
  cannot message it. Messages from its own content scripts can only act on their own tab.
- **Where agents can act** (enforced in the extension, `bg/policy.js`):
  - only tabs in the "AntiGem" tab group (and popups they open);
  - any other tab asks the user in a confirmation window;
  - a blocklist (banking, payments, password managers, crypto, `file://`) where the debugger is detached and
    nothing is recorded;
  - browser-internal pages are always refused;
  - raw DevTools access is limited to `Input.*`.
- **File uploads:** files from `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.antigem_bridge` and similar folders are refused.

### 6.4 Plugins
Plugins are third-party code the user chooses to install, from a ZIP or a GitHub repository listed in the plugin
settings.
- **Skills-only plugins** are just Markdown files served to agents.
- **Plugins with tools** run in the separate plugin-runtime process (section 4). They reach the browser only
  through the browser link above, with its tab-group and blocklist rules.

## 7. Files read and written

| Location | What | When |
|---|---|---|
| `~/.antigem_bridge/csrf_token.txt` | Bridge token | Read on start; created by the bridge if missing |
| `~/.antigem_bridge/opencode/` | The `opencode.json` config the bridge generates for `opencode serve` | While OpenCode is used |
| `~/.antigem/notes/notes.json` | Notes and to-dos | When notes change |
| `~/.antigem/projects.json` | Saved project folders | When a folder is picked |
| `~/.antigem/uploads/`, `~/.antigem/claude-attachments/` | Files attached to chats | When the user attaches files |
| `~/.antigem/claude-rewinds/` | Rewind points of Claude chats | When a message is edited |
| `~/.antigem/browser-extensions/` (+ `.antigem-state/`) | Installed plugins and their state | On plugin install / update / remove |
| `~/.antigem/chrome-extension/`, `~/.antigem/chrome/antigem-native-host` | Copy of the Chrome extension for *Load unpacked*, and the native-host wrapper | Only from *Settings → Browser* buttons |
| Browser `NativeMessagingHosts/com.antigem.browser_bridge.json` | Native host registration | Only on *Register with Chrome* |
| `~/.gemini/<antigravity-ide \| antigravity \| antigravity-cli>/` | Antigravity history, written by the agy hub | While agy runs |
| `~/.claude/projects/…` (read) | Claude Code transcripts, read to show chat history and subagents | Opening chats |
| Agent configuration (agy `mcp_config.json`, Claude `settings.json` / MCP config, Codex `config.toml`, OpenCode config) | Changed through each agent's own API or CLI | Only when the user changes that agent's settings in AntiGem |
| VS Code global state | Extension preferences (enabled agents, theme, Jarvis state, MCP device id…) | Normal use |

## 8. Third-party code

**npm (bundled into `dist/` by esbuild / Vite):**
- `protobufjs` and `ws` (extension host).
- `solid-js`, `katex`, `mermaid` and `@material-design-icons/svg` (webview).

Build-only: `esbuild`, `vite`, `vite-plugin-solid`, `typescript`, `@vscode/vsce`, type packages.

**Go (in the bridge binary):**
- `gorilla/websocket`, `google/uuid`, `modernc.org/sqlite` (pure Go SQLite) and their dependencies.
- See `bridge/go.mod`.

**Copied from the AntiGem app, unchanged:**
- `src/core/plugins/runtime/*.mjs` (plugin runtime).
- The Chrome extension's `page-agent.js` (page helper for the browser tools).
- `proto/LanguageServerService.proto`.

## 9. Verifying the bundled binaries

The bridge binaries in `bin/` are built from `bridge/` with:

```sh
cd bridge
CGO_ENABLED=0 GOOS=<os> GOARCH=<arch> go build -trimpath -ldflags='-s -w' -o ../bin/antigem-bridge-<platform>-<arch>[.exe] .
```

(`npm run build:bridge` does this for every target.) With the same source and Go toolchain the build is
reproducible: two builds of the same tree produce byte-identical binaries, so a reviewer can rebuild and compare
SHA-256 hashes. `bridge/go.mod` gives the minimum Go version.

The VSIX also ships the full source (`bridge/`, `src/`, `shared/`, `webview/src/`, build configs), so the shipped
package can be compared with this repository.

## 10. Testing

| Suite | What it covers |
|---|---|
| `dev/test-browser.ts` | Native-messaging framing, socket, registration, browser MCP tool schemas (offline) |
| `dev/test-browser-e2e.ts` | Every browser tool against a throwaway Chrome profile |
| `dev/test-plugins.ts` | Plugin runtime, skills, `/plu:` expansion, repositories, developer MCP |
| `dev/test-jarvis.ts` | Jarvis task state machine, events, MCP tools |
| `dev/test-agy.ts`, `test-claude.ts`, `test-codex.ts`, `test-opencode.ts` | Agent backends against a running bridge |

Each file's header says how to run it, e.g.
`npx esbuild dev/test-plugins.ts --bundle --platform=node --outfile=/tmp/t.js && node /tmp/t.js` (run from the
project folder).

For UI work: `npm run dev:server` (core behind `ws://127.0.0.1:5199`) and `npm run dev:webview`; add `?mock` to use
the fake host instead.
