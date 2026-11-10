// The VS Code end of the AntiGem browser link: a per-user Unix socket (dir 0700, socket 0600) the native host
// (`antigem-bridge --native-host`, started by Chrome for our extension only) connects to. Newline-delimited JSON:
//   VS Code -> extension  {id, command, payload} | {type:'ping'}
//   extension -> VS Code  {id, success, result | error, code} | {type:'hello'|'pong'|'event'} | {type:'host_hello'} (host)
// Served by the window that owns the MCP port (McpHost.start() resolved true). No TCP: web pages and other users can
// never reach it.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Logger } from '../types';
import { EXTENSION_ID, EXTENSION_ORIGIN, socketCandidates } from './constants';

export interface BrowserHello {
  protocol: number;
  version: string;
  extensionId: string;
  browser: string;
  brands?: string[];
}

export interface BrowserClientInfo {
  id: number;
  version: string;
  extensionId: string;
  browser: string;
  connectedAt: number;
  hostPid: number | null;
}

export type BridgeStatus = 'stopped' | 'listening' | 'busy' | 'unsupported' | 'error';

/** A command failed in the extension (or never reached it). `code` comes from the extension (dialog, denied…). */
export class BrowserError extends Error {
  constructor(
    message: string,
    public code: string = 'error',
    public data: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

export const NOT_CONNECTED =
  'The AntiGem Chrome extension is not connected. Install/connect the AntiGem Chrome extension: Settings → Browser (in AntiGem), then make sure Chrome is open.';

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

interface Client {
  id: number;
  socket: net.Socket;
  buf: string;
  hello: BrowserHello | null;
  origin: string | null;
  hostPid: number | null;
  connectedAt: number;
  lastSeen: number;
  pending: Map<number, Pending>;
}

const MAX_BUFFER = 300 * 1024 * 1024;

export interface BrowserBridgeOptions {
  log: Logger;
  /** Forced socket path (tests, dev server); default: socketCandidates(). */
  socketPath?: string | null;
  /** Accept another extension id (tests). */
  extensionId?: string;
}

export class BrowserBridge {
  private server: net.Server | null = null;
  private clients = new Map<number, Client>();
  private nextClient = 1;
  private nextId = 1;
  private heartbeat: NodeJS.Timeout | null = null;
  private changeListeners = new Set<() => void>();
  private eventListeners = new Set<(event: string, data: unknown) => void>();
  status: BridgeStatus = 'stopped';
  error = '';
  socketPath: string | null = null;

  constructor(private opts: BrowserBridgeOptions) {}

  private get extensionId() {
    return this.opts.extensionId ?? EXTENSION_ID;
  }

  onChange(fn: () => void) {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onEvent(fn: (event: string, data: unknown) => void) {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  private changed() {
    for (const fn of this.changeListeners) {
      try {
        fn();
      } catch {
        /* listeners never break the bridge */
      }
    }
  }

  /** Starts listening (call only in the window that owns the MCP port). */
  async start(): Promise<BridgeStatus> {
    if (this.server) return this.status;
    if (process.platform === 'win32') {
      this.status = 'unsupported';
      this.error = 'Browser control is not supported on Windows yet (AntiGem v1 supports Linux and macOS).';
      this.changed();
      return this.status;
    }
    const candidates = socketCandidates(this.opts.socketPath);
    let lastErr = '';
    for (const p of candidates) {
      try {
        const r = await this.listen(p);
        this.status = r;
        this.socketPath = p;
        this.error = r === 'busy' ? `Another AntiGem window or VS Code already serves ${p}` : '';
        if (r === 'listening') {
          this.opts.log(`[browser] waiting for the AntiGem Chrome extension on ${p}`);
          this.heartbeat = setInterval(() => this.beat(), 15_000);
        } else this.opts.log(`[browser] ${this.error}`);
        this.changed();
        return this.status;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    this.status = 'error';
    this.error = `Could not open the browser socket: ${lastErr}`;
    this.opts.log(`[browser] ${this.error}`);
    this.changed();
    return this.status;
  }

  private async listen(p: string): Promise<'listening' | 'busy'> {
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.statSync(dir);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
    if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
    if (fs.existsSync(p)) {
      if (await alive(p)) return 'busy';
      fs.unlinkSync(p);
    }
    const srv = net.createServer((s) => this.accept(s));
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(p, () => {
        srv.off('error', reject);
        resolve();
      });
    });
    fs.chmodSync(p, 0o600);
    srv.on('error', (e) => this.opts.log(`[browser] socket error: ${e.message}`));
    this.server = srv;
    return 'listening';
  }

  stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of this.clients.values()) c.socket.destroy();
    this.clients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
      if (this.socketPath && this.status === 'listening') {
        try {
          fs.unlinkSync(this.socketPath);
        } catch {
          /* gone */
        }
      }
    }
    this.status = 'stopped';
    this.changed();
  }

  private accept(socket: net.Socket) {
    const c: Client = {
      id: this.nextClient++,
      socket,
      buf: '',
      hello: null,
      origin: null,
      hostPid: null,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      pending: new Map(),
    };
    this.clients.set(c.id, c);
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      c.lastSeen = Date.now();
      c.buf += d;
      if (c.buf.length > MAX_BUFFER) {
        this.opts.log('[browser] message too large; dropping the connection');
        socket.destroy();
        return;
      }
      let i: number;
      while ((i = c.buf.indexOf('\n')) >= 0) {
        const line = c.buf.slice(0, i).trim();
        c.buf = c.buf.slice(i + 1);
        if (line) this.onLine(c, line);
      }
    });
    socket.on('close', () => {
      this.clients.delete(c.id);
      for (const p of c.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new BrowserError('The browser disconnected before answering.', 'not_connected'));
      }
      c.pending.clear();
      if (c.hello) this.opts.log(`[browser] extension disconnected (${shortBrowser(c.hello.browser)})`);
      this.changed();
    });
    socket.on('error', () => socket.destroy());
  }

  private onLine(c: Client, line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'host_hello') {
      c.origin = typeof msg.origin === 'string' ? msg.origin : null;
      c.hostPid = typeof msg.pid === 'number' ? msg.pid : null;
      if (c.origin && c.origin !== `chrome-extension://${this.extensionId}/`) {
        this.opts.log(`[browser] refused a native host started for ${c.origin}`);
        c.socket.destroy();
      }
      return;
    }
    if (msg.type === 'hello') {
      const h = msg as unknown as BrowserHello;
      if (h.extensionId !== this.extensionId) {
        this.opts.log(`[browser] refused extension ${String(h.extensionId)} (expected ${this.extensionId})`);
        c.socket.destroy();
        return;
      }
      c.hello = h;
      this.opts.log(`[browser] AntiGem extension ${h.version} connected (${shortBrowser(h.browser)})`);
      this.changed();
      return;
    }
    if (msg.type === 'pong') return;
    if (msg.type === 'ping') {
      this.write(c, { type: 'pong' });
      return;
    }
    if (msg.type === 'event') {
      for (const fn of this.eventListeners) {
        try {
          fn(String(msg.event), msg.data);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (typeof msg.id === 'number') {
      const p = c.pending.get(msg.id);
      if (!p) return;
      c.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.success) p.resolve(msg.result);
      else p.reject(new BrowserError(String(msg.error ?? 'Failed'), String(msg.code ?? 'error'), (msg.data as Record<string, unknown>) ?? null));
    }
  }

  private write(c: Client, msg: unknown) {
    if (!c.socket.destroyed) c.socket.write(`${JSON.stringify(msg)}\n`);
  }

  private beat() {
    const now = Date.now();
    for (const c of this.clients.values()) {
      if (now - c.lastSeen > 50_000) {
        this.opts.log('[browser] the extension stopped answering; closing its connection');
        c.socket.destroy();
      } else this.write(c, { type: 'ping', t: now });
    }
  }

  /** The browser that answers commands: the one that said hello last. */
  private active(): Client | null {
    let best: Client | null = null;
    for (const c of this.clients.values()) if (c.hello && (!best || c.connectedAt > best.connectedAt)) best = c;
    return best;
  }

  connected(): boolean {
    return !!this.active();
  }

  clientsInfo(): BrowserClientInfo[] {
    return [...this.clients.values()]
      .filter((c) => c.hello)
      .map((c) => ({ id: c.id, version: c.hello!.version, extensionId: c.hello!.extensionId, browser: c.hello!.browser, connectedAt: c.connectedAt, hostPid: c.hostPid }));
  }

  /** Sends a command to the extension; rejects with BrowserError (code 'not_connected', 'timeout' or the extension's). */
  call<T = unknown>(command: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const c = this.active();
    if (!c) return Promise.reject(new BrowserError(NOT_CONNECTED, 'not_connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pending.delete(id);
        reject(new BrowserError(`The browser did not answer ${command} within ${Math.round(timeoutMs / 1000)} s.`, 'timeout'));
      }, timeoutMs);
      c.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write(c, { id, command, payload });
    });
  }

  /** Fire and forget (cursor and caption updates). */
  notify(command: string, payload: Record<string, unknown> = {}) {
    this.call(command, payload, 10_000).catch(() => {});
  }
}

function shortBrowser(ua: string) {
  const m = /(Edg|OPR|Brave|Vivaldi|HeadlessChrome|Chrome)\/([\d.]+)/.exec(ua ?? '');
  return m ? `${m[1] === 'Edg' ? 'Edge' : m[1]} ${m[2]}` : 'browser';
}

/** True when something answers on the socket (another live window owns it). */
function alive(p: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(p);
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

export { EXTENSION_ORIGIN };
