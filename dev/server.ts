// Dev server: runs the extension's host-side code (bridge + agent backends) and serves views over a WebSocket, so the
// Solid UI can run in a normal browser tab (npm run dev:webview → http://127.0.0.1:5173).
//   node dist/dev-server.js [workspaceDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { AppHost, type Platform } from '../src/core/host';
import { BridgeManager, cliPathArgs } from '../src/core/bridge/BridgeManager';
import { McpHost } from '../src/core/mcp/server';
import { NotesStore, notesMcp } from '../src/core/mcp/notes';
import { themeMcp } from '../src/core/mcp/theme';
import { setPresetEnv } from '../src/core/mcp/presets';
import { JarvisEngine } from '../src/core/jarvis/engine';
import { jarvisMcp } from '../src/core/jarvis/mcp';
import { BrowserBridge } from '../src/core/browser/bridge';
import { browserMcp } from '../src/core/browser/mcp';
import { BrowserSettings } from '../src/core/browser/settings';
import { chromeExtensionBrowser, setupPlugins } from '../src/core/plugins';
import { randomBytes } from 'node:crypto';
import { AgyBackend } from '../src/core/agy/AgyBackend';
import { CodexBackend } from '../src/core/codex/CodexBackend';
import { ClaudeBackend } from '../src/core/claude/ClaudeBackend';
import { OpenCodeBackend } from '../src/core/opencode/OpenCodeBackend';
import type { KeyValueStore } from '../src/core/types';
import { PreviewServer } from '../src/core/preview/server';

const ROOT = path.resolve(__dirname, '..');
const workspace = path.resolve(process.argv[2] ?? process.cwd());
const stateDir = path.join(os.homedir(), '.antigem-vscode-dev');
fs.mkdirSync(stateDir, { recursive: true });
const stateFile = path.join(stateDir, 'state.json');
const log = (l: string) => console.log(new Date().toISOString().slice(11, 19), l);

const kv: KeyValueStore = {
  get: (k) => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'))[k];
    } catch {
      return undefined;
    }
  },
  set: (k, v) => {
    let all: Record<string, unknown> = {};
    try {
      all = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      /* new */
    }
    all[k] = v;
    fs.writeFileSync(stateFile, JSON.stringify(all, null, 2));
  },
};

const bridge = new BridgeManager({
  binPath: path.join(ROOT, 'bin', `antigem-bridge-${process.platform}-${process.arch}`),
  port: Number(process.env.ANTIGEM_BRIDGE_PORT ?? 1244),
  hubPort: Number(process.env.ANTIGEM_HUB_PORT ?? 1245),
  workspaceDir: workspace,
  extraArgs: () => cliPathArgs(kv.get('cli.paths')),
  agyDataDir: () => kv.get<string>('agy.dataDir') ?? 'antigravity-ide',
  logFile: path.join(stateDir, 'bridge.log'),
  log,
});

function walk(dir: string, out: string[], depth = 0) {
  if (depth > 6 || out.length > 5000) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else out.push(p);
  }
}

const platform: Platform = {
  workspaceFolders: () => [{ name: path.basename(workspace), uri: `file://${workspace}`, path: workspace }],
  defaultAgent: () => 'AGY',
  openFile: (p, line) => log(`[dev] openFile ${p}${line ? `:${line}` : ''}`),
  openUrl: (u) => log(`[dev] openUrl ${u}`),
  copy: (t) => log(`[dev] copy ${t.slice(0, 60)}`),
  pickAttachments: async () => [],
  searchFiles: async (q) => {
    const all: string[] = [];
    walk(workspace, all);
    const ql = q.toLowerCase();
    return all
      .map((p) => ({ path: p, relativePath: path.relative(workspace, p), kind: 'file' as const }))
      .filter((f) => f.relativePath.toLowerCase().includes(ql))
      .slice(0, 50);
  },
  openInEditor: (id) => log(`[dev] openInEditor ${id}`),
  confirm: async () => true,
  prompt: async (_m, v) => v,
  powerOff: async () => {
    await bridge.powerOff();
  },
  powerOn: () => bridge.resume(),
  isOff: () => bridge.suspended,
  restartBridge: async () => {
    bridge.resume();
    await bridge.shutdown();
    await new Promise((r) => setTimeout(r, 800));
    await bridge.ensureRunning();
  },
  bridgeInfo: () => ({ port: bridge.opts.port, hubPort: bridge.opts.hubPort, logFile: bridge.opts.logFile }),
  pickFolder: async () => null,
  // dev: the file a test wants picked (ANTIGEM_DEV_PICK_FILE: the path, or a .txt holding it), the first button of a
  // choice, notifications in the log
  pickFile: async () => {
    const f = process.env.ANTIGEM_DEV_PICK_FILE;
    if (!f) return null;
    const picked = f.endsWith('.txt') ? (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '') : f;
    log(`[dev] pickFile → ${picked || '(cancelled)'}`);
    return picked || null;
  },
  choose: async (m, options) => {
    log(`[dev] choose "${m.split('\n')[0]}" → ${options[0]}`);
    return options[0];
  },
  notify: (m) => log(`[dev] notify ${m}`),
  cliStatus: async () => {
    const get = (p: string) => bridge.json<any>(p).catch(() => null);
    const [agy, claude, codex, opencode] = await Promise.all([get('/api/agy/cli'), get('/api/claude/status'), get('/api/codex/status'), get('/api/opencode/status')]);
    const v = (s: unknown) => String(s ?? '').replace(/\s*\(Claude Code\)$/, '');
    return {
      AGY: { installed: !!agy?.installed, path: agy?.path ?? '', version: v(agy?.version) },
      CLAUDE: { installed: !!claude?.installed, path: claude?.bin_path ?? '', version: v(claude?.version) },
      CODEX: { installed: !!codex?.installed, path: codex?.binary ?? '', version: v(codex?.version) },
      OPENCODE: { installed: !!opencode?.installed, path: opencode?.binary ?? '', version: v(opencode?.version) },
    };
  },
  saveCopy: async (p) => log(`[dev] saveCopy ${p}`),
  saveText: async (name, content) => {
    const out = path.join(stateDir, name);
    fs.writeFileSync(out, content);
    log(`[dev] saved ${out} (${content.length} chars)`);
  },
  runInTerminal: (cmd, cwd) => log(`[dev] runInTerminal (${cwd ?? workspace}): ${cmd}`),
  openText: (title, content) => log(`[dev] openText ${title} (${content.length} chars)`),
  revealRange: (p, a, b) => log(`[dev] revealRange ${p}:${a}-${b}`),
  savedProjects: () => bridge.json<{ name: string; path: string }[]>('/api/projects'),
  saveProject: async (p) => {
    await bridge.json('/api/projects/add', { method: 'POST', body: JSON.stringify({ path: p }), headers: { 'content-type': 'application/json' } });
  },
  forgetProject: async (p) => {
    await bridge.json('/api/projects/remove', { method: 'POST', body: JSON.stringify({ path: p }), headers: { 'content-type': 'application/json' } });
  },
};

const opts = { openUrl: platform.openUrl, openFile: platform.openFile };
const host = new AppHost(
  {
    AGY: new AgyBackend(bridge, kv, log, opts),
    CLAUDE: new ClaudeBackend(bridge, kv, log, opts),
    CODEX: new CodexBackend(bridge, kv, log, opts),
    OPENCODE: new OpenCodeBackend(bridge, kv, log, opts),
  },
  platform,
  log,
  kv,
);
// Interactive Apps, local videos and YouTube embeds (the browser tab has no CSP: any port works)
const preview = new PreviewServer(log);
void preview.start().then(() => (host.preview = preview));
// built-in MCP servers (same as the extension; the first process on the port serves them)
let deviceId = kv.get<string>('mcp.deviceId');
if (!deviceId) {
  deviceId = randomBytes(16).toString('hex');
  kv.set('mcp.deviceId', deviceId);
}
const mcp = new McpHost({ port: Number(process.env.ANTIGEM_MCP_PORT ?? 1246), deviceId, log });
const notes = new NotesStore();
host.attachNotes(notes);
mcp.register(notesMcp(notes));
mcp.register(themeMcp({ get: () => host.getUiPrefs(), set: (p) => host.patchUiPrefs(p) }));
// Jarvis (the command center): the engine runs its loops only in the process that serves the MCP port
const jarvis = new JarvisEngine({ host: host.jarvisApi(), store: kv, log, bridge, mcp });
host.attachJarvis(jarvis);
mcp.register(jarvisMcp(jarvis));
const plugins = setupPlugins(host, { bridge, store: kv, log, mcp, platform });
// the AntiGem Chrome extension link (socket path: ANTIGEM_BROWSER_SOCKET, else the per-user default)
const browserBridge = new BrowserBridge({ log });
// plugins' chrome.* APIs act on Chrome through the same extension link
plugins.setBrowser(chromeExtensionBrowser(browserBridge));
mcp.register(browserMcp(browserBridge, { workspace: () => workspace }));
host.attachBrowser(
  new BrowserSettings({
    bridge: browserBridge,
    binPath: bridge.opts.binPath,
    // the Chrome extension's own repository next to this one (edits show without a build)
    extensionDir: process.env.ANTIGEM_CHROME_EXTENSION ?? path.join(ROOT, '..', 'antigem-chrome-extension'),
    openFolder: (p) => log(`[dev] openFolder ${p}`),
    copy: platform.copy,
    log,
    mcpPort: mcp.port,
  }),
);
setPresetEnv({ port: mcp.port, deviceId, served: (p) => mcp.serves(p) });
void mcp.start().then((bound) => {
  jarvis.setLeader(bound);
  plugins.setLeader(bound);
  if (bound) void browserBridge.start();
});

const port = Number(process.env.ANTIGEM_DEV_PORT ?? 5199);
const wss = new WebSocketServer({ host: '127.0.0.1', port });
wss.on('connection', (ws) => {
  const id = host.attachView({ kind: 'browser', post: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)) });
  ws.on('message', (data) => void host.handle(id, JSON.parse(String(data))));
  ws.on('close', () => host.detachView(id));
});
log(`[dev] host on ws://127.0.0.1:${port}, workspace ${workspace}`);
process.on('SIGINT', () => {
  browserBridge.stop();
  host.dispose();
  process.exit(0);
});
