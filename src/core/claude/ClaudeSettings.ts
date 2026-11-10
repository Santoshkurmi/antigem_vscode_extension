// Claude Code's settings pages (ports of the app's ClaudeSettingsScreen.kt pages, ClaudeConfigManager.kt and the
// account part of ClaudeAccountManager.kt): Account & CLI (install / update, sign-in, plan usage), chat defaults,
// permission rules, MCP servers, plugins, memory, custom providers, and settings.json itself. Everything goes through
// the bridge, with timeouts: a page Claude Code can't serve (not installed, bridge down) says so at once.
// Every settings.json write re-reads the file first and changes only its own keys.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ModelGroupView, QuotaWindowView, SettingFormField, SettingItem, SettingsPage, SettingsSection } from '../../../shared/protocol';
import type { AgentSettingsProvider } from '../types';
import { countdownText } from '../agy/quota';
import {
  Cached,
  MCP_EDIT,
  MCP_LIST,
  MCP_PRESETS,
  MCP_RECONNECT,
  MCP_REFRESH_ALL,
  MCP_REMOVE,
  blockedReason,
  joinCommand,
  mcpForm,
  mcpFormValues,
  mcpPage,
  remainingText,
  presetHeaders,
  presetTap,
  presetsItem,
  unavailablePage,
  waitFor,
  withTimeout,
  type McpServerView,
  type McpState,
} from '../agy/settingsKit';
import type { ClaudeBackend } from './ClaudeBackend';
import { scopedLimits } from './quota';
import { ClaudeProviders } from './ClaudeProviders';
import { PERMISSION_MODES, effortLabel, num, permissionModeDescription, planLabel, str } from './protocol';

const AGENT = 'CLAUDE' as const;
const SLOW = 90_000;
/** A settings page waits this long for Claude Code's status while it is checked, then says why it can't load. */
const WAIT_MS = 3_000;
/** A slow list (MCP status, plugins) is waited for this long; then the page shows what it has and updates later. */
const PAGE_WAIT_MS = 8_000;
/** A quick bridge read (settings.json, memory, the CLI job). */
const READ_MS = 6_000;

const TITLES: Record<string, string> = {
  'claude.defaults': 'Chat defaults',
  'claude.providers': 'Custom providers',
  'claude.permissions': 'Permission rules',
  'claude.mcp': 'MCP servers',
  'claude.plugins': 'Plugins',
  'claude.memory': 'Memory',
  'claude.advanced': 'Advanced',
};

const PAGES: { id: string; label: string; description: string; icon: string }[] = [
  { id: 'claude.defaults', label: 'Chat defaults', description: 'Model, effort, thinking, permission mode, output style', icon: 'tune' },
  { id: 'claude.providers', label: 'Custom providers', description: 'OpenRouter, Kimi and other Anthropic-compatible APIs', icon: 'cloud' },
  { id: 'claude.permissions', label: 'Permission rules', description: 'What Claude may do without asking', icon: 'security' },
  { id: 'claude.mcp', label: 'MCP servers', description: 'Tools Claude can call', icon: 'hub' },
  { id: 'claude.plugins', label: 'Plugins', description: 'Installed plugins, catalog and marketplaces', icon: 'extension' },
  { id: 'claude.memory', label: 'Memory', description: 'Instructions (CLAUDE.md) and the notes Claude saved', icon: 'description' },
];

const RULE_KINDS: { value: 'allow' | 'ask' | 'deny'; title: string }[] = [
  { value: 'allow', title: 'Allowed without asking' },
  { value: 'ask', title: 'Always ask' },
  { value: 'deny', title: 'Never allowed' },
];

const PLUGIN_DONE: Record<string, string> = {
  install: 'Installed',
  uninstall: 'Uninstalled',
  enable: 'Enabled',
  disable: 'Disabled',
  update: 'Updated',
  'marketplace-add': 'Added marketplace',
  'marketplace-remove': 'Removed marketplace',
  'marketplace-update': 'Updated marketplace',
};

const lastLine = (s: unknown) =>
  String(s ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();

interface Login {
  login_id: string;
  method: string;
  state: string;
  error?: string | null;
  manual_url?: string;
  automatic_url?: string;
}

export class ClaudeSettings implements AgentSettingsProvider {
  private mcpList: Cached<any[]>;
  private pluginList: Cached<any>;
  private memory: Record<'user' | 'project', any> = { user: null, project: null };
  private autoMemory: any | null = null;
  private sandbox: any | null = null;
  private cliJob: any | null = null;
  private login: Login | null = null;
  private loginPoll: NodeJS.Timeout | null = null;
  private jobPoll: NodeJS.Timeout | null = null;
  private busy = new Map<string, string>();
  private providers: ClaudeProviders;
  /** The plugin catalog search ("Discover"). */
  private pluginQuery = '';
  /** The CLI changes one shared plugin config: actions run one after another (the app's pluginMutex). */
  private pluginChain: Promise<unknown> = Promise.resolve();

  constructor(private b: ClaudeBackend) {
    this.providers = new ClaudeProviders(b, () => this.changed());
    this.mcpList = new Cached(() => this.fetchMcp(), () => this.changed());
    this.pluginList = new Cached(() => this.fetchPlugins(), () => this.changed());
  }

  private changed() {
    this.b.changed('settings');
  }

  private err(e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }

  private statusTriedAt = 0;

  /** Reads Claude Code's status when it is not known yet — not again and again while that fails (each read
   *  rebuilds the open pages). */
  private ensureStatus(): Promise<void> | null {
    if (this.b.cli || Date.now() - this.statusTriedAt < 10_000) return null;
    this.statusTriedAt = Date.now();
    return this.b.loadStatus();
  }

  /** A quick bridge read (settings.json, memory, the CLI job): fails after a few seconds instead of hanging. */
  private read<T = any>(p: string): Promise<T> {
    return this.b.bridgeJson<T>(p, {}, READ_MS);
  }

  // ------------------------------------------------------------------ root

  /** "you@mail.com · Max" / "Not signed in" / why Claude Code can't be used. */
  private accountSummary(): string {
    const st = this.b.status();
    const a = this.b.cli?.auth;
    if (this.login) return 'Signing in…';
    if (st.state === 'starting') return 'Checking…';
    if (st.state === 'not_installed') return 'Claude Code is not installed';
    if (a?.loggedIn) return [a.email, a.subscriptionType ? planLabel(a.subscriptionType) : null].filter(Boolean).join(' · ') || 'Signed in';
    if (this.b.cli?.installed) return 'Not signed in';
    return st.detail ?? 'Not available';
  }

  /** The "Claude Code" row on the agents page (opens the claude page). */
  rootItem(): SettingItem {
    const v = this.b.status().version;
    return { kind: 'page', id: 'claude', label: 'Claude Code', icon: 'smart_toy', description: this.accountSummary(), badge: v ?? null };
  }

  private section(id: string, items: SettingItem[], title = '', description: string | null = null): SettingsSection {
    return { id, title, agent: AGENT, description, items };
  }

  /** Claude Code's own page: links only, as the app's ClaudeSettingsGroup (Account & CLI / settings / Advanced). */
  private mainPage(): SettingsPage {
    const st = this.b.status();
    const a = this.b.cli?.auth;
    const accountBadge = this.login
      ? 'Signing in…'
      : st.state === 'not_installed'
        ? 'Not installed'
        : a?.loggedIn
          ? a.subscriptionType
            ? planLabel(a.subscriptionType)
            : 'Signed in'
          : this.b.cli?.installed
            ? 'Signed out'
            : st.state === 'starting'
              ? 'Checking…'
              : null;
    return {
      id: 'claude',
      title: 'Claude Code',
      sections: [
        this.section('cli', [
          {
            kind: 'page',
            id: 'claude.cli',
            label: 'Account & CLI',
            icon: 'account',
            description: [this.accountSummary(), st.version ? `CLI ${st.version}` : null].filter(Boolean).join(' · '),
            badge: accountBadge,
          },
        ]),
        this.section(
          'pages',
          PAGES.map((p) => ({ kind: 'page' as const, id: p.id, label: p.label, description: p.description, icon: p.icon, badge: this.badge(p.id) })),
        ),
        this.section('more', [{ kind: 'page', id: 'claude.advanced', label: 'Advanced', description: 'Edit ~/.claude/settings.json directly', icon: 'code' }]),
      ],
    };
  }

  private badge(page: string): string | null {
    const s = this.b.claudeSettings?.settings;
    switch (page) {
      case 'claude.providers':
        return this.b.providers.length ? `${this.b.providers.length} added` : null;
      case 'claude.permissions': {
        const n = Array.isArray(s?.permissions?.allow) ? s!.permissions.allow.length : 0;
        return n ? `${n} allowed` : null;
      }
      case 'claude.mcp':
        return this.mcpList.value?.length ? `${this.mcpList.value.length} servers` : null;
      default:
        return null;
    }
  }

  /** Plan usage (the app's Account page card): what is left of the 5-hour, weekly, and a model's own weekly limit. */
  private usageItems(): SettingItem[] {
    const u = this.b.usage;
    const rl = u?.rate_limits;
    const updated = this.b.refreshingUsage ? 'Updating…' : this.b.usageUpdatedAt ? `Updated ${new Date(this.b.usageUpdatedAt).toLocaleTimeString()}` : null;
    const items: SettingItem[] = [];
    if (u && rl && u.rate_limits_available !== false) {
      const win = (label: string, used: number, iso: unknown): QuotaWindowView => {
        const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
        const remaining = Math.max(0, Math.min(1, 1 - used));
        return { label, remaining, resetText: countdownText(Number.isFinite(t) ? t : null), text: remainingText(remaining, false) };
      };
      const windows: QuotaWindowView[] = [];
      if (rl.five_hour) windows.push(win('5h', num(rl.five_hour.utilization) / 100, rl.five_hour.resets_at));
      if (rl.seven_day) windows.push(win('7d', num(rl.seven_day.utilization) / 100, rl.seven_day.resets_at));
      const groups: ModelGroupView[] = [{ name: 'All models', windows }];
      for (const s of scopedLimits(rl)) groups.push({ name: s.name, windows: [win('7d', s.used, s.resetsAt)] });
      items.push({ kind: 'quota', id: 'claude.quota', label: 'Plan usage', groups });
    } else if (u) {
      items.push({ kind: 'info', id: 'claude.quota', label: 'Plan usage', value: 'Not available', tone: 'muted', description: 'Plan limits do not apply to this account (API billing has no 5-hour / weekly limits).' });
    }
    if (this.b.usageError) items.push({ kind: 'info', id: 'claude.usageError', label: 'Could not update', value: this.b.usageError, tone: 'error' });
    items.push({ kind: 'button', id: 'claude.usage.refresh', label: 'Refresh usage', description: updated, disabled: this.b.refreshingUsage });
    return items;
  }

  // ------------------------------------------------------------------ pages

  /** Why Claude Code's pages can't be read now (null = they can): not installed, bridge down… Signed out is fine:
   *  settings.json, memory, MCP servers and plugins work without an account. Waits a little while it is checked. */
  private async blocked(): Promise<string | null> {
    if (this.b.status().state === 'starting') {
      void this.ensureStatus();
      await waitFor(() => this.b.status().state !== 'starting', WAIT_MS);
    }
    const st = this.b.status();
    if (st.state === 'online' || (st.state === 'error' && this.b.cli?.installed)) return null;
    return blockedReason(st);
  }

  async page(id: string): Promise<SettingsPage | null> {
    if (id === 'claude') {
      void this.ensureStatus();
      return this.mainPage();
    }
    if (id === 'claude.cli') {
      // works with Claude Code missing too: it is where it is installed
      const status = this.ensureStatus();
      await Promise.allSettled([this.loadCliJob(), status ? withTimeout(status, WAIT_MS, 'Claude Code') : null]);
      return this.cliPage();
    }
    if (!(id in TITLES)) return null;
    const why = await this.blocked();
    if (why) return unavailablePage(id, TITLES[id], AGENT, why, { page: 'claude.cli', label: 'Account & CLI', description: 'Install Claude Code, or see why it can’t be used' });
    switch (id) {
      case 'claude.defaults':
        await Promise.all([this.b.loadChatDefaults(), this.b.cliInfo() ? Promise.resolve() : withTimeout(this.b.loadInfo(false), PAGE_WAIT_MS, 'Claude Code').catch(() => undefined)]);
        return this.defaultsPage();
      case 'claude.permissions':
        await Promise.all([this.b.loadChatDefaults(), this.loadSandbox()]);
        return this.permissionsPage();
      case 'claude.mcp': {
        const done = await this.mcpList.ensure(PAGE_WAIT_MS);
        return this.mcpPage(!done);
      }
      case 'claude.plugins': {
        const done = await this.pluginList.ensure(PAGE_WAIT_MS);
        return { ...this.pluginsPage(), loading: !done || undefined };
      }
      case 'claude.memory':
        await this.loadMemory();
        return this.memoryPage();
      case 'claude.providers':
        await this.b.loadProviders();
        return this.providers.page();
      case 'claude.advanced':
        await this.b.loadChatDefaults();
        return this.advancedPage();
      default:
        return null;
    }
  }

  // --- Chat defaults (settings.json: model, effortLevel, alwaysThinkingEnabled, permissions.defaultMode, outputStyle)

  private defaultsPage(): SettingsPage {
    const s = this.b.claudeSettings?.settings ?? {};
    const info = this.b.cliInfo();
    const models = info?.models ?? [];
    const model = str(s.model) || 'default';
    const levels = (models.find((m) => m.value === model) ?? models[0])?.supportedEffortLevels ?? [];
    const effort = str(s.effortLevel) || null;
    const mode = str(s.permissions?.defaultMode) && s.permissions.defaultMode !== 'bypassPermissions' ? s.permissions.defaultMode : 'auto';
    const modelOptions = models.length ? models.map((m) => ({ value: m.value, label: m.displayName || m.value, description: m.description })) : [{ value: 'default', label: 'Default' }];
    if (!modelOptions.some((o) => o.value === model)) modelOptions.push({ value: model, label: model, description: '' });
    const items: SettingItem[] = [{ kind: 'select', id: 'model', label: 'Default model', value: model, options: modelOptions }];
    if (levels.length)
      items.push({
        kind: 'select',
        id: 'effort',
        label: 'Default effort',
        value: effort ?? 'default',
        options: [null, ...levels].map((l) => ({ value: l ?? 'default', label: effortLabel(l) })),
      });
    items.push({ kind: 'toggle', id: 'thinking', label: 'Thinking', description: 'Reason before answering', value: typeof s.alwaysThinkingEnabled === 'boolean' ? s.alwaysThinkingEnabled : true });
    const sections: SettingsSection[] = [
      this.section('defaults', items, '', 'These apply to new Claude chats (saved in ~/.claude/settings.json, shared with the terminal CLI).'),
      this.section('mode', [
        {
          kind: 'select',
          id: 'mode',
          label: 'Default permission mode',
          value: mode,
          options: PERMISSION_MODES.map(([value, label]) => ({ value, label, description: permissionModeDescription(value) })),
        },
      ]),
    ];
    const styles = info?.available_output_styles ?? [];
    if (styles.length) {
      const style = str(s.outputStyle) || 'default';
      sections.push(
        this.section('style', [
          {
            kind: 'select',
            id: 'outputStyle',
            label: 'Output style',
            description: 'How Claude writes its replies',
            value: styles.find((x) => x.toLowerCase() === style.toLowerCase()) ?? style,
            options: styles.map((x) => ({ value: x, label: x })),
          },
        ]),
      );
    }
    return { id: 'claude.defaults', title: 'Chat defaults', sections };
  }

  // --- Permission rules (settings.json permissions.allow / ask / deny) + command sandbox

  private async loadSandbox() {
    try {
      this.sandbox = await this.b.bridgeJson('/api/claude/sandbox', {}, PAGE_WAIT_MS);
    } catch (e) {
      this.sandbox = { available: false, enabled: false, reason: `Could not check: ${this.err(e)}` };
    }
  }

  private rules(kind: string): string[] {
    const p = this.b.claudeSettings?.settings?.permissions;
    return Array.isArray(p?.[kind]) ? p[kind].filter((r: unknown) => typeof r === 'string') : [];
  }

  private permissionsPage(): SettingsPage {
    const sb = this.sandbox;
    const sections: SettingsSection[] = [
      this.section('sandbox', [
        {
          kind: 'toggle',
          id: 'sandbox',
          label: 'Sandbox commands',
          description: !sb
            ? 'Checking whether the sandbox can run here…'
            : sb.available
              ? 'Run Claude’s shell commands in an isolated container (no network, limited files). Commands that stay inside it run without asking.'
              : `Not available here: ${sb.reason ?? 'unknown reason'}. Auto mode already asks rarely.`,
          value: sb?.enabled === true,
          disabled: sb?.available !== true,
        },
      ]),
    ];
    for (const k of RULE_KINDS) {
      const rules = this.rules(k.value);
      sections.push(
        this.section(
          `rules.${k.value}`,
          [
            {
              kind: 'list',
              id: `rules.${k.value}`,
              label: `${k.title} (${rules.length})`,
              emptyText: 'No rules',
              rows: rules.map((r) => ({
                id: r,
                title: r,
                actions: [
                  ...RULE_KINDS.filter((x) => x.value !== k.value).map((x) => ({ id: x.value, label: `Move to “${x.title}”` })),
                  { id: 'remove', label: 'Remove', danger: true },
                ],
              })),
              ...(k.value === 'allow'
                ? {
                    addLabel: 'Add rule',
                    addForm: [
                      { id: 'rule', label: 'Rule', kind: 'text', placeholder: 'Bash(npm run test *)', required: true },
                      {
                        id: 'behavior',
                        label: 'Decision',
                        kind: 'select',
                        value: 'allow',
                        options: RULE_KINDS.map((x) => ({ value: x.value, label: x.value.charAt(0).toUpperCase() + x.value.slice(1) })),
                      },
                    ] as SettingFormField[],
                  }
                : {}),
            },
          ],
          '',
          k.value === 'allow'
            ? 'Rules use the CLI syntax: Bash(npm test), Bash(git log *), Read(./src/**), Edit(docs/**), WebFetch(domain:github.com), mcp__server__tool. Deny wins over ask, ask wins over allow.'
            : null,
        ),
      );
    }
    return { id: 'claude.permissions', title: 'Permission rules', sections };
  }

  // --- MCP servers (`claude mcp` through the bridge)

  private async fetchMcp(): Promise<any[]> {
    const cwd = this.b.workspaceDir();
    const r = await this.b.bridgeJson(`/api/claude/mcp${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`, {}, SLOW);
    if (!r?.success) throw new Error(r?.error ?? 'MCP status failed');
    return Array.isArray(r.servers) ? r.servers : [];
  }

  /** The add / edit form: the common one, with where the server is available (Claude's scopes). */
  private mcpFormFor(srv?: any): SettingFormField[] {
    const cfg = srv?.config ?? {};
    const transport = str(cfg.type) || (cfg.url ? 'http' : 'stdio');
    return mcpForm({
      name: srv?.name ?? '',
      nameLocked: !!srv,
      type: srv ? transport : 'stdio',
      remoteTypes: [
        { value: 'http', label: 'Remote URL (HTTP)', description: 'A URL and optional headers' },
        { value: 'sse', label: 'Remote URL (SSE)', description: 'An older server-sent events URL' },
      ],
      command: cfg.command ? joinCommand([str(cfg.command), ...(Array.isArray(cfg.args) ? cfg.args.map(String) : [])]) : '',
      env: cfg.env,
      url: str(cfg.url),
      headers: cfg.headers,
      extra: [
        {
          id: 'scope',
          label: 'Available in',
          kind: 'select',
          value: ['user', 'local', 'project'].includes(srv?.scope) ? srv.scope : 'user',
          options: [
            { value: 'user', label: 'All projects' },
            { value: 'local', label: 'This project (me)' },
            { value: 'project', label: 'This project (.mcp.json)' },
          ],
        },
      ],
    });
  }

  private mcpViews(): McpServerView[] {
    const scopeLabel = (s: string) => (s === 'user' ? 'all projects' : s === 'local' ? 'this project (you)' : s === 'project' ? 'this project (.mcp.json)' : s);
    const views: McpServerView[] = (this.mcpList.value ?? []).map((srv: any) => {
      const cfg = srv.config ?? {};
      const transport = str(cfg.type) || (cfg.url ? 'http' : 'stdio');
      const target = str(cfg.url) || [str(cfg.command), ...(Array.isArray(cfg.args) ? cfg.args.map(String) : [])].filter(Boolean).join(' ');
      const own = ['user', 'project', 'local'].includes(srv.scope);
      const state: McpState =
        srv.status === 'connected'
          ? 'connected'
          : srv.status === 'failed'
            ? 'error'
            : srv.status === 'pending'
              ? 'connecting'
              : srv.status === 'needs-auth'
                ? 'auth'
                : srv.status === 'disabled'
                  ? 'off'
                  : 'idle';
      return {
        name: srv.name,
        state,
        where: transport === 'stdio' ? target || null : `${transport.toUpperCase()} ${target}`,
        origin: srv.scope || srv.source ? scopeLabel(srv.scope || srv.source) : null,
        error: srv.error || null,
        tools: Array.isArray(srv.tools) ? srv.tools.length : null,
        toolNames: (srv.tools ?? []).map((t: any) => str(t.name)).filter(Boolean),
        // Claude Code switches servers per chat (/mcp): there is no saved on/off to set from here
        enabled: null,
        reconnect: true,
        editForm: own ? this.mcpFormFor(srv) : null,
        removable: own,
        busy: this.busy.get(`mcp:${srv.name}`) ?? null,
      };
    });
    for (const [k, v] of this.busy) if (k.startsWith('mcp:') && !views.some((r) => r.name === k.slice(4))) views.unshift({ name: k.slice(4), state: 'connecting', busy: v });
    return views;
  }

  private mcpPage(loading = false): SettingsPage {
    const names = (this.mcpList.value ?? []).map((x: any) => ({ name: String(x.name), url: x.url ?? x.config?.url ?? null }));
    return mcpPage({
      id: 'claude.mcp',
      agent: AGENT,
      description: `Tools Claude can call. Includes the servers of the project ${this.b.workspaceDir()}.`,
      servers: this.mcpViews(),
      error: this.mcpList.error,
      addForm: this.mcpFormFor(),
      loading,
      presets: [presetsItem(names, this.mcpFormFor())],
    });
  }

  /** The bridge's add body from the form's values (or a server's saved config). */
  private mcpBody(name: string, scope: string, f: { remote: boolean; type: string; command: string[]; env: Record<string, string>; url: string; headers: Record<string, string> }) {
    return {
      name,
      scope: scope || 'user',
      transport: f.remote ? f.type : 'stdio',
      command: f.remote ? '' : f.command[0],
      args: f.remote ? [] : f.command.slice(1),
      env: f.remote ? {} : f.env,
      url: f.remote ? f.url : '',
      headers: f.remote ? f.headers : {},
      cwd: this.b.workspaceDir(),
    };
  }

  private async postMcp(body: ReturnType<ClaudeSettings['mcpBody']>) {
    const r = await this.b.bridgeSend('POST', '/api/claude/mcp', body, SLOW);
    if (!r?.success) throw new Error(`Could not add '${body.name}': ${lastLine(r?.error) ?? 'Add failed'}`);
  }

  private async deleteMcp(name: string, scope?: string) {
    const cwd = this.b.workspaceDir();
    const q = `name=${encodeURIComponent(name)}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`;
    const r = await this.b.bridgeSend('DELETE', `/api/claude/mcp?${q}`, undefined, SLOW);
    if (!r?.success) throw new Error(r?.error ?? 'Remove failed');
  }

  /** Runs an MCP change with the row marked busy, then reads the list again. */
  private async mcpChange<T>(name: string, label: string, run: () => Promise<T>): Promise<T> {
    this.busy.set(`mcp:${name}`, label);
    this.changed();
    try {
      return await run();
    } finally {
      this.busy.delete(`mcp:${name}`);
      await this.mcpList.reload(PAGE_WAIT_MS);
      this.changed();
    }
  }

  private async mcpAction(id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void> {
    if (id === MCP_REFRESH_ALL || (id === MCP_LIST && actionId === MCP_RECONNECT)) {
      // Claude Code connects every server for each check: reading the status again reconnects them
      const done = await this.mcpList.reload(PAGE_WAIT_MS);
      this.changed();
      if (this.mcpList.error) throw new Error(`MCP status failed: ${this.mcpList.error}`);
      if (!done) return 'Still checking the servers…';
      if (rowId) {
        const s = (this.mcpList.value ?? []).find((x: any) => x.name === rowId);
        if (s?.status === 'failed') throw new Error(`${rowId}: ${s.error ?? 'failed to connect'}`);
        return s?.status === 'connected' ? `${rowId} connected · ${(s.tools ?? []).length} tools` : `${rowId}: ${s?.status ?? 'not found'}`;
      }
      return `${(this.mcpList.value ?? []).length} servers checked`;
    }
    if (id === MCP_PRESETS && actionId) return this.addPreset(actionId, values);
    if (id === MCP_LIST && actionId === 'add' && values) return this.addMcp(values);
    if (id !== MCP_LIST || !rowId) return;
    const srv = (this.mcpList.value ?? []).find((s: any) => s.name === rowId);
    if (actionId === MCP_REMOVE) {
      await this.mcpChange(rowId, 'Removing…', () => this.deleteMcp(rowId, srv?.scope));
      return `Removed '${rowId}'`;
    }
    if (actionId === MCP_EDIT && values) {
      if (!srv) throw new Error(`${rowId} is not in the list any more: reopen the page`);
      const next = this.mcpBody(rowId, values.scope || srv.scope, mcpFormValues(values));
      // `claude mcp` has no edit: remove, then add the new one (the old one comes back if that fails)
      const cfg = srv.config ?? {};
      const oldType = str(cfg.type) || (cfg.url ? 'http' : 'stdio');
      const old = this.mcpBody(rowId, srv.scope, {
        remote: oldType !== 'stdio',
        type: oldType,
        command: [str(cfg.command), ...(Array.isArray(cfg.args) ? cfg.args.map(String) : [])].filter(Boolean),
        env: cfg.env ?? {},
        url: str(cfg.url),
        headers: cfg.headers ?? {},
      });
      await this.mcpChange(rowId, 'Saving…', async () => {
        await this.deleteMcp(rowId, srv.scope);
        try {
          await this.postMcp(next);
        } catch (e) {
          await this.postMcp(old).catch(() => undefined);
          throw e;
        }
      });
      return `Saved '${rowId}'`;
    }
  }

  // --- Plugins & marketplaces

  private async fetchPlugins(): Promise<any> {
    try {
      return await this.b.bridgeJson('/api/claude/plugins', {}, SLOW);
    } catch (e) {
      return { success: false, error: this.err(e) };
    }
  }

  private get plugins(): any | null {
    return this.pluginList.value;
  }

  private pluginsPage(): SettingsPage {
    const d = this.plugins ?? {};
    const installed: any[] = Array.isArray(d.plugins?.installed) ? d.plugins.installed : [];
    const available: any[] = Array.isArray(d.plugins?.available) ? d.plugins.available : [];
    const markets: any[] = Array.isArray(d.marketplaces) ? d.marketplaces : [];
    const key = (p: any) => str(p.pluginId) || str(p.id) || str(p.name);
    const installedIds = new Set(installed.map(key));
    const sections: SettingsSection[] = [];
    if (d.success === false) sections.push(this.section('error', [{ kind: 'info', id: 'error', label: 'Plugin list failed', value: str(d.error), tone: 'error' }]));
    sections.push(
      this.section('installed', [
        {
          kind: 'list',
          id: 'installed',
          label: `Installed (${installed.length})`,
          emptyText: 'No plugins installed.',
          rows: installed.map((p) => {
            const k = key(p);
            const busy = this.busy.get(`plugin:${k}`);
            return {
              id: k,
              title: str(p.name) || k,
              subtitle: [p.version ? `v${p.version}` : null, p.scope || null, k.includes('@') ? k.split('@')[1] : null, str(p.description) || null].filter(Boolean).join(' · ') || null,
              status: busy ?? null,
              statusTone: busy ? 'warn' : null,
              toggle: typeof p.enabled === 'boolean' && !busy ? p.enabled : null,
              actions: busy
                ? []
                : [
                    { id: 'update', label: 'Update' },
                    { id: 'uninstall', label: 'Uninstall', danger: true, confirm: `Uninstall ${str(p.name) || k}?` },
                  ],
            };
          }),
        },
      ]),
      this.section('discover', this.discoverItems(available, installedIds, key)),
      this.section('marketplaces', [
        {
          kind: 'list',
          id: 'marketplaces',
          label: `Marketplaces (${markets.length})`,
          description: 'A marketplace is a catalog of plugins (a git repo with a marketplace.json).',
          emptyText: 'No marketplaces',
          rows: markets.map((m) => {
            const busy = this.busy.get(`plugin:${m.name}`);
            return {
              id: str(m.name),
              title: str(m.name),
              subtitle: str(m.repo) || str(m.url) || str(m.source) || null,
              status: busy ?? null,
              statusTone: busy ? 'warn' : null,
              actions: busy
                ? []
                : [
                    { id: 'marketplace-update', label: 'Refresh catalog' },
                    { id: 'marketplace-remove', label: 'Remove', danger: true, confirm: `Remove the marketplace ${m.name}?` },
                  ],
            };
          }),
          addLabel: 'Add marketplace',
          addForm: [{ id: 'source', label: 'GitHub owner/repo, a git URL, or a URL to marketplace.json', kind: 'text', placeholder: 'owner/repo', required: true }],
        },
      ]),
    );
    return { id: 'claude.plugins', title: 'Plugins', sections };
  }

  /** Discover: search the catalog (thousands of plugins), install from the results or by name. */
  private discoverItems(available: any[], installedIds: Set<string>, key: (p: any) => string): SettingItem[] {
    const q = this.pluginQuery.trim().toLowerCase();
    const items: SettingItem[] = [
      {
        kind: 'button',
        id: 'search',
        label: q ? `Search again (now: “${this.pluginQuery}”)` : `Search ${available.length} plugins`,
        form: [{ id: 'query', label: 'Search', kind: 'text', value: this.pluginQuery, placeholder: 'name, description or category', required: true }],
      },
    ];
    if (q) {
      const hits = available.filter((p) => `${str(p.name)}\n${str(p.description)}\n${str(p.category)}`.toLowerCase().includes(q));
      items.push({
        kind: 'list',
        id: 'available',
        label: `${hits.length} plugin(s)${hits.length > 100 ? ' (first 100)' : ''}`,
        emptyText: 'No plugin matches',
        rows: hits.slice(0, 100).map((p) => {
          const k = key(p);
          const busy = this.busy.get(`plugin:${k}`);
          return {
            id: k,
            title: str(p.name) || k,
            subtitle: [str(p.category) || null, k.includes('@') ? k.split('@')[1] : null, str(p.description) || null].filter(Boolean).join(' · ') || null,
            status: busy ?? (installedIds.has(k) ? 'Installed' : null),
            statusTone: busy ? 'warn' : installedIds.has(k) ? 'ok' : null,
            actions: busy || installedIds.has(k) ? [] : [{ id: 'install', label: 'Install' }],
          };
        }),
      });
      items.push({ kind: 'button', id: 'clearSearch', label: 'Clear the search' });
    }
    items.push({
      kind: 'button',
      id: 'install',
      label: 'Install by name',
      form: [{ id: 'plugin', label: 'Plugin (name@marketplace)', kind: 'text', placeholder: 'commit-commands@claude-plugins-official', required: true }],
    });
    return items;
  }

  /** Runs one plugin action; the CLI changes one shared config, so actions run one after another (pluginMutex). */
  private pluginAction(action: string, body: Record<string, string | undefined>): Promise<string> {
    const k = body.plugin || body.name || body.source || action;
    if (this.busy.has(`plugin:${k}`)) return Promise.resolve('Already working on it');
    this.busy.set(`plugin:${k}`, action === 'install' ? 'Installing…' : action.includes('remove') || action === 'uninstall' ? 'Removing…' : 'Working…');
    this.changed();
    const run = this.pluginChain.then(() => this.runPluginAction(action, body, k));
    this.pluginChain = run.catch(() => undefined);
    return run;
  }

  private async runPluginAction(action: string, body: Record<string, string | undefined>, k: string): Promise<string> {
    try {
      const r = await this.b.bridgeSend('POST', `/api/claude/plugins/${action}`, body, 300_000);
      const label = k.split('@')[0];
      if (!r?.success) throw new Error(`${label}: ${lastLine(r?.error) ?? `${action} failed`}`);
      return `${PLUGIN_DONE[action] ?? 'Done:'} ${label}`;
    } finally {
      this.busy.delete(`plugin:${k}`);
      await this.pluginList.reload(PAGE_WAIT_MS);
      this.changed();
    }
  }

  // --- Memory (CLAUDE.md for every project and for the bridge's project, and Claude's own notes)

  private async loadMemory() {
    const cwd = this.b.workspaceDir();
    const q = cwd ? `&cwd=${encodeURIComponent(cwd)}` : '';
    const [user, project, auto] = await Promise.all([
      this.read('/api/claude/memory?scope=user').catch((e) => ({ success: false, error: this.err(e) })),
      this.read(`/api/claude/memory?scope=project${q}`).catch((e) => ({ success: false, error: this.err(e) })),
      this.read(`/api/claude/memory/auto${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`).catch((e) => ({ success: false, error: this.err(e) })),
    ]);
    this.memory = { user, project };
    this.autoMemory = auto;
  }

  private memoryPage(): SettingsPage {
    const projectName = this.b.workspaceDir().replace(/\/+$/, '').split('/').pop() || 'Default workspace';
    const mem = (scope: 'user' | 'project', label: string): SettingItem => {
      const m = this.memory[scope] ?? {};
      return {
        kind: 'text',
        id: `memory.${scope}`,
        label,
        description: m.success === false ? `Could not read: ${m.error}` : `${m.path ?? ''}${m.exists ? '' : ' (created when you save)'}`,
        value: str(m.content),
        placeholder: '# Instructions Claude follows in every chat\n- Run the tests before committing',
        multiline: true,
        disabled: m.success === false,
      };
    };
    const a = this.autoMemory ?? {};
    const files: any[] = Array.isArray(a.files) ? a.files : [];
    return {
      id: 'claude.memory',
      title: 'Memory',
      sections: [
        this.section(
          'instructions',
          [mem('user', 'All projects'), mem('project', projectName)],
          '',
          'Instructions (CLAUDE.md): rules Claude follows in every chat. New chats read them right away; a running chat reads them the next time its Claude process starts.',
        ),
        this.section(
          'auto',
          [
            {
              kind: 'list',
              id: 'notes',
              label: `Claude's memory · ${projectName}`,
              description: a.success === false ? `Could not read: ${a.error}` : (a.dir ?? null),
              emptyText: 'No notes yet. Ask Claude to remember something and it saves it here.',
              rows: files.map((f) => ({
                id: str(f.name),
                title: str(f.name),
                subtitle: `${f.modified ? new Date(num(f.modified)).toLocaleString() : ''}${f.content ? ` · ${String(f.content).split('\n').find((l: string) => l.trim()) ?? ''}` : ''}`.slice(0, 200) || null,
                actions: [{ id: 'delete', label: 'Delete', danger: true, confirm: `Delete ${f.name}? Claude forgets what this note says.` }],
              })),
            },
          ],
          '',
          'Notes Claude saved by itself while working in this project.',
        ),
        ...(files.length
          ? [
              this.section(
                'notes',
                files.map((f) => ({ kind: 'text' as const, id: `note:${str(f.name)}`, label: str(f.name), value: str(f.content), multiline: true, disabled: true })),
              ),
            ]
          : []),
      ],
    };
  }

  // --- CLI install / update

  private async loadCliJob() {
    try {
      const r = await this.read('/api/claude/cli/job');
      this.cliJob = r?.job ?? null;
    } catch {
      /* keep */
    }
    if (this.cliJob?.running && !this.jobPoll) {
      this.jobPoll = setInterval(async () => {
        await this.loadCliJob();
        this.changed();
        if (!this.cliJob?.running && this.jobPoll) {
          clearInterval(this.jobPoll);
          this.jobPoll = null;
          const ok = this.cliJob?.exit_code === 0;
          this.b.notify(ok ? 'info' : 'error', ok ? `Claude Code ${this.cliJob?.kind === 'update' ? 'update' : 'install'} finished` : `Claude Code ${this.cliJob?.kind ?? 'install'} failed`);
          void this.b.loadStatus();
          void this.b.loadInfo(true);
        }
      }, 1500);
    }
  }

  private cliItems(): SettingItem[] {
    const c = this.b.cli;
    const st = this.b.status();
    const job = this.cliJob;
    const running = job?.running === true;
    const items: SettingItem[] = [
      {
        kind: 'info',
        id: 'claude.cli.state',
        label: 'Claude Code CLI',
        value: !c ? (st.state === 'starting' ? 'Checking…' : 'Could not check') : c.installed ? (st.version ?? 'Installed') : 'Not installed',
        tone: !c ? (st.state === 'starting' ? 'muted' : 'error') : c.installed ? 'ok' : 'warn',
        description: !c ? (st.state === 'starting' ? null : (st.detail ?? null)) : (c.bin_path ?? null),
      },
    ];
    if (c)
      items.push(
        c.installed
          ? { kind: 'button', id: 'update', label: running ? 'Checking…' : 'Check for updates', disabled: running }
          : { kind: 'button', id: 'install', label: running ? 'Installing…' : 'Install Claude Code', style: 'primary', disabled: running },
      );
    if (job) {
      items.push({
        kind: 'info',
        id: 'job',
        label: job.kind === 'update' ? 'Update' : 'Install',
        value: running ? 'running…' : job.exit_code === 0 ? 'done' : `failed (exit ${job.exit_code ?? '?'})`,
        tone: running ? 'warn' : job.exit_code === 0 ? 'ok' : 'error',
      });
      if (job.log) items.push({ kind: 'text', id: 'log', label: 'Log', value: String(job.log).split('\n').slice(-30).join('\n'), multiline: true, code: true, rows: 10, disabled: true });
    }
    return items;
  }

  private accountItems(): SettingItem[] {
    const cli = this.b.cli;
    const a = cli?.auth;
    const account: SettingItem[] = [
      {
        kind: 'info',
        id: 'claude.account',
        label: 'Account',
        value: !cli ? '…' : !cli.installed ? 'Install Claude Code first' : a?.loggedIn ? a.email || 'Signed in' : cli.auth_error ? 'Unknown' : 'Not signed in',
        tone: a?.loggedIn ? 'ok' : cli?.installed ? 'warn' : 'muted',
        description: a?.loggedIn
          ? [a.subscriptionType ? `Plan: ${planLabel(a.subscriptionType)}` : null, a.authMethod ? `via ${a.authMethod}` : null].filter(Boolean).join(' · ') || null
          : (cli?.auth_error ?? null),
      },
    ];
    // no sign-in / sign-out button until the account state is known
    if (this.login) {
      account.push({ kind: 'info', id: 'claude.login', label: 'Signing in…', value: this.login.state, tone: 'warn', description: 'Finish in the browser. If it shows a code, paste it here.' });
      account.push({ kind: 'button', id: 'claude.signin.open', label: 'Open the sign-in page again', style: 'primary', disabled: !this.login.automatic_url });
      account.push({ kind: 'button', id: 'claude.signin.manual', label: 'Browser can’t return here? Open the code page', disabled: !this.login.manual_url });
      account.push({ kind: 'button', id: 'claude.signin.code', label: 'Enter the code', form: [{ id: 'code', label: 'Code from the code page', kind: 'text', placeholder: 'code#state', required: true }] });
      account.push({ kind: 'button', id: 'claude.signin.cancel', label: 'Cancel sign-in' });
    } else if (a?.loggedIn) account.push({ kind: 'button', id: 'claude.signout', label: 'Sign out', style: 'danger', confirm: 'Sign out of Claude Code?' });
    else if (cli?.installed)
      account.push({
        kind: 'button',
        id: 'claude.signin',
        label: 'Sign in',
        style: 'primary',
        form: [
          {
            id: 'method',
            label: 'Account',
            kind: 'select',
            value: 'claudeai',
            options: [
              { value: 'claudeai', label: 'Claude subscription', description: 'Pro, Max, Team or Enterprise' },
              { value: 'console', label: 'Anthropic Console', description: 'API billing' },
            ],
          },
        ],
      });
    account.push({ kind: 'button', id: 'claude.refresh', label: 'Check again' });
    return account;
  }

  /** Account & CLI (the app's Account page): the CLI, the account, then what is left of the plan's limits. */
  private cliPage(): SettingsPage {
    const a = this.b.cli?.auth;
    const sections = [this.section('cli', this.cliItems()), this.section('account', this.accountItems())];
    if (a?.loggedIn || this.b.usage) sections.push(this.section('usage', this.usageItems(), '', 'What is left of each limit, and when it resets'));
    return { id: 'claude.cli', title: 'Account & CLI', sections };
  }

  // --- Advanced: settings.json as text

  private advancedPage(): SettingsPage {
    const cs = this.b.claudeSettings;
    return {
      id: 'claude.advanced',
      title: 'Advanced',
      sections: [
        this.section(
          'json',
          [
            {
              kind: 'text',
              id: 'settingsJson',
              label: 'settings.json',
              description: cs?.path ?? null,
              value: JSON.stringify(cs?.settings ?? {}, null, 2),
              multiline: true,
              code: true,
              rows: 24,
            },
            { kind: 'button', id: 'reload', label: 'Reload' },
          ],
          '',
          'Every Claude Code setting lives here: permissions, hooks, env, model, statusLine… Changes apply to new Claude chats.',
        ),
      ],
    };
  }

  // ------------------------------------------------------------------ writes

  /** Reads settings.json fresh, applies [change], writes it back. */
  private async writeSettings(change: (s: Record<string, any>) => void) {
    const r = await this.read('/api/claude/settings');
    if (!r?.success || !r.settings || typeof r.settings !== 'object') throw new Error(r?.error ?? "Couldn't read settings.json, nothing was changed");
    const next = JSON.parse(JSON.stringify(r.settings));
    change(next);
    await this.putSettings(next);
  }

  private async putSettings(next: Record<string, any>) {
    const w = await this.b.bridgeSend('PUT', '/api/claude/settings', { settings: next });
    if (!w?.success) throw new Error(`Save failed: ${w?.error ?? 'the bridge refused'}`);
    await this.b.loadChatDefaults();
    // the mode new chats start in comes with the CLI info
    void this.b.loadInfo(false);
    this.changed();
  }

  private setKey(key: string, value: unknown) {
    return this.writeSettings((s) => {
      if (value == null) delete s[key];
      else s[key] = value;
    });
  }

  private permissions(change: (p: Record<string, any>) => void) {
    return this.writeSettings((s) => {
      const p = s.permissions && typeof s.permissions === 'object' ? s.permissions : {};
      change(p);
      s.permissions = p;
    });
  }

  async change(page: string, id: string, value: unknown, rowId?: string): Promise<void> {
    switch (page) {
      case 'claude.defaults':
        if (id === 'model') return this.setKey('model', value === 'default' ? null : String(value));
        if (id === 'effort') return this.setKey('effortLevel', value === 'default' ? null : String(value));
        if (id === 'thinking') return this.setKey('alwaysThinkingEnabled', value === true);
        if (id === 'outputStyle') return this.setKey('outputStyle', value === 'default' ? null : String(value));
        if (id === 'mode')
          return this.permissions((p) => {
            p.defaultMode = String(value);
          });
        return;
      case 'claude.permissions':
        if (id === 'sandbox') {
          const on = value === true;
          await this.writeSettings((s) => {
            const cur = s.sandbox && typeof s.sandbox === 'object' ? s.sandbox : {};
            cur.enabled = on;
            if (on && !('autoAllowBashIfSandboxed' in cur)) cur.autoAllowBashIfSandboxed = true;
            s.sandbox = cur;
          });
          await this.loadSandbox();
          this.changed();
        }
        return;
      case 'claude.plugins':
        if (id === 'installed' && rowId) {
          const p = (this.plugins?.plugins?.installed ?? []).find((x: any) => (str(x.pluginId) || str(x.id) || str(x.name)) === rowId);
          await this.pluginAction(value === true ? 'enable' : 'disable', { plugin: rowId, scope: p?.scope || undefined });
        }
        return;
      case 'claude.memory':
        if (id === 'memory.user' || id === 'memory.project') {
          const scope = id.slice(7) as 'user' | 'project';
          const cwd = this.b.workspaceDir();
          const q = scope === 'project' && cwd ? `&cwd=${encodeURIComponent(cwd)}` : '';
          const r = await this.b.bridgeSend('PUT', `/api/claude/memory?scope=${scope}${q}`, { content: String(value ?? '') });
          if (!r?.success) throw new Error(`Save failed: ${r?.error ?? 'the bridge refused'}`);
          await this.loadMemory();
          this.changed();
        }
        return;
      case 'claude.advanced':
        if (id === 'settingsJson') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(String(value ?? ''));
          } catch (e) {
            throw new Error(`Invalid JSON: ${this.err(e)}`);
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json must be a JSON object');
          await this.putSettings(parsed as Record<string, any>);
        }
        return;
    }
  }

  async action(page: string, id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void> {
    switch (page) {
      case 'claude':
      case 'claude.cli':
        if (id === 'install' || id === 'update') return this.cliAction(id);
        return this.accountAction(id, values);
      case 'claude.permissions':
        if (id.startsWith('rules.')) {
          const from = id.slice(6);
          if (actionId === 'add' && values) {
            const rule = (values.rule ?? '').trim();
            if (!rule) throw new Error('Enter a rule');
            const to = values.behavior || 'allow';
            await this.permissions((p) => {
              for (const k of RULE_KINDS) {
                const list: string[] = Array.isArray(p[k.value]) ? p[k.value].filter((r: string) => r !== rule) : [];
                p[k.value] = k.value === to ? [...list, rule] : list;
              }
            });
            return `Added ${rule}`;
          }
          if (!rowId) return;
          await this.permissions((p) => {
            p[from] = (Array.isArray(p[from]) ? p[from] : []).filter((r: string) => r !== rowId);
            if (actionId && actionId !== 'remove') p[actionId] = [...(Array.isArray(p[actionId]) ? p[actionId] : []).filter((r: string) => r !== rowId), rowId];
          });
          return actionId === 'remove' ? `Removed ${rowId}` : undefined;
        }
        return;
      case 'claude.mcp':
        return this.mcpAction(id, rowId, actionId, values);
      case 'claude.plugins':
        if (id === 'install' && values?.plugin?.trim()) return this.pluginAction('install', { plugin: values.plugin.trim(), scope: 'user' });
        if (id === 'search') {
          this.pluginQuery = (values?.query ?? '').trim();
          this.changed();
          return;
        }
        if (id === 'clearSearch') {
          this.pluginQuery = '';
          this.changed();
          return;
        }
        if (id === 'available' && actionId === 'install' && rowId) return this.pluginAction('install', { plugin: rowId, scope: 'user' });
        if (id === 'installed' && rowId && (actionId === 'update' || actionId === 'uninstall')) {
          const p = (this.plugins?.plugins?.installed ?? []).find((x: any) => (str(x.pluginId) || str(x.id) || str(x.name)) === rowId);
          return this.pluginAction(actionId, { plugin: rowId, scope: actionId === 'uninstall' ? p?.scope || undefined : undefined });
        }
        if (id === 'marketplaces') {
          if (actionId === 'add' && values?.source?.trim()) return this.pluginAction('marketplace-add', { source: values.source.trim() });
          if (rowId && (actionId === 'marketplace-update' || actionId === 'marketplace-remove')) return this.pluginAction(actionId, { name: rowId });
        }
        return;
      case 'claude.memory':
        if (id === 'notes' && actionId === 'delete' && rowId) {
          const cwd = this.b.workspaceDir();
          const q = `${cwd ? `cwd=${encodeURIComponent(cwd)}&` : ''}name=${encodeURIComponent(rowId)}`;
          const r = await this.b.bridgeSend('DELETE', `/api/claude/memory/auto?${q}`);
          if (!r?.success) throw new Error(`Delete failed: ${r?.error ?? 'the bridge refused'}`);
          await this.loadMemory();
          this.changed();
          return `Deleted ${rowId}`;
        }
        return;
      case 'claude.providers':
        return this.providers.action(id, rowId, actionId, values);
      case 'claude.advanced':
        if (id === 'reload') {
          await this.b.loadChatDefaults();
          this.changed();
        }
        return;
    }
  }

  private async cliAction(id: 'install' | 'update'): Promise<string> {
    const r = await this.b.bridgeSend('POST', `/api/claude/cli/${id}`, {}, 15_000);
    if (!r?.success) throw new Error(r?.error ?? `${id} failed to start`);
    this.cliJob = r.job ?? null;
    await this.loadCliJob();
    this.changed();
    return id === 'install' ? 'Installing Claude Code…' : 'Checking for a Claude Code update…';
  }

  private async addMcp(v: Record<string, string>): Promise<string> {
    const f = mcpFormValues(v);
    if (!f.name) throw new Error('Enter a name');
    if ((this.mcpList.value ?? []).some((s: any) => s.name === f.name)) throw new Error(`"${f.name}" exists already: edit it instead`);
    // added: the status check connects to it (can take a few seconds)
    await this.mcpChange(f.name, 'Adding…', () => this.postMcp(this.mcpBody(f.name, v.scope || 'user', f)));
    const added = (this.mcpList.value ?? []).find((s: any) => s.name === f.name);
    return added?.status === 'connected' ? `'${f.name}' connected · ${(added.tools ?? []).length} tools` : added?.status === 'failed' ? `'${f.name}' was added but failed to connect` : `Added '${f.name}'`;
  }

  /** A preset tile (the app's Claude MCP presets): `claude mcp add --scope user` through the bridge — transport http
   *  with its URL and --header lines, or stdio with command and args. */
  private async addPreset(tileId: string, values?: Record<string, string>): Promise<string> {
    await this.mcpList.ensure(PAGE_WAIT_MS);
    const tap = presetTap(tileId, values, (this.mcpList.value ?? []).map((s: any) => ({ name: String(s.name), url: s.url ?? s.config?.url ?? null })));
    if (tap.kind === 'done') return tap.message;
    if (tap.kind === 'custom') {
      if (!values) throw new Error('Fill in the server to add');
      return this.addMcp(values);
    }
    const p = tap.preset;
    const stdio = p.transport === 'stdio';
    const body = this.mcpBody(p.serverName, 'user', {
      remote: !stdio,
      type: stdio ? 'stdio' : 'http',
      command: stdio ? [p.command ?? '', ...(p.args ?? [])] : [],
      env: {},
      url: stdio ? '' : (p.url ?? ''),
      headers: stdio ? {} : presetHeaders(p),
    });
    // a same-named server at another address (e.g. the phone app's) is replaced: `claude mcp add` will not overwrite
    if (tap.replace) {
      const old = (this.mcpList.value ?? []).find((s: any) => String(s.name).toLowerCase() === p.serverName.toLowerCase());
      await this.deleteMcp(p.serverName, old?.scope);
    }
    await this.mcpChange(p.serverName, tap.replace ? 'Updating…' : 'Adding…', () => this.postMcp(body));
    return `${tap.replace ? 'Updated' : 'Added'} ${p.name}`;
  }

  // --- account: sign in / out (ClaudeAccountManager)

  private async accountAction(id: string, values?: Record<string, string>): Promise<string | void> {
    switch (id) {
      case 'claude.refresh':
        await Promise.allSettled([this.b.loadStatus(), this.loadCliJob()]);
        this.changed();
        return;
      case 'claude.usage.refresh':
        await this.b.loadUsage(true);
        if (this.b.usageError) throw new Error(`Could not update the usage: ${this.b.usageError}`);
        return;
      case 'claude.signout': {
        const r = await this.b.bridgeSend('POST', '/api/claude/auth/logout', {}, 30_000);
        if (!r?.success) throw new Error(`Sign-out failed: ${r?.error ?? 'unknown error'}`);
        this.b.usage = null;
        await this.b.loadStatus();
        void this.b.loadInfo(true);
        return 'Signed out of Claude';
      }
      case 'claude.signin': {
        if (this.login) {
          if (this.login.automatic_url) this.b.openUrl(this.login.automatic_url);
          return 'Sign-in is already open in your browser';
        }
        this.b.notify('info', 'Opening Claude sign-in…');
        const r = await this.b.bridgeSend('POST', '/api/claude/auth/login', { method: values?.method === 'console' ? 'console' : 'claudeai' }, 60_000);
        if (!r?.success || !r.login) throw new Error(`Sign-in could not start: ${r?.error ?? 'unknown error'}`);
        this.login = r.login;
        this.pollLogin();
        this.changed();
        return;
      }
      case 'claude.signin.open':
        if (this.login?.automatic_url) this.b.openUrl(this.login.automatic_url);
        return;
      case 'claude.signin.manual':
        if (this.login?.manual_url) this.b.openUrl(this.login.manual_url);
        return;
      case 'claude.signin.code': {
        const code = (values?.code ?? '').trim();
        if (!this.login || !code) return;
        const r = await this.b.bridgeSend('POST', `/api/claude/auth/login/${encodeURIComponent(this.login.login_id)}/code`, { code }, 60_000);
        if (!r?.success) throw new Error(`Code rejected: ${r?.error ?? 'unknown error'}`);
        return;
      }
      case 'claude.signin.cancel': {
        const l = this.login;
        this.stopLogin();
        if (l) await this.b.bridgeSend('DELETE', `/api/claude/auth/login/${encodeURIComponent(l.login_id)}`, undefined, 10_000).catch(() => undefined);
        this.changed();
        return;
      }
    }
  }

  private pollLogin() {
    let opened = false;
    const started = Date.now();
    if (this.loginPoll) clearInterval(this.loginPoll);
    this.loginPoll = setInterval(async () => {
      const l = this.login;
      if (!l) return this.stopLogin();
      try {
        const r = await this.b.bridgeJson(`/api/claude/auth/login/${encodeURIComponent(l.login_id)}`);
        const st: Login | null = r?.login ?? null;
        if (!st) return;
        this.login = st;
        const url = st.automatic_url || st.manual_url;
        if (!opened && url) {
          opened = true;
          this.b.openUrl(url);
        }
        if (st.state === 'success' || st.state === 'error' || st.state === 'cancelled' || Date.now() - started > 10 * 60_000) {
          if (st.state !== 'success') this.b.log(`[claude] sign-in: ${st.error ?? st.state}`);
          this.stopLogin();
          await this.b.loadStatus();
          if (st.state === 'success') {
            void this.b.loadInfo(true);
            void this.b.loadUsage(true);
            this.b.notify('info', `Signed in to Claude${this.b.cli?.auth?.email ? ` as ${this.b.cli.auth.email}` : ''}`);
          } else if (st.state === 'error') this.b.notify('error', `Claude sign-in failed${st.error ? `: ${st.error}` : ''}`);
          else if (st.state !== 'cancelled') this.b.notify('warning', 'Claude sign-in timed out. Try again from Settings → Claude Code → Account & CLI.');
        }
        this.changed();
      } catch {
        /* keep polling */
      }
    }, 1500);
  }

  private stopLogin() {
    if (this.loginPoll) clearInterval(this.loginPoll);
    this.loginPoll = null;
    this.login = null;
  }

  dispose() {
    this.stopLogin();
    if (this.jobPoll) clearInterval(this.jobPoll);
    this.jobPoll = null;
  }
}
