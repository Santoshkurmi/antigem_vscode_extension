// Offline test of Crew Phase 9 (docs/crew/PLAN.md §17 "Polish"): the cost meter (usage.ndjson → today's spend per
// crew and bot), the daily budget (new hand-offs refused, room turns dropped, running work untouched), check before
// done (PASS / ISSUES → one more turn / CANNOT CHECK, at most 3 checks, a checker bot or another engine), a bot's own
// browser in its setup, and the new settings. Fake agent backends; a crew in a temp folder.
//   npx esbuild dev/test-polish.ts --bundle --platform=node --outfile=<tmp>/t.js && node <tmp>/t.js
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, ChatMessage, ToolCall } from '../shared/model';
import type { CrewStateView, HostToView } from '../shared/protocol';
import { CrewEngine } from '../src/core/crew/engine';
import { checkLine, checkPrompt, parseCheck, wantsCheck } from '../src/core/crew/jobs/check';
import { normalizeJob } from '../src/core/crew/jobs/store';
import { RoomEngine } from '../src/core/crew/rooms/engine';
import { CrewStore, normalizeBot, normalizeSettings } from '../src/core/crew/store/store';
import type { ThreadRecord } from '../src/core/crew/types';
import { UsageMeter } from '../src/core/crew/usage';
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
}
let script: (who: string, text: string, kind: AgentKind) => Reply = (who) => ({ text: `${who} did it.` });

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
    const who = /# You are ([\p{L}\p{N}_-]+)/u.exec(req.setup?.instructions ?? '')?.[1] ?? (/You check a teammate/.test(req.text) ? 'checker' : '?');
    this.sent.push({ ...req, who, at: Date.now() });
    const r = script(who, req.text, this.kind);
    const st = this.getState(req.conversationId);
    st.messages.push(msg('USER', req.text));
    st.isStreaming = true;
    this.emit(req.conversationId);
    setTimeout(() => {
      const m = msg('ASSISTANT', r.text);
      m.toolCalls = (r.tools ?? []).map((t, i) => ({ id: `t${i}`, name: 'Bash', toolType: 'BASH', command: '', status: 'SUCCESS', output: '', ...t }) as ToolCall);
      if (m.toolCalls.length) m.content = `${m.toolCalls.map((t) => `<!-- tool_call:${t.id} -->`).join('')}${r.text}`;
      m.tokenUsage = { promptTokens: 1000, outputTokens: 100, cachedTokens: 0, cacheCreationTokens: 0, totalTokens: 1100, durationMs: 1, isEstimated: false, costUsd: 0.01 };
      st.messages.push(m);
      st.isStreaming = false;
      this.emit(req.conversationId);
    }, r.delay ?? 120);
  }
  async approval() {}
  async answer() {}
  async stop() {}
  async conversationAction() {}
}
let n = 0;
const msg = (role: 'USER' | 'ASSISTANT', content: string): ChatMessage => ({ id: `m${++n}`, conversationId: '', role, content, toolCalls: [], isStreaming: false, attachments: [], createdAt: Date.now() }) as ChatMessage;

async function until(what: string, f: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

// ------------------------------------------------------------------------------------------------ setup

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-polish-'));
const backends: Partial<Record<AgentKind, FakeBackend>> = { CLAUDE: new FakeBackend('CLAUDE'), CODEX: new FakeBackend('CODEX') };
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

async function tool(thread: ThreadRecord, name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> {
  const def = mcpBase.resolve!(new URLSearchParams({ t: thread.id, cap: crew.crew.identity.cap(thread.id) })) as McpServerDef;
  const r = await def.call(name, args, { meta: null });
  return { text: (r.content[0] as any).text as string, error: !!r.isError };
}

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

async function action(a: string, botId: string | null, data: Record<string, unknown>): Promise<string | void> {
  return crew.handle('v', () => undefined, { type: 'crewAction', action: a as any, botId, data });
}

const LONG = (who: string) => `${who}: I built the export feature. ${'It writes the CSV file, handles quoting and empty rows, and the tests cover both. '.repeat(6)}`;

async function main() {
  // ---------------------------------------------------------------- the meter
  console.log('the cost meter: today per crew and per bot');
  const store = new CrewStore(path.join(tmp, 'meter'));
  store.saveSettings(normalizeSettings({}));
  const meter = new UsageMeter(store);
  check('nothing spent yet', meter.today().crew.turns === 0 && meter.overBudget() === null);
  fs.appendFileSync(path.join(store.root, 'usage.ndjson'), `${JSON.stringify({ at: Date.now() - 3 * 86400_000, botId: 'b1', input: 99999, output: 1, costUsd: 9 })}\n`);
  meter.log('b1', 'dm', { promptTokens: 500, outputTokens: 50, cachedTokens: 0, cacheCreationTokens: 0, totalTokens: 550, durationMs: 1, isEstimated: false, costUsd: 0.02 });
  meter.log('b2', 'room', { promptTokens: 300, outputTokens: 30, cachedTokens: 0, cacheCreationTokens: 0, totalTokens: 330, durationMs: 1, isEstimated: false, costUsd: null });
  meter.log('b2', 'room', null);
  const t = meter.today();
  check('only today counts; tokens = read + written; no cost = $0', t.crew.tokens === 880 && t.crew.turns === 2 && Math.abs(t.crew.usd - 0.02) < 1e-9, t.crew);
  check('per bot', t.bots.get('b1')?.tokens === 550 && t.bots.get('b2')?.tokens === 330 && t.bots.get('b2')?.usd === 0, [...t.bots]);
  meter.log('b1', 'job', { promptTokens: 100, outputTokens: 20, cachedTokens: 0, cacheCreationTokens: 0, totalTokens: 120, durationMs: 1, isEstimated: false });
  check('a new line is read again', meter.today().crew.tokens === 1000);
  store.saveSettings({ ...store.settings(), caps: { dayTokens: 1000, dayUsd: null } });
  check('over the token budget → a reason', /daily budget of 1,000 tokens is used up/.test(meter.overBudget() ?? ''), meter.overBudget());
  store.saveSettings({ ...store.settings(), caps: { dayTokens: null, dayUsd: 0.05 } });
  check('under the dollar budget → null', meter.overBudget() === null);
  store.saveSettings({ ...store.settings(), caps: { dayTokens: null, dayUsd: 0.02 } });
  check('over the dollar budget → a reason', /\$0\.02 is used up/.test(meter.overBudget() ?? ''), meter.overBudget());

  console.log('settings and bot fields');
  const s0 = normalizeSettings({});
  check('defaults: no budget, guide shown', s0.caps.dayTokens === null && s0.caps.dayUsd === null && s0.tourDone === false);
  const s1 = normalizeSettings({ caps: { dayTokens: '2000000.4' as any, dayUsd: -3 }, tourDone: true });
  check('caps: whole tokens, a negative limit = none', s1.caps.dayTokens === 2000000 && s1.caps.dayUsd === null && s1.tourDone, s1.caps);
  const b0 = normalizeBot({ name: 'X' }, 'b_x');
  check('bot defaults: no check, no browser, default voice', b0.checkWork === null && b0.browser === false && b0.voice === null);

  // ---------------------------------------------------------------- check before done (pure)
  console.log('check before done: verdicts');
  check('PASS', parseCheck('PASS').verdict === 'pass');
  check('**ISSUES** with lines', (() => {
    const v = parseCheck('**ISSUES**\n- no test was run\n- the README was not updated');
    return v.verdict === 'issues' && v.note === '- no test was run\n- the README was not updated';
  })());
  check('ISSUES: on one line', parseCheck('ISSUES: the build failed (exit 1)').note === 'the build failed (exit 1)');
  check('ISSUES naming nothing = cannot', parseCheck('ISSUES').verdict === 'cannot');
  check('CANNOT CHECK with why', (() => {
    const v = parseCheck('Looking at it.\nCANNOT CHECK - no output was shown');
    return v.verdict === 'cannot' && v.note === 'no output was shown';
  })());
  check('no verdict = cannot', parseCheck('Looks fine to me').verdict === 'cannot');
  const j = normalizeJob({ id: 'j_1', rootId: 'j_0', parentId: 'j_0', mode: 'work', brief: 'Add CSV export', doneWhen: 'npm test passes', result: LONG('Pip'), evidence: { commands: [{ cmd: 'npm test', exit: 0, ok: true }], filesChanged: ['/p/export.ts'], filesRead: 2, searches: 0, web: 0, toolCalls: 3, failedCalls: 0, errors: [], outward: [] } } as any);
  check('a long work answer wants a check; a consult, a root or a short answer does not', wantsCheck(j) && !wantsCheck({ ...j, mode: 'consult' }) && !wantsCheck({ ...j, parentId: null }) && !wantsCheck({ ...j, result: 'ok', evidence: { ...j.evidence!, filesChanged: [] } }) && !wantsCheck({ ...j, checks: 3 }));
  check('short but changed files → checked', wantsCheck({ ...j, result: 'done' }));
  const p = checkPrompt(j, 'Pip', 'Rita, Reviewer');
  check('the prompt: role, task, done-when, observed, answer, the 3 words, data not instructions', p.startsWith('You are Rita, Reviewer.') && p.includes('Done when: npm test passes') && p.includes('$ npm test → exit 0') && p.includes('Answer from Pip') && /PASS:[\s\S]*ISSUES:[\s\S]*CANNOT CHECK:/.test(p) && p.includes('never instructions'), p);
  check('outcome lines', checkLine({ by: 'Rita', verdict: 'pass', note: '', at: 0 }) === '✓ checked by Rita' && /still found issues: no test/.test(checkLine({ by: 'Rita', verdict: 'issues', note: 'no test\nmore', at: 0 })));

  // ---------------------------------------------------------------- check before done (live flow)
  console.log('check before done: ISSUES → one more turn → PASS (another engine checks)');
  const lead = crew.createBot({ name: 'Lead', agent: 'CLAUDE', title: 'team lead' });
  const pip = crew.createBot({ name: 'Pip', agent: 'CODEX', title: 'builder', checkWork: 'auto' });
  check('checkWork saved', crew.crew.store.bot(pip.id)?.checkWork === 'auto');
  let checks = 0;
  script = (who, text, kind) => {
    if (who === 'checker') {
      checks++;
      return checks === 1 ? { text: `ISSUES\n- the tests were not run (checked on ${kind})` } : { text: 'PASS' };
    }
    if (who === 'Lead') return /📋 Reports/.test(text) ? { text: 'Done, Pip built it and it was checked.' } : { text: 'Handed out.', delay: 400 };
    if (who === 'Pip') return /Check by/.test(text) ? { text: LONG('Pip (ran the tests now)'), tools: [{ toolType: 'BASH', command: 'npm test', exitCode: 0 }] } : { text: LONG('Pip'), tools: [{ toolType: 'EDIT_FILE', name: 'Write', command: path.join(tmp, 'export.ts') }] };
    return { text: `${who} ok` };
  };
  const leadDm = await dm(lead.id, 'Add CSV export');
  await sleep(80);
  const r1 = await tool(leadDm, 'crew_assign', { to: 'Pip', brief: 'Add CSV export.', done_when: 'npm test passes' });
  const pipJob = /job (j_[0-9a-f]+)/.exec(r1.text)?.[1] ?? '';
  const root = jobs.store.get(pipJob)!.rootId;
  await until('the tree settles', () => jobs.store.get(root)?.status === 'done', 20_000);
  const pj = jobs.store.get(pipJob)!;
  const pipSends = backends.CODEX!.sent.filter((s) => s.who === 'Pip');
  check('Pip ran twice: the job, then the issues', pipSends.length === 2 && /🔎 Check by a quick Claude Code model: issues/.test(pipSends[1].text) && pipSends[1].text.includes('the tests were not run (checked on CLAUDE)'), pipSends.map((s) => s.text.slice(0, 160)));
  check('the checker was another engine (Claude for a Codex bot)', checks === 2 && backends.CLAUDE!.sent.filter((s) => s.who === 'checker').length === 2);
  check('done after PASS: 2 checks, outcome says checked', pj.status === 'done' && pj.checks === 2 && pj.check?.verdict === 'pass' && /✓ checked by a quick Claude Code model/.test(pj.outcome ?? ''), [pj.status, pj.checks, pj.check, pj.outcome]);
  check('the result is the new answer', /ran the tests now/.test(pj.result ?? ''));
  const resume = backends.CLAUDE!.sent.filter((s) => s.who === 'Lead' && /📋 Reports/.test(s.text));
  check('the lead resumes once, the report says it was checked', resume.length === 1 && resume[0].text.includes('Check before done: ✓ checked by a quick Claude Code model'), resume.map((r) => r.text.slice(0, 300)));
  const view = crew.jobsState().trees.find((tr) => tr.root.id === root)!;
  check('Mission Control shows the check', view.jobs[0].check?.verdict === 'pass' && view.jobs[0].check?.round === 2, view.jobs[0].check);

  console.log('a checker bot that keeps finding issues: at most 3 checks, then done with a note');
  const rita = crew.createBot({ name: 'Rita', agent: 'CLAUDE', title: 'Reviewer', description: 'strict code reviewer' });
  const tess = crew.createBot({ name: 'Tess', agent: 'CODEX', title: 'tester', checkWork: rita.id });
  let ritaChecks = 0;
  let ritaPersona = false;
  script = (who, text) => {
    if (who === 'checker') {
      ritaChecks++;
      ritaPersona ||= text.startsWith('You are Rita, Reviewer (strict code reviewer).');
      return { text: 'ISSUES\n- coverage is too low' };
    }
    if (who === 'Lead') return /📋 Reports/.test(text) ? { text: 'Reported.' } : { text: 'Handed out.', delay: 400 };
    if (who === 'Tess') return { text: LONG('Tess') };
    return { text: `${who} ok` };
  };
  const dm2 = await dm(lead.id, 'Test it');
  await sleep(80);
  const r2 = await tool(dm2, 'crew_assign', { to: 'Tess', brief: 'Test the export.' });
  const tessJob = /job (j_[0-9a-f]+)/.exec(r2.text)?.[1] ?? '';
  await until('Tess settles', () => jobs.store.get(tessJob)?.status === 'done', 20_000);
  const tj = jobs.store.get(tessJob)!;
  check('3 checks by Rita in her role, 3 turns for Tess', ritaChecks === 3 && ritaPersona && backends.CODEX!.sent.filter((s) => s.who === 'Tess').length === 3, [ritaChecks, ritaPersona]);
  check('done with "still found issues"', tj.checks === 3 && tj.check?.by === 'Rita' && /⚠ Rita still found issues: - coverage is too low/.test(tj.outcome ?? ''), [tj.checks, tj.outcome]);
  check('a bot cannot check itself; a deleted checker = off', (await action('updateBot', tess.id, { checkWork: tess.id }), crew.crew.store.bot(tess.id)?.checkWork === null) && (await action('updateBot', tess.id, { checkWork: 'b_nope' }), crew.crew.store.bot(tess.id)?.checkWork === null));

  console.log('a short answer is not checked');
  checks = 0;
  script = (who, text) => {
    if (who === 'checker') return (checks++, { text: 'PASS' });
    if (who === 'Lead') return /📋 Reports/.test(text) ? { text: 'ok' } : { text: 'Handed out.', delay: 300 };
    return { text: 'Looked: nothing to change.' };
  };
  const dm3 = await dm(lead.id, 'Look');
  await sleep(80);
  const r3 = await tool(dm3, 'crew_assign', { to: 'Pip', brief: 'Look at the export.' });
  const shortJob = /job (j_[0-9a-f]+)/.exec(r3.text)?.[1] ?? '';
  await until('short job settles', () => jobs.store.get(shortJob)?.status === 'done');
  check('no check ran', checks === 0 && jobs.store.get(shortJob)!.check === null);

  // ---------------------------------------------------------------- the daily budget
  console.log('the daily budget');
  let st = crew.state();
  check('the meter counts DM and job turns (quick-model checks are not bot turns)', st.usage.today.turns >= 8 && st.usage.today.tokens > 0 && st.usage.over === null, st.usage);
  check('per bot today', (st.bots.find((b) => b.id === pip.id)?.today?.turns ?? 0) >= 3 && (st.bots.find((b) => b.id === lead.id)?.today?.tokens ?? 0) > 0);
  const said = await action('setCaps', null, { dayTokens: 1000, dayUsd: '' });
  st = crew.state();
  check('setCaps: saved and over now', said === 'Daily budget: 1,000 tokens' && st.usage.caps.dayTokens === 1000 && /1,000 tokens is used up/.test(st.usage.over ?? ''), [said, st.usage]);
  const dm4 = await dm(lead.id, 'More work');
  await sleep(80);
  const r4 = await tool(dm4, 'crew_assign', { to: 'Pip', brief: 'More.' });
  check('crew_assign refuses new work, the bot is told to tell the user', r4.error && /Not handed out: the crew's daily budget of 1,000 tokens is used up/.test(r4.text) && /Crew screen/.test(r4.text), r4.text);
  check('a DM the user writes still answers', backends.CLAUDE!.sent.some((s) => s.text.includes('More work')));
  // a room: the user's message gets no bot turn, a note says why
  const g = rooms.create({ title: 'Ops', mode: 'everyone' });
  rooms.addMember(g.id, pip.id);
  const before = backends.CODEX!.sent.length;
  rooms.post(g.id, 'hello team');
  await sleep(1800);
  const lines = rooms.find(g.id)?.messages ?? [];
  check('a room turn does not start; a note says why', backends.CODEX!.sent.length === before && lines.some((l: any) => /No more turns today: the crew's daily budget/.test(l.text)), lines.map((l: any) => l.text));
  await action('setCaps', null, { dayTokens: 0, dayUsd: 0 });
  check('cleared: no budget', crew.state().usage.over === null && crew.state().usage.caps.dayTokens === null);

  // ---------------------------------------------------------------- browser, tour
  console.log('a bot’s own browser; the guide');
  await action('updateBot', pip.id, { browser: true, voice: 'Samantha' });
  const pipThread = crew.ensureDm(pip.id);
  const setup = crew.crew.setupFor(pipThread);
  check('Codex bot with a browser: /browser in its own MCP servers', setup.mcp.some((m) => m.name === 'browser' && m.url.endsWith('/browser')), setup.mcp);
  await action('updateBot', pip.id, { access: 'talk' });
  check('not at Talk', !crew.crew.setupFor(crew.ensureDm(pip.id)).mcp.some((m) => m.name === 'browser'));
  const ana = crew.crew.setupFor(crew.ensureDm(lead.id));
  check('a bot without it: no browser', !ana.mcp.some((m) => m.name === 'browser'));
  const pv = crew.state().bots.find((b) => b.id === pip.id)!;
  check('the view carries browser and voice', pv.browser && pv.voice === 'Samantha');
  check('guide shown until closed', crew.state().tourDone === false && (await action('tourDone', null, { done: true }), crew.state().tourDone === true));

  console.log('crew_manage is listed only to the Chief (own servers)');
  const toolsOf = (t: ThreadRecord) => ((mcpBase.resolve!(new URLSearchParams({ t: t.id, cap: crew.crew.identity.cap(t.id) })) as McpServerDef).tools() as { name: string }[]).map((x) => x.name);
  check('a non-Chief bot: no crew_manage', !toolsOf(crew.ensureDm(pip.id)).includes('crew_manage'));
  await action('setChief', lead.id, {});
  check('the Chief: crew_manage', toolsOf(crew.ensureDm(lead.id)).includes('crew_manage') && !toolsOf(crew.ensureDm(pip.id)).includes('crew_manage'));

  const stView: CrewStateView = crew.state();
  void stView;
  console.log(`\n${passes} passed, ${failures} failed`);
  crew.dispose();
  rooms.dispose?.();
  process.exit(failures ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
