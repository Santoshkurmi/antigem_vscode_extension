// Offline test of Crew Phase 6 (docs/crew/PLAN.md §13, src/core/crew/automations): reading "when" sentences, next
// runs, crew_automation from a chat ("when tests fail, Tess investigates"), editor events in batches, schedules and
// catch-up, NOTHING NEW, Needs input → the Inbox, results posted in a room or as a notice, overlap skips, one retry,
// three failures → "Needs you", pause, Undo, webhooks (token, filter), waits (no AI until true), check-backs and
// crew_later. Fake agents; a crew in a temp folder.
//   npx esbuild dev/test-automations.ts --bundle --platform=node --outfile=<tmp>/t.js && node <tmp>/t.js
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, ChatMessage } from '../shared/model';
import type { HostToView } from '../shared/protocol';
import { AUTO_TIMING } from '../src/core/crew/automations/runner';
import { describeWhen, globTest, nextRun, parseWhen, readMoment } from '../src/core/crew/automations/when';
import { CrewEngine } from '../src/core/crew/engine';
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
async function until(what: string, f: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

AUTO_TIMING.tickMs = 300;
AUTO_TIMING.batchMs = 400;
AUTO_TIMING.retryMs = 300;

let script: (who: string, text: string) => { text: string; delay?: number } = (who) => ({ text: `${who} ok` });
class FakeBackend {
  chats = new Map<string, ChatState>();
  subs = new Map<string, Set<(s: ChatState) => void>>();
  sent: (SendRequest & { who: string })[] = [];
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
    const who = /# You are ([\p{L}\p{N}_-]+)/u.exec(req.setup?.instructions ?? '')?.[1] ?? '?';
    this.sent.push({ ...req, who });
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-auto-'));
const port = 20000 + Math.floor(Math.random() * 20000);
fs.mkdirSync(path.join(tmp, 'crew'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'crew', 'crew.json'), JSON.stringify({ schema: 2, webhookPort: port }));
const backends: Partial<Record<AgentKind, FakeBackend>> = { CLAUDE: new FakeBackend('CLAUDE'), CODEX: new FakeBackend('CODEX') };
const toasts: string[] = [];
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
  notify: (t) => toasts.push(t),
  log: () => undefined,
});
const rooms = new RoomEngine(crew.rooms);
crew.onRoomsChanged = () => rooms.refresh();
crew.roomReport = (r, b, t) => rooms.reportTurn(r, b, t);
crew.roomPost = (r, b, t, l) => rooms.postAs(r, b, t, l);
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
const auto = crew.automations;
const mcpBase = crew.crew.mcp();
async function tool(thread: ThreadRecord, name: string, args: Record<string, unknown>) {
  crew.crew.identity.beginTurn(thread.id);
  const def = mcpBase.resolve!(new URLSearchParams({ t: thread.id, cap: crew.crew.identity.cap(thread.id) })) as McpServerDef;
  const r = await def.call(name, args, { meta: null });
  return { text: (r.content[0] as any).text as string, error: !!r.isError };
}
function thread(botId: string, kind: ThreadRecord['kind'], roomId: string | null = null): ThreadRecord {
  const t: ThreadRecord = { id: `t_${++n}`, botId, engine: crew.crew.store.bot(botId)!.engine, chatId: `c_${n}`, kind, roomId, jobId: null, seen: 0, setupKey: null, createdAt: 1, updatedAt: 1 };
  crew.crew.store.putThread(t);
  return t;
}
const byName = (nm: string) => auto.store.all().find((a) => a.name === nm)!;

async function main() {
  console.log('"when" sentences');
  const p = (s: string) => parseWhen(s).when;
  const d = (s: string) => {
    const w = p(s);
    return w ? describeWhen(w) : 'null';
  };
  check('every weekday at 9', d('every weekday at 9:00') === 'Every weekday at 09:00');
  check('daily / weekends / named days', d('daily at 18:30') === 'Every day at 18:30' && d('weekends at 10am') === 'On weekends at 10:00' && d('mon, wed and fri at 8:30') === 'On Mon, Wed, Fri at 08:30', [d('daily at 18:30'), d('weekends at 10am'), d('mon, wed and fri at 8:30')]);
  check('every N minutes with a window', d('every 30 min between 9:00 and 17:00') === 'Every 30 min between 09:00 and 17:00' && d('every 2 hours') === 'Every 2 h');
  check('cron', d('cron 0 9 * * 1-5') === 'On cron "0 9 * * 1-5"' && parseWhen('cron 61 * * * *').error !== null);
  check('once / in 2h / tomorrow 9', p('in 2h')?.kind === 'schedule' && Math.abs((readMoment('in 2h') ?? 0) - Date.now() - 7_200_000) < 1000 && new Date(readMoment('tomorrow 9:00')!).getHours() === 9);
  const tf = p('when tests fail');
  const sv = p('on save of src/**/*.ts');
  check('editor events with a glob', tf?.kind === 'event' && tf.event === 'test_failed' && sv?.kind === 'event' && sv.event === 'file_saved' && sv.filter === 'src/**/*.ts', [tf, sv]);
  check('webhook, and an unreadable sentence says what works', p('webhook')?.kind === 'webhook' && /every weekday at 9:00/.test(parseWhen('whenever, really').error ?? ''));
  check('globs', globTest('src/**/*.ts')('/p/src/a/b.ts') && !globTest('src/**/*.ts')('/p/lib/b.ts') && globTest('docs/**')('/p/docs/x/y.md') && globTest('*.md')('/p/README.md'));
  const mon9 = new Date(2026, 10, 23, 9, 0).getTime(); // Monday
  check('next run: weekdays skip the weekend', new Date(nextRun({ type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }, new Date(2026, 10, 21, 10, 0).getTime())!).getDate() === 23 && nextRun({ type: 'daily', time: '09:00', days: [1] }, mon9 - 1) === mon9);
  check('next run: cron and every-N with a window', new Date(nextRun({ type: 'cron', expr: '30 9 * * 1-5' }, new Date(2026, 10, 22, 12, 0).getTime())!).getTime() === new Date(2026, 10, 23, 9, 30).getTime() && new Date(nextRun({ type: 'every', minutes: 60, from: '09:00', to: '17:00' }, new Date(2026, 10, 23, 18, 0).getTime(), new Date(2026, 10, 23, 0, 0).getTime())!).getHours() === 9);

  console.log('"When tests fail, Tess investigates" from a chat');
  const tess = crew.createBot({ name: 'Tess', agent: 'CODEX', access: 'edit' });
  const ada = crew.createBot({ name: 'Ada', agent: 'CLAUDE', access: 'edit' });
  const dm = thread(tess.id, 'dm');
  const made = await tool(dm, 'crew_automation', { action: 'create', when: 'when tests fail', instructions: 'Find out why the tests failed: read the failing output, find the cause, and say how to fix it.', name: 'Investigate failing tests' });
  check('crew_automation makes it and says the sentence', !made.error && /Made \(a_[0-9a-f]+\): When tests fail, Tess: Find out why/.test(made.text), made.text);
  const bad = await tool(dm, 'crew_automation', { action: 'create', when: 'sometimes', instructions: 'Do something useful please.' });
  check('a bad "when" gets a corrective error', bad.error && /every weekday at 9:00/.test(bad.text));
  script = (who, text) => (who === 'Tess' && /Automation: Investigate failing tests/.test(text) ? { text: 'The date test fails because of the time zone; set TZ=UTC in CI.' } : { text: 'ok' });
  auto.editorEvent('test_failed', 'npm test');
  auto.editorEvent('test_failed', 'npm run test:unit');
  auto.editorEvent('file_saved', '/p/a.ts');
  await until('it ran', () => byName('Investigate failing tests').lastStatus === 'ok');
  const runs = backends.CODEX!.sent.filter((s) => s.who === 'Tess' && /Automation: Investigate/.test(s.text));
  check('two failures in a row = one run with both (batched)', runs.length === 1 && runs[0].text.includes('npm test, npm run test:unit') && /does not see the chat|you do not see the chat/.test(runs[0].text), runs.map((r) => r.text.slice(0, 300)));
  check('made in its DM: the result comes as a notice', toasts.some((t) => /Investigate failing tests: The date test fails/.test(t)), toasts);
  check('it runs in its own hidden thread', crew.crew.store.threads().some((t) => t.kind === 'automation' && t.jobId === byName('Investigate failing tests').id));

  console.log('a room automation: results posted there; NOTHING NEW; needs input');
  const room = rooms.create({ title: 'Ops', userName: 'Sam' });
  rooms.addMember(room.id, ada.id);
  const rt = thread(ada.id, 'room', room.id);
  await tool(rt, 'crew_automation', { action: 'create', when: 'every weekday at 9:00', instructions: 'Summarize yesterday\'s commits in three lines.', name: 'Morning summary' });
  const ms = byName('Morning summary');
  check('made in a room: it posts there; next run set', ms.postTo.kind === 'room' && ms.nextRunAt! > Date.now() && new Date(ms.nextRunAt!).getHours() === 9);
  script = () => ({ text: '3 commits: parser, tests, docs.' });
  auto.runNow(ms.id);
  await until('posted', () => rooms.find(room.id)!.messages.some((m) => /3 commits/.test(m.text)));
  const line = rooms.find(room.id)!.messages.find((m) => /3 commits/.test(m.text))!;
  check('the room gets it from Ada, named after the automation', line.from === ada.id && line.picked?.by === 'automation' && line.picked.why === 'Morning summary');
  script = () => ({ text: 'NOTHING NEW' });
  const before = rooms.find(room.id)!.messages.length;
  auto.runNow(ms.id);
  await until('ran', () => byName('Morning summary').lastStatus === 'nothing');
  check('NOTHING NEW posts nothing', rooms.find(room.id)!.messages.length === before);
  script = (_w, text) => (/The user answered: main/.test(text) ? { text: 'On main: 2 commits.' } : { text: 'Needs input: which branch should I summarize?' });
  auto.runNow(ms.id);
  await until('it asks', () => crew.inbox.items().some((i) => i.kind === 'question' && /which branch/.test(i.title)));
  const q = crew.inbox.items().find((i) => i.kind === 'question')!;
  check('Needs input → an Inbox question', q.why === 'automation "Morning summary"' && q.choices.join() === 'answer,dismiss');
  await crew.handle('v', () => undefined, { type: 'inboxAnswer', id: q.id, choice: 'answer', note: 'main' });
  await until('answered and posted', () => rooms.find(room.id)!.messages.some((m) => /On main: 2 commits/.test(m.text)));
  check('your answer finishes the run', true);

  console.log('overlap, retry, failures, pause, cap');
  script = () => ({ text: 'slow result', delay: 1500 });
  auto.runNow(ms.id);
  await sleep(100);
  auto.runNow(ms.id);
  await until('done', () => byName('Morning summary').lastResult === 'slow result', 10_000);
  check('a run while one is going is skipped and counted', byName('Morning summary').skipped === 1);
  let tries = 0;
  script = () => (++tries === 1 ? { text: '' } : { text: 'second try worked' });
  auto.runNow(ms.id);
  await until('retried', () => byName('Morning summary').lastResult === 'second try worked', 10_000);
  check('a blip is retried once', tries === 2 && byName('Morning summary').failuresInRow === 0);
  script = () => ({ text: '' });
  for (let i = 0; i < 3; i++) {
    auto.runNow(ms.id);
    await until(`failure ${i + 1} counted (after its retry)`, () => byName('Morning summary').failuresInRow === i + 1 && !(auto as any).running.has(ms.id), 10_000);
  }
  await until('needs fix', () => !!byName('Morning summary').needsFix, 10_000);
  check('three failures in a row: "Needs you", not turned off', !byName('Morning summary').paused && /failed 3 times/.test(byName('Morning summary').needsFix ?? '') && toasts.some((t) => /needs you: it failed 3 times/.test(t)), byName('Morning summary'));
  const inv = byName('Investigate failing tests');
  await crew.handle('v', () => undefined, { type: 'automationAction', action: 'pause', id: inv.id });
  const sentBefore = backends.CODEX!.sent.length;
  auto.editorEvent('test_failed', 'again');
  await sleep(900);
  check('paused: events do nothing', backends.CODEX!.sent.length === sentBefore);
  await crew.handle('v', () => undefined, { type: 'automationAction', action: 'resume', id: inv.id });
  const cur = byName('Investigate failing tests');
  auto.store.touch({ ...cur, runsToday: { day: new Date().toISOString().slice(0, 10), count: 24 } });
  auto.editorEvent('test_failed', 'once more');
  await until('skipped', () => byName('Investigate failing tests').lastStatus === 'skipped');
  check('at most 24 AI runs a day for event automations', /24 runs today/.test(byName('Investigate failing tests').lastResult ?? ''));

  console.log('Undo');
  await crew.handle('v', () => undefined, { type: 'automationAction', action: 'delete', id: inv.id });
  check('deleted', !auto.store.get(inv.id));
  await crew.handle('v', () => undefined, { type: 'automationAction', action: 'undo', id: inv.id });
  check('Undo brings it back', !!auto.store.get(inv.id));

  console.log('webhooks');
  const mk = await tool(thread(ada.id, 'room', room.id), 'crew_automation', { action: 'create', when: 'webhook deploy', instructions: 'Say which version was deployed, from the payload.', name: 'Deploy hook' });
  check('a webhook automation', !mk.error, mk.text);
  const wh = byName('Deploy hook');
  const view = crew.automationsState().find((a) => a.id === wh.id)!;
  check('the page shows its address and token', !!view.webhook && view.webhook.url === `http://127.0.0.1:${port}/hooks/${wh.id}`);
  await sleep(200);
  const post = (token: string, body: string) => fetch(view.webhook!.url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body }).then((r) => r.status);
  check('a wrong token: 401', (await post('nope', '{"event":"deploy"}')) === 401);
  check('not matching its filter: accepted, nothing runs', (await post(view.webhook!.token, '{"event":"push"}')) === 202);
  script = () => ({ text: 'Deployed v1.2.3.' });
  check('the right token: 202', (await post(view.webhook!.token, '{"event":"deploy","version":"1.2.3"}')) === 202);
  await until('posted', () => rooms.find(room.id)!.messages.some((m) => /Deployed v1.2.3/.test(m.text)));
  check('the payload reaches the run', backends.CLAUDE!.sent.some((s) => /webhook: \{"event":"deploy","version":"1.2.3"\}/.test(s.text)));

  console.log('waits and check-backs (crew_later)');
  const flag = path.join(tmp, 'build.done');
  const w = await tool(dm, 'crew_later', { action: 'wait', kind: 'file_exists', target: flag, follow_up: 'The build finished: report the build size.', hours: 2 });
  check('crew_later wait', /Waiting \(a_/.test(w.text) && /without AI/.test(w.text), w.text);
  const waitSends = () => backends.CODEX!.sent.filter((s) => /The build finished/.test(s.text)).length;
  await sleep(900);
  check('no AI runs while it waits', waitSends() === 0);
  script = () => ({ text: 'Build is 2.1 MB.' });
  fs.writeFileSync(flag, 'x');
  await until('it ran once', () => waitSends() === 1);
  await until('the wait is done', () => !!auto.store.all().find((a) => a.when.kind === 'wait')?.done);
  await sleep(900);
  check('then it is done (runs once)', waitSends() === 1);
  const cb = await tool(dm, 'crew_later', { action: 'check_back', when: 'in 2h', note: 'see if CI is green' });
  check('crew_later check_back', /I will bring you back here/.test(cb.text), cb.text);
  const c = auto.store.all().find((a) => a.when.kind === 'checkback')!;
  auto.store.touch({ ...c, nextRunAt: Date.now() + 200, when: { kind: 'checkback', at: Date.now() + 200 } });
  script = () => ({ text: 'CI is green.' });
  await until('came back', () => backends.CODEX!.sent.some((s) => s.conversationId === dm.chatId && /The check-back you set: see if CI is green/.test(s.text)));
  check('a check-back is a turn in the chat it was set in', true);
  const list = await tool(dm, 'crew_later', { action: 'list' });
  check('nothing pending after it ran', /Nothing pending/.test(list.text), list.text);

  console.log('a missed schedule catches up once');
  const ms2 = byName('Morning summary');
  auto.store.touch({ ...ms2, needsFix: null, nextRunAt: Date.now() - 3600_000 });
  const sends = backends.CLAUDE!.sent.length;
  script = () => ({ text: 'caught up' });
  (auto as any).catchUp();
  await until('caught up', () => byName('Morning summary').lastResult === 'caught up');
  check('once, and the next run is in the future', backends.CLAUDE!.sent.length === sends + 1 && byName('Morning summary').nextRunAt! > Date.now());

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
