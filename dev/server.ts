// Dev server: runs the extension's host-side code (bridge + agent backends) and serves views over a WebSocket, so the
// Solid UI can run in a normal browser tab (npm run dev:webview → http://127.0.0.1:5173).
//   node dist/dev-server.js [workspaceDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { AppHost, type Platform } from '../src/core/host';
import { BridgeManager, cliPathArgs } from '../src/core/bridge/BridgeManager';
import { AgyBackend } from '../src/core/agy/AgyBackend';
import { CodexBackend } from '../src/core/codex/CodexBackend';
import { ClaudeBackend } from '../src/core/claude/ClaudeBackend';
import { OpenCodeBackend } from '../src/core/opencode/OpenCodeBackend';
import type { KeyValueStore } from '../src/core/types';

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
  restartBridge: async () => {
    await bridge.shutdown();
    await new Promise((r) => setTimeout(r, 800));
    await bridge.ensureRunning();
  },
  bridgeInfo: () => ({ port: bridge.opts.port, hubPort: bridge.opts.hubPort, logFile: bridge.opts.logFile }),
  pickFolder: async () => null,
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
const port = Number(process.env.ANTIGEM_DEV_PORT ?? 5199);
const wss = new WebSocketServer({ host: '127.0.0.1', port });
wss.on('connection', (ws) => {
  const id = host.attachView({ kind: 'browser', post: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)) });
  ws.on('message', (data) => void host.handle(id, JSON.parse(String(data))));
  ws.on('close', () => host.detachView(id));
});
log(`[dev] host on ws://127.0.0.1:${port}, workspace ${workspace}`);
process.on('SIGINT', () => {
  host.dispose();
  process.exit(0);
});
