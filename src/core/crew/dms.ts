// Each bot's DM (engine.ts): a normal chat of its agent, drawn with the bot's face, every message sent with its crew
// setup; its turn is tracked until the chat settles (crew_mcp answers only then; memory capture and usage after it).
import type { AgentKind, Conversation, CrewChatTag } from '../../../shared/model';
import { pathToUri } from '../paths';
import type { ChatState, SendRequest } from '../types';
import { needBot } from './bots';
import type { CrewEngine, CrewEngineApi } from './engine';
import { softNote } from './engines/caps';
import { effectiveAccess } from './engines/setup';
import { newId } from './store/store';
import { countUsers, lastTurnUsage } from './turns/runner';
import type { BotProfile, CrewAccess, ThreadRecord } from './types';

/** A DM turn that never showed any work is over after this long (the send failed, the agent is down). */
const START_TIMEOUT_MS = 120_000;

export class CrewDms {
  /** DM turns being watched until they settle (thread id → stop). */
  private tracking = new Map<string, () => void>();

  constructor(
    private e: CrewEngine,
    private api: () => CrewEngineApi | null,
  ) {}

  private get store() {
    return this.e.crew.store;
  }

  dmThread(botId: string): ThreadRecord | null {
    return this.store.threads().find((t) => t.kind === 'dm' && t.botId === botId) ?? null;
  }

  /** A bot's DM thread with a chat (made when it has none yet; it shows with the bot's face). */
  ensureDm(botId: string): ThreadRecord {
    const b = needBot(this.store, botId);
    let t = this.dmThread(b.id);
    const now = Date.now();
    if (!t || t.engine !== b.engine) {
      t = { id: t?.id ?? newId('t'), botId: b.id, engine: b.engine, chatId: null, kind: 'dm', roomId: null, jobId: null, seen: 0, setupKey: null, createdAt: now, updatedAt: now };
      this.store.putThread(t);
    }
    return t;
  }

  /** Opens the bot's DM, or an empty chat of its agent that becomes its DM with the first message. */
  openDm(botId: string) {
    const b = needBot(this.store, botId);
    const now = Date.now();
    let t = this.dmThread(botId);
    if (!t) {
      t = { id: newId('t'), botId, engine: b.engine, chatId: null, kind: 'dm', roomId: null, jobId: null, seen: 0, setupKey: null, createdAt: now, updatedAt: now };
      this.store.putThread(t);
    }
    if (t.chatId && t.engine === b.engine) {
      this.api()?.showChat(t.chatId, t.engine);
      return;
    }
    this.api()?.postActive({ type: 'crewDm', agent: b.engine, tag: this.tag(b, t), modelId: b.model });
  }

  private tag(b: BotProfile, t: ThreadRecord): CrewChatTag {
    const eff = effectiveAccess(b, this.store.settings());
    return { botId: b.id, threadId: t.id, name: b.name, title: b.title, emoji: b.emoji, color: b.color, access: eff, softNote: softNote(b.engine, eff) };
  }

  /** The DM a chat is (null = not a crew DM). */
  private dmOfChat(conversationId: string): ThreadRecord | null {
    return this.store.threads().find((t) => t.kind === 'dm' && t.chatId === conversationId) ?? null;
  }

  /** Crew DMs carry their bot's face (and stay out of the chat list); job work threads are hidden bot chats. */
  decorate(list: Conversation[]): Conversation[] {
    const mine = this.store.threads().filter((t) => t.kind !== 'room' && t.kind !== 'router' && t.chatId);
    if (!mine.length) return list;
    const byChat = new Map(mine.map((t) => [t.chatId!, t]));
    const bots = new Map(this.store.bots().map((b) => [b.id, b]));
    return list.map((c) => {
      const t = byChat.get(c.id);
      const b = t?.botId ? bots.get(t.botId) : undefined;
      if (!t || !b) return c;
      if (t.kind !== 'dm') return { ...c, groupBot: true, title: `${b.emoji} ${b.name} · ${t.kind === 'problems' ? 'Problems' : t.kind}` };
      return { ...c, crew: this.tag(b, t), title: `${b.emoji} ${b.name}` };
    });
  }

  isCrewChat(conversationId: string): boolean {
    return !!this.dmOfChat(conversationId);
  }

  /**
   * A message from the chat view: a crew DM's (its first one names the thread; later ones are found by chat id) goes
   * with the bot's setup, on its model / folder when it starts the chat, and its turn is tracked so its crew tools
   * answer. Other chats pass unchanged.
   */
  prepareSend(req: SendRequest, agent: AgentKind, crewThread: string | null | undefined): SendRequest {
    let t = crewThread ? this.store.thread(crewThread) : this.dmOfChat(req.conversationId);
    if (!t || !t.botId) return req;
    const b = this.store.bot(t.botId);
    if (!b) return req;
    if (crewThread && t.chatId !== req.conversationId) {
      t = { ...t, chatId: req.conversationId, engine: agent };
      this.store.putThread(t);
      this.e.changed();
    }
    const setup = this.e.crew.setupFor(t);
    if (t.setupKey !== setup.key) this.store.putThread({ ...t, setupKey: setup.key });
    // the user talks to the bot itself: its standing goal waits (Resume in Mission Control)
    this.e.jobs.pauseGoalsOf(b.id);
    const recall = this.e.recall(b.id, req.text);
    const out: SendRequest = { ...req, setup, ...(recall ? { text: `${recall}\n\n${req.text}` } : {}) };
    if (req.isNew) {
      out.modelId = b.model ?? req.modelId;
      if (b.effort !== 'default') out.effort = b.effort;
      const folder = setup.access === 'talk' || setup.access === 'read' ? this.store.botFolder(b.id) : (b.folder ?? null);
      if (folder) out.workspaceUri = pathToUri(folder);
    }
    this.trackTurn(t);
    return out;
  }

  /** Folders a bot's edits may change without asking: its work folder (or the open project), its own crew folder. */
  foldersOf(b: BotProfile, access: CrewAccess, extra: (string | null | undefined)[] = []): string[] {
    const own = this.store.botFolder(b.id);
    const work = access === 'talk' || access === 'read' ? null : (b.folder ?? this.api()?.workspaceFolder() ?? null);
    return [...new Set([own, work, ...extra].filter((x): x is string => !!x))];
  }

  /** Marks the thread as answering until its chat settles (crew_mcp answers only then). */
  private trackTurn(t: ThreadRecord) {
    const be = t.chatId ? this.api()?.backend(t.engine) : undefined;
    if (!be || !t.chatId) return;
    this.tracking.get(t.id)?.();
    this.e.crew.identity.beginTurn(t.id);
    const unlock = t.botId ? this.e.locks.mark(t.botId, 'its DM') : () => undefined;
    // its permission requests: by its level and your rules, else the Inbox (the card stays in the chat too)
    const bot = t.botId ? this.store.bot(t.botId) : null;
    const access = bot ? this.e.crew.setupFor(t).access : 'edit';
    const asks = bot ? this.e.inbox.dmTurn(t, be, bot, access, this.foldersOf(bot, access)) : null;
    let state: ChatState | null = null;
    const unsub = be.subscribe(t.chatId, (s) => (state = s));
    const started = Date.now();
    // a turn too quick to be seen streaming still counts once its reply is there
    let usersBefore = -1;
    try {
      usersBefore = countUsers(be.getState(t.chatId));
    } catch {
      /* not loaded: only streaming counts */
    }
    let ran = false;
    let quiet = 0;
    const stop = () => {
      clearInterval(timer);
      unsub();
      asks?.stop();
      unlock();
      // what was said, for memory capture
      const st = state as ChatState | null;
      if (bot && st && ran) {
        const users = st.messages.filter((m) => m.role === 'USER');
        const ask = (users[users.length - 1]?.content ?? '').replace(/<antigem-expansion[^>]*>[\s\S]*?<\/antigem-expansion>/g, ' ').trim();
        const reply = st.messages.slice(st.messages.lastIndexOf(users[users.length - 1]) + 1).filter((m) => m.role === 'ASSISTANT').map((m) => m.content).join('\n').replace(/<!--[\s\S]*?-->/g, ' ').trim();
        if (reply) this.e.noteTurn(bot.id, 'DM', ask, reply);
        this.e.crew.usage.log(bot.id, 'dm', lastTurnUsage(st.messages));
      }
      this.e.crew.identity.endTurn(t.id);
      this.e.jobs.turnEnded(t.id);
      if (this.tracking.get(t.id) === stop) this.tracking.delete(t.id);
      this.e.changed();
    };
    const timer = setInterval(() => {
      const s = state as ChatState | null;
      asks?.poll(s);
      const running = t.engine === 'AGY' && !!be.conversations().find((c) => c.id === t.chatId)?.isRunning;
      if (s?.isStreaming || s?.approvals.length || s?.question || running) {
        ran = true;
        quiet = 0;
        return;
      }
      if (!ran && s && usersBefore >= 0 && countUsers(s) > usersBefore && s.messages[s.messages.length - 1]?.role === 'ASSISTANT') ran = true;
      if (!ran && Date.now() - started < START_TIMEOUT_MS) return;
      quiet ||= Date.now();
      if (!ran || Date.now() - quiet > 2000) stop();
    }, 500);
    this.tracking.set(t.id, stop);
    this.e.changed();
  }

  /** Stops watching every DM turn (the engine is going away). */
  dispose() {
    for (const stop of this.tracking.values()) stop();
  }
}
