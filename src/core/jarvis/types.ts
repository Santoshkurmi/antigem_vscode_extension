// Jarvis (the command center): shared types of the engine and the two small interfaces it has with the host.
// Port of the Android app's data/jarvis/* minus voice: every Jarvis chat is a text chat (a "manager", keyed by its
// chat id) that plans, delegates tasks to other chats of any agent, and gets their news back as hidden messages.
import type { AgentKind, ChatMessage, Conversation } from '../../../shared/model';
import type {
  EditorContextView,
  FileSuggestion,
  HostToView,
  JarvisState,
  ProjectView,
  SettingItem,
  SettingsPage,
  ViewToHost,
  WorkspaceFolder,
} from '../../../shared/protocol';
import type { AgentBackend } from '../types';

// ------------------------------------------------------------------------------------------------ the model

export type StepStatus = 'todo' | 'doing' | 'done' | 'blocked';
export interface Step {
  n: number;
  text: string;
  status: StepStatus;
  note: string;
}

export interface Mission {
  goal: string;
  doneWhen: string;
  steps: Step[];
  /** "active", "done" or "paused". */
  status: 'active' | 'done' | 'paused';
  /** Keep working until done: the app nudges the manager when it stops while nothing is running. */
  autopilot: boolean;
  notes: string;
  updatedAt: number;
  /** Nudges in a row without progress (reset whenever something moves). */
  nudges: number;
}

export interface Team {
  name: string;
  agent: AgentKind;
  model: string;
  /** What this team does and how (sent hidden with every task the team gets). */
  role: string;
  project: string;
}

export interface Manager {
  /** The Jarvis chat's id (the id the views use). */
  key: string;
  agent: AgentKind;
  mission: Mission;
  teams: Team[];
  /** The guide version this chat already got in full (empty: the next message carries the whole guide). */
  bootFor: string;
  createdAt: number;
  /** Last time a message (the user's or news) was sent to this chat. */
  lastSentAt: number;
}

export type TaskState = 'STARTING' | 'RUNNING' | 'NEEDS_APPROVAL' | 'NEEDS_ANSWER' | 'STALLED' | 'DONE' | 'FAILED' | 'STOPPED';

export const TASK_LABEL: Record<TaskState, string> = {
  STARTING: 'starting',
  RUNNING: 'running',
  NEEDS_APPROVAL: 'waiting for approval',
  NEEDS_ANSWER: 'asking a question',
  STALLED: 'no progress',
  DONE: 'done',
  FAILED: 'failed',
  STOPPED: 'stopped',
};

export const isActiveState = (s: TaskState) => s === 'STARTING' || s === 'RUNNING' || s === 'NEEDS_APPROVAL' || s === 'NEEDS_ANSWER' || s === 'STALLED';
export const needsUserState = (s: TaskState) => s === 'NEEDS_APPROVAL' || s === 'NEEDS_ANSWER';

export interface Task {
  id: string;
  agent: AgentKind;
  title: string;
  goal: string;
  project: string;
  state: TaskState;
  createdAt: number;
  /** When the current message was sent (the start grace counts from here). */
  turnAt: number;
  updatedAt: number;
  /** Last time the chat visibly moved (new text, a tool started or finished). */
  progressAt: number;
  seenRunning: boolean;
  followUps: number;
  /** One line about the latest change ("Finished", "Waiting for an approval"). */
  note: string;
  /** The task's last reply (cut to its end when long), once it finished. */
  result: string;
  /** Length of the whole last reply ([result] is cut when this is longer). */
  resultChars: number;
  /** The current state was already reported (no repeat). */
  reported: boolean;
  /** An existing chat Jarvis was told to drive, not one it started. */
  adopted: boolean;
  /** The Jarvis chat (manager key) that started it and gets its news. */
  owner: string;
  /** The manager's team that works on it (empty: none). */
  team: string;
}

export interface JarvisEvent {
  /** task_done, task_failed, task_stalled, task_approval, task_question, nudge, autopilot_paused */
  kind: string;
  taskId: string;
  title: string;
  agent: string;
  team: string;
  goal: string;
  /** The sub-agent's reply, the error, the question or the action waiting for approval. */
  body: string;
  key: string;
  risk: string;
  /** Length of the whole reply when [body] is only its end (task_done), else 0. */
  replyChars: number;
  at: number;
}

export type Risk = 'READ' | 'NORMAL' | 'RISKY';

/** One request waiting for approval in a chat Jarvis can reach. */
export interface Perm {
  key: string;
  /** "task" (a task's chat) or "manager" (a Jarvis chat's own tool call). */
  source: 'task' | 'manager';
  chatId: string;
  agent: AgentKind;
  tool: string;
  summary: string;
  risk: Risk;
  /** The approval card's primary choice (what "approve" sends). */
  approveChoice: string;
}

// ------------------------------------------------------------------------------------------------ host interfaces

/** What the engine needs from the host (implemented by AppHost.jarvisApi()). */
export interface JarvisHostApi {
  /** An enabled agent's backend. */
  backend(kind: AgentKind): AgentBackend | undefined;
  enabledKinds(): AgentKind[];
  /** Every chat of the enabled agents (not decorated with Jarvis flags). */
  conversations(): Conversation[];
  /** Agent of new chats (the one picked last). */
  defaultAgent(): AgentKind;
  setDefaultAgent(kind: AgentKind): void;
  projects(): Promise<ProjectView[]>;
  workspaceFolders(): WorkspaceFolder[];
  saveProject(path: string): Promise<void>;
  /** The chat the user looks at (the view used last); null when no view is open. */
  screenChat(): { conversationId: string | null; agent: AgentKind } | null;
  /** Shows a chat (null = an empty new chat of [agent]) in the view used last. */
  showChat(conversationId: string | null, agent?: AgentKind): void;
  /** Sends a message to the view used last (navigation). */
  postActive(msg: HostToView): void;
  broadcast(msg: HostToView): void;
  /** The chat list changed (Jarvis tags): send it again. */
  refreshConversations(): void;
  /** Re-sends open settings pages. */
  refreshSettings(): void;
  /** The user's custom `/` commands expanded (hidden blocks). */
  expand(text: string): string;
  /** Settings → Global context entries (those with forJarvis are told to Jarvis). */
  contextEntries(): { title: string; text: string; enabled: boolean; everyMessage: boolean; forJarvis?: boolean }[];
  /** Settings → Global context's built-in text ([h] = heading level), or null when the user turned it off. */
  builtInContext(h?: string): string | null;
  uiPrefs(): Record<string, unknown>;
  patchUiPrefs(patch: Record<string, unknown>): void;
  editorContext(): EditorContextView | null;
  openFile(path: string, line?: number): void;
  openUrl(url: string): void;
  searchFiles(query: string): Promise<FileSuggestion[]>;
  /** AntiGem is turned off (drawer ⏻). */
  isOff(): boolean;
}

/** The bridge's authenticated JSON requests. */
export interface BridgeAccess {
  json<T = any>(p: string, init?: RequestInit): Promise<T>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Where agents reach jarvis_mcp. */
export interface McpAccess {
  url(path: string): string;
  headers(): Record<string, string>;
  /** This window serves the MCP port (its loops run here). */
  readonly boundPort: number | null;
}

export type JarvisActionMsg = Extract<ViewToHost, { type: 'jarvisAction' }>;

/** What the host calls on the engine. */
export interface JarvisHooks {
  /**
   * A message the user sends from a view. Returns the text with Jarvis' hidden note in front when the chat is a Jarvis
   * chat ([markJarvis]: a new chat the view opened with "New Jarvis chat"), or null for any other chat.
   */
  wrapSend(conversationId: string, agent: AgentKind, text: string, isNew: boolean, markJarvis: boolean): string | null;
  /** Adds the parsed news (`jarvisEvents`) to the labelled messages Jarvis sent. */
  decorateMessages(conversationId: string, messages: ChatMessage[]): ChatMessage[];
  /** Adds `isJarvis` / `jarvisHidden` to the chat list. */
  decorateConversations(list: Conversation[]): Conversation[];
  /** The whole state for a view that just opened. */
  snapshot(): JarvisState;
  /** A view's Jarvis button. May return a toast text. */
  action(msg: JarvisActionMsg, viewId: string): Promise<string | void>;
  /** Settings → Jarvis (pages 'jarvis' and 'jarvis.*'). */
  readonly settings: {
    rootItem(): SettingItem;
    page(id: string): Promise<SettingsPage>;
    change(page: string, id: string, value: unknown, rowId?: string): Promise<void>;
    action(page: string, id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void>;
  };
  /** A chat was deleted (chat list or a tool): Jarvis forgets it. */
  onChatDeleted(id: string): void;
  dispose(): void;
}
