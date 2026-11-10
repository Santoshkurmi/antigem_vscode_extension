// Custom AntiGem plugins, wired for the extension / dev server: one call registers the plugin MCPs
// (/mcp?extension=<id>) and the Plugin Developer MCP (/extension_developer) on the McpHost, attaches the settings
// pages and `/plu:` to the host, and feeds the "Custom Plugin MCP" preset.
import type { AppHost } from '../host';
import { setPresetPlugins } from '../mcp/presets';
import type { BrowserProvider } from './browser';
import { developerMcp } from './developer';
import { PluginService, type PluginServiceOptions } from './service';
import { pluginHooks } from './settings';
import { pluginServerName } from './types';

export type { BrowserProvider, BrowserTab, CdpSession } from './browser';
export { PluginService } from './service';
/** Phase 4 wiring: `plugins.setBrowser(chromeExtensionBrowser(browserBridge))` where the BrowserBridge is created. */
export { chromeExtensionBrowser, type BrowserLink } from './chromeBrowser';

export interface Plugins {
  service: PluginService;
  /** The MCP port is ours (or not): only the owner runs workers and checks updates. */
  setLeader(leader: boolean): void;
  /** The browser the plugins' chrome.* APIs use (the AntiGem Chrome extension client). */
  setBrowser(provider: BrowserProvider): void;
}

export function setupPlugins(host: AppHost, opts: PluginServiceOptions): Plugins {
  const service = new PluginService(opts);
  opts.mcp.register(service.pluginMcp());
  opts.mcp.register(developerMcp(service));
  host.attachPlugins(pluginHooks(service));
  setPresetPlugins(() =>
    service
      .plugins()
      .filter((p) => p.isEnabled && (p.toolCount > 0 || p.skillCount > 0))
      .map((p) => ({ id: p.id, name: p.name, folderName: p.folderName, toolCount: p.toolCount, skillCount: p.skillCount, serverName: pluginServerName(p.id) })),
  );
  service.start();
  return {
    service,
    setLeader: (l) => service.setLeader(l),
    setBrowser: (b) => service.setBrowser(b),
  };
}
