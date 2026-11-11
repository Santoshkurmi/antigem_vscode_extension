// Port of the app's ClaudeTranscript.kt: builds the chat feed of one Claude conversation from stream-json events (live)
// and transcript entries (history), producing the same ChatMessage / ToolCall shapes the Antigravity engine produces.
// Also tracks what the chat controls need: permission mode, model, prompt-cache timing, plan limits.
// Finished turns keep their ChatMessage object between calls (cached per turn version), so the host sends only diffs.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ChatAttachment, ChatMessage, ChoiceQuestionnaire, TokenUsage, ToolCall, ToolType } from '../../../shared/model';
import { displayUserText } from '../text';
import { num, str, type UnifiedWindow } from './protocol';

/** A permission prompt (`can_use_tool`) waiting for the user. */
export interface PendingPermission {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, any>;
  suggestions: any[] | null;
  reason: string | null;
  blockedPath: string | null;
}

/** Prompt-cache state for the "cache warm, N min left" indicator. */
export interface CacheInfo {
  anchorMs: number;
  ttlMs: number;
  recacheTokens: number;
  compacted: boolean;
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  eph1h: number;
  eph5m: number;
}

function usageOf(u: any): Usage | null {
  if (!u || typeof u !== 'object') return null;
  return {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
    eph1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
    eph5m: num(u.cache_creation?.ephemeral_5m_input_tokens),
  };
}

type Part =
  | { kind: 'thinking'; text: string; streaming: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; toolUseId: string }
  | { kind: 'error'; title: string; message: string };

interface TurnBase {
  version: number;
  cached: ChatMessage | null;
  cachedVersion: number;
}

interface UserTurn extends TurnBase {
  kind: 'user';
  uuid: string;
  text: string;
  attachments: ChatAttachment[];
  createdAt: number;
  stepIndex: number;
  /** Transcript message right before this prompt; rewinding to it drops this prompt and everything after. */
  parentUuid: string | null;
}

interface SummaryTurn extends TurnBase {
  kind: 'summary';
  id: string;
  text: string;
  createdAt: number;
}

interface AssistantTurn extends TurnBase {
  kind: 'assistant';
  id: string;
  parts: Part[];
  partByKey: Map<string, Part>;
  blockCounts: Map<string, number>;
  isStreaming: boolean;
  lastMessageUsage: Usage | null;
  /** The model that wrote this reply, as the API reported it (`assistant.message.model`). */
  model: string | null;
  resultUsage: TokenUsage | null;
  createdAt: number;
  timed: boolean;
}

type Turn = UserTurn | SummaryTurn | AssistantTurn;

interface ToolState {
  id: string;
  name: string;
  input: Record<string, any> | null;
  stepIndex: number;
  turn: AssistantTurn;
  status: string;
  output: string;
  progress: string | null;
  exitCode: number | null;
  startedAt: number;
  durationMs: number | null;
  /** Agent/Task: the subagent's id (links the card to its transcript); background = launched with run_in_background. */
  agentId?: string | null;
  background?: boolean;
}

/** What the bridge knows about a subagent run (from the session list). */
export interface SubagentInfo {
  agentId: string;
  toolUseId: string;
  running: boolean;
  finished: boolean;
}

/** Internal tools that are not interesting to show as cards. */
const HIDDEN_TOOLS = new Set(['ToolSearch']);
const OPEN_STATUSES = new Set(['RUNNING', 'PENDING_APPROVAL', 'AWAITING_CHOICE']);
const CONTEXT_TAG_RE = /<(ide_selection|ide_opened_file|system-reminder)>[\s\S]*?<\/(ide_selection|ide_opened_file|system-reminder)>/g;

const obj = (v: any): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const parseTime = (ts: unknown): number | null => {
  if (typeof ts !== 'string') return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
};

export class ClaudeTranscript {
  conversationId = '';
  sessionModel: string | null = null;
  permissionMode: string | null = null;
  cacheInfo: CacheInfo | null = null;
  /** Live plan-limit windows from `rate_limit_event` (key → utilization 0..1, resetsAt seconds). A new object per event. */
  rateLimits: Record<string, UnifiedWindow> = {};
  /** Cumulative session cost reported by the last `result`. */
  sessionCostUsd = 0;
  /** True while the chat runs on a custom provider's model: its errors are the provider's, not a Claude sign-in problem. */
  isCustomProvider: () => boolean = () => false;
  /** The last turn failed because the CLI is not signed in. */
  needsLogin = false;

  private turns: Turn[] = [];
  private seenUuids = new Set<string>();
  private tools = new Map<string, ToolState>();
  private pending = new Map<string, PendingPermission>();
  private taskToTool = new Map<string, string>();
  private activeTurn: AssistantTurn | null = null;
  private currentStreamMessageId: string | null = null;
  private stepCounter = 0;
  private afterCompactBoundary = false;
  private lastEventUuid: string | null = null;
  private lastResultCost = 0;
  /** subagent id → its Agent tool card (from the launch result, a task notification or the bridge's list). */
  private agentToTool = new Map<string, string>();
  /** The bridge's subagent list for this chat, by tool use id. */
  private subagentsByTool = new Map<string, SubagentInfo>();
  /** Show sidechain entries: this transcript is a subagent's own (every line is `isSidechain: true`). */
  acceptSidechain = false;
  /** The session the subagent conversations belong to ("<session>:agent-<id>"); the chat itself by default. */
  rootSessionId: string | null = null;

  reset(convId: string) {
    this.conversationId = convId;
    this.turns = [];
    this.seenUuids.clear();
    this.tools.clear();
    this.pending.clear();
    this.taskToTool.clear();
    this.activeTurn = null;
    this.currentStreamMessageId = null;
    this.stepCounter = 0;
    this.afterCompactBoundary = false;
    this.lastEventUuid = null;
    this.lastResultCost = 0;
    this.agentToTool.clear();
    for (const [toolId, a] of this.subagentsByTool) this.agentToTool.set(a.agentId, toolId);
    this.sessionModel = null;
    this.permissionMode = null;
    this.cacheInfo = null;
    this.rateLimits = {};
    this.sessionCostUsd = 0;
    this.needsLogin = false;
  }

  get isTurnActive(): boolean {
    return this.activeTurn?.isStreaming === true;
  }

  pendingFor(toolUseId: string): PendingPermission | undefined {
    return this.pending.get(toolUseId);
  }

  pendingList(): PendingPermission[] {
    return [...this.pending.values()];
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  get isEmpty(): boolean {
    return this.turns.length === 0;
  }

  userTurnCount(): number {
    return this.turns.filter((t) => t.kind === 'user').length;
  }

  /** uuid of the transcript message right before the prompt with [userUuid] (null for the first prompt). */
  parentOfUser(userUuid: string): string | null {
    const t = this.turns.find((x): x is UserTurn => x.kind === 'user' && x.uuid === userUuid);
    return t?.parentUuid ?? null;
  }

  /** The prompt text of the user message with [userUuid]. */
  userText(userUuid: string): string | null {
    const t = this.turns.find((x): x is UserTurn => x.kind === 'user' && x.uuid === userUuid);
    return t?.text ?? null;
  }

  /** The attachments of the user message with [userUuid] (inline images, files sent by path). */
  userAttachments(userUuid: string): ChatAttachment[] {
    const t = this.turns.find((x): x is UserTurn => x.kind === 'user' && x.uuid === userUuid);
    return t?.attachments ?? [];
  }

  /** The last user prompt before the assistant message [assistantMessageId]. */
  userBefore(assistantMessageId: string): string | null {
    const idx = this.turns.findIndex((t) => t.kind === 'assistant' && t.id === assistantMessageId);
    if (idx < 0) return null;
    for (let i = idx - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t.kind === 'user') return t.uuid;
    }
    return null;
  }

  /**
   * The bridge's subagent runs of this chat: links Agent cards to their transcripts and tells which background runs are
   * still working (a chat loaded from history has no live task events).
   */
  setSubagents(list: SubagentInfo[]) {
    const next = new Map(list.filter((a) => a.toolUseId).map((a) => [a.toolUseId, a]));
    for (const [toolId, a] of next) {
      const prev = this.subagentsByTool.get(toolId);
      this.agentToTool.set(a.agentId, toolId);
      const tool = this.tools.get(toolId);
      if (!tool) continue;
      let changed = !prev || prev.running !== a.running || prev.finished !== a.finished || tool.agentId !== a.agentId;
      tool.agentId = a.agentId;
      // a background run that ended while nobody watched the stream
      if (tool.background && tool.status === 'RUNNING' && !a.running && !this.isTurnActive) {
        tool.status = a.finished ? 'SUCCESS' : 'TERMINATED';
        tool.progress = null;
        changed = true;
      } else if (tool.background && tool.status === 'TERMINATED' && a.running && !tool.output.trim()) {
        // ended at load time for lack of news, but it still works (another process runs it)
        tool.status = 'RUNNING';
        tool.progress = 'Running in the background';
        changed = true;
      }
      if (changed) this.touch(tool.turn);
    }
    this.subagentsByTool = next;
  }

  /** The conversation id of a subagent run of this chat. */
  subagentConversationId(agentId: string): string {
    return `${this.rootSessionId ?? this.conversationId}:agent-${agentId}`;
  }

  // ------------------------------------------------------------------ local actions

  /** Shows the user's message immediately; the CLI's replay with the same uuid is ignored later. */
  addLocalUserMessage(uuid: string, text: string, attachments: ChatAttachment[]) {
    this.addUserTurn(uuid, text, attachments, Date.now(), this.lastEventUuid);
    this.beginAssistantTurn();
    this.needsLogin = false;
  }

  /** A prompt the extension answered itself (`/usage`, `/context`…): shown with its reply, never sent to Claude. */
  addLocalExchange(uuid: string, prompt: string, reply: string) {
    // a reply Claude is writing keeps streaming into its own turn
    const running = this.activeTurn;
    this.addUserTurn(uuid, prompt, [], Date.now(), this.lastEventUuid);
    const turn = this.beginAssistantTurn();
    turn.parts.push({ kind: 'text', text: reply });
    turn.isStreaming = false;
    this.activeTurn = running;
    this.touch(turn);
  }

  markPermissionAnswered(toolUseId: string, newStatus: string, output?: string | null) {
    this.pending.delete(toolUseId);
    const tool = this.tools.get(toolUseId);
    if (tool) {
      tool.status = newStatus;
      if (output != null) tool.output = output;
      this.touch(tool.turn);
    }
  }

  addError(title: string, message: string) {
    const turn = this.activeTurn ?? this.beginAssistantTurn();
    turn.parts.push({ kind: 'error', title, message });
    turn.isStreaming = false;
    this.touch(turn);
  }

  /** The turn is over without a `result` (process exited, interrupted while disconnected…). */
  endTurn() {
    if (this.activeTurn) {
      this.activeTurn.isStreaming = false;
      this.touch(this.activeTurn);
    }
    this.pending.clear();
  }

  // ------------------------------------------------------------------ incoming events

  /** Applies one stream-json line (live). Returns the event type for the caller's bookkeeping. */
  applyLive(data: any): string {
    const type = str(data?.type);
    if (!type) return '';
    switch (type) {
      case 'stream_event':
        this.onStreamEvent(data);
        break;
      case 'assistant':
        if (obj(data.message)) this.onAssistant(data);
        break;
      case 'user':
        if (obj(data.message)) this.onUser(data, true);
        break;
      case 'result':
        this.onResult(data);
        break;
      case 'system':
        this.onSystem(data);
        break;
      case 'control_request':
        this.onControlRequest(data);
        break;
      case 'control_cancel_request': {
        const id = str(data.request_id);
        for (const [k, p] of this.pending) {
          if (p.requestId === id) {
            this.markPermissionAnswered(k, 'RUNNING');
            break;
          }
        }
        break;
      }
      case 'rate_limit_event':
        this.onRateLimit(data);
        break;
    }
    return type;
  }

  /** Applies one transcript entry from `/history`. */
  applyHistory(entry: any) {
    switch (str(entry?.type)) {
      case 'assistant':
        if (obj(entry.message)) this.onAssistant(entry);
        break;
      case 'user':
        if (obj(entry.message)) this.onUser(entry, false);
        break;
      case 'system':
        if (entry.subtype === 'local_command' && typeof entry.content === 'string') this.addLocalCommandOutput(entry.content);
        else if (entry.subtype === 'compact_boundary') {
          this.afterCompactBoundary = true;
          if (this.cacheInfo) this.cacheInfo = { ...this.cacheInfo, compacted: true };
        }
        break;
    }
    if (typeof entry?.uuid === 'string') this.lastEventUuid = entry.uuid;
  }

  /** History is complete: nothing is streaming. */
  finishHistory() {
    for (const t of this.turns) {
      if (t.kind === 'assistant' && t.isStreaming) {
        t.isStreaming = false;
        this.touch(t);
      }
    }
    for (const tool of this.tools.values()) {
      if (!OPEN_STATUSES.has(tool.status)) continue;
      const sub = this.subagentsByTool.get(tool.id);
      // a background subagent keeps working after its turn (another process may still run it)
      if (tool.background && sub?.running) continue;
      tool.status = tool.background && sub?.finished ? 'SUCCESS' : 'TERMINATED';
      tool.progress = null;
      this.touch(tool.turn);
    }
    this.activeTurn = null;
  }

  private onStreamEvent(e: any) {
    if (e.parent_tool_use_id != null && !this.acceptSidechain) return;
    const ev = obj(e.event);
    if (!ev) return;
    switch (ev.type) {
      case 'message_start': {
        this.currentStreamMessageId = typeof ev.message?.id === 'string' ? ev.message.id : null;
        const u = usageOf(ev.message?.usage);
        if (u) this.recordCache(u, Date.now());
        const turn = this.activeTurn ?? this.beginAssistantTurn();
        turn.isStreaming = true;
        this.touch(turn);
        break;
      }
      case 'content_block_start': {
        const turn = this.activeTurn ?? this.beginAssistantTurn();
        if (typeof ev.index !== 'number') return;
        const key = this.blockKey(this.currentStreamMessageId, ev.index);
        if (turn.partByKey.has(key)) return;
        const block = obj(ev.content_block);
        if (!block) return;
        let part: Part;
        if (block.type === 'thinking') part = { kind: 'thinking', text: '', streaming: true };
        else if (block.type === 'text') part = { kind: 'text', text: str(block.text) };
        else if (block.type === 'tool_use') {
          const id = str(block.id);
          if (!id) return;
          this.ensureTool(id, str(block.name) || 'tool', obj(block.input), turn);
          part = { kind: 'tool', toolUseId: id };
        } else return;
        turn.partByKey.set(key, part);
        if (part.kind !== 'tool' || !turn.parts.some((p) => p.kind === 'tool' && p.toolUseId === part.toolUseId)) turn.parts.push(part);
        this.touch(turn);
        break;
      }
      case 'content_block_delta': {
        const turn = this.activeTurn;
        if (!turn || typeof ev.index !== 'number') return;
        const part = turn.partByKey.get(this.blockKey(this.currentStreamMessageId, ev.index));
        const delta = obj(ev.delta);
        if (!part || !delta) return;
        if (part.kind === 'text' && delta.type === 'text_delta') part.text += str(delta.text);
        else if (part.kind === 'thinking' && delta.type === 'thinking_delta') part.text += str(delta.thinking);
        else return;
        this.touch(turn);
        break;
      }
      case 'content_block_stop': {
        const turn = this.activeTurn;
        if (!turn || typeof ev.index !== 'number') return;
        const part = turn.partByKey.get(this.blockKey(this.currentStreamMessageId, ev.index));
        if (part?.kind === 'thinking' && part.streaming) {
          part.streaming = false;
          this.touch(turn);
        }
        break;
      }
    }
  }

  private onAssistant(e: any) {
    if (!this.acceptSidechain && (e.parent_tool_use_id != null || e.isSidechain === true)) return;
    const uuid = typeof e.uuid === 'string' ? e.uuid : null;
    // events re-emitted after /compact carry the uuids we already showed
    if (uuid) {
      if (this.seenUuids.has(uuid)) return;
      this.seenUuids.add(uuid);
      this.lastEventUuid = uuid;
    }
    const message = e.message;
    const synthetic = message.model === '<synthetic>';
    // a synthetic message outside a turn (e.g. output of a live model switch) is complete on arrival
    let turn = this.activeTurn;
    if (!turn) {
      turn = this.beginAssistantTurn();
      if (synthetic) {
        turn.isStreaming = false;
        this.activeTurn = null;
      }
    }
    if (!synthetic && typeof message.model === 'string') {
      this.sessionModel = message.model;
      turn.model = message.model;
    }
    const ts = parseTime(e.timestamp);
    if (ts != null && !turn.timed) {
      turn.createdAt = ts;
      turn.timed = true;
    }
    const msgId = str(message.id) || uuid || 'msg';
    const u = usageOf(message.usage);
    if (u && !synthetic) {
      turn.lastMessageUsage = u;
      // history: no message_start events, so the cache timer comes from the stored timestamps
      if (ts != null) this.recordCache(u, ts);
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!obj(block)) continue;
      const index = turn.blockCounts.get(msgId) ?? 0;
      turn.blockCounts.set(msgId, index + 1);
      const key = this.blockKey(msgId, index);
      const existing = turn.partByKey.get(key);
      if (block.type === 'thinking') {
        const text = str(block.thinking);
        let part = existing?.kind === 'thinking' ? existing : null;
        if (!part) {
          part = { kind: 'thinking', text: '', streaming: false };
          turn.partByKey.set(key, part);
          turn.parts.push(part);
        }
        if (text) part.text = text;
        part.streaming = false;
      } else if (block.type === 'text') {
        let part = existing?.kind === 'text' ? existing : null;
        if (!part) {
          part = { kind: 'text', text: '' };
          turn.partByKey.set(key, part);
          turn.parts.push(part);
        }
        part.text = str(block.text);
      } else if (block.type === 'tool_use') {
        const id = str(block.id);
        if (!id) continue;
        this.ensureTool(id, str(block.name) || 'tool', obj(block.input), turn);
        if (!existing && !turn.parts.some((p) => p.kind === 'tool' && p.toolUseId === id)) {
          const part: Part = { kind: 'tool', toolUseId: id };
          turn.partByKey.set(key, part);
          turn.parts.push(part);
        }
      }
    }
    this.touch(turn);
  }

  private onUser(e: any, live: boolean) {
    if (!this.acceptSidechain && (e.parent_tool_use_id != null || e.isSidechain === true)) return;
    const uuid = typeof e.uuid === 'string' ? e.uuid : null;
    if (uuid && this.seenUuids.has(uuid)) return;
    if (uuid) this.seenUuids.add(uuid);
    const content = e.message.content;
    if (content == null) return;
    // transcripts flag the compaction summary; the live stream sends it as a synthetic message after the boundary
    if (e.isCompactSummary === true || (e.isSynthetic === true && this.afterCompactBoundary)) {
      this.afterCompactBoundary = false;
      const text = contentText(content).trim();
      if (text) {
        // the card sits where the compaction happened: the reply so far ends above it, and whatever Claude writes
        // next (an auto-compaction continues the same turn) starts a new message below it
        const running = this.activeTurn;
        const wasStreaming = running?.isStreaming === true;
        if (running) {
          running.isStreaming = false;
          if (!running.parts.length) this.turns.splice(this.turns.indexOf(running), 1);
          else this.touch(running);
          this.activeTurn = null;
        }
        const at = parseTime(e.timestamp) ?? Date.now();
        this.turns.push({ kind: 'summary', id: `summary_${uuid ?? this.turns.length}`, text, createdAt: at, version: 0, cached: null, cachedVersion: -1 });
        if (live && wasStreaming) this.beginAssistantTurn();
      }
      if (uuid) this.lastEventUuid = uuid;
      return;
    }
    const origin = obj(e.origin);
    // a subagent's final report (SubagentHandback) goes on its Agent card
    if (origin?.kind === 'peer') {
      if (origin.handback === true) this.onHandback(origin, contentText(content));
      if (uuid) this.lastEventUuid = uuid;
      return;
    }
    // a background task ended (a subagent, a background command): its card is updated; Claude's reaction to it
    // follows in a new message, opened by a short note (the notification itself is not the user's message)
    const rawText = contentText(content).trimStart();
    if (origin?.kind === 'task-notification' || rawText.startsWith('<task-notification>')) {
      this.onTaskNotificationMessage(rawText, live, parseTime(e.timestamp));
      if (uuid) this.lastEventUuid = uuid;
      return;
    }
    let blocks: any[];
    if (typeof content === 'string') blocks = [{ type: 'text', text: content }];
    else if (Array.isArray(content)) blocks = content.filter((b) => obj(b) && typeof b.type === 'string');
    else return;

    const toolResults = blocks.filter((b) => b.type === 'tool_result');
    if (toolResults.length) {
      const structured = e.tool_use_result ?? e.toolUseResult;
      for (const r of toolResults) this.applyToolResult(r, toolResults.length === 1 ? structured : null);
      if (uuid) this.lastEventUuid = uuid;
      return;
    }
    if (e.isMeta === true) return;

    const joined = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();
    if (joined.startsWith('[Request interrupted by user')) {
      this.addNotice('Interrupted by user');
      this.endTurn();
      if (uuid) this.lastEventUuid = uuid;
      return;
    }
    if (joined.includes('<local-command-stdout>') || joined.includes('<local-command-stderr>')) {
      this.addLocalCommandOutput(joined);
      if (uuid) this.lastEventUuid = uuid;
      return;
    }
    if (joined.startsWith('<local-command-caveat>')) return;

    const id = uuid ?? `u_${this.turns.length}`;
    // files sent by path are listed in an <attached-files> block: show them as attachments, not text
    const { text: promptText, cards } = displayUserText(joined, id);
    const displayText = commandDisplay(promptText) ?? promptText.replace(CONTEXT_TAG_RE, '').trim();
    const attachments = [...blocks.map((b, i) => toAttachment(b, id, i)).filter((a): a is ChatAttachment => a != null), ...cards.map(withKind)];
    if (!displayText && !attachments.length) return;
    const createdAt = parseTime(e.timestamp) ?? Date.now();
    // a message sent while Claude was replying arrives inside that turn (at a tool boundary): the reply so far
    // stops streaming and continues in a new turn below the message
    if (live && this.activeTurn) {
      this.activeTurn.isStreaming = false;
      this.touch(this.activeTurn);
    }
    this.addUserTurn(id, displayText, attachments, createdAt, (typeof e.parentUuid === 'string' ? e.parentUuid : null) ?? this.lastEventUuid);
    this.lastEventUuid = id;
    if (live) this.beginAssistantTurn();
    else this.activeTurn = null;
  }

  private onResult(r: any) {
    const turn = this.activeTurn;
    const total = num(r.total_cost_usd);
    const turnCost = total - this.lastResultCost > 0 ? total - this.lastResultCost : null;
    if (total > 0) {
      this.lastResultCost = total;
      this.sessionCostUsd = total;
    }
    if (turn) {
      turn.isStreaming = false;
      const u = usageOf(r.usage);
      const tu = u ? toTokenUsage(u, num(r.duration_ms), turnCost) : null;
      if (tu) turn.resultUsage = tu;
      const interrupted = typeof r.terminal_reason === 'string' && r.terminal_reason.startsWith('aborted');
      if (r.is_error === true && !interrupted) {
        const errors: string[] = Array.isArray(r.errors) ? r.errors.map(String) : [];
        const msg = errors.join('\n').trim() || str(r.result).trim() || str(r.subtype);
        const custom = this.isCustomProvider();
        // a provider's rejected key is not a Claude sign-in problem
        if (!custom && /\/login|not logged in|authentication|OAuth token/i.test(msg)) this.needsLogin = true;
        // the CLI also writes the same text as a message of its own: show it once
        const last = turn.parts[turn.parts.length - 1];
        if (last?.kind === 'text' && last.text.trim() === msg.trim()) turn.parts.pop();
        turn.parts.push({ kind: 'error', title: custom ? providerErrorTitle(msg) : errorTitle(str(r.subtype), msg), message: msg });
      }
      this.touch(turn);
    }
    this.pending.clear();
    // tools that never got a result in this turn are no longer running
    for (const t of this.tools.values()) if (t.turn === turn && OPEN_STATUSES.has(t.status)) t.status = 'TERMINATED';
    this.activeTurn = null;
  }

  private onSystem(s: any) {
    switch (s.subtype) {
      case 'init':
        this.sessionModel = typeof s.model === 'string' ? s.model : this.sessionModel;
        this.permissionMode = typeof s.permissionMode === 'string' ? s.permissionMode : this.permissionMode;
        break;
      case 'status':
        if (typeof s.permissionMode === 'string') this.permissionMode = s.permissionMode;
        break;
      case 'compact_boundary':
        this.afterCompactBoundary = true;
        this.cacheInfo = this.cacheInfo ? { ...this.cacheInfo, compacted: true } : { anchorMs: Date.now(), ttlMs: 0, recacheTokens: 0, compacted: true };
        break;
      case 'permission_denied': {
        const text = str(s.message).split(' IMPORTANT:')[0].trim();
        if (text) this.addNotice(text);
        break;
      }
      case 'task_started': {
        const toolId = str(s.tool_use_id);
        if (!toolId) return;
        if (typeof s.task_id === 'string') {
          this.taskToTool.set(s.task_id, toolId);
          if (!this.agentToTool.has(s.task_id)) this.agentToTool.set(s.task_id, toolId);
        }
        const t = this.tools.get(toolId);
        if (t) {
          t.progress = `Running: ${str(s.description)}`.replace(/[:\s]+$/, '');
          this.touch(t.turn);
        }
        break;
      }
      case 'task_notification': {
        const toolId = str(s.tool_use_id) || (typeof s.task_id === 'string' ? this.taskToTool.get(s.task_id) : undefined);
        if (!toolId) return;
        const t = this.tools.get(toolId);
        if (t) {
          const status = str(s.status);
          if (t.background) this.finishBackgroundTool(t, status.toLowerCase(), str(s.summary));
          else t.progress = [status ? status.charAt(0).toUpperCase() + status.slice(1) : null, typeof s.summary === 'string' ? s.summary : null].filter(Boolean).join(': ');
          this.touch(t.turn);
        }
        break;
      }
    }
  }

  private onRateLimit(data: any) {
    const windows = obj(obj(data.rate_limit_info)?.unifiedWindows);
    if (!windows) return;
    const out: Record<string, UnifiedWindow> = {};
    for (const [k, v] of Object.entries(windows)) {
      const o = obj(v);
      if (!o) continue;
      out[k] = { utilization: num(o.utilization), resetsAt: o.resetsAt == null ? null : num(o.resetsAt) };
    }
    this.rateLimits = out;
  }

  private onControlRequest(c: any) {
    const req = obj(c.request);
    if (!req || req.subtype !== 'can_use_tool') return;
    const toolUseId = str(req.tool_use_id);
    if (!toolUseId) return;
    const toolName = str(req.tool_name) || 'tool';
    const input = obj(req.input) ?? {};
    const turn = this.activeTurn ?? this.beginAssistantTurn();
    const tool = this.ensureTool(toolUseId, toolName, input, turn);
    if (!tool.turn.parts.some((p) => p.kind === 'tool' && p.toolUseId === toolUseId)) tool.turn.parts.push({ kind: 'tool', toolUseId });
    tool.input = input;
    tool.status = toolName === 'AskUserQuestion' ? 'AWAITING_CHOICE' : 'PENDING_APPROVAL';
    this.pending.set(toolUseId, {
      requestId: str(c.request_id),
      toolUseId,
      toolName,
      input,
      suggestions: Array.isArray(req.permission_suggestions) ? req.permission_suggestions : null,
      reason: (typeof req.decision_reason === 'string' ? req.decision_reason : null) ?? (typeof req.description === 'string' ? req.description : null),
      blockedPath: typeof req.blocked_path === 'string' ? req.blocked_path : null,
    });
    this.touch(tool.turn);
  }

  // ------------------------------------------------------------------ helpers

  private recordCache(u: Usage, atMs: number) {
    const cached = u.cache_read_input_tokens + u.cache_creation_input_tokens;
    if (cached <= 0) return;
    const ttl = u.eph1h > 0 ? 3_600_000 : u.eph5m > 0 ? 300_000 : this.cacheInfo && this.cacheInfo.ttlMs > 0 ? this.cacheInfo.ttlMs : 300_000;
    this.cacheInfo = { anchorMs: atMs, ttlMs: ttl, recacheTokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, compacted: false };
  }

  private beginAssistantTurn(): AssistantTurn {
    let lastUser: UserTurn | null = null;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t.kind === 'user') {
        lastUser = t;
        break;
      }
    }
    const base = `claude_asst_${lastUser?.uuid ?? 'start'}`;
    let id = base;
    let n = 1;
    while (this.turns.some((t) => t.kind === 'assistant' && t.id === id)) id = `${base}_${n++}`;
    const turn: AssistantTurn = {
      kind: 'assistant',
      id,
      parts: [],
      partByKey: new Map(),
      blockCounts: new Map(),
      isStreaming: true,
      lastMessageUsage: null,
      model: null,
      resultUsage: null,
      createdAt: Date.now(),
      timed: false,
      version: 0,
      cached: null,
      cachedVersion: -1,
    };
    this.turns.push(turn);
    this.activeTurn = turn;
    return turn;
  }

  private addUserTurn(uuid: string, text: string, attachments: ChatAttachment[], createdAt: number, parentUuid: string | null) {
    this.seenUuids.add(uuid);
    this.turns.push({ kind: 'user', uuid, text, attachments, createdAt, stepIndex: this.stepCounter++, parentUuid, version: 0, cached: null, cachedVersion: -1 });
  }

  private ensureTool(id: string, name: string, input: Record<string, any> | null, turn: AssistantTurn): ToolState {
    const existing = this.tools.get(id);
    if (existing) {
      if (input && Object.keys(input).length) existing.input = input;
      if (name.trim()) existing.name = name;
      return existing;
    }
    const t: ToolState = { id, name, input, stepIndex: this.stepCounter++, turn, status: 'RUNNING', output: '', progress: null, exitCode: null, startedAt: Date.now(), durationMs: null };
    this.tools.set(id, t);
    return t;
  }

  private applyToolResult(r: any, structured: any) {
    const id = str(r.tool_use_id);
    const tool = id ? this.tools.get(id) : undefined;
    if (!tool) return;
    const text = contentText(r.content);
    const isError = r.is_error === true;
    if (tool.name === 'Agent' || tool.name === 'Task') {
      const st = obj(structured);
      const agentId = str(st?.agentId) || /\bagentId:\s*([\w-]+)/.exec(text)?.[1] || this.subagentsByTool.get(id)?.agentId || '';
      if (agentId) {
        tool.agentId = agentId;
        this.agentToTool.set(agentId, id);
      }
      // run_in_background: the result only says it started; the report comes later (hand-back / task notification)
      if (!isError && (st?.isAsync === true || st?.status === 'async_launched' || text.startsWith('Async agent launched'))) {
        tool.background = true;
        tool.status = 'RUNNING';
        tool.progress = 'Running in the background';
        tool.output = '';
        tool.exitCode = null;
        this.pending.delete(id);
        this.touch(tool.turn);
        return;
      }
    }
    tool.output = toolOutput(tool, text, structured);
    tool.progress = null;
    tool.status = !isError ? 'SUCCESS' : /rejected|denied|doesn't want to proceed/i.test(text) ? 'REJECTED' : 'FAILED';
    tool.exitCode = isError ? 1 : 0;
    tool.durationMs = Date.now() - tool.startedAt;
    this.pending.delete(id);
    this.touch(tool.turn);
  }

  private addNotice(text: string) {
    const last = this.turns[this.turns.length - 1];
    let turn = this.activeTurn ?? (last?.kind === 'assistant' ? last : null);
    if (!turn) {
      turn = this.beginAssistantTurn();
      turn.isStreaming = false;
    }
    turn.parts.push({ kind: 'text', text: `_${text}_` });
    this.touch(turn);
  }

  /** A subagent handed back its final report: it becomes the output of its Agent card. */
  private onHandback(origin: Record<string, any>, content: string) {
    const agentId = str(origin.from) || str(origin.senderTaskId);
    const toolId = agentId ? this.agentToTool.get(agentId) : undefined;
    const tool = toolId ? this.tools.get(toolId) : undefined;
    if (!tool) return;
    let report = typeof origin.handbackReportText === 'string' ? origin.handbackReportText : '';
    if (!report) {
      // older CLIs: the report is indented by two spaces after "The report follows:"
      const i = content.indexOf('The report follows:');
      if (i >= 0) report = content.slice(i + 'The report follows:'.length).replace(/<\/agent-message>\s*$/, '').split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n');
    }
    // the CLI's safety banner is for the parent model, not for people
    report = report.replace(/^\s*\[harness:[^\n]*\]\s*/, '').trim();
    if (!report) return;
    tool.output = report;
    tool.progress = null;
    if (tool.status === 'RUNNING') tool.status = 'SUCCESS';
    this.touch(tool.turn);
  }

  /** `<task-notification>` (a background subagent or command ended), as transcripts and replays carry it. */
  private onTaskNotificationMessage(text: string, live: boolean, at: number | null) {
    const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? '';
    const taskId = tag('task-id');
    const toolId = tag('tool-use-id') || this.taskToTool.get(taskId) || this.agentToTool.get(taskId) || '';
    const status = tag('status').toLowerCase();
    const summary = tag('summary');
    const tool = toolId ? this.tools.get(toolId) : undefined;
    if (tool) {
      this.finishBackgroundTool(tool, status, summary);
      const result = tag('result');
      // the report usually came as a hand-back already ("…delivered to you as a message…")
      if (result && !tool.output.trim() && !/^This agent's report was delivered/.test(result)) tool.output = result;
      const ms = Number(tag('duration_ms'));
      if (Number.isFinite(ms) && ms > 0) tool.durationMs = ms;
      this.touch(tool.turn);
    }
    if (live && this.activeTurn) {
      this.activeTurn.isStreaming = false;
      this.touch(this.activeTurn);
    }
    const turn = this.beginAssistantTurn();
    if (at != null) {
      turn.createdAt = at;
      turn.timed = true;
    }
    const label = summary || (status ? `Background task ${status}` : 'Background task finished');
    turn.parts.push({ kind: 'text', text: `_${label.replace(/[_*]/g, (c) => `\\${c}`)}_` });
    if (!live) turn.isStreaming = false;
    this.touch(turn);
  }

  /** A background tool's end state from a task notification ("completed", "failed", "killed"…). */
  private finishBackgroundTool(tool: ToolState, status: string, summary: string) {
    if (!status) return;
    if (status === 'completed') tool.status = 'SUCCESS';
    else if (status === 'failed' || status === 'error') tool.status = 'FAILED';
    else if (/kill|stop|cancel|abort/.test(status)) tool.status = 'TERMINATED';
    else return;
    tool.progress = null;
    if (!tool.output.trim() && summary && tool.status !== 'SUCCESS') tool.output = summary;
    tool.exitCode = tool.status === 'SUCCESS' ? 0 : 1;
  }

  private addLocalCommandOutput(raw: string) {
    const out = raw.replace(/<\/?local-command-(stdout|stderr)>/g, '').trim();
    if (!out) return;
    // a model switch ("Set model to opus (…)", "Kept model as …"): the chat's "Switched to …" divider shows it already
    if (/^(set model to|kept model as)\b/i.test(out.replace(/\x1b\[[0-9;]*m/g, ''))) return;
    // output outside a turn (e.g. a live model switch) is complete on arrival
    let turn = this.activeTurn;
    if (!turn) {
      turn = this.beginAssistantTurn();
      turn.isStreaming = false;
      this.activeTurn = null;
    }
    turn.parts.push({ kind: 'text', text: out });
    this.touch(turn);
  }

  private touch(turn: Turn) {
    turn.version++;
  }

  private blockKey(messageId: string | null, index: number) {
    return `${messageId ?? 'msg'}#${index}`;
  }

  // ------------------------------------------------------------------ output

  toChatMessages(): ChatMessage[] {
    return this.turns.map((turn) => {
      if (turn.cached && turn.cachedVersion === turn.version) return turn.cached;
      let msg: ChatMessage;
      if (turn.kind === 'user') {
        msg = {
          id: `user_${turn.uuid}`,
          conversationId: this.conversationId,
          role: 'USER',
          content: turn.text,
          toolCalls: [],
          isStreaming: false,
          attachments: turn.attachments,
          stepIndex: turn.stepIndex,
          createdAt: turn.createdAt,
        };
      } else if (turn.kind === 'assistant') {
        msg = this.assistantMessage(turn);
      } else {
        msg = {
          id: turn.id,
          conversationId: this.conversationId,
          role: 'SUMMARY',
          content: turn.text,
          contextSummary: turn.text,
          toolCalls: [],
          isStreaming: false,
          attachments: [],
          createdAt: turn.createdAt,
        };
      }
      turn.cached = msg;
      turn.cachedVersion = turn.version;
      return msg;
    });
  }

  private assistantMessage(turn: AssistantTurn): ChatMessage {
    const contentParts: string[] = [];
    const thoughts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const part of turn.parts) {
      if (part.kind === 'thinking') {
        const t = part.text.trim();
        if (t) {
          const tag = part.streaming && turn.isStreaming ? ':streaming' : '';
          contentParts.push(`<!-- thought${tag} -->\n${t}\n<!-- /thought -->`);
          thoughts.push(t);
        }
      } else if (part.kind === 'text') {
        const t = part.text.trim();
        if (t) contentParts.push(t);
      } else if (part.kind === 'tool') {
        const tool = this.tools.get(part.toolUseId);
        if (!tool || HIDDEN_TOOLS.has(tool.name)) continue;
        if (!toolCalls.some((c) => c.id === tool.id)) {
          const agentId = tool.agentId ?? this.subagentsByTool.get(tool.id)?.agentId ?? null;
          toolCalls.push({ ...toToolCall(tool), subagentConversationId: agentId ? this.subagentConversationId(agentId) : null });
          contentParts.push(`<!-- tool_call:${tool.id} -->`);
        }
      } else {
        const err = { title: part.title, userMessage: part.message, shortError: part.message, fullError: '' };
        contentParts.push(`<!-- error -->\n${JSON.stringify(err)}\n<!-- /error -->`);
      }
    }
    const base = turn.resultUsage ?? (turn.lastMessageUsage ? toTokenUsage(turn.lastMessageUsage) : null);
    const usage = base ? { ...base, model: turn.model } : null;
    const thought = thoughts.join('\n\n').trim();
    return {
      id: turn.id,
      conversationId: this.conversationId,
      role: 'ASSISTANT',
      content: contentParts.join('\n\n').trim(),
      thoughtText: thought || null,
      toolCalls,
      isStreaming: turn.isStreaming,
      tokenUsage: turn.isStreaming ? null : usage,
      attachments: [],
      createdAt: turn.createdAt,
      modelId: turn.model,
    };
  }
}

// ---------------------------------------------------------------- static helpers (the Kotlin companion object)

export function toolTypeFor(name: string): ToolType {
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') return 'BASH';
  if (name === 'Read') return 'VIEW_FILE';
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return 'EDIT_FILE';
  if (name === 'Glob') return 'FIND';
  if (name === 'Grep') return 'GREP_SEARCH';
  if (name === 'LS') return 'LIST_DIR';
  if (name === 'WebSearch') return 'SEARCH_WEB';
  if (name === 'WebFetch') return 'READ_URL';
  if (name === 'AskUserQuestion') return 'ASK_CHOICE';
  if (name.startsWith('mcp__')) return 'MCP';
  return 'UNKNOWN';
}

export function describeTool(name: string, input: Record<string, any>): string {
  const s = (k: string) => str(input[k]);
  const file = (k: string) => s(k).split('/').pop() || s(k);
  let out: string;
  switch (name) {
    case 'Bash':
      out = s('command');
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      out = file('file_path');
      break;
    case 'NotebookEdit':
      out = file('notebook_path');
      break;
    case 'Glob':
      out = s('pattern');
      break;
    case 'Grep':
      out = s('pattern') + (s('path') ? ` in ${s('path')}` : '');
      break;
    case 'WebSearch':
      out = s('query');
      break;
    case 'WebFetch':
      out = s('url');
      break;
    case 'Agent':
    case 'Task':
      out = s('description') || 'Subagent';
      break;
    case 'TodoWrite': {
      const todos: any[] = Array.isArray(input.todos) ? input.todos.filter(obj) : [];
      out = `Todo list (${todos.filter((t) => t.status === 'completed').length}/${todos.length} done)`;
      break;
    }
    case 'ExitPlanMode':
      out = 'Plan ready for review';
      break;
    case 'AskUserQuestion':
      out = str(obj(Array.isArray(input.questions) ? input.questions[0] : null)?.question) || 'Question';
      break;
    default:
      out = name.startsWith('mcp__') ? name.slice(5).replace(/__/g, ' · ') : name;
  }
  return out.trim() ? out : name;
}

export function todoChecklist(input: Record<string, any>): string {
  const todos: any[] = Array.isArray(input.todos) ? input.todos.filter(obj) : [];
  return todos.map((t) => `${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'} ${str(t.content)}`).join('\n');
}

export function questionnaireFrom(input: Record<string, any>): ChoiceQuestionnaire {
  const qs: any[] = Array.isArray(input.questions) ? input.questions : [];
  const questions = qs
    .map((q, i) => {
      if (!obj(q)) return null;
      const opts: any[] = Array.isArray(q.options) ? q.options : [];
      return {
        id: String(i + 1),
        prompt: str(q.question),
        description: typeof q.header === 'string' ? q.header : null,
        isMultiSelect: q.multiSelect === true || q.multiSelect === 'true',
        options: opts
          .map((o, j) => (obj(o) ? { id: String(j + 1), label: str(o.label), description: typeof o.description === 'string' ? o.description : null } : null))
          .filter((o): o is NonNullable<typeof o> => o != null),
        allowCustomAnswer: true,
      };
    })
    .filter((q): q is NonNullable<typeof q> => q != null);
  const header = obj(qs[0])?.header;
  return { title: typeof header === 'string' ? header : 'Claude has a question', questions, allowCustomNote: true };
}

export function contentText(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((el) => {
        if (!obj(el)) return null;
        if (el.type === 'text') return typeof el.text === 'string' ? el.text : null;
        if (el.type === 'image') return '[image]';
        return null;
      })
      .filter((x): x is string => x != null)
      .join('\n');
  }
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

function toToolCall(t: ToolState): ToolCall {
  const input = t.input ?? {};
  const shown = t.output.trim() ? t.output : t.name === 'TodoWrite' ? todoChecklist(input) : t.name === 'ExitPlanMode' ? str(input.plan) : (t.progress ?? '');
  return {
    id: t.id,
    name: t.name,
    toolType: toolTypeFor(t.name),
    command: describeTool(t.name, input),
    status: t.status,
    output: shown,
    exitCode: t.exitCode,
    durationMs: t.durationMs,
    stepIndex: t.stepIndex,
    interactionType: 'claude',
    questionnaire: t.name === 'AskUserQuestion' ? questionnaireFrom(input) : null,
  };
}

function toolOutput(tool: ToolState, text: string, structured: any): string {
  const o = obj(structured);
  switch (tool.name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const patch: any[] | null = Array.isArray(o?.structuredPatch) ? o!.structuredPatch : null;
      if (patch && patch.length) {
        return patch
          .filter(obj)
          .map((h) => {
            const lines: string[] = (Array.isArray(h.lines) ? h.lines : []).filter((l: unknown) => typeof l === 'string');
            return `@@ -${num(h.oldStart)},${num(h.oldLines)} +${num(h.newStart)},${num(h.newLines)} @@\n${lines.join('\n')}`;
          })
          .join('\n');
      }
      if (tool.name === 'Write') {
        const content = typeof o?.content === 'string' ? o.content : str(tool.input?.content);
        if (content) return content.split('\n').map((l) => `+${l}`).join('\n');
      }
      break;
    }
    case 'Bash': {
      const stdout = typeof o?.stdout === 'string' ? o.stdout : null;
      const stderr = typeof o?.stderr === 'string' ? o.stderr : null;
      if (stdout != null || stderr != null) return [stdout, stderr].filter((x): x is string => !!x).join('\n') || text;
      break;
    }
    case 'TodoWrite':
      if (tool.input) return todoChecklist(tool.input);
      break;
    case 'Agent':
    case 'Task':
      // drop the CLI's hand-back preamble so the card shows the subagent's report
      if (text.startsWith('[Subagent hand-back]')) {
        const i = text.indexOf('\n\n');
        return (i >= 0 ? text.slice(i + 2) : text).trim();
      }
      break;
  }
  return text;
}

/** A short title for an error of a custom provider ("API Error: 429 …", "Connection refused…"). */
function providerErrorTitle(msg: string): string {
  const m = /\b(?:API Error:?|HTTP|status)\s*(?:Request rejected\s*)?\(?(\d{3})\b/i.exec(msg);
  const status = m ? Number(m[1]) : null;
  if (status === 429 || /rate limit/i.test(msg)) return 'Provider rate limit';
  if (status === 401 || status === 403) return 'Provider rejected the key';
  if (status === 402 || /insufficient|balance/i.test(msg)) return 'Provider account problem';
  if (status === 404 || (status === 400 && /model/i.test(msg))) return 'Model not available';
  if ((status != null && status >= 500) || /overloaded/i.test(msg)) return 'Provider is having problems';
  if (/Connection refused|ECONN|timed out|ENOTFOUND/i.test(msg)) return 'Cannot reach the provider';
  return 'Provider error';
}

function errorTitle(subtype: string, msg: string): string {
  if (/login|auth/i.test(msg)) return 'Sign-in Required';
  if (/rate|limit/i.test(msg)) return 'Usage Limit Reached';
  if (subtype === 'error_max_turns') return 'Turn Limit Reached';
  return 'Claude Error';
}

function commandDisplay(text: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (name == null) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
  return args ? `${name} ${args}` : name;
}

/** Claude reports cache reads separately; the token pill shows prompt (uncached) + cached + output. */
function toTokenUsage(u: Usage, durationMs = 0, costUsd: number | null = null): TokenUsage | null {
  const prompt = u.input_tokens + u.cache_creation_input_tokens;
  if (prompt + u.cache_read_input_tokens + u.output_tokens === 0) return null;
  return {
    promptTokens: prompt,
    outputTokens: u.output_tokens,
    cachedTokens: u.cache_read_input_tokens,
    cacheCreationTokens: u.cache_creation_input_tokens,
    totalTokens: prompt + u.cache_read_input_tokens + u.output_tokens,
    durationMs,
    isEstimated: false,
    costUsd,
  };
}

/** A file card from the hidden attached-files list: a folder (inode/directory) or a file. */
export function withKind(a: ChatAttachment): ChatAttachment {
  if (a.kind) return a;
  return { ...a, kind: a.mimeType === 'inode/directory' ? 'folder' : a.isImage ? 'image' : 'file' };
}

function toAttachment(b: any, uuid: string, index: number): ChatAttachment | null {
  const src = obj(b.source);
  if (!src) return null;
  if (b.type === 'image') {
    return {
      id: `${uuid}_att_${index}`,
      name: `image_${index + 1}`,
      path: '',
      kind: 'image',
      isImage: true,
      isAudio: false,
      size: 0,
      mimeType: typeof src.media_type === 'string' ? src.media_type : null,
      base64: typeof src.data === 'string' ? src.data : null,
    };
  }
  if (b.type === 'document') {
    return {
      id: `${uuid}_att_${index}`,
      name: typeof b.title === 'string' ? b.title : `document_${index + 1}`,
      path: '',
      kind: 'file',
      isImage: false,
      isAudio: false,
      size: 0,
      mimeType: typeof src.media_type === 'string' ? src.media_type : null,
      base64: src.type === 'base64' && typeof src.data === 'string' ? src.data : null,
    };
  }
  return null;
}
