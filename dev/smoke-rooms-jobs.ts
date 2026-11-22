// Live smoke of Crew Phase 2 (Rooms v2) and Phase 3 (Jobs) with real agents on small models (Claude haiku, Codex low
// effort) through a dev bridge, with the crew MCP host on its own port. The real CrewEngine + RoomEngine run as in the
// extension. Checks:
//   Phase 2: a room routes by mention, by the auto heuristic, by the router model, by reply; hold / release; queued
//            messages go as one turn; everyone at once (parallel drafting); the text sent each turn stays small (deltas).
//   Phase 3: "plan, build and test X" in the lead's DM fans out to 3 bots with crew_assign, and the lead resumes ONCE
//            with all reports, then answers with evidence.
//   npx esbuild dev/smoke-rooms-jobs.ts --bundle --platform=node --outfile=/tmp/crew-smoke/rj.js
//   node /tmp/crew-smoke/rj.js            (from the repo root; SMOKE_PART=rooms|jobs runs one half)
// Ports: bridge 1254, MCP 1256 (no hub). Every chat it makes is deleted at the end; ~/.antigem_bridge/launched-binary.json
// is put back.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind } from '../shared/model';
import type { HostToView } from '../shared/protocol';
import { BridgeManager, cliPathArgs } from '../src/core/bridge/BridgeManager';
import { ClaudeBackend } from '../src/core/claude/ClaudeBackend';
import { CodexBackend } from '../src/core/codex/CodexBackend';
import { McpHost } from '../src/core/mcp/server';
import { CrewEngine } from '../src/core/crew/engine';
import { RoomEngine } from '../src/core/crew/rooms/engine';
import type { Group } from '../src/core/crew/rooms/types';
import type { AgentBackend, KeyValueStore, SendRequest } from '../src/core/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-rj-'));
const project = path.join(tmp, 'project');
fs.mkdirSync(project, { recursive: true });
const logFile = path.join(tmp, 'smoke.log');
const log = (l: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${l}\n`);
const say = (l: string) => {
  console.log(l);
  log(l);
};
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  say(`  ${ok ? '✓' : '✗'} ${name}${detail !== undefined && !ok ? ` — ${typeof detail === 'string' ? detail.slice(0, 600) : JSON.stringify(detail).slice(0, 600)}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const part = process.env.SMOKE_PART ?? 'all';

const kvData: Record<string, unknown> = {};
const kv: KeyValueStore = { get: <T>(k: string) => kvData[k] as T | undefined, set: (k, v) => void (kvData[k] = v) };
const LAUNCHED = path.join(os.homedir(), '.antigem_bridge', 'launched-binary.json');
const launchedBefore = fs.existsSync(LAUNCHED) ? fs.readFileSync(LAUNCHED, 'utf8') : null;

const bridge = new BridgeManager({
  binPath: process.env.CREW_SMOKE_BRIDGE ?? path.resolve('bin/antigem-bridge-linux-x64'),
  port: 1254,
  hubPort: 1255,
  workspaceDir: tmp,
  agentFlags: () => ['--no-hub'],
  extraArgs: () => cliPathArgs(undefined),
  agyDataDir: () => 'antigravity-ide',
  logFile: path.join(tmp, 'bridge.log'),
  log,
});
const opts = { openUrl: () => undefined, openFile: () => undefined, projectDir: () => null };
const raw: Partial<Record<AgentKind, AgentBackend>> = {
  CLAUDE: new ClaudeBackend(bridge, kv, log, opts as any),
  CODEX: new CodexBackend(bridge, kv, log, opts as any),
};
/** Every message sent to an agent (what each turn costs in text). */
const sent: { kind: AgentKind; chat: string; text: string; at: number }[] = [];
const backends: Partial<Record<AgentKind, AgentBackend>> = {};
for (const [k, be] of Object.entries(raw) as [AgentKind, AgentBackend][]) {
  backends[k] = new Proxy(be, {
    get(t, p, r) {
      if (p === 'send')
        return (req: SendRequest) => {
          sent.push({ kind: k, chat: req.conversationId, text: req.text, at: Date.now() });
          log(`[send ${k} ${req.conversationId}] ${req.text.length} chars`);
          return t.send(req);
        };
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

const mcp = new McpHost({ port: 1256, deviceId: randomBytes(16).toString('hex'), log });
const crew = new CrewEngine({ mcpUrl: (p) => mcp.url(p), mcpHeaders: () => mcp.headers(), root: path.join(tmp, 'crew'), groupsDir: path.join(tmp, 'none') });
const conversations = () => Object.values(backends).flatMap((b) => b!.conversations());
const active: HostToView[] = [];
crew.bind({
  backend: (k) => backends[k],
  enabledKinds: () => ['CLAUDE', 'CODEX'],
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => project,
  showChat: () => undefined,
  postActive: (m) => active.push(m),
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  openFile: () => undefined,
  isRunning: () => false,
  log,
});
mcp.register(crew.crew.mcp());
const rooms = new RoomEngine(crew.rooms);
crew.removeFromRooms = (id) => rooms.removeBotEverywhere(id);
crew.onRoomsChanged = () => rooms.refresh();
crew.roomReport = (r, b, t) => rooms.reportTurn(r, b, t);
crew.roomNote = (r, t) => rooms.note(r, t);
rooms.bind({
  backend: (k) => backends[k],
  enabledKinds: () => ['CLAUDE', 'CODEX'],
  conversations,
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => project,
  showChat: () => undefined,
  postActive: () => undefined,
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  log: (l) => log(`[rooms] ${l}`),
  crew: () => crew.roomApi(),
});

async function waitOnline(kind: AgentKind) {
  const be = raw[kind]!;
  be.start();
  for (let i = 0; i < 120; i++) {
    if (be.status().state === 'online') return true;
    await sleep(500);
  }
  say(`  ${kind} status: ${JSON.stringify(be.status())}`);
  return false;
}

async function settle(id: string, ms = 240_000) {
  const end = Date.now() + ms;
  await sleep(500);
  while (Date.now() < end) {
    if (!(rooms as any).isBusy(id)) return true;
    await sleep(500);
  }
  say(`  (room still busy after ${ms / 1000}s)`);
  return false;
}
const bots = (g: Group) => g.messages.filter((m) => g.bots.some((b) => b.id === m.from));
const lastBot = (g: Group) => bots(g).at(-1);
const show = (g: Group, from: number) =>
  g.messages
    .slice(from)
    .map((m) => `    ${m.from === 'user' ? '👤' : m.from === 'notice' || m.from === 'system' ? '·' : '🤖'} ${m.name || m.from}${m.picked ? ` [${m.picked.by}${m.picked.why ? `: ${m.picked.why}` : ''}]` : ''}: ${m.text.replace(/\s+/g, ' ').slice(0, 140)}${m.digest ? ` {${m.digest}}` : ''}`)
    .join('\n');

async function roomsPart() {
  say('\nPhase 2: a room on Claude + Codex');
  const ada = crew.createBot({ name: 'Ada', agent: 'CLAUDE', modelId: 'haiku', title: 'planner', description: 'Plans features and roadmaps', aliases: 'plan, roadmap, timeline', soul: 'You are Ada, a calm planner. One or two short sentences.', chattiness: 0, access: 'talk' });
  const tess = crew.createBot({ name: 'Tess', agent: 'CODEX', effort: 'low', title: 'tester', description: 'Finds bugs and failing tests', aliases: 'tests, bug, failing', soul: 'You are Tess, a blunt tester. One or two short sentences.', chattiness: 0, access: 'talk' });
  const pip = crew.createBot({ name: 'Pip', agent: 'CLAUDE', modelId: 'haiku', title: 'builder', description: 'Writes the code', soul: 'You are Pip, a cheerful builder. One or two short sentences.', chattiness: 0, access: 'talk' });
  const g = rooms.create({ title: 'Squad', userName: 'Sam' });
  for (const b of [ada, tess, pip]) rooms.addMember(g.id, b.id);
  let mark = rooms.find(g.id)!.messages.length;
  const step = async (label: string, text: string, opts: { replyTo?: string } = {}) => {
    mark = rooms.find(g.id)!.messages.length;
    rooms.post(g.id, text, [], opts.replyTo ?? null);
    await settle(g.id);
    const cur = rooms.find(g.id)!;
    say(`  — ${label}\n${show(cur, mark)}`);
    return cur;
  };

  let cur = await step('mention', '@Ada give me a one-line plan for a todo app');
  check('a mention: Ada answers', lastBot(cur)?.from === ada.id && lastBot(cur)?.picked?.by === 'mention');
  cur = await step('auto heuristic', 'the tests keep failing on CI, any idea why?');
  check('auto: the tester answers (her topics), no router call', lastBot(cur)?.from === tess.id && lastBot(cur)?.picked?.by === 'auto', lastBot(cur)?.picked);
  const routerBefore = crew.crew.store.threads().find((t) => t.kind === 'router' && t.roomId === g.id);
  cur = await step('router', 'what would be a fun name for this project?');
  const lb = lastBot(cur);
  check('unsure: the router model (or the lead when it is slow) picks one member', !!lb && (lb.picked?.by === 'router' || lb.picked?.by === 'lead') && bots(cur).length >= 3, lb?.picked);
  check('the router has its own hidden chat', !!crew.crew.store.threads().find((t) => t.kind === 'router' && t.roomId === g.id)?.chatId || !!routerBefore);
  const tessLine = [...cur.messages].reverse().find((m) => m.from === tess.id)!;
  cur = await step('reply', 'can you say more about that?', { replyTo: tessLine.id });
  check('a reply goes to the member replied to', lastBot(cur)?.from === tess.id && lastBot(cur)?.picked?.by === 'reply');
  rooms.post(g.id, 'pause @Pip');
  cur = await step('held mention', '@Pip are you there?');
  check('a held member is skipped; the message is kept', cur.heldMessages.length === 1 && cur.messages.slice(mark).every((m) => m.from !== pip.id));
  mark = cur.messages.length;
  rooms.release(g.id, pip.id);
  await settle(g.id);
  cur = rooms.find(g.id)!;
  say(`  — release\n${show(cur, mark)}`);
  check('released: Pip answers what was kept', lastBot(cur)?.from === pip.id && lastBot(cur)?.picked?.by === 'held');
  // the queue: two messages for Ada while Tess speaks go as one turn
  mark = cur.messages.length;
  const adaSendsBefore = sent.filter((s) => s.chat === cur.bots.find((b) => b.id === ada.id)!.chatId).length;
  rooms.post(g.id, '@Tess two sentences on why flaky tests are dangerous');
  await sleep(2500);
  rooms.post(g.id, '@Ada one thing:');
  rooms.post(g.id, '@Ada what comes first in the plan?');
  await settle(g.id);
  cur = rooms.find(g.id)!;
  say(`  — queue\n${show(cur, mark)}`);
  const adaChat = cur.bots.find((b) => b.id === ada.id)!.chatId;
  const adaTurns = sent.filter((s) => s.chat === adaChat).slice(adaSendsBefore);
  check('messages sent while Tess spoke went to Ada as ONE turn', adaTurns.length === 1 && adaTurns[0].text.includes('one thing:') && adaTurns[0].text.includes('what comes first'), adaTurns.map((t) => t.text.slice(-200)));
  rooms.update(g.id, { mode: 'everyone', drafting: 'parallel' });
  cur = await step('everyone at once', 'one word each: your favourite programming language?');
  const each = cur.messages.slice(mark).filter((m) => cur.bots.some((b) => b.id === m.from));
  check('everyone answers, drafted at once', new Set(each.map((m) => m.from)).size === 3, each.map((m) => m.name));
  // flat per-turn text: after each member's first turn, what it is sent stays small
  const chats = new Map(cur.bots.map((b) => [b.chatId, b.name]));
  const later = sent.filter((s) => chats.has(s.chat)).filter((s, i, a) => a.findIndex((x) => x.chat === s.chat) !== i);
  const maxLater = Math.max(...later.map((s) => s.text.length));
  say(`  per-turn text after the first turn: ${later.length} turns, max ${maxLater} chars, mean ${Math.round(later.reduce((n, s) => n + s.text.length, 0) / Math.max(1, later.length))}`);
  check('turn text stays small (deltas only, < 1500 chars)', later.length > 3 && maxLater < 1500, maxLater);
  const usage = fs.existsSync(path.join(tmp, 'crew', 'usage.ndjson')) ? fs.readFileSync(path.join(tmp, 'crew', 'usage.ndjson'), 'utf8').trim().split('\n').length : 0;
  say(`  usage.ndjson lines: ${usage}`);
}

async function jobsPart() {
  say('\nPhase 3: "plan, build and test X" from the lead’s DM');
  const lead = crew.createBot({ name: 'Lead', agent: 'CLAUDE', modelId: 'haiku', title: 'team lead', description: 'Splits work across the team and reports back', soul: 'You are Lead, the team lead. You delegate with crew_assign instead of doing the work yourself, and you report back briefly with evidence.', access: 'edit' });
  const planner = crew.createBot({ name: 'Plato', agent: 'CLAUDE', modelId: 'haiku', title: 'planner', soul: 'You are Plato, a planner. You write short plans.', access: 'edit' });
  const builder = crew.createBot({ name: 'Bob', agent: 'CLAUDE', modelId: 'haiku', title: 'builder', soul: 'You are Bob, a builder. You write small, working code.', access: 'edit' });
  const tester = crew.createBot({ name: 'Tina', agent: 'CODEX', effort: 'low', title: 'tester', soul: 'You are Tina, a tester. You write and run tiny tests.', access: 'edit' });
  active.length = 0;
  crew.openDm(lead.id);
  const tag = (active.find((m) => m.type === 'crewDm') as any).tag;
  const chatId = randomUUID();
  const ask =
    `In ${project}: plan, build and test a tiny add(a, b) function. Use crew_assign ONCE to hand out three jobs at the same time: ` +
    '@Plato writes PLAN.md (3 lines), @Bob writes add.js exporting add(a, b) with module.exports, @Tina writes add.test.js that requires ./add.js, ' +
    'asserts add(2, 3) === 5 and runs it with `node add.test.js`. Then end your turn. When their reports come back, answer me with one short report.';
  // as the chat view sends it: the open project
  const req = crew.prepareSend({ conversationId: chatId, isNew: true, text: ask, attachments: [], modelId: null, workspaceUri: `file://${project}` }, 'CLAUDE', tag.threadId);
  check('the DM goes with the lead’s setup and model', !!req.setup && req.modelId === 'haiku' && req.workspaceUri === `file://${project}`);
  await backends.CLAUDE!.send(req);
  const end = Date.now() + 12 * 60_000;
  let root = null as any;
  while (Date.now() < end) {
    root = crew.jobs.store.all().find((j) => !j.parentId && j.assignee.botId === lead.id);
    if (root && (root.status === 'done' || root.status === 'failed' || root.status === 'cancelled')) break;
    await sleep(2000);
  }
  if (!root) {
    check('the lead handed work out with crew_assign', false, 'no job tree (it did not call crew_assign)');
    return;
  }
  const tree = crew.jobs.store.tree(root.id);
  const kids = tree.filter((j) => j.parentId === root.id);
  const name = (id: string) => crew.crew.store.bot(id)?.name;
  say(`  tree ${root.id}: root ${root.status}; jobs: ${kids.map((k) => `${name(k.assignee.botId)} ${k.status} (${k.evidence ? `${k.evidence.toolCalls} tools` : 'no tools'})`).join(', ')}`);
  check('it fanned out to the three bots', new Set(kids.map((k) => name(k.assignee.botId))).size === 3, kids.map((k) => name(k.assignee.botId)));
  const resumes = sent.filter((s) => s.chat === chatId && /📋 Reports/.test(s.text));
  check('the lead resumed ONCE with all reports', resumes.length === 1 && kids.every((k) => resumes[0].text.includes(`job ${k.id.replace(/^j_/, '').slice(0, 6)}`)), resumes.length);
  check('the root finished with the lead’s report', root.status === 'done' && (root.result ?? '').length > 20, root.result);
  say(`  lead's final report: ${(root.result ?? '').replace(/\s+/g, ' ').slice(0, 400)}`);
  const files = ['PLAN.md', 'add.js', 'add.test.js'].filter((f) => fs.existsSync(path.join(project, f)));
  say(`  files in the project: ${files.join(', ') || 'none'}`);
  check('the work is on disk', files.length >= 2, files);
  const view = crew.jobsState();
  check('Mission Control shows the tree', view.trees.some((t) => t.root.id === root.id && t.jobs.length >= 3));
}

async function main() {
  say(`log: ${logFile}`);
  check('crew MCP host on 1256', await mcp.start());
  await bridge.ensureRunning();
  for (const k of ['CLAUDE', 'CODEX'] as AgentKind[]) check(`${k} online`, await waitOnline(k));
  try {
    if (part === 'all' || part === 'rooms') await roomsPart();
    if (part === 'all' || part === 'jobs') await jobsPart();
  } catch (e) {
    check('no crash', false, String((e as Error)?.stack ?? e));
  }
  await cleanup();
  say(`\n${failures ? `${failures} FAILED` : 'all passed'} (log ${logFile})`);
  process.exit(failures ? 1 : 0);
}

async function cleanup() {
  rooms.dispose();
  crew.dispose();
  await sleep(2000);
  const chats = new Set<string>();
  for (const t of crew.crew.store.threads()) if (t.chatId) chats.add(`${t.engine}|${t.chatId}`);
  for (const s of sent) chats.add(`${s.kind}|${s.chat}`);
  for (const c of chats) {
    const [k, id] = c.split('|') as [AgentKind, string];
    await raw[k]?.conversationAction(id, 'delete').catch((e) => log(`[smoke] delete ${id}: ${e}`));
  }
  say(`  deleted ${chats.size} chats`);
  await bridge.shutdown().catch(() => undefined);
  mcp.stop?.();
  if (launchedBefore !== null) fs.writeFileSync(LAUNCHED, launchedBefore);
}

process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));
void main();
