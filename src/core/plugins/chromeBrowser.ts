// The plugins' browser on PC: the user's Chrome through the AntiGem Chrome extension (Phase 4's BrowserBridge, typed
// structurally here so this file does not depend on its internals). The runtime's /api/browser/* contract maps onto
// the extension's commands: tabs.list / tabs.open / tabs.activate / tabs.close, page.eval (page scripts), cdp (input
// events only), screenshot, upload, lock.set and agent.begin / agent.end. The extension allows no raw DevTools
// passthrough, so a plugin's DevTools session is limited: page scripts (scripting.executeScript runs in the page's main
// world), Input.* events, reload and screenshots; content scripts, chrome.debugger beyond those, cookies and zoom are
// not available and fail with a clear message.
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserProvider, BrowserTab, CdpSession } from './browser';

/** What the plugins need of the extension link (src/core/browser/bridge.ts BrowserBridge). */
export interface BrowserLink {
  connected(): boolean;
  call<T = unknown>(command: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onChange(fn: () => void): () => void;
}

const NOT_CONNECTED =
  'The AntiGem Chrome extension is not connected. Install and connect it (Settings → Browser), then keep Chrome open, to let plugins use browser tabs.';
const LIMITED = 'is not available through the AntiGem Chrome extension (plugins get page scripts, input events, reload and screenshots)';
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', pdf: 'application/pdf', txt: 'text/plain' };

interface ExtTab {
  id: string;
  url: string;
  title: string;
  status: string;
  active: boolean;
}

interface EvalResult {
  result?: { value?: unknown; type?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

export class ChromeExtensionBrowser implements BrowserProvider {
  constructor(readonly link: BrowserLink) {}

  available() {
    return this.link.connected();
  }
  unavailableReason() {
    return NOT_CONNECTED;
  }
  onAvailability(cb: (available: boolean) => void) {
    let last = this.available();
    return this.link.onChange(() => {
      const now = this.available();
      if (now !== last) {
        last = now;
        cb(now);
      }
    });
  }

  private call<T>(command: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000) {
    if (!this.available()) return Promise.reject(new Error(NOT_CONNECTED));
    return this.link.call<T>(command, payload, timeoutMs);
  }

  async tabs(): Promise<BrowserTab[]> {
    const r = await this.call<{ tabs: ExtTab[] }>('tabs.list');
    return (r.tabs ?? []).map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, loading: t.status === 'loading' }));
  }

  async open(url: string): Promise<BrowserTab> {
    const r = await this.call<{ tabId: string }>('tabs.open', { url, newTab: true });
    const t = (await this.tabs().catch(() => [])).find((x) => x.id === r.tabId);
    return t ?? { id: r.tabId, url, title: '', active: true, loading: true };
  }

  async update(tabId: string | number, props: { url?: string; active?: boolean }) {
    if (props.url) await this.call('tabs.open', { tabId: String(tabId), url: props.url });
    if (props.active) await this.call('tabs.activate', { tabId: String(tabId) });
  }

  async close(tabId: string | number) {
    await this.call('tabs.close', { tabId: String(tabId) });
  }

  /** Runtime.evaluate in the page's main world (the CDP result: {result, exceptionDetails}). */
  evaluate(tabId: string | number, expression: string, timeoutMs = 60_000) {
    return this.call<EvalResult>('page.eval', { tabId: String(tabId), expression, timeoutMs: Math.min(120_000, timeoutMs) }, Math.min(120_000, timeoutMs) + 5_000);
  }

  async eval(tabId: string | number, script: string) {
    const r = await this.evaluate(tabId, script);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'Script failed');
    return r.result?.value;
  }

  async zoom(): Promise<void> {
    throw new Error(`Zoom ${LIMITED}`);
  }

  async cdp(tabId: string | number): Promise<CdpSession> {
    return new LimitedSession(this, String(tabId));
  }

  async automation(tabId: string | number, args: { owner: string; busy?: boolean; locked?: boolean; tap?: { fx: number; fy: number } }) {
    const id = String(tabId);
    if (args.locked !== undefined) await this.call('lock.set', { tabId: id, locked: args.locked, label: args.owner });
    if (args.busy === true) await this.call('agent.begin', { tabId: id, label: args.owner });
    if (args.busy === false) await this.call('agent.end', { tabId: id });
    if (args.tap) {
      const vp = (await this.eval(id, '({w: visualViewport?.width || innerWidth, h: visualViewport?.height || innerHeight, x: visualViewport?.offsetLeft || 0, y: visualViewport?.offsetTop || 0})')) as { w: number; h: number; x: number; y: number };
      const x = vp.x + Math.min(1, Math.max(0, args.tap.fx)) * vp.w;
      const y = vp.y + Math.min(1, Math.max(0, args.tap.fy)) * vp.h;
      await this.call('cdp', {
        tabId: id,
        commands: [
          { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y } },
          { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 } },
          { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 } },
        ],
      });
    }
    return { success: true };
  }

  async upload(tabId: string | number, args: { files: string[]; selector?: string; point?: { fx: number; fy: number }; method?: string; timeoutMs?: number }) {
    const id = String(tabId);
    let selector = args.selector;
    if (!selector && args.point) {
      // the element at that point, marked for the extension's upload
      const mark = `p${Date.now().toString(36)}`;
      const found = await this.eval(
        id,
        `(() => { const e = document.elementFromPoint(${Number(args.point.fx)} * innerWidth, ${Number(args.point.fy)} * innerHeight); if (!e) return false; e.setAttribute('data-antigem-plugin-upload', ${JSON.stringify(mark)}); return true; })()`,
      );
      if (!found) throw new Error('No element at that point');
      selector = `[data-antigem-plugin-upload="${mark}"]`;
    }
    const files = args.files.map((f) => ({ name: path.basename(f), path: f }));
    const payload: Record<string, unknown> = {
      tabId: id,
      files,
      ...(selector ? { selector } : {}),
      method: args.method ?? 'auto',
      timeoutSeconds: Math.round((args.timeoutMs ?? 10_000) / 1000),
    };
    let r = await this.call<Record<string, unknown>>('upload', payload, 90_000);
    if (r?.needData) {
      // no file chooser opened: the extension builds the files inside the page (25 MiB at most, as the app)
      let total = 0;
      const data = args.files.map((f) => {
        const buf = fs.readFileSync(f);
        total += buf.length;
        if (total > 25 * 1024 * 1024) throw new Error('Files built inside the page are limited to 25 MiB in total');
        return { name: path.basename(f), type: MIME[path.extname(f).slice(1).toLowerCase()] ?? 'application/octet-stream', data: buf.toString('base64') };
      });
      r = await this.call<Record<string, unknown>>('upload', { ...payload, data }, 120_000);
    }
    return r;
  }
}

/**
 * A plugin's DevTools session through the extension: page scripts (main world), input events, reload, screenshots.
 * Isolated worlds are emulated by running in the main world (no chrome.* API inside the page); the content-script
 * bridge and bindings are skipped; no events are relayed.
 */
class LimitedSession implements CdpSession {
  private ctx = 1000;
  private closeCbs = new Set<(reason: string) => void>();
  private unsub: (() => void) | null;

  constructor(
    private b: ChromeExtensionBrowser,
    private tabId: string,
  ) {
    this.unsub = b.link.onChange(() => {
      if (!b.available()) this.fire('The browser disconnected');
    });
  }

  private fire(reason: string) {
    for (const cb of [...this.closeCbs]) cb(reason);
    this.close();
  }

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
    switch (method) {
      case 'Runtime.enable':
      case 'Page.enable':
      case 'Runtime.addBinding':
        return {};
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'main', url: '' } } };
      case 'Page.createIsolatedWorld':
        return { executionContextId: ++this.ctx };
      case 'Runtime.evaluate': {
        const expression = String(params.expression ?? '');
        // the runtime's content-script bridge needs a real isolated world and a binding: not available here
        if (params.contextId != null && expression.startsWith('(()=>{if(globalThis.__antigemClient)return;')) return { result: { type: 'undefined' } };
        return this.b.evaluate(this.tabId, expression, timeoutMs);
      }
      case 'Page.reload':
        await this.b.link.call('tabs.history', { tabId: this.tabId, action: 'reload' });
        return {};
      case 'Page.captureScreenshot': {
        const r = await this.b.link.call<{ data: string }>('screenshot', { tabId: this.tabId }, 60_000);
        return { data: r.data };
      }
      default:
        if (method.startsWith('Input.')) {
          await this.b.link.call('cdp', { tabId: this.tabId, commands: [{ method, params }], timeoutMs: Math.min(30_000, timeoutMs) }, Math.min(30_000, timeoutMs) + 5_000);
          return {};
        }
        throw new Error(`DevTools ${method} ${LIMITED}`);
    }
  }

  onEvent(): () => void {
    return () => undefined;
  }

  onClose(cb: (reason: string) => void) {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  close() {
    this.unsub?.();
    this.unsub = null;
    this.closeCbs.clear();
  }
}

/** The plugins' browser backed by the AntiGem Chrome extension link. */
export const chromeExtensionBrowser = (link: BrowserLink): BrowserProvider => new ChromeExtensionBrowser(link);
