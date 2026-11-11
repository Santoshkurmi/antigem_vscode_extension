// The browser a plugin's chrome.* API acts on. In the app it is the in-app WebView (the native bridge's
// /api/browser/* + WebView DevTools); on PC it is the user's Chrome through the AntiGem Chrome extension (Phase 4's
// command client implements BrowserProvider). Without one, every browser call fails with a clear message and
// skills-only / storage-only plugins keep working.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** A tab as the runtime sees it (the app's /api/browser/tabs entry). `id` is the browser's own tab id. */
export interface BrowserTab {
  id: string | number;
  url: string;
  title: string;
  active: boolean;
  loading: boolean;
}

/** One tab's DevTools Protocol session (chrome.debugger in the Chrome extension). */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** CDP events of the tab; returns an unsubscribe. */
  onEvent(cb: (method: string, params: Record<string, unknown>) => void): () => void;
  /** The session ended (tab closed, debugger detached, extension disconnected). */
  onClose(cb: (reason: string) => void): () => void;
  close(): void;
}

export interface BrowserProvider {
  /** True while the browser can be used (the Chrome extension is connected). */
  available(): boolean;
  /** Why it can't be used (shown in errors). */
  unavailableReason(): string;
  /** Called with the new state whenever `available()` changes; returns an unsubscribe. */
  onAvailability?(cb: (available: boolean) => void): () => void;
  tabs(): Promise<BrowserTab[]>;
  open(url: string, opts: { active?: boolean }): Promise<BrowserTab>;
  update(tabId: string | number, props: { url?: string; active?: boolean; [k: string]: unknown }): Promise<void>;
  close(tabId: string | number): Promise<void>;
  /** Runs a script in the page's main world, returns its (JSON) value. */
  eval(tabId: string | number, script: string): Promise<unknown>;
  zoom(tabId: string | number, factor: number): Promise<void>;
  /** A DevTools session of the tab (Runtime/Page/Input/Network… commands and events). */
  cdp(tabId: string | number): Promise<CdpSession>;
  /** chrome.antigem.automation: busy lease, user-interaction lock, trusted tap at viewport fractions. */
  automation(tabId: string | number, args: { owner: string; busy?: boolean; locked?: boolean; tap?: { fx: number; fy: number } }): Promise<unknown>;
  /** chrome.antigem.uploadFiles: answers the page's file chooser with local files. */
  upload(
    tabId: string | number,
    args: { files: string[]; selector?: string; point?: { fx: number; fy: number }; method?: string; timeoutMs?: number },
  ): Promise<unknown>;
  /** Trusted key presses (optional). */
  key?(tabId: string | number, keys: string): Promise<void>;
}

const NO_BROWSER =
  'No browser is connected. Install the AntiGem Chrome extension and connect it (Settings → Browser) to let plugins use browser tabs.';

/** No browser: every call fails with a message that says how to get one. */
export class NoBrowser implements BrowserProvider {
  available() {
    return false;
  }
  unavailableReason() {
    return NO_BROWSER;
  }
  private fail(): never {
    throw new Error(NO_BROWSER);
  }
  tabs = async (): Promise<BrowserTab[]> => this.fail();
  open = async (): Promise<BrowserTab> => this.fail();
  update = async (): Promise<void> => this.fail();
  close = async (): Promise<void> => this.fail();
  eval = async (): Promise<unknown> => this.fail();
  zoom = async (): Promise<void> => this.fail();
  cdp = async (): Promise<CdpSession> => this.fail();
  automation = async (): Promise<unknown> => this.fail();
  upload = async (): Promise<unknown> => this.fail();
}

// ---- chrome.antigem.mediaInfo / mediaFrame: Android's MediaMetadataRetriever there, ffprobe / ffmpeg here

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        reject(new Error(e.code === 'ENOENT' ? `${cmd} is required for media info on this PC (install ffmpeg)` : `${cmd}: ${String(stderr || err.message).trim().slice(0, 300)}`));
      } else resolve(stdout);
    }),
  );

async function duration(file: string): Promise<number> {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = Number(out.trim());
  if (!Number.isFinite(d)) throw new Error(`Could not read the duration of ${file}`);
  return d;
}

export async function mediaInfo(file: string): Promise<{ duration: number }> {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  return { duration: await duration(file) };
}

/** A PNG frame next to the source (frame_<stem>_<ms>.png); no time = near the end (duration − 50 ms). */
export async function mediaFrame(file: string, atSeconds?: number | null): Promise<{ path: string }> {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const d = await duration(file);
  const at = atSeconds == null ? Math.max(0, d - 0.05) : Math.min(Math.max(0, Number(atSeconds)), Math.max(0, d - 0.001));
  const stem = path.basename(file, path.extname(file));
  const out = path.join(path.dirname(file), `frame_${stem}_${Math.round(at * 1000)}.png`);
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', out]);
  return { path: out };
}

/**
 * The app's /api/browser/<endpoint> contract (what the unchanged runtime calls), answered with the provider. Bodies and
 * results use the app's keys (tab_id, new_tab, file_paths, isActive…).
 */
export async function browserEndpoint(provider: BrowserProvider, endpoint: string, body: Record<string, unknown> | null): Promise<unknown> {
  const b = body ?? {};
  if (endpoint === 'media/info') return { success: true, ...(await mediaInfo(String(b.path ?? ''))) };
  if (endpoint === 'media/frame') return { success: true, ...(await mediaFrame(String(b.path ?? ''), b.at_seconds as number | undefined)) };
  if (!provider.available()) throw new Error(provider.unavailableReason());
  const tab = b.tab_id as string | number;
  switch (endpoint) {
    case 'tabs':
      return { tabs: (await provider.tabs()).map((t) => ({ id: t.id, url: t.url, title: t.title, isActive: t.active, isLoading: t.loading })) };
    case 'open': {
      const t = await provider.open(String(b.url ?? 'about:blank'), { active: b.active !== false });
      return { success: true, id: t.id, url: t.url, title: t.title };
    }
    case 'update': {
      const { tab_id: _id, ...props } = b;
      await provider.update(tab, props);
      return { success: true };
    }
    case 'close':
      await provider.close(tab);
      return { success: true };
    case 'eval':
      return { success: true, result: await provider.eval(tab, String(b.script ?? '')) };
    case 'zoom':
      await provider.zoom(tab, Number(b.factor ?? 1));
      return { success: true };
    case 'automation': {
      const r = await provider.automation(tab, {
        owner: String(b.owner ?? ''),
        ...(b.busy !== undefined ? { busy: b.busy === true } : {}),
        ...(b.locked !== undefined ? { locked: b.locked === true } : {}),
        ...(b.tap ? { tap: b.tap as { fx: number; fy: number } } : {}),
      });
      return { success: true, ...(r && typeof r === 'object' ? r : {}) };
    }
    case 'upload': {
      const r = await provider.upload(tab, {
        files: (b.file_paths as string[]) ?? [],
        ...(b.selector ? { selector: String(b.selector) } : {}),
        ...(b.fx != null && b.fy != null ? { point: { fx: Number(b.fx), fy: Number(b.fy) } } : {}),
        ...(b.method ? { method: String(b.method) } : {}),
        ...(b.timeout_ms ? { timeoutMs: Number(b.timeout_ms) } : {}),
      });
      return { success: true, ...(r && typeof r === 'object' ? r : {}) };
    }
    case 'key':
      if (!provider.key) throw new Error('Key presses are not supported by this browser connection');
      await provider.key(tab, String(b.keys ?? b.key ?? ''));
      return { success: true };
    default:
      throw new Error(`Unsupported browser operation: ${endpoint}`);
  }
}
