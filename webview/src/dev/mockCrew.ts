// ?mock: a fake Crew host (src/core/crew) so the Crew home, the bot editor and a DM's header can be worked on in a
// browser: three sample bots; "Message" starts a DM (crewDm), edits apply at once.
import type { AgentKind, CrewChatTag } from '@shared/model';
import type { CrewBotView, HostToView, InboxItemView, JobView, JobsStateView, ViewToHost } from '@shared/protocol';

const SOFT: Partial<Record<AgentKind, Partial<Record<string, string>>>> = {
  AGY: { talk: 'Talk-only can’t be enforced on Antigravity: tool approvals are refused, but some tools run without one.' },
  CODEX: { talk: 'Codex cannot turn its shell off: a talk-only bot runs in a read-only sandbox (it can look, not change).' },
};

export function createMockCrew(post: (m: HostToView) => void) {
  const now = Date.now();
  const bot = (id: string, name: string, title: string, emoji: string, color: string, agent: AgentKind, access: string, soul: string, extra: Partial<CrewBotView> = {}): CrewBotView => ({
    id,
    name,
    title,
    description: '',
    emoji,
    color,
    agent,
    modelId: null,
    effort: 'default',
    access,
    accessCeiling: access === 'talk' || access === 'read' ? 'edit' : access,
    effectiveAccess: access,
    folder: null,
    chattiness: 40,
    paused: false,
    soul,
    soulPath: `/home/dev/.antigem/crew/bots/${id}/SOUL.md`,
    aliases: [],
    busyWhere: null,
    rules: [],
    goal: null,
    checkWork: null,
    browser: false,
    voice: null,
    today: { tokens: 48200, usd: 0.12, turns: 7 },
    memory: { enabled: true, capture: true, notes: [{ id: 'm1', text: 'Sam ships on Fridays', where: 'core', from: 'DM', date: '2026-11-22' }], file: `/home/dev/.antigem/crew/bots/${id}/MEMORY.md`, undo: null },
    softNote: SOFT[agent]?.[access] ?? null,
    dmChatId: null,
    rooms: [],
    working: false,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  const bots: CrewBotView[] = [
    bot('b_ada', 'Ada', 'planner', '🧭', '#6366F1', 'CLAUDE', 'edit', 'You are Ada, a calm senior planner. You split work into small steps and name the risks first.', {
      modelId: 'claude-sonnet-5-5',
      description: 'Breaks features into steps and keeps the plan up to date.',
      rooms: [{ id: 'g1', name: 'Coffee break' }],
      working: true,
    }),
    bot('b_tess', 'Tess', 'tester', '🧪', '#10B981', 'CODEX', 'read', 'You are Tess. You read code and tests and point at what is not covered.', { description: 'Finds what the tests miss.' }),
    bot('b_gus', 'Gus', 'scout', '🛰️', '#F59E0B', 'AGY', 'talk', 'You are Gus, a quick scout who sums things up in three lines.'),
  ];
  const jobsState = mockJobs(now);
  let caps: { dayTokens: number | null; dayUsd: number | null } = { dayTokens: 1_000_000, dayUsd: null };
  let tourDone = false;
  const state = () => ({ bots: bots.map((b) => ({ ...b })), crewAccess: null, root: '/home/dev/.antigem/crew', softNotes: SOFT, jobs: jobsState.counts, paused: false, agyCrewServer: 'ask', chiefId: 'b_ada', changes: [{ id: 'mg1', at: now - 300_000, summary: 'Created @Gus (scout)', undone: false }], hasProblems: true, aboutMe: [{ id: 'a1', text: 'Prefers short answers', by: 'you' }], usage: { today: { tokens: 412000, usd: 1.84, turns: 37 }, caps: { ...caps }, over: null }, tourDone });
  const inboxItems: InboxItemView[] = [
    { id: 'ib1', kind: 'approval', bot: { id: 'b_ada', name: 'Ada', emoji: '🧭', color: '#6366F1' }, title: 'run the command: git push origin main', why: 'for Lead\'s job: ship it · it reaches outside (asks at every level)', detail: '$ git push origin main', outward: true, risk: 'OUTWARD', key: 'Bash(git push)', choices: ['allow', 'allow_session', 'allow_always', 'deny'], canOpen: true, jobId: null, inChat: false, createdAt: now - 60_000 },
    { id: 'job:j_test', kind: 'question', bot: { id: 'b_tess', name: 'Tess', emoji: '🧪', color: '#10B981' }, title: 'Should the tests run with node:test or vitest?', why: "for Ada's job 7a2c1f \"test\"", detail: 'Write tests for the CLI.', outward: false, risk: null, key: null, choices: ['answer'], canOpen: true, jobId: 'j_test', inChat: false, createdAt: now - 30_000 },
    { id: 'ib2', kind: 'setup', bot: null, title: 'Add the AntiGem Crew server to Antigravity?', why: 'Antigravity bots get their crew tools only through one entry in its mcp_config.json.', detail: null, outward: false, risk: null, key: null, choices: ['add', 'later'], canOpen: false, jobId: null, inChat: false, createdAt: now - 10_000 },
  ];
  let watching = false;
  const emit = () => watching && post({ type: 'crewState', crew: state() });
  const tag = (b: CrewBotView): CrewChatTag => ({ botId: b.id, threadId: `t_${b.id}`, name: b.name, title: b.title, emoji: b.emoji, color: b.color, access: b.effectiveAccess, softNote: b.softNote });

  return (m: ViewToHost): boolean => {
    if (m.type === 'inboxWatch') {
      post({ type: 'crewInbox', items: inboxItems, status: { working: 1, needsYou: inboxItems.length, paused: false } });
      return true;
    }
    if (m.type === 'inboxAnswer') {
      const i = inboxItems.findIndex((x) => x.id === m.id);
      if (i >= 0 && m.choice !== 'open') inboxItems.splice(i, 1);
      post({ type: 'crewInbox', items: [...inboxItems], status: { working: 1, needsYou: inboxItems.length, paused: false } });
      post({ type: 'toast', level: 'info', message: `${m.choice}${m.note ? `: ${m.note}` : ''}` } as HostToView);
      return true;
    }
    if (m.type === 'jobsWatch') {
      if (m.open) post({ type: 'jobsState', jobs: jobsState });
      return true;
    }
    if (m.type === 'jobAction') {
      post({ type: 'toast', level: 'info', message: `${m.action}: ${m.jobId}` } as HostToView);
      return true;
    }
    if (m.type === 'crewWatch') {
      watching = m.open;
      emit();
      return true;
    }
    if (m.type !== 'crewAction') return false;
    const d = (m.data ?? {}) as Record<string, any>;
    const b = bots.find((x) => x.id === m.botId);
    switch (m.action) {
      case 'createBot': {
        const nb = bot(`b_${Math.random().toString(16).slice(2, 8)}`, String(d.name), String(d.title ?? ''), String(d.emoji || String(d.name)[0]), String(d.color), d.agent, d.access, String(d.soul ?? ''));
        bots.push(nb);
        emit();
        post({ type: 'crewNavigate', botId: nb.id });
        post({ type: 'toast', level: 'info', message: `${nb.name} joined the crew` } as HostToView);
        break;
      }
      case 'updateBot':
        if (b) {
          Object.assign(b, {
            ...d,
            agent: d.agent ?? b.agent,
            modelId: d.modelId !== undefined ? d.modelId : b.modelId,
            effectiveAccess: d.access ?? b.access,
            softNote: SOFT[(d.agent ?? b.agent) as AgentKind]?.[d.access ?? b.access] ?? null,
            updatedAt: Date.now(),
          });
          emit();
        }
        break;
      case 'deleteBot':
        if (b) bots.splice(bots.indexOf(b), 1);
        emit();
        break;
      case 'openDm':
        if (b) post({ type: 'crewDm', agent: b.agent, tag: tag(b), modelId: b.modelId });
        break;
      case 'setCaps':
        caps = { dayTokens: Number(d.dayTokens) || null, dayUsd: Number(d.dayUsd) || null };
        emit();
        break;
      case 'tourDone':
        tourDone = d.done !== false;
        emit();
        break;
      default:
        break;
    }
    return true;
  };
}

/** One finished tree and one live one: "Plan, build and test" fanned out to three bots. */
function mockJobs(now: number): JobsStateView {
  const MIN = 60_000;
  const face = { lead: { id: 'b_ada', name: 'Ada', emoji: '🧭', color: '#6366F1' }, tess: { id: 'b_tess', name: 'Tess', emoji: '🧪', color: '#10B981' }, gus: { id: 'b_gus', name: 'Gus', emoji: '🛰️', color: '#F59E0B' } };
  const j = (id: string, parentId: string | null, bot: JobView['bot'], status: string, extra: Partial<JobView> = {}): JobView => ({
    id,
    rootId: 'j_root1',
    parentId,
    depth: parentId ? 1 : 0,
    title: '',
    brief: '',
    status,
    outcome: null,
    bot,
    requester: parentId ? { name: 'Ada', emoji: '🧭', color: '#6366F1' } : null,
    mode: 'work',
    level: 'edit',
    doneWhen: null,
    question: null,
    answer: null,
    result: null,
    digest: null,
    evidence: [],
    artifacts: [],
    usage: { input: 12000, output: 800, cached: 40000, costUsd: 0.021 },
    ack: false,
    canOpen: true,
    goal: null,
    check: null,
    createdAt: now - 12 * MIN,
    startedAt: now - 11 * MIN,
    endedAt: null,
    updatedAt: now - MIN,
    ...extra,
  });
  const root = j('j_root1', null, face.lead, 'waiting', { brief: 'Plan, build and test a todo app', result: 'I handed it out to Tess and Gus.' });
  const kids = [
    j('j_build', 'j_root1', face.gus, 'done', {
      title: 'build',
      brief: 'Build the todo app in ./todo with a tiny CLI.',
      outcome: 'Built the CLI; 3 commands work.',
      digest: 'ran 4 commands (1 failed), edited todo.ts and cli.ts',
      evidence: ['$ npm init -y → exit 0', '$ npm run build → exit 1', '$ npm run build → exit 0', 'changed: /home/dev/todo/todo.ts, /home/dev/todo/cli.ts', 'failed: Bash: tsc: missing types'],
      result: 'Built the CLI (`todo add|list|done`). First build failed on missing types; fixed with @types/node. Not verified: Windows paths.',
      artifacts: [{ kind: 'file', title: 'todo.ts', path: '/home/dev/todo/todo.ts' }],
      check: { by: 'a quick Codex model', verdict: 'pass', note: '', round: 2 },
      endedAt: now - 4 * MIN,
    }),
    j('j_test', 'j_root1', face.tess, 'needs_input', { title: 'test', brief: 'Write tests for the CLI.', question: 'Should the tests run with node:test or vitest?', digest: 'read 3 files' }),
  ];
  return {
    trees: [{ root, jobs: kids, origin: { kind: 'person', quote: 'Plan, build and test a todo app', roomId: null, roomName: null }, budget: { requests: 2, runs: 3, wakes: 0, failuresInRow: 0, limits: { requests: 24, runs: 48, wakes: 48, failuresInRow: 5 } } }],
    counts: { working: 0, waiting: 1, needsYou: 1, today: 1 },
  };
}
