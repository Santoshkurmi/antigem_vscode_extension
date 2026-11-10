// browser_mcp (/browser on the MCP host): port of the app's BrowserMcp.kt, driving Chrome through the AntiGem browser
// extension instead of the in-app WebView. Same tools, arguments, texts and result shapes (text + JPEG screenshots):
// - page understanding through the app's own page helper (page-agent.js, element refs like ref_12),
// - real (trusted) mouse / keyboard input through chrome.debugger,
// - screenshots sized for model vision (long side <= 1568 px, ~1568 tokens) with coordinates mapped per tab,
// - the agent's cursor, captions and the lock overlay drawn by the extension.
// The extension enforces what the agent may touch (AntiGem tab group or the user's OK, blocklist); this file only
// turns tool calls into its commands.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpContent, McpResult, McpServerDef } from '../mcp/server';
import { BrowserError, NOT_CONNECTED, type BrowserBridge } from './bridge';
import * as K from './keys';
import { ALIASES, HIDDEN_TOOLS, INSTRUCTIONS, TOOLS } from './tools';

type Args = Record<string, unknown>;

interface Dialog {
  type: string;
  message: string;
  defaultPrompt?: string;
  url?: string;
}

interface Tab {
  id: string;
  url: string;
  title: string;
  status: string;
  active: boolean;
  isCurrent: boolean;
  locked: boolean;
  viewMode: string;
  blocked: boolean;
  dialog: Dialog | null;
  consoleErrors: number;
  networkErrors: number;
}

interface Viewport {
  ok: boolean;
  w: number;
  h: number;
  ox: number;
  oy: number;
  sx: number;
  sy: number;
  pw: number;
  ph: number;
  iw: number;
  url: string;
  title: string;
}

/** The latest screenshot of a tab: its size and the visible page area (CSS px) it shows. */
interface Frame {
  shotW: number;
  shotH: number;
  cssW: number;
  cssH: number;
  url: string;
}

/** In a batch, coordinates refer to the screenshot taken before the batch; new frames apply after it. */
interface Batch {
  frames: Map<string, Frame>;
}

interface Target {
  x: number;
  y: number;
  vw: number;
  vh: number;
  desc: string;
  ref: string;
  fileInput: boolean;
  coveredBy: string;
  byRef: boolean;
  note: string;
}

interface PageState {
  url: string;
  title: string;
  tabIds: Set<string>;
  loading: boolean;
  tabs: Tab[];
}

class ToolError extends Error {}
/** Coordinates cannot be used; computer() answers with a fresh screenshot so the next try can succeed. */
class FrameError extends Error {}
/** The page stopped answering because it opened a dialog (alert / confirm / prompt). */
class DialogOpened extends Error {
  constructor(
    public tabId: string,
    public dialog: Dialog,
  ) {
    super('dialog');
  }
}

class Out {
  content: McpContent[] = [];
  text(s: string) {
    this.content.push({ type: 'text', text: s });
    return this;
  }
  image(data: string, mimeType = 'image/jpeg') {
    this.content.push({ type: 'image', data, mimeType });
    return this;
  }
  result(error = false): McpResult {
    return { content: this.content, ...(error ? { isError: true } : {}) };
  }
}

/** Tools that work in one tab's page: the agent marks the tab busy (overlay, lock) for the call. */
const PAGE_TOOLS = new Set(['browser_read_page', 'browser_find', 'browser_get_page_text', 'browser_computer', 'browser_form_input', 'browser_eval_js', 'browser_upload_file']);

const MAX_UPLOAD_IN_PAGE = 25 * 1024 * 1024;
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html', htm: 'text/html', xml: 'application/xml',
  zip: 'application/zip', gz: 'application/gzip', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
  ogg: 'audio/ogg', md: 'text/markdown', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', js: 'text/javascript', css: 'text/css',
};
/** Folders whose files never go to a web page (keys, credentials, the bridge token). */
const SECRET_DIRS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.antigem_bridge', '.config/gcloud', '.password-store', '.local/share/keyrings'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const has = (a: Args, k: string) => a[k] !== undefined && a[k] !== null;
const bool = (v: unknown) => v === true || v === 'true';
const int = (a: Args, k: string, d: number) => {
  const n = Number(a[k]);
  return has(a, k) && Number.isFinite(n) ? Math.trunc(n) : d;
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function clip(s: string, n: number) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
function num(d: number) {
  return Number.isInteger(d) ? String(d) : d.toFixed(1);
}
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** Short name for captions: `button "Sign in to your account"` -> `Sign in to your acco…`. */
function short(desc: string) {
  const m = /"(.+)"/.exec(desc);
  const name = m?.[1]?.trim().replace(/:+$/, '');
  return clip(name || desc, 28);
}
const summary = (a: Args) => {
  const s = str(a.action_summary).trim();
  return s ? clip(s, 48) : null;
};

export interface BrowserMcpOptions {
  /** Folder relative upload paths start from (the workspace). */
  workspace(): string;
}

export function browserMcp(bridge: BrowserBridge, opts: BrowserMcpOptions): McpServerDef {
  const tools = new BrowserTools(bridge, opts);
  return {
    path: '/browser',
    name: 'browser_mcp',
    instructions: INSTRUCTIONS,
    tools: () => TOOLS,
    hiddenTool: (n) => HIDDEN_TOOLS.has(n),
    call: (name, args) => tools.call(name, args),
  };
}

export class BrowserTools {
  private frames = new Map<string, Frame>();
  private tabChains = new Map<string, Promise<unknown>>();

  constructor(
    private bridge: BrowserBridge,
    private opts: BrowserMcpOptions,
  ) {}

  call(name: string, args: Args): Promise<McpResult> {
    return this.run(name, args ?? {}, null);
  }

  // ------------------------------------------------------------------------------------------------ plumbing

  /** A command to the extension; its failures become tool errors (a page dialog becomes DialogOpened). */
  private async c<T = any>(command: string, payload: Args = {}, timeoutMs = 30_000): Promise<T> {
    try {
      return await this.bridge.call<T>(command, payload, timeoutMs);
    } catch (e) {
      if (e instanceof BrowserError) {
        if (e.code === 'dialog') throw new DialogOpened(str(e.data?.tabId), (e.data ?? { type: 'alert', message: '' }) as unknown as Dialog);
        throw new ToolError(e.message);
      }
      throw e;
    }
  }

  private notify(command: string, payload: Args) {
    this.bridge.notify(command, payload);
  }

  /** The tab a tool works on (tab_id, or the current AntiGem tab). Outside the group the user is asked first. */
  private tab(args: Args, purpose = 'use', page = true): Promise<Tab> {
    return this.c<Tab>('tabs.resolve', { tabId: str(args.tab_id).trim() || null, purpose, page }, 150_000);
  }

  private agent<T = any>(tab: Tab, fn: string, ...args: unknown[]): Promise<T> {
    return this.c<T>('page.call', { tabId: tab.id, fn, args }, 30_000);
  }

  private async agentText(tab: Tab, fn: string, ...args: unknown[]): Promise<string> {
    const r = await this.agent<{ ok: boolean; text?: string; error?: string }>(tab, fn, ...args);
    if (!r?.ok) throw new ToolError(r?.error ?? 'Failed');
    return r.text ?? '';
  }

  private serial<T>(tab: Tab, block: () => Promise<T>): Promise<T> {
    const prev = this.tabChains.get(tab.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(block);
    const tail = next.catch(() => {});
    this.tabChains.set(tab.id, tail);
    void tail.then(() => {
      if (this.tabChains.get(tab.id) === tail) this.tabChains.delete(tab.id);
    });
    return next;
  }

  private moveTo(tabId: string, fx: number, fy: number, label: string | null) {
    this.notify('overlay', { tabId, op: 'move', fx, fy, ...(label ? { label } : {}) });
  }
  private press(tabId: string, down: boolean) {
    this.notify('overlay', { tabId, op: 'press', down });
  }
  private clickFx(tabId: string) {
    this.notify('overlay', { tabId, op: 'click' });
  }
  private activity(tabId: string, label: string | null) {
    this.notify('overlay', { tabId, op: 'activity', ...(label ? { label } : {}) });
  }

  // ------------------------------------------------------------------------------------------------ dispatch

  private async run(name: string, args: Args, batch: Batch | null): Promise<McpResult> {
    const out = new Out();
    let begun: string | null = null;
    try {
      if (!this.bridge.connected()) throw new ToolError(NOT_CONNECTED);
      let pageTab: Tab | null = null;
      if (PAGE_TOOLS.has(name)) {
        pageTab = await this.tab(args, name === 'browser_eval_js' ? 'run a script in' : 'control');
        this.dialogGuard(pageTab);
        const b = await this.c<{ userUnlocked: boolean }>('agent.begin', { tabId: pageTab.id, ...(summary(args) ? { label: summary(args) } : {}) });
        begun = pageTab.id;
        if (b.userUnlocked) {
          out.text(
            'Note: the user unlocked this tab and may have used it, so earlier refs and screenshots can be out of date: ' +
              'read the page again before relying on them. If your task is not finished, lock it again with browser_lock.',
          );
        }
      }
      switch (name) {
        case 'browser_list_tabs':
          await this.listTabs(out);
          break;
        case 'browser_open_url':
          await this.openUrl(args, out);
          break;
        case 'browser_switch_tab': {
          const id = str(args.tab_id).trim();
          if (!id) throw new ToolError('tab_id is required');
          await this.c('tabs.activate', { tabId: id }, 150_000);
          out.text(`Switched to tab ${id}`);
          break;
        }
        case 'browser_close_tab': {
          const id = str(args.tab_id).trim();
          if (!id) throw new ToolError('tab_id is required');
          await this.c('tabs.close', { tabId: id }, 150_000);
          this.frames.delete(id);
          out.text(`Closed tab ${id}`);
          break;
        }
        case 'browser_set_view_mode':
          await this.setViewMode(args, out);
          break;
        case 'browser_lock':
          await this.lockTool(args, out);
          break;
        case 'browser_handle_dialog':
          await this.handleDialog(args, out);
          break;
        case 'browser_read_page': {
          const tab = pageTab!;
          const opts: Args = { filter: str(args.filter) || 'all' };
          if (has(args, 'depth')) opts.depth = int(args, 'depth', 25);
          const ref = str(args.ref_id).trim();
          if (ref) opts.refId = ref;
          if (has(args, 'max_chars')) opts.maxChars = int(args, 'max_chars', 50_000);
          this.activity(tab.id, 'Reading the page');
          out.text(await this.agentText(tab, 'tree', opts));
          break;
        }
        case 'browser_find': {
          const query = str(args.query).trim();
          if (!query) throw new ToolError('query is empty: describe the element, e.g. "search box"');
          const tab = pageTab!;
          this.activity(tab.id, `Looking for "${clip(query, 24)}"`);
          out.text(await this.agentText(tab, 'find', query));
          break;
        }
        case 'browser_get_page_text': {
          const tab = pageTab!;
          this.activity(tab.id, 'Reading the text');
          out.text(await this.agentText(tab, 'pageText', int(args, 'max_chars', 50_000), bool(args.include_hidden)));
          break;
        }
        case 'browser_computer':
          await this.computer(pageTab!, args, batch, out);
          break;
        case 'browser_form_input':
          await this.formInput(pageTab!, args, out);
          break;
        case 'browser_eval_js':
          await this.evalJs(pageTab!, args, out);
          break;
        case 'browser_get_console_logs':
          await this.consoleLogs(await this.tab(args, 'read the console of'), args, out);
          break;
        case 'browser_read_network': {
          const tab = await this.tab(args, 'read the network requests of');
          await this.network(tab, args, out);
          break;
        }
        case 'browser_upload_file':
          await this.upload(pageTab!, args, out);
          break;
        case 'browser_batch':
          if (batch) throw new ToolError('browser_batch cannot be nested');
          return await this.runBatch(args);
        case 'browser_screenshot':
        case 'browser_inspect_dom':
        case 'browser_interact':
          return await this.legacy(name, args);
        default:
          throw new ToolError(`Unknown tool: ${name}`);
      }
      return out.result();
    } catch (e) {
      if (e instanceof DialogOpened) {
        return out.text(`${dialogText(e.tabId, e.dialog)}. The page is paused until it is answered: call browser_handle_dialog (accept=true or false).`).result(true);
      }
      if (e instanceof ToolError) return out.text(e.message || 'Failed').result(true);
      return out.text(`${name} failed: ${errText(e)}`).result(true);
    } finally {
      if (begun) this.notify('agent.end', { tabId: begun });
    }
  }

  // ------------------------------------------------------------------------------------------------ tabs, lock, dialogs

  private async listTabs(out: Out) {
    const r = await this.c<{ tabs: Tab[]; current: string | null; others: number }>('tabs.list');
    const list = r.tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      isDesktopMode: t.viewMode !== 'mobile',
      viewMode: t.viewMode,
      isLoading: t.status === 'loading',
      consoleErrorCount: t.consoleErrors,
      networkErrorCount: t.networkErrors,
      ...(t.locked ? { lockedByAgent: true } : {}),
      ...(t.dialog ? { dialog: { type: t.dialog.type, message: clip(t.dialog.message, 300) } } : {}),
      ...(t.blocked ? { blocked: true } : {}),
      isVisible: t.active,
      isActive: t.isCurrent,
    }));
    out.text(JSON.stringify(list, null, 2));
    const notes: string[] = [];
    if (!list.length) notes.push('No AntiGem tabs are open: browser_open_url opens one (in the AntiGem tab group).');
    if (r.others > 0) notes.push(`${r.others} other tab${r.others === 1 ? ' is' : 's are'} open outside the AntiGem tab group; you cannot see or use ${r.others === 1 ? 'it' : 'them'} unless the user drags ${r.others === 1 ? 'it' : 'them'} into the group.`);
    if (notes.length) out.text(notes.join('\n'));
  }

  private tabLine(t: { id: string; url?: string }) {
    return `${t.id} (${clip(t.url || 'new tab', 80)})`;
  }

  private async lockTool(args: Args, out: Out) {
    if (args.locked !== false && args.locked !== 'false') {
      const r = await this.c<{ tabId: string; locked: string[] }>('lock.set', { tabId: str(args.tab_id).trim() || null, locked: true, label: summary(args) ?? 'Taking control' }, 150_000);
      const tabs = (await this.c<{ tabs: Tab[] }>('tabs.list')).tabs;
      const locked = r.locked.map((id) => tabs.find((t) => t.id === id) ?? { id });
      out.text(
        `Agent lock on. Locked now: ${locked.map((t) => this.tabLine(t)).join(', ')}.\n` +
          "Every tab you use or open from now on (new tabs, popups from clicks) is locked too: the user's mouse and keyboard are " +
          'kept off the page. The user sees an Unlock button on locked tabs. When your task is done, call browser_lock ' +
          'with locked=false (no tab_id) to release them all.',
      );
      return;
    }
    const id = str(args.tab_id).trim();
    const tabs = (await this.c<{ tabs: Tab[] }>('tabs.list')).tabs;
    const line = (tid: string) => this.tabLine(tabs.find((t) => t.id === tid) ?? { id: tid });
    if (!id) {
      const r = await this.c<{ released: string[] }>('lock.set', { locked: false });
      for (const t of r.released) this.activity(t, summary(args) ?? 'Done');
      const n = r.released.length;
      out.text(n === 0 ? 'Agent lock off. No tab was locked.' : `Agent lock off. Released ${n} tab${n === 1 ? '' : 's'}: ${r.released.map(line).join(', ')}. The user can use ${n === 1 ? 'it' : 'them'} again.`);
      return;
    }
    const r = await this.c<{ was: boolean; locked: string[] }>('lock.set', { tabId: id, locked: false }, 150_000);
    const still = r.locked.length ? `Still locked: ${r.locked.map(line).join(', ')}.` : 'No tab is locked now.';
    out.text(r.was ? `Released tab ${id}; it stays unlocked until you lock it again. ${still}` : `Tab ${id} was not locked. ${still}`);
  }

  private dialogGuard(tab: Tab) {
    if (!tab.dialog) return;
    throw new ToolError(
      `${dialogText(tab.id, tab.dialog)}. The tab is paused until it is answered, so nothing was done. ` +
        `Call browser_handle_dialog with accept=true (OK${tab.dialog.type === 'beforeunload' ? '/Leave' : ''}) or accept=false (Cancel).`,
    );
  }

  private async handleDialog(args: Args, out: Out) {
    const id = str(args.tab_id).trim();
    const { dialogs } = await this.c<{ dialogs: (Dialog & { tabId: string })[] }>('dialog.list');
    const d = id ? dialogs.find((x) => x.tabId === id) : dialogs[0];
    if (!d) throw new ToolError(id ? `No page dialog is open on tab ${id}.` : 'No page dialog is open.');
    if (!has(args, 'accept')) throw new ToolError('accept is required: true for OK (or Leave), false for Cancel (or Stay).');
    const accept = bool(args.accept);
    const text = has(args, 'prompt_text') ? str(args.prompt_text) : undefined;
    await this.c('dialog.handle', { tabId: d.tabId, accept, ...(text !== undefined ? { promptText: text } : {}) });
    this.activity(d.tabId, accept ? 'Answering the dialog' : 'Dismissing the dialog');
    await sleep(300);
    const reply = d.type === 'prompt' && accept ? ` with "${clip(text ?? d.defaultPrompt ?? '', 60)}"` : '';
    const after = (await this.c<{ dialogs: (Dialog & { tabId: string })[] }>('dialog.list')).dialogs[0];
    const next = after ? `\nAnother dialog opened right after: ${dialogText(after.tabId, after)}.` : '';
    out.text(`${accept ? 'Accepted' : 'Dismissed'} the ${d.type} "${clip(d.message, 120)}"${reply} on tab ${d.tabId}.${next}`);
  }

  // ------------------------------------------------------------------------------------------------ navigation

  private async waitLoad(tabId: string, timeoutMs: number): Promise<{ loaded: boolean; url?: string; title?: string; error?: string; dialog?: Dialog }> {
    return this.c('tabs.wait', { tabId, timeoutMs }, timeoutMs + 5_000);
  }

  private async openUrl(args: Args, out: Out) {
    const url = str(args.url).trim();
    if (!url) throw new ToolError('url is empty');
    const desktop = has(args, 'mode') ? ['desktop', 'web'].includes(str(args.mode).toLowerCase()) : has(args, 'desktop_mode') ? bool(args.desktop_mode) : null;
    const lower = url.toLowerCase();
    let tabId: string;
    if (lower === 'back' || lower === 'forward' || lower === 'reload') {
      const tab = await this.tab(args, 'move in the history of', false);
      this.dialogGuard(tab);
      const r = await this.c<{ moved: boolean }>('tabs.history', { tabId: tab.id, action: lower }, 150_000);
      if (!r.moved) throw new ToolError(`This tab has no ${lower === 'back' ? 'earlier' : 'later'} page in its history.`);
      await sleep(300);
      tabId = tab.id;
    } else {
      if (str(args.tab_id).trim() || !bool(args.new_tab)) {
        const cur = str(args.tab_id).trim() ? await this.tab(args, 'open a page in', false) : null;
        if (cur) this.dialogGuard(cur);
      }
      const r = await this.c<{ tabId: string }>(
        'tabs.open',
        { url, tabId: str(args.tab_id).trim() || null, newTab: bool(args.new_tab), viewMode: desktop === null ? null : desktop ? 'desktop' : 'mobile' },
        150_000,
      );
      tabId = r.tabId;
    }
    let host = '';
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
    } catch {
      host = '';
    }
    const opening = lower === 'back' ? 'Going back' : lower === 'forward' ? 'Going forward' : lower === 'reload' ? 'Reloading' : `Opening ${host || clip(url, 24)}`;
    const w = await this.waitLoad(tabId, 10_000);
    this.activity(tabId, summary(args) ?? opening);
    if (w.dialog) {
      out.text(`Tab ${tabId}: opening ${url}. The page opened a dialog while loading: ${lowerFirst(dialogText(tabId, w.dialog))}. It is paused until answered: call browser_handle_dialog.`);
      return;
    }
    const tabs = (await this.c<{ tabs: Tab[] }>('tabs.list')).tabs;
    const t = tabs.find((x) => x.id === tabId);
    const finalUrl = t?.url ?? w.url ?? url;
    const title = t?.title ?? w.title ?? '';
    const mode = t?.viewMode === 'mobile' ? 'mobile' : 'desktop';
    const lockState = t?.locked ? ', locked' : '';
    const error = w.error ? `\nThe page reported an error: ${w.error}` : '';
    const blocked = t?.blocked ? '\nThis page is on the AntiGem blocklist: you cannot read or control it. Go back or open another page.' : '';
    out.text(
      `Tab ${tabId}: ${w.loaded ? 'loaded' : 'still loading after 10 s'} ${finalUrl} — "${title}" [${mode} view${lockState}]${error}${blocked}\n` +
        'Next: browser_find or browser_read_page for refs, or browser_computer action=screenshot to see it.',
    );
  }

  private async setViewMode(args: Args, out: Out) {
    const tab = await this.tab(args, 'change the view mode of');
    this.dialogGuard(tab);
    const desktop = has(args, 'mode') ? ['desktop', 'web'].includes(str(args.mode).toLowerCase()) : has(args, 'desktop_mode') ? bool(args.desktop_mode) : tab.viewMode === 'mobile';
    await this.c('tabs.viewMode', { tabId: tab.id, mode: desktop ? 'desktop' : 'mobile' });
    await sleep(300);
    const w = await this.waitLoad(tab.id, 10_000);
    out.text(`Switched tab ${tab.id} to ${desktop ? 'desktop' : 'mobile'} view (${w.url ?? tab.url}). Take a new screenshot before using coordinates.`);
  }

  // ------------------------------------------------------------------------------------------------ computer

  private async computer(tab: Tab, args: Args, batch: Batch | null, out: Out) {
    try {
      await this.computerAction(tab, args, batch, out);
    } catch (e) {
      if (!(e instanceof FrameError)) throw e;
      await this.screenshot(tab, 1, batch, out);
      throw new ToolError(`${e.message} Nothing was sent. A fresh screenshot is attached above: use its pixels and try again.`);
    }
  }

  /** A note when coordinates come from a screenshot of a page that has since been left. */
  private staleNote(tab: Tab, vp: Viewport) {
    const frame = this.frames.get(tab.id);
    if (!frame) return '';
    const now = vp.url ?? '';
    return frame.url && now && frame.url !== now ? `\nNote: these coordinates come from a screenshot of ${frame.url}; the tab now shows ${now}. Take a new screenshot if that was not intended.` : '';
  }

  private async computerAction(tab: Tab, args: Args, batch: Batch | null, out: Out) {
    const action = str(args.action);
    switch (action) {
      case 'screenshot':
        this.activity(tab.id, summary(args) ?? 'Looking at the page');
        await this.screenshot(tab, has(args, 'scale') ? Number(args.scale) : 1, batch, out);
        return;
      case 'zoom':
        this.activity(tab.id, summary(args) ?? 'Looking closer');
        await this.zoom(tab, args, out);
        return;
      case 'wait': {
        const seconds = Number(args.duration);
        if (!has(args, 'duration') || !Number.isFinite(seconds) || seconds <= 0) throw new ToolError('wait needs duration in seconds (up to 10)');
        if (seconds > 10) throw new ToolError('duration cannot exceed 10 seconds');
        this.activity(tab.id, summary(args) ?? 'Waiting');
        await sleep(seconds * 1000);
        out.text(`Waited ${num(seconds)} s`);
        return;
      }
      case 'left_click':
      case 'right_click':
      case 'double_click':
      case 'triple_click':
        return this.serial(tab, () => this.click(tab, args, action, out));
      case 'hover':
        return this.serial(tab, () => this.hover(tab, args, out));
      case 'left_click_drag':
        return this.serial(tab, () => this.drag(tab, args, out));
      case 'type':
        return this.serial(tab, () => this.type(tab, args, out));
      case 'key':
        return this.serial(tab, () => this.key(tab, args, out));
      case 'scroll':
        return this.serial(tab, () => this.scroll(tab, args, batch, out));
      case 'scroll_to':
        return this.serial(tab, async () => {
          const ref = str(args.ref).trim();
          if (!ref) throw new ToolError('scroll_to needs ref');
          this.activity(tab.id, summary(args) ?? 'Scrolling to it');
          const r = await this.agent(tab, 'scrollIntoViewRef', ref);
          if (!r.ok) throw new ToolError(r.error);
          out.text(`Scrolled ${r.desc} [${ref}] into view${r.note ?? ''}${!r.onScreen ? ' (it is still outside the visible area; it may be inside a hidden or clipped box)' : ''}`);
        });
      case '':
        throw new ToolError('action is required');
      default:
        throw new ToolError(`Unknown action "${action}"`);
    }
  }

  /** Where ref or coordinate points, in visible-area CSS px (what DevTools input uses). */
  private async target(tab: Tab, args: Args, what: string): Promise<Target> {
    const ref = str(args.ref).trim();
    if (ref) {
      const r = await this.agent(tab, 'resolve', ref, true);
      if (!r.ok) throw new ToolError(`${r.error} No mouse event was sent.`);
      return { x: r.x, y: r.y, vw: r.vw, vh: r.vh, desc: r.desc ?? '', ref: r.ref ?? '', fileInput: !!r.fileInput, coveredBy: r.coveredBy ?? '', byRef: true, note: r.note ?? '' };
    }
    const vp = await this.agent<Viewport>(tab, 'viewport');
    const [x, y] = this.point(tab, args.coordinate, what, vp);
    const hit = await this.agent(tab, 'hitTest', x, y);
    return { x, y, vw: vp.w, vh: vp.h, desc: hit.desc ?? '', ref: hit.ref ?? '', fileInput: !!hit.fileInput, coveredBy: '', byRef: false, note: this.staleNote(tab, vp) };
  }

  /** Maps screenshot pixels to visible-area CSS px using the tab's latest screenshot. */
  private point(tab: Tab, coordinate: unknown, what: string, vp: Viewport): [number, number] {
    if (!Array.isArray(coordinate) || coordinate.length !== 2) throw new ToolError(`${what} needs ref, or coordinate [x, y] in pixels of the latest screenshot.`);
    const frame = this.frames.get(tab.id);
    if (!frame) throw new FrameError('There is no screenshot of this tab yet, so coordinates have no meaning (or pass ref from browser_find / browser_read_page instead).');
    const x = Number(coordinate[0]);
    const y = Number(coordinate[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > frame.shotW + 2 || y > frame.shotH + 2) {
      throw new FrameError(`Coordinate (${num(x)}, ${num(y)}) is outside the latest screenshot (${frame.shotW}x${frame.shotH}): use pixels of the full-size screenshot.`);
    }
    if (Math.abs(vp.w - frame.cssW) > frame.cssW * 0.03 || Math.abs(vp.h - frame.cssH) > frame.cssH * 0.03) {
      throw new FrameError('The visible page area changed since the last screenshot (window size, zoom or view mode), so its coordinates no longer fit.');
    }
    return [(x * frame.cssW) / frame.shotW, (y * frame.cssH) / frame.shotH];
  }

  private mouse(type: string, x: number, y: number, button = 'none', buttons = 0, clickCount = 0, modifiers = 0, delayMs = 0) {
    return { method: 'Input.dispatchMouseEvent', params: { type, x, y, button, buttons, clickCount, modifiers }, ...(delayMs ? { delayMs } : {}) };
  }

  private input(tab: Tab, commands: unknown[], timeoutMs = 60_000) {
    return this.c('cdp', { tabId: tab.id, commands }, timeoutMs);
  }

  /** Shows the agent cursor travelling to the target and gives the user a moment to see it. */
  private async showPointer(tab: Tab, t: Target, label: string) {
    this.moveTo(tab.id, t.x / t.vw, t.y / t.vh, label);
    if (tab.active) await sleep(230);
  }

  private async click(tab: Tab, args: Args, action: string, out: Out) {
    const t = await this.target(tab, args, action);
    const button = action === 'right_click' ? 'right' : 'left';
    if (t.fileInput && button === 'left') {
      throw new ToolError(`${t.desc} opens a file picker, which cannot be used here. Use browser_upload_file with ref=${t.ref || '<its ref>'} instead. No click was sent.`);
    }
    const count = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
    let modifiers: number;
    try {
      modifiers = K.parseModifiers(str(args.modifiers));
    } catch (e) {
      throw new ToolError(errText(e));
    }
    const verb = action === 'double_click' ? 'Double-clicked' : action === 'triple_click' ? 'Triple-clicked' : action === 'right_click' ? 'Right-clicked' : 'Clicked';
    const before = await this.pageState(tab);
    await this.showPointer(tab, t, summary(args) ?? `${verb.replace(/ed$/, '')}ing ${short(t.desc)}`);
    const mask = button === 'right' ? 2 : 1;
    const cmds: unknown[] = [this.mouse('mouseMoved', t.x, t.y, 'none', 0, 0, modifiers)];
    for (let i = 1; i <= count; i++) {
      cmds.push(this.mouse('mousePressed', t.x, t.y, button, mask, i, modifiers));
      cmds.push(this.mouse('mouseReleased', t.x, t.y, button, 0, i, modifiers, i < count ? 70 : 0));
    }
    try {
      await this.input(tab, cmds);
    } catch (e) {
      if (!(e instanceof DialogOpened)) throw e;
      this.clickFx(tab.id);
      out.text(
        `${verb} ${t.desc}${t.ref ? ` [${t.ref}]` : ''}. That opened a page dialog: ${lowerFirst(dialogText(e.tabId || tab.id, e.dialog))}. ` +
          'The page is paused until it is answered: call browser_handle_dialog (accept=true or false).',
      );
      return;
    }
    this.clickFx(tab.id);
    const where = t.byRef ? `${t.desc} [${t.ref}]` : `(${num(t.x)}, ${num(t.y)} CSS px) on ${t.desc}${t.ref ? ` [${t.ref}]` : ''}`;
    const covered = t.coveredBy ? `\nNote: ${t.coveredBy} was covering it at that point, so the click may have gone there (e.g. a popup or banner).` : '';
    out.text(`${verb} ${where}${t.note}${covered}${await this.settle(tab, before)}`);
  }

  private async hover(tab: Tab, args: Args, out: Out) {
    const t = await this.target(tab, args, 'hover');
    await this.showPointer(tab, t, summary(args) ?? `Pointing at ${short(t.desc)}`);
    await this.input(tab, [this.mouse('mouseMoved', t.x, t.y)]);
    await sleep(150);
    out.text(`Moved the mouse over ${t.desc}${t.ref ? ` [${t.ref}]` : ''}${t.note}`);
  }

  private async drag(tab: Tab, args: Args, out: Out) {
    const vp = await this.agent<Viewport>(tab, 'viewport');
    const [sx, sy] = this.point(tab, args.start_coordinate, 'left_click_drag start_coordinate', vp);
    const [ex, ey] = this.point(tab, args.coordinate, 'left_click_drag coordinate', vp);
    const w = vp.w;
    const h = vp.h;
    this.moveTo(tab.id, sx / w, sy / h, summary(args) ?? 'Dragging');
    if (tab.active) await sleep(230);
    this.press(tab.id, true);
    const steps = 12;
    const cmds: unknown[] = [this.mouse('mouseMoved', sx, sy), this.mouse('mousePressed', sx, sy, 'left', 1, 1)];
    for (let i = 1; i <= steps; i++) cmds.push(this.mouse('mouseMoved', sx + ((ex - sx) * i) / steps, sy + ((ey - sy) * i) / steps, 'left', 1, 0, 0, 16));
    cmds.push(this.mouse('mouseReleased', ex, ey, 'left', 0, 1));
    await this.input(tab, cmds);
    this.moveTo(tab.id, ex / w, ey / h, null);
    this.press(tab.id, false);
    out.text(`Dragged from (${num(sx)}, ${num(sy)}) to (${num(ex)}, ${num(ey)}) CSS px`);
  }

  /** keyDown + keyUp for def; text is what it types (null for keys like Tab or arrows). */
  private keyEvents(def: K.KeyDef, modifiers: number, text: string | null): unknown[] {
    const shifted = def.text ? ((modifiers & K.SHIFT) !== 0 && def.text.length === 1 && /\p{L}/u.test(def.text) ? def.text.toUpperCase() : def.text) : null;
    const t = text ?? shifted;
    const typed = t && (modifiers & (K.CTRL | K.ALT | K.META)) === 0 ? t : null;
    const base = (type: string) => ({ type, key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers, location: def.location ?? 0 });
    return [
      { method: 'Input.dispatchKeyEvent', params: { ...base(typed ? 'keyDown' : 'rawKeyDown'), ...(typed ? { text: typed, unmodifiedText: typed } : {}) } },
      { method: 'Input.dispatchKeyEvent', params: base('keyUp') },
    ];
  }

  private async type(tab: Tab, args: Args, out: Out) {
    const text = str(args.text);
    if (!text) throw new ToolError('type needs text');
    if (text.length > 20_000) throw new ToolError(`text is too long (${text.length} characters, max 20000); type it in parts`);
    // a click can focus its field a moment later (e.g. a search overlay opening): give it time
    let focus = await this.agent(tab, 'focusInfo');
    const until = Date.now() + 1500;
    while ((focus.kind === 'none' || focus.kind === 'other') && Date.now() < until) {
      await sleep(150);
      focus = await this.agent(tab, 'focusInfo');
    }
    if (focus.kind === 'none') {
      throw new ToolError(
        'Nothing was typed: no text field has keyboard focus. Click the field first (its ref from browser_find), ' +
          'or set it with browser_form_input. To press keys on the page itself use action=key.',
      );
    }
    if (focus.kind === 'other') {
      throw new ToolError(
        `Nothing was typed: keyboard focus is on ${focus.desc}, which is not a text field. Click the ` +
          'text field first (its ref from browser_find), or set it with browser_form_input. To press keys there use action=key.',
      );
    }
    const secret = !!focus.sensitive;
    this.activity(tab.id, summary(args) ?? (secret ? 'Typing a password' : `Typing "${clip(text, 24)}"`));
    const before = await this.pageState(tab);
    const cmds: unknown[] = [];
    let plain = '';
    const flush = () => {
      if (plain) {
        cmds.push({ method: 'Input.insertText', params: { text: plain } });
        plain = '';
      }
    };
    for (const c of text) {
      if (c === '\r') continue;
      if (c === '\n') {
        flush();
        cmds.push(...this.keyEvents(K.enter(), 0, null));
      } else if (c === '\t') {
        flush();
        cmds.push(...this.keyEvents(K.tab(), 0, null));
      } else {
        const k = K.forChar(c);
        if (k) {
          flush();
          cmds.push(...this.keyEvents(k[0], k[1] ? K.SHIFT : 0, c));
        } else plain += c;
      }
    }
    flush();
    try {
      await this.input(tab, cmds, Math.max(60_000, cmds.length * 50));
    } catch (e) {
      if (e instanceof ToolError && /did not answer/.test(e.message)) throw new ToolError('The page stopped taking keyboard input (busy or frozen). Take a screenshot to see it.');
      throw e;
    }
    const shown = secret ? `${text.length} characters` : `"${clip(text, 80)}"`;
    // Enter or Tab may send, clear or leave the field, so only plain text can be checked
    if (focus.kind === 'editable' && !text.includes('\n') && !text.includes('\t')) {
      await sleep(80);
      const after = await this.agent(tab, 'focusInfo');
      if (after.ref === focus.ref && after.sig === focus.sig) {
        throw new ToolError(
          `Typed ${shown} into ${focus.desc}, but its content did not change: the page may have blocked the input ` +
            'or swapped the field. Take a screenshot to check, or use browser_form_input.',
        );
      }
    }
    const frameNote = focus.kind === 'frame' ? ' (inside a frame from another site, so the result could not be checked)' : '';
    out.text(`Typed ${shown} into ${focus.desc}${frameNote}${await this.settle(tab, before)}`);
  }

  private async key(tab: Tab, args: Args, out: Out) {
    const spec = str(args.text).trim();
    let steps: K.KeyStep[];
    try {
      steps = K.parse(spec);
    } catch (e) {
      throw new ToolError(errText(e));
    }
    const repeat = has(args, 'repeat') ? int(args, 'repeat', 0) : 1;
    if (repeat < 1 || repeat > 100) throw new ToolError('repeat must be between 1 and 100');
    const single = steps.length === 1 && steps[0].kind === 'press' ? steps[0] : null;
    const withCtrl = !!single && (single.modifiers & (K.CTRL | K.META)) !== 0;
    if (single && withCtrl && ['=', '+', '-', '0'].includes(single.def.key)) {
      throw new ToolError('Page zoom shortcuts are not supported. To look closer, use action=zoom with a region of the screenshot.');
    }
    if (single && repeat === 1 && (single.def.key === 'F5' || (withCtrl && single.def.key.toLowerCase() === 'r'))) {
      await this.c('tabs.history', { tabId: tab.id, action: 'reload' }, 30_000);
      await sleep(300);
      const w = await this.waitLoad(tab.id, 10_000);
      out.text(`Reloaded the page (${w.url ?? tab.url})`);
      return;
    }
    this.activity(tab.id, summary(args) ?? `Pressing ${clip(spec, 24)}`);
    const before = await this.pageState(tab);
    const cmds: unknown[] = [];
    for (let r = 0; r < repeat; r++) {
      for (const s of steps) {
        if (s.kind === 'text') {
          cmds.push({ method: 'Input.insertText', params: { text: s.text } });
          continue;
        }
        const held = K.modifierKeys(s.modifiers).filter((m) => m !== s.def);
        let bits = 0;
        for (const m of held) {
          bits |= m.modifierBit ?? 0;
          cmds.push({ method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, modifiers: bits, location: m.location ?? 0 } });
        }
        cmds.push(...this.keyEvents(s.def, s.modifiers, null));
        for (const m of [...held].reverse()) {
          bits &= ~(m.modifierBit ?? 0);
          cmds.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, modifiers: bits, location: m.location ?? 0 } });
        }
      }
    }
    try {
      await this.input(tab, cmds, Math.max(60_000, cmds.length * 50));
    } catch (e) {
      if (e instanceof ToolError && /did not answer/.test(e.message)) throw new ToolError('The page stopped taking keyboard input (busy or frozen). Take a screenshot to see it.');
      throw e;
    }
    const count = steps.length;
    out.text(`Pressed ${count === 1 ? 'key' : `${count} keys`}: ${spec}${repeat > 1 ? ` (${repeat} times)` : ''}${await this.settle(tab, before)}`);
  }

  private async scroll(tab: Tab, args: Args, batch: Batch | null, out: Out) {
    const direction = str(args.scroll_direction).trim() || 'down';
    const amount = Math.min(10, Math.max(1, int(args, 'scroll_amount', 3)));
    const vp = await this.agent<Viewport>(tab, 'viewport');
    const w = vp.w;
    const h = vp.h;
    const [x, y] = Array.isArray(args.coordinate) ? this.point(tab, args.coordinate, 'scroll', vp) : [w / 2, h / 2];
    const ticks = amount * 100;
    const delta: Record<string, [number, number]> = { up: [0, -ticks], down: [0, ticks], left: [-ticks, 0], right: [ticks, 0] };
    const d = delta[direction];
    if (!d) throw new ToolError('scroll_direction must be up, down, left or right');
    this.moveTo(tab.id, x / w, y / h, summary(args) ?? `Scrolling ${direction}`);
    await this.input(tab, [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x, y, deltaX: d[0], deltaY: d[1] } }]);
    await sleep(350);
    const after = await this.agent<Viewport>(tab, 'viewport');
    const at = (v: Viewport, k: 'sx' | 'sy', o: 'ox' | 'oy') => (v[k] ?? 0) + (v[o] ?? 0);
    const moved = Math.abs(at(after, 'sx', 'ox') - at(vp, 'sx', 'ox')) + Math.abs(at(after, 'sy', 'oy') - at(vp, 'sy', 'oy')) > 0.5;
    const where = `now showing ${num(at(after, 'sx', 'ox'))},${num(at(after, 'sy', 'oy'))} of ${Math.trunc(after.pw)}x${Math.trunc(after.ph)}`;
    out.text(
      `Scrolled ${direction} by ${amount} ticks at (${num(x)}, ${num(y)} CSS px), ${where}` +
        (!moved ? ' (the page itself did not move: an inner box may have scrolled, or this is already the end)' : ''),
    );
    await this.screenshot(tab, 1, batch, out);
  }

  // ------------------------------------------------------------------------------------------------ screenshots

  private async screenshot(tab: Tab, scale: number, batch: Batch | null, out: Out) {
    const s = Number.isFinite(scale) ? Math.min(1, Math.max(0.1, scale)) : 1;
    const r = await this.c<{ data: string; mimeType: string; fitW: number; fitH: number; outW: number; outH: number; vp: Viewport }>('screenshot', { tabId: tab.id, scale: s }, 30_000);
    const frame: Frame = { shotW: r.fitW, shotH: r.fitH, cssW: r.vp.w, cssH: r.vp.h, url: r.vp.url ?? '' };
    if (batch) batch.frames.set(tab.id, frame);
    else this.frames.set(tab.id, frame);
    const scaleNote = s < 1 ? `, shown at ${num(s)} scale: give coordinates in the full ${r.fitW}x${r.fitH} frame` : '';
    out.text(
      `Screenshot of tab ${tab.id} — "${clip(r.vp.title ?? '', 80)}" ${r.vp.url ?? ''}\n` +
        `Size ${r.fitW}x${r.fitH}${scaleNote}. Coordinates for clicks are pixels in this ${r.fitW}x${r.fitH} image.`,
    );
    out.image(r.data, r.mimeType || 'image/jpeg');
  }

  private async zoom(tab: Tab, args: Args, out: Out) {
    const region = args.region;
    if (!Array.isArray(region) || region.length !== 4) throw new ToolError('zoom needs region [x0, y0, x1, y1] in pixels of the latest screenshot');
    const frame = this.frames.get(tab.id);
    if (!frame) throw new FrameError('There is no screenshot of this tab yet: the zoom region is given in its pixels.');
    const [x0, y0, x1, y1] = region.map(Number);
    if ([x0, y0, x1, y1].some((v) => !Number.isFinite(v)) || x1 <= x0 || y1 <= y0) throw new ToolError('region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0');
    if (x0 < 0 || y0 < 0 || x1 > frame.shotW + 2 || y1 > frame.shotH + 2) throw new FrameError(`region is outside the latest screenshot (${frame.shotW}x${frame.shotH}).`);
    // screenshot px -> CSS px; the extension maps CSS px onto its capture
    const kx = frame.cssW / frame.shotW;
    const ky = frame.cssH / frame.shotH;
    const scale = has(args, 'scale') && Number.isFinite(Number(args.scale)) ? Math.min(1, Math.max(0.1, Number(args.scale))) : 1;
    const r = await this.c<{ data: string; mimeType: string; outW: number; outH: number }>('screenshot', { tabId: tab.id, regionCss: [x0 * kx, y0 * ky, x1 * kx, y1 * ky], scale }, 30_000);
    out.text(`Zoomed view of (${num(x0)}, ${num(y0)})-(${num(x1)}, ${num(y1)}) at ${r.outW}x${r.outH}. Click coordinates still refer to the full ${frame.shotW}x${frame.shotH} screenshot.`);
    out.image(r.data, r.mimeType || 'image/jpeg');
  }

  // ------------------------------------------------------------------------------------------------ forms, scripts, logs

  private formInput(tab: Tab, args: Args, out: Out) {
    return this.serial(tab, async () => {
      const ref = str(args.ref).trim();
      if (!ref) throw new ToolError('ref is required');
      if (!('value' in args)) throw new ToolError('value is required');
      const value = args.value;
      const where = await this.agent(tab, 'resolve', ref, true);
      if (!where.ok) throw new ToolError(where.error);
      this.moveTo(tab.id, where.x / where.vw, where.y / where.vh, summary(args) ?? `Filling ${short(where.desc ?? '')}`);
      const before = await this.pageState(tab);
      const r = await this.agent(tab, 'formInput', ref, value);
      this.clickFx(tab.id);
      if (!r.ok) throw new ToolError(r.error);
      out.text(`${r.text}${await this.settle(tab, before)}`);
    });
  }

  private async evalJs(tab: Tab, args: Args, out: Out) {
    const script = str(args.script).trim() ? str(args.script) : str(args.text);
    if (!script.trim()) throw new ToolError('script is empty');
    this.activity(tab.id, 'Running a script');
    const r = await this.c<{ result?: Record<string, unknown>; exceptionDetails?: Record<string, any> }>('page.eval', { tabId: tab.id, expression: script, timeoutMs: 30_000 }, 40_000);
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails;
      const desc = str(ex.exception?.description) || str(ex.text);
      throw new ToolError(`JavaScript error: ${desc.slice(0, 4000)}`);
    }
    const result = r.result ?? {};
    let text: string;
    if (result.type === 'undefined') text = 'undefined';
    else if ('value' in result) {
      const v = result.value;
      text = typeof v === 'string' ? v : v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
    } else text = str(result.description) || str(result.unserializableValue) || str(result.type);
    out.text(text.length > 100_000 ? `${text.slice(0, 100_000)}\n[cut at 100000 characters]` : text);
  }

  private async consoleLogs(tab: Tab, args: Args, out: Out) {
    const p = str(args.pattern).trim();
    let regex: RegExp | null = null;
    if (p) {
      try {
        regex = new RegExp(p, 'i');
      } catch {
        regex = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }
    }
    const lvl = str(args.level).toUpperCase();
    const level = lvl && lvl !== 'ALL' ? lvl : null;
    const limit = Math.min(300, Math.max(1, int(args, 'limit', 100)));
    const r = await this.c<{ entries: { level: string; message: string; sourceId: string; lineNumber: number; timestamp: number }[] }>('logs.console', { tabId: tab.id, clear: bool(args.clear) });
    const all = r.entries;
    const picked = all
      .filter((m) => (!bool(args.only_errors) || m.level === 'ERROR') && (!level || m.level === level) && (!regex || regex.test(m.message) || regex.test(m.sourceId)))
      .slice(-limit);
    const fmt = (t: number) => {
      const d = new Date(t);
      const pad = (n: number, w = 2) => String(n).padStart(w, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    };
    const lines = picked.map((m) => {
      const file = m.sourceId.split('?')[0].split('/').pop()?.slice(0, 60) ?? '';
      return `[${fmt(m.timestamp)}] ${m.level} ${m.message.slice(0, 2000)}${file ? ` (${file}:${m.lineNumber})` : ''}`;
    });
    const filtered = !!regex || !!level || bool(args.only_errors);
    out.text(
      !lines.length
        ? `No console messages${filtered ? ' match' : ' yet'} (${all.length} recorded in total).`
        : `${picked.length < all.length ? `Newest ${picked.length} of ${all.length}` : `All ${all.length}`} console messages, oldest first:\n${lines.join('\n')}`,
    );
  }

  private async network(tab: Tab, args: Args, out: Out) {
    const pattern = str(args.url_pattern).trim();
    const onlyFailed = bool(args.only_failed);
    const limit = Math.min(500, Math.max(1, int(args, 'limit', 100)));
    const r = await this.c<{ entries: { method: string; url: string; type: string; status: number; mime: string; bytes: number; durationMs: number; fromCache: boolean; error: string | null }[] }>(
      'logs.network',
      { tabId: tab.id, clear: bool(args.clear) },
    );
    const all = r.entries;
    const picked = all.filter((e) => (!pattern || e.url.includes(pattern)) && (!onlyFailed || e.error !== null || e.status >= 400)).slice(-limit);
    const lines = picked.map((e) => {
      const status = e.error ? `FAILED(${e.error})` : e.status === 0 ? 'pending' : String(e.status);
      const size = e.bytes >= 0 ? ` ${e.bytes >= 1024 ? `${num(e.bytes / 1024)} KB` : `${e.bytes} B`}` : '';
      const time = e.durationMs >= 0 ? ` ${e.durationMs} ms` : '';
      return `${e.method} ${status} ${e.type.toLowerCase()}${e.mime ? ` ${e.mime}` : ''}${size}${time}${e.fromCache ? ' (cache)' : ''} ${clip(e.url, 300)}`;
    });
    out.text(
      !lines.length
        ? `No requests${pattern || onlyFailed ? ' match' : ' recorded yet'} (${all.length} in total). Recording started when the browser MCP first used this tab; reload to capture a page's own requests.`
        : `${picked.length < all.length ? `Newest ${picked.length} of ${all.length}` : `All ${all.length}`} requests, oldest first:\n${lines.join('\n')}`,
    );
  }

  /** Local files for an upload: existing regular files, never from key / credential folders. */
  private uploadFiles(paths: string[]) {
    if (paths.length < 1 || paths.length > 20) throw new ToolError('Pass 1–20 file paths');
    const home = os.homedir();
    return paths.map((p) => {
      const raw = p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : path.isAbsolute(p) ? p : path.join(this.opts.workspace(), p);
      let real: string;
      try {
        real = fs.realpathSync(raw);
      } catch {
        throw new ToolError(`File not found: ${p}`);
      }
      const st = fs.statSync(real);
      if (!st.isFile()) throw new ToolError(`Not a file: ${p}`);
      const rel = path.relative(home, real);
      if (!rel.startsWith('..') && SECRET_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) throw new ToolError(`Refusing to upload ${p}: it is in ~/${rel.split('/')[0]}, which holds keys or credentials.`);
      const ext = path.extname(real).slice(1).toLowerCase();
      return { path: real, name: path.basename(real), size: st.size, type: MIME[ext] ?? 'application/octet-stream' };
    });
  }

  private upload(tab: Tab, args: Args, out: Out) {
    return this.serial(tab, async () => {
      const paths = Array.isArray(args.file_paths) ? args.file_paths.map(str).filter(Boolean) : [];
      if (!paths.length) throw new ToolError('file_paths is empty');
      const files = this.uploadFiles(paths);
      const ref = str(args.ref).trim();
      const label = summary(args) ?? `Uploading ${files.length} file${files.length === 1 ? '' : 's'}`;
      if (ref) {
        const r = await this.agent(tab, 'resolve', ref, true);
        if (!r.ok) throw new ToolError(r.error);
        this.moveTo(tab.id, r.x / r.vw, r.y / r.vh, label);
      } else this.activity(tab.id, label);
      const payload: Args = {
        tabId: tab.id,
        files,
        ref: ref || null,
        selector: str(args.selector).trim() || null,
        method: str(args.method).trim() || 'auto',
        timeoutSeconds: Math.min(30, Math.max(1, int(args, 'timeout_seconds', 10))),
      };
      let res = await this.c<Record<string, unknown>>('upload', payload, 90_000);
      if (res?.needData) {
        const total = files.reduce((a, f) => a + f.size, 0);
        if (total > MAX_UPLOAD_IN_PAGE) throw new ToolError('Upload failed: No file chooser opened, and the files are too large to build inside the page (25 MiB). Point at the element that opens the file chooser.');
        const data = files.map((f) => ({ name: f.name, type: f.type, data: fs.readFileSync(f.path).toString('base64') }));
        res = await this.c<Record<string, unknown>>('upload', { ...payload, method: 'drop', data }, 120_000);
      }
      if (ref) this.clickFx(tab.id);
      out.text(JSON.stringify(res, null, 2));
    });
  }

  // ------------------------------------------------------------------------------------------------ batch

  private async runBatch(args: Args): Promise<McpResult> {
    const actions = args.actions;
    if (!Array.isArray(actions)) return new Out().text('actions is required: a list of {name, input}').result(true);
    if (!actions.length) return new Out().text('actions is empty').result(true);
    if (actions.length > 50) return new Out().text('At most 50 actions per batch').result(true);
    const batch: Batch = { frames: new Map() };
    const out = new Out();
    let failed = false;
    try {
      for (let i = 0; i < actions.length; i++) {
        const item = actions[i] && typeof actions[i] === 'object' ? (actions[i] as Args) : null;
        const raw = str(item?.name).trim();
        const name = ALIASES[raw] ?? (raw.startsWith('browser_') ? raw : `browser_${raw}`);
        const input = item?.input && typeof item.input === 'object' ? (item.input as Args) : {};
        const act = str(input.action).trim();
        const label = `[${i + 1}/${actions.length}] ${name}${act ? ` ${act}` : ''}`;
        if (!item || !raw) {
          out.text(`${label}: each action needs a name and an input object. Stopped here.`);
          failed = true;
          break;
        }
        if (name === 'browser_batch') {
          out.text(`${label}: batches cannot be nested. Stopped here.`);
          failed = true;
          break;
        }
        const known = TOOLS.some((t) => t.name === name) || HIDDEN_TOOLS.has(name);
        const result = known ? await this.run(name, input, batch) : new Out().text(`Unknown tool: ${name}`).result(true);
        let first = true;
        for (const c of result.content) {
          if (c.type === 'text' && first) {
            out.content.push({ type: 'text', text: `${label}: ${c.text}` });
            first = false;
          } else out.content.push(c);
        }
        if (first) out.text(`${label}: done`);
        if (result.isError) {
          out.text(`Batch stopped at step ${i + 1} of ${actions.length} because it failed; later steps were not run.`);
          failed = true;
          break;
        }
      }
    } finally {
      for (const [k, v] of batch.frames) this.frames.set(k, v);
    }
    return out.result(failed);
  }

  // ------------------------------------------------------------------------------------------------ legacy tools (hidden)

  private async legacy(name: string, args: Args): Promise<McpResult> {
    const out = new Out();
    try {
      const tab = await this.tab(args, 'control');
      this.dialogGuard(tab);
      switch (name) {
        case 'browser_screenshot': {
          const r = await this.c<{ data: string; mimeType: string }>('screenshot', { tabId: tab.id, scale: 1 }, 30_000);
          out.image(r.data, r.mimeType || 'image/jpeg');
          break;
        }
        case 'browser_inspect_dom':
          out.text(await this.agentText(tab, 'tree', { filter: 'all' }));
          break;
        case 'browser_interact': {
          const selector = str(args.selector).trim();
          const action = str(args.action);
          const js =
            action === 'click'
              ? `(() => { const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : `document.elementFromPoint(${Number(args.x) || 0}, ${Number(args.y) || 0})`}; if (!el) throw new Error('No element'); el.click(); return true; })()`
              : action === 'type'
                ? `(() => { const el = document.querySelector(${JSON.stringify(selector || 'input')}); if (!el) throw new Error('No element'); el.focus(); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const set = Object.getOwnPropertyDescriptor(proto, 'value').set; set.call(el, ${bool(args.clear_first) ? '' : 'el.value + '}${JSON.stringify(str(args.text))}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`
                : action === 'scroll'
                  ? `(() => { const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'null'}; (el || window).scrollBy(${int(args, 'dx', 0)}, ${int(args, 'dy', 0)}); return true; })()`
                  : null;
          if (!js) {
            out.text('Failed: action must be click, type or scroll');
            break;
          }
          const r = await this.c<{ exceptionDetails?: Record<string, any> }>('page.eval', { tabId: tab.id, expression: js, timeoutMs: 10_000 }, 20_000);
          out.text(r.exceptionDetails ? `Failed: ${str(r.exceptionDetails.exception?.description) || str(r.exceptionDetails.text)}` : 'Done');
          break;
        }
      }
      return out.result();
    } catch (e) {
      if (e instanceof DialogOpened) return out.text(`${dialogText(e.tabId, e.dialog)}. The page is paused until it is answered: call browser_handle_dialog.`).result(true);
      return out.text(`${name} failed: ${errText(e)}`).result(true);
    }
  }

  // ------------------------------------------------------------------------------------------------ page changes

  private async pageState(tab: Tab): Promise<PageState> {
    const r = await this.c<{ tabs: Tab[] }>('tabs.list');
    const t = r.tabs.find((x) => x.id === tab.id);
    return { url: t?.url ?? tab.url, title: t?.title ?? '', tabIds: new Set(r.tabs.map((x) => x.id)), loading: t?.status === 'loading', tabs: r.tabs };
  }

  /** Lets the page react, then reports navigation, new tabs and dialogs. */
  private async settle(tab: Tab, before: PageState): Promise<string> {
    await sleep(250);
    let now = await this.pageState(tab);
    // wait only for loads this action started: some pages never finish (long polling)
    if (now.url !== before.url || (!before.loading && now.loading)) {
      await this.waitLoad(tab.id, 6_000).catch(() => null);
      now = await this.pageState(tab);
    }
    let notes = '';
    const dlg = now.tabs.find((t) => t.dialog);
    if (dlg?.dialog) notes += `\nThat opened a page dialog: ${lowerFirst(dialogText(dlg.id, dlg.dialog))}. The page is paused until it is answered: call browser_handle_dialog.`;
    if (now.url !== before.url) {
      const t = now.tabs.find((x) => x.id === tab.id);
      notes += `\nThe page changed to ${now.url} — "${clip(now.title, 80)}"${now.loading ? ' (still loading)' : ''}. Earlier refs may be gone.`;
      if (t?.blocked) notes += ' It is on the AntiGem blocklist: you cannot read or control it, go back or open another page.';
    }
    const opened = now.tabs.filter((t) => !before.tabIds.has(t.id)).map((t) => `${t.id} (${t.url || 'loading'}${t.locked ? ', locked like this one' : ''})`);
    if (opened.length) notes += `\nThis opened a new tab: ${opened.join(', ')}. Pass its tab_id to work in it.`;
    return notes;
  }
}

function dialogText(tabId: string, d: Dialog) {
  const what = d.type === 'beforeunload' ? '"Leave this page?" dialog' : `JavaScript ${d.type}`;
  return `A ${what} is open on tab ${tabId}${d.message ? `: "${clip(d.message, 200)}"` : ''}${d.type === 'prompt' ? ' (it asks for text: pass prompt_text)' : ''}`;
}
