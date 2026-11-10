// Custom AntiGem plugins (the app's BrowserExtension): what the bridge's /api/custom-plugins lists, and the hooks the
// host gives the plugin feature (settings pages, `/plu:` items and expansion).
import type { HostToView, SettingItem, SettingsPage, SlashCommandView } from '../../../shared/protocol';

/** One skills/<name>.md of a plugin (bridge pkg/plugins/skills.go). */
export interface PluginSkill {
  name: string;
  title: string;
  description: string;
  /** Absolute path of the skill file. */
  path: string;
  /** Absolute path of skills/<name>/ when it exists. */
  detailDir?: string;
}

/** `.antigem-source.json` of a repository install. */
export interface PluginSource {
  repo: string;
  ref: string;
  path: string;
}

/** A plugin as the bridge lists it (JSON keys of the app's BrowserExtension). */
export interface Plugin {
  id: string;
  name: string;
  version: string;
  description: string;
  toolCount: number;
  skillCount: number;
  folderName: string;
  permissions: string[];
  isEnabled: boolean;
  dirPath: string;
  iconPath: string;
  source?: PluginSource | null;
  /** installed | bundled | user_folder */
  location: string;
  skills: PluginSkill[];
}

/** One plugin a repository offers (bridge RepoPlugin). */
export interface RepoPlugin {
  path: string;
  id: string;
  name: string;
  version: string;
  description: string;
  iconUrl: string;
}

export interface RepoListing {
  title: string;
  plugins: RepoPlugin[];
  fromIndex: boolean;
}

/** A public GitHub repository of plugin folders; `ref` = branch or tag ('' = default branch). */
export interface PluginRepo {
  owner: string;
  name: string;
  ref: string;
}

/** A running repository install (bridge /repo/progress). */
export interface RepoInstallProgress {
  folder: string;
  phase: string;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
}

/** What the host gives the plugin feature. */
export interface PluginHostApi {
  broadcast(msg: HostToView): void;
  /** Re-sends open settings pages. */
  refreshSettings(): void;
  /** Re-sends every agent's `/` commands (the plugin list changed). */
  refreshCommands(): void;
  /** Shows a settings page in the view the user used last. */
  openSettings(page: string): void;
}

/** The plugin feature, as the host sees it. */
export interface PluginHooks {
  bind(api: PluginHostApi): void;
  /** `/` picker rows: `/plu:`, each enabled plugin and its skills. */
  slashItems(): SlashCommandView[];
  /** The note `/plu:<id>[:<skill>]` expands to (null = no such enabled plugin). */
  guide(pluginId: string, skill: string | null): string | null;
  /** Settings → Custom AntiGem Plugins (pages 'plugins' and 'plugins.*'). */
  readonly settings: {
    rootItem(): SettingItem;
    page(id: string): Promise<SettingsPage>;
    change(page: string, id: string, value: unknown, rowId?: string): Promise<void>;
    action(page: string, id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void>;
  };
  dispose(): void;
}

/** The MCP server name an agent's config uses for a plugin (BrowserExtensionManager.mcpServerName). */
export const pluginServerName = (id: string) => (id === 'google-flow' ? 'google_flow_mcp' : `extension_${id}`);

/** "v1.2.0", or "no version" (PluginVersions.label). */
export const versionLabel = (v: string | null | undefined) => (!v || !v.trim() ? 'no version' : `v${v.trim().replace(/^v/, '')}`);

/** Part-by-part numeric comparison; null when either is missing or not numeric (PluginVersions.compare). */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a?.trim() || !b?.trim()) return null;
  const parse = (v: string) => v.trim().replace(/^v/, '').split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  const x = parse(a);
  const y = parse(b);
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** A plugin from the bridge's JSON, with defaults for missing keys. */
export function pluginFromJson(o: Record<string, unknown>): Plugin {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const src = o.source as Record<string, unknown> | null | undefined;
  return {
    id: s(o.id),
    name: s(o.name) || s(o.folderName) || s(o.id),
    version: s(o.version),
    description: s(o.description),
    toolCount: Number(o.toolCount ?? 0) || 0,
    skillCount: Number(o.skillCount ?? 0) || 0,
    folderName: s(o.folderName),
    permissions: Array.isArray(o.permissions) ? (o.permissions as unknown[]).filter((p): p is string => typeof p === 'string') : [],
    isEnabled: o.isEnabled !== false,
    dirPath: s(o.dirPath),
    iconPath: s(o.iconPath),
    source: src && s(src.repo) ? { repo: s(src.repo), ref: s(src.ref), path: s(src.path) } : null,
    location: s(o.location) || 'installed',
    skills: Array.isArray(o.skills)
      ? (o.skills as Record<string, unknown>[]).map((k) => ({
          name: s(k.name),
          title: s(k.title) || s(k.name),
          description: s(k.description),
          path: s(k.path),
          ...(s(k.detailDir) ? { detailDir: s(k.detailDir) } : {}),
        }))
      : [],
  };
}

/** The app's BrowserExtension.toJsonObject() (what the developer MCP returns for a plugin). */
export function pluginJson(p: Plugin): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    description: p.description,
    toolCount: p.toolCount,
    skillCount: p.skillCount,
    folderName: p.folderName,
    permissions: p.permissions,
    isEnabled: p.isEnabled,
    dirPath: p.dirPath,
    iconPath: p.iconPath,
    ...(p.source ? { source: p.source } : {}),
  };
}
