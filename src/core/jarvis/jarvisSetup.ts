// Registers jarvis_mcp with each agent, the app's way (port of the Setup card of JarvisSettingsScreen.kt):
// - Antigravity: the bridge's /api/mcp/config (mcp_config.json) `mcpServers.jarvis_mcp = {serverUrl, headers}`, then the
//   hub's RefreshMcpServers;
// - Claude Code: the bridge's POST /api/claude/mcp (`claude mcp add --scope user --transport http --header …`), plus the
//   allow rule `mcp__jarvis_mcp` in ~/.claude/settings.json (otherwise every Jarvis tool call asks for approval);
// - Codex: `config/batchWrite` mcp_servers.jarvis_mcp {url, http_headers} + `config/mcpServer/reload` (POST /api/codex/rpc);
// - OpenCode: PUT /api/opencode/mcp/jarvis_mcp {type: 'remote', url, headers}.
import type { AgentKind } from '../../../shared/model';
import type { AgentBackend } from '../types';
import type { BridgeAccess, McpAccess } from './types';

export const JARVIS_MCP_NAME = 'jarvis_mcp';
const RULE = `mcp__${JARVIS_MCP_NAME}`;

export interface SetupStatus {
  /** null = unknown (the agent did not answer). */
  added: boolean | null;
  /** Claude: the allow rule for Jarvis' tools is there. */
  allowed?: boolean | null;
  /** Live connection state when the agent reports one ("connected", "failed"…). */
  state?: string | null;
  error?: string | null;
  checkedAt: number;
}

type HubCaller = { callHub?: (name: string, req: object, timeoutMs?: number) => Promise<unknown> };

export class JarvisSetup {
  private cache = new Map<AgentKind, SetupStatus>();
  private checking = new Map<AgentKind, Promise<SetupStatus>>();

  constructor(
    private bridge: BridgeAccess,
    private mcp: McpAccess,
    private backend: (k: AgentKind) => AgentBackend | undefined,
    private onChange: () => void,
  ) {}

  url() {
    return this.mcp.url('/jarvis');
  }

  cached(k: AgentKind): SetupStatus | null {
    return this.cache.get(k) ?? null;
  }

  /** Every enabled agent's status (fresh = ask the agents again; otherwise the cache, checked in the background). */
  async status(fresh = false, kinds: AgentKind[] = ['AGY', 'CLAUDE', 'CODEX', 'OPENCODE']): Promise<Record<string, boolean | null>> {
    const list = kinds.filter((k) => this.backend(k));
    const out: Record<string, boolean | null> = {};
    await Promise.all(
      list.map(async (k) => {
        const s = fresh || !this.cache.has(k) ? await this.check(k) : this.cache.get(k)!;
        out[k.toLowerCase()] = s.added;
      }),
    );
    return out;
  }

  /** Looks once at whether jarvis_mcp is configured for [k] (several callers share one look). */
  check(k: AgentKind): Promise<SetupStatus> {
    const running = this.checking.get(k);
    if (running) return running;
    const p = this.doCheck(k)
      .catch((e): SetupStatus => ({ added: null, error: e instanceof Error ? e.message : String(e), checkedAt: Date.now() }))
      .then((s) => {
        this.cache.set(k, s);
        this.checking.delete(k);
        this.onChange();
        return s;
      });
    this.checking.set(k, p);
    return p;
  }

  isChecking(k: AgentKind) {
    return this.checking.has(k);
  }

  private async doCheck(k: AgentKind): Promise<SetupStatus> {
    const now = Date.now();
    switch (k) {
      case 'AGY': {
        const cfg = await this.bridge.json<{ content?: string }>('/api/mcp/config');
        const servers = parseJson(cfg?.content)?.mcpServers ?? {};
        return { added: JARVIS_MCP_NAME in servers, checkedAt: now };
      }
      case 'CLAUDE': {
        const [mcp, settings] = await Promise.all([
          this.bridge.json<{ success?: boolean; servers?: { name?: string; status?: string; error?: string }[]; error?: string }>('/api/claude/mcp', { signal: AbortSignal.timeout(70_000) }),
          this.bridge.json<{ success?: boolean; settings?: { permissions?: { allow?: string[] } } }>('/api/claude/settings').catch(() => null),
        ]);
        if (!mcp?.success) return { added: null, error: mcp?.error ?? 'Claude Code did not answer', checkedAt: now };
        const s = (mcp.servers ?? []).find((x) => x?.name === JARVIS_MCP_NAME);
        const allow = settings?.settings?.permissions?.allow;
        return { added: !!s, state: s?.status ?? null, error: s?.error ?? null, allowed: Array.isArray(allow) ? allow.includes(RULE) : null, checkedAt: now };
      }
      case 'CODEX': {
        const r = await this.codexRpc('config/read', { includeLayers: false });
        const servers = (r as { config?: { mcp_servers?: Record<string, unknown> } })?.config?.mcp_servers ?? {};
        return { added: JARVIS_MCP_NAME in servers, checkedAt: now };
      }
      case 'OPENCODE': {
        const r = await this.bridge.json<{ success?: boolean; servers?: Record<string, unknown>; error?: string }>('/api/opencode/mcp');
        if (r?.success === false) return { added: null, error: r.error ?? 'OpenCode did not answer', checkedAt: now };
        return { added: JARVIS_MCP_NAME in (r?.servers ?? {}), checkedAt: now };
      }
    }
  }

  private async codexRpc(method: string, params: unknown): Promise<unknown> {
    const r = await this.bridge.json<{ success?: boolean; result?: unknown; error?: string }>('/api/codex/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(90_000),
    });
    if (r?.success !== true) throw new Error(r?.error ?? 'Codex did not answer');
    return r.result ?? null;
  }

  /** Adds (or replaces) jarvis_mcp in [k]'s configuration. Returns a short message for a toast. */
  async add(k: AgentKind): Promise<string> {
    const url = this.url();
    const headers = this.mcp.headers();
    const json = (p: string, method: string, body: unknown, timeoutMs = 60_000) =>
      this.bridge.json(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    switch (k) {
      case 'AGY': {
        const cfg = await this.bridge.json<{ content?: string }>('/api/mcp/config');
        const config = parseJson(cfg?.content) ?? {};
        config.mcpServers = { ...(config.mcpServers ?? {}), [JARVIS_MCP_NAME]: { serverUrl: url, headers } };
        await json('/api/mcp/config', 'POST', { content: JSON.stringify(config, null, 2) }, 15_000);
        await (this.backend('AGY') as HubCaller | undefined)?.callHub?.('RefreshMcpServers', {}, 15_000).catch(() => undefined);
        break;
      }
      case 'CLAUDE': {
        const r = (await json('/api/claude/mcp', 'POST', { name: JARVIS_MCP_NAME, scope: 'user', transport: 'http', url, headers }, 90_000)) as { success?: boolean; error?: string };
        if (!r?.success) throw new Error(`Could not add it to Claude Code: ${lastLine(r?.error) ?? 'add failed'}`);
        await this.allowClaudeTools();
        break;
      }
      case 'CODEX':
        await this.codexRpc('config/batchWrite', { edits: [{ keyPath: `mcp_servers.${JARVIS_MCP_NAME}`, value: { url, http_headers: headers }, mergeStrategy: 'replace' }], reloadUserConfig: true });
        await this.codexRpc('config/mcpServer/reload', {}).catch(() => undefined);
        break;
      case 'OPENCODE': {
        const r = (await json(`/api/opencode/mcp/${JARVIS_MCP_NAME}`, 'PUT', { type: 'remote', url, headers })) as { success?: boolean; error?: string };
        if (r?.success !== true) throw new Error(r?.error ?? 'OpenCode did not save it');
        break;
      }
    }
    await this.check(k);
    return `Added the Jarvis MCP server to ${label(k)}`;
  }

  /** Claude: Jarvis' own tools run without asking (allow rule `mcp__jarvis_mcp`). */
  async allowClaudeTools(): Promise<void> {
    const r = await this.bridge.json<{ success?: boolean; settings?: Record<string, any>; error?: string }>('/api/claude/settings'); // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!r?.success || !r.settings || typeof r.settings !== 'object') throw new Error(r?.error ?? "Couldn't read Claude's settings.json");
    const next = JSON.parse(JSON.stringify(r.settings));
    const perms = (next.permissions ??= {});
    const allow: string[] = Array.isArray(perms.allow) ? perms.allow : [];
    if (allow.includes(RULE)) return;
    perms.allow = [...allow, RULE];
    const w = await this.bridge.json<{ success?: boolean; error?: string }>('/api/claude/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: next }),
    });
    if (!w?.success) throw new Error(`Could not save Claude's settings: ${w?.error ?? 'refused'}`);
  }

  /** Removes jarvis_mcp from [k]'s configuration (the undo of add). */
  async remove(k: AgentKind): Promise<string> {
    switch (k) {
      case 'AGY': {
        const cfg = await this.bridge.json<{ content?: string }>('/api/mcp/config');
        const config = parseJson(cfg?.content) ?? {};
        if (config.mcpServers) delete config.mcpServers[JARVIS_MCP_NAME];
        await this.bridge.json('/api/mcp/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: JSON.stringify(config, null, 2) }) });
        await (this.backend('AGY') as HubCaller | undefined)?.callHub?.('RefreshMcpServers', {}, 15_000).catch(() => undefined);
        break;
      }
      case 'CLAUDE': {
        const r = await this.bridge.json<{ success?: boolean; error?: string }>(`/api/claude/mcp?name=${JARVIS_MCP_NAME}&scope=user`, { method: 'DELETE', signal: AbortSignal.timeout(90_000) });
        if (!r?.success) throw new Error(lastLine(r?.error) ?? 'remove failed');
        break;
      }
      case 'CODEX':
        await this.codexRpc('config/batchWrite', { edits: [{ keyPath: `mcp_servers.${JARVIS_MCP_NAME}`, value: null, mergeStrategy: 'replace' }], reloadUserConfig: true });
        await this.codexRpc('config/mcpServer/reload', {}).catch(() => undefined);
        break;
      case 'OPENCODE':
        await this.bridge.json(`/api/opencode/mcp/${JARVIS_MCP_NAME}`, { method: 'DELETE' });
        break;
    }
    await this.check(k);
    return `Removed the Jarvis MCP server from ${label(k)}`;
  }
}

function label(k: AgentKind) {
  return k === 'CLAUDE' ? 'Claude Code' : k === 'OPENCODE' ? 'OpenCode' : k === 'CODEX' ? 'Codex' : 'Antigravity';
}

function parseJson(s: string | null | undefined): Record<string, any> | null { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

function lastLine(s: string | null | undefined): string | null {
  const lines = (s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}
