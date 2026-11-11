// Antigravity's settings pages (ports of the app's Antigravity settings: Account & CLI — agy install / update, the
// Google account and usage limits —, MCP Servers + the Cascade MCP catalog, Skills & Plugins with scopes and the store,
// Commands & Permissions with project overrides). Everything goes to the hub (gRPC) or the bridge, with timeouts: a
// page whose hub is down says so at once instead of waiting.
//
// Writes to the hub's settings never encode a decoded config: they patch the hub's own stored bytes (patchMessage),
// so fields this proto copy does not know, and explicit false / 0 values, stay exactly as they were.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SettingFormField, SettingItem, SettingListRow, SettingsPage, SettingsSection } from '../../../shared/protocol';
import type { AgentSettingsProvider } from '../types';
import type { AgyBackend } from './AgyBackend';
import { applyQuota } from './quota';
import { uriToPath } from '../paths';
import { decodeAs, encodeAs, lengthDelimited, patchMessage, rawFields } from './proto';
import {
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
  presetHeaders,
  presetTap,
  presetsItem,
  timeoutSignal,
  unavailablePage,
  withTimeout,
  type McpServerView,
  type McpState,
} from './settingsKit';

/** A settings page waits this long for a hub that is still starting, then says it is down. */
const WAIT_ONLINE_MS = 3_000;
/** One hub read of a settings page. */
const HUB_READ_MS = 8_000;
/** One hub write. */
const HUB_WRITE_MS = 20_000;
/** One bridge read (agy CLI, MCP config). */
const BRIDGE_READ_MS = 6_000;

const TITLES: Record<string, string> = {
  'agy.cli': 'Account & CLI',
  'agy.permissions': 'Commands & Permissions',
  'agy.mcp': 'MCP Servers',
  'agy.mcp.catalog': 'MCP catalog',
  'agy.skills': 'Skills & Plugins',
};

const AUTO_OFF = 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF';
const AUTO_SMART = 'CASCADE_COMMANDS_AUTO_EXECUTION_AUTO';
const AUTO_EAGER = 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER';
const FILE_ASK = 'AGENT_SETTING_POLICY_ASK';
const FILE_ALLOW = 'AGENT_SETTING_POLICY_ALLOW';

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const PRESETS: { value: string; label: string; description: string; auto: string; files: boolean }[] = [
  { value: 'default', label: 'Default', description: 'Asks before running commands and before touching files outside the workspace', auto: AUTO_OFF, files: false },
  { value: 'machine', label: 'Full Machine', description: 'Asks before commands; may read and write files anywhere on this machine', auto: AUTO_OFF, files: true },
  { value: 'turbo', label: 'Turbo', description: 'Runs commands and touches files anywhere without asking', auto: AUTO_EAGER, files: true },
];

const GRANT_ACTIONS = [
  { value: 'command', label: 'Command', description: 'Shell commands, e.g. npm test*' },
  { value: 'mcp', label: 'MCP tool', description: 'server/tool, e.g. github/*' },
  { value: 'read_file', label: 'Read file', description: 'Path pattern, e.g. /home/me/**' },
  { value: 'write_file', label: 'Write file', description: 'Path pattern' },
];

const SKILL_SCOPES = [
  { value: 'GLOBAL', label: 'Global (Default)', description: 'Built-in, installed and your own skills' },
  { value: 'WORKSPACE', label: 'Project / Workspace', description: 'Skills in the project folder (.agents/skills/)' },
  { value: 'ALL', label: 'All', description: 'Both' },
];

const CATEGORY_LABEL: Record<string, string> = {
  DISCOVERY_CATEGORY_BUILTIN: 'Built-in',
  DISCOVERY_CATEGORY_INSTALLED: 'Installed',
  DISCOVERY_CATEGORY_CONFIG: 'Config',
  DISCOVERY_CATEGORY_WORKSPACE: 'Workspace',
  DISCOVERY_CATEGORY_GOOGLE3: 'Google',
};

interface Auth {
  loggedIn: boolean;
  email: string;
  name: string;
  tier: string;
  plan: string;
  upgradeUri: string;
  upgradeText: string;
  promptCredits: number | null;
  flowCredits: number | null;
}

interface ProjectRow {
  id: string;
  name: string;
  folder: string;
  auto: string | null;
  files: string | null;
  review: string | null;
  sandbox: boolean;
}

const firstLine = (s?: string) =>
  (s ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) ?? null;

/** "1.0.9" < "1.0.10" */
function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((x) => Number(x) || 0);
  const pb = b.split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

export class AgySettings implements AgentSettingsProvider {
  private user: any = null; // JetboxState_UserSettings as the hub returned it (decoded, for display only)
  private rawUserConfig: Uint8Array | null = null; // the UserConfig's exact bytes: writes patch these
  private auth: Auth | null = null;
  private authLoading: Promise<void> | null = null;
  private authTriedAt = 0;
  private signingIn: { url: string; started: number } | null = null;
  private mcp: { states: any[]; configPath: string; config: any; error: string | null; configRead: boolean } | null = null;
  private catalog: { query: string; plugins: any[]; error: string | null } | null = null;
  private skillScope: 'GLOBAL' | 'WORKSPACE' | 'ALL' = 'GLOBAL';
  private skills: any[] | null = null;
  private plugins: any[] | null = null;
  private store: any[] | null = null;
  private projects: ProjectRow[] | null = null;
  private cli: any = null;
  private cliLoading: Promise<void> | null = null;
  private cliTriedAt = 0;
  private summariesTriedAt = 0;
  private loginPoll: NodeJS.Timeout | null = null;
  private cliPoll: NodeJS.Timeout | null = null;

  constructor(private b: AgyBackend) {
    const saved = b.store.get<string>('agy.skillScope');
    if (saved === 'WORKSPACE' || saved === 'ALL') this.skillScope = saved;
  }

  private changed() {
    this.b.notifySettings();
  }

  private err(e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }

  // ------------------------------------------------------------------ hub & bridge access (with timeouts)

  /** Why the hub can't be asked now (what a page or a button says). */
  private downReason(): string {
    return blockedReason(this.b.status()) ?? "Antigravity isn't running";
  }

  /** The hub answers (waits a little for one that is starting); otherwise fails at once with the reason. */
  private async online(): Promise<void> {
    if (!(await this.b.waitOnline(WAIT_ONLINE_MS))) throw new Error(this.downReason());
  }

  private async hub<T = any>(name: string, req: object, timeoutMs = HUB_READ_MS): Promise<T> {
    await this.online();
    return this.b.callHub<T>(name, req, timeoutMs);
  }

  private async hubRaw(name: string, request: Uint8Array, timeoutMs = HUB_WRITE_MS): Promise<Buffer> {
    await this.online();
    return this.b.callHubRaw(name, request, timeoutMs);
  }

  private async rpc() {
    await this.online();
    return this.b.rpcReady();
  }

  private bridge<T = any>(p: string, init: RequestInit = {}, timeoutMs = BRIDGE_READ_MS): Promise<T> {
    return this.b.bridgeJson<T>(p, { ...init, signal: init.signal ?? timeoutSignal(timeoutMs) });
  }

  // ------------------------------------------------------------------ account & CLI (also used by the backend)

  /** true / false once known, null while unknown (the hub not asked yet). */
  signedIn(): boolean | null {
    return this.auth ? this.auth.loggedIn : null;
  }

  /** The account line of the agent status (email, else name). */
  accountLabel(): string | null {
    if (!this.auth?.loggedIn) return null;
    return this.auth.email || this.auth.name || null;
  }

  /** The subscription ("Google AI Pro"): the user tier, else the plan name (the app's Accounts dialog). */
  planLabel(): string | null {
    if (!this.auth?.loggedIn) return null;
    return this.auth.tier || this.auth.plan || null;
  }

  /** agy installed (the bridge's check): true / false, null while unknown or the check failed. */
  cliInstalled(): boolean | null {
    if (!this.cli || this.cli.error) return null;
    return this.cli.installed === true;
  }

  /** "1.5.4" (the version part of `agy --version`), as the app's Accounts dialog. */
  cliVersion(): string | null {
    if (!this.cli?.installed) return null;
    const v = String(this.cli.version ?? '').trim();
    return v.match(/\d+(\.\d+)+\S*/)?.[0] ?? (v || null);
  }

  /** Reads the account again (hub online, a send while signed out). */
  refreshAuth(): Promise<void> {
    if (!this.authLoading) {
      this.authTriedAt = Date.now();
      this.authLoading = this.loadAuth().finally(() => {
        this.authLoading = null;
      });
    }
    return this.authLoading;
  }

  /** Pages that show the account read it once the hub runs (not again and again when that fails). */
  private ensureAuth() {
    if (!this.auth && this.b.status().state === 'online' && Date.now() - this.authTriedAt > 15_000) void this.refreshAuth();
  }

  /** The hub's command auto-run setting, read once the hub is online (prompts carry it, as the app's saved policy). */
  async syncUserSettings() {
    await this.loadUser().catch((e) => this.b.log(`[agy] user settings: ${this.err(e)}`));
  }

  private async loadAuth() {
    const before = JSON.stringify(this.auth);
    const wasIn = this.auth?.loggedIn;
    try {
      const st = await this.hub('GetAuthStatus', {});
      const loggedIn = st.auth_result?.has_valid_auth === true;
      const a: Auth = { loggedIn, email: '', name: '', tier: '', plan: '', upgradeUri: '', upgradeText: '', promptCredits: null, flowCredits: null };
      if (loggedIn) {
        try {
          const res = await this.hub('GetUserStatus', { metadata: {} });
          const us = res.user_status ?? {};
          const clean = (v: unknown) => (typeof v === 'string' && v !== 'null' ? v : '');
          a.email = clean(us.email);
          a.name = clean(us.name);
          a.tier = us.user_tier?.name || us.user_tier?.description || '';
          a.upgradeUri = us.user_tier?.upgrade_subscription_uri || '';
          a.upgradeText = us.user_tier?.upgrade_subscription_text || '';
          const plan = us.plan_status?.plan_info ?? us.plan_info ?? res.plan_info;
          a.plan = plan?.plan_name || '';
          if (us.plan_status) {
            a.promptCredits = Number(us.plan_status.available_prompt_credits ?? 0);
            a.flowCredits = Number(us.plan_status.available_flow_credits ?? 0);
          }
        } catch {
          /* status only */
        }
      }
      this.auth = a;
    } catch (e) {
      // unreachable: keep what was known (the app keeps the auth state on a network failure)
      this.b.log(`[agy] auth: ${this.err(e)}`);
    }
    if (JSON.stringify(this.auth) === before) return;
    this.changed();
    this.b.notifyStatus();
    if (wasIn !== this.auth?.loggedIn) this.b.notifyModels();
  }

  /** The bridge's agy check (installed, path, version, a running install / update). */
  refreshCli(): Promise<void> {
    if (!this.cliLoading) {
      this.cliTriedAt = Date.now();
      const before = JSON.stringify([this.cliInstalled(), this.cliVersion()]);
      this.cliLoading = this.loadCli()
        .then(() => {
          if (JSON.stringify([this.cliInstalled(), this.cliVersion()]) === before) return;
          this.b.notifyStatus();
          this.changed();
        })
        .finally(() => {
          this.cliLoading = null;
        });
    }
    return this.cliLoading;
  }

  // ------------------------------------------------------------------ root section

  /** "you@gmail.com · Google AI Pro" / "Not signed in" / why Antigravity isn't running. */
  private accountSummary(): string {
    const st = this.b.status();
    if (st.state === 'not_installed') return 'agy is not installed';
    if (st.state === 'starting') return 'Starting…';
    if (st.state !== 'online') return st.detail ?? 'Not running';
    if (this.signingIn) return 'Signing in…';
    if (!this.auth) return 'Online';
    if (!this.auth.loggedIn) return 'Not signed in';
    return [this.auth.email || this.auth.name || 'Signed in', this.planLabel()].filter(Boolean).join(' · ');
  }

  /** The "Antigravity" row on the settings root (opens the agy page). */
  rootItem(): SettingItem {
    this.ensureAuth();
    const v = this.cliVersion();
    return { kind: 'page', id: 'agy', label: 'Antigravity', icon: 'rocket_launch', description: this.accountSummary(), badge: v ? `agy ${v}` : null };
  }

  private policyLabel(): string | null {
    const p = this.b.store.get<string>('agy.autoExecPolicy');
    if (!p) return null;
    return p.includes('EAGER') ? 'Auto-run' : p.includes('AUTO') ? 'Smart safety' : 'Ask first';
  }

  /**
   * Antigravity's own page: links only (the app's AntigravitySettingsMenu). Account & CLI first (install, account,
   * usage limits), then MCP Servers, Skills & Plugins, Commands & Permissions. Built from what is known: instant.
   */
  private mainPage(): SettingsPage {
    this.ensureAuth();
    if (!this.cli && Date.now() - this.cliTriedAt > 15_000) void this.refreshCli();
    const online = this.b.status().state === 'online';
    // the rows' values ("2 active", "17 skills · 1 plugin") load once in the background while the hub runs
    if (online && (!this.mcp || !this.skills) && Date.now() - this.summariesTriedAt > 30_000) {
      this.summariesTriedAt = Date.now();
      void Promise.allSettled([this.mcp ? null : this.loadMcp(), this.skills ? null : this.loadSkills()]).then(() => this.changed());
    }
    const installed = this.cliInstalled();
    const v = this.cliVersion();
    const servers = this.mcp && !this.mcp.error ? this.mcpViews() : null;
    return {
      id: 'agy',
      title: 'Antigravity',
      sections: [
        {
          id: 'cli',
          title: '',
          agent: 'AGY',
          items: [
            {
              kind: 'page',
              id: 'agy.cli',
              label: 'Account & CLI',
              icon: 'account',
              description: this.accountSummary(),
              badge: v ? `agy ${v}` : installed === false ? 'Not installed' : null,
            },
          ],
        },
        {
          id: 'pages',
          title: '',
          agent: 'AGY',
          items: [
            { kind: 'page', id: 'agy.mcp', label: 'MCP Servers', icon: 'hub', description: 'Model Context Protocol tools & integrations', badge: mcpSummary(servers) },
            {
              kind: 'page',
              id: 'agy.skills',
              label: 'Skills & Plugins',
              icon: 'auto_awesome',
              description: 'Agent capabilities, Google plugins, and extensions',
              badge: this.skills ? `${this.skills.length} skills · ${this.plugins?.length ?? 0} plugin${this.plugins?.length === 1 ? '' : 's'}` : null,
            },
            { kind: 'page', id: 'agy.permissions', label: 'Commands & Permissions', icon: 'shield', description: 'Auto-run policy, sandbox mode, and tool approvals', badge: this.policyLabel() },
          ],
        },
      ],
    };
  }

  // ------------------------------------------------------------------ pages

  async page(id: string): Promise<SettingsPage | null> {
    if (id === 'agy') return this.mainPage();
    if (id === 'agy.cli') {
      // works with the hub down too: it is where agy is installed or fixed
      await Promise.allSettled([this.loadCli(), this.b.status().state === 'online' && !this.auth ? withTimeout(this.refreshAuth(), HUB_READ_MS, 'Antigravity') : null]);
      return this.cliPage();
    }
    if (!(id in TITLES)) return null;
    // every other page reads the hub: when it is down, say so at once (with the way to fix it)
    if (!(await this.b.waitOnline(WAIT_ONLINE_MS)))
      return unavailablePage(id, TITLES[id], 'AGY', this.downReason(), { page: 'agy.cli', label: 'Account & CLI', description: 'Install agy, or see why Antigravity isn’t running' });
    switch (id) {
      case 'agy.permissions':
        // always the hub's current values (also confirms a write took effect)
        await Promise.all([this.loadUser(), this.loadProjects()]);
        return this.permissionsPage();
      case 'agy.mcp':
        await this.loadMcp();
        return this.mcpPage();
      case 'agy.mcp.catalog':
        await Promise.all([this.catalog ? null : this.loadCatalog(''), this.mcp ? null : this.loadMcp()]);
        return this.catalogPage();
      case 'agy.skills':
        await this.loadSkills();
        return this.skillsPage();
      default:
        return null;
    }
  }

  // --- Commands & Permissions

  /** Reads the hub's user settings (JetboxSubscribeToState's first frame), keeping the UserConfig's exact bytes. */
  private async loadUser() {
    const ac = new AbortController();
    let got = false;
    try {
      const rpc = await this.rpc();
      await Promise.race([
        rpc.streamRaw(
          'JetboxSubscribeToState',
          {},
          (buf: Buffer) => {
            if (got) return;
            got = true;
            // JetboxSubscribeToStateResponse field 3 = user_config (kept as raw bytes)
            const raw = rawFields(buf).find((f) => f.id === 3)?.payload ?? null;
            this.rawUserConfig = raw ? Uint8Array.from(raw) : new Uint8Array(0);
            const cfg = raw ? decodeAs('UserConfig', raw) : {};
            this.user = cfg?.user_settings ?? {};
            ac.abort();
          },
          ac.signal,
        ),
        new Promise((r) => setTimeout(r, 6000)),
      ]);
    } catch (e) {
      this.b.log(`[agy] user settings: ${this.err(e)}`);
    } finally {
      ac.abort();
    }
    if (!got) {
      this.user = this.user ?? {};
      return;
    }
    // prompts carry the hub's auto-run policy (the app's saved commandAutoExecutionPolicy); unset = the app's default
    const p = this.user?.auto_execution_policy;
    this.b.store.set('agy.autoExecPolicy', typeof p === 'string' && p !== 'CASCADE_COMMANDS_AUTO_EXECUTION_UNSPECIFIED' ? p : '');
  }

  /**
   * Changes some user settings: the hub's own stored bytes with only these fields replaced, so every other value
   * (including fields this proto copy does not know, and explicit false values the hub's migrations rely on) is kept.
   */
  private async writeUser(patch: Record<string, unknown>) {
    // always from the hub's current bytes, read just now
    await this.online();
    this.rawUserConfig = null;
    await this.loadUser();
    if (!this.rawUserConfig) throw new Error("Couldn't read the current Antigravity settings, nothing was changed");
    const fields = rawFields(this.rawUserConfig);
    const settingsRaw = fields.find((f) => f.id === 2)?.payload ?? new Uint8Array(0);
    const newSettings = patchMessage('JetboxState_UserSettings', settingsRaw, patch);
    const others = fields.filter((f) => f.id !== 2).map((f) => f.bytes);
    const userConfig = concat([...others, lengthDelimited(2, newSettings)]);
    const request = lengthDelimited(3, userConfig); // JetboxWriteStateRequest.user_config = 3
    this.user = { ...(this.user ?? {}), ...patch };
    if (typeof patch.auto_execution_policy === 'string') this.b.store.set('agy.autoExecPolicy', patch.auto_execution_policy);
    this.changed();
    try {
      await this.hubRaw('JetboxWriteState', request);
    } catch (e) {
      await this.loadUser();
      this.changed();
      throw e;
    }
  }

  private presetOf(auto: string | null | undefined, files: boolean): string {
    const a = auto ?? AUTO_OFF;
    return PRESETS.find((p) => p.auto === a && p.files === files)?.value ?? 'custom';
  }

  private grants(): { decision: 'allow' | 'deny' | 'ask'; rule: string }[] {
    const g = this.user?.global_permission_grants ?? {};
    return [
      ...(g.allow ?? []).map((rule: string) => ({ decision: 'allow' as const, rule })),
      ...(g.ask ?? []).map((rule: string) => ({ decision: 'ask' as const, rule })),
      ...(g.deny ?? []).map((rule: string) => ({ decision: 'deny' as const, rule })),
    ];
  }

  // the hub's projects (ProjectUpdatesStream ids + ReadProjects), for the per-project overrides
  private async projectIds(): Promise<string[]> {
    const ac = new AbortController();
    let ids: string[] = [];
    try {
      const rpc = await this.rpc();
      await Promise.race([
        rpc.stream(
          'ProjectUpdatesStream',
          {},
          (resp: any) => {
            if (resp.project_list?.project_ids?.length) ids = resp.project_list.project_ids;
            ac.abort();
          },
          ac.signal,
        ),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch (e) {
      this.b.log(`[agy] projects: ${this.err(e)}`);
    } finally {
      ac.abort();
    }
    return ids.length ? ids : ['default-cli-project', 'outside-of-project'];
  }

  private async loadProjects() {
    try {
      const res = await this.hub('ReadProjects', { ids: await this.projectIds() });
      const unset = (v: unknown) => (typeof v === 'string' && !v.endsWith('_UNSPECIFIED') ? v : null);
      this.projects = (res.projects ?? [])
        .filter((p: any) => p.id !== 'outside-of-project')
        .map((p: any) => {
          const r = p.project_resources?.resources?.[0];
          const folder = uriToPath(String(r?.folder_uri ?? r?.git_folder?.folder_uri ?? ''));
          return {
            id: p.id,
            name: p.name || p.id,
            folder,
            auto: unset(p.settings?.auto_execution_policy),
            files: unset(p.settings?.file_access_policy),
            review: unset(p.settings?.artifact_review_mode),
            sandbox: p.settings?.sandbox_mode === true,
          };
        });
    } catch (e) {
      this.b.log(`[agy] projects: ${this.err(e)}`);
      this.projects = this.projects ?? [];
    }
  }

  /**
   * A project's override (the app's updateProjectPreset / setProjectInheritGlobal): the hub's stored project bytes
   * with only its settings' policies replaced (inherit = those policies cleared), everything else kept.
   */
  private async writeProject(id: string, preset: (typeof PRESETS)[number] | null) {
    const raw = await this.hubRaw('ReadProjects', encodeAs('ReadProjectsRequest', { ids: [id] }));
    const project = rawFields(raw)
      .filter((f) => f.id === 1 && f.payload)
      .map((f) => f.payload!)
      .find((p) => {
        const idField = rawFields(p).find((x) => x.id === 1)?.payload;
        return idField && Buffer.from(idField).toString('utf8') === id;
      });
    if (!project) throw new Error(`The hub has no project "${id}"`);
    const fields = rawFields(project);
    const settingsRaw = fields.find((f) => f.id === 10)?.payload ?? new Uint8Array(0); // Project.settings = 10
    const patch: Record<string, unknown> = preset
      ? { auto_execution_policy: preset.auto, file_access_policy: preset.files ? FILE_ALLOW : FILE_ASK }
      : { auto_execution_policy: 0, file_access_policy: 0, artifact_review_mode: 0, sandbox_mode: false };
    const settings = patchMessage('ProjectSettings', settingsRaw, patch);
    const newProject = concat([...fields.filter((f) => f.id !== 10).map((f) => f.bytes), lengthDelimited(10, settings)]);
    await this.hubRaw('UpdateProject', lengthDelimited(1, newProject)); // UpdateProjectRequest.project = 1
  }

  private permissionsPage(): SettingsPage {
    const u = this.user ?? {};
    const preset = this.presetOf(u.auto_execution_policy, u.allow_agent_access_non_workspace_files === true);
    const grantForm: SettingFormField[] = [
      { id: 'action', label: 'Applies to', kind: 'select', value: 'command', options: GRANT_ACTIONS },
      { id: 'pattern', label: 'Pattern', kind: 'text', placeholder: 'npm test*', required: true },
      {
        id: 'decision',
        label: 'Decision',
        kind: 'select',
        value: 'allow',
        options: [
          { value: 'allow', label: 'Allow' },
          { value: 'ask', label: 'Ask' },
          { value: 'deny', label: 'Deny' },
        ],
      },
    ];
    const terminal = u.auto_execution_policy === AUTO_EAGER ? 'auto' : u.auto_execution_policy === AUTO_SMART ? 'smart' : 'ask';
    const projects = this.projects ?? [];
    const projectRows: SettingListRow[] = projects.map((p) => {
      const inherits = !p.auto && !p.files && !p.review && !p.sandbox;
      const own = inherits ? null : PRESETS.find((x) => x.auto === (p.auto ?? AUTO_OFF) && x.files === (p.files === FILE_ALLOW));
      return {
        id: p.id,
        title: p.name,
        subtitle: p.folder || null,
        status: inherits ? 'Inherits global' : (own?.label ?? 'Custom'),
        statusTone: inherits ? 'muted' : 'warn',
        actions: [
          ...(inherits ? [] : [{ id: 'inherit', label: 'Inherit global settings' }]),
          ...PRESETS.filter((x) => x !== own || inherits).map((x) => ({ id: x.value, label: `Set to ${x.label}` })),
        ],
      };
    });
    return {
      id: 'agy.permissions',
      title: 'Commands & Permissions',
      sections: [
        {
          id: 'preset',
          title: '',
          description: 'Security preset: live hub settings, applied across all workspaces',
          agent: 'AGY',
          items: [
            {
              kind: 'select',
              id: 'preset',
              label: 'Preset',
              value: preset,
              options: [...PRESETS.map((p) => ({ value: p.value, label: p.label, description: p.description })), { value: 'custom', label: 'Custom', description: 'Your own mix (below)' }],
            },
            {
              kind: 'select',
              id: 'terminal',
              label: 'Terminal commands',
              value: terminal,
              options: [
                { value: 'ask', label: 'Ask first' },
                ...(terminal === 'smart' ? [{ value: 'smart', label: 'Smart safety' }] : []),
                { value: 'auto', label: 'Auto-run' },
              ],
            },
            {
              kind: 'select',
              id: 'files',
              label: 'Files outside the workspace',
              value: u.allow_agent_access_non_workspace_files ? 'allow' : 'ask',
              options: [
                { value: 'ask', label: 'Ask first' },
                { value: 'allow', label: 'Allow' },
              ],
            },
            {
              kind: 'toggle',
              id: 'sandbox',
              label: 'Terminal sandbox isolation',
              description: u.enable_terminal_sandbox ? 'Commands run in a sandbox without host network access' : 'Commands run directly on this machine',
              value: u.enable_terminal_sandbox === true,
            },
          ],
        },
        {
          id: 'artifacts',
          title: '',
          items: [
            {
              kind: 'select',
              id: 'artifactReview',
              label: 'Artifact review',
              description: 'Plans and other artifacts the agent asks you to review',
              value: u.artifact_review_mode === 'ARTIFACT_REVIEW_MODE_TURBO' ? 'turbo' : 'always',
              options: [
                { value: 'turbo', label: 'Auto (Turbo)', description: 'Continue without waiting for a review' },
                { value: 'always', label: 'Always ask', description: 'Wait for your review' },
              ],
            },
          ],
        },
        {
          id: 'rules',
          title: '',
          items: [
            {
              kind: 'list',
              id: 'grants',
              label: 'Permission rules',
              description: 'Always allow, ask or deny matching actions (e.g. command(npm test*))',
              emptyText: 'No rules yet: tools and files follow the preset above',
              rows: this.grants().map((g) => ({
                id: `${g.decision}:${g.rule}`,
                title: g.rule,
                status: g.decision === 'allow' ? 'Allow' : g.decision === 'deny' ? 'Deny' : 'Ask',
                statusTone: g.decision === 'allow' ? 'ok' : g.decision === 'deny' ? 'error' : 'warn',
                actions: [
                  ...(['allow', 'ask', 'deny'] as const).filter((d) => d !== g.decision).map((d) => ({ id: d, label: `Change to ${d[0].toUpperCase()}${d.slice(1)}` })),
                  { id: 'remove', label: 'Remove', danger: true },
                ],
              })),
              addLabel: 'Add rule',
              addForm: grantForm,
            },
          ],
        },
        {
          id: 'projects',
          title: '',
          description: `Projects inherit the global preset or keep their own (${projects.filter((p) => !p.auto && !p.files && !p.review && !p.sandbox).length}/${projects.length} inheriting)`,
          items: [{ kind: 'list', id: 'projects', label: 'Project overrides', rows: projectRows, emptyText: 'No projects registered on the hub yet' }],
        },
        {
          id: 'approvals',
          title: '',
          items: [
            {
              kind: 'select',
              id: 'defaultScope',
              label: 'Default approval scope',
              description: 'How long an approval lasts when the card does not say',
              value: this.b.store.get<string>('agy.defaultScope') ?? 'once',
              options: [
                { value: 'once', label: 'Run once', description: 'Single call' },
                { value: 'conversation', label: 'This chat', description: 'Current session' },
                { value: 'project', label: 'Workspace', description: 'Always in this project' },
              ],
            },
          ],
        },
      ],
    };
  }

  // --- MCP

  /** The hub's live servers (status, tools) and mcp_config.json (the bridge reads and writes it). */
  private async loadMcp() {
    let error: string | null = null;
    let configRead = true;
    const [states, cfg] = await Promise.all([
      this.hub('GetMcpServerStates', {}).catch((e) => {
        error = this.err(e);
        return { states: this.mcp?.states ?? [] };
      }),
      this.bridge('/api/mcp/config').catch((e) => {
        error = error ?? this.err(e);
        configRead = false;
        return { path: this.mcp?.configPath ?? '', content: this.mcp ? JSON.stringify(this.mcp.config) : '{"mcpServers":{}}' };
      }),
    ]);
    let config: any = {};
    try {
      config = JSON.parse(cfg.content || '{}');
    } catch {
      // a file that isn't JSON is never written over
      config = { mcpServers: {} };
      configRead = false;
      error = error ?? `${cfg.path || 'mcp_config.json'} is not valid JSON`;
    }
    if (!config.mcpServers) config.mcpServers = {};
    this.mcp = { states: states.states ?? [], configPath: cfg.path ?? '', config, error, configRead };
  }

  /** mcp_config.json as it is now, for a change (another window may have changed it); a change is never made from a
   *  file that could not be read. */
  private async mcpForWrite() {
    await this.loadMcp();
    if (!this.mcp?.configRead) throw new Error(`Couldn't read the MCP config${this.mcp?.error ? ` (${this.mcp.error})` : ''}, nothing was changed`);
    return this.mcp;
  }

  /** Configured servers with their URLs (presets tell "added" from "added with another address"). */
  private mcpEntries(): { name: string; url: string | null }[] {
    const cfg = (this.mcp?.config.mcpServers ?? {}) as Record<string, any>;
    return this.mcpNames().map((name) => ({ name, url: cfg[name]?.serverUrl ?? cfg[name]?.url ?? null }));
  }

  private mcpNames(): string[] {
    const m = this.mcp;
    if (!m) return [];
    return [...new Set<string>([...Object.keys(m.config.mcpServers ?? {}), ...m.states.map((s) => s.spec?.server_name).filter(Boolean)])].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
  }

  /** The add / edit form (mcp_config.json: command + args + env, or serverUrl + headers). */
  private mcpFormFor(name = '', spec: any = {}): SettingFormField[] {
    const remote = !!(spec.serverUrl || spec.url);
    return mcpForm({
      name,
      remote,
      command: spec.command ? joinCommand([spec.command, ...(spec.args ?? []).map(String)]) : '',
      env: spec.env,
      url: spec.serverUrl ?? spec.url ?? '',
      headers: spec.headers,
    });
  }

  private mcpViews(): McpServerView[] {
    const m = this.mcp ?? { states: [], configPath: '', config: { mcpServers: {} }, error: null };
    return this.mcpNames().map((name) => {
      const st = m.states.find((s) => s.spec?.server_name === name);
      const cfg = m.config.mcpServers?.[name];
      const disabled = cfg?.disabled === true || st?.spec?.disabled === true;
      const status: string = st?.status ?? '';
      const tools: any[] = st?.tools ?? [];
      const state: McpState = disabled
        ? 'off'
        : status.includes('READY') || status.includes('CONNECTED')
          ? 'connected'
          : status.includes('ERROR')
            ? 'error'
            : status.includes('PENDING')
              ? 'connecting'
              : status.includes('DISABLED')
                ? 'off'
                : 'idle';
      const spec = cfg ?? {};
      const where = spec.serverUrl || spec.url || st?.spec?.server_url || [spec.command ?? st?.spec?.command, ...(spec.args ?? st?.spec?.args ?? [])].filter(Boolean).join(' ');
      return {
        name,
        state,
        where: where || null,
        origin: cfg ? null : 'from a plugin',
        error: st?.error || null,
        tools: st ? tools.length : null,
        toolNames: tools.map((t) => t.name).filter(Boolean),
        enabled: !disabled,
        reconnect: true,
        editForm: cfg ? this.mcpFormFor(name, cfg) : null,
        removable: !!cfg,
      };
    });
  }

  private mcpPage(): SettingsPage {
    const m = this.mcp;
    return mcpPage({
      id: 'agy.mcp',
      title: 'MCP Servers',
      agent: 'AGY',
      description: `Tools Antigravity can call.${m?.configPath ? ` Config: ${m.configPath}` : ''}`,
      servers: this.mcpViews(),
      error: m?.error ?? null,
      addForm: this.mcpFormFor(),
      presets: [presetsItem(this.mcpEntries(), this.mcpFormFor())],
      extra: [
        {
          id: 'catalog',
          title: '',
          items: [{ kind: 'page', id: 'agy.mcp.catalog', label: 'MCP catalog', icon: 'storefront', description: 'One-click MCP integrations (Firebase, BigQuery, Cloud…)' }],
        },
      ],
    });
  }

  private async saveMcpConfig() {
    if (!this.mcp) return;
    await this.bridge('/api/mcp/config', { method: 'POST', body: JSON.stringify({ content: JSON.stringify(this.mcp.config, null, 2) }), headers: { 'content-type': 'application/json' } }, 15_000);
    await this.hub('RefreshMcpServers', {}).catch(() => undefined);
    await this.loadMcp();
  }

  /** Adds a server from the add form (the custom tile too). */
  private async addServer(values: Record<string, string>): Promise<string> {
    const mcp = await this.mcpForWrite();
    const name = (values.name ?? '').trim();
    if (!name) throw new Error('Enter a name');
    if (mcp.config.mcpServers[name]) throw new Error(`"${name}" exists already: edit it instead`);
    mcp.config.mcpServers[name] = this.specFromForm(values);
    await this.saveMcpConfig();
    this.changed();
    return `Added ${name}`;
  }

  /** A preset tile (the app's McpSubScreen presets): mcp_config.json `mcpServers.<serverName>` = {serverUrl, headers}
   *  or {command, args}, then the hub reconnects its servers. */
  private async addPreset(tileId: string, values?: Record<string, string>): Promise<string> {
    const mcp = await this.mcpForWrite();
    const tap = presetTap(tileId, values, this.mcpEntries());
    if (tap.kind === 'done') return tap.message;
    if (tap.kind === 'custom') {
      if (!values) throw new Error('Fill in the server to add');
      return this.addServer(values);
    }
    const p = tap.preset;
    const headers = presetHeaders(p);
    mcp.config.mcpServers[p.serverName] =
      p.transport === 'stdio' ? { command: p.command, ...(p.args?.length ? { args: p.args } : {}) } : { serverUrl: p.url, ...(Object.keys(headers).length ? { headers } : {}) };
    await this.saveMcpConfig();
    this.changed();
    return `Added ${p.name}`;
  }

  /** mcp_config.json entry from the add / edit form. */
  private specFromForm(v: Record<string, string>): any {
    const f = mcpFormValues(v);
    if (f.remote) return { serverUrl: f.url, ...(Object.keys(f.headers).length ? { headers: f.headers } : {}) };
    return { command: f.command[0], args: f.command.slice(1), ...(Object.keys(f.env).length ? { env: f.env } : {}) };
  }

  // --- MCP catalog (GetAvailableCascadePlugins: the app's CascadeMcpCatalogDialog)

  private async loadCatalog(query: string) {
    try {
      const r = await this.hub('GetAvailableCascadePlugins', { os: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux', search_query: query, metadata: {} });
      this.catalog = { query, plugins: r.plugins ?? [], error: null };
    } catch (e) {
      this.catalog = { query, plugins: [], error: this.err(e) };
    }
  }

  /** The mcp_config.json entry for a catalog plugin (the app's installCascadePlugin, without the Termux env). */
  private catalogSpec(p: any): any {
    const commands: Record<string, any> = { ...(p.commands ?? {}), ...(p.local?.commands ?? {}) };
    const tpl = Object.values(commands).find((c: any) => c?.template?.command)?.template;
    if (tpl) {
      const env = tpl.env ?? {};
      return { command: tpl.command, args: tpl.args ?? [], ...(Object.keys(env).length ? { env } : {}) };
    }
    const rt = p.remote?.template;
    if (rt?.server_url) {
      const headers = rt.headers ?? {};
      return { serverUrl: rt.server_url, ...(Object.keys(headers).length ? { headers } : {}), ...(rt.auth_provider_type ? { authProviderType: rt.auth_provider_type } : {}) };
    }
    return null;
  }

  private catalogKey(p: any): string {
    return p.id || String(p.title ?? 'mcp').toLowerCase().replace(/\s+/g, '-');
  }

  private catalogPage(): SettingsPage {
    const c = this.catalog ?? { query: '', plugins: [], error: null };
    const names = new Set(this.mcpNames().map((n) => n.toLowerCase()));
    const rows: SettingListRow[] = c.plugins.map((p) => {
      const installed = names.has(String(p.id ?? '').toLowerCase()) || names.has(String(p.title ?? '').toLowerCase());
      const spec = this.catalogSpec(p);
      const how = spec?.serverUrl ? `Remote: ${spec.serverUrl}` : spec?.command ? `Stdio: ${[spec.command, ...(spec.args ?? []).slice(0, 2)].join(' ')}` : null;
      return {
        id: this.catalogKey(p),
        title: p.title || p.id,
        subtitle: [firstLine(p.description), how].filter(Boolean).join(' — ') || null,
        status: installed ? 'Installed' : p.trust_level || null,
        statusTone: installed ? 'ok' : 'muted',
        actions: [
          ...(installed || !spec ? [] : [{ id: 'install', label: 'Install', confirm: `Add "${p.title || p.id}" to your MCP servers?` }]),
          ...(p.readme ? [{ id: 'readme', label: 'README' }] : []),
          ...(p.link ? [{ id: 'link', label: 'Website' }] : []),
        ],
      };
    });
    return {
      id: 'agy.mcp.catalog',
      title: 'MCP catalog',
      sections: [
        {
          id: 'catalog',
          title: '',
          description: c.error ? `Couldn't load the catalog: ${c.error}` : `Cascade MCP catalog: ${c.plugins.length} package${c.plugins.length === 1 ? '' : 's'}${c.query ? ` matching "${c.query}"` : ''}`,
          agent: 'AGY',
          items: [
            { kind: 'text', id: 'search', label: 'Search', value: c.query, placeholder: 'Firebase, BigQuery, Firestore…' },
            { kind: 'list', id: 'plugins', label: 'Packages', rows, emptyText: c.query ? `No MCP packages match "${c.query}"` : 'The catalog is empty' },
          ],
        },
      ],
    };
  }

  // --- Skills & plugins

  private async loadSkills() {
    const ws = this.skillScope === 'GLOBAL' ? null : this.b.workspaceHint();
    const [sk, pl, st] = await Promise.all([
      this.hub('GetAllSkills', { workspace_uris: ws ? [ws] : [] }).catch(() => ({ skills: [] })),
      this.hub('GetAllPlugins', {}).catch(() => ({ plugins: [] })),
      this.hub('GetBuildWithGooglePlugins', {}).catch(() => ({ plugins: [] })),
    ]);
    const isWorkspace = (s: any) => s.discovery_category === 'DISCOVERY_CATEGORY_WORKSPACE' || !!s.scope?.local_scope || !!s.scope?.project_scope;
    const all: any[] = sk.skills ?? [];
    this.skills = this.skillScope === 'GLOBAL' ? all.filter((s) => !isWorkspace(s)) : this.skillScope === 'WORKSPACE' ? all.filter(isWorkspace) : all;
    this.plugins = pl.plugins ?? [];
    this.store = st.plugins ?? [];
  }

  private skillsPage(): SettingsPage {
    const plugins = this.plugins ?? [];
    const installed = new Map<string, any>();
    for (const p of plugins) {
      if (p.name) installed.set(String(p.name).toLowerCase(), p);
      if (p.display_name) installed.set(String(p.display_name).toLowerCase(), p);
    }
    const skills = this.skills ?? [];
    const ws = this.skillScope === 'GLOBAL' ? null : this.b.workspaceHint();
    return {
      id: 'agy.skills',
      title: 'Skills & Plugins',
      sections: [
        {
          id: 'skills',
          title: '',
          agent: 'AGY',
          description: ws ? `Workspace: ${uriToPath(ws)}` : 'Type / in the composer to use them',
          items: [
            { kind: 'select', id: 'scope', label: 'Show', value: this.skillScope, options: SKILL_SCOPES },
            {
              kind: 'list',
              id: 'skills',
              label: 'Skills',
              emptyText: this.skillScope === 'WORKSPACE' ? 'No workspace skills (.agents/skills/) in this project' : 'No skills found',
              rows: skills.map((s) => ({
                id: s.path || s.name,
                title: `/${s.name}${s.display_name && s.display_name !== s.name ? ` (${s.display_name})` : ''}`,
                subtitle: firstLine(s.description),
                status: s.plugin_name ? `from ${s.plugin_name}` : (CATEGORY_LABEL[s.discovery_category] ?? (s.is_builtin ? 'Built-in' : null)),
                statusTone: 'muted' as const,
                actions: s.path ? [{ id: 'view', label: 'View SKILL.md' }] : [],
              })),
            },
          ],
        },
        {
          id: 'plugins',
          title: '',
          items: [
            {
              kind: 'list',
              id: 'plugins',
              label: 'Installed plugins',
              emptyText: 'No plugin bundles installed',
              rows: plugins.map((p) => {
                const bundled = (p.skills ?? []).map((s: any) => `/${s.name}`);
                return {
                  id: p.name,
                  title: p.display_name || p.name,
                  subtitle: [firstLine(p.description), bundled.length ? `Skills: ${bundled.join(' ')}` : null].filter(Boolean).join(' — ') || null,
                  status: p.version ? `v${p.version}` : p.is_builtin ? 'Built-in' : p.is_global ? 'Global' : null,
                  statusTone: (p.disabled || p.force_disabled ? 'warn' : 'muted') as 'warn' | 'muted',
                  actions: [
                    ...(p.homepage ? [{ id: 'homepage', label: 'Homepage' }] : []),
                    ...(p.repository ? [{ id: 'repository', label: 'Repository' }] : []),
                    ...(p.is_builtin ? [] : [{ id: 'delete', label: 'Uninstall', danger: true, confirm: `Uninstall ${p.display_name || p.name}? Its bundled skills are removed too.` }]),
                  ],
                };
              }),
            },
          ],
        },
        {
          id: 'store',
          title: '',
          description: "Plugin store: official 'Build with Google' plugins",
          items: [
            {
              kind: 'list',
              id: 'store',
              label: 'Build with Google plugins',
              emptyText: 'The store is empty',
              rows: (this.store ?? []).map((s) => {
                const p = s.plugin ?? {};
                const have = installed.get(String(p.uid ?? '').toLowerCase()) ?? installed.get(String(p.name ?? '').toLowerCase());
                const versions = Object.keys(s.version_shas ?? {});
                const latest = versions.reduce<string | null>((a, v) => (!a || newerVersion(v, a) ? v : a), null);
                const outdated = !!have?.version && !!latest && newerVersion(latest, String(have.version));
                return {
                  id: p.uid || p.name,
                  title: p.name || p.uid,
                  subtitle: [firstLine(p.description), latest ? `Latest v${latest}` : null].filter(Boolean).join(' — ') || null,
                  status: outdated ? 'Update available' : have ? 'Installed' : p.trust_level || null,
                  statusTone: (outdated ? 'warn' : have ? 'ok' : 'muted') as 'ok' | 'warn' | 'muted',
                  actions: have && !outdated ? [] : [{ id: 'install', label: outdated ? 'Update' : 'Install' }],
                };
              }),
            },
          ],
        },
      ],
    };
  }

  // --- Account & CLI (the app's AgyCliCard, its Accounts dialog entry and the usage limits)

  private async loadCli() {
    try {
      this.cli = await this.bridge('/api/agy/cli');
    } catch (e) {
      // unknown (bridge down): not "not installed"
      this.cli = { ...(this.cli ?? {}), error: this.err(e) };
    }
    if (this.cli?.job?.running && !this.cliPoll) {
      this.cliPoll = setInterval(async () => {
        const before = JSON.stringify([this.cliInstalled(), this.cliVersion()]);
        await this.loadCli();
        this.changed();
        if (!this.cli?.job?.running && this.cliPoll) {
          clearInterval(this.cliPoll);
          this.cliPoll = null;
          const ok = this.cli?.job?.exit_code === 0;
          this.b.notify(ok ? 'info' : 'error', ok ? `agy ${this.cli?.job?.kind === 'update' ? 'update' : 'install'} finished` : `agy ${this.cli?.job?.kind ?? 'install'} failed`);
        }
        if (JSON.stringify([this.cliInstalled(), this.cliVersion()]) !== before) this.b.notifyStatus();
      }, 1500);
    }
  }

  private cliItems(): SettingItem[] {
    const c = this.cli;
    const running = c?.job?.running === true;
    const v = this.cliVersion();
    const items: SettingItem[] = [
      {
        kind: 'info',
        id: 'agy.cli.state',
        label: 'Antigravity CLI (agy)',
        value: !c ? 'Checking…' : c.error ? 'Could not check' : c.installed ? (v ?? 'Installed') : 'Not installed',
        tone: !c ? 'muted' : c.error ? 'error' : c.installed ? 'ok' : 'warn',
        description: c?.error ? c.error : c?.path || null,
      },
    ];
    if (c && !c.error)
      items.push(
        c.installed
          ? { kind: 'button', id: 'update', label: running && c.job?.kind === 'update' ? 'Checking…' : 'Check for updates', disabled: running }
          : { kind: 'button', id: 'install', label: running ? 'Installing…' : 'Install agy', style: 'primary', disabled: running },
      );
    if (c?.job) {
      items.push({
        kind: 'info',
        id: 'job',
        label: c.job.kind === 'update' ? 'Update' : 'Install',
        value: c.job.running ? 'running…' : c.job.exit_code === 0 ? 'done' : `failed (exit ${c.job.exit_code ?? '?'})`,
        tone: c.job.running ? 'warn' : c.job.exit_code === 0 ? 'ok' : 'error',
      });
      if (c.job.log)
        items.push({ kind: 'text', id: 'log', label: 'Log', value: String(c.job.log).split('\n').slice(-30).join('\n'), multiline: true, code: true, rows: 10, disabled: true });
    }
    return items;
  }

  private accountItems(): SettingItem[] {
    const st = this.b.status();
    const a = this.auth;
    if (st.state !== 'online' && !this.signingIn) {
      return [
        {
          kind: 'info',
          id: 'agy.account',
          label: 'Google account',
          value: st.state === 'starting' ? 'Starting…' : 'Not available',
          tone: st.state === 'starting' ? 'muted' : 'error',
          description: st.state === 'starting' ? 'Antigravity is starting: the account shows in a moment.' : `${blockedReason(st) ?? "Antigravity isn't running"}`,
        },
      ];
    }
    const items: SettingItem[] = [
      {
        kind: 'info',
        id: 'agy.account',
        label: 'Google account',
        value: this.signingIn ? 'Signing in…' : a == null ? 'Checking…' : a.loggedIn ? a.email || a.name || 'Signed in' : 'Not signed in',
        tone: this.signingIn ? 'warn' : a?.loggedIn ? 'ok' : a ? 'warn' : 'muted',
        description: this.signingIn ? 'Finish signing in with Google in your browser.' : a?.loggedIn && a.name && a.email ? a.name : null,
      },
    ];
    if (a?.loggedIn) {
      const plan = [a.tier, a.plan && a.plan !== a.tier ? a.plan : ''].filter(Boolean).join(' · ');
      if (plan) items.push({ kind: 'info', id: 'agy.plan.info', label: 'Plan', value: plan });
      if (a.promptCredits != null || a.flowCredits != null)
        items.push({ kind: 'info', id: 'agy.credits', label: 'Credits', value: `${a.promptCredits ?? 0} prompt · ${a.flowCredits ?? 0} flow`, tone: 'muted' });
    }
    // no sign-in / sign-out button until the account state is known
    if (this.signingIn) {
      items.push({ kind: 'button', id: 'agy.signin.open', label: 'Open the sign-in page again', style: 'primary', description: this.signingIn.url || 'Waiting for the sign-in address…', disabled: !this.signingIn.url });
      items.push({ kind: 'button', id: 'agy.signin.cancel', label: 'Cancel sign-in' });
    } else if (a?.loggedIn) {
      if (a.upgradeUri) items.push({ kind: 'button', id: 'agy.plan', label: 'Manage plan', description: a.upgradeText || null });
      items.push({ kind: 'button', id: 'agy.signout', label: 'Sign out', style: 'danger', confirm: 'Sign out of Antigravity?' });
    } else if (a) {
      items.push({ kind: 'button', id: 'agy.signin', label: 'Sign in with Google', style: 'primary' });
    }
    items.push({ kind: 'button', id: 'agy.account.refresh', label: 'Check again' });
    return items;
  }

  /** Usage limits: what is left of each limit (one decimal, as the app) and when it resets. */
  private usageItems(): SettingItem[] | null {
    if (this.b.status().state !== 'online' || !this.auth?.loggedIn) return null;
    const groups = applyQuota([], this.b.quota()).groups;
    return [
      groups.length
        ? { kind: 'quota', id: 'agy.quota', label: 'Usage limits', groups }
        : { kind: 'info', id: 'agy.quota', label: 'Usage limits', value: 'No usage information yet', tone: 'muted' },
      { kind: 'button', id: 'agy.usage.refresh', label: 'Refresh usage' },
    ];
  }

  private cliPage(): SettingsPage {
    const sections: SettingsSection[] = [
      {
        id: 'cli',
        title: '',
        agent: 'AGY',
        description:
          process.platform === 'win32'
            ? 'On Windows, install the Antigravity CLI from antigravity.google, then restart the bridge. Check for updates runs `agy update`.'
            : "Installed with Google's official installer (antigravity.google/cli/install.sh) into ~/.local/bin. Check for updates runs `agy update`; restart the bridge afterwards so the hub uses the new agy.",
        items: this.cliItems(),
      },
      { id: 'account', title: '', agent: 'AGY', items: this.accountItems() },
    ];
    const usage = this.usageItems();
    if (usage) sections.push({ id: 'usage', title: '', agent: 'AGY', description: 'What is left of each limit, and when it resets', items: usage });
    return { id: 'agy.cli', title: 'Account & CLI', sections };
  }

  // ------------------------------------------------------------------ edits

  async change(page: string, id: string, value: unknown, rowId?: string): Promise<void> {
    if (page === 'agy.permissions') {
      switch (id) {
        case 'preset': {
          const p = PRESETS.find((x) => x.value === value);
          if (p) await this.writeUser({ auto_execution_policy: p.auto, allow_agent_access_non_workspace_files: p.files });
          return;
        }
        case 'terminal':
          await this.writeUser({ auto_execution_policy: value === 'auto' ? AUTO_EAGER : value === 'smart' ? AUTO_SMART : AUTO_OFF });
          return;
        case 'files':
          await this.writeUser({ allow_agent_access_non_workspace_files: value === 'allow' });
          return;
        case 'sandbox':
          await this.writeUser({ enable_terminal_sandbox: value === true });
          return;
        case 'artifactReview':
          await this.writeUser({ artifact_review_mode: value === 'turbo' ? 'ARTIFACT_REVIEW_MODE_TURBO' : 'ARTIFACT_REVIEW_MODE_ALWAYS' });
          return;
        case 'defaultScope':
          this.b.store.set('agy.defaultScope', String(value));
          this.changed();
          return;
      }
    }
    if (page === 'agy.skills' && id === 'scope') {
      const v = String(value);
      this.skillScope = v === 'WORKSPACE' || v === 'ALL' ? v : 'GLOBAL';
      this.b.store.set('agy.skillScope', this.skillScope);
      await this.loadSkills();
      this.changed();
      return;
    }
    if (page === 'agy.mcp.catalog' && id === 'search') {
      await this.loadCatalog(String(value ?? '').trim());
      this.changed();
      return;
    }
    if (page === 'agy.mcp' && id === MCP_LIST && rowId) {
      const enabled = value === true;
      const cfg = (await this.mcpForWrite()).config.mcpServers?.[rowId];
      if (cfg) {
        if (enabled) delete cfg.disabled;
        else cfg.disabled = true;
      }
      await this.hub('ToggleMcpServer', { server_name: rowId, enabled }, HUB_WRITE_MS).catch(() => undefined);
      if (cfg) await this.saveMcpConfig();
      else await this.loadMcp();
      this.changed();
    }
  }

  async action(page: string, id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void> {
    if (page === 'agy' || page === 'agy.cli') {
      if (id === 'agy.signin') return this.signIn();
      if (id === 'agy.signin.cancel') {
        this.stopSignIn();
        await withTimeout(this.refreshAuth(), HUB_READ_MS, 'Antigravity').catch(() => undefined);
        return 'Sign-in cancelled';
      }
      if (id === 'agy.signin.open' && this.signingIn?.url) {
        this.b.openUrl(this.signingIn.url);
        return;
      }
      if (id === 'agy.signout') {
        await this.hub('AuthLogout', {}, HUB_WRITE_MS);
        this.auth = { loggedIn: false, email: '', name: '', tier: '', plan: '', upgradeUri: '', upgradeText: '', promptCredits: null, flowCredits: null };
        this.changed();
        this.b.afterSignIn();
        return 'Signed out of Antigravity';
      }
      if (id === 'agy.plan' && this.auth?.upgradeUri) {
        this.b.openUrl(this.auth.upgradeUri);
        return;
      }
      if (id === 'agy.account.refresh') {
        await Promise.allSettled([this.loadCli(), this.b.status().state === 'online' ? withTimeout(this.refreshAuth(), HUB_READ_MS, 'Antigravity') : null]);
        this.changed();
        const st = this.b.status();
        if (st.state !== 'online') throw new Error(this.downReason());
        return;
      }
      if (id === 'agy.usage.refresh') {
        await this.online();
        await withTimeout(this.b.loadQuota(true), 15_000, 'Antigravity');
        this.changed();
        return;
      }
      if (page === 'agy.cli' && (id === 'install' || id === 'update')) {
        await this.bridge(`/api/agy/cli/${id}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }, 15_000);
        await this.loadCli();
        this.changed();
        return id === 'install' ? 'Installing agy…' : 'Checking for an agy update…';
      }
      return;
    }
    if (page === 'agy.permissions' && id === 'grants') {
      const g = { ...(this.user?.global_permission_grants ?? {}) };
      const lists = { allow: [...(g.allow ?? [])], ask: [...(g.ask ?? [])], deny: [...(g.deny ?? [])] } as Record<'allow' | 'ask' | 'deny', string[]>;
      if (actionId === 'add' && values) {
        const pattern = (values.pattern ?? '').trim();
        if (!pattern) throw new Error('Enter a pattern');
        const rule = `${(values.action || 'command').trim().toLowerCase()}(${pattern})`;
        const d = (values.decision as 'allow' | 'ask' | 'deny') || 'allow';
        for (const k of Object.keys(lists) as ('allow' | 'ask' | 'deny')[]) lists[k] = lists[k].filter((r) => r.toLowerCase() !== rule.toLowerCase());
        lists[d].push(rule);
      } else if (rowId) {
        const [from, ...rest] = rowId.split(':');
        const rule = rest.join(':');
        lists[from as 'allow' | 'ask' | 'deny'] = lists[from as 'allow' | 'ask' | 'deny'].filter((r) => r !== rule);
        if (actionId === 'allow' || actionId === 'ask' || actionId === 'deny') lists[actionId].push(rule);
      }
      await this.writeUser({ global_permission_grants: { ...g, ...lists } });
      return;
    }
    if (page === 'agy.permissions' && id === 'projects' && rowId && actionId) {
      const preset = actionId === 'inherit' ? null : PRESETS.find((p) => p.value === actionId);
      if (preset === undefined) return;
      await this.writeProject(rowId, preset);
      await this.loadProjects();
      this.changed();
      const name = this.projects?.find((p) => p.id === rowId)?.name ?? rowId;
      return preset ? `${name}: ${preset.label}` : `${name} inherits the global settings`;
    }
    if (page === 'agy.mcp' && id === MCP_REFRESH_ALL) {
      await this.hub('RefreshMcpServers', {}, HUB_WRITE_MS);
      await new Promise((r) => setTimeout(r, 600));
      await this.loadMcp();
      this.changed();
      const n = this.mcp?.states.length ?? 0;
      const tools = (this.mcp?.states ?? []).reduce((a, s) => a + (s.tools?.length ?? 0), 0);
      return `Refreshed: ${n} server${n === 1 ? '' : 's'}, ${tools} tool${tools === 1 ? '' : 's'}`;
    }
    if (page === 'agy.mcp' && id === MCP_LIST && rowId && actionId === MCP_RECONNECT) {
      await this.hub('RefreshMcpServers', { server_name: rowId }, HUB_WRITE_MS);
      await new Promise((r) => setTimeout(r, 600));
      await this.loadMcp();
      this.changed();
      const s = this.mcp?.states.find((x) => x.spec?.server_name === rowId);
      if (s?.error) throw new Error(`${rowId}: ${s.error}`);
      return s?.tools?.length ? `Reconnected ${rowId}: ${s.tools.length} tools` : `Reconnected ${rowId}`;
    }
    if (page === 'agy.mcp' && id === MCP_PRESETS && actionId) return this.addPreset(actionId, values);
    if (page === 'agy.mcp' && id === MCP_LIST) {
      if (actionId === 'add' && values) return this.addServer(values);
      if (!rowId) return;
      const mcp = await this.mcpForWrite();
      if (actionId === MCP_REMOVE) {
        delete mcp.config.mcpServers[rowId];
        await this.saveMcpConfig();
        this.changed();
        return `Removed ${rowId}`;
      }
      if (actionId === MCP_EDIT && values) {
        const name = (values.name ?? rowId).trim() || rowId;
        const spec = this.specFromForm(values);
        const old = mcp.config.mcpServers[rowId] ?? {};
        if (name !== rowId) delete mcp.config.mcpServers[rowId];
        // keep fields the form does not show (disabled, cwd, tool lists…), switch command ↔ url cleanly
        const { command: _c, args: _a, env: _e, serverUrl: _s, url: _u, headers: _h, ...rest } = old;
        mcp.config.mcpServers[name] = { ...rest, ...spec };
        await this.saveMcpConfig();
        this.changed();
        return `Saved ${name}`;
      }
    }
    if (page === 'agy.mcp.catalog' && id === 'plugins' && rowId) {
      const p = (this.catalog?.plugins ?? []).find((x) => this.catalogKey(x) === rowId);
      if (!p) return;
      if (actionId === 'readme' && p.readme) return void this.b.openUrl(p.readme);
      if (actionId === 'link' && p.link) return void this.b.openUrl(p.link);
      if (actionId === 'install') {
        const spec = this.catalogSpec(p);
        if (!spec) throw new Error(`${p.title || p.id} has no server to install`);
        (await this.mcpForWrite()).config.mcpServers[rowId] = spec;
        await this.saveMcpConfig();
        this.changed();
        return `Installed and activated '${p.title || rowId}' MCP server`;
      }
    }
    if (page === 'agy.skills' && rowId) {
      if (id === 'skills' && actionId === 'view') {
        const s = (this.skills ?? []).find((x) => (x.path || x.name) === rowId);
        if (s?.path) this.b.openFile(uriToPath(String(s.path)));
        return;
      }
      if (id === 'plugins') {
        const p = (this.plugins ?? []).find((x) => x.name === rowId);
        if (actionId === 'homepage' && p?.homepage) return void this.b.openUrl(p.homepage);
        if (actionId === 'repository' && p?.repository) return void this.b.openUrl(p.repository);
        if (actionId === 'delete') {
          const r = await this.hub('DeletePlugin', { plugin_id: rowId });
          if (r.success !== true) throw new Error(r.message || 'Delete failed');
          await this.hub('RefreshMcpServers', {}).catch(() => undefined);
          await this.afterPluginChange();
          return `Uninstalled ${p?.display_name || rowId}`;
        }
      }
      if (id === 'store' && actionId === 'install') {
        const r = await this.hub('DownloadBuildWithGooglePlugin', { plugin_id: rowId }, 5 * 60_000);
        if (r.success !== true) throw new Error(r.message || 'Download failed');
        await this.hub('RefreshMcpServers', {}).catch(() => undefined);
        await this.afterPluginChange();
        return r.message || `Installed ${rowId}`;
      }
    }
  }

  /** A plugin came or went: its skills, the `/` list and its MCP servers. */
  private async afterPluginChange() {
    await new Promise((r) => setTimeout(r, 400));
    await Promise.all([this.loadSkills(), this.loadMcp()]);
    this.b.afterSignIn();
    this.changed();
  }

  // ------------------------------------------------------------------ sign-in

  private stopSignIn() {
    if (this.loginPoll) clearInterval(this.loginPoll);
    this.loginPoll = null;
    this.signingIn = null;
    this.changed();
    this.b.notifyStatus();
  }

  /**
   * Google sign-in (the app's loginToAgyHub): already signed in → done; otherwise the hub's Login runs (the bridge
   * captures the address the hub prints, opened in the browser) while the account is polled until it is signed in.
   */
  private async signIn(): Promise<string | void> {
    if (this.loginPoll) {
      if (this.signingIn?.url) this.b.openUrl(this.signingIn.url);
      return 'Sign-in is already open in your browser';
    }
    // the hub runs the sign-in: without it, say why at once
    await this.online();
    this.b.notify('info', 'Opening Google sign-in…');
    try {
      const pre = await this.hub('GetAuthStatus', {});
      if (pre.auth_result?.has_valid_auth) {
        await this.refreshAuth();
        return `Already signed in as ${this.auth?.name || this.auth?.email || 'your account'}`;
      }
    } catch {
      /* try the sign-in anyway */
    }
    this.signingIn = { url: '', started: Date.now() };
    this.changed();
    this.b.notifyStatus();
    // Login blocks until the browser flow finishes; it may also answer with something the account must do first
    void this.b
      .callHub('Login', { is_gcp_tos: false }, 10 * 60_000)
      .then((res) => {
        const r = res?.auth_result;
        if (!r || r.has_valid_auth || !this.signingIn) return;
        const verify = r.ineligible?.verification_url || r.verification_required?.verification_url;
        if (verify) {
          this.stopSignIn();
          this.b.openUrl(verify);
          this.b.notify('warning', r.ui_message || 'Your account needs verification before you can sign in.');
        } else if (r.general_error?.reason || r.ui_message) {
          this.b.notify('warning', r.ui_message || r.general_error.reason);
        }
      })
      .catch((e) => this.b.log(`[agy] login: ${this.err(e)}`));
    this.loginPoll = setInterval(async () => {
      if (!this.signingIn) return;
      try {
        if (!this.signingIn.url) {
          const r = await this.bridge('/api/auth/login-url');
          if (r.loginUrl && this.signingIn) {
            this.signingIn.url = r.loginUrl;
            this.b.openUrl(r.loginUrl);
            this.changed();
          }
        }
        const st = await this.hub('GetAuthStatus', {});
        if (st.auth_result?.has_valid_auth) {
          this.stopSignIn();
          await this.refreshAuth();
          this.b.afterSignIn();
          this.b.notify('info', `Signed in as ${this.auth?.name || this.auth?.email || 'your Google account'}`);
        } else if (this.signingIn && Date.now() - this.signingIn.started > 5 * 60_000) {
          this.stopSignIn();
          await this.refreshAuth();
          this.b.notify('warning', 'Sign-in timed out. Try again from Settings → Antigravity → Account & CLI.');
        }
      } catch {
        /* keep polling */
      }
    }, 1500);
  }

  dispose() {
    if (this.loginPoll) clearInterval(this.loginPoll);
    if (this.cliPoll) clearInterval(this.cliPoll);
  }
}
