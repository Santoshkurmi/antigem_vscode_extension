// Settings and bookkeeping of Jarvis (port of the app's JarvisPreferences.kt minus the voice ones). Everything is off
// until the user turns Jarvis on in Settings → Jarvis. Kept in the extension's KeyValueStore.
import type { AgentKind } from '../../../shared/model';
import type { KeyValueStore } from '../types';

export interface JarvisPrefValues {
  /** Jarvis is available (the Jarvis tab, the MCP server, the loops). */
  enabled: boolean;
  /** Agent of new Jarvis chats ("" = the one used for the last Jarvis chat, else the agent new chats use). */
  agent: '' | AgentKind;
  /** Model of new Jarvis chats ("" = the agent's default). */
  modelId: string;
  /** Whom Jarvis speaks as: "female", "male", "neutral" or "" (matters in languages like Hindi). */
  persona: string;
  /** What the user wants Jarvis to know: what to call them, language, context, standing instructions. */
  aboutUser: string;
  /** The note Jarvis keeps across chats (jarvis_memory_write). */
  memory: string;
  /** Live context (VS Code, chats, tasks, approvals) goes with every message. */
  contextInPrompt: boolean;
  /** "ask_each", "auto_readonly", "auto_except_risky" or "auto_all". */
  permissionPolicy: string;
  /** Jarvis may change app settings (jarvis_set_setting). Off keeps it read-only. */
  allowSettingChanges: boolean;
  /** Task news (done, failed, stuck): "model" (the Jarvis chat reads it and acts) or "speak" (just a notice, no model turn). */
  eventRouting: string;
  /** Approvals inside tasks: "policy" (the approval rules) or "jarvis" (the Jarvis chat decides from the task's goal). */
  taskApprovals: string;
  /** Report a running task with no progress after this many minutes (0 = never). */
  stallMinutes: number;
  /** A Jarvis chat that sleeps or polls while its tasks run: "interrupt", "remind" or "off". */
  waitGuard: string;
  /** Autopilot: nudges in a row without progress before it pauses itself. */
  autopilotMaxNudges: number;
  /** News that comes in within this time goes to Jarvis together, in one message (ms). */
  eventBatchMs: number;
  /** The agent of the last Jarvis chat the user opened. */
  textChatAgent: string;
  /** Jarvis chats in All too: "none" (only under Jarvis), "text" (the user's Jarvis chats) or "all". */
  listMode: 'none' | 'text' | 'all';
  /** The project Jarvis works in by default (jarvis_ide_open_project); "" = the first workspace folder. */
  activeProject: string;
}

const DEFAULTS: JarvisPrefValues = {
  enabled: false,
  agent: '',
  modelId: '',
  persona: '',
  aboutUser: '',
  memory: '',
  contextInPrompt: true,
  permissionPolicy: 'ask_each',
  allowSettingChanges: false,
  eventRouting: 'model',
  taskApprovals: 'policy',
  stallMinutes: 10,
  waitGuard: 'interrupt',
  autopilotMaxNudges: 4,
  eventBatchMs: 2000,
  textChatAgent: '',
  listMode: 'none',
  activeProject: '',
};

const KEY = 'jarvis.prefs';
const IDS_KEY = 'jarvis.chatIds';

export class JarvisPrefs {
  private v: JarvisPrefValues;
  private ids: Set<string>;
  private listeners = new Set<() => void>();

  constructor(private store: KeyValueStore) {
    this.v = { ...DEFAULTS, ...(store.get<Partial<JarvisPrefValues>>(KEY) ?? {}) };
    this.ids = new Set(store.get<string[]>(IDS_KEY) ?? []);
  }

  get<K extends keyof JarvisPrefValues>(k: K): JarvisPrefValues[K] {
    return this.v[k];
  }

  set<K extends keyof JarvisPrefValues>(k: K, value: JarvisPrefValues[K]) {
    if (this.v[k] === value) return;
    this.v = { ...this.v, [k]: value };
    this.store.set(KEY, this.v);
    for (const l of this.listeners) l();
  }

  all(): JarvisPrefValues {
    return this.v;
  }

  onChange(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // ---- the ids of every Jarvis chat (listed under the Jarvis tab)

  chatIds(): string[] {
    return [...this.ids];
  }

  isJarvisChat(id: string | null | undefined): boolean {
    return !!id && this.ids.has(id);
  }

  addChatId(id: string) {
    if (!id || this.ids.has(id)) return;
    this.ids.add(id);
    this.store.set(IDS_KEY, [...this.ids]);
    for (const l of this.listeners) l();
  }

  removeChatId(id: string) {
    if (!this.ids.delete(id)) return;
    this.store.set(IDS_KEY, [...this.ids]);
    for (const l of this.listeners) l();
  }

  /** The agent picked for Jarvis chats, or null when none was picked. */
  agentKind(): AgentKind | null {
    const a = this.v.agent;
    return a === 'AGY' || a === 'CLAUDE' || a === 'CODEX' || a === 'OPENCODE' ? a : null;
  }
}
