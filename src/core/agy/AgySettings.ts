// Antigravity's settings pages (ports of the app's Antigravity settings: Commands & Permissions with project
// overrides, MCP Servers + the Cascade MCP catalog, Skills & Plugins with scopes and the store, Antigravity CLI,
// account + usage limits). Everything goes to the hub (gRPC) or the bridge.
//
// Writes to the hub's settings never encode a decoded config: they patch the hub's own stored bytes (patchMessage),
// so fields this proto copy does not know, and explicit false / 0 values, stay exactly as they were.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SettingFormField, SettingItem, SettingListRow, SettingsPage } from '../../../shared/protocol';
import type { AgentSettingsProvider } from '../types';
import type { AgyBackend } from './AgyBackend';
import { applyQuota } from './quota';
import { decodeAs, encodeAs, lengthDelimited, patchMessage, rawFields } from './proto';

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
  private signingIn: { url: string; started: number } | null = null;
  private mcp: { states: any[]; configPath: string; config: any } | null = null;
  private catalog: { query: string; plugins: any[]; error: string | null } | null = null;
  private skillScope: 'GLOBAL' | 'WORKSPACE' | 'ALL' = 'GLOBAL';
  private skills: any[] | null = null;
  private plugins: any[] | null = null;
  private store: any[] | null = null;
  private projects: ProjectRow[] | null = null;
  private cli: any = null;
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

  // ------------------------------------------------------------------ account (also used by the backend)

  /** true / false once known, null while unknown (the hub not asked yet). */
  signedIn(): boolean | null {
    return this.auth ? this.auth.loggedIn : null;
  }

  /** The account line of the agent status (name / email). */
  accountLabel(): string | null {
    if (!this.auth?.loggedIn) return null;
    return this.auth.email || this.auth.name || null;
  }

  /** Reads the account again (hub online, a send while signed out). */
  refreshAuth(): Promise<void> {
    if (!this.authLoading) {
      this.authLoading = this.loadAuth().finally(() => {
        this.authLoading = null;
      });
    }
    return this.authLoading;
  }

  /** The hub's command auto-run setting, read once the hub is online (prompts carry it, as the app's saved policy). */
  async syncUserSettings() {
    await this.loadUser();
  }

  private async loadAuth() {
    const before = this.auth?.loggedIn;
    try {
      const st = await this.b.callHub('GetAuthStatus', {});
      const loggedIn = st.auth_result?.has_valid_auth === true;
      const a: Auth = { loggedIn, email: '', name: '', tier: '', plan: '', upgradeUri: '', upgradeText: '', promptCredits: null, flowCredits: null };
      if (loggedIn) {
        try {
          const res = await this.b.callHub('GetUserStatus', { metadata: {} });
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
      this.b.log(`[agy] auth: ${this.err(e)}`);
      // unreachable: keep what was known (the app keeps the auth state on a network failure)
      if (!this.auth) {
        this.changed();
        return;
      }
    }
    this.changed();
    if (before !== this.auth?.loggedIn) this.b.notifyModels();
  }

  // ------------------------------------------------------------------ root section

  /** The "Antigravity" row on the settings root (opens the agy page). */
  rootItem(): SettingItem {
    if (!this.auth) void this.refreshAuth();
    const st = this.b.status();
    const state =
      st.state === 'online'
        ? this.signingIn
          ? 'Signing in…'
          : this.auth?.loggedIn
            ? this.auth.email || 'Signed in'
            : this.auth
              ? 'Not signed in'
              : 'Online'
        : st.state === 'starting'
          ? 'Starting…'
          : 'Offline';
    return { kind: 'page', id: 'agy', label: 'Antigravity', icon: 'rocket_launch', description: state, badge: this.cli?.version ? `agy ${this.cli.version}` : null };
  }

  private policyLabel(): string | null {
    const p = this.b.store.get<string>('agy.autoExecPolicy');
    if (!p) return null;
    return p.includes('EAGER') ? 'Auto-run' : p.includes('AUTO') ? 'Smart safety' : 'Ask first';
  }

  /** Antigravity's own page: account, usage limits, then its settings pages (the app's AntigravitySettingsMenu). */
  private mainPage(): SettingsPage {
    if (!this.auth) void this.refreshAuth();
    if (!this.cli) void this.loadCli().then(() => this.changed());
    // the rows' summaries ("2 active", "17 skills · 1 plugin") load once in the background
    if (!this.mcp) void this.loadMcp().then(() => this.changed());
    if (!this.skills) void this.loadSkills().then(() => this.changed());
    const st = this.b.status();
    const a = this.auth;
    const items: SettingItem[] = [
      {
        kind: 'info',
        id: 'agy.status',
        label: 'Hub',
        value: st.state === 'online' ? 'Online' : st.state === 'starting' ? 'Starting…' : (st.detail ?? st.state),
        tone: st.state === 'online' ? 'ok' : st.state === 'starting' ? 'warn' : 'error',
      },
      {
        kind: 'info',
        id: 'agy.account',
        label: 'Account',
        value: this.signingIn ? 'Signing in…' : a == null ? 'Checking…' : a.loggedIn ? a.email || a.name || 'Signed in' : 'Not signed in',
        tone: this.signingIn ? 'warn' : a?.loggedIn ? 'ok' : a ? 'warn' : 'muted',
        description: a?.loggedIn && a.name && a.email ? a.name : null,
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
      items.push({ kind: 'button', id: 'agy.signin.open', label: 'Open the sign-in page again', description: this.signingIn.url || 'Waiting for the sign-in address…', disabled: !this.signingIn.url });
      items.push({ kind: 'button', id: 'agy.signin.cancel', label: 'Cancel sign-in' });
    } else if (a?.loggedIn) {
      if (a.upgradeUri) items.push({ kind: 'button', id: 'agy.plan', label: 'Manage plan', description: a.upgradeText || null });
      items.push({ kind: 'button', id: 'agy.signout', label: 'Sign out', style: 'danger', confirm: 'Sign out of Antigravity?' });
    } else if (a) {
      items.push({ kind: 'button', id: 'agy.signin', label: 'Sign in with Google', style: 'primary', disabled: st.state !== 'online' });
    }
    const groups = applyQuota([], this.b.quota()).groups;
    const sections: SettingsPage['sections'] = [{ id: 'account', title: '', agent: 'AGY', items }];
    if (groups.length) sections.push({ id: 'usage', title: '', agent: 'AGY', items: [{ kind: 'quota', id: 'agy.quota', label: 'Usage limits', groups }] });
    const active = this.mcp ? this.mcp.states.filter((s) => s.spec?.disabled !== true).length : 0;
    const mcpTotal = this.mcpNames().length;
    const mcpValue = !this.mcp ? null : !mcpTotal ? 'None' : active ? `${active} active` : 'All off';
    sections.push({
      id: 'settings',
      title: '',
      agent: 'AGY',
      items: [
        { kind: 'page', id: 'agy.permissions', label: 'Commands & Permissions', icon: 'shield', description: this.policyLabel() ?? 'Auto-run, file access, permission rules' },
        { kind: 'page', id: 'agy.mcp', label: 'MCP Servers', icon: 'extension', description: mcpValue, badge: this.mcp ? String(mcpTotal) : null },
        {
          kind: 'page',
          id: 'agy.skills',
          label: 'Skills & Plugins',
          icon: 'auto_awesome',
          description: this.skills ? `${this.skills.length} skills · ${this.plugins?.length ?? 0} plugin${this.plugins?.length === 1 ? '' : 's'}` : null,
        },
        { kind: 'page', id: 'agy.cli', label: 'Antigravity CLI', icon: 'terminal', badge: this.cli?.version || null, description: this.cli ? (this.cli.installed ? null : 'Not installed') : null },
      ],
    });
    return { id: 'agy', title: 'Antigravity', sections };
  }

  // ------------------------------------------------------------------ pages

  async page(id: string): Promise<SettingsPage | null> {
    switch (id) {
      case 'agy':
        return this.mainPage();
      case 'agy.permissions':
        // always the hub's current values (also confirms a write took effect)
        await Promise.all([this.loadUser(), this.loadProjects()]);
        return this.permissionsPage();
      case 'agy.mcp':
        await this.loadMcp();
        return this.mcpPage();
      case 'agy.mcp.catalog':
        if (!this.catalog) await this.loadCatalog('');
        if (!this.mcp) await this.loadMcp();
        return this.catalogPage();
      case 'agy.skills':
        await this.loadSkills();
        return this.skillsPage();
      case 'agy.cli':
        await this.loadCli();
        return this.cliPage();
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
      const rpc = await this.b.rpcReady();
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
      await this.b.callHubRaw('JetboxWriteState', request);
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
      const rpc = await this.b.rpcReady();
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
      const res = await this.b.callHub('ReadProjects', { ids: await this.projectIds() });
      const unset = (v: unknown) => (typeof v === 'string' && !v.endsWith('_UNSPECIFIED') ? v : null);
      this.projects = (res.projects ?? [])
        .filter((p: any) => p.id !== 'outside-of-project')
        .map((p: any) => {
          const r = p.project_resources?.resources?.[0];
          const folder = String(r?.folder_uri ?? r?.git_folder?.folder_uri ?? '').replace(/^file:\/\//, '');
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
    const raw = await this.b.callHubRaw('ReadProjects', encodeAs('ReadProjectsRequest', { ids: [id] }));
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
    await this.b.callHubRaw('UpdateProject', lengthDelimited(1, newProject)); // UpdateProjectRequest.project = 1
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
          title: 'Security preset',
          description: 'Live hub settings, applied across all workspaces',
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
          title: 'Artifacts',
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
          title: 'Permission rules',
          items: [
            {
              kind: 'list',
              id: 'grants',
              label: 'Rules',
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
          title: 'Project overrides',
          description: `Projects inherit the global preset or keep their own (${projects.filter((p) => !p.auto && !p.files && !p.review && !p.sandbox).length}/${projects.length} inheriting)`,
          items: [{ kind: 'list', id: 'projects', label: 'Projects', rows: projectRows, emptyText: 'No projects registered on the hub yet' }],
        },
        {
          id: 'approvals',
          title: 'Approvals',
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

  private async loadMcp() {
    try {
      const [states, cfg] = await Promise.all([
        this.b.callHub('GetMcpServerStates', {}).catch(() => ({ states: [] })),
        this.b.bridgeJson('/api/mcp/config').catch(() => ({ path: '', content: '{"mcpServers":{}}' })),
      ]);
      let config: any = {};
      try {
        config = JSON.parse(cfg.content || '{}');
      } catch {
        config = { mcpServers: {} };
      }
      if (!config.mcpServers) config.mcpServers = {};
      this.mcp = { states: states.states ?? [], configPath: cfg.path ?? '', config };
    } catch (e) {
      this.b.log(`[agy] mcp: ${this.err(e)}`);
      this.mcp = { states: [], configPath: '', config: { mcpServers: {} } };
    }
  }

  private mcpNames(): string[] {
    const m = this.mcp;
    if (!m) return [];
    return [...new Set<string>([...Object.keys(m.config.mcpServers ?? {}), ...m.states.map((s) => s.spec?.server_name).filter(Boolean)])].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
  }

  private mcpForm(name = '', spec: any = {}): SettingFormField[] {
    const isRemote = !!(spec.serverUrl || spec.url);
    return [
      { id: 'name', label: 'Name', kind: 'text', value: name, placeholder: 'github', required: true },
      {
        id: 'type',
        label: 'Type',
        kind: 'select',
        value: isRemote ? 'http' : 'stdio',
        options: [
          { value: 'stdio', label: 'Command (stdio)' },
          { value: 'http', label: 'Remote URL (HTTP / SSE)' },
        ],
      },
      { id: 'command', label: 'Command', kind: 'text', value: spec.command ?? '', placeholder: 'npx' },
      { id: 'args', label: 'Arguments (one per line)', kind: 'multiline', value: (spec.args ?? []).join('\n'), placeholder: '-y\n@modelcontextprotocol/server-github' },
      { id: 'env', label: 'Environment (KEY=value per line)', kind: 'multiline', value: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n') },
      { id: 'url', label: 'URL', kind: 'text', value: spec.serverUrl ?? spec.url ?? '', placeholder: 'https://example.com/mcp' },
      { id: 'headers', label: 'Headers (Name: value per line)', kind: 'multiline', value: Object.entries(spec.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n') },
    ];
  }

  private mcpPage(): SettingsPage {
    const m = this.mcp ?? { states: [], configPath: '', config: { mcpServers: {} } };
    const rows = this.mcpNames().map((name) => {
      const st = m.states.find((s) => s.spec?.server_name === name);
      const cfg = m.config.mcpServers?.[name] ?? {};
      const disabled = cfg.disabled === true || st?.spec?.disabled === true;
      const status: string = st?.status ?? '';
      const tools: any[] = st?.tools ?? [];
      const toolNames = tools.map((t) => t.name).filter(Boolean);
      const where = cfg.serverUrl || cfg.url || st?.spec?.server_url || [cfg.command ?? st?.spec?.command, ...(cfg.args ?? st?.spec?.args ?? [])].filter(Boolean).join(' ');
      return {
        id: name,
        title: name,
        subtitle: st?.error
          ? st.error
          : toolNames.length
            ? `${toolNames.slice(0, 6).join(', ')}${toolNames.length > 6 ? ` +${toolNames.length - 6}` : ''}`
            : where || null,
        status: disabled
          ? 'Off'
          : status.includes('READY') || status.includes('CONNECTED')
            ? `${tools.length} tool${tools.length === 1 ? '' : 's'}`
            : status.includes('ERROR')
              ? 'Error'
              : status
                ? status.replace('MCP_SERVER_STATUS_', '').toLowerCase()
                : 'Not started',
        statusTone: (disabled ? 'muted' : status.includes('ERROR') ? 'error' : status.includes('READY') || status.includes('CONNECTED') ? 'ok' : 'warn') as 'ok' | 'warn' | 'error' | 'muted',
        toggle: !disabled,
        actions: [
          { id: 'refresh', label: 'Reconnect' },
          ...(m.config.mcpServers?.[name]
            ? [
                { id: 'edit', label: 'Edit', form: this.mcpForm(name, cfg) },
                { id: 'remove', label: 'Remove', danger: true, confirm: `Remove the MCP server "${name}"?` },
              ]
            : []),
        ],
      };
    });
    return {
      id: 'agy.mcp',
      title: 'MCP Servers',
      sections: [
        {
          id: 'servers',
          title: 'Servers',
          agent: 'AGY',
          description: m.configPath ? `Config: ${m.configPath}` : null,
          items: [
            { kind: 'list', id: 'servers', label: 'MCP servers', rows, emptyText: 'No MCP servers yet', addLabel: 'Add server', addForm: this.mcpForm() },
            { kind: 'button', id: 'refreshAll', label: 'Reconnect all servers' },
          ],
        },
        {
          id: 'catalog',
          title: '',
          items: [{ kind: 'page', id: 'agy.mcp.catalog', label: 'MCP catalog', icon: 'storefront', description: 'One-click MCP integrations (Firebase, BigQuery, Cloud…)' }],
        },
      ],
    };
  }

  private async saveMcpConfig() {
    if (!this.mcp) return;
    await this.b.bridgeJson('/api/mcp/config', { method: 'POST', body: JSON.stringify({ content: JSON.stringify(this.mcp.config, null, 2) }), headers: { 'content-type': 'application/json' } });
    await this.b.callHub('RefreshMcpServers', {}).catch(() => undefined);
    await this.loadMcp();
  }

  private specFromForm(v: Record<string, string>): any {
    const lines = (s?: string) =>
      (s ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    if (v.type === 'http') {
      const headers: Record<string, string> = {};
      for (const l of lines(v.headers)) {
        const i = l.indexOf(':');
        if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      }
      if (!v.url?.trim()) throw new Error('Enter the server URL');
      return { serverUrl: v.url.trim(), ...(Object.keys(headers).length ? { headers } : {}) };
    }
    const env: Record<string, string> = {};
    for (const l of lines(v.env)) {
      const i = l.indexOf('=');
      if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1);
    }
    if (!v.command?.trim()) throw new Error('Enter the command');
    return { command: v.command.trim(), args: lines(v.args), ...(Object.keys(env).length ? { env } : {}) };
  }

  // --- MCP catalog (GetAvailableCascadePlugins: the app's CascadeMcpCatalogDialog)

  private async loadCatalog(query: string) {
    try {
      const r = await this.b.callHub('GetAvailableCascadePlugins', { os: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux', search_query: query, metadata: {} });
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
          title: 'Cascade MCP catalog',
          description: c.error ? `Couldn't load the catalog: ${c.error}` : `${c.plugins.length} package${c.plugins.length === 1 ? '' : 's'}${c.query ? ` matching "${c.query}"` : ''}`,
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
      this.b.callHub('GetAllSkills', { workspace_uris: ws ? [ws] : [] }).catch(() => ({ skills: [] })),
      this.b.callHub('GetAllPlugins', {}).catch(() => ({ plugins: [] })),
      this.b.callHub('GetBuildWithGooglePlugins', {}).catch(() => ({ plugins: [] })),
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
          title: `Skills (${skills.length})`,
          agent: 'AGY',
          description: ws ? `Workspace: ${ws.replace(/^file:\/\//, '')}` : 'Type / in the composer to use them',
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
          title: `Installed plugins (${plugins.length})`,
          items: [
            {
              kind: 'list',
              id: 'plugins',
              label: 'Plugins',
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
          title: 'Plugin store',
          description: "Official 'Build with Google' plugins",
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

  // --- CLI

  private async loadCli() {
    try {
      this.cli = await this.b.bridgeJson('/api/agy/cli');
    } catch (e) {
      this.cli = { installed: false, error: this.err(e) };
    }
    if (this.cli?.job?.running && !this.cliPoll) {
      this.cliPoll = setInterval(async () => {
        await this.loadCli();
        this.changed();
        if (!this.cli?.job?.running && this.cliPoll) {
          clearInterval(this.cliPoll);
          this.cliPoll = null;
        }
      }, 1500);
    }
  }

  private cliPage(): SettingsPage {
    const c = this.cli ?? {};
    const items: SettingItem[] = [
      { kind: 'info', id: 'installed', label: 'Installed', value: c.installed ? 'Yes' : 'No', tone: c.installed ? 'ok' : 'error' },
      { kind: 'info', id: 'version', label: 'Version', value: c.version || '—' },
      { kind: 'info', id: 'path', label: 'Path', value: c.path || '—', tone: 'muted' },
      c.installed
        ? { kind: 'button', id: 'update', label: 'Update agy', disabled: c.job?.running === true }
        : { kind: 'button', id: 'install', label: 'Install agy', style: 'primary', disabled: c.job?.running === true },
    ];
    if (c.job) {
      items.push({
        kind: 'info',
        id: 'job',
        label: c.job.running ? `${c.job.kind ?? 'Job'} running…` : `${c.job.kind ?? 'Job'} finished`,
        value: c.job.running ? '' : c.job.exit_code === 0 ? 'Done' : `Exit ${c.job.exit_code ?? '?'}`,
        tone: c.job.running ? 'warn' : c.job.exit_code === 0 ? 'ok' : 'error',
      });
      if (c.job.log) items.push({ kind: 'text', id: 'log', label: 'Log', value: String(c.job.log).slice(-6000), multiline: true, disabled: true });
    }
    return { id: 'agy.cli', title: 'Antigravity CLI', sections: [{ id: 'cli', title: 'agy', agent: 'AGY', items }] };
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
    if (page === 'agy.mcp' && id === 'servers' && rowId && this.mcp) {
      const enabled = value === true;
      const cfg = this.mcp.config.mcpServers?.[rowId];
      if (cfg) {
        if (enabled) delete cfg.disabled;
        else cfg.disabled = true;
      }
      await this.b.callHub('ToggleMcpServer', { server_name: rowId, enabled }).catch(() => undefined);
      if (cfg) await this.saveMcpConfig();
      else await this.loadMcp();
      this.changed();
    }
  }

  async action(page: string, id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void> {
    if (page === 'agy') {
      if (id === 'agy.signin') return this.signIn();
      if (id === 'agy.signin.cancel') {
        this.stopSignIn();
        await this.refreshAuth();
        return 'Sign-in cancelled';
      }
      if (id === 'agy.signin.open' && this.signingIn?.url) {
        this.b.openUrl(this.signingIn.url);
        return;
      }
      if (id === 'agy.signout') {
        await this.b.callHub('AuthLogout', {});
        this.auth = { loggedIn: false, email: '', name: '', tier: '', plan: '', upgradeUri: '', upgradeText: '', promptCredits: null, flowCredits: null };
        this.changed();
        this.b.afterSignIn();
        return 'Signed out of Antigravity';
      }
      if (id === 'agy.plan' && this.auth?.upgradeUri) {
        this.b.openUrl(this.auth.upgradeUri);
        return;
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
    if (page === 'agy.mcp' && id === 'refreshAll') {
      await this.b.callHub('RefreshMcpServers', {});
      await new Promise((r) => setTimeout(r, 600));
      await this.loadMcp();
      this.changed();
      const n = this.mcp?.states.length ?? 0;
      const tools = (this.mcp?.states ?? []).reduce((a, s) => a + (s.tools?.length ?? 0), 0);
      return `Refreshed: ${n} server${n === 1 ? '' : 's'}, ${tools} tool${tools === 1 ? '' : 's'}`;
    }
    if (page === 'agy.mcp' && id === 'servers') {
      if (!this.mcp) await this.loadMcp();
      const mcp = this.mcp!;
      if (actionId === 'add' && values) {
        const name = (values.name ?? '').trim();
        if (!name) throw new Error('Enter a name');
        mcp.config.mcpServers[name] = this.specFromForm(values);
        await this.saveMcpConfig();
        this.changed();
        return `Added ${name}`;
      }
      if (!rowId) return;
      if (actionId === 'refresh') {
        await this.b.callHub('RefreshMcpServers', { server_name: rowId });
        await new Promise((r) => setTimeout(r, 600));
        await this.loadMcp();
        this.changed();
        const s = this.mcp?.states.find((x) => x.spec?.server_name === rowId);
        if (s?.error) throw new Error(`${rowId}: ${s.error}`);
        return s?.tools?.length ? `Reconnected ${rowId}: ${s.tools.length} tools` : `Reconnected ${rowId}`;
      }
      if (actionId === 'remove') {
        delete mcp.config.mcpServers[rowId];
        await this.saveMcpConfig();
        this.changed();
        return `Removed ${rowId}`;
      }
      if (actionId === 'edit' && values) {
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
        await this.loadMcp(); // the config as it is now (another window may have changed it)
        this.mcp!.config.mcpServers[rowId] = spec;
        await this.saveMcpConfig();
        this.changed();
        return `Installed and activated '${p.title || rowId}' MCP server`;
      }
    }
    if (page === 'agy.skills' && rowId) {
      if (id === 'skills' && actionId === 'view') {
        const s = (this.skills ?? []).find((x) => (x.path || x.name) === rowId);
        if (s?.path) this.b.openFile(String(s.path).replace(/^file:\/\//, ''));
        return;
      }
      if (id === 'plugins') {
        const p = (this.plugins ?? []).find((x) => x.name === rowId);
        if (actionId === 'homepage' && p?.homepage) return void this.b.openUrl(p.homepage);
        if (actionId === 'repository' && p?.repository) return void this.b.openUrl(p.repository);
        if (actionId === 'delete') {
          const r = await this.b.callHub('DeletePlugin', { plugin_id: rowId });
          if (r.success !== true) throw new Error(r.message || 'Delete failed');
          await this.b.callHub('RefreshMcpServers', {}).catch(() => undefined);
          await this.afterPluginChange();
          return `Uninstalled ${p?.display_name || rowId}`;
        }
      }
      if (id === 'store' && actionId === 'install') {
        const r = await this.b.callHub('DownloadBuildWithGooglePlugin', { plugin_id: rowId }, 5 * 60_000);
        if (r.success !== true) throw new Error(r.message || 'Download failed');
        await this.b.callHub('RefreshMcpServers', {}).catch(() => undefined);
        await this.afterPluginChange();
        return r.message || `Installed ${rowId}`;
      }
    }
    if (page === 'agy.cli' && (id === 'install' || id === 'update')) {
      await this.b.bridgeJson(`/api/agy/cli/${id}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      await this.loadCli();
      this.changed();
      return id === 'install' ? 'Installing agy…' : 'Updating agy…';
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
  }

  /**
   * Google sign-in (the app's loginToAgyHub): already signed in → done; otherwise the hub's Login runs (the bridge
   * captures the address the hub prints, opened in the browser) while the account is polled until it is signed in.
   */
  private async signIn(): Promise<string> {
    if (this.loginPoll) {
      if (this.signingIn?.url) this.b.openUrl(this.signingIn.url);
      return 'Sign-in is already open in your browser';
    }
    try {
      const pre = await this.b.callHub('GetAuthStatus', {});
      if (pre.auth_result?.has_valid_auth) {
        await this.refreshAuth();
        return `Already signed in as ${this.auth?.name || this.auth?.email || 'your account'}`;
      }
    } catch {
      /* try the sign-in anyway */
    }
    this.signingIn = { url: '', started: Date.now() };
    this.changed();
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
          const r = await this.b.bridgeJson('/api/auth/login-url');
          if (r.loginUrl && this.signingIn) {
            this.signingIn.url = r.loginUrl;
            this.b.openUrl(r.loginUrl);
            this.changed();
          }
        }
        const st = await this.b.callHub('GetAuthStatus', {});
        if (st.auth_result?.has_valid_auth) {
          this.stopSignIn();
          await this.refreshAuth();
          this.b.afterSignIn();
          this.b.notify('info', `Signed in as ${this.auth?.name || this.auth?.email || 'your Google account'}`);
        } else if (this.signingIn && Date.now() - this.signingIn.started > 5 * 60_000) {
          this.stopSignIn();
          await this.refreshAuth();
          this.b.notify('warning', 'Sign-in timed out. Try again from Settings → Antigravity.');
        }
      } catch {
        /* keep polling */
      }
    }, 1500);
    return 'Opening Google sign-in in your browser…';
  }

  dispose() {
    if (this.loginPoll) clearInterval(this.loginPoll);
    if (this.cliPoll) clearInterval(this.cliPoll);
  }
}
