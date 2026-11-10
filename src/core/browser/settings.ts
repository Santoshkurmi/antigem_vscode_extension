// Settings → Browser: the AntiGem Chrome extension link (status, native host registration, extension install steps,
// blocklist, tests). Host-owned page 'browser'.
import os from 'node:os';
import path from 'node:path';
import type { SettingItem, SettingsPage, SettingsSection } from '../../../shared/protocol';
import type { Logger } from '../types';
import { type BrowserBridge, BrowserError } from './bridge';
import { EXTENSION_ID, HOST_NAME } from './constants';
import { defaultWrapperPath, extensionVersion, installExtensionFiles, register, registrationStatus, unregister } from './nativeHost';

export interface BrowserHooks {
  rootItem(): SettingItem;
  page(id: string): Promise<SettingsPage>;
  change(page: string, id: string, value: unknown): Promise<void>;
  action(page: string, id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void>;
  onChange(fn: () => void): void;
}

export interface BrowserSettingsDeps {
  bridge: BrowserBridge;
  /** The bridge binary the native host wrapper runs. */
  binPath: string;
  /** The bundled chrome-extension folder. */
  extensionDir: string;
  /** Reveal a folder in the OS file manager. */
  openFolder(p: string): void;
  copy(text: string): void;
  log: Logger;
  /** Port of the MCP host (to explain which window serves the browser). */
  mcpPort: number;
}

const tilde = (p: string) => {
  const home = os.homedir();
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
};

export const INSTALL_DIR = path.join(os.homedir(), '.antigem', 'chrome-extension');

export class BrowserSettings implements BrowserHooks {
  constructor(private d: BrowserSettingsDeps) {}

  onChange(fn: () => void) {
    this.d.bridge.onChange(fn);
  }

  private statusLine(): { text: string; tone: 'ok' | 'warn' | 'error' | 'muted' } {
    const b = this.d.bridge;
    const c = b.clientsInfo()[0];
    if (c) {
      const m = /(Edg|OPR|Brave|Vivaldi|HeadlessChrome|Chrome)\/([\d]+)/.exec(c.browser);
      return { text: `Connected · ${m ? `${m[1] === 'Edg' ? 'Edge' : m[1]} ${m[2]}` : 'browser'} · extension ${c.version}`, tone: 'ok' };
    }
    switch (b.status) {
      case 'listening':
        return { text: 'Waiting for the AntiGem extension (is Chrome open, the extension installed and the native host registered?)', tone: 'warn' };
      case 'busy':
        return { text: b.error || 'Another VS Code window serves the browser link', tone: 'muted' };
      case 'unsupported':
      case 'error':
        return { text: b.error, tone: 'error' };
      default:
        return { text: `Another VS Code window serves the browser link (the one that owns MCP port ${this.d.mcpPort})`, tone: 'muted' };
    }
  }

  rootItem(): SettingItem {
    const connected = this.d.bridge.connected();
    return {
      kind: 'page',
      id: 'browser',
      label: 'Browser',
      icon: 'language',
      description: 'Let agents use Chrome through the AntiGem extension',
      badge: connected ? 'Connected' : this.d.bridge.status === 'listening' ? 'Not connected' : null,
    };
  }

  async page(_id: string): Promise<SettingsPage> {
    const st = this.statusLine();
    const reg = registrationStatus(this.d.binPath);
    const installedBrowsers = reg.browsers.filter((b) => b.installed);
    const registered = reg.browsers.filter((b) => b.registered);
    const regText = !registered.length
      ? 'Not registered yet'
      : `${registered.map((b) => `${b.name}${b.manifestOk ? '' : ' (outdated)'}`).join(', ')}${reg.wrapperCurrent ? '' : ' — the host points at an older AntiGem install: register again'}`;
    const bundled = extensionVersion(this.d.extensionDir);
    const installed = extensionVersion(INSTALL_DIR);
    const connected = this.d.bridge.connected();

    let blocklist: string[] | null = null;
    if (connected) {
      try {
        blocklist = (await this.d.bridge.call<{ list: string[] }>('blocklist.get', {}, 3000)).list;
      } catch {
        blocklist = null;
      }
    }

    const status: SettingsSection = {
      id: 'browser-status',
      title: '',
      items: [
        { kind: 'info', id: 'browser.status', label: 'Connection', value: st.text, tone: st.tone },
        {
          kind: 'info',
          id: 'browser.how',
          label: 'How it works',
          value:
            'Agents get a "Browser" MCP (add it from each agent’s MCP page). They work only in tabs of the “AntiGem” tab group in Chrome; ' +
            'other tabs need your OK, and sites on the blocklist are never opened or controlled. Chrome talks to VS Code through native messaging — no network port.',
          tone: 'muted',
        },
      ],
    };

    const setup: SettingsSection = {
      id: 'browser-setup',
      title: 'Set up',
      items: [
        {
          kind: 'button',
          id: 'browser.install',
          label: '1 · Open the extension folder',
          description: `Copies the AntiGem extension${bundled ? ` ${bundled}` : ''} to ${tilde(INSTALL_DIR)}${installed ? ` (installed: ${installed}${installed !== bundled ? ' — update it, then press Reload on chrome://extensions' : ''})` : ''} and opens it`,
          style: installed ? 'default' : 'primary',
        },
        {
          kind: 'info',
          id: 'browser.steps',
          label: 'Load it in Chrome',
          value: `Open chrome://extensions (brave://extensions, edge://extensions), turn on Developer mode, press “Load unpacked” and pick ${tilde(INSTALL_DIR)}. Its id must be ${EXTENSION_ID}. Pin the AntiGem icon to see its status.`,
          tone: 'muted',
        },
        {
          kind: 'button',
          id: 'browser.register',
          label: '2 · Register with Chrome',
          description: `Lets the extension start AntiGem's native host (${HOST_NAME}) in ${installedBrowsers.length ? installedBrowsers.map((b) => b.name).join(', ') : 'your Chromium browsers'}. Registered: ${regText}`,
          style: registered.length && reg.wrapperCurrent && registered.every((b) => b.manifestOk) ? 'default' : 'primary',
        },
        { kind: 'button', id: 'browser.copyPath', label: 'Copy the extension folder path', description: tilde(INSTALL_DIR) },
        ...(registered.length
          ? [
              {
                kind: 'button' as const,
                id: 'browser.unregister',
                label: 'Remove the registration',
                description: `Deletes ${HOST_NAME}.json from every browser and the wrapper ${tilde(defaultWrapperPath())}`,
                style: 'danger' as const,
                confirm: 'Remove the AntiGem native host from all browsers? The extension cannot reach VS Code until you register again.',
              },
            ]
          : []),
      ],
    };

    const blockItems: SettingItem[] = [
      {
        kind: 'text',
        id: 'browser.blocklist',
        label: 'Blocklist',
        description: connected
          ? 'Sites agents can never open, read or control — one per line (a domain covers its subdomains; file:// = local files). Removing entries needs your OK in the browser. Also editable in the extension popup.'
          : 'Connect the extension to edit it here (or edit it in the extension popup).',
        value: (blocklist ?? []).join('\n'),
        multiline: true,
        rows: 8,
        code: true,
        disabled: !connected || blocklist === null,
      },
    ];

    const test: SettingsSection = {
      id: 'browser-test',
      title: 'Test',
      items: [
        { kind: 'button', id: 'browser.test', label: 'Test the connection', description: 'Asks the extension to answer', disabled: !connected },
        { kind: 'button', id: 'browser.testOpen', label: 'Open a test page', description: 'Opens example.com in a new tab of the AntiGem tab group', disabled: !connected },
      ],
    };

    return { id: 'browser', title: 'Browser', sections: [status, setup, { id: 'browser-blocklist', title: 'Safety', items: blockItems }, test] };
  }

  async change(_page: string, id: string, value: unknown) {
    if (id !== 'browser.blocklist') return;
    const list = String(value ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await this.d.bridge.call('blocklist.set', { list }, 150_000);
    } catch (e) {
      throw new Error(e instanceof BrowserError ? e.message : String(e));
    }
  }

  async action(_page: string, id: string): Promise<string | void> {
    switch (id) {
      case 'browser.install': {
        const dir = installExtensionFiles(this.d.extensionDir, INSTALL_DIR);
        this.d.openFolder(dir);
        this.d.log(`[browser] extension files copied to ${dir}`);
        return `Copied to ${tilde(dir)}. In Chrome: chrome://extensions → Developer mode → Load unpacked → pick that folder (or Reload it there after an update).`;
      }
      case 'browser.copyPath':
        this.d.copy(INSTALL_DIR);
        return 'Path copied';
      case 'browser.register': {
        const r = register({ binPath: this.d.binPath });
        this.d.log(`[browser] native host registered: ${r.written.join(', ')}`);
        return `Registered for ${r.browsers.join(', ')}. Restart the browser if the extension still says it is not registered.`;
      }
      case 'browser.unregister': {
        const removed = unregister();
        return removed.length ? `Removed from ${removed.length} browser${removed.length === 1 ? '' : 's'}` : 'Nothing was registered';
      }
      case 'browser.test': {
        const t = Date.now();
        const r = await this.d.bridge.call<{ version: string }>('ping', {}, 5000);
        return `The extension ${r.version} answered in ${Date.now() - t} ms`;
      }
      case 'browser.testOpen': {
        const r = await this.d.bridge.call<{ tabId: string }>('tabs.open', { url: 'https://example.com', newTab: true }, 30_000);
        return `Opened example.com in tab ${r.tabId} (AntiGem tab group)`;
      }
      default:
        return;
    }
  }
}
