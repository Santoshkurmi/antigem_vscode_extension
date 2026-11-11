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
  kind: 'text' | 'multiline' | 'select' | 'toggle' | 'password';
  placeholder?: string | null;
  value?: string | null;
  options?: SettingOption[];
  required?: boolean;
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
  // ---- Jarvis
  /** Jarvis state: `full` = the whole state (on init / requestJarvis); otherwise only the fields that changed. */
  | { type: 'jarvis'; state: Partial<JarvisState>; full?: boolean }
  /**
   * Answer to jarvisAction newChat: show an empty new chat of `agent` (preselect `modelId` for it when not null) marked
   * as a Jarvis chat (JarvisChatWelcome + strip); its first `send` carries `jarvis: true`.
   */
  | { type: 'jarvisNewChat'; agent: AgentKind; modelId: string | null }
  /** Jarvis (a tool, a notice) wants this view to show a screen: a chat, the notes, or a settings page. */
  | { type: 'jarvisNavigate'; screen: 'chat' | 'notes' | 'settings'; conversationId?: string | null; settingsPage?: string | null };

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
   * .html file on disk (`htmlFile`), a local video / audio file (`file`) or a YouTube video id (`youtube`). Answered
   * with mediaUrl.
   */
  | { type: 'mediaUrl'; reqId: string; kind: 'html' | 'htmlFile' | 'file' | 'youtube'; value: string; start?: number }
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
