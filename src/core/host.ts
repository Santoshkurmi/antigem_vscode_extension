// The host side of every view (VS Code sidebar, editor tabs, or a browser tab in dev): routes view requests to the
// agent backends and sends each view only what changed in the chat it shows.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { AgentKind, ChatAttachment, ChatMessage, Conversation } from '../../shared/model';
import type { ChatPatch, ChatSearchHit, EditorContextView, FileSuggestion, HostToView, ProjectView, SettingItem, SettingsPage, SettingsSection, UiPrefs, ViewToHost, WorkspaceFolder } from '../../shared/protocol';
import path from 'node:path';
import { HostSettings } from './settings';
import { selectionBlock } from './text';
import type { AgentBackend, ChatState, KeyValueStore, Logger } from './types';

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
  /** Open a file and select a line range. */
  revealRange(path: string, startLine: number, endLine: number): void;
  openInEditor(conversationId: string): void;
  confirm(message: string): Promise<boolean>;
  prompt(message: string, value: string): Promise<string | undefined>;
  /** Stops and starts the bridge again (its hub too). */
  restartBridge(): Promise<void>;
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
}

export interface ViewPort {
  kind: 'sidebar' | 'panel' | 'browser';
  post(msg: HostToView): void;
  /** The shown chat's title changed (editor tabs use it as their tab title). */
  onTitle?: (title: string) => void;
  /** Conversation an editor panel opens with. */
  initialConversationId?: string | null;
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

const META_KEYS = ['conversation', 'isStreaming', 'isLoading', 'error', 'queued', 'approvals', 'question', 'artifacts', 'workingLabel', 'controls', 'notice', 'modelId'] as const;

export class AppHost {
  private views = new Map<string, ViewState>();
  private unsubs: Array<() => void> = [];
  private settings: HostSettings;
  private editorCtx: EditorContextView | null = null;
  /** The view the user interacted with last (VS Code commands deliver chips there). */
  private lastActive: string | null = null;

  constructor(
    private backends: Partial<Record<AgentKind, AgentBackend>>,
    private platform: Platform,
    private log: Logger,
    private store: KeyValueStore,
  ) {
    this.settings = new HostSettings(store);
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

  /** Sends a message to every view. */
  broadcastAll(msg: HostToView) {
    this.broadcast(msg);
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

  /** Agents switched on in Settings → Agents (default: every agent the extension has). */
  private enabledKinds(): AgentKind[] {
    const saved = this.store.get<AgentKind[]>('agents.enabled');
    const registered = AppHost.ALL.filter((k) => this.backends[k]);
    return saved ? registered.filter((k) => saved.includes(k)) : registered;
  }

  private isEnabled(kind: AgentKind): boolean {
    return this.enabledKinds().includes(kind);
  }

  /** Backends that are registered and enabled. */
  private active(): AgentBackend[] {
    return this.enabledKinds().map((k) => this.backends[k]!).filter(Boolean);
  }

  private setEnabled(kinds: AgentKind[]) {
    const next = AppHost.ALL.filter((k) => kinds.includes(k) && this.backends[k]);
    if (!next.length) throw new Error('Keep at least one agent enabled');
    this.store.set('agents.enabled', next);
    for (const k of next) this.backends[k]?.start();
    this.broadcast({ type: 'agents', agents: this.agentStatuses() });
    this.broadcast({ type: 'conversations', conversations: this.allConversations() });
    for (const b of this.active()) this.broadcast({ type: 'models', state: b.models() });
  }

  /** Agent of a new chat: the one picked last (remembered), if still enabled, else the first enabled one. */
  private defaultAgent(): AgentKind {
    const enabled = this.enabledKinds();
    const last = this.settings.defaultAgent(this.platform.defaultAgent());
    return enabled.includes(last) ? last : (enabled[0] ?? 'AGY');
  }

  /** Custom commands (every agent) + the agent's own. */
  private commandsFor(agent: AgentKind) {
    return [...this.settings.slashItems(), ...(this.backendFor(agent)?.commands() ?? [])];
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
      // each card is a section; no headers between them
      const names = this.active().map((b) => b.status().label);
      const sections: SettingsSection[] = [
        { id: 'agents', title: '', items: [{ kind: 'page', id: 'agents', label: 'Agents', icon: 'smart_toy', description: names.join(', ') }] },
        this.settings.chatSection(),
        { id: 'system', title: '', items: [{ kind: 'page', id: 'connection', label: 'Bridge & connection', icon: 'lan', description: `127.0.0.1:${this.platform.bridgeInfo().port}` }] },
      ];
      return { id: 'root', title: 'Settings', sections };
    }
    if (page === 'agents') {
      const labels: Record<AgentKind, string> = { AGY: 'Antigravity', CLAUDE: 'Claude Code', CODEX: 'Codex', OPENCODE: 'OpenCode' };
      const enabled = this.enabledKinds();
      const links = this.active()
        .map((b) => b.settings?.rootItem())
        .filter((s): s is SettingItem => !!s);
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
                values: enabled,
                options: AppHost.ALL.map((k) => ({
                  value: k,
                  label: labels[k],
                  description: this.backends[k] ? (this.backends[k]!.status().detail ?? null) : 'Not available yet',
                })),
              },
            ],
          },
          ...(links.length ? [{ id: 'agent-pages', title: '', items: links }] : []),
          await this.cliLocationsSection(),
        ],
      };
    }
    if (page === 'connection') return this.settings.connectionPage(this.platform.bridgeInfo(), !!this.platform.showLogs);
    if (page === 'agy') {
      // Antigravity page + which agy history the hub uses (host-owned: switching restarts the bridge)
      const p = (await this.backendForPage(page, '')?.settings?.page(page)) ?? { id: page, title: 'Antigravity', sections: [] };
      return { ...p, sections: [...p.sections, this.agyHistorySection()] };
    }
    const own = this.settings.page(page);
    if (own) return own;
    const backend = this.backendForPage(page, '');
    const p = await backend?.settings?.page(page);
    return p ?? { id: page, title: 'Settings', sections: [] };
  }

  /** Antigravity → Chat history: which ~/.gemini/<folder> the hub reads and writes. */
  private agyHistorySection(): SettingsSection {
    const home = process.env.HOME ?? '';
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

  /** Settings → Agents → CLI locations: the detected CLI of each agent, or a path the user sets. */
  private async cliLocationsSection(): Promise<SettingsSection> {
    const labels: Record<AgentKind, string> = { AGY: 'Antigravity CLI path (agy)', CLAUDE: 'Claude Code CLI path (claude)', CODEX: 'Codex CLI path (codex)', OPENCODE: 'OpenCode CLI path (opencode)' };
    const custom = this.store.get<Partial<Record<AgentKind, string>>>('cli.paths') ?? {};
    const found = await this.platform.cliStatus().catch(() => ({}) as Awaited<ReturnType<Platform['cliStatus']>>);
    const items: SettingItem[] = AppHost.ALL.filter((k) => this.backends[k]).map((k) => {
      const f = found[k];
      const detected = f?.installed ? `Found: ${f.path}${f.version ? ` · ${f.version}` : ''}` : 'Not found on this PC';
      return {
        kind: 'text' as const,
        id: `cli.path.${k}`,
        label: labels[k],
        description: custom[k] ? `Using your path. ${detected}` : `${detected}. Leave empty to auto-detect.`,
        value: custom[k] ?? '',
        placeholder: f?.path || `/path/to/${k === 'AGY' ? 'agy' : k.toLowerCase()}`,
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
    try {
      const built = await this.buildSettings(page);
      if (v.settingsPage === page) v.port.post({ type: 'settings', page: built });
    } catch (e) {
      this.toast(v, 'error', e instanceof Error ? e.message : String(e));
    }
  }

  /** Re-sends open settings pages (light: only pages built from cached state — status / usage changes — never the
   *  pages that re-read the hub). */
  private refreshSettings(light = false) {
    const cheap = new Set(['root', 'agents', 'agy', 'claude', 'codex', 'opencode', 'connection', 'slash', 'context']);
    for (const v of this.views.values()) if (v.settingsPage && (!light || cheap.has(v.settingsPage))) void this.postSettings(v);
  }

  /** Project picker: this window's folders, the saved projects, and folders recent chats ran in. */
  private async projects(): Promise<ProjectView[]> {
    const pathOf = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/+$/, '');
    const stats = new Map<string, { lastUsed: number; chats: number }>();
    for (const c of this.allConversations()) {
      if (!c.workspaceUri) continue;
      const p = pathOf(c.workspaceUri);
      const s = stats.get(p) ?? { lastUsed: 0, chats: 0 };
      s.lastUsed = Math.max(s.lastUsed, c.updatedAt);
      s.chats++;
      stats.set(p, s);
    }
    const out = new Map<string, ProjectView>();
    const add = (path: string, name: string, source: ProjectView['source']) => {
      const clean = path.replace(/\/+$/, '') || '/';
      if (out.has(clean)) return;
      const s = stats.get(clean);
      out.set(clean, { name, path: clean, uri: `file://${clean}`, source, lastUsed: s?.lastUsed ?? null, chats: s?.chats ?? 0 });
    };
    for (const f of this.platform.workspaceFolders()) add(f.path, f.name, 'workspace');
    const saved = await this.platform.savedProjects().catch(() => []);
    for (const p of saved) add(p.path, p.name, 'saved');
    // folders chats ran in, when they exist on this machine (a chat started on the phone has a phone path)
    for (const [p] of [...stats].sort((a, b) => b[1].lastUsed - a[1].lastUsed)) {
      let isDir = false;
      try {
        isDir = fs.statSync(p).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir) add(p, p.split('/').filter(Boolean).pop() ?? p, 'recent');
    }
    const rank = { workspace: 0, saved: 1, recent: 2 } as const;
    return [...out.values()].sort((a, b) => rank[a.source] - rank[b.source] || (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  }

  private uiPrefs(): UiPrefs {
    return { theme: 'auto', ...(this.store.get<Partial<UiPrefs>>('ui.prefs') ?? {}) } as UiPrefs;
  }

  private agentStatuses() {
    const all: AgentKind[] = ['AGY', 'CLAUDE', 'OPENCODE', 'CODEX'];
    const labels: Record<AgentKind, string> = { AGY: 'Antigravity', CLAUDE: 'Claude', OPENCODE: 'OpenCode', CODEX: 'Codex' };
    return all.map((k) =>
      this.backends[k] && this.isEnabled(k)
        ? this.backends[k]!.status()
        : { kind: k, label: labels[k], state: 'disabled' as const, detail: this.backends[k] ? 'Turned off in Settings → Agents' : 'Not available yet' },
    );
  }

  private allConversations(): Conversation[] {
    return this.active()
      .flatMap((b) => b.conversations())
      .sort((a, b) => b.updatedAt - a.updatedAt);
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
    });
    v.port.post({ type: 'uiPrefs', prefs: this.uiPrefs() });
    v.port.post({ type: 'editorContext', context: this.editorCtx });
    v.port.post({ type: 'agents', agents: this.agentStatuses() });
    v.port.post({ type: 'conversations', conversations: this.allConversations() });
    for (const b of this.active()) v.port.post({ type: 'models', state: b.models() });
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
    if (!conversationId) return;
    const backend = this.backendFor(agent);
    if (!backend) {
      v.port.post({ type: 'chat', conversationId, patch: { isLoading: false, error: `${agent} chats are not supported yet in the extension.` } });
      return;
    }
    v.unsubscribe = backend.subscribe(conversationId, (state) => this.push(v, conversationId, state));
  }

  private push(v: ViewState, conversationId: string, state: ChatState) {
    if (v.conversationId !== conversationId) return;
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
    try {
      await this.dispatch(v, msg);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.log(`[host] ${msg.type}: ${m}`);
      this.toast(v, 'error', m);
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
        // editor selections travel as text (a hidden block the chat shows as chips); files go to the backend
        const selections = msg.attachments.filter((a) => a.kind === 'selection' || a.selectionText != null);
        const others = msg.attachments.filter((a) => !selections.includes(a));
        const withSel = selections.length ? `${msg.text}${selectionBlock(selections)}` : msg.text;
        await backend.send({
          conversationId: msg.conversationId,
          isNew: msg.isNew,
          text: this.settings.wrap(this.settings.expand(withSel), msg.isNew),
          attachments: others,
          modelId: msg.modelId,
          workspaceUri: msg.workspaceUri ?? this.platform.workspaceFolders()[0]?.uri ?? null,
        });
        return;
      }
      case 'stop':
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
      case 'requestSettings':
        v.settingsPage = msg.page;
        await this.postSettings(v);
        return;
      case 'closeSettings':
        v.settingsPage = null;
        return;
      case 'settingChange': {
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
          const value = String(msg.value ?? '').trim().replace(/^~(?=\/)/, process.env.HOME ?? '~');
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
          this.setEnabled(Array.isArray(msg.value) ? (msg.value as AgentKind[]) : []);
          this.refreshSettings();
          return;
        }
        if (!this.settings.change(msg.page, msg.id, msg.value, msg.rowId)) {
          await this.backendForPage(msg.page, msg.id)?.settings?.change(msg.page, msg.id, msg.value, msg.rowId);
        }
        this.refreshSettings();
        return;
      }
      case 'settingAction': {
        let result: string | void | null = null;
        if (msg.id === 'conn.restart' || msg.id === 'cli.apply') {
          await this.platform.restartBridge();
          for (const b of this.active()) b.retry();
          result = 'Bridge restarted';
        } else if (msg.id === 'conn.logs') {
          this.platform.showLogs?.();
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
        for (const b of this.active()) b.retry();
        return;
      case 'toolAction':
        await this.backendFor(this.agentOf(msg.conversationId) ?? v.agent)?.toolAction?.(msg.conversationId, msg.toolId, msg.action);
        return;
      case 'setQuotaGroup':
        this.backendFor(msg.agent)?.setQuotaGroup?.(msg.modelId, msg.group);
        return;
      case 'readImage': {
        let dataUrl: string | null = null;
        try {
          const p = msg.path.replace(/^file:\/\//, '');
          const st = fs.statSync(p);
          const mime = IMAGE_MIME[path.extname(p).slice(1).toLowerCase()];
          if (mime && st.size <= 8 * 1024 * 1024) dataUrl = `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
        } catch {
          dataUrl = null;
        }
        v.port.post({ type: 'imageData', reqId: msg.reqId, dataUrl });
        return;
      }
      case 'resolveDrop': {
        const paths = msg.uris
          .map((u) => u.trim())
          .filter(Boolean)
          .map((u) => {
            try {
              return u.startsWith('file:') ? decodeURIComponent(new URL(u).pathname) : u.startsWith('/') ? u : null;
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
        await this.platform.saveCopy(msg.path.replace(/^file:\/\//, ''));
        return;
      case 'setControl':
        await this.backendFor(msg.agent)?.setControl?.(msg.conversationId, msg.id, msg.value);
        return;
      case 'requestProjects':
        v.port.post({ type: 'projects', reqId: msg.reqId, projects: await this.projects() });
        return;
      case 'pickFolder': {
        const p = await this.platform.pickFolder();
        if (p) await this.platform.saveProject(p).catch(() => undefined);
        const project: ProjectView | null = p ? { name: p.split('/').filter(Boolean).pop() ?? p, uri: `file://${p}`, path: p, source: 'saved' } : null;
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
        const prompt = await b.rewind(msg.conversationId, msg.messageId, msg.restoreFiles === true);
        // rewinding the first prompt deletes the chat (as in the app): continue on a new chat with that prompt
        if (v.conversationId === msg.conversationId && !b.conversations().some((c) => c.id === msg.conversationId)) this.show(v, null, b.kind);
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
    if (action === 'delete') {
      if (!(await this.platform.confirm('Delete this chat? This cannot be undone.'))) return;
    }
    let arg = value;
    if (action === 'rename' && !arg) {
      const current = backend.conversations().find((c) => c.id === id)?.title ?? '';
      arg = await this.platform.prompt('Rename chat', current);
      if (!arg) return;
    }
    const res = await backend.conversationAction(id, action as 'delete' | 'fork' | 'rename' | 'archive' | 'unarchive', arg);
    if (action === 'delete' && v.conversationId === id) this.show(v, null, v.agent);
    if (action === 'fork' && typeof res === 'string' && res) this.show(v, res, backend.kind);
  }

  dispose() {
    for (const v of this.views.values()) v.unsubscribe?.();
    this.views.clear();
    this.unsubs.forEach((u) => u());
    for (const b of Object.values(this.backends)) b?.dispose();
  }
}
