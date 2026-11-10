// Custom AntiGem plugins in the extension (port of the app's BrowserExtensionManager + PluginRepositories +
// PluginUpdateCheckWorker): the bridge owns every plugin file (list, install, update, remove…); this service loads the
// enabled plugins' workers into the Node runtime, serves each plugin's MCP at /mcp?extension=<id> (skills tools here,
// worker tools through the runtime), keeps the repositories and checks them for updates every 12 h.
//
// Several VS Code windows: the window that owns the MCP port (the "leader") runs the runtime and serves every plugin
// MCP; another window does bridge reads itself and asks the leader to make changes (hidden developer-MCP tool).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SlashCommandView } from '../../../shared/protocol';
import type { BridgeManager } from '../bridge/BridgeManager';
import type { Platform } from '../host';
import { errorResult, text, type McpHost, type McpResult, type McpServerDef, type McpTool } from '../mcp/server';
import type { KeyValueStore, Logger } from '../types';
import { NoBrowser, type BrowserProvider } from './browser';
import { PluginBridge, type Installed } from './bridgeApi';
import { pluginGuide, pluginSlashItems } from './expansion';
import { PluginRepositories, repoLabel } from './repos';
import { defaultRuntimeEntry, defaultSdkDir, PluginRuntime } from './runtime';
import { callSkillTool, listSkills, SKILL_TOOL_NAMES, skillInstructions, skillTools } from './skills';
import { compareVersions, pluginJson, versionLabel, type Plugin, type PluginHostApi, type RepoInstallProgress, type RepoPlugin } from './types';

export interface PluginServiceOptions {
  bridge: BridgeManager;
  store: KeyValueStore;
  log: Logger;
  mcp: McpHost;
  platform: Platform;
  /** runtime/host-ipc.mjs (default: dist/plugin-runtime next to the bundle). */
  runtimeEntry?: string;
  /** The SDK docs folder (default: dist/plugin-sdk). */
  sdkDir?: string;
}

/** The hidden developer-MCP tool another window uses to ask the leader for a change. */
export const RUNTIME_TOOL = 'antigem_runtime';
const HOUR = 3600_000;

/** Whether a plugin needs the Node runtime (a worker, worker tools or content scripts); skills-only plugins do not. */
function manifestOf(p: Plugin): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(p.dirPath, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}
export function needsWorker(p: Plugin): boolean {
  const m = manifestOf(p);
  if (!m) return p.toolCount > 0;
  const bg = (m.background ?? {}) as Record<string, unknown>;
  return !!(bg.service_worker || (Array.isArray(bg.scripts) && bg.scripts.length) || (Array.isArray(m.mcp_tools) && m.mcp_tools.length) || (Array.isArray(m.content_scripts) && m.content_scripts.length));
}
const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

export class PluginService {
  readonly bridgeApi: PluginBridge;
  readonly repos: PluginRepositories;
  readonly runtime: PluginRuntime;
  readonly sdkDir: string;
  private list: Plugin[] = [];
  private listLoaded = false;
  private listError: string | null = null;
  private refreshing: Promise<Plugin[]> | null = null;
  private lastListAt = 0;
  private leader = false;
  private api: PluginHostApi | null = null;
  private browser: BrowserProvider = new NoBrowser();
  private browserUnsub: (() => void) | null = null;
  /** Worker start failures by plugin id (shown on the plugin row, returned by MCP calls). */
  readonly loadErrors = new Map<string, string>();
  /** A running repository install (shown on the plugin pages). */
  progress: RepoInstallProgress | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  private crashes: number[] = [];
  private disposed = false;

  constructor(private opts: PluginServiceOptions) {
    this.bridgeApi = new PluginBridge(opts.bridge);
    this.repos = new PluginRepositories(opts.store, this.bridgeApi, () => this.changed('settings'));
    this.sdkDir = opts.sdkDir ?? defaultSdkDir();
    const home = os.homedir();
    this.runtime = new PluginRuntime({
      entry: opts.runtimeEntry ?? defaultRuntimeEntry(),
      root: path.join(home, 'extensions'),
      stateRoot: path.join(home, '.antigem', 'browser-extensions', '.antigem-state'),
      log: opts.log,
      browser: () => this.browser,
    });
    this.runtime.onExit(() => this.onRuntimeExit());
  }

  get platform() {
    return this.opts.platform;
  }
  get log() {
    return this.opts.log;
  }
  get isLeader() {
    return this.leader;
  }

  bind(api: PluginHostApi) {
    this.api = api;
  }

  private changed(what: 'settings' | 'commands' | 'both') {
    if (what !== 'commands') this.api?.refreshSettings();
    if (what !== 'settings') this.api?.refreshCommands();
  }

  /** Starts reading the plugin list (and loading workers once this window is the leader). */
  start() {
    void this.refresh().catch(() => undefined);
    // other windows / the phone app / a file manager can change plugin folders: pick that up now and then
    this.timers.push(
      setInterval(() => {
        if (this.leader) void this.refresh().then(() => this.sync()).catch(() => undefined);
      }, 60_000),
    );
  }

  /** This window owns the MCP port: it runs the plugin workers and checks for updates. */
  setLeader(leader: boolean) {
    this.leader = leader;
    if (!leader) return;
    void this.refresh()
      .then(() => this.sync())
      .catch((e) => this.log(`[plugins] ${e instanceof Error ? e.message : String(e)}`));
    // the 12 h update check (the app's PluginUpdateCheckWorker), first shortly after start
    this.timers.push(setTimeout(() => void this.checkUpdates(false), 45_000));
    this.timers.push(setInterval(() => void this.checkUpdates(false), HOUR));
  }

  /** The browser the plugins' chrome.* API uses (the AntiGem Chrome extension client, Phase 4). */
  setBrowser(provider: BrowserProvider) {
    this.browserUnsub?.();
    this.browser = provider;
    this.browserUnsub = provider.onAvailability?.((on) => this.runtime.browserChanged(on)) ?? null;
    this.runtime.browserChanged(provider.available());
  }

  browserProvider() {
    return this.browser;
  }

  // ------------------------------------------------------------------ the plugin list (bridge)

  plugins(): Plugin[] {
    return this.list;
  }
  loaded(): boolean {
    return this.listLoaded;
  }
  error(): string | null {
    return this.listError;
  }
  find(id: string): Plugin | undefined {
    return this.list.find((p) => p.id === id);
  }

  /** Reads the plugin list from the bridge (one request at a time). */
  refresh(): Promise<Plugin[]> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.bridgeApi
      .list()
      .then((list) => {
        const before = JSON.stringify(this.list);
        this.list = list;
        this.listLoaded = true;
        this.listError = null;
        this.lastListAt = Date.now();
        if (JSON.stringify(list) !== before) this.changed('both');
        return list;
      })
      .catch((e) => {
        this.listError = e instanceof Error ? e.message : String(e);
        throw e;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /** The list, refreshed when it is older than `maxAgeMs`. */
  async fresh(maxAgeMs = 3000): Promise<Plugin[]> {
    if (Date.now() - this.lastListAt > maxAgeMs) await this.refresh().catch(() => undefined);
    return this.list;
  }

  // ------------------------------------------------------------------ `/plu:`

  slashItems(): SlashCommandView[] {
    return pluginSlashItems(this.list);
  }

  guide(id: string, skill: string | null): string | null {
    return pluginGuide(this.list, id, skill);
  }

  mcpUrl(id: string) {
    return this.opts.mcp.url(`/mcp?extension=${encodeURIComponent(id)}`);
  }

  // ------------------------------------------------------------------ runtime (leader)

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** id → loaded folder (real path) of the workers running now. */
  async loadedWorkers(): Promise<Map<string, string>> {
    if (!this.runtime.running()) return new Map();
    const list = await this.runtime.call<{ id: string; dir: string }[]>('list').catch(() => []);
    return new Map(list.map((e) => [e.id, e.dir]));
  }

  /** Whether an enabled plugin is ready: skills-only always, a worker plugin when its worker runs from its folder. */
  async isLoaded(p: Plugin, workers?: Map<string, string>): Promise<boolean> {
    if (!p.isEnabled) return false;
    if (!needsWorker(p)) return true;
    const w = workers ?? (await this.loadedWorkers());
    return w.get(p.id) === real(p.dirPath);
  }

  private async load(p: Plugin) {
    if (!needsWorker(p)) return;
    try {
      await this.runtime.call('load', { dir: p.dirPath }, 30_000);
      this.loadErrors.delete(p.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.loadErrors.set(p.id, msg);
      throw new Error(msg);
    }
  }

  private async unloadIfLoaded(id: string) {
    if (!this.runtime.running()) return;
    const w = await this.loadedWorkers();
    if (w.has(id)) await this.runtime.call('unload', { id });
  }

  /** Loads every enabled worker plugin and unloads the rest (the app's refreshExtensions). */
  sync(): Promise<void> {
    if (!this.leader || this.disposed) return Promise.resolve();
    return this.lock(async () => {
      const desired = this.list.filter((p) => p.isEnabled && needsWorker(p));
      if (!desired.length && !this.runtime.running()) return;
      const loaded = await this.loadedWorkers();
      for (const [id, dir] of loaded) {
        if (!desired.some((p) => p.id === id && real(p.dirPath) === dir)) await this.runtime.call('unload', { id }).catch(() => undefined);
      }
      for (const p of desired) {
        if (loaded.get(p.id) === real(p.dirPath)) continue;
        await this.load(p).catch((e) => this.log(`[plugins] ${p.id}: ${e instanceof Error ? e.message : String(e)}`));
      }
      for (const id of [...this.loadErrors.keys()]) if (!desired.some((p) => p.id === id)) this.loadErrors.delete(id);
      // once started the runtime stays up (as the app's host): worker logs survive disable / reload / remove
      this.changed('settings');
    });
  }

  private onRuntimeExit() {
    if (!this.leader || this.disposed) return;
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
    if (this.crashes.length > 3) {
      this.log('[plugins] the plugin runtime keeps exiting; not restarting it until the next change');
      this.changed('settings');
      return;
    }
    setTimeout(() => void this.sync(), 2000);
  }

  /** Loads a plugin the bridge just placed; if it fails to start, the bridge puts the previous files back. */
  private async activate(installed: Plugin, previous: Plugin | null): Promise<Plugin> {
    if (previous?.isEnabled) await this.unloadIfLoaded(previous.id);
    if (installed.isEnabled) {
      try {
        await this.unloadIfLoaded(installed.id);
        await this.load(installed);
      } catch (e) {
        await this.unloadIfLoaded(installed.id).catch(() => undefined);
        await this.bridgeApi.restore(installed.folderName).catch(() => undefined);
        if (previous?.isEnabled) await this.load(previous).catch(() => undefined);
        await this.refresh().catch(() => undefined);
        throw e;
      }
    }
    await this.bridgeApi.commit(installed.folderName).catch(() => undefined);
    const list = await this.refresh().catch(() => this.list);
    return list.find((p) => p.id === installed.id) ?? installed;
  }

  private previousFor(updateId: string | null): Plugin | null {
    if (!updateId) return null;
    const p = this.find(updateId);
    if (!p) throw new Error('Extension not found');
    return p;
  }

  // ------------------------------------------------------------------ changes (run by the leader)

  /** Runs a change in the window that owns the plugin runtime (this one, or the leader through its MCP port). */
  private async exec<T>(op: string, args: Record<string, unknown>): Promise<T> {
    if (this.leader) return (await this.local(op, args)) as T;
    try {
      const r = (await this.remote(op, args)) as T;
      await this.refresh().catch(() => undefined);
      return r;
    } catch (e) {
      // no AntiGem window serves the port: make the bridge change here (no workers run anywhere then)
      if ((e as { noLeader?: boolean }).noLeader) return (await this.local(op, args)) as T;
      throw e;
    }
  }

  private async remote(op: string, args: Record<string, unknown>): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(this.opts.mcp.url('/extension_developer'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.opts.mcp.headers() },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: RUNTIME_TOOL, arguments: { op, args } } }),
        signal: AbortSignal.timeout(600_000),
      });
    } catch (e) {
      throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { noLeader: true });
    }
    if (!res.ok) throw Object.assign(new Error(`AntiGem MCP port: HTTP ${res.status}`), { noLeader: true });
    const body = (await res.json()) as { result?: McpResult; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    const t = body.result?.content?.[0];
    const txt = t && t.type === 'text' ? t.text : 'null';
    if (body.result?.isError) {
      let msg = txt;
      try {
        msg = JSON.parse(txt).error ?? txt;
      } catch {
        /* plain text */
      }
      throw new Error(msg);
    }
    return JSON.parse(txt);
  }

  /** A change, in this window (the leader, or no leader at all). */
  async local(op: string, a: Record<string, unknown>): Promise<unknown> {
    const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
    if (op === 'sync') {
      await this.refresh();
      await this.sync();
      return { success: true };
    }
    return this.lock(async () => {
      await this.refresh().catch(() => undefined);
      switch (op) {
        case 'installZip': {
          const previous = this.previousFor(s('updateId') || null);
          const inst = await this.bridgeApi.install(s('zipPath'), s('folder').trim(), s('updateId') || null, a.asNew === true);
          return this.activate(inst.plugin, previous);
        }
        case 'installRepo': {
          const previous = this.previousFor(s('updateId') || null);
          const inst = await this.bridgeApi.repoInstall(s('repo'), s('path'), s('folder').trim(), s('updateId') || null, a.asNew === true);
          return this.activate(inst.plugin, previous);
        }
        case 'installDraft': {
          const previous = this.previousFor(s('updateId') || null);
          const inst: Installed = await this.bridgeApi.draftInstall(s('projectId') || null, s('zipPath') || null, s('folder').trim(), s('updateId') || null);
          return this.activate(inst.plugin, previous);
        }
        case 'setEnabled': {
          const p = this.find(s('id'));
          if (!p) throw new Error('Extension not found');
          if (a.enabled === true) await this.load(p);
          else {
            await this.unloadIfLoaded(p.id);
            this.loadErrors.delete(p.id);
          }
          await this.bridgeApi.setEnabled(p.id, a.enabled === true);
          await this.refresh();
          return this.find(p.id) ?? p;
        }
        case 'reload': {
          const p = this.find(s('id'));
          if (!p) throw new Error('Extension not found');
          if (p.isEnabled) {
            await this.unloadIfLoaded(p.id);
            await this.load(p);
          }
          await this.refresh();
          return this.find(p.id) ?? p;
        }
        case 'rename': {
          const p = this.find(s('id'));
          if (!p) throw new Error('Extension not found');
          if (p.isEnabled) await this.unloadIfLoaded(p.id);
          let renamed: Plugin;
          try {
            renamed = await this.bridgeApi.rename(p.id, s('folder').trim());
          } catch (e) {
            if (p.isEnabled) await this.load(p).catch(() => undefined);
            throw e;
          }
          if (renamed.isEnabled) await this.load(renamed);
          await this.refresh();
          return this.find(p.id) ?? renamed;
        }
        case 'remove': {
          const p = this.find(s('id'));
          if (!p) throw new Error('Extension not found');
          await this.unloadIfLoaded(p.id);
          this.loadErrors.delete(p.id);
          await this.bridgeApi.remove(p.id, a.deleteData === true);
          await this.refresh();
          // another root's plugin with the same ID (e.g. a bundled copy) takes over
          const other = this.find(p.id);
          if (other?.isEnabled) await this.load(other).catch(() => undefined);
          return { success: true };
        }
        default:
          throw new Error(`Unknown plugin operation ${op}`);
      }
    });
  }

  installZip(zipPath: string, folder: string, updateId: string | null, asNew: boolean): Promise<Plugin> {
    return this.exec('installZip', { zipPath, folder, updateId, asNew });
  }

  async installRepo(repo: string, plugin: RepoPlugin, folder: string, updateId: string | null, asNew = false): Promise<Plugin> {
    // the bridge reports the download while it runs; the pages show it
    this.progress = { folder, phase: 'listing', bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0 };
    this.changed('settings');
    let stop = false;
    const poll = (async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 400));
        if (stop) break;
        const p = await this.bridgeApi.repoProgress(folder).catch(() => null);
        if (stop) break;
        this.progress = p ?? (this.progress ? { ...this.progress, phase: 'starting' } : null);
        this.changed('settings');
      }
    })();
    try {
      return await this.exec('installRepo', { repo, path: plugin.path, folder, updateId, asNew });
    } finally {
      stop = true;
      await poll;
      this.progress = null;
      this.changed('settings');
    }
  }

  installDraft(projectId: string | null, zipPath: string | null, folder: string, updateId: string | null): Promise<Plugin> {
    return this.exec('installDraft', { projectId, zipPath, folder, updateId });
  }
  setEnabled(id: string, enabled: boolean): Promise<Plugin> {
    return this.exec('setEnabled', { id, enabled });
  }
  reload(id: string): Promise<Plugin> {
    return this.exec('reload', { id });
  }
  rename(id: string, folder: string): Promise<Plugin> {
    return this.exec('rename', { id, folder });
  }
  remove(id: string, deleteData: boolean): Promise<unknown> {
    return this.exec('remove', { id, deleteData });
  }
  /** Reconciles disk and live workers (another window asks the leader). */
  resync(): Promise<unknown> {
    return this.exec('sync', {});
  }

  // ------------------------------------------------------------------ plugin MCP (/mcp?extension=<id>)

  /** The worker tools a plugin offers: the running worker's, else its manifest's (they answer once it runs). */
  private async ownTools(p: Plugin): Promise<McpTool[]> {
    if (!needsWorker(p)) return [];
    if (await this.isLoaded(p)) return this.runtime.call<McpTool[]>('tools', { id: p.id }).catch(() => []);
    const m = manifestOf(p);
    return (Array.isArray(m?.mcp_tools) ? (m!.mcp_tools as Record<string, unknown>[]) : [])
      .filter((t) => typeof t.name === 'string')
      .map((t) => ({ name: String(t.name), description: String(t.description ?? ''), inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} } }));
  }

  /** tools/list of one plugin: its own tools, then the skills tools it does not override. */
  async pluginTools(p: Plugin): Promise<McpTool[]> {
    const own = await this.ownTools(p);
    let skills: McpTool[] = [];
    try {
      const list = listSkills(p.dirPath);
      skills = list.length ? skillTools(list) : [];
    } catch (e) {
      this.log(`[plugins] ${p.id} skills: ${e instanceof Error ? e.message : String(e)}`);
    }
    return own.concat(skills.filter((t) => !own.some((o) => o.name === t.name)));
  }

  /** tools/call of one plugin (the runtime's callTool: skills here, the rest by its worker). */
  async callPluginTool(p: Plugin, name: string, args: Record<string, unknown>): Promise<McpResult> {
    const wrap = (value: unknown): McpResult => {
      const v = value as McpResult | null;
      if (v && Array.isArray(v.content)) return v;
      return text(typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2));
    };
    try {
      const own = await this.ownTools(p);
      if (SKILL_TOOL_NAMES.includes(name) && !own.some((t) => t.name === name) && listSkills(p.dirPath).length) return wrap(callSkillTool(p.dirPath, name, args));
      if (!own.some((t) => t.name === name)) throw new Error(`Tool not found in extension ${p.id}: ${name}`);
      if (!this.leader) throw new Error('Plugin tools run in the AntiGem window that serves the MCP port');
      if (!(await this.isLoaded(p))) {
        await this.lock(() => this.load(p)).catch(() => undefined);
        if (!(await this.isLoaded(p)))
          throw new Error(`The plugin's worker is not running${this.loadErrors.get(p.id) ? `: ${this.loadErrors.get(p.id)}` : ''}. See webview_extension_logs.`);
      }
      return wrap(await this.runtime.call('call', { id: p.id, tool: name, args }, 185_000));
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  }

  /** The server at /mcp: dispatches on ?extension=<id> (400 without one, 404 for a disabled / unknown plugin). */
  pluginMcp(): McpServerDef {
    return {
      path: '/mcp',
      name: 'custom_plugin_mcp',
      tools: () => [],
      call: () => errorResult('Select one extension using ?extension=EXTENSION_ID'),
      resolve: async (query) => {
        const id = query.get('extension');
        if (!id) return { status: 400, error: 'Select one extension using ?extension=EXTENSION_ID' };
        let p = this.find(id);
        if (!p?.isEnabled) p = (await this.fresh(3000)).find((x) => x.id === id);
        if (!p?.isEnabled) return { status: 404, error: 'Extension is disabled or not loaded' };
        const plugin = p;
        let instructions: string | undefined;
        try {
          instructions = skillInstructions(plugin.name || plugin.id, listSkills(plugin.dirPath));
        } catch {
          instructions = undefined;
        }
        return {
          path: '/mcp',
          name: plugin.id,
          version: plugin.version || '1.0.0',
          instructions,
          tools: () => this.pluginTools(plugin),
          // every name reaches call(): an unknown one is a scoped tool error, as in the app
          hiddenTool: () => true,
          call: (name, args) => this.callPluginTool(plugin, name, args),
        };
      },
    };
  }

  // ------------------------------------------------------------------ worker logs / tests (developer MCP)

  async logs(id: string | null, limit: number): Promise<{ logs: unknown[]; retained: number; capacity: number }> {
    if (!this.runtime.running()) {
      const failed = [...this.loadErrors].filter(([k]) => !id || k === id).map(([k, m]) => ({ extension_id: k, time: Date.now(), level: 'error', message: m }));
      return { logs: failed.slice(-limit), retained: failed.length, capacity: 500 };
    }
    return this.runtime.call('logs', { id: id ?? '', limit });
  }

  /** Why the runtime can't run the enabled worker plugins (null = fine or not needed). */
  hostError(): string | null {
    const need = this.list.some((p) => p.isEnabled && needsWorker(p));
    return need && this.leader && !this.runtime.running() ? this.runtime.lastError : null;
  }

  // ------------------------------------------------------------------ updates (12 h, the app's PluginUpdateCheckWorker)

  /** Lists the repositories again and notifies once per plugin version that has an update. */
  async checkUpdates(force: boolean) {
    if (this.disposed) return;
    const last = this.opts.store.get<number>('plugins.updateCheckAt') ?? 0;
    if (!force && Date.now() - last < 12 * HOUR) return;
    this.opts.store.set('plugins.updateCheckAt', Date.now());
    const installed = await this.refresh().catch(() => null);
    if (!installed?.some((p) => p.source)) return;
    await this.repos.refreshAll().catch(() => undefined);
    this.notifyUpdates();
  }

  /** Repositories listed on open (the app lists them each time its plugin screen opens; here at most every 2 min). */
  refreshReposIfStale() {
    if (Date.now() - this.repos.lastRefresh < 120_000) return;
    this.repos.lastRefresh = Date.now();
    void Promise.all([this.repos.refreshAll(), this.refresh().catch(() => undefined)]).then(() => this.notifyUpdates());
  }

  updatesAvailable(): { plugin: Plugin; offered: RepoPlugin; repo: string }[] {
    const out: { plugin: Plugin; offered: RepoPlugin; repo: string }[] = [];
    for (const p of this.list) {
      const u = this.repos.updateFor(p);
      if (u) out.push({ plugin: p, offered: u.offered, repo: repoLabel(u.repo) });
    }
    return out;
  }

  /** Notifies (toast + system notification) once per plugin version that has an update in its repository. */
  notifyUpdates() {
    const notified = this.opts.store.get<Record<string, string>>('plugins.updateNotified') ?? {};
    let changed = false;
    for (const { plugin, offered } of this.updatesAvailable()) {
      if (notified[plugin.id] === offered.version) continue;
      notified[plugin.id] = offered.version;
      changed = true;
      const name = plugin.name || plugin.folderName;
      const message = `Plugin update: ${name} ${versionLabel(plugin.version)} → ${versionLabel(offered.version)} · update it in Settings → Custom AntiGem Plugins`;
      this.log(`[plugins] ${message}`);
      this.api?.broadcast({ type: 'toast', level: 'info', message });
      this.platform.notify?.(message, { label: 'Open plugins', run: () => this.api?.openSettings('plugins.installed') });
    }
    if (changed) this.opts.store.set('plugins.updateNotified', notified);
    this.changed('settings');
  }

  /** "v1 → v2 (newer)" between an installed and an incoming version. */
  static versionChange(installed: string, incoming: string, incomingLabel = 'This ZIP'): string {
    const c = compareVersions(incoming, installed);
    const hint = c == null ? '' : c === 0 ? ' (same version)' : c > 0 ? ' (newer)' : ' (older than installed)';
    return `Installed: ${versionLabel(installed)} → ${incomingLabel}: ${versionLabel(incoming)}${hint}`;
  }

  /** The plugin's JSON for the developer MCP (the app's toJsonObject + mcp_url). */
  metadata(p: Plugin): Record<string, unknown> {
    return { ...pluginJson(p), mcp_url: this.mcpUrl(p.id) };
  }

  dispose() {
    this.disposed = true;
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
    this.browserUnsub?.();
    this.runtime.dispose();
  }
}
