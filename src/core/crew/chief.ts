// The Chief (docs/crew/PLAN.md §10): one bot the user picks as their single point of contact. It gets crew_manage
// (create / update bots and rooms, retry a failed job, pause a bot) and every change it makes is journaled with Undo
// (crew/manage.ndjson). A failed job starts a Chief turn in its "Problems" thread (≤ 5 an hour): it retries (≤ 2 per
// job), re-briefs or reassigns with crew_assign, or tells the user. Work it hands out runs at max(the assignee's
// level, the Chief's), never above the assignee's highest level (jobs/runtime.ts levelFor).
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentKind } from '../../../shared/model';
import type { ApprovalView } from '../../../shared/protocol';
import type { AgentBackend } from '../types';
import { labeledBlock } from '../text';
import type { ApproveResult } from './access/broker';
import type { Crew } from './crew';
import type { JobRuntime } from './jobs/runtime';
import { shortId } from './jobs/prompts';
import type { BotLocks } from './locks';
import { appendLine, readLines } from './store/fsx';
import { newId } from './store/store';
import { digestOf } from './turns/evidence';
import { runTurn } from './turns/runner';
import type { BotProfile, CrewAccess, JobRow, RoomRecord, ThreadRecord } from './types';

const PROBLEMS_PER_HOUR = 5;
const RETRIES_PER_JOB = 2;
const BOTS_PER_TURN = 4;

/** Room operations the Chief may use (the RoomEngine, set by the host). */
export interface ChiefRooms {
  create(input: { title: string; topic?: string; mode?: string }): { id: string };
  addMember(roomId: string, botId: string): void;
  update(roomId: string, data: Record<string, unknown>): void;
  remove(roomId: string): Promise<void>;
  /** The user's message in a room (crew_admin). */
  post?(roomId: string, text: string): void;
  /** Someone in the room is answering (or about to). */
  busy?(roomId: string): boolean;
  transcript?(roomId: string, last: number): string;
  pause?(roomId: string): void;
  /** The room's lines as the room engine has them now (its files are written a moment later). */
  lines?(roomId: string): { from: string; name: string; text: string }[];
}

export interface ChiefDeps {
  crew: Crew;
  locks: BotLocks;
  jobs(): JobRuntime;
  backend(kind: AgentKind): AgentBackend | undefined;
  workspaceFolder(): string | null;
  isRunning(kind: AgentKind, chatId: string): boolean;
  createBot(fields: Record<string, unknown>): BotProfile;
  updateBot(id: string, fields: Record<string, unknown>): BotProfile;
  /** Deletes a bot without asking (Undo of a bot the Chief made). */
  removeBot(id: string): void;
  rooms(): ChiefRooms | null;
  approve(botId: string, access: CrewAccess, a: ApprovalView, chat: { engine: AgentKind; chatId: string }): ApproveResult;
  folders(b: BotProfile, access: CrewAccess): string[];
  notify(text: string, open: () => void): void;
  showChat(chatId: string, engine: AgentKind): void;
  changed(): void;
  log(line: string): void;
}

export interface ManageEntry {
  id: string;
  at: number;
  by: string;
  action: string;
  /** "Created @Tess (tester)" */
  summary: string;
  target: { kind: 'bot' | 'room' | 'job'; id: string };
  before: unknown;
  after: unknown;
  undone?: boolean;
}

const str = (v: unknown) => (v == null ? '' : String(v)).trim();

export class Chief {
  private recent: number[] = [];
  /** Bots made per turn ("<thread>:<turn start>" → count, ≤ 4). */
  private made = new Map<string, number>();

  constructor(private d: ChiefDeps) {}

  private get store() {
    return this.d.crew.store;
  }

  chiefId(): string | null {
    const id = this.store.settings().chiefId;
    return id && this.store.bot(id) ? id : null;
  }

  setChief(botId: string | null) {
    const s = this.store.settings();
    this.store.saveSettings({ ...s, chiefId: botId && this.store.bot(botId) ? botId : null });
    this.d.changed();
  }

  // ------------------------------------------------------------------ crew_manage

  private journalFile() {
    return path.join(this.store.root, 'manage.ndjson');
  }

  private record(e: Omit<ManageEntry, 'id' | 'at'>): ManageEntry {
    const entry: ManageEntry = { ...e, id: newId('mg'), at: Date.now() };
    appendLine(this.journalFile(), entry);
    this.d.changed();
    return entry;
  }

  /** The Chief's recent changes, newest first (undone ones marked). */
  changes(limit = 20): ManageEntry[] {
    const all = readLines<ManageEntry & { undo?: string }>(this.journalFile());
    const undone = new Set(all.filter((x) => x.action === 'undo').map((x) => x.undo));
    return all
      .filter((x) => x.action !== 'undo')
      .map((x) => ({ ...x, undone: undone.has(x.id) }))
      .reverse()
      .slice(0, limit);
  }

  /** crew_manage, for the Chief only. */
  async manage(caller: ThreadRecord, a: Record<string, unknown>): Promise<string> {
    const chief = this.chiefId();
    if (!chief || caller.botId !== chief) throw new Error('Only the Chief can shape the crew. Ask the Chief (or the user) instead.');
    const action = str(a.action);
    const bots = this.store.bots();
    const findBot = (ref: unknown) => {
      const r = str(ref).replace(/^@/, '').toLowerCase();
      const b = bots.find((x) => x.id === r || x.name.toLowerCase() === r);
      if (!b) throw new Error(`No bot "${str(ref)}". Bots: ${bots.map((x) => `@${x.name}`).join(', ')}.`);
      return b;
    };
    const cap = (lvl: unknown): CrewAccess => (['talk', 'read', 'edit'].includes(str(lvl)) ? (str(lvl) as CrewAccess) : 'edit');
    switch (action) {
      case 'create_bot': {
        const turn = `${caller.id}:${this.d.crew.identity.turnStarted(caller.id) ?? 0}`;
        const n = this.made.get(turn) ?? 0;
        if (n >= BOTS_PER_TURN) throw new Error(`At most ${BOTS_PER_TURN} new bots per turn.`);
        const b = this.d.createBot({
          name: a.name,
          title: a.title,
          description: a.description,
          soul: a.soul,
          agent: str(a.engine).toUpperCase() || undefined,
          modelId: a.model ? str(a.model) : undefined,
          access: cap(a.access),
          emoji: a.emoji,
          color: a.color,
          aliases: a.aliases,
        });
        this.made.set(turn, n + 1);
        const e = this.record({ by: chief, action, summary: `Created @${b.name}${b.title ? ` (${b.title})` : ''}`, target: { kind: 'bot', id: b.id }, before: null, after: b });
        return `Created @${b.name} (${e.id}). Tell the user in one line; they can undo it.`;
      }
      case 'update_bot': {
        const b = findBot(a.bot);
        const fields: Record<string, unknown> = {};
        for (const k of ['title', 'description', 'soul', 'emoji', 'color', 'aliases', 'chattiness']) if (a[k] !== undefined) fields[k] = a[k];
        if (a.access !== undefined) fields.access = cap(a.access);
        if (a.model !== undefined) fields.modelId = a.model ? str(a.model) : null;
        if (!Object.keys(fields).length) throw new Error('Say what to change (title, description, soul, access, model, emoji, color, aliases).');
        const before = { ...b, soul: this.store.soul(b.id) };
        const after = this.d.updateBot(b.id, fields);
        const e = this.record({ by: chief, action, summary: `Changed @${b.name}: ${Object.keys(fields).join(', ')}`, target: { kind: 'bot', id: b.id }, before, after: { ...after, soul: this.store.soul(b.id) } });
        return `Updated @${b.name} (${e.id}).`;
      }
      case 'pause_bot': {
        const b = findBot(a.bot);
        const paused = a.paused !== false;
        this.d.updateBot(b.id, { paused });
        const e = this.record({ by: chief, action, summary: `${paused ? 'Paused' : 'Resumed'} @${b.name}`, target: { kind: 'bot', id: b.id }, before: { paused: b.paused }, after: { paused } });
        return `${paused ? 'Paused' : 'Resumed'} @${b.name} (${e.id}).`;
      }
      case 'create_room': {
        const rooms = this.d.rooms();
        if (!rooms) throw new Error('Rooms are not available here.');
        const members = (Array.isArray(a.members) ? a.members : str(a.members).split(/[,\s]+/)).filter(Boolean).map((m) => findBot(m));
        const r = rooms.create({ title: str(a.name) || 'Room', topic: str(a.bulletin), mode: str(a.mode) || undefined });
        for (const m of members) rooms.addMember(r.id, m.id);
        const lead = a.lead ? findBot(a.lead) : null;
        if (lead) rooms.update(r.id, { lead: lead.id });
        const e = this.record({ by: chief, action, summary: `Made the room #${str(a.name) || 'Room'} with ${members.map((m) => `@${m.name}`).join(', ')}`, target: { kind: 'room', id: r.id }, before: null, after: { id: r.id } });
        return `Made #${str(a.name) || 'Room'} (${e.id}).`;
      }
      case 'update_room': {
        const rooms = this.d.rooms();
        if (!rooms) throw new Error('Rooms are not available here.');
        const room = this.store.rooms().find((r) => r.id === str(a.room) || r.name.toLowerCase() === str(a.room).replace(/^#/, '').toLowerCase());
        if (!room) throw new Error(`No room "${str(a.room)}".`);
        const data: Record<string, unknown> = {};
        if (a.bulletin !== undefined) data.topic = str(a.bulletin);
        if (a.mode !== undefined) data.mode = str(a.mode);
        if (a.lead !== undefined) data.lead = findBot(a.lead).id;
        if (a.name !== undefined) data.title = str(a.name);
        for (const m of Array.isArray(a.add) ? a.add : []) rooms.addMember(room.id, findBot(m).id);
        rooms.update(room.id, data);
        const e = this.record({ by: chief, action, summary: `Changed #${room.name}`, target: { kind: 'room', id: room.id }, before: room, after: data });
        return `Updated #${room.name} (${e.id}).`;
      }
      case 'retry': {
        const jobs = this.d.jobs();
        const j = jobs.store.get(str(a.job)) ?? jobs.store.all().find((x) => x.id.endsWith(str(a.job).replace(/^j_/, '')) && str(a.job).length >= 4);
        if (!j) throw new Error(`No job ${str(a.job)}.`);
        if (j.retries >= RETRIES_PER_JOB) throw new Error(`Job ${j.id} was retried ${j.retries} times already: re-brief it with crew_assign or tell the user.`);
        j.retries++;
        jobs.store.put(j);
        jobs.retry(j.id);
        this.record({ by: chief, action, summary: `Retried job ${shortId(j.id)}`, target: { kind: 'job', id: j.id }, before: null, after: null });
        return `Running job ${j.id} again (retry ${j.retries} of ${RETRIES_PER_JOB}).`;
      }
      default:
        throw new Error('action must be create_bot, update_bot, pause_bot, create_room, update_room or retry.');
    }
  }

  /** Undo one of the Chief's changes, if nothing changed it since. */
  async undo(id: string): Promise<string> {
    const e = this.changes(500).find((x) => x.id === id);
    if (!e) throw new Error('No such change.');
    if (e.undone) return 'Already undone.';
    const after = e.after as Partial<BotProfile> & { soul?: string } | null;
    switch (e.action) {
      case 'create_bot': {
        const b = this.store.bot(e.target.id);
        if (b && after && b.updatedAt !== after.updatedAt) throw new Error(`@${b.name} was changed since: undo it by hand.`);
        if (b) this.d.removeBot(b.id);
        break;
      }
      case 'update_bot': {
        const b = this.store.bot(e.target.id);
        const before = e.before as BotProfile & { soul: string };
        if (!b) throw new Error('That bot is gone.');
        if (after && b.updatedAt !== after.updatedAt) throw new Error(`@${b.name} was changed since: undo it by hand.`);
        this.d.updateBot(b.id, { title: before.title, description: before.description, soul: before.soul, access: before.access, modelId: before.model, emoji: before.emoji, color: before.color, aliases: before.aliases, chattiness: before.chattiness });
        break;
      }
      case 'pause_bot':
        this.d.updateBot(e.target.id, { paused: (e.before as { paused: boolean }).paused });
        break;
      case 'create_room':
        await this.d.rooms()?.remove(e.target.id);
        break;
      case 'update_room': {
        const before = e.before as RoomRecord;
        this.d.rooms()?.update(e.target.id, { title: before.name, topic: before.bulletin, mode: before.mode, lead: before.lead });
        break;
      }
      default:
        throw new Error('This change cannot be undone.');
    }
    appendLine(this.journalFile(), { id: newId('mg'), at: Date.now(), by: 'user', action: 'undo', undo: e.id });
    this.d.changed();
    return `Undone: ${e.summary}`;
  }

  // ------------------------------------------------------------------ the Problems thread

  /** A job failed: the Chief looks at it in its Problems thread (≤ 5 an hour; not its own retries' noise). */
  problem(j: JobRow) {
    const chief = this.chiefId();
    if (!chief || this.store.settings().paused || this.store.bot(chief)?.paused || this.d.crew.usage.overBudget()) return;
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 3600_000);
    if (this.recent.length >= PROBLEMS_PER_HOUR) return;
    this.recent.push(now);
    void this.problemTurn(chief, j).catch((e) => this.d.log(`[crew] Chief problem turn: ${e instanceof Error ? e.message : e}`));
  }

  /** The Chief's Problems thread (one, hidden from the chat list, opened from the Crew home). */
  problemsThread(chiefId: string): ThreadRecord {
    const b = this.store.bot(chiefId)!;
    let t = this.store.threads().find((x) => x.kind === 'problems' && x.botId === chiefId);
    if (t && t.engine !== b.engine) t = { ...t, engine: b.engine, chatId: null, setupKey: null };
    if (!t) {
      const now = Date.now();
      t = { id: newId('t'), botId: chiefId, engine: b.engine, chatId: null, kind: 'problems', roomId: null, jobId: null, seen: 0, setupKey: null, createdAt: now, updatedAt: now };
    }
    this.store.putThread(t);
    return t;
  }

  private async problemTurn(chiefId: string, j: JobRow) {
    const b = this.store.bot(chiefId);
    if (!b) return;
    const release = await this.d.locks.acquire(chiefId, 'its Problems thread', { cancelled: () => false, timeoutMs: 30 * 60_000 });
    if (!release) return;
    let t = this.problemsThread(chiefId);
    try {
      const backend = this.d.backend(t.engine);
      if (!backend) return;
      const isNew = !t.chatId;
      if (isNew) {
        t = { ...t, chatId: randomUUID() };
        this.store.putThread(t);
        this.d.changed();
      }
      const chatId = t.chatId!;
      const setup = this.d.crew.setupFor(t);
      const bots = new Map(this.store.bots().map((x) => [x.id, x]));
      const who = bots.get(j.assignee.botId);
      const from = j.requester.botId ? bots.get(j.requester.botId) : null;
      const text = labeledBlock(
        `⚠️ Problem: job ${shortId(j.id)} failed`,
        [
          `@${who?.name ?? '?'}'s job ${j.id}${j.title ? ` "${j.title}"` : ''}${from ? ` (handed out by @${from.name})` : ''} failed: ${j.outcome ?? 'no reason given'}.`,
          `Brief: ${j.brief.slice(0, 1500)}`,
          j.evidence ? `Observed: ${digestOf(j.evidence) ?? 'no tool use'}` : '',
          j.result ? `What it said: ${j.result.slice(0, 1500)}` : '',
          '',
          `You may retry it with crew_manage (action "retry", job "${j.id}"; retried ${j.retries} of ${RETRIES_PER_JOB} times), re-brief or reassign it with crew_assign, or tell the user in one or two lines what is wrong and what they should decide.`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      this.d.crew.identity.beginTurn(t.id);
      const res = await runTurn({
        backend,
        agent: t.engine,
        chatId,
        isNew,
        text,
        modelId: b.model,
        folder: this.d.folders(b, setup.access)[0] ?? this.store.botFolder(b.id),
        effort: b.effort,
        setup,
        access: setup.access,
        cancelled: () => false,
        isRunning: t.engine === 'AGY' ? () => this.d.isRunning('AGY', chatId) : undefined,
        approve: (a) => this.d.approve(b.id, setup.access, a, { engine: t.engine, chatId }),
      }).finally(() => {
        this.d.crew.identity.endTurn(t.id);
        this.d.jobs().turnEnded(t.id);
      });
      const said = res.text.split('\n').find((l) => l.trim()) ?? '';
      if (said) this.d.notify(`${b.emoji} ${b.name} (Chief) on a failed job: ${said.slice(0, 160)}`, () => this.d.showChat(chatId, t.engine));
    } finally {
      release();
      this.d.changed();
    }
  }
}
