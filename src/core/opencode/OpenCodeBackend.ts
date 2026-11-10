// OpenCode backend: a port of the app's OpenCodeChatBackend.kt. The bridge runs one `opencode serve` for every
// OpenCode chat; this class reads sessions and their messages from its v2 API, follows its live event stream (one
// connection for all chats, no replay: everything is reloaded after a reconnect), and sends prompts, stops, approvals
// and answers. OpenCodeTranscript turns each open chat into the shared ChatMessages.
//
// Chat ids: OpenCode only accepts its own session ids ("ses_…"), while a view names a new chat with a UUID. Such a chat
// gets a session id at once and the UUID stays its public id (aliases are kept in the store), so the view, the chat
// list and every action keep using the id the view knows.
import fs from 'node:fs';
import type { AiModel, ChatAttachment, ChatMessage, Conversation } from '../../../shared/model';
import type { AgentStatus, ApprovalView, ControlChipView, ModelsState, QuestionView, SlashCommandView } from '../../../shared/protocol';
import type { BridgeManager } from '../bridge/BridgeManager';
import { attachedFilesBlock, cleanTitle, collapseExpansions } from '../text';
import type { AgentBackend, BackendChange, ChatState, KeyValueStore, Logger, SendRequest } from '../types';
import { OpenCodeClient, OpenCodeUnavailableError, type OpenCodeStatus } from './client';
import {
  DEFAULT_AGENTS,
  MODES,
  MODE_ASK,
  MODE_AUTO,
  STATE_LABELS,
  agentDescription,
  agentIcon,
  arr,
  bool,
  capitalize,
  errMsg,
  isSessionId,
  modeDescription,
  modeIcon,
  modeLabel,
  modelRef,
  modelRefJson,
  newId,
  num,
  obj,
  providerOf,
  rules,
  str,
  type Json,
  type OpenCodeAgent,
  type OpenCodeState,
} from './common';
import { MAX_RETRIES, OpenCodeTranscript, formToolId, permissionOf, questionnaireOf, safeId, type Permission } from './OpenCodeTranscript';
import { OpenCodeSettings } from './OpenCodeSettings';

const EMIT_INTERVAL_MS = 33;
/** Silence while waiting for the model before the notice shows, and before the turn is stopped. */
const STALL_NOTICE_MS = 20_000;
const STALL_MS = 90_000;
const ALIAS_LIMIT = 300;

/** ChatState plus the optional fields the host forwards when it knows them (notice line, the chat's own model). */
export type OpenCodeChatState = ChatState & { notice?: string | null; modelId?: string | null };

const isBlocking = (s: OpenCodeState) => s === 'not_installed' || s === 'disabled' || s === 'outdated' || s === 'offline';

/** One OpenCode chat a view shows (or showed a moment ago): its transcript and live state. */
class OpenCodeSession {
  readonly transcript: OpenCodeTranscript;
  listeners = new Set<(s: ChatState) => void>();
  isLoading = false;
  loaded = false;
  loading = false;
  error: string | null = null;
  /** Agent of this chat (build / plan / …) and its "provider/model". */
  agent: string;
  model: string | null = null;
  /** When the turn last started (performance.now()) and when its last event came (Date.now()). */
  turnStartedAt = 0;
  lastActivityAt = 0;
  closed = false;
  private watchdog: NodeJS.Timeout | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private disposeTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly id: string,
    private b: OpenCodeBackend,
  ) {
    this.transcript = new OpenCodeTranscript(id);
    this.agent = b.prefAgent();
  }

  addListener(l: (s: ChatState) => void) {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
    this.listeners.add(l);
    if (this.b.isServerSession(this.id) && !this.loaded && !this.loading) {
      this.isLoading = true;
      void this.b.reload(this);
    }
    l(this.state());
  }

  removeListener(l: (s: ChatState) => void) {
    this.listeners.delete(l);
    if (!this.listeners.size) {
      // keep it a while (switching back and forth is instant); always drop it eventually
      this.disposeTimer = setTimeout(() => this.b.dropSession(this.id), 90_000);
    }
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

  state(): OpenCodeChatState {
    const pub = this.b.publicId(this.id);
    const t = this.transcript;
    const messages = t.toChatMessages(pub);
    const form = [...t.pendingForms.values()].find((f) => questionnaireOf(f));
    const question: QuestionView | null = form ? { key: formToolId(form.id), agent: 'OPENCODE', questionnaire: questionnaireOf(form)! } : null;
    return {
      conversation: this.b.conversationFor(this.id),
      agent: 'OPENCODE',
      messages,
      isStreaming: t.isTurnActive,
      isLoading: this.isLoading && messages.length === 0,
      error: this.error,
      queued: [],
      approvals: [...t.pendingPermissions.values()].map(approvalView),
      question,
      artifacts: [],
      workingLabel: t.compacting ? 'Compacting the conversation…' : null,
      controls: this.b.controls(pub),
      // the app's notice line above the controls strip: provider retries, a model that does not answer
      notice: t.retryNotice,
      modelId: this.model,
    };
  }

  /**
   * Watches the turn while it waits for the model: some providers never answer and OpenCode waits forever. After
   * STALL_NOTICE_MS of silence the notice says so; after STALL_MS the turn is stopped with an error card. Running
   * commands and requests waiting for the user do not count.
   */
  startWatchdog() {
    if (this.watchdog || this.closed) return;
    let noticeShown = false;
    const stop = () => {
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
    };
    this.watchdog = setInterval(() => {
      const t = this.transcript;
      if (this.closed || !t.isTurnActive) return stop();
      const quiet = Date.now() - this.lastActivityAt;
      if (!t.isWaitingOnModel) {
        if (noticeShown) {
          t.setNotice(null);
          noticeShown = false;
          this.emitNow();
        }
        return;
      }
      if (quiet >= STALL_MS) {
        const model = (this.model ?? '').split('/').slice(1).join('/') || 'the model';
        t.addError(
          'No answer from the model',
          `${model} did not answer for ${STALL_MS / 1000} s. It may be overloaded or not available on the provider right now: try again, or pick another model.`,
        );
        t.setNotice(null);
        this.emitNow();
        void this.b.interrupt(this.id).catch(() => undefined);
        stop();
      } else if (quiet >= STALL_NOTICE_MS) {
        t.setNotice(`Waiting for the model to answer… ${Math.floor(quiet / 1000)} s`);
        noticeShown = true;
        this.emitNow();
      }
    }, 5000);
  }

  close() {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.watchdog = this.emitTimer = this.disposeTimer = null;
  }
}

/** OpenCode's permission requests as approval cards: allow once, always allow (the pattern it suggests), or deny. */
function approvalView(p: Permission): ApprovalView {
  const [icon, title] = permissionTitle(p.action);
  const res = p.resources.join('\n');
  const diff = ['diff', 'patch'].map((k) => str(p.metadata, k)).find((v) => v && v.trim());
  return {
    key: p.id,
    agent: 'OPENCODE',
    icon,
    title,
    subtitle: p.action,
    target: p.action === 'shell' ? null : res || null,
    preview: p.action === 'shell' ? p.resources.map((r) => `$ ${r}`).join('\n') : diff ? diff.split('\n').slice(0, 60).join('\n') : null,
    primary: { id: 'once', label: 'Allow' },
    secondary: [],
    always: p.save.length
      ? [{ id: 'always', label: `Always allow ${p.save.join(', ')}`, description: 'OpenCode remembers this for the project' }]
      : [{ id: 'always', label: `Always allow ${p.action}` }],
    denyLabel: 'Deny',
    denyPlaceholder: 'Tell OpenCode what to do instead (optional)',
  };
}

function permissionTitle(action: string): [string, string] {
  switch (action) {
    case 'shell':
    case 'bash':
      return ['terminal', 'Run a command?'];
    case 'edit':
      return ['edit', 'Change a file?'];
    case 'write':
      return ['edit', 'Create a file?'];
    case 'webfetch':
      return ['web', 'Fetch a web page?'];
    case 'websearch':
      return ['web', 'Search the web?'];
    case 'read':
    case 'list':
    case 'glob':
    case 'grep':
      return ['file', 'Read this?'];
    case 'external_directory':
      return ['file', 'Work outside the project?'];
    case 'skill':
      return ['mcp', 'Use a skill?'];
    default:
      return ['shield', `Allow ${action}?`];
  }
}

const isNetworkError = (e: unknown) =>
  e instanceof TypeError || (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError' || /ECONNREFUSED|fetch failed|socket/i.test(e.message)));

export class OpenCodeBackend implements AgentBackend {
  readonly kind = 'OPENCODE' as const;
  readonly settings: OpenCodeSettings;
  readonly client: OpenCodeClient;

  // ---- server state
  ocState: OpenCodeState = 'checking';
  ocStatus: OpenCodeStatus | null = null;

  // ---- models & agents
  /** Every model OpenCode offers, including the ones turned off in Settings → OpenCode → Models. */
  allModels: AiModel[] = [];
  providers: { id: string; name: string }[] = [];
  /** Names of the built-in providers that have a saved account (OpenCode's own free models need none). */
  connectedProviders: string[] = [];
  modelsError: string | null = null;
  agents: OpenCodeAgent[] = [];
  private defaultModelId: string | null = null;
  private selectedModel: string;
  private refreshing = false;

  // ---- chats
  private serverList: Conversation[] = [];
  private localConvs = new Map<string, Conversation>();
  /** Sessions that exist on the server (a new chat exists only here until its first message). */
  private created = new Set<string>();
  private running = new Set<string>();
  private sessions = new Map<string, OpenCodeSession>();
  /** View id (UUID) → session id, and back. */
  private aliases = new Map<string, string>();
  private reverse = new Map<string, string>();
  /** Retries counted for chats that are not open (an open one counts in its transcript). */
  private retriesBySession = new Map<string, number>();
  private titleChecked = new Set<string>();

  private changeListeners = new Set<(w: BackendChange) => void>();
  private started = false;
  private disposed = false;
  private eventsAc: AbortController | null = null;
  private loopTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private timers = new Set<NodeJS.Timeout>();
  private connected = false;
  private lastEventsError: string | null = null;

  constructor(
    private bridge: BridgeManager,
    readonly store: KeyValueStore,
    readonly log: Logger,
    private opts: { openUrl: (url: string) => void } = { openUrl: () => undefined },
  ) {
    this.client = new OpenCodeClient(bridge);
    this.selectedModel = store.get<string>('opencode.model') ?? '';
    for (const [view, ses] of Object.entries(store.get<Record<string, string>>('opencode.aliases') ?? {})) {
      if (typeof ses !== 'string' || !isSessionId(ses)) continue;
      this.aliases.set(view, ses);
      this.reverse.set(ses, view);
      this.created.add(ses);
    }
    this.settings = new OpenCodeSettings(this);
  }

  // ------------------------------------------------------------------ prefs

  prefAgent(): string {
    return this.store.get<string>('opencode.agent') || 'build';
  }
  prefMode(): string {
    const m = this.store.get<string>('opencode.permissionMode');
    return m && (MODES as readonly string[]).includes(m) ? m : MODE_ASK;
  }
  hiddenModels(): Set<string> {
    return new Set(this.store.get<string[]>('opencode.hiddenModels') ?? []);
  }
  hiddenProviders(): Set<string> {
    return new Set(this.store.get<string[]>('opencode.hiddenProviders') ?? []);
  }

  // ------------------------------------------------------------------ status & lifecycle

  /** The agent row (port of the app's openCodeStatusEntry). */
  status(): AgentStatus {
    const st = this.ocStatus;
    const row = (state: AgentStatus['state'], detail: string | null): AgentStatus => ({ kind: 'OPENCODE', label: 'OpenCode', state, detail });
    switch (this.ocState) {
      case 'ready':
        return row('online', [st?.version ? `OpenCode ${st.version}` : null, st?.running ? 'running' : 'starts with the first message'].filter(Boolean).join(' · '));
      case 'checking':
        return row('starting', 'Starting… waiting for the bridge.');
      case 'not_installed':
        return row('not_installed', 'OpenCode is not installed yet. Install it in Settings → OpenCode → Install & update.');
      case 'disabled':
        return row('error', 'The bridge was started with OpenCode off.');
      case 'outdated':
        return row('error', 'This bridge has no OpenCode support yet. Update it.');
      case 'offline':
        return row('offline', 'The bridge is not running.');
      default:
        return row('error', st?.error ?? STATE_LABELS[this.ocState]);
    }
  }

  // ------------------------------------------------------------------ host hooks

  private notify: ((level: 'info' | 'warning' | 'error', message: string) => void) | null = null;

  setNotifier(notify: (level: 'info' | 'warning' | 'error', message: string) => void) {
    this.notify = notify;
  }

  /** A short message (the app's toasts); without a notifier it goes to the chat's error line. */
  toast(message: string, level: 'info' | 'warning' | 'error' = 'error', s?: OpenCodeSession) {
    if (this.notify) this.notify(level, message);
    else if (s) {
      s.error = message;
      s.scheduleEmit();
    } else this.log(`[opencode] ${message}`);
  }

  /** OpenCode's own session id ("Copy ID"): a chat started here is known to the views by its alias. */
  externalId(conversationId: string): string {
    return this.lookup(conversationId) ?? conversationId;
  }

  onChange(cb: (w: BackendChange) => void) {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }
  changed(w: BackendChange) {
    for (const l of this.changeListeners) l(w);
  }

  openUrl(url: string) {
    this.opts.openUrl(url);
  }

  private debounced = new Map<string, NodeJS.Timeout>();
  private debounce(key: string, ms: number, fn: () => void) {
    if (this.debounced.has(key)) return;
    const t = setTimeout(() => {
      this.debounced.delete(key);
      this.timers.delete(t);
      if (!this.disposed) fn();
    }, ms);
    this.debounced.set(key, t);
    this.timers.add(t);
  }

  /** A timer that dispose() cancels. */
  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(t);
  }

  start() {
    if (this.started) return;
    this.started = true;
    void this.loop();
    const ac = new AbortController();
    this.eventsAc = ac;
    void this.client.events(
      ac.signal,
      (e) => this.handleEvent(e),
      () => {
        this.connected = true;
        this.lastEventsError = null;
        this.changed('settings');
        void (async () => {
          if (this.ocState !== 'ready') await this.refreshStatus();
          await this.resync();
        })();
      },
      (e) => {
        this.connected = false;
        this.changed('settings');
        if (e instanceof OpenCodeUnavailableError && (e.disabled || e.outdated)) this.setState(e.disabled ? 'disabled' : 'outdated');
        else if (e) {
          const msg = errMsg(e);
          if (msg !== this.lastEventsError) this.log(`[opencode] events: ${msg}`);
          this.lastEventsError = msg;
          // the stream dropped (bridge stopped?): READY is never re-checked otherwise
          if (this.ocState === 'ready') void this.refreshStatus();
        }
      },
    );
  }

  private async loop() {
    await this.refreshStatus();
    void this.loadModels();
    void this.loadAgents();
    const tick = async () => {
      if (this.disposed) return;
      await this.refreshSessions();
      this.loopTimer = setTimeout(async () => {
        if (this.disposed) return;
        if (this.ocState !== 'ready') await this.refreshStatus();
        await tick();
      }, this.ocState === 'ready' ? 60_000 : 15_000);
    };
    await tick();
  }

  private setState(s: OpenCodeState) {
    if (s === this.ocState) return;
    const wasReady = this.ocState === 'ready';
    this.ocState = s;
    this.changed('status');
    this.changed('settings');
    if (s === 'ready' && !wasReady && this.started) {
      void this.loadModels();
      void this.loadAgents();
    }
  }

  /** Asks the bridge whether OpenCode is there (installed, version, last error). */
  async refreshStatus(showProgress = false) {
    if (showProgress && this.ocState !== 'ready') this.setState('checking');
    try {
      if (this.bridge.state !== 'running') await this.bridge.ensureRunning();
      const st = await this.client.status();
      this.ocStatus = st;
      this.setState(st.installed ? 'ready' : 'not_installed');
    } catch (e) {
      this.ocStatus = { error: errMsg(e) };
      if (e instanceof OpenCodeUnavailableError) this.setState(e.disabled ? 'disabled' : e.outdated ? 'outdated' : 'error');
      else if (isNetworkError(e)) {
        this.bridge.state = 'stopped';
        this.setState('offline');
      } else this.setState('error');
    }
    this.changed('status');
  }

  retry() {
    void (async () => {
      await this.refreshStatus(true);
      await Promise.allSettled([this.loadModels(), this.loadAgents(), this.refreshSessions()]);
    })();
  }

  // ------------------------------------------------------------------ models & agents

  models(): ModelsState {
    const list = this.allModels.filter((m) => this.isModelVisible(m.id));
    const groups: { name: string }[] = [];
    for (const m of list) if (m.group && !groups.some((g) => g.name === m.group)) groups.push({ name: m.group });
    return { agent: 'OPENCODE', models: list, selectedId: this.selectedId(list), groups, refreshing: this.refreshing };
  }

  /** The picked model when it is still offered: else the remembered one, OpenCode's default, or the first. */
  private selectedId(list: AiModel[]): string | null {
    const has = (id: string | null | undefined) => !!id && list.some((m) => m.id === id);
    if (has(this.selectedModel)) return this.selectedModel;
    const pref = this.store.get<string>('opencode.model');
    if (has(pref)) return pref!;
    if (has(this.defaultModelId)) return this.defaultModelId;
    return list[0]?.id ?? null;
  }

  isModelVisible(modelId: string): boolean {
    return !this.hiddenProviders().has(providerOf(modelId)) && !this.hiddenModels().has(modelId);
  }

  modelName(id: string): string {
    return this.allModels.find((m) => m.id === id)?.displayName ?? (id.split('/').slice(1).join('/') || id);
  }

  /** Hidden models / providers changed (Settings → OpenCode → Models). */
  publishModels() {
    const all = this.allModels;
    const list = all.filter((m) => this.isModelVisible(m.id));
    this.modelsError = !all.length
      ? 'No models: connect a provider in Settings → OpenCode → Providers.'
      : !list.length
        ? 'All models are turned off: turn some on in Settings → OpenCode → Models.'
        : null;
    this.changed('models');
  }

  refreshModels() {
    if (this.refreshing) return;
    this.refreshing = true;
    this.changed('models');
    void Promise.allSettled([this.loadModels(), this.loadAgents()]).then(() => {
      this.refreshing = false;
      this.changed('models');
    });
  }

  async loadModels() {
    try {
      const [integ, prov, def] = await Promise.all([
        this.client.get('/integration').catch(() => null),
        this.client.get('/provider').catch(() => null),
        this.client.get('/model/default').catch(() => null),
      ]);
      if (integ) {
        this.connectedProviders = arr(integ, 'data')
          .filter((i) => arr(i, 'connections').length > 0)
          .map((i) => str(i, 'name') ?? str(i, 'id') ?? '');
      }
      this.providers = arr(prov, 'data')
        .filter((p) => str(p, 'id'))
        .map((p) => ({ id: str(p, 'id')!, name: str(p, 'name') ?? str(p, 'id')! }));
      const names = new Map(this.providers.map((p) => [p.id, p.name]));
      const d = obj(def, 'data');
      const defaultId = d && str(d, 'id') ? `${str(d, 'providerID')}/${str(d, 'id')}` : null;
      const res = await this.client.get('/model');
      const list: AiModel[] = arr(res, 'data')
        .filter((m) => m && typeof m === 'object' && (str(m, 'type') ?? 'chat') === 'chat' && bool(m, 'enabled') !== false && str(m, 'status') !== 'deprecated')
        .map((m) => {
          const provider = str(m, 'providerID') ?? '';
          const id = `${provider}/${str(m, 'id')}`;
          const c0 = arr(m, 'cost')[0];
          const free = !!c0 && (num(c0, 'input') ?? 1) === 0 && (num(c0, 'output') ?? 1) === 0;
          const ctx = num(obj(m, 'limit'), 'context');
          const pname = names.get(provider) ?? provider;
          const displayName = str(m, 'name') ?? str(m, 'id') ?? id;
          const desc = [pname, ctx && ctx > 0 ? `${Math.floor(ctx / 1000)}K context` : null, free ? 'free' : null].filter(Boolean).join(' · ');
          return {
            id,
            key: id,
            displayName,
            family: /claude/i.test(id + displayName) ? 'CLAUDE' : /gemini/i.test(id + displayName) ? 'GEMINI' : 'OTHER',
            // the app's model sheet marks OpenCode's default model
            description: id === defaultId ? `${desc} · default` : desc,
            isDefault: id === defaultId,
            baseName: pname,
            tier: null,
            group: pname,
          } satisfies AiModel;
        })
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.baseName.toLowerCase().localeCompare(b.baseName.toLowerCase()) || a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
      this.allModels = list;
      this.defaultModelId = defaultId;
      this.publishModels();
    } catch (e) {
      this.modelsError = errMsg(e);
      this.log(`[opencode] models: ${this.modelsError}`);
      this.changed('models');
    }
  }

  async loadAgents() {
    try {
      const res = await this.client.get('/agent');
      this.agents = arr(res, 'data')
        .filter((a) => a && typeof a === 'object' && bool(a, 'hidden') !== true && str(a, 'mode') !== 'subagent' && str(a, 'id'))
        .map((a) => ({ id: str(a, 'id')!, name: str(a, 'name') ?? str(a, 'id')!, description: str(a, 'description') ?? '' }));
      this.changed('controls');
      for (const s of this.sessions.values()) s.scheduleEmit();
    } catch (e) {
      this.log(`[opencode] agents: ${errMsg(e)}`);
    }
  }

  selectModel(conversationId: string | null, modelId: string) {
    this.selectedModel = modelId;
    this.store.set('opencode.model', modelId);
    this.changed('models');
    if (!conversationId) return;
    const ses = this.lookup(conversationId);
    const s = ses ? this.sessions.get(ses) : undefined;
    if (s) {
      s.model = modelId;
      s.scheduleEmit();
    }
    if (!ses || !this.isServerSession(ses)) return;
    const ref = modelRefJson(modelId);
    if (!ref) return;
    this.serverList = this.serverList.map((c) => (c.id === ses ? { ...c, modelId } : c));
    void this.client.post(`/session/${ses}/model`, { model: ref }).catch((e) => {
      this.toast(`Could not switch the model: ${errMsg(e)}`, 'error', s);
    });
  }

  commands(): SlashCommandView[] {
    return [];
  }

  // ------------------------------------------------------------------ controls (agent, approvals)

  controls(conversationId: string | null): ControlChipView[] {
    const ses = conversationId ? this.lookup(conversationId) : null;
    const s = ses ? this.sessions.get(ses) : undefined;
    const agent = s?.agent ?? this.prefAgent();
    const mode = this.prefMode();
    const list = this.agents.length ? this.agents : DEFAULT_AGENTS;
    const name = list.find((a) => a.id === agent)?.name ?? agent;
    return [
      {
        id: 'agent',
        label: capitalize(name),
        title: 'Agent',
        note: 'Switching applies to the next message of this chat. New chats use the agent from Settings → OpenCode → Permissions.',
        kind: 'select',
        value: agent,
        options: list.map((a) => ({ value: a.id, label: capitalize(a.name), description: agentDescription(a) })),
        icon: agentIcon(agent),
        tone: agent === 'plan' ? 'accent' : null,
      },
      {
        id: 'mode',
        label: modeLabel(mode),
        title: 'Approvals',
        note: 'Applies to this chat right away and to new chats. Requests show above the message box.',
        kind: 'select',
        value: mode,
        options: MODES.map((m) => ({ value: m, label: modeLabel(m), description: modeDescription(m) })),
        icon: modeIcon(mode),
        tone: mode === MODE_AUTO ? 'warn' : null,
      },
    ];
  }

  async setControl(conversationId: string | null, id: string, value: string) {
    // OpenCode's strip has only pickers (no info / action chips)
    if (value === 'details' || value === 'run') return;
    const ses = conversationId ? this.lookup(conversationId) : null;
    const s = ses ? this.sessions.get(ses) : undefined;
    const onServer = !!ses && this.isServerSession(ses);
    if (id === 'agent') {
      this.store.set('opencode.agent', value);
      if (s) s.agent = value;
      this.changed('controls');
      s?.scheduleEmit();
      if (onServer) {
        try {
          await this.client.post(`/session/${ses}/agent`, { agent: value });
          await this.client.patch(`/session/${ses}`, { permissions: rules(this.prefMode(), value) ?? [] });
        } catch (e) {
          this.toast(`Could not switch to ${value}: ${errMsg(e)}`, 'error', s);
        }
      }
    } else if (id === 'mode') {
      await this.setPermissionMode(value, ses ?? null);
    }
  }

  /** The approval mode for new chats and, now, for the chat `target` ('open' = every chat a view shows). */
  async setPermissionMode(mode: string, target: string | null) {
    if (!(MODES as readonly string[]).includes(mode)) return;
    this.store.set('opencode.permissionMode', mode);
    this.changed('controls');
    this.changed('settings');
    for (const s of this.sessions.values()) s.scheduleEmit();
    const targets = target === 'open' ? [...this.sessions.values()].filter((s) => s.listeners.size).map((s) => s.id) : target ? [target] : [];
    for (const ses of targets) {
      if (!this.isServerSession(ses)) continue;
      const s = this.sessions.get(ses);
      try {
        await this.client.patch(`/session/${ses}`, { permissions: rules(mode, s?.agent ?? this.prefAgent()) ?? [] });
      } catch (e) {
        this.toast(`Could not change approvals: ${errMsg(e)}`, 'error', s);
      }
    }
  }

  // ------------------------------------------------------------------ ids

  /** Session id of a view id (a UUID gets a new session id the first time). */
  private resolve(id: string): string {
    if (isSessionId(id)) return id;
    let ses = this.aliases.get(id);
    if (!ses) {
      ses = newId('ses', true);
      this.aliases.set(id, ses);
      this.reverse.set(ses, id);
    }
    return ses;
  }

  /** Session id of a view id, without making one. */
  private lookup(id: string): string | null {
    return isSessionId(id) ? id : (this.aliases.get(id) ?? null);
  }

  /** The id views know a session by. */
  publicId(ses: string): string {
    return this.reverse.get(ses) ?? ses;
  }

  private saveAliases() {
    const out: Record<string, string> = {};
    const entries = [...this.aliases].filter(([, ses]) => this.created.has(ses)).slice(-ALIAS_LIMIT);
    for (const [view, ses] of entries) out[view] = ses;
    this.store.set('opencode.aliases', out);
  }

  /** The session exists on the server (listed, created here, or an id that came from OpenCode). */
  isServerSession(ses: string): boolean {
    return this.created.has(ses) || this.serverList.some((c) => c.id === ses) || (isSessionId(ses) && !this.reverse.has(ses));
  }

  // ------------------------------------------------------------------ conversations

  conversations(): Conversation[] {
    const merged = new Map<string, Conversation>();
    for (const c of this.localConvs.values()) merged.set(c.id, c);
    for (const c of this.serverList) if (!merged.has(c.id)) merged.set(c.id, c);
    return [...merged.values()]
      .map((c) => this.withRuntime(c))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private withRuntime(c: Conversation): Conversation {
    const isRunning = this.running.has(c.id);
    const pub = this.publicId(c.id);
    return { ...c, id: pub, isRunning, runStatus: isRunning ? 'RUNNING' : 'IDLE' };
  }

  /** The conversation of session `ses` as views see it (null for a chat not started yet). */
  conversationFor(ses: string): Conversation | null {
    const c = this.serverList.find((x) => x.id === ses) ?? this.localConvs.get(ses);
    return c ? this.withRuntime(c) : null;
  }

  private conversationOf(s: Json, active: Json): Conversation | null {
    const id = str(s, 'id');
    if (!id) return null;
    const dir = str(obj(s, 'location'), 'directory') ?? '';
    const time = obj(s, 'time');
    const title = str(s, 'title');
    const isRunning = !!active && id in active;
    return {
      id,
      title: (title && cleanTitle(title).trim()) || 'New Chat',
      modelId: modelRef(obj(s, 'model')) ?? '',
      createdAt: num(time, 'created') ?? 0,
      updatedAt: num(time, 'updated') ?? 0,
      isRunning,
      notFullyIdle: false,
      hasActivity: false,
      runStatus: isRunning ? 'RUNNING' : 'IDLE',
      stepCount: 0,
      workspaceUri: dir ? `file://${dir}` : '',
      parentConversationId: str(s, 'parentID') ?? null,
      nestingDepth: 0,
      agent: 'OPENCODE',
      archived: num(time, 'archived') != null,
    };
  }

  async refreshSessions() {
    try {
      const [res, act] = await Promise.all([this.client.get('/session?limit=200&parentID=null'), this.client.get('/session/active').catch(() => null)]);
      const active = obj(act, 'data') ?? null;
      const list = arr(res, 'data')
        .map((s) => this.conversationOf(s, active))
        .filter((c): c is Conversation => c != null);
      for (const c of list) {
        this.created.add(c.id);
        // OpenCode names a chat a moment after its first reply: keep the first-message title until then
        if (c.title === 'New Chat') {
          const prev = this.localConvs.get(c.id) ?? this.serverList.find((x) => x.id === c.id);
          if (prev?.title && prev.title !== 'New Chat') c.title = prev.title;
        }
      }
      this.running.clear();
      if (active) for (const k of Object.keys(active)) this.running.add(k);
      for (const c of list) this.localConvs.delete(c.id);
      this.serverList = list;
      this.changed('conversations');
      for (const s of this.sessions.values()) s.scheduleEmit();
    } catch (e) {
      this.log(`[opencode] sessions: ${errMsg(e)}`);
    }
  }

  private scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (!this.disposed) void this.refreshSessions();
    }, 700);
  }

  /** A chat's new title, in the list and on the open chat. */
  private applyTitle(ses: string, title: string) {
    this.serverList = this.serverList.map((c) => (c.id === ses ? { ...c, title } : c));
    const l = this.localConvs.get(ses);
    if (l) this.localConvs.set(ses, { ...l, title });
    this.changed('conversations');
    this.sessions.get(ses)?.scheduleEmit();
  }

  // ------------------------------------------------------------------ sessions

  private session(id: string): OpenCodeSession {
    const ses = this.resolve(id);
    let s = this.sessions.get(ses);
    if (!s) {
      s = new OpenCodeSession(ses, this);
      const c = this.serverList.find((x) => x.id === ses);
      if (c?.modelId) s.model = c.modelId;
      this.sessions.set(ses, s);
    }
    return s;
  }

  dropSession(ses: string) {
    const s = this.sessions.get(ses);
    if (!s || s.listeners.size) return;
    s.close();
    this.sessions.delete(ses);
    // a chat that was never sent goes away with its view
    if (this.localConvs.has(ses) && !this.created.has(ses)) {
      this.localConvs.delete(ses);
      this.changed('conversations');
    }
  }

  subscribe(conversationId: string, listener: (s: ChatState) => void) {
    const s = this.session(conversationId);
    s.addListener(listener);
    return () => s.removeListener(listener);
  }

  getState(conversationId: string): ChatState {
    return this.session(conversationId).state();
  }

  /** A chat's stored messages, newest first, `maxPages` pages of 200 at most (OpenCode's own page limit). */
  private async history(ses: string, maxPages: number): Promise<Json[]> {
    const items: Json[] = [];
    let res = await this.client.get(`/session/${ses}/message?limit=200&order=desc`);
    for (let pages = 0; ; ) {
      const page = arr(res, 'data').filter((m) => m && typeof m === 'object');
      items.push(...page);
      const next = str(obj(res, 'cursor'), 'next');
      if (!page.length || !next || ++pages >= maxPages) break;
      res = await this.client.get(`/session/${ses}/message?limit=200&cursor=${encodeURIComponent(next)}`);
    }
    return items;
  }

  /** Loads a chat's messages, pending approvals and questions from OpenCode. */
  async reload(s: OpenCodeSession) {
    const id = s.id;
    const startedAt = performance.now();
    s.loading = true;
    try {
      const items = await this.history(id, 10);
      const [act, info, perms, forms] = await Promise.all([
        this.client.get('/session/active').catch(() => null),
        this.client.get(`/session/${id}`).catch(() => null),
        this.client.get(`/session/${id}/permission`).catch(() => null),
        this.client.get(`/session/${id}/form`).catch(() => null),
      ]);
      if (s.closed) return;
      const active = !!obj(act, 'data') && id in obj(act, 'data');
      // a turn started while this was loading: the snapshot is older than what is shown, and the turn's end reloads
      if (!active && s.transcript.isTurnActive && s.turnStartedAt > startedAt) return;
      const t = s.transcript;
      t.loadHistory(items, active);
      for (const p of [...t.pendingPermissions.keys()]) t.removePermission(p, false);
      for (const f of [...t.pendingForms.keys()]) t.removeForm(f);
      for (const p of arr(perms, 'data')) {
        const perm = permissionOf(p, id);
        if (perm) t.addPermission(perm);
      }
      for (const f of arr(forms, 'data')) {
        const status = str(obj(f, 'state'), 'status');
        if (status && status !== 'pending') continue;
        const fid = str(f, 'id');
        if (!fid) continue;
        t.addForm({ id: fid, sessionId: id, title: str(f, 'title') ?? '', fields: arr(f, 'fields').filter((x) => x && typeof x === 'object') });
      }
      const d = obj(info, 'data');
      if (d) {
        const m = modelRef(obj(d, 'model'));
        if (m) s.model = m;
        const a = str(d, 'agent');
        if (a) s.agent = a;
        this.created.add(id);
      }
      // the picker shows the open chat's model (like the app)
      if (s.listeners.size && s.model && s.model !== this.selectedModel && this.allModels.some((x) => x.id === s.model)) {
        this.selectedModel = s.model;
        this.changed('models');
      }
      if (active) {
        if (!this.running.has(id)) {
          this.running.add(id);
          this.changed('conversations');
        }
        s.lastActivityAt = Date.now();
        s.startWatchdog();
      } else if (this.running.delete(id)) this.changed('conversations');
      s.loaded = true;
      s.error = null;
    } catch (e) {
      if (!s.closed && !s.transcript.isEmpty) this.log(`[opencode] reload ${id}: ${errMsg(e)}`);
      else s.error = `Could not load this chat: ${errMsg(e)}`;
    } finally {
      s.loading = false;
      s.isLoading = false;
      s.emitNow();
    }
  }

  /** Everything that may have been missed while the event stream was down. */
  private async resync() {
    await this.refreshSessions();
    for (const s of this.sessions.values()) if (this.isServerSession(s.id) && (s.listeners.size || s.loaded)) void this.reload(s);
  }

  // ------------------------------------------------------------------ sending

  async send(req: SendRequest): Promise<void> {
    const s = this.session(req.conversationId);
    if (isBlocking(this.ocState)) {
      this.toast(`OpenCode is not available: ${STATE_LABELS[this.ocState]}. Check Settings → OpenCode.`, 'warning', s);
      return;
    }
    const { text, files, names } = await this.buildPayload(req.text, req.attachments);
    if (!text.trim() && !files.length) return;
    const ses = s.id;
    const onServer = this.isServerSession(ses);
    const workspaceUri = req.workspaceUri ? (req.workspaceUri.startsWith('file://') ? req.workspaceUri : `file://${req.workspaceUri}`) : '';
    if (!onServer) {
      // a new chat: listed at once (OpenCode lists it once created)
      s.model = req.modelId ?? this.models().selectedId;
      s.agent = this.prefAgent();
      const first = collapseExpansions(cleanTitle(text) || 'Attachment').split('\n').find((l) => l.trim())?.trim() ?? 'Chat';
      this.localConvs.set(ses, {
        id: ses,
        title: first.length > 40 ? `${first.slice(0, 40)}...` : first,
        modelId: s.model ?? '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isRunning: true,
        notFullyIdle: false,
        hasActivity: false,
        runStatus: 'RUNNING',
        stepCount: 0,
        workspaceUri,
        nestingDepth: 0,
        agent: 'OPENCODE',
        archived: false,
      });
    } else {
      const c = this.serverList.find((x) => x.id === ses);
      if (c) this.serverList = this.serverList.map((x) => (x.id === ses ? { ...x, updatedAt: Date.now() } : x));
    }
    const msgId = newId('msg', false);
    const images = req.attachments.filter((a) => a.isImage && a.base64);
    // a prompt sent while a turn runs waits in OpenCode's inbox: a failure must not end that turn
    const wasActive = s.transcript.isTurnActive;
    s.transcript.addLocalPrompt(msgId, text, names, images);
    s.turnStartedAt = performance.now();
    s.lastActivityAt = Date.now();
    s.error = null;
    s.startWatchdog();
    this.running.add(ses);
    this.changed('conversations');
    s.emitNow();

    if (!onServer) {
      const dir = workspaceUri.replace(/^file:\/\//, '');
      const ref = modelRefJson(s.model);
      const perms = rules(this.prefMode(), s.agent);
      const body: Record<string, unknown> = { id: ses };
      if (dir.startsWith('/')) body.location = { directory: decodeURIComponent(dir) };
      if (ref) body.model = ref;
      if (s.agent && s.agent !== 'build') body.agent = s.agent;
      if (perms) body.permissions = perms;
      try {
        await this.client.post('/session', body);
      } catch (e) {
        this.fail(s, msgId, 'Could not start the OpenCode chat', e, wasActive);
        return;
      }
      this.created.add(ses);
      if (this.reverse.has(ses)) this.saveAliases();
    }
    try {
      await this.client.post(`/session/${ses}/prompt`, { id: msgId, text: text || 'See the attached file.', ...(files.length ? { files } : {}) });
    } catch (e) {
      this.fail(s, msgId, 'OpenCode did not take the message', e, wasActive);
    }
  }

  /**
   * Images go inline (data: URIs, so the model sees them); files by path go to the agent as a hidden list in the text
   * (opened in place). `names`: attachments that could not be sent, shown with the prompt.
   */
  private async buildPayload(text: string, atts: ChatAttachment[]): Promise<{ text: string; files: Json[]; names: string[] }> {
    const files: Json[] = [];
    const refs: { path: string; mimeType: string; size: number }[] = [];
    const notes: string[] = [];
    const names: string[] = [];
    for (const a of atts) {
      const mime = a.mimeType || (a.isImage ? 'image/png' : 'application/octet-stream');
      if (a.isImage || mime.startsWith('image/')) {
        let b64 = a.base64 ?? null;
        try {
          if (!b64 && a.path && fs.existsSync(a.path) && fs.statSync(a.path).size < 8 * 1024 * 1024) b64 = fs.readFileSync(a.path).toString('base64');
        } catch {
          /* fall through to the path */
        }
        if (b64) {
          files.push({ uri: `data:${mime};base64,${b64}`, name: a.name, source: { type: 'inline' } });
          continue;
        }
      }
      if (a.path) {
        let size = a.size;
        let folder = a.kind === 'folder' || a.mimeType === 'inode/directory';
        try {
          const st = fs.statSync(a.path);
          folder ||= st.isDirectory();
          size = folder ? 0 : size || st.size;
        } catch {
          /* keep */
        }
        refs.push({ path: a.path, mimeType: folder ? 'inode/directory' : (a.mimeType ?? ''), size });
      } else {
        notes.push(`(The attachment ${a.name} could not be sent)`);
        names.push(a.name);
      }
    }
    let body = [text.trim(), ...notes].filter(Boolean).join('\n\n');
    if (!body) body = files.length ? 'Image' : refs.length ? 'Attachment' : '';
    return { text: refs.length ? `${body}\n\n${attachedFilesBlock(refs)}` : body, files, names };
  }

  private fail(s: OpenCodeSession, msgId: string, title: string, e: unknown, turnWasActive: boolean) {
    const msg = errMsg(e);
    this.log(`[opencode] ${title}: ${msg}`);
    s.transcript.removeLocalPrompt(msgId);
    s.transcript.addError(title, msg || 'Unknown error');
    if (turnWasActive) {
      s.emitNow();
      return;
    }
    s.transcript.apply('session.execution.interrupted', {});
    if (this.running.delete(s.id)) this.changed('conversations');
    if (!this.created.has(s.id) && this.localConvs.has(s.id)) {
      const c = this.localConvs.get(s.id)!;
      this.localConvs.set(s.id, { ...c, isRunning: false, runStatus: 'IDLE' });
    }
    s.emitNow();
  }

  /** Stops a chat's turn, open or not. */
  async interrupt(ses: string): Promise<void> {
    try {
      await this.client.post(`/session/${ses}/interrupt`);
    } catch (e) {
      this.log(`[opencode] interrupt ${ses}: ${errMsg(e)}`);
      throw e;
    }
  }

  async stop(conversationId: string): Promise<void> {
    const ses = this.lookup(conversationId);
    if (!ses) return;
    const s = this.sessions.get(ses);
    if (!this.isServerSession(ses)) {
      if (s) {
        s.transcript.apply('session.execution.interrupted', {});
        s.emitNow();
      }
      return;
    }
    try {
      await this.interrupt(ses);
    } catch (e) {
      this.toast(`Could not stop: ${errMsg(e)}`, 'error', s);
      return;
    }
    // the stream says when it stopped; reload when it did not (missed event)
    this.later(3000, () => {
      if (s && !s.closed && s.transcript.isTurnActive) void this.reload(s);
    });
  }

  // ------------------------------------------------------------------ approvals & questions

  async approval(conversationId: string, key: string, choiceId: string | undefined, deny: boolean, feedback?: string): Promise<void> {
    const ses = this.lookup(conversationId);
    const s = ses ? this.sessions.get(ses) : undefined;
    if (!s) return;
    const decision = deny ? 'reject' : choiceId === 'always' ? 'always' : 'once';
    const perm = s.transcript.pendingPermissions.get(key);
    const sid = perm?.sessionId || s.id;
    s.transcript.removePermission(key, decision === 'reject');
    s.emitNow();
    try {
      await this.client.post(`/session/${sid}/permission/${encodeURIComponent(key)}/reply`, { decision, ...(feedback?.trim() ? { message: feedback.trim() } : {}) });
    } catch (e) {
      this.toast(`Could not answer the request: ${errMsg(e)}`, 'error', s);
      void this.reload(s);
    }
  }

  async answer(conversationId: string, key: string, answers: Record<string, string[]>, _note?: string, skip?: boolean): Promise<void> {
    const ses = this.lookup(conversationId);
    const s = ses ? this.sessions.get(ses) : undefined;
    if (!s) return;
    const form = [...s.transcript.pendingForms.values()].find((f) => formToolId(f.id) === key);
    if (!form) return;
    s.transcript.removeForm(form.id);
    s.emitNow();
    const path = `/session/${form.sessionId || s.id}/form/${encodeURIComponent(form.id)}`;
    if (skip) {
      await this.client.del(path).catch((e) => this.log(`[opencode] cancel form: ${errMsg(e)}`));
      return;
    }
    const answer: Record<string, unknown> = {};
    for (const field of form.fields) {
      const k = str(field, 'key');
      if (!k || bool(field, 'hidden') === true) continue;
      const picked = answers[k] ?? [];
      if (!picked.length) continue;
      const optionIds = new Set(arr(field, 'options').map((o) => str(o, 'value')).filter(Boolean));
      const typed = picked.filter((p) => !optionIds.has(p)).join(', ').trim();
      switch (str(field, 'type')) {
        case 'multiselect':
          answer[k] = picked;
          break;
        case 'boolean':
          if (picked[0] === 'true' || picked[0] === 'false') answer[k] = picked[0] === 'true';
          break;
        case 'number':
        case 'integer': {
          const n = Number(typed || picked[0]);
          if (Number.isFinite(n)) answer[k] = str(field, 'type') === 'integer' ? Math.trunc(n) : n;
          break;
        }
        default: {
          const v = typed || picked.join(', ');
          if (v) answer[k] = v;
        }
      }
    }
    try {
      await this.client.post(`${path}/reply`, { answer });
    } catch (e) {
      this.toast(`Could not send the answer: ${errMsg(e)}`, 'error', s);
      void this.reload(s);
    }
  }

  // ------------------------------------------------------------------ conversation & queue actions

  async conversationAction(id: string, action: 'delete' | 'fork' | 'rename' | 'archive' | 'unarchive', value?: string): Promise<string | void> {
    const ses = this.lookup(id) ?? this.resolve(id);
    switch (action) {
      case 'delete': {
        if (this.isServerSession(ses)) await this.client.del(`/session/${ses}`);
        this.serverList = this.serverList.filter((c) => c.id !== ses);
        this.localConvs.delete(ses);
        this.created.delete(ses);
        this.running.delete(ses);
        this.sessions.get(ses)?.close();
        this.sessions.delete(ses);
        const view = this.reverse.get(ses);
        if (view) {
          this.aliases.delete(view);
          this.reverse.delete(ses);
          this.saveAliases();
        }
        this.changed('conversations');
        return;
      }
      case 'fork': {
        const res = await this.client.post(`/session/${ses}/fork`, {});
        const newSes = str(obj(res, 'data'), 'id') ?? str(res, 'id');
        await this.refreshSessions();
        return newSes ?? undefined;
      }
      case 'rename': {
        const title = value?.trim();
        if (!title) return;
        await this.client.patch(`/session/${ses}`, { title });
        this.applyTitle(ses, title);
        void this.refreshSessions();
        return;
      }
      case 'archive':
      case 'unarchive': {
        if (!this.isServerSession(ses)) return;
        await this.client.patch(`/session/${ses}`, { archived: action === 'archive' });
        this.serverList = this.serverList.map((c) => (c.id === ses ? { ...c, archived: action === 'archive' } : c));
        this.changed('conversations');
        void this.refreshSessions();
        return;
      }
    }
  }

  /** Prompts sent while a turn runs wait in OpenCode's inbox and show in the chat (like the app); nothing to do here. */
  async queueAction(): Promise<void> {
    return;
  }

  // ------------------------------------------------------------------ tool cards

  /** Tool card actions: "terminate" a running command stops the turn (OpenCode has no per-tool stop, like the app);
   *  "approve" / "reject" answer the tool's pending permission request. */
  async toolAction(conversationId: string, toolId: string, action: string): Promise<void> {
    if (action === 'terminate' || action === 'stop') return this.stop(conversationId);
    const ses = this.lookup(conversationId);
    const s = ses ? this.sessions.get(ses) : undefined;
    if (!s) return;
    const perm = [...s.transcript.pendingPermissions.values()].find((p) => p.toolCallId && safeId(p.toolCallId) === toolId);
    if (!perm) return;
    if (action === 'approve' || action === 'allow') await this.approval(conversationId, perm.id, 'once', false);
    else if (action === 'reject' || action === 'deny') await this.approval(conversationId, perm.id, undefined, true);
  }

  // ------------------------------------------------------------------ chat contents (search, export)

  /** Messages of a chat that is not open (port of loadMessages: export / search). */
  async loadMessages(conversationId: string): Promise<ChatMessage[]> {
    const ses = this.lookup(conversationId) ?? conversationId;
    const t = new OpenCodeTranscript(ses);
    t.loadHistory(await this.history(ses, 3), false);
    return t.toChatMessages(this.publicId(ses));
  }

  private searchCache = new Map<string, { updatedAt: number; text: string }>();

  /** Drawer deep search: the prompts and replies of every chat (cached until a chat changes). */
  async search(query: string): Promise<{ conversationId: string; snippet: string }[]> {
    const q = query.trim().toLowerCase();
    if (!q || this.ocState !== 'ready') return [];
    const list = [...this.serverList];
    const out: { conversationId: string; snippet: string; updatedAt: number }[] = [];
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const c = list[next++];
        const text = await this.searchText(c).catch(() => '');
        const at = text.toLowerCase().indexOf(q);
        if (at < 0) continue;
        const from = Math.max(0, at - 40);
        const to = Math.min(text.length, at + q.length + 80);
        const snippet = `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
        out.push({ conversationId: this.publicId(c.id), snippet, updatedAt: c.updatedAt });
      }
    };
    await Promise.all([0, 1, 2, 3].map(() => worker()));
    return out.sort((a, b) => b.updatedAt - a.updatedAt).map(({ conversationId, snippet }) => ({ conversationId, snippet }));
  }

  private async searchText(c: Conversation): Promise<string> {
    const hit = this.searchCache.get(c.id);
    if (hit && hit.updatedAt === c.updatedAt) return hit.text;
    const msgs = await this.loadMessages(c.id);
    const text = msgs
      .filter((m) => m.role === 'USER' || m.role === 'ASSISTANT')
      .map((m) =>
        m.content
          .replace(/<!-- thought(:streaming)? -->[\s\S]*?<!-- \/thought -->/g, ' ')
          .replace(/<!-- error -->[\s\S]*?<!-- \/error -->/g, ' ')
          .replace(/<!-- tool_call:[^>]* -->/g, ' '),
      )
      .join('\n');
    this.searchCache.set(c.id, { updatedAt: c.updatedAt, text });
    return text;
  }

  // ------------------------------------------------------------------ retry & edit (OpenCode's revert)

  /** Host hook for the footer ↻ (AgentBackend.retryMessage). */
  retryMessage(conversationId: string, messageId: string): Promise<string | void> {
    return this.regenerate(conversationId, messageId);
  }

  /** Asks again: the chat goes back to right before the prompt of reply `messageId` and sends it again. */
  async regenerate(conversationId: string, messageId: string): Promise<string | void> {
    const ses = this.lookup(conversationId);
    const s = ses ? this.sessions.get(ses) : undefined;
    if (!s || !ses) return;
    if (s.transcript.isTurnActive) return 'Stop the reply first';
    const prompt = s.transcript.promptBefore(messageId);
    if (!prompt || prompt.local) return 'Nothing to retry here';
    await this.revertTo(ses, prompt.id, false);
    await this.reload(s);
    await this.send({ conversationId, isNew: false, text: prompt.text, attachments: [], modelId: s.model, workspaceUri: null });
  }

  /** Edits a sent prompt: the chat goes back to right before it; its text is returned for the input box. */
  async rewind(conversationId: string, messageId: string, restoreFiles = false): Promise<string | null> {
    const ses = this.lookup(conversationId);
    const s = ses ? this.sessions.get(ses) : undefined;
    if (!s || !ses) return null;
    if (s.transcript.isTurnActive) throw new Error('Stop the reply first');
    const prompt = s.transcript.userMessage(messageId);
    if (!prompt || prompt.local) throw new Error("This message can't be edited yet");
    await this.revertTo(ses, prompt.id, restoreFiles);
    await this.reload(s);
    return collapseExpansions(prompt.text);
  }

  private async revertTo(ses: string, messageId: string, restoreFiles: boolean) {
    try {
      await this.client.post(`/session/${ses}/revert/stage`, { messageID: messageId, files: restoreFiles });
      await this.client.post(`/session/${ses}/revert/commit`);
    } catch (e) {
      await this.client.del(`/session/${ses}/revert`).catch(() => undefined);
      throw new Error(`Could not go back in the chat: ${errMsg(e)}`);
    }
  }

  // ------------------------------------------------------------------ titles

  /**
   * OpenCode names a new chat itself after the first message, but only when its title call works. After the first
   * reply, once: if OpenCode set no title by then, one is made with the chat's own model in a single stateless call
   * (only the first message) and saved as the chat's title.
   */
  private titleIfMissing(s: OpenCodeSession) {
    const prompts = s.transcript.userPrompts();
    if (prompts.length !== 1 || this.titleChecked.has(s.id)) return;
    this.titleChecked.add(s.id);
    const raw = prompts[0];
    const typed = cleanTitle(raw).trim();
    const files = [...raw.matchAll(/^- `(.+)` \(/gm)].map((m) => m[1].split('/').pop());
    const subject = [typed, files.length ? `Attached files: ${files.join(', ')}` : ''].filter(Boolean).join('\n').slice(0, 900);
    if (!subject) return;
    const ses = s.id;
    const model = modelRefJson(s.model);
    this.later(6000, async () => {
      try {
        const cur = str(obj(await this.client.get(`/session/${ses}`), 'data'), 'title');
        if (cur?.trim()) return;
        const res = await this.client.post('/experimental/generate/text', {
          prompt:
            'Name this conversation for a list of past chats: reply with a title of three to five words and nothing else ' +
            '(one line, no quotes, no trailing period). Name the subject; do not answer the request.\n\nFirst message:\n' +
            subject,
          ...(model ? { model } : {}),
        });
        const text = str(obj(res, 'data'), 'text');
        const title = text
          ? cleanTitle(text)
              .split('\n')
              .find((l) => l.trim())
              ?.trim()
              .replace(/^["'`]+|["'`]+$/g, '')
              .replace(/\.$/, '')
              .slice(0, 60)
          : null;
        if (!title || this.disposed || !this.created.has(ses)) return;
        await this.client.patch(`/session/${ses}`, { title });
        this.applyTitle(ses, title);
      } catch (e) {
        this.log(`[opencode] title ${ses}: ${errMsg(e)}`);
      }
    });
  }

  // ------------------------------------------------------------------ events

  private handleEvent(e: Json) {
    const type = str(e, 'type');
    if (!type) return;
    const d = obj(e, 'data') ?? {};
    const sid = str(d, 'sessionID') ?? str(obj(d, 'form'), 'sessionID');
    switch (type) {
      case 'server.connected':
        return;
      case 'session.created':
      case 'session.deleted':
      case 'session.forked':
      case 'session.archived':
      case 'session.unarchived':
      case 'session.moved':
        this.scheduleRefresh();
        break;
      case 'session.execution.started':
        if (sid) {
          this.retriesBySession.delete(sid);
          if (!this.running.has(sid)) {
            this.running.add(sid);
            this.changed('conversations');
          }
        }
        break;
      case 'session.retry.scheduled':
        if (sid && !this.sessions.has(sid)) {
          const attempt = num(d, 'attempt');
          const n = attempt != null ? Math.trunc(attempt) - 1 : (this.retriesBySession.get(sid) ?? 0) + 1;
          this.retriesBySession.set(sid, n);
          if (n > MAX_RETRIES) void this.interrupt(sid).catch(() => undefined);
        }
        break;
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted':
      case 'session.idle':
        if (sid && this.running.delete(sid)) this.changed('conversations');
        break;
      // providers / models / agents changed (signed in elsewhere, config reloaded): the picker follows
      case 'integration.updated':
      case 'provider.updated':
      case 'model.updated':
        this.debounce('models', 1000, () => void this.loadModels());
        return;
      case 'agent.updated':
        this.debounce('agents', 1000, () => void this.loadAgents());
        return;
      case 'session.renamed': {
        const raw = str(d, 'title');
        const title = raw ? cleanTitle(raw).trim() : '';
        if (sid && title) this.applyTitle(sid, title);
        break;
      }
    }
    const s = sid ? this.sessions.get(sid) : undefined;
    if (!s || s.closed) return;
    s.lastActivityAt = Date.now();
    if (type === 'session.execution.started') {
      s.turnStartedAt = performance.now();
      s.startWatchdog();
    }
    const changed = s.transcript.apply(type, d);
    if (type === 'session.retry.scheduled' && s.transcript.retries > MAX_RETRIES) {
      // OpenCode would keep retrying a provider that keeps failing: stop after a few tries and say why
      const why = s.transcript.lastRetryError;
      s.transcript.addError(`Gave up after ${MAX_RETRIES} retries`, `The provider kept failing${why ? `: ${why}` : '.'} Try again later or pick another model.`);
      s.transcript.setNotice(null);
      s.emitNow();
      void this.interrupt(s.id).catch(() => undefined);
      return;
    }
    switch (type) {
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted': {
        s.emitNow();
        if (type === 'session.execution.succeeded') this.titleIfMissing(s);
        // the stored chat is the reference (ids, final texts, usage): reload it once the turn is over
        this.later(400, () => {
          if (!s.closed && !s.transcript.isTurnActive) void this.reload(s);
          this.scheduleRefresh();
        });
        return;
      }
      case 'session.model.selected': {
        const m = modelRef(obj(d, 'model'));
        if (m) {
          s.model = m;
          this.serverList = this.serverList.map((c) => (c.id === s.id ? { ...c, modelId: m } : c));
        }
        break;
      }
      case 'session.agent.selected': {
        const a = str(d, 'agent');
        if (a) s.agent = a;
        break;
      }
    }
    if (changed || type === 'session.model.selected' || type === 'session.agent.selected') s.scheduleEmit();
  }

  /** The event stream is connected (for tests and the settings page). */
  get isConnected() {
    return this.connected;
  }

  dispose() {
    this.disposed = true;
    this.settings.dispose();
    this.eventsAc?.abort();
    if (this.loopTimer) clearTimeout(this.loopTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
