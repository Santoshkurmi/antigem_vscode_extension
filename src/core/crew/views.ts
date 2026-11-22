// What the Crew screens show (engine.ts sends it again on every change): the Crew screen (its bots, settings, the
// Chief's changes, About you, today's spend) and the Automations page. Built from the engine's parts; nothing changes.
import type { AutomationView, CrewBotView, CrewStateView } from '../../../shared/protocol';
import { ENGINES } from './bots';
import type { CrewEngine } from './engine';
import { softNote } from './engines/caps';
import { effectiveAccess } from './engines/setup';
import { jobCounts } from './jobs/view';
import { ACCESS_LEVELS } from './store/store';
import type { BotProfile } from './types';

/** The parts the Crew screen is drawn from. */
type CrewParts = Pick<CrewEngine, 'crew' | 'locks' | 'jobs' | 'inbox' | 'chief' | 'memory'>;

export function crewStateOf(e: CrewParts): CrewStateView {
  const store = e.crew.store;
  const settings = store.settings();
  const rooms = store.rooms();
  const threads = store.threads();
  const working = new Set<string | null | undefined>(e.crew.identity.working().map((t) => threads.find((x) => x.id === t)?.botId));
  for (const b of store.bots()) if (e.locks.busy(b.id)) working.add(b.id);
  return {
    bots: store.bots().map((b) => botView(e, b, settings, rooms, threads, working)),
    crewAccess: settings.crewAccess,
    root: store.root,
    jobs: jobCounts(e.jobs.store.all()),
    paused: settings.paused,
    agyCrewServer: settings.agyCrewServer,
    chiefId: e.chief.chiefId(),
    changes: e.chief.changes(8).map((c) => ({ id: c.id, at: c.at, summary: c.summary, undone: !!c.undone })),
    aboutMe: e.memory.aboutMeLines().map((l) => ({ id: l.id, text: l.text, by: l.by === 'user' ? 'you' : (store.bot(l.by)?.name ?? l.by) })),
    hasProblems: threads.some((t) => t.kind === 'problems' && !!t.chatId && t.botId === settings.chiefId),
    usage: { today: roundSpend(e.crew.usage.today().crew), caps: settings.caps, over: e.crew.usage.overBudget() },
    tourDone: settings.tourDone,
    softNotes: Object.fromEntries(
      ENGINES.map((en) => [en, Object.fromEntries(ACCESS_LEVELS.map((a) => [a, softNote(en, a)]).filter(([, n]) => n))]),
    ),
  };
}

function botView(e: CrewParts, b: BotProfile, settings = e.crew.store.settings(), rooms = e.crew.store.rooms(), threads = e.crew.store.threads(), working = new Set<string | null | undefined>()): CrewBotView {
  const store = e.crew.store;
  const eff = effectiveAccess(b, settings);
  return {
    id: b.id,
    name: b.name,
    title: b.title,
    description: b.description,
    emoji: b.emoji,
    color: b.color,
    agent: b.engine,
    modelId: b.model,
    effort: b.effort,
    access: b.access,
    accessCeiling: b.accessCeiling,
    effectiveAccess: eff,
    folder: b.folder,
    chattiness: b.chattiness,
    paused: b.paused,
    soul: store.soul(b.id),
    soulPath: store.soulPath(b.id),
    softNote: softNote(b.engine, eff),
    aliases: b.aliases,
    busyWhere: e.locks.busy(b.id)?.where ?? null,
    rules: e.inbox.broker.rules(b.id),
    memory: {
      enabled: b.memory.enabled,
      capture: b.memory.capture,
      notes: e.memory
        .notes(b.id)
        .filter((n) => n.struck === null)
        .reverse()
        .slice(0, 60)
        .map((n) => ({ id: n.id, text: n.text, where: n.where, from: n.from, date: n.date })),
      file: e.memory.file(b.id),
      undo: (() => {
        const j = e.memory.journal(b.id, 1)[0];
        return j && j.action !== 'undo' ? { id: j.id, what: `${j.action}${j.after ? `: ${String(j.after).replace(/<!--[\s\S]*?-->/g, '').slice(0, 80)}` : ''}` } : null;
      })(),
    },
    goal: (() => {
      const g = e.jobs.store
        .all()
        .filter((j) => j.goal && !j.parentId && j.assignee.botId === b.id)
        .sort((x, y) => y.createdAt - x.createdAt)[0];
      return g?.goal ? { jobId: g.id, text: g.brief, status: g.status, turns: g.goal.turns, maxTurns: g.goal.maxTurns, paused: g.goal.paused, nextAt: g.goal.nextAt } : null;
    })(),
    checkWork: b.checkWork,
    browser: b.browser,
    voice: b.voice,
    today: (() => {
      const s = e.crew.usage.today().bots.get(b.id);
      return s ? roundSpend(s) : null;
    })(),
    dmChatId: threads.find((t) => t.kind === 'dm' && t.botId === b.id)?.chatId ?? null,
    rooms: rooms.filter((r) => r.members.includes(b.id)).map((r) => ({ id: r.id, name: r.name })),
    working: working.has(b.id),
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

/** The Automations page (finished check-backs are left out). */
export function automationsStateOf(e: Pick<CrewEngine, 'crew' | 'automations'>): AutomationView[] {
  const store = e.crew.store;
  const bots = new Map(store.bots().map((b) => [b.id, b]));
  return e.automations.store
    .all()
    .filter((a) => a.when.kind !== 'checkback' || !a.done)
    .map((a) => {
      const b = bots.get(a.botId);
      const t = store.threads().find((x) => x.kind === 'automation' && x.jobId === a.id);
      return {
        id: a.id,
        name: a.name,
        sentence: e.automations.sentence(a),
        bot: b ? { id: b.id, name: b.name, emoji: b.emoji, color: b.color } : null,
        paused: a.paused,
        done: a.done,
        lastRunAt: a.lastRunAt,
        nextRunAt: a.nextRunAt,
        lastStatus: a.lastStatus,
        lastResult: a.lastResult,
        needsFix: a.needsFix,
        skipped: a.skipped,
        webhook: a.when.kind === 'webhook' && a.token ? { url: e.automations.webhookUrl(a), token: a.token } : null,
        runs: e.automations.store.runs(a.id, 5).map((r) => ({ at: r.at, status: r.status, trigger: r.trigger, result: r.result.slice(0, 500) })),
        canUndo: !!e.automations.store.lastChange(a.id),
        canOpen: !!t?.chatId,
        createdBy: a.createdBy === 'user' ? 'you' : (bots.get(a.createdBy)?.name ?? a.createdBy),
      };
    });
}

const roundSpend = (s: { tokens: number; usd: number; turns: number }) => ({ tokens: s.tokens, usd: Math.round(s.usd * 10000) / 10000, turns: s.turns });
