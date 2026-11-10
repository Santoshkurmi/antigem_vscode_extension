// Pieces every agent's settings pages share (Antigravity, Claude Code, Codex, OpenCode), so their pages look and
// behave the same: timeouts, the "agent is down" page, cached slow lists, the MCP servers page, usage-limit text.
// (Kept next to quota.ts, which the other agents already share.)
import type { AgentKind } from '../../../shared/model';
import type { AgentStatus, SettingFormField, SettingItem, SettingListRow, SettingsPage, SettingsSection } from '../../../shared/protocol';
import { mcpPresets, presetTiles, resolvePreset, type McpPreset, presetState, type ConfiguredServer } from '../mcp/presets';

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `p`, or an error after `ms` (the work itself goes on; only the wait ends). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** A fetch signal that gives up after `ms` (bridge reads of the settings pages). */
export const timeoutSignal = (ms: number) => AbortSignal.timeout(ms);

/** Waits until `ok()` holds (polled), at most `ms`; whether it holds. */
export async function waitFor(ok: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 150));
  return ok();
}

/**
 * A page that cannot be built because the agent is not usable (CLI missing, bridge or hub down): one card with the
 * reason and a link to the agent's CLI page, where it can be installed or fixed.
 */
export function unavailablePage(
  id: string,
  title: string,
  agent: AgentKind,
  reason: string,
  setup: { page: string; label: string; description?: string | null },
): SettingsPage {
  return {
    id,
    title,
    sections: [
      {
        id: 'unavailable',
        title: '',
        agent,
        items: [
          { kind: 'info', id: 'unavailable', label: 'Not available', value: reason, tone: 'error' },
          { kind: 'page', id: setup.page, label: setup.label, icon: 'terminal', description: setup.description ?? 'Install, update or fix it here' },
        ],
      },
    ],
  };
}

/** Why an agent's pages can't load right now (null = they can): its status says so. */
export function blockedReason(st: AgentStatus): string | null {
  if (st.state === 'online') return null;
  if (st.state === 'not_installed') return st.detail || `${st.label} is not installed.`;
  if (st.state === 'starting') return `${st.label} is still starting. Try again in a moment.`;
  return st.detail ? `${st.label} isn't running: ${st.detail}` : `${st.label} isn't running.`;
}

/**
 * A list read from an agent (MCP servers, plugins…), kept between page builds. A page waits for a fresh read only a
 * little; when the agent is slow the page shows what it has (marked loading) and is rebuilt once the read ends.
 */
export class Cached<T> {
  value: T | null = null;
  error: string | null = null;
  at = 0;
  private inflight: Promise<void> | null = null;
  private late = false;

  constructor(
    private load: () => Promise<T>,
    private onLateResult: () => void,
    private maxAgeMs = 4_000,
  ) {}

  get loading() {
    return this.inflight != null;
  }

  private start(): Promise<void> {
    if (!this.inflight) {
      this.late = false;
      this.inflight = this.load()
        .then(
          (v) => {
            this.value = v;
            this.error = null;
          },
          (e) => {
            this.error = errText(e);
          },
        )
        .finally(() => {
          this.at = Date.now();
          this.inflight = null;
          if (this.late) this.onLateResult();
        });
    }
    return this.inflight;
  }

  /** Re-reads when older than its max age (or `force`); true = done within `waitMs`, false = still loading. */
  async ensure(waitMs: number, force = false): Promise<boolean> {
    if (!force && !this.inflight && this.at && Date.now() - this.at < this.maxAgeMs) return true;
    // a read that started before a change can't be reused for it: queue a fresh one after it
    if (force && this.inflight) await withTimeout(this.inflight, waitMs, 'The agent').catch(() => undefined);
    const p = this.start();
    let done = false;
    await Promise.race([p.then(() => (done = true)), new Promise((r) => setTimeout(r, waitMs))]);
    if (!done) this.late = true;
    return done;
  }

  /** A fresh read after a change (waits for one already running first), at most `waitMs`; false = it goes on (the
   *  page is rebuilt when it ends). */
  reload(waitMs = 10_000): Promise<boolean> {
    return this.ensure(waitMs, true);
  }
}

// ------------------------------------------------------------------------------------------------ usage limits

/** "48.8%" (one decimal: Antigravity) or "49%" (whole: Claude, Codex) for a share left, as the app's quotaPercentText. */
export function remainingText(remaining: number, oneDecimal: boolean): string {
  const pct = Math.max(0, Math.min(100, remaining * 100));
  if (!oneDecimal) return `${Math.round(pct)}%`;
  const t = pct.toFixed(1);
  return `${t === '100.0' ? '100' : t}%`;
}

// ------------------------------------------------------------------------------------------------ MCP servers page
// The same page for every agent: one list (status chip, tools, on/off switch, Reconnect / Edit / Remove), an Add form,
// "Refresh all", then the agent's own extras. Ids are the same everywhere: list 'servers' (row actions 'refresh',
// 'edit', 'remove'; add = 'add'; switch = settingChange on 'servers' with the row), button 'refreshAll'.

export const MCP_LIST = 'servers';
export const MCP_REFRESH_ALL = 'refreshAll';
export const MCP_RECONNECT = 'refresh';
export const MCP_EDIT = 'edit';
export const MCP_REMOVE = 'remove';

export type McpState = 'connected' | 'error' | 'off' | 'connecting' | 'auth' | 'idle';

export interface McpServerView {
  name: string;
  state: McpState;
  /** Command line or URL. */
  where?: string | null;
  /** Where it is configured ("all projects", "from your OpenCode config"…). */
  origin?: string | null;
  error?: string | null;
  /** Tool count when known (null = unknown, e.g. not connected yet). */
  tools?: number | null;
  toolNames?: string[];
  /** The on/off switch (null = this agent can't switch this server). */
  enabled?: boolean | null;
  /** Reconnect is offered. */
  reconnect?: boolean;
  /** Edit form (null = can't be edited here). */
  editForm?: SettingFormField[] | null;
  /** Can be removed here. */
  removable?: boolean;
  /** Busy text ("Removing…") instead of the status while an action runs. */
  busy?: string | null;
}

const STATE_CHIP: Record<McpState, [string, SettingListRow['statusTone']]> = {
  connected: ['Connected', 'ok'],
  error: ['Error', 'error'],
  off: ['Off', 'muted'],
  connecting: ['Connecting…', 'warn'],
  auth: ['Needs sign-in', 'warn'],
  idle: ['Not started', 'muted'],
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function mcpRow(s: McpServerView): SettingListRow {
  const [chip, tone] = STATE_CHIP[s.state];
  const names = (s.toolNames ?? []).filter(Boolean);
  const tools =
    s.tools != null && s.state === 'connected'
      ? names.length
        ? `${plural(s.tools, 'tool')}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` +${names.length - 6}` : ''}`
        : plural(s.tools, 'tool')
      : null;
  const subtitle = [[s.where, s.origin].filter(Boolean).join(' · ') || null, s.state === 'error' || s.state === 'auth' ? (s.error ?? null) : tools].filter(Boolean).join('\n') || null;
  return {
    id: s.name,
    title: s.name,
    subtitle,
    status: s.busy ?? chip,
    statusTone: s.busy ? 'warn' : tone,
    toggle: s.busy ? null : (s.enabled ?? null),
    actions: s.busy
      ? []
      : [
          ...(s.reconnect !== false && s.state !== 'off' ? [{ id: MCP_RECONNECT, label: 'Reconnect' }] : []),
          ...(s.editForm ? [{ id: MCP_EDIT, label: 'Edit', form: s.editForm }] : []),
          ...(s.removable ? [{ id: MCP_REMOVE, label: 'Remove', danger: true, confirm: `Remove the MCP server "${s.name}"?` }] : []),
        ],
  };
}

/** The main page row's value for the MCP page ("2 active", "All off", "None"). */
export function mcpSummary(servers: McpServerView[] | null): string | null {
  if (!servers) return null;
  if (!servers.length) return 'None';
  const on = servers.filter((s) => s.state !== 'off').length;
  return on ? `${on} active` : 'All off';
}

export function mcpPage(opts: {
  id: string;
  title?: string;
  agent: AgentKind;
  /** Where the servers live / when they connect. */
  description: string;
  servers: McpServerView[];
  error?: string | null;
  addForm: SettingFormField[];
  loading?: boolean;
  /** One-tap servers (buttons whose form is prefilled; their action adds like 'add'): a card of their own. */
  presets?: SettingItem[];
  /** The agent's own extras (catalog…), after the presets. */
  extra?: SettingsSection[];
}): SettingsPage {
  const items: SettingItem[] = [];
  if (opts.error) items.push({ kind: 'info', id: 'mcpError', label: 'Could not read the servers', value: opts.error, tone: 'error' });
  const tools = opts.servers.reduce((n, s) => n + (s.state === 'connected' ? (s.tools ?? 0) : 0), 0);
  items.push(
    {
      kind: 'list',
      id: MCP_LIST,
      label: 'Servers',
      description: tools ? `${plural(tools, 'tool')} available` : null,
      rows: opts.servers.map(mcpRow),
      emptyText: opts.loading ? 'Loading…' : 'No MCP servers yet. Add one to give the agent more tools.',
      addLabel: 'Add server',
      addForm: opts.addForm,
    },
    { kind: 'button', id: MCP_REFRESH_ALL, label: 'Refresh all', description: 'Reconnect every server and read the list again' },
  );
  const sections: SettingsSection[] = [{ id: 'servers', title: '', agent: opts.agent, description: opts.description, items }];
  // ---- presets: one-tap servers, a card of their own between the list and the agent's extras
  if (opts.presets?.length) sections.push({ id: 'presets', title: '', agent: opts.agent, items: opts.presets });
  sections.push(...(opts.extra ?? []));
  return { id: opts.id, title: opts.title ?? 'MCP servers', sections, loading: opts.loading || undefined };
}

// ---- the app's preset tiles (src/core/mcp/presets.ts): one `presets` item; a tap sends settingAction
// {id: MCP_PRESETS, actionId: tile id, values: the tile's form}. 'custom' opens the agent's own add form.

export const MCP_PRESETS = 'presets';
export const MCP_CUSTOM_TILE = 'custom';

/** The tiles item: `added` from the configured server names; the custom tile carries the agent's add form. */
export function presetsItem(configuredNames: Iterable<ConfiguredServer>, addForm: SettingFormField[]): SettingItem {
  return {
    kind: 'presets',
    id: MCP_PRESETS,
    label: 'Quick add',
    description: 'One tap adds a ready-made server (some ask for a key or a path first)',
    tiles: presetTiles(configuredNames).map((t) => (t.id === MCP_CUSTOM_TILE ? { ...t, form: addForm } : t)),
  };
}

/** `replace` = a server with that name exists at another address (e.g. the phone app's): remove it first. */
export type PresetTap = { kind: 'add'; preset: McpPreset; replace?: boolean } | { kind: 'custom' } | { kind: 'done'; message: string };

/** What a tile tap does: add the preset (its form's values applied), open the custom form, or nothing (already
 *  added). Throws for an unknown / unavailable tile or a missing value (key, path). */
export function presetTap(tileId: string, values: Record<string, string> | undefined, configuredNames: Iterable<ConfiguredServer>): PresetTap {
  if (tileId === MCP_CUSTOM_TILE) return { kind: 'custom' };
  const tile = mcpPresets().find((p) => p.id === tileId);
  if (!tile) throw new Error(`Unknown preset ${tileId}`);
  const st = presetState(tile, configuredNames);
  if (st === 'added') return { kind: 'done', message: `${tile.name} is already added` };
  return { kind: 'add', preset: resolvePreset(tileId, values ?? {}), replace: st === 'stale' };
}

/** Headers of a preset without blank values (a server gets only the headers it has). */
export const presetHeaders = (p: McpPreset): Record<string, string> => Object.fromEntries(Object.entries(p.headers ?? {}).filter(([, v]) => v !== ''));

/** "Key: value" / "KEY=value" lines → map (blank lines skipped). */
export function parsePairs(text: string | undefined, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of (text ?? '').split('\n').map((x) => x.trim())) {
    const i = l.indexOf(sep);
    if (l && i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

/** A command line → its words (quotes keep spaces together). */
export function splitCommand(text: string | undefined): string[] {
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

/** Words → one command line (words with spaces quoted). */
export const joinCommand = (words: string[]) => words.map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(' ');

/**
 * The add / edit form every agent uses: name, type (command or remote URL), command line + environment, or URL +
 * headers. `extra` = the agent's own fields (Claude's scope); `nameLocked` hides the name when editing can't rename.
 */
export function mcpForm(init: {
  name?: string;
  remote?: boolean;
  command?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  nameLocked?: boolean;
  remoteTypes?: { value: string; label: string; description?: string }[];
  type?: string;
  extra?: SettingFormField[];
}): SettingFormField[] {
  const pairs = (o: Record<string, string> | undefined, sep: string) =>
    Object.entries(o ?? {})
      .map(([k, v]) => `${k}${sep}${v}`)
      .join('\n');
  const remoteTypes = init.remoteTypes ?? [{ value: 'http', label: 'Remote URL (HTTP)', description: 'A URL and optional headers' }];
  return [
    ...(init.nameLocked ? [] : [{ id: 'name', label: 'Name', kind: 'text' as const, value: init.name ?? '', placeholder: 'github', required: true }]),
    {
      id: 'type',
      label: 'Type',
      kind: 'select',
      value: init.type ?? (init.remote ? remoteTypes[0].value : 'stdio'),
      options: [{ value: 'stdio', label: 'Command (stdio)', description: 'A command started on this machine' }, ...remoteTypes],
    },
    ...(init.extra ?? []),
    { id: 'command', label: 'Command and arguments', kind: 'text', value: init.command ?? '', placeholder: 'npx -y @modelcontextprotocol/server-github' },
    { id: 'env', label: 'Environment (KEY=value per line)', kind: 'multiline', value: pairs(init.env, '=') },
    { id: 'url', label: 'URL', kind: 'text', value: init.url ?? '', placeholder: 'https://example.com/mcp' },
    { id: 'headers', label: 'Headers (Name: value per line)', kind: 'multiline', value: pairs(init.headers, ': ') },
  ];
}

/** The add / edit form's values, checked: a command, or an http(s) URL. */
export function mcpFormValues(v: Record<string, string>): { name: string; remote: boolean; type: string; command: string[]; env: Record<string, string>; url: string; headers: Record<string, string> } {
  const type = v.type || 'stdio';
  const remote = type !== 'stdio';
  const command = splitCommand(v.command);
  const url = (v.url ?? '').trim();
  if (!remote && !command.length) throw new Error('Enter the command');
  if (remote && !/^https?:\/\//.test(url)) throw new Error('Enter the server URL (http:// or https://)');
  return { name: (v.name ?? '').trim(), remote, type, command, env: parsePairs(v.env, '='), url, headers: parsePairs(v.headers, ':') };
}
