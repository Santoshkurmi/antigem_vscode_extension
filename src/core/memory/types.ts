// What the host and Agent memory (src/core/memory) use of each other.
import type { AgentKind, Conversation } from '../../../shared/model';
import type { HostToView, SettingItem, SettingsPage, ViewToHost } from '../../../shared/protocol';
import type { AgentBackend, SendRequest } from '../types';

/** Every agent, in the order the settings list them. */
export const MEMORY_AGENTS: AgentKind[] = ['AGY', 'CLAUDE', 'CODEX', 'OPENCODE'];
export const DEFAULT_LIST_LIMIT = 10;
export const MAX_LIST_LIMIT = 30;

/** What Agent memory may use of the host. */
export interface MemoryHostApi {
  /** The backend of an enabled agent. */
  backend(kind: AgentKind): AgentBackend | undefined;
  /** Every backend the host has (enabled or not), to follow their chat lists. */
  allBackends(): AgentBackend[];
  /** Every chat of the enabled agents. */
  conversations(): Conversation[];
  isJarvisChat(id: string): boolean;
  /** Some view shows this chat. */
  isShown(id: string): boolean;
  broadcast(msg: HostToView): void;
  /** Re-sends the open Agents / memory settings pages. */
  refreshPages(): void;
  /** Text in an editor tab. */
  openText(title: string, content: string, language?: string | null): void;
  /** The window's first folder (the project a new memory offers), or null. */
  workspaceFolder(): string | null;
}

export type MemoryRequestMsg = Extract<ViewToHost, { type: 'memoryRequest' }>;

/** What the host calls on Agent memory. */
export interface MemoryHooks {
  bind(api: MemoryHostApi): void;
  /**
   * A normal chat's message from a view (never a Jarvis chat): a chat's first message (and its first after a compaction)
   * waits briefly for the memory text and carries it hidden; messages sent meanwhile go after it, in order. [typed]
   * = what the user typed (ranks the memories); [dispatch] sends the request to the agent.
   */
  send(req: SendRequest, agent: AgentKind, typed: string, dispatch: (req: SendRequest) => Promise<void>): Promise<void>;
  /** The chat lost its memory text (compacted, its first prompt undone): its next message carries it again. */
  forget(conversationId: string): void;
  /** A view opened this chat: catch up on turns that finished while nothing followed it. */
  opened(conversationId: string, agent: AgentKind): void;
  /** The chat was deleted: its history file goes too. */
  onChatDeleted(conversationId: string): void;
  /** A memory chip's question (what became of its block) or its Undo. [chat]: the chat the asking view shows. */
  request(msg: MemoryRequestMsg, chat: { id: string; agent: AgentKind } | null): Promise<HostToView>;
  /** Settings → Agents → Agent memory & history (pages 'memory' and 'memory.*'). */
  readonly settings: {
    rootItem(): SettingItem;
    page(id: string): Promise<SettingsPage>;
    change(page: string, id: string, value: unknown, rowId?: string): Promise<void>;
    action(page: string, id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void>;
  };
  dispose(): void;
}
