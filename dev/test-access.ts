// Offline test of Crew Phase 4 (docs/crew/PLAN.md §11, src/core/crew/access + inbox.ts): the level policy (talk / read
// / edit / auto / full, risky commands, edits outside the folder, outward actions at every level, always / session
// rules), the Inbox (approvals from 3 bots at once, why it asks, a waiting turn is not timed out, deny with a note,
// DM requests also answerable in the chat), job questions / failures as Inbox items, pause (everyone / one bot: rooms
// skip, jobs wait and go on), Antigravity's crew server asked first, the status line and toasts. Fake agents.
//   npx esbuild dev/test-access.ts --bundle --platform=node --outfile=<tmp>/t.js && node <tmp>/t.js
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, ChatMessage } from '../shared/model';
import type { ApprovalView, CrewStatusView, HostToView, InboxItemView } from '../shared/protocol';
import { decide } from '../src/core/crew/access/policy';
import { CrewEngine } from '../src/core/crew/engine';
import { claudeCrew } from '../src/core/crew/engines/claude';
import { codexSandbox } from '../src/core/crew/engines/codex';
import { opencodeRules } from '../src/core/crew/engines/opencode';
import { RoomEngine } from '../src/core/crew/rooms/engine';
import type { CrewAccess, ThreadRecord } from '../src/core/crew/types';
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
async function until(what: string, f: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

// ------------------------------------------------------------------------------------------------ approval cards

let k = 0;
const card = (icon: string, subtitle: string, extra: Partial<ApprovalView>): ApprovalView =>
  ({ key: `a${++k}`, agent: 'CLAUDE', icon, title: 'Allow?', subtitle, target: null, preview: null, primary: { id: 'allow', label: 'Allow' }, secondary: [], always: [], denyLabel: 'Deny', denyPlaceholder: '', ...extra }) as ApprovalView;
const bash = (cmd: string) => card('terminal', 'Bash', { preview: `$ ${cmd}` });
const edit = (p: string) => card('edit', 'Edit', { target: p });
const mcp = (name: string) => card('mcp', name, {});

// ------------------------------------------------------------------------------------------------ fake agents

interface Reply {
  text: string;
  delay?: number;
  /** permission requests raised first; the reply comes once all are answered */
  asks?: ApprovalView[];
}
let script: (who: string, text: string) => Reply = (who) => ({ text: `${who} ok` });
const decisions: { who: string; title: string; deny: boolean; note?: string }[] = [];

class FakeBackend {
  chats = new Map<string, ChatState>();
  subs = new Map<string, Set<(s: ChatState) => void>>();
  sent: (SendRequest & { who: string })[] = [];
  private waiting = new Map<string, { who: string; left: Set<string>; finish(): void; cards: ApprovalView[] }>();
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
  emit(id: string) {
    const st = this.chats.get(id)!;
    for (const l of this.subs.get(id) ?? []) l({ ...st, messages: [...st.messages], approvals: [...st.approvals] });
  }
  async send(req: SendRequest) {
    const who = /# You are ([\p{L}\p{N}_-]+)/u.exec(req.setup?.instructions ?? '')?.[1] ?? /You are ([\p{L}\p{N}_-]+)/u.exec(req.text)?.[1] ?? '?';
    this.sent.push({ ...req, who });
    const r = script(who, req.text);
    const st = this.getState(req.conversationId);
    st.messages.push(msg('USER', req.text));
    st.isStreaming = true;
    this.emit(req.conversationId);
    const finish = () =>
      setTimeout(() => {
        st.messages.push(msg('ASSISTANT', r.text));
        st.isStreaming = false;
        this.emit(req.conversationId);
      }, r.delay ?? 120);
    if (r.asks?.length) {
      const cards = r.asks.map((a) => ({ ...a, key: `${a.key}-${req.conversationId.slice(0, 6)}` }));
      setTimeout(() => {
        st.approvals = cards;
        this.waiting.set(req.conversationId, { who, left: new Set(cards.map((c) => c.key)), finish, cards });
        this.emit(req.conversationId);
      }, 80);
    } else finish();
  }
  async approval(id: string, key: string, _c: string | undefined, deny: boolean, note?: string) {
    const w = this.waiting.get(id);
    const st = this.getState(id);
    const c = st.approvals.find((a) => a.key === key);
    if (w && c) decisions.push({ who: w.who, title: c.preview ?? c.target ?? c.subtitle ?? '', deny, note });
    st.approvals = st.approvals.filter((a) => a.key !== key);
    this.emit(id);
    if (w) {
      w.left.delete(key);
      if (!w.left.size) {
        this.waiting.delete(id);
        w.finish();
      }
    }
  }
  /** The user answered the card in the chat itself. */
  answerInChat(id: string) {
    const st = this.getState(id);
    const keys = st.approvals.map((a) => a.key);
    for (const key of keys) void this.approval(id, key, 'allow', false);
  }
  async answer() {}
  async stop(id: string) {
    const st = this.getState(id);
    st.isStreaming = false;
    st.approvals = [];
    this.waiting.delete(id);
    this.emit(id);
  }
  async conversationAction() {}
}
let n = 0;
const msg = (role: 'USER' | 'ASSISTANT', content: string): ChatMessage => ({ id: `m${++n}`, conversationId: '', role, content, toolCalls: [], isStreaming: false, attachments: [], createdAt: Date.now() }) as ChatMessage;

// ------------------------------------------------------------------------------------------------ setup

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-access-'));
const project = path.join(tmp, 'project');
fs.mkdirSync(project, { recursive: true });
const backends: Partial<Record<AgentKind, FakeBackend>> = { CLAUDE: new FakeBackend('CLAUDE'), CODEX: new FakeBackend('CODEX'), OPENCODE: new FakeBackend('OPENCODE'), AGY: new FakeBackend('AGY') };
const KINDS: AgentKind[] = ['CLAUDE', 'CODEX', 'OPENCODE', 'AGY'];
const toasts: string[] = [];
let statusLine: string | null = null;
let lastStatus: CrewStatusView | null = null;
const active: HostToView[] = [];
const crew = new CrewEngine({ mcpUrl: (p) => `http://127.0.0.1:1${p}`, mcpHeaders: () => ({}), root: path.join(tmp, 'crew'), groupsDir: path.join(tmp, 'none') });
crew.bind({
  backend: (kk) => backends[kk] as unknown as AgentBackend | undefined,
  enabledKinds: () => KINDS,
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => project,
  showChat: () => undefined,
  postActive: (m) => active.push(m),
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  openFile: () => undefined,
  notify: (t) => toasts.push(t),
  status: (s, t) => {
    lastStatus = s;
    statusLine = t;
  },
  log: () => undefined,
});
const rooms = new RoomEngine(crew.rooms);
crew.onRoomsChanged = () => rooms.refresh();
crew.onPause = (ids) => rooms.pauseBots(ids);
crew.roomReport = (r, b, t) => rooms.reportTurn(r, b, t);
crew.roomNote = (r, t) => rooms.note(r, t);
rooms.bind({
  backend: (kk) => backends[kk] as unknown as AgentBackend | undefined,
  enabledKinds: () => KINDS,
  conversations: () => [],
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => project,
  showChat: () => undefined,
  postActive: () => undefined,
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  log: () => undefined,
  crew: () => crew.roomApi(),
});
let view: InboxItemView[] = [];
void crew.handle('v1', (m) => m.type === 'crewInbox' && (view = m.items), { type: 'inboxWatch', open: true });
const items = () => crew.inbox.items();
const answer = (id: string, choice: string, note: string | null = null) => crew.handle('v1', () => undefined, { type: 'inboxAnswer', id, choice, note });
async function settle(id: string) {
  await sleep(300);
  await until('room quiet', () => !(rooms as any).isBusy(id), 20_000);
}
const mcpBase = crew.crew.mcp();
async function tool(thread: ThreadRecord, name: string, args: Record<string, unknown>) {
  const def = mcpBase.resolve!(new URLSearchParams({ t: thread.id, cap: crew.crew.identity.cap(thread.id) })) as McpServerDef;
  const r = await def.call(name, args, { meta: null });
  return (r.content[0] as any).text as string;
}

async function main() {
  // ---------------------------------------------------------------- the policy
  console.log('levels: what each may do without asking');
  const folders = [project];
  const d = (access: CrewAccess, a: ApprovalView, allowed: (key: string) => boolean = () => false) => decide({ access, approval: a, folders, allowed });
  const v = (access: CrewAccess, a: ApprovalView) => d(access, a).verdict;
  check('talk: tools refused, crew tools fine', v('talk', bash('ls')) === 'deny' && v('talk', mcp('mcp__crew__crew_roster')) === 'allow');
  check('read: reads only', v('read', bash('ls -la')) === 'allow' && v('read', bash('npm test')) === 'deny' && v('read', edit(path.join(project, 'a.ts'))) === 'deny');
  check('edit: ordinary commands and its own files', v('edit', bash('npm test')) === 'allow' && v('edit', edit(path.join(project, 'src/a.ts'))) === 'allow');
  check('edit: a risky command or a file outside its folder asks', v('edit', bash('rm -rf build')) === 'ask' && v('edit', edit('/etc/hosts')) === 'ask');
  check('auto: only risky things ask', v('auto', bash('rm -rf build')) === 'ask' && v('auto', edit('/etc/hosts')) === 'allow' && v('auto', bash('npm test')) === 'allow');
  check('full: anything but outward', v('full', bash('rm -rf build')) === 'allow');
  const outward = [bash('git push origin main'), bash('npm publish'), bash('curl -X POST https://x.io/api'), bash('gh pr create --fill'), mcp('mcp__slack__send_message')];
  check('outward actions ask at EVERY level above read', (['edit', 'auto', 'full'] as CrewAccess[]).every((lvl) => outward.every((a) => v(lvl, a) === 'ask')), outward.map((a) => [a.preview ?? a.subtitle, v('full', a)]));
  const push = d('full', bash('git push origin main'));
  check('"always allow" is remembered as bot + tool + command', push.key === 'Bash(git push)' && push.outward && d('full', bash('git push -f'), (kk) => kk === 'Bash(git push)').verdict === 'allow', push.key);
  const fullClaude = claudeCrew({ id: 't', key: 'k', instructions: '', mcp: [], access: 'full', onlyOwnMcp: false, addDirs: [] }).crew;
  const editClaude = claudeCrew({ id: 't', key: 'k', instructions: '', mcp: [], access: 'edit', onlyOwnMcp: false, addDirs: [] }).crew;
  const ocFull = opencodeRules('full', []);
  check('Auto / Full: engines must ask for outward commands (Claude ask rules, OpenCode shell asks) so the broker decides', !!fullClaude.ask_tools?.includes('Bash(git push:*)') && !editClaude.ask_tools && ocFull.some((r) => r.action === 'shell' && r.effect === 'ask' && r.resource === 'git push *'), fullClaude.ask_tools);
  check('talk-only is enforced by the engines that can (setups)', claudeCrew({ id: 't', key: 'k', instructions: '', mcp: [], access: 'talk', onlyOwnMcp: true, addDirs: [] }).crew.tools?.length === 0 && codexSandbox('talk') === 'read-only' && opencodeRules('talk', [])[0].effect === 'deny');

  // ---------------------------------------------------------------- three bots, one Inbox
  console.log('approvals from three bots land in one Inbox');
  const mk = (f: Record<string, unknown>) => crew.createBot({ chattiness: 0, ...f });
  const ada = mk({ name: 'Ada', agent: 'CLAUDE', access: 'edit' });
  const pip = mk({ name: 'Pip', agent: 'CODEX', access: 'full' });
  const olga = mk({ name: 'Olga', agent: 'OPENCODE', access: 'auto' });
  const tim = mk({ name: 'Tim', agent: 'CLAUDE', access: 'talk' });
  const room = rooms.create({ title: 'Ops', userName: 'Sam' });
  for (const b of [ada, pip, olga, tim]) rooms.addMember(room.id, b.id);
  rooms.update(room.id, { mode: 'everyone', drafting: 'parallel' });
  rooms.hold(room.id, tim.id);
  script = (who) => (['Ada', 'Pip', 'Olga'].includes(who) ? { text: `${who} pushed.`, asks: [bash(`git push origin ${who.toLowerCase()}`)] } : { text: `${who} ok` });
  rooms.post(room.id, 'everyone: push your branch');
  await until('three requests in the Inbox', () => items().filter((i) => i.kind === 'approval').length === 3);
  await sleep(300);
  const three = items().filter((i) => i.kind === 'approval');
  check('three bots, three items, each with its face and why', new Set(three.map((i) => i.bot?.name)).size === 3 && three.every((i) => i.why.startsWith('in #Ops') && /reaches outside/.test(i.why) && i.outward && i.choices.join() === 'allow,allow_session,allow_always,deny'), three.map((i) => [i.bot?.name, i.why]));
  check('the view got them, the status line says so, a toast per item', view.length === 3 && /3 need you/.test(statusLine ?? '') && toasts.filter((t) => /needs you: run the command: git push/.test(t)).length === 3, { statusLine, toasts });
  await sleep(400);
  check('the room waits on you (no reply, no timeout)', !rooms.find(room.id)!.messages.some((m) => /pushed/.test(m.text)));
  const byBot = (nm: string) => three.find((i) => i.bot?.name === nm)!;
  await answer(byBot('Ada').id, 'allow');
  await answer(byBot('Pip').id, 'allow_always');
  await answer(byBot('Olga').id, 'deny', 'not on Fridays');
  await settle(room.id);
  const g = rooms.find(room.id)!;
  check('answered: the allowed ones went on, the denied one was told why', decisions.filter((x) => x.who === 'Ada' && !x.deny).length === 1 && decisions.some((x) => x.who === 'Olga' && x.deny && /not on Fridays/.test(x.note ?? '')) && g.messages.filter((m) => /pushed/.test(m.text)).length === 3, decisions);
  check('the Inbox is empty again', items().length === 0 && view.length === 0);
  check('"always" is saved for that bot only', crew.state().bots.find((b) => b.id === pip.id)!.rules.includes('Bash(git push)') && !crew.state().bots.find((b) => b.id === ada.id)!.rules.length);
  const before = decisions.length;
  rooms.post(room.id, '@Pip push again');
  await settle(room.id);
  check('next time Pip pushes without asking', decisions.length === before + 1 && !decisions.at(-1)!.deny && items().length === 0);
  crew.handle('v1', () => undefined, { type: 'crewAction', action: 'forgetRule', botId: pip.id, data: { key: 'Bash(git push)' } });
  check('forgetting the rule', !crew.state().bots.find((b) => b.id === pip.id)!.rules.length);
  // ordinary work does not ask
  script = (who) => ({ text: `${who} tested.`, asks: [bash('npm test'), edit(path.join(project, 'src', 'x.ts'))] });
  const nDec = decisions.length;
  rooms.post(room.id, '@Ada run the tests and fix x.ts');
  await settle(room.id);
  check('edit level: ordinary commands and its own files go without asking', decisions.length === nDec + 2 && decisions.slice(-2).every((x) => !x.deny) && items().length === 0);
  rooms.release(room.id, tim.id);
  await settle(room.id);
  script = (who) => ({ text: `${who} done`, asks: [edit(path.join(project, 'notes.md'))] });
  rooms.post(room.id, '@Tim write notes.md');
  await settle(room.id);
  check('a talk-only bot cannot edit (refused, no Inbox item)', decisions.at(-1)!.who === 'Tim' && decisions.at(-1)!.deny && /talk-only/.test(decisions.at(-1)!.note ?? '') && items().length === 0);

  // ---------------------------------------------------------------- jobs ask too
  console.log('a job asks: the Inbox says whose job');
  script = (who, text) => {
    if (who === 'Ada' && /handed you job/.test(text)) return { text: 'Deployed.', asks: [bash('kubectl apply -f deploy.yaml')] };
    if (who === 'Lead') return /📋 Reports/.test(text) ? { text: 'Ada deployed.' } : { text: 'Handed out.', delay: 500 };
    return { text: 'ok' };
  };
  const lead = mk({ name: 'Lead', agent: 'CLAUDE', access: 'edit' });
  active.length = 0;
  crew.openDm(lead.id);
  const tag = (active.find((m) => m.type === 'crewDm') as any).tag;
  const dmReq = crew.prepareSend({ conversationId: 'dm-lead', isNew: true, text: 'deploy it', attachments: [], modelId: null, workspaceUri: null }, 'CLAUDE', tag.threadId);
  await backends.CLAUDE!.send(dmReq);
  await sleep(100);
  await tool(crew.crew.store.thread(tag.threadId)!, 'crew_assign', { to: 'Ada', brief: 'Deploy the app to staging.', title: 'deploy' });
  await until('the job asks', () => items().some((i) => i.bot?.name === 'Ada'));
  const jobAsk = items().find((i) => i.bot?.name === 'Ada')!;
  check('"for Lead\'s job: deploy · it reaches outside"', /^for Lead's job: deploy · it reaches outside/.test(jobAsk.why), jobAsk.why);
  await answer(jobAsk.id, 'allow');
  await until('the tree finishes', () => crew.jobs.store.all().some((j) => !j.parentId && j.assignee.botId === lead.id && j.status === 'done'));
  check('allowed: the job finished and the lead got its report', backends.CLAUDE!.sent.some((s) => s.conversationId === 'dm-lead' && /📋 Reports: Ada ✓/.test(s.text)));

  // ---------------------------------------------------------------- DMs
  console.log('DM requests: by level, else the Inbox and the chat card');
  const dmAt = decisions.length;
  script = () => ({ text: 'ran it', asks: [bash('npm run lint')] });
  await backends.CLAUDE!.send(crew.prepareSend({ conversationId: 'dm-lead', isNew: false, text: 'lint please', attachments: [], modelId: null, workspaceUri: null }, 'CLAUDE', null));
  await until('auto-allowed', () => decisions.length === dmAt + 1, 5000);
  check('an ordinary command in a DM goes by its level (no card left, no Inbox)', !decisions.at(-1)!.deny && items().length === 0);
  script = () => ({ text: 'pushed', asks: [bash('git push')], delay: 100 });
  await sleep(2600);
  await backends.CLAUDE!.send(crew.prepareSend({ conversationId: 'dm-lead', isNew: false, text: 'push it', attachments: [], modelId: null, workspaceUri: null }, 'CLAUDE', null));
  await until('the DM request is in the Inbox', () => items().some((i) => i.inChat));
  check('an outward command in a DM: Inbox item marked "in the chat too"', items().find((i) => i.inChat)!.why.startsWith('in its DM'));
  backends.CLAUDE!.answerInChat('dm-lead');
  await until('answered in the chat: gone from the Inbox', () => !items().some((i) => i.inChat), 5000);
  check('answering the chat card clears the Inbox item', true);

  // ---------------------------------------------------------------- job questions / failures in the Inbox
  console.log('job questions and failures are Inbox items');
  script = (who, text) => {
    if (who === 'Pip' && /handed you job/.test(text)) return { text: 'Started.\nNEEDS INPUT: which region?' };
    if (who === 'Pip' && /Answer on job/.test(text)) return { text: 'Deployed to eu-west.' };
    if (who === 'Olga' && /handed you job/.test(text)) return { text: '', delay: 900 };
    if (who === 'Lead') return /📋 Reports|asks \(job/.test(text) ? { text: 'Noted, waiting.' } : { text: 'ok', delay: 500 };
    return { text: 'ok' };
  };
  await sleep(2600);
  await backends.CLAUDE!.send(crew.prepareSend({ conversationId: 'dm-lead', isNew: false, text: 'two more', attachments: [], modelId: null, workspaceUri: null }, 'CLAUDE', null));
  await sleep(100);
  const lt = crew.crew.store.thread(tag.threadId)!;
  await tool(lt, 'crew_assign', { to: 'Pip', brief: 'Deploy to the right region.' });
  await tool(lt, 'crew_assign', { to: 'Olga', brief: 'Check the logs.' });
  await until('a question in the Inbox', () => items().some((i) => i.kind === 'question'));
  const q = items().find((i) => i.kind === 'question')!;
  check('the question shows with an answer box', q.bot?.name === 'Pip' && q.title === 'which region?' && q.choices.join() === 'answer');
  await answer(q.id, 'answer', 'eu-west');
  await until('Pip done', () => crew.jobs.store.get(q.jobId!)!.status === 'done');
  check('answered from the Inbox: the job went on', crew.jobs.store.get(q.jobId!)!.answer === 'eu-west');
  await until('a failure in the Inbox', () => items().some((i) => i.kind === 'failed'), 20_000);
  const f = items().find((i) => i.kind === 'failed')!;
  check('a failed job: Retry / Dismiss', f.bot?.name === 'Olga' && f.choices.join() === 'retry,dismiss');
  await answer(f.id, 'dismiss');
  check('dismissed', !items().some((i) => i.kind === 'failed'));

  // ---------------------------------------------------------------- pause
  console.log('pause: everyone / one bot');
  await crew.handle('v1', () => undefined, { type: 'crewAction', action: 'setPaused', data: { paused: true } });
  rooms.update(room.id, { mode: 'everyone', drafting: 'turns' });
  const mark = rooms.find(room.id)!.messages.length;
  rooms.post(room.id, 'anyone there?');
  await settle(room.id);
  const after = rooms.find(room.id)!.messages.slice(mark);
  check('everyone paused: nobody answers in rooms, a note says why', !after.some((m) => rooms.find(room.id)!.bots.some((b) => b.id === m.from)) && after.some((m) => /paused/.test(m.text)) && statusLine === 'Crew: paused', { after: after.map((m) => m.text), statusLine });
  script = (who) => ({ text: `${who} did it after the pause.` });
  const pj = await tool(crew.crew.store.thread(tag.threadId)!, 'crew_assign', { to: 'Pip', brief: 'Rotate the keys.' }).catch((e) => String(e));
  const pjId = /job (j_[0-9a-f]+)/.exec(pj)?.[1];
  await sleep(1500);
  check('a job handed out while paused waits (queued)', !!pjId && crew.jobs.store.get(pjId)!.status === 'queued', pj);
  await crew.handle('v1', () => undefined, { type: 'crewAction', action: 'setPaused', data: { paused: false } });
  await until('it runs after the resume', () => crew.jobs.store.get(pjId!)!.status === 'done', 10_000);
  check('resumed: the job went on', /after the pause/.test(crew.jobs.store.get(pjId!)!.result ?? ''));
  // one bot paused mid-turn: the job goes back to the queue and on after the resume
  script = (who) => (who === 'Pip' ? { text: 'long task done', delay: 2500 } : { text: 'ok' });
  const lj = /job (j_[0-9a-f]+)/.exec(await tool(crew.crew.store.thread(tag.threadId)!, 'crew_assign', { to: 'Pip', brief: 'A long task.' }))![1];
  await until('running', () => crew.jobs.store.get(lj)!.status === 'running');
  crew.updateBot(pip.id, { paused: true });
  await until('back in the queue', () => crew.jobs.store.get(lj)!.status === 'queued', 5000);
  check('pausing a bot stops its running job and queues it', crew.jobs.store.get(lj)!.status === 'queued');
  crew.updateBot(pip.id, { paused: false });
  await until('done after the resume', () => crew.jobs.store.get(lj)!.status === 'done', 15_000);
  const pipSends = backends.CODEX!.sent.filter((s) => s.who === 'Pip' && /A long task/.test(s.text));
  check('it went on, told it was paused mid-way', pipSends.length === 2 && /You were paused/.test(pipSends[1].text));

  // ---------------------------------------------------------------- Antigravity's crew server
  console.log('Antigravity: the crew server is added only after you say yes');
  const gus = mk({ name: 'Gus', agent: 'AGY', access: 'talk' });
  const gt: ThreadRecord = { id: 't_gus', botId: gus.id, engine: 'AGY', chatId: 'agy-1', kind: 'dm', roomId: null, jobId: null, seen: 0, setupKey: null, createdAt: 1, updatedAt: 1 };
  crew.crew.store.putThread(gt);
  let setup = crew.crew.setupFor(gt);
  check('not asked yet: no crew server, no cap; it is told it has no crew tools', setup.sharedMcp === null && !setup.instructions.includes('cap=') && /no crew tools yet/.test(setup.instructions));
  await until('the Inbox asks', () => items().some((i) => i.kind === 'setup'));
  crew.crew.setupFor(gt);
  check('asked once (one setup item)', items().filter((i) => i.kind === 'setup').length === 1 && items().find((i) => i.kind === 'setup')!.choices.join() === 'add,later');
  await answer(items().find((i) => i.kind === 'setup')!.id, 'add');
  setup = crew.crew.setupFor(gt);
  check('yes: the setup carries the crew server and the cap (the backend adds it)', !!setup.sharedMcp && setup.instructions.includes('cap="') && crew.state().agyCrewServer === 'allowed');
  await crew.handle('v1', () => undefined, { type: 'crewAction', action: 'allowAgyServer', data: { allow: false } });
  check('"not now" turns it off again', crew.crew.setupFor(gt).sharedMcp === null && crew.state().agyCrewServer === 'declined' && !items().some((i) => i.kind === 'setup'));

  console.log('status');
  check('the status counts bots at work and things that need you', !!lastStatus && typeof (lastStatus as CrewStatusView).working === 'number');

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
