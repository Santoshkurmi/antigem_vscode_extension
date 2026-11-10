// Starts (or reuses) the forked Go bridge on 127.0.0.1 and talks to it with the token header.
// One bridge per machine is shared by every VS Code window (and the dev server). The token lives in the bridge's own
// file (~/.antigem_bridge/csrf_token.txt): we never pass -t, so an existing token is never overwritten.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface BridgeOptions {
  binPath: string;
  port: number;
  hubPort: number;
  /** Bridge workspace dir (-d); the hub gets it as --add-dir. */
  workspaceDir: string;
  agyPath?: string;
  /** More flags at each start (custom CLI paths from Settings → Agents). */
  extraArgs?: () => string[];
  /** agy history folder under ~/.gemini the hub must use (a running bridge using another one is restarted). */
  agyDataDir?: () => string;
  logFile: string;
  log: (line: string) => void;
}

export interface HubStatus {
  status: 'idle' | 'starting' | 'online' | 'error' | 'stopped' | string;
  csrfToken: string;
  port: string;
  error: string;
  /** The hub's history folder under ~/.gemini ('' = unknown, older bridge). */
  dataDir: string;
}

export type BridgeState = 'stopped' | 'starting' | 'running' | 'error';

const TOKEN_FILE = path.join(os.homedir(), '.antigem_bridge', 'csrf_token.txt');
const TOKEN_LEN = 12;

export class BridgeManager {
  state: BridgeState = 'stopped';
  lastError = '';
  private token = '';
  private starting: Promise<void> | null = null;

  constructor(public opts: BridgeOptions) {}

  get baseUrl() {
    return `http://127.0.0.1:${this.opts.port}`;
  }
  get hubUrl() {
    return `http://127.0.0.1:${this.opts.hubPort}`;
  }

  private readToken(): string {
    try {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      return t.length === TOKEN_LEN ? t : '';
    } catch {
      return '';
    }
  }

  /** The header every bridge request (REST and WebSocket) needs. */
  authHeaders(): Record<string, string> {
    if (!this.token) this.token = this.readToken();
    const t = this.token.padEnd(TOKEN_LEN, ' ').slice(0, TOKEN_LEN);
    return { [`x-ag${t}_9qx`]: 'true' };
  }

  /** ws:// URL of a bridge WebSocket route (connect with `authHeaders()`). */
  wsUrl(p: string): string {
    return `ws://127.0.0.1:${this.opts.port}${p}`;
  }

  /** Authenticated request to the bridge. */
  async fetch(p: string, init: RequestInit = {}): Promise<Response> {
    const headers = { ...(init.headers as Record<string, string> | undefined), ...this.authHeaders() };
    return fetch(this.baseUrl + p, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(15_000) });
  }

  async json<T = any>(p: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(p, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`bridge ${p}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  private async healthy(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** The bridge on our port answers with our token (it is ours, or a compatible one sharing the token file). */
  private async authorized(): Promise<boolean> {
    this.token = this.readToken();
    if (!this.token) return false;
    try {
      const r = await this.fetch('/api/status', { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  ensureRunning(): Promise<void> {
    if (this.state === 'running') return Promise.resolve();
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async doStart() {
    this.state = 'starting';
    if (await this.healthy()) {
      if (await this.authorized()) {
        // a bridge whose hub uses another agy history folder (or an older bridge without the setting) is replaced
        const want = this.opts.agyDataDir?.();
        let have = 'antigravity-cli';
        try {
          have = (await this.json<any>('/api/status'))?.hub?.data_dir || 'antigravity-cli';
        } catch {
          /* keep default */
        }
        if (!want || want === have) {
          this.state = 'running';
          this.opts.log(`[bridge] reusing bridge on ${this.baseUrl}`);
          return;
        }
        this.opts.log(`[bridge] the running bridge uses ~/.gemini/${have}; restarting it with ~/.gemini/${want}`);
        await this.shutdown();
        for (let i = 0; i < 30 && (await this.healthy()); i++) await new Promise((r) => setTimeout(r, 200));
        this.state = 'starting';
      } else {
        this.state = 'error';
        this.lastError = `Port ${this.opts.port} is used by another program (or a bridge with a different token). Change "antigem.bridgePort".`;
        throw new Error(this.lastError);
      }
    }
    if (!fs.existsSync(this.opts.binPath)) {
      this.state = 'error';
      this.lastError = `Bridge binary not found: ${this.opts.binPath}`;
      throw new Error(this.lastError);
    }
    const args = [
      '-f',
      '--no-agy-patch',
      '-p',
      String(this.opts.port),
      '--hub-port',
      String(this.opts.hubPort),
      '--bind',
      '127.0.0.1',
      '-d',
      this.opts.workspaceDir,
    ];
    if (this.opts.agyPath) args.push('--bin', this.opts.agyPath);
    const dataDir = this.opts.agyDataDir?.();
    if (dataDir) args.push('--agy-data-dir', dataDir);
    args.push(...(this.opts.extraArgs?.() ?? []));
    fs.mkdirSync(path.dirname(this.opts.logFile), { recursive: true });
    const out = fs.openSync(this.opts.logFile, 'a');
    this.opts.log(`[bridge] starting ${this.opts.binPath} ${args.join(' ')}`);
    const child = spawn(this.opts.binPath, args, {
      cwd: this.opts.workspaceDir,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env },
    });
    child.on('error', (e) => this.opts.log(`[bridge] spawn error: ${e.message}`));
    child.unref();
    fs.closeSync(out);

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      if ((await this.healthy()) && (await this.authorized())) {
        this.state = 'running';
        this.opts.log(`[bridge] running on ${this.baseUrl}`);
        return;
      }
    }
    this.state = 'error';
    this.lastError = `The bridge did not start (see ${this.opts.logFile}).`;
    throw new Error(this.lastError);
  }

  async hubStatus(): Promise<HubStatus> {
    const s = await this.json<any>('/api/status');
    return {
      status: s?.hub?.status ?? 'stopped',
      csrfToken: s?.hub?.csrf_token ?? '',
      port: String(s?.hub?.port ?? this.opts.hubPort),
      error: s?.hub?.error ?? '',
      dataDir: s?.hub?.data_dir ?? '',
    };
  }

  /** Stops the bridge (it stops its hub) so the next ensureRunning starts a fresh one. */
  async shutdown() {
    try {
      await this.fetch('/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(5000) });
    } catch {
      /* already gone */
    }
    this.state = 'stopped';
  }
}

/** Bridge flags for the CLI paths set in Settings → Agents → CLI locations. */
export function cliPathArgs(paths: Partial<Record<'AGY' | 'CLAUDE' | 'CODEX' | 'OPENCODE', string>> | undefined): string[] {
  const p = paths ?? {};
  const out: string[] = [];
  if (p.AGY) out.push('--bin', p.AGY);
  if (p.CLAUDE) out.push('--claude-bin', p.CLAUDE);
  if (p.CODEX) out.push('--codex-bin', p.CODEX);
  if (p.OPENCODE) out.push('--opencode-bin', p.OPENCODE);
  return out;
}
