// Live: a 4-member room on the 4 engines runs 30 messages (docs/crew/PLAN.md Phase 2 "done when": correct routing and
// flat per-turn tokens). Ada = Claude haiku, Tess = Codex low effort, Olga = OpenCode (a free model), Gus = Antigravity
// (a Flash model). Every step says who should answer (a mention, a reply, a topic the auto heuristic knows, @all, a
// hold) or that the router picks; the text sent each turn must stay small (deltas).
//   npx esbuild dev/smoke-room4.ts --bundle --platform=node --outfile=/tmp/crew-smoke/room4.js
//   node /tmp/crew-smoke/room4.js       (from the repo root: agy loads proto/)
// Ports: bridge 1254, hub 1255, MCP 1256. Put back at the end (also on failure / Ctrl-C): every chat it made,
// ~/.antigem_bridge/launched-binary.json, Antigravity's mcp_config.json, ~/.antigem_bridge/opencode/{crew,opencode}.json.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind } from '../shared/model';
import { AgyBackend } from '../src/core/agy/AgyBackend';
import { BridgeManager, cliPathArgs } from '../src/core/bridge/BridgeManager';
import { ClaudeBackend } from '../src/core/claude/ClaudeBackend';
import { CodexBackend } from '../src/core/codex/CodexBackend';
import { OpenCodeBackend } from '../src/core/opencode/OpenCodeBackend';
import { McpHost } from '../src/core/mcp/server';
import { CrewEngine } from '../src/core/crew/engine';
import { RoomEngine } from '../src/core/crew/rooms/engine';
import type { Group } from '../src/core/crew/rooms/types';
import type { AgentBackend, KeyValueStore, SendRequest } from '../src/core/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-room4-'));
const logFile = path.join(tmp, 'smoke.log');
const log = (l: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${l}\n`);
const say = (l: string) => {
  console.log(l);
  log(l);
};
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  say(`  ${ok ? '✓' : '✗'} ${name}${detail !== undefined && !ok ? ` — ${typeof detail === 'string' ? detail.slice(0, 500) : JSON.stringify(detail).slice(0, 500)}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ what we put back
const BRIDGE_HOME = path.join(os.homedir(), '.antigem_bridge');
const backups: [string, string | null][] = [path.join(BRIDGE_HOME, 'launched-binary.json'), path.join(BRIDGE_HOME, 'opencode', 'crew.json'), path.join(BRIDGE_HOME, 'opencode', 'opencode.json')].map((f) => [
  f,
  fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null,
]);
function restoreFiles() {
  for (const [f, data] of backups) {
    try {
      if (data === null) fs.rmSync(f, { force: true });
      else fs.writeFileSync(f, data);
    } catch (e) {
      say(`  could not put back ${f}: ${e}`);
    }
  }
}

const kvData: Record<string, unknown> = {};
const kv: KeyValueStore = { get: <T>(k: string) => kvData[k] as T | undefined, set: (k, v) => void (kvData[k] = v) };
const bridge = new BridgeManager({
  binPath: process.env.CREW_SMOKE_BRIDGE ?? path.resolve('bin/antigem-bridge-linux-x64'),
  port: 1254,
  hubPort: 1255,
  workspaceDir: tmp,
  agentFlags: () => [],
  extraArgs: () => cliPathArgs(undefined),
  agyDataDir: () => 'antigravity-ide',
  logFile: path.join(tmp, 'bridge.log'),
  log,
});
const opts = { openUrl: () => undefined, openFile: () => undefined, projectDir: () => null };
const raw: Record<AgentKind, AgentBackend> = {
  CLAUDE: new ClaudeBackend(bridge, kv, log, opts as any),
  CODEX: new CodexBackend(bridge, kv, log, opts as any),
  OPENCODE: new OpenCodeBackend(bridge, kv, log, opts as any),
  AGY: new AgyBackend(bridge, kv, log, opts as any),
};
const KINDS = Object.keys(raw) as AgentKind[];
const sent: { kind: AgentKind; chat: string; text: string; at: number }[] = [];
const backends = Object.fromEntries(
  KINDS.map((k) => [
    k,
    new Proxy(raw[k], {
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
    }),
  ]),
) as Record<AgentKind, AgentBackend>;

let agyMcpBefore: string | null = null;
async function restoreAgyMcp() {
  if (agyMcpBefore === null) return;
  await bridge.json('/api/mcp/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: agyMcpBefore }) }).catch((e) => say(`  could not restore mcp_config.json: ${e}`));
  agyMcpBefore = null;
}

const mcp = new McpHost({ port: 1256, deviceId: randomBytes(16).toString('hex'), log });
const crew = new CrewEngine({ mcpUrl: (p) => mcp.url(p), mcpHeaders: () => mcp.headers(), root: path.join(tmp, 'crew'), groupsDir: path.join(tmp, 'none') });
const conversations = () => KINDS.flatMap((k) => raw[k].conversations());
crew.bind({
  backend: (k) => backends[k],
  enabledKinds: () => KINDS,
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => tmp,
  showChat: () => undefined,
  postActive: () => undefined,
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  openFile: () => undefined,
  isRunning: (k, id) => !!raw[k].conversations().find((c) => c.id === id)?.isRunning,
  log,
});
mcp.register(crew.crew.mcp());
const rooms = new RoomEngine(crew.rooms);
crew.onRoomsChanged = () => rooms.refresh();
rooms.bind({
  backend: (k) => backends[k],
  enabledKinds: () => KINDS,
  conversations,
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => tmp,
  showChat: () => undefined,
  postActive: () => undefined,
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  log: (l) => log(`[rooms] ${l}`),
  crew: () => crew.roomApi(),
});

async function waitOnline(kind: AgentKind) {
  const be = raw[kind];
  be.start();
  for (let i = 0; i < 180; i++) {
    if (be.status().state === 'online' && (kind !== 'AGY' || be.models().models.length)) return true;
    await sleep(500);
  }
  say(`  ${kind} status: ${JSON.stringify(be.status())}`);
  return false;
}

async function settle(id: string, ms = 300_000) {
  const end = Date.now() + ms;
  await sleep(600);
  while (Date.now() < end) {
    if (!(rooms as any).isBusy(id)) return true;
    await sleep(500);
  }
  say(`  (room still busy after ${ms / 1000}s)`);
  return false;
}

// ------------------------------------------------------------------------------------------------ the script

/** expect: names that must answer (exactly), 'router' (one or two members, picked by the router or the lead), 'none'. */
interface Step {
  text: string;
  expect: string[] | 'router' | 'none';
  /** reply to the last line of this member */
  replyTo?: string;
  /** a hold command: no line is posted */
  command?: boolean;
  /** how the answer must be picked (default: any) */
  by?: string;
}
const STEPS: Step[] = [
  { text: '@Ada hi! What is your role, in one line?', expect: ['Ada'], by: 'mention' },
  { text: '@Tess hi! And yours, in one line?', expect: ['Tess'], by: 'mention' },
  { text: '@Olga and yours?', expect: ['Olga'], by: 'mention' },
  { text: '@Gus and yours?', expect: ['Gus'], by: 'mention' },
  { text: 'We need a deadline for the beta. What do you suggest?', expect: ['Ada'], by: 'auto' },
  { text: 'The login tests are flaky again.', expect: ['Tess'], by: 'auto' },
  { text: 'Can someone compare two charting libraries for us?', expect: ['Olga'], by: 'auto' },
  { text: 'What colors should the logo use?', expect: ['Gus'], by: 'auto' },
  { text: 'How would you find the cause?', expect: ['Tess'], replyTo: 'Tess', by: 'reply' },
  { text: 'And which font goes with that?', expect: ['Gus'], replyTo: 'Gus', by: 'reply' },
  { text: '@all one word each: the biggest risk this week?', expect: ['Ada', 'Tess', 'Olga', 'Gus'], by: 'everyone' },
  { text: 'What should we name the beta?', expect: 'router' },
  { text: "What's the plan for the next sprint?", expect: ['Ada'], by: 'auto' },
  { text: 'Is there a bug in the date picker?', expect: ['Tess'], by: 'auto' },
  { text: 'Find the docs for the date picker API.', expect: ['Olga'], by: 'auto' },
  { text: 'pause @Gus', expect: 'none', command: true },
  { text: '@Gus redesign the settings page, please.', expect: 'none' },
  { text: 'Ada, can you put the redesign on the schedule?', expect: ['Ada'], by: 'auto' },
  { text: 'resume @Gus', expect: ['Gus'], command: true, by: 'held' },
  { text: '@Tess @Olga one sentence each: what makes test docs useful?', expect: ['Tess', 'Olga'], by: 'mention' },
  { text: "What's a good team motto?", expect: 'router' },
  { text: 'Any ideas for a fun launch party?', expect: 'router' },
  { text: '@Ada sum up what we decided so far, in one line.', expect: ['Ada'], by: 'mention' },
  { text: 'Roadmap check: are we on track?', expect: ['Ada'], by: 'auto' },
  { text: 'Can you research how other apps do onboarding?', expect: ['Olga'], by: 'auto' },
  { text: 'Which UI pattern fits onboarding best?', expect: ['Gus'], by: 'auto' },
  { text: 'Which tests should cover the onboarding flow?', expect: ['Tess'], by: 'auto' },
  { text: '@Olga @Gus one line each: docs or design first?', expect: ['Olga', 'Gus'], by: 'mention' },
  { text: 'Thanks everyone! @all one emoji each to close.', expect: ['Ada', 'Tess', 'Olga', 'Gus'], by: 'everyone' },
  { text: '@Ada final one-line wrap-up, please.', expect: ['Ada'], by: 'mention' },
];

async function run() {
  const models = (k: AgentKind) => raw[k].models().models;
  const olgaModel = models('OPENCODE').find((m) => /deepseek.*flash.*free/i.test(m.id))?.id ?? models('OPENCODE').find((m) => /free/i.test(m.id))?.id ?? null;
  const gusModel = models('AGY').find((m) => /flash/i.test(`${m.id} ${m.displayName}`))?.id ?? null;
  say(`  OpenCode model: ${olgaModel}; Antigravity model: ${gusModel}`);
  const mk = (f: Record<string, unknown>) => crew.createBot({ chattiness: 0, access: 'talk', ...f });
  const ada = mk({ name: 'Ada', agent: 'CLAUDE', modelId: 'haiku', title: 'planner', description: 'Plans sprints and releases', aliases: 'plan, roadmap, deadline, schedule, sprint', soul: 'You are Ada, a calm planner. Answer in one or two short sentences.' });
  const tess = mk({ name: 'Tess', agent: 'CODEX', effort: 'low', title: 'tester', description: 'Finds bugs and failing tests', aliases: 'test, tests, bug, flaky, failing', soul: 'You are Tess, a blunt tester. Answer in one or two short sentences.' });
  const olga = mk({ name: 'Olga', agent: 'OPENCODE', modelId: olgaModel, title: 'researcher', description: 'Researches libraries and documentation', aliases: 'research, docs, compare, library, libraries', soul: 'You are Olga, a thorough researcher. Answer in one or two short sentences.' });
  const gus = mk({ name: 'Gus', agent: 'AGY', modelId: gusModel, title: 'designer', description: 'Designs the UI, colors and logos', aliases: 'design, colors, logo, ui, font, redesign', soul: 'You are Gus, a playful designer. Answer in one or two short sentences.' });
  const byName = new Map([ada, tess, olga, gus].map((b) => [b.name, b.id]));
  const g = rooms.create({ title: 'Launch', userName: 'Sam', maxBotTurns: 10 });
  for (const b of [ada, tess, olga, gus]) rooms.addMember(g.id, b.id);
  rooms.update(g.id, { maxBotTurns: 10 });

  let ok = 0;
  for (const [i, s] of STEPS.entries()) {
    const before = rooms.find(g.id)!;
    const mark = before.messages.length;
    const replyTo = s.replyTo ? [...before.messages].reverse().find((m) => m.from === byName.get(s.replyTo!))?.id ?? null : null;
    const t0 = Date.now();
    if (s.command) {
      const [cmd, who] = s.text.split(' @');
      if (/pause/.test(cmd)) rooms.hold(g.id, who);
      else rooms.release(g.id, who);
    } else rooms.post(g.id, s.text, [], replyTo);
    await settle(g.id);
    const cur = rooms.find(g.id) as Group;
    const answers = cur.messages.slice(mark).filter((m) => cur.bots.some((b) => b.id === m.from));
    const names = answers.map((m) => m.name);
    let good: boolean;
    if (s.expect === 'none') good = answers.length === 0;
    else if (s.expect === 'router') good = answers.length >= 1 && answers.length <= 2 && answers.every((m) => m.picked?.by === 'router' || m.picked?.by === 'lead' || m.picked?.by === 'auto');
    else good = [...new Set(names)].sort().join() === [...s.expect].sort().join() && (!s.by || answers.every((m) => m.picked?.by === s.by));
    if (good) ok++;
    const secs = Math.round((Date.now() - t0) / 1000);
    say(`  ${good ? '✓' : '✗'} ${String(i + 1).padStart(2)}. ${s.text.slice(0, 60)} → ${answers.map((m) => `${m.name}[${m.picked?.by}${m.picked?.why ? `: ${m.picked.why.slice(0, 40)}` : ''}]`).join(', ') || '(nobody)'} (${secs}s)`);
    for (const m of answers) log(`      ${m.name}: ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`);
    for (const n of cur.messages.slice(mark).filter((m) => m.from === 'notice')) say(`      note: ${n.text}`);
    if (!good) failures++;
  }
  say(`\n  routing: ${ok}/${STEPS.length} as expected`);

  // per-turn text: after each member's first turn only deltas are sent
  const cur = rooms.find(g.id)!;
  for (const b of cur.bots) {
    const mine = sent.filter((s) => s.chat === b.chatId);
    const later = mine.slice(1).map((s) => s.text.length);
    say(`  ${b.name} (${b.agent}): ${mine.length} turns; first ${mine[0]?.text.length ?? 0} chars, later max ${later.length ? Math.max(...later) : 0}, mean ${later.length ? Math.round(later.reduce((a, c) => a + c, 0) / later.length) : 0}`);
  }
  const later = cur.bots.flatMap((b) => sent.filter((s) => s.chat === b.chatId).slice(1));
  check('turn text stays flat (every later turn < 2000 chars)', later.length > 20 && later.every((s) => s.text.length < 2000), later.map((s) => s.text.length));
  const usage = fs.readFileSync(path.join(tmp, 'crew', 'usage.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const b of cur.bots) {
    const u = usage.filter((x) => x.botId === b.id && x.kind === 'room').map((x) => x.input + x.cached);
    if (u.length) say(`  ${b.name} engine-reported input per turn: ${u.join(', ')}`);
  }
}

async function main() {
  say(`log: ${logFile}`);
  check('crew MCP host on 1256', await mcp.start());
  await bridge.ensureRunning();
  const cfg = await bridge.json<any>('/api/mcp/config').catch(() => null);
  agyMcpBefore = typeof cfg?.content === 'string' ? cfg.content : null;
  say(`  Antigravity mcp_config.json backed up (${cfg?.path ?? '?'})`);
  for (const k of KINDS) check(`${k} online`, await waitOnline(k));
  try {
    await run();
  } catch (e) {
    check('no crash', false, String((e as Error)?.stack ?? e));
  }
  await cleanup();
  say(`\n${failures ? `${failures} FAILED` : 'all passed'} (log ${logFile})`);
  process.exit(failures ? 1 : 0);
}

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
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
  await restoreAgyMcp();
  await bridge.shutdown().catch(() => undefined);
  mcp.stop();
  restoreFiles();
  say('  put back: launched-binary.json, Antigravity mcp_config.json, the bridge’s OpenCode crew.json / opencode.json');
}

process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));
process.on('SIGTERM', () => void cleanup().then(() => process.exit(143)));
void main();
