// VS Code glue: a webview in the activity bar (the whole app, like the phone) and chats in editor tabs, plus the
// editor integration (selection chip, add file / selection commands, drag & drop, terminal, diffs).
// All agent work happens in core/ (shared with the dev server); this file only maps VS Code APIs onto it.
import * as vscode from 'vscode';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { AppHost, type Platform, type ViewPort } from './core/host';
import { agentFlags, BridgeManager, cliPathArgs } from './core/bridge/BridgeManager';
import { McpHost } from './core/mcp/server';
import { NotesStore, notesMcp } from './core/mcp/notes';
import { themeMcp } from './core/mcp/theme';
import { setPresetEnv } from './core/mcp/presets';
import { JarvisEngine } from './core/jarvis/engine';
import { jarvisMcp } from './core/jarvis/mcp';
import { BrowserBridge } from './core/browser/bridge';
import { browserMcp } from './core/browser/mcp';
import { BrowserSettings } from './core/browser/settings';
import { chromeExtensionBrowser, setupPlugins } from './core/plugins';
import { AgyBackend } from './core/agy/AgyBackend';
import { CodexBackend } from './core/codex/CodexBackend';
import { ClaudeBackend } from './core/claude/ClaudeBackend';
import { OpenCodeBackend } from './core/opencode/OpenCodeBackend';
import { PreviewServer } from './core/preview/server';
import type { AgentKind, ChatAttachment } from '../shared/model';
import type { EditorContextView, FileSuggestion, HostToView, ViewToHost } from '../shared/protocol';

let host: AppHost | undefined;
let sidebarViewId: string | undefined;
/** Interactive Apps, local videos and YouTube embeds play from this local server (webview CSP: frame-src, media-src). */
const preview = new PreviewServer();
let previewReady: Promise<void> | null = null;
/** Chats open in editor tabs (the drawer's ⏻ closes them). */
const chatPanels = new Set<vscode.WebviewPanel>();
/** The drawer's ⏻ closed AntiGem: opening its view again starts it (like opening the app again). */
let closedByPower = false;

/** Hides the AntiGem view: closes the side bar it is shown in. */
async function hideAntiGemView() {
  const wait = () => new Promise((r) => setTimeout(r, 250));
  if (!sidebarView?.visible) return;
  // the view lives in the primary side bar unless the user moved it
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await wait();
  if (!sidebarView?.visible) return;
  // it is in the secondary side bar (or the panel): give the primary side bar back and close that one instead
  await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await wait();
  if (sidebarView?.visible) await vscode.commands.executeCommand('workbench.action.closePanel');
}
let sidebarView: vscode.WebviewView | undefined;

const MAX_SELECTION = 40_000;
const EXCLUDE = '**/{node_modules,.git,dist,build,out,.next,.venv,__pycache__,target}/**';

/** The UI's own page (dist/webview/index.html, with its splash screen), made webview-safe: CSP, base URL, nonce. */
function webviewHtml(webview: vscode.Webview, extUri: vscode.Uri): string {
  const dist = vscode.Uri.joinPath(extUri, 'dist', 'webview');
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob: https:`,
    `media-src ${webview.cspSource} data: blob: https:${preview.port ? ` ${preview.origin()}` : ''}`,
    ...(preview.port ? [`frame-src ${preview.origin()}`] : []),
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
  ].join('; ');
  const base = `${webview.asWebviewUri(dist).toString()}/`;
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}"><base href="${base}">`;
  try {
    let html = fs.readFileSync(path.join(dist.fsPath, 'index.html'), 'utf8');
    html = html.replace(/<head>/i, `<head>${head}`);
    // module scripts load through the base URL; webview resources are not CORS requests
    html = html.replace(/\s+crossorigin(="[^"]*")?/g, '');
    html = html.replace(/<script\b/g, `<script nonce="${nonce}"`);
    return html;
  } catch {
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8">${head}<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="index.css"><title>AntiGem</title></head><body><div id="root"></div><script type="module" nonce="${nonce}" src="index.js"></script></body></html>`;
  }
}

function connectWebview(
  webview: vscode.Webview,
  kind: ViewPort['kind'],
  initialConversationId: string | null,
  disposables: vscode.Disposable[],
  onTitle?: (title: string) => void,
): string {
  const id = host!.attachView({ kind, initialConversationId, onTitle, post: (m) => void webview.postMessage(m) });
  disposables.push(webview.onDidReceiveMessage((m: ViewToHost) => void host?.handle(id, m)));
  return id;
}

function openChatPanel(context: vscode.ExtensionContext, conversationId: string | null) {
  const panel = vscode.window.createWebviewPanel('antigem.chatPanel', conversationId ? 'AntiGem Chat' : 'New Chat', vscode.ViewColumn.Beside, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
  chatPanels.add(panel);
  const disposables: vscode.Disposable[] = [];
  void (previewReady ?? Promise.resolve()).then(() => {
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri);
  });
  const id = connectWebview(panel.webview, 'panel', conversationId, disposables, (t) => {
    panel.title = t.length > 40 ? `${t.slice(0, 40)}…` : t;
  });
  panel.onDidDispose(() => {
    chatPanels.delete(panel);
    host?.detachView(id);
    disposables.forEach((d) => d.dispose());
  });
}

/** The active text editor as the composer's offer chip (file, or the selected lines). */
function editorContext(ed: vscode.TextEditor | undefined): EditorContextView | null {
  if (!ed || ed.document.uri.scheme !== 'file') return null;
  const doc = ed.document;
  const sel = ed.selection;
  let selection: EditorContextView['selection'] = null;
  if (!sel.isEmpty) {
    // a selection that ends at column 0 of the next line covers only the lines above it
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    const text = doc.getText(sel);
    selection = { startLine: sel.start.line + 1, endLine, text: text.length > MAX_SELECTION ? text.slice(0, MAX_SELECTION) : text };
  }
  return { path: doc.uri.fsPath, relativePath: vscode.workspace.asRelativePath(doc.uri), name: path.basename(doc.uri.fsPath), languageId: doc.languageId, selection };
}

function selectionChip(ctx: EditorContextView): ChatAttachment | null {
  if (!ctx.selection) return null;
  const { startLine: a, endLine: b, text } = ctx.selection;
  return {
    id: `sel_${Date.now()}`,
    name: `${ctx.name}:${a === b ? a : `${a}-${b}`}`,
    path: ctx.path,
    isImage: false,
    isAudio: false,
    size: text.length,
    reference: true,
    kind: 'selection',
    lineStart: a,
    lineEnd: b,
    selectionText: text,
    languageId: ctx.languageId,
  };
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('AntiGem');
  const log = (line: string) => output.appendLine(`${new Date().toISOString().slice(11, 19)} ${line}`);
  const cfg = () => vscode.workspace.getConfiguration('antigem');
  const folders = () => vscode.workspace.workspaceFolders ?? [];
  const homeDir = () => folders()[0]?.uri.fsPath ?? os.homedir();

  const kv = { get: <T,>(k: string) => context.globalState.get<T>(k), set: (k: string, v: unknown) => void context.globalState.update(k, v) };

  const bridge = new BridgeManager({
    binPath: path.join(context.extensionPath, 'bin', `antigem-bridge-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`),
    port: cfg().get<number>('bridgePort', 1244),
    hubPort: cfg().get<number>('hubPort', 1245),
    workspaceDir: homeDir(),
    extraArgs: () => cliPathArgs(kv.get('cli.paths')),
    agentFlags: () => agentFlags(kv.get<string[]>('agents.enabled')),
    launchedFlags: { get: () => kv.get<string>('bridge.agentFlags'), set: (f) => kv.set('bridge.agentFlags', f) },
    agyDataDir: () => kv.get<string>('agy.dataDir') ?? 'antigravity-ide',
    logFile: path.join(context.globalStorageUri.fsPath, 'bridge.log'),
    log,
  });

  /** Delivers a message to the chat the user works in (last used view; else the sidebar, opened if needed). */
  const deliver = async (msg: HostToView) => {
    let id = host?.activeViewId() ?? null;
    if (!id) {
      await vscode.commands.executeCommand('antigem.chat.focus');
      for (let i = 0; i < 20 && !sidebarViewId; i++) await new Promise((r) => setTimeout(r, 100));
      id = sidebarViewId ?? null;
    } else if (id === sidebarViewId) sidebarView?.show?.(true);
    if (id) host?.postTo(id, msg);
  };

  let terminal: vscode.Terminal | undefined;

  const platform: Platform = {
    workspaceFolders: () => folders().map((f) => ({ name: f.name, uri: f.uri.toString(), path: f.uri.fsPath })),
    defaultAgent: () => cfg().get<AgentKind>('defaultAgent', 'AGY'),
    openFile: (p, line) => {
      const file = p.startsWith('file://') ? vscode.Uri.parse(p) : vscode.Uri.file(path.isAbsolute(p) ? p : path.join(homeDir(), p));
      const opts: vscode.TextDocumentShowOptions = line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : {};
      void vscode.window.showTextDocument(file, opts).then(undefined, () => vscode.commands.executeCommand('vscode.open', file));
    },
    openUrl: (u) => void vscode.env.openExternal(vscode.Uri.parse(u)),
    copy: (t) => void vscode.env.clipboard.writeText(t),
    pickAttachments: async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, openLabel: 'Attach' });
      return host?.attachmentsForPaths((picked ?? []).map((u) => u.fsPath)) ?? [];
    },
    searchFiles: async (q) => {
      // open editors first, then workspace files and folders matching the query (fuzzy on the path)
      const query = q.trim().toLowerCase();
      const fuzzy = (s: string) => {
        if (!query) return true;
        let i = 0;
        const t = s.toLowerCase();
        for (const ch of query) {
          i = t.indexOf(ch, i);
          if (i < 0) return false;
          i++;
        }
        return true;
      };
      const out: FileSuggestion[] = [];
      const seen = new Set<string>();
      for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
        const uri = tab.input instanceof vscode.TabInputText ? tab.input.uri : null;
        if (!uri || uri.scheme !== 'file' || seen.has(uri.fsPath)) continue;
        const rel = vscode.workspace.asRelativePath(uri);
        if (!fuzzy(rel)) continue;
        seen.add(uri.fsPath);
        out.push({ path: uri.fsPath, relativePath: rel, kind: 'file', isOpen: true });
      }
      const glob = query ? `**/*${query.replace(/[{}[\]*?/\\]/g, '').split('').join('*')}*` : '**/*';
      const uris = await vscode.workspace.findFiles(glob, EXCLUDE, 80);
      const dirs = new Set<string>();
      for (const u of uris) {
        if (!seen.has(u.fsPath)) {
          seen.add(u.fsPath);
          out.push({ path: u.fsPath, relativePath: vscode.workspace.asRelativePath(u), kind: 'file' });
        }
        // folders on the way whose path matches
        let d = path.dirname(u.fsPath);
        const root = vscode.workspace.getWorkspaceFolder(u)?.uri.fsPath;
        while (root && d.startsWith(root) && d !== root) {
          if (!dirs.has(d)) {
            dirs.add(d);
            const rel = vscode.workspace.asRelativePath(vscode.Uri.file(d));
            if (query && fuzzy(rel) && path.basename(d).toLowerCase().includes(query.split('/').pop() ?? query))
              out.push({ path: d, relativePath: `${rel}/`, kind: 'folder' });
          }
          d = path.dirname(d);
        }
      }
      const score = (f: FileSuggestion) => (f.isOpen ? 0 : 1) * 1000 + (path.basename(f.path).toLowerCase().startsWith(query) ? 0 : 100) + f.relativePath.length / 100;
      return out.sort((a, b) => score(a) - score(b)).slice(0, 60);
    },
    openInEditor: (id) => openChatPanel(context, id),
    confirm: async (m, action = 'Delete') => (await vscode.window.showWarningMessage(m, { modal: true }, action)) === action,
    prompt: (m, v) => Promise.resolve(vscode.window.showInputBox({ prompt: m, value: v })),
    powerOff: async () => {
      await bridge.powerOff();
      // like closing the app: its chats in editor tabs and its view close too; opening AntiGem again starts it
      closedByPower = true;
      for (const p of [...chatPanels]) p.dispose();
      await hideAntiGemView();
    },
    powerOn: () => bridge.resume(),
    isOff: () => bridge.suspended,
    restartBridge: async () => {
      bridge.resume();
      await bridge.shutdown();
      await new Promise((r) => setTimeout(r, 800));
      await bridge.ensureRunning();
    },
    applyAgents: async (firstChoice) => {
      if (bridge.state !== 'running' || !bridge.agentFlagsChanged()) return true;
      if (
        !firstChoice &&
        (await vscode.window.showWarningMessage(
          'Restart the AntiGem bridge to apply the agents? Running chats stop in every VS Code window.',
          { modal: true },
          'Restart bridge',
        )) !== 'Restart bridge'
      )
        return false;
      log('[bridge] restarting for the enabled agents');
      bridge.resume();
      await bridge.shutdown();
      await new Promise((r) => setTimeout(r, 800));
      await bridge.ensureRunning();
      return true;
    },
    showLogs: () => output.show(),
    bridgeInfo: () => ({ port: bridge.opts.port, hubPort: bridge.opts.hubPort, logFile: bridge.opts.logFile }),
    saveCopy: async (p) => {
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(homeDir(), path.basename(p))) });
      if (target) {
        await vscode.workspace.fs.copy(vscode.Uri.file(p), target, { overwrite: true });
        void vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`);
      }
    },
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
    saveText: async (name, content) => {
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(homeDir(), name)) });
      if (target) {
        await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
        const open = await vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`, 'Open');
        if (open) void vscode.commands.executeCommand('vscode.open', target);
      }
    },
    runInTerminal: (command, cwd) => {
      if (!terminal || terminal.exitStatus !== undefined) terminal = vscode.window.createTerminal({ name: 'AntiGem', cwd: cwd || homeDir() });
      terminal.show(true);
      terminal.sendText(command, false);
    },
    openText: async (title, content, language) => {
      const doc = await vscode.workspace.openTextDocument({ content, language: language || (/^(diff|---|\+\+\+|@@)/m.test(content) ? 'diff' : 'plaintext') });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
      void title;
    },
    revealRange: (p, a, b) => {
      void vscode.window.showTextDocument(vscode.Uri.file(p), { selection: new vscode.Range(Math.max(0, a - 1), 0, Math.max(0, b - 1), Number.MAX_SAFE_INTEGER) });
    },
    pickFile: async (o) => {
      const r = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: o.title, filters: o.filters, openLabel: 'Choose' });
      return r?.[0]?.fsPath ?? null;
    },
    choose: async (m, options) => {
      const [first, ...rest] = m.split('\n');
      return vscode.window.showInformationMessage(first, { modal: true, detail: rest.join('\n') || undefined }, ...options);
    },
    notify: (m, action) => {
      void vscode.window.showInformationMessage(m, ...(action ? [action.label] : [])).then((picked) => {
        if (picked && action) {
          void vscode.commands.executeCommand('antigem.chat.focus');
          action.run();
        }
      });
    },
    pickFolder: async () => {
      const r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use this folder' });
      return r?.[0]?.fsPath ?? null;
    },
    savedProjects: () => bridge.json<{ name: string; path: string }[]>('/api/projects'),
    saveProject: async (p) => {
      await bridge.json('/api/projects/add', { method: 'POST', body: JSON.stringify({ path: p }), headers: { 'content-type': 'application/json' } });
    },
    forgetProject: async (p) => {
      await bridge.json('/api/projects/remove', { method: 'POST', body: JSON.stringify({ path: p }), headers: { 'content-type': 'application/json' } });
    },
  };

  // the preview server's address as the webview reaches it (VS Code forwards the port when this runs remotely)
  preview.log = log;
  previewReady = (async () => {
    try {
      // the same port as last time when it is free: Interactive Apps keep their localStorage
      const port = await preview.start(kv.get<number>('preview.port') ?? 1247);
      kv.set('preview.port', port);
      const ext = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${preview.port}`));
      preview.base = ext.toString(true).replace(/\/$/, '');
    } catch (e) {
      log(`[preview] not available: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  const opts = { openUrl: platform.openUrl, openFile: platform.openFile };
  host = new AppHost(
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
  void previewReady.then(() => {
    if (host && preview.port) host.preview = preview;
  });

  // ---- built-in MCP servers (notes, theme…) — the app's local bridge server, one path per server
  let deviceId = kv.get<string>('mcp.deviceId');
  if (!deviceId) {
    deviceId = randomBytes(16).toString('hex');
    kv.set('mcp.deviceId', deviceId);
  }
  const mcp = new McpHost({ port: cfg().get<number>('mcpPort', 1246), deviceId, log });
  const notes = new NotesStore();
  host.attachNotes(notes);
  mcp.register(notesMcp(notes));
  mcp.register(themeMcp({ get: () => host!.getUiPrefs(), set: (p) => host!.patchUiPrefs(p) }));
  // Jarvis (the command center): the engine runs its loops only in the process that serves the MCP port
  const jarvis = new JarvisEngine({ host: host.jarvisApi(), store: kv, log, bridge, mcp });
  host.attachJarvis(jarvis);
  mcp.register(jarvisMcp(jarvis));
  // custom AntiGem plugins: /mcp?extension=<id>, /extension_developer, settings, `/plu:` (workers run in the port owner)
  const plugins = setupPlugins(host, { bridge, store: kv, log, mcp, platform });
  // the AntiGem Chrome extension (native messaging -> per-user socket, served by the MCP port owner): /browser + Settings → Browser
  const browserBridge = new BrowserBridge({ log });
  // plugins' chrome.* APIs act on Chrome through the same extension link
  plugins.setBrowser(chromeExtensionBrowser(browserBridge));
  mcp.register(browserMcp(browserBridge, { workspace: homeDir }));
  host.attachBrowser(
    new BrowserSettings({
      bridge: browserBridge,
      binPath: bridge.opts.binPath,
      extensionDir: path.join(context.extensionPath, 'dist', 'chrome-extension'),
      openFolder: (p) => void vscode.env.openExternal(vscode.Uri.file(p)),
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

  // ---- editor → composer: the active file / selection, debounced
  let ctxTimer: NodeJS.Timeout | undefined;
  const pushContext = () => {
    if (ctxTimer) clearTimeout(ctxTimer);
    ctxTimer = setTimeout(() => host?.setEditorContext(editorContext(vscode.window.activeTextEditor)), 150);
  };
  pushContext();

  /** Explorer / editor-tab "Add to AntiGem Chat": files and folders as chips. */
  const addPaths = async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const list = (uris?.length ? uris : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : []).filter((u) => u.scheme === 'file');
    if (!list.length) return;
    const atts = host?.attachmentsForPaths(list.map((u) => u.fsPath)) ?? [];
    if (atts.length) await deliver({ type: 'addAttachments', attachments: atts });
  };

  /** Editor "Add Selection to AntiGem Chat" (no selection = the whole file as a chip). */
  const addSelection = async () => {
    const ctx = editorContext(vscode.window.activeTextEditor);
    if (!ctx) return;
    const chip = selectionChip(ctx);
    if (chip) await deliver({ type: 'addAttachments', attachments: [chip] });
    else await addPaths(vscode.Uri.file(ctx.path));
  };

  context.subscriptions.push(
    output,
    vscode.window.onDidChangeActiveTextEditor(pushContext),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) pushContext();
    }),
    vscode.window.registerWebviewViewProvider(
      'antigem.chat',
      {
        async resolveWebviewView(view) {
          sidebarView = view;
          view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
          };
          await previewReady;
          view.webview.html = webviewHtml(view.webview, context.extensionUri);
          const disposables: vscode.Disposable[] = [];
          const id = connectWebview(view.webview, 'sidebar', null, disposables);
          sidebarViewId = id;
          disposables.push(
            view.onDidChangeVisibility(() => {
              // opened again after the drawer's ⏻: start the bridge and the agents again
              if (view.visible && closedByPower) {
                closedByPower = false;
                host?.reconnect();
              }
            }),
          );
          view.onDidDispose(() => {
            host?.detachView(id);
            disposables.forEach((d) => d.dispose());
            if (sidebarViewId === id) sidebarViewId = undefined;
            sidebarView = undefined;
          });
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand('antigem.newChat', () => {
      if (sidebarViewId) host?.newChat(sidebarViewId);
      else void vscode.commands.executeCommand('antigem.chat.focus');
    }),
    vscode.commands.registerCommand('antigem.openInEditor', () => {
      openChatPanel(context, sidebarViewId ? (host?.viewConversation(sidebarViewId) ?? null) : null);
    }),
    vscode.commands.registerCommand('antigem.focus', async () => {
      await deliver({ type: 'focusComposer' });
    }),
    vscode.commands.registerCommand('antigem.addSelection', addSelection),
    vscode.commands.registerCommand('antigem.sendSelection', addSelection),
    vscode.commands.registerCommand('antigem.addFile', (uri?: vscode.Uri, uris?: vscode.Uri[]) => addPaths(uri, uris)),
    vscode.commands.registerCommand('antigem.restartBridge', async () => {
      await bridge.shutdown();
      log('[bridge] restarting');
      await bridge.ensureRunning().catch((e) => log(`[bridge] ${e instanceof Error ? e.message : String(e)}`));
    }),
    vscode.commands.registerCommand('antigem.showLogs', () => output.show()),
    { dispose: () => mcp.stop() },
    { dispose: () => preview.stop() },
    { dispose: () => browserBridge.stop() },
    { dispose: () => host?.dispose() },
  );
  log('[antigem] activated');
}

export function deactivate() {
  host?.dispose();
  host = undefined;
}
