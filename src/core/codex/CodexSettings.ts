// Settings → Codex (ports of the app's CodexSettingsScreen.kt and CodexMcpPage.kt): the main page links to Account &
// CLI (install / update / restart, ChatGPT sign-in, usage limits), Permissions & defaults (local choices) and MCP
// servers (Codex's own config.toml). A page Codex can't serve (not installed, bridge down) says so at once.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SettingFormField, SettingItem, SettingsPage, SettingsSection } from '../../../shared/protocol';
import type { AgentSettingsProvider } from '../types';
import {
  Cached,
  MCP_EDIT,
  MCP_LIST,
  MCP_PRESETS,
  MCP_RECONNECT,
  MCP_REFRESH_ALL,
  MCP_REMOVE,
  joinCommand,
  mcpForm,
  mcpFormValues,
  mcpPage,
  mcpSummary,
  presetHeaders,
  presetTap,
  presetsItem,
  unavailablePage,
  waitFor,
  withTimeout,
  type McpServerView,
  type McpState,
} from '../agy/settingsKit';
import type { CodexBackend } from './CodexBackend';
import { MODES, STATE_LABEL, arr, capitalize, effortDescription, effortLabel, modeDescription, modeLabel, quotaWindows, str, type J } from './util';

type McpRow = Awaited<ReturnType<CodexBackend['mcpList']>>[number];

const strings = (x: J | null | undefined): Record<string, string> => Object.fromEntries(Object.entries(x ?? {}).map(([k, v]) => [k, String(v ?? '')]));

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A page waits this long for Codex's status while it is checked. */
const WAIT_MS = 3_000;
/** The MCP list (it connects the servers) is waited for this long; then the page shows what it has. */
const PAGE_WAIT_MS = 8_000;

export class CodexSettings implements AgentSettingsProvider {
  private mcp: Cached<McpRow[]>;
  /** Number of servers in Codex's config (the MCP row's badge), read cheaply without connecting them. */
  private mcpCount: number | null = null;
  private mcpCounting = false;
  private busy = new Map<string, string>();

  constructor(private b: CodexBackend) {
    this.mcp = new Cached(
      () => this.b.mcpList(),
      () => this.changed(),
    );
  }

  private changed() {
    this.b.changed('settings');
  }

  // ------------------------------------------------------------------ root & main page

  /** "you@mail.com · Plus plan" / the state. */
  private accountSummary(): string {
    const acc = this.b.account;
    if (this.b.login) return 'Signing in…';
    if (acc) return [acc.email, acc.plan ? `${capitalize(acc.plan)} plan` : null].filter(Boolean).join(' · ') || 'Signed in';
    return STATE_LABEL[this.b.codexState];
  }

  rootItem(): SettingItem {
    return { kind: 'page', id: 'codex', label: 'Codex', icon: 'code', description: this.accountSummary(), badge: this.b.status().version ?? null };
  }

  /** The Codex page: links only, as the app's CodexSettingsGroup (Account & CLI / Permissions, MCP servers). */
  private mainPage(): SettingsPage {
    const b = this.b;
    const st = b.codexState;
    if (this.mcpCount == null && (st === 'READY' || st === 'SIGNED_OUT')) void this.countMcp();
    const mode = b.permissionMode();
    const v = b.status().version;
    const servers = this.mcp.value && !this.mcp.error ? this.mcpViews() : null;
    const sections: SettingsSection[] = [
      {
        id: 'cli',
        title: '',
        agent: 'CODEX',
        items: [
          {
            kind: 'page',
            id: 'codex.cli',
            label: 'Account & CLI',
            icon: 'account',
            description: [this.accountSummary(), v ? `Codex ${v}` : null].filter(Boolean).join(' · '),
            badge: st === 'READY' ? (b.account?.plan ? `${capitalize(b.account.plan)} plan` : 'Signed in') : STATE_LABEL[st],
          },
        ],
      },
      {
        id: 'pages',
        title: '',
        agent: 'CODEX',
        items: [
          { kind: 'page', id: 'codex.permissions', label: 'Permissions & defaults', icon: 'tune', description: 'What Codex asks before acting in new chats', badge: modeLabel(mode) },
          {
            kind: 'page',
            id: 'codex.mcp',
            label: 'MCP servers',
            icon: 'hub',
            description: 'Tools Codex can call (Codex’s own config)',
            badge: servers ? mcpSummary(servers) : this.mcpCount ? `${this.mcpCount} servers` : null,
          },
        ],
      },
    ];
    return { id: 'codex', title: 'Codex', sections };
  }

  // ------------------------------------------------------------------ pages

  /** Why Codex's MCP servers can't be read now (null = they can: signed out is fine). */
  private async blocked(): Promise<string | null> {
    if (this.b.codexState === 'CHECKING') await waitFor(() => this.b.codexState !== 'CHECKING', WAIT_MS);
    const st = this.b.codexState;
    if (st === 'READY' || st === 'SIGNED_OUT') return null;
    if (st === 'CHECKING') return 'Codex is still starting. Try again in a moment.';
    return this.b.status().detail ?? STATE_LABEL[st];
  }

  async page(id: string): Promise<SettingsPage | null> {
    switch (id) {
      case 'codex':
        return this.mainPage();
      case 'codex.cli':
        // works with Codex missing too: it is where it is installed
        await withTimeout(this.b.refreshCliJob(), WAIT_MS, 'The bridge').catch(() => undefined);
        return this.cliPage();
      case 'codex.permissions':
        // local choices: no Codex needed
        return this.permissionsPage();
      case 'codex.mcp': {
        const why = await this.blocked();
        if (why) return unavailablePage(id, 'MCP servers', 'CODEX', why, { page: 'codex.cli', label: 'Account & CLI', description: 'Install Codex, or see why it can’t be used' });
        const done = await this.mcp.ensure(PAGE_WAIT_MS);
        return this.mcpPage(!done);
      }
      default:
        return null;
    }
  }

  private permissionsPage(): SettingsPage {
    const b = this.b;
    const model = b.selectedModelId();
    const efforts = b.effortsOf(model);
    const effort = b.effortFor(null);
    const items: SettingItem[] = [
      {
        kind: 'select',
        id: 'mode',
        label: 'Approvals',
        description: 'What Codex asks before acting. Applies to the next message of every chat; each chat can change it from the chip above the message box.',
        value: b.permissionMode(),
        options: MODES.map((m) => ({ value: m, label: modeLabel(m), description: modeDescription(m) })),
      },
    ];
    if (efforts.length)
      items.push({
        kind: 'select',
        id: 'effort',
        label: 'Reasoning for new chats',
        description: `How long ${b.modelName(model)} thinks before answering.`,
        value: effort,
        options: efforts.map((e) => ({ value: e, label: effortLabel(e), description: effortDescription(e) })),
      });
    items.push({
      kind: 'toggle',
      id: 'autoTitle',
      label: 'Name new chats',
      description: "After the first reply, a short hidden Codex turn writes the chat's title (like Codex's own app). Uses a little of your limits.",
      value: b.autoTitle(),
    });
    return { id: 'codex.permissions', title: 'Permissions & defaults', sections: [{ id: 'defaults', title: '', agent: 'CODEX', items }] };
  }

  // --- MCP

  private async countMcp() {
    if (this.mcpCounting) return;
    this.mcpCounting = true;
    try {
      this.mcpCount = (await this.b.mcpServerNames()).length;
      this.changed();
    } catch {
      this.mcpCount = this.mcpCount ?? 0;
    } finally {
      this.mcpCounting = false;
    }
  }

  private mcpFormFor(srv?: McpRow): SettingFormField[] {
    const c = srv?.config ?? {};
    return mcpForm({
      name: srv?.name ?? '',
      nameLocked: !!srv,
      remote: srv ? str(c, 'url') != null : false,
      command: str(c, 'command') ? joinCommand([str(c, 'command')!, ...arr(c, 'args').map((a) => String(a))]) : '',
      env: strings(c.env),
      url: str(c, 'url') ?? '',
      headers: strings(c.http_headers),
    });
  }

  private mcpViews(): McpServerView[] {
    const views: McpServerView[] = (this.mcp.value ?? []).map((srv) => {
      const c = srv.config;
      const off = c.enabled === false || srv.status === 'disabled';
      const state: McpState = off
        ? 'off'
        : srv.status === 'connected'
          ? 'connected'
          : srv.status === 'failed'
            ? 'error'
            : srv.status === 'authenticationRequired'
              ? 'auth'
              : srv.status === 'starting' || srv.status === 'notStarted'
                ? 'connecting'
                : 'idle';
      return {
        name: srv.name,
        state,
        where: str(c, 'url') ?? ([str(c, 'command'), ...arr(c, 'args').map((a) => String(a))].filter(Boolean).join(' ') || null),
        origin: srv.status == null && !off ? 'connects with the next chat' : null,
        error: srv.error,
        tools: srv.status === 'connected' ? srv.toolCount : null,
        enabled: !off,
        reconnect: true,
        editForm: this.mcpFormFor(srv),
        removable: true,
        busy: this.busy.get(srv.name) ?? null,
      };
    });
    for (const [name, label] of this.busy) if (!views.some((v) => v.name === name)) views.unshift({ name, state: 'connecting', busy: label });
    return views;
  }

  private mcpPage(loading = false): SettingsPage {
    const names = (this.mcp.value ?? []).map((s: any) => ({ name: String(s.name), url: s.url ?? s.config?.url ?? null }));
    return mcpPage({
      id: 'codex.mcp',
      agent: 'CODEX',
      description:
        "Servers here are in Codex's own config (~/.codex/config.toml), so every Codex chat, the Codex CLI and its VS Code extension can use them. They connect when a chat starts.",
      servers: this.mcpViews(),
      error: this.mcp.error ? `Could not read Codex's config: ${this.mcp.error}` : null,
      addForm: this.mcpFormFor(),
      loading,
      presets: [presetsItem(names, this.mcpFormFor())],
    });
  }

  /** Saves a server from the form; an edit keeps the entry's other fields (enabled, timeouts…). */
  private async saveMcp(values: Record<string, string>, fixedName?: string): Promise<string> {
    const f = mcpFormValues(values);
    const name = fixedName ?? f.name;
    if (!NAME_RE.test(name)) throw new Error('Name: letters, digits, "-" and "_" (up to 64)');
    const old = fixedName ? ((this.mcp.value ?? []).find((s) => s.name === fixedName)?.config ?? {}) : {};
    const { command: _c, args: _a, env: _e, url: _u, http_headers: _h, ...rest } = old as J;
    const value: J = f.remote
      ? { ...rest, url: f.url, ...(Object.keys(f.headers).length ? { http_headers: f.headers } : {}) }
      : { ...rest, command: f.command[0], ...(f.command.length > 1 ? { args: f.command.slice(1) } : {}), ...(Object.keys(f.env).length ? { env: f.env } : {}) };
    await this.b.putMcp(name, value);
    return name;
  }

  private async addServer(values: Record<string, string>): Promise<string> {
    const name = (values.name ?? '').trim();
    if ((this.mcp.value ?? []).some((s) => s.name === name)) throw new Error(`"${name}" exists already: edit it instead`);
    await this.mcpChange(name || 'new', 'Saving…', () => this.saveMcp(values));
    return `${name} saved`;
  }

  /** A preset tile (the app's CodexMcpPage presets): config/batchWrite `mcp_servers.<serverName>` = {url,
   *  http_headers} or {command, args}, then config/mcpServer/reload. */
  private async addPreset(tileId: string, values?: Record<string, string>): Promise<string> {
    await this.mcp.ensure(PAGE_WAIT_MS);
    const tap = presetTap(tileId, values, (this.mcp.value ?? []).map((s: any) => ({ name: String(s.name), url: s.url ?? s.config?.url ?? null })));
    if (tap.kind === 'done') return tap.message;
    if (tap.kind === 'custom') {
      if (!values) throw new Error('Fill in the server to add');
      return this.addServer(values);
    }
    const p = tap.preset;
    await this.mcpChange(p.serverName, 'Adding…', () =>
      p.transport === 'stdio' ? this.b.addLocalMcp(p.serverName, [p.command ?? '', ...(p.args ?? [])], {}) : this.b.addRemoteMcp(p.serverName, p.url ?? '', presetHeaders(p)),
    );
    this.mcpCount = this.mcp.value?.length ?? this.mcpCount;
    return `Added ${p.name}`;
  }

  /** Runs an MCP change with the row marked busy, then reads the list again. */
  private async mcpChange<T>(name: string, label: string, run: () => Promise<T>): Promise<T> {
    this.busy.set(name, label);
    this.changed();
    try {
      return await run();
    } finally {
      this.busy.delete(name);
      await this.mcp.reload(PAGE_WAIT_MS);
      this.mcpCount = this.mcp.value?.length ?? this.mcpCount;
      this.changed();
    }
  }

  // --- Account & CLI (the app's Account, Usage limits and Server & install pages, on one page)

  private cliItems(): SettingItem[] {
    const b = this.b;
    const st = b.bridgeStatus ?? {};
    const notInstalled = b.codexState === 'NOT_INSTALLED';
    const job = b.cliJob;
    const jobRunning = job?.running === true;
    const items: SettingItem[] = [
      {
        kind: 'info',
        id: 'version',
        label: 'Codex CLI',
        value: notInstalled ? 'Not installed' : [st.version ? `Codex ${st.version}` : null, st.running ? 'running' : st.installed ? 'starts when needed' : null].filter(Boolean).join(' · ') || STATE_LABEL[b.codexState],
        tone: notInstalled ? 'warn' : b.codexState === 'ERROR' || b.codexState === 'OFFLINE' || b.codexState === 'DISABLED' || b.codexState === 'OUTDATED' ? 'error' : b.codexState === 'CHECKING' ? 'muted' : 'ok',
        description: st.binary ?? null,
      },
    ];
    if (notInstalled)
      items.push({
        kind: 'button',
        id: 'install',
        label: jobRunning ? 'Installing…' : 'Install Codex',
        style: 'primary',
        disabled: jobRunning,
        description: st.termux_package ? 'Installs the Termux package (pkg install codex).' : "Downloads OpenAI's official Linux build into ~/.local/bin.",
      });
    else if (st.installed) {
      items.push({ kind: 'button', id: 'update', label: jobRunning ? 'Checking…' : 'Check for updates', disabled: jobRunning });
      items.push({
        kind: 'button',
        id: 'restart',
        label: 'Restart Codex',
        disabled: jobRunning,
        confirm: 'Restart Codex? Replies that are running end.',
        description: 'Restarting ends replies that are running. Codex keeps its chats and sign-in in ~/.codex.',
      });
    }
    if (job) {
      items.push({
        kind: 'info',
        id: 'job',
        label: job.kind === 'update' ? 'Update' : 'Install',
        value: job.running ? 'running…' : job.exit_code === 0 ? 'done' : 'failed',
        tone: job.running ? 'warn' : job.exit_code === 0 ? 'ok' : 'error',
      });
      if (job.log?.trim()) items.push({ kind: 'text', id: 'log', label: 'Log', value: job.log.trim().split('\n').slice(-30).join('\n'), multiline: true, code: true, rows: 10, disabled: true });
    }
    if (st.error && b.codexState !== 'READY' && b.codexState !== 'SIGNED_OUT') items.push({ kind: 'info', id: 'error', label: 'Error', value: '', description: st.error, tone: 'error' });
    return items;
  }

  private accountItems(): SettingItem[] {
    const b = this.b;
    const st = b.codexState;
    const acc = b.account;
    const usable = st === 'READY' || st === 'SIGNED_OUT';
    const account: SettingItem[] = [
      {
        kind: 'info',
        id: 'codex.account',
        label: 'Account',
        value: acc ? acc.email || (acc.type === 'apiKey' ? 'API key' : 'Signed in') : st === 'CHECKING' ? 'Checking…' : usable ? 'Not signed in' : 'Not available',
        tone: acc ? 'ok' : st === 'SIGNED_OUT' ? 'warn' : usable || st === 'CHECKING' ? 'muted' : 'error',
        description: acc?.plan ? `${capitalize(acc.plan)} plan` : !usable && st !== 'CHECKING' ? (b.status().detail ?? null) : null,
      },
    ];
    const login = b.login;
    if (login) {
      account.push({
        kind: 'info',
        id: 'codex.login',
        label: login.code ? 'Enter this code on the sign-in page' : 'Finish signing in in your browser',
        value: login.code ?? '',
        tone: 'warn',
        description: login.url,
      });
      account.push({ kind: 'button', id: 'codex.loginOpen', label: 'Open sign-in page', style: 'primary' });
      account.push({ kind: 'button', id: 'codex.loginCancel', label: 'Cancel sign-in' });
    } else if (st === 'SIGNED_OUT') {
      account.push({
        kind: 'button',
        id: 'codex.signin',
        label: 'Sign in with ChatGPT',
        style: 'primary',
        description: 'Sign in with the ChatGPT account whose plan Codex should use (Free, Plus, Pro, Business…).',
      });
      account.push({
        kind: 'button',
        id: 'codex.signinCode',
        label: 'Use a code',
        description: '"Use a code" works when the browser cannot come back to Codex. It may first need to be allowed in ChatGPT → Settings → Security.',
      });
    } else if (acc) {
      account.push({ kind: 'button', id: 'codex.signout', label: 'Sign out', style: 'danger', confirm: 'Sign out of Codex? Every Codex chat stops working until you sign in again.' });
    }
    account.push({ kind: 'button', id: 'codex.refresh', label: 'Check again' });
    return account;
  }

  /** Usage limits: every Codex model counts toward the same limits; the meters show what is left. */
  private usageItems(): SettingItem[] | null {
    const b = this.b;
    if (b.codexState !== 'READY') return null;
    const windows = quotaWindows(b.rateLimits);
    const plan = b.rateLimits?.plan ?? b.account?.plan;
    return [
      windows.length
        ? { kind: 'quota', id: 'codex.quota', label: 'Usage limits', groups: [{ name: plan ? `${capitalize(plan)} plan · all models` : 'All models', windows }] }
        : { kind: 'info', id: 'codex.quota', label: 'Usage limits', value: !b.rateLimits ? 'No usage information yet.' : 'No limits reported for this account.', tone: 'muted' },
      { kind: 'button', id: 'codex.usage.refresh', label: 'Refresh usage' },
    ];
  }

  private cliPage(): SettingsPage {
    const sections: SettingsSection[] = [
      { id: 'cli', title: '', agent: 'CODEX', items: this.cliItems() },
      { id: 'account', title: '', agent: 'CODEX', items: this.accountItems() },
    ];
    const usage = this.usageItems();
    if (usage) sections.push({ id: 'usage', title: '', agent: 'CODEX', description: 'What is left of each limit, and when it resets', items: usage });
    return { id: 'codex.cli', title: 'Account & CLI', sections };
  }

  // ------------------------------------------------------------------ edits

  async change(page: string, id: string, value: unknown, rowId?: string): Promise<void> {
    if (page === 'codex.mcp' && id === MCP_LIST && rowId) {
      const on = value === true;
      await this.mcpChange(rowId, on ? 'Turning on…' : 'Turning off…', () => this.b.setMcpEnabled(rowId, on));
      return;
    }
    if (page !== 'codex.permissions') return;
    if (id === 'mode') this.b.setPermissionMode(String(value));
    else if (id === 'effort') this.b.setDefaultEffort(String(value));
    else if (id === 'autoTitle') {
      this.b.store.set('codex.autoTitle', value === true);
      this.changed();
    }
  }

  async action(page: string, id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void> {
    const b = this.b;
    if (page === 'codex' || page === 'codex.cli' || page === 'root') {
      switch (id) {
        case 'codex.signin':
        case 'codex.signinCode':
          b.notify('info', 'Opening ChatGPT sign-in…');
          return b.startLogin(id === 'codex.signinCode');
        case 'codex.loginOpen':
          if (b.login) b.openUrl(b.login.url);
          return;
        case 'codex.loginCancel':
          await b.cancelLogin();
          return 'Sign-in cancelled';
        case 'codex.signout':
          await b.logout();
          return 'Signed out of Codex';
        case 'codex.refresh':
          await b.refreshStatus();
          await Promise.allSettled([b.refreshRateLimits(), b.refreshCliJob()]);
          this.changed();
          return STATE_LABEL[b.codexState];
        case 'codex.usage.refresh':
          await b.refreshRateLimits();
          this.changed();
          return;
        case 'install':
        case 'update':
          await b.startCliJob(id);
          return id === 'install' ? 'Installing Codex…' : 'Checking for a Codex update…';
        case 'restart':
          await b.restartServer();
          return 'Codex restarted';
      }
      return;
    }
    if (page === 'codex.mcp') {
      if (id === MCP_REFRESH_ALL || (id === MCP_LIST && actionId === MCP_RECONNECT)) {
        await b.reloadMcp();
        const done = await this.mcp.reload(PAGE_WAIT_MS);
        this.changed();
        if (this.mcp.error) throw new Error(`Could not read the servers: ${this.mcp.error}`);
        if (!done) return 'Reconnecting… the list updates when Codex answers';
        const s = rowId ? (this.mcp.value ?? []).find((x) => x.name === rowId) : null;
        if (s?.status === 'failed') throw new Error(`${rowId}: ${s.error ?? 'failed to connect'}`);
        return rowId ? `Reconnected ${rowId}${s?.status === 'connected' ? ` · ${s.toolCount} tools` : ''}` : `${(this.mcp.value ?? []).length} servers reconnected`;
      }
      if (id === MCP_PRESETS && actionId) return this.addPreset(actionId, values);
      if (id === MCP_LIST && actionId === 'add' && values) return this.addServer(values);
      if (id !== MCP_LIST || !rowId) return;
      if (actionId === MCP_EDIT && values) {
        await this.mcpChange(rowId, 'Saving…', () => this.saveMcp(values, rowId));
        return `${rowId} saved`;
      }
      if (actionId === MCP_REMOVE) {
        await this.mcpChange(rowId, 'Removing…', () => b.removeMcp(rowId));
        return `${rowId} removed`;
      }
      return;
    }
  }

  dispose() {
    /* nothing running of its own: the backend owns the polls */
  }
}
