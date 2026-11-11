// Antigravity (agy) backend: the hub's gRPC API through the bridge-managed hub, like the Android app's AgyChatBackend.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AiModel, ChatAttachment, ChatMessage, Conversation, QueuedMessage, ToolCall } from '../../../shared/model';
import type { AgentStatus, ApprovalChoiceView, ApprovalView, ModelsState, QuestionView, SlashCommandView } from '../../../shared/protocol';
import type { AgentBackend, BackendChange, ChatState, KeyValueStore, Logger, SendRequest } from '../types';
import type { BridgeManager } from '../bridge/BridgeManager';
import { GrpcClient, GrpcError } from './grpc';
import { HubRpc, decodeAs, encodeAs, lengthDelimited, patchMessage, rawFields } from './proto';
import { CLIENT_MSG_TAG_PREFIX, TrajectoryEngine, interactionTypeOf } from './trajectory';
import { attachedFilesBlock, cleanTitle, collapseExpansions } from '../text';
import { baseName, pathToUri, uriToPath } from '../paths';
import { agySlashCommands, applyQuota, modelKey, parseQuotaSummary, type QuotaGroup } from './quota';
import { AgySettings } from './AgySettings';

const EMIT_INTERVAL_MS = 33;
const DEFAULT_PROJECT_ID = 'default-cli-project';
/** Status detail when agy itself is missing (the hub can't start without it). */
export const AGY_NOT_INSTALLED = "agy is not installed. Install it from Settings → Antigravity → Account & CLI.";
const IDLE = 'CASCADE_RUN_STATUS_IDLE';
const MEDIA_MAX = 8 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };

const isNumericEnum = (id: string) => /^\d+$/.test(id);
const enumValue = (id: string) => (isNumericEnum(id) ? Number(id) : id);
const tsMillis = (ts: any): number | null => (ts ? Number(ts.seconds ?? 0) * 1000 + Math.floor(Number(ts.nanos ?? 0) / 1e6) : null);
const toFileUri = pathToUri;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const stamp = () => {
  const now = Date.now();
  return { seconds: Math.floor(now / 1000), nanos: (now % 1000) * 1e6 };
};

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A sleep the session can cut short (hub back online, Retry). */
function wakeableSleep(ms: number): { done: Promise<void>; wake: () => void } {
  let wake: () => void = () => undefined;
  const done = new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    wake = () => {
      clearTimeout(t);
      r();
    };
  });
  return { done, wake };
}

/** The app's error titles for a message that could not be delivered (executeStream). */
function deliveryErrorTitle(err: string): string {
  if (/auth/i.test(err)) return 'Authentication Required';
  if (/quota|credit|429/i.test(err)) return 'Quota Limit Exceeded';
  if (/model not found/i.test(err)) return 'Model Not Found';
  if (/connect|network/i.test(err)) return 'Server Connection Error';
  return 'Message Delivery Error';
}

/** Readable text of a chat (drawer deep search): prompts and replies, without the inline markers. */
function chatText(msgs: ChatMessage[]): string {
  return msgs
    .map((m) =>
      m.content
        .replace(/<!-- thought[^>]*-->[\s\S]*?<!-- \/thought -->/g, ' ')
        .replace(/<!-- error[^>]*-->[\s\S]*?<!-- \/error -->/g, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' '),
    )
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------------------------------------------------ hub media

/**
 * Port of the app's HubMediaResolver: images the chat refers to by path (generated images, attachments saved as hub
 * artifacts) become data: URLs the webview can show. A file on this machine is read directly, anything else through
 * the hub's ReadFile. Kept in RAM.
 */
class HubMedia {
  private cache = new Map<string, string | null>();
  private loading = new Map<string, Array<() => void>>();
  private gen = 0;
  private views = new WeakMap<ChatMessage, { gen: number; out: ChatMessage }>();

  constructor(private b: AgyBackend) {}

  static pathOf(uri: string): string {
    return uriToPath(uri.trim());
  }

  /** A path or file URI (not a web link, not already data). */
  static isLocal(uri: string): boolean {
    const u = uri.trim();
    return u.startsWith('file:') || path.isAbsolute(u);
  }

  /** Forget failed reads (the hub came back: try again). */
  retryFailed() {
    for (const [k, v] of [...this.cache]) if (v == null) this.cache.delete(k);
    this.gen++;
  }

  /** The data URL when known; undefined while it loads (onReady fires when it arrives); null when unreadable. */
  resolve(uri: string, onReady: () => void): string | null | undefined {
    const key = HubMedia.pathOf(uri);
    if (!key) return null;
    if (this.cache.has(key)) return this.cache.get(key);
    const waiting = this.loading.get(key);
    if (waiting) {
      waiting.push(onReady);
      return undefined;
    }
    this.loading.set(key, [onReady]);
    void this.load(key).then((v) => {
      this.cache.set(key, v);
      this.gen++;
      const w = this.loading.get(key) ?? [];
      this.loading.delete(key);
      for (const f of w) f();
    });
    return undefined;
  }

  private async load(p: string): Promise<string | null> {
    const mime = IMAGE_MIME[path.extname(p).slice(1).toLowerCase()] ?? 'image/png';
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return st.size <= MEDIA_MAX ? `data:${mime};base64,${fs.readFileSync(p).toString('base64')}` : null;
    } catch {
      /* not on this machine: ask the hub */
    }
    try {
      const r = await this.b.callHub('ReadFile', { uri: toFileUri(p) }, 30_000);
      const b64: string = r.content ?? '';
      if (b64 && (b64.length * 3) / 4 <= MEDIA_MAX) return `data:${mime};base64,${b64}`;
    } catch (e) {
      this.b.log(`[agy] media ${p}: ${errText(e)}`);
    }
    return null;
  }

  private needs(m: ChatMessage): boolean {
    return (
      m.toolCalls.some((t) => t.toolType === 'GENERATE_IMAGE' && t.status !== 'RUNNING' && HubMedia.isLocal(t.output)) ||
      m.attachments.some((a) => a.isImage && !a.base64 && !!a.path && HubMedia.isLocal(a.path))
    );
  }

  /** The messages with every resolvable image inlined (unchanged messages keep their identity). */
  apply(msgs: ChatMessage[], onReady: () => void): ChatMessage[] {
    return msgs.map((m) => {
      if (!this.needs(m)) return m;
      const cached = this.views.get(m);
      if (cached && cached.gen === this.gen) return cached.out;
      let changed = false;
      const toolCalls = m.toolCalls.map((t): ToolCall => {
        if (t.toolType !== 'GENERATE_IMAGE' || t.status === 'RUNNING' || !HubMedia.isLocal(t.output)) return t;
        const d = this.resolve(t.output, onReady);
        if (!d) return t;
        changed = true;
        return { ...t, output: d };
      });
      const attachments = m.attachments.map((a): ChatAttachment => {
        if (!a.isImage || a.base64 || !a.path || !HubMedia.isLocal(a.path)) return a;
        const d = this.resolve(a.path, onReady);
        if (!d) return a;
        changed = true;
        return { ...a, base64: d.slice(d.indexOf(',') + 1), mimeType: d.slice(5, d.indexOf(';')) };
      });
      const out = changed ? { ...m, toolCalls, attachments } : m;
      this.views.set(m, { gen: this.gen, out });
      return out;
    });
  }
}

// ------------------------------------------------------------------------------------------------ session

/** One open chat: its trajectory engine and live stream. */
class AgySession {
  readonly engine = new TrajectoryEngine();
  listeners = new Set<(s: ChatState) => void>();
  isLoading = true;
  error: string | null = null;
  /** Message sent and not yet confirmed by the stream (shows the reply spinner at once). */
  optimisticTag: string | null = null;
  private optimisticTimer: NodeJS.Timeout | null = null;
  localQueued = new Map<string, QueuedMessage>();
  hiddenQueuedIds = new Set<string>();
  /** Known to the hub (StartCascade done or listed in summaries). */
  knownOnHub = false;
  /** StartCascade in flight (a second message waits for it instead of starting the chat twice). */
  starting: Promise<void> | null = null;
  localConversation: Conversation | null = null;
  /** The live stream delivered a frame (its run state wins over the summary's, as the app's StreamRunState). */
  hasFrames = false;
  private ac: AbortController | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;
  private disposeTimer: NodeJS.Timeout | null = null;
  private streaming = false;
  private closed = false;
  /** Abort the current stream and connect again at once (resync, hub restart, Retry). */
  private restart = false;
  /** Abort the current stream and stop (the chat was deleted). */
  private halted = false;
  private wake: (() => void) | null = null;

  constructor(
    readonly id: string,
    private backend: AgyBackend,
  ) {
    this.engine.reset(id);
    this.engine.modelDisplayName = (m) => backend.modelName(m);
  }

  setOptimistic(tag: string | null) {
    if (this.optimisticTimer) clearTimeout(this.optimisticTimer);
    this.optimisticTimer = null;
    this.optimisticTag = tag;
    if (tag) {
      // safety net only: the stream normally confirms within a moment
      this.optimisticTimer = setTimeout(() => {
        if (this.optimisticTag === tag) {
          this.optimisticTag = null;
          this.scheduleEmit();
        }
      }, 30_000);
    }
  }

  addListener(l: (s: ChatState) => void) {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
    this.listeners.add(l);
    if (!this.streaming && (this.knownOnHub || this.backend.isListed(this.id))) this.startStream();
    else if (!this.knownOnHub && !this.backend.isListed(this.id)) this.isLoading = false;
    l(this.state());
  }

  removeListener(l: (s: ChatState) => void) {
    this.listeners.delete(l);
    if (!this.listeners.size) {
      // keep the stream a while (switching back and forth is instant); always close it eventually
      this.disposeTimer = setTimeout(() => this.backend.dropSession(this.id), 90_000);
    }
  }

  scheduleEmit() {
    if (this.emitTimer || this.closed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (!this.listeners.size) return;
      const s = this.state();
      for (const l of this.listeners) l(s);
    }, EMIT_INTERVAL_MS);
  }

  /**
   * The app's isCurrentChatActivelyRunning / isCurrentChatBackgroundActive: the live stream's state when it has one,
   * else the summary's. A message sent while either is true is queued for when the agent is done.
   */
  busy(): { running: boolean; background: boolean } {
    const conv = this.backend.conversation(this.id) ?? this.localConversation;
    const running = this.optimisticTag != null || (this.hasFrames ? this.engine.isRunning : !!conv?.isRunning);
    const background = !running && ((this.hasFrames && !this.engine.fullyIdle) || !!conv?.isRunning || !!conv?.notFullyIdle || !!conv?.hasActivity);
    return { running, background };
  }

  state(): ChatState {
    const messages = this.backend.media.apply(this.engine.toChatMessages(this.id), () => this.scheduleEmit());
    const running = this.engine.isRunning && !this.engine.isWaitingInteraction;
    // every pending approval of the chat (the app's pendingApprovals: all replies, one per step)
    const seen = new Set<number>();
    const pending: ToolCall[] = [];
    let asking: ToolCall | undefined;
    for (const m of messages) {
      if (m.role !== 'ASSISTANT') continue;
      for (const t of m.toolCalls) {
        if (t.status === 'PENDING_APPROVAL' && t.toolType !== 'ASK_CHOICE' && !seen.has(t.stepIndex ?? -1)) {
          seen.add(t.stepIndex ?? -1);
          pending.push(t);
        }
        if (t.status === 'AWAITING_CHOICE' && t.questionnaire) asking = t;
      }
    }
    const conv = this.backend.conversation(this.id) ?? this.localConversation;
    const modelId = this.backend.chatModel(this.id);
    return {
      conversation: conv && modelId && conv.modelId !== modelId ? { ...conv, modelId } : (conv ?? null),
      agent: 'AGY',
      messages,
      isStreaming: running || this.optimisticTag != null,
      isLoading: this.isLoading && messages.length === 0,
      error: this.error,
      queued: this.queued(),
      approvals: pending.map((t) => approvalView(t, this.engine.activeStep(t.stepIndex ?? Number(t.id)))),
      question: asking ? ({ key: asking.id, agent: 'AGY', questionnaire: asking.questionnaire! } satisfies QuestionView) : null,
      artifacts: this.engine.artifacts,
      workingLabel: null,
      notice: this.backend.noticeFor(this),
      modelId,
    };
  }

  queued(): QueuedMessage[] {
    const server = this.engine.queuedMessages();
    const serverIds = new Set(server.map((e) => e.id));
    for (const id of [...this.hiddenQueuedIds]) if (!serverIds.has(id)) this.hiddenQueuedIds.delete(id);
    const serverTags = new Set(server.flatMap((e) => e.tags));
    // listed by the daemon now (or already delivered): no longer pending here
    for (const tag of [...this.localQueued.keys()]) if (serverTags.has(tag) || this.engine.hasSeenClientTag(tag)) this.localQueued.delete(tag);
    return [
      ...server
        .filter((e) => !this.hiddenQueuedIds.has(e.id))
        .map((e) => ({
          id: e.id,
          text: e.text,
          attachmentCount: e.media.length,
          // NEXT_INVOCATION ones are being delivered right now
          canSendNow: e.deliveryStrategy !== 'MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION',
          canDelete: true,
          isPending: false,
        })),
      ...this.localQueued.values(),
    ];
  }

  startStream() {
    if (this.streaming || this.closed) return;
    this.streaming = true;
    this.halted = false;
    void this.streamLoop();
  }

  private async streamLoop() {
    let backoff = 1000;
    while (!this.closed) {
      const ac = new AbortController();
      this.ac = ac;
      let gotFrame = false;
      let rehydrate = false;
      let failure: unknown = null;
      this.lastFrameAt = Date.now();
      const watchdog = setInterval(() => {
        // the hub's own rule: stream says RUNNING, summary says idle, nothing for a while → stale; resubscribe
        const conv = this.backend.conversation(this.id);
        const silent = Date.now() - this.lastFrameAt;
        if (this.engine.isRunning && !this.optimisticTag && conv && !conv.isRunning && silent >= 9_000) {
          rehydrate = true;
          ac.abort();
        }
      }, 1000);
      try {
        const rpc = await this.backend.rpcReady();
        await rpc.stream(
          'StreamAgentStateUpdates',
          { conversation_id: this.id, subscriber_id: randomUUID(), trajectory_verbosity: 'CLIENTTRAJECTORYVERBOSITY_CLIENT_TRAJECTORY_VERBOSITY_PROD_UI' },
          (resp: any) => {
            this.lastFrameAt = Date.now();
            const historyChunk = !gotFrame;
            gotFrame = true;
            this.hasFrames = true;
            backoff = 1000;
            if (resp.update) this.engine.ingestAgentStateUpdate(resp.update);
            this.knownOnHub = true;
            this.isLoading = false;
            this.error = null;
            // the sent message started (loop running) or already finished (its step is there)
            if (this.optimisticTag && (this.engine.isRunning || this.engine.hasSeenClientTag(this.optimisticTag))) this.setOptimistic(null);
            if (historyChunk) this.backend.adoptChatModel(this.id, this.engine.toChatMessages(this.id));
            this.scheduleEmit();
          },
          ac.signal,
        );
      } catch (e) {
        failure = e;
      } finally {
        clearInterval(watchdog);
      }
      if (this.closed) break;
      if (this.halted) {
        this.halted = false;
        break;
      }
      if (rehydrate || this.restart) {
        this.restart = false;
        continue;
      }
      // no live stream any more: the summary decides the run state again
      this.hasFrames = false;
      if (failure) {
        if (failure instanceof GrpcError && failure.isAuth) this.backend.invalidateCsrf();
        const msg = errText(failure);
        this.backend.log(`[agy] stream ${this.id.slice(0, 8)}: ${msg}`);
        this.isLoading = false;
        if (!this.engine.toChatMessages(this.id).length) {
          this.error = /connect/i.test(msg) ? 'Cannot connect to Antigravity. Make sure Antigravity is running and tap Retry.' : `Error loading conversation: ${msg}`;
        }
        if (this.engine.isRunning) this.engine.cancelRunning();
        this.scheduleEmit();
        // the hub has no history for this chat (deleted, or listed from another install): asking again won't help
        if (failure instanceof GrpcError && failure.code === 5) {
          this.isLoading = false;
          if (!this.engine.toChatMessages(this.id).length) this.error = "Antigravity can't find this chat's history (it may have been deleted). Tap Retry to try again.";
          this.scheduleEmit();
          break;
        }
      } else if (!gotFrame) {
        this.isLoading = false;
        if (!this.engine.toChatMessages(this.id).length && this.backend.isListed(this.id)) this.error = 'No messages received from Antigravity. Tap Retry.';
        this.scheduleEmit();
      }
      // the hub ends a stream on restart or idle; reconnect while someone watches
      if (!this.listeners.size) break;
      const pause = wakeableSleep(backoff);
      this.wake = pause.wake;
      await pause.done;
      this.wake = null;
      backoff = Math.min(backoff * 2, 10_000);
    }
    this.streaming = false;
  }

  /** Drops what the engine has and re-reads the chat from the hub (after a revert). */
  resync() {
    this.engine.reset(this.id, true);
    this.hasFrames = false;
    this.isLoading = true;
    this.scheduleEmit();
    this.reconnect();
  }

  /** Connects the stream again right away (hub restarted, Retry). */
  reconnect() {
    if (this.closed) return;
    if (this.streaming) {
      if (this.wake) this.wake();
      else {
        this.restart = true;
        this.ac?.abort();
      }
    } else if (this.listeners.size && (this.knownOnHub || this.backend.isListed(this.id))) this.startStream();
  }

  /** Ensures a live stream (after a send to a chat that had none). */
  ensureStream() {
    if (!this.streaming) this.startStream();
    else this.wake?.();
  }

  /** Stops streaming without closing (the chat was deleted on the hub; a new message starts it again). */
  halt() {
    if (!this.streaming) return;
    this.halted = true;
    this.ac?.abort();
    this.wake?.();
  }

  close() {
    this.closed = true;
    this.ac?.abort();
    this.wake?.();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    if (this.optimisticTimer) clearTimeout(this.optimisticTimer);
  }
}

// ------------------------------------------------------------------------------------------------ approvals

const SCOPES: Record<string, string> = {
  once: 'PERMISSION_SCOPE_ONCE',
  conversation: 'PERMISSION_SCOPE_CONVERSATION',
  project: 'PERMISSION_SCOPE_PROJECT',
  global: 'PERMISSION_SCOPE_GLOBAL',
};

const ALWAYS_CHOICES: ApprovalChoiceView[] = [
  { id: 'conversation', label: 'For this conversation', description: "Don't ask again in this chat" },
  { id: 'project', label: 'In this workspace', description: "Don't ask again in this project" },
  { id: 'global', label: 'Everywhere', description: "Don't ask again anywhere" },
];

/** The approval card of a waiting step (the app's agyApprovalItems), shaped by what the hub asks for. */
function approvalView(t: ToolCall, step: any): ApprovalView {
  let [icon, title] =
    t.toolType === 'BASH'
      ? ['terminal', 'Run a command?']
      : t.toolType === 'EDIT_FILE'
        ? ['edit', 'Edit a file?']
        : ['VIEW_FILE', 'LIST_DIR', 'FIND', 'GREP_SEARCH'].includes(t.toolType)
          ? ['file', 'Read files?']
          : t.toolType === 'SEARCH_WEB'
            ? ['web', 'Search the web?']
            : t.toolType === 'READ_URL'
              ? ['web', 'Open a web page?']
              : t.toolType === 'GENERATE_IMAGE'
                ? ['image', 'Generate an image?']
                : t.toolType === 'MCP'
                  ? ['mcp', `Use ${t.name.split('__').pop()}?`]
                  : ['shield', `Allow ${t.name}?`];
  const body = t.command.trim() ? t.command : t.output;
  const ri = step?.requested_interaction ?? {};
  const type = interactionTypeOf(step);
  let always: ApprovalChoiceView[] = [];
  let reason: string | null = null;
  let target: string | null = null;
  let markdown: string | null = null;
  let primary: ApprovalChoiceView = { id: 'once', label: 'Allow' };
  let denyLabel = 'Deny';
  let denyPlaceholder = 'Tell Antigravity what to do instead (optional)';
  if (type === 'permission') {
    const spec = ri.permission ?? {};
    reason = spec.reason || spec.action_description || null;
    // the hub may limit how long an approval can last
    const filter: string[] = (spec.approval_scope_filter ?? []).map(String);
    always = ALWAYS_CHOICES.filter((c) => !filter.length || filter.includes(SCOPES[c.id]));
  } else if (type === 'file_permission') {
    const spec = ri.file_permission ?? {};
    icon = 'file';
    title = spec.is_directory ? 'Open a folder outside the workspace?' : 'Open a file outside the workspace?';
    target = uriToPath(String(spec.absolute_path_uri ?? '')) || null;
    always = ALWAYS_CHOICES;
    denyPlaceholder = '';
  } else if (type === 'elicitation') {
    const spec = ri.elicitation ?? {};
    icon = 'mcp';
    title = `${spec.server_name || 'An MCP server'} asks for your input`;
    markdown = spec.message || null;
    target = spec.url || null;
    primary = { id: 'once', label: 'Accept' };
    denyLabel = 'Decline';
    denyPlaceholder = '';
  } else if (type === 'deploy') {
    icon = 'web';
    title = 'Deploy?';
    denyLabel = 'Cancel';
    denyPlaceholder = '';
  } else {
    // a confirm-only interaction: no "always" scopes, no deny reason
    denyPlaceholder = '';
  }
  return {
    key: t.id,
    agent: 'AGY',
    icon,
    title,
    subtitle: t.name,
    target,
    preview: t.toolType === 'BASH' ? `$ ${body}` : body,
    markdown,
    reason,
    primary,
    secondary: [],
    always,
    denyLabel,
    denyPlaceholder,
  };
}

// ------------------------------------------------------------------------------------------------ backend

export class AgyBackend implements AgentBackend {
  readonly kind = 'AGY' as const;
  readonly settings: AgySettings;
  readonly media: HubMedia;
  private convs = new Map<string, Conversation>();
  private sessions = new Map<string, AgySession>();
  private changeListeners = new Set<(w: BackendChange) => void>();
  private modelList: AiModel[] = [];
  private quotaGroups: QuotaGroup[] = [];
  private refreshing = false;
  private slash: SlashCommandView[] = agySlashCommands(null);
  private countdownTimer: NodeJS.Timeout | null = null;
  private quotaAfterRunTimer: NodeJS.Timeout | null = null;
  /** The model the user last picked (the saved default): new chats start on it. */
  private selectedModel: string | null;
  /** The model each chat was last given (the app's chatModels): the pill shows it, messages use it. */
  private chatModels = new Map<string, string>();
  private hubState: AgentStatus['state'] = 'starting';
  private hubDetail: string | null = 'Starting Antigravity…';
  private csrf = '';
  private rpc: HubRpc;
  private client: GrpcClient;
  private started = false;
  private disposed = false;
  private summariesAc: AbortController | null = null;
  private readyWaiters: Array<() => void> = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private notifyFn: (level: 'info' | 'warning' | 'error', message: string) => void = () => undefined;
  /** Per chat, from the summaries: raw ConversationAnnotations bytes (archive writes them back whole). */
  private rawAnnotations = new Map<string, Uint8Array>();
  /** Per chat, from the summaries: the hub's summary text and background work. */
  private summaryInfo = new Map<string, { summary: string; backgroundTasks: number; subagents: boolean }>();
  /** Text of chats opened in this run (drawer deep search), newest last. */
  private textIndex = new Map<string, string>();

  constructor(
    private bridge: BridgeManager,
    readonly store: KeyValueStore,
    readonly log: Logger,
    private opts: { openUrl: (url: string) => void; openFile?: (path: string) => void } = { openUrl: () => undefined },
  ) {
    this.settings = new AgySettings(this);
    this.media = new HubMedia(this);
    this.client = new GrpcClient({ baseUrl: bridge.hubUrl, headers: (): Record<string, string> => (this.csrf ? { 'x-codeium-csrf-token': this.csrf } : {}) });
    this.rpc = new HubRpc(this.client);
    this.selectedModel = store.get<string>('agy.model') ?? null;
  }

  // ---------- status & connection ----------

  status(): AgentStatus {
    const signedIn = this.settings.signedIn();
    // agy itself missing (the bridge's CLI check) while the hub is down: that is why
    const installed = this.settings.cliInstalled();
    const missing = this.hubState !== 'online' && installed === false;
    // the hub stopped for a missing agy that is there now (installed in a terminal): it starts with the bridge
    const installedSince = this.hubState === 'not_installed' && installed === true;
    const state: AgentStatus['state'] = missing ? 'not_installed' : installedSince ? 'error' : this.hubState;
    const detail =
      state === 'not_installed'
        ? AGY_NOT_INSTALLED
        : installedSince
          ? 'agy is installed now: restart the bridge (Settings → Bridge & connection) to start Antigravity.'
          : this.hubState === 'online' && signedIn === false
            ? 'Not signed in'
            : this.hubDetail;
    return {
      kind: 'AGY',
      label: 'Antigravity',
      state,
      detail,
      account: this.settings.accountLabel(),
      version: this.settings.cliVersion(),
      plan: this.settings.planLabel(),
      setupPage: 'agy.cli',
    };
  }

  /** The hub answers now, or within `ms` while it is starting (settings pages wait at most that long). */
  async waitOnline(ms: number): Promise<boolean> {
    const ready = () => this.hubState === 'online' && !!this.csrf;
    const starting = () => this.hubState === 'starting' || (this.hubState === 'online' && !this.csrf);
    const end = Date.now() + ms;
    while (!ready() && starting() && Date.now() < end) await new Promise((r) => setTimeout(r, 150));
    return ready();
  }

  onChange(cb: (w: BackendChange) => void) {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }
  private changed(w: BackendChange) {
    for (const l of this.changeListeners) l(w);
  }

  setNotifier(notify: (level: 'info' | 'warning' | 'error', message: string) => void) {
    this.notifyFn = notify;
  }

  /** A toast in every view (sign-in results, a queued message that could not be sent…). */
  notify(level: 'info' | 'warning' | 'error', message: string) {
    this.notifyFn(level, message);
  }

  start() {
    if (this.started) return;
    this.started = true;
    void this.connectLoop();
  }

  /** Retry (connection banner / bridge restarted): every stream, the lists and the account are read again. */
  retry() {
    for (const s of this.sessions.values())
      if (s.error) {
        s.error = null;
        s.scheduleEmit();
      }
    this.csrf = '';
    void this.pollHub().then(() => {
      if (this.hubState === 'online') this.reconnectAll();
    });
  }

  private setHub(state: AgentStatus['state'], detail: string | null) {
    if (state === this.hubState && detail === this.hubDetail) return;
    const wasOnline = this.hubState === 'online';
    this.hubState = state;
    this.hubDetail = detail;
    this.changed('status');
    if (state === 'online' && !wasOnline) {
      this.readyWaiters.splice(0).forEach((r) => r());
      this.onHubOnline();
    } else if (wasOnline && state !== 'online') {
      // the hub stopped: nothing runs any more (as the app on "stopped")
      let any = false;
      for (const [id, c] of this.convs)
        if (c.isRunning) {
          this.convs.set(id, { ...c, isRunning: false });
          any = true;
        }
      if (any) this.changed('conversations');
    }
    for (const s of this.sessions.values()) if (s.listeners.size) s.scheduleEmit();
  }

  private async connectLoop() {
    try {
      await this.bridge.ensureRunning();
    } catch (e) {
      this.setHub('error', errText(e));
    }
    const tick = async () => {
      if (this.disposed) return;
      await this.pollHub();
      this.pollTimer = setTimeout(tick, this.hubState === 'online' ? 15_000 : 2_000);
    };
    await tick();
  }

  private lastCliCheck = 0;

  private async pollHub() {
    // the installed agy (version, or missing) is read again now and then while the hub is down, and on each restart
    if (this.hubState !== 'online' && Date.now() - this.lastCliCheck > 20_000) {
      this.lastCliCheck = Date.now();
      void this.settings.refreshCli();
    }
    try {
      if (this.bridge.state !== 'running') await this.bridge.ensureRunning();
      const hs = await this.bridge.hubStatus();
      this.hubDataDir = hs.dataDir || 'antigravity-cli';
      if (hs.status === 'online' && hs.csrfToken) {
        if (hs.csrfToken !== this.csrf) {
          // a new token while online: the hub restarted under us (its streams are gone)
          const restarted = this.csrf !== '' && this.hubState === 'online';
          this.csrf = hs.csrfToken;
          this.client.close();
          if (restarted) {
            this.log('[agy] hub restarted: reconnecting');
            this.reconnectAll();
          }
        }
        this.setHub('online', null);
      } else if (hs.status === 'error' && /not installed/i.test(hs.error)) {
        // "agy is not installed at … (install it in the app: …)": say where to install it here
        this.setHub('not_installed', AGY_NOT_INSTALLED);
      } else if (hs.status === 'error') {
        this.setHub('error', hs.error || 'Antigravity hub error');
      } else if (hs.status === 'starting' || hs.status === 'idle' || (hs.status === 'online' && !hs.csrfToken)) {
        this.setHub('starting', 'Starting Antigravity…');
      } else {
        this.setHub('offline', hs.error || 'Antigravity hub is not running');
      }
    } catch (e) {
      this.bridge.state = 'stopped';
      this.setHub('offline', `Bridge not reachable: ${errText(e)}`);
    }
  }

  invalidateCsrf() {
    this.csrf = '';
    this.hubState = 'starting';
    void this.pollHub();
  }

  /** The RPC client once the hub is online (waits up to 30 s). */
  async rpcReady(): Promise<HubRpc> {
    if (this.hubState === 'online' && this.csrf) return this.rpc;
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        new Promise<void>((r) => this.readyWaiters.push(r)),
        new Promise<void>((_r, reject) => {
          timer = setTimeout(() => reject(new Error(this.hubDetail ?? 'Antigravity is not running')), 30_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.rpc;
  }

  private async call<T = any>(name: string, req: object, timeoutMs?: number): Promise<T> {
    const rpc = await this.rpcReady();
    try {
      return await rpc.call<T>(name, req, timeoutMs);
    } catch (e) {
      if (e instanceof GrpcError && e.isAuth) {
        this.invalidateCsrf();
        const rpc2 = await this.rpcReady();
        return rpc2.call<T>(name, req, timeoutMs);
      }
      throw e;
    }
  }

  // ---------- helpers for the settings pages ----------

  callHub<T = any>(name: string, req: object, timeoutMs?: number): Promise<T> {
    return this.call<T>(name, req, timeoutMs);
  }

  /** Unary call with already-encoded request bytes (writes that must keep the hub's other fields). */
  async callHubRaw(name: string, request: Uint8Array, timeoutMs?: number): Promise<Buffer> {
    const rpc = await this.rpcReady();
    try {
      return await rpc.callRaw(name, request, timeoutMs);
    } catch (e) {
      if (e instanceof GrpcError && e.isAuth) {
        this.invalidateCsrf();
        return (await this.rpcReady()).callRaw(name, request, timeoutMs);
      }
      throw e;
    }
  }

  /** The account or the installed agy changed: the agents list (drawer, Accounts) shows it. */
  notifyStatus() {
    this.changed('status');
  }

  bridgeJson<T = any>(p: string, init: RequestInit = {}): Promise<T> {
    return this.bridge.json<T>(p, init);
  }

  openUrl(url: string) {
    this.opts.openUrl(url);
  }

  /** Opens a file in the editor (SKILL.md…); falls back to the system handler. */
  openFile(p: string) {
    if (this.opts.openFile) this.opts.openFile(p);
    else this.opts.openUrl(toFileUri(p));
  }

  notifySettings() {
    this.changed('settings');
  }

  notifyModels() {
    this.changed('models');
  }

  /** The account changed (signed in / out): models, limits and skills belong to it. */
  afterSignIn() {
    void this.loadModels(true);
    void this.loadQuota(true);
    void this.loadCommands();
    this.changed('status');
    for (const s of this.sessions.values()) if (s.listeners.size) s.scheduleEmit();
  }

  /** The folder skills of the "Workspace" scope come from: the project picked for new chats, else the latest chat's. */
  workspaceHint(): string | null {
    const last = this.store.get<{ lastProject?: unknown }>('ui.prefs')?.lastProject;
    if (typeof last === 'string' && last) return toFileUri(last);
    const recent = [...this.convs.values()].filter((c) => c.workspaceUri).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent) return toFileUri(recent.workspaceUri);
    return this.bridge.opts.workspaceDir ? toFileUri(this.bridge.opts.workspaceDir) : null;
  }

  private onHubOnline() {
    if (!this.countdownTimer) {
      // the reset countdowns ("2h 4m") tick down
      this.countdownTimer = setInterval(() => {
        if (this.quotaGroups.length) this.changed('models');
      }, 60_000);
    }
    // the hub (re)started: the agy it runs may be a new one (installed, updated)
    void this.settings.refreshCli();
    this.reconnectAll();
  }

  /** Hub (re)connected: lists, account and every open chat's stream again (the app's "online" handling). */
  private reconnectAll() {
    void this.loadModels();
    void this.loadQuota();
    void this.loadCommands();
    void this.settings.refreshAuth();
    void this.settings.syncUserSettings();
    this.media.retryFailed();
    this.summariesAc?.abort();
    this.summariesAc = null;
    this.startSummaries();
    for (const s of this.sessions.values()) if (s.listeners.size) s.reconnect();
  }

  // ---------- conversations ----------

  conversations(): Conversation[] {
    const list = [...this.convs.values()];
    for (const s of this.sessions.values()) if (s.localConversation && !this.convs.has(s.id)) list.push(s.localConversation);
    return list;
  }

  conversation(id: string): Conversation | undefined {
    return this.convs.get(id);
  }

  isListed(id: string): boolean {
    return this.convs.has(id);
  }

  private startSummaries() {
    if (this.summariesAc) return;
    const ac = new AbortController();
    this.summariesAc = ac;
    void (async () => {
      let backoff = 1000;
      while (!ac.signal.aborted && !this.disposed) {
        try {
          const rpc = await this.rpcReady();
          let first = true;
          await rpc.streamRaw(
            'JetboxSubscribeToSummaries',
            {},
            (buf: Buffer) => {
              backoff = 1000;
              if (first) {
                first = false;
                this.convs.clear();
              }
              this.applySummaries(decodeAs('JetboxSubscribeToSummariesResponse', buf), buf);
            },
            ac.signal,
          );
        } catch (e) {
          if (e instanceof GrpcError && e.isAuth) this.invalidateCsrf();
          this.log(`[agy] summaries: ${errText(e)}`);
        }
        if (ac.signal.aborted) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15_000);
      }
    })().finally(() => {
      if (this.summariesAc === ac) this.summariesAc = null;
    });
  }

  /** Keeps each chat's annotations as the hub sent them (field 15 of its CascadeTrajectorySummary). */
  private keepRawAnnotations(buf: Buffer) {
    for (const f of rawFields(buf)) {
      if (f.id !== 1 || !f.payload) continue; // updates map entry: key = 1, value = 2
      const entry = rawFields(f.payload);
      const key = entry.find((e) => e.id === 1)?.payload;
      const val = entry.find((e) => e.id === 2)?.payload;
      if (!key) continue;
      const id = Buffer.from(key).toString('utf8');
      const ann = val ? rawFields(val).find((e) => e.id === 15)?.payload : null;
      if (ann) this.rawAnnotations.set(id, Uint8Array.from(ann));
      else this.rawAnnotations.delete(id);
    }
  }

  /** The hub's history folder (from the bridge), to tell listed chats that can be opened. */
  private hubDataDir = '';

  /**
   * A listed chat whose trajectory is not stored in the hub's folder cannot be opened ("not found in any store"):
   * the Antigravity IDE's history lists chats it keeps elsewhere. Those are hidden; running or just-active chats
   * always stay (a brand-new chat may not be flushed yet).
   */
  private openable(cid: string, s: any, updated: number): boolean {
    if (!this.hubDataDir) return true;
    if (s.status === 'CASCADE_RUN_STATUS_RUNNING' || Date.now() - updated < 120_000 || this.sessions.has(cid)) return true;
    const dir = path.join(os.homedir(), '.gemini', this.hubDataDir, 'conversations');
    return fs.existsSync(path.join(dir, `${cid}.db`)) || fs.existsSync(path.join(dir, `${cid}.pb`));
  }

  private applySummaries(resp: any, raw: Buffer) {
    const wasRunning = [...this.convs.values()].some((c) => c.isRunning);
    try {
      this.keepRawAnnotations(raw);
    } catch (e) {
      this.log(`[agy] summaries annotations: ${errText(e)}`);
    }
    for (const id of resp.deletes ?? []) {
      this.convs.delete(id);
      this.rawAnnotations.delete(id);
      this.summaryInfo.delete(id);
    }
    for (const [cid, s] of Object.entries<any>(resp.updates ?? {})) {
      const annTitle = s.annotations?.title?.trim() ? s.annotations.title : null;
      const rawSummary = s.summary?.trim() ? s.summary : null;
      const stepCount = Number(s.step_count ?? 0);
      const isDeleted = (!s.status || s.status === 'CASCADE_RUN_STATUS_UNSPECIFIED') && s.killed;
      if ((!annTitle && !rawSummary && stepCount <= 0) || isDeleted) {
        this.convs.delete(cid);
        continue;
      }
      const updated = tsMillis(s.last_modified_time) ?? Date.now();
      if (!this.openable(cid, s, updated)) {
        this.convs.delete(cid);
        continue;
      }
      const meta = s.trajectory_metadata;
      const ws = (meta?.workspace_uris ?? []).find((u: string) => u?.trim()) ?? s.workspaces?.[0]?.workspace_folder_absolute_uri ?? '';
      this.summaryInfo.set(cid, { summary: rawSummary ?? '', backgroundTasks: Number(s.background_task_count ?? 0), subagents: s.has_running_subagents === true });
      this.convs.set(cid, {
        id: cid,
        title: cleanTitle(annTitle ?? rawSummary ?? 'Conversation'),
        modelId: this.chatModels.get(cid) ?? '',
        createdAt: tsMillis(s.created_time) ?? updated,
        updatedAt: updated,
        isRunning: s.status === 'CASCADE_RUN_STATUS_RUNNING',
        notFullyIdle: s.not_fully_idle === true,
        hasActivity: s.has_activity === true,
        runStatus: s.status ?? IDLE,
        stepCount,
        workspaceUri: ws,
        parentConversationId: meta?.parent_conversation_id?.trim() ? meta.parent_conversation_id : s.fork_parent_conversation_id?.trim() ? s.fork_parent_conversation_id : null,
        subagentRole: meta?.subagent_spec?.role || null,
        subagentTypeName: meta?.subagent_spec?.type_name || null,
        nestingDepth: Number(meta?.nesting_depth ?? 0),
        agent: 'AGY',
        archived: s.annotations?.archived === true,
        cloudProjectId: s.cloud ? (meta?.project_id ?? '') : null,
      });
      const sess = this.sessions.get(cid);
      if (sess) {
        sess.knownOnHub = true;
        sess.localConversation = null;
        if (sess.listeners.size) sess.ensureStream();
        sess.scheduleEmit();
      }
    }
    this.changed('conversations');
    // the last running chat stopped: its usage changed (as the app, a quota-only refresh after 3 s)
    if (wasRunning && ![...this.convs.values()].some((c) => c.isRunning)) {
      if (this.quotaAfterRunTimer) clearTimeout(this.quotaAfterRunTimer);
      this.quotaAfterRunTimer = setTimeout(() => void this.loadQuota(true), 3000);
    }
  }

  /**
   * One-line notice above the composer: hub down, signed out, or — only while a message of the user's is actually
   * waiting in the queue — the background work it waits for (never while nothing was sent).
   */
  noticeFor(s: AgySession): string | null {
    if (this.hubState !== 'online') return this.hubDetail ?? 'Antigravity is not running';
    if (this.settings.signedIn() === false) return 'Not signed in to Antigravity: sign in from Settings → Antigravity';
    const conv = this.convs.get(s.id);
    if (!conv || s.engine.isRunning || s.optimisticTag || !s.queued().length) return null;
    const info = this.summaryInfo.get(s.id);
    const streamBusy = s.hasFrames && !s.engine.fullyIdle;
    if (!streamBusy && !conv.notFullyIdle && !info?.backgroundTasks && !info?.subagents) return null;
    const what = info?.subagents ? 'Subagents are' : info?.backgroundTasks ? `${info.backgroundTasks} background task${info.backgroundTasks === 1 ? ' is' : 's are'}` : 'Background work is';
    return `${what} still running: new messages wait until ${info?.subagents || (info?.backgroundTasks ?? 0) > 1 ? 'they finish' : 'it finishes'}`;
  }

  // ---------- models ----------

  /** The picker's model: the saved pick (by id, key or name, as the app restores it), else a Flash model, else the first. */
  private selectedId(): string | null {
    if (!this.modelList.length) return this.selectedModel;
    const find = (v?: string | null) => (v ? this.modelList.find((m) => m.id === v || m.key === v || m.displayName.toLowerCase() === v.toLowerCase()) : undefined);
    const m =
      find(this.selectedModel) ??
      find(this.store.get<string>('agy.modelKey')) ??
      find(this.store.get<string>('agy.modelName')) ??
      this.modelList.find((x) => (x.key ?? '').includes('3.8') || (x.key ?? '').includes('flash')) ??
      this.modelList[0];
    return m?.id ?? null;
  }

  models(): ModelsState {
    // which limit the chat pill shows: the shared view preference (model sheet → "Shown in chat")
    const pill = this.store.get<{ quotaPillWindow?: '5h' | '7d' }>('ui.prefs')?.quotaPillWindow === '7d' ? '7d' : '5h';
    const overrides = this.store.get<Record<string, string>>('agy.quotaOverrides') ?? {};
    const q = applyQuota(this.modelList, this.quotaGroups, pill, overrides);
    return { agent: 'AGY', models: q.models, selectedId: this.selectedId(), groups: q.groups, refreshing: this.refreshing };
  }

  /** Model sheet edit mode: put a model (all its tiers) in another usage-limit group; null = automatic. */
  setQuotaGroup(modelId: string, group: string | null) {
    const m = this.modelList.find((x) => x.id === modelId || x.key === modelId);
    const key = m ? modelKey(m) : modelId.trim().toLowerCase();
    if (!key) return;
    const overrides = { ...(this.store.get<Record<string, string>>('agy.quotaOverrides') ?? {}) };
    const g = group == null ? null : this.quotaGroups.find((x) => x.id === group || x.title === group);
    if (g) overrides[key] = g.id;
    else delete overrides[key];
    this.store.set('agy.quotaOverrides', overrides);
    this.changed('models');
  }

  /** Usage-limit groups (settings page shows them too). */
  quota(): QuotaGroup[] {
    return this.quotaGroups;
  }

  commands(): SlashCommandView[] {
    return this.slash;
  }

  private async loadCommands() {
    try {
      const res = await this.call('GetAllSkills', {});
      this.slash = agySlashCommands(res);
      this.changed('commands');
    } catch (e) {
      this.log(`[agy] skills: ${errText(e)}`);
    }
  }

  async loadQuota(force = false) {
    try {
      const res = await this.call('RetrieveUserQuotaSummary', { force_refresh: force });
      this.quotaGroups = parseQuotaSummary(res);
      this.changed('models');
    } catch (e) {
      this.log(`[agy] quota: ${errText(e)}`);
    }
  }

  modelName(id: string): string {
    return this.modelList.find((m) => m.id === id || m.key === id)?.displayName || id;
  }

  refreshModels() {
    if (this.refreshing) return;
    this.refreshing = true;
    this.changed('models');
    void Promise.allSettled([this.loadModels(true), this.loadQuota(true), this.loadCommands()]).then(() => {
      this.refreshing = false;
      this.changed('models');
    });
  }

  private async loadModels(force = false) {
    try {
      const res = await this.call('GetAvailableModels', { force_refresh: force });
      const r = res.response ?? {};
      const map: Record<string, any> = r.models ?? {};
      const sorts: any[] = r.agent_model_sorts?.length ? r.agent_model_sorts : (r.battle_mode_model_sorts ?? []);
      const ids: string[] = [];
      const groupOf = new Map<string, string>();
      for (const sort of sorts)
        for (const g of sort.groups ?? [])
          for (const mid of g.model_ids ?? [])
            if (mid && !ids.includes(mid)) {
              ids.push(mid);
              if (g.group_name || g.name) groupOf.set(mid, g.group_name ?? g.name);
            }
      const keys = ids.length ? ids : Object.keys(map).filter((k) => !map[k]?.is_internal && !map[k]?.disabled && map[k]?.display_name);
      const list: AiModel[] = [];
      for (const key of keys) {
        const d = map[key];
        if (!d || d.disabled || d.is_internal) continue;
        const displayName: string = d.display_name || key;
        const id = d.model && d.model !== 'MODEL_UNSPECIFIED' ? String(d.model) : key;
        const tm = /^(.*?)\s*\((High|Medium|Low|Med|Thinking)\)$/i.exec(displayName);
        list.push({
          id,
          key,
          displayName,
          family: /claude/i.test(displayName + key) ? 'CLAUDE' : 'GEMINI',
          description: d.description ?? '',
          isDefault: false,
          baseName: tm ? tm[1].trim() : displayName,
          tier: tm ? tm[2].charAt(0).toUpperCase() + tm[2].slice(1) : null,
          group: groupOf.get(key) ?? null,
        });
      }
      if (!list.length) return;
      this.modelList = list;
      // usage pills under replies name their model; chats opened before the list arrived adopt their model now
      for (const s of this.sessions.values()) {
        s.engine.invalidateMessages();
        this.adoptChatModel(s.id, s.engine.toChatMessages(s.id));
        s.scheduleEmit();
      }
      this.changed('models');
    } catch (e) {
      this.log(`[agy] models: ${errText(e)}`);
    }
  }

  selectModel(conversationId: string | null, modelId: string) {
    // the chat on screen keeps this model; it is also the default for new chats (the app's selectModel)
    if (conversationId && (this.sessions.has(conversationId) || this.convs.has(conversationId))) this.rememberChatModel(conversationId, modelId);
    this.selectedModel = modelId;
    const m = this.modelList.find((x) => x.id === modelId || x.key === modelId);
    this.store.set('agy.model', modelId);
    this.store.set('agy.modelKey', m?.key ?? '');
    this.store.set('agy.modelName', m?.displayName ?? '');
    this.changed('models');
  }

  /** The model a chat uses (the pill shows it), when one was picked or adopted for it. */
  chatModel(id: string): string | null {
    return this.chatModels.get(id) ?? null;
  }

  private rememberChatModel(id: string, modelId: string) {
    if (!id || !modelId) return;
    if (this.chatModels.get(id) === modelId) return;
    this.chatModels.set(id, modelId);
    const c = this.convs.get(id);
    if (c) this.convs.set(id, { ...c, modelId });
    this.sessions.get(id)?.scheduleEmit();
  }

  /** A chat opened without a model picked for it shows the model of its last reply (the app's adoptChatModelFromHistory). */
  adoptChatModel(id: string, msgs: ChatMessage[]) {
    if (this.chatModels.has(id)) return;
    const last = [...msgs].reverse().find((m) => m.role === 'ASSISTANT' && m.modelId)?.modelId;
    if (!last) return;
    const model = this.modelList.find((m) => m.id === last || m.key === last);
    if (model) this.rememberChatModel(id, model.id);
  }

  /** The model a message to `id` uses: the chat's own, else the one the view sent, else the picker's. */
  private modelOfChat(id: string, requested?: string | null): string {
    return this.chatModels.get(id) ?? requested ?? this.selectedId() ?? '';
  }

  // ---------- sessions ----------

  private session(id: string): AgySession {
    let s = this.sessions.get(id);
    if (!s) {
      s = new AgySession(id, this);
      s.knownOnHub = this.convs.has(id);
      this.sessions.set(id, s);
    }
    return s;
  }

  dropSession(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.listeners.size) return;
    this.indexText(id, chatText(s.engine.toChatMessages(id)));
    s.close();
    this.sessions.delete(id);
    if (s.localConversation) this.changed('conversations');
  }

  private indexText(id: string, text: string) {
    if (!text) return;
    this.textIndex.delete(id);
    this.textIndex.set(id, text);
    // keep the newest 60 chats
    while (this.textIndex.size > 60) this.textIndex.delete(this.textIndex.keys().next().value!);
  }

  subscribe(conversationId: string, listener: (s: ChatState) => void) {
    const s = this.session(conversationId);
    s.addListener(listener);
    return () => s.removeListener(listener);
  }

  getState(conversationId: string): ChatState {
    return this.session(conversationId).state();
  }

  /** Drawer deep search: the text of chats opened in this run, and the hub's summary of every chat. */
  async search(query: string): Promise<{ conversationId: string; snippet: string }[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const snippet = (text: string, at: number) => {
      const from = Math.max(0, at - 50);
      return `${from > 0 ? '…' : ''}${text.slice(from, at + q.length + 70).replace(/\s+/g, ' ').trim()}…`;
    };
    const out: { conversationId: string; snippet: string }[] = [];
    for (const c of this.convs.values()) {
      const live = this.sessions.get(c.id);
      const full = live ? chatText(live.engine.toChatMessages(c.id)) : this.textIndex.get(c.id);
      const i = full ? full.toLowerCase().indexOf(q) : -1;
      if (full && i >= 0) {
        out.push({ conversationId: c.id, snippet: snippet(full, i) });
        continue;
      }
      const summary = this.summaryInfo.get(c.id)?.summary ?? '';
      const j = summary.toLowerCase().indexOf(q);
      if (j >= 0 && summary !== c.title) out.push({ conversationId: c.id, snippet: snippet(summary, j) });
    }
    return out;
  }

  // ---------- sending ----------

  async send(req: SendRequest): Promise<void> {
    const s = this.session(req.conversationId);
    const conv = this.convs.get(req.conversationId) ?? s.localConversation;
    const modelId = this.modelOfChat(req.conversationId, req.modelId);
    const workspaceUri = req.workspaceUri ? toFileUri(req.workspaceUri) : (conv?.workspaceUri ?? '');

    if (!conv) {
      const firstLine = collapseExpansions(req.text).trim().split('\n').find((l) => l.trim()) ?? 'Chat';
      s.localConversation = {
        id: req.conversationId,
        title: cleanTitle(firstLine.length > 40 ? `${firstLine.slice(0, 40)}...` : firstLine) || 'Chat',
        modelId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isRunning: true,
        notFullyIdle: true,
        hasActivity: true,
        runStatus: 'CASCADE_RUN_STATUS_RUNNING',
        stepCount: 0,
        workspaceUri,
        nestingDepth: 0,
        agent: 'AGY',
        archived: false,
      };
      s.isLoading = false;
      this.changed('conversations');
    }
    this.rememberChatModel(req.conversationId, modelId);

    // like the hub web UI: a fully idle chat runs the message now; otherwise the daemon queues it until the agent is done
    const busy = conv ? s.busy() : { running: false, background: false };
    const queued = !!conv && (busy.running || busy.background);
    const clientMessageId = randomUUID();
    const tag = `${CLIENT_MSG_TAG_PREFIX}${clientMessageId}`;
    const imageAtts = req.attachments.filter((a) => a.isImage && a.base64);

    // signed out: the hub would refuse it (the app does not send at all); checked again in case it changed meanwhile
    if (this.settings.signedIn() === false) await this.settings.refreshAuth();
    if (this.settings.signedIn() === false) {
      s.engine.submitUserPrompt(req.text, imageAtts, req.conversationId);
      s.engine.addLocalError('Authentication Required', 'Please sign in to Antigravity to send messages (Settings → Antigravity → Sign in).');
      this.settleLocal(s);
      s.scheduleEmit();
      return;
    }

    if (queued) {
      s.localQueued.set(tag, { id: tag, text: req.text, attachmentCount: req.attachments.length, canSendNow: false, canDelete: false, isPending: true });
    } else {
      s.setOptimistic(tag);
      s.engine.submitUserPrompt(req.text, imageAtts, req.conversationId);
    }
    s.error = null;
    s.scheduleEmit();

    // files by path go to the agent as a hidden list in the text (never as Media.uri: the hub moves such files);
    // images go inline (and as a hub artifact copy, as the app does)
    const { text, media } = await this.buildPayload(req.text, req.attachments);
    let stage: 'start' | 'send' = 'start';
    try {
      await this.ensureOnHub(s, modelId, workspaceUri);
      stage = 'send';
      s.ensureStream();
      const sendReq = this.userMessageRequest(req.conversationId, text, media, modelId, queued ? 'MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE' : 'MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION', clientMessageId);
      try {
        await this.call('SendUserCascadeMessage', sendReq);
      } catch (e) {
        // the hub forgot the conversation (restart): start it again and retry once
        if (/not found/i.test(errText(e))) {
          await this.startCascade(req.conversationId, modelId, workspaceUri);
          await this.call('SendUserCascadeMessage', sendReq);
        } else throw e;
      }
    } catch (e) {
      const msg = errText(e);
      this.log(`[agy] send: ${msg}`);
      if (queued) {
        // out of the queue card, and say so
        s.localQueued.delete(tag);
        this.notify('error', `Couldn't queue the message: ${msg}`);
      } else {
        s.setOptimistic(null);
        const title = stage === 'start' ? (/auth/i.test(msg) ? 'Authentication Required' : 'Failed to Start Conversation') : deliveryErrorTitle(msg);
        s.engine.addLocalError(title, msg);
        this.settleLocal(s);
      }
      s.scheduleEmit();
    }
  }

  /** A chat only this window knows (nothing reached the hub): not running any more. */
  private settleLocal(s: AgySession) {
    if (s.localConversation) {
      s.localConversation = { ...s.localConversation, isRunning: false, notFullyIdle: false, hasActivity: false, runStatus: IDLE };
      this.changed('conversations');
    }
  }

  /** StartCascade once per new chat (a second message waits for the first one's start). */
  private ensureOnHub(s: AgySession, modelId: string, workspaceUri: string): Promise<void> {
    if (s.knownOnHub || this.convs.has(s.id)) return Promise.resolve();
    if (!s.starting) {
      s.starting = this.startCascade(s.id, modelId, workspaceUri)
        .then(() => {
          s.knownOnHub = true;
        })
        .finally(() => {
          s.starting = null;
        });
    }
    return s.starting;
  }

  private async startCascade(id: string, modelId: string, workspaceUri: string) {
    await this.call('StartCascade', {
      cascade_id: id,
      source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
      requested_model: modelId ? enumValue(modelId) : 'MODEL_UNSPECIFIED',
      workspace_uris: workspaceUri ? [workspaceUri] : [],
      override_workspace_uris: workspaceUri ? [workspaceUri] : [],
    });
    if (workspaceUri) {
      try {
        await this.pointDefaultProject(workspaceUri);
      } catch (e) {
        this.log(`[agy] UpdateProject: ${errText(e)}`);
      }
    }
  }

  /**
   * The app points the hub's default CLI project at the chat's folder (UpdateProject). Its other fields (the user's
   * project preset, permission rules…) are kept: only name and folder of the stored project bytes change. A project
   * the hub does not have yet is created as the app creates it.
   */
  private async pointDefaultProject(workspaceUri: string) {
    const name = baseName(workspaceUri);
    const resources = { resources: [{ folder_uri: workspaceUri }] };
    const raw = await this.callHubRaw('ReadProjects', encodeAs('ReadProjectsRequest', { ids: [DEFAULT_PROJECT_ID] }));
    const projectBytes = rawFields(raw).find((f) => f.id === 1)?.payload; // ReadProjectsResponse.projects = 1
    if (projectBytes) {
      const patched = patchMessage('Project', projectBytes, { name, project_resources: resources });
      await this.callHubRaw('UpdateProject', lengthDelimited(1, patched)); // UpdateProjectRequest.project = 1
      return;
    }
    await this.call('UpdateProject', {
      project: {
        id: DEFAULT_PROJECT_ID,
        name,
        project_resources: resources,
        permission_grants: { permission_grants: { allow: ['read_url(example.com)'] } },
        settings: {},
      },
    });
  }

  private async buildPayload(text: string, atts: ChatAttachment[]): Promise<{ text: string; media: any[] }> {
    const media: any[] = [];
    const refs: { path: string; mimeType: string; size: number }[] = [];
    for (const a of atts) {
      if (a.isImage) {
        let b64 = a.base64 ?? null;
        try {
          if (!b64 && a.path && fs.existsSync(a.path) && fs.statSync(a.path).size < MEDIA_MAX) b64 = fs.readFileSync(a.path).toString('base64');
        } catch {
          b64 = null;
        }
        if (b64) {
          const mime = a.mimeType || IMAGE_MIME[path.extname(a.name || a.path || '').slice(1).toLowerCase()] || 'image/jpeg';
          // a copy saved as a hub artifact keeps the image in the chat's history (the app's saveMediaAsArtifact)
          let uri = '';
          try {
            const r = await this.call('SaveMediaAsArtifact', { media: { mime_type: mime, inline_data: b64, description: a.name, thumbnail: b64 } });
            uri = r.uri ?? '';
          } catch (e) {
            this.log(`[agy] SaveMediaAsArtifact: ${errText(e)}`);
          }
          media.push({ mime_type: mime, inline_data: b64, description: a.name || 'Image', ...(uri ? { uri } : {}) });
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
      }
    }
    const body = text.trim() || (media.length ? 'Image' : refs.length ? 'Attachment' : '');
    return { text: refs.length ? `${body}\n\n${attachedFilesBlock(refs)}` : body, media };
  }

  /** The command auto-run policy a prompt carries: the hub's own setting (Commands & Permissions), as the app keeps it. */
  private autoExecPolicy(): string {
    return this.store.get<string>('agy.autoExecPolicy') || 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER';
  }

  private userMessageRequest(cascadeId: string, text: string, media: any[], modelId: string, delivery: string, clientMessageId: string) {
    return {
      cascade_id: cascadeId,
      items: [{ text }],
      media,
      cascade_config: {
        planner_config: {
          tool_config: {
            run_command: { auto_command_config: { auto_execution_policy: this.autoExecPolicy() } },
            notify_user: {},
          },
          requested_model: modelId ? { model: enumValue(modelId) } : undefined,
          use_ai_credits: false,
          supports_latex_rendering: true,
        },
        executor_config: { use_core_direct: true },
        conversation_history_config: {},
      },
      custom_agent_spec: { builtin_agent: { default_agent: { is_google: false, is_interactive: true } } },
      delivery_strategy: delivery,
      tags: [`${CLIENT_MSG_TAG_PREFIX}${clientMessageId}`],
      client_message_id: clientMessageId,
    };
  }

  async stop(conversationId: string) {
    const s = this.sessions.get(conversationId);
    if (s) {
      s.setOptimistic(null);
      s.engine.cancelRunning();
      s.scheduleEmit();
    }
    try {
      await this.call('CancelCascadeInvocation', { cascade_id: conversationId, kill_background_tasks: true });
    } catch (e) {
      this.log(`[agy] cancel: ${errText(e)}`);
    }
  }

  /** Tool card actions: "terminate" stops one running command, not the whole reply (the app's terminateRunningTerminalTool). */
  async toolAction(conversationId: string, toolId: string, action: string) {
    if (action !== 'terminate') return;
    const s = this.sessions.get(conversationId);
    const stepIndex = Number(toolId);
    if (!s || !Number.isFinite(stepIndex)) return;
    const tool = s.engine
      .toChatMessages(conversationId)
      .flatMap((m) => m.toolCalls)
      .find((t) => t.id === toolId);
    if (tool && tool.status !== 'RUNNING') return;
    s.engine.optimisticUpdateStepStatus(stepIndex, 'CANCELED', 'Command terminated by user.');
    s.scheduleEmit();
    try {
      await this.call('CancelCascadeSteps', { cascade_id: conversationId, step_indices: [stepIndex] });
    } catch (e) {
      this.log(`[agy] CancelCascadeSteps ${stepIndex}: ${errText(e)}`);
      this.notify('error', `Couldn't stop the command: ${errText(e)}`);
    }
  }

  // ---------- approvals & questions ----------

  async approval(conversationId: string, key: string, choiceId: string | undefined, deny: boolean, feedback?: string) {
    const s = this.session(conversationId);
    const stepIndex = Number(key);
    if (!Number.isFinite(stepIndex)) return;
    const step = s.engine.activeStep(stepIndex);
    const type = interactionTypeOf(step);
    const ri = step?.requested_interaction ?? {};
    const trajectoryId = s.engine.trajectoryId;
    const allow = !deny;
    const denyText = feedback?.trim() || 'User rejected this command.';
    const scope = allow ? (SCOPES[choiceId ?? this.store.get<string>('agy.defaultScope') ?? 'once'] ?? SCOPES.once) : SCOPES.once;
    s.engine.markStepResponded(stepIndex);
    s.engine.optimisticUpdateStepStatus(stepIndex, allow ? 'RUNNING' : 'CANCELED', allow ? undefined : denyText);
    s.scheduleEmit();
    const interaction: Record<string, unknown> = { trajectory_id: trajectoryId, step_index: stepIndex };
    switch (type) {
      case 'permission':
        interaction.permission = { allow, scope, user_deny_instruction: allow ? '' : denyText };
        break;
      case 'file_permission':
        interaction.file_permission = { allow, scope, absolute_path_uri: ri.file_permission?.absolute_path_uri ?? '' };
        break;
      case 'deploy':
        interaction.deploy = { cancel: !allow };
        break;
      case 'elicitation':
        interaction.elicitation = { action: allow ? 'accept' : 'decline', content_json: '' };
        break;
      case 'run_command': {
        const cmd = step?.run_command?.proposed_command_line || step?.run_command?.command_line || '';
        interaction.run_command = { confirm: allow, proposed_command_line: cmd, submitted_command_line: cmd };
        break;
      }
      default:
        // mcp, read_url_content, browser_action, approval_interaction and the other confirm-only kinds
        interaction[type] = { confirm: allow };
    }
    try {
      await this.call('HandleCascadeUserInteraction', { cascade_id: conversationId, interaction });
    } catch (e) {
      let ok = false;
      if (allow) {
        try {
          await this.call('ResolveOutstandingSteps', { cascade_id: conversationId });
          ok = true;
        } catch {
          /* fall through */
        }
      }
      if (!ok) {
        // roll back so the card shows again
        s.engine.unmarkStepResponded(stepIndex);
        s.engine.optimisticUpdateStepStatus(stepIndex, 'WAITING');
        s.error = `${allow ? 'Approval' : 'Rejection'} failed: ${errText(e)}`;
        s.scheduleEmit();
      }
    }
  }

  /**
   * Answers an ask_question card. `skip` sends every question as skipped (the app's skipUserChoices); `cancel` (the
   * card's ✕) stops the reply instead, as the app's cancelUserChoices does.
   */
  async answer(conversationId: string, key: string, answers: Record<string, string[]>, note?: string, skip?: boolean, cancel?: boolean) {
    const s = this.session(conversationId);
    const stepIndex = Number(key);
    if (cancel) {
      s.engine.markStepResponded(stepIndex);
      s.engine.optimisticUpdateStepStatus(stepIndex, 'CANCELED', 'Questionnaire cancelled by user.');
      s.scheduleEmit();
      await this.stop(conversationId);
      return;
    }
    const msgs: ChatMessage[] = s.engine.toChatMessages(conversationId);
    const tool = msgs.flatMap((m) => m.toolCalls).find((t) => t.id === key);
    const q = tool?.questionnaire;
    if (!q) return;
    const responses = q.questions.map((qq) => {
      const picked = skip ? [] : (answers[qq.id] ?? []);
      const optionIds = new Set(qq.options.map((o) => o.id));
      const selected = picked.filter((p) => optionIds.has(p));
      const custom = picked.filter((p) => !optionIds.has(p)).join(', ');
      const write = skip ? '' : custom || (note && qq === q.questions[q.questions.length - 1] ? note : '');
      return {
        question: qq.prompt,
        options: qq.options.map((o) => ({ id: o.id, text: o.label })),
        is_multi_select: qq.isMultiSelect,
        selected_option_ids: selected,
        write_in_response: write,
        skipped: skip === true || (!selected.length && !write),
      };
    });
    s.engine.markStepResponded(stepIndex);
    s.engine.optimisticUpdateStepStatus(stepIndex, 'DONE');
    s.scheduleEmit();
    try {
      await this.call('HandleCascadeUserInteraction', {
        cascade_id: conversationId,
        interaction: {
          trajectory_id: s.engine.trajectoryId,
          step_index: stepIndex,
          ask_question: { responses, cancelled: responses.length > 0 && responses.every((r) => r.skipped) },
        },
      });
    } catch (e) {
      s.engine.unmarkStepResponded(stepIndex);
      s.engine.optimisticUpdateStepStatus(stepIndex, 'WAITING');
      s.error = `Couldn't send the answer: ${errText(e)}`;
      this.log(`[agy] answer: ${s.error}`);
      s.scheduleEmit();
    }
  }

  // ---------- conversation & queue actions ----------

  async conversationAction(id: string, action: 'delete' | 'fork' | 'rename' | 'archive' | 'unarchive', value?: string): Promise<string | void> {
    switch (action) {
      case 'delete':
        await this.call('DeleteCascadeTrajectory', { cascade_id: id });
        this.convs.delete(id);
        this.chatModels.delete(id);
        this.textIndex.delete(id);
        this.sessions.get(id)?.close();
        this.sessions.delete(id);
        this.changed('conversations');
        return;
      case 'rename': {
        const title = value?.trim();
        if (!title) return;
        // shown at once; the summaries stream pushes the stored title back
        const before = this.convs.get(id);
        if (before) {
          this.convs.set(id, { ...before, title });
          this.changed('conversations');
          this.sessions.get(id)?.scheduleEmit();
        }
        try {
          await this.call('UpdateConversationAnnotations', { cascade_ids: [id], annotations: { title }, merge_annotations: true });
        } catch (e) {
          const cur = this.convs.get(id);
          if (before && cur?.title === title) {
            this.convs.set(id, { ...cur, title: before.title });
            this.changed('conversations');
          }
          throw new Error(`Could not rename: ${errText(e)}`);
        }
        return;
      }
      case 'archive':
      case 'unarchive': {
        const archived = action === 'archive';
        const before = this.convs.get(id);
        if (before) {
          this.convs.set(id, { ...before, archived });
          this.changed('conversations');
        }
        try {
          const raw = this.rawAnnotations.get(id);
          if (raw) {
            // the known annotations go back whole, not merged: a merge may skip `archived = false` (the proto
            // default), as the app's setConversationArchived notes; the raw bytes keep every other annotation
            const ann = patchMessage('ConversationAnnotations', raw, { archived, archival_status_timestamp: stamp() });
            const head = encodeAs('UpdateConversationAnnotationsRequest', { cascade_ids: [id] });
            await this.callHubRaw('UpdateConversationAnnotations', concat([head, lengthDelimited(2, ann)]));
          } else {
            await this.call('UpdateConversationAnnotations', { cascade_ids: [id], annotations: { archived, archival_status_timestamp: stamp() }, merge_annotations: true });
          }
        } catch (e) {
          const cur = this.convs.get(id);
          if (before && cur) {
            this.convs.set(id, { ...cur, archived: before.archived });
            this.changed('conversations');
          }
          throw new Error(`Could not ${action}: ${errText(e)}`);
        }
        return;
      }
      case 'fork': {
        const steps = await this.call('GetCascadeTrajectorySteps', { cascade_id: id });
        const n = steps.steps?.length ?? 0;
        const res = await this.call('ForkConversation', { source_cascade_id: id, fork_at_step_index: Math.max(0, n - 1) });
        const newId = res.new_cascade_id as string;
        const m = this.chatModels.get(id);
        if (newId && m) this.rememberChatModel(newId, m);
        return newId;
      }
    }
  }

  async queueAction(conversationId: string, id: string, action: 'sendNow' | 'delete') {
    const s = this.session(conversationId);
    if (action === 'delete') {
      s.hiddenQueuedIds.add(id);
      s.scheduleEmit();
      try {
        await this.call('DeleteAgentMessage', { message_id: id, recipient: conversationId });
      } catch (e) {
        s.hiddenQueuedIds.delete(id);
        s.scheduleEmit();
        this.notify('error', `Couldn't delete the queued message: ${errText(e)}`);
      }
      return;
    }
    // "Send now": sent again to run right away (interrupting the current work), then removed from the queue
    const entry = s.engine.queuedMessages().find((e) => e.id === id);
    if (!entry) return;
    const clientMessageId = randomUUID();
    s.setOptimistic(`${CLIENT_MSG_TAG_PREFIX}${clientMessageId}`);
    s.hiddenQueuedIds.add(id);
    s.scheduleEmit();
    try {
      const req = this.userMessageRequest(conversationId, entry.text, entry.media, this.modelOfChat(conversationId), 'MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION', clientMessageId);
      await this.call('SendUserCascadeMessage', req);
      await this.call('DeleteAgentMessage', { message_id: id, recipient: conversationId }).catch((e) => this.log(`[agy] DeleteAgentMessage: ${errText(e)}`));
    } catch (e) {
      s.setOptimistic(null);
      s.hiddenQueuedIds.delete(id);
      s.scheduleEmit();
      this.notify('error', `Couldn't send the queued message: ${errText(e)}`);
    }
  }

  // ---------- edit / regenerate (RevertToCascadeStep, as the app) ----------

  /** ✎ on a prompt: the chat is cut right before it; returns its text for the composer. */
  async rewind(conversationId: string, messageId: string): Promise<string | null> {
    const m = /^user_.+_(\d+)$/.exec(messageId);
    if (!m) return null;
    const step = Number(m[1]);
    const s = this.session(conversationId);
    const msg = s.engine.toChatMessages(conversationId).find((x) => x.id === messageId);
    const text = msg?.content ?? '';
    if (step <= 0) {
      // the first prompt: nothing stays, so the chat goes (the app's revertUserMessage deletes it on the hub)
      await this.call('DeleteCascadeTrajectory', { cascade_id: conversationId });
      s.halt();
      this.convs.delete(conversationId);
      this.rawAnnotations.delete(conversationId);
      this.summaryInfo.delete(conversationId);
      s.engine.reset(conversationId, true);
      s.knownOnHub = false;
      s.hasFrames = false;
      s.localConversation = null;
      s.isLoading = false;
      s.error = null;
      this.changed('conversations');
      s.scheduleEmit();
      return text;
    }
    await this.revertTo(conversationId, step - 1);
    s.resync();
    return text;
  }

  /** ↻ on a reply: cut before its prompt and send that prompt again. */
  async retryMessage(conversationId: string, messageId: string): Promise<string | void> {
    const s = this.session(conversationId);
    const msgs = s.engine.toChatMessages(conversationId);
    const i = msgs.findIndex((x) => x.id === messageId);
    const prompt = [...msgs.slice(0, i < 0 ? msgs.length : i)].reverse().find((x) => x.role === 'USER');
    if (!prompt || prompt.stepIndex == null) throw new Error('No prompt to run again');
    // the first reply: nothing to cut back to, so the prompt is simply sent again (the app's retryMessage)
    if (prompt.stepIndex > 0) {
      await this.revertTo(conversationId, prompt.stepIndex - 1);
      s.resync();
    }
    await this.send({ conversationId, isNew: false, text: prompt.rawContent || prompt.content, attachments: [], modelId: null, workspaceUri: null });
  }

  private async revertTo(conversationId: string, stepIndex: number) {
    const modelId = this.modelOfChat(conversationId);
    await this.call('RevertToCascadeStep', {
      cascade_id: conversationId,
      step_index: stepIndex,
      conversation_only: true,
      override_config: { planner_config: modelId ? { requested_model: { model: enumValue(modelId) } } : {} },
    });
  }

  dispose() {
    this.disposed = true;
    this.settings.dispose();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.quotaAfterRunTimer) clearTimeout(this.quotaAfterRunTimer);
    this.summariesAc?.abort();
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
    this.client.close();
  }
}
