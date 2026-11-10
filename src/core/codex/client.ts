// Talks to the bridge's /api/codex/ endpoints (port of the app's CodexBridgeClient.kt). The bridge runs one
// `codex app-server` (OpenAI's JSON-RPC protocol, the one the official VS Code extension speaks) for every Codex chat:
// `rpc` calls one of its methods, `reply` answers a server request (approval, question). The event stream
// (/api/codex/ws) is followed by CodexBackend.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { TokenUsage } from '../../../shared/model';
import type { BridgeManager } from '../bridge/BridgeManager';
import { bool, num, obj, str, type J } from './util';

/** Codex is turned off on the bridge, or the bridge has no Codex support yet. */
export class CodexUnavailableError extends Error {
  constructor(
    message: string,
    readonly disabled = false,
    readonly outdated = false,
  ) {
    super(message);
  }
}

/** An error Codex answered (a JSON-RPC error), or the bridge could not reach Codex at all (`unavailable`). */
export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
    readonly unavailable = false,
  ) {
    super(message);
  }
}

export interface CodexStatus {
  success?: boolean;
  installed?: boolean;
  running?: boolean;
  starting?: boolean;
  binary?: string | null;
  version?: string | null;
  error?: string | null;
  logs?: string[] | null;
  uptime_seconds?: number | null;
  /** Codex comes from the Termux package repository (`pkg install codex`). */
  termux_package?: boolean;
}

/** An install / update of Codex running on the bridge (its log grows while it runs). */
export interface CodexCliJob {
  kind: string;
  running: boolean;
  exit_code?: number | null;
  log: string;
}

/** A turn's model and token use as Codex recorded them (history has neither). */
export interface CodexTurnMeta {
  model: string | null;
  effort: string | null;
  usage: TokenUsage | null;
  durationMs: number | null;
}

const RPC_TIMEOUT_MS = 120_000;

export class CodexClient {
  constructor(private bridge: BridgeManager) {}

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<any> {
    const res = await this.bridge.fetch(`/api/codex${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    const isJson = /^\s*[{[]/.test(text);
    if (res.status === 404 && !isJson) throw new CodexUnavailableError('This bridge has no Codex support yet. Update and restart it.', false, true);
    if (res.status === 503 && text.includes('"disabled":true')) throw new CodexUnavailableError('The bridge was started with Codex turned off. Restart it to use Codex.', true);
    if (!res.ok && !isJson) throw new Error(text.trim().slice(0, 200) || `HTTP ${res.status}`);
    return JSON.parse(text);
  }

  private post(path: string, body: unknown, timeoutMs = 30_000): Promise<any> {
    return this.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, timeoutMs);
  }

  /** Calls one app-server method; its result (null when it has none). */
  async rpc<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const body: J = { method, params: params ?? {} };
    if (timeoutMs) body.timeout_ms = timeoutMs;
    // a cold app-server start can take a while (the bridge waits up to 45 s), then the call itself
    const res = await this.post('/rpc', body, (timeoutMs ?? RPC_TIMEOUT_MS) + 50_000);
    if (bool(res, 'success') !== true) {
      throw new CodexRpcError(String(str(res, 'error') ?? 'Codex did not answer').slice(0, 400), num(res, 'code'), bool(res, 'codex_unavailable') === true);
    }
    return (res?.result ?? null) as T;
  }

  /** Answers a waiting request (approval, question) with `result`. */
  async reply(key: string, result: unknown): Promise<void> {
    const res = await this.post(`/requests/${encodeURIComponent(key)}/reply`, { result });
    if (bool(res, 'success') !== true) throw new Error(str(res, 'error') ?? 'Codex did not take the answer');
  }

  async status(): Promise<CodexStatus> {
    return (await this.request('/status', {}, 20_000)) as CodexStatus;
  }

  async restart(): Promise<void> {
    const r = await this.post('/restart', {}, 90_000);
    if (bool(r, 'success') !== true) throw new Error(str(r, 'error') ?? 'Codex did not restart');
  }

  /** Starts installing ("install") or updating ("update") Codex on the bridge machine. */
  async startCliJob(action: 'install' | 'update'): Promise<CodexCliJob> {
    const r = await this.post(`/cli/${action}`, {});
    if (bool(r, 'success') !== true) throw new Error(str(r, 'error') ?? `Could not start the ${action}`);
    return (obj(r.job) as CodexCliJob | null) ?? { kind: action, running: true, log: '' };
  }

  async cliJob(): Promise<CodexCliJob | null> {
    const r = await this.request('/cli/job', {}, 15_000);
    return (obj(r?.job) as CodexCliJob | null) ?? null;
  }

  /** Each turn's model, effort, token use and duration (read by the bridge from the thread's record on disk). */
  async turnsMeta(threadId: string): Promise<Record<string, CodexTurnMeta>> {
    const r = await this.request(`/turns-meta?thread=${encodeURIComponent(threadId)}`, {}, 40_000);
    if (bool(r, 'success') !== true) throw new Error(str(r, 'error') ?? 'no turn data');
    return parseTurnsMeta(r);
  }
}

/** The bridge's turns-meta answer → turn id → model, effort, usage and duration. */
export function parseTurnsMeta(r: any): Record<string, CodexTurnMeta> {
  const out: Record<string, CodexTurnMeta> = {};
  for (const [id, v] of Object.entries<any>(obj(r?.turns) ?? {})) {
    const u = obj(v?.usage);
    const model = str(v, 'model') || null;
    const durationMs = num(v, 'duration_ms');
    let usage: TokenUsage | null = null;
    if (u) {
      const input = num(u, 'input_tokens') ?? 0;
      const cached = num(u, 'cached_input_tokens') ?? 0;
      usage = {
        promptTokens: Math.max(0, input - cached),
        outputTokens: num(u, 'output_tokens') ?? 0,
        cachedTokens: cached,
        cacheCreationTokens: num(u, 'cache_write_input_tokens') ?? 0,
        totalTokens: num(u, 'total_tokens') ?? 0,
        durationMs: durationMs ?? 0,
        isEstimated: false,
        model,
      };
    }
    out[id] = { model, effort: str(v, 'effort') || null, usage, durationMs };
  }
  return out;
}
