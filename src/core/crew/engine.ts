// The Crew in the extension host (docs/crew/PLAN.md Phase 1): the Crew screen's bots (create, edit, SOUL.md, delete),
// each bot's DM (a normal chat of its agent, drawn with its face, every message sent with its crew setup), rooms
// (on the crew's files: rooms/) and the crew turns crew_mcp answers for.
// This file wires the parts together; the work is in bots.ts, dms.ts, botTurns.ts, turnMemory.ts, views.ts, actions.ts.
import fs from 'node:fs';
import type { AgentKind, Conversation } from '../../../shared/model';
import type { AutomationView, CrewStateView, CrewStatusView, HostToView, ViewToHost } from '../../../shared/protocol';
import type { McpServerDef } from '../mcp/server';
import type { AgentBackend, SendRequest } from '../types';
import { CrewActions } from './actions';
import { Automations } from './automations/runner';
import { BotTurns } from './botTurns';
import { CrewBots, ENGINES } from './bots';
import { Chief, type ChiefRooms } from './chief';
import { Crew } from './crew';
import { CrewDms } from './dms';
import { CrewInbox } from './inbox';
import { JobRuntime } from './jobs/runtime';
import { jobsView } from './jobs/view';
import { BotLocks } from './locks';
import { crewAdminMcp } from './mcp/admin';
import { BotMemory } from './memory/memory';
import { CrewRoomStore } from './rooms/store';
import type { CrewTurn, RoomCrewApi } from './rooms/types';
import { CrewSharing } from './sharing';
import { migrateGroups, migrateSchema } from './store/migrate';
import { normalizeBot } from './store/store';
import { TurnMemory } from './turnMemory';
import type { TurnResult } from './turns/runner';
import type { BotProfile, CrewAccess, ThreadRecord } from './types';
import { automationsStateOf, crewStateOf } from './views';

// memory capture's timing lives with it (turnMemory.ts); tests shorten it through this export
export { MEMORY_TIMING } from './turnMemory';

/** What the Crew needs from the host (AppHost.attachCrew). */
export interface CrewEngineApi {
  backend(kind: AgentKind): AgentBackend | undefined;
  enabledKinds(): AgentKind[];
  defaultAgent(): AgentKind;
  workspaceFolder(): string | null;
  /** Shows a chat in the view used last. */
  showChat(conversationId: string, agent: AgentKind): void;
  postActive(msg: HostToView): void;
  /** Chat rows changed (a DM's face): send the chat list again. */
  refreshConversations(): void;
  pickFolder(): Promise<string | null>;
  confirm(message: string, action?: string): Promise<boolean>;
  openFile(path: string): void;
  openUrl?(url: string): void;
  /** Antigravity: whether a chat runs (its state may lag). */
  isRunning?(kind: AgentKind, conversationId: string): boolean;
  /** A toast with an Open button (or a desktop notification when VS Code is not focused). */
  notify?(text: string, open: () => void): void;
  /** Save text with a save dialog (a crew package). */
  saveText?(suggestedName: string, content: string): Promise<void>;
  /** This window does not run the crew (another window owns the MCP port). */
  notLeader?(): boolean;
  /** The status bar line ("Crew: 2 working · 1 needs you"; null = hidden). */
  status?(s: CrewStatusView, text: string | null): void;
  log(line: string): void;
}

export interface CrewEngineOptions {
  mcpUrl(path: string): string;
  mcpHeaders(): Record<string, string>;
  /** ~/.antigem/crew (tests: a temp folder). */
  root?: string;
  /** ~/.antigem/groups (copied into rooms once). */
  groupsDir?: string;
}

type CrewViewMsg = Extract<ViewToHost, { type: 'crewWatch' | 'crewAction' | 'jobsWatch' | 'jobAction' | 'inboxWatch' | 'inboxAnswer' | 'automationsWatch' | 'automationAction' }>;

export class CrewEngine {
  readonly crew: Crew;
  readonly rooms: CrewRoomStore;
  /** One turn at a time per bot, crew-wide (rooms and jobs wait; DMs mark it). */
  readonly locks = new BotLocks();
  /** Jobs: crew_assign & co., the wake lane, Mission Control. */
  readonly jobs: JobRuntime;
  /** The Inbox: what needs the user (approvals the broker could not settle, job questions / failures, setup). */
  readonly inbox: CrewInbox;
  /** The Chief: crew_manage, its Problems thread. */
  readonly chief: Chief;
  /** Automations: schedules, editor events, webhooks, waits, check-backs. */
  readonly automations: Automations;
  /** Bots' memory (MEMORY.md, topics, About you). */
  readonly memory: BotMemory;
  /** Crew packages: import (library, GitHub, OpenMausBot), export. */
  readonly sharing: CrewSharing;

  /** Set by the host: room operations the Chief may use (the RoomEngine). */
  roomsHook: ChiefRooms | null = null;
  /** Set by the host: a member's line in a room without a turn (an automation's result). */
  roomPost: ((roomId: string, botId: string, text: string, label: string) => void) | null = null;
  /** Set by the host: a room member answers in its room with its job reports (the RoomEngine runs it). */
  roomReport: ((roomId: string, botId: string, text: string) => Promise<string | null>) | null = null;
  /** Set by the host: a line in a room for the user only. */
  roomNote: ((roomId: string, text: string) => void) | null = null;
  /** Set by the host: paused bots' room turns stop (the RoomEngine). */
  onPause: ((botIds: string[]) => void) | null = null;
  /** Set by the host: removes a bot from the rooms it sits in (the RoomEngine owns the rooms). */
  removeFromRooms: ((botId: string) => void) | null = null;
  /** Set by the host: a bot changed here, the rooms read it again (the RoomEngine keeps them in memory). */
  onRoomsChanged: (() => void) | null = null;

  private api: CrewEngineApi | null = null;
  private views = new Map<string, (m: HostToView) => void>();
  /** Mission Control views. */
  private jobViews = new Map<string, (m: HostToView) => void>();
  private autoViews = new Map<string, (m: HostToView) => void>();
  private emitTimer: NodeJS.Timeout | null = null;
  private chatsStale = false;
  private watcher: fs.FSWatcher | null = null;
  private tidyTimers: NodeJS.Timeout[] = [];

  // the engine's own parts: each gets the engine and its host (set in bind)
  private readonly dms = new CrewDms(this, () => this.api);
  private readonly bots = new CrewBots(this, () => this.api, this.dms);
  private readonly turns = new BotTurns(this, () => this.api);
  private readonly turnMemory = new TurnMemory(this, () => this.api);
  private readonly actions = new CrewActions(this, () => this.api);

  constructor(opts: CrewEngineOptions) {
    this.crew = new Crew(
      {
        backend: (k) => this.api?.backend(k),
        mcpUrl: (p) => opts.mcpUrl(p),
        mcpHeaders: () => opts.mcpHeaders(),
        userName: () => 'the user',
      },
      opts.root,
    );
    try {
      migrateSchema(this.crew.store);
    } catch (e) {
      this.log(`[crew] ${errText(e)}`);
    }
    // Group chats become rooms: copied once (the groups folder is left as it was), then the engine runs on rooms
    try {
      const m = migrateGroups(this.crew.store, opts.groupsDir);
      if (m.rooms.length) this.log(`[crew] Group chats copied into rooms: ${m.rooms.length} rooms, ${m.bots.length} bots`);
    } catch (e) {
      this.log(`[crew] could not copy the Group chats: ${errText(e)}`);
    }
    this.rooms = new CrewRoomStore(this.crew.store);
    this.memory = new BotMemory(this.crew.store.root);
    this.crew.memory = this.memory;
    this.jobs = new JobRuntime(this.crew, this.locks, {
      backend: (k) => this.api?.backend(k),
      workspaceFolder: () => this.api?.workspaceFolder() ?? null,
      isRunning: (k, id) => this.api?.isRunning?.(k, id) ?? false,
      userName: () => 'the user',
      roomTurn: (roomId, botId, text) => this.roomReport?.(roomId, botId, text) ?? Promise.resolve(null),
      roomNote: (roomId, text) => this.roomNote?.(roomId, text),
      changed: (chats) => {
        this.changed(chats === true);
        this.inbox.emit();
      },
      approve: (botId, a, where, folders, chat, access) => this.inbox.broker.approve({ botId, access, approval: a, folders, where, chat }),
      isPaused: (botId) => this.isPaused(botId),
      cheapTurn: (engine, text) => this.cheap(engine, text),
      recall: (botId, text) => this.recall(botId, text),
      onTurnDone: (botId, where, ask, reply) => this.noteTurn(botId, where, ask, reply),
      onFailed: (j) => this.chief.problem(j),
      notify: (text, open) => this.api?.notify?.(text, open),
      checkWork: (j, b) => this.turns.checkWork(j, b),
      overBudget: () => this.crew.usage.overBudget(),
      log: (l) => this.log(l),
    });
    this.crew.jobs = this.jobs;
    this.inbox = new CrewInbox({
      store: this.crew.store,
      jobs: () => this.jobs,
      locks: this.locks,
      showChat: (id, engine) => this.api?.showChat(id, engine),
      notify: (text, open) => this.api?.notify?.(text, open),
      status: (st, text) => this.api?.status?.(st, text),
      openCrew: () => this.api?.postActive({ type: 'crewNavigate', botId: null }),
      changed: () => this.changed(false),
    });
    this.locks.onChange = () => {
      this.changed(false);
      this.inbox.emit();
    };
    // Antigravity bots: its crew server goes into its mcp_config.json only after the user said yes
    this.crew.onAgyAsk = () => this.inbox.askAgyServer();
    this.chief = new Chief({
      crew: this.crew,
      locks: this.locks,
      jobs: () => this.jobs,
      backend: (k) => this.api?.backend(k),
      workspaceFolder: () => this.api?.workspaceFolder() ?? null,
      isRunning: (k, id) => this.api?.isRunning?.(k, id) ?? false,
      createBot: (f) => this.createBot(f),
      updateBot: (id, f) => this.updateBot(id, f),
      removeBot: (id) => this.removeBotNow(id),
      rooms: () => this.roomsHook,
      approve: (botId, access, a, chat) => {
        const b = this.store.bot(botId);
        return this.inbox.broker.approve({ botId, access, approval: a, folders: b ? this.foldersOf(b, access) : [], where: 'in its Problems thread', chat });
      },
      folders: (b, access) => this.foldersOf(b, access),
      notify: (text, open) => this.api?.notify?.(text, open),
      showChat: (id, engine) => this.api?.showChat(id, engine),
      changed: () => this.changed(true),
      log: (l) => this.log(l),
    });
    this.crew.chief = this.chief;
    this.automations = new Automations({
      crew: this.crew,
      locks: this.locks,
      isPaused: (id) => this.isPaused(id),
      runOnThread: (t, text, where, o) => this.runOnThread(t, text, where, o),
      roomPost: (roomId, botId, text, label) => this.roomPost?.(roomId, botId, text, label),
      roomTurn: (roomId, botId, text) => this.roomReport?.(roomId, botId, text) ?? Promise.resolve(null),
      ask: (f) => {
        const q = this.inbox.broker.ask({ kind: 'question', botId: f.botId, title: f.title, why: f.why, detail: f.detail, tool: null, key: null, outward: false, risk: null, chat: null, inChat: false, choices: ['answer', 'dismiss'] });
        return { promise: q.promise, cancel: q.cancel };
      },
      notify: (text, open) => this.api?.notify?.(text, open ?? (() => this.api?.postActive({ type: 'crewNavigate', botId: null }))),
      showChat: (id, engine) => this.api?.showChat(id, engine),
      onFailed: (a, why) => this.log(`[crew] automation ${a.name} failed: ${why}`),
      changed: () => this.changed(false),
      log: (l) => this.log(l),
      webhookPort: () => this.store.settings().webhookPort,
    });
    this.crew.automations = this.automations;
    this.sharing = new CrewSharing({
      store: this.crew.store,
      memory: this.memory,
      automations: this.automations,
      chief: this.chief,
      createBot: (f) => this.createBot(f),
      rooms: () => this.roomsHook,
      enabledKinds: () => this.api?.enabledKinds() ?? ENGINES,
      defaultAgent: () => this.api?.defaultAgent() ?? 'CLAUDE',
    });
  }

  bind(api: CrewEngineApi) {
    this.api = api;
    this.automations.start();
    // notes past their "until" day go (daily)
    const tidy = () => {
      for (const b of this.store.bots()) this.memory.expire(b.id);
    };
    this.tidyTimers = [setTimeout(tidy, 10_000), setInterval(tidy, 12 * 3600_000)];
  }

  dispose() {
    this.dms.dispose();
    this.jobs.dispose();
    this.inbox.dispose();
    this.automations.dispose();
    for (const t of this.tidyTimers) clearTimeout(t);
    this.turnMemory.dispose();
    this.watcher?.close();
    if (this.emitTimer) clearTimeout(this.emitTimer);
  }

  /** crew_admin for the MCP host (/crew-admin): Jarvis and other chats drive the crew from outside. */
  adminMcp(): McpServerDef {
    return crewAdminMcp(this, () => (this.api?.notLeader?.() ? 'The crew runs in another VS Code window' : null));
  }

  /** Writes rooms the room engine has not saved yet (outside readers see them at once). */
  flushRooms() {
    this.rooms.flush();
  }

  async stopChat(engine: AgentKind, chatId: string) {
    await this.api?.backend(engine)?.stop(chatId).catch(() => undefined);
  }

  // ------------------------------------------------------------------ bots (bots.ts)

  createBot(d: Record<string, unknown>): BotProfile {
    return this.bots.createBot(d);
  }

  updateBot(id: string, d: Record<string, unknown>): BotProfile {
    return this.bots.updateBot(id, d);
  }

  /** Deletes a bot without asking (the Chief's Undo of a bot it made). */
  removeBotNow(id: string) {
    this.bots.removeBotNow(id);
  }

  deleteBot(id: string): Promise<string | void> {
    return this.bots.deleteBot(id);
  }

  /** The bot (or everyone) is paused: no room turns, no jobs. */
  isPaused(botId: string): boolean {
    return this.store.settings().paused || !!this.store.bot(botId)?.paused;
  }

  // ------------------------------------------------------------------ DMs (dms.ts)

  /** A bot's DM thread with a chat (made when it has none yet; it shows with the bot's face). */
  ensureDm(botId: string): ThreadRecord {
    return this.dms.ensureDm(botId);
  }

  /** Opens the bot's DM, or an empty chat of its agent that becomes its DM with the first message. */
  openDm(botId: string) {
    this.dms.openDm(botId);
  }

  /** Crew DMs carry their bot's face (and stay out of the chat list); job work threads are hidden bot chats. */
  decorate(list: Conversation[]): Conversation[] {
    return this.dms.decorate(list);
  }

  isCrewChat(conversationId: string): boolean {
    return this.dms.isCrewChat(conversationId);
  }

  /** A message from the chat view: a crew DM's goes with its bot's setup and its turn is tracked; others pass unchanged. */
  prepareSend(req: SendRequest, agent: AgentKind, crewThread: string | null | undefined): SendRequest {
    return this.dms.prepareSend(req, agent, crewThread);
  }

  /** Folders a bot's edits may change without asking: its work folder (or the open project), its own crew folder. */
  foldersOf(b: BotProfile, access: CrewAccess, extra: (string | null | undefined)[] = []): string[] {
    return this.dms.foldersOf(b, access, extra);
  }

  // ------------------------------------------------------------------ turns and memory (botTurns.ts, turnMemory.ts)

  /** A turn on a crew thread as its bot (automation runs, check-backs, asking a bot from the Automations page). Null = it stayed busy. */
  runOnThread(t: ThreadRecord, text: string, where: string, opts: { timeoutMs: number; waitMs: number; isNew?: boolean }): Promise<TurnResult | null> {
    return this.turns.runOnThread(t, text, where, opts);
  }

  /** One question to an engine's cheapest model (the goal judge, memory capture). */
  cheap(engine: AgentKind, text: string): Promise<string> {
    return this.turns.cheap(engine, text);
  }

  /** Notes a bot recalls for a turn's text, as a hidden block ('' = nothing matches, or memory is off). */
  recall(botId: string, text: string): string {
    return this.turnMemory.recall(botId, text);
  }

  /** A bot answered: kept for memory capture (after 2 min of quiet, or 6 turns, a quick model files new facts). */
  noteTurn(botId: string, where: string, ask: string, reply: string) {
    this.turnMemory.noteTurn(botId, where, ask, reply);
  }

  // ------------------------------------------------------------------ views (views.ts, actions.ts)

  async handle(viewId: string, post: (m: HostToView) => void, msg: CrewViewMsg): Promise<string | void> {
    if (msg.type === 'jobsWatch') {
      if (msg.open) {
        this.jobViews.set(viewId, post);
        post({ type: 'jobsState', jobs: this.jobsState() });
      } else this.jobViews.delete(viewId);
      return;
    }
    if (msg.type === 'jobAction') return this.actions.jobAction(msg.action, msg.jobId, (msg.data ?? {}) as Record<string, unknown>);
    if (msg.type === 'inboxWatch') {
      this.inbox.watch(viewId, post, msg.open);
      return;
    }
    if (msg.type === 'inboxAnswer') return this.inbox.answer(msg.id, msg.choice, msg.note);
    if (msg.type === 'automationsWatch') {
      if (msg.open) {
        this.autoViews.set(viewId, post);
        post({ type: 'automationsState', automations: this.automationsState() });
      } else this.autoViews.delete(viewId);
      return;
    }
    if (msg.type === 'automationAction') return this.actions.automationAction(msg.action, msg.id ?? '', (msg.data ?? {}) as Record<string, unknown>);
    if (msg.type === 'crewWatch') {
      if (msg.open) {
        this.views.set(viewId, post);
        this.watchFiles();
        post({ type: 'crewState', crew: this.state() });
      } else this.views.delete(viewId);
      return;
    }
    return this.actions.crewAction(post, msg);
  }

  forgetView(viewId: string) {
    this.views.delete(viewId);
    this.jobViews.delete(viewId);
    this.autoViews.delete(viewId);
    this.inbox.forget(viewId);
  }

  state(): CrewStateView {
    return crewStateOf(this);
  }

  /** Mission Control. */
  jobsState() {
    return jobsView(this.jobs.store.all(), this.store.bots(), this.store.rooms());
  }

  automationsState(): AutomationView[] {
    return automationsStateOf(this);
  }

  /** The bots / settings changed: the Crew screens and chat faces update (≤ 4/s). */
  changed(chats = true) {
    if (chats) this.chatsStale = true;
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (this.views.size) {
        const s = this.state();
        for (const post of this.views.values()) post({ type: 'crewState', crew: s });
      }
      if (this.jobViews.size) {
        const j = this.jobsState();
        for (const post of this.jobViews.values()) post({ type: 'jobsState', jobs: j });
      }
      if (this.autoViews.size) {
        const a = this.automationsState();
        for (const post of this.autoViews.values()) post({ type: 'automationsState', automations: a });
      }
      if (this.chatsStale) {
        this.chatsStale = false;
        this.api?.refreshConversations();
      }
    }, 250);
  }

  /** SOUL.md edited in an editor tab, a bot changed by another window or the app: the screen follows. */
  private watchFiles() {
    if (this.watcher) return;
    try {
      fs.mkdirSync(this.store.root, { recursive: true });
      this.watcher = fs.watch(this.store.root, { recursive: true }, (_e, file) => {
        const f = String(file ?? '');
        if (f.startsWith('bots') || f === 'crew.json') this.changed();
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      /* no recursive watch here: the screen refreshes on its own actions */
    }
  }

  // ------------------------------------------------------------------ rooms

  /** What the room engine gets from the crew. */
  roomApi(): RoomCrewApi {
    return {
      turn: (roomId, botId, chatId) => this.roomTurn(roomId, botId, chatId),
      lock: (botId, where, opts) => this.locks.acquire(botId, where, opts),
      learn: (botId, words) => {
        const b = this.store.bot(botId);
        if (!b) return;
        this.store.putBot(normalizeBot({ ...b, aliases: [...b.aliases, ...words] }, botId));
        this.changed();
      },
      bot: (id) => this.store.bot(id),
      bots: () => this.store.bots(),
      createBot: (fields) => this.createBot(fields),
      updateBot: (id, fields) => this.updateBot(id, fields),
      logUsage: (entry) => this.store.logUsage(entry),
      approve: (botId, a, where, folder, chat, access) => {
        const b = this.store.bot(botId);
        return this.inbox.broker.approve({ botId, access, approval: a, folders: b ? this.foldersOf(b, access, [folder]) : [folder], where, chat });
      },
      recall: (botId, text) => this.recall(botId, text),
      turnDone: (botId, where, ask, reply) => this.noteTurn(botId, where, ask, reply),
      isPaused: (botId) => this.isPaused(botId),
      overBudget: () => this.crew.usage.overBudget(),
    };
  }

  /** A room member's turn: its room thread, set up as the crew bot, answering while the turn runs. */
  roomTurn(groupId: string, botId: string, chatId: string): CrewTurn | null {
    if (!this.store.bot(botId)) return null;
    const t = this.rooms.threadOf(groupId, botId, chatId);
    const setup = this.crew.setupFor(t);
    this.crew.identity.beginTurn(t.id);
    this.changed();
    return {
      setup,
      end: () => {
        this.crew.identity.endTurn(t.id);
        this.jobs.turnEnded(t.id);
        this.changed();
      },
    };
  }

  private log(line: string) {
    this.api?.log(line);
  }

  private get store() {
    return this.crew.store;
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
