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
  | { kind: 'text'; id: string; label: string; description?: string | null; value: string; placeholder?: string | null; multiline?: boolean; disabled?: boolean }
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
    }
  /** Opens a sub-page (the view sends requestSettings {page: id}). */
  | { kind: 'page'; id: string; label: string; description?: string | null; icon?: string | null; badge?: string | null }
  /** Usage meters (account quota). */
  | { kind: 'quota'; id: string; label: string; groups: ModelGroupView[] };

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

export type HostToView =
  | {
      type: 'init';
      viewKind: 'sidebar' | 'panel' | 'browser';
      workspaceFolders: WorkspaceFolder[];
      /** Conversation this view opens with (editor panels); null = last / new chat. */
      conversationId: string | null;
      defaultAgent: AgentKind;
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
  /** Answer to searchChats. */
  | { type: 'chatSearchResult'; reqId: string; results: ChatSearchHit[] }
  /** Put the cursor in the composer (keyboard shortcut). */
  | { type: 'focusComposer' };

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
  /** A controls-strip chip changed (conversationId null = defaults for the next new chat). */
  | { type: 'setControl'; agent: AgentKind; conversationId: string | null; id: string; value: string }
  /** Show a local image (artifact / attachment thumbnail): answered with imageData. */
  | { type: 'readImage'; reqId: string; path: string }
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
  | { type: 'setQuotaGroup'; agent: AgentKind; modelId: string; group: string | null };
