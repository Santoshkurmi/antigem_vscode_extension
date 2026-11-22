// Automations on disk (docs/crew/PLAN.md §4, §13): automations/automations.json (definitions and their state),
// automations/runs.ndjson (run history), automations/changes.ndjson (every create / update / delete with the version
// before it: Undo, guarded by updatedAt so an older Undo never overwrites a newer change).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { appendLine, readJson, readLines, writeJson } from '../store/fsx';
import { newId } from '../store/store';
import type { When } from './when';

export type PostTo = { kind: 'room'; roomId: string } | { kind: 'dm' } | { kind: 'none' };
export type RunStatus = 'ok' | 'nothing' | 'failed' | 'needs-input' | 'skipped';

export interface Automation {
  id: string;
  name: string;
  botId: string;
  when: When;
  /** Self-contained: a run does not see the chat it was made in. */
  instructions: string;
  /** Where a result is posted (a room, the bot's DM as a notice, nowhere). */
  postTo: PostTo;
  paused: boolean;
  /** A one-shot (once, a wait, a check-back) that has run, or a wait that expired. */
  done: boolean;
  /** 'user' or the bot that made it. */
  createdBy: string;
  /** Check-backs: the thread to come back to. */
  threadId: string | null;
  /** Webhooks: the bearer token callers must send. */
  token: string | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: RunStatus | null;
  lastResult: string | null;
  failuresInRow: number;
  /** Shown as "Needs you: …" (three failures in a row, a missing bot). */
  needsFix: string | null;
  /** AI runs today (event / webhook / wait automations: at most 24 a day). */
  runsToday: { day: string; count: number };
  /** Runs skipped because the last one was still going. */
  skipped: number;
  /** Its own hidden thread (reused; a new chat every 20 runs). */
  threadRuns: number;
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  id: string;
  automationId: string;
  at: number;
  status: RunStatus;
  /** What started it ("schedule", "file saved: src/a.ts", "webhook"). */
  trigger: string;
  result: string;
  ms: number;
}

interface Change {
  id: string;
  at: number;
  automationId: string;
  by: string;
  what: 'create' | 'update' | 'delete' | 'undo';
  before: Automation | null;
  after: Automation | null;
  undo?: string;
}

export const today = () => new Date().toISOString().slice(0, 10);

export class AutomationStore {
  private rows: Map<string, Automation> | null = null;

  constructor(readonly root: string) {}

  private file(name: string) {
    return path.join(this.root, 'automations', name);
  }

  private load(): Map<string, Automation> {
    if (!this.rows) {
      const raw = readJson<Automation[]>(this.file('automations.json'));
      this.rows = new Map((Array.isArray(raw) ? raw : []).filter((a) => a && typeof a.id === 'string' && a.when).map((a) => [a.id, normalize(a)]));
    }
    return this.rows;
  }

  all(): Automation[] {
    return [...this.load().values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Automation | null {
    return this.load().get(id) ?? null;
  }

  private save() {
    writeJson(this.file('automations.json'), [...this.load().values()]);
  }

  /** Writes state (run times, counters) without a change record. */
  touch(a: Automation) {
    this.load().set(a.id, a);
    this.save();
  }

  /** A create / update by the user or a bot: recorded for Undo. */
  put(a: Automation, by: string): Automation {
    const before = this.get(a.id);
    const next = { ...a, updatedAt: Date.now() };
    this.load().set(a.id, next);
    this.save();
    this.change({ automationId: a.id, by, what: before ? 'update' : 'create', before, after: next });
    return next;
  }

  delete(id: string, by: string) {
    const before = this.get(id);
    if (!before) return;
    this.load().delete(id);
    this.save();
    this.change({ automationId: id, by, what: 'delete', before, after: null });
  }

  private change(c: Omit<Change, 'id' | 'at'>): Change {
    const full: Change = { ...c, id: newId('ac'), at: Date.now() };
    appendLine(this.file('changes.ndjson'), full);
    return full;
  }

  /** The last change of an automation that can still be undone (null = none). */
  lastChange(automationId: string): Change | null {
    const all = readLines<Change>(this.file('changes.ndjson'));
    const undone = new Set(all.filter((c) => c.what === 'undo').map((c) => c.undo));
    return [...all].reverse().find((c) => c.automationId === automationId && c.what !== 'undo' && !undone.has(c.id)) ?? null;
  }

  /** Puts back what was there before a change, unless the automation changed since. */
  undo(changeId: string): string {
    const all = readLines<Change>(this.file('changes.ndjson'));
    const c = all.find((x) => x.id === changeId);
    if (!c || c.what === 'undo') throw new Error('No such change.');
    if (all.some((x) => x.what === 'undo' && x.undo === changeId)) return 'Already undone.';
    const cur = this.get(c.automationId);
    if (c.after && cur && cur.updatedAt !== c.after.updatedAt) throw new Error('It changed since: undo the newer change first.');
    if (c.before) this.load().set(c.automationId, { ...c.before, updatedAt: Date.now() });
    else this.load().delete(c.automationId);
    this.save();
    appendLine(this.file('changes.ndjson'), { id: newId('ac'), at: Date.now(), automationId: c.automationId, by: 'user', what: 'undo', before: null, after: null, undo: changeId });
    return c.what === 'create' ? 'Removed it again' : c.what === 'delete' ? 'Brought it back' : 'Put back the earlier version';
  }

  addRun(r: Omit<RunRecord, 'id'>) {
    appendLine(this.file('runs.ndjson'), { ...r, id: newId('r') });
  }

  runs(automationId: string, limit = 5): RunRecord[] {
    return readLines<RunRecord>(this.file('runs.ndjson'))
      .filter((r) => r.automationId === automationId)
      .slice(-limit)
      .reverse();
  }
}

export function newAutomation(fields: Pick<Automation, 'name' | 'botId' | 'when' | 'instructions' | 'postTo' | 'createdBy'> & Partial<Automation>): Automation {
  const now = Date.now();
  return normalize({
    id: newId('a'),
    paused: false,
    done: false,
    threadId: null,
    token: fields.when.kind === 'webhook' ? randomBytes(18).toString('hex') : null,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    lastResult: null,
    failuresInRow: 0,
    needsFix: null,
    runsToday: { day: today(), count: 0 },
    skipped: 0,
    threadRuns: 0,
    createdAt: now,
    updatedAt: now,
    ...fields,
  } as Automation);
}

function normalize(a: Automation): Automation {
  return {
    ...a,
    name: String(a.name || 'Automation').slice(0, 80),
    instructions: String(a.instructions ?? '').slice(0, 8000),
    postTo: a.postTo?.kind === 'room' || a.postTo?.kind === 'dm' || a.postTo?.kind === 'none' ? a.postTo : { kind: 'dm' },
    paused: a.paused === true,
    done: a.done === true,
    threadId: a.threadId ?? null,
    token: a.token ?? null,
    failuresInRow: Number(a.failuresInRow) || 0,
    needsFix: a.needsFix ?? null,
    runsToday: a.runsToday && typeof a.runsToday.day === 'string' ? a.runsToday : { day: today(), count: 0 },
    skipped: Number(a.skipped) || 0,
    threadRuns: Number(a.threadRuns) || 0,
  };
}
