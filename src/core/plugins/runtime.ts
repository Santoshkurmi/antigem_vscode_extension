// The app's Node plugin runtime (runtime/extension-host.mjs, unchanged) in a child process of this extension host —
// as the app runs it next to itself (`node --experimental-vm-modules extension-host.mjs`): plugin workers run in their
// own process, so a stuck worker never freezes VS Code. Controlled over the IPC channel (runtime/host-ipc.mjs); the
// runtime's browser calls come back here and go to the BrowserProvider.
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../types';
import { browserEndpoint, type BrowserProvider, type CdpSession } from './browser';

export interface RuntimeOptions {
  /** runtime/host-ipc.mjs (copied to dist/plugin-runtime by esbuild.mjs). */
  entry: string;
  /** Plugin root of the runtime (downloads go to its parent's Downloads/<id>). */
  root: string;
  /** Per-plugin storage (<id>.json): the bridge's ~/.antigem/browser-extensions/.antigem-state, so "remove data" works. */
  stateRoot: string;
  log: Logger;
  browser: () => BrowserProvider;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class PluginRuntime {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private sessions = new Map<string, { session: CdpSession; unsubs: (() => void)[] }>();
  private sessionSeq = 0;
  private exitListeners = new Set<(reason: string) => void>();
  private disposed = false;
  /** Children stopped on purpose (their exit is not a crash). */
  private stopped = new WeakSet<ChildProcess>();
  /** Last start failure (shown in the developer MCP's host_error). */
  lastError: string | null = null;
  /** Whether module workers (background.type "module") can run (vm.SourceTextModule). */
  modules = false;

  constructor(private opts: RuntimeOptions) {}

  running(): boolean {
    return !!this.child && this.child.connected && !this.starting;
  }

  /** The child died (crash, killed): its plugins are gone; the service loads them again. */
  onExit(cb: (reason: string) => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  /** Starts the runtime if it is not running. */
  ensure(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('The plugin runtime is stopped'));
    if (this.child?.connected && !this.starting) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.spawn().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private spawn(): Promise<void> {
    const { entry } = this.opts;
    if (!fs.existsSync(entry)) {
      this.lastError = `Plugin runtime not found: ${entry}`;
      return Promise.reject(new Error(this.lastError));
    }
    return new Promise<void>((resolve, reject) => {
      const config = { root: this.opts.root, stateRoot: this.opts.stateRoot };
      let child: ChildProcess;
      try {
        // VS Code's extension host runs inside Electron: ELECTRON_RUN_AS_NODE makes its binary a plain Node
        child = fork(entry, [], {
          execArgv: ['--experimental-vm-modules', '--no-warnings'],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: process.env.HOME || os.homedir(), ANTIGEM_PLUGIN_HOST: JSON.stringify(config) },
          cwd: os.homedir(),
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          serialization: 'json',
        });
      } catch (e) {
        this.lastError = `Could not start the plugin runtime: ${e instanceof Error ? e.message : String(e)}`;
        reject(new Error(this.lastError));
        return;
      }
      this.child = child;
      let ready = false;
      const tail: string[] = [];
      const forward = (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          tail.push(line);
          if (tail.length > 12) tail.shift();
          this.opts.log(`[plugins] ${line.length > 2000 ? `${line.slice(0, 2000)}…` : line}`);
        }
      };
      child.stdout?.on('data', forward);
      child.stderr?.on('data', forward);
      const timer = setTimeout(() => {
        if (ready) return;
        this.lastError = `The plugin runtime did not start in time${tail.length ? `:\n${tail.join('\n')}` : ''}`;
        child.kill();
        reject(new Error(this.lastError));
      }, 20_000);
      child.on('message', (msg: Record<string, unknown>) => {
        if (msg?.kind === 'ready') {
          ready = true;
          clearTimeout(timer);
          this.lastError = null;
          this.modules = msg.modules === true;
          this.opts.log(`[plugins] runtime ready (pid ${msg.pid}, node ${msg.node}${this.modules ? '' : ', no module workers'})`);
          // tell it whether a browser is there (tab polling only runs with one)
          void this.call('browser', { available: this.opts.browser().available() }).catch(() => undefined);
          resolve();
          return;
        }
        this.onMessage(child, msg);
      });
      child.on('error', (e) => {
        this.opts.log(`[plugins] runtime error: ${e.message}`);
        if (!ready) {
          clearTimeout(timer);
          this.lastError = `Could not start the plugin runtime: ${e.message}`;
          reject(new Error(this.lastError));
        }
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        const reason = `The plugin runtime exited (${signal ?? `code ${code}`})${tail.length ? `: ${tail.slice(-4).join(' | ')}` : ''}`;
        if (this.child === child) this.child = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(reason));
          this.pending.delete(id);
        }
        for (const s of this.sessions.values()) {
          s.unsubs.forEach((u) => u());
          s.session.close();
        }
        this.sessions.clear();
        if (!ready) {
          this.lastError = reason;
          reject(new Error(reason));
          return;
        }
        if (!this.disposed && !this.stopped.has(child)) {
          this.lastError = reason;
          this.opts.log(`[plugins] ${reason}`);
          for (const cb of this.exitListeners) cb(reason);
        }
      });
    });
  }

  /** Runs an operation in the runtime (see host-ipc.mjs: load, unload, reload, list, tools, call, logs, browser). */
  async call<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    await this.ensure();
    const child = this.child;
    if (!child?.connected) throw new Error(this.lastError ?? 'The plugin runtime is not running');
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Plugin runtime: ${op} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.send({ kind: 'call', id, op, args });
    });
  }

  /** Tells a running runtime that the browser came or went (no start just for that). */
  browserChanged(available: boolean) {
    if (this.child?.connected && !this.starting) void this.call('browser', { available }).catch(() => undefined);
  }

  private onMessage(child: ChildProcess, msg: Record<string, unknown>) {
    if (msg?.kind === 'ret') {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if (msg.error != null) p.reject(new Error(String(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg?.kind === 'ask') {
      const id = msg.id as number;
      const answer = (result: unknown, error?: string) => {
        if (child.connected) child.send(error != null ? { kind: 'answer', id, error } : { kind: 'answer', id, result: result ?? null });
      };
      this.answer(child, String(msg.op), (msg.payload ?? {}) as Record<string, unknown>).then(
        (r) => answer(r),
        (e) => answer(null, e instanceof Error ? e.message : String(e)),
      );
    }
  }

  /** The runtime's requests: the app's browser bridge, and DevTools sessions relayed to the browser. */
  private async answer(child: ChildProcess, op: string, p: Record<string, unknown>): Promise<unknown> {
    const browser = this.opts.browser();
    if (op === 'browser') return browserEndpoint(browser, String(p.endpoint ?? ''), (p.body ?? null) as Record<string, unknown> | null);
    if (op === 'cdp.open') {
      if (!browser.available()) throw new Error(browser.unavailableReason());
      const session = await browser.cdp(p.tab_id as string | number);
      const sid = `cdp${++this.sessionSeq}`;
      const unsubs = [
        session.onEvent((method, params) => {
          if (child.connected) child.send({ kind: 'cdp.event', session: sid, method, params });
        }),
        session.onClose((reason) => {
          const s = this.sessions.get(sid);
          if (!s) return;
          this.sessions.delete(sid);
          s.unsubs.forEach((u) => u());
          if (child.connected) child.send({ kind: 'cdp.closed', session: sid, reason });
        }),
      ];
      this.sessions.set(sid, { session, unsubs });
      return { session: sid };
    }
    if (op === 'cdp.send') {
      const s = this.sessions.get(String(p.session));
      if (!s) throw new Error('DevTools connection is closed');
      return (await s.session.send(String(p.method), (p.params ?? {}) as Record<string, unknown>, Number(p.timeout ?? 60_000))) ?? {};
    }
    if (op === 'cdp.close') {
      const s = this.sessions.get(String(p.session));
      if (s) {
        this.sessions.delete(String(p.session));
        s.unsubs.forEach((u) => u());
        s.session.close();
      }
      return {};
    }
    throw new Error(`Unknown request ${op}`);
  }

  /** Stops the runtime (every worker). */
  stop() {
    const child = this.child;
    this.child = null;
    if (child) {
      this.stopped.add(child);
      if (child.connected) child.disconnect();
      setTimeout(() => {
        if (child.exitCode == null) child.kill();
      }, 3000).unref();
    }
  }

  dispose() {
    this.disposed = true;
    this.stop();
  }
}

/** Where the runtime entry is: next to the bundle (dist/plugin-runtime) or in the sources (dev). */
export function defaultRuntimeEntry(): string {
  const candidates = [path.join(__dirname, 'plugin-runtime', 'host-ipc.mjs'), path.join(__dirname, '..', 'src', 'core', 'plugins', 'runtime', 'host-ipc.mjs')];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

/** Where the SDK docs are (dist/plugin-sdk, or the sources in dev). */
export function defaultSdkDir(): string {
  const candidates = [path.join(__dirname, 'plugin-sdk'), path.join(__dirname, '..', 'src', 'core', 'plugins', 'sdk')];
  return candidates.find((c) => fs.existsSync(path.join(c, 'README.md'))) ?? candidates[0];
}
