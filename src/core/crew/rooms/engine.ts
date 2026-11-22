// Rooms v2 (docs/crew/PLAN.md §7): the talking. A user message is routed (router.ts) to who should answer; members
// answer one at a time (or, drafting "parallel", all at once with posts landing in order), each in its own room
// thread with only the lines it has not seen; a member's @mentions chain to others (≤ 3 hops a round, a member that
// spoke this round answers again only when named); each member gets turnsPerMember turns a round; maxBotTurns in a row
// and the members wait for the user. The user's messages sent while a member speaks wait in a queue and go as one
// turn; held members are skipped and see what was for them when released. One turn at a time per bot crew-wide (its
// DM, another room, a job): a busy member waits (≤ 30 min). Older lines fold into a rolling summary while it is quiet.
import { randomUUID } from 'node:crypto';
import type { AgentKind, ChatAttachment } from '../../../../shared/model';
import type { HostToView } from '../../../../shared/protocol';
import { digestOf } from '../turns/evidence';
import { runTurn } from '../turns/runner';
import type { CrewAccess } from '../types';
import { AGENTS, dropItems, errText, RoomCore, shortId, type CreateInput, type Pending, type QItem, type Runtime, type Turn } from './core';
import * as GL from '../goals';
import * as P from './prompts';
import * as R from './router';
import { REASON_RANK, type Bot, type Group, type GroupStoreLike, type GroupViewMsg, type Msg, type Reason } from './types';

export type { CreateInput };

/** Timing a test may shorten. routerBudgetMs: the router answers within this long, or the lead answers (fail-open); CLI agents need a few seconds even warm. */
export const ROOM_TIMING = { routerBudgetMs: 8000 };
/** Bot-to-bot @mention hops per round. */
const MAX_HOPS = 3;
/** A busy member waits this long for its other turn to end, then is skipped. */
const LOCK_WAIT_MS = 30 * 60_000;
/** Members drafting at once (parallel drafting). */
const MAX_PARALLEL = 4;
/** Re-asking another member this soon after an auto pick teaches the router. */
const LEARN_WINDOW_MS = 5 * 60_000;
/** The summary is brought up to date when this many lines are past it (and the room is quiet). */
const SUMMARY_EVERY = P.LONG_GAP + 30;

const CREW_ACCESS: Record<Bot['access'], CrewAccess> = { chat: 'talk', read: 'read', edit: 'edit' };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Draft {
  bot: Bot;
  q: QItem;
  /** What to post ('' = nothing: it passed). */
  text: string;
  m: Partial<Msg>;
  /** A lead's goal turn: its control block. */
  control: GL.Control | null;
}

export class RoomEngine extends RoomCore {
  private summarizing = new Set<string>();

  constructor(store: GroupStoreLike) {
    super(store);
  }

  // ------------------------------------------------------------------ views

  async handle(viewId: string, post: (m: HostToView) => void, msg: GroupViewMsg): Promise<string | void> {
    if (msg.type === 'groupWatch') {
      this.watch(viewId, post, msg.groupId, msg.open);
      return;
    }
    if (msg.type === 'groupSend') {
      this.post(msg.groupId, msg.text, msg.attachments, msg.replyTo ?? null);
      return;
    }
    const gid = msg.groupId ?? '';
    const data = (msg.data ?? {}) as Record<string, unknown>;
    const botId = msg.botId ?? '';
    switch (msg.action) {
      case 'create': {
        const g = this.create({
          title: String(data.title ?? ''),
          topic: data.topic != null ? String(data.topic) : undefined,
          userName: data.userName != null ? String(data.userName) : undefined,
          template: data.template != null ? String(data.template) : null,
        });
        post({ type: 'groupNavigate', groupId: g.id });
        return;
      }
      case 'update':
        this.update(gid, data);
        return;
      case 'delete':
        await this.remove(gid);
        return 'Room deleted';
      case 'addBot':
        this.addBot(gid, data as Partial<Bot>);
        return;
      case 'addMember':
        this.addMember(gid, botId);
        return;
      case 'updateBot':
        this.updateBot(gid, botId, data as Partial<Bot>);
        return;
      case 'removeBot':
        this.removeBot(gid, botId);
        return;
      case 'hold':
        this.hold(gid, botId);
        return;
      case 'release':
        this.release(gid, botId);
        return;
      case 'goal':
        if (data.stop === true) this.stopGoal(gid);
        else if (data.continue === true) this.continueGoal(gid);
        else this.startGoal(gid, String(data.text ?? ''), Number(data.maxTurns ?? 13));
        return;
      case 'unqueue': {
        const rt = this.runtime(this.need(gid).id);
        rt.pending = rt.pending.filter((p) => p.id !== data.id);
        this.emitState(gid);
        return;
      }
      case 'pause':
        this.pause(gid);
        return;
      case 'resume':
        this.resume(gid);
        return;
      case 'continue':
        this.continueTalk(gid);
        return;
      case 'clear':
        await this.clear(gid);
        return 'Chat cleared; the members start fresh';
      case 'nudgeBot':
        this.nudge(gid, botId);
        return;
      case 'openBotChat': {
        const g = this.need(gid);
        const b = g.bots.find((x) => x.id === botId);
        if (!b?.chatId) return `${b?.name ?? 'This member'} has not spoken here yet.`;
        this.api.showChat(b.chatId, b.agent);
        return;
      }
      case 'setupWithAI': {
        const agent = (AGENTS.includes(data.agent as AgentKind) ? data.agent : this.api.defaultAgent()) as AgentKind;
        post({ type: 'startChat', agent, text: setupRequest(String(data.idea ?? '').trim()) });
        return;
      }
      case 'pickProject': {
        const g = this.need(gid);
        const p = data.clear === true ? null : await this.api.pickFolder();
        if (p === null && data.clear !== true) return;
        g.project = p;
        // their chats ran in the old folder: they start again there (with the recent lines)
        for (const b of g.bots) if (b.access !== 'chat') this.resetBotChat(g, b);
        this.save(g);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ the user

  /** The user's message (the screen, or groups_mcp on the user's behalf). */
  post(ref: string, text: string, attachments: ChatAttachment[] = [], replyTo: string | null = null) {
    const g = this.need(ref);
    const t = text.trim();
    if (!t && !attachments.length) return;
    // "pause @Grit" / "resume @Grit": a hold, not a message
    const cmd = /^\s*(stop|pause|hold|resume|release|unpause|unhold)\s+@([\p{L}\p{N}_.-]+)\s*[.!]?\s*$/iu.exec(t);
    if (cmd && !attachments.length) {
      const b = this.findBot(g, cmd[2]);
      if (b) {
        if (/^(stop|pause|hold)$/i.test(cmd[1])) this.hold(g.id, b.id);
        else this.release(g.id, b.id);
        return;
      }
    }
    // "/goal <text>" starts a goal the lead drives; "/goal stop" stops it
    const goal = /^\/goal\b\s*(.*)$/is.exec(t);
    if (goal && !attachments.length) {
      const arg = goal[1].trim();
      if (/^(stop|end|cancel)$/i.test(arg)) this.stopGoal(g.id);
      else if (/^(continue|go on|resume)$/i.test(arg)) this.continueGoal(g.id);
      else if (arg) this.startGoal(g.id, arg);
      return;
    }
    // the file on disk is enough (the room and the members read it from there); inline data only when there is no path
    const p: Pending = { id: shortId(), text: t, attachments: attachments.map((a) => (a.path ? { ...a, base64: null } : a)), replyTo };
    const rt = this.runtime(g.id);
    if (rt.running) {
      // someone is speaking: it waits above the composer and goes with the next turn
      rt.pending.push(p);
      this.emitState(g.id);
      return;
    }
    this.postLines(g, rt, [p]);
    // the goal waited for the user: their answer goes to the lead
    if (g.goal?.status === 'needs-input') {
      rt.toRoute = [];
      g.goal = { ...g.goal, status: 'running', updatedAt: Date.now() };
      this.goalLead(g, '(The user answered above.)');
    }
    void this.pump(g.id);
  }

  /** The user's waiting messages become room lines (a new round); they are routed by the pump. */
  private postLines(g: Group, rt: Runtime, list: Pending[]) {
    const msgs: Msg[] = list.map((p) => ({ id: p.id, from: 'user', name: g.userName, text: p.text, at: Date.now(), attachments: p.attachments, ...(p.replyTo ? { replyTo: p.replyTo } : {}) }));
    g.messages.push(...msgs);
    g.botTurns = 0;
    g.waiting = false;
    g.paused = false;
    rt.nudgePasses = 0;
    rt.round = { turns: new Map(), hops: 0 };
    // what was waiting to chime in is stale now; asked members still answer
    rt.queue = rt.queue.filter((q) => REASON_RANK[q.reason] >= REASON_RANK.all && q.reason !== 'lead');
    rt.toRoute.push(...msgs);
    this.save(g);
    this.emitMessages(g, msgs);
  }

  pause(ref: string) {
    const g = this.need(ref);
    g.paused = true;
    this.stopAll(g);
    this.save(g);
  }

  resume(ref: string) {
    const g = this.need(ref);
    g.paused = false;
    this.save(g);
    void this.pump(g.id);
    this.armIdle(g.id);
  }

  /** The members stopped after maxBotTurns: let them go on. */
  continueTalk(ref: string) {
    const g = this.need(ref);
    g.waiting = false;
    g.paused = false;
    g.botTurns = 0;
    const rt = this.runtime(g.id);
    rt.nudgePasses = 0;
    rt.round = { turns: new Map(), hops: 0 };
    if (g.mode === 'moderator') rt.moderate = true;
    else {
      const lastBot = [...g.messages].reverse().find((m) => g.bots.some((b) => b.id === m.from));
      const pick = weighted(this.active(g).filter((b) => b.id !== lastBot?.from)) ?? weighted(this.active(g));
      if (pick) this.enqueue(g, { botId: pick.id, reason: 'pick', picked: { by: 'nudge' } });
    }
    this.save(g);
    void this.pump(g.id);
  }

  /** Make one member speak now. */
  nudge(ref: string, botRef: string) {
    const g = this.need(ref);
    const b = this.findBot(g, botRef);
    if (!b) throw new Error('No such member in this room.');
    g.waiting = false;
    g.paused = false;
    g.botTurns = 0;
    this.enqueue(g, { botId: b.id, reason: 'pick', picked: { by: 'user' } }, true);
    this.save(g);
    void this.pump(g.id);
  }

  /** The member is skipped here; messages for it are kept until it is released. */
  hold(ref: string, botRef: string) {
    const g = this.need(ref);
    const b = this.findBot(g, botRef);
    if (!b || b.muted) return;
    b.muted = true;
    const rt = this.runtime(g.id);
    for (const t of rt.turns) if (t.botId === b.id) t.cancelled = true;
    dropItems(rt.queue.filter((q) => q.botId === b.id));
    rt.queue = rt.queue.filter((q) => q.botId !== b.id);
    this.addNote(g, `⏸ ${b.name} is on hold here.`, true);
    this.save(g);
  }

  /** Back from hold: it answers what was kept for it. */
  release(ref: string, botRef: string) {
    const g = this.need(ref);
    const b = this.findBot(g, botRef);
    if (!b || !b.muted) return;
    b.muted = false;
    const kept = g.heldMessages.filter((h) => h.botId === b.id);
    g.heldMessages = g.heldMessages.filter((h) => h.botId !== b.id);
    this.addNote(g, `▶ ${b.name} is back.`, true);
    if (kept.length) {
      this.enqueue(g, { botId: b.id, reason: 'held', picked: { by: 'held', why: `${kept.length} kept for it` } });
      void this.pump(g.id);
    }
    this.save(g);
  }

  // ------------------------------------------------------------------ who answers

  /** Members that can answer now (not held, not paused, their agent usable). */
  protected active(g: Group): Bot[] {
    const usable = new Set(this.usableKinds());
    return g.bots.filter((b) => !b.muted && usable.has(b.agent) && !this.isPaused(b.id));
  }

  private isPaused(botId: string): boolean {
    try {
      return this.crew().isPaused(botId);
    } catch {
      return false;
    }
  }

  /** Paused bots stop talking: their running room turns end, their queued turns are dropped. */
  pauseBots(botIds: string[]) {
    const ids = new Set(botIds);
    for (const [id, rt] of this.rts) {
      for (const t of rt.turns) if (t.botId && ids.has(t.botId)) t.cancelled = true;
      dropItems(rt.queue.filter((q) => ids.has(q.botId)));
      rt.queue = rt.queue.filter((q) => !ids.has(q.botId));
      this.emitState(id);
    }
  }

  private enqueue(g: Group, item: QItem, front = false) {
    const rt = this.runtime(g.id);
    const cur = rt.queue.find((q) => q.botId === item.botId);
    if (cur) {
      if (REASON_RANK[item.reason] > REASON_RANK[cur.reason]) {
        cur.reason = item.reason;
        cur.picked = item.picked;
      }
      // one turn carries both (a job report and a mention, two reports…)
      if (item.extra) cur.extra = cur.extra ? `${cur.extra}\n\n${item.extra}` : item.extra;
      if (item.done) {
        const first = cur.done;
        const next = item.done;
        cur.done = first ? (t) => (first(t), next(t)) : next;
      }
    } else if (front) rt.queue.unshift(item);
    else rt.queue.push(item);
    // stable: stronger reasons first, arrival order inside a rank
    if (!front) rt.queue.sort((a, b) => REASON_RANK[b.reason] - REASON_RANK[a.reason]);
  }

  private keepFor(g: Group, b: Bot, m: Msg) {
    if (g.heldMessages.some((h) => h.botId === b.id && h.lineId === m.id)) return;
    g.heldMessages.push({ botId: b.id, lineId: m.id });
    this.addNote(g, `${b.name} is on hold: it will see this when you release it.`);
  }

  /** Routes the user's new lines (one combined decision): replies, mentions, the mode, chime-ins. */
  private async routeUser(g: Group, rt: Runtime, msgs: Msg[]) {
    if (!g.bots.length) {
      this.addNote(g, 'Add a member to start the conversation.');
      return;
    }
    const active = this.active(g);
    if (!active.length) {
      this.addNote(
        g,
        g.bots.every((b) => b.muted) ? 'Every member is on hold.' : g.bots.every((b) => b.muted || this.isPaused(b.id)) ? 'Every member is paused (resume them on the Crew screen).' : 'No member can answer now: their agents are offline.',
      );
      return;
    }
    const isActive = (id: string) => active.some((b) => b.id === id);
    const picked = new Set<string>();
    const add = (b: Bot, reason: Reason, by: QItem['picked']) => {
      picked.add(b.id);
      this.enqueue(g, { botId: b.id, reason, picked: by });
    };
    let direct = false;
    for (const m of msgs) {
      if (m.replyTo) {
        const line = g.messages.find((x) => x.id === m.replyTo);
        const b = line ? g.bots.find((x) => x.id === line.from) : undefined;
        if (b) {
          direct = true;
          if (b.muted) this.keepFor(g, b, m);
          else if (isActive(b.id)) add(b, 'reply', { by: 'reply' });
        }
      }
      const mm = R.mentions(m.text, g.bots);
      for (const a of mm.ambiguous) this.addNote(g, `@${a.word} could mean ${a.names.join(' or ')}: say which one.`);
      for (const id of mm.ids) {
        const b = g.bots.find((x) => x.id === id)!;
        direct = true;
        if (b.muted) this.keepFor(g, b, m);
        else if (isActive(b.id)) add(b, 'mention', { by: 'mention' });
      }
      if (mm.all || mm.here) {
        direct = true;
        const busy = mm.here && !mm.all ? new Set([...this.rts.values()].flatMap((r) => [...r.turns].map((t) => t.botId))) : new Set<string | null>();
        for (const b of active) if (!busy.has(b.id)) add(b, 'all', { by: 'everyone' });
      }
      // learning: the user asks someone else right after an auto pick
      const last = rt.lastAuto;
      const right = last ? g.messages.slice(g.messages.findIndex((x) => x.id === last.lineId) + 1, g.messages.indexOf(m)).every((x) => x.from !== 'user') : false;
      if (last && right && mm.ids.length === 1 && !m.replyTo && last.botId !== mm.ids[0] && Date.now() - last.at < LEARN_WINDOW_MS) {
        const target = g.bots.find((b) => b.id === mm.ids[0])!;
        const words = R.learnWords(last.text, target, g);
        if (words.length) {
          try {
            this.crew().learn(target.id, words);
            this.syncMembers(g);
            this.addNote(g, `Noted: messages about ${words.join(', ')} go to @${target.name} next time (edit in its profile).`);
          } catch {
            /* learning is best effort */
          }
        }
        rt.lastAuto = null;
      }
    }
    if (!direct) await this.routeByMode(g, rt, msgs, active, add);
    // natural chime-ins: the others roll their chattiness (less often when someone was asked)
    if (g.mode !== 'moderator' && g.mode !== 'everyone') {
      for (const b of active) if (!picked.has(b.id) && Math.random() * 100 < b.chattiness * (picked.size ? 0.3 : 1)) add(b, 'chime', { by: 'chime' });
    }
  }

  private async routeByMode(g: Group, rt: Runtime, msgs: Msg[], active: Bot[], add: (b: Bot, r: Reason, by: QItem['picked']) => void) {
    const text = msgs.map((m) => m.text).join('\n');
    const lead = active.find((b) => b.id === g.lead) ?? active[0];
    const lastBot = [...g.messages].reverse().find((m) => g.bots.some((b) => b.id === m.from))?.from ?? null;
    switch (g.mode) {
      case 'everyone':
        for (const b of active) add(b, 'all', { by: 'everyone' });
        return;
      case 'lead':
        add(lead, 'lead', { by: 'lead' });
        return;
      case 'mentions':
        return;
      case 'moderator':
        rt.moderate = true;
        return;
      case 'auto': {
        if (active.length === 1) {
          add(active[0], 'user', { by: 'auto', why: 'only member' });
          return;
        }
        const scores = R.scoreMembers(g, text, active, lastBot);
        const sure = R.confidentPick(scores);
        if (sure) {
          add(sure.bot, 'user', { by: 'auto', why: R.whyText(sure) });
          rt.lastAuto = { text, botId: sure.bot.id, at: Date.now(), lineId: msgs[msgs.length - 1].id };
          return;
        }
        const r = await this.askRouter(g, rt, msgs[msgs.length - 1]);
        if (r?.everyone) {
          for (const b of active) add(b, 'all', { by: 'router', why: r.why || 'for everyone' });
          return;
        }
        const bots = (r?.bots ?? []).filter((b) => active.includes(b));
        if (bots.length) {
          for (const b of bots) add(b, 'user', { by: 'router', why: r!.why });
          rt.lastAuto = { text, botId: bots[0].id, at: Date.now(), lineId: msgs[msgs.length - 1].id };
          return;
        }
        add(lead, 'lead', { by: 'lead', why: r ? 'router unsure' : 'router did not answer in time' });
        rt.lastAuto = { text, botId: lead.id, at: Date.now(), lineId: msgs[msgs.length - 1].id };
        return;
      }
    }
  }

  /** A member's message: whom it @mentions answers (≤ MAX_HOPS a round); the others may chime in. */
  private reactBot(g: Group, rt: Runtime, m: Msg, author: Bot) {
    const active = this.active(g).filter((b) => b.id !== author.id);
    if (!active.length) return;
    const mm = R.mentions(m.text, g.bots);
    const named = mm.ids.filter((id) => active.some((b) => b.id === id));
    let asked = false;
    if (named.length || mm.all) {
      if (rt.round.hops < MAX_HOPS) {
        rt.round.hops++;
        asked = true;
        for (const id of named) this.enqueue(g, { botId: id, reason: 'mention', picked: { by: 'mention', why: `asked by ${author.name}` } });
        if (mm.all) for (const b of active) if (!named.includes(b.id)) this.enqueue(g, { botId: b.id, reason: 'all', picked: { by: 'everyone', why: `asked by ${author.name}` } });
      }
      for (const id of named) {
        const b = g.bots.find((x) => x.id === id);
        if (b?.muted) this.keepFor(g, b, m);
      }
    }
    if (g.mode === 'moderator') {
      rt.moderate = true;
      return;
    }
    if (asked) return;
    // a member that spoke this round answers again only when named
    for (const b of active) {
      if (rt.round.turns.has(b.id)) continue;
      if (Math.random() * 100 < b.chattiness * 0.5) this.enqueue(g, { botId: b.id, reason: 'chime', picked: { by: 'chime' } });
    }
  }

  // ------------------------------------------------------------------ the pump

  /** Runs the room: routes the user's lines, then members' turns, until the queue is empty. */
  private async pump(id: string) {
    const rt = this.runtime(id);
    if (rt.running) return;
    rt.running = true;
    if (rt.idle) clearTimeout(rt.idle);
    rt.idle = null;
    this.emitList();
    try {
      for (;;) {
        const g = this.store.get(id);
        if (!g || g.paused) break;
        if (rt.pending.length) this.postLines(g, rt, rt.pending.splice(0));
        if (rt.toRoute.length) {
          await this.routeUser(g, rt, rt.toRoute.splice(0)).catch((e) => this.addNote(g, `Could not pick who answers: ${errText(e)}`));
          continue;
        }
        if (!rt.queue.length && rt.moderate) {
          rt.moderate = false;
          if (g.botTurns >= g.maxBotTurns) {
            this.stopForUser(g, rt);
            break;
          }
          await this.runModerator(g, rt).catch((e) => this.addNote(g, `The moderator failed: ${errText(e)}`));
          continue;
        }
        if (!rt.queue.length) break;
        // the daily budget: only job reports (work already running) still get their turn
        if (this.budgetStop(g, rt)) break;
        // job reports are not chatter: they run past the limit
        if (g.botTurns >= g.maxBotTurns && !rt.queue.some((q) => q.done || q.goal)) {
          this.stopForUser(g, rt);
          break;
        }
        const batch = this.takeBatch(g, rt);
        if (!batch.length) continue;
        // everyone drafts at once (parallel) or one by one; posts land in queue order either way
        const drafts = batch.map((q) => this.draft(g, rt, q));
        for (const d of drafts) {
          const done = await d;
          if (done) this.publish(g, rt, done);
        }
      }
    } finally {
      rt.running = false;
      rt.status = null;
      rt.typing.clear();
      const g = this.store.get(id);
      // messages that came while it stopped (paused) stay queued; otherwise run them now
      if (g && !g.paused && (rt.pending.length || rt.toRoute.length)) void this.pump(id);
      else {
        this.emitState(id);
        this.armIdle(id);
        if (g) void this.maybeSummarize(g);
      }
    }
  }

  /** The next speaker(s): one, or up to MAX_PARALLEL when drafting in parallel; held / capped members are skipped. */
  private takeBatch(g: Group, rt: Runtime): QItem[] {
    const out: QItem[] = [];
    const over = g.botTurns >= g.maxBotTurns;
    const max = g.drafting === 'parallel' ? Math.max(1, Math.min(MAX_PARALLEL, g.maxBotTurns - g.botTurns)) : 1;
    while (rt.queue.length && out.length < max) {
      const q = rt.queue.shift()!;
      const b = g.bots.find((x) => x.id === q.botId);
      // past the limit only job reports run
      if (over && !q.done && !q.goal) {
        dropItems([q]);
        continue;
      }
      if (!b || b.muted || this.isPaused(b.id) || out.some((o) => o.botId === q.botId) || (!q.done && !q.goal && (rt.round.turns.get(b.id) ?? 0) >= g.turnsPerMember)) {
        dropItems([q]);
        if (q.goal) this.goalMissed(g, q);
        continue;
      }
      out.push(q);
    }
    return out;
  }

  /** The crew's daily budget is used up: queued turns are dropped (job reports stay); true = nothing is left to run. */
  private budgetStop(g: Group, rt: Runtime): boolean {
    let over: string | null = null;
    try {
      over = this.crew().overBudget?.() ?? null;
    } catch {
      /* no crew yet */
    }
    if (!over) return false;
    const drop = rt.queue.filter((q) => !q.done);
    if (drop.length) {
      rt.queue = rt.queue.filter((q) => q.done);
      dropItems(drop);
      for (const q of drop) if (q.goal) this.goalMissed(g, q);
      this.addNote(g, `No more turns today: ${over}. Raise it on the Crew screen.`);
    }
    return !rt.queue.length;
  }

  private stopForUser(g: Group, rt: Runtime) {
    dropItems(rt.queue);
    rt.queue = [];
    rt.moderate = false;
    if (!g.waiting) {
      g.waiting = true;
      this.addNote(g, `💤 The members paused after ${g.maxBotTurns} messages in a row. Say something, or press Continue.`);
      this.save(g);
    }
  }

  /** The folder a member's room thread runs in. */
  private folderOf(g: Group, b: { access: Bot['access'] }): string {
    if (b.access === 'chat') return this.store.roomDir(g.id);
    return g.project ?? this.api.workspaceFolder() ?? this.store.roomDir(g.id);
  }

  private setTyping(g: Group, rt: Runtime, botId: string, activity: 'typing' | 'working' | 'waiting', step: string | null) {
    const cur = rt.typing.get(botId);
    if (cur?.activity === activity && cur.step === step) return;
    rt.typing.set(botId, { activity, step });
    this.emitState(g.id);
  }

  /** One member's turn: waits until the bot is free crew-wide, runs it, returns what to post (null = nothing). */
  private async draft(g: Group, rt: Runtime, q: QItem): Promise<Draft | null> {
    const d = await this.draftTurn(g, rt, q);
    if (!d) {
      q.done?.(null);
      if (q.goal) this.goalMissed(g, q);
    }
    return d;
  }

  private async draftTurn(g: Group, rt: Runtime, q: QItem): Promise<Draft | null> {
    const bot = g.bots.find((b) => b.id === q.botId);
    if (!bot) return null;
    const used = rt.round.turns.get(bot.id) ?? 0;
    rt.round.turns.set(bot.id, used + 1);
    const crew = this.crew();
    const gate: Turn = { botId: bot.id, chatId: '', agent: bot.agent, cancelled: false };
    rt.turns.add(gate);
    this.setTyping(g, rt, bot.id, 'typing', null);
    let release: (() => void) | null = null;
    let end: (() => void) | null = null;
    let isNew = false;
    try {
      release = await crew.lock(bot.id, `#${g.title}`, {
        cancelled: () => gate.cancelled || !!this.store.get(g.id)?.paused,
        onWait: (where) => this.setTyping(g, rt, bot.id, 'waiting', `finishing something in ${where}`),
        timeoutMs: LOCK_WAIT_MS,
      });
      if (!release) {
        if (!gate.cancelled) this.addNote(g, `${bot.name} was busy elsewhere for too long; skipped.`);
        return null;
      }
      this.setTyping(g, rt, bot.id, 'typing', null);
      // Crew-screen edits made while the room was busy (another agent / model starts its room thread again)
      this.syncMembers(g);
      const backend = this.api.backend(bot.agent);
      const st = backend?.status().state;
      if (!backend || st === 'not_installed' || st === 'disabled') {
        this.addNote(g, `${bot.name} is offline: ${P.AGENT_LABEL[bot.agent]} is not available.`);
        return null;
      }
      const upTo = g.messages.length;
      isNew = !bot.chatId;
      const folder = this.folderOf(g, bot);
      const chatId = bot.chatId ?? randomUUID();
      if (isNew) {
        // known as a bot chat before it shows in the agent's list (the drawer never lists it)
        bot.chatId = chatId;
        this.save(g);
        this.api.refreshConversations();
      }
      gate.chatId = chatId;
      gate.agent = bot.agent;
      let ct: ReturnType<typeof crew.turn> = null;
      try {
        ct = crew.turn(g.id, bot.id, chatId);
      } catch (e) {
        this.api.log(`crew setup of ${bot.name}: ${errText(e)}`);
      }
      end = ct?.end ?? null;
      const ctx: P.TurnContext = { reason: q.reason, finalTurn: g.turnsPerMember > 1 && used + 1 >= g.turnsPerMember, summary: this.store.summary(g.id) };
      const base = isNew ? P.introPrompt(g, bot, ctx, folder, !ct) : P.turnPrompt(g, bot, ctx);
      // what it remembers that fits these lines (never in its stable prompt: only when something matches)
      const recall = crew.recall?.(bot.id, base.slice(-3000)) ?? '';
      const text = `${recall ? `${recall}\n\n` : ''}${base}${q.extra ? `\n\n${q.extra}` : ''}`;
      const res = await runTurn({
        backend,
        agent: bot.agent,
        chatId,
        isNew,
        text,
        attachments: this.newFiles(g, isNew ? Math.max(0, upTo - 30) : bot.seen, upTo, bot.id),
        modelId: bot.modelId,
        folder,
        effort: bot.effort,
        setup: ct?.setup ?? null,
        access: ct?.setup.access ?? CREW_ACCESS[bot.access],
        cancelled: () => gate.cancelled,
        isRunning: bot.agent === 'AGY' ? () => !!this.api.conversations().find((c) => c.id === chatId)?.isRunning : undefined,
        onActivity: (a) => this.setTyping(g, rt, bot.id, a.kind, a.step),
        questionNote: 'This is a room: ask the room in your reply instead.',
        // its permission requests: by its level and your rules, else the Inbox ("in #Ops")
        approve: (a) => crew.approve(bot.id, a, `in #${g.title}`, folder, { engine: bot.agent, chatId }, ct?.setup.access ?? CREW_ACCESS[bot.access]),
      });
      if (res.cancelled) return null;
      bot.seen = upTo;
      if (res.usage) crew.logUsage({ botId: bot.id, roomId: g.id, kind: 'room', input: res.usage.promptTokens, output: res.usage.outputTokens, cached: res.usage.cachedTokens, costUsd: res.usage.costUsd ?? null });
      let out = P.stripPrefix(res.text, bot.name);
      // a lead's goal turn ends with a control block: followed, not posted
      let control: GL.Control | null = null;
      if (q.goal === 'lead') ({ text: out, control } = GL.parseControl(out));
      if (P.isPass(out)) {
        if (res.error) this.addNote(g, `${bot.name} could not reply: ${res.error}`);
        else if (q.reason === 'nudge') rt.nudgePasses++;
        this.save(g);
        return q.goal && !res.error ? { bot, q, text: '', m: {}, control } : null;
      }
      crew.turnDone?.(bot.id, `#${g.title}`, base.slice(-2000), out);
      const digest = digestOf(res.evidence);
      return {
        bot,
        q,
        control,
        text: out,
        m: {
          ...(digest ? { digest, evidence: res.evidence } : {}),
          ...(res.usage ? { usage: { input: res.usage.promptTokens, output: res.usage.outputTokens, cached: res.usage.cachedTokens, costUsd: res.usage.costUsd ?? null } } : {}),
        },
      };
    } catch (e) {
      if (isNew) {
        bot.chatId = null;
        this.save(g);
      }
      this.addNote(g, `${bot.name} could not reply: ${errText(e)}`);
      return null;
    } finally {
      end?.();
      release?.();
      rt.turns.delete(gate);
      rt.typing.delete(bot.id);
      this.emitState(g.id);
    }
  }

  private publish(g: Group, rt: Runtime, d: Draft) {
    if (!g.bots.includes(d.bot)) {
      d.q.done?.(null);
      return;
    }
    if (!d.text) {
      d.q.done?.(null);
      if (d.q.goal) this.goalAfter(g, rt, d);
      return;
    }
    const m: Msg = { id: shortId(), from: d.bot.id, name: d.bot.name, text: d.text, at: Date.now(), attachments: [], picked: d.q.picked, ...d.m };
    g.messages.push(m);
    g.botTurns++;
    rt.nudgePasses = 0;
    this.save(g);
    this.emitMessages(g, [m]);
    d.q.done?.(m.text);
    // a goal turn is followed by the goal's own next step, not by mention chains
    if (d.q.goal) this.goalAfter(g, rt, d);
    else this.reactBot(g, rt, m, d.bot);
  }

  // ------------------------------------------------------------------ room goals

  /** A goal the lead drives in bounded team turns (docs/crew/PLAN.md §7 "Goals"). */
  startGoal(ref: string, text: string, maxTurns = 13) {
    const g = this.need(ref);
    const goal = text.trim().slice(0, 2000);
    if (!goal) throw new Error('Say what the goal is.');
    if (!g.bots.length) throw new Error('Add members first.');
    const now = Date.now();
    g.goal = { text: goal, status: 'running', turns: 0, maxTurns: Math.max(1, Math.min(100, Math.round(maxTurns) || 13)), note: '', startedAt: now, updatedAt: now };
    this.runtime(g.id).goalMisses = 0;
    const lead = this.goalLeader(g);
    this.addNote(g, `🎯 New room goal${lead ? `, led by ${lead.name}` : ''}: ${goal}`, true);
    this.save(g);
    this.goalLead(g);
  }

  stopGoal(ref: string) {
    const g = this.need(ref);
    if (!g.goal || g.goal.status !== 'running') return;
    this.endGoal(g, 'stopped', '🎯 Goal stopped.');
  }

  /** More turns for a goal that stopped, needs input or was blocked. */
  continueGoal(ref: string) {
    const g = this.need(ref);
    if (!g.goal || g.goal.status === 'running' || g.goal.status === 'completed') return;
    g.goal = { ...g.goal, status: 'running', maxTurns: g.goal.turns + Math.max(5, g.goal.maxTurns), updatedAt: Date.now() };
    this.runtime(g.id).goalMisses = 0;
    this.save(g);
    this.goalLead(g, '(The user asked you to go on.)');
  }

  /** Who drives the goal: the lead, or the first member that can answer. */
  private goalLeader(g: Group): Bot | undefined {
    const active = this.active(g);
    return active.find((b) => b.id === g.lead) ?? active[0];
  }

  private goalLead(g: Group, extra = '') {
    const goal = g.goal;
    if (!goal || goal.status !== 'running') return;
    const lead = this.goalLeader(g);
    if (!lead) {
      this.endGoal(g, 'stopped', '🎯 Goal stopped: no member can answer now.');
      return;
    }
    const others = this.active(g).filter((b) => b.id !== lead.id).map((b) => b.name);
    this.enqueue(g, { botId: lead.id, reason: 'goal', goal: 'lead', picked: { by: 'goal', why: `turn ${goal.turns + 1}/${goal.maxTurns}` }, extra: GL.leadInstruction(goal.text, goal.turns + 1, goal.maxTurns, others, extra) });
    void this.pump(g.id);
  }

  private endGoal(g: Group, status: 'completed' | 'needs-input' | 'blocked' | 'stopped', note: string) {
    if (!g.goal) return;
    g.goal = { ...g.goal, status, updatedAt: Date.now() };
    const rt = this.runtime(g.id);
    dropItems(rt.queue.filter((q) => q.goal));
    rt.queue = rt.queue.filter((q) => !q.goal);
    this.addNote(g, note, status === 'completed');
    this.save(g);
  }

  /** A goal turn ended: the lead's control block says what happens next; after a member's step the lead goes on. */
  private goalAfter(g: Group, rt: Runtime, d: Draft) {
    const goal = g.goal;
    if (!goal || goal.status !== 'running') return;
    goal.turns++;
    goal.updatedAt = Date.now();
    const out = () => goal.turns >= goal.maxTurns && (this.endGoal(g, 'stopped', `🎯 The goal paused after ${goal.turns} team turns. Say /goal continue (or press Continue) to go on.`), true);
    if (d.q.goal === 'member') {
      if (!out()) this.goalLead(g);
      return;
    }
    const c = d.control;
    if (!c) {
      rt.goalMisses++;
      if (rt.goalMisses >= 2) this.endGoal(g, 'stopped', `🎯 Goal stopped: ${d.bot.name} did not say how it goes (no control line).`);
      else if (!out()) this.goalLead(g, 'Remember: end with the JSON control line.');
      return;
    }
    rt.goalMisses = 0;
    goal.note = c.instruction || goal.note;
    if (c.status === 'completed') return this.endGoal(g, 'completed', `🎯 Goal reached: ${goal.text}${c.instruction ? ` (${c.instruction})` : ''}`);
    if (c.status === 'needs-input') return this.endGoal(g, 'needs-input', `🎯 The goal needs you: ${c.instruction || 'see above'}. Your next message goes to ${d.bot.name}.`);
    if (c.status === 'blocked') return this.endGoal(g, 'blocked', `🎯 The goal is blocked: ${c.instruction || 'see above'}`);
    if (out()) return;
    const next = this.active(g).find((b) => b.id !== d.bot.id && b.name.toLowerCase() === c.next.toLowerCase());
    if (next) this.enqueue(g, { botId: next.id, reason: 'goal', goal: 'member', picked: { by: 'goal', why: `asked by ${d.bot.name}` }, extra: GL.stepInstruction(d.bot.name, goal.text, c.instruction) });
    else this.goalLead(g, c.next ? `(@${c.next} is not a member who can answer now: pick another or do it yourself.)` : '');
    this.save(g);
  }

  /** A goal turn that did not happen (busy too long, held, an error): the goal goes on without it. */
  private goalMissed(g: Group, q: QItem) {
    if (g.goal?.status !== 'running') return;
    const name = g.bots.find((b) => b.id === q.botId)?.name ?? 'A member';
    if (q.goal === 'member') this.goalLead(g, `(${name} could not take the step: it was busy or did not answer. Pick another member or do it yourself.)`);
    else this.endGoal(g, 'stopped', `🎯 Goal stopped: ${name} (the lead) could not answer.`);
  }

  // ------------------------------------------------------------------ crew jobs

  /** A member answers in the room with its job reports (the work it handed out from here is back). */
  reportTurn(roomId: string, botId: string, text: string): Promise<string | null> {
    return new Promise((resolve) => {
      const g = this.store.get(roomId);
      if (!g || !g.bots.some((b) => b.id === botId && !b.muted)) return resolve(null);
      const rt = this.runtime(g.id);
      // a report starts its own round (the member may hand out more or ask others)
      rt.round = { turns: new Map(), hops: 0 };
      this.enqueue(g, { botId, reason: 'report', picked: { by: 'report' }, extra: text, done: resolve }, true);
      void this.pump(g.id);
    });
  }

  /** A member's line from an automation run (no turn: its result), headed with the automation's name. */
  postAs(roomId: string, botId: string, text: string, label: string) {
    const g = this.store.get(roomId);
    const b = g?.bots.find((x) => x.id === botId);
    if (!g || !b) return;
    const m: Msg = { id: shortId(), from: b.id, name: b.name, text, at: Date.now(), attachments: [], picked: { by: 'automation', why: label } };
    g.messages.push(m);
    this.save(g);
    this.emitMessages(g, [m]);
  }

  /** A line in the room for the user only (a job handed out / reported). */
  note(roomId: string, text: string) {
    const g = this.store.get(roomId);
    if (g) this.addNote(g, text);
  }

  /** Images / files the user shared in lines [from, to) a member has not seen: they go along with its turn. */
  private newFiles(g: Group, from: number, to: number, selfId: string): ChatAttachment[] {
    const out: ChatAttachment[] = [];
    for (let i = from; i < to && i < g.messages.length; i++) {
      const m = g.messages[i];
      if (m.from === selfId) continue;
      for (const a of m.attachments) if (a.path || a.base64) out.push(a);
    }
    return out.slice(-6);
  }

  // ------------------------------------------------------------------ router / moderator

  /** The router's agent: the room's choice, else the lead's, else any usable one. */
  private routerAgent(g: Group): AgentKind | null {
    const usable = this.usableKinds();
    const lead = g.bots.find((b) => b.id === g.lead);
    for (const a of [g.moderatorAgent, lead?.agent, ...usable]) if (a && usable.includes(a)) return a;
    return null;
  }

  /** The room's choice, else the agent's cheapest-looking model (haiku, mini, flash…), else its default. */
  private routerModel(g: Group, agent: AgentKind): string | null {
    if (g.moderatorModelId) return g.moderatorModelId;
    const ms = this.api.backend(agent)?.models().models ?? [];
    const cheap = ms.find((m) => /haiku|mini|flash|lite|nano|small|fast/i.test(`${m.id} ${m.displayName}`));
    return cheap?.id ?? ms.find((m) => m.isDefault)?.id ?? null;
  }

  /** A turn of the room's hidden router thread (router + moderator). */
  private async routerTurn(g: Group, rt: Runtime, text: (isNew: boolean) => string): Promise<string | null> {
    const agent = this.routerAgent(g);
    const backend = agent ? this.api.backend(agent) : undefined;
    if (!agent || !backend) return null;
    if (g.moderatorChatId && g.moderatorAgent && g.moderatorAgent !== agent) this.resetModerator(g);
    const upTo = g.messages.length;
    const isNew = !g.moderatorChatId;
    const chatId = g.moderatorChatId ?? randomUUID();
    if (isNew) {
      g.moderatorChatId = chatId;
      g.moderatorAgent ??= agent;
      this.save(g);
      this.api.refreshConversations();
    }
    const turn: Turn = { botId: null, chatId, agent, cancelled: false };
    rt.turns.add(turn);
    try {
      const res = await runTurn({
        backend,
        agent,
        chatId,
        isNew,
        text: text(isNew),
        modelId: this.routerModel(g, agent),
        folder: this.store.roomDir(g.id),
        effort: 'low',
        access: 'talk',
        cancelled: () => turn.cancelled,
        isRunning: agent === 'AGY' ? () => !!this.api.conversations().find((c) => c.id === chatId)?.isRunning : undefined,
        reask: false,
        timeoutMs: 120_000,
        settleMs: 300,
      });
      if (res.cancelled) return null;
      g.moderatorSeen = upTo;
      this.save(g);
      return res.text;
    } catch (e) {
      if (isNew) {
        g.moderatorChatId = null;
        this.save(g);
      }
      throw e;
    } finally {
      rt.turns.delete(turn);
    }
  }

  /** Auto mode, the heuristic was unsure: the router model picks within ROOM_TIMING.routerBudgetMs (null = slow / failed). */
  private async askRouter(g: Group, rt: Runtime, msg: Msg): Promise<R.RouterPick | null> {
    if (rt.routerBusy) return null;
    rt.routerBusy = true;
    rt.status = 'Picking who answers…';
    this.emitState(g.id);
    const run = this.routerTurn(g, rt, (isNew) => (isNew ? R.routerIntro(g, msg) : R.routerTurn(g, msg)))
      .then((t) => (t === null ? null : R.parseRouter(t, g)))
      .catch((e) => {
        this.api.log(`router of ${g.title}: ${errText(e)}`);
        return null;
      })
      .finally(() => (rt.routerBusy = false));
    const r = await Promise.race([run, sleep(ROOM_TIMING.routerBudgetMs).then(() => 'slow' as const)]);
    rt.status = null;
    this.emitState(g.id);
    return r === 'slow' ? null : r;
  }

  private async runModerator(g: Group, rt: Runtime) {
    rt.status = 'The moderator is choosing who speaks…';
    this.emitState(g.id);
    try {
      const t = await this.routerTurn(g, rt, (isNew) => (isNew ? R.moderatorIntro(g, P.transcript(g, Math.max(0, g.messages.length - 30), g.messages.length, null)) : R.moderatorTurn(g)));
      if (t === null) return;
      for (const b of R.parsePicks(t, g)) this.enqueue(g, { botId: b.id, reason: 'pick', picked: { by: 'moderator' } });
    } finally {
      rt.status = null;
      this.emitState(g.id);
    }
  }

  // ------------------------------------------------------------------ summary

  /** While the room is quiet: older lines fold into summary.md (a throwaway chat on the router's cheap model). */
  private async maybeSummarize(g: Group) {
    const to = g.messages.length - 30;
    if (this.summarizing.has(g.id) || to - g.summaryUpTo < SUMMARY_EVERY - 30 || g.messages.slice(g.summaryUpTo, to).filter(P.isTalk).length < SUMMARY_EVERY - 30) return;
    const agent = this.routerAgent(g);
    const backend = agent ? this.api.backend(agent) : undefined;
    if (!agent || !backend) return;
    this.summarizing.add(g.id);
    const chatId = randomUUID();
    try {
      const res = await runTurn({
        backend,
        agent,
        chatId,
        isNew: true,
        text: P.summaryPrompt(g, this.store.summary(g.id), g.summaryUpTo, to),
        modelId: this.routerModel(g, agent),
        folder: this.store.roomDir(g.id),
        effort: 'low',
        access: 'talk',
        cancelled: () => false,
        reask: false,
        timeoutMs: 180_000,
      });
      const text = res.text.trim();
      if (text && !res.error) {
        this.store.setSummary(g.id, text.slice(0, 4000), to);
        g.summaryUpTo = to;
        this.save(g);
      }
    } catch (e) {
      this.api.log(`summary of ${g.title}: ${errText(e)}`);
    } finally {
      this.summarizing.delete(g.id);
      this.dropChat(agent, chatId);
    }
  }

  // ------------------------------------------------------------------ auto-talk

  /** When the room is quiet for idleSeconds (and someone is looking at it), a member says something. */
  protected armIdle(id: string) {
    const rt = this.runtime(id);
    if (rt.idle) clearTimeout(rt.idle);
    rt.idle = null;
    const g = this.store.get(id);
    if (!g || !g.autoTalk || g.paused || g.waiting || rt.running || rt.nudgePasses >= 3 || !g.messages.some((m) => m.from === 'user')) return;
    if (!this.watchers(id).length) return;
    rt.idle = setTimeout(() => {
      rt.idle = null;
      const cur = this.store.get(id);
      if (!cur || !cur.autoTalk || cur.paused || cur.waiting || rt.running || !this.watchers(id).length) return;
      if (cur.botTurns >= cur.maxBotTurns) {
        this.stopForUser(cur, rt);
        return;
      }
      const lastFrom = [...cur.messages].reverse().find((m) => P.isTalk(m) && m.from !== 'system')?.from;
      const pick = weighted(this.active(cur).filter((b) => b.id !== lastFrom)) ?? weighted(this.active(cur));
      if (!pick) return;
      rt.round = { turns: new Map(), hops: 0 };
      this.enqueue(cur, { botId: pick.id, reason: 'nudge', picked: { by: 'nudge' } });
      void this.pump(id);
    }, g.idleSeconds * 1000);
  }
}

// ------------------------------------------------------------------------------------------------ helpers

/** A random member, more likely the chattier it is. */
function weighted(bots: Bot[]): Bot | undefined {
  if (!bots.length) return undefined;
  const total = bots.reduce((n, b) => n + Math.max(5, b.chattiness), 0);
  let r = Math.random() * total;
  for (const b of bots) {
    r -= Math.max(5, b.chattiness);
    if (r <= 0) return b;
  }
  return bots[bots.length - 1];
}

/** "Create with AI": what the new chat's message box gets. */
function setupRequest(idea: string): string {
  return [
    `Set up an AntiGem crew room for me with the groups_mcp tools${idea ? `: ${idea}` : '.'}`,
    '',
    '1. Ask me in one short question what the room is for, if I did not say.',
    '2. Call group_models to see which agents and models I can use, and mix them (different agents / models make the voices more different).',
    '3. Design 2 to 5 members with distinct names (one word), personas (who they are, how they talk, what they care about), an emoji and a color each; pick chattiness (0 to 100) and access (chat / read / edit) to fit.',
    '4. Show me the cast in a short table and create it with group_create (members included), then open it with group_open.',
    '',
    "If you don't have the groups_mcp tools, tell me to add \"Group Chat\" in Settings → (this agent) → MCP servers.",
  ].join('\n');
}
