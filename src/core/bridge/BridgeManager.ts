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
  /**
   * The agents the bridge must leave off (the app's AgentPreferences.bridgeFlags: --no-hub, --no-claude…), and where
   * the flags of the bridge started last are kept (shared by every window): a running bridge started with other
   * flags is replaced.
   */
  agentFlags?: () => string[];
  launchedFlags?: { get(): string | undefined; set(flags: string): void };
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
/** Written by Stop (side bar): every VS Code window (and the dev server) leaves the bridge off until Start removes it. */
const STOPPED_FILE = path.join(os.homedir(), '.antigem_bridge', 'stopped-by-user');
/** Which bridge program the running bridge was started from (an extension update ships a new one). */
const LAUNCHED_FILE = path.join(os.homedir(), '.antigem_bridge', 'launched-binary.json');

/** The bridge program's identity: its path, size and date. */
function binaryId(bin: string): string | null {
  try {
    const st = fs.statSync(bin);
    return `${path.resolve(bin)}|${st.size}|${Math.round(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

/**
 * Whether the bridge program [launched] (a binaryId) is older than [mine]: written before it (an extension is
 * unpacked when it is installed, so a later install is a later date), or gone (its extension was removed).
 */
function olderBinary(launched: string, mine: string): boolean {
  const [file, , at] = launched.split('|');
  const mineAt = Number(mine.split('|')[2]);
  if (!file || !fs.existsSync(file)) return true;
  return Number(at) < mineAt;
}
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
    if (this.suspended) throw new Error('AntiGem is turned off — press Reconnect to start it');
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

  private wantedFlags(): string {
    return (this.opts.agentFlags?.() ?? []).join(' ');
  }

  /**
   * The running bridge was started for other agents than the ones enabled now (a bridge from before this was kept,
   * with no record, ran every agent).
   */
  agentFlagsChanged(): boolean {
    if (!this.opts.agentFlags) return false;
    return (this.opts.launchedFlags?.get() ?? '') !== this.wantedFlags();
  }

  /**
   * Stopped by the user (side bar ■): nothing starts the bridge again until resume() (▶). Shared by every window
   * through a marker file, so another window does not start it again a moment later.
   */
  get suspended(): boolean {
    return fs.existsSync(STOPPED_FILE);
  }

  async powerOff() {
    try {
      fs.mkdirSync(path.dirname(STOPPED_FILE), { recursive: true });
      fs.writeFileSync(STOPPED_FILE, `${new Date().toISOString()}\n`);
    } catch (e) {
      this.opts.log(`[bridge] could not mark the bridge stopped: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.shutdown();
  }

  resume() {
    fs.rmSync(STOPPED_FILE, { force: true });
  }

  ensureRunning(): Promise<void> {
    if (this.suspended) return Promise.reject(new Error('AntiGem is turned off — press Reconnect to start it'));
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
        const agentsOk = !this.agentFlagsChanged();
        // started from an older copy of the bridge program (an older extension): replace it. Unknown = keep it (a
        // bridge from before this check; restarting would stop other windows' running chats for nothing). A newer one
        // is kept too: a window not reloaded since the update must not swap it back, then lose it again
        let launched: string | null = null;
        try {
          launched = fs.readFileSync(LAUNCHED_FILE, 'utf8').trim() || null;
        } catch {
          /* unknown */
        }
        const mine = binaryId(this.opts.binPath);
        const sameBinary = !launched || !mine || launched === mine || !olderBinary(launched, mine);
        if ((!want || want === have) && agentsOk && sameBinary) {
          this.state = 'running';
          this.opts.log(`[bridge] reusing bridge on ${this.baseUrl}`);
          return;
        }
        if (!sameBinary) this.opts.log('[bridge] the running bridge comes from another version of the extension; restarting it');
        else if (!agentsOk) this.opts.log(`[bridge] the running bridge runs other agents; restarting it with ${this.wantedFlags() || 'every agent'}`);
        else this.opts.log(`[bridge] the running bridge uses ~/.gemini/${have}; restarting it with ~/.gemini/${want}`);
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
    const agentFlags = this.opts.agentFlags?.() ?? [];
    args.push(...agentFlags);
    this.opts.launchedFlags?.set(agentFlags.join(' '));
    fs.mkdirSync(path.dirname(this.opts.logFile), { recursive: true });
    // a VSIX packed on Windows loses the program's run permission (macOS / Linux would refuse to start it)
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(this.opts.binPath, 0o755);
      } catch {
        /* read-only install: it has the permission already, or the start reports why */
      }
    }
    const out = fs.openSync(this.opts.logFile, 'a');
    this.opts.log(`[bridge] starting ${this.opts.binPath} ${args.join(' ')}`);
    const child = spawn(this.opts.binPath, args, {
      cwd: this.opts.workspaceDir,
      detached: true,
      // Windows: no console window for the bridge
      windowsHide: true,
      stdio: ['ignore', out, out],
      env: { ...process.env },
    });
    const id = binaryId(this.opts.binPath);
    try {
      if (id) fs.writeFileSync(LAUNCHED_FILE, id);
    } catch {
      /* next start just reuses */
    }
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
      // not this.fetch(): it refuses while stopped, and Stop marks the bridge stopped before shutting it down
      await fetch(this.baseUrl + '/api/shutdown', { method: 'POST', headers: this.authHeaders(), signal: AbortSignal.timeout(5000) });
    } catch {
      /* already gone */
    }
    this.state = 'stopped';
  }

  /**
   * Stops the running bridge (its agents and hub) and starts a fresh one; waits until the old one is really gone, so
   * the start does not just reuse it while it is still exiting.
   */
  async restart() {
    this.resume();
    await this.shutdown();
    for (let i = 0; i < 40 && (await this.healthy()); i++) await new Promise((r) => setTimeout(r, 200));
    if (await this.healthy()) throw new Error('The old bridge did not stop (another program on the port?)');
    await this.ensureRunning();
  }
}

/** Bridge flags that keep a disabled agent from running at all (AgentPreferences.bridgeFlags); none chosen yet = none runs. */
export function agentFlags(enabled: string[] | undefined): string[] {
  const on = enabled ?? [];
  const out: string[] = [];
  if (!on.includes('AGY')) out.push('--no-hub');
  if (!on.includes('CLAUDE')) out.push('--no-claude');
  if (!on.includes('OPENCODE')) out.push('--no-opencode');
  if (!on.includes('CODEX')) out.push('--no-codex');
  return out;
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
