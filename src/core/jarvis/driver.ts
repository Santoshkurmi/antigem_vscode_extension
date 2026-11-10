// Drives the chats Jarvis works with, whether a view shows them or not (port of the app's JarvisDriver.kt): is it
// working, send it a message, stop it, what it is running right now. The app keeps its own backend per chat; here
// the host's backends serve every chat already (the bridge runs the agents), so a "watch" is just a subscription
// that keeps the chat's state live (approvals, questions, messages) while Jarvis needs it.
import type { AgentKind, ChatMessage, ToolCall } from '../../../shared/model';
import type { AgentBackend, ChatState } from '../types';
import type { JarvisEngine } from './engine';
import * as JText from './text';

interface Watch {
  agent: AgentKind;
  unsub: () => void;
  state: ChatState | null;
  /** Watching it is wanted until this time (0 = until released). */
  until: number;
  /** Holders that keep it ("task", "manager", "read"). */
  holders: Set<string>;
  listeners: Set<(s: ChatState) => void>;
}

export class Driver {
  private watches = new Map<string, Watch>();
  /** The agent of chats Jarvis created (before they show in the backend's list). */
  private known = new Map<string, AgentKind>();

  constructor(private j: JarvisEngine) {}

  remember(id: string, agent: AgentKind) {
    this.known.set(id, agent);
  }

  /** The agent a chat runs on, when known. */
  agentOf(id: string): AgentKind | null {
    return (
      this.watches.get(id)?.agent ??
      this.j.managers?.get(id)?.agent ??
      this.j.tasks?.find(id, true)?.agent ??
      this.known.get(id) ??
      this.j.host.conversations().find((c) => c.id === id)?.agent ??
      null
    );
  }

  backendOf(id: string): AgentBackend | undefined {
    const a = this.agentOf(id);
    return a ? this.j.host.backend(a) : undefined;
  }

  // ------------------------------------------------------------------ watching

  /** Keeps a live subscription on chat [id] for [holder]. */
  watch(id: string, holder: string, agent?: AgentKind): Watch | null {
    const a = agent ?? this.agentOf(id);
    if (!a) return null;
    const b = this.j.host.backend(a);
    if (!b) return null;
    let w = this.watches.get(id);
    if (!w || w.agent !== a) {
      w?.unsub();
      const nw: Watch = { agent: a, unsub: () => undefined, state: null, until: 0, holders: new Set(), listeners: new Set() };
      nw.unsub = b.subscribe(id, (s) => {
        nw.state = s;
        for (const l of nw.listeners) l(s);
      });
      // a backend that has the state already may not call the listener at once
      if (!nw.state) {
        try {
          nw.state = b.getState(id);
        } catch {
          nw.state = null;
        }
      }
      this.watches.set(id, nw);
      w = nw;
    }
    w.holders.add(holder);
    return w;
  }

  release(id: string, holder?: string) {
    const w = this.watches.get(id);
    if (!w) return;
    if (holder) w.holders.delete(holder);
    else w.holders.clear();
    if (w.holders.size) return;
    w.unsub();
    this.watches.delete(id);
  }

  isWatched(id: string, holder?: string): boolean {
    const w = this.watches.get(id);
    return !!w && (!holder || w.holders.has(holder));
  }

  state(id: string): ChatState | null {
    return this.watches.get(id)?.state ?? null;
  }

  /** The chat is working on a turn right now. */
  isBusy(id: string): boolean {
    if (!id) return false;
    const st = this.state(id);
    if (st?.isStreaming) return true;
    const a = this.agentOf(id);
    if (!a) return false;
    const c = this.j.host.conversations().find((x) => x.id === id);
    if (!c) return false;
    // Antigravity's list knows a chat runs before (and after) its live state does; the others' live state is the truth
    if (a === 'AGY') return this.j.host.backend('AGY')?.status().state === 'online' && (c.isRunning || c.notFullyIdle);
    return !st && c.isRunning;
  }

  /** Waits until the watched chat has loaded (history known), at most [ms]. */
  async loaded(id: string, ms: number): Promise<ChatState | null> {
    const w = this.watches.get(id);
    if (!w) return null;
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const s = w.state;
      if (s && !s.isLoading) return s;
      await sleep(200);
    }
    return w.state;
  }

  /** The chat's messages as they are live (watched), else null. */
  liveMessages(id: string): ChatMessage[] | null {
    return this.state(id)?.messages ?? null;
  }

  /** The tool the chat's current reply is running, if any. */
  runningTool(id: string): ToolCall | null {
    const msgs = this.liveMessages(id);
    if (!msgs) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'ASSISTANT') continue;
      const calls = msgs[i].toolCalls;
      for (let k = calls.length - 1; k >= 0; k--) if (calls[k].status === 'RUNNING') return calls[k];
      return null;
    }
    return null;
  }

  /** The chat's last reply text (hidden blocks taken out). */
  async lastReply(id: string): Promise<string> {
    const msgs = this.liveMessages(id)?.length ? this.liveMessages(id)! : await this.readChat(id);
    const last = [...msgs].reverse().find((m) => m.role === 'ASSISTANT' && m.content.trim());
    return JText.reply(last?.content ?? '').text;
  }

  /**
   * A chat's messages, whatever agent it runs on: what is live comes first, otherwise it is loaded (a short watch,
   * released a minute later so repeated reads stay cheap).
   */
  async readChat(id: string, ms = 10_000): Promise<ChatMessage[]> {
    const live = this.state(id);
    if (live && !live.isLoading && live.messages.length) return live.messages;
    const w = this.watch(id, 'read');
    if (!w) return [];
    const s = await this.loaded(id, ms);
    this.releaseLater(id, 'read', 60_000);
    return s?.messages ?? [];
  }

  private releaseTimers = new Map<string, NodeJS.Timeout>();

  releaseLater(id: string, holder: string, ms: number) {
    const k = `${id}|${holder}`;
    const old = this.releaseTimers.get(k);
    if (old) clearTimeout(old);
    this.releaseTimers.set(
      k,
      setTimeout(() => {
        this.releaseTimers.delete(k);
        this.release(id, holder);
      }, ms),
    );
  }

  // ------------------------------------------------------------------ acting

  /** Sends [text] to an existing chat (the chat is loaded first, so the agent resumes it). */
  async send(id: string, text: string): Promise<void> {
    const a = this.agentOf(id);
    const b = a ? this.j.host.backend(a) : undefined;
    if (!a || !b) throw new Error(a ? `${a} is turned off (Settings → Agents)` : 'Unknown chat');
    const fresh = !this.watches.has(id);
    this.watch(id, 'send', a);
    if (fresh) await this.loaded(id, 8000);
    try {
      await b.send({ conversationId: id, isNew: false, text, attachments: [], modelId: null, workspaceUri: null });
    } finally {
      this.releaseLater(id, 'send', 120_000);
    }
  }

  /** Stops the chat's current turn. */
  async stop(id: string): Promise<void> {
    const b = this.backendOf(id);
    if (!b) throw new Error('Unknown chat');
    if (!this.watches.has(id)) {
      this.watch(id, 'stop');
      await this.loaded(id, 3000);
      this.releaseLater(id, 'stop', 30_000);
    }
    await b.stop(id);
  }

  dispose() {
    for (const t of this.releaseTimers.values()) clearTimeout(t);
    this.releaseTimers.clear();
    for (const w of this.watches.values()) w.unsub();
    this.watches.clear();
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
