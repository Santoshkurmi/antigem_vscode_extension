// crew_mcp: the tools a Crew bot gets (docs/crew/PLAN.md §9), served at /crew on the extension's MCP host. Each
// request's URL says how the caller is identified (mcp/identity.ts); the tool list is the same bytes for every
// thread of an engine (only Antigravity's adds the `cap` argument). Phase 0: crew_roster; Phase 3: crew_assign,
// crew_answer, crew_jobs, crew_report, crew_thread (jobs/runtime.ts).
import type { McpCallContext, McpResult, McpServerDef, McpTool } from '../../mcp/server';
import { errorResult, S, text } from '../../mcp/server';
import { ENGINE_LABEL } from '../prompts/stable';
import type { CrewStore } from '../store/store';
import type { Automations } from '../automations/runner';
import { crewAutomation, crewLater } from '../automations/tools';
import type { Chief } from '../chief';
import type { BotMemory } from '../memory/memory';
import type { AssignInput, JobRuntime } from '../jobs/runtime';
import type { BotProfile, ThreadRecord } from '../types';
import type { CallerLookup, CrewIdentity } from './identity';

export interface CrewMcpEnv {
  store: CrewStore;
  identity(): CrewIdentity;
  lookup: CallerLookup;
  userName(): string;
  jobs?(): JobRuntime | null;
  chief?(): Chief | null;
  automations?(): Automations | null;
  memory?(): BotMemory | null;
  /** null = the crew is not running in this window (another window owns it). */
  notReady?(): string | null;
}

const CAP_PROP = { cap: S.prop('string', 'Your crew cap, exactly as your instructions give it.') };

function tools(withCap: boolean): McpTool[] {
  const extra = withCap ? CAP_PROP : {};
  const req = (r: string[]) => (withCap ? [...r, 'cap'] : r);
  return [
    S.tool('crew_roster', 'You, your teammates (role, engine, what they are doing), your rooms and your open jobs.', req([]), { ...extra }),
    S.tool(
      'crew_assign',
      'Hand work to 1-4 teammates as tracked jobs. They do not see your chat: the brief must say everything. When ALL of them are done you get ONE message with every report (what they did, observed from their tool calls, and what they say). End your turn right after assigning.',
      req(['to', 'brief']),
      {
        to: S.strings('Teammate names (1-4), e.g. ["Tess", "Pip"]'),
        brief: S.prop('string', 'What to do, with the context, files and constraints they need'),
        done_when: S.prop('string', 'How they know they are done (e.g. "npm test passes")'),
        mode: S.prop('string', 'work (default) = do it; consult = answer only, change nothing; notify = for their information, no report back', ['work', 'consult', 'notify']),
        thread: S.prop('string', 'standing (default) = their usual work thread; new = a fresh thread for this job', ['standing', 'new']),
        title: S.prop('string', 'A few words for the job list'),
        files: S.strings('Up to 5 relevant file paths'),
        ...extra,
      },
    ),
    S.tool('crew_answer', "Answer a teammate's question on a job you handed them (it goes on with the job).", req(['job', 'answer']), {
      job: S.prop('string', 'The job id from the question'),
      answer: S.prop('string', 'Your answer'),
      ...extra,
    }),
    S.tool('crew_jobs', 'Jobs you sent or got (status, outcome); with an id: its brief, result, evidence and its own jobs. Read-only.', req([]), {
      id: S.prop('string', 'A job id for its details'),
      ...extra,
    }),
    S.tool('crew_report', 'Attach structured results to the job you are working on now: files (path), diffs (path), links (url), data (text).', req([]), {
      summary: S.prop('string', 'One line: the outcome'),
      artifacts: {
        type: 'array',
        description: 'Up to 20 items',
        items: {
          type: 'object',
          properties: {
            kind: S.prop('string', 'file | diff | link | data', ['file', 'diff', 'link', 'data']),
            title: S.prop('string', 'A short label'),
            path: S.prop('string', 'Absolute path (file, diff)'),
            url: S.prop('string', 'URL (link)'),
            text: S.prop('string', 'Text (data)'),
          },
        },
      },
      ...extra,
    }),
    S.tool('crew_memory', 'Your memory: add a note (a topic keeps it out of your prompt until searched), update or forget one, search your notes; prefer = something about the user every bot should know.', req(['action']), {
      action: S.prop('string', 'What to do', ['add', 'update', 'forget', 'search', 'prefer']),
      text: S.prop('string', 'add / prefer: the note; update: the new text; forget / search: the note or words to find'),
      note: S.prop('string', 'update: the note to change (its words or id)'),
      topic: S.prop('string', 'add: a topic (e.g. "deploy") for details you only need sometimes'),
      until: S.prop('string', 'add: the last day it holds ("2026-12-01", "7d", "2w")'),
      ...extra,
    }),
    S.tool('crew_later', 'Come back later without any AI running meanwhile: check_back (this chat, at a time), wait (until a URL / file / process / bot changes, then do follow_up), list, cancel.', req(['action']), {
      action: S.prop('string', 'What to do', ['check_back', 'wait', 'list', 'cancel']),
      when: S.prop('string', 'check_back: "in 2h", "tomorrow 9:00", "friday 14:00", "2026-12-01 10:00"'),
      note: S.prop('string', 'check_back: what to come back to'),
      kind: S.prop('string', 'wait: what to wait for', ['url_contains', 'url_missing', 'file_exists', 'file_missing', 'file_changed', 'process_running', 'process_gone', 'bot_idle']),
      target: S.prop('string', 'wait: the URL, file path, process name or bot name'),
      text: S.prop('string', 'wait (url_contains / url_missing): the text to look for'),
      follow_up: S.prop('string', 'wait: what to do when it happens (self-contained: the run does not see this chat)'),
      hours: S.prop('number', 'wait: give up after this many hours (1-168, default 24)'),
      id: S.prop('string', 'cancel: the id'),
      ...extra,
    }),
    S.tool(
      'crew_automation',
      'Automations: "when X happens, do Y" (schedules, editor events like tests failing or a file saved, webhooks). Create it in this turn without asking; instructions must be self-contained (a run does not see this chat). Results post in this room (or your DM as a notice); "NOTHING NEW" posts nothing. info shows the time and your automations.',
      req(['action']),
      {
        action: S.prop('string', 'What to do', ['info', 'create', 'update', 'pause', 'resume', 'run_now', 'delete']),
        when: S.prop('string', 'create / update: "every weekday at 9:00", "every 30 min between 9:00 and 17:00", "cron 0 9 * * 1-5", "when tests fail", "on save of src/**/*.ts", "webhook"…'),
        instructions: S.prop('string', 'create / update: everything the run needs to know and do'),
        name: S.prop('string', 'A few words'),
        post_to: S.prop('string', 'Where results go (default: this room, else your DM)', ['room', 'dm', 'none']),
        room: S.prop('string', 'A room name to post in'),
        bot: S.prop('string', 'Chief only: the bot that runs it'),
        id: S.prop('string', 'update / pause / resume / run_now / delete: the id'),
        ...extra,
      },
    ),
    S.tool(
      'crew_manage',
      'Chief only: shape the crew. create_bot (≤4 per turn) / update_bot / pause_bot, create_room / update_room, retry a failed job (≤2). Changes apply at once; say what you changed in one line (the user can undo it).',
      req(['action']),
      {
        action: S.prop('string', 'What to do', ['create_bot', 'update_bot', 'pause_bot', 'create_room', 'update_room', 'retry']),
        name: S.prop('string', 'create_bot / create_room / update_room: the name (bots: one word)'),
        bot: S.prop('string', 'update_bot / pause_bot: the bot name'),
        title: S.prop('string', 'Bot role (planner, tester…)'),
        description: S.prop('string', 'Bot: one line teammates see'),
        soul: S.prop('string', 'Bot: who it is and how it works (its standing instructions)'),
        engine: S.prop('string', 'create_bot: claude, codex, opencode or agy (default: the crew default)'),
        model: S.prop('string', 'Bot model id (optional)'),
        access: S.prop('string', 'Bot level (at most edit)', ['talk', 'read', 'edit']),
        aliases: S.strings('Bot: topics that route room messages to it'),
        paused: S.prop('boolean', 'pause_bot: true pauses, false resumes'),
        room: S.prop('string', 'update_room: the room name'),
        members: S.strings('create_room: bot names'),
        add: S.strings('update_room: bot names to add'),
        lead: S.prop('string', 'Room lead (bot name)'),
        bulletin: S.prop('string', 'Room: what it is for'),
        mode: S.prop('string', 'Room mode', ['auto', 'mentions', 'lead', 'everyone', 'moderator']),
        job: S.prop('string', 'retry: the job id'),
        ...extra,
      },
    ),
    S.tool('crew_thread', 'Work in parallel on yourself: start a thread with its own brief (max 5 open); its report comes back to you like a teammate\'s. Also list / close your threads.', req(['action']), {
      action: S.prop('string', 'start | list | close', ['start', 'list', 'close']),
      message: S.prop('string', 'start: what the thread should do (it does not see this chat)'),
      title: S.prop('string', 'start: a few words'),
      report_back: S.prop('boolean', 'start: false = no report back'),
      id: S.prop('string', 'close: the thread job id'),
      ...extra,
    }),
  ];
}

export function crewMcp(env: CrewMcpEnv): McpServerDef {
  const def = (query: URLSearchParams): McpServerDef => {
    const own = query.get('t');
    const withCap = !own && query.get('engine') !== 'opencode';
    // a bot's own server (Claude, Codex) lists the Chief's tool only to the Chief; shared servers list it (and refuse it)
    const list = own && env.store.thread(own)?.botId !== env.store.settings().chiefId ? tools(withCap).filter((x) => x.name !== 'crew_manage') : tools(withCap);
    return {
      path: '/crew',
      name: 'crew_mcp',
      instructions: 'AntiGem Crew: the tools of a crew bot. They act as you, only while you are answering in the crew.',
      tools: () => list,
      notReady: env.notReady,
      call: async (name: string, args: Record<string, unknown>, ctx?: McpCallContext): Promise<McpResult> => {
        const caller = env.identity().resolve(query, ctx?.meta ?? null, args, env.lookup);
        if ('error' in caller) return errorResult(caller.error);
        const jobs = env.jobs?.() ?? null;
        try {
          switch (name) {
            case 'crew_roster':
              return text(roster(env, caller.thread));
            case 'crew_assign':
              return text(need(jobs).assign(caller.thread, args as unknown as AssignInput));
            case 'crew_answer':
              return text(need(jobs).answer(caller.thread, String(args.job ?? ''), String(args.answer ?? '')));
            case 'crew_jobs':
              return text(need(jobs).list(caller.thread, args.id ? String(args.id) : undefined));
            case 'crew_report':
              return text(need(jobs).report(caller.thread, args.summary, args.artifacts));
            case 'crew_thread':
              return text(need(jobs).thread(caller.thread, args.action ?? 'start', args));
            case 'crew_memory':
              return text(memoryTool(env, caller.thread, args));
            case 'crew_later': {
              const auto = env.automations?.();
              if (!auto) return errorResult('Automations are not available in this window.');
              return text(crewLater(auto, env.store, caller.thread, args));
            }
            case 'crew_automation': {
              const auto = env.automations?.();
              if (!auto) return errorResult('Automations are not available in this window.');
              return text(crewAutomation(auto, env.store, caller.thread, args, env.store.settings().chiefId === caller.thread.botId));
            }
            case 'crew_manage': {
              const chief = env.chief?.();
              if (!chief) return errorResult('The Chief is not available in this window.');
              return text(await chief.manage(caller.thread, args));
            }
            default:
              return errorResult(`Unknown crew tool ${name}`);
          }
        } catch (e) {
          return errorResult(e instanceof Error ? e.message : String(e));
        }
      },
    };
  };
  const base = def(new URLSearchParams());
  return { ...base, resolve: (query) => def(query) };
}

function roster(env: CrewMcpEnv, thread: ThreadRecord): string {
  const bots = env.store.bots();
  const me = bots.find((b) => b.id === thread.botId) ?? null;
  const working = new Set(env.identity().working().map((id) => env.store.thread(id)?.botId).filter(Boolean));
  const rooms = env.store.rooms();
  const line = (b: BotProfile) => {
    const where = rooms.filter((r) => r.members.includes(b.id)).map((r) => `#${r.name}`);
    return `- @${b.name}${b.title ? ` — ${b.title}` : ''} (${ENGINE_LABEL[b.engine]}${b.model ? ` · ${b.model}` : ''})${b.paused ? ' · paused' : working.has(b.id) ? ' · working' : ' · idle'}${where.length ? ` · in ${where.join(', ')}` : ''}${b.description ? `\n  ${b.description.slice(0, 200)}` : ''}`;
  };
  const out: string[] = [];
  out.push(me ? `You: @${me.name}${me.title ? ` — ${me.title}` : ''} (${ENGINE_LABEL[me.engine]}${me.model ? ` · ${me.model}` : ''}, access: ${me.access})` : 'You: a crew helper with no bot profile');
  out.push(`The user: ${env.userName()}`);
  const mates = bots.filter((b) => b.id !== me?.id);
  out.push(mates.length ? `Teammates:\n${mates.map(line).join('\n')}` : 'Teammates: none yet.');
  const mine = rooms.filter((r) => me && r.members.includes(me.id));
  out.push(mine.length ? `Your rooms: ${mine.map((r) => `#${r.name}${r.lead === me?.id ? ' (you lead)' : ''}`).join(', ')}` : 'Your rooms: none.');
  const open = me ? (env.jobs?.()?.openLines(me.id) ?? []) : [];
  out.push(open.length ? `Your open jobs:\n${open.join('\n')}` : 'Open jobs: none.');
  return out.join('\n');
}

function need(j: JobRuntime | null): JobRuntime {
  if (!j) throw new Error('Jobs are not available in this window.');
  return j;
}

/** crew_memory: notes are dated and say where they were learned (the room, the DM, the job). */
function memoryTool(env: CrewMcpEnv, t: ThreadRecord, a: Record<string, unknown>): string {
  const mem = env.memory?.();
  if (!mem || !t.botId) throw new Error('Memory is not available here.');
  const bot = env.store.bot(t.botId);
  if (bot && !bot.memory.enabled) throw new Error('Your memory is turned off (the user can turn it on in your profile).');
  const room = t.roomId ? env.store.room(t.roomId) : null;
  const source = room ? `#${room.name}` : t.kind === 'dm' ? 'DM' : t.kind === 'automation' ? 'automation' : t.jobId ? `job ${t.jobId}` : t.kind;
  const s = (v: unknown) => (v == null ? '' : String(v)).trim();
  switch (s(a.action)) {
    case 'add': {
      if (!s(a.text)) throw new Error('Write the note in "text".');
      const r = mem.add(t.botId, { text: s(a.text), topic: s(a.topic) || null, until: s(a.until) || null, source, actor: 'bot' });
      return r.duplicate ? 'You have that note already.' : `Noted${r.where !== 'core' ? ` under ${r.where}` : ''}.${r.note ? ` ${r.note}` : ''}`;
    }
    case 'update': {
      const r = mem.update(t.botId, s(a.note) || s(a.text), s(a.text), 'bot');
      if (!r) throw new Error(`No single note matches "${s(a.note)}": ${mem.find(t.botId, s(a.note)).map((n) => n.text).slice(0, 5).join(' | ') || 'none'}.`);
      return 'Updated.';
    }
    case 'forget': {
      const r = mem.forget(t.botId, s(a.text) || s(a.note), 'bot');
      if (!r) throw new Error(`No single note matches "${s(a.text)}".`);
      return `Forgot: ${r.text}`;
    }
    case 'search': {
      const hits = mem.search(t.botId, s(a.text), 8);
      return hits.length ? hits.map((h) => `- ${h.text}${h.where !== 'core' ? ` (${h.where})` : ''}${h.date ? ` · ${h.date}` : ''}`).join('\n') : 'Nothing found.';
    }
    case 'prefer': {
      if (!s(a.text)) throw new Error('Write what every bot should know about the user in "text".');
      const r = mem.prefer(s(a.text), t.botId);
      return r.duplicate ? 'Every bot knows that already.' : 'Saved for every bot (the user can see and remove it).';
    }
    default:
      throw new Error('action must be add, update, forget, search or prefer.');
  }
}
