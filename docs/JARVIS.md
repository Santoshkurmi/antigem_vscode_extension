# Jarvis in the VS Code extension — host side and protocol for the UI

Jarvis is the app's **command center** (port of `app/.../data/jarvis/*` minus voice): a *Jarvis chat* is a normal chat of
any agent that gets Jarvis' guide, tools (`jarvis_mcp`) and a command strip. Give it a big job and it writes a mission,
creates teams, starts **tasks** (each its own chat of any agent, watched by the host), receives their news as hidden
messages, checks results and keeps going (autopilot). The host owns everything; the view only draws state it is sent
and sends `jarvisAction`s.

Host code: `src/core/jarvis/` (engine, managers, tasks, events, driver, controller, skill texts, settings, setup,
`mcp.ts` = jarvis_mcp at `/jarvis`). Offline test: `dev/test-jarvis.ts`.

## 1. Messages

### Host → view

| Message | When | What to do |
|---|---|---|
| `{type:'jarvis', state, full:true}` | on `init`, on `requestJarvis` | replace the whole Jarvis store |
| `{type:'jarvis', state}` | whenever something changes (≤ 4/s) | merge: **only the top-level fields that changed are present** (each one complete, e.g. the whole `tasks` array) |
| `{type:'jarvisNewChat', agent, modelId}` | answer to `jarvisAction newChat` (the host already sent the empty new-chat `chat` reset for `agent`) | mark this new-chat screen as a Jarvis draft: show `JarvisChatWelcome`, preselect `modelId` (if not null) for this chat only, and send its first message with `jarvis: true` |
| `{type:'jarvisNavigate', screen:'chat'\|'notes'\|'settings', conversationId?, settingsPage?}` | a Jarvis tool / notice wants this view to show something | `chat`: the host already sent the chat (`show`); switch to the chat screen. `notes`: open Notes. `settings`: open Settings at `settingsPage` (`'root'`, `'jarvis'`, `'jarvis.setup'`, `'claude.mcp'`…) |

### View → host

| Message | Fields |
|---|---|
| `{type:'requestJarvis'}` | — |
| `{type:'send', …, jarvis?: true}` | `jarvis: true` only on the first send of a chat opened via `jarvisNewChat` |
| `{type:'jarvisAction', action, chatId?, taskId?, agent?, noticeId?, teamName?, on?, settingsPage?}` | see below |

`JarvisActionKind`:

| action | fields | effect |
|---|---|---|
| `newChat` | `agent?` | host picks agent/model (Settings → Jarvis → Agent & model, else last used, else new-chat agent), shows an empty chat, answers `jarvisNewChat` |
| `stopTask` · `openTask` · `dismissTask` | `taskId` | stop it / show its chat / forget it (the chat stays) |
| `clearFinished` | `chatId?` | drop finished tasks (of that Jarvis chat, or all) |
| `pauseMission` · `resumeMission` · `clearMission` | `chatId` | mission of that Jarvis chat |
| `setAutopilot` | `chatId`, `on` | |
| `removeTeam` | `chatId`, `teamName` | |
| `stopAll` | `chatId?` | stop that Jarvis chat's turn and its tasks (no chatId: every Jarvis chat) |
| `dismissNotice` | `noticeId?` | one notice (none: all) |
| `clearLog` | — | |
| `setup` | `agent` | register jarvis_mcp with that agent (same as the Setup page button) |
| `openSettings` | `settingsPage?` | host answers `jarvisNavigate settings` (default `'jarvis'`) |

Errors come back as the usual `toast`. Returned texts (e.g. "Stopped 2 tasks") come as `toast` info.

## 2. Shapes (`shared/protocol.ts`, group "Jarvis"; `shared/model.ts`)

```ts
interface JarvisState {
  enabled: boolean;                       // Settings → Jarvis → Turn on Jarvis
  listMode: 'none' | 'text' | 'all';      // Jarvis chats in All / agent tabs too
  agent: AgentKind | null;                // agent of new Jarvis chats (null = last used / new-chat agent)
  modelId: string | null;
  chatIds: string[];                      // every Jarvis chat
  managers: JarvisManagerView[];          // one per Jarvis chat
  tasks: JarvisTaskView[];                // newest first, ≤ 30
  notices: JarvisNoticeView[];            // short-lived (9 s; 30 s with an action), ≤ 5
  log: JarvisLogEntry[];                  // newest last, ≤ 200 sent (500 kept)
  timers: { id: number; label: string; endsAt: number }[];
  anyActive: boolean;
}
interface JarvisManagerView {
  chatId: string; agent: AgentKind; title: string | null;
  mission: JarvisMissionView | null;      // null = no mission yet
  teams: JarvisTeamView[];
  status: string | null;                  // jarvis_status / the tool it uses / "Done: Parser" — the strip's subtitle
  phase: 'thinking' | 'working' | 'idle'; // its own turn: model writing / running a tool / waiting
  steps: { text: string; at: number; done: boolean }[];   // last 4 status lines (activity card)
  activeTasks: number; needsAttention: boolean;           // a task waits for approval / answer
  toolsMissing: boolean;                  // its agent answered JARVIS_MCP_MISSING → show the setup hint
  pendingEvents: number;                  // news queued for its next free moment
}
interface JarvisMissionView { goal; doneWhen; steps: JarvisStepView[]; status: 'active'|'done'|'paused'; autopilot; notes; doneCount; updatedAt }
interface JarvisStepView { n; text; status: 'todo'|'doing'|'done'|'blocked'; note }
interface JarvisTeamView { name; agent; model; role; project; runningTasks }
interface JarvisTaskView {
  id;                                      // the task's chat id (open it like any chat)
  title; goal; agent;
  state: 'starting'|'running'|'waiting_approval'|'asking'|'no_progress'|'done'|'failed'|'stopped';
  stateLabel;                              // "waiting for approval"…
  active; needsUser; owner /* manager chatId */; team; project; note; createdAt; updatedAt; followUps;
}
interface JarvisNoticeView { id; text; level: 'info'|'warning'|'error'; action: 'setup'|'settings'|'chat'|null; chatId?; at }
interface JarvisLogEntry { at; kind: 'task'|'event'|'approval'|'notice'|'mission'|'chat'; text; chatId?; taskId? }
```

Chat list (`conversations`): `Conversation.isJarvis?: boolean` (Jarvis tab, bot icon) and `Conversation.jarvisHidden?:
boolean` (leave it out of All and the agent tabs — the host already applied `listMode`). Both are absent while Jarvis is
off (then show no Jarvis tab and list every chat normally).

Event cards: a news message the host sent to a Jarvis chat is a `USER` message whose `content` is the one-line label
(`⚡ Jarvis · Parser: done`, `⚡ Jarvis · 3 updates — …`) and which carries
`ChatMessage.jarvisEvents: JarvisEventView[]`:

```ts
interface JarvisEventView {
  kind: 'task_done'|'task_failed'|'task_stalled'|'task_approval'|'task_question'|'nudge'|'autopilot_paused';
  title: string;   // "" = mission news → show "Mission"
  team: string; agent: string /* claude|agy|opencode|codex|"" */;
  taskId: string;  // ↗ opens it (openTask) while it is in state.tasks
  text: string;    // the sub-agent's report / error / question / "wants to …" — shown on "Show reports"
}
```

Render such a message as the app's `JarvisEventCard` instead of a user bubble (colors/words: done = green "Finished",
failed = red, stalled = orange "No progress", approval/question/autopilot_paused = amber, nudge = violet "Autopilot:
keep going").

## 3. What to build (Kotlin sources to port, `app/src/main/java/com/example/gemini/ui/`)

| UI piece | Port of | Data |
|---|---|---|
| Drawer: Jarvis filter chip + "New Jarvis chat" row, bot icon on Jarvis chats, hide `jarvisHidden` from All/agent tabs, empty text | `drawer/ChatHistoryDrawer.kt` (Jarvis chip ~l.859, `JarvisNewChatRow` ~l.2433, `isJarvis` row icon ~l.1575) | `conversations[].isJarvis/jarvisHidden`, `jarvis.enabled`; action `newChat` |
| Fresh Jarvis chat welcome + 3 starters | `jarvis/JarvisCommandCenter.kt` `JarvisChatWelcome` | `jarvisNewChat` draft flag |
| Command strip above the composer (mission title / status subtitle, steps progress `doneCount/steps`, Autopilot chip, task pills → open, "N finished tasks", tools-missing hint → Settings → Jarvis → Setup) and the expandable **board** (steps with marks, done-when, notes, Pause/Resume/Clear mission, teams with ✕, every task with Stop/Dismiss/Open) | `jarvis/JarvisCommandCenter.kt` `JarvisCommandStrip`, `Board`, `TaskPill`, `ToggleChip` | `managers[chatId]`, `tasks.filter(t => t.owner === chatId)`; actions `setAutopilot`, `pauseMission`, `resumeMission`, `clearMission`, `removeTeam`, `stopTask`, `dismissTask`, `openTask`, `openSettings {settingsPage:'jarvis.setup'}`. The app's Voice chip is not ported. |
| Event card in the feed | `JarvisCommandCenter.kt` `JarvisEventCard` | `ChatMessage.jarvisEvents` |
| Bot icon / badge (animated while working) | `jarvis/JarvisBot.kt` | `phase !== 'idle'` or `activeTasks > 0` |
| Overlay inside the webview: status pill (current manager's `status` + Stop → `stopAll {chatId}`), notices chip (tap: `setup` → Settings `jarvis.setup`, `settings` → `jarvis`, `chat` → open `chatId`; ✕ → `dismissNotice`), activity card (`steps`) | `jarvis/JarvisOverlay.kt` (skip the orb, mic, waves, transcript, send/cancel/wait) | `managers`, `notices` |
| Jarvis panel (all tasks with open/stop/dismiss, clear finished, the log, stop all, settings shortcut) | `jarvis/JarvisPanel.kt` (skip quick switches, typing box, voice) | `tasks`, `log`, `timers` |
| Settings → Jarvis | host-owned pages `jarvis`, `jarvis.agent`, `jarvis.personality`, `jarvis.setup`, `jarvis.tasks`, `jarvis.approvals`, `jarvis.chat` (normal `settings` pages; nothing to build beyond the generic renderer) | — |

## 4. Behaviour notes for the UI

- The host wraps every message sent to a Jarvis chat (boot pack on the first one, then a preamble with live context
  and the mission brief) — the chat only shows what the user typed.
- News is delivered only when the Jarvis chat is idle, batched (Settings → Jarvis → Manager & tasks), at most every 25 s.
- Approvals of a Jarvis chat's **own** tool calls: Jarvis' tools are approved automatically; anything else stays on the
  chat's normal approval card (plus a notice when that chat is not on screen). Approvals/questions **inside tasks** go
  to the Jarvis chat as events (or are approved by the policy).
- Several VS Code windows: only the window that serves the MCP port (first one) runs Jarvis' loops; the others still
  send messages and draw state they know.
- The app's voice parts (orb, mic, speech, wake phrase, quiet mode, voice replies chip, voice chat) do not exist here.
