// What every agent backend (agy now; Claude, Codex, OpenCode next) implements for the host.
import type { AgentKind, ArtifactSnapshot, ChatAttachment, ChatMessage, Conversation, QueuedMessage } from '../../shared/model';
import type { AgentStatus, ApprovalView, ChipDetailsView, ControlChipView, ModelsState, QuestionView, SettingItem, SettingsPage, SlashCommandView } from '../../shared/protocol';

/** Everything a view needs to draw one chat. Messages keep their identity when unchanged. */
export interface ChatState {
  conversation: Conversation | null;
  agent: AgentKind;
  messages: ChatMessage[];
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  queued: QueuedMessage[];
  approvals: ApprovalView[];
  question: QuestionView | null;
  artifacts: ArtifactSnapshot[];
  workingLabel: string | null;
  /** The agent's controls strip for this chat (optional). */
  controls?: ControlChipView[];
  /** One-line notice above the controls strip (provider switch pending, model rerouted…). */
  notice?: string | null;
  /** The model this chat uses (per-chat model agents); the model pill prefers it. */
  modelId?: string | null;
  /** The chat cannot take messages; the text says why (a Claude subagent's transcript). */
  readOnly?: string | null;
}

export interface SendRequest {
  conversationId: string;
  isNew: boolean;
  text: string;
  attachments: ChatAttachment[];
  modelId: string | null;
  /** file:// URI of the project folder (new chats). */
  workspaceUri: string | null;
  /** A new chat's reasoning effort (Claude: low…max, Codex: the model's levels; 'default' = the agent's default). */
  effort?: string | null;
  /** A new Claude chat's extended thinking. */
  thinking?: boolean | null;
  /** A Crew bot's chat: its persona, own MCP server and tool limits (src/core/crew). Sent with every message. */
  setup?: ThreadSetup | null;
}

/** How much a Crew bot may do (docs/crew/PLAN.md §11). */
export type CrewAccess = 'talk' | 'read' | 'edit' | 'auto' | 'full';

/**
 * A Crew bot's chat setup. Each backend applies it as hard as its engine allows (src/core/crew/engines/caps.ts):
 * Claude = process flags, Codex = thread config, OpenCode = a hidden agent, Antigravity = a global MCP entry and a
 * hidden persona block in the message (it has no per-chat setup).
 */
export interface ThreadSetup {
  /** Names the engine-side things made for it (OpenCode agent "crew-<id>"). */
  id: string;
  /** Hash of everything below: a different key = the setup changed and is applied again. */
  key: string;
  /** Persona + crew rules (the system prompt part). */
  instructions: string;
  /** Its own MCP servers (the crew server with the caller's identity in the URL). */
  mcp: { name: string; url: string; headers: Record<string, string> }[];
  /** OpenCode / Antigravity: the one crew server every bot shares (OpenCode names the calling chat; AGY bots pass a cap). */
  sharedMcp?: { url: string; headers: Record<string, string> } | null;
  access: CrewAccess;
  /** Only the MCP servers above, none of the user's own. */
  onlyOwnMcp: boolean;
  /** Folders it may read without asking (the crew folder). */
  addDirs: string[];
}

/** An agent's settings: its section on the root page and its own pages (ids prefixed with the agent, "agy.mcp"). */
export interface AgentSettingsProvider {
  /** The agent's row on the settings root (a page link). */
  rootItem(): SettingItem;
  page(id: string): Promise<SettingsPage | null>;
  change(page: string, id: string, value: unknown, rowId?: string): Promise<void>;
  /** May return a short message to show as a toast. */
  action(page: string, id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void>;
  dispose?(): void;
}

export type BackendChange = 'status' | 'conversations' | 'models' | 'commands' | 'settings' | 'controls';

export interface AgentBackend {
  readonly kind: AgentKind;
  /** Settings pages, when the agent has any. */
  readonly settings?: AgentSettingsProvider;
  status(): AgentStatus;
  conversations(): Conversation[];
  models(): ModelsState;
  /** Starts connecting (idempotent). */
  start(): void;
  onChange(cb: (what: BackendChange) => void): () => void;

  /** Live state of a chat; `listener` is called (throttled) whenever it changes. */
  subscribe(conversationId: string, listener: (state: ChatState) => void): () => void;
  getState(conversationId: string): ChatState;

  send(req: SendRequest): Promise<void>;
  stop(conversationId: string): Promise<void>;
  approval(conversationId: string, key: string, choiceId: string | undefined, deny: boolean, feedback?: string): Promise<void>;
  /** `cancel` = the question was dismissed (✕): agy cancels the run, others treat it like skip. */
  answer(conversationId: string, key: string, answers: Record<string, string[]>, note?: string, skip?: boolean, cancel?: boolean): Promise<void>;
  selectModel(conversationId: string | null, modelId: string): void;
  /** The agent's `/` commands. */
  commands(): SlashCommandView[];
  /**
   * The `/` list follows the chat a view shows (the app's "/" menu follows the open chat's project): `folder` is its
   * project path (null = none). `opened`: the `/` menu just opened, so skills added meanwhile are read again. Emit
   * 'commands' when the list changed. Optional.
   */
  slashFolder?(folder: string | null, opened: boolean): void;
  /** Controls strip for a chat (null = defaults for the next new chat). Emit 'controls' when the defaults change. */
  controls?(conversationId: string | null): ControlChipView[];
  setControl?(conversationId: string | null, id: string, value: string): void | Promise<void>;
  /** An 'info' chip was clicked: describe it as a card (null = no card: setControl gets 'details' and may toast). */
  chipDetails?(conversationId: string | null, id: string): Promise<ChipDetailsView | null>;
  refreshModels(): void;
  conversationAction(id: string, action: 'delete' | 'fork' | 'rename' | 'archive' | 'unarchive', value?: string): Promise<string | void>;
  queueAction(conversationId: string, id: string, action: 'sendNow' | 'delete'): Promise<void>;
  /** The host gives each backend a way to show toasts (info: "Plan approved", warning: refused changes…). */
  setNotifier?(notify: (level: 'info' | 'warning' | 'error', message: string) => void): void;
  /** The agent's own id for a chat ("Copy ID"), when it differs from the id the views use. */
  externalId?(conversationId: string): string;
  /** Search chat contents (drawer deep search). Title matches are done by the host. */
  search?(query: string): Promise<{ conversationId: string; snippet: string }[]>;
  /** Tool card actions (terminate a running command…). */
  toolAction?(conversationId: string, toolId: string, action: string): Promise<void>;
  /** Model sheet edit mode: put a model in another usage-limit group (null = automatic). */
  setQuotaGroup?(modelId: string, group: string | null): void;
  /** Footer ↻: run the prompt of this reply again (optional). May return a toast text. */
  retryMessage?(conversationId: string, messageId: string): Promise<string | void>;
  /** Bubble ✎: undo this prompt and everything after it; returns the prompt text for the composer (optional). */
  rewind?(conversationId: string, messageId: string, restoreFiles?: boolean): Promise<string | null>;
  retry(): void;
  dispose(): void;
}

/** Small persistent key/value store (VS Code globalState, or a JSON file in dev). */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export type Logger = (line: string) => void;
