// crew_admin (/crew-admin, docs/crew/PLAN.md §15): the crew from the outside — Jarvis or any chat that has the
// "AntiGem Crew" MCP server can look (bots, rooms, jobs), organize (make / change bots and rooms, import / export a
// crew), and run work: send a message to a bot or a room (idempotent with send_id), wait for it (≤ 120 s per call,
// with the job tree it started), interrupt it. Never: approving requests, deleting, credentials.
import { randomBytes } from 'node:crypto';
import type { McpServerDef } from '../../mcp/server';
import { errorResult, jsonResult, S, text } from '../../mcp/server';
import { jobLine } from '../jobs/prompts';
import type { CrewEngine } from '../engine';
import { SETTLED } from '../types';

interface Ticket {
  id: string;
  kind: 'dm' | 'room';
  botId: string | null;
  roomId: string | null;
  threadId: string | null;
  startedAt: number;
  lines: number;
  done: boolean;
  reply: string | null;
  error: string | null;
}

const str = (v: unknown) => (v == null ? '' : String(v)).trim();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function crewAdminMcp(engine: CrewEngine, notReady: () => string | null): McpServerDef {
  const tickets = new Map<string, Ticket>();
  const sendIds = new Map<string, string>();
  const store = engine.crew.store;
  const bot = (ref: unknown) => {
    const r = str(ref).replace(/^@/, '').toLowerCase();
    const b = store.bots().find((x) => x.id === r || x.name.toLowerCase() === r);
    if (!b) throw new Error(`No bot "${str(ref)}". Bots: ${store.bots().map((x) => `@${x.name}`).join(', ') || 'none'}.`);
    return b;
  };
  const room = (ref: unknown) => {
    engine.flushRooms?.();
    const r = str(ref).replace(/^#/, '').toLowerCase();
    const x = store.rooms().find((y) => y.id === r || y.name.toLowerCase() === r);
    if (!x) throw new Error(`No room "${str(ref)}". Rooms: ${store.rooms().map((y) => `#${y.name}`).join(', ') || 'none'}.`);
    return x;
  };

  const tools = [
    S.tool('crew_overview', 'The crew: bots (role, engine, busy or idle), rooms, open jobs, automations, the Chief.', [], {}),
    S.tool('crew_read_room', 'The last lines of a room.', ['room'], { room: S.prop('string', 'Room name'), last: S.prop('number', 'How many lines (default 30)') }),
    S.tool('crew_send', 'Send a message to a bot (its DM: it answers and may hand work out) or a room (as the user). Returns an id for crew_wait. send_id makes a retry safe (the same send_id is sent once).', ['to', 'text'], {
      to: S.prop('string', '"@Name" for a bot, "#Room" for a room'),
      text: S.prop('string', 'The message'),
      send_id: S.prop('string', 'Your id for this send (retries with it do not send twice)'),
    }),
    S.tool('crew_wait', 'Wait for a send to finish (at most 120 s per call; call again while it runs). Returns the answer and the jobs it handed out.', ['id'], {
      id: S.prop('string', 'The id crew_send returned'),
      timeout: S.prop('number', 'Seconds to wait, 1-120 (default 60)'),
    }),
    S.tool('crew_interrupt', 'Stop the work a send started (the jobs it handed out stop too).', ['id'], { id: S.prop('string', 'The id crew_send returned') }),
    S.tool('crew_create_bot', 'Make a bot (at most Edit access; engine claude, codex, opencode or agy).', ['name'], {
      name: S.prop('string', 'One word'),
      title: S.prop('string', 'Its role'),
      description: S.prop('string', 'One line'),
      soul: S.prop('string', 'Who it is and how it works'),
      engine: S.prop('string', 'claude, codex, opencode or agy'),
      model: S.prop('string', 'A model id (optional)'),
      access: S.prop('string', 'talk, read or edit', ['talk', 'read', 'edit']),
    }),
    S.tool('crew_update_bot', "Change a bot's role, description, soul, engine, model or access (at most Edit).", ['bot'], {
      bot: S.prop('string', 'Bot name'),
      title: S.prop('string', 'Its role'),
      description: S.prop('string', 'One line'),
      soul: S.prop('string', 'Who it is and how it works'),
      engine: S.prop('string', 'claude, codex, opencode or agy'),
      model: S.prop('string', 'A model id'),
      access: S.prop('string', 'talk, read or edit', ['talk', 'read', 'edit']),
    }),
    S.tool('crew_create_room', 'Make a room with members.', ['name', 'members'], {
      name: S.prop('string', 'Room name'),
      members: S.strings('Bot names'),
      lead: S.prop('string', 'The lead (bot name)'),
      bulletin: S.prop('string', 'What the room is for'),
      mode: S.prop('string', 'Who answers', ['auto', 'mentions', 'lead', 'everyone', 'moderator']),
    }),
    S.tool('crew_import', 'Add a crew from a Crew package (text), a GitHub link (also OpenMausBot / BotMRR teams) or the library (feature-squad, bug-hunters, docs-team, brainstorm). Automations arrive paused.', [], {
      url: S.prop('string', 'A GitHub link'),
      text: S.prop('string', 'A package (Markdown with antigem-crew frontmatter)'),
      library: S.prop('string', 'A library id'),
    }),
    S.tool('crew_export', 'The crew (or some bots) as one Crew package (Markdown; never secrets or chats).', [], { bots: S.strings('Bot names (default: all)'), name: S.prop('string', 'Package name') }),
  ];

  const engineOf = (v: unknown) => (str(v) ? str(v).toUpperCase().replace(/^CLAUDE ?CODE$/, 'CLAUDE').replace(/^ANTIGRAVITY$/, 'AGY') : undefined);
  const cap = (v: unknown) => (['talk', 'read', 'edit'].includes(str(v)) ? str(v) : undefined);

  const call = async (name: string, a: Record<string, unknown>) => {
    switch (name) {
      case 'crew_overview': {
        engine.flushRooms?.();
        const st = engine.state();
        const jobs = engine.jobs.store.all().filter((j) => !SETTLED.includes(j.status));
        return jsonResult({
          chief: st.bots.find((b) => b.id === st.chiefId)?.name ?? null,
          bots: st.bots.map((b) => ({ name: b.name, title: b.title, engine: b.agent.toLowerCase(), model: b.modelId, access: b.effectiveAccess, busy: b.busyWhere, paused: b.paused, rooms: b.rooms.map((r) => r.name) })),
          rooms: store.rooms().map((r) => ({ name: r.name, members: r.members.map((m) => store.bot(m)?.name).filter(Boolean), mode: r.mode, goal: r.goal?.status === 'running' ? r.goal.text : null })),
          openJobs: jobs.length,
          automations: engine.automations.store.all().filter((x) => !x.done).map((x) => engine.automations.sentence(x)),
          paused: st.paused,
        });
      }
      case 'crew_read_room': {
        const r = room(a.room);
        return text(engine.roomsHook?.transcript?.(r.id, Math.min(200, Math.max(1, Number(a.last ?? 30) || 30))) ?? '');
      }
      case 'crew_send': {
        const sid = str(a.send_id);
        if (sid && sendIds.has(sid)) return text(`Already sent: id ${sendIds.get(sid)}`);
        const to = str(a.to);
        const msg = str(a.text);
        if (!msg) throw new Error('Write the message in "text".');
        const id = `s_${randomBytes(5).toString('hex')}`;
        if (to.startsWith('#') || (!to.startsWith('@') && store.rooms().some((r) => r.name.toLowerCase() === to.toLowerCase()))) {
          const r = room(to);
          if (!engine.roomsHook?.post) throw new Error('Rooms are not available here.');
          const t: Ticket = { id, kind: 'room', botId: null, roomId: r.id, threadId: null, startedAt: Date.now(), lines: (engine.roomsHook.lines?.(r.id) ?? store.transcript(r.id)).length, done: false, reply: null, error: null };
          tickets.set(id, t);
          engine.roomsHook.post(r.id, msg);
        } else {
          const b = bot(to);
          const t: Ticket = { id, kind: 'dm', botId: b.id, roomId: null, threadId: null, startedAt: Date.now(), lines: 0, done: false, reply: null, error: null };
          tickets.set(id, t);
          const th = engine.ensureDm(b.id);
          t.threadId = th.id;
          void engine
            .runOnThread(th, msg, 'its DM', { timeoutMs: 30 * 60_000, waitMs: 30 * 60_000 })
            .then((r) => {
              t.reply = r?.text ?? null;
              t.error = r ? r.error : `${b.name} stayed busy`;
            })
            .catch((e) => (t.error = e instanceof Error ? e.message : String(e)))
            .finally(() => (t.done = true));
        }
        if (sid) sendIds.set(sid, id);
        return text(`Sent. id ${id} (crew_wait to get the answer)`);
      }
      case 'crew_wait': {
        const t = tickets.get(str(a.id));
        if (!t) throw new Error('No such send id (they last until the editor restarts).');
        const until = Date.now() + Math.min(120, Math.max(1, Number(a.timeout ?? 60) || 60)) * 1000;
        const roomDone = () => t.kind === 'room' && !engine.roomsHook?.busy?.(t.roomId!) && Date.now() - t.startedAt > 1500;
        while (Date.now() < until && !t.done && !roomDone()) await sleep(500);
        if (t.kind === 'room') {
          const lines = (engine.roomsHook?.lines?.(t.roomId!) ?? store.transcript(t.roomId!)).slice(t.lines).filter((l) => l.from !== 'notice' && l.from !== 'user' && l.from !== 'system');
          return jsonResult({ status: roomDone() ? 'done' : 'running', replies: lines.map((l) => ({ from: l.name, text: l.text })) });
        }
        const bots = new Map(store.bots().map((b) => [b.id, b]));
        const roots = engine.jobs.store.all().filter((j) => !j.parentId && j.assignee.threadId === t.threadId && j.createdAt >= t.startedAt);
        const tree = roots.flatMap((r) => engine.jobs.store.tree(r.id)).map((j) => jobLine(j, bots));
        const working = roots.some((r) => !SETTLED.includes(r.status));
        return jsonResult({ status: !t.done ? 'running' : working ? 'waiting for its team' : 'done', answer: t.reply, error: t.error, jobs: tree, final: roots.map((r) => r.result).filter(Boolean).pop() ?? null });
      }
      case 'crew_interrupt': {
        const t = tickets.get(str(a.id));
        if (!t) throw new Error('No such send id.');
        if (t.threadId) {
          for (const r of engine.jobs.store.all().filter((j) => !j.parentId && j.assignee.threadId === t.threadId && j.createdAt >= t.startedAt && !SETTLED.includes(j.status))) engine.jobs.stop(r.id, 'interrupted');
          const th = store.thread(t.threadId);
          if (th?.chatId) await engine.stopChat(th.engine, th.chatId);
        }
        if (t.roomId) engine.roomsHook?.pause?.(t.roomId);
        return text('Stopped.');
      }
      case 'crew_create_bot': {
        const b = engine.createBot({ name: a.name, title: a.title, description: a.description, soul: a.soul, agent: engineOf(a.engine), modelId: a.model ? str(a.model) : undefined, access: cap(a.access) ?? 'edit' });
        return text(`Made @${b.name}.`);
      }
      case 'crew_update_bot': {
        const b = bot(a.bot);
        const f: Record<string, unknown> = {};
        for (const k of ['title', 'description', 'soul']) if (a[k] !== undefined) f[k] = a[k];
        if (a.engine !== undefined) f.agent = engineOf(a.engine);
        if (a.model !== undefined) f.modelId = str(a.model) || null;
        if (a.access !== undefined && cap(a.access)) f.access = cap(a.access);
        engine.updateBot(b.id, f);
        return text(`Updated @${b.name}.`);
      }
      case 'crew_create_room': {
        const rooms = engine.roomsHook;
        if (!rooms) throw new Error('Rooms are not available here.');
        const members = (Array.isArray(a.members) ? a.members : str(a.members).split(/[,\s]+/)).filter(Boolean).map((m) => bot(m));
        const r = rooms.create({ title: str(a.name) || 'Room', topic: str(a.bulletin), mode: str(a.mode) || undefined });
        for (const m of members) rooms.addMember(r.id, m.id);
        if (a.lead) rooms.update(r.id, { lead: bot(a.lead).id });
        return text(`Made #${str(a.name) || 'Room'}.`);
      }
      case 'crew_import':
        return text(await engine.sharing.apply({ url: str(a.url) || undefined, text: str(a.text) || undefined, library: str(a.library) || undefined }));
      case 'crew_export': {
        const names = Array.isArray(a.bots) ? a.bots : [];
        return text(engine.sharing.export({ botIds: names.map((n) => bot(n).id), name: str(a.name) || undefined }).text);
      }
      default:
        return errorResult(`Unknown tool ${name}`);
    }
  };

  return {
    path: '/crew-admin',
    name: 'crew_admin',
    instructions: 'AntiGem Crew from the outside: look at the crew, send work to a bot or a room and wait for it (with the jobs it hands out), make bots and rooms, import a crew. It cannot approve requests, delete anything or see credentials.',
    tools: () => tools,
    notReady,
    call: async (name, args) => {
      try {
        return await call(name, args);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
