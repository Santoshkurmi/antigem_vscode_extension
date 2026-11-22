// Messages between the extension host (or the dev server) and the webview.
// The webview never touches the network: every agent call happens on the host side and arrives here as data.
import type {
  AgentKind,
  AiModel,
  ArtifactSnapshot,
  ChatAttachment,
  ChatMessage,
  ChoiceQuestionnaire,
  Conversation,
  CrewChatTag,
  QueuedMessage,
} from './model';

export type AgentRunState = 'online' | 'starting' | 'offline' | 'error' | 'disabled' | 'not_installed';

export interface AgentStatus {
  kind: AgentKind;
  label: string;
  state: AgentRunState;
  detail?: string | null;
  /** Logged-in account, when known. */
  account?: string | null;
  /** CLI version ("1.5.3"), when known. */
  version?: string | null;
  /** Subscription / plan ("Google AI Pro", "Max", "Free"), when known. */
  plan?: string | null;
  /** Settings page that installs / signs in / fixes this agent ('agy.cli', 'claude.cli'…), for "Install" buttons. */
  setupPage?: string | null;
  /**
   * Installed but nobody is signed in, or the sign-in expired: the chat shows "Sign in" instead of an error. The
   * page's sign-in button is `<agent>.signin` (agy.signin, claude.signin, codex.signin); sign-out `<agent>.signout`.
   */
  signedOut?: boolean | null;
}

export interface WorkspaceFolder {
  name: string;
  /** file:// URI */
  uri: string;
  path: string;
}

/** One choice button of an approval card (mirrors the app's ApprovalChoice). */
export interface ApprovalChoiceView {
  id: string;
  label: string;
  description?: string | null;
}

/** A pending tool approval, already built on the host (mirrors the app's ApprovalItem). */
export interface ApprovalView {
  key: string;
  agent: AgentKind;
  /** Icon hint: 'terminal' | 'file' | 'edit' | 'web' | 'mcp' | 'plan' | 'shield' */
  icon: string;
  title: string;
  subtitle?: string | null;
  target?: string | null;
  /** Monospace body; lines starting with "+ " / "- " are colored as a diff. */
  preview?: string | null;
  markdown?: string | null;
  reason?: string | null;
  primary: ApprovalChoiceView;
  secondary: ApprovalChoiceView[];
  always: ApprovalChoiceView[];
  denyLabel: string;
  denyPlaceholder: string;
}

export interface QuestionView {
  key: string;
  agent: AgentKind;
  questionnaire: ChoiceQuestionnaire;
}

/** One chip of an agent's controls strip above the composer (the app's Claude/Codex/OpenCode ControlsStrip). */
export interface ControlChipView {
  id: string;
  /** Short label ("Auto", "Effort · High", "Thinking"). */
  label: string;
  /** Title of the chip's picker sheet ("Permission mode"); defaults to the label. */
  title?: string | null;
  /** Footnote under the picker sheet's options ("Switching applies to the next message…"). */
  note?: string | null;
  /** 'select' opens a menu of `options`; 'toggle' flips `value` between "on" / "off"; 'info' is display only
   *  (tapping it may open its details: the host answers setControl {value:'details'} with a toast/dialog);
   *  'action' runs at once (setControl with value 'run'). */
  kind: 'select' | 'toggle' | 'info' | 'action';
  value: string;
  options?: { value: string; label: string; description?: string | null }[];
  /** Material icon name hint ('bolt', 'psychology', 'shield', 'speed', 'timer'…). */
  icon?: string | null;
  tone?: 'accent' | 'warn' | 'danger' | 'success' | 'muted' | null;
  disabled?: boolean;
}

// ------------------------------------------------------------------------------------------------ chip details
// A click on an 'info' chip (context, cache, usage…) sends setControl {value: 'details'}; a backend that can describe
// it answers with a `chipDetails` card the view shows anchored to the chip (like Claude Code's own VS Code extension
// shows the context window), instead of a toast.

export type DetailTone = 'ok' | 'warn' | 'error' | 'muted' | 'accent' | null;

export interface ChipDetailsView {
  /** The chip it belongs to (ControlChipView.id). */
  chipId: string;
  conversationId: string | null;
  title: string;
  /** Under the title ("Claude Code · Opus 5.5"). */
  subtitle?: string | null;
  /** The main figure ("124.3k / 200k tokens", "4 min left") with a caption and a tone. */
  headline?: { value: string; caption?: string | null; tone?: DetailTone } | null;
  /**
   * One stacked bar with a legend (the context window by category). `total` = the whole bar; a part with `free` is
   * drawn as empty space. `text` = the value as shown ("12.4k").
   */
  breakdown?: { total: number; parts: { label: string; value: number; text?: string | null; color?: string | null; free?: boolean }[] } | null;
  /** Bars (usage windows, cache time left): `used` from 0 to 1; `text` on the right ("62% used"), `detail` under it ("resets in 2 h"). */
  meters?: { label: string; used: number; text?: string | null; detail?: string | null; tone?: DetailTone }[];
  /** Label / value lines. */
  rows?: { label: string; value: string; tone?: DetailTone }[];
  /** Small text at the bottom. */
  note?: string | null;
  /** Buttons: setControl {id: chipId, value: 'action:<id>'} (e.g. "Compact now"). */
  actions?: { id: string; label: string; primary?: boolean }[];
  /** Still being read: the view shows a spinner until the full card comes. */
  loading?: boolean;
  error?: string | null;
}

/** State of the chat a view shows. Every field is optional in a patch: absent = unchanged. */
export interface ChatPatch {
  /** Replace everything (new conversation opened). Fields not in the patch reset to defaults. */
  reset?: boolean;
  conversation?: Conversation | null;
  agent?: AgentKind;
  /** Full ordered list of message ids, sent when the order or membership changed. */
  order?: string[];
  /** Messages that are new or changed since the last patch (matched by id). */
  upserts?: ChatMessage[];
  isStreaming?: boolean;
  isLoading?: boolean;
  error?: string | null;
  queued?: QueuedMessage[];
  approvals?: ApprovalView[];
  question?: QuestionView | null;
  artifacts?: ArtifactSnapshot[];
  /** Status line under the working spinner (e.g. "Running command…"). */
  workingLabel?: string | null;
  /** The agent's controls strip (also sent for a new, empty chat). */
  controls?: ControlChipView[];
  /** One-line notice above the strip (Codex / OpenCode: "Model rerouted…", provider hiccups). */
  notice?: string | null;
  /** The model this chat uses (per-chat model agents such as Claude); the model pill prefers it. */
  modelId?: string | null;
  /**
   * The chat cannot take messages (a Claude subagent's transcript: it is driven by its parent chat). The text says why;
   * the composer is replaced by it (and a link to the parent chat when the conversation has parentConversationId).
   */
  readOnly?: string | null;
}

/** What the user has open / selected in the VS Code editor (the composer offers it as a chip). */
export interface EditorContextView {
  path: string;
  relativePath: string;
  name: string;
  languageId: string;
  /** null = nothing selected (just the active file). */
  selection: { startLine: number; endLine: number; text: string } | null;
}

/** A chat found by "search in chats". */
export interface ChatSearchHit {
  conversationId: string;
  agent: AgentKind;
  title: string;
  snippet: string;
  updatedAt: number;
}

/** A file / folder the `@` popup offers. */
export interface FileSuggestion {
  path: string;
  relativePath: string;
  /** Default 'file'. */
  kind?: 'file' | 'folder';
  /** Open in an editor tab right now (listed first). */
  isOpen?: boolean;
}

export interface ModelsState {
  agent: AgentKind;
  models: AiModel[];
  selectedId: string | null;
  /** Optional: model picker sections (models whose `group` equals `name`), each with its usage limits on top. */
  groups?: ModelGroupView[];
  /** Optional: the host is reloading the list (the picker's refresh icon spins). */
  refreshing?: boolean;
}

/** One usage limit of a quota group, shown as a small meter ("5h ▬▬▭ 85% · 2h 4m"). */
export interface QuotaWindowView {
  label: string;
  /** 0..1 share left. */
  remaining: number;
  /** Time until it resets, already formatted ("2h 20m"). */
  resetText?: string | null;
  /** Share left, already formatted the agent's way ("48.8%" for Antigravity, "75%" for Claude). Prefer it. */
  text?: string | null;
}

/** A section of the model picker (mirrors the app's QuotaGroupHeader). */
export interface ModelGroupView {
  name: string;
  windows?: QuotaWindowView[];
}

/** One entry of the `/` command picker (mirrors the app's SlashCommandItem). */
export interface SlashCommandView {
  /** What is typed, with the slash: "/compact". */
  command: string;
  description?: string | null;
  argumentHint?: string | null;
  /** Picker group: 'command' (agent commands), 'skill', 'custom', 'plugin', 'app'. Default 'command'. */
  kind?: 'command' | 'skill' | 'custom' | 'plugin' | 'app';
  pluginName?: string | null;
  /** A tap sends it right away (no argument needed) instead of putting it in the box. */
  runsOnTap?: boolean;
}

// ------------------------------------------------------------------------------------------------ settings
// The host describes the settings pages; the view draws them in the app's style (SettingsRows.kt) and reports edits.
// Ids are opaque to the view: it sends them back in settingChange / settingAction.

export interface SettingOption {
  value: string;
  label: string;
  description?: string | null;
}

/** A row of a settings list (MCP server, plugin, model…). */
export interface SettingListRow {
  id: string;
  title: string;
  subtitle?: string | null;
  /** Small status chip ("Connected", "Error"…). */
  status?: string | null;
  statusTone?: 'ok' | 'warn' | 'error' | 'muted' | null;
  /** A switch on the row (sends settingChange {id: item.id, rowId, value}). */
  toggle?: boolean | null;
  /** Row buttons / ⋮ menu entries (send settingAction {id: item.id, rowId, actionId}). With `form`, the view shows
   *  the form first (prefilled) and sends its values with the action ("Edit"). */
  actions?: { id: string; label: string; danger?: boolean; confirm?: string | null; form?: SettingFormField[] | null }[];
}

/** A field of an "add / edit" form (settingAction carries the typed values). */
export interface SettingFormField {
  id: string;
  label: string;
  /** checklist: several of `options` ticked; value = the ticked values joined with ",". */
  kind: 'text' | 'multiline' | 'select' | 'toggle' | 'password' | 'checklist';
  placeholder?: string | null;
  value?: string | null;
  options?: SettingOption[];
  /** Must be filled (only checked while the field is shown). */
  required?: boolean;
  /** Shown only while the form's field `field` has one of `values` (an MCP server's command for type stdio, its URL
   *  for http / sse). A hidden field's value is still sent. */
  showWhen?: { field: string; values: string[] } | null;
}

export type SettingItem =
  | { kind: 'toggle'; id: string; label: string; description?: string | null; value: boolean; disabled?: boolean }
  /** Several of `options` can be ticked (checkboxes); settingChange value = string[] of ticked values. */
  | { kind: 'checklist'; id: string; label: string; description?: string | null; values: string[]; options: SettingOption[]; disabled?: boolean }
  | { kind: 'select'; id: string; label: string; description?: string | null; value: string; options: SettingOption[]; disabled?: boolean }
  | {
      kind: 'text';
      id: string;
      label: string;
      description?: string | null;
      value: string;
      placeholder?: string | null;
      multiline?: boolean;
      disabled?: boolean;
      /** Visible rows of a multiline field (a settings.json editor wants ~24). */
      rows?: number | null;
      /** Monospace code editor look (JSON / config files). */
      code?: boolean;
    }
  | { kind: 'info'; id: string; label: string; value: string; tone?: 'ok' | 'warn' | 'error' | 'muted' | null; description?: string | null }
  | {
      kind: 'button';
      id: string;
      label: string;
      description?: string | null;
      style?: 'primary' | 'danger' | 'default';
      /** Ask before running (dialog text). */
      confirm?: string | null;
      /** Show a form first; its values go with the action. */
      form?: SettingFormField[] | null;
      disabled?: boolean;
    }
  | {
      kind: 'list';
      id: string;
      label: string;
      description?: string | null;
      rows: SettingListRow[];
      emptyText?: string | null;
      /** "Add" button with a form (settingAction {id, actionId: 'add', values}). */
      addLabel?: string | null;
      addForm?: SettingFormField[] | null;
      /**
       * How the rows show: 'rows' (default); 'tiles', a grid of cards; 'search', one button (labelled `label`) that opens
       * a searchable sheet of the rows. With tiles and search a tap on a row runs its action, or asks which one first
       * when it has several (status 'Connected' marks a tile as added).
       */
      display?: 'rows' | 'tiles' | 'search' | null;
      /** display 'search': the sheet's title ("Connect a provider"). */
      searchTitle?: string | null;
      /** Tiles / the search button: accent token or hex ('opencode', '#D97757'…). */
      accent?: string | null;
      /** Tiles: Material icon name. */
      icon?: string | null;
    }
  /**
   * An agent CLI's card (the app's AgyCliCard), the same on every agent's Account & CLI page: the title with a refresh
   * icon, the version and path (or "not installed" / why it could not be checked), its buttons (Install / Check for
   * updates / Restart: settingAction {id: action.id}), the install / update job with its log, and a footnote.
   */
  | {
      kind: 'cli';
      id: string;
      /** "Claude Code CLI" */
      label: string;
      state: 'checking' | 'installed' | 'missing' | 'error';
      /** Installed version ("2.1.3"); null: unknown. */
      version?: string | null;
      /** Where the binary is (or would be installed). */
      path?: string | null;
      /** Why it is missing / could not be checked, or a note on its state ("server running"). */
      message?: string | null;
      /** The install / update running or last run. */
      job?: { kind: string; running: boolean; ok?: boolean | null; exitCode?: number | null; log?: string | null } | null;
      actions: { id: string; label: string; style?: 'primary' | 'danger' | 'default'; confirm?: string | null; disabled?: boolean; busy?: boolean }[];
      /** The refresh icon's settingAction id (check the CLI again); null: no icon. */
      refreshId?: string | null;
      /** How it is installed / updated (small text at the bottom). */
      note?: string | null;
    }
  /** Opens a sub-page (the view sends requestSettings {page: id}). */
  | { kind: 'page'; id: string; label: string; description?: string | null; icon?: string | null; badge?: string | null }
  /** Usage meters (account quota). */
  | { kind: 'quota'; id: string; label: string; groups: ModelGroupView[] }
  /**
   * The app's ModelsCard: providers with their models, each provider a collapsible row (switch + "3 of 12 models on");
   * opened: All on / All off, a search when it has many, a switch per model. Changes: settingChange {id, rowId:
   * 'provider:<group id>' | 'model:<model id>', value: boolean}; All on / off: settingAction {id, rowId: group id,
   * actionId: 'allOn' | 'allOff'}.
   */
  | {
      kind: 'modelGroups';
      id: string;
      label: string;
      description?: string | null;
      emptyText?: string | null;
      /** Accent token or hex for the switches ('opencode'). */
      accent?: string | null;
      groups: { id: string; name: string; on: boolean; models: { id: string; name: string; detail?: string | null; on: boolean }[] }[];
    }
  /**
   * The app's MCP preset tiles (Custom Plugin MCP, Plugin Developer, Browser, Notes & To-dos, Jarvis, Theme, Stitch,
   * Google Flow, Custom server…): a grid of cards; a tap sends settingAction {id: item.id, actionId: tile.id, values?}
   * after the tile's form (e.g. Stitch API key) when it has one. `added` shows the app's "Added" state.
   */
  | {
      kind: 'presets';
      id: string;
      label: string;
      description?: string | null;
      tiles: {
        id: string;
        name: string;
        subtitle: string;
        /** Material icon name (extension, developer_mode, language, edit_note, record_voice_over, palette, add…). */
        icon: string;
        /** Accent token or hex ('primary', 'info', 'warning', '#D97757'…). */
        accent?: string | null;
        added?: boolean;
        disabled?: boolean;
        form?: SettingFormField[] | null;
      }[];
    };

export interface SettingsSection {
  id: string;
  title: string;
  description?: string | null;
  /** Agent the section belongs to (tints its header with the agent accent). */
  agent?: AgentKind | null;
  items: SettingItem[];
}

export interface SettingsPage {
  /** 'root' = the main settings screen; other ids come from `page` items. */
  id: string;
  title: string;
  sections: SettingsSection[];
  /** The host is loading this page's data (show a spinner on the header). */
  loading?: boolean;
  /** The page could not be built (agent offline, CLI missing…): show this with a Retry (re-sends requestSettings). */
  error?: string | null;
}

/** View preferences shared by every view (sidebar + editor tabs), kept by the host. */
export interface UiPrefs {
  /** Theme id ('auto' = follow VS Code light/dark). */
  theme: string;
  /** Other view preferences the UI keeps (font scale, compact tool rows…). */
  [key: string]: unknown;
}

/** A folder a chat can work in (the project picker; mirrors the app's ProjectPickerDialog). */
export interface ProjectView {
  name: string;
  /** file:// URI (what `send.workspaceUri` takes). */
  uri: string;
  path: string;
  /** 'workspace' = open in this VS Code window, 'saved' = the bridge's project list, 'recent' = used by a chat. */
  source: 'workspace' | 'saved' | 'recent';
  /** Last chat activity in this folder (ms), when known. */
  lastUsed?: number | null;
  /** Number of chats that ran in this folder. */
  chats?: number | null;
}

/** A note or to-do list (the Notes screen; same shape notes_mcp stores). */
export interface NoteView {
  id: string;
  kind: 'note' | 'todo';
  title: string;
  text: string;
  items: { id: string; text: string; done: boolean }[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

// ------------------------------------------------------------------------------------------------ Jarvis
// The command center (port of the app's data/jarvis/* minus voice). Every Jarvis chat is a normal chat of an agent
// ("manager", keyed by its chat id) that plans, hands tasks to other chats and gets their news back. The host owns
// the whole state and pushes it as `jarvis` messages; the view only draws it and sends `jarvisAction`s.
// See docs/JARVIS.md for the exact shapes and which Kotlin UI files to port.

export type JarvisTaskState = 'starting' | 'running' | 'waiting_approval' | 'asking' | 'no_progress' | 'done' | 'failed' | 'stopped';

export interface JarvisStepView {
  n: number;
  text: string;
  status: 'todo' | 'doing' | 'done' | 'blocked';
  note: string;
}

export interface JarvisMissionView {
  goal: string;
  doneWhen: string;
  steps: JarvisStepView[];
  status: 'active' | 'done' | 'paused';
  autopilot: boolean;
  notes: string;
  /** Steps done (the strip's "3/7"). */
  doneCount: number;
  updatedAt: number;
}

export interface JarvisTeamView {
  name: string;
  agent: AgentKind;
  /** Model id ("" = the agent's default). */
  model: string;
  role: string;
  /** Project path ("" = the active project at the time). */
  project: string;
  /** Its tasks working right now. */
  runningTasks: number;
}

export interface JarvisTaskView {
  /** The task's chat id (open it like any chat). */
  id: string;
  title: string;
  goal: string;
  agent: AgentKind;
  state: JarvisTaskState;
  /** "waiting for approval", "no progress"… */
  stateLabel: string;
  /** Still working (starting, running, waiting for approval, asking, no progress). */
  active: boolean;
  /** Waiting for a decision (approval or question): amber. */
  needsUser: boolean;
  /** The Jarvis chat (manager) that runs it. */
  owner: string;
  team: string;
  project: string;
  /** One line about the latest change ("Finished", "Waiting for an approval"). */
  note: string;
  createdAt: number;
  updatedAt: number;
  followUps: number;
}

export interface JarvisManagerView {
  /** The Jarvis chat's id (also its manager_id). */
  chatId: string;
  agent: AgentKind;
  /** The chat's title (from the chat list), when known. */
  title: string | null;
  /** null = no mission yet. */
  mission: JarvisMissionView | null;
  teams: JarvisTeamView[];
  /** What it says it is doing right now (jarvis_status, the tool it uses, a task's news); null = nothing. */
  status: string | null;
  /** thinking = its turn runs (the model writes), working = its turn runs a tool, idle = waiting for the user / news. */
  phase: 'thinking' | 'working' | 'idle';
  /** The last few status lines, newest last (the activity card). */
  steps: { text: string; at: number; done: boolean }[];
  /** Its tasks still working. */
  activeTasks: number;
  /** One of its tasks waits for a decision. */
  needsAttention: boolean;
  /** Its agent answered that it has no jarvis_mcp tools: show "Add the Jarvis MCP server" (Settings → Jarvis → Setup). */
  toolsMissing: boolean;
  /** News queued for it (delivered when its turn ends). */
  pendingEvents: number;
}

export interface JarvisNoticeView {
  id: string;
  text: string;
  level: 'info' | 'warning' | 'error';
  /** What tapping it does: 'setup' (Settings → Jarvis → Setup), 'settings' (Settings → Jarvis), 'chat' (open chatId). */
  action: 'setup' | 'settings' | 'chat' | null;
  chatId?: string | null;
  at: number;
}

export interface JarvisLogEntry {
  at: number;
  /** task (started / finished…), event (news delivered), approval, notice, mission, chat */
  kind: 'task' | 'event' | 'approval' | 'notice' | 'mission' | 'chat';
  text: string;
  chatId?: string | null;
  taskId?: string | null;
}

export interface JarvisState {
  /** Settings → Jarvis → Turn on Jarvis. Off: no Jarvis tab, no strip, the MCP answers "Jarvis is turned off". */
  enabled: boolean;
  /** Jarvis chats in All / the agent tabs too: none (only under Jarvis), text (the Jarvis chats you opened), all. */
  listMode: 'none' | 'text' | 'all';
  /** Agent / model of new Jarvis chats (null = the agent new chats use / its default model). */
  agent: AgentKind | null;
  modelId: string | null;
  /** Every Jarvis chat id (same as conversations with isJarvis). */
  chatIds: string[];
  managers: JarvisManagerView[];
  /** Newest first, at most 30. */
  tasks: JarvisTaskView[];
  /** Short-lived notices for the overlay (they expire by themselves; dismissNotice removes one). */
  notices: JarvisNoticeView[];
  /** What Jarvis did, newest last (at most 200 here; 500 are kept). */
  log: JarvisLogEntry[];
  timers: { id: number; label: string; endsAt: number }[];
  /** Some task is working. */
  anyActive: boolean;
}

/** What a Jarvis button asks for (`jarvisAction`). */
export type JarvisActionKind =
  /** Drawer's "New Jarvis chat" (agent: optional): the host answers with `jarvisNewChat`. */
  | 'newChat'
  /** taskId */
  | 'stopTask'
  | 'openTask'
  | 'dismissTask'
  | 'clearFinished'
  /** chatId (the manager) */
  | 'pauseMission'
  | 'resumeMission'
  | 'clearMission'
  /** chatId + on */
  | 'setAutopilot'
  /** chatId + teamName */
  | 'removeTeam'
  /** chatId: stop that Jarvis chat's turn and its tasks; no chatId: every Jarvis chat and task */
  | 'stopAll'
  /** noticeId */
  | 'dismissNotice'
  | 'clearLog'
  /** agent: register jarvis_mcp with that agent (Settings → Jarvis → Setup) */
  | 'setup'
  /** Open Settings → Jarvis (or settingsPage) in this view */
  | 'openSettings';

// ------------------------------------------------------------------------------------------------ STEM & diagrams
// Settings → STEM & diagrams (src/core/render, webview/src/components/Stem.tsx): chemistry in math, and ```smiles,
// ```functionplot, ```jsxgraph, ```matter, ```tikz blocks drawn in frames from the local preview server.

/** What chats render now. */
export interface RenderStateView {
  /** The render bundle is downloaded. */
  installed: boolean;
  /** The parts that render: switched on, and downloaded when they need the bundle (chem, smiles, functionplot, jsxgraph, matter, tikz). */
  active: string[];
}

// ------------------------------------------------------------------------------------------------ project checkpoints
// src/core/checkpoints (the app's ProjectCheckpoints.kt) and webview/src/components/Checkpoints.tsx: the bridge saves a
// hidden copy of the project right before each message (any agent); a message's restore point puts the files back.

/** A checkpoint (CheckpointSummary). kind 'pre-restore' = the copy made right before a restore (restoring it undoes it). */
export interface CheckpointView {
  id: string;
  time: number;
  kind: string;
  /** claude | agy | codex | opencode */
  agent?: string | null;
  title?: string | null;
  midTurn?: boolean;
  late?: boolean;
  repos?: number;
}

/** What a restore would do (CheckpointPreview); a restore's answer also has its errors and the undo checkpoint. */
export interface CheckpointPreviewView {
  checkpoint: CheckpointView;
  /** change: modified | deleted (made after the checkpoint: removed) | recreated (deleted after it: comes back) */
  files: { path: string; change: string; added: number; removed: number; binary?: boolean }[];
  modified: number;
  deleted: number;
  recreated: number;
  warnings: { kind: string; text: string }[];
  laterChats: { agent?: string | null; title?: string | null; time: number; turns: number }[];
  errors?: string[];
  undoId?: string | null;
  /** Other chats (any agent) still running in this project. */
  otherRunning?: number;
}

/** The ask-once question's project (CheckpointProjectState). */
export interface CheckpointProjectView {
  path: string;
  isGit: boolean;
  shouldAsk: boolean;
}

export type CheckpointRequest =
  /** The new chat's project: should it ask "Keep checkpoints for …?" */
  | { action: 'project'; project: string }
  | { action: 'decide'; project: string; decision: 'on' | 'off' }
  /** conversationId: the chat the sheet was opened from (not counted as another running chat). */
  | { action: 'preview'; project: string; id: string; conversationId?: string | null }
  | { action: 'restore'; project: string; id: string }
  /** Opens the file's change in a diff editor tab (now ↔ checkpoint). */
  | { action: 'diff'; project: string; id: string; file: string; change: string }
  | { action: 'delete'; project: string; id: string };

// ------------------------------------------------------------------------------------------------ Agent memory
// src/core/memory (the app's AgentMemory.kt / MemorySync.kt) and webview/src/components/MemoryChip.tsx: an
// ```antigem-memory block in a reply is drawn as a chip telling what the bridge did with it (with Undo).

/** What became of one memory block (the bridge's /api/memory/applied). */
export interface MemoryAppliedView {
  key: string;
  /** The bridge has seen the block (false: not synced yet). */
  found: boolean;
  /** saved | updated | deleted | error */
  action?: string;
  /** The memory file under the memory folder ("global/x.md", "projects/<dir>/x.md"). */
  id?: string;
  description?: string;
  error?: string;
  undone?: boolean;
  at?: number;
}

// ------------------------------------------------------------------------------------------------ Group chats

/**
 * Group chats (src/core/groups): the user and several AI bots in one room. Each bot is its own hidden chat on any
 * agent / model; the room only carries what they say (never their thinking or tool calls).
 */
/**
 * Who answers a message nobody @mentioned (Rooms v2, docs/crew/PLAN.md §7): auto = the best fit (local heuristic, then
 * the router model, else the lead), mentions = only who is @mentioned (others may chime in), lead = the lead,
 * everyone = every member, moderator = a model picks 0–2 speakers after every message.
 */
export type GroupMode = 'auto' | 'mentions' | 'lead' | 'everyone' | 'moderator';
/** What a bot may do in its own chat: just talk, also read the group's project, or also edit it. */
export type GroupBotAccess = 'chat' | 'read' | 'edit';

export interface GroupBotView {
  id: string;
  /** Unique in the group; others mention it as @name. */
  name: string;
  agent: AgentKind;
  /** null = the agent's default model. */
  modelId: string | null;
  /** Who the bot is and how it talks (sent to it once, with the room rules). */
  persona: string;
  /** Avatar: one emoji (or a letter) on [color]. */
  emoji: string;
  color: string;
  /** 0..100: how often it joins in when nobody mentioned it. */
  chattiness: number;
  access: GroupBotAccess;
  /** Reasoning effort of its chat ('default', 'low', 'medium', 'high'); used when its chat starts. */
  effort: string;
  /** On hold in this room: skipped; messages for it are kept until it is released. */
  muted: boolean;
  /** Its hidden chat (null until it first speaks). */
  chatId: string | null;
  /** Its crew role and the words auto routing matches on. */
  title: string;
  aliases: string[];
  /** Messages for it kept while it is on hold. */
  held: number;
  /** The voice its messages are read in (null = the default voice). */
  voice: string | null;
}

/** A bot replying right now: 'typing' (writing), 'working' (using a tool first) or 'waiting' (busy elsewhere first). */
export interface GroupTypingView {
  botId: string;
  activity: 'typing' | 'working' | 'waiting';
  /** What it does now ("editing api.ts", "finishing something in #Ops"), changes at most every few seconds. */
  step?: string | null;
}

export interface GroupView {
  id: string;
  title: string;
  /** What the group is about (every bot is told). */
  topic: string;
  /** What the bots call the user. */
  userName: string;
  bots: GroupBotView[];
  mode: GroupMode;
  /** The member who answers when nobody else is picked (lead mode; auto mode's fallback). */
  lead: string | null;
  /** 'turns' = one speaker at a time; 'parallel' = everyone picked drafts at once (posts land in order). */
  drafting: 'turns' | 'parallel';
  /** Turns each member gets per round (1–5; the last one is told to wrap up). */
  turnsPerMember: number;
  /** Auto / moderator mode: the agent / model that picks who speaks (null = the lead's agent, its cheapest model). */
  moderatorAgent: AgentKind | null;
  moderatorModelId: string | null;
  /** Your messages sent while a bot speaks: they wait here and go as one turn when it is done. */
  queue: { id: string; text: string }[];
  /** The goal the lead drives (status: running | completed | needs-input | blocked | stopped). */
  goal: { text: string; status: string; turns: number; maxTurns: number; note: string } | null;
  /** Crew bots that are not members (to add). */
  others: { id: string; name: string; emoji: string; color: string; title: string; agent: AgentKind }[];
  /** Bot messages in a row (no user message in between) before the bots wait for the user. */
  maxBotTurns: number;
  /** Bots start talking by themselves when the room is quiet for [idleSeconds]. */
  autoTalk: boolean;
  idleSeconds: number;
  /** Folder bots with read / edit access work in (null = a private empty folder). */
  project: string | null;
  paused: boolean;
  /** The bots stopped after maxBotTurns and wait for the user (or Continue). */
  waiting: boolean;
  typing: GroupTypingView[];
  /** One line about what happens now ("Moderator is choosing…"), or null. */
  status: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GroupMessageView {
  id: string;
  /** 'user', a bot id, 'system' (room news the bots are told: joins, topic) or 'notice' (for the user only). */
  from: string;
  /** The sender's name when it was sent (a removed bot keeps its name). */
  name: string;
  /** Markdown: code blocks, images (![](path or https)), diagrams… */
  text: string;
  at: number;
  attachments: ChatAttachment[];
  /** The message it answers (the user replied to a bot). */
  replyTo?: string | null;
  /** Why this bot spoke: 'reply' | 'mention' | 'everyone' | 'lead' | 'auto' | 'router' | 'moderator' | 'chime' | 'held' | 'nudge'. */
  picked?: { by: string; why?: string } | null;
  /** One line of what the bot did before answering ("ran 3 commands, edited api.ts"). */
  digest?: string | null;
  /** The facts behind the digest (commands with exit codes, files changed, failures). */
  evidence?: string[] | null;
  /** Tokens of the bot's turn. */
  usage?: { input: number; output: number; cached: number; costUsd: number | null } | null;
}

export interface GroupSummaryView {
  id: string;
  title: string;
  topic: string;
  bots: { name: string; emoji: string; color: string; agent: AgentKind }[];
  lastText: string;
  lastName: string;
  messageCount: number;
  updatedAt: number;
  active: boolean;
}

export type GroupActionKind =
  /** data: {title, topic?, template?} → the new group opens. */
  | 'create'
  /** data: any of title, topic, userName, mode, lead, drafting, turnsPerMember, moderatorAgent, moderatorModelId, maxBotTurns, autoTalk, idleSeconds. */
  | 'update'
  | 'delete'
  /** data: the bot's fields (name required). */
  | 'addBot'
  /** botId + data: changed fields. */
  | 'updateBot'
  | 'removeBot'
  | 'pause'
  | 'resume'
  /** The bots stopped after maxBotTurns: let them go on. */
  | 'continue'
  /** Delete every message and start each bot's memory again. */
  | 'clear'
  /** Show a bot's hidden chat (its tool calls, thinking) in the chat view. */
  | 'openBotChat'
  /** Make the bot speak now. */
  | 'nudgeBot'
  /** Open a new chat with a request to design a group with groups_mcp (data: {agent?, idea?}). */
  | 'setupWithAI'
  /** Pick the project folder for bots with read / edit access (data: {clear?: true}). */
  | 'pickProject'
  /** botId: add an existing crew bot to the room. */
  | 'addMember'
  /** botId: put a member on hold / release it (its kept messages are answered then). */
  | 'hold'
  | 'release'
  /** data: {id}: drop a queued message of yours before it is sent. */
  | 'unqueue'
  /** data: {text, maxTurns?} starts a goal the lead drives; {stop: true} stops it; {continue: true} gives it more turns. */
  | 'goal';

// ------------------------------------------------------------------------------------------------ Crew

/** Crew (src/core/crew, docs/crew/PLAN.md): a bot's profile as the Crew screen shows and edits it. */
export interface CrewBotView {
  id: string;
  /** One word, @-mentionable, unique in the crew. */
  name: string;
  title: string;
  description: string;
  emoji: string;
  color: string;
  agent: AgentKind;
  /** null = the agent's default model. */
  modelId: string | null;
  effort: string;
  /** talk | read | edit | auto | full */
  access: string;
  accessCeiling: string;
  /** The level it runs at now (raised by the whole-crew switch, capped by the ceiling). */
  effectiveAccess: string;
  /** Folder it works in at edit and up (null = the open project). */
  folder: string | null;
  chattiness: number;
  paused: boolean;
  /** SOUL.md: who it is and how it works (its persona and standing instructions). */
  soul: string;
  soulPath: string;
  /** What its engine cannot enforce at its level (null = all of it is). */
  softNote: string | null;
  /** Words that send a room message to it in auto mode (typed, or learned when the user re-asked it). */
  aliases: string[];
  /** Where it is answering now ("#Ops", "its DM"), null = free. */
  busyWhere: string | null;
  /** What you chose to "always allow" for it ("Bash(git push)", "mcp__github__create_issue"). */
  rules: string[];
  /** Its memory: on, capture on (a quick model files new facts), its notes (newest first), its last change (Undo). */
  memory: { enabled: boolean; capture: boolean; notes: { id: string; text: string; where: string; from: string | null; date: string | null }[]; file: string; undo: { id: string; what: string } | null };
  /** Its standing goal (null = none): turns used / allowed, paused, waiting until. */
  goal: { jobId: string; text: string; status: string; turns: number; maxTurns: number; paused: boolean; nextAt: number | null } | null;
  /** Check before done: null = off, 'auto' = a quick model of another engine, else the checking bot's id. */
  checkWork: string | null;
  /** It has its own browser (AntiGem's Browser MCP; Claude Code and Codex). */
  browser: boolean;
  /** The voice its room messages are read in (null = the default voice). */
  voice: string | null;
  /** What it spent today (null = nothing yet). */
  today: SpendView | null;
  /** Its DM chat (null = none yet). */
  dmChatId: string | null;
  /** Rooms it is in. */
  rooms: { id: string; name: string }[];
  /** It is answering somewhere now. */
  working: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CrewStateView {
  bots: CrewBotView[];
  /** The whole-crew access switch (null = each bot's own level). */
  crewAccess: string | null;
  /** The folder the crew lives in (~/.antigem/crew). */
  root: string;
  /** What each engine cannot enforce at each level (agent → access → note), for the editor while choosing. */
  softNotes: Partial<Record<AgentKind, Partial<Record<string, string>>>>;
  /** Jobs now (the Crew home's Mission Control row). */
  jobs: JobCountsView;
  /** Everyone is paused (no room turns, no jobs). */
  paused: boolean;
  /** Antigravity's crew server: 'ask' (not decided), 'allowed', 'declined'. */
  agyCrewServer: string;
  /** The Chief (null = none). */
  chiefId: string | null;
  /** The Chief's recent changes (newest first), each undoable once. */
  changes: { id: string; at: number; summary: string; undone: boolean }[];
  /** The Chief's Problems thread has a chat to open. */
  hasProblems: boolean;
  /** What every bot knows about you (by: 'you' or the bot that added it). */
  aboutMe: { id: string; text: string; by: string }[];
  /** Today's spend, the daily budget (null = none) and why new work waits (null = it does not). */
  usage: { today: SpendView; caps: { dayTokens: number | null; dayUsd: number | null }; over: string | null };
  /** The getting-started guide was closed. */
  tourDone: boolean;
}

/** Tokens (read + written), dollars (when the engine reports a cost) and turns. */
export interface SpendView {
  tokens: number;
  usd: number;
  turns: number;
}

// ------------------------------------------------------------------------------------------------ Crew packages

/** What importing a crew package would make (the review screen). */
export interface ImportPreviewView {
  name: string;
  tagline: string;
  /** antigem | botmrr | openmaus-json */
  format: string;
  /** Where it came from (a URL, the library, pasted text). */
  from: string;
  bots: { name: string; from: string; title: string; emoji: string; color: string; access: string; engine: string | null }[];
  rooms: { name: string; members: string[] }[];
  chief: string | null;
  /** MCP servers it needs (you add them yourself). */
  mcp: { name: string; reason: string }[];
  /** They arrive paused. */
  automations: { name: string; bot: string; when: string }[];
  playbooks: number;
  /** Secrets taken out. */
  redacted: number;
  leftOut: string[];
  warnings: string[];
}

// ------------------------------------------------------------------------------------------------ Automations

/** An automation (docs/crew/PLAN.md §13) as its row on the Automations page shows it. */
export interface AutomationView {
  id: string;
  name: string;
  /** "Every weekday at 09:00, Scout: summarize yesterday's commits → #Ops" */
  sentence: string;
  bot: { id: string; name: string; emoji: string; color: string } | null;
  paused: boolean;
  /** A one-shot that ran (or a wait that expired). */
  done: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  /** ok | nothing | failed | needs-input | skipped */
  lastStatus: string | null;
  lastResult: string | null;
  /** "Needs you: …" */
  needsFix: string | null;
  skipped: number;
  /** Webhook automations: where to POST, with "Authorization: Bearer <token>". */
  webhook: { url: string; token: string } | null;
  runs: { at: number; status: string; trigger: string; result: string }[];
  /** Its last change can be undone. */
  canUndo: boolean;
  /** Its own hidden chat can be opened. */
  canOpen: boolean;
  createdBy: string;
}

// ------------------------------------------------------------------------------------------------ Inbox

/** One thing a crew bot needs from you (docs/crew/PLAN.md §11). */
export interface InboxItemView {
  id: string;
  /** approval | setup (Antigravity's crew server) | question (a job's NEEDS INPUT) | failed (a job that failed) */
  kind: string;
  bot: { id: string; name: string; emoji: string; color: string } | null;
  /** What it wants ("run the command: git push"). */
  title: string;
  /** Where and why it asks ("for Lead's job: deploy · it reaches outside"). */
  why: string;
  /** The command / diff / question text. */
  detail: string | null;
  /** It sends something out of the machine (asked at every level). */
  outward: boolean;
  /** READ | NORMAL | RISKY | OUTWARD */
  risk: string | null;
  /** What "Always allow" remembers. */
  key: string | null;
  /** Buttons: allow | allow_session | allow_always | deny | add | later | answer | retry | dismiss. */
  choices: string[];
  /** Its chat can be opened. */
  canOpen: boolean;
  jobId: string | null;
  /** A DM's request: its card is in the chat too. */
  inChat: boolean;
  createdAt: number;
}

export interface CrewStatusView {
  /** Bots answering somewhere now. */
  working: number;
  /** Inbox items. */
  needsYou: number;
  /** Everyone paused. */
  paused: boolean;
}

// ------------------------------------------------------------------------------------------------ Mission Control

export interface JobCountsView {
  /** Jobs running or queued. */
  working: number;
  /** Requesters waiting for their teammates. */
  waiting: number;
  /** Jobs with a question nobody answered yet. */
  needsYou: number;
  /** Trees started in the last day. */
  today: number;
}

/** One job (docs/crew/PLAN.md §8) as Mission Control draws it. */
export interface JobView {
  id: string;
  rootId: string;
  parentId: string | null;
  depth: number;
  title: string;
  brief: string;
  /** queued | running | needs_input | waiting | resume | done | failed | cancelled */
  status: string;
  outcome: string | null;
  /** Who does it. */
  bot: { id: string; name: string; emoji: string; color: string } | null;
  /** Who asked (null = you). */
  requester: { name: string; emoji: string; color: string } | null;
  /** work | consult | notify */
  mode: string;
  level: string;
  doneWhen: string | null;
  question: string | null;
  answer: string | null;
  /** Its final words (≤ 2000 characters here). */
  result: string | null;
  /** One line of what it did (from its tool calls) and the facts behind it. */
  digest: string | null;
  evidence: string[];
  artifacts: { kind: string; title: string; path?: string; url?: string; text?: string }[];
  usage: { input: number; output: number; cached: number; costUsd: number | null };
  /** An acknowledgement only (did not wake its requester). */
  ack: boolean;
  /** Its thread can be opened. */
  canOpen: boolean;
  /** A bot goal: turns used / allowed, paused, waiting until. */
  goal: { turns: number; maxTurns: number; paused: boolean; nextAt: number | null } | null;
  /** Check before done: who checked, checking | pass | issues | cannot, what it found, which round (≤ 3). */
  check: { by: string; verdict: string; note: string; round: number } | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  updatedAt: number;
}

export interface JobTreeView {
  root: JobView;
  /** Every job under the root (the root not included), parents before children. */
  jobs: JobView[];
  /** Where it started: your message to a bot (person), a room turn (room). */
  origin: { kind: string; quote: string; roomId: string | null; roomName: string | null };
  budget: { requests: number; runs: number; wakes: number; failuresInRow: number; limits: { requests: number; runs: number; wakes: number; failuresInRow: number } };
}

export interface JobsStateView {
  trees: JobTreeView[];
  counts: JobCountsView;
}

export type CrewActionKind =
  /** data: the bot's fields (name required) → the editor shows the new bot. */
  | 'createBot'
  /** botId + data: changed fields (soul included). */
  | 'updateBot'
  | 'deleteBot'
  /** Open the bot's SOUL.md in an editor tab. */
  | 'openSoul'
  /** Open (or start) the bot's DM in the chat view. */
  | 'openDm'
  /** botId: pick its work folder (data: {clear?: true}). */
  | 'pickFolder'
  /** data: {access: string | null}: the whole-crew switch. */
  | 'setCrewAccess'
  /** data: {paused: boolean}: pause / resume everyone. */
  | 'setPaused'
  /** data: {allow: boolean}: add AntiGem's crew server to Antigravity's MCP servers (or not now). */
  | 'allowAgyServer'
  /** botId + data: {key}: stop always allowing this. */
  | 'forgetRule'
  /** botId (null = none): make it the Chief. */
  | 'setChief'
  /** data: {id}: undo one of the Chief's changes. */
  | 'undoManage'
  /** Open the Chief's Problems thread. */
  | 'openProblems'
  /** botId + data: {text, maxTurns?}: a standing goal for the bot; {stop: true} stops it. */
  | 'goal'
  /** botId + data: {id}: forget one of its notes. */
  | 'forgetMemory'
  /** botId + data: {id}: undo its last memory change. */
  | 'undoMemory'
  /** botId: open its MEMORY.md in an editor tab. */
  | 'openMemory'
  /** data: {text}: add a line about you; {remove: id}: remove one. */
  | 'aboutMe'
  /** data: {text?, url?, library?}: what importing that crew would make (answer: crewImport {preview | error}). */
  | 'importPreview'
  /** Same data: add it (answer: a toast; the Crew screen follows). */
  | 'importApply'
  /** The library of ready-made crews (answer: crewImport {library}). */
  | 'library'
  /** data: {botIds?, name?}: save the crew (or some bots) as one Crew package file. */
  | 'export'
  /** data: {dayTokens, dayUsd} (0 / empty = no limit): the crew's daily budget. */
  | 'setCaps'
  /** data: {done: boolean}: close (or bring back) the getting-started guide. */
  | 'tourDone';

export type HostToView =
  | {
      type: 'init';
      viewKind: 'sidebar' | 'panel' | 'browser';
      workspaceFolders: WorkspaceFolder[];
      /** Conversation this view opens with (editor panels); null = last / new chat. */
      conversationId: string | null;
      defaultAgent: AgentKind;
      /** No agents chosen yet: show the app's first-run agent picker (it sends settingChange agents.enabled). */
      firstRun?: boolean;
    }
  | { type: 'agents'; agents: AgentStatus[] }
  | { type: 'conversations'; conversations: Conversation[] }
  | { type: 'chat'; conversationId: string | null; patch: ChatPatch }
  | { type: 'models'; state: ModelsState }
  | { type: 'toast'; level: 'info' | 'warning' | 'error'; message: string }
  | { type: 'insertText'; text: string }
  | { type: 'attachments'; reqId: string; attachments: ChatAttachment[] }
  | { type: 'fileSearchResult'; reqId: string; files: FileSuggestion[] }
  /** Optional: the `/` commands of an agent (sent on `requestCommands`, or whenever they change). */
  | { type: 'commands'; agent: AgentKind; commands: SlashCommandView[] }
  /** A settings page (answer to requestSettings, and again whenever its values change while open). */
  | { type: 'settings'; page: SettingsPage }
  /** A settingAction / settingChange finished (buttons show "Working…" until then). */
  | { type: 'settingDone'; page: string; id: string; rowId?: string | null; actionId?: string | null; ok: boolean; error?: string | null }
  /** Shared view preferences (theme…), on init and whenever they change. */
  | { type: 'uiPrefs'; prefs: UiPrefs }
  /** Answer to requestProjects. */
  | { type: 'projects'; reqId: string; projects: ProjectView[] }
  /** Answer to pickFolder (null = cancelled). The folder is also saved to the project list. */
  | { type: 'folderPicked'; reqId: string; project: ProjectView | null }
  /** The editor's active file / selection changed (null = no text editor). */
  | { type: 'editorContext'; context: EditorContextView | null }
  /** Add these chips to the composer (VS Code commands: add file, add selection, explorer…). */
  | { type: 'addAttachments'; attachments: ChatAttachment[] }
  /** Answer to readImage (a data: URL, or null when unreadable / too big). */
  | { type: 'imageData'; reqId: string; dataUrl: string | null }
  /** Answer to mediaUrl (null with an error when it cannot be served). */
  | { type: 'mediaUrl'; reqId: string; url: string | null; error?: string | null }
  /** Answer to searchChats. */
  | { type: 'chatSearchResult'; reqId: string; results: ChatSearchHit[] }
  /** Put the cursor in the composer (keyboard shortcut). */
  | { type: 'focusComposer' }
  /** Every note (answer to requestNotes, and again after any change — also when an agent edits them via notes_mcp). */
  | { type: 'notes'; notes: NoteView[] }
  // ---- Skills (src/core/skills)
  /** Settings → "Set up with AI": close the settings and open a new chat of `agent` with `text` in its message box. */
  | { type: 'startChat'; agent: AgentKind; text: string }
  // ---- STEM & diagrams (src/core/render) and pages the view draws from the host's Markdown
  /** What chats render (answer to requestRender, and to every view whenever it changes). */
  | { type: 'renderState'; state: RenderStateView }
  /** Answer to stemPage / stemSvg: the block's page (null with an error). TikZ: the compiled picture or the TeX run. */
  | { type: 'stemPage'; reqId: string; url: string | null; tikz?: 'svg' | 'compile' | null; error?: string | null }
  /** Answer to requestDoc: a guide as Markdown (null = unknown id). */
  | { type: 'doc'; id: string; markdown: string | null }
  // ---- Project checkpoints (src/core/checkpoints)
  /** The open chat's restore points: user message id → its checkpoint (empty while checkpoints are off). */
  | { type: 'checkpoints'; conversationId: string; project: string | null; byMessage: Record<string, CheckpointView> }
  /** Answer to a `checkpoint` request (error = it failed). */
  | { type: 'checkpointReply'; reqId: string; error?: string | null; preview?: CheckpointPreviewView | null; project?: CheckpointProjectView | null }
  /** Settings → Project checkpoints: open a checkpoint's restore sheet (files only; `deletable` = with Delete). */
  | { type: 'checkpointOpen'; project: string; checkpoint: CheckpointView; deletable?: boolean }
  /** Settings → Project checkpoints → a project's History: push that settings page. */
  | { type: 'checkpointHistory'; page: string; title: string; subtitle?: string | null }
  // ---- Agent memory (src/core/memory)
  /** Answer to memoryRequest; `enabled` = Agent memory is on (off: the chip says it was not saved). */
  | { type: 'memoryResult'; reqId: string; applied: MemoryAppliedView | null; enabled: boolean; error?: string | null }
  /** Memories changed (a reply saved one, an Undo, the settings), or memory was switched on / off: chips ask again. */
  | { type: 'memoryChanged'; enabled: boolean }
  // ---- Jarvis
  /** Jarvis state: `full` = the whole state (on init / requestJarvis); otherwise only the fields that changed. */
  | { type: 'jarvis'; state: Partial<JarvisState>; full?: boolean }
  /**
   * Answer to jarvisAction newChat: show an empty new chat of `agent` (preselect `modelId` for it when not null) marked
   * as a Jarvis chat (JarvisChatWelcome + strip); its first `send` carries `jarvis: true`.
   */
  | { type: 'jarvisNewChat'; agent: AgentKind; modelId: string | null }
  /** Jarvis (a tool, a notice) wants this view to show a screen: a chat, the notes, or a settings page. */
  | { type: 'jarvisNavigate'; screen: 'chat' | 'notes' | 'settings'; conversationId?: string | null; settingsPage?: string | null }
  // ---- Group chats (src/core/groups)
  /** Every group (answer to groupWatch, and again whenever the list changes while the Group chats screen is open). */
  | { type: 'groupList'; groups: GroupSummaryView[] }
  /** The watched group's settings, bots and who is typing (null = it was deleted). */
  | { type: 'groupState'; groupId: string; group: GroupView | null }
  /** The watched group's messages: `full` = all of them, otherwise new / changed ones to add. */
  | { type: 'groupMessages'; groupId: string; messages: GroupMessageView[]; full: boolean }
  /** Open the Group chats screen at this group (null = the list): a tool or a new group asks for it. */
  | { type: 'groupNavigate'; groupId: string | null }
  // ---- Crew (src/core/crew)
  /** The bots and crew settings (answer to crewWatch, and again on every change while the Crew screen is open). */
  | { type: 'crewState'; crew: CrewStateView }
  /** Open the Crew screen (at a bot's editor, or the list). */
  | { type: 'crewNavigate'; botId: string | null }
  /** Mission Control's job trees (answer to jobsWatch, again on every change while it is open). */
  | { type: 'jobsState'; jobs: JobsStateView }
  /** Import: the library, a preview of what a package would make, or why it could not be read. */
  | { type: 'crewImport'; library?: { id: string; name: string; tagline: string; emojis: string }[]; preview?: ImportPreviewView | null; error?: string | null }
  /** The Inbox and the crew's status (answer to inboxWatch, again on every change). */
  | { type: 'crewInbox'; items: InboxItemView[]; status: CrewStatusView }
  /** The Automations page (answer to automationsWatch, again on every change while it is open). */
  | { type: 'automationsState'; automations: AutomationView[] }
  /** Start a new DM chat with a bot: an empty chat of its agent, drawn with its face; its first message is its DM. */
  | { type: 'crewDm'; agent: AgentKind; tag: CrewChatTag; modelId: string | null }
  // ---- chip details
  /** Answer to setControl {value: 'details'} when the agent describes the chip (see ChipDetailsView). */
  | { type: 'chipDetails'; details: ChipDetailsView };

export type ConversationAction = 'delete' | 'fork' | 'rename' | 'archive' | 'unarchive' | 'copyId' | 'openInEditor';

export type ViewToHost =
  | { type: 'ready' }
  /** This view now shows conversation `id` (null = an empty new-chat screen for `agent`). */
  | { type: 'openConversation'; id: string | null; agent?: AgentKind }
  | {
      type: 'send';
      /** Generated by the view for a new chat (a UUID). */
      conversationId: string;
      isNew: boolean;
      agent: AgentKind;
      text: string;
      attachments: ChatAttachment[];
      modelId: string | null;
      workspaceUri: string | null;
      /** Jarvis: a new chat opened with "New Jarvis chat" (jarvisNewChat): it becomes a Jarvis chat. */
      jarvis?: boolean;
      /** Crew: the first message of a bot's DM (the crew thread it starts). */
      crewThread?: string | null;
    }
  | { type: 'stop'; conversationId: string }
  | { type: 'approval'; conversationId: string; key: string; choiceId?: string; deny?: boolean; feedback?: string }
  | {
      type: 'answer';
      conversationId: string;
      key: string;
      /** question id → picked option ids */
      answers: Record<string, string[]>;
      note?: string;
      skip?: boolean;
      /** Optional: question id → typed "Other…" answer. */
      custom?: Record<string, string>;
      /** Optional: the question was dismissed (✕), not skipped. */
      cancel?: boolean;
    }
  | { type: 'selectModel'; agent: AgentKind; conversationId: string | null; modelId: string }
  | { type: 'requestModels'; agent: AgentKind }
  | { type: 'conversationAction'; id: string; action: ConversationAction; value?: string }
  | { type: 'queueAction'; conversationId: string; id: string; action: 'sendNow' | 'delete' }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'openUrl'; url: string }
  | { type: 'pickAttachments'; reqId: string }
  | { type: 'searchFiles'; reqId: string; query: string }
  | { type: 'copy'; text: string }
  | { type: 'retryConnections' }
  /** Kill the bridge (its agents and the agy hub) and start it again; the host asks first. */
  | { type: 'restartBridge' }
  /** Optional: ask for the agent's `/` commands (answered with `commands`). */
  | { type: 'requestCommands'; agent: AgentKind }
  /** Optional: regenerate this assistant reply (footer ↻). */
  | { type: 'retry'; conversationId: string; messageId: string }
  /** Optional: undo this prompt and everything after it; the host answers with `insertText` of the prompt (bubble ✎). */
  | { type: 'rewind'; conversationId: string; messageId: string; /** Also restore files the agent changed since (Claude checkpoints, OpenCode revert). */ restoreFiles?: boolean }
  /** Open / refresh a settings page ('root' = main screen). */
  | { type: 'requestSettings'; page: string }
  /** The settings screen was closed (the host stops pushing updates). */
  | { type: 'closeSettings' }
  | { type: 'settingChange'; page: string; id: string; value: unknown; rowId?: string }
  | { type: 'settingAction'; page: string; id: string; rowId?: string; actionId?: string; values?: Record<string, string> }
  /** Save a shared view preference (theme…); the host broadcasts uiPrefs to every view. */
  | { type: 'setUiPref'; key: string; value: unknown }
  /** Folders a new chat can use (answered with `projects`). */
  | { type: 'requestProjects'; reqId: string }
  /** "Browse…": pick a folder with the system dialog (answered with `folderPicked`). */
  | { type: 'pickFolder'; reqId: string }
  /** Remove a folder from the saved project list. */
  | { type: 'forgetProject'; path: string }
  /** Optional: an artifact card's download button: save a copy of the file (e.g. a "Save As" dialog). */
  | { type: 'saveArtifact'; path: string }
  /** Save a file from the web (a video in the chat) with a save dialog; the host downloads it. */
  | { type: 'downloadUrl'; url: string; name: string }
  /** Open the Notes screen: the host answers with `notes` and keeps sending them while it is open. */
  | { type: 'requestNotes' }
  /** Notes screen edits: create (note fields), update (whole note), delete (id), restore (undo a delete). */
  | { type: 'notesAction'; action: 'create' | 'update' | 'delete' | 'restore'; note: Partial<NoteView> & { id?: string } }
  /** Drawer ⏻: stop the bridge and every agent (the app's exit). Reconnect / retryConnections starts them again. */
  | { type: 'powerOff' }
  /** A controls-strip chip changed (conversationId null = defaults for the next new chat). */
  | { type: 'setControl'; agent: AgentKind; conversationId: string | null; id: string; value: string }
  /** Show a local image (artifact / attachment thumbnail): answered with imageData. */
  | { type: 'readImage'; reqId: string; path: string }
  /**
   * An address the chat can frame or play (the local preview server): an Interactive App's HTML (`html`), an app's
   * .html file on disk (`htmlFile`), a local video / audio file (`file`), a player page for one (`player`: what a VS
   * Code webview can play) or a YouTube video id (`youtube`). Answered
   * with mediaUrl.
   */
  | { type: 'mediaUrl'; reqId: string; kind: 'html' | 'htmlFile' | 'file' | 'player' | 'youtube'; value: string; start?: number }
  /** Files / folders dropped on the view (VS Code explorer or OS): answered with `attachments {reqId}`. */
  | { type: 'resolveDrop'; reqId: string; uris: string[] }
  /** Search the content of chats (drawer deep search): answered with chatSearchResult. */
  | { type: 'searchChats'; reqId: string; query: string }
  /** Save text the view produced (chat export as Markdown / HTML…) with a save dialog. */
  | { type: 'saveFile'; suggestedName: string; content: string }
  /** Run a code block's command in a VS Code terminal. */
  | { type: 'runInTerminal'; command: string; cwd?: string | null }
  /** Open a diff / text in a VS Code editor tab (tool-card diffs, long outputs). */
  | { type: 'openText'; title: string; content: string; language?: string | null }
  /** Open a file at a line range in the editor and select it (selection chips). */
  | { type: 'revealRange'; path: string; startLine: number; endLine: number }
  /** An action on a tool card ("terminate" a running command, …). */
  | { type: 'toolAction'; conversationId: string; toolId: string; action: 'terminate' | string }
  /** Model sheet edit mode: move a model (by its group key) to another quota group (null = automatic). */
  | { type: 'setQuotaGroup'; agent: AgentKind; modelId: string; group: string | null }
  // ---- Skills (src/core/skills)
  /** The `/` menu opened (at most every 10 s per agent): the agent reads its commands and skills again for the folder
   *  of the chat this view shows (answered with `commands` when they changed). */
  | { type: 'slashMenuOpened'; agent: AgentKind }
  // ---- STEM & diagrams (src/core/render) and pages the view draws from the host's Markdown
  /** What chats render (answered with renderState). */
  | { type: 'requestRender' }
  /**
   * The page of a STEM block (`kind` = smiles, functionplot, jsxgraph, matter or tikz; `fg` = the chat's text color):
   * answered with stemPage. TikZ: the cached picture when there is one, else the TeX run.
   */
  | { type: 'stemPage'; reqId: string; kind: string; code: string; dark: boolean; fg?: string | null; full?: boolean }
  /** A TikZ picture the TeX run finished: the host caches the SVG and answers stemPage with the picture's page. */
  | { type: 'stemSvg'; reqId: string; kind: string; code: string; svg: string; dark: boolean; fg?: string | null }
  /** A guide the settings show ('stem-guide', 'egm-guide'): answered with doc. */
  | { type: 'requestDoc'; id: string }
  // ---- Project checkpoints (src/core/checkpoints): answered with checkpointReply
  | { type: 'checkpoint'; reqId: string; request: CheckpointRequest }
  // ---- Agent memory (src/core/memory): answered with memoryResult
  /** A memory chip: what became of its block (`body` = the block's text), or Undo of what it did. */
  | { type: 'memoryRequest'; reqId: string; op: 'applied' | 'undo'; body: string }
  // ---- Group chats (src/core/groups)
  /**
   * The Group chats screen shows the list (groupId null) or a group; `open: false` = the screen closed (the host
   * stops sending). Answered with groupList (+ groupState and groupMessages {full} for a group).
   */
  | { type: 'groupWatch'; groupId: string | null; open: boolean }
  /** A Group chats button; see GroupActionKind for the fields. */
  | { type: 'groupAction'; action: GroupActionKind; groupId?: string | null; botId?: string | null; data?: Record<string, unknown> | null }
  /** The user's message to a group. */
  | { type: 'groupSend'; groupId: string; text: string; attachments: ChatAttachment[]; replyTo?: string | null }
  // ---- Crew (src/core/crew)
  /** The Crew screen opened / closed (the host sends crewState while it is open). */
  | { type: 'crewWatch'; open: boolean }
  | { type: 'crewAction'; action: CrewActionKind; botId?: string | null; data?: Record<string, unknown> | null }
  /** Mission Control opened / closed (the host sends jobsState while it is open). */
  | { type: 'jobsWatch'; open: boolean }
  /** The Automations page opened / closed. */
  | { type: 'automationsWatch'; open: boolean }
  /** pause / resume / runNow / delete / undo / open (its chat) an automation; new (data: {botId, text}: the bot sets it up in its DM). */
  | { type: 'automationAction'; action: 'pause' | 'resume' | 'runNow' | 'delete' | 'undo' | 'open' | 'new'; id?: string | null; data?: Record<string, unknown> | null }
  /** The view wants the Inbox (sent once when it starts; the host then sends crewInbox on every change). */
  | { type: 'inboxWatch'; open: boolean }
  /** An Inbox button: allow / allow_session / allow_always / deny (note) / add / later / answer (note = the answer) / retry / dismiss / open. */
  | { type: 'inboxAnswer'; id: string; choice: string; note?: string | null }
  /** stop / retry a job; answer its question (data: {answer}); open its thread; open an artifact (data: {index}). */
  | { type: 'jobAction'; action: 'stop' | 'retry' | 'answer' | 'openThread' | 'openArtifact' | 'resumeGoal'; jobId: string; data?: Record<string, unknown> | null }
  // ---- Jarvis
  /** Ask for the whole Jarvis state (answered with `jarvis {full: true}`; it is also sent on init). */
  | { type: 'requestJarvis' }
  /** A Jarvis button (drawer, command strip, board, panel, overlay). See JarvisActionKind for which fields go with which action. */
  | {
      type: 'jarvisAction';
      action: JarvisActionKind;
      chatId?: string | null;
      taskId?: string | null;
      agent?: AgentKind | null;
      noticeId?: string | null;
      teamName?: string | null;
      on?: boolean | null;
      settingsPage?: string | null;
    };
