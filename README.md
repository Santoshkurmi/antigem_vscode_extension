# AntiGem for VS Code

The AntiGem app's chat UI inside VS Code: one sidebar and chat tabs for Antigravity (agy), Claude Code, Codex and
OpenCode, all four through the same bridge and the same UI.

## Why this extension / objective

The goal is to give developers a **single, seamless place inside VS Code** to talk to every coding agent they use
(Antigravity/agy, Claude Code, Codex, OpenCode) instead of juggling four separate CLIs and UIs. Concretely:

- **One chat UI for all models** — switch agents per conversation without leaving the editor.
- **Rich GUI and formatting** — markdown, code blocks, diffs, math, diagrams, file chips and image paste, instead
  of plain terminal text.
- **Editor integration** — selections and files become chips, `@` mentions, drag & drop, open-in-editor tabs,
  run shell blocks in a terminal, reveal ranges.
- **More control** — per-agent settings, CLI paths, project folders, approvals, rewind, plugins/skills, quota
  views, and a shared bridge so all windows reuse one process.

This is the VS Code port of the AntiGem Android app (https://github.com/santoshkurmi/antigem): same bridge
protocol, chat UI and agent backends, just hosted inside VS Code instead of on a phone.

## VS Code integration

| What | How |
|---|---|
| Selection → chat | Select code in an editor: the composer offers it as a chip (`file.ts:12-30`), included by default; ✕ to leave it out |
| Add selection / file | `Ctrl+Alt+K` (`Cmd+Alt+K`), or right-click → *Add Selection to AntiGem Chat* / *Add to AntiGem Chat* (editor, editor tab, explorer — files and folders) |
| `@` mentions | Type `@` in the composer: open editors first, then workspace files and folders (fuzzy); picks become chips |
| Drag & drop | Drag files/folders from the explorer onto the chat (hold Shift, as for every VS Code webview) |
| Paste images | Paste a screenshot into the composer |
| Focus chat | `Ctrl+Alt+G` (`Cmd+Alt+G`); new chat `Ctrl+Alt+N` while the chat has focus |
| Code blocks | ▶ runs shell blocks in an *AntiGem* terminal; diffs and long outputs open in an editor tab |
| Editor tabs | ⋮ → *Open in editor tab*: chats side by side for multitasking |

## Layout

| Path | What |
|---|---|
| `bridge/` | Fork of the app's Go IDE bridge (`agy_ide_bridge`). Adds `--no-agy-patch`: the agy binary is never modified; the hub keeps its standard `x-codeium-csrf-token` header. |
| `proto/` | The hub's `LanguageServerService.proto` (the app's filtered copy), loaded at runtime with protobufjs. |
| `shared/` | The contract between host and UI: `model.ts` (mirror of the app's `Models.kt`) and `protocol.ts` (messages). |
| `src/core/` | Host-side logic, no VS Code dependency: bridge manager, `AppHost` (routes views ↔ backends, sends only diffs, settings, projects, search), and one backend per agent: `agy/` (gRPC to the hub, port of `TrajectoryEngine.kt`), `claude/` (bridge session WebSocket), `codex/` (app-server JSON-RPC via the bridge), `opencode/` (relayed API + SSE). |
| `src/extension.ts` | VS Code glue: activity-bar webview (the whole app, phone-like) + chats in editor tabs. |
| `webview/` | The UI: SolidJS port of the app's Compose UI. |
| `dev/` | `server.ts` runs `src/core` behind a WebSocket so the UI runs in a browser; `client.ts` / `probe*.ts` are headless tests. |

## How it talks to agy

webview ⇄ postMessage ⇄ extension host ⇄ native gRPC (HTTP/2 cleartext) ⇄ agy hub (started by the bridge).
The webview never touches the network. The bridge token comes from `~/.antigem_bridge/csrf_token.txt` (never
overwritten); the hub's own csrf token comes from the bridge's `/api/status`.

Default ports: bridge `1244`, hub `1245` (settings `antigem.bridgePort` / `antigem.hubPort`), so it does not collide
with a phone server-mode bridge on `1234`/`1235`.

## Build & run

See `BUILDING.md` for the full build/package documentation (including per-platform VSIX packaging).

```sh
npm install
npm run build:bridge      # Go → bin/antigem-bridge-<platform>-<arch> for all 64-bit targets
npm run build             # extension host (esbuild) + webview (vite)
code --extensionDevelopmentPath="$PWD"
```

Supported native targets (64-bit only): linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.

UI development in a browser, against the real backends:

```sh
npm run dev:server -- /path/to/project   # host on ws://127.0.0.1:5199 (starts the bridge if needed)
npm run dev:webview                      # http://127.0.0.1:5173  (add ?mock for the fake data stream)
```

The bridge runs detached and is shared by all windows; stop it with the "AntiGem: Restart Bridge" command or
`curl -X POST` its `/api/shutdown` with the token header.

## Packaging for the Marketplace

A single VSIX containing all five 64-bit binaries is the recommended (and default) way to ship. One command
builds the bridge (all targets), the host and the webview, then packages:

```sh
npm run package          # → antigem.vsix (~31 MB)
```

The runtime picks the right binary by `process.platform`/`process.arch` (with `.exe` on Windows), so one package
works on every supported 64-bit platform.

Per-platform packages are still available if you ever want smaller downloads:

```sh
npm run package:linux-x64        # single target (~8.5 MB)
npm run package:all              # all 64-bit targets
```

Source code (`bridge/`, `src/`, `shared/`, `webview/src/`) is shipped inside every VSIX for transparency and
reviewer verification.

## Related projects

- This extension is the VS Code port of the **AntiGem Android app**: https://github.com/santoshkurmi/antigem
- Extension repository: https://github.com/santoshkurmi/antigem_vscode_extension

Both share the same bridge protocol, chat UI and agent backends (agy, Claude Code, Codex, OpenCode); this project
just hosts them inside VS Code instead of on a phone.
