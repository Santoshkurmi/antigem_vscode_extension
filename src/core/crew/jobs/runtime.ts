// How bots work together (docs/crew/PLAN.md §8). A bot's turn (its DM, a room turn, or a job of its own) that hands
// out work with crew_assign becomes the root of a job tree; each teammate gets a job that runs as one turn on its work
// thread, opened by a host-written envelope. When ALL of a requester's jobs have settled it gets ONE resume turn with
// every report (observed evidence first, the bot's own account second); a teammate's question interrupts the wait once.
// Loop protection: no handing back up the chain, ≤ 4 levels, the same brief to the same bot is not doubled, per-tree
// budgets, 5 failures in a row stop the tree, a cut turn reruns once (never after an outward action). Acknowledgements
// ("ok, on it") don't wake anyone.
import { randomUUID } from 'node:crypto';
import type { AgentKind } from '../../../../shared/model';
import type { ApprovalView } from '../../../../shared/protocol';
import type { AgentBackend } from '../../types';
import type { ApproveResult } from '../access/broker';
import type { Crew } from '../crew';
import type { BotLocks } from '../locks';
import { ENGINE_LABEL } from '../prompts/stable';
import { newId } from '../store/store';
import { emptyEvidence } from '../turns/evidence';
import { runTurn, type TurnResult } from '../turns/runner';
import { SETTLED, type Artifact, type BotProfile, type CrewAccess, type Evidence, type JobRow, type ThreadRecord } from '../types';
import * as GL from '../goals';
import * as CK from './check';
import * as JP from './prompts';
import { JobStore, normalizeJob } from './store';

export const LIMITS = { to: 4, depth: 4, requests: 24, runs: 48, wakes: 48, total: 300, failuresInRow: 5, selfThreads: 5, resultChars: 12_000, lockWaitMs: 30 * 60_000, roomWaitMs: 40 * 60_000 };
const ACK = /^\W*(ok(ay)?|got it|thanks?( you)?|thx|will do|on it|sure|noted|understood|roger|sounds good|👍|✅)\b/i;
const RANK: CrewAccess[] = ['talk', 'read', 'edit', 'auto', 'full'];

export interface JobsApi {
  backend(kind: AgentKind): AgentBackend | undefined;
  workspaceFolder(): string | null;
  /** Antigravity: whether the chat runs (its state may lag). */
  isRunning(engine: AgentKind, chatId: string): boolean;
  userName(): string;
  /** A room member answers in its room with these reports; resolves with what it posted (null = nothing). */
  roomTurn?(roomId: string, botId: string, text: string): Promise<string | null>;
  /** A line in a room for the user only (job handed out / reported). */
  roomNote?(roomId: string, text: string): void;
  /** Jobs changed (Mission Control); `chats`: a new hidden chat appeared (the chat list hides it). */
  changed(chats?: boolean): void;
  /** A job turn's permission request: by the bot's level and the user's rules, or an Inbox item to wait on. */
  approve?(botId: string, a: ApprovalView, where: string, folders: string[], chat: { engine: AgentKind; chatId: string }, access: CrewAccess): ApproveResult;
  /** The bot (or everyone) is paused: its jobs wait. */
  isPaused?(botId: string): boolean;
  /** One question to the engine's cheapest model (the goal judge); '' when it failed. */
  cheapTurn?(engine: AgentKind, text: string): Promise<string>;
  /** A job failed (the Chief looks at it). */
  onFailed?(job: JobRow): void;
  /** A toast with an Open button. */
  notify?(text: string, open: () => void): void;
  /** Notes the bot recalls for this text ('' = none). */
  recall?(botId: string, text: string): string;
  /** A job turn ended (memory capture). */
  onTurnDone?(botId: string, where: string, ask: string, reply: string): void;
  /** Check before done: the checker's verdict on a job's result (null = no checker could run). */
  checkWork?(j: JobRow, bot: BotProfile): Promise<{ by: string; reply: string } | null>;
  /** Why new work may not start (the crew's daily budget is used up), or null. */
  overBudget?(): string | null;
  log(line: string): void;
}

export interface AssignInput {
  to: unknown;
  brief: unknown;
  done_when?: unknown;
  mode?: unknown;
  thread?: unknown;
  title?: unknown;
  files?: unknown;
}

interface Flag {
  cancelled: boolean;
  paused?: boolean;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const PAUSED_NOTE = '(You were paused in the middle of this. Check what is done already and go on.)\n\n';
const settled = (j: JobRow) => SETTLED.includes(j.status);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** "a, b" / ["a","b"] / '["a"]' → list. */
export function listOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v ?? '').trim();
  if (s.startsWith('[')) {
    try {
      return listOf(JSON.parse(s));
    } catch {
      /* plain text */
    }
  }
  return s
    .split(/[,\n]|\band\b/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export class JobRuntime {
  readonly store: JobStore;
  /** thread → the job its current turn works on */
  private turnJob = new Map<string, string>();
  /** threads whose current turn this runtime runs (it settles them itself) */
  private own = new Set<string>();
  /** job → its running turn's flags (cancelled: stop it; paused: it goes back to the queue) */
  private live = new Map<string, Flag>();

  constructor(
    private crew: Crew,
    private locks: BotLocks,
    private api: JobsApi,
  ) {
    this.store = new JobStore(crew.store.root);
    // bot goals that wait for later (or were cut by a restart) go on at their time
    for (const j of this.store.all()) if (j.goal && !j.parentId && j.status === 'waiting' && j.goal.nextAt && !j.goal.paused) this.goalTimer(j);
  }

  private timers = new Map<string, NodeJS.Timeout>();

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const f of this.live.values()) f.cancelled = true;
    this.store.flush();
  }

  private bot(id: string | null | undefined): BotProfile | null {
    return id ? this.crew.store.bot(id) : null;
  }

  private rootOf(j: JobRow): JobRow {
    return this.store.get(j.rootId) ?? j;
  }

  private save(j: JobRow, event?: Record<string, unknown>) {
    this.store.put(j);
    if (event) this.store.event({ job: j.id, root: j.rootId, ...event });
    this.api.changed();
  }

  // ------------------------------------------------------------------ turns the crew runs (DMs, rooms)

  /** The job a thread's current turn works on (a DM or room turn becomes a root when it first hands work out). */
  private currentJob(t: ThreadRecord): JobRow {
    const id = this.turnJob.get(t.id);
    const have = id ? this.store.get(id) : null;
    if (have) return have;
    const bot = this.bot(t.botId);
    if (!bot) throw new Error('This crew thread has no bot.');
    const quote = this.lastAsk(t);
    const now = Date.now();
    const rid = newId('j');
    const root = normalizeJob({
      id: rid,
      rootId: rid,
      parentId: null,
      depth: 0,
      origin: { kind: t.kind === 'room' ? 'room' : t.kind === 'automation' ? 'automation' : 'person', quote: quote.slice(0, 400), roomId: t.roomId },
      requester: { botId: null, threadId: null },
      assignee: { botId: bot.id, threadId: t.id },
      mode: 'work',
      reply: 'none',
      title: '',
      brief: quote.slice(0, 2000),
      status: 'running',
      level: this.crew.setupFor(t).access,
      budget: { requests: 0, runs: 0, wakes: 0, failuresInRow: 0 },
      createdAt: now,
      startedAt: now,
    });
    this.turnJob.set(t.id, root.id);
    this.save(root, { kind: 'root', bot: bot.id, quote: root.origin.quote });
    return root;
  }

  /** What the user last asked in this thread (the root's quote). */
  private lastAsk(t: ThreadRecord): string {
    if (!t.chatId) return '';
    try {
      const msgs = this.api.backend(t.engine)?.getState(t.chatId).messages ?? [];
      const last = [...msgs].reverse().find((m) => m.role === 'USER');
      const text = (last?.sentContent ?? last?.content ?? '').replace(/<antigem-expansion[^>]*>[\s\S]*?<\/antigem-expansion>/g, ' ').trim();
      return text.length > 400 ? `…${text.slice(-399)}` : text;
    } catch {
      return '';
    }
  }

  /** A DM or room turn the crew tracks ended: a root it started now waits for its jobs. */
  turnEnded(threadId: string) {
    if (this.own.has(threadId)) return;
    const id = this.turnJob.get(threadId);
    if (!id) return;
    this.turnJob.delete(threadId);
    const j = this.store.get(id);
    if (!j || j.parentId || j.status !== 'running') return;
    const kids = this.store.children(j.id).filter((c) => c.reply === 'resume');
    if (!kids.length) {
      this.finish(j, j.result ?? '', 'handed out only notes');
      return;
    }
    j.status = 'waiting';
    this.save(j, { kind: 'waiting' });
    this.maybeWake(j);
  }

  // ------------------------------------------------------------------ crew tools

  /** crew_assign */
  assign(caller: ThreadRecord, a: AssignInput): string {
    const me = this.bot(caller.botId);
    if (!me) throw new Error('This crew thread has no bot.');
    const names = listOf(a.to).map((n) => n.replace(/^@/, ''));
    if (!names.length) throw new Error('Name 1 to 4 teammates in "to" (crew_roster lists them).');
    if (names.length > LIMITS.to) throw new Error(`Hand work to at most ${LIMITS.to} teammates at once.`);
    const brief = String(a.brief ?? '').trim();
    if (brief.length < 3) throw new Error('Write a brief: what to do, with everything they need (they do not see your chat).');
    const mode = a.mode === 'consult' || a.mode === 'notify' ? a.mode : 'work';
    const bots = this.crew.store.bots();
    const targets: BotProfile[] = [];
    for (const n of names) {
      const b = bots.find((x) => x.name.toLowerCase() === n.toLowerCase());
      if (!b) throw new Error(`No teammate called @${n}. Teammates: ${bots.filter((x) => x.id !== me.id).map((x) => `@${x.name}`).join(', ') || 'none yet'}.`);
      if (b.id === me.id) throw new Error('That is you: use crew_thread to work on something in parallel yourself.');
      if (b.paused) throw new Error(`@${b.name} is paused.`);
      const over = this.api.overBudget?.();
      if (over) throw new Error(`Not handed out: ${over}. Tell ${this.api.userName()} (they can raise it on the Crew screen).`);
      if (!targets.includes(b)) targets.push(b);
    }
    const parent = this.currentJob(caller);
    const root = this.rootOf(parent);
    // never hand work back up the chain (that is what ending your turn does)
    for (let up: JobRow | null = parent; up; up = up.parentId ? this.store.get(up.parentId) : null) {
      const asker = up.requester.botId;
      const t = targets.find((b) => b.id === asker);
      if (t) throw new Error(`@${t.name} is waiting for your work (they asked for it): report back by ending your turn instead of handing work to them.`);
    }
    if (parent.depth + 1 > LIMITS.depth) throw new Error(`Jobs go at most ${LIMITS.depth} levels deep: do this part yourself.`);
    const budget = root.budget!;
    if (budget.requests + targets.length > LIMITS.requests) throw new Error(`This task has handed out ${budget.requests} jobs already (limit ${LIMITS.requests}): finish with what you have.`);
    if (this.store.tree(root.id).length + targets.length > LIMITS.total) throw new Error('This task tree is too big: finish with what you have.');
    const title = String(a.title ?? '').trim().slice(0, 80);
    const doneWhen = a.done_when ? String(a.done_when).trim().slice(0, 600) : null;
    const files = listOf(a.files).slice(0, 5);
    const thread = a.thread === 'new' ? 'new' : 'standing';
    const now = Date.now();
    const lines: string[] = [];
    const made: JobRow[] = [];
    for (const b of targets) {
      const dup = this.store.children(parent.id).find((c) => c.assignee.botId === b.id && norm(c.brief) === norm(brief) && c.status !== 'cancelled');
      if (dup) {
        lines.push(`@${b.name} already has this as job ${dup.id} (${dup.status}).`);
        continue;
      }
      const level = this.levelFor(b, mode, me);
      const j = normalizeJob({
        id: newId('j'),
        rootId: root.id,
        parentId: parent.id,
        depth: parent.depth + 1,
        origin: root.origin,
        requester: { botId: me.id, threadId: caller.id },
        assignee: { botId: b.id, threadId: null },
        mode,
        reply: mode === 'notify' ? 'none' : 'resume',
        title,
        brief: brief.slice(0, 8000),
        doneWhen,
        files,
        thread,
        status: 'queued',
        level,
        createdAt: now,
      });
      made.push(j);
      this.save(j, { kind: 'assigned', from: me.id, to: b.id, mode });
      lines.push(`@${b.name}: job ${j.id}`);
    }
    budget.requests += made.length;
    this.save(root);
    for (const j of made) void this.run(j);
    if (made.length && root.origin.roomId) this.api.roomNote?.(root.origin.roomId, `🧩 ${me.name} handed work to ${made.map((j) => `@${this.bot(j.assignee.botId)?.name}`).join(', ')}: ${title || brief.split('\n')[0].slice(0, 100)}`);
    const back = mode === 'notify' ? 'No report comes back (notify).' : 'Their reports come back to you in ONE message when all are done: end your turn now.';
    return `${lines.join('\n')}\n${made.length ? back : ''}`.trim();
  }

  /**
   * The level a job runs at: the assignee's own; work the Chief hands out runs at max(own, the Chief's), never above
   * the assignee's highest level; a consultation reads only.
   */
  private levelFor(b: BotProfile, mode: JobRow['mode'], requester: BotProfile | null = null): CrewAccess {
    let lvl = this.crew.effectiveAccess(b);
    if (requester && this.crew.store.settings().chiefId === requester.id) {
      const chief = this.crew.effectiveAccess(requester);
      if (RANK.indexOf(chief) > RANK.indexOf(lvl)) lvl = RANK[Math.min(RANK.indexOf(chief), RANK.indexOf(b.accessCeiling))];
    }
    return mode === 'consult' && RANK.indexOf(lvl) > RANK.indexOf('read') ? 'read' : lvl;
  }

  /** crew_answer: the requester answers a teammate's question. */
  answer(caller: ThreadRecord | null, ref: string, answer: string): string {
    const j = this.find(ref);
    if (caller && j.requester.botId !== caller.botId) throw new Error('You can only answer questions on jobs you handed out.');
    if (j.status !== 'needs_input') throw new Error(`Job ${j.id} is ${j.status}: there is no question to answer.`);
    if (!answer.trim()) throw new Error('Write the answer.');
    j.answer = answer.trim().slice(0, 4000);
    j.asked = false;
    j.status = 'queued';
    this.save(j, { kind: 'answered', by: caller?.botId ?? 'user' });
    void this.run(j, JP.answerText(j, caller ? this.bot(caller.botId) : null, answer));
    return `Sent to @${this.bot(j.assignee.botId)?.name ?? '?'}. Its report comes back with the others.`;
  }

  private find(ref: string): JobRow {
    const r = String(ref ?? '').trim();
    const j = this.store.get(r) ?? this.store.all().find((x) => x.id.endsWith(r.replace(/^j_/, '')) && r.length >= 4);
    if (!j) throw new Error(`No job ${r}.`);
    return j;
  }

  /** crew_jobs */
  list(caller: ThreadRecord, ref?: string): string {
    const bots = new Map(this.crew.store.bots().map((b) => [b.id, b]));
    if (ref) {
      const j = this.find(ref);
      const out = [JP.jobLine(j, bots), `Brief: ${j.brief.slice(0, 1500)}`];
      if (j.doneWhen) out.push(`Done when: ${j.doneWhen}`);
      if (j.question) out.push(`Question: ${j.question}${j.answer ? `\nAnswer: ${j.answer}` : ''}`);
      if (j.evidence?.toolCalls) out.push(`Observed: ${JP.reportsText([{ job: j, bot: bots.get(j.assignee.botId) ?? null }], false, '', false).split('\n').find((l) => l.startsWith('Observed')) ?? ''}`);
      if (j.result) out.push(`Result: ${j.result.slice(0, 3000)}`);
      const kids = this.store.children(j.id);
      if (kids.length) out.push('Its jobs:', ...kids.map((k) => JP.jobLine(k, bots)));
      return out.join('\n');
    }
    const day = Date.now() - 24 * 3600_000;
    const mine = this.store
      .all()
      .filter((j) => j.parentId && (j.requester.botId === caller.botId || j.assignee.botId === caller.botId) && (!settled(j) || j.updatedAt > day))
      .sort((a, b) => Number(settled(a)) - Number(settled(b)) || b.updatedAt - a.updatedAt)
      .slice(0, 20);
    return mine.length ? mine.map((j) => JP.jobLine(j, bots)).join('\n') : 'No jobs sent or received in the last day.';
  }

  /** Open jobs of a bot (crew_roster). */
  openLines(botId: string): string[] {
    const bots = new Map(this.crew.store.bots().map((b) => [b.id, b]));
    return this.store
      .all()
      .filter((j) => j.parentId && !settled(j) && (j.assignee.botId === botId || j.requester.botId === botId))
      .slice(0, 10)
      .map((j) => JP.jobLine(j, bots));
  }

  /** crew_report: structured results for the job the caller works on now. */
  report(caller: ThreadRecord, summary: unknown, artifacts: unknown): string {
    const id = this.turnJob.get(caller.id);
    const j = id ? this.store.get(id) : null;
    if (!j) throw new Error('crew_report attaches results to a job; you are not working on one now.');
    let list: unknown = artifacts;
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list);
      } catch {
        list = [{ kind: 'data', title: 'note', text: list }];
      }
    }
    const items = (Array.isArray(list) ? list : list ? [list] : []).slice(0, 20).map((x): Artifact | null => {
      const o = (x ?? {}) as Record<string, unknown>;
      const p = typeof o.path === 'string' ? o.path : undefined;
      const url = typeof o.url === 'string' ? o.url : undefined;
      const text = typeof o.text === 'string' ? o.text.slice(0, 8000) : typeof o.data === 'string' ? o.data.slice(0, 8000) : undefined;
      const kind = ['file', 'diff', 'link', 'data'].includes(String(o.kind)) ? (o.kind as Artifact['kind']) : url ? 'link' : p ? 'file' : 'data';
      if ((kind === 'file' || kind === 'diff') && !p) return null;
      if (kind === 'link' && !url) return null;
      return { kind, title: String(o.title ?? (p ? JP.fileTitle(p) : (url ?? 'data'))).slice(0, 120), ...(p ? { path: p } : {}), ...(url ? { url } : {}), ...(text ? { text } : {}) };
    });
    const ok = items.filter((x): x is Artifact => !!x);
    j.artifacts = [...j.artifacts, ...ok].slice(-30);
    if (summary) j.outcome = String(summary).trim().split('\n')[0].slice(0, 200);
    this.save(j, { kind: 'report', artifacts: ok.length });
    return `Attached ${ok.length} item${ok.length === 1 ? '' : 's'} to job ${j.id}${items.length > ok.length ? ` (${items.length - ok.length} skipped: a file needs "path", a link "url")` : ''}.`;
  }

  /** crew_thread: parallel work on yourself (start / list / close). */
  thread(caller: ThreadRecord, action: unknown, a: Record<string, unknown>): string {
    const me = this.bot(caller.botId);
    if (!me) throw new Error('This crew thread has no bot.');
    const bots = new Map(this.crew.store.bots().map((b) => [b.id, b]));
    const mine = () => this.store.all().filter((j) => j.thread === 'self' && j.assignee.botId === me.id && !settled(j));
    if (action === 'list') return mine().map((j) => JP.jobLine(j, bots)).join('\n') || 'No threads of yours are open.';
    if (action === 'close') {
      const j = this.find(String(a.id ?? ''));
      if (j.thread !== 'self' || j.assignee.botId !== me.id) throw new Error('That is not one of your threads.');
      this.stop(j.id, 'closed');
      return `Closed ${j.id}.`;
    }
    const brief = String(a.message ?? a.brief ?? '').trim();
    if (brief.length < 3) throw new Error('Say what the thread should do in "message".');
    if (mine().length >= LIMITS.selfThreads) throw new Error(`You have ${LIMITS.selfThreads} threads open: wait for them or close one.`);
    const parent = this.currentJob(caller);
    const root = this.rootOf(parent);
    if (parent.depth + 1 > LIMITS.depth) throw new Error(`Jobs go at most ${LIMITS.depth} levels deep: do this part yourself.`);
    if (root.budget!.requests + 1 > LIMITS.requests) throw new Error('This task has handed out too much work already: finish with what you have.');
    const j = normalizeJob({
      id: newId('j'),
      rootId: root.id,
      parentId: parent.id,
      depth: parent.depth + 1,
      origin: root.origin,
      requester: { botId: me.id, threadId: caller.id },
      assignee: { botId: me.id, threadId: null },
      mode: 'work',
      reply: a.report_back === false ? 'none' : 'resume',
      title: String(a.title ?? '').trim().slice(0, 80),
      brief: brief.slice(0, 8000),
      thread: 'self',
      status: 'queued',
      level: this.crew.effectiveAccess(me),
      createdAt: Date.now(),
    });
    root.budget!.requests++;
    this.save(root);
    this.save(j, { kind: 'thread', bot: me.id });
    void this.run(j);
    return `Started thread ${j.id}. ${j.reply === 'resume' ? 'Its report comes back to you with the others: end your turn now.' : ''}`.trim();
  }

  // ------------------------------------------------------------------ running jobs

  /** The thread a job runs in: the bot's standing work thread, or one of its own. */
  private threadFor(j: JobRow, b: BotProfile): ThreadRecord {
    if (j.assignee.threadId) {
      const t = this.crew.store.thread(j.assignee.threadId);
      if (t) return t;
    }
    const now = Date.now();
    let t = j.thread === 'standing' ? this.crew.store.threads().find((x) => x.kind === 'work' && x.botId === b.id && !x.jobId) : undefined;
    if (t && t.engine !== b.engine) t = { ...t, engine: b.engine, chatId: null, setupKey: null };
    if (!t) t = { id: newId('t'), botId: b.id, engine: b.engine, chatId: null, kind: 'work', roomId: null, jobId: j.thread === 'standing' ? null : j.id, seen: 0, setupKey: null, createdAt: now, updatedAt: now };
    this.crew.store.putThread(t);
    j.assignee.threadId = t.id;
    this.store.put(j);
    return t;
  }

  /** "for Lead's job: write the tests" (the Inbox says why a job turn asks). */
  private whereOf(j: JobRow): string {
    const r = this.bot(j.requester.botId);
    const what = j.title || j.brief.split('\n')[0].slice(0, 60);
    return j.parentId ? `for ${r ? `${r.name}'s` : 'a'} job: ${what}` : 'in its DM (reading reports)';
  }

  /** Folders its edits may change without asking: where it works and its own crew folder. */
  private foldersOf(b: BotProfile, access: CrewAccess): string[] {
    return [...new Set([this.folderFor(b, access), this.crew.store.botFolder(b.id)])];
  }

  private folderFor(b: BotProfile, access: CrewAccess): string {
    if (access === 'talk' || access === 'read') return this.crew.store.botFolder(b.id);
    return b.folder ?? this.api.workspaceFolder() ?? this.crew.store.botFolder(b.id);
  }

  private envelopeOf(j: JobRow): string {
    const recall = this.api.recall?.(j.assignee.botId, j.brief) ?? '';
    return `${recall ? `${recall}\n\n` : ''}${JP.envelope({ job: j, requester: this.bot(j.requester.botId), userName: this.api.userName(), rootQuote: this.rootOf(j).origin.quote })}`;
  }

  /** Runs one turn of a job (its envelope, or an answer) once its bot is free. */
  private async run(j: JobRow, text?: string) {
    const b = this.bot(j.assignee.botId);
    if (!b) return this.fail(j, 'its bot was deleted');
    const root = this.rootOf(j);
    if (root.budget && root.budget.runs >= LIMITS.runs) return this.fail(j, `the task ran out of turns (${LIMITS.runs})`);
    const flag: Flag = { cancelled: false };
    this.live.set(j.id, flag);
    let res: TurnResult | null = null;
    let sentText = text ?? null;
    try {
      // a paused bot's jobs wait (queued) until it is resumed
      if (!(await this.untilUnpaused(b.id, flag))) return;
      // parallel work on itself runs next to the turn that started it; anything else waits until the bot is free
      const release =
        j.thread === 'self' ? this.locks.mark(b.id, `job ${JP.shortId(j.id)}`) : await this.locks.acquire(b.id, `job ${JP.shortId(j.id)}`, { cancelled: () => flag.cancelled, timeoutMs: LIMITS.lockWaitMs });
      if (!release) {
        if (!flag.cancelled) this.fail(j, `@${b.name} stayed busy elsewhere`);
        return;
      }
      try {
        const cur = this.store.get(j.id) ?? j;
        if (cur.status === 'cancelled') return;
        // paused while it waited for the bot: back to waiting for the resume
        if (this.api.isPaused?.(b.id)) {
          flag.paused = true;
          return;
        }
        const thread = this.threadFor(cur, b);
        cur.status = 'running';
        cur.startedAt ??= Date.now();
        cur.executions++;
        this.save(cur, { kind: 'running', run: cur.executions });
        if (root.budget) {
          root.budget.runs++;
          this.store.put(root);
        }
        sentText = text ?? this.envelopeOf(cur);
        res = await this.turn(cur, thread, b, sentText, flag);
      } finally {
        release();
      }
    } catch (e) {
      if (!flag.cancelled) this.cut(j.id, errText(e), text);
      return;
    } finally {
      if (this.live.get(j.id) === flag) this.live.delete(j.id);
    }
    if (flag.paused) {
      // stopped by a pause: back in the queue, it goes on when the bot is resumed
      const cur = this.store.get(j.id);
      if (cur && !settled(cur)) {
        const ran = cur.status === 'running';
        cur.status = 'queued';
        this.save(cur, { kind: 'paused' });
        void this.run(cur, ran ? PAUSED_NOTE + (sentText ?? this.envelopeOf(cur)) : text);
      }
      return;
    }
    if (res) this.afterTurn(j.id, res, text);
  }

  /** Waits while the bot (or everyone) is paused; false = the job was stopped meanwhile. */
  private async untilUnpaused(botId: string, flag: Flag): Promise<boolean> {
    let told = false;
    while (this.api.isPaused?.(botId)) {
      if (flag.cancelled && !flag.paused) return false;
      if (!told) {
        told = true;
        this.api.changed();
      }
      await sleep(1000);
    }
    return !flag.cancelled;
  }

  /** Paused bots: their running job turns stop and go back to the queue. */
  pause(botIds: string[]) {
    const ids = new Set(botIds);
    for (const [jobId, f] of this.live) {
      const j = this.store.get(jobId);
      if (j && ids.has(j.assignee.botId) && (j.status === 'running' || j.status === 'resume')) {
        f.paused = true;
        f.cancelled = true;
      }
    }
  }

  /** Resumed bots: requesters that waited while paused get their reports. */
  resumeBots(botIds: string[]) {
    const ids = new Set(botIds);
    for (const j of this.store.all()) if (j.status === 'waiting' && ids.has(j.assignee.botId)) this.maybeWake(j);
  }

  /** A turn that broke off (the agent failed to start or answer): it runs once more, never after an outward action. */
  private cut(id: string, why: string, text?: string, outwardNow = false) {
    const j = this.store.get(id);
    if (!j || settled(j)) return;
    if (j.executions < 2 && !outwardNow && !j.evidence?.outward.length) {
      j.status = 'queued';
      this.save(j, { kind: 'rerun', why });
      void this.run(j, text);
      return;
    }
    this.fail(j, why);
  }

  /** One turn on a DM or work thread with the bot's crew setup at the job's level. */
  private async turn(j: JobRow, thread: ThreadRecord, b: BotProfile, text: string, flag: Flag): Promise<TurnResult> {
    const backend = this.api.backend(thread.engine);
    const st = backend?.status().state;
    if (!backend || st === 'not_installed' || st === 'disabled') throw new Error(`${ENGINE_LABEL[thread.engine]} is not available`);
    const isNew = !thread.chatId;
    const chatId = thread.chatId ?? randomUUID();
    let t = thread;
    if (isNew) {
      t = { ...thread, chatId };
      this.crew.store.putThread(t);
    }
    const setup = this.crew.setupFor(t, j.level);
    this.crew.identity.beginTurn(t.id);
    this.turnJob.set(t.id, j.id);
    this.own.add(t.id);
    this.api.changed(isNew);
    try {
      return await runTurn({
        backend,
        agent: t.engine,
        chatId,
        isNew,
        text,
        modelId: b.model,
        folder: this.folderFor(b, setup.access),
        effort: b.effort,
        setup,
        access: setup.access,
        cancelled: () => flag.cancelled,
        isRunning: t.engine === 'AGY' ? () => this.api.isRunning('AGY', chatId) : undefined,
        questionNote: 'Put your question in your reply as a last line "NEEDS INPUT: <question>" instead.',
        approve: this.api.approve ? (a) => this.api.approve!(b.id, a, this.whereOf(j), this.foldersOf(b, setup.access), { engine: t.engine, chatId }, setup.access) : undefined,
      });
    } catch (e) {
      if (isNew) this.crew.store.putThread({ ...t, chatId: null });
      throw e;
    } finally {
      this.crew.identity.endTurn(t.id);
      if (this.turnJob.get(t.id) === j.id) this.turnJob.delete(t.id);
      this.own.delete(t.id);
      this.api.changed();
    }
  }

  /** A job's turn ended: it waits for the work it handed out, asks, finishes, or (a cut turn) runs once more. */
  private afterTurn(id: string, res: TurnResult, text?: string) {
    const j = this.store.get(id);
    if (!j || j.status === 'cancelled' || res.cancelled) return;
    this.addUsage(j, res);
    if (!res.text.trim() && (res.error || res.timedOut || (j.parentId && !res.evidence.toolCalls && !res.question))) {
      this.store.put(j);
      if (res.timedOut) return this.fail(j, 'its turn took too long');
      return this.cut(j.id, res.error ?? 'it gave no answer', text, res.evidence.outward.length > 0);
    }
    if (res.text.trim()) {
      j.result = res.text.trim().slice(0, LIMITS.resultChars);
      this.api.onTurnDone?.(j.assignee.botId, `job ${JP.shortId(j.id)}`, j.brief.slice(0, 2000), j.result);
    }
    const kids = this.store.children(j.id).filter((c) => c.reply === 'resume');
    const open = kids.filter((c) => !settled(c));
    // work it handed out is still running, or came back while this turn ran: it waits / resumes for it
    if (open.length || kids.some((c) => !c.reported && !c.ack)) {
      j.status = 'waiting';
      this.save(j, { kind: 'waiting', open: open.length });
      this.maybeWake(j);
      return;
    }
    if (j.goal && !j.parentId) {
      void this.goalStep(j, res);
      return;
    }
    if (res.question && j.parentId) {
      j.status = 'needs_input';
      j.question = res.question;
      j.asked = false;
      this.save(j, { kind: 'question', text: res.question });
      this.notifyParent(j, true);
      return;
    }
    if (CK.wantsCheck(j) && this.api.checkWork && this.bot(j.assignee.botId)?.checkWork) {
      void this.check(j, res.text);
      return;
    }
    // a new round of work that settled already (all acks) leaves it nothing to wait for
    this.finish(j, res.text);
  }

  /** Check before done: PASS finishes the job, ISSUES go back to the bot for one more turn (≤ 3 checks). */
  private async check(j: JobRow, text: string) {
    const b = this.bot(j.assignee.botId);
    if (!b) return this.finish(j, text);
    j.checks++;
    j.check = { by: 'a checker', verdict: 'checking', note: '', at: Date.now() };
    this.save(j, { kind: 'checking', round: j.checks });
    let r: { by: string; reply: string } | null = null;
    try {
      r = await this.api.checkWork!(j, b);
    } catch (e) {
      this.api.log(`[crew] check of ${j.id}: ${errText(e)}`);
    }
    const cur = this.store.get(j.id);
    if (!cur || settled(cur)) return;
    const v = r ? CK.parseCheck(r.reply) : { verdict: 'cannot' as const, note: 'no checker could run' };
    cur.check = { by: r?.by ?? 'the checker', verdict: v.verdict, note: v.note, at: Date.now() };
    if (v.verdict === 'issues' && cur.checks < CK.CHECK.rounds) {
      cur.status = 'queued';
      this.save(cur, { kind: 'check-issues', round: cur.checks });
      void this.run(cur, CK.issuesText(cur.check));
      return;
    }
    this.save(cur, { kind: `check-${v.verdict}` });
    this.finish(cur, text, `${firstLine(cur.result ?? '') || 'done'} · ${CK.checkLine(cur.check)}`);
  }

  private addUsage(j: JobRow, res: TurnResult) {
    const u = res.usage;
    if (u) {
      j.usage = {
        input: j.usage.input + u.promptTokens,
        output: j.usage.output + u.outputTokens,
        cached: j.usage.cached + u.cachedTokens,
        costUsd: u.costUsd != null ? (j.usage.costUsd ?? 0) + u.costUsd : j.usage.costUsd,
      };
      this.crew.store.logUsage({ botId: j.assignee.botId, jobId: j.id, rootId: j.rootId, kind: 'job', input: u.promptTokens, output: u.outputTokens, cached: u.cachedTokens, costUsd: u.costUsd ?? null });
    }
    j.evidence = mergeEvidence(j.evidence, res.evidence);
  }

  private finish(j: JobRow, text: string, outcome?: string) {
    const t = text.trim();
    j.status = 'done';
    j.endedAt = Date.now();
    if (t) j.result = t.slice(0, LIMITS.resultChars);
    j.outcome ??= outcome ?? (firstLine(j.result ?? '') || 'done');
    j.ack = !!j.parentId && (j.mode === 'notify' || (!j.doneWhen && !(j.evidence?.toolCalls ?? 0) && t.length <= 80 && ACK.test(t)));
    const root = this.rootOf(j);
    if (root.budget) root.budget.failuresInRow = 0;
    this.store.put(root);
    this.save(j, { kind: 'done', ack: j.ack });
    if (j.parentId && j.origin.roomId) this.api.roomNote?.(j.origin.roomId, `📋 ${this.bot(j.assignee.botId)?.name ?? 'A teammate'} finished${j.title ? ` "${j.title}"` : ''}: ${j.outcome}`);
    this.notifyParent(j);
  }

  private fail(j: JobRow, why: string) {
    const cur = this.store.get(j.id) ?? j;
    if (settled(cur)) return;
    cur.status = 'failed';
    cur.outcome = why.slice(0, 300);
    cur.endedAt = Date.now();
    this.save(cur, { kind: 'failed', why });
    this.api.log(`[crew] job ${cur.id} failed: ${why}`);
    if (cur.parentId) this.api.onFailed?.(cur);
    const root = this.rootOf(cur);
    if (cur.parentId && root.budget) {
      root.budget.failuresInRow++;
      this.store.put(root);
      if (root.budget.failuresInRow >= LIMITS.failuresInRow) {
        this.stop(root.id, `${LIMITS.failuresInRow} jobs failed in a row`);
        return;
      }
    }
    if (cur.parentId && cur.origin.roomId) this.api.roomNote?.(cur.origin.roomId, `⚠️ ${this.bot(cur.assignee.botId)?.name ?? 'A teammate'}'s job failed: ${cur.outcome}`);
    this.notifyParent(cur);
  }

  // ------------------------------------------------------------------ the wake lane

  private notifyParent(child: JobRow, question = false) {
    const p = child.parentId ? this.store.get(child.parentId) : null;
    if (!p || settled(p)) return;
    if (question) {
      // a question interrupts the wait once; while the requester's turn runs, its end picks it up
      if (p.status === 'waiting' && !child.asked) {
        child.asked = true;
        this.save(child);
        void this.wake(p, child);
      }
      return;
    }
    this.maybeWake(p);
  }

  /** A waiting requester: asked by a teammate, or every job it handed out settled → ONE resume turn. */
  private maybeWake(p: JobRow) {
    if (p.status !== 'waiting') return;
    const kids = this.store.children(p.id).filter((c) => c.reply === 'resume');
    const ask = kids.find((c) => c.status === 'needs_input' && !c.asked);
    if (ask) {
      ask.asked = true;
      this.save(ask);
      void this.wake(p, ask);
      return;
    }
    if (!kids.every(settled)) return;
    const fresh = kids.filter((c) => !c.reported);
    if (!fresh.some((c) => !c.ack)) {
      // nothing but acknowledgements: no turn needed
      for (const c of fresh) c.reported = true;
      for (const c of fresh) this.store.put(c);
      this.finish(p, '', p.result ? undefined : 'its teammates acknowledged');
      return;
    }
    void this.wake(p);
  }

  /** The requester's resume turn: every new report at once (or one question), in the thread it asked from. */
  private async wake(p: JobRow, question?: JobRow) {
    const root = this.rootOf(p);
    if (root.budget && root.budget.wakes >= LIMITS.wakes) return this.fail(p, `too many report rounds (${LIMITS.wakes})`);
    const thread = p.assignee.threadId ? this.crew.store.thread(p.assignee.threadId) : null;
    const b = this.bot(p.assignee.botId);
    if (!thread || !b) return this.fail(p, 'its thread is gone');
    const user = this.api.userName();
    const inRoom = thread.kind === 'room' && !!thread.roomId;
    let text: string;
    let reports: JobRow[] = [];
    if (question) text = JP.questionText(question, this.bot(question.assignee.botId), user, !p.parentId);
    else {
      reports = this.store.children(p.id).filter((c) => c.reply === 'resume' && settled(c) && !c.reported);
      for (const c of reports) {
        c.reported = true;
        this.store.put(c);
      }
      text = JP.reportsText(
        reports.map((job) => ({ job, bot: this.bot(job.assignee.botId) })),
        !p.parentId,
        user,
        inRoom,
      );
    }
    if (root.budget) {
      root.budget.wakes++;
      this.store.put(root);
    }
    p.status = 'resume';
    this.save(p, { kind: question ? 'asked' : 'resume', child: question?.id });
    if (inRoom && this.api.roomTurn) {
      // the room runs it as a member turn; its crew tools act for this job meanwhile
      this.turnJob.set(thread.id, p.id);
      this.own.add(thread.id);
      let said: string | null = null;
      try {
        said = await Promise.race([this.api.roomTurn(thread.roomId!, b.id, text), new Promise<null>((r) => setTimeout(() => r(null), LIMITS.roomWaitMs))]);
      } catch (e) {
        this.api.log(`[crew] room report of ${p.id}: ${errText(e)}`);
      } finally {
        if (this.turnJob.get(thread.id) === p.id) this.turnJob.delete(thread.id);
        this.own.delete(thread.id);
      }
      const cur = this.store.get(p.id);
      if (cur && cur.status === 'resume') {
        cur.status = 'running';
        this.afterTurn(cur.id, { cancelled: false, raw: said ?? '', text: said ?? '', error: null, evidence: emptyEvidence(), toolCalls: [], usage: null, question: null, timedOut: false });
      }
      return;
    }
    const flag: Flag = { cancelled: false };
    this.live.set(p.id, flag);
    let res: TurnResult | null = null;
    try {
      if (!(await this.untilUnpaused(b.id, flag))) return;
      const release = await this.locks.acquire(b.id, thread.kind === 'dm' ? 'its DM' : `job ${JP.shortId(p.id)}`, { cancelled: () => flag.cancelled, timeoutMs: LIMITS.lockWaitMs });
      if (!release) {
        if (!flag.cancelled) this.fail(p, `@${b.name} stayed busy elsewhere`);
        return;
      }
      try {
        const cur = this.store.get(p.id) ?? p;
        if (cur.status === 'cancelled') return;
        if (this.api.isPaused?.(b.id)) {
          flag.paused = true;
          return;
        }
        cur.status = 'running';
        this.save(cur);
        if (root.budget) {
          root.budget.runs++;
          this.store.put(root);
        }
        res = await this.turn(cur, thread, b, text, flag);
      } finally {
        release();
      }
    } catch (e) {
      if (!flag.cancelled) this.fail(p, errText(e));
      return;
    } finally {
      if (this.live.get(p.id) === flag) this.live.delete(p.id);
    }
    if (flag.paused) {
      // stopped by a pause: the same reports (or question) are handed back after the resume
      const cur = this.store.get(p.id);
      if (cur && !settled(cur)) {
        for (const c of reports) {
          c.reported = false;
          this.store.put(c);
        }
        if (question) {
          question.asked = false;
          this.store.put(question);
        }
        cur.status = 'waiting';
        this.save(cur, { kind: 'paused' });
      }
      return;
    }
    if (res) this.afterTurn(p.id, res);
  }

  // ------------------------------------------------------------------ bot goals

  /** A standing goal for one bot: it works on its own, a cheap judge decides after each turn (≤ maxTurns). */
  startGoal(botId: string, text: string, maxTurns = 10): JobRow {
    const b = this.bot(botId);
    if (!b) throw new Error('No such bot.');
    const goal = text.trim().slice(0, 4000);
    if (!goal) throw new Error('Say what the goal is.');
    for (const old of this.store.all()) if (old.goal && !old.parentId && old.assignee.botId === botId && !settled(old)) this.stop(old.id, 'replaced by a new goal');
    const now = Date.now();
    const id = newId('j');
    const j = normalizeJob({
      id,
      rootId: id,
      parentId: null,
      depth: 0,
      origin: { kind: 'person', quote: goal.slice(0, 400), roomId: null },
      requester: { botId: null, threadId: null },
      assignee: { botId, threadId: null },
      mode: 'work',
      reply: 'none',
      title: 'goal',
      brief: goal,
      thread: 'new',
      status: 'queued',
      level: this.crew.effectiveAccess(b),
      budget: { requests: 0, runs: 0, wakes: 0, failuresInRow: 0 },
      goal: { maxTurns: Math.max(1, Math.min(100, Math.round(maxTurns) || 10)), turns: 0, nextAt: null, failures: 0, paused: false },
      createdAt: now,
    });
    this.save(j, { kind: 'goal', bot: botId });
    void this.run(j, GL.goalEnvelope(goal, this.api.userName(), j.goal!.maxTurns));
    return j;
  }

  /** After each goal turn: done, keep going, wait, or pause (two empty turns in a row; its turn budget). */
  private async goalStep(j: JobRow, res: TurnResult) {
    const over = this.api.overBudget?.();
    if (over && j.goal) {
      j.goal.paused = true;
      j.status = 'waiting';
      j.outcome = `paused: ${over}`;
      this.save(j, { kind: 'goal-paused', why: over });
      return;
    }
    const g = j.goal!;
    g.turns++;
    g.failures = res.text.trim() ? 0 : g.failures + 1;
    const b = this.bot(j.assignee.botId);
    const tell = (what: string) => b && this.api.notify?.(`${b.emoji} ${b.name}'s goal: ${what}`, () => undefined);
    if (g.failures >= 2) {
      g.paused = true;
      j.status = 'waiting';
      j.outcome = 'paused: two turns in a row without an answer';
      this.save(j, { kind: 'goal-paused' });
      tell(j.outcome);
      return;
    }
    if (res.question) {
      j.status = 'needs_input';
      j.question = res.question;
      j.asked = false;
      this.save(j, { kind: 'question', text: res.question });
      return;
    }
    if (g.turns >= g.maxTurns) {
      this.finish(j, res.text, `stopped after ${g.turns} turns`);
      tell(`stopped after ${g.turns} turns`);
      return;
    }
    const reply = b ? ((await this.api.cheapTurn?.(b.engine, GL.judgePrompt(j.brief, res.text))) ?? '') : '';
    const cur = this.store.get(j.id);
    if (!cur || settled(cur) || cur.goal?.paused) return;
    const v = GL.parseJudge(reply || 'CONTINUE');
    if (v.verdict === 'done') {
      this.finish(cur, res.text, 'goal reached');
      tell('reached');
      return;
    }
    if (v.verdict === 'wait') {
      cur.goal!.nextAt = Date.now() + v.minutes * 60_000;
      cur.status = 'waiting';
      cur.outcome = `waiting ${v.minutes} min`;
      this.save(cur, { kind: 'goal-wait', minutes: v.minutes });
      this.goalTimer(cur);
      return;
    }
    cur.status = 'queued';
    this.save(cur);
    void this.run(cur, GL.continueText(g.turns + 1, g.maxTurns));
  }

  private goalTimer(j: JobRow) {
    const old = this.timers.get(j.id);
    if (old) clearTimeout(old);
    const wait = Math.max(1000, (j.goal?.nextAt ?? Date.now()) - Date.now());
    this.timers.set(
      j.id,
      setTimeout(() => {
        this.timers.delete(j.id);
        const cur = this.store.get(j.id);
        if (!cur?.goal || cur.goal.paused || cur.status !== 'waiting') return;
        cur.goal.nextAt = null;
        cur.status = 'queued';
        this.save(cur);
        void this.run(cur, GL.continueText(cur.goal.turns + 1, cur.goal.maxTurns));
      }, Math.min(wait, 2 ** 31 - 1)),
    );
  }

  /** The user talks to the bot itself: its goal pauses (Resume in Mission Control). */
  pauseGoalsOf(botId: string) {
    for (const j of this.store.all()) {
      if (!j.goal || j.parentId || settled(j) || j.assignee.botId !== botId || j.goal.paused) continue;
      j.goal.paused = true;
      if (j.status === 'waiting' || j.status === 'queued') j.status = 'waiting';
      j.outcome = 'paused: you wrote to it';
      const t = this.timers.get(j.id);
      if (t) clearTimeout(t);
      this.save(j, { kind: 'goal-paused' });
    }
  }

  resumeGoal(id: string) {
    const j = this.find(id);
    if (!j.goal || settled(j)) throw new Error('That is not a running goal.');
    j.goal.paused = false;
    j.goal.failures = 0;
    j.outcome = null;
    if (j.status === 'waiting' && !this.live.has(j.id)) {
      j.status = 'queued';
      this.save(j, { kind: 'goal-resumed' });
      void this.run(j, GL.continueText(j.goal.turns + 1, j.goal.maxTurns));
    } else this.save(j);
  }

  // ------------------------------------------------------------------ Mission Control

  /** Stops a job and everything under it (running turns end, queued ones never start); its requester hears it. */
  stop(id: string, why = 'stopped by the user') {
    const top = this.find(id);
    const tree = this.store.tree(top.rootId);
    const under = new Set([top.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const j of tree) {
        if (j.parentId && under.has(j.parentId) && !under.has(j.id)) {
          under.add(j.id);
          grew = true;
        }
      }
    }
    const now = Date.now();
    for (const j of tree) {
      if (!under.has(j.id) || settled(j)) continue;
      j.status = 'cancelled';
      j.outcome = why;
      j.endedAt = now;
      const f = this.live.get(j.id);
      if (f) f.cancelled = true;
      this.save(j, { kind: 'cancelled', why });
    }
    if (top.parentId) this.notifyParent(this.store.get(top.id)!);
  }

  /** Runs a failed or stopped job again (from its envelope). */
  retry(id: string) {
    const j = this.find(id);
    if (!settled(j) || j.status === 'done') throw new Error('Only a failed or stopped job can run again.');
    if (!j.parentId) throw new Error('Ask the bot again in its chat instead.');
    const p = this.store.get(j.parentId);
    j.status = 'queued';
    j.outcome = null;
    j.endedAt = null;
    j.reported = false;
    j.executions = 0;
    this.save(j, { kind: 'retry' });
    // its requester waits for it again
    if (p && settled(p) && p.status !== 'cancelled') {
      p.status = 'waiting';
      p.endedAt = null;
      this.save(p);
    }
    void this.run(j);
  }

  /** The thread a job runs in, to open it (null = it has not run). */
  threadOf(id: string): ThreadRecord | null {
    const j = this.find(id);
    return j.assignee.threadId ? this.crew.store.thread(j.assignee.threadId) : null;
  }
}

function firstLine(s: string): string {
  const l = s.replace(/[*_`#>]/g, '').trim().split('\n').find((x) => x.trim()) ?? '';
  return l.length > 160 ? `${l.slice(0, 159)}…` : l;
}

function mergeEvidence(a: Evidence | null, b: Evidence): Evidence {
  if (!a) return b;
  return {
    commands: [...a.commands, ...b.commands].slice(-50),
    filesChanged: [...new Set([...a.filesChanged, ...b.filesChanged])].slice(0, 50),
    filesRead: a.filesRead + b.filesRead,
    searches: a.searches + b.searches,
    web: a.web + b.web,
    toolCalls: a.toolCalls + b.toolCalls,
    failedCalls: a.failedCalls + b.failedCalls,
    errors: [...a.errors, ...b.errors].slice(-3),
    outward: [...a.outward, ...b.outward].slice(-10),
  };
}
