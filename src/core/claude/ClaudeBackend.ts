// Claude Code backend: the bridge runs one `claude` process per chat (spawned on its first message); each open chat
// attaches to `/api/claude/session` (ClaudeSession). This class keeps what the app's ClaudeChatBackend keeps outside
// the attached chat: the chat list, models / commands / defaults from the CLI's `initialize`, custom providers, plan
// usage, account status, and the controls of the next new chat. Port of ClaudeChatBackend.kt + ClaudeAccountManager.kt.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import type { AiModel, Conversation } from '../../../shared/model';
import type { AgentStatus, ControlChipView, ModelGroupView, ModelsState, SlashCommandView } from '../../../shared/protocol';
import type { AgentBackend, BackendChange, ChatState, KeyValueStore, Logger, SendRequest } from '../types';
import type { BridgeManager } from '../bridge/BridgeManager';
import { cleanTitle, collapseExpansions, displayUserText } from '../text';
import { ClaudeSession, type NewChatControls } from './ClaudeSession';
import { ClaudeSubagentView, parseSubagentId, subagentConversationId, toSubagentInfo, type SubagentWire } from './ClaudeSubagent';
import { questionnaireFrom } from './ClaudeTranscript';
import { ClaudeSettings } from './ClaudeSettings';
import { ALLOW_ONCE, PLAN_PREFIX, SUGGESTION_PREFIX } from './approvals';
import { applyClaudeQuota, claudeQuotaGroups, groupViews, scopedLimits } from './quota';
import {
  PERMISSION_MODES,
  compactTokens,
  contextLabel,
  effortDescription,
  effortLabel,
  formatReset,
  initializeInfo,
  limitsOf,
  num,
  permissionModeDescription,
  permissionModeIcon,
  permissionModeLabel,
  permissionModeTone,
  planLabel,
  providerOf,
  rawModel,
  usageTone,
  type CliStatus,
  type InitializeInfo,
  type ModelInfo,
  type Provider,
  type SessionSummary,
  type UnifiedWindow,
  type UsageInfo,
} from './protocol';

/** Built-in commands the extension answers itself (see appCommand). */
const APP_COMMANDS: Record<string, string> = {
  usage: 'Plan usage limits and this chat’s cost',
  context: 'Context window usage',
  model: 'Choose the model',
  effort: 'Set the effort level',
  mcp: 'MCP servers',
  config: 'Claude Code settings',
  clear: 'Start a new chat',
};

/** Built-ins that do nothing useful here (terminal-only views, internal or removed commands). */
const HIDDEN_COMMANDS = new Set(['color', 'focus', 'heapdump', '__remote-workflow', 'workflow-launch-exec', 'extra-usage', 'agents', 'import']);

const SLOW = 90_000;
/** Transcript uuids (the bridge's rewind takes only these; local replies have none). */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class ClaudeBackend implements AgentBackend {
  readonly kind = 'CLAUDE' as const;
  readonly settings: ClaudeSettings;

  private sessions = new Map<string, ClaudeSession>();
  private convs = new Map<string, Conversation>();
  private localConvs = new Map<string, Conversation>();
  /** Subagent runs of each chat (bridge list), their drawer rows (nested under the chat) and open views. */
  private subLists = new Map<string, SubagentWire[]>();
  private subConvs = new Map<string, Conversation>();
  private subViews = new Map<string, ClaudeSubagentView>();
  sessionsLoaded = false;
  private changeListeners = new Set<(w: BackendChange) => void>();

  // ---- CLI info, defaults, providers
  private info: InitializeInfo | null = null;
  modelsError: string | null = null;
  private refreshing = false;
  /** Permission mode new chats start in: the bridge's default (Auto unless settings.json sets one). */
  defaultPermissionMode: string;
  /** settings.json defaults for new chats: model, effortLevel, alwaysThinkingEnabled. */
  chatDefaults: { model: string | null; effort: string | null; thinking: boolean } = { model: null, effort: null, thinking: true };
  /** settings.json as last read (the settings pages use it too). */
  claudeSettings: { path: string; settings: Record<string, any> } | null = null;
  providers: Provider[] = [];
  settingsEndpoint: string | null = null;
  settingsConflicts: string[] = [];

  // ---- account & usage
  cli: CliStatus | null = null;
  private runState: AgentStatus['state'] = 'starting';
  private runDetail: string | null = 'Checking Claude Code…';
  usage: UsageInfo | null = null;
  usageUpdatedAt = 0;
  usageError: string | null = null;
  refreshingUsage = false;
  /** The newest plan windows a chat stream reported (fresher than the cached usage call). */
  liveLimits: Record<string, UnifiedWindow> = {};

  // ---- model picker & the next new chat's controls
  private pickerModel: string | null;
  private newChat: { effort?: string | null; thinking?: boolean; mode?: string; touched?: boolean } = {};
  /** Chats already asked for a title in this run. */
  readonly titleAsked = new Set<string>();

  private started = false;
  private disposed = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private countdownTimer: NodeJS.Timeout | null = null;
  private usageAfterTurnTimer: NodeJS.Timeout | null = null;
  private titleTimers = new Map<string, NodeJS.Timeout[]>();
  private usageSeq = 0;

  constructor(
    private bridge: BridgeManager,
    readonly store: KeyValueStore,
    readonly log: Logger,
    private opts: { openUrl: (url: string) => void } = { openUrl: () => undefined },
  ) {
    this.settings = new ClaudeSettings(this);
    this.pickerModel = store.get<string>('claude.model') ?? null;
    this.defaultPermissionMode = store.get<string>('claude.defaultMode') ?? 'auto';
    const cached = store.get<any>('claude.info');
    if (cached) this.info = initializeInfo(cached);
  }

  // ------------------------------------------------------------------ bridge helpers

  bridgeJson<T = any>(p: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
    return this.bridge.json<T>(p, timeoutMs ? { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) } : init);
  }

  /** JSON request with a body (POST / PUT / DELETE). */
  bridgeSend<T = any>(method: string, p: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    return this.bridgeJson<T>(
      p,
      { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      timeoutMs,
    );
  }

  wsUrl(p: string) {
    return this.bridge.wsUrl(p);
  }

  authHeaders() {
    return this.bridge.authHeaders();
  }

  /** The bridge's workspace folder (memory / MCP project scope). */
  workspaceDir(): string {
    return this.bridge.opts.workspaceDir;
  }

  openUrl(url: string) {
    this.opts.openUrl(url);
  }

  // ------------------------------------------------------------------ status & connection

  status(): AgentStatus {
    const a = this.cli?.auth;
    return {
      kind: 'CLAUDE',
      label: 'Claude Code',
      state: this.runState,
      detail: this.runDetail,
      account: a?.loggedIn ? (a.email ?? null) : null,
      // "2.1.322 (Claude Code)" → "2.1.322", as the app's Accounts dialog
      version: this.cli?.installed && this.cli.version ? this.cli.version.trim().split(/\s+/)[0] || null : null,
      plan: a?.loggedIn && a.subscriptionType ? planLabel(a.subscriptionType) : null,
      setupPage: 'claude.cli',
    };
  }

  onChange(cb: (w: BackendChange) => void) {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  changed(w: BackendChange) {
    for (const l of this.changeListeners) l(w);
  }

  start() {
    if (this.started) return;
    this.started = true;
    void (async () => {
      try {
        await this.bridge.ensureRunning();
      } catch (e) {
        this.setRun('offline', `Bridge not reachable: ${e instanceof Error ? e.message : String(e)}`);
      }
      void this.loadStatus();
      void this.loadInfo(false);
      void this.loadProviders();
      void this.loadChatDefaults();
      void this.loadUsage(false);
      const tick = async () => {
        if (this.disposed) return;
        await this.refreshSessions();
        // poll faster while a chat is working so the sidebar's running state stays current
        this.pollTimer = setTimeout(tick, [...this.convs.values()].some((c) => c.isRunning) ? 5_000 : 30_000);
      };
      await tick();
    })();
    // the reset countdowns ("2h 4m") tick down
    this.countdownTimer = setInterval(() => {
      if (this.usage) this.changed('models');
    }, 60_000);
  }

  retry() {
    void this.loadStatus();
    void this.refreshSessions();
    if (!this.info) void this.loadInfo(false);
    for (const s of this.sessions.values()) {
      if (!s.listeners.size) continue;
      // a chat not on disk yet has no history to reload: just reconnect (its output is in the bridge buffer)
      if (this.isOnDisk(s.id)) void s.loadAndAttach();
      else s.ensureConnected();
    }
  }

  private setRun(state: AgentStatus['state'], detail: string | null) {
    if (state === this.runState && detail === this.runDetail) return;
    this.runState = state;
    this.runDetail = detail;
    this.changed('status');
  }

  /** `claude --version` + `claude auth status` through the bridge (ClaudeAccountManager.refreshStatus). */
  async loadStatus() {
    try {
      const res = await this.bridge.fetch('/api/claude/status', { signal: AbortSignal.timeout(SLOW) });
      const text = await res.text();
      const isJson = text.trimStart().startsWith('{');
      // the bridge's Claude routes always answer JSON; a plain 404 means a bridge without them
      if (res.status === 404 && !isJson) throw new Error('The running bridge has no Claude Code support. Restart it to load the new version.');
      if (res.status === 503 && text.includes('"disabled":true')) throw new Error('The bridge was started with Claude Code turned off. Restart it to use Claude.');
      if (!isJson) throw new Error(`HTTP ${res.status}`);
      const st = JSON.parse(text);
      this.cli = { installed: st.installed === true, version: st.version ?? null, bin_path: st.bin_path ?? null, auth: st.auth ?? null, auth_error: st.auth_error ?? null, error: st.error ?? null };
      const a = this.cli.auth;
      if (!this.cli.installed) this.setRun('not_installed', 'Claude Code is not installed. Install it from Settings → Claude Code → Account & CLI.');
      else if (!a && this.cli.auth_error) this.setRun('online', `Could not read the sign-in state: ${this.cli.auth_error}`);
      else if (a?.loggedIn) this.setRun('online', [a.email, a.subscriptionType ? `${planLabel(a.subscriptionType)} plan` : null].filter(Boolean).join(' · ') || 'Signed in');
      else this.setRun('error', 'Sign in required (Settings → Claude Code → Account & CLI)');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const offline = /fetch failed|ECONNREFUSED|ENOTFOUND|aborted|timeout/i.test(msg);
      this.setRun(offline ? 'offline' : 'error', offline ? `Bridge not reachable: ${msg}` : msg);
    }
    this.changed('settings');
  }

  // ------------------------------------------------------------------ CLI info, defaults, providers, usage

  modelInfos(): ModelInfo[] {
    return this.info?.models ?? [];
  }

  modelInfo(modelId: string): ModelInfo | undefined {
    return this.info?.models.find((m) => m.value === modelId);
  }

  cliInfo(): InitializeInfo | null {
    return this.info;
  }

  provider(id: string): Provider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  /** Models, slash commands and defaults from the CLI's `initialize` (cached by the bridge; refresh=1 asks again). */
  async loadInfo(force: boolean) {
    try {
      const resp = await this.bridgeJson(`/api/claude/info${force ? '?refresh=1' : ''}`, {}, SLOW);
      if (resp?.success && resp.info) {
        this.info = initializeInfo(resp.info);
        this.store.set('claude.info', resp.info);
        this.modelsError = null;
        if (typeof resp.default_mode === 'string' && resp.default_mode) {
          this.defaultPermissionMode = resp.default_mode;
          this.store.set('claude.defaultMode', resp.default_mode);
        }
      } else this.modelsError = resp?.error ?? 'Claude Code did not return its models';
    } catch (e) {
      this.modelsError = e instanceof Error ? e.message : String(e);
      this.log(`[claude] info: ${this.modelsError}`);
    }
    this.changed('models');
    this.changed('commands');
    this.changed('controls');
  }

  async loadProviders() {
    try {
      const resp = await this.bridgeJson('/api/claude/providers', {}, 6_000);
      if (!resp?.success) return;
      this.providers = (Array.isArray(resp.providers) ? resp.providers : []).map((p: any) => ({ ...p, models: Array.isArray(p.models) ? p.models : [] }));
      this.settingsEndpoint = typeof resp.settings_endpoint === 'string' && resp.settings_endpoint.trim() ? resp.settings_endpoint : null;
      this.settingsConflicts = Array.isArray(resp.settings_conflicts) ? resp.settings_conflicts : [];
      this.changed('models');
    } catch (e) {
      this.log(`[claude] providers: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** settings.json: the defaults for new chats (and the settings pages' data). */
  async loadChatDefaults() {
    try {
      const resp = await this.bridgeJson('/api/claude/settings', {}, 6_000);
      if (!resp?.success) return;
      const st = resp.settings && typeof resp.settings === 'object' ? resp.settings : {};
      this.claudeSettings = { path: String(resp.path ?? ''), settings: st };
      const s = (k: string) => (typeof st[k] === 'string' && st[k] ? (st[k] as string) : null);
      this.chatDefaults = { model: s('model'), effort: s('effortLevel'), thinking: typeof st.alwaysThinkingEnabled === 'boolean' ? st.alwaysThinkingEnabled : true };
      this.changed('controls');
    } catch (e) {
      this.log(`[claude] settings: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Plan limits (`get_usage`). force: fresh numbers, which also replace the windows the last reply carried. */
  async loadUsage(force: boolean) {
    const seq = ++this.usageSeq;
    this.refreshingUsage = true;
    try {
      const resp = await this.bridgeJson(`/api/claude/usage${force ? '?refresh=1' : ''}`, {}, SLOW);
      if (resp?.success) {
        this.usage = resp.usage ?? null;
        this.usageError = null;
        this.usageUpdatedAt = Date.now();
        if (force) this.liveLimits = {};
      } else this.usageError = resp?.error ?? 'Claude Code did not return usage';
    } catch (e) {
      this.usageError = e instanceof Error ? e.message : String(e);
    } finally {
      if (seq === this.usageSeq) this.refreshingUsage = false;
    }
    this.changed('models');
    this.changed('settings');
  }

  /** A chat stream reported plan windows (`rate_limit_event`). */
  onLiveRateLimits(windows: Record<string, UnifiedWindow>) {
    if (!Object.keys(windows).length) return;
    this.liveLimits = windows;
    this.changed('models');
  }

  /** A turn finished: the chat list's running state, plan usage (as the app: a cached refresh). */
  afterTurn(id: string) {
    this.runningChanged();
    this.scheduleTitleRefresh(id);
    if (this.usageAfterTurnTimer) clearTimeout(this.usageAfterTurnTimer);
    this.usageAfterTurnTimer = setTimeout(() => void this.loadUsage(false), 3000);
  }

  /** The CLI writes a chat's AI title shortly after the first reply: look again a few times. */
  private scheduleTitleRefresh(id: string) {
    for (const t of this.titleTimers.get(id) ?? []) clearTimeout(t);
    this.titleTimers.set(
      id,
      [1_500, 6_000, 15_000].map((ms) => setTimeout(() => void this.refreshSessions(), ms)),
    );
  }

  // ------------------------------------------------------------------ models

  /** Readable name of a model id, with the provider for a custom one ("Gemma 4 31B · OpenRouter"). */
  modelLabel(modelId: string): string {
    const pid = providerOf(modelId);
    const m = this.allModels().find((x) => x.id === modelId);
    if (!pid) return `Claude ${m?.displayName ?? modelId}`;
    return `${m?.displayName ?? rawModel(modelId)} · ${this.provider(pid)?.name ?? pid}`;
  }

  /** The context window the user saved for a custom model (0 = unknown or a Claude model). */
  contextLengthOf(modelId: string): number {
    const pid = providerOf(modelId);
    const p = pid ? this.provider(pid) : undefined;
    return p ? limitsOf(p, rawModel(modelId)).context : 0;
  }

  /** Claude's models ("Default (Opus 5.5)" for the default), then every provider's models ("@provider/model"). */
  private allModels(): AiModel[] {
    // Claude's own models need the Claude login; the providers' models only their key
    const a = this.cli?.auth;
    const signedOut = !!this.cli?.installed && !!a && a.loggedIn !== true;
    const official: AiModel[] = (signedOut ? [] : (this.info?.models ?? []))
      .filter((m) => !m.disabled)
      .map((m) => {
        const resolved = m.value === 'default' && m.description.includes(' · ') ? m.description.split(' · ')[0] : '';
        return {
          id: m.value,
          key: m.value,
          displayName: resolved ? `Default (${resolved})` : m.displayName || m.value,
          family: 'CLAUDE',
          description: m.description,
          isDefault: m.value === 'default',
          baseName: m.displayName || m.value,
          tier: null,
        };
      });
    const custom: AiModel[] = this.providers.flatMap((p) =>
      p.models.map((m) => ({
        id: `@${p.id}/${m.id}`,
        key: `@${p.id}/${m.id}`,
        displayName: m.name?.trim() ? m.name : m.id,
        family: 'CLAUDE' as const,
        description: [p.name, contextLabel(p, m)].filter(Boolean).join(' · '),
        isDefault: false,
        baseName: m.id,
        tier: null,
        group: p.name,
      })),
    );
    return [...official, ...custom];
  }

  models(): ModelsState {
    const all = this.allModels();
    const official = all.filter((m) => !providerOf(m.id));
    const custom = all.filter((m) => providerOf(m.id));
    const pill = this.store.get<{ quotaPillWindow?: '5h' | '7d' }>('ui.prefs')?.quotaPillWindow === '7d' ? '7d' : '5h';
    const overrides = this.store.get<Record<string, string>>('claude.quotaOverrides') ?? {};
    const groups = claudeQuotaGroups(this.usage, this.liveLimits);
    const models = [...applyClaudeQuota(official, groups, pill, overrides), ...custom];
    const views: ModelGroupView[] = [...groupViews(groups), ...this.providers.filter((p) => p.models.length).map((p) => ({ name: p.name }))];
    const want = this.pickerModel ?? this.chatDefaults.model ?? 'default';
    const selectedId = models.some((m) => m.id === want) ? want : (models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? null);
    return { agent: 'CLAUDE', models, selectedId, groups: views.length ? views : undefined, refreshing: this.refreshing };
  }

  refreshModels() {
    if (this.refreshing) return;
    this.refreshing = true;
    this.changed('models');
    void Promise.allSettled([this.loadInfo(true), this.loadUsage(true), this.loadProviders()]).then(() => {
      this.refreshing = false;
      this.changed('models');
    });
  }

  selectModel(conversationId: string | null, modelId: string) {
    this.pickerModel = modelId;
    this.store.set('claude.model', modelId);
    const s = conversationId ? this.sessions.get(conversationId) : undefined;
    if (s && (s.prepared || this.isOnDisk(s.id) || !s.transcript.isEmpty)) s.selectModel(modelId);
    this.changed('models');
    this.changed('controls');
  }

  // ------------------------------------------------------------------ commands

  commands(): SlashCommandView[] {
    return (this.info?.commands ?? [])
      .filter((c) => !HIDDEN_COMMANDS.has(c.name) && !c.description.startsWith('(removed)'))
      .map((c) => {
        const app = APP_COMMANDS[c.name];
        const plugin = c.name.includes(':') ? c.name.split(':')[0] : null;
        return {
          command: `/${c.name}`,
          description: app ?? (c.description || null),
          argumentHint: app ? null : c.argumentHint || null,
          kind: app ? ('app' as const) : c.builtin && !plugin ? ('command' as const) : ('skill' as const),
          pluginName: plugin,
        };
      });
  }

  /**
   * A slash command the extension answers itself (true), or false to send the text to Claude. Commands that only
   * change a chat control (`/model opus`, `/effort high`, `/rename x`) go through the controls so the chips stay in sync.
   */
  private async appCommand(s: ClaudeSession, typed: string): Promise<boolean> {
    if (!typed.startsWith('/')) return false;
    const space = typed.indexOf(' ');
    const name = (space < 0 ? typed.slice(1) : typed.slice(1, space)).toLowerCase();
    const arg = space < 0 ? '' : typed.slice(space + 1).trim();
    switch (name) {
      case 'usage':
      case 'cost':
        s.localExchange(typed, await this.usageReport(s));
        return true;
      case 'context': {
        const c = await s.refreshContextUsage();
        s.localExchange(
          typed,
          !c
            ? 'Context usage shows once this chat has started (send a message first).'
            : [
                `**Context window** · ${compactTokens(c.totalTokens)} of ${compactTokens(c.maxTokens)} tokens used (${Math.floor(c.percentage)}%)`,
                '',
                ...c.categories.map((k) => `- ${k.name}: ${compactTokens(k.tokens)}`),
                '',
                '_Send /compact to summarize the conversation and free space._',
              ].join('\n'),
        );
        return true;
      }
      case 'model':
        if (!arg) {
          const list = this.allModels()
            .map((m) => `- \`${m.id}\` · ${m.displayName}${m.id === s.model ? ' **(this chat)**' : ''}`)
            .join('\n');
          s.localExchange(typed, `${list || 'No models loaded yet.'}\n\n_Pick one in the model picker, or send /model <name>._`);
          return true;
        }
        this.selectModel(s.id, arg);
        s.localExchange(typed, `Model set to ${arg}`);
        return true;
      case 'effort': {
        const levels = this.modelInfo(s.model)?.supportedEffortLevels ?? [];
        if (!arg) {
          s.localExchange(
            typed,
            `Effort: **${effortLabel(s.effort)}**\n\n${['default', ...levels].map((l) => `- \`${l}\` · ${effortDescription(l === 'default' ? null : l)}`).join('\n')}`,
          );
          return true;
        }
        const level = /^(auto|default)$/i.test(arg) ? null : arg.toLowerCase();
        void s.setEffort(level);
        s.localExchange(typed, level ? `Effort set to ${level === 'xhigh' ? 'extra high' : level}` : 'Effort set to the model default');
        return true;
      }
      case 'mcp': {
        if (arg) return false;
        let list = '';
        try {
          const r = await this.bridgeJson(`/api/claude/mcp?cwd=${encodeURIComponent(this.workspaceDir())}`, {}, SLOW);
          const servers: any[] = Array.isArray(r?.servers) ? r.servers : [];
          list = servers.map((x) => `- **${x.name}** · ${x.status || 'unknown'}${x.tools?.length ? ` · ${x.tools.length} tools` : ''}${x.error ? ` · ${x.error}` : ''}`).join('\n');
          if (!r?.success) list = `Could not check the servers: ${r?.error ?? 'unknown error'}`;
        } catch (e) {
          list = `Could not check the servers: ${e instanceof Error ? e.message : String(e)}`;
        }
        s.localExchange(typed, `${list || 'No MCP servers yet.'}\n\n_Add or remove servers in Settings → Agents → Claude Code → MCP servers._`);
        return true;
      }
      case 'config':
        if (arg) return false;
        s.localExchange(typed, 'Claude Code settings are in Settings → Agents → Claude Code (chat defaults, permission rules, MCP servers, plugins, memory, custom providers, settings.json).');
        return true;
      case 'clear':
      case 'new':
        s.localExchange(typed, 'Start a new chat with the + button (the conversation so far stays in this chat).');
        return true;
      case 'rename':
        if (!arg) return false;
        await this.conversationAction(s.id, 'rename', arg);
        s.localExchange(typed, 'Chat renamed');
        return true;
      default:
        return false;
    }
  }

  /** The `/usage` reply: plan limits (live windows win) and this chat's cost. */
  private async usageReport(s: ClaudeSession): Promise<string> {
    if (providerOf(s.model)) {
      return `This chat runs on ${this.modelLabel(s.model)}, a custom provider. Plan usage and cost are only shown for Claude's own models; check the provider's dashboard for this chat's usage.`;
    }
    await this.loadUsage(true);
    const rl = this.usage?.rate_limits;
    const lines: string[] = [];
    const plan = this.usage?.subscription_type ?? this.cli?.auth?.subscriptionType;
    lines.push(`**Usage** · Claude Code${plan ? ` · ${planLabel(plan)} plan` : ''}`, '');
    const bar = (label: string, used: number, reset: string | null) => `- ${label}: ${Math.round(used * 100)}% used${reset ? ` · resets ${reset}` : ''}`;
    const five = this.liveLimits.five_hour
      ? bar('Current session (5-hour)', this.liveLimits.five_hour.utilization, formatReset(null, this.liveLimits.five_hour.resetsAt))
      : rl?.five_hour
        ? bar('Current session (5-hour)', num(rl.five_hour.utilization) / 100, formatReset(rl.five_hour.resets_at))
        : null;
    const week = this.liveLimits.seven_day
      ? bar('This week (all models)', this.liveLimits.seven_day.utilization, formatReset(null, this.liveLimits.seven_day.resetsAt))
      : rl?.seven_day
        ? bar('This week (all models)', num(rl.seven_day.utilization) / 100, formatReset(rl.seven_day.resets_at))
        : null;
    if (five || week) {
      if (five) lines.push(five);
      if (week) lines.push(week);
      for (const sl of scopedLimits(rl)) lines.push(bar(`This week (${sl.name})`, sl.used, formatReset(sl.resetsAt)));
    } else if (this.usage && !this.usage.rate_limits_available) lines.push('Plan limits do not apply to this account (API billing has no 5-hour or weekly limits).');
    else lines.push(`Plan usage is not available right now${this.usageError ? ` (${this.usageError})` : ''}.`);
    const cost = s.transcript.sessionCostUsd;
    lines.push('', `This chat: ${cost > 0 ? `$${cost.toFixed(2)}` : '–'}`, '', '_Cost is what this chat would cost at API prices; on a subscription it counts toward the limits above._');
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ controls

  /** The controls of [s] (null = the next new chat): permission mode, effort, thinking, cache, context, 5h limit. */
  controlsFor(s: ClaudeSession | null): ControlChipView[] {
    const model = s ? s.model : (this.pickerModel ?? this.chatDefaults.model ?? 'default');
    const custom = providerOf(model) !== '';
    const info = custom ? undefined : (this.modelInfo(model) ?? this.info?.models[0]);
    const mode = s ? s.permissionMode : (this.newChat.mode ?? this.defaultPermissionMode);
    const effort = s ? s.effort : this.newChat.effort !== undefined ? this.newChat.effort : this.chatDefaults.effort;
    const thinking = s ? s.thinking : (this.newChat.thinking ?? this.chatDefaults.thinking);
    const autoSupported = !custom && info?.supportsAutoMode !== false;
    const modes = PERMISSION_MODES.filter(([v]) => v !== 'auto' || autoSupported);
    if (!modes.some(([v]) => v === mode)) modes.push([mode, permissionModeLabel(mode)]);
    const chips: ControlChipView[] = [];
    // a provider switch waiting for the user's answer (the app's ClaudeProviderSwitchDialog)
    if (s?.pendingSwitch) {
      const running = s.transcript.isTurnActive;
      chips.push({
        id: 'switch',
        label: 'Switch provider?',
        title: `Move this chat to ${this.modelLabel(s.pendingSwitch.modelId)}?`,
        kind: 'select',
        value: '',
        options: [
          { value: 'new', label: 'Start a new chat with it', description: 'Recommended: this chat stays as it is' },
          { value: 'cancel', label: 'Cancel', description: `Stay on ${this.modelLabel(s.model)}` },
          {
            value: 'switch',
            label: running ? 'Switch after this reply' : 'Switch anyway',
            description: 'Claude Code restarts; the whole conversation is sent again without cache, so the next reply costs far more. Thinking, effort and Auto mode may not carry over.',
          },
        ],
        note: 'Starting a new chat is usually the better choice: the new provider may also reject or misread earlier replies.',
        icon: 'warning',
        tone: 'warn',
      });
    }
    chips.push(
      {
        id: 'mode',
        label: permissionModeLabel(mode),
        title: 'Permission mode',
        kind: 'select',
        value: mode,
        options: modes.map(([value, label]) => ({ value, label, description: permissionModeDescription(value) })),
        note: autoSupported
          ? 'Auto asks only for risky actions. For fewer prompts without giving up checks, turn on Sandbox commands in Settings → Agents → Claude Code → Permission rules.'
          : 'This model has no Auto mode; chats on it start in Manual.',
        icon: permissionModeIcon(mode),
        tone: permissionModeTone(mode),
      },
    );
    const levels = info?.supportedEffortLevels ?? [];
    if (levels.length) {
      const applied = s?.appliedEffort ?? null;
      chips.push({
        id: 'effort',
        // "Default" shows the level the process really runs when the CLI reported it
        label: `Effort · ${effortLabel(effort)}${effort == null && applied ? ` (${effortLabel(applied)})` : ''}`,
        title: 'Effort',
        kind: 'select',
        value: effort ?? 'default',
        options: [null, ...levels].map((l) => ({ value: l ?? 'default', label: effortLabel(l), description: effortDescription(l) })),
        note: 'How much work Claude puts into each reply.',
        icon: 'speed',
        tone: effort != null ? 'accent' : 'muted',
      });
    }
    chips.push({ id: 'thinking', label: thinking ? 'Thinking' : 'No thinking', title: 'Thinking', kind: 'toggle', value: thinking ? 'on' : 'off', icon: 'lightbulb', tone: thinking ? 'accent' : 'muted' });
    if (s) {
      const c = s.transcript.cacheInfo;
      if (c) {
        const left = c.anchorMs + c.ttlMs - Date.now();
        const warm = !c.compacted && c.ttlMs > 0 && left > 0;
        chips.push({ id: 'cache', label: warm ? `Cache ${Math.floor((left + 59_999) / 60_000)}m` : 'Cache cold', title: 'Prompt cache', kind: 'info', value: warm ? 'warm' : 'cold', icon: 'timer', tone: warm ? 'success' : 'muted' });
      }
      const ctx = s.contextUsage;
      if (ctx) chips.push({ id: 'context', label: `Context ${Math.floor(ctx.percentage)}%`, title: 'Context window', kind: 'info', value: String(ctx.percentage), icon: 'data_usage', tone: usageTone(ctx.percentage / 100) });
      const w = this.liveLimits.five_hour;
      if (w && !custom) chips.push({ id: 'limit', label: `5h ${Math.floor(w.utilization * 100)}%`, title: 'Usage', kind: 'info', value: String(w.utilization), icon: 'bolt', tone: usageTone(w.utilization) });
      // the app's "Restart chat": a provider chat picks up changed provider settings with a new process
      if (custom && s.processLive && !s.transcript.isTurnActive) chips.push({ id: 'restart', label: 'Restart', title: 'Restart chat', kind: 'action', value: 'run', icon: 'restart_alt', tone: 'muted' });
    }
    // fast mode (the model sheet's "Fast mode · Off — send /fast to toggle")
    if (info?.supportsFastMode) {
      const fast = s?.fastMode ?? this.info?.fast_mode_state ?? 'off';
      chips.push({ id: 'fast', label: `Fast · ${fast.charAt(0).toUpperCase()}${fast.slice(1)}`, title: 'Fast mode', kind: 'info', value: fast, icon: 'bolt', tone: fast === 'on' ? 'accent' : 'muted' });
    }
    return chips;
  }

  /** The text behind an info chip (the app's cache / context / usage dialogs). */
  private async chipDetails(s: ClaudeSession | null, id: string): Promise<string | null> {
    switch (id) {
      case 'cache': {
        const c = s?.transcript.cacheInfo;
        const left = c ? c.anchorMs + c.ttlMs - Date.now() : 0;
        if (!c) return 'No cache information yet.';
        if (c.compacted) return 'The conversation was compacted, so your next message will re-cache it.';
        if (left > 0)
          return `Cache warm, about ${Math.floor((left + 59_999) / 60_000)} min left (${c.ttlMs >= 3_600_000 ? '1-hour' : '5-minute'} cache). Messages sent before it expires reuse it and cost less.`;
        return `The prompt cache has likely expired, so your next message will re-cache about ${compactTokens(c.recacheTokens)} tokens.`;
      }
      case 'context': {
        const c = s ? await s.refreshContextUsage() : null;
        if (!c) return 'Context usage shows once this chat has started (send a message first).';
        const top = [...c.categories].sort((a, b) => b.tokens - a.tokens).slice(0, 6).map((k) => `${k.name} ${compactTokens(k.tokens)}`).join(' · ');
        return `${compactTokens(c.totalTokens)} of ${compactTokens(c.maxTokens)} tokens used (${Math.floor(c.percentage)}%). ${top}. Send /compact to summarize the conversation and free space.`;
      }
      case 'limit':
        return s ? (await this.usageReport(s)).replace(/\*\*/g, '').replace(/_/g, '').replace(/\n+- /g, ' · ').replace(/\n+/g, ' ') : null;
      case 'fast':
        return 'Fast mode makes this model answer faster on extra-usage pricing. Send /fast in the chat to toggle it.';
      default:
        return null;
    }
  }

  controls(conversationId: string | null): ControlChipView[] {
    const s = conversationId ? this.sessions.get(conversationId) : undefined;
    return this.controlsFor(s && (s.prepared || this.isOnDisk(s.id) || !s.transcript.isEmpty) ? s : null);
  }

  async setControl(conversationId: string | null, id: string, value: string) {
    const s = conversationId ? this.sessions.get(conversationId) : undefined;
    const live = s && (s.prepared || this.isOnDisk(s.id) || !s.transcript.isEmpty) ? s : null;
    if (value === 'details') {
      const text = await this.chipDetails(live, id);
      if (text) this.notify('info', text);
      return;
    }
    if (live && id === 'switch') {
      live.answerSwitch(value);
      return;
    }
    if (live && id === 'restart') {
      this.notify('info', await this.restartChat(live.id));
      return;
    }
    if (!live) {
      // the next new chat
      if (id === 'mode') this.newChat.mode = value;
      else if (id === 'effort') this.newChat.effort = value === 'default' ? null : value;
      else if (id === 'thinking') this.newChat.thinking = value === 'on';
      else return;
      this.newChat.touched = true;
      this.changed('controls');
      return;
    }
    if (id === 'mode') void live.setPermissionMode(value);
    else if (id === 'effort') void live.setEffort(value === 'default' ? null : value);
    else if (id === 'thinking') void live.setThinking(value === 'on');
  }

  /** The controls a chat started now gets (then the new-chat screen starts from the defaults again). */
  private takeNewChatControls(modelId: string | null): NewChatControls {
    const n = this.newChat;
    const c: NewChatControls = {
      model: modelId ?? this.pickerModel ?? this.chatDefaults.model ?? 'default',
      effort: n.effort !== undefined ? n.effort : this.chatDefaults.effort,
      thinking: n.thinking ?? this.chatDefaults.thinking,
      permissionMode: n.mode ?? this.defaultPermissionMode,
      modeTouched: n.mode !== undefined,
      controlsTouched: n.effort !== undefined || n.thinking !== undefined || modelId != null,
    };
    this.newChat = {};
    if (n.touched) this.changed('controls');
    return c;
  }

  // ------------------------------------------------------------------ notifier, search, tool actions

  private notifier: ((level: 'info' | 'warning' | 'error', message: string) => void) | null = null;

  setNotifier(notify: (level: 'info' | 'warning' | 'error', message: string) => void) {
    this.notifier = notify;
  }

  /** Shows a toast through the host; false when the host gave no notifier. */
  notify(level: 'info' | 'warning' | 'error', message: string): boolean {
    if (!this.notifier) {
      this.log(`[claude] ${level}: ${message}`);
      return false;
    }
    this.notifier(level, message);
    return true;
  }

  /** Text of chats loaded in this run (the bridge has no search route): id → lowercased text, newest last. */
  private textIndex = new Map<string, string>();
  /** The bridge's last prompt of each chat (cheap: comes with the chat list). */
  private lastPrompts = new Map<string, string>();

  indexChat(id: string, messages: { role: string; content: string }[]) {
    const text = messages
      .filter((m) => m.role === 'USER' || m.role === 'ASSISTANT')
      .map((m) => m.content.replace(/<!-- (?:tool_call:[^>]*|\/?thought(?::streaming)?|\/?error) -->/g, ' '))
      .join('\n')
      .slice(0, 400_000);
    this.textIndex.delete(id);
    this.textIndex.set(id, text);
    // keep the newest 60 chats
    while (this.textIndex.size > 60) this.textIndex.delete(this.textIndex.keys().next().value!);
  }

  /** Drawer deep search: the chats' last prompts, and the full text of chats opened in this run. */
  async search(query: string): Promise<{ conversationId: string; snippet: string }[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const snippet = (text: string, at: number) => {
      const from = Math.max(0, at - 50);
      return `${from > 0 ? '…' : ''}${text.slice(from, at + q.length + 70).replace(/\s+/g, ' ').trim()}…`;
    };
    const out: { conversationId: string; snippet: string }[] = [];
    for (const c of this.conversations()) {
      const full = this.textIndex.get(c.id);
      const lower = full?.toLowerCase();
      const i = lower ? lower.indexOf(q) : -1;
      if (full && i >= 0) {
        out.push({ conversationId: c.id, snippet: snippet(full, i) });
        continue;
      }
      const lp = this.lastPrompts.get(c.id) ?? '';
      const j = lp.toLowerCase().indexOf(q);
      if (j >= 0) out.push({ conversationId: c.id, snippet: snippet(lp, j) });
    }
    return out;
  }

  /** Tool card actions: "terminate" a running command interrupts the turn (the app's terminateRunningTerminalTool). */
  async toolAction(conversationId: string, toolId: string, action: string) {
    const s = this.sessions.get(conversationId);
    if (!s || action !== 'terminate') return;
    const tool = s.transcript.toChatMessages().flatMap((m) => m.toolCalls).find((t) => t.id === toolId);
    if (tool && tool.status !== 'RUNNING' && tool.status !== 'PENDING_APPROVAL') return;
    s.interrupt();
    this.notify('info', 'Stopping Claude Code…');
  }

  /** Model sheet edit mode: put a Claude model in another plan group (null = automatic). */
  setQuotaGroup(modelId: string, group: string | null) {
    const overrides = { ...(this.store.get<Record<string, string>>('claude.quotaOverrides') ?? {}) };
    const groups = claudeQuotaGroups(this.usage, this.liveLimits);
    const g = group == null ? null : groups.find((x) => x.title === group || x.id === group);
    if (g) overrides[modelId] = g.id;
    else delete overrides[modelId];
    this.store.set('claude.quotaOverrides', overrides);
    this.changed('models');
  }

  /** Stops the chat's process (when idle); its next message starts one with the current settings (the app's restartChat). */
  async restartChat(id: string): Promise<string> {
    try {
      const r = await this.bridgeSend('POST', `/api/claude/sessions/${id}/restart`, {});
      if (!r?.success) return r?.error ?? 'Could not restart the chat';
      this.sessions.get(id)?.scheduleEmit();
      return 'Restarted: the next message uses the current provider settings';
    } catch (e) {
      return e instanceof Error ? e.message : 'The bridge is not reachable';
    }
  }

  // ------------------------------------------------------------------ conversations

  conversations(): Conversation[] {
    const list: Conversation[] = [];
    for (const c of this.convs.values()) list.push(this.withLive(c));
    for (const c of this.localConvs.values()) if (!this.convs.has(c.id)) list.push(this.withLive(c));
    for (const c of this.subConvs.values()) list.push(c);
    return list;
  }

  // ------------------------------------------------------------------ subagents (read-only transcripts)

  /** The bridge's subagent runs of chat [sessionId], for its transcript (links, running state). */
  subagentsOf(sessionId: string) {
    return (this.subLists.get(sessionId) ?? []).map(toSubagentInfo);
  }

  hasRunningSubagents(sessionId: string): boolean {
    return (this.subLists.get(sessionId) ?? []).some((a) => a.running === true);
  }

  subagentRunning(convId: string): boolean {
    return this.subConvs.get(convId)?.isRunning === true;
  }

  /** A fresher subagent list of one chat (its open view polls it). */
  applySessionSubagents(sessionId: string, list: SubagentWire[]) {
    const before = JSON.stringify(this.subLists.get(sessionId) ?? []);
    if (before === JSON.stringify(list)) return;
    if (list.length) this.subLists.set(sessionId, list);
    else this.subLists.delete(sessionId);
    this.rebuildSubConvs();
    const infos = this.subagentsOf(sessionId);
    const s = this.sessions.get(sessionId);
    if (s) {
      s.transcript.setSubagents(infos);
      s.scheduleEmit();
    }
    for (const v of this.subViews.values()) if (v.sessionId === sessionId) v.update(infos);
    this.changed('conversations');
  }

  /** Drawer rows: each subagent under its chat (or under the subagent that started it). */
  private rebuildSubConvs() {
    const next = new Map<string, Conversation>();
    for (const [sessionId, list] of this.subLists) {
      const parent = this.convs.get(sessionId);
      if (!parent) continue;
      for (const w of list) {
        if (!w?.agent_id) continue;
        const id = subagentConversationId(sessionId, w.agent_id);
        const running = w.running === true;
        next.set(id, {
          id,
          title: (w.description || w.agent_type || 'Subagent').trim(),
          modelId: '',
          createdAt: num(w.created_at) || parent.createdAt,
          updatedAt: num(w.updated_at) || parent.updatedAt,
          isRunning: running,
          notFullyIdle: running,
          hasActivity: false,
          runStatus: running ? 'RUNNING' : 'IDLE',
          stepCount: 0,
          workspaceUri: parent.workspaceUri,
          nestingDepth: w.parent_agent_id ? 2 : 1,
          agent: 'CLAUDE',
          archived: parent.archived,
          parentConversationId: w.parent_agent_id ? subagentConversationId(sessionId, w.parent_agent_id) : sessionId,
          subagentRole: w.description || null,
          subagentTypeName: w.agent_type || null,
        });
      }
    }
    this.subConvs = next;
  }

  private subView(id: string): ClaudeSubagentView {
    let v = this.subViews.get(id);
    if (!v) {
      const p = parseSubagentId(id)!;
      v = new ClaudeSubagentView(id, p.sessionId, p.agentId, this);
      v.update(this.subagentsOf(p.sessionId));
      this.subViews.set(id, v);
    }
    return v;
  }

  dropSubagentView(id: string) {
    const v = this.subViews.get(id);
    if (!v || v.listeners.size) return;
    v.close();
    this.subViews.delete(id);
  }

  private withLive(c: Conversation): Conversation {
    const s = this.sessions.get(c.id);
    const active = s?.transcript.isTurnActive === true;
    return active && !c.isRunning ? { ...c, isRunning: true, notFullyIdle: true } : c;
  }

  conversation(id: string): Conversation | undefined {
    return this.convs.get(id) ?? this.localConvs.get(id) ?? this.subConvs.get(id);
  }

  /** The bridge lists the chat (its transcript exists); a chat only known here has not been written yet. */
  isOnDisk(id: string): boolean {
    return this.convs.has(id) && !this.localConvs.has(id);
  }

  runningChanged() {
    this.changed('conversations');
  }

  setTitle(id: string, title: string) {
    const c = this.convs.get(id);
    if (c) this.convs.set(id, { ...c, title });
    const l = this.localConvs.get(id);
    if (l) this.localConvs.set(id, { ...l, title });
    this.changed('conversations');
    this.sessions.get(id)?.scheduleEmit();
  }

  async refreshSessions() {
    try {
      const resp = await this.bridgeJson('/api/claude/sessions');
      const list: SessionSummary[] = Array.isArray(resp?.sessions) ? resp.sessions : [];
      const next = new Map<string, Conversation>();
      for (const s of list) {
        if (typeof s?.id !== 'string') continue;
        if (typeof s.last_prompt === 'string' && s.last_prompt) this.lastPrompts.set(s.id, displayUserText(s.last_prompt, s.id).text);
        next.set(s.id, {
          id: s.id,
          // an older bridge makes titles from the raw first prompt, hidden blocks included
          title: cleanTitle(String(s.title ?? '')).trim() || 'Claude Chat',
          modelId: '',
          createdAt: num(s.created_at),
          updatedAt: num(s.updated_at),
          isRunning: s.busy === true,
          notFullyIdle: s.busy === true,
          hasActivity: false,
          runStatus: s.busy ? 'RUNNING' : s.live ? 'IDLE_LIVE' : 'IDLE',
          stepCount: 0,
          workspaceUri: s.cwd ? `file://${s.cwd}` : '',
          nestingDepth: 0,
          agent: 'CLAUDE',
          archived: s.archived === true,
        });
      }
      this.convs = next;
      const lists = new Map<string, SubagentWire[]>();
      for (const s of list) if (typeof s?.id === 'string' && Array.isArray(s.subagents) && s.subagents.length) lists.set(s.id, s.subagents);
      this.subLists = lists;
      this.rebuildSubConvs();
      for (const s of this.sessions.values()) s.transcript.setSubagents(this.subagentsOf(s.id));
      for (const v of this.subViews.values()) v.update(this.subagentsOf(v.sessionId));
      // a chat started here is now written to disk: the bridge's entry replaces the local one
      for (const id of [...this.localConvs.keys()]) if (next.has(id)) this.localConvs.delete(id);
      const first = !this.sessionsLoaded;
      this.sessionsLoaded = true;
      this.changed('conversations');
      for (const s of this.sessions.values()) {
        if (first) s.onSessionsLoaded();
        // a chat shown before it was on the list (a fork, a restored tab) loads its history once it is
        else if (s.listeners.size && !s.historyLoaded && !s.isLoading && s.transcript.isEmpty && this.isOnDisk(s.id)) void s.loadAndAttach();
        s.scheduleEmit();
      }
    } catch (e) {
      this.log(`[claude] sessions: ${e instanceof Error ? e.message : String(e)}`);
      if (!this.sessionsLoaded) {
        // keep chats waiting for the list from spinning forever
        this.sessionsLoaded = true;
        for (const s of this.sessions.values()) s.onSessionsLoaded();
      }
    }
  }

  async conversationAction(id: string, action: 'delete' | 'fork' | 'rename' | 'archive' | 'unarchive', value?: string): Promise<string | void> {
    if (parseSubagentId(id)) throw new Error('A subagent is part of its parent chat: change the parent chat instead');
    const check = (r: any) => {
      if (!r?.success) throw new Error(r?.error ?? 'the bridge refused');
    };
    switch (action) {
      case 'delete': {
        this.sessions.get(id)?.close();
        this.sessions.delete(id);
        // also for a chat not on the list yet: the bridge stops its process and removes what it wrote
        check(await this.bridgeSend('DELETE', `/api/claude/sessions/${id}`, undefined, 30_000));
        this.convs.delete(id);
        this.localConvs.delete(id);
        this.titleAsked.delete(id);
        this.changed('conversations');
        return;
      }
      case 'rename': {
        const clean = value?.trim();
        if (!clean) return;
        check(await this.bridgeSend('POST', `/api/claude/sessions/${id}/title`, { title: clean }));
        this.setTitle(id, clean);
        void this.refreshSessions();
        return;
      }
      case 'archive':
      case 'unarchive': {
        const archived = action === 'archive';
        const c = this.convs.get(id);
        if (!c) throw new Error('This chat is not saved yet');
        this.convs.set(id, { ...c, archived });
        this.changed('conversations');
        try {
          check(await this.bridgeSend('POST', `/api/claude/sessions/${id}/archive`, { archived }));
        } catch (e) {
          const cur = this.convs.get(id);
          if (cur) this.convs.set(id, { ...cur, archived: !archived });
          this.changed('conversations');
          throw new Error(`Could not ${action}: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      case 'fork': {
        // copies the chat on the bridge (a chat of its own right away)
        const src = this.conversation(id);
        if (!src) throw new Error('Unknown chat');
        const newId = randomUUID();
        const title = `${src.title} (fork)`;
        check(await this.bridgeSend('POST', `/api/claude/sessions/${id}/fork`, { new_id: newId, title }));
        const now = Date.now();
        this.localConvs.set(newId, { ...src, id: newId, title, createdAt: now, updatedAt: now, isRunning: false, notFullyIdle: false });
        this.changed('conversations');
        void this.refreshSessions();
        return newId;
      }
    }
  }

  // ------------------------------------------------------------------ sessions

  private session(id: string): ClaudeSession {
    let s = this.sessions.get(id);
    if (!s) {
      s = new ClaudeSession(id, this);
      s.transcript.setSubagents(this.subagentsOf(id));
      this.sessions.set(id, s);
    }
    return s;
  }

  dropSession(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.listeners.size) return;
    s.close();
    this.sessions.delete(id);
  }

  subscribe(conversationId: string, listener: (s: ChatState) => void) {
    if (parseSubagentId(conversationId)) {
      const v = this.subView(conversationId);
      v.addListener(listener);
      return () => v.removeListener(listener);
    }
    const s = this.session(conversationId);
    s.addListener(listener);
    return () => s.removeListener(listener);
  }

  getState(conversationId: string): ChatState {
    if (parseSubagentId(conversationId)) return this.subView(conversationId).state();
    return this.session(conversationId).state();
  }

  async send(req: SendRequest): Promise<void> {
    if (parseSubagentId(req.conversationId)) throw new Error('A subagent takes instructions from its parent chat only');
    const s = this.session(req.conversationId);
    const known = this.conversation(req.conversationId);
    if (!this.isOnDisk(s.id) && !s.prepared && s.transcript.isEmpty && !s.historyLoaded) s.prepareNewChat(this.takeNewChatControls(req.modelId));
    const typed = collapseExpansions(req.text).trim();
    if (!req.attachments.length && (await this.appCommand(s, typed))) return;
    if (!known) {
      const first = (typed || (req.attachments.length ? 'Attachment' : 'Chat')).split('\n').find((l) => l.trim()) ?? 'Chat';
      const uri = req.workspaceUri ? (req.workspaceUri.startsWith('file://') ? req.workspaceUri : `file://${req.workspaceUri}`) : '';
      const now = Date.now();
      this.localConvs.set(req.conversationId, {
        id: req.conversationId,
        title: first.length > 40 ? `${first.slice(0, 40)}...` : first,
        modelId: s.model,
        createdAt: now,
        updatedAt: now,
        // running while its turn is (withLive / the session's state add it)
        isRunning: false,
        notFullyIdle: false,
        hasActivity: true,
        runStatus: 'IDLE',
        stepCount: 0,
        workspaceUri: uri,
        nestingDepth: 0,
        agent: 'CLAUDE',
        archived: false,
      });
      s.localConversation = this.localConvs.get(req.conversationId)!;
      s.isLoading = false;
    }
    s.sendPrompt(req.text, req.attachments);
    this.changed('conversations');
  }

  async stop(conversationId: string) {
    this.sessions.get(conversationId)?.interrupt();
  }

  // ------------------------------------------------------------------ edit / regenerate (ClaudeChatBackend.editMessage / regenerate)

  /** The open, saved chat [conversationId] and the transcript uuid of its prompt [userUuid] (a real prompt, not a local reply). */
  private rewindable(conversationId: string, userUuid: string | null): ClaudeSession {
    const s = this.sessions.get(conversationId);
    if (!s) throw new Error('Open the chat first');
    if (!this.isOnDisk(conversationId)) throw new Error('This chat is not saved yet');
    if (!userUuid || !UUID_RE.test(userUuid)) throw new Error('This message cannot be edited');
    return s;
  }

  /**
   * Edits the prompt [messageId] ("user_<uuid>") in place, like the CLI's rewind: the chat is cut right before that
   * prompt (the next message continues from there); its text goes back to the composer.
   */
  async rewind(conversationId: string, messageId: string, restoreFiles?: boolean): Promise<string | null> {
    const uuid = messageId.replace(/^user_/, '');
    const s = this.rewindable(conversationId, uuid);
    const text = s.transcript.userText(uuid) ?? '';
    // "restore code": the files changed since that prompt go back first (the app's editMessage(restoreCode = true))
    if (restoreFiles) {
      const r = await s.rewindFiles(uuid);
      if (!r) this.notify('warning', 'Claude Code did not answer: the files were not restored');
      else if (r.error || !r.canRewind) this.notify('warning', `The files were not restored: ${r.error ?? 'no checkpoint for that message'}`);
      else
        this.notify(
          'info',
          r.filesChanged.length
            ? `Restored ${r.filesChanged.length} file${r.filesChanged.length === 1 ? '' : 's'} (+${r.insertions} −${r.deletions})`
            : 'No files had changed since that message',
        );
    }
    await s.rewindBefore(uuid);
    this.notify('info', 'Rewound: edit the prompt and send it; the chat continues from before it');
    return text;
  }

  /** Regenerates the reply [messageId]: the chat is cut before its prompt and that prompt (with its files) is sent again. */
  async retryMessage(conversationId: string, messageId: string): Promise<string | void> {
    const s = this.sessions.get(conversationId);
    const uuid = s?.transcript.userBefore(messageId) ?? null;
    const live = this.rewindable(conversationId, uuid);
    const text = live.transcript.userText(uuid!) ?? '';
    const atts = live.transcript.userAttachments(uuid!);
    await live.rewindBefore(uuid!);
    live.sendPrompt(text, atts);
    this.changed('conversations');
    return 'Regenerating the reply';
  }

  async approval(conversationId: string, key: string, choiceId: string | undefined, deny: boolean, feedback?: string) {
    const s = this.sessions.get(conversationId);
    const p = s?.transcript.pendingFor(key);
    if (!s || !p) return;
    if (p.toolName === 'ExitPlanMode') {
      if (deny) {
        s.keepPlanning(key, feedback);
        this.notify('info', 'Claude keeps planning');
      } else {
        const mode = choiceId?.startsWith(PLAN_PREFIX) ? choiceId.slice(PLAN_PREFIX.length) : 'acceptEdits';
        s.approvePlan(key, mode);
        this.notify('info', `Plan approved · ${mode === 'acceptEdits' ? 'edits are accepted automatically' : 'you review each edit'}`);
      }
      return;
    }
    if (deny) {
      s.denyTool(key, feedback);
      return;
    }
    // "Allow" never adds a rule; an "always" choice applies only that one of Claude's suggestions
    const idx = choiceId && choiceId !== ALLOW_ONCE && choiceId.startsWith(SUGGESTION_PREFIX) ? Number(choiceId.slice(SUGGESTION_PREFIX.length)) : -1;
    s.allowTool(key, Number.isInteger(idx) ? idx : -1);
  }

  async answer(conversationId: string, key: string, answers: Record<string, string[]>, note?: string, skip?: boolean) {
    const s = this.sessions.get(conversationId);
    const p = s?.transcript.pendingFor(key);
    if (!s || !p || p.toolName !== 'AskUserQuestion') return;
    if (skip) {
      s.skipQuestion(key);
      return;
    }
    const q = questionnaireFrom(p.input);
    const out: Record<string, string> = {};
    const summary: string[] = [];
    q.questions.forEach((qq, i) => {
      const picked = answers[qq.id] ?? [];
      const labels = picked.map((id) => qq.options.find((o) => o.id === id)?.label ?? id).filter((x) => x.trim());
      if (note?.trim() && i === q.questions.length - 1) labels.push(note.trim());
      const value = labels.join(', ');
      if (value) out[qq.prompt] = value;
      summary.push(`• ${qq.prompt}: ${value || 'Skipped'}`);
    });
    s.answerQuestion(key, out, summary.join('\n\n'));
  }

  async queueAction(conversationId: string, _id: string, action: 'sendNow' | 'delete') {
    // "Send now" interrupts the current reply; the CLI then runs the queued messages. A queued message is already
    // with the CLI and cannot be taken back (canDelete is false).
    if (action === 'sendNow') this.sessions.get(conversationId)?.interrupt();
  }

  dispose() {
    this.disposed = true;
    this.settings.dispose();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.usageAfterTurnTimer) clearTimeout(this.usageAfterTurnTimer);
    for (const ts of this.titleTimers.values()) for (const t of ts) clearTimeout(t);
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
    for (const v of this.subViews.values()) v.close();
    this.subViews.clear();
  }
}
