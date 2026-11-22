// Offline test of Crew Phase 5 (docs/crew/PLAN.md §7 Goals, §10 Chief): the Chief's prompt and crew_manage (Chief
// only, ≤ 4 new bots a turn, rooms, retry ≤ 2, Undo), work the Chief hands out at its level (capped), a failed job
// starting a Chief turn in its Problems thread, room goals (control blocks, a busy member parks and the goal still
// finishes, needs-input → your answer resumes it, budget, missing control lines) and bot goals (judge: continue /
// done / wait, a DM pauses it, Resume). Fake agents; a crew in a temp folder.
//   npx esbuild dev/test-chief.ts --bundle --platform=node --outfile=<tmp>/t.js && node <tmp>/t.js
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, ChatMessage } from '../shared/model';
import type { HostToView } from '../shared/protocol';
import { CrewEngine } from '../src/core/crew/engine';
import { parseControl, parseJudge } from '../src/core/crew/goals';
import { RoomEngine } from '../src/core/crew/rooms/engine';
import type { ThreadRecord } from '../src/core/crew/types';
import type { McpServerDef } from '../src/core/mcp/server';
import type { AgentBackend, ChatState, SendRequest } from '../src/core/types';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 700)}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, f: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

let script: (who: string, text: string) => { text: string; delay?: number } = (who) => ({ text: `${who} ok` });
class FakeBackend {
  chats = new Map<string, ChatState>();
  subs = new Map<string, Set<(s: ChatState) => void>>();
  sent: (SendRequest & { who: string; at: number })[] = [];
  constructor(readonly kind: AgentKind) {}
  status() {
    return { kind: this.kind, label: this.kind, state: 'online' as const };
  }
  conversations() {
    return [];
  }
  models() {
    return { agent: this.kind, models: [{ id: 'big', displayName: 'Big', family: 'OTHER' as const, description: '', isDefault: true, baseName: 'big' }, { id: 'mini', displayName: 'Mini', family: 'OTHER' as const, description: '', isDefault: false, baseName: 'mini' }], selectedId: null };
  }
  subscribe(id: string, l: (s: ChatState) => void) {
    let s = this.subs.get(id);
    if (!s) this.subs.set(id, (s = new Set()));
    s.add(l);
    return () => s!.delete(l);
  }
  getState(id: string): ChatState {
    let st = this.chats.get(id);
    if (!st) {
      st = { conversation: null, agent: this.kind, messages: [], isStreaming: false, isLoading: false, error: null, queued: [], approvals: [], question: null, artifacts: [], workingLabel: null };
      this.chats.set(id, st);
    }
    return st;
  }
  private emit(id: string) {
    const st = this.chats.get(id)!;
    for (const l of this.subs.get(id) ?? []) l({ ...st, messages: [...st.messages] });
  }
  async send(req: SendRequest) {
    const who = /# You are ([\p{L}\p{N}_-]+)/u.exec(req.setup?.instructions ?? '')?.[1] ?? (/You judge progress/.test(req.text) ? 'JUDGE' : /You are ([\p{L}\p{N}_-]+)/u.exec(req.text)?.[1]) ?? '?';
    this.sent.push({ ...req, who, at: Date.now() });
    const r = script(who, req.text);
    const st = this.getState(req.conversationId);
    st.messages.push(msg('USER', req.text));
    st.isStreaming = true;
    this.emit(req.conversationId);
    setTimeout(() => {
      st.messages.push(msg('ASSISTANT', r.text));
      st.isStreaming = false;
      this.emit(req.conversationId);
    }, r.delay ?? 500);
  }
  async approval() {}
  async answer() {}
  async stop(id: string) {
    const st = this.getState(id);
    st.isStreaming = false;
    this.emit(id);
  }
  async conversationAction() {}
}
let n = 0;
const msg = (role: 'USER' | 'ASSISTANT', content: string): ChatMessage => ({ id: `m${++n}`, conversationId: '', role, content, toolCalls: [], isStreaming: false, attachments: [], createdAt: Date.now() }) as ChatMessage;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-chief-'));
const backends: Partial<Record<AgentKind, FakeBackend>> = { CLAUDE: new FakeBackend('CLAUDE'), CODEX: new FakeBackend('CODEX') };
const all = () => [...backends.CLAUDE!.sent, ...backends.CODEX!.sent].sort((a, b) => a.at - b.at);
const active: HostToView[] = [];
const toasts: string[] = [];
const crew = new CrewEngine({ mcpUrl: (p) => `http://127.0.0.1:1${p}`, mcpHeaders: () => ({}), root: path.join(tmp, 'crew'), groupsDir: path.join(tmp, 'none') });
crew.bind({
  backend: (k) => backends[k] as unknown as AgentBackend | undefined,
  enabledKinds: () => ['CLAUDE', 'CODEX'],
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => tmp,
  showChat: () => undefined,
  postActive: (m) => active.push(m),
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  openFile: () => undefined,
  notify: (t) => toasts.push(t),
  log: () => undefined,
});
const rooms = new RoomEngine(crew.rooms);
crew.onRoomsChanged = () => rooms.refresh();
crew.onPause = (ids) => rooms.pauseBots(ids);
crew.roomReport = (r, b, t) => rooms.reportTurn(r, b, t);
crew.roomNote = (r, t) => rooms.note(r, t);
crew.removeFromRooms = (id) => rooms.removeBotEverywhere(id);
crew.roomsHook = { create: (i) => rooms.create(i), addMember: (r, b) => void rooms.addMember(r, b), update: (r, d) => rooms.update(r, d), remove: (r) => rooms.remove(r) };
rooms.bind({
  backend: (k) => backends[k] as unknown as AgentBackend | undefined,
  enabledKinds: () => ['CLAUDE', 'CODEX'],
  conversations: () => [],
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => tmp,
  showChat: () => undefined,
  postActive: () => undefined,
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  log: () => undefined,
  crew: () => crew.roomApi(),
});
const mcpBase = crew.crew.mcp();
async function tool(thread: ThreadRecord, name: string, args: Record<string, unknown>) {
  const def = mcpBase.resolve!(new URLSearchParams({ t: thread.id, cap: crew.crew.identity.cap(thread.id) })) as McpServerDef;
  const r = await def.call(name, args, { meta: null });
  return { text: (r.content[0] as any).text as string, error: !!r.isError };
}
/** A thread in a crew turn (as if the bot were answering now). */
function inTurn(botId: string): ThreadRecord {
  const t: ThreadRecord = { id: `t_${botId}_${++n}`, botId, engine: crew.crew.store.bot(botId)!.engine, chatId: `c_${n}`, kind: 'work', roomId: null, jobId: null, seen: 0, setupKey: null, createdAt: 1, updatedAt: 1 };
  crew.crew.store.putThread(t);
  crew.crew.identity.beginTurn(t.id);
  return t;
}

async function main() {
  console.log('control blocks and judge replies');
  let pc = parseControl('Ada checks it next.\n{"status": "continue", "next": "@Ada", "instruction": "check the logs"}');
  check('a control line is read and stripped', pc.text === 'Ada checks it next.' && pc.control?.status === 'continue' && pc.control.next === 'Ada' && pc.control.instruction === 'check the logs', pc);
  pc = parseControl("Done!\n```json\n{'status': 'done', 'next': '', 'instruction': 'shipped'}\n```");
  check('lenient: fences, single quotes, "done"', pc.text === 'Done!' && pc.control?.status === 'completed', pc);
  check('no block: no control', parseControl('just words').control === null);
  check('judge: WAIT 20 / DONE / anything else = continue', parseJudge('WAIT 20 minutes').verdict === 'wait' && parseJudge('WAIT 20').minutes === 20 && parseJudge('DONE.').verdict === 'done' && parseJudge('hmm').verdict === 'continue');

  console.log('the Chief');
  const mk = (f: Record<string, unknown>) => crew.createBot({ chattiness: 0, access: 'edit', ...f });
  const boss = mk({ name: 'Boss', agent: 'CLAUDE', access: 'full', accessCeiling: 'full' });
  const ada = mk({ name: 'Ada', agent: 'CLAUDE' });
  const pip = mk({ name: 'Pip', agent: 'CODEX', accessCeiling: 'full' });
  const notChief = await tool(inTurn(ada.id), 'crew_manage', { action: 'create_bot', name: 'Zed' });
  check('crew_manage is refused for a bot that is not the Chief', notChief.error && /Only the Chief/.test(notChief.text));
  await crew.handle('v', () => undefined, { type: 'crewAction', action: 'setChief', botId: boss.id });
  const bt = inTurn(boss.id);
  check('the Chief is told it is the Chief', crew.crew.setupFor(bt).instructions.includes('## You are the Chief') && !crew.crew.setupFor(inTurn(ada.id)).instructions.includes('You are the Chief'));
  const made: string[] = [];
  for (const nm of ['Tess', 'Olga', 'Gus', 'Mia', 'Zed']) made.push((await tool(bt, 'crew_manage', { action: 'create_bot', name: nm, title: 'helper', soul: `You are ${nm}.`, access: 'full' })).text);
  check('at most 4 new bots a turn', made.slice(0, 4).every((t) => /^Created @/.test(t)) && /At most 4/.test(made[4]), made);
  const tess = crew.crew.store.bots().find((b) => b.name === 'Tess')!;
  check('a bot it makes is capped at edit and gets its soul', tess.access === 'edit' && crew.crew.store.soul(tess.id) === 'You are Tess.');
  const upd = await tool(bt, 'crew_manage', { action: 'update_bot', bot: 'Tess', title: 'tester', soul: 'You are Tess, a tester.' });
  check('update_bot', /Updated @Tess/.test(upd.text) && crew.crew.store.bot(tess.id)!.title === 'tester');
  const room = await tool(bt, 'crew_manage', { action: 'create_room', name: 'QA', members: ['Tess', 'Pip'], lead: 'Tess', bulletin: 'Testing' });
  const qa = rooms.summaries().find((r) => r.title === 'QA');
  check('create_room with members and a lead', /Made #QA/.test(room.text) && !!qa && rooms.find(qa.id)!.lead === tess.id && rooms.find(qa.id)!.bots.length === 2, room.text);
  let st = crew.state();
  check('its changes are listed (newest first)', st.changes[0]?.summary.startsWith('Made the room #QA') && st.changes.some((c) => c.summary === 'Created @Tess (helper)'), st.changes.map((c) => c.summary));
  const updEntry = st.changes.find((c) => c.summary.startsWith('Changed @Tess'))!;
  await crew.handle('v', () => undefined, { type: 'crewAction', action: 'undoManage', data: { id: updEntry.id } });
  check('Undo restores the bot as it was', crew.crew.store.bot(tess.id)!.title === 'helper' && crew.crew.store.soul(tess.id) === 'You are Tess.');
  const zedLess = crew.state().changes.find((c) => c.summary === 'Created @Mia (helper)')!;
  await crew.handle('v', () => undefined, { type: 'crewAction', action: 'undoManage', data: { id: zedLess.id } });
  check('Undo of a bot it made deletes it', !crew.crew.store.bots().some((b) => b.name === 'Mia') && crew.state().changes.find((c) => c.id === zedLess.id)?.undone === true);

  console.log('work the Chief hands out: at its level, capped');
  script = (who) => ({ text: `${who} done`, delay: 200 });
  const r1 = await tool(bt, 'crew_assign', { to: ['Ada', 'Pip'], brief: 'Do the thing.' });
  const ids = [...r1.text.matchAll(/job (j_[0-9a-f]+)/g)].map((m) => m[1]);
  const lvl = (id: string) => crew.jobs.store.get(id)!.level;
  const adaJob = ids.find((id) => crew.jobs.store.get(id)!.assignee.botId === ada.id)!;
  const pipJob = ids.find((id) => crew.jobs.store.get(id)!.assignee.botId === pip.id)!;
  check('Ada (highest level edit) stays at edit; Pip (allowed up to full) runs at the Chief\'s full', lvl(adaJob) === 'edit' && lvl(pipJob) === 'full', [lvl(adaJob), lvl(pipJob)]);
  crew.crew.identity.endTurn(bt.id);
  crew.jobs.turnEnded(bt.id);

  console.log('a failed job: the Chief looks at it in its Problems thread');
  script = (who, text) => {
    if (who === 'Ada' && /handed you job/.test(text)) return { text: '', delay: 700 };
    if (who === 'Boss' && /Problem: job/.test(text)) return { text: 'Ada gave no answer twice; I will retry it.', delay: 300 };
    return { text: `${who} ok`, delay: 200 };
  };
  const bt2 = inTurn(boss.id);
  const fail = [...(await tool(bt2, 'crew_assign', { to: 'Ada', brief: 'A job that fails.' })).text.matchAll(/job (j_[0-9a-f]+)/g)][0][1];
  crew.crew.identity.endTurn(bt2.id);
  crew.jobs.turnEnded(bt2.id);
  await until('the job fails', () => crew.jobs.store.get(fail)!.status === 'failed', 20_000);
  await until('the Chief is told', () => backends.CLAUDE!.sent.some((s) => s.who === 'Boss' && /Problem: job/.test(s.text)));
  const pt = crew.crew.store.threads().find((t) => t.kind === 'problems' && t.botId === boss.id);
  const ps = backends.CLAUDE!.sent.find((s) => s.who === 'Boss' && /Problem: job/.test(s.text))!;
  check('in its own Problems thread, with what failed and what it may do', !!pt && ps.conversationId === pt.chatId && ps.text.includes(fail) && /crew_manage/.test(ps.text) && /retried 0 of 2/.test(ps.text));
  await until('a toast with its answer', () => toasts.some((t) => /on a failed job: Ada gave no answer/.test(t)));
  check('you hear what the Chief said', true);
  script = (who) => ({ text: `${who} fixed it`, delay: 200 });
  const pt2 = { ...pt!, id: pt!.id };
  crew.crew.identity.beginTurn(pt2.id);
  const rr = await tool(pt2, 'crew_manage', { action: 'retry', job: fail });
  check('the Chief retries it (count shown)', /retry 1 of 2/.test(rr.text), rr.text);
  await until('the retry finishes', () => crew.jobs.store.get(fail)!.status === 'done');
  const j = crew.jobs.store.get(fail)!;
  j.retries = 2;
  crew.jobs.store.put(j);
  const rr2 = await tool(pt2, 'crew_manage', { action: 'retry', job: fail });
  check('not more than twice', rr2.error && /retried 2 times/.test(rr2.text));
  crew.crew.identity.endTurn(pt2.id);

  console.log('room goal: the lead drives, a busy member parks, the goal still finishes');
  const g = rooms.create({ title: 'Ship', userName: 'Sam' });
  rooms.addMember(g.id, ada.id);
  rooms.addMember(g.id, pip.id);
  let leadTurns = 0;
  script = (who, text) => {
    if (who === 'Ada' && /Room goal · team turn/.test(text)) {
      leadTurns++;
      if (leadTurns === 1) return { text: 'Pip, write the parser.\n{"status": "continue", "next": "Pip", "instruction": "write the parser"}' };
      return { text: 'Pip did it. We are done.\n{"status": "completed", "next": "", "instruction": "parser written"}' };
    }
    if (who === 'Pip' && /asks you: write the parser/.test(text)) return { text: 'Parser written.' };
    return { text: 'ok' };
  };
  // Pip is busy elsewhere for a while (its DM)
  const releasePip = crew.locks.mark(pip.id, 'its DM');
  setTimeout(releasePip, 1500);
  rooms.post(g.id, '/goal Ship the parser');
  await until('the goal ends', () => rooms.find(g.id)!.goal?.status !== 'running', 30_000);
  let cur = rooms.find(g.id)!;
  const posted = cur.messages.filter((m) => cur.bots.some((b) => b.id === m.from));
  check('"/goal" starts it; the lead and the member take turns; the control lines are not posted', posted.map((m) => m.name).join() === 'Ada,Pip,Ada' && !posted.some((m) => m.text.includes('"status"')), posted.map((m) => `${m.name}: ${m.text}`));
  check('the busy member waited and the goal completed', cur.goal?.status === 'completed' && cur.goal.turns === 3 && cur.messages.some((m) => /Goal reached: Ship the parser/.test(m.text)), cur.goal);
  check('goal turns are marked', posted.every((m) => m.picked?.by === 'goal'));

  console.log('room goal: needs input, then your answer resumes it; budget; no control line');
  leadTurns = 0;
  script = (who, text) => {
    if (who === 'Ada' && /Room goal · team turn/.test(text)) {
      leadTurns++;
      if (leadTurns === 1) return { text: 'Which database?\n{"status": "needs-input", "next": "", "instruction": "Postgres or SQLite?"}' };
      return { text: /SQLite/.test(text) ? 'SQLite then.\n{"status": "completed", "next": "", "instruction": "done"}' : 'no' };
    }
    return { text: 'ok' };
  };
  rooms.startGoal(g.id, 'Pick a database');
  await until('it asks', () => rooms.find(g.id)!.goal?.status === 'needs-input');
  cur = rooms.find(g.id)!;
  check('needs input: it stops and says so', cur.messages.some((m) => /The goal needs you: Postgres or SQLite/.test(m.text)));
  rooms.post(g.id, 'SQLite');
  await until('resumed and done', () => rooms.find(g.id)!.goal?.status === 'completed');
  check('your answer went to the lead and the goal finished', leadTurns === 2);
  script = (who, text) => (who === 'Ada' && /Room goal/.test(text) ? { text: 'Still working.\n{"status": "continue", "next": "", "instruction": "more"}' } : { text: 'ok' });
  rooms.startGoal(g.id, 'Polish', 3);
  await until('the budget stops it', () => rooms.find(g.id)!.goal?.status === 'stopped');
  check('it pauses after its team turns', rooms.find(g.id)!.goal!.turns === 3 && rooms.find(g.id)!.messages.some((m) => /paused after 3 team turns/.test(m.text)));
  script = (who, text) => (who === 'Ada' && /Room goal/.test(text) ? { text: 'I forgot the line.' } : { text: 'ok' });
  rooms.startGoal(g.id, 'Forgetful');
  await until('stopped for no control line', () => rooms.find(g.id)!.goal?.status === 'stopped');
  check('two lead turns without a control line stop it', rooms.find(g.id)!.messages.some((m) => /did not say how it goes/.test(m.text)));

  console.log('bot goal: a judge after each turn');
  let judged = 0;
  script = (who, text) => {
    if (who === 'JUDGE') return { text: ++judged === 1 ? 'CONTINUE' : 'DONE', delay: 100 };
    if (who === 'Pip') return { text: /standing goal/.test(text) ? 'Step 1 done.' : 'Step 2 done; all green.', delay: 300 };
    return { text: 'ok' };
  };
  await crew.handle('v', () => undefined, { type: 'crewAction', action: 'goal', botId: pip.id, data: { text: 'Keep the tests green', maxTurns: 5 } });
  await until('the goal is reached', () => crew.state().bots.find((b) => b.id === pip.id)!.goal?.status === 'done', 20_000);
  const gv = crew.state().bots.find((b) => b.id === pip.id)!.goal!;
  check('two turns, judged after each, done', gv.turns === 2 && judged === 2 && toasts.some((t) => /Pip's goal: reached/.test(t)), gv);
  check('the judge runs on the cheap model', backends.CODEX!.sent.filter((s) => s.who === 'JUDGE').every((s) => s.modelId === 'mini'));
  script = (who, text) => (who === 'JUDGE' ? { text: 'WAIT 30', delay: 100 } : who === 'Pip' && /goal/.test(text) ? { text: 'Waiting for CI.', delay: 300 } : { text: 'ok' });
  await crew.handle('v', () => undefined, { type: 'crewAction', action: 'goal', botId: pip.id, data: { text: 'Watch CI' } });
  await until('it waits', () => crew.state().bots.find((b) => b.id === pip.id)!.goal?.nextAt != null);
  const w = crew.state().bots.find((b) => b.id === pip.id)!.goal!;
  check('WAIT 30: it waits about 30 minutes', w.status === 'waiting' && Math.abs((w.nextAt ?? 0) - Date.now() - 30 * 60_000) < 60_000, w);
  active.length = 0;
  crew.openDm(pip.id);
  const tag = (active.find((m) => m.type === 'crewDm') as any).tag;
  crew.prepareSend({ conversationId: 'dm-pip', isNew: true, text: 'hi', attachments: [], modelId: null, workspaceUri: null }, 'CODEX', tag.threadId);
  check('writing to the bot pauses its goal', crew.state().bots.find((b) => b.id === pip.id)!.goal!.paused);
  await crew.handle('v', () => undefined, { type: 'jobAction', action: 'resumeGoal', jobId: w.jobId });
  await until('it goes on after Resume', () => backends.CODEX!.sent.filter((s) => s.who === 'Pip' && /Goal turn 2/.test(s.text)).length === 1);
  check('Resume runs its next turn', true);
  await crew.handle('v', () => undefined, { type: 'crewAction', action: 'goal', botId: pip.id, data: { stop: true } });
  check('Stop', crew.state().bots.find((b) => b.id === pip.id)!.goal!.status === 'cancelled');

  rooms.dispose();
  crew.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
