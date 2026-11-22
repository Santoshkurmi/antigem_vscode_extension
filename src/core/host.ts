// The host side of every view (VS Code sidebar, editor tabs, or a browser tab in dev): routes view requests to the
// agent backends and sends each view only what changed in the chat it shows.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import type { AgentKind, ChatAttachment, ChatMessage, Conversation } from '../../shared/model';
import type { ChatPatch, ChatSearchHit, EditorContextView, FileSuggestion, HostToView, ProjectView, SettingItem, SettingsPage, SettingsSection, UiPrefs, ViewToHost, WorkspaceFolder } from '../../shared/protocol';
import path from 'node:path';
import { HostSettings } from './settings';
import { ChatNotifier, type ChatAlert } from './notifications';
import { absPath, baseName, expandHome, folderKey, pathToUri, tildePath, uriToPath } from './paths';
import type { NotesStore } from './mcp/notes';
import type { JarvisHooks, JarvisHostApi } from './jarvis/types';
import type { GroupsHooks } from './crew/rooms/types';
import type { BrowserHooks } from './browser/settings';
import type { PluginHooks } from './plugins/types';
import type { MemoryHooks } from './memory/types';
import { selectionBlock } from './text';
import { defaultCliPaths } from './bridge/BridgeManager';
import type { PreviewServer } from './preview/server';
import type { PhoneAccess } from './phone';
import type { AgentBackend, ChatState, KeyValueStore, Logger, SendRequest } from './types';
import { RenderBundle } from './render/bundle';
import { stemAction, stemChange, stemSettingsPage } from './render/settings';
import { EgmManager } from './egm/manager';
import { egmAction, egmChange, egmGuide, egmPage, egmRootItem } from './egm/settings';
import { setupChatRequest, slashFolderOf } from './skills';
import { checkpoints, CheckpointsHost, isCheckpointPage } from './checkpoints';
import type { CrewEngine } from './crew/engine';

/** What the embedding environment (VS Code or the dev server) provides. */
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };

export interface Platform {
  workspaceFolders(): WorkspaceFolder[];
  defaultAgent(): AgentKind;
  openFile(path: string, line?: number): void;
  openUrl(url: string): void;
  copy(text: string): void;
  pickAttachments(): Promise<ChatAttachment[]>;
  searchFiles(query: string): Promise<FileSuggestion[]>;
  /** Save text with a save dialog (chat export). */
  saveText(suggestedName: string, content: string): Promise<void>;
  /** Run a command in a terminal (code block ▶). */
  runInTerminal(command: string, cwd?: string | null): void;
  /** Open text in an editor tab (diffs, long outputs). */
  openText(title: string, content: string, language?: string | null): void;
  /** Two versions side by side in a diff editor: a file on disk or text (left) against text (right, read-only). */
  openDiff?(title: string, left: { path?: string | null; text?: string | null }, right: { text: string; name: string }): void;
  /** Open a file and select a line range. */
  revealRange(path: string, startLine: number, endLine: number): void;
  openInEditor(conversationId: string): void;
  /** A modal yes / no; [action] = the yes button's label (default "Delete"). */
  confirm(message: string, action?: string): Promise<boolean>;
  prompt(message: string, value: string): Promise<string | undefined>;
  /** Stops and starts the bridge again (its hub too). */
  restartBridge(): Promise<void>;
  /** Drawer ⏻: stop the bridge + agents and keep them off; powerOn() allows starting again. */
  powerOff(): Promise<void>;
  powerOn(): void;
  isOff(): boolean;
  /**
   * The enabled agents changed (saved already): restart a running bridge started for other agents. [firstChoice]: the
   * first-run picker (nothing to ask). False = the user kept the old agents.
   */
  applyAgents?(firstChoice: boolean): Promise<boolean>;
  /** Shows the host log (VS Code output channel); absent in dev. */
  showLogs?(): void;
  bridgeInfo(): { port: number; hubPort: number; logFile: string };
  /** Folder chooser (absolute path, or null when cancelled). */
  pickFolder(): Promise<string | null>;
  /** The bridge's saved project list (shared with the AntiGem app). */
  savedProjects(): Promise<{ name: string; path: string }[]>;
  saveProject(path: string): Promise<void>;
  forgetProject(path: string): Promise<void>;
  /** Where the bridge found each agent's CLI (path, version). */
  cliStatus(): Promise<Partial<Record<AgentKind, { installed: boolean; path: string; version: string }>>>;
  /** "Save a copy" of a file the agent produced (artifact download). */
  saveCopy(path: string): Promise<void>;
  /** "Save a copy" of a file on the web: a save dialog, then the download (absent in dev). */
  downloadUrl?(url: string, name: string): Promise<void>;
  /** File chooser (absolute path, or null when cancelled); `filters` = label → extensions. */
  pickFile?(opts: { title?: string; filters?: Record<string, string[]> }): Promise<string | null>;
  /** A modal choice between buttons: the picked label, undefined when cancelled. */
  choose?(message: string, options: string[]): Promise<string | undefined>;
  /** A system notification (VS Code toast), optionally with one action button. */
  notify?(message: string, action?: { label: string; run: () => void }): void;
  /** The Crew's status bar item ("Crew: 2 working · 1 needs you"); null = hide it. Clicking it opens the Crew. */
  crewStatus?(text: string | null, tooltip: string): void;
  /** The VS Code window has the focus (absent = always). */
  windowFocused?(): boolean;
  /** A chat alert as a VS Code pop-up; [open] shows the chat (its "Open" button). */
  chatAlert?(alert: ChatAlert, open: () => void): void;
  /** A chat alert as a desktop notification (a click opens the chat); false when it could not be shown. */
  systemAlert?(alert: ChatAlert): Promise<boolean>;
  /** Why desktop notifications cannot be shown here (null = they can; absent = never). */
  systemAlertUnavailable?(): string | null;
  /** The count on the AntiGem icon (0 = none). */
  setBadge?(count: number, tooltip: string): void;
}

export interface ViewPort {
  kind: 'sidebar' | 'panel' | 'browser';
  post(msg: HostToView): void;
  /** The shown chat's title changed (editor tabs use it as their tab title). */
  onTitle?: (title: string) => void;
  /** Conversation an editor panel opens with. */
  initialConversationId?: string | null;
  /** On screen now (the side bar is open on it / the editor tab is the visible one); absent = always. */
  isVisible?(): boolean;
  /** Brings the view to the front. */
  reveal?(): void;
}

interface ViewState {
  id: string;
  port: ViewPort;
  conversationId: string | null;
  agent: AgentKind;
  unsubscribe: (() => void) | null;
  sent: Map<string, { ref: ChatMessage; json: string }>;
  order: string[];
  meta: Record<string, string>;
  /** Settings page the view shows (null = settings closed). */
  settingsPage: string | null;
}

const META_KEYS = ['conversation', 'isStreaming', 'isLoading', 'error', 'queued', 'approvals', 'question', 'artifacts', 'workingLabel', 'controls', 'notice', 'modelId', 'readOnly'] as const;

export class AppHost {
  private views = new Map<string, ViewState>();
  private unsubs: Array<() => void> = [];
  private settings: HostSettings;
  /** Local server for Interactive Apps, local videos and YouTube embeds (set by the embedder; absent = not shown). */
  preview: PreviewServer | null = null;
  private editorCtx: EditorContextView | null = null;
  /** The view the user interacted with last (VS Code commands deliver chips there). */
  private lastActive: string | null = null;
  /** Tells the user when a chat they sent finishes or needs them (and they are not looking at it). */
  private notifier: ChatNotifier;
  /** Settings → STEM & diagrams (src/core/render): the render bundle, the chat's STEM blocks, what agents are told. */
  private render: RenderBundle;
  /** Settings → Agents → EGM (src/core/egm): install, settings and the `/egm` commands. */
  private egm: EgmManager;
  /** Project checkpoints (src/core/checkpoints): the chats' restore points, the restore sheet, Settings → Project checkpoints. */
  private checkpoints: CheckpointsHost;

  constructor(
    private backends: Partial<Record<AgentKind, AgentBackend>>,
    private platform: Platform,
    private log: Logger,
    private store: KeyValueStore,
  ) {
    this.settings = new HostSettings(store);
    this.render = new RenderBundle(store, log, () => this.preview);
    this.egm = new EgmManager(store, log);
    this.settings.renderContext = () => this.render.promptSection();
    this.settings.egm = this.egm;
    this.checkpoints = new CheckpointsHost(checkpoints, {
      conversations: () => this.rawConversations(),
      openDiff: platform.openDiff && ((t, l, r) => platform.openDiff!(t, l, r)),
      openText: (t, c, l) => platform.openText(t, c, l),
      refreshPages: () => this.refreshPages((p) => p === 'root' || isCheckpointPage(p)),
      log,
    });
    this.render.onChange(() => {
      this.broadcast({ type: 'renderState', state: this.render.view() });
      this.refreshPages((p) => p === 'stem');
    });
    let egmCommands = JSON.stringify(this.egm.slashItems());
    this.egm.onChange(() => {
      this.refreshPages((p) => p === 'egm' || p === 'agents');
      // installed, removed, switched on / off: the `/` lists change
      const now = JSON.stringify(this.egm.slashItems());
      if (now === egmCommands) return;
      egmCommands = now;
      for (const b of this.active()) this.broadcast({ type: 'commands', agent: b.kind, commands: this.commandsFor(b.kind) });
    });
    // once: the default look became "VS Code" (its own theme colors). Saved prefs always carry the mode (any pref
    // change saves them whole), so an install that was on the old default Auto moves to the new default.
    const saved = store.get<Record<string, unknown>>('ui.prefs');
    if (saved && !store.get<boolean>('ui.themeDefaultVscode')) {
      if (saved.theme == null || saved.theme === 'auto') store.set('ui.prefs', { ...saved, theme: 'vscode' });
    }
    store.set('ui.themeDefaultVscode', true);
    this.notifier = new ChatNotifier({
      backend: (k) => this.backendFor(k),
      chatTitle: (id) => this.rawConversations().find((c) => c.id === id)?.title || 'Chat',
      isWatching: (id) => this.isWatching(id),
      windowFocused: () => this.platform.windowFocused?.() ?? true,
      prefs: () => this.settings.notifyPrefs(),
      system: platform.systemAlert && ((a) => (platform.systemAlertUnavailable?.() ? Promise.resolve(false) : platform.systemAlert!(a))),
      inApp: platform.chatAlert && ((a) => platform.chatAlert!(a, () => this.revealChat(a.conversationId))),
      setBadge: platform.setBadge && ((n, tip) => platform.setBadge!(n, tip)),
      log,
    });
    for (const b of Object.values(this.backends)) {
      if (!b) continue;
      this.unsubs.push(
        b.onChange((what) => {
          if (what === 'status') this.broadcast({ type: 'agents', agents: this.agentStatuses() });
          else if (what === 'conversations') this.broadcast({ type: 'conversations', conversations: this.allConversations() });
          else if (what === 'models') this.broadcast({ type: 'models', state: b.models() });
          else if (what === 'commands') this.broadcast({ type: 'commands', agent: b.kind, commands: this.commandsFor(b.kind) });
          else if (what === 'settings') this.refreshSettings();
          else if (what === 'controls') {
            // new-chat screens of this agent show its default controls
            for (const v of this.views.values())
              if (!v.conversationId && v.agent === b.kind) v.port.post({ type: 'chat', conversationId: null, patch: { controls: b.controls?.(null) ?? [] } });
          }
          if (what === 'status' || what === 'models') this.refreshSettings(true);
        }),
      );
      b.setNotifier?.((level, message) => this.broadcast({ type: 'toast', level, message }));
      if (this.isEnabled(b.kind)) b.start();
    }
  }

  /** Starts the bridge again after the drawer's ⏻ (Reconnect, or the view opened again) and retries every agent. */
  reconnect() {
    if (this.platform.isOff()) {
      this.platform.powerOn();
      this.broadcast({ type: 'agents', agents: this.agentStatuses() });
      this.broadcast({ type: 'toast', level: 'info', message: 'Starting AntiGem…' });
    }
    for (const b of this.active()) b.retry();
  }

  /** Sends a message to every view. */
  broadcastAll(msg: HostToView) {
    this.broadcast(msg);
  }

  // ------------------------------------------------------------------ chat notifications

  /** The user has this chat on screen: VS Code focused and a visible view shows it. */
  private isWatching(conversationId: string): boolean {
    if (!(this.platform.windowFocused?.() ?? true)) return false;
    for (const v of this.views.values()) if (v.conversationId === conversationId && (v.port.isVisible?.() ?? true)) return true;
    return false;
  }

  /** Window focus or a view's visibility changed: chats now on screen are read. */
  attentionChanged() {
    this.notifier.seen();
  }

  /** A notification was clicked: show the chat (the view that has it, else the side bar, else an editor tab). */
  revealChat(conversationId: string) {
    if (!conversationId) return;
    const views = [...this.views.values()];
    const showing = views.find((v) => v.conversationId === conversationId && v.port.reveal);
    if (showing) {
      showing.port.reveal!();
    } else {
      const side = views.find((v) => v.port.kind === 'sidebar');
      if (side) {
        this.show(side, conversationId, this.agentOf(conversationId) ?? side.agent);
        side.port.reveal?.();
      } else this.platform.openInEditor(conversationId);
    }
    this.notifier.markRead(conversationId);
  }

  // ------------------------------------------------------------------ shared prefs (theme MCP) and notes

  getUiPrefs(): Record<string, unknown> {
    return this.uiPrefs() as Record<string, unknown>;
  }

  /** Changes shared view prefs and re-themes every view (theme_mcp, settings). */
  patchUiPrefs(patch: Record<string, unknown>) {
    const prefs = { ...this.uiPrefs(), ...patch } as UiPrefs;
    this.store.set('ui.prefs', prefs);
    this.broadcast({ type: 'uiPrefs', prefs });
  }

  private notes: NotesStore | null = null;

  /** The notes store the Notes screen and notes_mcp share; every change reaches open views. */
  attachNotes(store: NotesStore) {
    this.notes = store;
    store.onChange((all) => this.broadcast({ type: 'notes', notes: all }));
  }

  // ------------------------------------------------------------------ Jarvis (src/core/jarvis): hooks both ways

  private jarvis: JarvisHooks | null = null;

  // ------------------------------------------------------------------ AntiGem browser extension (src/core/browser)

  private browser: BrowserHooks | null = null;

  // ------------------------------------------------------------------ Connect phone (src/core/phone)

  private phone: PhoneAccess | null = null;

  /** Settings → Connect phone (page 'phone'): the AntiGem app on a phone uses this PC's agents. */
  attachPhone(p: PhoneAccess) {
    this.phone = p;
    p.onChange(() => {
      for (const v of this.views.values()) if (v.settingsPage === 'root' || v.settingsPage === 'phone') void this.postSettings(v);
    });
  }

  /** Settings → Browser (pages 'browser*'); its status changes refresh the pages that show it. */
  attachBrowser(b: BrowserHooks) {
    this.browser = b;
    b.onChange(() => {
      for (const v of this.views.values()) if (v.settingsPage === 'root' || v.settingsPage?.startsWith('browser')) void this.postSettings(v);
    });
  }

  // ------------------------------------------------------------------ custom AntiGem plugins (src/core/plugins)

  private plugins: PluginHooks | null = null;

  /** Custom plugins: `/plu:` items and expansion, Settings → Custom AntiGem Plugins. */
  attachPlugins(p: PluginHooks) {
    this.plugins = p;
    this.settings.pluginGuide = (id, skill) => p.guide(id, skill);
    p.bind({
      broadcast: (msg) => this.broadcast(msg),
      // only the pages that show plugins (install progress ticks must not rebuild an agent's page)
      refreshSettings: () => {
        for (const v of this.views.values()) if (v.settingsPage === 'root' || v.settingsPage === 'plugins' || v.settingsPage?.startsWith('plugins.')) void this.postSettings(v);
      },
      refreshCommands: () => {
        for (const b of this.active()) this.broadcast({ type: 'commands', agent: b.kind, commands: this.commandsFor(b.kind) });
      },
      openSettings: (page) => {
        const id = this.activeViewId();
        if (id) this.views.get(id)?.port.post({ type: 'jarvisNavigate', screen: 'settings', settingsPage: page });
      },
    });
  }

  // ------------------------------------------------------------------ Agent memory (src/core/memory)

  private memory: MemoryHooks | null = null;

  /** Agent memory: the memory text of a chat's first message, syncing chats, the chips, Settings → Agents → Agent memory. */
  attachMemory(m: MemoryHooks) {
    this.memory = m;
    m.bind({
      backend: (k) => this.backendFor(k),
      allBackends: () => Object.values(this.backends).filter((b): b is AgentBackend => !!b),
      conversations: () => this.rawConversations(),
      isJarvisChat: (id) => this.jarvis?.isJarvisTarget(id, false, false) ?? false,
      isShown: (id) => [...this.views.values()].some((v) => v.conversationId === id),
      broadcast: (msg) => this.broadcast(msg),
      refreshPages: () => this.refreshPages((p) => p === 'agents' || p === 'memory' || p.startsWith('memory.')),
      openText: (title, content, language) => this.platform.openText(title, content, language),
      workspaceFolder: () => this.platform.workspaceFolders()[0]?.path ?? null,
    });
  }

  /** The Jarvis engine: wraps sends to Jarvis chats, tags the chat list, owns the 'jarvis' settings pages. */
  attachJarvis(j: JarvisHooks) {
    this.jarvis = j;
    this.broadcast({ type: 'jarvis', state: j.snapshot(), full: true });
    this.broadcast({ type: 'conversations', conversations: this.allConversations() });
  }

  // ------------------------------------------------------------------ Group chats (src/core/groups)

  private groups: GroupsHooks | null = null;

  /** Group chats: the user and AI bots in one room; each bot's hidden chat stays out of the chat list. */
  attachGroups(g: GroupsHooks) {
    this.groups = g;
    const lastView = () => {
      const id = this.activeViewId();
      return id ? (this.views.get(id) ?? null) : null;
    };
    g.bind({
      backend: (k) => this.backendFor(k),
      enabledKinds: () => this.enabledKinds(),
      conversations: () => this.rawConversations(),
      defaultAgent: () => this.defaultAgent(),
      workspaceFolder: () => this.platform.workspaceFolders()[0]?.path ?? null,
      showChat: (id, agent) => {
        const v = lastView();
        if (!v) return;
        this.show(v, id, agent);
        v.port.post({ type: 'jarvisNavigate', screen: 'chat', conversationId: id, settingsPage: null });
      },
      postActive: (msg) => lastView()?.port.post(msg),
      refreshConversations: () => this.broadcast({ type: 'conversations', conversations: this.allConversations() }),
      pickFolder: () => this.platform.pickFolder(),
      confirm: (m, a) => this.platform.confirm(m, a),
      log: (l) => this.log(`[groups] ${l}`),
      // rooms run on the crew: members are crew bots, each turn is that crew bot's (persona, crew tools, access)
      crew: () => this.crew?.roomApi() ?? null,
    });
  }

  // ------------------------------------------------------------------ Crew (src/core/crew)

  private crew: CrewEngine | null = null;

  /** Shows the Crew screen (status bar click, a crew toast) in the view used last. */
  openCrew() {
    const id = this.activeViewId();
    const v = id ? this.views.get(id) : undefined;
    v?.port.post({ type: 'crewNavigate', botId: null });
  }

  /** Crew: bots, their DMs (normal chats drawn with the bot's face, sent with its setup) and the Crew screen. */
  attachCrew(c: CrewEngine) {
    this.crew = c;
    const lastView = () => {
      const id = this.activeViewId();
      return id ? (this.views.get(id) ?? null) : null;
    };
    c.bind({
      backend: (k) => this.backendFor(k),
      enabledKinds: () => this.enabledKinds(),
      defaultAgent: () => this.defaultAgent(),
      workspaceFolder: () => this.platform.workspaceFolders()[0]?.path ?? null,
      showChat: (id, agent) => {
        const v = lastView();
        if (!v) return;
        this.show(v, id, agent);
        v.port.post({ type: 'jarvisNavigate', screen: 'chat', conversationId: id, settingsPage: null });
      },
      postActive: (msg) => lastView()?.port.post(msg),
      refreshConversations: () => this.broadcast({ type: 'conversations', conversations: this.allConversations() }),
      pickFolder: () => this.platform.pickFolder(),
      confirm: (m, a) => this.platform.confirm(m, a),
      openFile: (p) => this.platform.openFile(p),
      openUrl: (u) => this.platform.openUrl(u),
      isRunning: (k, id) => !!this.backendFor(k)?.conversations().find((c) => c.id === id)?.isRunning,
      notify: (text, open) => this.platform.notify?.(text, { label: 'Open', run: open }),
      saveText: (name, content) => this.platform.saveText(name, content),
      status: (st, text) => {
        const tip = st.needsYou ? `${st.needsYou} thing${st.needsYou === 1 ? '' : 's'} in the Crew Inbox` : '';
        this.platform.crewStatus?.(text, text ? `${tip ? `${tip} · ` : ''}Click to open the Crew` : '');
        this.notifier.setCrew(st.needsYou, tip);
      },
      log: (l) => this.log(l),
    });
  }

  /** What the Jarvis engine may use of the host. */
  jarvisApi(): JarvisHostApi {
    const lastView = () => {
      const id = this.activeViewId();
      return id ? (this.views.get(id) ?? null) : null;
    };
    return {
      backend: (k) => this.backendFor(k),
      enabledKinds: () => this.enabledKinds(),
      conversations: () => this.rawConversations(),
      defaultAgent: () => this.defaultAgent(),
      setDefaultAgent: (k) => this.store.set('chat.defaultAgent', k),
      projects: () => this.projects(),
      workspaceFolders: () => this.platform.workspaceFolders(),
      saveProject: (p) => this.platform.saveProject(p),
      screenChat: () => {
        const v = lastView();
        return v ? { conversationId: v.conversationId, agent: v.agent } : null;
      },
      showChat: (id, agent) => {
        const v = lastView();
        if (!v) return;
        this.show(v, id, id ? (agent ?? this.agentOf(id) ?? v.agent) : (agent ?? v.agent));
        if (id) v.port.post({ type: 'jarvisNavigate', screen: 'chat', conversationId: id, settingsPage: null });
      },
      postActive: (msg) => lastView()?.port.post(msg),
      broadcast: (msg) => this.broadcast(msg),
      refreshConversations: () => this.broadcast({ type: 'conversations', conversations: this.allConversations() }),
      refreshSettings: () => this.refreshSettings(),
      expand: (t) => this.settings.expand(t),
      contextEntries: () => this.settings.contextEntries(),
      builtInContext: (h, agent) => this.settings.builtInFor(agent, h),
      uiPrefs: () => this.getUiPrefs(),
      patchUiPrefs: (p) => this.patchUiPrefs(p),
      editorContext: () => this.editorCtx,
      openFile: (p, line) => this.platform.openFile(p, line),
      openUrl: (u) => this.platform.openUrl(u),
      searchFiles: (q) => this.platform.searchFiles(q),
      isOff: () => this.platform.isOff(),
    };
  }

  /** The editor's active file / selection (every view shows it as an offer chip). */
  setEditorContext(ctx: EditorContextView | null) {
    this.editorCtx = ctx;
    this.broadcast({ type: 'editorContext', context: ctx });
  }

  /** The view the user used last, if it is still open. */
  activeViewId(): string | null {
    if (this.lastActive && this.views.has(this.lastActive)) return this.lastActive;
    return this.views.keys().next().value ?? null;
  }

  // ------------------------------------------------------------------ attachments, search, files

  /** A dropped / picked path as a composer chip (images inline when small). */
  private attachmentFor(p: string, i: number): ChatAttachment | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return null;
    }
    const name = path.basename(p) || p;
    if (st.isDirectory()) return { id: `att_${Date.now()}_${i}`, name, path: p, isImage: false, isAudio: false, size: 0, reference: true, kind: 'folder', mimeType: 'inode/directory' };
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = IMAGE_MIME[ext] ?? null;
    const isImage = !!mime && st.size <= 5 * 1024 * 1024;
    return {
      id: `att_${Date.now()}_${i}`,
      name,
      path: p,
      isImage,
      isAudio: false,
      size: st.size,
      mimeType: mime,
      base64: isImage ? fs.readFileSync(p).toString('base64') : null,
      reference: !isImage,
      kind: isImage ? 'image' : 'file',
    };
  }

  attachmentsForPaths(paths: string[]): ChatAttachment[] {
    return paths.map((p, i) => this.attachmentFor(p, i)).filter((a): a is ChatAttachment => !!a);
  }

  private async searchChats(query: string): Promise<ChatSearchHit[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits = new Map<string, ChatSearchHit>();
    const all = this.allConversations();
    for (const c of all) {
      if (c.title.toLowerCase().includes(q)) hits.set(c.id, { conversationId: c.id, agent: c.agent, title: c.title, snippet: c.title, updatedAt: c.updatedAt });
    }
    const results = await Promise.all(this.active().map((b) => (b.search ? b.search(query).catch(() => []) : Promise.resolve([]))));
    for (const list of results)
      for (const h of list) {
        const c = all.find((x) => x.id === h.conversationId);
        if (!c) continue;
        hits.set(c.id, { conversationId: c.id, agent: c.agent, title: c.title, snippet: h.snippet, updatedAt: c.updatedAt });
      }
    return [...hits.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
  }

  // ------------------------------------------------------------------ enabled agents

  private static ALL: AgentKind[] = ['AGY', 'CLAUDE', 'CODEX', 'OPENCODE'];

  /**
   * Agents switched on in Settings → Agents. None until the first-run picker saved a choice: nothing starts (no
   * bridge, no agent CLI) before the user said which agents to use.
   */
  private enabledKinds(): AgentKind[] {
    const saved = this.store.get<AgentKind[]>('agents.enabled');
    if (!saved) return [];
    return AppHost.ALL.filter((k) => this.backends[k] && saved.includes(k));
  }

  private isEnabled(kind: AgentKind): boolean {
    return this.enabledKinds().includes(kind);
  }

  /** Backends that are registered and enabled. */
  private active(): AgentBackend[] {
    return this.enabledKinds().map((k) => this.backends[k]!).filter(Boolean);
  }

  /** Returns false when the user kept the old agents (declined the bridge restart the change needs). */
  private async setEnabled(kinds: AgentKind[]): Promise<boolean> {
    const next = AppHost.ALL.filter((k) => kinds.includes(k) && this.backends[k]);
    if (!next.length) throw new Error('Keep at least one agent enabled');
    const before = this.store.get<AgentKind[]>('agents.enabled');
    this.store.set('agents.enabled', next);
    // the bridge runs only the enabled agents (--no-hub, --no-claude…): a running one is restarted for the new set
    if (!(await (this.platform.applyAgents?.(before === undefined) ?? Promise.resolve(true)))) {
      this.store.set('agents.enabled', before);
      return false;
    }
    for (const k of next) this.backends[k]?.start();
    for (const b of this.active()) b.retry();
    // a new-chat screen on an agent that is now off (the first-run choice, or one turned off) moves to an enabled one
    for (const v of this.views.values()) if (!v.conversationId && !next.includes(v.agent)) this.show(v, null, this.defaultAgent());
    this.broadcast({ type: 'agents', agents: this.agentStatuses() });
    this.broadcast({ type: 'conversations', conversations: this.allConversations() });
    for (const b of this.active()) this.broadcast({ type: 'models', state: b.models() });
    return true;
  }

  /** Agent of a new chat: the one picked last (remembered), if still enabled, else the first enabled one. */
  private defaultAgent(): AgentKind {
    const enabled = this.enabledKinds();
    const last = this.settings.defaultAgent(this.platform.defaultAgent());
    return enabled.includes(last) ? last : (enabled[0] ?? 'AGY');
  }

  /** Custom commands (every agent) + the agent's own. */
  private commandsFor(agent: AgentKind) {
    return [...(this.plugins?.slashItems() ?? []), ...this.settings.slashItems(), ...(this.backendFor(agent)?.commands() ?? [])];
  }

  // ------------------------------------------------------------------ settings

  private backendForPage(page: string, id: string): AgentBackend | undefined {
    const key = page === 'root' ? id : page;
    const prefix = key.split('.')[0];
    const map: Record<string, AgentKind> = { agy: 'AGY', claude: 'CLAUDE', codex: 'CODEX', opencode: 'OPENCODE' };
    return map[prefix] ? this.backends[map[prefix]] : undefined;
  }

  private async buildSettings(page: string): Promise<SettingsPage> {
    if (page === 'root') {
      // the root only links to pages (as the app): each agent, chat features, connection
      // as the app's main menu: one card with "Agents" (choose agents, CLI paths) and each enabled agent's page
      const agentRows = this.active()
        .map((b) => b.settings?.rootItem())
        .filter((s): s is SettingItem => !!s);
      const sections: SettingsSection[] = [
        { id: 'agents', title: '', items: [{ kind: 'page', id: 'agents', label: 'Agents', icon: 'smart_toy', description: `${this.enabledKinds().length} enabled` }, ...agentRows] },
        this.settings.chatSection(),
        ...(this.browser ? [{ id: 'browser', title: '', items: [this.browser.rootItem()] } satisfies SettingsSection] : []),
        ...(this.plugins ? [{ id: 'plugins', title: '', items: [this.plugins.settings.rootItem()] } satisfies SettingsSection] : []),
        { id: 'checkpoints', title: '', items: [this.checkpoints.settings.rootItem()] },
        ...(this.jarvis ? [{ id: 'jarvis', title: '', items: [this.jarvis.settings.rootItem()] } satisfies SettingsSection] : []),
        {
          id: 'system',
          title: '',
          items: [
            { kind: 'page', id: 'connection', label: 'Bridge & connection', icon: 'lan', description: `127.0.0.1:${this.platform.bridgeInfo().port}` },
            ...(this.phone ? [this.phone.rootItem()] : []),
          ],
        },
      ];
      return { id: 'root', title: 'Settings', sections };
    }
    if (page === 'agents') {
      const labels: Record<AgentKind, string> = { AGY: 'Antigravity', CLAUDE: 'Claude Code', CODEX: 'Codex', OPENCODE: 'OpenCode' };
      return {
        id: 'agents',
        title: 'Agents',
        sections: [
          {
            id: 'enabled',
            title: '',
            items: [
              {
                kind: 'checklist',
                id: 'agents.enabled',
                label: 'Enabled agents',
                description: 'The agents you can start chats with',
                values: this.enabledKinds(),
                options: AppHost.ALL.map((k) => ({
                  value: k,
                  label: labels[k],
                  description: this.backends[k] ? (this.backends[k]!.status().detail ?? null) : 'Not available yet',
                })),
              },
            ],
          },
          // EGM design reviews (src/core/egm), under the agents like the app's EgmEntryRow
          { id: 'egm', title: '', items: [egmRootItem(this.egm)] },
          // Agent memory & history (src/core/memory), the app's AgentMemoryEntryRow
          ...(this.memory ? [{ id: 'memory', title: '', items: [this.memory.settings.rootItem()] }] : []),
          await this.cliLocationsSection(),
        ],
      };
    }
    if (page === 'connection') return this.settings.connectionPage(this.platform.bridgeInfo(), !!this.platform.showLogs);
    if (page === 'notifications')
      return this.settings.notificationsPage(this.platform.systemAlert ? (this.platform.systemAlertUnavailable?.() ?? null) : 'Not available here');
    if (page === 'agy') {
      // Antigravity page + which agy history the hub uses (host-owned: switching restarts the bridge)
      const p = (await this.backendForPage(page, '')?.settings?.page(page)) ?? { id: page, title: 'Antigravity', sections: [] };
      return { ...p, sections: [...p.sections, this.agyHistorySection()] };
    }
    if (this.jarvis && (page === 'jarvis' || page.startsWith('jarvis.'))) return this.jarvis.settings.page(page);
    if (this.browser && (page === 'browser' || page.startsWith('browser.'))) return this.browser.page(page);
    if (this.phone && page === 'phone') return this.phone.page(page);
    if (this.plugins && (page === 'plugins' || page.startsWith('plugins.'))) return this.plugins.settings.page(page);
    if (page === 'stem') return stemSettingsPage(this.render);
    if (page === 'egm') return egmPage(this.egm);
    if (isCheckpointPage(page)) return this.checkpoints.settings.page(page);
    if (this.memory && (page === 'memory' || page.startsWith('memory.'))) return this.memory.settings.page(page);
    const own = this.settings.page(page);
    if (own) return own;
    const backend = this.backendForPage(page, '');
    const p = await backend?.settings?.page(page);
    return p ?? { id: page, title: 'Settings', sections: [] };
  }

  /** Antigravity → Chat history: which ~/.gemini/<folder> the hub reads and writes. */
  private agyHistorySection(): SettingsSection {
    const home = os.homedir();
    const count = (name: string) => {
      try {
        return fs.readdirSync(path.join(home, '.gemini', name, 'conversations')).filter((f) => !f.startsWith('.')).length;
      } catch {
        return 0;
      }
    };
    const current = this.store.get<string>('agy.dataDir') ?? 'antigravity-ide';
    const opts = [
      { value: 'antigravity-ide', label: 'Antigravity IDE', what: '~/.gemini/antigravity-ide' },
      { value: 'antigravity', label: 'Antigravity app', what: '~/.gemini/antigravity' },
      { value: 'antigravity-cli', label: 'agy CLI (as the AntiGem app)', what: '~/.gemini/antigravity-cli' },
    ];
    return {
      id: 'agy-history',
      title: '',
      agent: 'AGY',
      items: [
        {
          kind: 'select',
          id: 'agy.dataDir',
          label: 'Chat history',
          description: 'Which Antigravity history the sidebar shows and new chats are saved to. Switching restarts the bridge.',
          value: current,
          options: opts.map((o) => ({ value: o.value, label: o.label, description: `${o.what} · ${count(o.value)} chats` })),
        },
      ],
    };
  }

  /**
   * Settings → Agents → CLI locations: the CLI each agent runs. By default the fixed path its installer uses (as the
   * app: nothing is searched for); the user may set another one. Empty = back to the default.
   */
  private async cliLocationsSection(): Promise<SettingsSection> {
    const labels: Record<AgentKind, string> = { AGY: 'Antigravity CLI path (agy)', CLAUDE: 'Claude Code CLI path (claude)', CODEX: 'Codex CLI path (codex)', OPENCODE: 'OpenCode CLI path (opencode)' };
    const custom = this.store.get<Partial<Record<AgentKind, string>>>('cli.paths') ?? {};
    const defaults = defaultCliPaths();
    const found = await this.platform.cliStatus().catch(() => ({}) as Awaited<ReturnType<Platform['cliStatus']>>);
    const tilde = tildePath;
    const items: SettingItem[] = AppHost.ALL.filter((k) => this.backends[k] && this.isEnabled(k)).map((k) => {
      const f = found[k];
      const used = custom[k] || defaults[k];
      // what the running bridge reports for this path (it may still run an older path until it restarts)
      const same = !!f?.path && path.resolve(f.path) === path.resolve(used);
      const state = !f || !same ? '' : f.installed ? ` · installed${f.version ? ` (${f.version})` : ''}` : ' · not installed there yet';
      return {
        kind: 'text' as const,
        id: `cli.path.${k}`,
        label: labels[k],
        description: custom[k] ? `Your path${state}. Clear it to use the default (${tilde(defaults[k])}).` : `Default path${state}`,
        value: tilde(used),
        placeholder: tilde(defaults[k]),
      };
    });
    items.push({
      kind: 'button',
      id: 'cli.apply',
      label: 'Restart bridge to apply',
      description: 'New paths are used when the bridge starts again',
      confirm: 'Restart the bridge? Running chats are stopped.',
    });
    return { id: 'cli-paths', title: '', items };
  }

  private async postSettings(v: ViewState) {
    const page = v.settingsPage;
    if (!page) return;
    const titleOf = (id: string) => {
      const map: Record<string, string> = { agy: 'Antigravity', claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
      return map[id.split('.')[0]] ?? 'Settings';
    };
    try {
      // never spin forever: an agent that is down (CLI uninstalled, hub offline) answers with an error page
      const built = await Promise.race([
        this.buildSettings(page),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(this.offlineReason(page) ?? 'Not responding — is the agent running?')), 12_000)),
      ]);
      if (v.settingsPage === page) v.port.post({ type: 'settings', page: built });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`[host] settings ${page}: ${msg}`);
      if (v.settingsPage === page) v.port.post({ type: 'settings', page: { id: page, title: titleOf(page), sections: [], error: this.offlineReason(page) ?? msg } });
    }
  }

  /** Why an agent's settings page can't load (its status), or null when it looks fine. */
  private offlineReason(page: string): string | null {
    if (this.platform.isOff()) return 'AntiGem is turned off — press Reconnect to start it.';
    const b = this.backendForPage(page, '');
    if (!b) return null;
    const st = b.status();
    if (st.state === 'online') return null;
    if (st.state === 'not_installed') return `${st.label} is not installed. Install it from its CLI page.`;
    return `${st.label} is ${st.state === 'starting' ? 'still starting' : 'not running'}${st.detail ? `: ${st.detail}` : ''}.`;
  }

  /** Re-sends open settings pages (light: only pages built from cached state — status / usage changes — never the
   *  pages that re-read the hub). */
  private refreshSettings(light = false) {
    const cheap = new Set(['root', 'agents', 'agy', 'claude', 'codex', 'opencode', 'connection', 'slash', 'context']);
    for (const v of this.views.values()) if (v.settingsPage && (!light || cheap.has(v.settingsPage))) void this.postSettings(v);
  }

  /** Re-sends only the open settings pages [match] picks (a download's progress must not rebuild an agent's page). */
  private refreshPages(match: (page: string) => boolean) {
    for (const v of this.views.values()) if (v.settingsPage && match(v.settingsPage)) void this.postSettings(v);
  }

  /** Project picker: this window's folders, the saved projects, and folders recent chats ran in. */
  private async projects(): Promise<ProjectView[]> {
    // one entry per folder, however its link or path is written (file:///c%3A/… from VS Code, C:\… from an agent)
    const stats = new Map<string, { path: string; lastUsed: number; chats: number }>();
    for (const c of this.allConversations()) {
      if (!c.workspaceUri) continue;
      const key = folderKey(c.workspaceUri);
      const s = stats.get(key) ?? { path: uriToPath(c.workspaceUri), lastUsed: 0, chats: 0 };
      s.lastUsed = Math.max(s.lastUsed, c.updatedAt);
      s.chats++;
      stats.set(key, s);
    }
    const out = new Map<string, ProjectView>();
    const add = (p: string, name: string, source: ProjectView['source']) => {
      const clean = uriToPath(p).replace(/(?<=.)[\\/]+$/, '');
      const key = folderKey(clean);
      if (out.has(key)) return;
      const s = stats.get(key);
      out.set(key, { name, path: clean, uri: pathToUri(clean), source, lastUsed: s?.lastUsed ?? null, chats: s?.chats ?? 0 });
    };
    for (const f of this.platform.workspaceFolders()) add(f.path, f.name, 'workspace');
    const saved = await this.platform.savedProjects().catch(() => []);
    for (const p of saved) add(p.path, p.name, 'saved');
    // folders chats ran in, when they exist on this machine (a chat started on the phone has a phone path)
    for (const { path: p } of [...stats.values()].sort((a, b) => b.lastUsed - a.lastUsed)) {
      let isDir = false;
      try {
        isDir = fs.statSync(p).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir) add(p, baseName(p), 'recent');
    }
    const rank = { workspace: 0, saved: 1, recent: 2 } as const;
    return [...out.values()].sort((a, b) => rank[a.source] - rank[b.source] || (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  }

  private uiPrefs(): UiPrefs {
    // the default look matches VS Code's own theme
    return { theme: 'vscode', ...(this.store.get<Partial<UiPrefs>>('ui.prefs') ?? {}) } as UiPrefs;
  }

  private agentStatuses() {
    const all: AgentKind[] = ['AGY', 'CLAUDE', 'OPENCODE', 'CODEX'];
    const labels: Record<AgentKind, string> = { AGY: 'Antigravity', CLAUDE: 'Claude', OPENCODE: 'OpenCode', CODEX: 'Codex' };
    const off = this.platform.isOff();
    return all.map((k) =>
      this.backends[k] && this.isEnabled(k)
        ? off
          ? { ...this.backends[k]!.status(), state: 'offline' as const, detail: 'AntiGem is turned off' }
          : this.backends[k]!.status()
        : { kind: k, label: labels[k], state: 'disabled' as const, detail: this.backends[k] ? 'Turned off in Settings → Agents' : 'Not available yet' },
    );
  }

  private allConversations(): Conversation[] {
    let list = this.rawConversations();
    // a group chat bot's own chat is never listed (the group's member menu opens it)
    const groups = this.groups;
    if (groups) list = list.map((c) => (groups.isBotChat(c.id) ? { ...c, groupBot: true } : c));
    // a crew DM carries its bot's face (the drawer leaves it to the Crew screen)
    if (this.crew) list = this.crew.decorate(list);
    return this.jarvis ? this.jarvis.decorateConversations(list) : list;
  }

  /** Every chat of the enabled agents, newest first (without the Jarvis tags). */
  private rawConversations(): Conversation[] {
    return this.active()
      .flatMap((b) => b.conversations())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** An enabled agent's backend (the Crew runs bot chats on it). */
  agentBackend(agent: AgentKind): AgentBackend | undefined {
    return this.backendFor(agent);
  }

  private backendFor(agent: AgentKind | undefined): AgentBackend | undefined {
    return agent && this.isEnabled(agent) ? this.backends[agent] : undefined;
  }

  private agentOf(conversationId: string): AgentKind | undefined {
    for (const b of this.active()) if (b.conversations().some((c) => c.id === conversationId)) return b.kind;
    return undefined;
  }

  private broadcast(msg: HostToView) {
    for (const v of this.views.values()) v.port.post(msg);
  }

  attachView(port: ViewPort): string {
    const id = randomUUID();
    this.views.set(id, {
      id,
      port,
      conversationId: null,
      agent: this.defaultAgent(),
      unsubscribe: null,
      sent: new Map(),
      order: [],
      meta: {},
      settingsPage: null,
    });
    return id;
  }

  detachView(id: string) {
    const v = this.views.get(id);
    v?.unsubscribe?.();
    this.views.delete(id);
    this.groups?.forgetView(id);
    this.crew?.forgetView(id);
    this.checkpoints.forgetView(id);
  }

  /** Conversation shown by a view (for "Open in editor"). */
  viewConversation(id: string): string | null {
    return this.views.get(id)?.conversationId ?? null;
  }

  postTo(id: string, msg: HostToView) {
    this.views.get(id)?.port.post(msg);
  }

  /** The view's "+" button: an empty new-chat screen. */
  newChat(id: string) {
    const v = this.views.get(id);
    if (v) this.show(v, null, v.agent);
  }

  private sendInit(v: ViewState) {
    v.port.post({
      type: 'init',
      viewKind: v.port.kind,
      workspaceFolders: this.platform.workspaceFolders(),
      conversationId: v.port.initialConversationId ?? null,
      defaultAgent: this.defaultAgent(),
      firstRun: this.store.get('agents.enabled') === undefined,
    });
    v.port.post({ type: 'uiPrefs', prefs: this.uiPrefs() });
    v.port.post({ type: 'editorContext', context: this.editorCtx });
    v.port.post({ type: 'agents', agents: this.agentStatuses() });
    v.port.post({ type: 'conversations', conversations: this.allConversations() });
    for (const b of this.active()) v.port.post({ type: 'models', state: b.models() });
    if (this.jarvis) v.port.post({ type: 'jarvis', state: this.jarvis.snapshot(), full: true });
  }

  /** Points a view at a conversation (or an empty new chat) and streams its state. */
  private show(v: ViewState, conversationId: string | null, agent: AgentKind) {
    v.unsubscribe?.();
    v.unsubscribe = null;
    v.conversationId = conversationId;
    v.agent = agent;
    v.sent.clear();
    v.order = [];
    v.meta = {};
    const reset: ChatPatch = {
      reset: true,
      agent,
      conversation: null,
      order: [],
      upserts: [],
      isStreaming: false,
      isLoading: conversationId != null,
      error: null,
      queued: [],
      approvals: [],
      question: null,
      artifacts: [],
      workingLabel: null,
      controls: conversationId ? [] : (this.backendFor(agent)?.controls?.(null) ?? []),
    };
    v.port.post({ type: 'chat', conversationId, patch: reset });
    v.port.onTitle?.(conversationId ? (this.allConversations().find((c) => c.id === conversationId)?.title ?? 'Chat') : 'New Chat');
    // the agent's "/" list follows the chat's project (src/core/skills/slashFolder.ts)
    this.backendFor(agent)?.slashFolder?.(slashFolderOf(conversationId, this.rawConversations(), this.uiPrefs().lastProject, this.platform.workspaceFolders()), false);
    if (!conversationId) return;
    this.notifier.seen();
    const backend = this.backendFor(agent);
    if (!backend) {
      v.port.post({ type: 'chat', conversationId, patch: { isLoading: false, error: `${agent} chats are not supported yet in the extension.` } });
      return;
    }
    v.unsubscribe = backend.subscribe(conversationId, (state) => this.push(v, conversationId, state));
    // Agent memory: catch up on turns that finished while no one followed this chat
    this.memory?.opened(conversationId, agent);
  }

  private push(v: ViewState, conversationId: string, state: ChatState) {
    if (v.conversationId !== conversationId) return;
    // Jarvis' labelled news messages carry their parsed events (the view draws them as event cards)
    if (this.jarvis) state = { ...state, messages: this.jarvis.decorateMessages(conversationId, state.messages) };
    // the user messages' restore points (project checkpoints), sent apart from the messages
    this.checkpoints.onChat(v.id, (m) => v.port.post(m), conversationId, state);
    const patch: ChatPatch = {};
    let any = false;
    const order = state.messages.map((m) => m.id);
    if (order.length !== v.order.length || order.some((id, i) => id !== v.order[i])) {
      patch.order = order;
      v.order = order;
      any = true;
      const keep = new Set(order);
      for (const id of [...v.sent.keys()]) if (!keep.has(id)) v.sent.delete(id);
    }
    const upserts: ChatMessage[] = [];
    for (const m of state.messages) {
      const prev = v.sent.get(m.id);
      if (prev?.ref === m) continue;
      const json = JSON.stringify(m);
      if (prev && prev.json === json) {
        prev.ref = m;
        continue;
      }
      v.sent.set(m.id, { ref: m, json });
      upserts.push(m);
    }
    if (upserts.length) {
      patch.upserts = upserts;
      any = true;
    }
    for (const k of META_KEYS) {
      const json = JSON.stringify(state[k] ?? null);
      if (v.meta[k] !== json) {
        v.meta[k] = json;
        if (k === 'conversation' && state.conversation?.title) v.port.onTitle?.(state.conversation.title);
        (patch as Record<string, unknown>)[k] = state[k] ?? null;
        any = true;
      }
    }
    if (any) v.port.post({ type: 'chat', conversationId, patch });
  }

  private toast(v: ViewState, level: 'info' | 'warning' | 'error', message: string) {
    v.port.post({ type: 'toast', level, message });
  }

  async handle(viewId: string, msg: ViewToHost) {
    const v = this.views.get(viewId);
    if (!v) return;
    if (msg.type !== 'ready') this.lastActive = viewId;
    const isSetting = msg.type === 'settingChange' || msg.type === 'settingAction';
    const done = (ok: boolean, error: string | null) => {
      if (!isSetting) return;
      v.port.post({
        type: 'settingDone',
        page: msg.page,
        id: msg.id,
        rowId: msg.rowId ?? null,
        actionId: msg.type === 'settingAction' ? (msg.actionId ?? null) : null,
        ok,
        error,
      });
    };
    try {
      await this.dispatch(v, msg);
      done(true, null);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.log(`[host] ${msg.type}: ${m}`);
      this.toast(v, 'error', m);
      done(false, m);
      // a settings change that failed: show the page as it really is again
      if (isSetting) void this.postSettings(v);
    }
  }

  private async dispatch(v: ViewState, msg: ViewToHost) {
    switch (msg.type) {
      case 'ready': {
        this.sendInit(v);
        // a reloaded webview (hidden editor tab shown again) gets back what it showed
        const target = v.conversationId ?? v.port.initialConversationId ?? null;
        if (target) this.show(v, target, v.conversationId ? v.agent : (this.agentOf(target) ?? v.agent));
        else this.show(v, null, v.agent);
        return;
      }
      case 'openConversation': {
        if (msg.id == null) {
          const agent = msg.agent && this.isEnabled(msg.agent) ? msg.agent : this.defaultAgent();
          if (msg.agent) this.store.set('chat.defaultAgent', agent);
          this.show(v, null, agent);
          return;
        }
        this.show(v, msg.id, msg.agent ?? this.agentOf(msg.id) ?? v.agent);
        return;
      }
      case 'send': {
        const backend = this.backendFor(msg.agent);
        if (!backend) {
          this.toast(v, 'warning', `${msg.agent} is not available in the extension yet.`);
          return;
        }
        if (v.conversationId !== msg.conversationId) {
          // a new chat: start showing it before the first frame arrives
          v.unsubscribe?.();
          v.conversationId = msg.conversationId;
          v.agent = msg.agent;
          v.sent.clear();
          v.order = [];
          v.meta = {};
          v.unsubscribe = backend.subscribe(msg.conversationId, (state) => this.push(v, msg.conversationId, state));
        }
        // tell the user when this turn is over / it needs them, if they are not looking then
        this.notifier.track(msg.conversationId, msg.agent);
        // editor selections travel as text (a hidden block the chat shows as chips); files go to the backend
        const selections = msg.attachments.filter((a) => a.kind === 'selection' || a.selectionText != null);
        const others = msg.attachments.filter((a) => !selections.includes(a));
        const withSel = selections.length ? `${msg.text}${selectionBlock(selections)}` : msg.text;
        // a Jarvis chat carries Jarvis' hidden note (guide, rules, live context, mission) instead of the global context
        // (and EGM's commands tell Jarvis to run the reviewers as task chats)
        const expanded = this.settings.expand(withSel, this.jarvis?.isJarvisTarget(msg.conversationId, msg.isNew, msg.jarvis === true) ?? false);
        const jarvisText = this.jarvis?.wrapSend(msg.conversationId, msg.agent, expanded, msg.isNew, msg.jarvis === true) ?? null;
        let req: SendRequest = {
          conversationId: msg.conversationId,
          isNew: msg.isNew,
          text: jarvisText ?? this.settings.wrap(expanded, msg.isNew, msg.conversationId, msg.agent),
          attachments: others,
          modelId: msg.modelId,
          workspaceUri: msg.workspaceUri ?? this.platform.workspaceFolders()[0]?.uri ?? null,
        };
        // a crew DM: the bot's setup (persona, crew tools, access), and its model / folder when the chat starts
        if (this.crew) req = this.crew.prepareSend(req, msg.agent, msg.crewThread);
        // Agent memory (src/core/memory): a normal chat's first message also carries the memory text (it waits briefly)
        await (this.memory && jarvisText == null ? this.memory.send(req, msg.agent, msg.text, (r) => backend.send(r)) : backend.send(req));
        return;
      }
      case 'stop':
        this.notifier.stopped(msg.conversationId);
        await this.backendFor(this.agentOf(msg.conversationId) ?? v.agent)?.stop(msg.conversationId);
        return;
      case 'approval':
        await this.backendFor(this.agentOf(msg.conversationId) ?? v.agent)?.approval(msg.conversationId, msg.key, msg.choiceId, msg.deny === true, msg.feedback);
        return;
      case 'answer': {
        const answers: Record<string, string[]> = { ...msg.answers };
        for (const [q, text] of Object.entries(msg.custom ?? {})) if (text.trim()) answers[q] = [...(answers[q] ?? []), text.trim()];
        await this.backendFor(this.agentOf(msg.conversationId) ?? v.agent)?.answer(
          msg.conversationId,
          msg.key,
          answers,
          msg.note,
          msg.skip === true || msg.cancel === true,
          msg.cancel === true,
        );
        return;
      }
      case 'selectModel':
        this.backendFor(msg.agent)?.selectModel(msg.conversationId, msg.modelId);
        return;
      case 'requestModels': {
        const b = this.backendFor(msg.agent);
        if (b) {
          v.port.post({ type: 'models', state: b.models() });
          b.refreshModels();
        }
        return;
      }
      case 'requestCommands':
        v.port.post({ type: 'commands', agent: msg.agent, commands: this.commandsFor(msg.agent) });
        return;
      case 'slashMenuOpened':
        this.backendFor(msg.agent)?.slashFolder?.(slashFolderOf(v.conversationId, this.rawConversations(), this.uiPrefs().lastProject, this.platform.workspaceFolders()), true);
        return;
      case 'requestSettings':
        v.settingsPage = msg.page;
        await this.postSettings(v);
        return;
      case 'closeSettings':
        v.settingsPage = null;
        return;
      case 'settingChange': {
        if (this.phone && msg.page === 'phone') {
          await this.phone.change(msg.page, msg.id, msg.value);
          this.refreshSettings();
          return;
        }
        if (this.browser && (msg.page === 'browser' || msg.page.startsWith('browser.'))) {
          await this.browser.change(msg.page, msg.id, msg.value);
          this.refreshSettings();
          return;
        }
        if (this.plugins && (msg.page === 'plugins' || msg.page.startsWith('plugins.'))) {
          await this.plugins.settings.change(msg.page, msg.id, msg.value, msg.rowId);
          this.refreshSettings();
          return;
        }
        if (isCheckpointPage(msg.page)) {
          await this.checkpoints.settings.change(msg.page, msg.id, msg.value, msg.rowId);
          this.refreshSettings();
          return;
        }
        if (this.memory && (msg.page === 'memory' || msg.page.startsWith('memory.'))) {
          await this.memory.settings.change(msg.page, msg.id, msg.value, msg.rowId);
          this.refreshSettings();
          return;
        }
        if (this.jarvis && (msg.page === 'jarvis' || msg.page.startsWith('jarvis.'))) {
          await this.jarvis.settings.change(msg.page, msg.id, msg.value, msg.rowId);
          this.refreshSettings();
          return;
        }
        // Settings → STEM & diagrams, Settings → Agents → EGM
        if ((msg.page === 'stem' && stemChange(this.render, msg.id, msg.value)) || (msg.page === 'egm' && egmChange(this.egm, msg.id, msg.value))) {
          this.refreshSettings();
          return;
        }
        if (msg.id === 'agy.dataDir') {
          const name = String(msg.value);
          if (!['antigravity-ide', 'antigravity', 'antigravity-cli'].includes(name)) return;
          if (name === (this.store.get<string>('agy.dataDir') ?? 'antigravity-ide')) return;
          this.store.set('agy.dataDir', name);
          this.toast(v, 'info', 'Switching Antigravity history… (restarting the bridge)');
          await this.platform.restartBridge();
          for (const b of this.active()) b.retry();
          this.refreshSettings();
          return;
        }
        if (msg.id.startsWith('cli.path.')) {
          const kind = msg.id.slice('cli.path.'.length) as AgentKind;
          const value = expandHome(String(msg.value ?? '').trim());
          // the default path itself (or empty) = no path of your own
          if (!value || path.resolve(value) === path.resolve(defaultCliPaths()[kind])) {
            const paths = { ...(this.store.get<Partial<Record<AgentKind, string>>>('cli.paths') ?? {}) };
            const had = !!paths[kind];
            delete paths[kind];
            this.store.set('cli.paths', paths);
            if (had) this.toast(v, 'info', 'Back to the default path — restart the bridge to use it');
            this.refreshSettings();
            return;
          }
          if (value) {
            let ok = false;
            try {
              fs.accessSync(value, fs.constants.X_OK);
              ok = fs.statSync(value).isFile();
            } catch {
              ok = false;
            }
            if (!ok) throw new Error(`Not an executable file: ${value}`);
          }
          const paths = { ...(this.store.get<Partial<Record<AgentKind, string>>>('cli.paths') ?? {}) };
          if (value) paths[kind] = value;
          else delete paths[kind];
          this.store.set('cli.paths', paths);
          this.toast(v, 'info', 'Saved — restart the bridge to use it');
          this.refreshSettings();
          return;
        }
        if (msg.id === 'agents.enabled') {
          if (!(await this.setEnabled(Array.isArray(msg.value) ? (msg.value as AgentKind[]) : []))) this.toast(v, 'info', 'Agents unchanged');
          this.refreshSettings();
          return;
        }
        if (!this.settings.change(msg.page, msg.id, msg.value, msg.rowId)) {
          await this.backendForPage(msg.page, msg.id)?.settings?.change(msg.page, msg.id, msg.value, msg.rowId);
        } else if (msg.page === 'notifications') this.notifier.refreshBadge();
        this.refreshSettings();
        return;
      }
      case 'settingAction': {
        // Skills → "Set up with AI": a new chat of the chosen agent with the setup request (src/core/skills)
        const setup = setupChatRequest(msg.id, msg.values);
        if (setup) {
          if (!this.isEnabled(setup.agent)) throw new Error('That agent is turned off in Settings → Agents: turn it on, or pick another one.');
          v.port.post({ type: 'startChat', ...setup });
          return;
        }
        let result: string | void | null = null;
        if (msg.id === 'conn.restart' || msg.id === 'cli.apply') {
          await this.platform.restartBridge();
          for (const b of this.active()) b.retry();
          result = 'Bridge restarted';
        } else if (msg.id === 'conn.logs') {
          this.platform.showLogs?.();
        } else if (msg.id === 'notify.test') {
          result = await this.notifier.test();
        } else if (this.jarvis && (msg.page === 'jarvis' || msg.page.startsWith('jarvis.'))) {
          result = await this.jarvis.settings.action(msg.page, msg.id, msg.rowId, msg.actionId, msg.values);
        } else if (this.phone && msg.page === 'phone') {
          result = await this.phone.action(msg.page, msg.id, msg.rowId, msg.actionId);
        } else if (this.browser && (msg.page === 'browser' || msg.page.startsWith('browser.'))) {
          result = await this.browser.action(msg.page, msg.id, msg.rowId, msg.actionId, msg.values);
        } else if (this.plugins && (msg.page === 'plugins' || msg.page.startsWith('plugins.'))) {
          result = await this.plugins.settings.action(msg.page, msg.id, msg.rowId, msg.actionId, msg.values);
        } else if (isCheckpointPage(msg.page)) {
          result = await this.checkpoints.settings.action(msg.page, msg.id, msg.rowId, msg.actionId, msg.values, (m) => v.port.post(m));
        } else if (this.memory && (msg.page === 'memory' || msg.page.startsWith('memory.'))) {
          result = await this.memory.settings.action(msg.page, msg.id, msg.rowId, msg.actionId, msg.values);
        } else if (msg.page === 'stem' || msg.page === 'egm') {
          result =
            msg.page === 'stem'
              ? stemAction(this.render, msg.id)
              : await egmAction(this.egm, msg.id, (u) => this.platform.openUrl(u), msg.rowId, msg.actionId, msg.values);
        } else {
          result = this.settings.action(msg.page, msg.id, msg.rowId, msg.actionId, msg.values);
          if (result === null) result = await this.backendForPage(msg.page, msg.id)?.settings?.action(msg.page, msg.id, msg.rowId, msg.actionId, msg.values);
          if (msg.page === 'slash') for (const b of this.active()) this.broadcast({ type: 'commands', agent: b.kind, commands: this.commandsFor(b.kind) });
        }
        if (result) this.toast(v, 'info', result);
        this.refreshSettings();
        return;
      }
      case 'conversationAction':
        await this.conversationAction(v, msg.id, msg.action, msg.value);
        return;
      case 'queueAction':
        await this.backendFor(this.agentOf(msg.conversationId) ?? v.agent)?.queueAction(msg.conversationId, msg.id, msg.action);
        return;
      case 'openFile':
        this.platform.openFile(msg.path, msg.line);
        return;
      case 'openUrl':
        this.platform.openUrl(msg.url);
        return;
      case 'copy':
        this.platform.copy(msg.text);
        return;
      case 'pickAttachments': {
        const attachments = await this.platform.pickAttachments();
        v.port.post({ type: 'attachments', reqId: msg.reqId, attachments });
        return;
      }
      case 'searchFiles': {
        const files = await this.platform.searchFiles(msg.query);
        v.port.post({ type: 'fileSearchResult', reqId: msg.reqId, files });
        return;
      }
      case 'retryConnections':
        this.reconnect();
        return;
      case 'restartBridge': {
        if (!(await this.platform.confirm('Restart the AntiGem bridge? Its agents and the Antigravity hub stop and start again; running chats stop in every VS Code window.', 'Restart')))
          return;
        this.toast(v, 'info', 'Restarting the bridge…');
        try {
          await this.platform.restartBridge();
          for (const b of this.active()) b.retry();
          this.broadcast({ type: 'agents', agents: this.agentStatuses() });
          this.toast(v, 'info', 'Bridge restarted');
        } catch (e) {
          this.toast(v, 'error', `The bridge did not start: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      case 'powerOff': {
        if (
          !(await this.platform.confirm(
            'Stop AntiGem? The bridge, every agent and the Antigravity hub stop (running chats stop) in every VS Code window. Press ▶ in the side bar to start them again.',
            'Stop',
          ))
        )
          return;
        await this.platform.powerOff();
        this.broadcast({ type: 'agents', agents: this.agentStatuses() });
        this.broadcast({ type: 'toast', level: 'info', message: 'AntiGem stopped — press ▶ in the side bar to start it' });
        return;
      }
      case 'toolAction':
        await this.backendFor(this.agentOf(msg.conversationId) ?? v.agent)?.toolAction?.(msg.conversationId, msg.toolId, msg.action);
        return;
      case 'setQuotaGroup':
        this.backendFor(msg.agent)?.setQuotaGroup?.(msg.modelId, msg.group);
        return;
      case 'groupWatch':
      case 'groupAction':
      case 'groupSend': {
        if (!this.groups) throw new Error('Group chats are not available in this window');
        const r = await this.groups.handle(v.id, (m) => v.port.post(m), msg);
        if (r) this.toast(v, 'info', r);
        return;
      }
      case 'crewWatch':
      case 'crewAction':
      case 'jobsWatch':
      case 'jobAction':
      case 'inboxWatch':
      case 'inboxAnswer': {
        if (!this.crew) throw new Error('The Crew is not available in this window');
        const r = await this.crew.handle(v.id, (m) => v.port.post(m), msg);
        if (r) this.toast(v, 'info', r);
        return;
      }
      case 'requestJarvis':
        if (this.jarvis) v.port.post({ type: 'jarvis', state: this.jarvis.snapshot(), full: true });
        return;
      case 'jarvisAction': {
        if (!this.jarvis) throw new Error('Jarvis is not available in this window');
        const r = await this.jarvis.action(msg, v.id);
        if (r) this.toast(v, 'info', r);
        return;
      }
      case 'readImage': {
        let dataUrl: string | null = null;
        try {
          const p = uriToPath(msg.path);
          const st = fs.statSync(p);
          const mime = IMAGE_MIME[path.extname(p).slice(1).toLowerCase()];
          if (mime && st.size <= 8 * 1024 * 1024) dataUrl = `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
        } catch {
          dataUrl = null;
        }
        v.port.post({ type: 'imageData', reqId: msg.reqId, dataUrl });
        return;
      }
      case 'mediaUrl': {
        const srv = this.preview;
        let url: string | null = null;
        let error: string | null = null;
        try {
          if (!srv) throw new Error('Previews are not available here');
          url =
            msg.kind === 'html'
              ? srv.html(msg.value)
              : msg.kind === 'htmlFile'
                ? srv.htmlFile(msg.value)
                : msg.kind === 'file'
                  ? srv.file(msg.value)
                  : msg.kind === 'player'
                    ? srv.player(msg.value)
                    : srv.youtube(msg.value, msg.start ?? 0);
        } catch (e) {
          error = e instanceof Error ? (/ENOENT/.test(e.message) ? 'File not found' : e.message) : String(e);
        }
        v.port.post({ type: 'mediaUrl', reqId: msg.reqId, url, error });
        return;
      }
      // STEM & diagrams (src/core/render): what chats render, the pages of STEM blocks; and the guides settings show
      case 'requestRender':
      case 'stemPage':
      case 'stemSvg':
        this.render.handle(msg, (m) => v.port.post(m));
        return;
      case 'requestDoc':
        v.port.post({ type: 'doc', id: msg.id, markdown: msg.id === 'stem-guide' ? this.render.guideText() : msg.id === 'egm-guide' ? egmGuide(this.egm) : null });
        return;
      case 'checkpoint':
        await this.checkpoints.request(msg.reqId, msg.request, (m) => v.port.post(m));
        return;
      case 'memoryRequest':
        v.port.post(
          this.memory
            ? await this.memory.request(msg, v.conversationId ? { id: v.conversationId, agent: v.agent } : null)
            : { type: 'memoryResult', reqId: msg.reqId, applied: null, enabled: false, error: 'Agent memory is not available here' },
        );
        return;
      case 'resolveDrop': {
        const paths = msg.uris
          .map((u) => u.trim())
          .filter(Boolean)
          .map((u) => {
            try {
              return absPath(u);
            } catch {
              return null;
            }
          })
          .filter((p): p is string => !!p);
        v.port.post({ type: 'attachments', reqId: msg.reqId, attachments: this.attachmentsForPaths(paths) });
        return;
      }
      case 'searchChats':
        v.port.post({ type: 'chatSearchResult', reqId: msg.reqId, results: await this.searchChats(msg.query) });
        return;
      case 'saveFile':
        await this.platform.saveText(msg.suggestedName, msg.content);
        return;
      case 'runInTerminal':
        this.platform.runInTerminal(msg.command, msg.cwd);
        return;
      case 'openText':
        this.platform.openText(msg.title, msg.content, msg.language);
        return;
      case 'revealRange':
        this.platform.revealRange(msg.path, msg.startLine, msg.endLine);
        return;
      case 'saveArtifact':
        await this.platform.saveCopy(uriToPath(msg.path));
        return;
      case 'downloadUrl':
        if (!/^https?:\/\//i.test(msg.url)) throw new Error('Only web addresses can be downloaded');
        if (!this.platform.downloadUrl) throw new Error('Downloads are not available here');
        await this.platform.downloadUrl(msg.url, msg.name);
        return;
      case 'setControl': {
        const b = this.backendFor(msg.agent);
        // an info chip: the agent's card (ChipDetailsView) when it has one, else its old toast
        if (msg.value === 'details' && b?.chipDetails) {
          const details = await b.chipDetails(msg.conversationId, msg.id).catch((e) => ({
            chipId: msg.id,
            conversationId: msg.conversationId,
            title: 'Details',
            error: e instanceof Error ? e.message : String(e),
          }));
          if (details) {
            v.port.post({ type: 'chipDetails', details });
            return;
          }
        }
        await b?.setControl?.(msg.conversationId, msg.id, msg.value);
        return;
      }
      case 'requestNotes':
        v.port.post({ type: 'notes', notes: this.notes?.all() ?? [] });
        return;
      case 'notesAction': {
        const n = this.notes;
        if (!n) return;
        const note = msg.note;
        if (msg.action === 'create') {
          if (note.id && !n.get(note.id)) {
            // the screen made the note (its id, its rows — blank ones too, it is still being typed): keep it as it is
            const now = Date.now();
            n.restore({
              id: note.id,
              kind: note.kind === 'todo' ? 'todo' : 'note',
              title: note.title ?? '',
              text: note.text ?? '',
              items: (note.items ?? []).map((i) => ({ id: i.id || randomUUID(), text: i.text ?? '', done: i.done === true })),
              pinned: note.pinned === true,
              createdAt: note.createdAt ?? now,
              updatedAt: now,
            });
          } else n.create(note.kind === 'todo' ? 'todo' : 'note', note.title ?? '', note.text ?? '', (note.items ?? []).map((i) => i.text), note.pinned === true);
        } else if (msg.action === 'update' && note.id) {
          n.update(note.id, (cur) => ({
            ...cur,
            kind: note.kind ?? cur.kind,
            title: note.title ?? cur.title,
            text: note.text ?? cur.text,
            items: note.items ?? cur.items,
            pinned: note.pinned ?? cur.pinned,
          }));
        } else if (msg.action === 'delete' && note.id) {
          n.delete(note.id);
        } else if (msg.action === 'restore' && note.id && note.createdAt) {
          n.restore(note as Parameters<NotesStore['restore']>[0]);
        }
        return;
      }
      case 'requestProjects':
        v.port.post({ type: 'projects', reqId: msg.reqId, projects: await this.projects() });
        return;
      case 'pickFolder': {
        const p = await this.platform.pickFolder();
        if (p) await this.platform.saveProject(p).catch(() => undefined);
        const project: ProjectView | null = p ? { name: baseName(p), uri: pathToUri(p), path: p, source: 'saved' } : null;
        v.port.post({ type: 'folderPicked', reqId: msg.reqId, project });
        return;
      }
      case 'forgetProject':
        await this.platform.forgetProject(msg.path);
        return;
      case 'setUiPref': {
        const prefs = { ...this.uiPrefs(), [msg.key]: msg.value };
        this.store.set('ui.prefs', prefs);
        this.broadcast({ type: 'uiPrefs', prefs });
        // the chat pill's 5h / 7d choice changes every model's pill text
        if (msg.key === 'quotaPillWindow') for (const b of this.active()) this.broadcast({ type: 'models', state: b.models() });
        return;
      }
      case 'retry': {
        const b = this.backendFor(this.agentOf(msg.conversationId) ?? v.agent);
        if (!b?.retryMessage) {
          this.toast(v, 'info', 'Regenerate is not available for this agent yet.');
          return;
        }
        const t = await b.retryMessage(msg.conversationId, msg.messageId);
        if (t) this.toast(v, 'info', t);
        return;
      }
      case 'rewind': {
        const b = this.backendFor(this.agentOf(msg.conversationId) ?? v.agent);
        if (!b?.rewind) {
          this.toast(v, 'info', 'Edit & rewind is not available for this agent yet.');
          return;
        }
        const wasFirst = b.getState(msg.conversationId).messages.find((m) => m.role === 'USER')?.id === msg.messageId;
        const prompt = await b.rewind(msg.conversationId, msg.messageId, msg.restoreFiles === true);
        // rewinding the first prompt deletes the chat (as in the app): continue on a new chat with that prompt
        if (v.conversationId === msg.conversationId && !b.conversations().some((c) => c.id === msg.conversationId)) this.show(v, null, b.kind);
        // ... or the chat stays under the same id but starts over (Claude, OpenCode, Codex): its next message is a first
        // message again, with the global context and the Agent memory text
        if (wasFirst && prompt != null && b.conversations().some((c) => c.id === msg.conversationId)) {
          this.settings.restartContext(msg.conversationId);
          this.memory?.forget(msg.conversationId);
        }
        if (prompt != null) v.port.post({ type: 'insertText', text: prompt });
        return;
      }
    }
  }

  private async conversationAction(v: ViewState, id: string, action: string, value?: string) {
    if (action === 'copyId') {
      // the agent's own id (Codex thread / OpenCode session), not the alias the views use
      const b = this.backendFor(this.agentOf(id));
      this.platform.copy(b?.externalId?.(id) ?? id);
      this.toast(v, 'info', 'Chat ID copied');
      return;
    }
    if (action === 'openInEditor') {
      this.platform.openInEditor(id);
      return;
    }
    const backend = this.backendFor(this.agentOf(id));
    if (!backend) return;
    // delete: the view already asked (the drawer's "Delete Conversation?" dialog), so no second VS Code dialog here
    let arg = value;
    if (action === 'rename' && !arg) {
      const current = backend.conversations().find((c) => c.id === id)?.title ?? '';
      arg = await this.platform.prompt('Rename chat', current);
      if (!arg) return;
    }
    const res = await backend.conversationAction(id, action as 'delete' | 'fork' | 'rename' | 'archive' | 'unarchive', arg);
    if (action === 'delete') this.jarvis?.onChatDeleted(id);
    // Agent memory: its history file goes too (memories it saved stay)
    if (action === 'delete') this.memory?.onChatDeleted(id);
    if (action === 'delete' && v.conversationId === id) this.show(v, null, v.agent);
    if (action === 'fork' && typeof res === 'string' && res) this.show(v, res, backend.kind);
  }

  dispose() {
    this.notifier.dispose();
    this.phone?.dispose();
    for (const v of this.views.values()) v.unsubscribe?.();
    this.views.clear();
    this.jarvis?.dispose();
    this.groups?.dispose();
    this.crew?.dispose();
    this.plugins?.dispose();
    this.checkpoints.dispose();
    this.memory?.dispose();
    this.unsubs.forEach((u) => u());
    for (const b of Object.values(this.backends)) b?.dispose();
  }
}
