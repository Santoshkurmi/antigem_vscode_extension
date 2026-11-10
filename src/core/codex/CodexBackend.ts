// Codex backend: a port of the Android app's CodexChatBackend.kt for the extension host.
//
// The bridge runs one `codex app-server` for every Codex chat (thread). This class lists threads and reads their
// turns through it (POST /api/codex/rpc), follows its event stream (one WebSocket for all chats, replayed with
// ?since= after a reconnect), and starts turns, stops them, and answers approvals and questions. Each chat a view
// shows is a CodexSession with its own CodexTranscript; live events go to the session of their thread.
//
// New chats: a view makes up a UUID for a new chat and keeps using it, but Codex names the thread itself
// (thread/start). The UUID becomes an alias of the thread id (kept in the KeyValueStore, so an editor tab keeps
// working after a reload): the chat is listed under the view's id, and every id the host passes is resolved to the
// thread id before talking to Codex.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { AiModel, ChatAttachment, ChatMessage, Conversation, QueuedMessage } from '../../../shared/model';
import type { AgentStatus, ApprovalView, ControlChipView, ModelsState, QuestionView, SlashCommandView } from '../../../shared/protocol';
import type { AgentBackend, BackendChange, ChatState, KeyValueStore, Logger, SendRequest } from '../types';
import type { BridgeManager } from '../bridge/BridgeManager';
import { attachedFilesBlock, cleanTitle, collapseExpansions, displayUserText, extractAttachedFiles, type FileRef } from '../text';
import { CodexClient, CodexRpcError, CodexUnavailableError, type CodexCliJob, type CodexStatus } from './client';
import { CodexTranscript, safeId, unwrapShell, type CodexQuestion } from './CodexTranscript';
import { CodexSettings } from './CodexSettings';
import {
  MODE_AUTO,
  MODE_FULL,
  MODES,
  approvalPolicy,
  arr,
  bool,
  capitalize,
  effortDescription,
  effortLabel,
  errText,
  limitsOf,
  modeDescription,
  modeIcon,
  modeLabel,
  o,
  obj,
  quotaWindows,
  sandboxMode,
  sandboxPolicy,
  str,
  STATE_LABEL,
  type CodexStateName,
  type J,
  type RateLimits,
} from './util';
import { remainingText } from '../agy/settingsKit';

const EMIT_INTERVAL_MS = 33;
const SOURCES = ['cli', 'vscode', 'exec', 'appServer'];
/** The small model Codex's own app names chats with (when the plan offers it; else the chat's model). */
const TITLE_MODEL = 'gpt-5.6-luna';
/** One title of at most 36 characters, as Codex's own app asks for it. */
const TITLE_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string', minLength: 1, maxLength: 36 } },
  required: ['title'],
  additionalProperties: false,
};
const QUOTA_GROUP = 'All models';
const MAX_ALIASES = 300;

/** Sending a message cannot work in this state. */
const BLOCKING: CodexStateName[] = ['NOT_INSTALLED', 'DISABLED', 'OUTDATED', 'OFFLINE', 'SIGNED_OUT'];

export interface CodexAccount {
  type: string;
  email: string | null;
  plan: string | null;
}

/** A sign-in in progress: open `url` (and type `code`, for a device code sign-in). */
export interface CodexLogin {
  loginId: string;
  url: string;
  code: string | null;
}

/** A request Codex is waiting on: an approval or a question (answered through the bridge by `key`). */
interface Pending {
  key: string;
  method: string;
  params: J;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  isQuestion: boolean;
}

/** Codex's own commands in the "/" menu of a Codex chat. */
const BUILTIN_COMMANDS: SlashCommandView[] = [
  { command: '/compact', description: 'Summarize the chat so far to free up context', kind: 'command', runsOnTap: true },
  { command: '/review', description: 'Review the uncommitted changes (or: /review what to check)', kind: 'command', runsOnTap: true },
  { command: '/plan', description: 'Plan mode: plan before changing anything (or: /plan the task)', kind: 'command', runsOnTap: true },
  { command: '/fork', description: 'Copy this chat into a new one', kind: 'command', runsOnTap: true },
  { command: '/model', description: 'Pick the model', kind: 'app' },
  { command: '/status', description: 'Account, usage limits and settings', kind: 'app' },
  { command: '/mcp', description: 'MCP servers Codex can use', kind: 'app' },
  { command: '/new', description: 'Start a new Codex chat', kind: 'app' },
];

/** Commands the app answers with one of its screens (the view opens the ones it has); never sent to Codex as a prompt. */
const APP_ONLY: Record<string, string> = {
  '/model': 'Pick the model with the model button.',
  '/models': 'Pick the model with the model button.',
  '/new': 'Start a new chat with the + button.',
  '/clear': 'Start a new chat with the + button.',
  '/status': 'Account and usage limits: Settings → Agents → Codex.',
  '/usage': 'Account and usage limits: Settings → Agents → Codex.',
  '/limits': 'Account and usage limits: Settings → Agents → Codex.',
  '/account': 'Account and usage limits: Settings → Agents → Codex.',
  '/login': 'Sign in: Settings → Agents → Codex.',
  '/logout': 'Sign out: Settings → Agents → Codex.',
  '/mcp': 'MCP servers: Settings → Agents → Codex → MCP servers.',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textInput = (text: string): J => ({ type: 'text', text, text_elements: [] });
const pathOfUri = (uri: string | null | undefined): string | null => {
  if (!uri) return null;
  const p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  return p.startsWith('/') ? p : null;
};

// ------------------------------------------------------------------------------------------------ session

/** One chat a view shows (or a chat replying while nobody looks): its transcript and listeners. */
class CodexSession {
  readonly transcript = new CodexTranscript();
  readonly listeners = new Set<(s: ChatState) => void>();
  /** Codex's thread id (null: a new chat that exists only here until its first message). */
  threadId: string | null = null;
  /** Resolved once it is known whether the id is an existing thread. */
  ready: Promise<void> = Promise.resolve();
  /** The probe could not reach Codex: ask again before sending. */
  probeUnsure = false;
  isLoading = true;
  loadedOnce = false;
  error: string | null = null;
  /** Retry / reroute notice (shown under the working spinner). */
  notice: string | null = null;
  queued: QueuedMessage[] = [];
  /** Plan mode: Codex explores and proposes a plan instead of changing anything. */
  planMode = false;
  /** Reasoning effort of this chat (null: the default for new chats). */
  effort: string | null = null;
  /** Model of this chat (its last turn's, or picked in it); null: the picked model for new chats. */
  model: string | null = null;
  /** The thread was created from here (it may get a generated title). */
  createdHere = false;
  /** The chat before Codex lists it. */
  localConversation: Conversation | null = null;
  turnStartedAt = 0;
  /** turn/start was sent and has not answered yet (an "idle" status meanwhile does not end the reply). */
  turnStartPending = false;
  closed = false;
  private emitTimer: NodeJS.Timeout | null = null;
  private disposeTimer: NodeJS.Timeout | null = null;
  private awaitTimer: NodeJS.Timeout | null = null;
  private reloading: Promise<void> | null = null;
  private reloadAgain = false;
  private reloadRestore = false;

  constructor(
    public publicId: string,
    private b: CodexBackend,
  ) {}

  addListener(l: (s: ChatState) => void) {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
    const first = this.listeners.size === 0;
    this.listeners.add(l);
    l(this.state());
    // a chat (re)opened is read again: Codex's stored copy is the reference, merged with what streamed meanwhile
    if (first) void this.ready.then(() => (this.threadId ? this.reload(!this.loadedOnce) : this.markLoaded()));
  }

  removeListener(l: (s: ChatState) => void) {
    this.listeners.delete(l);
    if (!this.listeners.size) this.scheduleDrop();
  }

  scheduleDrop() {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = setTimeout(() => this.b.dropSession(this), 90_000);
  }

  markLoaded() {
    this.isLoading = false;
    this.scheduleEmit();
  }

  /** Shows the reply spinner for something that starts a turn later (compact, review); cleared by turn/started. */
  awaitTurn(on: boolean) {
    if (this.awaitTimer) clearTimeout(this.awaitTimer);
    this.awaitTimer = null;
    this.transcript.markAwaitingStart(on);
    if (on)
      this.awaitTimer = setTimeout(() => {
        this.transcript.markAwaitingStart(false);
        this.scheduleEmit();
      }, 60_000);
    this.scheduleEmit();
  }

  reload(restore = false): Promise<void> {
    if (this.reloading) {
      this.reloadAgain = true;
      this.reloadRestore ||= restore;
      return this.reloading;
    }
    this.reloading = (async () => {
      let r = restore;
      do {
        this.reloadAgain = false;
        await this.b.loadThread(this, r);
        r = this.reloadRestore;
        this.reloadRestore = false;
      } while (this.reloadAgain && !this.closed);
    })().finally(() => {
      this.reloading = null;
    });
    return this.reloading;
  }

  scheduleEmit() {
    if (this.emitTimer || this.closed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitNow();
    }, EMIT_INTERVAL_MS);
  }

  emitNow() {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    if (this.closed || !this.listeners.size) return;
    const s = this.state();
    for (const l of this.listeners) l(s);
  }

  state(): ChatState {
    return this.b.stateOf(this);
  }

  close() {
    this.closed = true;
    for (const t of [this.emitTimer, this.disposeTimer, this.awaitTimer]) if (t) clearTimeout(t);
    this.emitTimer = this.disposeTimer = this.awaitTimer = null;
  }
}

// ------------------------------------------------------------------------------------------------ backend

export class CodexBackend implements AgentBackend {
  readonly kind = 'CODEX' as const;
  readonly settings: CodexSettings;
  readonly client: CodexClient;

  // ---- account & server (read by the settings pages)
  codexState: CodexStateName = 'CHECKING';
  bridgeStatus: CodexStatus | null = null;
  account: CodexAccount | null = null;
  rateLimits: RateLimits | null = null;
  login: CodexLogin | null = null;
  cliJob: CodexCliJob | null = null;

  private changeListeners = new Set<(w: BackendChange) => void>();
  private notifier: ((level: 'info' | 'warning' | 'error', message: string) => void) | null = null;
  /** thread id → its preview (first message), for a search when Codex's own search fails. */
  private previews = new Map<string, string>();
  private started = false;
  private disposed = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private loopWake: (() => void) | null = null;
  private countdownTimer: NodeJS.Timeout | null = null;
  private limitsTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private cliPoll: NodeJS.Timeout | null = null;

  // ---- models & commands
  private modelList: AiModel[] = [];
  /** Every model Codex offers, hidden ones included (the title model can be hidden). */
  private allModelIds = new Set<string>();
  private modelEfforts = new Map<string, string[]>();
  private modelDefaultEffort = new Map<string, string>();
  modelsError: string | null = null;
  private refreshing = false;
  private selectedModel: string | null;
  private slash: SlashCommandView[] = BUILTIN_COMMANDS;
  /** skill name → SKILL.md path (a "/name" message is sent as that skill). */
  private skillPaths = new Map<string, string>();
  /** Plan mode chosen on the empty new-chat screen (taken by the next new chat). */
  private newChatPlan = false;

  // ---- chats
  private serverList: Conversation[] = [];
  private listedThreads = new Set<string>();
  private running = new Set<string>();
  private convCache: Conversation[] | null = null;
  private lastConvJson = '';
  /** view id → thread id (new chats started here). */
  private aliases: Record<string, string>;
  private aliasOfThread = new Map<string, string>();
  /** Any id a session is known by (view id, thread id) → the session. */
  private sessions = new Map<string, CodexSession>();
  private pendingAll = new Map<string, Pending>();
  /** Threads this backend sent a message to (a reply that runs while nobody looks gets a live copy). */
  private sentTo = new Set<string>();
  private epoch = 0;
  private refreshingThreads: Promise<void> | null = null;

  // ---- event stream
  private ws: WebSocket | null = null;
  private wsTimer: NodeJS.Timeout | null = null;
  private wsBackoff = 1000;
  /** Last bridge event sequence number seen (-1: none yet). */
  private lastSeq = -1;

  // ---- hidden title threads
  private titleRuns = new Map<string, (answer: string | null) => void>();
  private titleAnswers = new Map<string, string>();
  private titleAsked = new Set<string>();

  constructor(
    private bridge: BridgeManager,
    readonly store: KeyValueStore,
    readonly log: Logger,
    private opts: { openUrl: (url: string) => void } = { openUrl: () => undefined },
  ) {
    this.client = new CodexClient(bridge);
    this.selectedModel = store.get<string>('codex.model') || null;
    this.aliases = { ...(store.get<Record<string, string>>('codex.aliases') ?? {}) };
    for (const [view, tid] of Object.entries(this.aliases)) this.aliasOfThread.set(tid, view);
    this.settings = new CodexSettings(this);
  }

  // ------------------------------------------------------------------ status & lifecycle

  status(): AgentStatus {
    const st = this.codexState;
    const state: AgentStatus['state'] =
      st === 'READY' ? 'online' : st === 'CHECKING' ? 'starting' : st === 'NOT_INSTALLED' ? 'not_installed' : st === 'OFFLINE' ? 'offline' : 'error';
    let detail: string | null = null;
    const version = this.bridgeStatus?.version;
    switch (st) {
      case 'READY':
        detail = [this.account?.email, this.account?.plan ? capitalize(this.account.plan) : null, version ? `Codex ${version}` : null].filter(Boolean).join(' · ') || null;
        break;
      case 'CHECKING':
        detail = 'Starting… waiting for the bridge.';
        break;
      case 'SIGNED_OUT':
        detail = 'Sign in with your ChatGPT account to use Codex (Settings → Codex → Account & CLI).';
        break;
      case 'NOT_INSTALLED':
        detail = this.bridgeStatus?.termux_package
          ? 'Codex is not installed yet (pkg install codex). Install it from Settings → Codex → Account & CLI.'
          : 'Codex is not installed yet. Install it from Settings → Codex → Account & CLI.';
        break;
      case 'DISABLED':
        detail = 'The bridge was started with Codex off.';
        break;
      case 'OUTDATED':
        detail = 'This bridge has no Codex support yet. Update it.';
        break;
      case 'OFFLINE':
        detail = 'The bridge is not running.';
        break;
      default:
        detail = this.bridgeStatus?.error ?? STATE_LABEL[st];
    }
    return {
      kind: 'CODEX',
      label: 'Codex',
      state,
      detail,
      account: this.account?.email ?? null,
      version: this.bridgeStatus?.installed && version ? version.replace(/^v/, '') : null,
      plan: this.account?.plan ? capitalize(this.account.plan) : null,
      setupPage: 'codex.cli',
    };
  }

  /** The host's toasts (the app's `toasts` flow). */
  setNotifier(notify: (level: 'info' | 'warning' | 'error', message: string) => void) {
    this.notifier = notify;
  }

  notify(level: 'info' | 'warning' | 'error', message: string) {
    if (this.notifier) this.notifier(level, message);
    else this.log(`[codex] ${level}: ${message}`);
  }

  /** Codex's own id of a chat ("Copy ID"): the thread id behind a view's id. */
  externalId(conversationId: string): string {
    return this.threadIdOf(conversationId);
  }

  onChange(cb: (w: BackendChange) => void) {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  changed(w: BackendChange) {
    if (w === 'conversations') {
      this.convCache = null;
      const json = JSON.stringify(this.conversations());
      if (json === this.lastConvJson) return;
      this.lastConvJson = json;
    }
    for (const l of this.changeListeners) l(w);
  }

  /** Codex is enabled: check the bridge, load account, models and chats, follow the event stream. */
  start() {
    if (this.started) return;
    this.started = true;
    void this.loop();
  }

  private async loop() {
    try {
      await this.bridge.ensureRunning();
    } catch (e) {
      this.bridgeStatus = { error: errText(e) };
      this.setState('OFFLINE');
    }
    this.connectEvents();
    // becoming READY loads models, skills and chats (setState); signed out, the models still show
    await this.refreshStatus();
    if (this.codexState === 'SIGNED_OUT') await this.loadModels();
    if (!this.countdownTimer)
      // the reset countdowns ("2h 4m") tick down
      this.countdownTimer = setInterval(() => {
        if (this.rateLimits) this.changed('models');
      }, 60_000);
    while (!this.disposed) {
      await this.refreshThreads();
      await new Promise<void>((r) => {
        this.loopWake = r;
        this.loopTimer = setTimeout(r, this.codexState === 'READY' ? 60_000 : 15_000);
      });
      this.loopWake = null;
      if (this.disposed) break;
      if (this.codexState !== 'READY') await this.refreshStatus();
    }
  }

  retry() {
    void (async () => {
      if (this.codexState !== 'READY') this.setState('CHECKING');
      await this.refreshStatus();
      await this.loadModels();
      await this.refreshThreads();
      if (!this.ws) {
        if (this.wsTimer) clearTimeout(this.wsTimer);
        this.wsTimer = null;
        this.connectEvents();
      }
    })();
  }

  private setState(s: CodexStateName) {
    if (s === this.codexState) return;
    const wasReady = this.codexState === 'READY';
    this.codexState = s;
    this.changed('status');
    this.changed('settings');
    if (s === 'READY' && !wasReady && this.started) {
      void this.loadModels();
      void this.refreshSkills();
      void this.refreshThreads();
      // chats opened while Codex could not be asked whether they exist
      for (const ss of this.uniqueSessions())
        if (ss.probeUnsure && !ss.threadId && ss.listeners.size) {
          ss.ready = this.probe(ss, ss.publicId);
          void ss.ready.then(() => (ss.threadId ? ss.reload(true) : undefined));
        }
    }
  }

  /** Asks the bridge whether Codex is there and signed in. */
  async refreshStatus() {
    let st: CodexStatus;
    try {
      st = await this.client.status();
    } catch (e) {
      this.bridgeStatus = { ...(this.bridgeStatus ?? {}), error: errText(e) };
      if (e instanceof CodexUnavailableError) this.setState(e.disabled ? 'DISABLED' : 'OUTDATED');
      else if (e instanceof TypeError || /fetch failed|ECONNREFUSED|abort|timeout/i.test(errText(e))) {
        this.setState('OFFLINE');
        if (this.bridge.state !== 'running') void this.bridge.ensureRunning().catch(() => undefined);
      } else this.setState('ERROR');
      this.changed('status');
      return;
    }
    this.bridgeStatus = st;
    if (!st.installed) {
      this.setState('NOT_INSTALLED');
      this.changed('settings');
      return;
    }
    await this.refreshAccount();
  }

  /** Reads the account (starts Codex on the bridge if needed); READY or SIGNED_OUT. */
  async refreshAccount() {
    try {
      const res = await this.client.rpc('account/read', { refreshToken: false });
      const acc = o(res, 'account');
      this.account = acc ? { type: str(acc, 'type') ?? '', email: str(acc, 'email'), plan: str(acc, 'planType') } : null;
      const needsAuth = bool(res, 'requiresOpenaiAuth') === true;
      this.setState(!acc && needsAuth ? 'SIGNED_OUT' : 'READY');
      if (acc) await this.refreshRateLimits();
    } catch (e) {
      // Codex did not start (or answer): the status shows why
      this.bridgeStatus = { ...(this.bridgeStatus ?? {}), error: errText(e) };
      this.setState('ERROR');
    }
    this.changed('status');
    this.changed('settings');
  }

  async refreshRateLimits() {
    try {
      const res = await this.client.rpc('account/rateLimits/read');
      this.rateLimits = limitsOf(o(res, 'rateLimits'));
      this.changed('models');
    } catch (e) {
      this.log(`[codex] rate limits: ${errText(e)}`);
    }
  }

  /** Reads the usage limits again shortly (a burst of finished turns asks once). */
  private refreshRateLimitsSoon() {
    if (this.limitsTimer) return;
    this.limitsTimer = setTimeout(() => {
      this.limitsTimer = null;
      void this.refreshRateLimits();
    }, 1500);
  }

  // ------------------------------------------------------------------ account (settings)

  /** Starts a ChatGPT sign-in: a browser sign-in that comes back to Codex on this machine, or a device code. */
  async startLogin(deviceCode: boolean): Promise<string> {
    const res = await this.client.rpc('account/login/start', { type: deviceCode ? 'chatgptDeviceCode' : 'chatgpt' });
    const id = str(res, 'loginId');
    const url = str(res, 'verificationUrl') ?? str(res, 'authUrl');
    if (!id || !url) throw new Error('Codex did not start the sign-in');
    this.login = { loginId: id, url, code: str(res, 'userCode') };
    this.opts.openUrl(url);
    this.changed('settings');
    return deviceCode ? `Enter the code ${this.login.code ?? ''} on the sign-in page` : 'Finish signing in in your browser';
  }

  async cancelLogin() {
    const l = this.login;
    if (!l) return;
    this.login = null;
    this.changed('settings');
    await this.client.rpc('account/login/cancel', { loginId: l.loginId }).catch(() => undefined);
  }

  async logout() {
    await this.client.rpc('account/logout');
    await this.refreshAccount();
  }

  openUrl(url: string) {
    this.opts.openUrl(url);
  }

  // ------------------------------------------------------------------ install / restart (settings)

  async startCliJob(action: 'install' | 'update'): Promise<void> {
    this.cliJob = await this.client.startCliJob(action);
    this.changed('settings');
    if (this.cliPoll) return;
    this.cliPoll = setInterval(async () => {
      const j = await this.client.cliJob().catch(() => null);
      if (!j) return;
      this.cliJob = j;
      this.changed('settings');
      if (!j.running) {
        if (this.cliPoll) clearInterval(this.cliPoll);
        this.cliPoll = null;
        const ok = j.exit_code === 0;
        this.notify(ok ? 'info' : 'error', ok ? (action === 'install' ? 'Codex installed' : 'Codex is up to date') : `Codex ${action} failed`);
        await this.refreshStatus();
        if (j.exit_code === 0) {
          await this.loadModels();
          await this.refreshThreads();
        }
      }
    }, 1500);
  }

  async refreshCliJob() {
    this.cliJob = (await this.client.cliJob().catch(() => null)) ?? this.cliJob;
  }

  async restartServer(): Promise<void> {
    await this.client.restart();
    await this.refreshStatus();
    await this.loadModels();
  }

  // ------------------------------------------------------------------ models & commands

  models(): ModelsState {
    const windows = quotaWindows(this.rateLimits);
    // which limit the chat pill shows: the shared view preference (model sheet → "Shown in chat")
    const pill = this.store.get<{ quotaPillWindow?: '5h' | '7d' }>('ui.prefs')?.quotaPillWindow === '7d' ? '7d' : '5h';
    const shortest = windows[0] ?? null;
    const longest = windows.length > 1 ? windows[windows.length - 1] : shortest;
    const win = pill === '7d' ? longest : shortest;
    const quotaText = win ? `${win.label === '5h' ? '' : `${win.label} `}${remainingText(win.remaining, false)}` : null;
    const models = this.modelList.map((m) => ({
      ...m,
      group: windows.length ? QUOTA_GROUP : null,
      quotaRemaining: win?.remaining ?? null,
      quotaText,
    }));
    return {
      agent: 'CODEX',
      models,
      selectedId: this.selectedModelId(),
      groups: windows.length && models.length ? [{ name: QUOTA_GROUP, windows }] : [],
      refreshing: this.refreshing,
    };
  }

  /** The model new messages go to: the picked one, else Codex's default, else the first. */
  selectedModelId(): string | null {
    const list = this.modelList;
    if (this.selectedModel && (!list.length || list.some((m) => m.id === this.selectedModel))) return this.selectedModel;
    return list.find((m) => m.isDefault)?.id ?? list[0]?.id ?? null;
  }

  modelName(id: string | null): string {
    return (id && this.modelList.find((m) => m.id === id)?.displayName) || id || '';
  }

  /** Reasoning efforts `model` supports. */
  effortsOf(model: string | null): string[] {
    return (model && this.modelEfforts.get(model)) || [];
  }

  /** Effort a chat (or a new chat: null) uses: its own, else the remembered one; one the model lacks → its default. */
  effortFor(s: CodexSession | null): string {
    const model = this.chatModel(s) ?? this.selectedModelId();
    const list = this.effortsOf(model);
    const pref = this.store.get<string>('codex.effort') ?? '';
    let e = s?.effort ?? pref;
    if (list.length && !list.includes(e)) e = (list.includes(pref) ? pref : null) ?? (model ? this.modelDefaultEffort.get(model) : null) ?? list[0];
    return e;
  }

  permissionMode(): string {
    const m = this.store.get<string>('codex.permissionMode');
    return m && MODES.includes(m) ? m : MODE_AUTO;
  }

  setPermissionMode(mode: string) {
    if (!MODES.includes(mode)) return;
    this.store.set('codex.permissionMode', mode);
    this.changed('controls');
    this.changed('settings');
    this.emitAll();
  }

  setDefaultEffort(effort: string) {
    this.store.set('codex.effort', effort);
    this.changed('controls');
    this.changed('settings');
  }

  autoTitle(): boolean {
    return this.store.get<boolean>('codex.autoTitle') !== false;
  }

  refreshModels() {
    if (this.refreshing) return;
    this.refreshing = true;
    this.changed('models');
    void Promise.allSettled([this.loadModels(), this.refreshRateLimits(), this.refreshSkills()]).then(() => {
      this.refreshing = false;
      this.changed('models');
    });
  }

  async loadModels() {
    try {
      const res = await this.client.rpc('model/list', { limit: 100 });
      const data = arr(res, 'data').map((x) => obj(x)).filter((x): x is J => x != null);
      this.allModelIds = new Set(data.map((m) => str(m, 'id')).filter((x): x is string => !!x));
      const raw = data.filter((m) => m.hidden !== true);
      this.modelEfforts = new Map(raw.map((m) => [str(m, 'id') ?? '', arr(m, 'supportedReasoningEfforts').map((e) => str(e, 'reasoningEffort')).filter((e): e is string => !!e)]));
      this.modelDefaultEffort = new Map(raw.map((m) => [str(m, 'id') ?? '', str(m, 'defaultReasoningEffort') ?? '']));
      this.modelList = raw.map((m) => {
        const id = str(m, 'id') ?? '';
        return {
          id,
          key: id,
          displayName: (str(m, 'displayName') ?? '').trim() || id,
          family: 'OTHER',
          description: str(m, 'description') ?? '',
          isDefault: m.isDefault === true,
          baseName: 'OpenAI',
          tier: null,
        } satisfies AiModel;
      });
      this.modelsError = this.modelList.length ? null : 'No models: sign in to Codex in Settings → Codex.';
    } catch (e) {
      this.modelsError = errText(e);
      this.log(`[codex] models: ${this.modelsError}`);
    }
    this.changed('models');
    this.changed('controls');
    this.emitAll();
  }

  selectModel(conversationId: string | null, modelId: string) {
    this.selectedModel = modelId;
    this.store.set('codex.model', modelId);
    this.changed('models');
    // the effort list follows the model
    this.changed('controls');
    const s = conversationId ? this.sessions.get(conversationId) : undefined;
    if (s) s.model = modelId;
    this.emitAll();
  }

  commands(): SlashCommandView[] {
    return this.slash;
  }

  /** Codex's skills (`skills/list`) for the "/" menu. */
  async refreshSkills() {
    const cwds = [...new Set([...this.uniqueSessions()].map((s) => pathOfUri(this.conversationOf(s)?.workspaceUri)).filter((x): x is string => !!x))];
    try {
      const res = await this.client.rpc('skills/list', cwds.length ? { cwds } : {});
      const seen = new Set<string>();
      const skills: J[] = [];
      for (const e of arr(res, 'data'))
        for (const sk of arr(e, 'skills')) {
          const n = str(sk, 'name');
          if (!n || seen.has(n) || sk.enabled === false) continue;
          seen.add(n);
          skills.push(sk);
        }
      this.skillPaths = new Map(skills.map((sk) => [str(sk, 'name')!, str(sk, 'path') ?? '']).filter(([, p]) => !!p) as [string, string][]);
      this.slash = [
        ...BUILTIN_COMMANDS,
        ...skills.map((sk) => ({
          command: `/${str(sk, 'name')}`,
          description: (str(sk, 'shortDescription') ?? '').trim() || str(sk, 'description') || null,
          kind: 'skill' as const,
          argumentHint: 'what to do',
        })),
      ];
      this.changed('commands');
    } catch (e) {
      this.log(`[codex] skills: ${errText(e)}`);
    }
  }

  // ------------------------------------------------------------------ controls strip

  controls(conversationId: string | null): ControlChipView[] {
    return this.controlsFor(conversationId ? (this.sessions.get(conversationId) ?? null) : null);
  }

  /** Port of CodexControlsStrip: implement plan, plan mode, reasoning effort, approval mode. */
  private controlsFor(s: CodexSession | null): ControlChipView[] {
    const chips: ControlChipView[] = [];
    const plan = s ? s.planMode : this.newChatPlan;
    const running = s?.transcript.isTurnActive ?? false;
    if (s && plan && !running && s.transcript.lastPlan)
      chips.push({ id: 'implementPlan', label: 'Implement plan', kind: 'action', value: 'run', icon: 'play_arrow', tone: 'success' });
    chips.push({ id: 'plan', label: plan ? 'Plan mode' : 'Plan', kind: 'toggle', value: plan ? 'on' : 'off', icon: 'lightbulb', tone: plan ? 'accent' : null });
    const efforts = this.effortsOf(this.chatModel(s) ?? this.selectedModelId());
    if (efforts.length) {
      const effort = this.effortFor(s);
      chips.push({
        id: 'effort',
        label: `Reasoning: ${effortLabel(effort)}`,
        title: 'Reasoning · how long Codex thinks before answering',
        kind: 'select',
        value: effort,
        options: efforts.map((e) => ({ value: e, label: effortLabel(e), description: effortDescription(e) })),
        icon: 'psychology',
        tone: ['high', 'xhigh', 'max', 'ultra'].includes(effort) ? 'accent' : null,
      });
    }
    const mode = this.permissionMode();
    chips.push({
      id: 'mode',
      label: modeLabel(mode),
      title: 'Approvals · what Codex asks before doing',
      kind: 'select',
      value: mode,
      options: MODES.map((m) => ({ value: m, label: modeLabel(m), description: modeDescription(m) })),
      icon: modeIcon(mode),
      tone: mode === MODE_FULL ? 'warn' : null,
    });
    return chips;
  }

  async setControl(conversationId: string | null, id: string, value: string) {
    const s = conversationId ? this.session(conversationId) : null;
    if (value === 'details') {
      // what a chip means (the app's sheet notes)
      const note =
        id === 'mode'
          ? `${modeLabel(this.permissionMode())}: ${modeDescription(this.permissionMode())} Applies to the next message of this chat and to new chats.`
          : id === 'effort'
            ? `Reasoning ${effortLabel(this.effortFor(s))}: ${effortDescription(this.effortFor(s))} Applies to the next message and to new chats.`
            : id === 'plan'
              ? 'Plan mode: Codex explores and proposes a plan (it may ask questions) instead of changing anything.'
              : null;
      if (note) this.notify('info', note);
      return;
    }
    switch (id) {
      case 'effort':
        if (s) {
          s.effort = value;
          s.scheduleEmit();
        }
        // the choice is also the default for new chats (as the app)
        this.setDefaultEffort(value);
        return;
      case 'mode':
        this.setPermissionMode(value);
        return;
      case 'plan':
        if (s) {
          s.planMode = value === 'on';
          s.scheduleEmit();
        } else {
          this.newChatPlan = value === 'on';
          this.changed('controls');
        }
        return;
      case 'implementPlan':
        if (s && value !== 'off') await this.implementPlan(s);
        return;
    }
  }

  /** Leaves plan mode and asks Codex to carry out the plan it proposed. */
  private async implementPlan(s: CodexSession) {
    s.planMode = false;
    s.scheduleEmit();
    await this.send({ conversationId: s.publicId, isNew: false, text: 'Implement the plan.', attachments: [], modelId: null, workspaceUri: null });
  }

  // ------------------------------------------------------------------ conversations

  conversations(): Conversation[] {
    if (this.convCache) return this.convCache;
    const out = new Map<string, Conversation>();
    for (const c of this.serverList) {
      const tid = this.threadIdOf(c.id);
      const isRunning = this.running.has(tid);
      out.set(c.id, isRunning === c.isRunning ? c : { ...c, isRunning, notFullyIdle: isRunning, runStatus: isRunning ? 'RUNNING' : 'IDLE' });
    }
    for (const s of this.uniqueSessions()) {
      const c = s.localConversation;
      if (!c || out.has(c.id)) continue;
      const isRunning = (s.threadId != null && this.running.has(s.threadId)) || s.transcript.isTurnActive;
      out.set(c.id, { ...c, isRunning, notFullyIdle: isRunning, runStatus: isRunning ? 'RUNNING' : 'IDLE' });
    }
    this.convCache = [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return this.convCache;
  }

  private conversationOf(s: CodexSession): Conversation | null {
    return this.conversations().find((c) => c.id === s.publicId) ?? s.localConversation;
  }

  /** The thread id behind an id a view uses. */
  threadIdOf(id: string): string {
    return this.aliases[id] ?? this.sessions.get(id)?.threadId ?? id;
  }

  /** The id views use for a thread (the view's own id of a chat started here). */
  publicIdOf(threadId: string): string {
    return this.aliasOfThread.get(threadId) ?? threadId;
  }

  async refreshThreads(): Promise<void> {
    if (this.refreshingThreads) return this.refreshingThreads;
    this.refreshingThreads = (async () => {
      let res: any;
      try {
        res = await this.client.rpc('thread/list', { limit: 100, sortKey: 'updated_at', sourceKinds: SOURCES });
      } catch (e) {
        this.log(`[codex] thread/list: ${errText(e)}`);
        return;
      }
      const archived = await this.client.rpc('thread/list', { limit: 50, sortKey: 'updated_at', archived: true, sourceKinds: SOURCES }).catch(() => null);
      const live = arr(res, 'data').map((t) => obj(t)).filter((t): t is J => t != null);
      const old = arr(archived, 'data').map((t) => obj(t)).filter((t): t is J => t != null);
      const list = [...live.map((t) => this.conversationFromThread(t, false)), ...old.map((t) => this.conversationFromThread(t, true))].filter((c): c is Conversation => c != null);
      const ids = new Set([...live, ...old].map((t) => str(t, 'id')).filter((x): x is string => !!x));
      const active = new Set(live.filter((t) => str(o(t, 'status'), 'type') === 'active').map((t) => str(t, 'id')!));
      for (const id of [...this.running]) if (!active.has(id) && ids.has(id)) this.running.delete(id);
      for (const id of active) this.running.add(id);
      this.listedThreads = ids;
      this.serverList = list;
      for (const s of this.uniqueSessions()) if (s.threadId && ids.has(s.threadId)) s.localConversation = null;
      this.changed('conversations');
    })().finally(() => {
      this.refreshingThreads = null;
    });
    return this.refreshingThreads;
  }

  private conversationFromThread(t: J, archived: boolean): Conversation | null {
    const tid = str(t, 'id');
    if (!tid) return null;
    const cwd = str(t, 'cwd') ?? '';
    // the preview is the first message as sent: its hidden blocks (even cut off) never become the title
    const named = cleanTitle(str(t, 'name') ?? '').trim();
    const first = cleanTitle(str(t, 'preview') ?? '')
      .split('\n')
      .find((l) => l.trim())
      ?.trim();
    const title = named || (first ? (first.length > 60 ? `${first.slice(0, 60)}…` : first) : 'New Chat');
    this.previews.set(tid, cleanTitle(str(t, 'preview') ?? ''));
    const created = (Number(t.createdAt) || 0) * 1000;
    const isRunning = str(o(t, 'status'), 'type') === 'active';
    return {
      id: this.publicIdOf(tid),
      title,
      modelId: str(t, 'model') ?? '',
      createdAt: created,
      updatedAt: (Number(t.updatedAt) || Number(t.createdAt) || 0) * 1000,
      isRunning,
      notFullyIdle: isRunning,
      hasActivity: false,
      runStatus: isRunning ? 'RUNNING' : 'IDLE',
      stepCount: 0,
      workspaceUri: cwd ? `file://${cwd}` : '',
      nestingDepth: 0,
      agent: 'CODEX',
      archived,
    };
  }

  /** Reads the chat list again shortly (a burst of events asks once). */
  private scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshThreads();
    }, 700);
  }

  private applyTitle(threadId: string, title: string) {
    this.serverList = this.serverList.map((c) => (this.threadIdOf(c.id) === threadId ? { ...c, title } : c));
    const s = this.sessions.get(threadId);
    if (s?.localConversation) s.localConversation = { ...s.localConversation, title };
    this.changed('conversations');
    s?.scheduleEmit();
  }

  private setAlias(viewId: string, threadId: string) {
    if (viewId === threadId) return;
    this.aliases[viewId] = threadId;
    this.aliasOfThread.set(threadId, viewId);
    const keys = Object.keys(this.aliases);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ALIASES))) {
      this.aliasOfThread.delete(this.aliases[k]);
      delete this.aliases[k];
    }
    this.store.set('codex.aliases', this.aliases);
  }

  private dropAlias(threadId: string) {
    const view = this.aliasOfThread.get(threadId);
    if (!view) return;
    this.aliasOfThread.delete(threadId);
    delete this.aliases[view];
    this.store.set('codex.aliases', this.aliases);
  }

  async conversationAction(id: string, action: 'delete' | 'fork' | 'rename' | 'archive' | 'unarchive', value?: string): Promise<string | void> {
    const s = this.sessions.get(id);
    const tid = this.threadIdOf(id);
    const exists = this.listedThreads.has(tid) || (s?.threadId != null && s.threadId === tid);
    switch (action) {
      case 'delete': {
        if (exists) await this.client.rpc('thread/delete', { threadId: tid });
        this.serverList = this.serverList.filter((c) => this.threadIdOf(c.id) !== tid);
        this.listedThreads.delete(tid);
        this.running.delete(tid);
        if (s) this.dropSession(s, true);
        this.dropAlias(tid);
        this.changed('conversations');
        return;
      }
      case 'fork': {
        if (!exists) {
          this.notify('info', 'Send a message first: there is nothing to copy yet.');
          return;
        }
        const res = await this.client.rpc('thread/fork', { threadId: tid, excludeTurns: true });
        const newId = str(o(res, 'thread'), 'id');
        await this.refreshThreads();
        return newId ?? undefined;
      }
      case 'rename': {
        const title = value?.trim();
        if (!title) return;
        if (!exists) {
          if (s?.localConversation) s.localConversation = { ...s.localConversation, title };
          this.changed('conversations');
          s?.scheduleEmit();
          return;
        }
        await this.client.rpc('thread/name/set', { threadId: tid, name: title });
        this.applyTitle(tid, title);
        return;
      }
      case 'archive':
      case 'unarchive': {
        if (!exists) return;
        await this.client.rpc(action === 'archive' ? 'thread/archive' : 'thread/unarchive', { threadId: tid });
        await this.refreshThreads();
        return;
      }
    }
  }

  // ------------------------------------------------------------------ sessions

  private *uniqueSessions(): Generator<CodexSession> {
    const seen = new Set<CodexSession>();
    for (const s of this.sessions.values())
      if (!seen.has(s)) {
        seen.add(s);
        yield s;
      }
  }

  private emitAll() {
    for (const s of this.uniqueSessions()) s.scheduleEmit();
  }

  /** The session of any id a view or Codex uses (made when missing). */
  private session(id: string): CodexSession {
    const known = this.sessions.get(id);
    if (known) return known;
    const tid = this.aliases[id] ?? id;
    const byThread = this.sessions.get(tid);
    if (byThread) {
      this.sessions.set(id, byThread);
      return byThread;
    }
    const publicId = this.aliasOfThread.get(tid) ?? id;
    const s = new CodexSession(publicId, this);
    this.sessions.set(id, s);
    this.sessions.set(publicId, s);
    if (this.aliases[id] != null || this.aliasOfThread.has(tid) || this.listedThreads.has(tid)) this.attachThread(s, tid);
    else s.ready = this.probe(s, id);
    return s;
  }

  private attachThread(s: CodexSession, threadId: string) {
    s.threadId = threadId;
    s.transcript.threadId = threadId;
    this.sessions.set(threadId, s);
  }

  /** Whether `id` is an existing thread (one not listed yet: an old one, or the list is still loading). */
  private async probe(s: CodexSession, id: string): Promise<void> {
    try {
      const res = await this.client.rpc('thread/read', { threadId: id });
      if (str(o(res, 'thread'), 'id')) {
        this.attachThread(s, id);
        s.probeUnsure = false;
        return;
      }
    } catch (e) {
      // a JSON-RPC error ("thread not loaded", "invalid thread id"): a new chat; anything else: ask again later
      s.probeUnsure = !(e instanceof CodexRpcError && !e.unavailable);
    }
    s.isLoading = false;
    s.scheduleEmit();
  }

  dropSession(s: CodexSession, force = false) {
    if (!force) {
      if (s.listeners.size) return;
      // a reply still running (or waiting on an answer) keeps its live copy
      if (s.transcript.isTurnActive || (s.threadId && [...this.pendingAll.values()].some((p) => p.threadId === s.threadId))) {
        s.scheduleDrop();
        return;
      }
    }
    s.close();
    for (const [k, v] of [...this.sessions]) if (v === s) this.sessions.delete(k);
    if (s.localConversation) this.changed('conversations');
  }

  subscribe(conversationId: string, listener: (s: ChatState) => void) {
    const s = this.session(conversationId);
    s.addListener(listener);
    return () => s.removeListener(listener);
  }

  getState(conversationId: string): ChatState {
    return this.session(conversationId).state();
  }

  private pendingFor(threadId: string | null): Pending[] {
    if (!threadId) return [];
    return [...this.pendingAll.values()].filter((p) => p.threadId === threadId);
  }

  /** What a view shows of a session. */
  stateOf(s: CodexSession): ChatState {
    const mine = this.pendingFor(s.threadId);
    const awaiting = new Set(mine.filter((p) => !p.isQuestion && p.itemId).map((p) => p.itemId!));
    const q = mine.find((p) => p.isQuestion) ?? null;
    const question: CodexQuestion | null = q ? { key: q.key, turnId: q.turnId, questions: arr(q.params, 'questions').map((x) => obj(x)).filter((x): x is J => x != null) } : null;
    const messages = s.transcript.toChatMessages(s.publicId, awaiting, question);
    const questionnaire = question ? CodexTranscript.questionnaireOf(question) : null;
    return {
      conversation: this.conversationOf(s),
      agent: 'CODEX',
      messages,
      isStreaming: s.transcript.isTurnActive,
      isLoading: s.isLoading && messages.length === 0,
      error: s.error,
      queued: s.queued,
      approvals: mine.filter((p) => !p.isQuestion).map((p) => approvalView(p, messages)),
      question: q && questionnaire ? ({ key: q.key, agent: 'CODEX', questionnaire } satisfies QuestionView) : null,
      artifacts: [],
      workingLabel: null,
      controls: this.controlsFor(s),
      notice: s.notice,
      modelId: this.chatModel(s),
    };
  }

  /** The model a chat's next message goes to, when it has its own (one this account can use). */
  private chatModel(s: CodexSession | null): string | null {
    const m = s?.model;
    return m && (!this.modelList.length || this.modelList.some((x) => x.id === m)) ? m : null;
  }

  /** Loads a chat's turns (reading needs no subscription in Codex). Port of CodexChatBackend.reload. */
  async loadThread(s: CodexSession, restore: boolean) {
    const tid = s.threadId;
    if (!tid || s.closed) return;
    const startEpoch = this.epoch;
    const fail = (e: unknown) => {
      s.error = `Could not load this chat: ${errText(e)}`;
      s.isLoading = false;
      s.scheduleEmit();
    };
    let read: J | null;
    const turns: J[] = [];
    try {
      read = o(await this.client.rpc('thread/read', { threadId: tid }), 'thread');
      let cursor: string | null = null;
      let pages = 0;
      do {
        const params: J = { threadId: tid, limit: 30, itemsView: 'full', sortDirection: 'desc' };
        if (cursor) params.cursor = cursor;
        const page = await this.client.rpc('thread/turns/list', params);
        turns.push(...arr(page, 'data').map((x) => obj(x)).filter((x): x is J => x != null));
        cursor = str(page, 'nextCursor');
      } while (cursor && ++pages < 4);
    } catch (e) {
      fail(e);
      return;
    }
    // each turn's model and token use: Codex's record on disk (history has neither)
    const meta = await this.client.turnsMeta(tid).catch(() => null);
    if (s.closed || s.threadId !== tid) return;
    const active = str(o(read, 'status'), 'type') === 'active';
    // a turn started while this was loading: the snapshot is older than what is shown, its end reloads again
    if (!active && s.transcript.isTurnActive && s.turnStartedAt > startEpoch) return;
    s.transcript.model = str(read, 'model');
    s.transcript.loadHistory([...turns].reverse(), active);
    if (meta) s.transcript.applyMeta(meta);
    if (restore) {
      // the picker and the chip show what the chat last ran on: its newest turn's model and effort (the thread's own
      // setting can differ, e.g. changed elsewhere without a message)
      const last = turns.map((t) => meta?.[str(t, 'id') ?? '']).find((m) => m?.model != null);
      const model = last?.model ?? str(read, 'model');
      if (model && s.model == null) s.model = model;
      const effort = last?.effort ?? str(read, 'reasoningEffort');
      if (effort && s.effort == null) s.effort = effort;
    }
    const wasRunning = this.running.has(tid);
    if (active) this.running.add(tid);
    else this.running.delete(tid);
    if (wasRunning !== active) this.changed('conversations');
    s.isLoading = false;
    s.loadedOnce = true;
    if (s.error?.startsWith('Could not load')) s.error = null;
    await this.refreshQueue(s);
    s.emitNow();
  }

  // ------------------------------------------------------------------ sending

  async send(req: SendRequest): Promise<void> {
    const s = this.session(req.conversationId);
    await s.ready;
    if (s.probeUnsure && !s.threadId) {
      s.ready = this.probe(s, req.conversationId);
      await s.ready;
    }
    // commands are read without the hidden notes (the host puts its global context in front of messages)
    const typed = collapseExpansions(req.text).trim();
    if (!req.attachments.length && (await this.runCommand(s, typed))) return;
    if (BLOCKING.includes(this.codexState)) {
      this.notify('warning', `Codex is not available: ${STATE_LABEL[this.codexState]}. Check Settings → Codex.`);
      return;
    }
    if (!req.text.trim() && !req.attachments.length) return;

    const isNew = !s.threadId;
    const busy = !isNew && s.transcript.isTurnActive;
    const picked = req.modelId && (!this.modelList.length || this.modelList.some((m) => m.id === req.modelId)) ? req.modelId : null;
    const modelId = (s.threadId ? this.chatModel(s) : null) ?? picked ?? this.selectedModelId();
    s.model = modelId;
    const workspace = pathOfUri(req.workspaceUri) ?? pathOfUri(this.conversationOf(s)?.workspaceUri);
    const clientId = `agm_${randomUUID()}`;
    const { input, promptText, images, names } = this.buildInput(req.text, typed, req.attachments);
    s.error = null;

    if (busy) {
      // Codex is working on this chat: the message waits in Codex's queue and runs after the current turn
      this.sentTo.add(s.threadId!);
      try {
        await this.client.rpc('thread/queue/add', { threadId: s.threadId, input, clientUserMessageId: clientId });
      } catch (e) {
        this.notify('error', `Could not queue the message: ${errText(e)}`);
        return;
      }
      if (!s.transcript.isTurnActive) await this.client.rpc('thread/queue/start', { threadId: s.threadId }).catch(() => undefined);
      await this.refreshQueue(s);
      s.emitNow();
      return;
    }

    s.transcript.addLocalPrompt(clientId, promptText, names, true, images);
    s.turnStartedAt = ++this.epoch;
    s.isLoading = false;
    // until turn/start answers, an "idle" status (thread/start sends one) does not end the reply
    s.turnStartPending = true;
    s.emitNow();

    if (isNew) {
      const firstLine = displayUserText(typed || 'Attachment', 'title').text.split('\n').find((l) => l.trim()) ?? 'Chat';
      const now = Date.now();
      s.localConversation = {
        id: s.publicId,
        title: s.localConversation?.title && s.localConversation.title !== 'New Chat' ? s.localConversation.title : firstLine.length > 40 ? `${firstLine.slice(0, 40)}...` : firstLine,
        modelId: modelId ?? '',
        createdAt: s.localConversation?.createdAt ?? now,
        updatedAt: now,
        isRunning: true,
        notFullyIdle: true,
        hasActivity: true,
        runStatus: 'RUNNING',
        stepCount: 0,
        workspaceUri: workspace ? `file://${workspace}` : '',
        nestingDepth: 0,
        agent: 'CODEX',
        archived: false,
      };
      // the plan chip picked on the empty screen goes with the new chat
      if (this.newChatPlan) {
        s.planMode = true;
        this.newChatPlan = false;
        this.changed('controls');
      }
      this.changed('conversations');
      try {
        await this.createThread(s, workspace, modelId);
      } catch (e) {
        s.turnStartPending = false;
        this.fail(s, clientId, 'Could not start the Codex chat', e);
        return;
      }
    }
    const tid = s.threadId!;
    this.running.add(tid);
    this.sentTo.add(tid);
    this.changed('conversations');
    // the turn runs on the model picked now (its card shows it)
    if (modelId) s.transcript.model = modelId;
    const mode = this.permissionMode();
    const effort = this.effortFor(s);
    const params: J = {
      threadId: tid,
      input,
      clientUserMessageId: clientId,
      // the model's thinking comes as a summary only when asked for: the chat shows it as the thinking block
      summary: 'detailed',
      approvalPolicy: approvalPolicy(mode),
      sandboxPolicy: sandboxPolicy(mode),
    };
    if (modelId) params.model = modelId;
    if (effort) params.effort = effort;
    if (modelId) params.collaborationMode = { mode: s.planMode ? 'plan' : 'default', settings: { model: modelId, reasoning_effort: effort || null, developer_instructions: null } };
    try {
      await this.client.rpc('turn/start', params);
    } catch (e) {
      this.fail(s, clientId, 'Codex did not take the message', e);
    } finally {
      s.turnStartPending = false;
    }
  }

  /** Creates the thread of a new chat now and makes the view's id its alias. */
  private async createThread(s: CodexSession, workspace: string | null, modelId: string | null): Promise<string> {
    const mode = this.permissionMode();
    const params: J = { approvalPolicy: approvalPolicy(mode), sandbox: sandboxMode(mode), serviceName: 'AntiGem' };
    if (workspace) params.cwd = workspace;
    if (modelId) params.model = modelId;
    const res = await this.client.rpc('thread/start', params);
    const tid = str(o(res, 'thread'), 'id');
    if (!tid) throw new Error('Codex did not return a thread');
    this.attachThread(s, tid);
    this.setAlias(s.publicId, tid);
    s.createdHere = true;
    if (!s.localConversation) {
      const now = Date.now();
      s.localConversation = {
        id: s.publicId,
        title: 'New Chat',
        modelId: modelId ?? '',
        createdAt: now,
        updatedAt: now,
        isRunning: false,
        notFullyIdle: false,
        hasActivity: false,
        runStatus: 'IDLE',
        stepCount: 0,
        workspaceUri: workspace ? `file://${workspace}` : '',
        nestingDepth: 0,
        agent: 'CODEX',
        archived: false,
      };
    }
    this.changed('conversations');
    return tid;
  }

  private fail(s: CodexSession, clientId: string, title: string, e: unknown) {
    this.log(`[codex] ${title}: ${errText(e)}`);
    s.transcript.removeLocalPrompt(clientId);
    s.transcript.addError(title, errText(e) || 'Unknown error');
    if (s.threadId) this.running.delete(s.threadId);
    this.changed('conversations');
    s.emitNow();
  }

  /**
   * Codex's input of a message: the text (with a hidden list of files sent by path), a "/skill" as Codex's own skill
   * input, images by path (localImage) or inline (data URL).
   */
  private buildInput(text: string, typed: string, atts: ChatAttachment[]): { input: J[]; promptText: string; images: ChatAttachment[]; names: string[] } {
    const inputs: J[] = [];
    const images: ChatAttachment[] = [];
    const refs: FileRef[] = [];
    for (const a of atts) {
      const onDisk = !!a.path && a.path.startsWith('/') && fs.existsSync(a.path);
      if (a.isImage && a.base64) {
        inputs.push({ type: 'image', url: `data:${a.mimeType || 'image/png'};base64,${a.base64}` });
        images.push(a);
        continue;
      }
      if (a.isImage && onDisk) {
        inputs.push({ type: 'localImage', path: a.path });
        images.push(a);
        continue;
      }
      if (onDisk) {
        let size = a.size;
        let dir = a.kind === 'folder';
        try {
          const st = fs.statSync(a.path);
          dir ||= st.isDirectory();
          size = dir ? 0 : size || st.size;
        } catch {
          /* keep */
        }
        refs.push({ path: a.path, mimeType: dir ? 'inode/directory' : (a.mimeType ?? ''), size });
        continue;
      }
      if (a.base64) {
        // a file with no path here (pasted): saved where Codex can open it
        const dir = path.join(os.tmpdir(), 'antigem-codex-attachments', randomUUID());
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, path.basename(a.name || 'attachment'));
        fs.writeFileSync(p, Buffer.from(a.base64, 'base64'));
        refs.push({ path: p, mimeType: a.mimeType ?? '', size: fs.statSync(p).size });
      }
    }
    const body = text.trim();
    const promptText = [body, refs.length ? attachedFilesBlock(refs) : ''].filter(Boolean).join('\n\n') || 'See the attached file.';
    // "/skill-name …": the skill goes along as Codex's own skill input
    const skillName = /^\/([A-Za-z0-9_.:-]+)(\s|$)/.exec(typed)?.[1];
    const skillPath = skillName ? this.skillPaths.get(skillName) : undefined;
    const input = [textInput(promptText), ...(skillName && skillPath ? [{ type: 'skill', name: skillName, path: skillPath }] : []), ...inputs];
    return { input, promptText, images, names: [] };
  }

  /** Runs a Codex command typed as a message ("/compact", "/review …", "/plan …", "/fork"); false when it is not one. */
  private async runCommand(s: CodexSession, text: string): Promise<boolean> {
    if (!text.startsWith('/')) return false;
    const name = text.split(/\s/)[0].toLowerCase();
    const arg = text.slice(name.length).trim();
    switch (name) {
      case '/compact':
        await this.compact(s);
        return true;
      case '/review':
        await this.startReview(s, arg || null);
        return true;
      case '/plan':
        s.planMode = true;
        s.scheduleEmit();
        if (!s.threadId) {
          // the empty new-chat screen shows the defaults
          this.newChatPlan = true;
          this.changed('controls');
        }
        // the task itself goes out as a normal message, now in plan mode
        if (arg) await this.send({ conversationId: s.publicId, isNew: !s.threadId, text: arg, attachments: [], modelId: null, workspaceUri: null });
        else this.notify('info', 'Plan mode is on: Codex plans before changing anything.');
        return true;
      case '/fork': {
        const id = await this.conversationAction(s.publicId, 'fork');
        if (id) this.notify('info', 'Copied into a new chat (see the chat list)');
        return true;
      }
      case '/stop':
        await this.stop(s.publicId);
        return true;
    }
    const hint = APP_ONLY[name];
    if (hint) {
      this.notify('info', hint);
      return true;
    }
    return false;
  }

  /** Summarizes the chat so far (Codex's /compact): frees the context window. */
  private async compact(s: CodexSession) {
    if (!s.threadId) return this.notify('info', 'Nothing to compact yet.');
    if (s.transcript.isTurnActive) return this.notify('info', 'Wait for the reply to finish first');
    s.awaitTurn(true);
    try {
      await this.client.rpc('thread/compact/start', { threadId: s.threadId });
      this.sentTo.add(s.threadId);
    } catch (e) {
      s.awaitTurn(false);
      this.notify('error', `Could not compact: ${errText(e)}`);
    }
  }

  /** Codex's code review (/review): `instructions` what to review, or null for the uncommitted changes. */
  private async startReview(s: CodexSession, instructions: string | null) {
    if (s.transcript.isTurnActive) return this.notify('info', 'Wait for the reply to finish first');
    let tid = s.threadId;
    if (!tid) {
      try {
        tid = await this.createThread(s, pathOfUri(this.conversationOf(s)?.workspaceUri), this.selectedModelId());
      } catch (e) {
        return this.notify('error', `Could not start the Codex chat: ${errText(e)}`);
      }
    }
    s.awaitTurn(true);
    try {
      await this.client.rpc('review/start', { threadId: tid, target: instructions == null ? { type: 'uncommittedChanges' } : { type: 'custom', instructions } });
      this.sentTo.add(tid);
    } catch (e) {
      s.awaitTurn(false);
      this.notify('error', `Could not start the review: ${errText(e)}`);
    }
  }

  /** Stops a chat's turn, open or not. */
  async stop(conversationId: string) {
    const s = this.sessions.get(conversationId);
    const tid = this.threadIdOf(conversationId);
    let turnId = s?.transcript.activeTurnId ?? null;
    if (!turnId) {
      const res = await this.client.rpc('thread/turns/list', { threadId: tid, limit: 1, sortDirection: 'desc' }).catch(() => null);
      const t = obj(arr(res, 'data')[0]);
      if (str(t, 'status') === 'inProgress') turnId = str(t, 'id');
    }
    if (!turnId) {
      s?.awaitTurn(false);
      return;
    }
    await this.client.rpc('turn/interrupt', { threadId: tid, turnId }).catch((e) => this.notify('error', `Could not stop: ${errText(e)}`));
  }

  /**
   * Tool card actions. "terminate": ends a running command (Codex's background terminal of that command); when
   * Codex cannot (not a background terminal, already gone), the turn is stopped instead, like the app.
   */
  async toolAction(conversationId: string, toolId: string, action: string) {
    if (action !== 'terminate') return;
    const s = this.sessions.get(conversationId);
    const tid = this.threadIdOf(conversationId);
    const cmd = s?.transcript.commandOfTool(toolId) ?? null;
    let processId = cmd?.processId ?? null;
    if (cmd && !processId) {
      // the item names its process only once it became a background terminal: ask Codex
      const list = await this.client.rpc('thread/backgroundTerminals/list', { threadId: tid }).catch(() => null);
      processId = str(arr(list, 'data').find((x) => str(x, 'itemId') === cmd.itemId), 'processId');
    }
    if (processId) {
      try {
        const res = await this.client.rpc('thread/backgroundTerminals/terminate', { threadId: tid, processId });
        this.log(`[codex] terminate ${processId}: ${JSON.stringify(res)}`);
        if (res?.terminated === true) return;
      } catch (e) {
        this.log(`[codex] terminate ${processId}: ${errText(e)}`);
      }
    }
    // not a background terminal (or already gone): stop the turn, as the app does
    await this.stop(conversationId);
  }

  // ------------------------------------------------------------------ retry & edit (Codex's thread/revert)

  /** Asks again: the chat goes back to right before the turn of reply `messageId` and its prompt is sent again. */
  async retryMessage(conversationId: string, messageId: string): Promise<string | void> {
    const s = this.session(conversationId);
    if (!s.threadId) return 'Nothing to retry here';
    if (s.transcript.isTurnActive) return 'Stop the reply first';
    const turn = s.transcript.turnOfItem(messageId);
    const prompt = turn ? s.transcript.promptOf(turn) : null;
    if (!turn || !prompt?.trim()) return 'Nothing to retry here';
    if (!(await this.revertTo(s, turn.id))) return;
    await s.reload();
    await this.send({ conversationId: s.publicId, isNew: false, text: prompt, attachments: [], modelId: null, workspaceUri: null });
  }

  /**
   * Edits a sent prompt: the chat goes back to right before its turn and the text returns to the input. Codex does
   * not undo file changes (only the chat history goes back).
   */
  async rewind(conversationId: string, messageId: string): Promise<string | null> {
    const s = this.session(conversationId);
    if (s.threadId && s.transcript.isTurnActive) {
      this.notify('info', 'Stop the reply first');
      return null;
    }
    const turn = s.threadId ? s.transcript.turnOfItem(messageId) : null;
    if (!s.threadId || !turn) {
      this.notify('info', "This message can't be edited yet");
      return null;
    }
    const text = s.transcript.userTextOf(turn, messageId) || s.transcript.promptOf(turn) || '';
    if (!(await this.revertTo(s, turn.id))) return null;
    await s.reload();
    return displayUserText(text, 'edit').text;
  }

  private async revertTo(s: CodexSession, turnId: string): Promise<boolean> {
    try {
      await this.client.rpc('thread/revert', { threadId: s.threadId, beforeTurnId: turnId });
      return true;
    } catch (e) {
      this.notify('error', `Could not go back in the chat: ${errText(e)}`);
      return false;
    }
  }

  /** Messages of a chat that is not open (export / share). */
  async loadMessages(conversationId: string): Promise<ChatMessage[]> {
    const tid = this.threadIdOf(conversationId);
    const res = await this.client.rpc('thread/turns/list', { threadId: tid, limit: 100, itemsView: 'full', sortDirection: 'desc' }).catch(() => null);
    if (!res) return [];
    const t = new CodexTranscript(tid);
    t.loadHistory(
      arr(res, 'data')
        .map((x) => obj(x))
        .filter((x): x is J => x != null)
        .reverse(),
      false,
    );
    const meta = await this.client.turnsMeta(tid).catch(() => null);
    if (meta) t.applyMeta(meta);
    return t.toChatMessages(this.publicIdOf(tid), new Set(), null);
  }

  /** Chat contents search (Codex's own full-text thread search; previews when it is not available). */
  async search(query: string): Promise<{ conversationId: string; snippet: string }[]> {
    const q = query.trim();
    if (!q) return [];
    const hits = new Map<string, string>();
    try {
      for (const archived of [false, true]) {
        const res = await this.client.rpc('thread/search', { searchTerm: q, limit: 50, sortKey: 'updated_at', sourceKinds: SOURCES, archived });
        for (const r of arr(res, 'data')) {
          const id = str(o(r, 'thread'), 'id');
          if (id && !hits.has(id)) hits.set(id, cleanTitle(str(r, 'snippet') ?? '').replace(/\s+/g, ' ').trim());
        }
      }
    } catch (e) {
      this.log(`[codex] search: ${errText(e)}`);
      const lower = q.toLowerCase();
      for (const [id, preview] of this.previews) {
        const i = preview.toLowerCase().indexOf(lower);
        if (i >= 0) hits.set(id, preview.slice(Math.max(0, i - 40), i + q.length + 80).replace(/\s+/g, ' ').trim());
      }
    }
    return [...hits].map(([id, snippet]) => ({ conversationId: this.publicIdOf(id), snippet }));
  }

  // ------------------------------------------------------------------ approvals & questions

  async approval(conversationId: string, key: string, choiceId: string | undefined, deny: boolean, feedback?: string) {
    const p = this.pendingAll.get(key);
    if (!p) return;
    const s = this.sessions.get(conversationId) ?? (p.threadId ? this.sessions.get(p.threadId) : undefined);
    if (deny) {
      const result =
        p.method === 'item/permissions/requestApproval'
          ? { permissions: {}, scope: 'turn' }
          : p.method === 'mcpServer/elicitation/request'
            ? { action: 'decline', content: null, _meta: null }
            : p.method === 'applyPatchApproval' || p.method === 'execCommandApproval'
              ? { decision: 'denied' }
              : { decision: 'decline' };
      if (!(await this.answerRequest(p, result, s))) return;
      // the note goes to Codex right after, in the same turn
      const note = feedback?.trim();
      if (note && p.threadId && p.turnId) {
        await this.client
          .rpc('turn/steer', { threadId: p.threadId, expectedTurnId: p.turnId, input: [textInput(note)] })
          .catch((e) => this.notify('error', `Codex did not get your note: ${errText(e)}`));
      }
      return;
    }
    if (choiceId === 'rule') {
      // allows the command and saves the rule Codex suggested (its command prefix), so it is never asked again
      const rule = p.params.proposedExecpolicyAmendment;
      if (Array.isArray(rule)) {
        await this.answerRequest(p, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: rule } } }, s);
        return;
      }
    }
    const always = choiceId === 'session';
    const result =
      p.method === 'item/permissions/requestApproval'
        ? { permissions: o(p.params, 'permissions') ?? {}, scope: always ? 'session' : 'turn' }
        : p.method === 'mcpServer/elicitation/request'
          ? { action: 'accept', content: null, _meta: null }
          : p.method === 'applyPatchApproval' || p.method === 'execCommandApproval'
            ? { decision: always ? 'approved_for_session' : 'approved' }
            : { decision: always ? 'acceptForSession' : 'accept' };
    await this.answerRequest(p, result, s);
  }

  async answer(conversationId: string, key: string, answers: Record<string, string[]>, _note?: string, skip?: boolean) {
    const p = this.pendingAll.get(key);
    if (!p || !p.isQuestion) return;
    const s = this.sessions.get(conversationId) ?? (p.threadId ? this.sessions.get(p.threadId) : undefined);
    const out: J = {};
    if (!skip) {
      for (const q of arr(p.params, 'questions')) {
        const qid = str(q, 'id');
        if (!qid) continue;
        const list = (answers[qid] ?? []).map((a) => a.trim()).filter(Boolean);
        if (list.length) out[qid] = { answers: list };
      }
    }
    await this.answerRequest(p, { answers: out }, s);
  }

  private async answerRequest(p: Pending, result: unknown, s: CodexSession | undefined): Promise<boolean> {
    this.pendingAll.delete(p.key);
    s?.emitNow();
    try {
      await this.client.reply(p.key, result);
      return true;
    } catch (e) {
      this.notify('error', `Could not answer the request: ${errText(e)}`);
      s?.scheduleEmit();
      return false;
    }
  }

  // ------------------------------------------------------------------ queue

  private async refreshQueue(s: CodexSession) {
    if (!s.threadId) return;
    const res = await this.client.rpc('thread/queue/list', { threadId: s.threadId }).catch(() => null);
    if (!res) return;
    s.queued = arr(res, 'data')
      .map((q) => obj(q))
      .filter((q): q is J => q != null && !!str(q, 'id'))
      .map((q) => {
        const parts = arr(q, 'input').map((x) => obj(x)).filter((x): x is J => x != null);
        const raw = parts
          .filter((x) => str(x, 'type') === 'text')
          .map((x) => str(x, 'text') ?? '')
          .join('\n');
        return {
          id: str(q, 'id')!,
          text: displayUserText(raw, 'q').text,
          attachmentCount: parts.filter((x) => str(x, 'type') !== 'text').length,
          canSendNow: true,
          canDelete: true,
          isPending: false,
        };
      });
    s.scheduleEmit();
  }

  async queueAction(conversationId: string, id: string, action: 'sendNow' | 'delete') {
    const s = this.session(conversationId);
    const tid = s.threadId;
    if (!tid) return;
    if (action === 'delete') {
      await this.client.rpc('thread/queue/delete', { threadId: tid, queuedSubmissionId: id }).catch((e) => this.notify('error', `Could not remove the message: ${errText(e)}`));
      await this.refreshQueue(s);
      return;
    }
    // "Send now": the queued message joins the running turn (Codex reads it at its next step) instead of waiting
    const turnId = s.transcript.activeTurnId;
    if (!turnId) {
      await this.client.rpc('thread/queue/start', { threadId: tid, queuedSubmissionId: id });
      await this.refreshQueue(s);
      return;
    }
    const list = await this.client.rpc('thread/queue/list', { threadId: tid }).catch(() => null);
    const item = arr(list, 'data')
      .map((x) => obj(x))
      .find((x) => str(x, 'id') === id);
    if (!item) return;
    await this.client.rpc('thread/queue/delete', { threadId: tid, queuedSubmissionId: id });
    const steer: J = { threadId: tid, expectedTurnId: turnId, input: Array.isArray(item.input) ? item.input : [] };
    const cid = str(item, 'clientUserMessageId');
    if (cid) steer.clientUserMessageId = cid;
    try {
      await this.client.rpc('turn/steer', steer);
    } catch {
      // the turn ended meanwhile: queue it again so it runs next
      await this.client.rpc('thread/queue/add', { threadId: tid, input: steer.input, clientUserMessageId: cid ?? `agm_${randomUUID()}` }).catch(() => undefined);
    }
    await this.refreshQueue(s);
  }

  // ------------------------------------------------------------------ MCP servers (Codex's config.toml)

  /** The MCP servers in Codex's config (`mcp_servers`), with their live state (null until a chat connected it). */
  async mcpList(): Promise<{ name: string; config: J; status: string | null; error: string | null; toolCount: number }[]> {
    const cfg = o(o(await this.client.rpc('config/read', { includeLayers: false }), 'config'), 'mcp_servers') ?? {};
    const liveRes = await this.client.rpc('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }, 60_000).catch(() => null);
    const live = new Map(
      arr(liveRes, 'data')
        .map((x) => obj(x))
        .filter((x): x is J => x != null)
        .map((x) => [str(x, 'name') ?? '', x] as const),
    );
    return Object.keys(cfg)
      .sort()
      .map((name) => {
        const st = live.get(name);
        const toolsError = str(st, 'toolsError');
        return {
          name,
          config: obj(cfg[name]) ?? {},
          status: str(st, 'runtimeStatus') ?? (st ? (toolsError == null ? 'connected' : 'failed') : null),
          error: toolsError,
          toolCount: Object.keys(o(st, 'tools') ?? {}).length,
        };
      });
  }

  /** Names of the MCP servers in Codex's config (no connection made). */
  async mcpServerNames(): Promise<string[]> {
    return Object.keys(o(o(await this.client.rpc('config/read', { includeLayers: false }), 'config'), 'mcp_servers') ?? {});
  }

  private async writeMcp(name: string, value: unknown) {
    await this.client.rpc('config/batchWrite', { edits: [{ keyPath: `mcp_servers.${name}`, value, mergeStrategy: 'replace' }], reloadUserConfig: true });
    await this.client.rpc('config/mcpServer/reload').catch(() => undefined);
  }

  /** Adds (or replaces) a local MCP server (a command Codex starts) for every Codex chat. */
  addLocalMcp(name: string, command: string[], env: Record<string, string>) {
    if (!command.length) throw new Error('The command is empty');
    const v: J = { command: command[0] };
    if (command.length > 1) v.args = command.slice(1);
    if (Object.keys(env).length) v.env = env;
    return this.writeMcp(name, v);
  }

  /** Adds (or replaces) a remote (HTTP) MCP server for every Codex chat. */
  addRemoteMcp(name: string, url: string, headers: Record<string, string>) {
    const v: J = { url };
    if (Object.keys(headers).length) v.http_headers = headers;
    return this.writeMcp(name, v);
  }

  removeMcp(name: string) {
    return this.writeMcp(name, null);
  }

  /** Writes a server's whole entry (an edit keeps the fields the form does not show). */
  putMcp(name: string, value: J) {
    return this.writeMcp(name, value);
  }

  /** Switches a server on or off in Codex's config (`enabled`), for every Codex chat. */
  async setMcpEnabled(name: string, enabled: boolean) {
    await this.client.rpc('config/batchWrite', { edits: [{ keyPath: `mcp_servers.${name}.enabled`, value: enabled, mergeStrategy: 'replace' }], reloadUserConfig: true }, 30_000);
    await this.client.rpc('config/mcpServer/reload', {}, 30_000).catch(() => undefined);
  }

  /** Reconnects the MCP servers (Codex reloads them all). */
  async reloadMcp() {
    await this.client.rpc('config/mcpServer/reload', {}, 30_000);
  }

  // ------------------------------------------------------------------ events

  private connectEvents() {
    if (this.disposed || this.ws) return;
    const since = this.lastSeq >= 0 ? this.lastSeq + 1 : -1;
    let failure: string | null = null;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.bridge.wsUrl(`/api/codex/ws?since=${since}`), { headers: this.bridge.authHeaders() });
    } catch (e) {
      this.log(`[codex] events: ${errText(e)}`);
      this.wsTimer = setTimeout(() => this.connectEvents(), this.wsBackoff);
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.wsBackoff = 1000;
    });
    ws.on('message', (data) => {
      let f: J | null = null;
      try {
        f = obj(JSON.parse(String(data)));
      } catch {
        return;
      }
      if (!f) return;
      try {
        this.handleFrame(f);
      } catch (e) {
        this.log(`[codex] event: ${errText(e)}`);
      }
    });
    ws.on('error', (e) => {
      failure = e.message;
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      if (this.disposed) return;
      let delay = this.wsBackoff;
      this.wsBackoff = Math.min(this.wsBackoff * 2, 15_000);
      if (failure && /\b404\b/.test(failure)) {
        this.setState('OUTDATED');
        delay = 60_000;
      } else if (failure && /\b503\b/.test(failure)) {
        this.setState('DISABLED');
        delay = 60_000;
      } else if (this.codexState === 'READY') {
        // the stream dropped (bridge stopped?): READY is never re-checked otherwise
        void this.refreshStatus();
      }
      this.wsTimer = setTimeout(() => {
        this.wsTimer = null;
        this.connectEvents();
      }, delay);
    });
  }

  private handleFrame(f: J) {
    const type = str(f, 'type');
    if (type === 'bridge_state') {
      const st = o(f, 'state');
      this.pendingAll.clear();
      for (const r of arr(st, 'pending')) {
        const key = str(r, 'key');
        if (key) this.pendingAll.set(key, pendingOf(key, str(r, 'method') ?? '', o(r, 'params') ?? {}));
      }
      const next = Number(st?.next_seq ?? 0);
      const bufStart = Number(st?.buffer_start ?? 0);
      const event = str(f, 'event');
      if (event === 'attached') {
        const since = this.lastSeq + 1;
        const missed = this.lastSeq >= 0 && (bufStart > since || next < since);
        this.lastSeq = next - 1;
        if (missed) this.resync();
        if (this.codexState !== 'READY') void this.refreshStatus();
      } else if (event === 'exited') {
        // every running turn ended with the process
        this.running.clear();
        this.changed('conversations');
        const err = str(f, 'error');
        if (err) {
          this.log(`[codex] app-server stopped: ${err.slice(0, 300)}`);
          this.notify('warning', `Codex stopped: ${err.slice(0, 160)}`);
        }
        for (const s of this.uniqueSessions()) if (s.threadId && s.transcript.isTurnActive) void s.reload();
      }
      this.emitAll();
      return;
    }
    if (type !== 'bridge_line') return;
    const seq = Number(f.seq);
    if (Number.isFinite(seq) && seq > this.lastSeq) this.lastSeq = seq;
    const d = o(f, 'data');
    const method = str(d, 'method');
    if (!d || !method) return;
    const params = o(d, 'params') ?? {};
    const key = str(f, 'key');
    if ('id' in d && key) {
      const p = pendingOf(key, method, params);
      this.pendingAll.set(key, p);
      if (p.threadId) this.sessions.get(p.threadId)?.emitNow();
      return;
    }
    this.handleNotification(method, params, key);
  }

  private handleNotification(method: string, p: J, key: string | null) {
    const tid = str(p, 'threadId') ?? str(o(p, 'thread'), 'id');
    // a hidden thread that only makes a title: its reply is the title, nothing of it shows anywhere
    if (tid && this.titleRuns.has(tid)) {
      const item = o(p, 'item');
      if (method === 'item/completed' && str(item, 'type') === 'agentMessage') {
        const t = str(item, 'text');
        if (t) this.titleAnswers.set(tid, t);
      }
      if (method === 'turn/completed') this.titleRuns.get(tid)?.(this.titleAnswers.get(tid) ?? null);
      return;
    }
    switch (method) {
      case 'serverRequest/resolved':
        if (key && this.pendingAll.delete(key) && tid) this.sessions.get(tid)?.emitNow();
        break;
      case 'thread/status/changed':
        if (tid) {
          const type = str(o(p, 'status'), 'type');
          const active = type === 'active';
          if (active !== this.running.has(tid)) {
            if (active) this.running.add(tid);
            else this.running.delete(tid);
            this.changed('conversations');
          }
          const s = this.sessions.get(tid);
          if (s && type === 'idle' && s.transcript.isTurnActive && !s.turnStartPending) {
            s.transcript.settleAll();
            s.scheduleEmit();
          }
        }
        break;
      case 'thread/started':
      case 'thread/archived':
      case 'thread/unarchived':
      case 'thread/deleted':
        this.scheduleRefresh();
        break;
      case 'thread/name/updated': {
        const name = str(p, 'threadName');
        if (tid && name) this.applyTitle(tid, name);
        break;
      }
      case 'account/rateLimits/updated': {
        const l = limitsOf(o(p, 'rateLimits'));
        if (l) {
          this.rateLimits = l;
          this.changed('models');
        }
        break;
      }
      case 'account/updated':
        void this.refreshAccount();
        break;
      case 'account/login/completed':
        if (this.login?.loginId === str(p, 'loginId')) this.login = null;
        if (str(p, 'success') === 'true') {
          this.notify('info', 'Signed in to Codex');
          void this.refreshAccount().then(() => Promise.all([this.loadModels(), this.refreshThreads()]));
        } else {
          const err = str(p, 'error');
          if (err && err !== 'Login was not completed') this.notify('error', `Codex sign-in failed: ${err}`);
        }
        this.changed('settings');
        break;
      case 'thread/queue/changed':
        if (tid) {
          const s = this.sessions.get(tid);
          if (s) void this.refreshQueue(s);
        }
        break;
    }
    if (!tid) return;
    let s = this.sessions.get(tid);
    // a reply running in a chat nobody looks at, sent from here: keep a live copy (Codex saves it only at the end)
    if (!s && method === 'turn/started' && this.sentTo.has(tid)) {
      s = this.session(tid);
      s.isLoading = false;
      s.scheduleDrop();
    }
    if (!s) return;
    switch (method) {
      case 'turn/started':
        s.turnStartedAt = ++this.epoch;
        s.notice = null;
        s.awaitTurn(false);
        break;
      case 'error':
        if (str(p, 'willRetry') === 'true') s.notice = `Reconnecting… ${(str(o(p, 'error'), 'message') ?? '').slice(0, 140)}`;
        break;
      case 'model/rerouted':
        s.notice = `Codex switched from ${str(p, 'fromModel') ?? '?'} to ${str(p, 'toModel') ?? '?'}`;
        break;
    }
    const changed = s.transcript.apply(method, p);
    if (method === 'turn/completed') {
      s.notice = null;
      s.emitNow();
      this.requestTitleOnce(s);
      // the plan's usage after each reply
      this.refreshRateLimitsSoon();
      // the stored chat is the reference (final items): load it again once the turn is over
      const session = s;
      setTimeout(() => {
        if (!session.closed && !session.transcript.isTurnActive) {
          if (session.listeners.size) void session.reload();
          else session.loadedOnce = true;
        }
        this.scheduleRefresh();
      }, 500);
      return;
    }
    if (changed || method === 'error' || method === 'model/rerouted' || method === 'turn/started') s.scheduleEmit();
  }

  /** Everything that may have been missed while the event stream was down. */
  private resync() {
    this.scheduleRefresh();
    for (const s of this.uniqueSessions()) if (s.threadId && s.listeners.size) void s.reload();
  }

  // ------------------------------------------------------------------ chat titles

  /**
   * Codex's app-server never names a chat: its own terminal app does, after the first message, by running one turn in
   * a hidden read-only thread (its small title model at low effort when the plan has it) and saving the answer with
   * `thread/name/set`. The same here, once, after the first reply of a chat started here.
   */
  private requestTitleOnce(s: CodexSession) {
    const threadId = s.threadId;
    if (!threadId || !s.createdHere || !this.autoTitle()) return;
    const prompts = s.transcript.prompts();
    if (prompts.length !== 1 || this.titleAsked.has(threadId)) return;
    this.titleAsked.add(threadId);
    const raw = prompts[0];
    const typed = cleanTitle(raw).trim();
    const files = extractAttachedFiles(raw, 't').cards.map((c) => c.name);
    const subject = [typed || null, files.length ? `Attached files: ${files.join(', ')}` : null].filter(Boolean).join('\n');
    if (!subject) return;
    const model = this.allModelIds.has(TITLE_MODEL) ? TITLE_MODEL : (this.selectedModelId() ?? '');
    void (async () => {
      let temp: string | null = null;
      try {
        // like Codex's own app: no MCP servers for the hidden thread (nothing to start, nothing it could call)
        const mcp = await this.mcpServerNames().catch(() => [] as string[]);
        const params: J = {
          sandbox: 'read-only',
          approvalPolicy: 'never',
          ephemeral: true,
          // as small as app-server allows: no environments, extra tools or workspace roots, a one-line base prompt
          environments: [],
          dynamicTools: [],
          runtimeWorkspaceRoots: [],
          selectedCapabilityRoots: [],
          baseInstructions: "You write short titles for chats. Follow the user's instructions exactly.",
        };
        if (model) params.model = model;
        if (mcp.length) params.config = { mcp_servers: Object.fromEntries(mcp.map((n) => [n, { enabled: false }])) };
        temp = str(o(await this.client.rpc('thread/start', params), 'thread'), 'id');
        if (!temp) return;
        const done = new Promise<string | null>((resolve) => this.titleRuns.set(temp!, resolve));
        const turn: J = { threadId: temp, input: [textInput(titlePrompt(subject))], outputSchema: TITLE_SCHEMA };
        if (model === TITLE_MODEL) turn.effort = 'low';
        await this.client.rpc('turn/start', turn);
        const answer = await Promise.race([done, sleep(90_000).then(() => null)]);
        if (!answer) return;
        let title: string | null = null;
        try {
          title = str(JSON.parse(answer), 'title');
        } catch {
          title = null;
        }
        title = cleanTitle(title ?? '')
          .trim()
          .slice(0, 60);
        if (!title) return;
        await this.client.rpc('thread/name/set', { threadId, name: title });
        this.applyTitle(threadId, title);
      } catch (e) {
        this.log(`[codex] title: ${errText(e)}`);
      } finally {
        if (temp) {
          this.titleRuns.delete(temp);
          this.titleAnswers.delete(temp);
          await this.client.rpc('thread/unsubscribe', { threadId: temp }).catch(() => undefined);
        }
      }
    })();
  }

  // ------------------------------------------------------------------ dispose

  dispose() {
    this.disposed = true;
    this.settings.dispose();
    for (const t of [this.loopTimer, this.limitsTimer, this.refreshTimer, this.wsTimer]) if (t) clearTimeout(t);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.cliPoll) clearInterval(this.cliPoll);
    this.loopWake?.();
    try {
      this.ws?.close();
    } catch {
      /* closed */
    }
    this.ws = null;
    for (const s of this.uniqueSessions()) s.close();
    this.sessions.clear();
  }
}

// ------------------------------------------------------------------------------------------------ helpers

function pendingOf(key: string, method: string, params: J): Pending {
  return {
    key,
    method,
    params,
    threadId: str(params, 'threadId') ?? str(params, 'conversationId'),
    turnId: str(params, 'turnId'),
    itemId: str(params, 'itemId') ?? str(params, 'callId'),
    isQuestion: method === 'item/tool/requestUserInput',
  };
}

/** Codex's own title instructions (its terminal app), at most 960 bytes in all. */
function titlePrompt(subject: string): string {
  const prefix =
    'Generate a concise, single-line task title of at most 36 characters and under five words where possible. ' +
    "Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, " +
    "or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. " +
    'Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n\nUser prompt:\n';
  const room = 960 - Buffer.byteLength(prefix);
  let used = 0;
  let out = '';
  for (const ch of subject.trim()) {
    const n = Buffer.byteLength(ch);
    if (used + n > room) break;
    out += ch;
    used += n;
  }
  return prefix + out;
}

/**
 * Codex's approval requests as approval cards (port of codexApprovalItems): allow once, allow for the rest of the
 * session (or always allow the command prefix Codex suggests), or deny with an optional note that Codex gets right
 * away. `messages`: the chat, where a file change's diff is (its request does not carry it).
 */
function approvalView(p: Pending, messages: ChatMessage[]): ApprovalView {
  const prm = p.params;
  const toolId = p.itemId ? safeId(p.itemId) : null;
  let tool: { command: string; output: string } | null = null;
  if (toolId)
    for (let i = messages.length - 1; i >= 0 && !tool; i--) {
      const t = messages[i].toolCalls.find((x) => x.id === toolId);
      if (t) tool = t;
    }
  const reason = str(prm, 'reason');
  const base = {
    key: p.key,
    agent: 'CODEX' as const,
    reason,
    secondary: [],
    denyLabel: 'Deny',
    denyPlaceholder: 'Tell Codex what to do instead (optional)',
  };
  switch (p.method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval': {
      const network = o(prm, 'networkApprovalContext');
      const cmdStr = str(prm, 'command');
      const command =
        (cmdStr != null ? unwrapShell(cmdStr) : null) ??
        (Array.isArray(prm.command) ? (prm.command.filter((x: unknown) => typeof x === 'string') as string[]).join(' ') : null) ??
        tool?.command ??
        '';
      const rule = arr(prm, 'proposedExecpolicyAmendment').filter((x) => typeof x === 'string') as string[];
      return {
        ...base,
        icon: network ? 'web' : 'terminal',
        title: network ? 'Allow network access?' : 'Run a command?',
        subtitle: network ? `${str(network, 'protocol') ?? ''} ${str(network, 'host') ?? ''}`.trim() : str(prm, 'cwd'),
        preview: command.trim() ? `$ ${command}` : null,
        primary: { id: 'once', label: 'Allow' },
        always: [
          { id: 'session', label: 'Allow for this session', description: 'Codex asks again after a restart' },
          ...(rule.length ? [{ id: 'rule', label: `Always allow \`${rule.join(' ')}\``, description: 'Codex saves this rule' }] : []),
        ],
      };
    }
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval': {
      const grant = str(prm, 'grantRoot');
      const preview = tool?.output?.trim()
        ? tool.output
            .split('\n')
            .slice(0, 80)
            // the panel colors "+ " / "- " lines
            .map((line) => (line.startsWith('+') && !line.startsWith('+ ') ? `+ ${line.slice(1)}` : line.startsWith('-') && !line.startsWith('- ') ? `- ${line.slice(1)}` : line))
            .join('\n')
        : null;
      return {
        ...base,
        icon: 'edit',
        title: 'Change files?',
        subtitle: tool?.command ?? null,
        target: grant ? `Write access to ${grant}` : null,
        preview,
        primary: { id: 'once', label: 'Allow' },
        always: [{ id: 'session', label: 'Allow edits for this session', description: 'Codex asks again after a restart' }],
      };
    }
    case 'item/permissions/requestApproval':
      return {
        ...base,
        icon: 'shield',
        title: 'Grant more access?',
        subtitle: str(prm, 'cwd'),
        preview: o(prm, 'permissions') ? JSON.stringify(o(prm, 'permissions'), null, 2) : null,
        primary: { id: 'once', label: 'Allow for this turn' },
        always: [{ id: 'session', label: 'Allow for this session' }],
      };
    case 'mcpServer/elicitation/request':
      return {
        ...base,
        icon: 'mcp',
        title: str(prm, 'title') ?? `${str(prm, 'serverName') ?? 'An MCP server'} asks`,
        subtitle: str(prm, 'serverName'),
        target: str(prm, 'url'),
        reason: str(prm, 'message') ?? str(prm, 'description'),
        primary: { id: 'once', label: 'Continue' },
        always: [],
      };
    default:
      return { ...base, icon: 'shield', title: 'Allow this?', subtitle: p.method, primary: { id: 'once', label: 'Allow' }, always: [] };
  }
}
