// The room engine's base: the screens it feeds (list, room, messages), the rooms' settings and members (crew bots), and
// each room's runtime. Talking and scheduling are in engine.ts (RoomEngine extends this).
import { randomUUID } from 'node:crypto';
import type { AgentKind } from '../../../../shared/model';
import type { GroupSummaryView, GroupView, HostToView } from '../../../../shared/protocol';
import type { BotProfile, CrewAccess, PickBy } from '../types';
import { clamp } from '../store/legacyGroups';
import * as P from './prompts';
import { roomView, msgView, summaryView } from './view';
import type { Bot, Group, GroupStoreLike, GroupsHooks, GroupsHostApi, GroupViewMsg, Msg, Reason, RoomCrewApi, RoomMode } from './types';

export const AGENTS: AgentKind[] = ['AGY', 'CLAUDE', 'OPENCODE', 'CODEX'];
const MODES: RoomMode[] = ['auto', 'mentions', 'lead', 'everyone', 'moderator'];
export const shortId = () => randomUUID().replace(/-/g, '').slice(0, 10);
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const TO_CREW_ACCESS: Record<string, CrewAccess> = { chat: 'talk', read: 'read', edit: 'edit' };
const TO_GROUP_ACCESS = (a: CrewAccess): Bot['access'] => (a === 'talk' ? 'chat' : a === 'read' ? 'read' : 'edit');

export interface Turn {
  botId: string | null; // null = the router / moderator
  chatId: string;
  agent: AgentKind;
  cancelled: boolean;
}

export interface QItem {
  botId: string;
  reason: Reason;
  picked: { by: PickBy; why?: string };
  /** Added to its turn text (a job report). */
  extra?: string;
  /** Told what it posted (null = nothing): a job waits for its report turn. */
  done?: (text: string | null) => void;
  /** A room-goal turn: the lead's (ends with a control block) or a member's step. */
  goal?: 'lead' | 'member';
}

/** Queue items dropped without a turn: whoever waits on them hears "nothing". */
export function dropItems(items: QItem[]) {
  for (const q of items) q.done?.(null);
}

/** A message of the user's sent while a member speaks: it waits (shown above the composer) and goes with the next turn. */
export interface Pending {
  id: string;
  text: string;
  attachments: Msg['attachments'];
  replyTo: string | null;
}

export interface Runtime {
  queue: QItem[];
  /** The moderator should pick the next speaker once the queue is empty. */
  moderate: boolean;
  running: boolean;
  turns: Set<Turn>;
  typing: Map<string, { activity: 'typing' | 'working' | 'waiting'; step: string | null }>;
  status: string | null;
  idle: NodeJS.Timeout | null;
  /** Auto-talk nudges in a row that the bot passed on (3 = stop until the user writes). */
  nudgePasses: number;
  pending: Pending[];
  /** The user's lines posted but not routed yet. */
  toRoute: Msg[];
  /** This round (from the user's last message): turns per member, bot-to-bot @mention hops. */
  round: { turns: Map<string, number>; hops: number };
  /** The last auto / router pick (learning: the user re-asks someone else right after). */
  lastAuto: { text: string; botId: string; at: number; lineId: string } | null;
  routerBusy: boolean;
  /** Lead goal turns in a row without a control line (2 = the goal stops). */
  goalMisses: number;
}

interface ViewWatch {
  post: (m: HostToView) => void;
  groupId: string | null;
  open: boolean;
}

export interface CreateInput {
  title: string;
  topic?: string;
  userName?: string;
  mode?: string;
  maxBotTurns?: number;
  autoTalk?: boolean;
  idleSeconds?: number;
  template?: string | null;
  bots?: Partial<Bot>[];
}

export abstract class RoomCore implements GroupsHooks {
  protected api!: GroupsHostApi;
  readonly store: GroupStoreLike;
  protected rts = new Map<string, Runtime>();
  protected views = new Map<string, ViewWatch>();
  private botChats = new Set<string>();
  private listTimer: NodeJS.Timeout | null = null;
  private stateTimers = new Map<string, NodeJS.Timeout>();

  constructor(store: GroupStoreLike) {
    this.store = store;
    this.indexChats();
  }

  bind(api: GroupsHostApi) {
    this.api = api;
  }

  abstract handle(viewId: string, post: (m: HostToView) => void, msg: GroupViewMsg): Promise<string | void>;
  protected abstract armIdle(id: string): void;

  protected crew(): RoomCrewApi {
    const c = this.api.crew();
    if (!c) throw new Error('The crew is not available in this window.');
    return c;
  }

  isBotChat(id: string): boolean {
    return this.botChats.has(id);
  }

  dispose() {
    for (const rt of this.rts.values()) {
      if (rt.idle) clearTimeout(rt.idle);
      for (const t of rt.turns) t.cancelled = true;
      rt.queue = [];
    }
    if (this.listTimer) clearTimeout(this.listTimer);
    for (const t of this.stateTimers.values()) clearTimeout(t);
    this.store.flush();
  }

  forgetView(viewId: string) {
    this.views.delete(viewId);
  }

  // ------------------------------------------------------------------ views

  protected isBusy(id: string): boolean {
    const rt = this.rts.get(id);
    return !!rt && (rt.running || rt.queue.length > 0 || rt.pending.length > 0);
  }

  protected watchers(groupId: string | null): ViewWatch[] {
    return [...this.views.values()].filter((v) => v.open && (groupId === null || v.groupId === groupId));
  }

  protected watch(viewId: string, post: (m: HostToView) => void, groupId: string | null, open: boolean) {
    this.views.set(viewId, { post, groupId, open });
    if (!open) return;
    this.store.scan((id) => this.isBusy(id));
    this.indexChats();
    post({ type: 'groupList', groups: this.summaries() });
    if (groupId) {
      const g = this.store.get(groupId);
      post({ type: 'groupState', groupId, group: g ? this.view(g) : null });
      if (g) {
        post({ type: 'groupMessages', groupId: g.id, messages: g.messages.map(msgView), full: true });
        this.armIdle(g.id);
      }
    }
  }

  /** The list rows went stale (≤ 4/s). */
  protected emitList() {
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      const ws = this.watchers(null);
      if (!ws.length) return;
      const list = this.summaries();
      for (const w of ws) w.post({ type: 'groupList', groups: list });
    }, 250);
  }

  /** The room's settings / members / typing changed (≤ 7/s). */
  protected emitState(id: string) {
    this.emitList();
    if (this.stateTimers.has(id)) return;
    this.stateTimers.set(
      id,
      setTimeout(() => {
        this.stateTimers.delete(id);
        const g = this.store.get(id);
        for (const w of this.watchers(id)) w.post({ type: 'groupState', groupId: id, group: g ? this.view(g) : null });
      }, 150),
    );
  }

  protected emitMessages(g: Group, msgs: Msg[]) {
    for (const w of this.watchers(g.id)) w.post({ type: 'groupMessages', groupId: g.id, messages: msgs.map(msgView), full: false });
    this.emitState(g.id);
  }

  protected emitAll(g: Group) {
    for (const w of this.watchers(g.id)) w.post({ type: 'groupMessages', groupId: g.id, messages: g.messages.map(msgView), full: true });
    this.emitState(g.id);
  }

  summaries(): GroupSummaryView[] {
    return this.store.all().map((g) => summaryView(g, this.isBusy(g.id)));
  }

  view(g: Group): GroupView {
    const rt = this.rts.get(g.id);
    let crewBots: BotProfile[] = [];
    try {
      crewBots = this.api.crew()?.bots() ?? [];
    } catch {
      /* no crew list: nothing to add */
    }
    return roomView(
      g,
      rt
        ? {
            typing: [...rt.typing].map(([botId, t]) => ({ botId, activity: t.activity, step: t.step })),
            status: rt.status,
            queue: rt.pending.map((p) => ({ id: p.id, text: p.text })),
          }
        : null,
      crewBots,
    );
  }

  // ------------------------------------------------------------------ rooms and members (UI + groups_mcp)

  /** A room by id or (case-insensitive) title. */
  find(ref: string): Group | undefined {
    this.store.scan((id) => this.isBusy(id));
    const r = ref.trim();
    return this.store.get(r) ?? this.store.all().find((g) => g.title.toLowerCase() === r.toLowerCase());
  }

  protected need(ref: string): Group {
    const g = this.find(ref);
    if (!g) throw new Error('No such room.');
    return g;
  }

  protected runtime(id: string): Runtime {
    let rt = this.rts.get(id);
    if (!rt) {
      rt = {
        queue: [],
        moderate: false,
        running: false,
        turns: new Set(),
        typing: new Map(),
        status: null,
        idle: null,
        nudgePasses: 0,
        pending: [],
        toRoute: [],
        round: { turns: new Map(), hops: 0 },
        lastAuto: null,
        routerBusy: false,
        goalMisses: 0,
      };
      this.rts.set(id, rt);
    }
    return rt;
  }

  protected save(g: Group) {
    g.updatedAt = Date.now();
    this.store.put(g);
    this.indexChats();
    this.emitState(g.id);
  }

  protected indexChats() {
    const s = new Set<string>();
    for (const g of this.store.all()) {
      for (const b of g.bots) if (b.chatId) s.add(b.chatId);
      if (g.moderatorChatId) s.add(g.moderatorChatId);
    }
    this.botChats = s;
  }

  create(input: CreateInput): Group {
    const now = Date.now();
    const tpl = input.template ? P.TEMPLATES.find((t) => t.id === input.template) : undefined;
    const recent = this.store.all()[0];
    const mode = input.mode === 'natural' ? 'auto' : MODES.includes(input.mode as RoomMode) ? (input.mode as RoomMode) : (tpl?.mode ?? 'auto');
    const g: Group = {
      id: shortId(),
      title: input.title.trim().slice(0, 80) || tpl?.title || 'Room',
      topic: (input.topic ?? tpl?.topic ?? '').trim().slice(0, 2000),
      userName: P.cleanName(input.userName ?? '') || recent?.userName || 'Boss',
      bots: [],
      mode,
      lead: null,
      drafting: 'turns',
      turnsPerMember: 1,
      moderatorAgent: null,
      moderatorModelId: null,
      moderatorChatId: null,
      moderatorSeen: 0,
      maxBotTurns: clamp(input.maxBotTurns ?? 6, 1, 50),
      autoTalk: input.autoTalk === true,
      idleSeconds: clamp(input.idleSeconds ?? 60, 10, 3600),
      project: null,
      paused: false,
      botTurns: 0,
      waiting: false,
      heldMessages: [],
      goal: null,
      summaryUpTo: 0,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    const kinds = this.usableKinds();
    if (tpl) tpl.bots.forEach((tb, i) => g.bots.push(this.newMember(g, { ...tb, agent: kinds[i % Math.max(1, kinds.length)] ?? this.api.defaultAgent(), access: tpl.access })));
    for (const b of input.bots ?? []) g.bots.push(this.newMember(g, b));
    g.lead = g.bots[0]?.id ?? null;
    if (g.bots.length) this.addNote(g, `${g.bots.map((b) => `${b.emoji} ${b.name}`).join(', ')} joined.`, true);
    this.save(g);
    this.emitList();
    return g;
  }

  /** Agents that can run a bot now (enabled, installed). */
  usableKinds(): AgentKind[] {
    return this.api.enabledKinds().filter((k) => {
      const s = this.api.backend(k)?.status().state;
      return s && s !== 'not_installed' && s !== 'disabled';
    });
  }

  /** An agent's models (groups_mcp checks model ids against them). */
  modelsOf(agent: AgentKind): { id: string; name: string; isDefault: boolean }[] {
    const ms = this.api.backend(agent)?.models();
    return (ms?.models ?? []).map((m) => ({ id: m.id, name: m.displayName, isDefault: m.isDefault }));
  }

  /** A new member = a new crew bot (one profile and SOUL.md, shared by every room it joins). */
  private newMember(g: Group, raw: Partial<Bot>): Bot {
    const crew = this.crew();
    const base = P.cleanName(String(raw.name ?? '')).replace(/\./g, '') || `Bot${g.bots.length + 1}`;
    const taken = new Set([...crew.bots().map((b) => b.name.toLowerCase()), g.userName.toLowerCase()]);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()) || /^(all|everyone|here|you|user)$/i.test(name); n++) name = `${base}${n}`;
    const p = crew.createBot({
      name,
      agent: AGENTS.includes(raw.agent as AgentKind) ? raw.agent : this.api.defaultAgent(),
      modelId: raw.modelId ?? null,
      soul: String(raw.persona ?? '').trim().slice(0, 4000),
      emoji: raw.emoji,
      color: /^#[0-9a-f]{6}$/i.test(String(raw.color ?? '')) ? raw.color : P.PALETTE[g.bots.length % P.PALETTE.length],
      chattiness: clamp(Number(raw.chattiness ?? 40), 0, 100),
      access: TO_CREW_ACCESS[String(raw.access ?? 'chat')] ?? 'talk',
      effort: ['low', 'medium', 'high'].includes(String(raw.effort)) ? String(raw.effort) : 'default',
    });
    return this.member(p, String(raw.persona ?? '').trim(), g.messages.length);
  }

  /** A crew bot as a room member. */
  protected member(p: BotProfile, soul: string, seen: number): Bot {
    return {
      id: p.id,
      name: p.name,
      agent: p.engine,
      modelId: p.model,
      persona: soul,
      emoji: p.emoji,
      color: p.color,
      chattiness: p.chattiness,
      access: TO_GROUP_ACCESS(p.access),
      effort: p.effort,
      muted: false,
      chatId: null,
      seen,
      title: p.title,
      description: p.description,
      aliases: p.aliases,
    };
  }

  update(ref: string, d: Record<string, unknown>) {
    const g = this.need(ref);
    const notes: string[] = [];
    if (typeof d.title === 'string' && d.title.trim() && d.title.trim() !== g.title) {
      g.title = d.title.trim().slice(0, 80);
      notes.push(`The room is now called "${g.title}".`);
    }
    if (typeof d.topic === 'string' && d.topic.trim() !== g.topic) {
      g.topic = d.topic.trim().slice(0, 2000);
      notes.push(g.topic ? `New topic: ${g.topic}` : 'The topic was cleared.');
    }
    if (typeof d.userName === 'string') {
      const n = P.cleanName(d.userName);
      if (n && n !== g.userName && !g.bots.some((b) => b.name.toLowerCase() === n.toLowerCase())) {
        notes.push(`${g.userName} is now called ${n}.`);
        g.userName = n;
      }
    }
    const mode = d.mode === 'natural' ? 'auto' : (d.mode as RoomMode);
    if (MODES.includes(mode) && mode !== g.mode) {
      // the router and the moderator are told different jobs: a new one starts
      if (g.mode === 'moderator' || mode === 'moderator') this.resetModerator(g);
      g.mode = mode;
    }
    if (typeof d.lead === 'string' && g.bots.some((b) => b.id === d.lead) && d.lead !== g.lead) {
      g.lead = d.lead;
      notes.push(`${g.bots.find((b) => b.id === d.lead)!.name} leads the room now.`);
    }
    if (d.drafting === 'turns' || d.drafting === 'parallel') g.drafting = d.drafting;
    if (d.turnsPerMember !== undefined) g.turnsPerMember = clamp(Number(d.turnsPerMember), 1, 5);
    if (d.moderatorAgent !== undefined) {
      const a = AGENTS.includes(d.moderatorAgent as AgentKind) ? (d.moderatorAgent as AgentKind) : null;
      if (a !== g.moderatorAgent) this.resetModerator(g);
      g.moderatorAgent = a;
    }
    if (d.moderatorModelId !== undefined) {
      const m = d.moderatorModelId ? String(d.moderatorModelId) : null;
      if (m !== g.moderatorModelId) this.resetModerator(g);
      g.moderatorModelId = m;
    }
    if (d.maxBotTurns !== undefined) g.maxBotTurns = clamp(Number(d.maxBotTurns), 1, 50);
    if (d.autoTalk !== undefined) g.autoTalk = d.autoTalk === true;
    if (d.idleSeconds !== undefined) g.idleSeconds = clamp(Number(d.idleSeconds), 10, 3600);
    for (const n of notes) this.addNote(g, n, true);
    this.save(g);
    this.armIdle(g.id);
  }

  addBot(ref: string, raw: Partial<Bot>): Bot {
    const g = this.need(ref);
    if (g.bots.length >= 12) throw new Error('A room has at most 12 members.');
    const b = this.newMember(g, raw);
    this.join(g, b);
    return b;
  }

  /** An existing crew bot joins the room. */
  addMember(ref: string, botId: string): Bot {
    const g = this.need(ref);
    if (g.bots.some((b) => b.id === botId)) throw new Error('It is already in this room.');
    if (g.bots.length >= 12) throw new Error('A room has at most 12 members.');
    const crew = this.crew();
    const p = crew.bot(botId);
    if (!p) throw new Error('No such bot.');
    const b = this.member(p, this.store.soulOf(botId), g.messages.length);
    this.join(g, b);
    return b;
  }

  private join(g: Group, b: Bot) {
    g.bots.push(b);
    g.lead ??= b.id;
    this.addNote(g, `${b.emoji} ${b.name} joined${b.title ? ` (${b.title})` : b.persona ? `: ${b.persona.split('\n')[0].slice(0, 100)}` : ''}.`, true);
    this.save(g);
  }

  /** A member by id or (case-insensitive) name. */
  findBot(g: Group, ref: string): Bot | undefined {
    const r = ref.trim().replace(/^@/, '');
    return g.bots.find((b) => b.id === r) ?? g.bots.find((b) => b.name.toLowerCase() === r.toLowerCase());
  }

  /**
   * The room's member editor changes the crew bot (every room and its DM follow). A new persona / access reaches its
   * room thread through its crew setup (no restart); a new agent or model starts its room thread again.
   */
  updateBot(ref: string, botRef: string, d: Partial<Bot>): Bot {
    const g = this.need(ref);
    const b = this.findBot(g, botRef);
    if (!b) throw new Error('No such member in this room.');
    const fields: Record<string, unknown> = {};
    if (d.name !== undefined) {
      const n = P.cleanName(String(d.name)).replace(/\./g, '');
      if (n && n !== b.name) {
        if (n.toLowerCase() === g.userName.toLowerCase()) throw new Error(`The name ${n} is taken.`);
        fields.name = n;
      }
    }
    if (d.persona !== undefined && String(d.persona).trim() !== b.persona) fields.soul = String(d.persona).trim().slice(0, 4000);
    if (d.agent !== undefined && AGENTS.includes(d.agent as AgentKind) && d.agent !== b.agent) fields.agent = d.agent;
    if (d.modelId !== undefined) fields.modelId = d.modelId ? String(d.modelId) : null;
    if (d.access !== undefined && TO_CREW_ACCESS[String(d.access)] && d.access !== b.access) fields.access = TO_CREW_ACCESS[String(d.access)];
    if (d.effort !== undefined) fields.effort = ['low', 'medium', 'high'].includes(String(d.effort)) ? String(d.effort) : 'default';
    if (d.emoji !== undefined) fields.emoji = d.emoji;
    if (d.color !== undefined) fields.color = d.color;
    if (d.chattiness !== undefined) fields.chattiness = clamp(Number(d.chattiness), 0, 100);
    const oldName = b.name;
    let room = g;
    if (Object.keys(fields).length) {
      // the crew tells every room to read its members again: this room may be a fresh object after it
      this.crew().updateBot(b.id, fields);
      room = this.store.get(g.id) ?? g;
      this.syncMembers(room);
    }
    const now = room.bots.find((x) => x.id === b.id) ?? b;
    if (now.name !== oldName) this.addNote(room, `${oldName} is now called ${now.name}.`, true);
    if (d.muted !== undefined && d.muted !== now.muted) {
      if (d.muted) this.hold(room.id, now.id);
      else this.release(room.id, now.id);
    }
    this.save(room);
    return now;
  }

  /** Reads the members' crew profiles again; a member on another agent / model starts its room thread again. */
  protected syncMembers(g: Group) {
    for (const c of this.store.refreshBots(g.id)) {
      const b = g.bots.find((x) => x.id === c.botId);
      if (b && (c.engineChanged || c.modelChanged)) this.resetBotChat(g, b, c.oldEngine);
    }
  }

  abstract hold(ref: string, botRef: string): void;
  abstract release(ref: string, botRef: string): void;

  removeBot(ref: string, botRef: string) {
    const g = this.need(ref);
    const b = this.findBot(g, botRef);
    if (!b) throw new Error('No such member in this room.');
    const rt = this.runtime(g.id);
    for (const t of rt.turns) if (t.botId === b.id) t.cancelled = true;
    dropItems(rt.queue.filter((q) => q.botId === b.id));
    rt.queue = rt.queue.filter((q) => q.botId !== b.id);
    this.dropChat(b.agent, b.chatId);
    g.bots = g.bots.filter((x) => x !== b);
    g.heldMessages = g.heldMessages.filter((h) => h.botId !== b.id);
    if (g.lead === b.id) g.lead = g.bots[0]?.id ?? null;
    this.addNote(g, `${b.name} left the room.`, true);
    this.save(g);
  }

  protected resetBotChat(g: Group, b: Bot, oldAgent: AgentKind = b.agent) {
    const rt = this.rts.get(g.id);
    for (const t of rt?.turns ?? []) if (t.botId === b.id) t.cancelled = true;
    this.dropChat(oldAgent, b.chatId);
    b.chatId = null;
    b.seen = g.messages.length;
  }

  protected resetModerator(g: Group) {
    this.dropChat(g.moderatorAgent ?? this.api.defaultAgent(), g.moderatorChatId);
    g.moderatorChatId = null;
    g.moderatorSeen = g.messages.length;
  }

  /** Deletes a hidden chat (it is not listed anywhere, so it would only pile up). */
  protected dropChat(agent: AgentKind, chatId: string | null) {
    if (!chatId) return;
    const b = this.api.backend(agent);
    setTimeout(() => void b?.conversationAction(chatId, 'delete').catch(() => undefined), 1500);
  }

  protected stopAll(g: Group) {
    const rt = this.runtime(g.id);
    dropItems(rt.queue);
    rt.queue = [];
    rt.moderate = false;
    for (const t of rt.turns) t.cancelled = true;
    if (rt.idle) clearTimeout(rt.idle);
    rt.idle = null;
  }

  async remove(ref: string) {
    const g = this.need(ref);
    const rt = this.rts.get(g.id);
    if (rt) {
      for (const t of rt.turns) t.cancelled = true;
      if (rt.idle) clearTimeout(rt.idle);
      dropItems(rt.queue);
      rt.queue = [];
      rt.pending = [];
    }
    for (const b of g.bots) this.dropChat(b.agent, b.chatId);
    this.dropChat(g.moderatorAgent ?? this.api.defaultAgent(), g.moderatorChatId);
    this.store.delete(g.id);
    this.rts.delete(g.id);
    this.indexChats();
    for (const w of this.watchers(g.id)) w.post({ type: 'groupState', groupId: g.id, group: null });
    this.emitList();
  }

  async clear(ref: string) {
    const g = this.need(ref);
    this.stopAll(g);
    this.runtime(g.id).pending = [];
    for (const b of g.bots) {
      this.dropChat(b.agent, b.chatId);
      b.chatId = null;
      b.seen = 0;
    }
    this.resetModerator(g);
    g.messages = [];
    g.moderatorSeen = 0;
    g.botTurns = 0;
    g.waiting = false;
    g.heldMessages = [];
    g.summaryUpTo = 0;
    this.store.setSummary(g.id, '', 0);
    this.save(g);
    this.emitAll(g);
  }

  /** The rooms changed on disk (a crew bot edited on the Crew screen): read them again and update the screens. */
  refresh() {
    this.store.scan((id) => this.isBusy(id));
    // rooms read from disk just now have the new profiles; the others (busy, or with a save pending) read them here
    for (const g of this.store.all()) this.syncMembers(g);
    this.indexChats();
    this.emitList();
    for (const g of this.store.all()) if (this.watchers(g.id).length) this.emitState(g.id);
  }

  /** A crew bot was deleted: it leaves every room it sat in. */
  removeBotEverywhere(botId: string) {
    for (const g of this.store.all()) if (g.bots.some((b) => b.id === botId)) this.removeBot(g.id, botId);
  }

  /** Shows the room in the view used last. */
  open(ref: string) {
    const g = this.need(ref);
    this.api.postActive({ type: 'groupNavigate', groupId: g.id });
  }

  /** The room's transcript as text (groups_mcp). */
  readTranscript(ref: string, last: number): string {
    const g = this.need(ref);
    const talk = g.messages.filter(P.isTalk);
    const from = Math.max(0, talk.length - Math.max(1, last));
    return talk
      .slice(from)
      .map((m) => (m.from === 'system' ? `(${m.text})` : `[${m.name}]: ${m.text}${m.digest ? `\n[What ${m.name} did: ${m.digest}]` : ''}`))
      .join('\n\n');
  }

  /** A room note: `system` ones are news the members are told (joins, topic), the rest are for the user only. */
  protected addNote(g: Group, text: string, forBots = false): Msg {
    const m: Msg = { id: shortId(), from: forBots ? 'system' : 'notice', name: '', text, at: Date.now(), attachments: [] };
    g.messages.push(m);
    this.store.put(g);
    this.emitMessages(g, [m]);
    return m;
  }
}
