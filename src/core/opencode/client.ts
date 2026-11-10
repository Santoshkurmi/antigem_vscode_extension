// Port of the app's OpenCodeBridgeClient.kt: the bridge's `/api/opencode/` endpoints. `/x/...` is OpenCode's own v2 API
// relayed by the bridge (which runs `opencode serve` and adds its password); the rest is the bridge's own (status,
// custom providers, credentials without secrets, MCP servers, install / update).
import type { BridgeManager } from '../bridge/BridgeManager';
import { arr, isObj, obj, sleep, str, type Json } from './common';

/** OpenCode is turned off on the bridge, or the bridge has no OpenCode support yet, or it could not start. */
export class OpenCodeUnavailableError extends Error {
  constructor(
    message: string,
    readonly disabled = false,
    readonly outdated = false,
  ) {
    super(message);
  }
}

export interface OpenCodeStatus {
  success?: boolean;
  installed?: boolean;
  running?: boolean;
  starting?: boolean;
  binary?: string | null;
  version?: string | null;
  error?: string | null;
  logs?: string[] | null;
  uptime_seconds?: number | null;
}

export interface OpenCodeCustomModel {
  id: string;
  name?: string | null;
  context_length?: number | null;
  max_output_tokens?: number | null;
  reasoning?: boolean;
  no_tools?: boolean;
  images?: boolean;
}

export interface OpenCodeCustomProvider {
  id: string;
  name: string;
  /** "openai" (chat/completions) or "anthropic" (messages). */
  kind: string;
  base_url: string;
  /** Only sent when saving (blank keeps the saved key, "-" clears it); the bridge never returns it. */
  api_key?: string | null;
  has_api_key?: boolean;
  api_key_hint?: string | null;
  headers?: Record<string, string> | null;
  models: OpenCodeCustomModel[];
}

/** An install / update of OpenCode running on the bridge (its log grows while it runs). */
export interface OpenCodeCliJob {
  kind: string;
  running: boolean;
  exit_code?: number | null;
  log: string;
}

/** One MCP server as Settings shows it. `saved`: added from AntiGem (kept in the bridge's OpenCode config). */
export interface OpenCodeMcpServer {
  name: string;
  saved: boolean;
  config: Json | null;
  status: string | null;
  error: string | null;
}

export interface OpenCodeCredential {
  id: string;
  integrationId: string;
  label: string;
  active: boolean;
  type: string | null;
}

/** Cold starts of `opencode serve` can take a while. */
const API_TIMEOUT_MS = 75_000;
/** The event stream: OpenCode sends a heartbeat every 15 s, so a minute of silence means the connection is dead. */
const STREAM_IDLE_MS = 60_000;

export class OpenCodeClient {
  constructor(private bridge: BridgeManager) {}

  /** Runs one request to the bridge's /api/opencode{path}; the answer's text (non-2xx → error). */
  private async execute(path: string, init: RequestInit = {}, timeoutMs = API_TIMEOUT_MS): Promise<string> {
    const res = await this.bridge.fetch(`/api/opencode${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    const trimmed = text.trimStart();
    const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    if (res.status === 404 && !isJson) throw new OpenCodeUnavailableError('This bridge has no OpenCode support yet. Update and restart it.', false, true);
    if (res.status === 503 && text.includes('"disabled":true')) throw new OpenCodeUnavailableError('The bridge was started with OpenCode turned off.', true);
    if (!res.ok) {
      let msg = '';
      try {
        const o = JSON.parse(text);
        msg = str(o, 'error') ?? str(o, 'message') ?? str(obj(o, 'data'), 'message') ?? '';
      } catch {
        msg = text.trim().slice(0, 200);
      }
      if (res.status === 503 && text.includes('opencode_unavailable')) throw new OpenCodeUnavailableError(msg || 'OpenCode could not start');
      throw new Error(msg || `HTTP ${res.status}`);
    }
    return text;
  }

  private async executeJson(path: string, init: RequestInit = {}): Promise<Json> {
    const text = await this.execute(path, init);
    return text.trim() ? JSON.parse(text) : null;
  }

  // ---- OpenCode API (relayed)

  /** One request to OpenCode's `/api{path}`; the JSON answer (null for an empty one, e.g. 204). */
  async api(method: string, path: string, body?: unknown): Promise<Json> {
    const hasBody = body !== undefined || method === 'POST' || method === 'PUT' || method === 'PATCH';
    const init: RequestInit = {
      method,
      headers: hasBody ? { 'content-type': 'application/json' } : {},
      body: hasBody ? JSON.stringify(body ?? {}) : undefined,
    };
    return this.executeJson(`/x${path}`, init);
  }
  get(path: string) {
    return this.api('GET', path);
  }
  post(path: string, body?: unknown) {
    return this.api('POST', path, body);
  }
  patch(path: string, body: unknown) {
    return this.api('PATCH', path, body);
  }
  del(path: string) {
    return this.api('DELETE', path);
  }

  /**
   * OpenCode's live events (every session), reconnecting until `signal` aborts. `onConnected` runs after each
   * (re)connection so the caller can resync what it may have missed (the stream has no replay).
   */
  async events(signal: AbortSignal, onEvent: (e: Json) => void, onConnected: () => void, onDisconnected: (e: unknown) => void): Promise<void> {
    let backoff = 1000;
    while (!signal.aborted) {
      const ac = new AbortController();
      const abort = () => ac.abort();
      signal.addEventListener('abort', abort);
      let idle: NodeJS.Timeout | null = null;
      const touch = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => ac.abort(), STREAM_IDLE_MS);
      };
      let failure: unknown = null;
      let unavailable: OpenCodeUnavailableError | null = null;
      try {
        touch();
        const res = await this.bridge.fetch('/api/opencode/x/event', { headers: { accept: 'text/event-stream' }, signal: ac.signal });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 503 && text.includes('"disabled":true')) throw new OpenCodeUnavailableError('OpenCode is turned off on the bridge.', true);
          if (res.status === 404 && !text.trimStart().startsWith('{')) throw new OpenCodeUnavailableError('This bridge has no OpenCode support yet.', false, true);
          let msg = `HTTP ${res.status}`;
          try {
            msg = str(JSON.parse(text), 'error') ?? msg;
          } catch {
            /* keep */
          }
          throw res.status === 503 ? new OpenCodeUnavailableError(msg) : new Error(msg);
        }
        if (!res.body) throw new Error('no body');
        backoff = 1000;
        onConnected();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let data = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          touch();
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            let line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (!line) {
              if (data) {
                try {
                  const ev = JSON.parse(data);
                  if (isObj(ev)) onEvent(ev);
                } catch {
                  /* not JSON */
                }
                data = '';
              }
            } else if (line.startsWith('data:')) {
              if (data) data += '\n';
              data += line.slice(5).replace(/^ /, '');
            }
            // ": heartbeat" comments and other fields are ignored
          }
        }
      } catch (e) {
        if (e instanceof OpenCodeUnavailableError) unavailable = e;
        else failure = e;
      } finally {
        if (idle) clearTimeout(idle);
        signal.removeEventListener('abort', abort);
      }
      if (signal.aborted) break;
      onDisconnected(unavailable ?? failure);
      await sleep(unavailable && (unavailable.disabled || unavailable.outdated) ? 60_000 : backoff);
      backoff = Math.min(backoff * 2, 15_000);
    }
  }

  // ---- bridge endpoints

  async status(): Promise<OpenCodeStatus> {
    return (await this.executeJson('/status')) as OpenCodeStatus;
  }

  async restart(): Promise<void> {
    const r = await this.executeJson('/restart', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    if (r?.success !== true) throw new Error(str(r, 'error') ?? 'OpenCode did not restart');
  }

  /** Starts installing ("install") or updating ("update") OpenCode on the bridge's machine. */
  async startCliJob(action: 'install' | 'update'): Promise<OpenCodeCliJob> {
    const r = await this.executeJson(`/cli/${action}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    if (r?.success !== true) throw new Error(str(r, 'error') ?? `Could not start the ${action}`);
    return (r.job as OpenCodeCliJob) ?? { kind: action, running: true, log: '' };
  }

  async cliJob(): Promise<OpenCodeCliJob | null> {
    const r = await this.executeJson('/cli/job');
    return (r?.job as OpenCodeCliJob) ?? null;
  }

  /** The saved accounts (the bridge leaves their secrets out; never use OpenCode's own /credential list). */
  async credentials(): Promise<OpenCodeCredential[]> {
    const o = await this.executeJson('/credentials');
    if (o?.success === false) throw new Error(str(o, 'error') ?? 'Could not list the accounts');
    return arr(o, 'credentials')
      .filter((c) => str(c, 'id'))
      .map((c) => ({
        id: str(c, 'id')!,
        integrationId: str(c, 'integrationID') ?? '',
        label: str(c, 'label') ?? 'Account',
        active: c.active === true,
        type: str(c, 'type') ?? null,
      }));
  }

  async activateCredential(id: string): Promise<void> {
    await this.post(`/credential/${encodeURIComponent(id)}/activate`);
  }
  async removeCredential(id: string): Promise<void> {
    await this.del(`/credential/${encodeURIComponent(id)}`);
  }

  /** Uses an API key for a built-in provider (OpenCode saves it on the server). */
  async connectKey(integrationId: string, key: string, answer: Record<string, unknown> = {}, label = 'Added from AntiGem'): Promise<void> {
    await this.post(`/integration/${encodeURIComponent(integrationId)}/connect/key`, { key, ...(Object.keys(answer).length ? { answer } : {}), label });
  }

  /** Starts an OAuth sign-in; the attempt (id, url, instructions, mode). */
  async startOAuth(integrationId: string, methodId: string, answer: Record<string, unknown> = {}): Promise<Json> {
    const r = await this.post(`/integration/${encodeURIComponent(integrationId)}/connect/oauth`, {
      methodID: methodId,
      ...(Object.keys(answer).length ? { answer } : {}),
      label: 'Added from AntiGem',
    });
    const d = obj(r, 'data') ?? r;
    if (!str(d, 'attemptID')) throw new Error('OpenCode did not start the sign-in');
    return d;
  }

  async oauthStatus(integrationId: string, attemptId: string): Promise<{ status: 'pending' | 'complete' | 'failed'; message?: string }> {
    const r = await this.get(`/integration/${encodeURIComponent(integrationId)}/connect/oauth/${encodeURIComponent(attemptId)}`);
    const d = obj(r, 'data') ?? r;
    const s = str(d, 'status');
    return s === 'complete' ? { status: 'complete' } : s === 'failed' ? { status: 'failed', message: str(d, 'message') ?? 'The sign-in failed.' } : { status: 'pending' };
  }

  async completeOAuth(integrationId: string, attemptId: string, code: string): Promise<void> {
    await this.post(`/integration/${encodeURIComponent(integrationId)}/connect/oauth/${encodeURIComponent(attemptId)}/complete`, { code });
  }

  async cancelOAuth(integrationId: string, attemptId: string): Promise<void> {
    await this.del(`/integration/${encodeURIComponent(integrationId)}/connect/oauth/${encodeURIComponent(attemptId)}`).catch(() => undefined);
  }

  /**
   * Hands the 127.0.0.1 address a browser sign-in came back to over to the bridge (the browser ran on another
   * machine than OpenCode, e.g. VS Code Remote): the bridge calls it on its own loopback so OpenCode finishes.
   */
  async forwardOAuthCallback(callbackUrl: string): Promise<void> {
    const o = await this.executeJson('/oauth-callback', { method: 'POST', body: JSON.stringify({ url: callbackUrl }), headers: { 'content-type': 'application/json' } });
    if (o?.success !== true) throw new Error(str(o, 'error') ?? 'The bridge could not finish the sign-in');
  }

  /** Uses credentials already on the server (Claude Code's login, an AWS profile, gcloud). */
  async connectExternal(integrationId: string, methodId: string, answer: Record<string, unknown> = {}): Promise<void> {
    await this.post(`/integration/${encodeURIComponent(integrationId)}/connect/external`, {
      methodID: methodId,
      ...(Object.keys(answer).length ? { answer } : {}),
      label: 'Added from AntiGem',
    });
  }

  /** The servers added from AntiGem plus every server OpenCode reports (the user's own config included). */
  async mcpList(): Promise<OpenCodeMcpServer[]> {
    const o = await this.executeJson('/mcp');
    if (o?.success === false) throw new Error(str(o, 'error') ?? 'Could not list the MCP servers');
    const saved: Record<string, Json> = obj(o, 'servers') ?? {};
    const live = new Map<string, Json>();
    for (const s of arr(obj(o, 'status'), 'data')) if (str(s, 'name')) live.set(str(s, 'name')!, s);
    const names = [...new Set([...Object.keys(saved), ...live.keys()])].filter(Boolean).sort();
    return names.map((name) => {
      const st = obj(live.get(name), 'status');
      return { name, saved: name in saved, config: isObj(saved[name]) ? saved[name] : null, status: str(st, 'status') ?? null, error: str(st, 'error') ?? null };
    });
  }

  /** Adds (or replaces) an MCP server for every OpenCode chat ({type:"local",command,environment} or {type:"remote",url,headers}). */
  async putMcp(name: string, config: Record<string, unknown>): Promise<void> {
    const o = await this.executeJson(`/mcp/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(config), headers: { 'content-type': 'application/json' } });
    if (o?.success !== true) throw new Error(str(o, 'error') ?? 'Could not save the MCP server');
  }

  async removeMcp(name: string): Promise<void> {
    const o = await this.executeJson(`/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (o?.success !== true) throw new Error(str(o, 'error') ?? 'Could not remove the MCP server');
  }

  async customProviders(): Promise<OpenCodeCustomProvider[]> {
    const r = await this.executeJson('/custom-providers');
    if (r?.success !== true) throw new Error(str(r, 'error') ?? 'Could not load the custom providers');
    return (r.providers as OpenCodeCustomProvider[]) ?? [];
  }

  /** Adds `p` (blank id) or updates it. */
  async saveCustomProvider(p: OpenCodeCustomProvider): Promise<OpenCodeCustomProvider> {
    const init: RequestInit = { method: p.id ? 'PUT' : 'POST', body: JSON.stringify(p), headers: { 'content-type': 'application/json' } };
    const r = await this.executeJson(p.id ? `/custom-providers/${encodeURIComponent(p.id)}` : '/custom-providers', init);
    if (r?.success !== true) throw new Error(str(r, 'error') ?? 'Could not save the provider');
    return (r.provider as OpenCodeCustomProvider) ?? p;
  }

  async deleteCustomProvider(id: string): Promise<void> {
    const r = await this.executeJson(`/custom-providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (r?.success !== true) throw new Error(str(r, 'error') ?? 'Could not remove the provider');
  }

  /** The model ids an endpoint lists (`GET {base}/models`). `savedId`: use that provider's saved key when `apiKey` is blank. */
  async fetchModels(kind: string, baseUrl: string, apiKey: string, savedId = ''): Promise<OpenCodeCustomModel[]> {
    const r = await this.executeJson('/custom-providers/fetch-models', {
      method: 'POST',
      body: JSON.stringify({ kind, base_url: baseUrl, api_key: apiKey, id: savedId }),
      headers: { 'content-type': 'application/json' },
    });
    if (r?.success !== true) throw new Error(str(r, 'error') ?? 'Could not list the models');
    return (r.models as OpenCodeCustomModel[]) ?? [];
  }
}
