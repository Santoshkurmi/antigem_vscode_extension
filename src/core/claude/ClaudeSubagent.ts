// A Claude subagent's own transcript (the Agent / Task tool), shown read-only: Claude Code keeps it in
// <project>/<session>/subagents/agent-<id>.jsonl and only the parent chat can talk to it. Conversation id:
// "<session id>:agent-<agent id>" (nested under the parent chat in the drawer). The transcript only grows, so it is
// read incrementally (`?from=<byte offset>`), every 2.5 s while the subagent works and a view shows it.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ChatState } from '../types';
import { ClaudeTranscript, type SubagentInfo } from './ClaudeTranscript';
import type { ClaudeBackend } from './ClaudeBackend';

const SUBAGENT_ID_RE = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):agent-([A-Za-z0-9_-]{1,64})$/;

/** "<session>:agent-<id>" → its parts (null for a normal chat id). */
export function parseSubagentId(id: string): { sessionId: string; agentId: string } | null {
  const m = SUBAGENT_ID_RE.exec(id);
  return m ? { sessionId: m[1], agentId: m[2] } : null;
}

export const subagentConversationId = (sessionId: string, agentId: string) => `${sessionId}:agent-${agentId}`;

/** A subagent run as the bridge lists it (`/sessions` → subagents, `/sessions/{id}/subagents`). */
export interface SubagentWire {
  agent_id: string;
  agent_type?: string;
  description?: string;
  tool_use_id?: string;
  parent_agent_id?: string;
  background?: boolean;
  finished?: boolean;
  running?: boolean;
  created_at?: number;
  updated_at?: number;
  size_bytes?: number;
}

export const toSubagentInfo = (w: SubagentWire): SubagentInfo => ({
  agentId: w.agent_id,
  toolUseId: w.tool_use_id ?? '',
  running: w.running === true,
  finished: w.finished === true,
});

const POLL_MS = 2_500;

export class ClaudeSubagentView {
  readonly listeners = new Set<(s: ChatState) => void>();
  readonly transcript = new ClaudeTranscript();
  private offset = 0;
  private loaded = false;
  private loading = false;
  private error: string | null = null;
  private running = false;
  private finishedApplied = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private disposeTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    readonly id: string,
    readonly sessionId: string,
    readonly agentId: string,
    private b: ClaudeBackend,
  ) {
    this.transcript.reset(id);
    this.transcript.acceptSidechain = true;
    this.transcript.rootSessionId = sessionId;
    this.running = b.subagentRunning(id);
  }

  addListener(l: (s: ChatState) => void) {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
    this.listeners.add(l);
    if (!this.loaded && !this.loading) void this.load();
    l(this.state());
  }

  removeListener(l: (s: ChatState) => void) {
    this.listeners.delete(l);
    if (!this.listeners.size) {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.disposeTimer = setTimeout(() => this.b.dropSubagentView(this.id), 60_000);
    }
  }

  /** The session's subagent list changed (links of nested Agent cards, running state). */
  update(list: SubagentInfo[]) {
    this.transcript.setSubagents(list);
    const running = this.b.subagentRunning(this.id);
    if (running !== this.running) {
      this.running = running;
      if (running) this.schedulePoll();
      else void this.load();
    }
    this.emit();
  }

  private async load() {
    if (this.closed || this.loading) return;
    this.loading = true;
    try {
      const r = await this.b.bridgeJson(`/api/claude/sessions/${this.sessionId}/subagents/${encodeURIComponent(this.agentId)}/history?from=${this.offset}`, {}, 60_000);
      if (!r?.success) throw new Error(r?.error ?? 'the bridge refused');
      if (this.closed) return;
      const entries: any[] = Array.isArray(r.entries) ? r.entries : [];
      // a shorter file (rewritten) is read again from the start
      if (typeof r.next === 'number' && r.next < this.offset) {
        this.transcript.reset(this.id);
        this.finishedApplied = false;
      }
      for (const e of entries) this.transcript.applyHistory(e);
      if (typeof r.next === 'number') this.offset = r.next;
      if (r.subagent && typeof r.subagent === 'object') this.running = r.subagent.running === true;
      this.loaded = true;
      this.error = null;
      if (!this.running && !this.finishedApplied) {
        this.transcript.finishHistory();
        this.finishedApplied = true;
      } else if (this.running) this.finishedApplied = false;
    } catch (e) {
      if (!this.loaded) this.error = `Cannot load the subagent: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.loading = false;
    }
    this.emit();
    if (this.running) this.schedulePoll();
  }

  private schedulePoll() {
    if (this.pollTimer || this.closed || !this.listeners.size) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (this.listeners.size) void this.load();
    }, POLL_MS);
  }

  private emit() {
    if (this.closed || !this.listeners.size) return;
    const s = this.state();
    for (const l of this.listeners) l(s);
  }

  state(): ChatState {
    const conversation = this.b.conversation(this.id) ?? null;
    const parent = this.b.conversation(conversation?.parentConversationId ?? this.sessionId);
    const messages = this.transcript.toChatMessages();
    const working = this.running && this.loaded;
    return {
      conversation: conversation ? { ...conversation, isRunning: working } : null,
      agent: 'CLAUDE',
      messages,
      isStreaming: working,
      isLoading: !this.loaded && !this.error,
      error: this.error,
      queued: [],
      approvals: [],
      question: null,
      artifacts: [],
      workingLabel: working ? 'Subagent working…' : null,
      controls: [],
      notice: null,
      modelId: this.transcript.sessionModel,
      readOnly: `Subagent of “${parent?.title ?? 'its chat'}” · it takes instructions from that chat only`,
    };
  }

  close() {
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.listeners.clear();
  }
}
