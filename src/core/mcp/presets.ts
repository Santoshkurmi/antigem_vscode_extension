// The app's MCP preset tiles, shared by every agent's MCP page (agy, Claude, Codex, OpenCode). Built-in servers point
// at the extension's MCP host (http://127.0.0.1:<port><path> + X-Device-Id); a tile is disabled until that server is
// served. Order, names and subtitles follow the app (SettingsDialog.kt McpSubScreen presets, ClaudeSettingsScreen,
// CodexMcpPage, OpenCodeMcpPage); terminal / Android / REA presets are not offered on PC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SettingFormField } from '../../../shared/protocol';

export interface PresetEnv {
  port: number;
  deviceId: string;
  /** Whether the MCP host serves this path in this window (or another window on the same port). */
  served(p: string): boolean;
}

let env: PresetEnv | null = null;

/** Set once by the extension / dev server after creating the McpHost. */
export function setPresetEnv(e: PresetEnv) {
  env = e;
}

/** An enabled custom plugin the "Custom Plugin MCP" tile can add (its MCP is /mcp?extension=<id>). */
export interface PresetPlugin {
  id: string;
  name: string;
  folderName: string;
  toolCount: number;
  skillCount: number;
  /** Server name in the agent's config (extension_<id>; google_flow_mcp for google-flow). */
  serverName: string;
}

let pluginSource: (() => PresetPlugin[]) | null = null;

/** Set by the plugin feature: the enabled plugins with tools or skills, for the Custom Plugin MCP picker. */
export function setPresetPlugins(fn: () => PresetPlugin[]) {
  pluginSource = fn;
}

export interface McpPreset {
  /** Tile id (settingAction actionId). */
  id: string;
  name: string;
  subtitle: string;
  icon: string;
  accent: string;
  /** Server name written into the agent's config ("notes_mcp"). */
  serverName: string;
  /** 'http' = remote URL (+ headers), 'stdio' = command, 'custom' = open the empty add form. */
  transport: 'http' | 'stdio' | 'custom';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  /** Asked before adding (Stitch API key, DeepX path…); values fill headers / args. */
  form?: SettingFormField[];
  available: boolean;
  /** Why it is disabled. */
  note?: string;
}

const local = (p: string): { url: string; headers: Record<string, string> } => ({
  url: env ? `http://127.0.0.1:${env.port}${p}` : '',
  headers: env ? { 'X-Device-Id': env.deviceId } : {},
});

function deepxDefault(): string {
  const candidates = [
    path.join(os.homedir(), 'agy_cli_hub', 'antiGem', 'flow_mcp', 'deepx-mcp', 'bin', 'deepx-mcp.mjs'),
    path.join(os.homedir(), 'flow_mcp', 'deepx-mcp', 'bin', 'deepx-mcp.mjs'),
    path.join(os.homedir(), 'deepx-mcp', 'bin', 'deepx-mcp.mjs'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? '';
}

/** Every preset, in the app's order. */
export function mcpPresets(): McpPreset[] {
  const builtIn = (id: string, name: string, subtitle: string, icon: string, accent: string, serverName: string, p: string, later?: string): McpPreset => {
    const available = !!env && env.served(p);
    return { id, name, subtitle, icon, accent, serverName, transport: 'http', ...local(p), available, note: available ? undefined : (later ?? 'Coming soon') };
  };
  return [
    customPluginTile(builtIn('custom_plugin', 'Custom Plugin MCP', 'Pick an installed plugin', 'extension', '#D97757', 'extension', '/mcp', 'Install a plugin first (Settings → Plugins)')),
    builtIn('plugin_developer', 'Plugin Developer', 'Build & test AntiGem plugins', 'developer_mode', '#A78BFA', 'custom_plugin_developer_mcp', '/extension_developer'),
    builtIn('browser', 'Browser', 'Control Chrome via the AntiGem extension', 'language', '#3B82F6', 'browser_mcp', '/browser'),
    builtIn('notes', 'Notes & To-dos', 'Read & edit your notes', 'edit_note', 'warning', 'notes_mcp', '/notes'),
    builtIn('jarvis', 'Jarvis', 'Let Jarvis run tasks with your agents', 'record_voice_over', '#14B8A6', 'jarvis_mcp', '/jarvis'),
    builtIn('theme', 'Theme', 'Create & switch app themes', 'palette', 'tertiary', 'theme_mcp', '/theme'),
    {
      id: 'stitch',
      name: 'Stitch',
      subtitle: 'Google Stitch UI design · API key',
      icon: 'palette',
      accent: '#EC4899',
      serverName: 'stitch',
      transport: 'http',
      url: 'https://stitch.googleapis.com/mcp',
      headers: { 'X-Goog-Api-Key': '' },
      form: [{ id: 'apiKey', label: 'Stitch API key', kind: 'password', placeholder: 'AIza…', required: true }],
      available: true,
    },
    {
      id: 'google_flow',
      name: 'Google Flow',
      subtitle: 'Veo & Imagen via the DeepX Chrome extension',
      icon: 'movie',
      accent: '#22C55E',
      serverName: 'google_flow_mcp',
      transport: 'stdio',
      command: 'node',
      args: [deepxDefault()],
      form: [{ id: 'path', label: 'deepx-mcp.mjs path (flow_mcp/deepx-mcp/bin)', kind: 'text', value: deepxDefault(), placeholder: '~/flow_mcp/deepx-mcp/bin/deepx-mcp.mjs', required: true }],
      available: true,
    },
    { id: 'custom', name: 'Custom server', subtitle: 'Any stdio / HTTP / SSE server', icon: 'add', accent: 'primary', serverName: '', transport: 'custom', available: true },
  ];
}

/**
 * The preset with the form's values applied (Stitch key header, DeepX path arg). Throws when a required value is
 * missing.
 */
/** The Custom Plugin MCP tile: available with an enabled plugin; its form picks the plugin (the app's chooser). */
function customPluginTile(p: McpPreset): McpPreset {
  const plugins = pluginSource?.() ?? [];
  if (!p.available) return p;
  if (!plugins.length) return { ...p, available: false, note: 'Install or enable a plugin first (Settings → Custom AntiGem Plugins)' };
  return {
    ...p,
    form: [
      {
        id: 'plugin',
        label: 'Plugin',
        kind: 'select',
        value: plugins[0].id,
        required: true,
        options: plugins.map((x) => ({
          value: x.id,
          label: x.folderName || x.name,
          description: [x.name, `${x.toolCount} tools`, x.skillCount ? `${x.skillCount} skills` : ''].filter(Boolean).join(' · '),
        })),
      },
    ],
  };
}

export function resolvePreset(id: string, values: Record<string, string> = {}): McpPreset {
  const p = mcpPresets().find((x) => x.id === id);
  if (!p) throw new Error(`Unknown preset ${id}`);
  if (!p.available) throw new Error(`${p.name}: ${p.note ?? 'not available'}`);
  if (p.id === 'custom_plugin') {
    const plugins = pluginSource?.() ?? [];
    const picked = plugins.find((x) => x.id === (values.plugin ?? '').trim()) ?? (plugins.length === 1 ? plugins[0] : undefined);
    if (!picked) throw new Error('Choose an enabled plugin');
    return { ...p, name: picked.name, serverName: picked.serverName, ...local(`/mcp?extension=${encodeURIComponent(picked.id)}`) };
  }
  if (p.id === 'stitch') {
    const key = (values.apiKey ?? '').trim();
    if (!key) throw new Error('Enter the Stitch API key');
    return { ...p, headers: { 'X-Goog-Api-Key': key } };
  }
  if (p.id === 'google_flow') {
    const raw = (values.path ?? p.args?.[0] ?? '').trim().replace(/^~(?=\/)/, os.homedir());
    if (!raw || !fs.existsSync(raw)) throw new Error('Enter the path of deepx-mcp.mjs (from the DeepX project: flow_mcp/deepx-mcp/bin)');
    return { ...p, args: [raw] };
  }
  return p;
}

/** A configured server: its name, and its URL when it is a remote one. Plain names are accepted too. */
export type ConfiguredServer = string | { name: string; url?: string | null };

function configured(list: Iterable<ConfiguredServer>): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const e of list) {
    if (typeof e === 'string') m.set(e.toLowerCase(), null);
    else if (e?.name) m.set(e.name.toLowerCase(), e.url ?? null);
  }
  return m;
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * State of a preset against the agent's config: 'none', 'added' (same name, same address — or no address known), or
 * 'stale' (same name, another address: e.g. the phone app's 127.0.0.1:8765 server) — a stale one is replaced on tap.
 */
export function presetState(p: McpPreset, list: Iterable<ConfiguredServer>): 'none' | 'added' | 'stale' {
  if (!p.serverName) return 'none';
  const m = configured(list);
  if (!m.has(p.serverName.toLowerCase())) return 'none';
  const url = m.get(p.serverName.toLowerCase());
  if (p.transport === 'http' && url && p.url && !p.url.startsWith('https://stitch') && !sameUrl(url, p.url)) return 'stale';
  return 'added';
}

/** Tiles for the `presets` settings item. */
export function presetTiles(list: Iterable<ConfiguredServer>) {
  const all = [...list];
  return mcpPresets().map((p) => {
    const st = presetState(p, all);
    return {
      id: p.id,
      name: p.name,
      subtitle: !p.available ? (p.note ?? p.subtitle) : st === 'stale' ? 'Added with another address · tap to update' : p.subtitle,
      icon: p.icon,
      accent: p.accent,
      added: st === 'added',
      disabled: !p.available,
      form: p.form ?? null,
    };
  });
}
