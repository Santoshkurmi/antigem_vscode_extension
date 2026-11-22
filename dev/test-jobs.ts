// Offline test of Crew jobs (docs/crew/PLAN.md Phase 3, src/core/crew/jobs): crew_assign fan-out from a DM turn with
// ONE resume for all reports, envelopes, evidence in reports, a question interrupting once (crew_answer), nested jobs,
// acknowledgements and notify, guards (self, up the chain, depth, duplicates, unknown names), failures and retry,
// stop, a room turn's tree reported back in the room, crew_report / crew_jobs / crew_thread, one turn per bot, and the
// Mission Control view. Fake agent backends; a crew in a temp folder.
//   npx esbuild dev/test-jobs.ts --bundle --platform=node --outfile=<tmp>/t.js && node <tmp>/t.js
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, ChatMessage, ToolCall } from '../shared/model';
import type { HostToView, JobsStateView } from '../shared/protocol';
import { CrewEngine } from '../src/core/crew/engine';
import { LIMITS } from '../src/core/crew/jobs/runtime';
import { RoomEngine } from '../src/core/crew/rooms/engine';
import type { JobRow, ThreadRecord } from '../src/core/crew/types';
import type { McpServerDef } from '../src/core/mcp/server';
import type { AgentBackend, ChatState, SendRequest } from '../src/core/types';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 800)}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ fake agents

interface Reply {
  text: string;
  delay?: number;
  tools?: Partial<ToolCall>[];
  fail?: string;
}
/** who = the bot ("# You are X" in its setup), its message → reply. */
let script: (who: string, text: string) => Reply = (who) => ({ text: `${who} did it.` });

class FakeBackend {
  chats = new Map<string, ChatState>();
  subs = new Map<string, Set<(s: ChatState) => void>>();
  sent: (SendRequest & { who: string; at: number })[] = [];
  stopped: string[] = [];
  constructor(readonly kind: AgentKind) {}
  status() {
    return { kind: this.kind, label: this.kind, state: 'online' as const };
  }
  conversations() {
    return [];
  }
  models() {
    return { agent: this.kind, models: [], selectedId: null };
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
    const who = /# You are ([\p{L}\p{N}_-]+)/u.exec(req.setup?.instructions ?? '')?.[1] ?? /You are ([\p{L}\p{N}_-]+)/u.exec(req.text)?.[1] ?? '?';
    this.sent.push({ ...req, who, at: Date.now() });
    const r = script(who, req.text);
    if (r.fail) throw new Error(r.fail);
    const st = this.getState(req.conversationId);
    st.messages.push(msg('USER', req.text));
    st.isStreaming = true;
    this.emit(req.conversationId);
    setTimeout(() => {
      const m = msg('ASSISTANT', r.text);
      m.toolCalls = (r.tools ?? []).map((t, i) => ({ id: `t${i}`, name: 'Bash', toolType: 'BASH', command: '', status: 'SUCCESS', output: '', ...t }) as ToolCall);
      if (m.toolCalls.length) m.content = `${m.toolCalls.map((t) => `<!-- tool_call:${t.id} -->`).join('')}${r.text}`;
      m.tokenUsage = { promptTokens: 100, outputTokens: 10, cachedTokens: 0, cacheCreationTokens: 0, totalTokens: 110, durationMs: 1, isEstimated: false };
      st.messages.push(m);
      st.isStreaming = false;
      this.emit(req.conversationId);
    }, r.delay ?? 150);
  }
  async approval() {}
  async answer() {}
  async stop(id: string) {
    this.stopped.push(id);
    const st = this.getState(id);
    st.isStreaming = false;
    this.emit(id);
  }
  async conversationAction() {}
}
let n = 0;
const msg = (role: 'USER' | 'ASSISTANT', content: string): ChatMessage => ({ id: `m${++n}`, conversationId: '', role, content, toolCalls: [], isStreaming: false, attachments: [], createdAt: Date.now() }) as ChatMessage;

// ------------------------------------------------------------------------------------------------ setup

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-jobs-'));
const backends: Partial<Record<AgentKind, FakeBackend>> = { CLAUDE: new FakeBackend('CLAUDE'), CODEX: new FakeBackend('CODEX') };
const all = () => [...backends.CLAUDE!.sent, ...backends.CODEX!.sent].sort((a, b) => a.at - b.at);
const active: HostToView[] = [];
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
  log: () => undefined,
});
const rooms = new RoomEngine(crew.rooms);
crew.removeFromRooms = (id) => rooms.removeBotEverywhere(id);
crew.onRoomsChanged = () => rooms.refresh();
crew.roomReport = (r, b, t) => rooms.reportTurn(r, b, t);
crew.roomNote = (r, t) => rooms.note(r, t);
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
const jobs = crew.jobs;
const mcpBase = crew.crew.mcp();

/** A crew tool call as the bot in [thread] (Claude / Codex: the thread's own URL). */
async function tool(thread: ThreadRecord | string, name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> {
  const t = typeof thread === 'string' ? crew.crew.store.thread(thread)! : thread;
  const def = mcpBase.resolve!(new URLSearchParams({ t: t.id, cap: crew.crew.identity.cap(t.id) })) as McpServerDef;
  const r = await def.call(name, args, { meta: null });
  return { text: (r.content[0] as any).text as string, error: !!r.isError };
}

async function until(what: string, f: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const job = (id: string) => jobs.store.get(id)!;
const kidsOf = (id: string) => jobs.store.children(id);
const idsIn = (text: string) => [...text.matchAll(/job (j_[0-9a-f]+)/g)].map((m) => m[1]);
/** Claude sends since [mark] to a chat matching [re]. */
const sendsSince = (mark: number, chatId: string | null, re: RegExp) => backends.CLAUDE!.sent.slice(mark).filter((s) => s.conversationId === chatId && re.test(s.text));

/** The user's DM message to a bot: its turn runs (tracked like the chat view does); returns the DM thread. */
async function dm(botId: string, text: string): Promise<ThreadRecord> {
  active.length = 0;
  crew.openDm(botId);
  const tag = (active.find((m) => m.type === 'crewDm') as any)?.tag;
  const have = crew.crew.store.threads().find((t) => t.kind === 'dm' && t.botId === botId)!;
  const chatId = have.chatId ?? `dm-${botId}`;
  const req = crew.prepareSend({ conversationId: chatId, isNew: !have.chatId, text, attachments: [], modelId: null, workspaceUri: null }, crew.crew.store.bot(botId)!.engine, tag?.threadId ?? null);
  await backends[crew.crew.store.bot(botId)!.engine]!.send(req);
  return crew.crew.store.thread(have.id)!;
}

async function main() {
  const lead = crew.createBot({ name: 'Lead', agent: 'CLAUDE', title: 'team lead' });
  const ada = crew.createBot({ name: 'Ada', agent: 'CLAUDE', title: 'planner' });
  const pip = crew.createBot({ name: 'Pip', agent: 'CODEX', title: 'builder' });
  const tess = crew.createBot({ name: 'Tess', agent: 'CODEX', title: 'tester' });

  // ---------------------------------------------------------------- fan-out, one resume
  console.log('"Plan, build and test X": fan-out to 3 bots, the lead resumes ONCE with all reports');
  script = (who, text) => {
    if (who === 'Lead') return /📋 Reports/.test(text) ? { text: 'Done: Ada planned, Pip built, Tess tested (npm test passes). Not verified: the UI.' } : { text: 'I handed it out.', delay: 900 };
    if (who === 'Pip') return { text: 'Built the app.', delay: 400, tools: [{ toolType: 'EDIT_FILE', name: 'Write', command: path.join(tmp, 'todo.ts') }, { toolType: 'BASH', command: 'npm run build', exitCode: 0 }] };
    if (who === 'Tess') return { text: 'Tests pass.', delay: 700, tools: [{ toolType: 'BASH', command: 'npm test', exitCode: 0 }] };
    return { text: `${who}: plan written.`, delay: 200 };
  };
  const leadDm = await dm(lead.id, 'Plan, build and test a todo app');
  await sleep(100);
  const r1 = await tool(leadDm, 'crew_assign', { to: ['Ada', 'Pip', 'Tess'], brief: 'Plan, build and test a small todo app in this folder.', done_when: 'npm test passes', title: 'todo app' });
  check('crew_assign hands out 3 jobs and says to end the turn', !r1.error && idsIn(r1.text).length === 3 && /end your turn now/.test(r1.text), r1.text);
  const root = jobs.store.all().find((j) => !j.parentId && j.assignee.botId === lead.id)!;
  check('the DM turn became the root (quote = the user’s words)', !!root && root.origin.kind === 'person' && root.origin.quote.includes('Plan, build and test a todo app') && root.status === 'running');
  await until('the tree settles', () => job(root.id).status === 'done', 20_000);
  const leadSends = backends.CLAUDE!.sent.filter((s) => s.conversationId === leadDm.chatId);
  const resumes = leadSends.filter((s) => /📋 Reports/.test(s.text));
  check('ONE resume turn for the lead, with all three reports', resumes.length === 1 && /Ada ✓ · Pip ✓ · Tess ✓|Pip ✓ · Ada ✓|✓.*✓.*✓/.test(resumes[0].text), resumes.map((r) => r.text.slice(0, 120)));
  const rep = resumes[0].text;
  check('reports carry observed evidence apart from the bot’s own account', rep.includes('Observed: ran 1 command, edited todo.ts') && rep.includes('$ npm run build → exit 0') && rep.includes('its own account, not verified') && rep.includes('"""\nBuilt the app.'), rep.slice(0, 900));
  check('the resume runs in the DM chat with the bot’s setup', !!resumes[0].setup && resumes[0].setup.instructions.includes('# You are Lead'));
  const kids = kidsOf(root.id);
  check('every child is done and reported; the root has the lead’s final words', kids.every((k) => k.status === 'done' && k.reported) && /Ada planned/.test(job(root.id).result ?? ''), kids.map((k) => [k.status, k.reported]));
  const pipEnv = backends.CODEX!.sent.find((s) => s.who === 'Pip')!.text;
  check('the envelope: who asked, the quoted request, level, done-when, brief, rules', pipEnv.includes('@Lead (team lead) handed you job') && pipEnv.includes('"Plan, build and test a todo app"') && pipEnv.includes('Done when: npm test passes') && pipEnv.includes('NEEDS INPUT') && pipEnv.includes('Your level for this job: edit'), pipEnv);
  check('children ran on work threads (hidden chats), at the same time', kids.every((k) => crew.crew.store.thread(k.assignee.threadId!)?.kind === 'work'));
  const deco = crew.decorate([{ id: crew.crew.store.thread(kids[1].assignee.threadId!)!.chatId!, title: 'x' } as any]);
  check('work chats stay out of the chat list', deco[0].groupBot === true);

  // ---------------------------------------------------------------- a question interrupts once
  console.log('a question interrupts the wait once; crew_answer sends it on');
  let asked = 0;
  script = (who, text) => {
    if (who === 'Lead') return /asks \(job/.test(text) ? { text: 'Answered.', delay: 800 } : /📋 Reports/.test(text) ? { text: 'All good.' } : { text: 'Handed out.', delay: 600 };
    if (who === 'Tess') return /Answer on job/.test(text) ? { text: 'Used SQLite, tests pass.' } : (asked++, { text: 'I started.\nNEEDS INPUT: SQLite or Postgres?' });
    return { text: `${who} ok`, delay: 300, tools: [{ toolType: 'BASH', command: 'ls', exitCode: 0 }] };
  };
  const m2 = backends.CLAUDE!.sent.length;
  const dm2 = await dm(lead.id, 'Add storage');
  await sleep(100);
  const r2 = await tool(dm2, 'crew_assign', { to: 'Tess, Pip', brief: 'Add storage to the todo app.' });
  const [tessJob] = idsIn(r2.text).filter((id) => job(id).assignee.botId === tess.id);
  await until('Tess asks', () => job(tessJob).status === 'needs_input');
  await until('the lead gets the question', () => sendsSince(m2, dm2.chatId, /asks \(job/).length > 0);
  const qSend = sendsSince(m2, dm2.chatId, /asks \(job/)[0];
  check('the question reaches the lead while Pip still works', qSend.text.includes('SQLite or Postgres?') && qSend.text.includes(`crew_answer (job: "${tessJob}")`), qSend.text);
  const ans = await tool(dm2, 'crew_answer', { job: tessJob, answer: 'SQLite' });
  check('crew_answer sends the answer on', !ans.error && /Sent to @Tess/.test(ans.text), ans.text);
  const root2 = job(tessJob).rootId;
  await until('the second tree settles', () => job(root2).status === 'done', 20_000);
  const r2Resumes = sendsSince(m2, dm2.chatId, /📋 Reports/);
  check('one question turn, then ONE resume with both reports', r2Resumes.length === 1 && /Pip ✓/.test(r2Resumes[0].text) && /Tess ✓/.test(r2Resumes[0].text) && sendsSince(m2, dm2.chatId, /asks \(job/).length === 1 && asked === 1, r2Resumes.map((r) => r.text.slice(0, 100)));
  check('Tess got the answer and finished', job(tessJob).status === 'done' && job(tessJob).answer === 'SQLite' && /SQLite, tests pass/.test(job(tessJob).result ?? ''));

  // ---------------------------------------------------------------- nested jobs
  console.log('nested: a teammate hands part of its job on; each requester resumes once');
  let adaJob = '';
  script = (who, text) => {
    if (who === 'Lead') return /📋 Reports/.test(text) ? { text: 'Lead wraps up.' } : { text: 'On it.', delay: 600 };
    if (who === 'Ada') return /📋 Reports/.test(text) ? { text: 'Ada: Pip did the API, I checked it.' } : { text: 'Asked Pip for the API.', delay: 800 };
    return { text: 'API done.', delay: 200 };
  };
  const m3 = backends.CLAUDE!.sent.length;
  const dm3 = await dm(lead.id, 'Ship the API');
  await sleep(100);
  adaJob = idsIn((await tool(dm3, 'crew_assign', { to: 'Ada', brief: 'Ship the API.' })).text)[0];
  await until('Ada runs', () => job(adaJob).status === 'running' && !!job(adaJob).assignee.threadId);
  const adaThread = job(adaJob).assignee.threadId!;
  const nested = await tool(adaThread, 'crew_assign', { to: 'Pip', brief: 'Write the API endpoints.' });
  const pipJob = idsIn(nested.text)[0];
  check('a job’s turn can hand work on (depth 2)', !!pipJob && job(pipJob).parentId === adaJob && job(pipJob).depth === 2, nested.text);
  const back = await tool(adaThread, 'crew_assign', { to: 'Lead', brief: 'You do it.' });
  check('handing work back up the chain is refused', back.error && /waiting for your work/.test(back.text), back.text);
  const self = await tool(adaThread, 'crew_assign', { to: 'Ada', brief: 'do it myself' });
  check('assigning to yourself points to crew_thread', self.error && /crew_thread/.test(self.text));
  const unknown = await tool(adaThread, 'crew_assign', { to: 'Zed', brief: 'x x x' });
  check('an unknown name lists the teammates', unknown.error && /No teammate called @Zed/.test(unknown.text) && /@Pip/.test(unknown.text));
  const dup = await tool(adaThread, 'crew_assign', { to: 'Pip', brief: 'Write the API  endpoints.' });
  check('the same brief to the same bot is not doubled', /already has this as job/.test(dup.text) && kidsOf(adaJob).length === 1, dup.text);
  const root3 = job(adaJob).rootId;
  await until('the nested tree settles', () => job(root3).status === 'done', 20_000);
  const adaResumes = backends.CLAUDE!.sent.slice(m3).filter((s) => s.who === 'Ada' && /📋 Reports/.test(s.text));
  const leadResumes3 = sendsSince(m3, dm3.chatId, /📋 Reports/);
  check('Ada resumed once with Pip’s report; the lead once with Ada’s', adaResumes.length === 1 && leadResumes3.length === 1 && leadResumes3[0].text.includes('Ada: Pip did the API'), [adaResumes.length, leadResumes3.length]);

  // ---------------------------------------------------------------- acks, notify
  console.log('acknowledgements and notify do not wake the requester');
  script = (who, text) => (who === 'Lead' ? (/📋 Reports/.test(text) ? { text: 'should not happen' } : { text: 'ok', delay: 500 }) : { text: 'Got it, thanks!' });
  const m4 = backends.CLAUDE!.sent.length;
  const dm4 = await dm(lead.id, 'Tell Pip about the freeze');
  await sleep(100);
  const ackJob = idsIn((await tool(dm4, 'crew_assign', { to: 'Pip', brief: 'FYI: code freeze on Friday.', mode: 'notify' })).text)[0];
  const ackJob2 = idsIn((await tool(dm4, 'crew_assign', { to: 'Tess', brief: 'Please confirm you saw the freeze notice.' })).text)[0];
  await until('acks settle', () => job(job(ackJob).rootId).status === 'done' && job(ackJob2).status === 'done');
  await sleep(300);
  check('no resume turn for acknowledgements only', !sendsSince(m4, dm4.chatId, /📋 Reports/).length && job(ackJob).ack && job(ackJob2).ack, [sendsSince(m4, dm4.chatId, /📋 Reports/).length, job(ackJob).ack, job(ackJob2).ack]);

  // ---------------------------------------------------------------- failures, retry, stop
  console.log('failures, retry, stop, depth');
  let pipFails = true;
  script = (who, text) => {
    if (who === 'Lead') return /📋 Reports/.test(text) ? { text: 'Pip failed, said so.' } : { text: 'ok', delay: 500 };
    if (who === 'Pip' && pipFails) return { text: '', fail: 'Codex is down' };
    return { text: `${who} fine`, delay: 200 };
  };
  const m5 = backends.CLAUDE!.sent.length;
  const dm5 = await dm(lead.id, 'Try something');
  await sleep(100);
  const failJob = idsIn((await tool(dm5, 'crew_assign', { to: 'Pip', brief: 'Do the risky thing.' })).text)[0];
  await until('the job fails (after one rerun)', () => job(failJob).status === 'failed');
  await until('the lead hears the failure', () => job(job(failJob).rootId).status === 'done');
  await until('the failure report is sent', () => sendsSince(m5, dm5.chatId, /📋 Reports/).length === 1);
  const failRep = sendsSince(m5, dm5.chatId, /📋 Reports/)[0];
  check('a failed job: rerun once, then reported as failed', job(failJob).executions === 2 && /Pip ✗/.test(failRep.text) && /It failed: Codex is down/.test(failRep.text), [job(failJob).executions, failRep?.text.slice(0, 200)]);
  pipFails = false;
  void crew.handle('mc', () => undefined, { type: 'jobAction', action: 'retry', jobId: failJob });
  await until('the retried job finishes', () => job(failJob).status === 'done');
  await until('its requester resumes again', () => sendsSince(m5, dm5.chatId, /📋 Reports/).length === 2);
  check('retry runs it again and reports to the requester', job(failJob).result === 'Pip fine');
  script = (who, text) => (who === 'Lead' ? (/📋 Reports/.test(text) ? { text: 'stopped' } : { text: 'ok', delay: 300 }) : { text: 'slow work', delay: 3000 });
  const dm6 = await dm(lead.id, 'Long job');
  await sleep(100);
  const slow = idsIn((await tool(dm6, 'crew_assign', { to: 'Tess', brief: 'A long task.' })).text)[0];
  await until('it runs', () => job(slow).status === 'running');
  void crew.handle('mc', () => undefined, { type: 'jobAction', action: 'stop', jobId: job(slow).rootId });
  await sleep(600);
  check('stopping a tree stops its running turn', job(slow).status === 'cancelled' && job(job(slow).rootId).status === 'cancelled' && backends.CODEX!.stopped.includes(crew.crew.store.thread(job(slow).assignee.threadId!)!.chatId!));
  // depth: a chain of LIMITS.depth levels
  script = (_who) => ({ text: 'working', delay: 4000 });
  const dm7 = await dm(lead.id, 'Deep');
  await sleep(100);
  let cur = idsIn((await tool(dm7, 'crew_assign', { to: 'Ada', brief: 'level 1' })).text)[0];
  const chain = [ada, pip, tess, lead];
  let deepErr = '';
  for (let d = 2; d <= LIMITS.depth + 1; d++) {
    await until(`level ${d - 1} runs`, () => job(cur).status === 'running' && !!job(cur).assignee.threadId);
    const next = chain[(d - 1) % chain.length];
    const r = await tool(job(cur).assignee.threadId!, 'crew_assign', { to: next.name === job(cur).assignee.botId ? 'Pip' : next.name, brief: `level ${d}` });
    if (r.error) {
      deepErr = r.text;
      break;
    }
    cur = idsIn(r.text)[0];
  }
  check(`jobs go at most ${LIMITS.depth} levels deep (or are refused up the chain)`, /levels deep|waiting for your work/.test(deepErr), deepErr);
  void crew.handle('mc', () => undefined, { type: 'jobAction', action: 'stop', jobId: job(cur).rootId });

  // ---------------------------------------------------------------- crew_report, crew_jobs, crew_thread, roster
  console.log('crew_report, crew_jobs, crew_thread, roster');
  let reportOut = '';
  let threadOut = '';
  script = (who, text) => {
    if (who === 'Lead') return /📋 Reports/.test(text) ? { text: 'thanks' } : { text: 'ok', delay: 500 };
    if (who === 'Ada' && /thread job|handed you job/.test(text) && /draw the diagram/.test(text)) return { text: 'Diagram drawn.', delay: 300 };
    return { text: 'Report attached.', delay: 1200 };
  };
  const dm8 = await dm(lead.id, 'Document it');
  await sleep(100);
  const docJob = idsIn((await tool(dm8, 'crew_assign', { to: 'Ada', brief: 'Write the docs.' })).text)[0];
  await until('Ada runs', () => job(docJob).status === 'running');
  const adaT = job(docJob).assignee.threadId!;
  reportOut = (await tool(adaT, 'crew_report', { summary: 'Docs written', artifacts: JSON.stringify([{ kind: 'file', path: path.join(tmp, 'README.md') }, { url: 'https://example.com/docs' }, { kind: 'diff' }]) })).text;
  threadOut = (await tool(adaT, 'crew_thread', { action: 'start', message: 'draw the diagram', title: 'diagram' })).text;
  const roster = (await tool(adaT, 'crew_roster', {})).text;
  const jobsList = (await tool(adaT, 'crew_jobs', {})).text;
  check('crew_report: lenient artifacts (a stringified list), bad ones skipped', /Attached 2 items/.test(reportOut) && /1 skipped/.test(reportOut) && job(docJob).artifacts.length === 2 && job(docJob).artifacts[1].kind === 'link', reportOut);
  check('crew_thread: parallel work on itself (no waiting for its own lock)', /Started thread j_/.test(threadOut), threadOut);
  check('roster and crew_jobs list open jobs', /Your open jobs:/.test(roster) && roster.includes(docJob) && jobsList.includes(docJob), roster);
  await until('the docs tree settles', () => job(job(docJob).rootId).status === 'done', 20_000);
  const thr = jobs.store.all().find((j) => j.thread === 'self')!;
  check('the thread ran beside the job and reported to Ada', thr.status === 'done' && thr.result === 'Diagram drawn.' && thr.requester.botId === ada.id && backends.CLAUDE!.sent.some((s) => s.who === 'Ada' && /📋 Reports: Ada ✓/.test(s.text)));
  const detail = (await tool(dm8, 'crew_jobs', { id: docJob })).text;
  check('crew_jobs with an id: brief, result, its jobs', /Brief: Write the docs/.test(detail) && /Its jobs:/.test(detail), detail);

  // ---------------------------------------------------------------- one turn at a time per bot
  console.log('one turn at a time per bot');
  script = (who, text) => (who === 'Lead' ? (/📋 Reports/.test(text) ? { text: 'ok' } : { text: 'ok', delay: 400 }) : { text: `${who} done`, delay: 600 });
  const dmA = await dm(lead.id, 'two things');
  await sleep(100);
  const ja = idsIn((await tool(dmA, 'crew_assign', { to: 'Tess', brief: 'first thing' })).text)[0];
  const jb = idsIn((await tool(dmA, 'crew_assign', { to: 'Tess', brief: 'second thing' })).text)[0];
  await until('both done', () => job(ja).status === 'done' && job(jb).status === 'done');
  const tessSends = backends.CODEX!.sent.filter((s) => s.who === 'Tess' && /(first|second) thing/.test(s.text));
  check('two jobs for one bot run one after the other', tessSends.length === 2 && tessSends[1].at - tessSends[0].at >= 550, tessSends.map((s) => s.at));

  // ---------------------------------------------------------------- a room turn's tree
  console.log('a room turn hands work out; the report is posted in the room');
  const room = rooms.create({ title: 'Ops', userName: 'Boss' });
  rooms.addMember(room.id, lead.id);
  rooms.update(room.id, { mode: 'lead' });
  let roomThread: ThreadRecord | null = null;
  script = (who, text) => {
    if (who === 'Lead') return /📋 Reports/.test(text) ? { text: 'Room update: Pip deployed it; logs attached.' } : { text: 'Asking Pip.', delay: 900 };
    return { text: 'Deployed.', delay: 200, tools: [{ toolType: 'BASH', command: 'deploy.sh', exitCode: 0 }] };
  };
  rooms.post(room.id, 'please deploy');
  setTimeout(() => {
    if (process.env.DEBUG_JOBS) console.log('DEBUG', JSON.stringify({ msgs: rooms.find(room.id)!.messages.map((m) => [m.from, m.text]), typing: [...((rooms as any).rts.get(room.id)?.typing ?? [])], busy: crew.locks.busy(lead.id), q: (rooms as any).rts.get(room.id)?.queue, running: (rooms as any).rts.get(room.id)?.running }));
  }, 3000);
  await until('the lead’s room turn runs', () => !!(roomThread = crew.crew.store.threads().find((t) => t.kind === 'room' && t.roomId === room.id && t.botId === lead.id) ?? null) && crew.crew.identity.inTurn(roomThread.id));
  const rr = await tool(roomThread!, 'crew_assign', { to: 'Pip', brief: 'Deploy the app.', title: 'deploy' });
  const roomRoot = job(idsIn(rr.text)[0]).rootId;
  check('the room turn is the root (origin room)', job(roomRoot).origin.kind === 'room' && job(roomRoot).origin.roomId === room.id);
  await until('the room tree settles', () => job(roomRoot).status === 'done', 20_000);
  await sleep(300);
  const g = rooms.find(room.id)!;
  const posted = g.messages.find((m) => m.text.startsWith('Room update'));
  check('the report turn posts in the room', !!posted && posted.picked?.by === 'report', g.messages.map((m) => `${m.from}: ${m.text.slice(0, 40)}`));
  check('the room shows the hand-off and the result as notes', g.messages.some((m) => m.from === 'notice' && /Lead handed work to @Pip/.test(m.text)) && g.messages.some((m) => m.from === 'notice' && /Pip finished "deploy"/.test(m.text)));

  // ---------------------------------------------------------------- Mission Control
  console.log('Mission Control');
  let mc: JobsStateView | null = null;
  await crew.handle('mc', (m) => m.type === 'jobsState' && (mc = m.jobs), { type: 'jobsWatch', open: true });
  const view = mc as unknown as JobsStateView;
  const t1 = view?.trees.find((t) => t.root.id === root.id);
  check('trees with the root and its jobs, parents first', !!t1 && t1.jobs.length === 3 && t1.root.requester === null && t1.jobs.every((j) => j.requester?.name === 'Lead'), t1?.jobs.map((j) => j.bot?.name));
  const nestedTree = view.trees.find((t) => t.root.id === root3)!;
  check('nested jobs follow their parent', nestedTree.jobs.map((j) => j.bot?.name).join() === 'Ada,Pip', nestedTree.jobs.map((j) => j.bot?.name));
  check('evidence, usage and budgets are shown', t1!.jobs.some((j) => j.digest === 'ran 1 command, edited todo.ts') && t1!.jobs.every((j) => j.usage.input === 100) && t1!.budget.requests === 3 && t1!.budget.limits.requests === LIMITS.requests);
  check('the Crew home counts jobs', crew.state().jobs.today >= 8, crew.state().jobs);
  jobs.store.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'crew', 'jobs', 'jobs.json'), 'utf8')) as JobRow[];
  const events = fs.readFileSync(path.join(tmp, 'crew', 'jobs', 'events.ndjson'), 'utf8').trim().split('\n');
  check('jobs.json and events.ndjson are written', onDisk.length === jobs.store.all().length && events.some((l) => l.includes('"kind":"assigned"')) && events.some((l) => l.includes('"kind":"resume"')));

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
