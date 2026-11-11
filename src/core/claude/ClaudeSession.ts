// One open Claude chat: its transcript, its bridge WebSocket (`/api/claude/session`) and its controls. Port of the
// per-chat half of the app's ClaudeChatBackend.kt (the app attaches one chat at a time; the extension keeps one of these
// per chat a view shows). Never loses output: history first, then the bridge buffer from `buffer_start_seq`, a gap in
// the sequence re-attaches from the first missing line, a dropped socket reconnects (1.5 s) with `since`, and frames
// written while disconnected wait in an outbox.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import WebSocket from 'ws';
import type { ChatAttachment, Conversation, QueuedMessage } from '../../../shared/model';
import type { QuestionView } from '../../../shared/protocol';
import type { ChatState } from '../types';
import { attachedFilesBlock, cleanTitle, displayUserText, type FileRef } from '../text';
import { ClaudeTranscript, questionnaireFrom, withKind } from './ClaudeTranscript';
import { approvalViews } from './approvals';
import { contextUsage, limitsOf, providerOf, rawModel, sameLimits, sessionState, str, type BridgeFrame, type ContextUsage, type SpawnConfig } from './protocol';
import type { ClaudeBackend } from './ClaudeBackend';

const EMIT_INTERVAL_MS = 33;
const RECONNECT_MS = 1500;
/** The start-up notice appears only when Claude Code takes longer than this to answer a sent message. */
const STARTUP_NOTICE_DELAY_MS = 4000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
/** The API takes inline images up to about 5 MB of base64. */
const INLINE_IMAGE_BYTES = 3_500_000;

interface Reply {
  subtype: string;
  request_id: string;
  response?: any;
  error?: string;
}

/** ChatState plus the fields the protocol's ChatPatch has for per-chat-model agents (see the report). */
export type ClaudeChatState = ChatState & { notice?: string | null; modelId?: string | null };

export interface NewChatControls {
  model: string;
  effort: string | null;
  thinking: boolean;
  permissionMode: string;
  modeTouched: boolean;
  controlsTouched: boolean;
}

export class ClaudeSession {
  readonly transcript = new ClaudeTranscript();
  readonly listeners = new Set<(s: ChatState) => void>();
  isLoading = false;
  error: string | null = null;
  /** A chat started here and not on the bridge's list yet. */
  localConversation: Conversation | null = null;
  /** Messages sent while Claude was replying, not delivered yet (uuid → entry). */
  readonly queued = new Map<string, QueuedMessage>();

  // ---- controls (the app keeps these per attached chat)
  model: string;
  /** null = the model's default effort. */
  effort: string | null;
  /** The effort the running process really uses (`get_settings().applied.effort`), null until known. */
  appliedEffort: string | null = null;
  thinking: boolean;
  permissionMode: string;
  /** The permission mode was changed in this chat; untouched it is left to the user's settings.json default. */
  modeTouched = false;
  /** model / effort / thinking were changed in this chat. */
  controlsTouched = false;
  contextUsage: ContextUsage | null = null;
  /** New-chat controls were applied (first send of a chat started here). */
  prepared = false;

  // ---- socket
  private ws: WebSocket | null = null;
  private socketGen = 0;
  private wantSocket = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastSeq = -1;
  processLive = false;
  private outbox: string[] = [];
  private replies = new Map<string, (r: Reply) => void>();

  // ---- notices & replay
  workingLabel: string | null = null;
  private awaitingProcess = false;
  private startupTimer: NodeJS.Timeout | null = null;
  private compacting = false;
  private retryNoticeShown = false;
  private replayUntilSeq: number | null = null;
  private replayDeadline: NodeJS.Timeout | null = null;
  private queuedRestart: string | null = null;
  private flashTimer: NodeJS.Timeout | null = null;
  /** A model of another provider was chosen in a chat with messages: waits for the user's answer (the switch chip). */
  pendingSwitch: { modelId: string; resendTokens: number | null } | null = null;
  /** The CLI's fast mode ("on" / "off"), from `system:init` / `result`. */
  fastMode: string | null = null;

  // ---- lifecycle
  /** The transcript was loaded from the bridge at least once. */
  historyLoaded = false;
  private started = false;
  private loadGen = 0;
  private emitTimer: NodeJS.Timeout | null = null;
  private disposeTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private wasActive = false;
  private closed = false;

  // ---- a chat another process writes (Claude Code in VS Code, a terminal): the bridge does not stream it
  /** "<mtime>:<size>" of the transcript the shown history was read from. */
  private diskStamp: string | null = null;
  private lastDiskChange = 0;
  private diskTimer: NodeJS.Timeout | null = null;
  private diskLoading = false;

  constructor(
    readonly id: string,
    private b: ClaudeBackend,
  ) {
    this.transcript.reset(id);
    this.transcript.isCustomProvider = () => providerOf(this.model) !== '';
    const d = b.chatDefaults;
    this.model = d.model ?? 'default';
    this.effort = d.effort;
    this.thinking = d.thinking;
    this.permissionMode = b.defaultPermissionMode;
  }

  // ------------------------------------------------------------------ listeners & emit

  addListener(l: (s: ChatState) => void) {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
    this.listeners.add(l);
    if (!this.started) this.begin();
    this.watchDisk();
    // the prompt-cache chip counts down
    if (!this.tickTimer) this.tickTimer = setInterval(() => this.transcript.cacheInfo && this.scheduleEmit(), 30_000);
    l(this.state());
  }

  removeListener(l: (s: ChatState) => void) {
    this.listeners.delete(l);
    if (!this.listeners.size) {
      // keep the socket a while (switching back and forth is instant); always close it eventually
      this.disposeTimer = setTimeout(() => this.b.dropSession(this.id), 90_000);
    }
  }

  /** First listener: a chat on the bridge's list loads its history; a new chat waits for its first message. */
  private begin() {
    if (this.b.isOnDisk(this.id)) {
      this.started = true;
      void this.loadAndAttach();
    } else if (!this.b.sessionsLoaded) {
      // the chat list is not loaded yet (a restored editor tab): decide once it is
      this.isLoading = true;
    } else {
      this.started = true;
      this.isLoading = false;
    }
  }

  /** The bridge's chat list arrived. */
  onSessionsLoaded() {
    if (!this.started && this.listeners.size) this.begin();
  }

  scheduleEmit() {
    if (this.emitTimer || this.closed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitNow();
    }, EMIT_INTERVAL_MS);
  }

  private emitNow() {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    if (this.closed) return;
    const active = this.transcript.isTurnActive;
    if (active !== this.wasActive) {
      this.wasActive = active;
      this.b.runningChanged();
    }
    if (!this.listeners.size) return;
    const s = this.state();
    for (const l of this.listeners) l(s);
  }

  state(): ClaudeChatState {
    const replaying = this.replayUntilSeq != null;
    const messages = replaying ? [] : this.transcript.toChatMessages();
    const pending = this.transcript.pendingList();
    const ask = pending.find((p) => p.toolName === 'AskUserQuestion');
    const question: QuestionView | null = ask ? { key: ask.toolUseId, agent: 'CLAUDE', questionnaire: questionnaireFrom(ask.input) } : null;
    const active = this.transcript.isTurnActive;
    const base = this.b.conversation(this.id) ?? this.localConversation;
    const conversation = base ? { ...base, isRunning: base.isRunning || active, modelId: this.model } : null;
    return {
      conversation,
      agent: 'CLAUDE',
      messages,
      isStreaming: active && !this.transcript.hasPending(),
      isLoading: (this.isLoading || replaying) && messages.length === 0,
      error: this.error,
      queued: [...this.queued.values()],
      approvals: approvalViews(pending),
      question,
      artifacts: [],
      workingLabel: this.workingLabel,
      controls: this.b.controlsFor(this),
      notice: this.notice(),
      modelId: this.model,
    };
  }

  /** One line above the controls: a provider switch waiting for an answer or for the reply to end, a lost sign-in. */
  private notice(): string | null {
    if (this.pendingSwitch) {
      const tokens = this.pendingSwitch.resendTokens ? ` (about ${Math.round(this.pendingSwitch.resendTokens / 1000)}k tokens)` : '';
      return `Switch this chat to ${this.b.modelLabel(this.pendingSwitch.modelId)}? Claude Code restarts and the whole conversation${tokens} is sent again without cache. A new chat is usually the better choice.`;
    }
    if (this.queuedRestart) return `Switches to ${this.b.modelLabel(this.queuedRestart)} after this reply`;
    if (this.transcript.needsLogin && !providerOf(this.model)) return 'Claude Code is signed out: sign in in Settings → Agents → Claude Code.';
    return null;
  }

  /** A message for the user: the host's toast when it gave one, else the chat's error line for a moment. */
  tell(level: 'info' | 'warning' | 'error', msg: string) {
    if (!this.b.notify(level, msg)) this.flash(msg);
    else this.b.log(`[claude] ${this.id.slice(0, 8)}: ${msg}`);
  }

  /** A short notice (a refused control…) in the chat's error line; it clears itself. */
  flash(msg: string) {
    this.b.log(`[claude] ${this.id.slice(0, 8)}: ${msg}`);
    this.error = msg;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      if (this.error === msg) {
        this.error = null;
        this.scheduleEmit();
      }
    }, 8000);
    this.scheduleEmit();
  }

  // ------------------------------------------------------------------ history & socket

  /** History from the transcript, then the live rest from the bridge buffer (replayed before the chat shows). */
  async loadAndAttach() {
    const gen = ++this.loadGen;
    this.started = true;
    this.isLoading = true;
    this.scheduleEmit();
    let h: any;
    try {
      h = await this.b.bridgeJson(`/api/claude/sessions/${this.id}/history`, {}, 60_000);
      if (!h?.success) throw new Error(h?.error ?? 'the bridge refused');
    } catch (e) {
      if (gen !== this.loadGen || this.closed) return;
      this.isLoading = false;
      this.error = `Cannot load Claude chat: ${e instanceof Error ? e.message : String(e)}`;
      this.scheduleEmit();
      return;
    }
    if (gen !== this.loadGen || this.closed) return;
    this.error = null;
    this.historyLoaded = true;
    this.diskStamp = stampOf(h);
    this.transcript.reset(this.id);
    for (const entry of Array.isArray(h.entries) ? h.entries : []) this.transcript.applyHistory(entry);
    this.transcript.finishHistory();
    const st = sessionState(h.state);
    this.lastSeq = st.buffer_start_seq - 1;
    this.processLive = st.live;
    // resuming a chat continues on the model it last used (a running process is checked once attached)
    if (!this.controlsTouched) {
      if (typeof h.model_ref === 'string' && h.model_ref.trim()) this.model = h.model_ref;
      else if (providerOf(this.model)) this.model = this.b.chatDefaults.model ?? 'default';
    }
    if (!st.live && !this.controlsTouched && this.transcript.sessionModel) this.selectResolvedModel(this.transcript.sessionModel);
    const newest = st.next_seq - 1;
    if (st.live && newest >= st.buffer_start_seq) {
      // the rest of the chat is in the bridge buffer: keep loading until it is replayed (shown once, complete)
      this.replayUntilSeq = newest;
      if (this.replayDeadline) clearTimeout(this.replayDeadline);
      // safety net only: the replay normally ends within a moment
      this.replayDeadline = setTimeout(() => this.finishReplay(), 3000);
    } else {
      this.finishReplay();
    }
    this.connect(st.buffer_start_seq);
  }

  /**
   * While a view shows the chat: polls the transcript's size / time and subagents (cheap, no history read) and
   * reloads the history when another process wrote the chat; every 3 s while it changes or a subagent works, else 15 s.
   */
  private watchDisk() {
    if (this.diskTimer || this.closed || !this.listeners.size) return;
    const busy = Date.now() - this.lastDiskChange < 5 * 60_000;
    // a working subagent is polled fast even while our own process streams the chat (its rows and state live on disk)
    const fast = this.b.hasRunningSubagents(this.id) || (busy && !this.processLive);
    this.diskTimer = setTimeout(() => void this.checkDisk(), fast ? 3_000 : 15_000);
  }

  private async checkDisk() {
    this.diskTimer = null;
    if (this.closed || !this.listeners.size) return;
    try {
      // a chat started here never loads a history, but its subagents still need polling once it is on disk
      if ((this.historyLoaded || this.started) && this.b.isOnDisk(this.id)) {
        const r = await this.b.bridgeJson(`/api/claude/sessions/${this.id}/subagents`, {}, 15_000);
        if (r?.success && !this.closed) {
          this.b.applySessionSubagents(this.id, Array.isArray(r.subagents) ? r.subagents : []);
          const stamp = stampOf(r);
          if (stamp && stamp !== this.diskStamp) {
            this.lastDiskChange = Date.now();
            // the bridge's own process streams its output; only another process' writes need a reload
            if (!this.processLive && !this.wantsOwnTurn()) await this.reloadFromDisk();
            else this.diskStamp = stamp;
          }
        }
      }
    } catch {
      // the bridge is down: the backend shows that
    }
    this.watchDisk();
  }

  /** A prompt of ours is on its way: its process will stream the turn (no reload under it). */
  private wantsOwnTurn(): boolean {
    return this.transcript.isTurnActive || this.awaitingProcess || this.outbox.length > 0 || this.queued.size > 0;
  }

  /** Shows the transcript as another process left it (the same history read as opening the chat). */
  private async reloadFromDisk() {
    if (this.diskLoading || this.isLoading) return;
    this.diskLoading = true;
    try {
      const h = await this.b.bridgeJson(`/api/claude/sessions/${this.id}/history`, {}, 60_000);
      if (!h?.success || this.closed || this.processLive || this.wantsOwnTurn()) return;
      // the bridge runs it now: its stream has the rest
      if (sessionState(h.state).live) return;
      this.diskStamp = stampOf(h);
      this.transcript.reset(this.id);
      for (const entry of Array.isArray(h.entries) ? h.entries : []) this.transcript.applyHistory(entry);
      this.transcript.finishHistory();
      this.emitNow();
    } finally {
      this.diskLoading = false;
    }
  }

  private finishReplay() {
    this.replayUntilSeq = null;
    if (this.replayDeadline) clearTimeout(this.replayDeadline);
    this.replayDeadline = null;
    this.isLoading = false;
    this.emitNow();
    this.b.indexChat(this.id, this.transcript.toChatMessages());
  }

  /** Connects (or keeps connecting) from the first line not seen yet. */
  ensureConnected() {
    if (!this.wantSocket) this.connect(this.lastSeq + 1);
  }

  get attached(): boolean {
    return this.wantSocket;
  }

  private spawnConfig(): SpawnConfig {
    const conv = this.b.conversation(this.id) ?? this.localConversation;
    const uri = conv?.workspaceUri ?? '';
    const cwd = uri ? decodeURIComponent(uri.replace(/^file:\/\//, '')) : '';
    return {
      cwd: cwd || undefined,
      // always explicit, so the process runs exactly what the controls show ("default" clears an older choice)
      model: this.model || 'default',
      permission_mode: this.modeTouched ? this.permissionMode : undefined,
      effort: this.effort ?? 'default',
      thinking: this.thinking ? 'on' : 'off',
    };
  }

  private connect(since: number) {
    this.wantSocket = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const gen = ++this.socketGen;
    const old = this.ws;
    this.ws = null;
    old?.close();
    const q = new URLSearchParams({ id: this.id, since: String(since) });
    for (const [k, v] of Object.entries(this.spawnConfig())) if (v) q.set(k, v);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.b.wsUrl(`/api/claude/session?${q}`), { headers: this.b.authHeaders() });
    } catch (e) {
      this.b.log(`[claude] socket ${this.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
      this.reconnectTimer = setTimeout(() => gen === this.socketGen && !this.closed && this.connect(this.lastSeq + 1), RECONNECT_MS);
      return;
    }
    ws.on('open', () => {
      if (gen !== this.socketGen) {
        ws.close();
        return;
      }
      this.ws = ws;
      while (this.outbox.length && ws.readyState === WebSocket.OPEN) ws.send(this.outbox.shift()!);
    });
    ws.on('message', (data) => {
      if (gen !== this.socketGen) return;
      let frame: BridgeFrame;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      this.handleFrame(frame);
    });
    ws.on('error', (e) => this.b.log(`[claude] socket ${this.id.slice(0, 8)}: ${e.message}`));
    ws.on('close', () => {
      if (gen !== this.socketGen) return;
      this.ws = null;
      if (this.closed || !this.wantSocket) return;
      this.reconnectTimer = setTimeout(() => {
        if (gen === this.socketGen && !this.closed && this.wantSocket) this.connect(this.lastSeq + 1);
      }, RECONNECT_MS);
    });
  }

  private closeSocket() {
    this.wantSocket = false;
    this.socketGen++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private handleFrame(frame: BridgeFrame) {
    switch (frame.type) {
      case 'bridge_line': {
        const seq = frame.seq;
        if (typeof seq !== 'number' || seq <= this.lastSeq) return;
        if (this.lastSeq >= 0 && seq > this.lastSeq + 1) {
          // frames were lost on the way: attach again from the first missing one (the bridge buffer still has it),
          // otherwise e.g. a lost `result` leaves the turn running forever
          this.b.log(`[claude] ${this.id.slice(0, 8)}: missed frames ${this.lastSeq + 1}..${seq - 1}, re-attaching`);
          this.connect(this.lastSeq + 1);
          return;
        }
        this.lastSeq = seq;
        const data = frame.data && typeof frame.data === 'object' ? frame.data : null;
        const isReply = data?.type === 'control_response';
        if (isReply) this.deliverReply(data);
        const type = data && !isReply ? this.transcript.applyLive(data) : '';
        // a queued message was delivered (its replay, or command_lifecycle started / completed / cancelled)
        if (type === 'command_lifecycle') {
          if (data.state !== 'queued' && typeof data.command_uuid === 'string') this.dequeue(data.command_uuid);
        } else if (type === 'user' && typeof data.uuid === 'string') this.dequeue(data.uuid);
        if (this.replayUntilSeq != null) {
          // old output being replayed while the chat opens: no side effects, show it once at the end.
          // Every buffered line counts, control replies included (often the newest line).
          if (seq >= this.replayUntilSeq) this.finishReplay();
          return;
        }
        if (!data || isReply) return;
        if (this.awaitingProcess && type !== 'stream_event' && type !== 'rate_limit_event' && type !== 'command_lifecycle') {
          this.awaitingProcess = false;
          this.clearStartupNotice();
        }
        if (this.retryNoticeShown && (type === 'stream_event' || type === 'assistant' || type === 'result')) {
          this.retryNoticeShown = false;
          this.workingLabel = null;
        }
        // a subagent was started: its drawer row shows within seconds, not on the next list refresh
        if (type === 'assistant' && Array.isArray(data.message?.content) && data.message.content.some((c: any) => c?.type === 'tool_use' && (c.name === 'Agent' || c.name === 'Task')))
          this.b.pollSubagentsSoon(this.id);
        if (type === 'result') {
          if (this.queuedRestart) {
            const m = this.queuedRestart;
            this.queuedRestart = null;
            this.restartOn(m);
          }
          this.endCompactingNotice();
          if (typeof data.fast_mode_state === 'string') this.fastMode = data.fast_mode_state;
          // a lost sign-in: the account state changed
          if (this.transcript.needsLogin) void this.b.loadStatus();
          void this.requestTitleOnce();
          this.b.afterTurn(this.id);
          this.b.indexChat(this.id, this.transcript.toChatMessages());
          void this.refreshContextUsage();
        } else if (type === 'rate_limit_event') {
          this.b.onLiveRateLimits(this.transcript.rateLimits);
        } else if (type === 'system') {
          switch (data.subtype) {
            case 'api_retry':
              this.showRetryNotice(data);
              break;
            case 'session_title_changed': {
              const title = cleanTitle(str(data.title)).trim();
              if (title) this.b.setTitle(this.id, title);
              break;
            }
            case 'init':
              this.processLive = true;
              if (typeof data.fast_mode_state === 'string') this.fastMode = data.fast_mode_state;
              if (this.transcript.permissionMode) this.permissionMode = this.transcript.permissionMode;
              // confirm what the process really runs
              void this.syncApplied();
              break;
            case 'status':
              if (this.transcript.permissionMode) this.permissionMode = this.transcript.permissionMode;
              if (data.status === 'compacting') {
                this.compacting = true;
                this.workingLabel = 'Compacting the conversation…';
              } else this.endCompactingNotice();
              break;
            case 'compact_boundary':
              this.endCompactingNotice();
              break;
          }
        }
        this.scheduleEmit();
        return;
      }
      case 'bridge_state': {
        const st = sessionState(frame.state);
        this.processLive = st.live;
        switch (frame.event) {
          case 'attached':
            if (this.lastSeq >= 0 && this.lastSeq + 1 < st.buffer_start_seq && this.b.isOnDisk(this.id)) {
              // output was dropped from the buffer while we were away: reload from the transcript
              // (a chat not written to disk yet keeps what it shows)
              void this.loadAndAttach();
              return;
            }
            // no process and nothing sent on this connection: a turn shown as running is over (the process exited
            // while we were away). A just-sent message starts the process itself.
            if (!st.live && this.transcript.isTurnActive && !this.awaitingProcess) this.transcript.endTurn();
            if (this.replayUntilSeq != null && st.next_seq - 1 <= this.lastSeq) this.finishReplay();
            // a running process may use other settings than this chat last showed
            if (st.live) void this.syncApplied();
            break;
          case 'spawned':
            // only when the start-up notice is already shown (a slow start)
            if (this.awaitingProcess && this.workingLabel != null) this.workingLabel = 'Claude Code is starting…';
            break;
          case 'exited': {
            this.awaitingProcess = false;
            this.clearStartupNotice();
            if (this.replayUntilSeq != null) this.finishReplay();
            this.failReplies('Claude process exited');
            this.dropQueued('Claude Code stopped before it was delivered.');
            const code = typeof frame.exit_code === 'number' ? frame.exit_code : 0;
            if (this.transcript.isTurnActive || code !== 0) {
              if (code !== 0) this.transcript.addError('Claude Code stopped', frame.error?.trim() || `The claude process exited with code ${code}.`);
              this.transcript.endTurn();
            }
            break;
          }
        }
        this.scheduleEmit();
        return;
      }
      case 'bridge_error': {
        const err = str(frame.error);
        this.awaitingProcess = false;
        this.clearStartupNotice();
        if (this.replayUntilSeq != null) this.finishReplay();
        this.failReplies(err);
        this.dropQueued(err);
        const notFound = /not found/i.test(err);
        this.transcript.addError(
          notFound ? 'Claude Code is not installed' : 'Claude Code unavailable',
          notFound ? `${err}\n\nInstall it from Settings → Agents → Claude Code → Claude Code CLI.` : err,
        );
        this.transcript.endTurn();
        this.scheduleEmit();
        return;
      }
    }
  }

  // ------------------------------------------------------------------ notices

  /** "Provider rate limit (HTTP 429). Retrying in 18s · attempt 6 of 10" from a `system/api_retry` line. */
  private showRetryNotice(data: any) {
    const attempt = Number(data.attempt);
    if (!Number.isFinite(attempt)) return;
    const max = Number.isFinite(Number(data.max_retries)) ? Number(data.max_retries) : null;
    const delaySec = Math.floor((Number(data.retry_delay_ms ?? 0) + 999) / 1000);
    const status = Number.isFinite(Number(data.error_status)) && data.error_status != null ? Number(data.error_status) : null;
    const reason =
      status === 429
        ? 'rate limit (HTTP 429)'
        : status === 401 || status === 403
          ? `the key was rejected (HTTP ${status})`
          : status === 402
            ? 'payment or balance problem (HTTP 402)'
            : status != null && status >= 500
              ? `the provider is having problems (HTTP ${status})`
              : status != null
                ? `HTTP ${status}`
                : 'cannot reach the provider';
    this.retryNoticeShown = true;
    this.workingLabel = `Provider error: ${reason}. Retrying in ${delaySec}s · attempt ${attempt}${max != null ? ` of ${max}` : ''}`;
  }

  private clearStartupNotice() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.compacting = false;
    this.workingLabel = null;
  }

  private endCompactingNotice() {
    if (!this.compacting) return;
    this.compacting = false;
    this.workingLabel = null;
  }

  private dequeue(uuid: string) {
    if (this.queued.delete(uuid)) this.scheduleEmit();
  }

  /** The process is gone: the queued messages were never delivered. */
  private dropQueued(reason: string) {
    if (!this.queued.size) return;
    const dropped = [...this.queued.values()];
    this.queued.clear();
    this.transcript.addError(
      dropped.length === 1 ? 'Queued message not sent' : `${dropped.length} queued messages not sent`,
      `${reason}\n\n${dropped.map((q) => `• ${q.text.slice(0, 120)}`).join('\n')}`,
    );
  }

  // ------------------------------------------------------------------ writing

  private sendRaw(text: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
    else this.outbox.push(text);
  }

  private deliverReply(data: any) {
    const r = data?.response;
    const id = typeof r?.request_id === 'string' ? r.request_id : '';
    const w = this.replies.get(id);
    if (w) w({ subtype: str(r.subtype), request_id: id, response: r.response, error: typeof r.error === 'string' ? r.error : undefined });
  }

  private failReplies(error: string) {
    for (const w of [...this.replies.values()]) w({ subtype: 'error', request_id: '', error });
    this.replies.clear();
  }

  /** Sends a control request and waits for its reply (null on timeout). The bridge starts the process if needed. */
  request(body: Record<string, unknown>, timeoutMs = 30_000): Promise<Reply | null> {
    const id = `app_${randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.replies.delete(id);
        resolve(null);
      }, timeoutMs);
      this.replies.set(id, (r) => {
        clearTimeout(timer);
        this.replies.delete(id);
        resolve(r);
      });
      this.sendRaw(JSON.stringify({ type: 'control_request', request_id: id, request: body }));
    });
  }

  private sendControl(body: Record<string, unknown>) {
    this.sendRaw(JSON.stringify({ type: 'control_request', request_id: `app_${randomUUID()}`, request: body }));
  }

  private respond(requestId: string, result: Record<string, unknown>) {
    const clean = Object.fromEntries(Object.entries(result).filter(([, v]) => v !== undefined && v !== null));
    this.sendRaw(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: clean } }));
  }

  // ------------------------------------------------------------------ prompts

  /** Starts a chat started here with the new-chat controls (the first send of a chat not on the bridge yet). */
  prepareNewChat(c: NewChatControls) {
    if (this.prepared) return;
    this.prepared = true;
    this.model = c.model;
    this.effort = c.effort;
    this.thinking = c.thinking;
    this.permissionMode = c.permissionMode;
    this.modeTouched = c.modeTouched;
    this.controlsTouched = c.controlsTouched;
  }

  /**
   * Sends a prompt. Images (≤ 3.5 MB) go inline so Claude sees them; other files go by path in the hidden
   * attached-files block (Claude opens them in place). While Claude replies, the CLI queues the message and delivers
   * it at the next tool boundary (or as the next turn); its replay adds it to the chat then.
   */
  sendPrompt(text: string, atts: ChatAttachment[]) {
    const { blocks, fullText, images } = buildBlocks(text, atts);
    const uuid = randomUUID();
    this.error = null;
    const frame = JSON.stringify({ type: 'user', uuid, session_id: '', parent_tool_use_id: null, message: { role: 'user', content: blocks } });
    const { text: shown, cards } = displayUserText(fullText, uuid);
    const display = shown || (images.length ? 'Image' : 'Attachment');
    if (this.processLive && this.transcript.isTurnActive) {
      this.queued.set(uuid, { id: uuid, text: display, attachmentCount: atts.length, canSendNow: true, canDelete: false, isPending: false });
      this.ensureConnected();
      this.sendRaw(frame);
      this.scheduleEmit();
      return;
    }
    this.transcript.addLocalUserMessage(uuid, display, [...images, ...cards.map(withKind)]);
    if (!this.processLive) {
      this.awaitingProcess = true;
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = setTimeout(() => {
        if (this.awaitingProcess) {
          this.workingLabel = 'Starting Claude Code…';
          this.scheduleEmit();
        }
      }, STARTUP_NOTICE_DELAY_MS);
    }
    this.scheduleEmit();
    this.ensureConnected();
    this.sendRaw(frame);
  }

  /** A prompt the extension answered itself: shown with its reply, never sent to Claude. */
  localExchange(prompt: string, reply: string) {
    this.transcript.addLocalExchange(`local_${randomUUID()}`, prompt, reply);
    this.scheduleEmit();
  }

  interrupt() {
    if (!this.wantSocket || (!this.processLive && !this.awaitingProcess)) {
      // nothing runs this chat: a turn shown as running is over
      this.transcript.endTurn();
      this.scheduleEmit();
      return;
    }
    this.sendControl({ subtype: 'interrupt' });
  }

  // ------------------------------------------------------------------ approvals & questions

  private respondTool(toolUseId: string, build: (p: { input: Record<string, any>; toolUseId: string; suggestions: any[] | null }) => [Record<string, unknown>, string]) {
    const p = this.transcript.pendingFor(toolUseId);
    if (!p) return;
    const [result, status] = build(p);
    this.ensureConnected();
    this.respond(p.requestId, result);
    this.transcript.markPermissionAnswered(p.toolUseId, status, status === 'REJECTED' ? (result.message as string | undefined) : null);
    this.scheduleEmit();
  }

  /** Allow; [suggestion] ≥ 0 also remembers that one of the CLI's permission suggestions (a rule, a folder, a mode). */
  allowTool(toolUseId: string, suggestion: number) {
    this.respondTool(toolUseId, (p) => {
      const s = suggestion >= 0 ? p.suggestions?.[suggestion] : undefined;
      return [{ behavior: 'allow', updatedInput: p.input, updatedPermissions: s ? [s] : undefined, toolUseID: p.toolUseId }, 'RUNNING'];
    });
  }

  denyTool(toolUseId: string, reason: string | undefined, interrupt = false) {
    this.respondTool(toolUseId, (p) => [
      { behavior: 'deny', message: reason?.trim() || 'User rejected this tool call.', interrupt: interrupt || undefined, toolUseID: p.toolUseId },
      'REJECTED',
    ]);
  }

  /** Plan approval: allow ExitPlanMode, then switch to [nextMode] ("acceptEdits", "default", "auto"). */
  approvePlan(toolUseId: string, nextMode: string) {
    this.respondTool(toolUseId, (p) => [{ behavior: 'allow', updatedInput: p.input, toolUseID: p.toolUseId }, 'RUNNING']);
    void this.setPermissionMode(nextMode);
  }

  /** Plan rejected: Claude keeps planning with the feedback. */
  keepPlanning(toolUseId: string, feedback: string | undefined) {
    this.denyTool(toolUseId, feedback?.trim() || 'The user wants you to keep planning. Revise the plan before calling ExitPlanMode again.');
  }

  /** AskUserQuestion answered: question text → picked labels (and typed answers), joined with ", ". */
  answerQuestion(toolUseId: string, answers: Record<string, string>, summary: string) {
    const p = this.transcript.pendingFor(toolUseId);
    if (!p) return;
    this.ensureConnected();
    this.respond(p.requestId, { behavior: 'allow', updatedInput: { ...p.input, answers }, toolUseID: p.toolUseId });
    this.transcript.markPermissionAnswered(p.toolUseId, 'RUNNING', summary);
    this.scheduleEmit();
  }

  skipQuestion(toolUseId: string) {
    this.respondTool(toolUseId, (p) => [{ behavior: 'deny', message: 'The user skipped the question. Continue with your best judgement.', toolUseID: p.toolUseId }, 'RUNNING']);
  }

  // ------------------------------------------------------------------ controls

  /**
   * Applies a chat control. With a running process it is sent live and the CLI's answer is checked: a refused
   * change is reverted (and shown), an accepted one is confirmed with get_settings. Without a process it is a spawn
   * option of the next start (no process is started); before the chat is connected the socket's query covers it.
   */
  private async applyControl(live: Record<string, unknown> | null, spawn: SpawnConfig, what: string, revert: () => void, configureLive = false) {
    this.scheduleEmit();
    if (!this.wantSocket) return;
    if (!this.processLive || configureLive) this.sendRaw(JSON.stringify({ type: 'bridge_config', ...spawn }));
    if (!this.processLive || !live) return;
    const reply = await this.request(live, 15_000);
    if (!reply) this.tell('warning', `Claude Code did not confirm the ${what} change`);
    else if (reply.subtype === 'error') {
      revert();
      this.tell('warning', `Claude Code refused the ${what} change: ${reply.error ?? 'unknown error'}`);
    } else await this.syncApplied();
    this.scheduleEmit();
  }

  /** default (Manual) | acceptEdits | plan | auto | dontAsk */
  setPermissionMode(mode: string) {
    const prev = this.permissionMode;
    this.modeTouched = true;
    this.permissionMode = mode;
    return this.applyControl({ subtype: 'set_permission_mode', mode }, { permission_mode: mode }, 'mode', () => (this.permissionMode = prev));
  }

  /** level: low | medium | high | xhigh | max, or null for the model default. */
  setEffort(level: string | null) {
    const prev = this.effort;
    this.controlsTouched = true;
    this.effort = level;
    return this.applyControl({ subtype: 'apply_flag_settings', settings: { effortLevel: level } }, { effort: level ?? 'default' }, 'effort', () => (this.effort = prev));
  }

  setThinking(on: boolean) {
    const prev = this.thinking;
    this.controlsTouched = true;
    this.thinking = on;
    // a custom provider gets a thinking budget only when its page sets one (many providers reject the parameter)
    const pid = providerOf(this.model);
    const p = pid ? this.b.provider(pid) : undefined;
    const budget = !pid ? 31999 : p ? limitsOf(p, rawModel(this.model)).thinkingBudget : 0;
    const live = on && budget === 0 ? null : { subtype: 'set_max_thinking_tokens', max_thinking_tokens: on ? budget : 0, ...(on ? { thinking_display: 'summarized' } : {}) };
    return this.applyControl(live, { thinking: on ? 'on' : 'off' }, 'thinking', () => (this.thinking = prev));
  }

  selectModel(modelId: string) {
    const prev = this.model;
    if (providerOf(modelId) !== providerOf(prev)) {
      // the endpoint is fixed when the process starts: another provider means a new process (the chat resumes from
      // its transcript). In a chat with messages that resends everything without cache: ask first (the switch chip).
      if (!this.transcript.isEmpty || this.b.isOnDisk(this.id)) {
        this.pendingSwitch = {
          modelId,
          resendTokens: (this.contextUsage?.totalTokens ?? 0) > 0 ? this.contextUsage!.totalTokens : (this.transcript.cacheInfo?.recacheTokens ?? 0) > 0 ? this.transcript.cacheInfo!.recacheTokens : null,
        };
        this.tell('warning', `Switching this chat to ${this.b.modelLabel(modelId)} restarts Claude Code and resends the whole conversation without cache. Confirm with the "Switch provider?" chip.`);
        this.scheduleEmit();
        return;
      }
      this.switchProvider(modelId);
      return;
    }
    const pid = providerOf(modelId);
    if (pid) {
      // context window, output limit and thinking budget are fixed when the process starts
      const p = this.b.provider(pid);
      if (p && !sameLimits(limitsOf(p, rawModel(modelId)), limitsOf(p, rawModel(prev)))) {
        this.tell('info', `${this.b.modelLabel(modelId)} has other limits: the chat restarts to apply them`);
        this.switchProvider(modelId);
        return;
      }
    }
    this.controlsTouched = true;
    this.model = modelId;
    // keep the effort valid for the new model
    const levels = this.b.modelInfo(modelId)?.supportedEffortLevels ?? [];
    if (this.effort != null && levels.length && !levels.includes(this.effort)) void this.setEffort(null);
    // a provider's process knows its models by their own id; the bridge remembers the chat's model for its next start
    void this.applyControl({ subtype: 'set_model', model: rawModel(modelId) }, { model: modelId }, 'model', () => (this.model = prev), true);
  }

  /** The answer to a pending provider switch: 'switch' (this chat), 'new' (the next new chat uses it), 'cancel'. */
  answerSwitch(answer: string) {
    const sw = this.pendingSwitch;
    if (!sw) return;
    this.pendingSwitch = null;
    if (answer === 'switch') this.switchProvider(sw.modelId);
    else if (answer === 'new') this.tell('info', `Start a new chat (+): it uses ${this.b.modelLabel(sw.modelId)}`);
    this.scheduleEmit();
  }

  private switchProvider(modelId: string) {
    this.controlsTouched = true;
    this.model = modelId;
    if (providerOf(modelId)) this.effort = null;
    if (this.transcript.isTurnActive) {
      this.queuedRestart = modelId;
      this.tell('info', `Switches to ${this.b.modelLabel(modelId)} after this reply`);
      this.scheduleEmit();
      return;
    }
    this.restartOn(modelId);
    this.scheduleEmit();
  }

  private restartOn(modelId: string) {
    // not connected: the next connect sends the new model
    if (!this.wantSocket && !this.processLive) return;
    this.sendRaw(JSON.stringify({ type: 'bridge_restart', model: modelId, effort: this.effort ?? 'default' }));
  }

  /** Reads what the running process really uses (`get_settings().applied`) and shows that in the controls. */
  async syncApplied() {
    if (!this.processLive || !this.wantSocket) return;
    const r = await this.request({ subtype: 'get_settings' }, 15_000);
    const applied = r?.response?.applied;
    if (!applied || typeof applied !== 'object') return;
    if (typeof applied.model === 'string') this.selectResolvedModel(applied.model);
    this.appliedEffort = typeof applied.effort === 'string' ? applied.effort : null;
    if (this.effort != null && this.appliedEffort && this.appliedEffort !== this.effort) this.effort = this.appliedEffort;
    this.scheduleEmit();
  }

  /** Shows the model alias that runs [resolved] (a full id like `claude-opus-5-5`); keeps a choice that resolves to it. */
  selectResolvedModel(resolved: string) {
    const pid = providerOf(this.model);
    if (pid) {
      // a router (openrouter/free) reports the model it picked, which is not one of the provider's models: keep the choice
      const known = this.b.provider(pid)?.models.some((m) => m.id === resolved) === true;
      if (known && rawModel(this.model) !== resolved) this.model = `@${pid}/${resolved}`;
      return;
    }
    const infos = this.b.modelInfos();
    const current = infos.find((m) => m.value === this.model);
    if (current && (current.value === resolved || current.resolvedModel === resolved)) return;
    const match =
      infos.find((m) => m.value === resolved) ?? infos.find((m) => m.resolvedModel === resolved && m.value !== 'default') ?? infos.find((m) => m.resolvedModel === resolved);
    this.model = match?.value ?? resolved;
  }

  /** Context window usage of the running process (`get_context_usage`), with a custom model's real window. */
  async refreshContextUsage(): Promise<ContextUsage | null> {
    if (!this.processLive || !this.wantSocket) return this.contextUsage;
    const r = await this.request({ subtype: 'get_context_usage' });
    const c = contextUsage(r?.response);
    if (c) {
      const window = this.b.contextLengthOf(this.model);
      this.contextUsage =
        window > 0
          ? {
              ...c,
              maxTokens: window,
              percentage: (c.totalTokens * 100) / window,
              categories: c.categories.map((k) => (/^free space/i.test(k.name) ? { ...k, tokens: Math.max(0, window - c.totalTokens) } : k)),
            }
          : c;
      this.scheduleEmit();
    }
    return this.contextUsage;
  }

  /**
   * Claude Code names a chat only when its client asks. After the first reply of a new chat, ask once: the title is
   * saved in the chat's transcript, where the bridge's chat list reads it.
   */
  private async requestTitleOnce() {
    const prompts = this.transcript.toChatMessages().filter((m) => m.role === 'USER');
    if (prompts.length !== 1 || this.b.titleAsked.has(this.id)) return;
    this.b.titleAsked.add(this.id);
    const first = prompts[0];
    const typed = cleanTitle(first.content).trim();
    const files = first.attachments.map((a) => a.name).filter(Boolean);
    const description = [typed || null, files.length ? `Attached files: ${files.join(', ')}` : null].filter(Boolean).join('\n').slice(0, 2000);
    if (!description) return;
    const r = await this.request({ subtype: 'generate_session_title', description, persist: true }, 60_000);
    const title = cleanTitle(str(r?.response?.title)).trim();
    if (!title) {
      this.b.log(`[claude] no title for ${this.id.slice(0, 8)}: ${r?.error ?? 'no reply'}`);
      return;
    }
    this.b.setTitle(this.id, title);
  }

  // ------------------------------------------------------------------ edit / regenerate (rewind)

  /**
   * Restores the files Claude changed since the prompt [userUuid] from its file checkpoints (`rewind_files`, the app's
   * rewindFilesLocked). The bridge starts the process if needed. null = no answer.
   */
  async rewindFiles(userUuid: string, dryRun = false): Promise<{ canRewind: boolean; error: string | null; filesChanged: string[]; insertions: number; deletions: number } | null> {
    this.ensureConnected();
    const reply = await this.request({ subtype: 'rewind_files', user_message_id: userUuid, dry_run: dryRun });
    if (!reply) return null;
    const r = reply.response && typeof reply.response === 'object' ? reply.response : {};
    return {
      canRewind: r.canRewind === true,
      error: typeof r.error === 'string' ? r.error : reply.subtype === 'error' ? (reply.error ?? 'refused') : null,
      filesChanged: Array.isArray(r.filesChanged) ? r.filesChanged.map(String) : [],
      insertions: Number(r.insertions) || 0,
      deletions: Number(r.deletions) || 0,
    };
  }

  /**
   * Cuts the chat right before the prompt [userUuid] on the bridge (like the CLI's rewind: the bridge stops the
   * process and the next one resumes at the entry before that prompt), then reloads it. Listeners stay attached.
   */
  async rewindBefore(userUuid: string) {
    // the bridge stops the process: its last frames belong to the old branch
    this.closeSocket();
    this.outbox = [];
    this.failReplies('chat rewound');
    this.queued.clear();
    this.queuedRestart = null;
    this.awaitingProcess = false;
    this.clearStartupNotice();
    this.isLoading = true;
    this.scheduleEmit();
    try {
      const r = await this.b.bridgeSend('POST', `/api/claude/sessions/${this.id}/rewind`, { before: userUuid }, 30_000);
      if (!r?.success) throw new Error(r?.error ?? 'the bridge refused');
    } finally {
      // rewound or not, show the chat as the bridge has it now
      this.processLive = false;
      this.appliedEffort = null;
      this.contextUsage = null;
      await this.loadAndAttach();
    }
  }

  // ------------------------------------------------------------------ teardown

  close() {
    if (this.diskTimer) clearTimeout(this.diskTimer);
    this.diskTimer = null;
    this.closed = true;
    this.closeSocket();
    this.outbox = [];
    this.failReplies('chat closed');
    for (const t of [this.emitTimer, this.disposeTimer, this.startupTimer, this.replayDeadline, this.flashTimer]) if (t) clearTimeout(t);
    if (this.tickTimer) clearInterval(this.tickTimer);
  }
}

/** The prompt's content blocks, the text as sent (with the hidden file list) and the inline images (for the bubble). */
function buildBlocks(text: string, atts: ChatAttachment[]): { blocks: any[]; fullText: string; images: ChatAttachment[] } {
  const images: any[] = [];
  const imageAtts: ChatAttachment[] = [];
  const refs: FileRef[] = [];
  const notes: string[] = [];
  for (const a of atts) {
    // an editor selection reaches the message as text (the host adds it)
    if (a.kind === 'selection') continue;
    const mime = (a.mimeType ?? '').toLowerCase();
    // a folder goes by path like a file (Claude opens it in place)
    if (a.kind === 'folder' || mime === 'inode/directory') {
      if (a.path) refs.push({ path: a.path, mimeType: 'inode/directory', size: 0 });
      continue;
    }
    if (a.isImage && IMAGE_TYPES.has(mime)) {
      let b64 = a.base64 ?? null;
      try {
        if (!b64 && a.path && fs.statSync(a.path).size <= INLINE_IMAGE_BYTES) b64 = fs.readFileSync(a.path).toString('base64');
      } catch {
        /* sent by path below */
      }
      if (b64 && (b64.length * 3) / 4 <= INLINE_IMAGE_BYTES) {
        images.push({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } });
        imageAtts.push({ ...a, base64: b64 });
        continue;
      }
    }
    if (a.path) {
      let size = a.size;
      try {
        size = size || fs.statSync(a.path).size;
      } catch {
        /* keep */
      }
      refs.push({ path: a.path, mimeType: a.mimeType ?? '', size });
    } else notes.push(`[Attachment ${a.name} could not be sent]`);
  }
  const body = [...notes, text.trim()].filter(Boolean).join('\n\n');
  const fullText = refs.length ? `${body || 'Attachment'}\n\n${attachedFilesBlock(refs)}` : body;
  const blocks: any[] = [...images];
  if (fullText.trim() || !blocks.length) blocks.push({ type: 'text', text: fullText.trim() ? fullText : ' ' });
  return { blocks, fullText, images: imageAtts };
}

/** "<mtime>:<size>" of a transcript, from a bridge reply (history / subagents), or null. */
function stampOf(r: any): string | null {
  return typeof r?.updated_at === 'number' && typeof r?.size_bytes === 'number' && r.updated_at > 0 ? `${r.updated_at}:${r.size_bytes}` : null;
}
