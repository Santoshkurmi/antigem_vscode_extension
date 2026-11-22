// What Mission Control shows (shared/protocol.ts JobsStateView): every job tree, newest first, parents before their
// children, with who asked whom, status, evidence, cost and the tree's budgets.
import type { JobCountsView, JobTreeView, JobView, JobsStateView } from '../../../../shared/protocol';
import { digestOf, evidenceLines } from '../turns/evidence';
import { SETTLED, type BotProfile, type JobRow, type RoomRecord } from '../types';
import { LIMITS } from './runtime';

const MAX_TREES = 40;

function jobView(j: JobRow, bots: Map<string, BotProfile>): JobView {
  const b = bots.get(j.assignee.botId);
  const r = j.requester.botId ? bots.get(j.requester.botId) : null;
  return {
    id: j.id,
    rootId: j.rootId,
    parentId: j.parentId,
    depth: j.depth,
    title: j.title,
    brief: j.brief.slice(0, 4000),
    status: j.status,
    outcome: j.outcome,
    bot: b ? { id: b.id, name: b.name, emoji: b.emoji, color: b.color } : null,
    requester: r ? { name: r.name, emoji: r.emoji, color: r.color } : j.requester.botId ? { name: '(deleted)', emoji: '?', color: '#64748B' } : null,
    mode: j.mode,
    level: j.level,
    doneWhen: j.doneWhen,
    question: j.question,
    answer: j.answer,
    result: j.result ? j.result.slice(0, 2000) : null,
    digest: j.evidence ? digestOf(j.evidence) : null,
    evidence: j.evidence ? evidenceLines(j.evidence) : [],
    artifacts: j.artifacts.map((a) => ({ kind: a.kind, title: a.title, ...(a.path ? { path: a.path } : {}), ...(a.url ? { url: a.url } : {}), ...(a.text ? { text: a.text.slice(0, 2000) } : {}) })),
    usage: j.usage,
    ack: j.ack,
    canOpen: !!j.assignee.threadId,
    goal: j.goal ? { turns: j.goal.turns, maxTurns: j.goal.maxTurns, paused: j.goal.paused, nextAt: j.goal.nextAt } : null,
    check: j.check ? { by: j.check.by, verdict: j.check.verdict, note: j.check.note, round: j.checks } : null,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    updatedAt: j.updatedAt,
  };
}

export function jobCounts(all: JobRow[]): JobCountsView {
  const day = Date.now() - 24 * 3600_000;
  return {
    working: all.filter((j) => j.parentId && (j.status === 'running' || j.status === 'queued' || j.status === 'resume')).length,
    waiting: all.filter((j) => j.status === 'waiting').length,
    needsYou: all.filter((j) => j.status === 'needs_input').length,
    today: all.filter((j) => !j.parentId && j.createdAt > day).length,
  };
}

export function jobsView(all: JobRow[], bots: BotProfile[], rooms: RoomRecord[]): JobsStateView {
  const byBot = new Map(bots.map((b) => [b.id, b]));
  const roots = all
    .filter((j) => !j.parentId)
    // live trees first, then the newest
    .sort((a, b) => {
      const live = (r: JobRow) => (all.some((j) => j.rootId === r.id && !SETTLED.includes(j.status)) ? 1 : 0);
      return live(b) - live(a) || b.updatedAt - a.updatedAt;
    })
    .slice(0, MAX_TREES);
  const trees: JobTreeView[] = roots.map((root) => {
    const tree = all.filter((j) => j.rootId === root.id && j.id !== root.id);
    // parents before children, siblings by age
    const ordered: JobRow[] = [];
    const walk = (parent: string) => {
      for (const c of tree.filter((j) => j.parentId === parent).sort((a, b) => a.createdAt - b.createdAt)) {
        ordered.push(c);
        walk(c.id);
      }
    };
    walk(root.id);
    const room = root.origin.roomId ? rooms.find((r) => r.id === root.origin.roomId) : undefined;
    const b = root.budget ?? { requests: 0, runs: 0, wakes: 0, failuresInRow: 0 };
    return {
      root: jobView(root, byBot),
      jobs: ordered.map((j) => jobView(j, byBot)),
      origin: { kind: root.origin.kind, quote: root.origin.quote, roomId: root.origin.roomId, roomName: room?.name ?? null },
      budget: { ...b, limits: { requests: LIMITS.requests, runs: LIMITS.runs, wakes: LIMITS.wakes, failuresInRow: LIMITS.failuresInRow } },
    };
  });
  return { trees, counts: jobCounts(all) };
}
