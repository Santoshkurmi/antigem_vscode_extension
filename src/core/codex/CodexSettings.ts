// Settings → Codex (ports of the app's CodexSettingsScreen.kt and CodexMcpPage.kt): account and usage limits on the
// main page, then Permissions & defaults (local choices), MCP servers (Codex's own config.toml) and Server & install.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SettingFormField, SettingItem, SettingListRow, SettingsPage, SettingsSection } from '../../../shared/protocol';
import type { AgentSettingsProvider } from '../types';
import type { CodexBackend } from './CodexBackend';
import { MODES, STATE_LABEL, arr, capitalize, effortDescription, effortLabel, errText, modeDescription, modeLabel, quotaWindows, str, windowLabel, type J } from './util';

type McpRow = Awaited<ReturnType<CodexBackend['mcpList']>>[number];

/** "Key: value" / "KEY=value" lines → map (blank lines skipped). */
function parsePairs(text: string | undefined, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of (text ?? '').split('\n').map((x) => x.trim())) {
    const i = l.indexOf(sep);
    if (l && i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

/** A command line → its words (quotes keep spaces together). */
function splitCommand(text: string | undefined): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const c of (text ?? '').trim()) {
    if (quote && c === quote) quote = null;
    else if (!quote && (c === '"' || c === "'")) quote = c;
    else if (!quote && /\s/.test(c)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const strings = (x: J | null | undefined): Record<string, string> => Object.fromEntries(Object.entries(x ?? {}).map(([k, v]) => [k, String(v ?? '')]));

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class CodexSettings implements AgentSettingsProvider {
  private mcp: McpRow[] | null = null;
  private mcpError: string | null = null;
  private mcpLoadedAt = 0;
  /** Number of servers in Codex's config (the MCP row's badge), read cheaply without connecting them. */
  private mcpCount: number | null = null;
  private mcpCounting = false;

  constructor(private b: CodexBackend) {}

  private changed() {
    this.b.changed('settings');
  }

  // ------------------------------------------------------------------ root & main page

  rootItem(): SettingItem {
    const st = this.b.codexState;
    const acc = this.b.account;
    const description = acc ? [acc.email, acc.plan ? `${capitalize(acc.plan)} plan` : null].filter(Boolean).join(' · ') || 'Signed in' : STATE_LABEL[st];
    return { kind: 'page', id: 'codex', label: 'Codex', icon: 'code', description, badge: this.b.bridgeStatus?.version ?? null };
  }

  /** The Codex page: account, usage limits, then links to its settings pages (sections without titles). */
  private mainPage(): SettingsPage {
    const b = this.b;
    const st = b.codexState;
    const acc = b.account;
    const ready = st === 'READY';
    const account: SettingItem[] = [
      {
        kind: 'info',
        id: 'codex.state',
        label: 'Codex',
        value: STATE_LABEL[st],
        tone: ready ? 'ok' : st === 'CHECKING' ? 'muted' : st === 'SIGNED_OUT' ? 'warn' : 'error',
        description: !ready && st !== 'CHECKING' && st !== 'SIGNED_OUT' ? (b.bridgeStatus?.error ?? null) : null,
      },
      {
        kind: 'info',
        id: 'codex.account',
        label: 'Account',
        value: acc ? acc.email || (acc.type === 'apiKey' ? 'API key' : 'Signed in') : st === 'CHECKING' ? 'Checking…' : 'Not signed in',
        tone: acc ? 'ok' : 'muted',
        description: acc?.plan ? `${capitalize(acc.plan)} plan` : null,
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
        description: "Sign in with the ChatGPT account whose plan Codex should use (Free, Plus, Pro, Business…).",
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
    const sections: SettingsSection[] = [{ id: 'account', title: '', agent: 'CODEX', items: account }];

    // usage limits: every Codex model counts toward the same limits
    const windows = quotaWindows(b.rateLimits);
    const plan = b.rateLimits?.plan ?? acc?.plan;
    if (windows.length) {
      sections.push({
        id: 'usage',
        title: '',
        agent: 'CODEX',
        items: [{ kind: 'quota', id: 'codex.quota', label: 'Usage limits', groups: [{ name: plan ? `${capitalize(plan)} plan · all models` : 'All models', windows }] }],
      });
    } else {
      const value = !b.rateLimits ? (ready ? 'No usage information yet.' : 'Sign in to Codex to see your limits.') : 'No limits reported for this account.';
      sections.push({ id: 'usage', title: '', agent: 'CODEX', items: [{ kind: 'info', id: 'codex.quota', label: 'Usage limits', value, tone: 'muted' }] });
    }

    if (this.mcpCount == null && ready) void this.countMcp();
    const mode = b.permissionMode();
    sections.push({
      id: 'pages',
      title: '',
      agent: 'CODEX',
      items: [
        { kind: 'page', id: 'codex.permissions', label: 'Permissions & defaults', icon: 'tune', description: `${modeLabel(mode)} · what Codex asks before acting`, badge: modeLabel(mode) },
        { kind: 'page', id: 'codex.mcp', label: 'MCP servers', icon: 'hub', description: "Tools Codex can call (Codex's own config)", badge: (this.mcp?.length ?? this.mcpCount) ? `${this.mcp?.length ?? this.mcpCount} servers` : null },
        {
          kind: 'page',
          id: 'codex.cli',
          label: 'Server & install',
          icon: 'dns',
          description: 'Install, update and restart Codex',
          badge: st === 'NOT_INSTALLED' ? 'Not installed' : (b.bridgeStatus?.version ?? null),
        },
      ],
    });
    return { id: 'codex', title: 'Codex', sections };
  }

  // ------------------------------------------------------------------ pages

  async page(id: string): Promise<SettingsPage | null> {
    switch (id) {
      case 'codex':
        return this.mainPage();
      case 'codex.permissions':
        return this.permissionsPage();
      case 'codex.mcp':
        // re-read at most every few seconds (every settings refresh re-builds the open page)
        if (!this.mcp || Date.now() - this.mcpLoadedAt > 5_000) await this.loadMcp();
        return this.mcpPage();
      case 'codex.cli':
        await this.b.refreshCliJob();
        return this.cliPage();
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
      /* the badge stays empty */
    } finally {
      this.mcpCounting = false;
    }
  }

  private async loadMcp() {
    try {
      this.mcp = await this.b.mcpList();
      this.mcpCount = this.mcp.length;
      this.mcpError = null;
    } catch (e) {
      this.mcpError = errText(e);
      this.mcp = this.mcp ?? [];
    }
    this.mcpLoadedAt = Date.now();
  }

  private mcpForm(srv?: McpRow): SettingFormField[] {
    const c = srv?.config ?? {};
    const remote = srv ? str(c, 'url') != null : true;
    const command = [str(c, 'command'), ...arr(c, 'args').map((a) => String(a))].filter((x): x is string => !!x).map((w) => (w.includes(' ') ? `"${w}"` : w));
    return [
      { id: 'name', label: 'Name', kind: 'text', value: srv?.name ?? '', placeholder: 'github', required: true },
      {
        id: 'type',
        label: 'Type',
        kind: 'select',
        value: remote ? 'http' : 'stdio',
        options: [
          { value: 'http', label: 'Remote (HTTP)', description: 'A URL and optional headers' },
          { value: 'stdio', label: 'Local (command)', description: 'A command Codex starts' },
        ],
      },
      { id: 'url', label: 'URL', kind: 'text', value: str(c, 'url') ?? '', placeholder: 'https://example.com/mcp' },
      {
        id: 'headers',
        label: 'Headers (Name: value per line)',
        kind: 'multiline',
        value: Object.entries(strings(c.http_headers))
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n'),
      },
      { id: 'command', label: 'Command', kind: 'text', value: command.join(' '), placeholder: 'npx -y @modelcontextprotocol/server-github' },
      {
        id: 'env',
        label: 'Environment (KEY=value per line)',
        kind: 'multiline',
        value: Object.entries(strings(c.env))
          .map(([k, v]) => `${k}=${v}`)
          .join('\n'),
      },
    ];
  }

  private mcpPage(): SettingsPage {
    const stitchAdded = (this.mcp ?? []).some((s) => s.name === 'stitch');
    const rows: SettingListRow[] = (this.mcp ?? []).map((srv) => {
      const c = srv.config;
      const [label, tone] = ((): [string, SettingListRow['statusTone']] => {
        switch (srv.status) {
          case 'connected':
            return [srv.toolCount > 0 ? `${srv.toolCount} tools` : 'Connected', 'ok'];
          case 'failed':
            return ['Failed', 'error'];
          case 'disabled':
            return ['Disabled', 'muted'];
          case 'authenticationRequired':
            return ['Needs sign-in', 'warn'];
          case 'starting':
          case 'notStarted':
            return ['Connecting…', 'warn'];
          case null:
            return ['Connects with the next chat', 'muted'];
          default:
            return [srv.status, 'muted'];
        }
      })();
      const where = str(c, 'url') ?? ([str(c, 'command'), ...arr(c, 'args').map((a) => String(a))].filter(Boolean).join(' ') || null);
      return {
        id: srv.name,
        title: srv.name,
        subtitle: srv.error ?? where,
        status: label,
        statusTone: tone,
        actions: [
          { id: 'edit', label: 'Edit', form: this.mcpForm(srv) },
          { id: 'remove', label: 'Remove', danger: true, confirm: `Remove the MCP server "${srv.name}" from Codex's config?` },
        ],
      };
    });
    return {
      id: 'codex.mcp',
      title: 'MCP servers',
      sections: [
        {
          id: 'servers',
          title: '',
          agent: 'CODEX',
          description: this.mcpError
            ? `Could not read Codex's config: ${this.mcpError}`
            : "Servers here are in Codex's own config (~/.codex/config.toml), so every Codex chat, the Codex CLI and its VS Code extension can use them. They connect when a chat starts.",
          items: [
            { kind: 'list', id: 'servers', label: `Servers (${rows.length})`, rows, emptyText: 'None yet. Add one, or start from a preset below.', addLabel: 'Add server', addForm: this.mcpForm() },
            { kind: 'button', id: 'refresh', label: 'Refresh' },
          ],
        },
        {
          id: 'presets',
          title: 'Quick presets',
          agent: 'CODEX',
          description: 'Local servers run on this machine, in Codex\'s environment.',
          items: [
            {
              kind: 'button',
              id: 'preset.stitch',
              label: stitchAdded ? 'Stitch · added' : 'Stitch',
              description: 'Google Stitch UI design · API key',
              disabled: stitchAdded,
              form: this.mcpForm({ name: 'stitch', config: { url: 'https://stitch.googleapis.com/mcp', http_headers: { 'X-Goog-Api-Key': '' } }, status: null, error: null, toolCount: 0 }),
            },
            { kind: 'button', id: 'preset.custom', label: 'Custom server', description: 'Any remote (HTTP) or local (command) server', form: this.mcpForm() },
          ],
        },
      ],
    };
  }

  private async saveMcp(values: Record<string, string>, fixedName?: string) {
    const name = (fixedName ?? values.name ?? '').trim();
    if (!NAME_RE.test(name)) throw new Error('Name: letters, digits, "-" and "_" (up to 64)');
    if (values.type === 'stdio') {
      const cmd = splitCommand(values.command);
      if (!cmd.length) throw new Error('Enter the command');
      await this.b.addLocalMcp(name, cmd, parsePairs(values.env, '='));
    } else {
      const url = (values.url ?? '').trim();
      if (!/^https?:\/\//.test(url)) throw new Error('Enter the server URL (http:// or https://)');
      await this.b.addRemoteMcp(name, url, parsePairs(values.headers, ':'));
    }
    return name;
  }

  // --- server & install

  private cliPage(): SettingsPage {
    const b = this.b;
    const st = b.bridgeStatus ?? {};
    const notInstalled = b.codexState === 'NOT_INSTALLED';
    const job = b.cliJob;
    const jobRunning = job?.running === true;
    const items: SettingItem[] = [
      {
        kind: 'info',
        id: 'version',
        label: 'Codex',
        value: notInstalled ? 'Not installed' : [st.version ? `Codex ${st.version}` : null, st.running ? 'running' : st.installed ? 'starts when needed' : null].filter(Boolean).join(' · ') || STATE_LABEL[b.codexState],
        tone: notInstalled || b.codexState === 'ERROR' || b.codexState === 'OFFLINE' ? 'error' : 'ok',
      },
      { kind: 'info', id: 'binary', label: 'Binary', value: st.binary ?? '—', tone: 'muted' },
    ];
    if (notInstalled)
      items.push({
        kind: 'button',
        id: 'install',
        label: jobRunning ? 'Installing…' : 'Install Codex',
        style: 'primary',
        disabled: jobRunning,
        description: st.termux_package
          ? 'Installs the Termux package (pkg install codex).'
          : "Downloads OpenAI's official Linux build into ~/.local/bin.",
      });
    else {
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
      if (job.log?.trim()) items.push({ kind: 'text', id: 'log', label: 'Log', value: job.log.trim().split('\n').slice(-14).join('\n'), multiline: true, disabled: true });
    }
    if (st.error && b.codexState !== 'READY') items.push({ kind: 'info', id: 'error', label: 'Error', value: '', description: st.error, tone: 'error' });
    const limits = b.rateLimits;
    const windows = [limits?.primary, limits?.secondary].filter((w): w is NonNullable<typeof w> => w != null);
    if (windows.length)
      items.push({
        kind: 'info',
        id: 'limits',
        label: 'Usage',
        value: windows.map((w) => `${windowLabel(w.windowMinutes)} ${Math.round(w.usedPercent)}% used`).join(' · '),
        tone: 'muted',
      });
    return { id: 'codex.cli', title: 'Server & install', sections: [{ id: 'server', title: '', agent: 'CODEX', items }] };
  }

  // ------------------------------------------------------------------ edits

  async change(page: string, id: string, value: unknown, _rowId?: string): Promise<void> {
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
    if (page === 'codex' || page === 'root') {
      switch (id) {
        case 'codex.signin':
          return b.startLogin(false);
        case 'codex.signinCode':
          return b.startLogin(true);
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
          await b.refreshRateLimits();
          return STATE_LABEL[b.codexState];
      }
      return;
    }
    if (page === 'codex.mcp') {
      if (id === 'refresh') {
        await this.loadMcp();
        this.changed();
        return this.mcpError ? `Could not read the servers: ${this.mcpError}` : undefined;
      }
      if ((id === 'preset.stitch' || id === 'preset.custom') && values) {
        const name = (values.name ?? '').trim();
        if (this.mcp?.some((s) => s.name === name)) throw new Error(`"${name}" exists already: edit it instead`);
        await this.saveMcp(values);
        await this.loadMcp();
        this.changed();
        return `${name} saved`;
      }
      if (id === 'servers') {
        if (actionId === 'add' && values) {
          const name = (values.name ?? '').trim();
          if (this.mcp?.some((s) => s.name === name)) throw new Error(`"${name}" exists already: edit it instead`);
          await this.saveMcp(values);
          await this.loadMcp();
          this.changed();
          return `${name} saved`;
        }
        if (!rowId) return;
        if (actionId === 'edit' && values) {
          await this.saveMcp(values, rowId);
          await this.loadMcp();
          this.changed();
          return `${rowId} saved`;
        }
        if (actionId === 'remove') {
          await b.removeMcp(rowId);
          await this.loadMcp();
          this.changed();
          return `${rowId} removed`;
        }
      }
      return;
    }
    if (page === 'codex.cli') {
      if (id === 'install' || id === 'update') {
        await b.startCliJob(id);
        return id === 'install' ? 'Installing Codex…' : 'Checking for a Codex update…';
      }
      if (id === 'restart') {
        await b.restartServer();
        return 'Codex restarted';
      }
    }
  }

  dispose() {
    /* nothing running of its own: the backend owns the polls */
  }
}
