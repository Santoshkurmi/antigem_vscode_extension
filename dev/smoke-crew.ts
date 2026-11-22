// Live smoke of Crew Phase 0 (real agents, small models): a bot chat on Claude Code and on Codex (and OpenCode with
// CREW_SMOKE_OPENCODE=1, Antigravity with CREW_SMOKE_AGY=1) through a dev bridge, with the crew MCP host on its own
// port. Checks: each bot has its persona
// and its own crew tools (crew_roster answers as that bot), talk / read access is enforced, and an edited persona
// reaches the same chat (Claude: process restart; Codex: application context).
//   (cd bridge && CGO_ENABLED=0 go build -o /tmp/crew-smoke/antigem-bridge-linux-x64 .)
//   npx esbuild dev/smoke-crew.ts --bundle --platform=node --outfile=/tmp/crew-smoke/smoke.js
//   CREW_SMOKE_BRIDGE=/tmp/crew-smoke/antigem-bridge-linux-x64 node /tmp/crew-smoke/smoke.js   (from the repo root: agy loads proto/)
// Ports: bridge 1254, hub 1255 (only with CREW_SMOKE_AGY), MCP 1256. The chats it makes are deleted at the end, and
// ~/.antigem_bridge/launched-binary.json and Antigravity's mcp_config.json are put back.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, ChatMessage } from '../shared/model';
import { BridgeManager, cliPathArgs } from '../src/core/bridge/BridgeManager';
import { AgyBackend } from '../src/core/agy/AgyBackend';
import { ClaudeBackend } from '../src/core/claude/ClaudeBackend';
import { CodexBackend } from '../src/core/codex/CodexBackend';
import { OpenCodeBackend } from '../src/core/opencode/OpenCodeBackend';
import { McpHost, type McpServerDef } from '../src/core/mcp/server';
import { Crew } from '../src/core/crew/crew';
import { newId, normalizeBot } from '../src/core/crew/store/store';
import type { BotProfile, ThreadRecord } from '../src/core/crew/types';
import type { AgentBackend, ChatState, KeyValueStore } from '../src/core/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-smoke-'));
const logFile = path.join(tmp, 'smoke.log');
const log = (l: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${l}\n`);
const say = (l: string) => {
  console.log(l);
  log(l);
};
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  say(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail !== undefined ? ` — ${typeof detail === 'string' ? detail.slice(0, 500) : JSON.stringify(detail).slice(0, 500)}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const kvData: Record<string, unknown> = {};
const kv: KeyValueStore = { get: <T>(k: string) => kvData[k] as T | undefined, set: (k, v) => void (kvData[k] = v) };

const LAUNCHED = path.join(os.homedir(), '.antigem_bridge', 'launched-binary.json');
const launchedBefore = fs.existsSync(LAUNCHED) ? fs.readFileSync(LAUNCHED, 'utf8') : null;

const bridge = new BridgeManager({
  binPath: process.env.CREW_SMOKE_BRIDGE ?? '/tmp/crew-smoke/antigem-bridge-linux-x64',
  port: 1254,
  hubPort: 1255,
  workspaceDir: tmp,
  agentFlags: () => (process.env.CREW_SMOKE_AGY ? [] : ['--no-hub']),
  extraArgs: () => cliPathArgs(undefined),
  agyDataDir: () => 'antigravity-ide',
  logFile: path.join(tmp, 'bridge.log'),
  log,
});
const opts = { openUrl: () => undefined, openFile: () => undefined, projectDir: () => null };
const backends: Partial<Record<AgentKind, AgentBackend>> = {
  CLAUDE: new ClaudeBackend(bridge, kv, log, opts as any),
  CODEX: new CodexBackend(bridge, kv, log, opts as any),
  ...(process.env.CREW_SMOKE_OPENCODE ? { OPENCODE: new OpenCodeBackend(bridge, kv, log, opts as any) } : {}),
  ...(process.env.CREW_SMOKE_AGY ? { AGY: new AgyBackend(bridge, kv, log, opts as any) } : {}),
};
/** Antigravity's mcp_config.json before the smoke (the crew entry it adds points at this test's port). */
let agyMcpBefore: string | null = null;
async function restoreAgyMcp() {
  if (agyMcpBefore === null) return;
  await bridge.json('/api/mcp/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: agyMcpBefore }) }).catch((e) => say(`  could not restore mcp_config.json: ${e}`));
  agyMcpBefore = null;
}
const mcp = new McpHost({ port: 1256, deviceId: randomBytes(16).toString('hex'), log });
const crew = new Crew({ backend: (k) => backends[k], mcpUrl: (p) => mcp.url(p), mcpHeaders: () => mcp.headers(), userName: () => 'Sam' }, path.join(tmp, 'crew'));

// count crew tool calls per thread (wrapping the server the host resolves per request)
const calls = new Map<string, number>();
const base = crew.mcp();
const counted: McpServerDef = {
  ...base,
  resolve: async (q) => {
    const d = (await base.resolve!(q)) as McpServerDef;
    return {
      ...d,
      call: async (name, args, ctx) => {
        const r = await d.call(name, args, ctx);
        const cap = typeof args.cap === 'string' ? args.cap : '';
        const tid = q.get('t') ?? crew.lookup.threadByEngineChat('OPENCODE', String(ctx?.meta?.['ai.opencode/sessionID'] ?? ''))?.id ?? (cap ? cap.slice(0, cap.lastIndexOf('.')) : '?');
        if (!r.isError) calls.set(tid, (calls.get(tid) ?? 0) + 1);
        log(`[crew] ${name} from ${tid}: ${r.isError ? 'ERROR ' : ''}${JSON.stringify(r.content).slice(0, 200)}`);
        return r;
      },
    };
  },
};
mcp.register(counted);

function lastReply(msgs: ChatMessage[]): string {
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i].role !== 'USER') i--;
  return msgs
    .slice(i + 1)
    .filter((m) => m.role === 'ASSISTANT')
    .map((m) => m.content)
    .join('\n');
}

/** One bot turn: the crew way (begin turn → send with setup → wait until settled → end turn). */
async function turn(be: AgentBackend, th: ThreadRecord, isNew: boolean, text: string, model: string | null, folder: string): Promise<string> {
  let state: ChatState | null = null;
  const unsub = be.subscribe(th.chatId!, (s) => (state = s));
  crew.identity.beginTurn(th.id);
  try {
    if (!isNew) {
      const until = Date.now() + 15_000;
      while (Date.now() < until && (!state || (state as ChatState).isLoading)) await sleep(200);
    }
    const setup = crew.setupFor(th);
    crew.store.putThread({ ...th, setupKey: setup.key });
    await be.send({ conversationId: th.chatId!, isNew, text, attachments: [], modelId: isNew ? model : null, workspaceUri: isNew ? `file://${folder}` : null, setup });
    const started = Date.now();
    let ran = false;
    let quiet = 0;
    for (;;) {
      await sleep(500);
      const s = state as ChatState | null;
      if (s?.approvals.length) {
        for (const a of s.approvals) await be.approval(th.chatId!, a.key, undefined, true, 'Not allowed for this bot.');
      }
      // Antigravity: its chat row says when the agent runs (as GroupsEngine.runTurn reads it)
      const running = th.engine === 'AGY' && !!be.conversations().find((c) => c.id === th.chatId)?.isRunning;
      const busy = !!s?.isStreaming || !!s?.approvals.length || running;
      if (busy) {
        ran = true;
        quiet = 0;
      } else if (ran || (s && lastReply(s.messages).trim())) {
        quiet ||= Date.now();
        if (Date.now() - quiet > 1500) break;
      }
      if (Date.now() - started > 240_000) throw new Error('turn timed out');
    }
    const s = state as ChatState | null;
    if (s?.error) log(`[smoke] chat error: ${s.error}`);
    return s ? lastReply(s.messages) : '';
  } finally {
    crew.identity.endTurn(th.id);
    unsub();
  }
}

async function waitOnline(kind: AgentKind) {
  const be = backends[kind]!;
  be.start();
  for (let i = 0; i < 120; i++) {
    // online, with its models known (a new chat needs one)
    if (be.status().state === 'online' && (kind !== 'AGY' || be.models().models.length)) return true;
    await sleep(500);
  }
  say(`  ${kind} status: ${JSON.stringify(be.status())}`);
  return false;
}

async function main() {
  say(`log: ${logFile}`);
  check('crew MCP host on 1256', await mcp.start());
  await bridge.ensureRunning();
  if (backends.AGY) {
    const cfg = await bridge.json<any>('/api/mcp/config');
    agyMcpBefore = typeof cfg?.content === 'string' ? cfg.content : null;
    say(`Antigravity mcp_config.json backed up (${cfg?.path ?? '?'})`);
  }
  const made: { be: AgentBackend; chat: string }[] = [];
  const room = crew.store.roomFolder('smoke');
  const mk = (o: Partial<BotProfile>, soul: string) => {
    const b = normalizeBot(o, newId('b'));
    crew.store.putBot(b);
    crew.store.setSoul(b.id, soul);
    return b;
  };
  const ada = mk({ name: 'Ada', title: 'planner', engine: 'CLAUDE', model: 'haiku', access: 'talk' }, 'You are Ada, a terse planner. Always start your reply with "Ada here."');
  const tess = mk({ name: 'Tess', title: 'tester', engine: 'CODEX', access: 'read' }, 'You are Tess, a careful tester. Always start your reply with "Tess here."');
  const gus = backends.AGY ? mk({ name: 'Gus', title: 'scout', engine: 'AGY', access: 'talk' }, 'You are Gus, a quick scout. Always start your reply with "Gus here."') : null;
  const olga = process.env.CREW_SMOKE_OPENCODE ? mk({ name: 'Olga', title: 'researcher', engine: 'OPENCODE', access: 'talk', model: process.env.CREW_SMOKE_OPENCODE_MODEL ?? null }, 'You are Olga. Always start your reply with "Olga here."') : null;
  const ask = 'Introduce yourself in one line. Then call your crew_roster tool and name your teammates. Then try to create a file named made.txt in the current folder containing "hi" (use a tool if you have one), and say whether it worked.';

  const only = process.env.CREW_SMOKE_ONLY?.split(',');
  for (const b of [ada, tess, olga, gus].filter((x): x is BotProfile => !!x && (!only || only.includes(x.engine)))) {
    say(`\n${b.name} on ${b.engine} (${b.access})`);
    if (!(await waitOnline(b.engine))) {
      check(`${b.engine} is online`, false);
      continue;
    }
    const be = backends[b.engine]!;
    const th: ThreadRecord = { id: newId('t'), botId: b.id, engine: b.engine, chatId: randomUUID(), kind: 'dm', roomId: null, jobId: null, seen: 0, setupKey: null, createdAt: Date.now(), updatedAt: Date.now() };
    crew.store.putThread(th);
    made.push({ be, chat: th.chatId! });
    fs.rmSync(path.join(room, 'made.txt'), { force: true });
    let reply = '';
    try {
      const model = b.engine === 'AGY' ? (be.models().models.find((m) => /flash/i.test(m.displayName || m.id))?.id ?? null) : b.model;
      reply = await turn(be, th, true, ask, model, room);
    } catch (e) {
      check('first turn finished', false, String(e));
      continue;
    }
    log(`[smoke] ${b.name} said: ${reply}`);
    check('persona: answers as itself', reply.includes(`${b.name} here`), reply);
    check('own crew tools: crew_roster answered for this thread', (calls.get(th.id) ?? 0) > 0, Object.fromEntries(calls));
    const mates = [ada, tess, olga, gus].filter((x) => x && x.id !== b.id).map((x) => x!.name);
    check('it named its teammates (from the roster)', mates.some((n) => reply.includes(n)), reply);
    check(`${b.access}: no file was created`, !fs.existsSync(path.join(room, 'made.txt')));
    if (b.engine === 'OPENCODE') continue;

    // edited persona, same chat
    crew.store.setSoul(b.id, `You are ${b.name}, but you now go by the nickname Zed${b.name}. Always start your reply with "Zed${b.name} here."`);
    const before = calls.get(th.id) ?? 0;
    try {
      reply = await turn(be, th, false, 'Who are you now? One line. Then call crew_roster once more.', null, room);
    } catch (e) {
      check('second turn finished', false, String(e));
      continue;
    }
    log(`[smoke] ${b.name} (edited) said: ${reply}`);
    check('edited persona reached the same chat', reply.includes(`Zed${b.name}`), reply);
    check('crew tools still work after the change', (calls.get(th.id) ?? 0) > before, Object.fromEntries(calls));
  }

  // cleanup
  for (const m of made) await m.be.conversationAction(m.chat, 'delete').catch((e) => log(`[smoke] delete ${m.chat}: ${e}`));
  await restoreAgyMcp();
  await bridge.shutdown();
  mcp.stop();
  if (launchedBefore !== null) fs.writeFileSync(LAUNCHED, launchedBefore);
  say(`\n${failures ? `${failures} failed` : 'all passed'} (log ${logFile})`);
  process.exit(failures ? 1 : 0);
}

void main().catch(async (e) => {
  say(`smoke crashed: ${e instanceof Error ? e.stack : String(e)}`);
  await restoreAgyMcp();
  await bridge.shutdown().catch(() => undefined);
  if (launchedBefore !== null) fs.writeFileSync(LAUNCHED, launchedBefore);
  process.exit(1);
});
