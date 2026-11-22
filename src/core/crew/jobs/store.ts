// Jobs on disk (docs/crew/PLAN.md §4): jobs/jobs.json holds the rows (rewritten atomically on each change, kept in
// memory), jobs/events.ndjson is the append-only history (who handed what to whom, every status change). Finished
// trees older than a week, and all but the newest 200 roots, are dropped from jobs.json (events keep them).
import path from 'node:path';
import { appendLine, readJson, writeJson } from '../store/fsx';
import { SETTLED, type JobRow } from '../types';

const KEEP_ROOTS = 200;
const KEEP_MS = 7 * 24 * 3600_000;

export class JobStore {
  private rows: Map<string, JobRow> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly root: string) {}

  private file(name: string) {
    return path.join(this.root, 'jobs', name);
  }

  private load(): Map<string, JobRow> {
    if (!this.rows) {
      const raw = readJson<Partial<JobRow>[]>(this.file('jobs.json'));
      this.rows = new Map((Array.isArray(raw) ? raw : []).filter((j) => j && typeof j.id === 'string').map((j) => [j.id!, normalizeJob(j)]));
      // a turn can't outlive the window that ran it: what was running ends as failed (the parent hears about it)
      for (const j of this.rows.values()) {
        if (j.status !== 'running' && j.status !== 'queued' && j.status !== 'resume') continue;
        // a bot goal goes on a minute after the editor is back; other work ends as failed (its requester hears it)
        if (j.goal && !j.parentId) Object.assign(j, { status: 'waiting', goal: { ...j.goal, nextAt: Date.now() + 60_000 } });
        else Object.assign(j, { status: 'failed', outcome: 'stopped: the editor closed while it ran', endedAt: Date.now() });
      }
    }
    return this.rows;
  }

  all(): JobRow[] {
    return [...this.load().values()];
  }

  get(id: string): JobRow | null {
    return this.load().get(id) ?? null;
  }

  children(id: string): JobRow[] {
    return this.all()
      .filter((j) => j.parentId === id)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  tree(rootId: string): JobRow[] {
    return this.all()
      .filter((j) => j.rootId === rootId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  put(j: JobRow) {
    j.updatedAt = Date.now();
    this.load().set(j.id, j);
    this.saveSoon();
  }

  event(e: Record<string, unknown>) {
    try {
      appendLine(this.file('events.ndjson'), { at: Date.now(), ...e });
    } catch {
      /* history is a nice-to-have */
    }
  }

  private saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 200);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.rows) return;
    this.prune();
    try {
      writeJson(this.file('jobs.json'), [...this.rows.values()]);
    } catch {
      /* the next change saves again */
    }
  }

  private prune() {
    const rows = this.rows!;
    const roots = [...rows.values()].filter((j) => !j.parentId).sort((a, b) => b.createdAt - a.createdAt);
    const now = Date.now();
    const drop = new Set<string>();
    roots.forEach((r, i) => {
      const tree = [...rows.values()].filter((j) => j.rootId === r.id);
      const finished = tree.every((j) => SETTLED.includes(j.status));
      if (finished && (i >= KEEP_ROOTS || now - r.updatedAt > KEEP_MS)) drop.add(r.id);
    });
    if (drop.size) for (const [id, j] of rows) if (drop.has(j.rootId)) rows.delete(id);
  }
}

const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

export function normalizeJob(raw: Partial<JobRow>): JobRow {
  const now = Date.now();
  return {
    id: str(raw.id),
    rootId: str(raw.rootId, str(raw.id)),
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    depth: Number(raw.depth ?? 0) || 0,
    origin: { kind: raw.origin?.kind ?? 'person', quote: str(raw.origin?.quote), roomId: raw.origin?.roomId ?? null },
    requester: { botId: raw.requester?.botId ?? null, threadId: raw.requester?.threadId ?? null },
    assignee: { botId: str(raw.assignee?.botId), threadId: raw.assignee?.threadId ?? null },
    mode: raw.mode === 'consult' || raw.mode === 'notify' ? raw.mode : 'work',
    reply: raw.reply === 'none' ? 'none' : 'resume',
    title: str(raw.title),
    brief: str(raw.brief),
    doneWhen: raw.doneWhen ?? null,
    files: Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === 'string') : [],
    thread: raw.thread === 'new' || raw.thread === 'self' ? raw.thread : 'standing',
    status: raw.status ?? 'queued',
    outcome: raw.outcome ?? null,
    level: raw.level ?? 'edit',
    result: raw.result ?? null,
    evidence: raw.evidence ?? null,
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
    question: raw.question ?? null,
    asked: raw.asked === true,
    answer: raw.answer ?? null,
    reported: raw.reported === true,
    ack: raw.ack === true,
    executions: Number(raw.executions ?? 0) || 0,
    dismissed: raw.dismissed === true,
    retries: Number(raw.retries ?? 0) || 0,
    checks: Number(raw.checks ?? 0) || 0,
    check: raw.check ?? null,
    goal: raw.goal ? { maxTurns: Number(raw.goal.maxTurns) || 10, turns: Number(raw.goal.turns) || 0, nextAt: raw.goal.nextAt ?? null, failures: Number(raw.goal.failures) || 0, paused: raw.goal.paused === true } : null,
    usage: raw.usage ?? { input: 0, output: 0, cached: 0, costUsd: null },
    budget: raw.budget ?? null,
    createdAt: Number(raw.createdAt ?? now),
    updatedAt: Number(raw.updatedAt ?? now),
    startedAt: raw.startedAt ?? null,
    endedAt: raw.endedAt ?? null,
  };
}
