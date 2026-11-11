// OpenCode's settings pages (ports of the app's OpenCodeSettingsScreen.kt — OpenCodeSettingsGroup and its pages Server &
// install, Permissions, Providers, MCP servers — OpenCodeProvidersPage.kt with ProviderSignInSheet / AllProvidersSheet /
// ModelsCard / CustomProviderDialog, and OpenCodeMcpPage.kt). Everything goes to the bridge, with timeouts: a page
// OpenCode can't serve (not installed, bridge down) says so at once.
import type { AiModel } from '../../../shared/model';
import type { SettingFormField, SettingItem, SettingListRow, SettingsPage, SettingsSection } from '../../../shared/protocol';
import type { AgentSettingsProvider } from '../types';
import {
  answer,
  answersFrom,
  attempt as attemptOf,
  formFields,
  integrations as integrationsOf,
  isExternal,
  isKey,
  methodHint,
  methodTitle,
  missing,
  orderedMethods,
  returnsToLoopback,
  signInMethods,
  userCode,
  type Attempt,
  type AuthMethod,
  type Integration,
} from './auth';
import type { OpenCodeCliJob, OpenCodeCredential, OpenCodeCustomModel, OpenCodeCustomProvider, OpenCodeMcpServer } from './client';
import { DEFAULT_AGENTS, MODES, STATE_LABELS, agentDescription, arr, capitalize, errMsg, modeDescription, modeLabel, providerOf, str, type Json } from './common';
import type { OpenCodeBackend } from './OpenCodeBackend';
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
  mcpSummary,
  presetTap,
  presetHeaders,
  presetsItem,
  unavailablePage,
  waitFor,
  withTimeout,
  type McpServerView,
  type McpState,
} from '../agy/settingsKit';

/** A page waits this long for OpenCode's status while it is checked. */
const WAIT_MS = 3_000;
/** A list read from OpenCode is waited for this long; then the page shows what it has and updates later. */
const PAGE_WAIT_MS = 8_000;

const TITLES: Record<string, string> = {
  'opencode.providers': 'Providers',
  'opencode.models': 'Models',
  'opencode.mcp': 'MCP servers',
};

/** Subscriptions people sign in with most, shown first (id → title and hint), as the app's quick tiles. */
const QUICK: [string, string, string][] = [
  ['openai', 'ChatGPT / OpenAI', 'ChatGPT Plus / Pro, or an API key'],
  ['github-copilot', 'GitHub Copilot', 'Your Copilot subscription'],
  ['claude-agent', 'Claude subscription', "Uses Claude Code's login"],
  ['xai', 'SuperGrok / xAI', 'Grok subscription or API key'],
  ['opencode', 'OpenCode Zen', 'OpenCode Console account'],
  ['opencode-go', 'OpenCode Go', "OpenCode's plan · key"],
  ['openrouter', 'OpenRouter', 'Hundreds of models · key'],
  ['anthropic', 'Anthropic API', 'Claude models · key'],
];


/** A running sign-in. */
interface SignIn extends Attempt {
  integrationId: string;
  integrationName: string;
  code: string | null;
  loopback: boolean;
  error: string | null;
  startedAt: number;
}

const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class OpenCodeSettings implements AgentSettingsProvider {
  private integrations: Integration[] | null = null;
  private integrationsError: string | null = null;
  private credentials: OpenCodeCredential[] = [];
  private customs: OpenCodeCustomProvider[] | null = null;
  private mcp: Cached<OpenCodeMcpServer[]>;
  private busy = new Map<string, string>();
  private job: OpenCodeCliJob | null = null;
  private jobPoll: NodeJS.Timeout | null = null;
  private signIn: SignIn | null = null;
  private signInPoll: NodeJS.Timeout | null = null;
  private countsLoading = false;

  constructor(private b: OpenCodeBackend) {
    this.mcp = new Cached(
      () => this.fetchMcp(),
      () => this.changed(),
    );
  }

  private changed() {
    this.b.changed('settings');
  }

  // ------------------------------------------------------------------ root (OpenCodeSettingsGroup)

  rootItem(): SettingItem {
    const st = this.b.ocState;
    const v = this.b.status().version;
    return {
      kind: 'page',
      id: 'opencode',
      label: 'OpenCode',
      icon: 'code',
      description: st === 'ready' ? `${modeLabel(this.b.prefMode())} · ${this.b.models().models.length} models` : STATE_LABELS[st],
      badge: st === 'ready' && v ? v : null,
    };
  }

  /** Counts on the main page (custom providers, MCP servers), loaded in the background. */
  private loadCounts() {
    if (this.countsLoading || this.b.ocState !== 'ready') return;
    this.countsLoading = true;
    void Promise.allSettled([
      withTimeout(this.loadCustoms(), PAGE_WAIT_MS, 'OpenCode'),
      this.mcp.ensure(PAGE_WAIT_MS),
      withTimeout(this.loadIntegrations(), PAGE_WAIT_MS, 'OpenCode'),
    ]).then(() => this.changed());
  }

  /** OpenCode's page: links only, as the app's OpenCodeSettingsGroup (OpenCode CLI / Permissions, Providers, Models,
   *  MCP servers). Built from what is known: instant. */
  private mainPage(): SettingsPage {
    if (this.customs == null || this.mcp.value == null) this.loadCounts();
    const st = this.b.ocState;
    const status = this.b.ocStatus;
    const ready = st === 'ready';
    const connected = this.b.connectedProviders.length + (this.customs?.length ?? 0);
    const all = this.b.allModels.length;
    const shown = this.b.models().models.length;
    const servers = this.mcp.value && !this.mcp.error ? this.mcpViews() : null;
    const v = this.b.status().version;
    return {
      id: 'opencode',
      title: 'OpenCode',
      sections: [
        {
          id: 'cli',
          title: '',
          agent: 'OPENCODE',
          items: [
            {
              kind: 'page',
              id: 'opencode.cli',
              label: 'OpenCode CLI',
              icon: 'terminal',
              description: [STATE_LABELS[st], v ? `OpenCode ${v}` : null, status?.running ? 'server running' : null].filter(Boolean).join(' · '),
              badge: ready ? (v ?? STATE_LABELS[st]) : STATE_LABELS[st],
            },
          ],
        },
        {
          id: 'pages',
          title: '',
          agent: 'OPENCODE',
          items: [
            { kind: 'page', id: 'opencode.permissions', label: 'Permissions', icon: 'tune', description: 'What OpenCode asks before acting, and the agent of new chats', badge: modeLabel(this.b.prefMode()) },
            {
              kind: 'page',
              id: 'opencode.providers',
              label: 'Providers',
              icon: 'cloud',
              description: 'Sign in or add an API key, or add any OpenAI- or Anthropic-compatible API manually',
              badge: connected > 0 ? `${connected} connected` : all ? 'Free models' : null,
            },
            { kind: 'page', id: 'opencode.models', label: 'Models', icon: 'view_list', description: 'Turn providers or models off in the model picker', badge: all ? `${shown}/${all}` : null },
            { kind: 'page', id: 'opencode.mcp', label: 'MCP servers', icon: 'hub', description: 'Tools OpenCode can call', badge: mcpSummary(servers) },
          ],
        },
      ],
    };
  }

  private restartButton(id: string): SettingItem {
    const running = this.b.ocStatus?.running === true;
    return {
      kind: 'button',
      id,
      label: running ? 'Restart OpenCode' : 'Start OpenCode',
      description: 'Running replies stop when OpenCode restarts.',
      confirm: running ? 'Restart OpenCode? Running replies stop.' : null,
    };
  }

  private installButton(id: string): SettingItem {
    const running = this.job?.running === true;
    return {
      kind: 'button',
      id,
      label: running ? 'Installing…' : 'Install OpenCode',
      style: 'primary',
      description:
        process.platform === 'win32'
          ? 'Not from here on Windows: in a terminal run npm install -g opencode-ai, then restart the bridge.'
          : 'Downloads the official build (~250 MB) into ~/.opencode/bin. Or in a terminal: curl -fsSL https://opencode.ai/v2/install | bash',
      disabled: running,
    };
  }

  // ------------------------------------------------------------------ pages

  /** Why OpenCode's pages can't be read now (null = they can). Waits a little while it is checked. */
  private async blocked(): Promise<string | null> {
    if (this.b.ocState === 'checking') await waitFor(() => this.b.ocState !== 'checking', WAIT_MS);
    return this.b.ocState === 'ready' ? null : blockedReason(this.b.status());
  }

  async page(id: string): Promise<SettingsPage | null> {
    if (id === 'opencode') return this.mainPage();
    if (id === 'opencode.cli') {
      // works with OpenCode missing too: it is where it is installed
      await Promise.allSettled([withTimeout(this.b.refreshStatus(), WAIT_MS, 'The bridge'), withTimeout(this.loadJob(), WAIT_MS, 'The bridge')]);
      return this.cliPage();
    }
    if (id === 'opencode.permissions') return this.permissionsPage();
    if (!(id in TITLES)) return null;
    const why = await this.blocked();
    if (why) return unavailablePage(id, TITLES[id], 'OPENCODE', why, { page: 'opencode.cli', label: 'OpenCode CLI', description: 'Install OpenCode, or see why it isn’t running' });
    switch (id) {
      case 'opencode.providers': {
        const r = await Promise.allSettled([this.loadIntegrations(), this.loadCustoms(), this.loadCredentials()].map((p) => withTimeout(p, PAGE_WAIT_MS, 'OpenCode')));
        return { ...this.providersPage(), loading: r.some((x) => x.status === 'rejected') || undefined };
      }
      case 'opencode.models':
        if (!this.b.allModels.length) await withTimeout(this.b.loadModels(), PAGE_WAIT_MS, 'OpenCode').catch(() => undefined);
        return this.modelsPage();
      case 'opencode.mcp': {
        const done = await this.mcp.ensure(PAGE_WAIT_MS);
        return this.mcpPage(!done);
      }
      default:
        return null;
    }
  }

  // --- Permissions (approvals + agent for new chats)

  private permissionsPage(): SettingsPage {
    const agents = this.b.agents.length ? this.b.agents : DEFAULT_AGENTS;
    return {
      id: 'opencode.permissions',
      title: 'Permissions',
      sections: [
        {
          id: 'approvals',
          title: '',
          agent: 'OPENCODE',
          items: [
            {
              kind: 'select',
              id: 'mode',
              label: 'Approvals',
              description: 'What OpenCode asks before doing. Applies to new chats and to the open chats.',
              value: this.b.prefMode(),
              options: MODES.map((m) => ({ value: m, label: modeLabel(m), description: modeDescription(m) })),
            },
            {
              kind: 'select',
              id: 'agent',
              label: 'Agent for new chats',
              description: 'Build makes changes; Plan only reads and plans. Switch any time from the chip above the message box.',
              value: this.b.prefAgent(),
              options: agents.map((a) => ({ value: a.id, label: capitalize(a.name), description: agentDescription(a) })),
            },
          ],
        },
      ],
    };
  }

  // --- Providers

  private async loadIntegrations() {
    try {
      this.integrations = integrationsOf(await this.b.client.get('/integration'));
      this.integrationsError = null;
    } catch (e) {
      this.integrationsError = errMsg(e);
      if (!this.integrations) this.integrations = [];
    }
  }

  private async loadCredentials() {
    try {
      this.credentials = await this.b.client.credentials();
    } catch (e) {
      this.b.log(`[opencode] credentials: ${errMsg(e)}`);
    }
  }

  private async loadCustoms() {
    try {
      this.customs = await this.b.client.customProviders();
    } catch (e) {
      this.b.log(`[opencode] custom providers: ${errMsg(e)}`);
      if (!this.customs) this.customs = [];
    }
  }

  /** One provider as a row whose menu has its sign-in methods (each with its questions as a form). */
  private providerRow(i: Integration, title = i.name, hint?: string): SettingListRow {
    const methods = orderedMethods(i);
    return {
      id: i.id,
      title,
      subtitle: hint ?? ([...new Set(methods.map((m) => (isKey(m) ? 'key' : isExternal(m) ? 'this machine’s login' : 'sign in')))].join(' · ') || null),
      status: i.connections.length ? 'Connected' : null,
      statusTone: i.connections.length ? 'ok' : null,
      actions: methods.map((m) => {
        const form = formFields(m);
        return {
          id: `m:${i.methods.indexOf(m)}`,
          label: `${i.connections.length ? 'Add account · ' : ''}${methodTitle(m)} — ${methodHint(m)}`,
          form: form.length ? form : null,
        };
      }),
    };
  }

  private customForm(p?: OpenCodeCustomProvider): SettingFormField[] {
    return [
      { id: 'name', label: 'Name', kind: 'text', value: p?.name ?? '', placeholder: 'My Ollama', required: true },
      {
        id: 'kind',
        label: 'API',
        kind: 'select',
        value: p?.kind || 'openai',
        options: [
          { value: 'openai', label: 'OpenAI-compatible', description: 'chat/completions (Ollama, LM Studio, vLLM, LiteLLM…)' },
          { value: 'anthropic', label: 'Anthropic-compatible', description: 'messages' },
        ],
      },
      { id: 'base_url', label: 'Base URL', kind: 'text', value: p?.base_url ?? '', placeholder: 'http://localhost:11434/v1', required: true },
      {
        id: 'api_key',
        label: p?.has_api_key ? `API key (blank keeps ${p.api_key_hint ?? 'the saved one'}, "-" clears it)` : 'API key (optional for local servers)',
        kind: 'password',
        value: '',
      },
      {
        id: 'models',
        label: 'Model ids (one per line; leave empty to add every model the endpoint lists)',
        kind: 'multiline',
        value: (p?.models ?? []).map((m) => m.id).join('\n'),
        placeholder: 'llama3.1',
      },
    ];
  }

  private providersPage(): SettingsPage {
    const integ = this.integrations ?? [];
    const byId = new Map(integ.map((i) => [i.id, i]));
    // ---- your providers: every saved account, the one in use, switch / disconnect
    const accounts: SettingListRow[] = [];
    for (const i of integ.filter((x) => x.connections.length)) {
      const creds = this.credentials.filter((c) => c.integrationId === i.id);
      for (const conn of i.connections) {
        const cred = creds.find((c) => c.id === conn.id);
        const active = cred?.active ?? i.connections.length === 1;
        const type = cred?.type ?? conn.method;
        const isCred = conn.id.startsWith('cred');
        accounts.push({
          id: `${i.id}|${conn.id}`,
          title: i.name,
          subtitle: [conn.label, type === 'key' ? 'API key' : type === 'oauth' ? 'Signed in' : type, active && i.connections.length > 1 ? 'in use' : null].filter(Boolean).join(' · '),
          status: active ? 'Connected' : null,
          statusTone: active ? 'ok' : 'muted',
          actions: [
            ...(isCred && !active ? [{ id: 'use', label: 'Use this account' }] : []),
            ...(isCred ? [{ id: 'disconnect', label: 'Disconnect', danger: true, confirm: `Disconnect ${conn.label} from ${i.name}?` }] : []),
            // the app's "Add account": another account of the same provider
            ...(this.providerRow(i).actions ?? []),
          ],
        });
      }
    }
    const accountItems: SettingItem[] = [];
    if (this.integrationsError) accountItems.push({ kind: 'info', id: 'integrationsError', label: 'Providers', value: this.integrationsError, tone: 'error' });
    accountItems.push({
      kind: 'list',
      id: 'accounts',
      label: 'Your providers',
      description: `Sign in with a subscription (ChatGPT, GitHub Copilot, SuperGrok, Claude…) or an API key. Their models then show in the model picker; ${this.b.models().models.length} are available now.`,
      rows: accounts,
      emptyText: "Nothing connected yet: OpenCode's free models work without an account.",
    });

    // ---- a running sign-in
    const sections: SettingsSection[] = [{ id: 'accounts', title: '', agent: 'OPENCODE', items: accountItems }];
    const a = this.signIn;
    if (a) {
      const left = a.expiresAt ? Math.max(0, Math.round((a.expiresAt - Date.now()) / 1000)) : null;
      const items: SettingItem[] = [
        {
          kind: 'info',
          id: 'signIn',
          label: `Signing in to ${a.integrationName}`,
          value: a.error ?? (a.code ? `Enter code ${a.code} on the sign-in page` : 'Waiting for you to finish signing in…'),
          tone: a.error ? 'error' : 'warn',
          description: [a.code ? null : a.instructions, left != null && !a.error ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : null].filter(Boolean).join(' · ') || null,
        },
      ];
      if (a.url && !a.error) items.push({ kind: 'button', id: 'openSignIn', label: a.code ? 'Open the sign-in page again' : 'Open sign-in page', style: 'primary' });
      if ((a.mode === 'code' || a.paste) && !a.error)
        items.push({ kind: 'button', id: 'oauthCode', label: 'Submit the code from the provider', form: [{ id: 'code', label: 'Code from the provider', kind: 'text', required: true }] });
      else if (a.loopback && !a.error)
        items.push({
          kind: 'button',
          id: 'oauthCallback',
          label: 'Finish sign-in from another machine',
          description:
            "Only when the browser ran on another computer than OpenCode (VS Code Remote): it ends on a page that can't load (http://127.0.0.1… or http://localhost…). Copy that whole address and paste it here.",
          form: [{ id: 'url', label: 'Address the browser ended on', kind: 'text', placeholder: 'http://127.0.0.1:…/callback?code=…', required: true }],
        });
      items.push({ kind: 'button', id: 'cancelSignIn', label: a.error ? 'Close' : 'Cancel the sign-in' });
      sections.push({ id: 'signIn', title: '', agent: 'OPENCODE', items });
    }

    // ---- the models of every connected provider, to turn on / off (the app's ModelsCard, under Your providers)
    sections.push({ id: 'models', title: '', agent: 'OPENCODE', items: [this.modelsItem()] });

    // ---- connect: the quick providers, then every provider (each row's menu: its sign-in methods)
    const quick = QUICK.filter(([id]) => byId.has(id) && signInMethods(byId.get(id)!).length).map(([id, title, hint]) => this.providerRow(byId.get(id)!, title, hint));
    const all = integ.filter((i) => signInMethods(i).length);
    sections.push({
      id: 'connect',
      title: '',
      agent: 'OPENCODE',
      items: [
        // the app's Connect card: quick providers as tiles, then every provider behind a search (a tap asks how to sign in)
        { kind: 'list', id: 'quick', label: 'Connect', rows: quick, emptyText: 'No providers yet', display: 'tiles', accent: 'opencode', icon: 'login' },
        {
          kind: 'list',
          id: 'all',
          label: `All ${all.length || ''} providers`,
          rows: all.map((i) => this.providerRow(i)),
          emptyText: 'No providers yet',
          display: 'search',
          searchTitle: 'Connect a provider',
          accent: 'opencode',
        },
      ],
    });

    // ---- manual: any OpenAI- / Anthropic-compatible API by its address
    const customs = this.customs ?? [];
    sections.push({
      id: 'custom',
      title: '',
      agent: 'OPENCODE',
      items: [
        {
          kind: 'list',
          id: 'custom',
          label: 'Manual',
          description: 'Any OpenAI-compatible API (Ollama, LM Studio, vLLM, LiteLLM, a company gateway…) or an Anthropic-compatible one, added by its address. It must be reachable from this machine.',
          rows: customs.map((p) => ({
            id: p.id,
            title: p.name,
            subtitle: `${p.kind === 'anthropic' ? 'Anthropic' : 'OpenAI'}-compatible · ${p.models.length} model${p.models.length === 1 ? '' : 's'}${p.api_key_hint ? ` · key ${p.api_key_hint}` : p.has_api_key ? ' · key set' : ''} · ${p.base_url}`,
            status: null,
            actions: [
              { id: 'edit', label: 'Edit', form: this.customForm(p) },
              { id: 'fetch', label: 'Add every model the endpoint lists' },
              { id: 'remove', label: 'Remove', danger: true, confirm: `Remove ${p.name}?` },
            ],
          })),
          emptyText: 'Nothing added manually',
          addLabel: 'Add manually',
          addForm: this.customForm(),
        },
      ],
    });
    return { id: 'opencode.providers', title: 'Providers', sections };
  }

  // --- Models in the picker (the app's ModelsCard)

  /** The app's ModelsCard: every provider that has models, each with its switch and a switch per model. */
  private modelsItem(): SettingItem {
    const hiddenModels = this.b.hiddenModels();
    const hiddenProviders = this.b.hiddenProviders();
    const groups = new Map<string, AiModel[]>();
    for (const m of this.b.allModels) {
      const pid = providerOf(m.id);
      groups.set(pid, [...(groups.get(pid) ?? []), m]);
    }
    return {
      kind: 'modelGroups',
      id: 'models',
      label: 'Models',
      description: 'Turn providers or single models off to keep them out of the model picker. Tap a provider to see its models.',
      emptyText: this.b.modelsError ?? 'No models yet: connect a provider below (OpenCode\'s free models need none).',
      accent: 'opencode',
      groups: [...groups]
        .sort((x, y) => x[1][0].baseName.toLowerCase().localeCompare(y[1][0].baseName.toLowerCase()))
        .map(([pid, models]) => ({
          id: pid,
          name: models[0].baseName,
          on: !hiddenProviders.has(pid),
          models: models.map((m) => ({ id: m.id, name: m.displayName, detail: m.id.slice(pid.length + 1), on: !hiddenModels.has(m.id) })),
        })),
    };
  }

  private modelsPage(): SettingsPage {
    return {
      id: 'opencode.models',
      title: 'Models',
      sections: [
        {
          id: 'models',
          title: '',
          agent: 'OPENCODE',
          items: [
            this.modelsItem(),
            { kind: 'info', id: 'about', label: 'Kept by AntiGem', value: 'OpenCode itself still has the models you turn off here.', tone: 'muted' },
          ],
        },
      ],
    };
  }

  private setModelsHidden(pid: string, ticked: Set<string>) {
    const ids = this.b.allModels.map((m) => m.id).filter((m) => providerOf(m) === pid);
    const hidden = this.b.hiddenModels();
    for (const m of ids) {
      if (ticked.has(m)) hidden.delete(m);
      else hidden.add(m);
    }
    this.b.store.set('opencode.hiddenModels', [...hidden]);
    this.b.publishModels();
  }

  // --- MCP servers

  private async fetchMcp(): Promise<OpenCodeMcpServer[]> {
    return this.b.client.mcpList();
  }

  /** Add / edit form (a saved server's name cannot change, as in the app). */
  private mcpFormFor(srv?: OpenCodeMcpServer): SettingFormField[] {
    const c = srv?.config ?? {};
    const local = str(c, 'type') === 'local';
    const strs = (o: Json): Record<string, string> =>
      Object.fromEntries(Object.entries((o && typeof o === 'object' ? o : {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    return mcpForm({
      name: srv?.name ?? '',
      nameLocked: !!srv,
      remote: srv ? !local : false,
      command: joinCommand(arr(c, 'command').map((x) => String(x))),
      env: strs(c.environment),
      url: str(c, 'url') ?? '',
      headers: strs(c.headers),
    });
  }

  private mcpViews(): McpServerView[] {
    const views: McpServerView[] = (this.mcp.value ?? []).map((srv) => {
      const c = srv.config;
      const off = c?.enabled === false || srv.status === 'disabled';
      const state: McpState = off
        ? 'off'
        : srv.status === 'connected'
          ? 'connected'
          : srv.status === 'failed'
            ? 'error'
            : srv.status === 'needs_auth' || srv.status === 'needs_client_registration'
              ? 'auth'
              : srv.status === 'pending'
                ? 'connecting'
                : 'idle';
      return {
        name: srv.name,
        state,
        where: c ? (str(c, 'url') ?? (arr(c, 'command').map(String).join(' ') || null)) : null,
        origin: srv.saved ? (srv.status == null && !off ? 'connects with the next chat' : null) : 'from your OpenCode config',
        error: srv.error,
        // OpenCode's status has no tool list
        tools: null,
        // servers of the user's own OpenCode config are shown but changed there
        enabled: srv.saved ? !off : null,
        reconnect: true,
        editForm: srv.saved ? this.mcpFormFor(srv) : null,
        removable: srv.saved,
        busy: this.busy.get(srv.name) ?? null,
      };
    });
    for (const [name, label] of this.busy) if (!views.some((v) => v.name === name)) views.unshift({ name, state: 'connecting', busy: label });
    return views;
  }

  private mcpPage(loading = false): SettingsPage {
    const servers = this.mcp.value ?? [];
    return mcpPage({
      id: 'opencode.mcp',
      agent: 'OPENCODE',
      description: 'Servers added here work in every OpenCode chat and survive restarts; they connect when a chat starts. Servers from your own OpenCode config are shown but changed there.',
      servers: this.mcpViews(),
      error: this.mcpError(),
      addForm: this.mcpFormFor(),
      loading,
      presets: [presetsItem(servers.map((s: any) => ({ name: String(s.name), url: s.url ?? s.config?.url ?? null })), this.mcpFormFor())],
    });
  }

  private mcpError(): string | null {
    return this.mcp.error;
  }

  /** OpenCode's config entry from the form ({type:"local",command,environment} or {type:"remote",url,headers}); an
   *  edit keeps the entry's other fields (enabled, timeout…). */
  private mcpConfig(v: Record<string, string>, old?: Json | null): { name: string; config: Record<string, unknown> } {
    const f = mcpFormValues(v);
    if (!MCP_NAME_RE.test(f.name)) throw new Error('The name may use letters, digits, - and _ (up to 64)');
    const { type: _t, url: _u, headers: _h, command: _c, environment: _e, ...rest } = (old && typeof old === 'object' ? old : {}) as Record<string, unknown>;
    if (!f.remote) return { name: f.name, config: { ...rest, type: 'local', command: f.command, ...(Object.keys(f.env).length ? { environment: f.env } : {}) } };
    return { name: f.name, config: { ...rest, type: 'remote', url: f.url, ...(Object.keys(f.headers).length ? { headers: f.headers } : {}) } };
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
      this.changed();
    }
  }

  // --- Server & install

  private async loadJob() {
    try {
      this.job = await this.b.client.cliJob();
    } catch (e) {
      this.b.log(`[opencode] cli job: ${errMsg(e)}`);
    }
    if (this.job?.running) this.pollJob();
  }

  /** Follows an install / update until it ends (then toasts and reloads, as the app's startCliJob). */
  private pollJob() {
    if (this.jobPoll) return;
    this.jobPoll = setInterval(async () => {
      try {
        this.job = await this.b.client.cliJob();
      } catch {
        return;
      }
      this.changed();
      const j = this.job;
      if (j && !j.running && this.jobPoll) {
        clearInterval(this.jobPoll);
        this.jobPoll = null;
        const ok = j.exit_code === 0;
        this.b.toast(ok ? `OpenCode ${j.kind === 'install' ? 'installed' : 'is up to date'}` : `OpenCode ${j.kind || 'install'} failed`, ok ? 'info' : 'error');
        await this.b.refreshStatus();
        if (ok) {
          void this.b.loadModels();
          void this.b.loadAgents();
          void this.b.refreshSessions();
        }
        this.changed();
      }
    }, 1500);
  }

  private cliPage(): SettingsPage {
    const st = this.b.ocStatus ?? {};
    const state = this.b.ocState;
    const installed = st.installed === true;
    const running = this.job?.running === true;
    const items: SettingItem[] = [
      {
        kind: 'info',
        id: 'state',
        label: 'OpenCode',
        value: [STATE_LABELS[state], st.version, st.running ? 'server running' : null].filter(Boolean).join(' · '),
        tone: state === 'ready' ? 'ok' : state === 'checking' ? 'muted' : state === 'not_installed' ? 'warn' : 'error',
        description: state !== 'ready' && state !== 'checking' ? (this.b.status().detail ?? null) : null,
      },
      { kind: 'info', id: 'binary', label: 'Binary', value: st.binary || '—', tone: 'muted' },
      {
        kind: 'info',
        id: 'server',
        label: 'Server',
        value: st.running ? `Running${st.uptime_seconds ? ` · up ${Math.round(st.uptime_seconds / 60)} min` : ''}` : st.starting ? 'Starting…' : 'Starts with the first chat',
        tone: st.running ? 'ok' : 'muted',
      },
    ];
    if (st.error && (state !== 'ready' || st.running === false)) items.push({ kind: 'info', id: 'error', label: 'Last error', value: st.error, tone: 'error' });
    if (!installed && state === 'not_installed') items.push(this.installButton('install'));
    else if (installed) items.push({ kind: 'button', id: 'update', label: running ? 'Checking…' : 'Check for updates', disabled: running });
    if (this.job) {
      const j = this.job;
      items.push({
        kind: 'info',
        id: 'job',
        label: j.kind === 'update' ? 'Update' : 'Install',
        value: j.running ? 'running…' : j.exit_code === 0 ? 'done' : 'failed',
        tone: j.running ? 'warn' : j.exit_code === 0 ? 'ok' : 'error',
      });
      if (j.log?.trim()) items.push({ kind: 'text', id: 'log', label: 'Log', value: j.log.trim().split('\n').slice(-30).join('\n'), multiline: true, code: true, rows: 10, disabled: true });
    }
    if (state === 'ready') items.push(this.restartButton('restart'));
    items.push({ kind: 'button', id: 'check', label: 'Check again' });
    const sections: SettingsSection[] = [{ id: 'cli', title: '', agent: 'OPENCODE', items }];
    if (st.logs?.length)
      sections.push({ id: 'logs', title: '', agent: 'OPENCODE', items: [{ kind: 'text', id: 'serverLog', label: 'Server log', value: st.logs.slice(-20).join('\n'), multiline: true, code: true, rows: 8, disabled: true }] });
    sections.push({
      id: 'account',
      title: '',
      agent: 'OPENCODE',
      items: [{ kind: 'page', id: 'opencode.providers', label: 'Providers', icon: 'cloud', description: 'No sign-in for OpenCode itself: each provider uses its own account or API key (free models need none).' }],
    });
    return { id: 'opencode.cli', title: 'OpenCode CLI', sections };
  }

  // ------------------------------------------------------------------ edits

  async change(page: string, id: string, value: unknown, rowId?: string): Promise<void> {
    if (page === 'opencode.mcp' && id === MCP_LIST && rowId) {
      await this.setMcpEnabled(rowId, value === true);
      return;
    }
    if (page === 'opencode.permissions') {
      if (id === 'mode') await this.b.setPermissionMode(String(value), 'open');
      else if (id === 'agent') {
        this.b.store.set('opencode.agent', String(value));
        this.b.changed('controls');
      }
      this.changed();
      return;
    }
    if ((page === 'opencode.models' || page === 'opencode.providers') && id === 'models' && rowId) {
      if (rowId.startsWith('provider:')) {
        const pid = rowId.slice('provider:'.length);
        const hidden = this.b.hiddenProviders();
        if (value === true) hidden.delete(pid);
        else hidden.add(pid);
        this.b.store.set('opencode.hiddenProviders', [...hidden]);
      } else if (rowId.startsWith('model:')) {
        const mid = rowId.slice('model:'.length);
        const hidden = this.b.hiddenModels();
        if (value === true) hidden.delete(mid);
        else hidden.add(mid);
        this.b.store.set('opencode.hiddenModels', [...hidden]);
      }
      this.b.publishModels();
      this.changed();
      return;
    }
    if (page === 'opencode.models') {
      if (id.startsWith('provider:')) {
        const pid = id.slice('provider:'.length);
        const hidden = this.b.hiddenProviders();
        if (value === true) hidden.delete(pid);
        else hidden.add(pid);
        this.b.store.set('opencode.hiddenProviders', [...hidden]);
        this.b.publishModels();
      } else if (id.startsWith('models:') && Array.isArray(value)) {
        this.setModelsHidden(id.slice('models:'.length), new Set(value.map(String)));
      }
      this.changed();
    }
  }

  async action(page: string, id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void> {
    if (page === 'opencode') {
      if (id === 'opencode.restart') return this.restart();
      if (id === 'opencode.install') return this.startJob('install');
      return;
    }
    if (page === 'opencode.cli') {
      if (id === 'install' || id === 'update') return this.startJob(id);
      if (id === 'restart') return this.restart();
      if (id === 'check') {
        await Promise.allSettled([this.b.refreshStatus(), this.loadJob()]);
        this.changed();
        return STATE_LABELS[this.b.ocState];
      }
      return;
    }
    if ((page === 'opencode.models' || page === 'opencode.providers') && id === 'models' && rowId && (actionId === 'allOn' || actionId === 'allOff')) {
      this.setModelsHidden(rowId, new Set(actionId === 'allOn' ? this.b.allModels.map((m) => m.id).filter((m) => providerOf(m) === rowId) : []));
      this.changed();
      return;
    }
    if (page === 'opencode.models') {
      const [what, pid] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
      if (what === 'allOn' || what === 'allOff') {
        this.setModelsHidden(pid, new Set(what === 'allOn' ? this.b.allModels.map((m) => m.id).filter((m) => providerOf(m) === pid) : []));
        this.changed();
      }
      return;
    }
    if (page === 'opencode.providers') return this.providerAction(id, rowId, actionId, values);
    if (page === 'opencode.mcp') return this.mcpAction(id, rowId, actionId, values);
  }

  private async restart(): Promise<string> {
    this.b.toast('Restarting OpenCode…', 'info');
    await this.b.client.restart();
    await this.b.refreshStatus();
    void this.b.loadModels();
    void this.b.loadAgents();
    void this.b.refreshSessions();
    return 'OpenCode restarted';
  }

  private async startJob(action: 'install' | 'update'): Promise<string> {
    this.job = await this.b.client.startCliJob(action);
    this.pollJob();
    this.changed();
    return action === 'install' ? 'Installing OpenCode…' : 'Checking for updates…';
  }

  private async addServer(values: Record<string, string>): Promise<string> {
    const { name, config } = this.mcpConfig(values);
    if ((this.mcp.value ?? []).some((s) => s.name === name)) throw new Error(`There is already a server named ${name}`);
    await this.mcpChange(name, 'Saving…', () => this.b.client.putMcp(name, config));
    return `${name} saved`;
  }

  /** A preset tile (the app's OpenCodeMcpPage presets): the bridge's PUT /mcp/<serverName> {type:'remote', url,
   *  headers} or {type:'local', command:[cmd, ...args]}. */
  private async addPreset(tileId: string, values?: Record<string, string>): Promise<string> {
    await this.mcp.ensure(PAGE_WAIT_MS);
    const tap = presetTap(tileId, values, (this.mcp.value ?? []).map((s: any) => ({ name: String(s.name), url: s.url ?? s.config?.url ?? null })));
    if (tap.kind === 'done') return tap.message;
    if (tap.kind === 'custom') {
      if (!values) throw new Error('Fill in the server to add');
      return this.addServer(values);
    }
    const p = tap.preset;
    const headers = presetHeaders(p);
    const config: Record<string, unknown> =
      p.transport === 'stdio' ? { type: 'local', command: [p.command ?? '', ...(p.args ?? [])] } : { type: 'remote', url: p.url ?? '', ...(Object.keys(headers).length ? { headers } : {}) };
    await this.mcpChange(p.serverName, 'Adding…', () => this.b.client.putMcp(p.serverName, config));
    return `Added ${p.name}`;
  }

  /** OpenCode reloads its config: every MCP server reconnects. */
  private async reconnectAll() {
    await withTimeout(this.b.client.post('/location/reload'), 20_000, 'OpenCode');
  }

  private async mcpAction(id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void> {
    if (id === MCP_REFRESH_ALL || (id === MCP_LIST && actionId === MCP_RECONNECT)) {
      if (this.b.ocState !== 'ready') throw new Error(blockedReason(this.b.status()) ?? 'OpenCode is not running');
      // OpenCode has no per-server reconnect: reloading its config reconnects them all
      await this.reconnectAll();
      const done = await this.mcp.reload(PAGE_WAIT_MS);
      this.changed();
      if (this.mcp.error) throw new Error(`Could not read the servers: ${this.mcp.error}`);
      if (!done) return 'Reconnecting… the list updates when OpenCode answers';
      const s = rowId ? (this.mcp.value ?? []).find((x) => x.name === rowId) : null;
      if (s?.status === 'failed') throw new Error(`${rowId}: ${s.error ?? 'failed to connect'}`);
      return rowId ? `Reconnected ${rowId}` : `${(this.mcp.value ?? []).length} servers reconnected`;
    }
    if (id === MCP_PRESETS && actionId) return this.addPreset(actionId, values);
    if (id === MCP_LIST && actionId === 'add' && values) return this.addServer(values);
    if (id !== MCP_LIST || !rowId) return;
    const srv = (this.mcp.value ?? []).find((s) => s.name === rowId);
    if (actionId === MCP_REMOVE) {
      await this.mcpChange(rowId, 'Removing…', () => this.b.client.removeMcp(rowId));
      return `${rowId} removed`;
    }
    if (actionId === MCP_EDIT && values) {
      const { name, config } = this.mcpConfig({ ...values, name: rowId }, srv?.config);
      await this.mcpChange(name, 'Saving…', () => this.b.client.putMcp(name, config));
      return `${name} saved`;
    }
  }

  /** The row's switch: `enabled: false` in the saved entry (OpenCode skips it), removed again to switch it on. */
  private async setMcpEnabled(name: string, on: boolean) {
    const srv = (this.mcp.value ?? []).find((s) => s.name === name);
    if (!srv?.saved || !srv.config) throw new Error(`${name} is in your own OpenCode config: switch it there`);
    const { enabled: _e, ...rest } = srv.config as Record<string, unknown>;
    await this.mcpChange(name, on ? 'Turning on…' : 'Turning off…', () => this.b.client.putMcp(name, on ? rest : { ...rest, enabled: false }));
  }


  private async providerAction(id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void> {
    const after = async () => {
      await Promise.allSettled([this.loadIntegrations(), this.loadCredentials(), this.loadCustoms()]);
      void this.b.loadModels();
      this.changed();
    };
    if (id === 'accounts' && rowId && actionId?.startsWith('m:')) {
      // Add account: rowId is "<provider>|<connection>"
      const integ = (this.integrations ?? []).find((i) => i.id === rowId.slice(0, rowId.indexOf('|')));
      const m = integ?.methods[Number(actionId.slice(2))];
      if (!integ || !m) throw new Error('This provider is not available any more: reopen the page');
      return this.connect(integ, m, values ?? {});
    }
    if (id === 'accounts' && rowId) {
      const credId = rowId.slice(rowId.indexOf('|') + 1);
      const name = this.integrations?.find((i) => i.id === rowId.slice(0, rowId.indexOf('|')))?.name ?? 'the provider';
      if (actionId === 'use') {
        await this.b.client.activateCredential(credId);
        await after();
        return 'Account switched';
      }
      if (actionId === 'disconnect') {
        await this.b.client.removeCredential(credId);
        await after();
        return `${name} disconnected`;
      }
      return;
    }
    if ((id === 'quick' || id === 'all') && rowId && actionId?.startsWith('m:')) {
      const integ = (this.integrations ?? []).find((i) => i.id === rowId);
      const m = integ?.methods[Number(actionId.slice(2))];
      if (!integ || !m) throw new Error('This provider is not available any more: reopen the page');
      return this.connect(integ, m, values ?? {});
    }
    if (id === 'openSignIn' && this.signIn?.url) {
      this.b.openUrl(this.signIn.url);
      return;
    }
    if (id === 'oauthCode' && this.signIn && values?.code?.trim()) {
      await this.b.client.completeOAuth(this.signIn.integrationId, this.signIn.id, values.code.trim());
      return 'Code sent, finishing…';
    }
    if (id === 'oauthCallback' && this.signIn && values?.url?.trim()) {
      await this.b.client.forwardOAuthCallback(values.url.trim());
      return 'Sent to OpenCode, finishing…';
    }
    if (id === 'cancelSignIn' && this.signIn) {
      if (!this.signIn.error) await this.b.client.cancelOAuth(this.signIn.integrationId, this.signIn.id);
      this.endSignIn();
      return;
    }
    if (id === 'custom') {
      if (actionId === 'remove' && rowId) {
        await this.b.client.deleteCustomProvider(rowId);
        await after();
        return 'Provider removed';
      }
      if (actionId === 'fetch' && rowId) {
        const p = (this.customs ?? []).find((x) => x.id === rowId);
        if (!p) return;
        const found = await this.b.client.fetchModels(p.kind, p.base_url, '', p.id);
        if (!found.length) throw new Error('The endpoint listed no models.');
        const known = new Set(p.models.map((m) => m.id));
        const added = found.filter((m) => !known.has(m.id));
        if (!added.length) return 'Every listed model is already added';
        await this.b.client.saveCustomProvider({ ...p, api_key: null, models: [...p.models, ...added] });
        await after();
        return `Added ${added.length} model${added.length === 1 ? '' : 's'}`;
      }
      if ((actionId === 'add' || actionId === 'edit') && values) {
        const old = actionId === 'edit' ? (this.customs ?? []).find((p) => p.id === rowId) : undefined;
        const p = await this.customFromForm(values, old);
        const saved = await this.b.client.saveCustomProvider(p);
        await after();
        return `${saved.name} saved`;
      }
    }
  }

  private async customFromForm(v: Record<string, string>, old?: OpenCodeCustomProvider): Promise<OpenCodeCustomProvider> {
    const name = (v.name ?? '').trim();
    const baseUrl = (v.base_url ?? '').trim();
    const kind = v.kind === 'anthropic' ? 'anthropic' : 'openai';
    const key = (v.api_key ?? '').trim();
    if (!name) throw new Error('Enter a name');
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('The base URL must start with http:// or https://');
    const ids = (v.models ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    let models: OpenCodeCustomModel[] = ids.map((id) => old?.models.find((m) => m.id === id) ?? { id });
    if (!models.length) models = await this.b.client.fetchModels(kind, baseUrl, key === '-' ? '' : key, old?.id ?? '');
    if (!models.length) throw new Error('Add at least one model id (the endpoint listed none)');
    return { ...(old ?? {}), id: old?.id ?? '', name, kind, base_url: baseUrl, api_key: key || null, models };
  }

  // --- provider sign-in (port of ProviderSignInSheet)

  private async connect(integ: Integration, m: AuthMethod, values: Record<string, string>): Promise<string> {
    const answers = answersFrom(m, values);
    const miss = missing(m.form, answers);
    if (miss) throw new Error(`Fill in: ${miss}`);
    const ans = answer(m.form, answers);
    const done = async () => {
      await Promise.allSettled([this.loadIntegrations(), this.loadCredentials()]);
      void this.b.loadModels();
      this.changed();
      return `${integ.name} connected`;
    };
    if (isKey(m)) {
      const key = values.__key?.trim();
      if (!key) throw new Error('Enter the API key');
      await this.b.client.connectKey(integ.id, key, ans);
      return done();
    }
    if (isExternal(m)) {
      await this.b.client.connectExternal(integ.id, m.id ?? '', ans);
      return done();
    }
    this.b.toast(`Opening ${integ.name} sign-in…`, 'info');
    if (this.signIn && !this.signIn.error) await this.b.client.cancelOAuth(this.signIn.integrationId, this.signIn.id);
    const a = attemptOf(await withTimeout(this.b.client.startOAuth(integ.id, m.id ?? '', ans), 30_000, 'OpenCode'));
    if (!a) throw new Error('OpenCode did not start the sign-in');
    const code = userCode(a);
    this.signIn = { ...a, integrationId: integ.id, integrationName: integ.name, code, loopback: returnsToLoopback(a), error: null, startedAt: Date.now() };
    // a device code or a browser page: open it right away (the page shows the code too)
    if (a.url) this.b.openUrl(a.url);
    this.pollSignIn();
    this.changed();
    return code ? `Enter code ${code} on the sign-in page` : 'Finish signing in in your browser…';
  }

  /** Follows the attempt until OpenCode says it is done (or it fails / expires). */
  private pollSignIn() {
    if (this.signInPoll) clearInterval(this.signInPoll);
    this.signInPoll = setInterval(async () => {
      const a = this.signIn;
      if (!a || a.error) return this.stopSignInPoll();
      try {
        const st = await this.b.client.oauthStatus(a.integrationId, a.id);
        if (this.signIn !== a) return;
        if (st.status === 'complete') {
          this.endSignIn();
          this.b.toast(`${a.integrationName} connected`, 'info');
          await Promise.allSettled([this.loadIntegrations(), this.loadCredentials()]);
          void this.b.loadModels();
          this.changed();
          return;
        }
        if (st.status === 'failed') {
          a.error = st.message ?? 'The sign-in failed.';
          this.stopSignInPoll();
          this.changed();
          return;
        }
      } catch {
        /* keep polling */
      }
      if ((a.expiresAt && Date.now() > a.expiresAt) || Date.now() - a.startedAt > 15 * 60_000) {
        a.error = 'The sign-in expired. Start it again.';
        this.stopSignInPoll();
        this.changed();
      }
    }, 2000);
  }

  private stopSignInPoll() {
    if (this.signInPoll) clearInterval(this.signInPoll);
    this.signInPoll = null;
  }

  private endSignIn() {
    this.stopSignInPoll();
    this.signIn = null;
    this.changed();
  }

  dispose() {
    if (this.jobPoll) clearInterval(this.jobPoll);
    this.jobPoll = null;
    this.stopSignInPoll();
    // a sign-in left open is cancelled
    const a = this.signIn;
    if (a && !a.error) void this.b.client.cancelOAuth(a.integrationId, a.id);
  }
}
