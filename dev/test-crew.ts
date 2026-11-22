// Offline test of the Crew Phase 0 foundations (src/core/crew): store + migrations, caller identity, thread setups
// and their per-engine mappings, and crew_mcp served by a real McpHost. No bridge, no agents.
/* eslint-disable @typescript-eslint/no-explicit-any */
//   npx esbuild dev/test-crew.ts --bundle --platform=node --outfile=<tmp>/test-crew.js && node <tmp>/test-crew.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpHost } from '../src/core/mcp/server';
import { Crew } from '../src/core/crew/crew';
import { CrewStore, newId, normalizeBot, normalizeRoom } from '../src/core/crew/store/store';
import { migrateGroups, migrateSchema } from '../src/core/crew/store/migrate';
import { CrewIdentity, GRACE_MS } from '../src/core/crew/mcp/identity';
import { buildSetup, effectiveAccess, softPreamble } from '../src/core/crew/engines/setup';
import { claudeCrew, CLAUDE_READ_TOOLS } from '../src/core/crew/engines/claude';
import { codexPersonaContext, codexSandboxPolicy, codexThreadParams } from '../src/core/crew/engines/codex';
import { opencodeAgent, opencodeAgentId, opencodeRules } from '../src/core/crew/engines/opencode';
import { CREW_SCHEMA, type BotProfile, type ThreadRecord } from '../src/core/crew/types';
import type { AgentBackend } from '../src/core/types';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}` : ''}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-test-'));
const root = path.join(tmp, 'crew');
const now = Date.now();
const thread = (o: Partial<ThreadRecord>): ThreadRecord => ({ id: newId('t'), botId: null, engine: 'CLAUDE', chatId: null, kind: 'dm', roomId: null, jobId: null, seen: 0, setupKey: null, createdAt: now, updatedAt: now, ...o });
const bot = (o: Partial<BotProfile>) => normalizeBot(o, o.id ?? newId('b'));

async function main() {
  // ------------------------------------------------------------------ store
  console.log('store');
  const store = new CrewStore(root);
  check('no crew.json yet', !store.exists());
  check('schema migration creates crew.json', migrateSchema(store).length === 0 && store.exists() && store.settings().schema === CREW_SCHEMA);
  const ada = bot({ name: 'Ada Lovelace', title: 'planner', engine: 'CLAUDE', access: 'talk' });
  store.putBot(ada);
  store.setSoul(ada.id, 'x'.repeat(30_000));
  check('bot names are one word', store.bot(ada.id)?.name === 'AdaLovelace');
  check('SOUL.md is capped at 24 KB', Buffer.byteLength(store.soul(ada.id)) === 24 * 1024);
  store.setSoul(ada.id, 'You are Ada, a terse planner.');
  fs.mkdirSync(path.join(root, 'bots', 'hand'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bots', 'hand', 'bot.json'), JSON.stringify({ name: 'Hand', engine: 'NOPE', access: 'root', color: 'red', chattiness: 900 }));
  const hand = store.bot('hand')!;
  check('a hand-edited bot is normalized', hand.engine === 'CLAUDE' && hand.access === 'edit' && hand.color === '#6366F1' && hand.chattiness === 100, hand);
  store.deleteBot('hand');
  const t1 = thread({ botId: ada.id, chatId: 'chat-1' });
  store.putThread(t1);
  check('threads by id and by chat', store.thread(t1.id)?.chatId === 'chat-1' && store.threadByChat('CLAUDE', 'chat-1')?.id === t1.id);
  const secret = store.secret();
  check('secret is 32 bytes, private, outside the crew folder', secret.length === 32 && (fs.statSync(`${root}.secret`).mode & 0o777) === 0o600 && !fs.existsSync(path.join(root, 'secret')));
  check('secret is stable', store.secret().equals(secret));
  fs.writeFileSync(path.join(root, 'crew.json'), JSON.stringify({ schema: CREW_SCHEMA + 1 }));
  let threw = false;
  try {
    migrateSchema(store);
  } catch {
    threw = true;
  }
  check('a newer schema is refused, not overwritten', threw && store.settings().schema === CREW_SCHEMA + 1);
  // schema 1 → 2: a room saved in the old natural mode ('mentions') answers in 'auto' mode; real modes stay
  fs.writeFileSync(path.join(root, 'crew.json'), JSON.stringify({ schema: 1 }));
  store.putRoom(normalizeRoom({ name: 'Old natural', mode: 'mentions' }, 'r_old'));
  store.putRoom(normalizeRoom({ name: 'Old everyone', mode: 'everyone' }, 'r_old2'));
  const ran = migrateSchema(store);
  check('schema 1 → 2: old natural rooms become auto', ran.join() === '1' && store.room('r_old')?.mode === 'auto' && store.room('r_old2')?.mode === 'everyone' && store.settings().schema === CREW_SCHEMA);
  store.deleteRoom('r_old');
  store.deleteRoom('r_old2');
  fs.writeFileSync(path.join(root, 'crew.json'), JSON.stringify({ schema: CREW_SCHEMA }));

  // ------------------------------------------------------------------ groups migration
  console.log('groups migration');
  const groupsDir = path.join(tmp, 'groups');
  const g1 = {
    title: 'Design talk',
    topic: 'The new settings page',
    mode: 'natural',
    project: null,
    maxBotTurns: 4,
    autoTalk: true,
    idleSeconds: 90,
    moderatorAgent: 'CODEX',
    moderatorChatId: 'mod-chat',
    moderatorSeen: 2,
    bots: [
      { id: 'gb1', name: 'Max', agent: 'CLAUDE', persona: 'A cheerful designer.', emoji: '🎨', color: '#FF0000', chattiness: 70, access: 'chat', effort: 'low', muted: false, chatId: 'max-chat', seen: 3 },
      { id: 'gb2', name: 'Rex', agent: 'CODEX', persona: 'A grumpy reviewer.', emoji: '🦖', color: '#00FF00', chattiness: 20, access: 'edit', effort: 'default', muted: true, chatId: null, seen: 0 },
    ],
    messages: [
      { id: 'm1', from: 'user', name: 'You', text: 'Hi all', at: 1, attachments: [] },
      { id: 'm2', from: 'gb1', name: 'Max', text: 'Hello!', at: 2, attachments: [] },
      { id: 'm3', from: 'system', name: '', text: 'Rex joined.', at: 3, attachments: [] },
    ],
    createdAt: 100,
    updatedAt: 200,
  };
  const g2 = { ...g1, title: 'Second', bots: [g1.bots[0]], messages: [], moderatorChatId: null };
  for (const [id, g] of [
    ['g1', g1],
    ['g2', g2],
  ] as const) {
    fs.mkdirSync(path.join(groupsDir, id, 'room'), { recursive: true });
    fs.writeFileSync(path.join(groupsDir, id, 'group.json'), JSON.stringify(g));
  }
  fs.writeFileSync(path.join(groupsDir, 'g1', 'room', 'notes.txt'), 'room file');
  fs.mkdirSync(path.join(groupsDir, 'broken'));
  const m = migrateGroups(store, groupsDir);
  check('two rooms, two new bots, the shared bot reused, a broken group skipped', m.rooms.length === 2 && m.bots.length === 2 && m.reused.length === 1 && m.skipped.includes('broken'), m);
  const r1 = store.room('g1')!;
  const max = store.bots().find((b) => b.name === 'Max')!;
  const rex = store.bots().find((b) => b.name === 'Rex')!;
  check('room fields', r1.name === 'Design talk' && r1.bulletin === 'The new settings page' && r1.mode === 'auto' && r1.maxBotTurns === 4 && r1.autoTalk.on && r1.autoTalk.idleSeconds === 90 && r1.fromGroup === 'g1', r1);
  check('members, lead and holds', r1.members.join() === [max.id, rex.id].join() && r1.lead === max.id && r1.holds[rex.id] === true && !r1.holds[max.id]);
  check('bot fields (chat → talk, persona → SOUL.md)', max.access === 'talk' && rex.access === 'edit' && max.emoji === '🎨' && max.effort === 'low' && store.soul(max.id) === 'A cheerful designer.');
  const lines = store.transcript('g1');
  check('transcript copied with bot ids mapped', lines.length === 3 && lines[1].from === max.id && lines[0].from === 'user' && lines[2].from === 'system', lines);
  const ths = store.threads().filter((t) => t.roomId === 'g1');
  check('bot chat → room thread (goes on where it was), moderator → router thread', ths.some((t) => t.kind === 'room' && t.chatId === 'max-chat' && t.seen === 3 && t.botId === max.id) && ths.some((t) => t.kind === 'router' && t.chatId === 'mod-chat' && t.engine === 'CODEX'), ths);
  check('the room folder came along', fs.readFileSync(path.join(store.roomFolder('g1'), 'notes.txt'), 'utf8') === 'room file');
  check('groups folder untouched', fs.existsSync(path.join(groupsDir, 'g1', 'group.json')));
  const again = migrateGroups(store, groupsDir);
  check('a second run copies nothing twice', again.rooms.length === 0 && again.bots.length === 0 && store.bots().filter((b) => b.name === 'Max').length === 1, again);

  // ------------------------------------------------------------------ identity
  console.log('identity');
  const id = new CrewIdentity(secret);
  const other = new CrewIdentity(Buffer.alloc(32, 7));
  check('cap verifies only for its thread and secret', id.verify(t1.id, id.cap(t1.id)) && !id.verify('t_other', id.cap(t1.id)) && !other.verify(t1.id, id.cap(t1.id)));
  const lookup = {
    thread: (x: string) => store.thread(x),
    threadByEngineChat: (engine: string, chat: string) => store.threads().find((t) => t.engine === engine && t.chatId === chat) ?? null,
  };
  const q = (o: Record<string, string>) => new URLSearchParams(o);
  let r = id.resolve(q({ t: t1.id, cap: id.cap(t1.id) }), null, {}, lookup);
  check('outside a turn: refused', 'error' in r && /no turn/.test(r.error), r);
  id.beginTurn(t1.id);
  r = id.resolve(q({ t: t1.id, cap: id.cap(t1.id) }), null, {}, lookup);
  check('in a turn: the thread', 'thread' in r && r.thread.id === t1.id, r);
  r = id.resolve(q({ t: t1.id, cap: 'f'.repeat(32) }), null, {}, lookup);
  check('wrong cap: refused', 'error' in r);
  id.endTurn(t1.id);
  check('just ended: still allowed (grace)', id.inTurn(t1.id));
  check('after the grace: refused', !id.inTurn(t1.id, Date.now() + GRACE_MS + 1));
  const oc = thread({ botId: ada.id, engine: 'OPENCODE', chatId: 'ses_abc' });
  store.putThread(oc);
  id.beginTurn(oc.id);
  r = id.resolve(q({ engine: 'opencode' }), { 'ai.opencode/sessionID': 'ses_abc' }, {}, lookup);
  check('OpenCode: the caller from _meta', 'thread' in r && r.thread.id === oc.id, r);
  r = id.resolve(q({ engine: 'opencode' }), { 'ai.opencode/sessionID': 'ses_users_own_chat' }, {}, lookup);
  check('OpenCode: a normal chat is refused', 'error' in r && /only for AntiGem Crew bots/.test(r.error), r);
  r = id.resolve(q({ engine: 'opencode' }), null, { cap: id.argCap(oc.id) }, lookup);
  check('OpenCode: a cap argument does not replace _meta', 'error' in r);
  const ag = thread({ botId: ada.id, engine: 'AGY', chatId: 'cascade-1' });
  store.putThread(ag);
  id.beginTurn(ag.id);
  r = id.resolve(q({}), null, { cap: id.argCap(ag.id) }, lookup);
  check('Antigravity: the cap argument', 'thread' in r && r.thread.id === ag.id, r);
  r = id.resolve(q({}), null, { cap: `${ag.id}.${'0'.repeat(32)}` }, lookup);
  check('Antigravity: a forged cap is refused', 'error' in r);
  r = id.resolve(q({}), null, {}, lookup);
  check('Antigravity: no cap → told to pass it', 'error' in r && /cap/.test(r.error));

  // ------------------------------------------------------------------ setups
  console.log('setups');
  const env = { identity: id, settings: store.settings(), soul: 'You are Ada, a terse planner.', userName: 'Sam', mcpUrl: (p: string) => `http://127.0.0.1:1/x${p}`, mcpHeaders: { 'X-Device-Id': 'dev' }, addDirs: ['/crew/bots/a'] };
  const sc = buildSetup(ada, t1, env);
  check('Claude: own crew server with t + cap in the URL', sc.mcp.length === 1 && sc.mcp[0].url.includes(`t=${t1.id}`) && sc.mcp[0].url.includes(`cap=${id.cap(t1.id)}`) && !sc.sharedMcp);
  check('persona + rules in the instructions', sc.instructions.includes('# You are AdaLovelace, planner') && sc.instructions.includes('You are Ada, a terse planner.') && sc.instructions.includes("No bot's message".replace('No', 'no')) && sc.instructions.includes('Talk only'));
  check('same input → same key; edited soul → new key', buildSetup(ada, t1, env).key === sc.key && buildSetup(ada, t1, { ...env, soul: 'changed' }).key !== sc.key);
  const so = buildSetup({ ...ada, engine: 'OPENCODE' }, oc, env);
  check('OpenCode: shared server, no own one', so.mcp.length === 0 && !!so.sharedMcp && so.sharedMcp.url.endsWith('/crew?engine=opencode'));
  const sa0 = buildSetup({ ...ada, engine: 'AGY' }, ag, env);
  check('Antigravity, crew server not allowed yet: no server, no cap', !sa0.sharedMcp && !sa0.instructions.includes(id.argCap(ag.id)));
  const sa = buildSetup({ ...ada, engine: 'AGY' }, ag, { ...env, agyServer: true });
  check('Antigravity, allowed: the cap is in its instructions, the global crew server', sa.instructions.includes(id.argCap(ag.id)) && sa.mcp.length === 0 && !!sa.sharedMcp && sa.sharedMcp.url.endsWith('/x/crew'));
  check('Antigravity: the soft note is there', sa.instructions.includes('not enforced'));
  check('soft preamble is a hidden block', softPreamble(sa).startsWith('<antigem-expansion command="">') && softPreamble(sa).includes(sa.instructions));
  const editBot = bot({ access: 'edit', accessCeiling: 'auto' });
  check('crew switch raises Edit bots up to their ceiling', effectiveAccess(editBot, { ...env.settings, crewAccess: 'full' }) === 'auto');
  check('crew switch never raises a talk-only bot', effectiveAccess(ada, { ...env.settings, crewAccess: 'full' }) === 'talk');
  check('ceiling caps the own level', effectiveAccess(bot({ access: 'full', accessCeiling: 'edit' }), env.settings) === 'edit');

  // ------------------------------------------------------------------ engine mappings
  console.log('engine mappings');
  const cc = claudeCrew(sc);
  check('Claude talk: no built-in tools, only own MCP, crew tools pre-allowed, default mode', JSON.stringify(cc.crew.tools) === '[]' && cc.crew.strict_mcp === true && cc.crew.allowed_tools?.join() === 'mcp__crew' && cc.permissionMode === 'default' && cc.crew.append_system_prompt === sc.instructions && cc.crew.key === sc.key);
  const cr = claudeCrew({ ...sc, access: 'read', onlyOwnMcp: false });
  check('Claude read: read tools only, allowed without asking', cr.crew.tools?.join() === CLAUDE_READ_TOOLS.join() && CLAUDE_READ_TOOLS.every((t) => cr.crew.allowed_tools?.includes(t)) && !cr.crew.strict_mcp);
  const ce = claudeCrew({ ...sc, access: 'edit' });
  check('Claude edit: all tools, acceptEdits', ce.crew.tools === undefined && ce.permissionMode === 'acceptEdits');
  check('Claude full → auto (broker in Phase 4)', claudeCrew({ ...sc, access: 'full' }).permissionMode === 'auto');
  const cx = codexThreadParams(sc);
  const crewCfg = (cx.config as any).mcp_servers.crew;
  check('Codex talk: read-only, never asks, developerInstructions, MCP approved', cx.sandbox === 'read-only' && cx.approvalPolicy === 'never' && cx.developerInstructions === sc.instructions && crewCfg.default_tools_approval_mode === 'approve' && crewCfg.http_headers['X-Device-Id'] === 'dev');
  check('Codex edit: workspace-write, asks to leave the sandbox', codexThreadParams({ ...sc, access: 'edit' }).sandbox === 'workspace-write' && codexThreadParams({ ...sc, access: 'edit' }).approvalPolicy === 'on-request' && (codexSandboxPolicy('edit') as any).type === 'workspaceWrite');
  check('Codex persona update context', JSON.stringify(codexPersonaContext(sc)).includes('application'));
  check('OpenCode agent id', opencodeAgentId(so) === `crew-${oc.id}`);
  const talkRules = opencodeRules('talk', []);
  check('OpenCode talk: deny everything, allow crew tools (last wins)', talkRules[0].action === '*' && talkRules[0].effect === 'deny' && talkRules.at(-1)!.action === 'antigem_crew_*' && talkRules.at(-1)!.effect === 'allow');
  const readRules = opencodeRules('read', ['/crew/bots/a']);
  check('OpenCode read: read tools + its crew folder', ['read', 'glob', 'grep', 'webfetch', 'websearch'].every((a) => readRules.some((x) => x.action === a && x.effect === 'allow')) && readRules.some((x) => x.action === 'external_directory' && x.resource === '/crew/bots/a/*') && !readRules.some((x) => x.action === 'edit' || x.action === 'shell'));
  check('OpenCode edit: shell asks', opencodeRules('edit', []).some((x) => x.action === 'shell' && x.effect === 'ask'));
  const agent = opencodeAgent(so);
  check('OpenCode agent: hidden, primary, system = instructions', agent.hidden && agent.mode === 'primary' && agent.system === so.instructions);

  // ------------------------------------------------------------------ crew_mcp over HTTP
  console.log('crew_mcp');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const mcp = new McpHost({ port, deviceId: 'dev', log: () => undefined });
  const tess = bot({ name: 'Tess', title: 'tester', engine: 'CODEX', model: 'gpt-6-luna', description: 'Runs the tests.' });
  store.putBot(tess);
  const backends: Partial<Record<string, AgentBackend>> = { OPENCODE: { externalId: (c: string) => (c === 'view-uuid' ? 'ses_mapped' : c) } as unknown as AgentBackend };
  const crew = new Crew({ backend: (k) => backends[k], mcpUrl: (p) => mcp.url(p), mcpHeaders: () => mcp.headers(), userName: () => 'Sam' }, root);
  mcp.register(crew.mcp());
  check('MCP host listens', await mcp.start());
  const ct = thread({ botId: ada.id, engine: 'CLAUDE', chatId: 'c-2' });
  crew.store.putThread(ct);
  const setup = crew.setupFor(ct);
  const url = setup.mcp[0].url;
  const rpc = async (u: string, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = mcp.headers()) => {
    const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return res.status === 200 ? ((await res.json()) as any) : { status: res.status };
  };
  const init = await rpc(url, 'initialize');
  check('initialize', init.result?.serverInfo?.name === 'crew_mcp');
  const list = await rpc(url, 'tools/list');
  const names = (list.result?.tools ?? []).map((t: any) => t.name).join();
  check('tools/list: the crew tools (no crew_manage for a non-Chief), none with a cap argument', names === 'crew_roster,crew_assign,crew_answer,crew_jobs,crew_report,crew_memory,crew_later,crew_automation,crew_thread' && list.result.tools.every((t: any) => !t.inputSchema.properties.cap), names);
  const agyList = await rpc(mcp.url('/crew'), 'tools/list');
  check('the global (Antigravity) server asks for cap in every tool', agyList.result?.tools?.length === 10 && agyList.result.tools.every((t: any) => t.inputSchema.properties.cap && t.inputSchema.required?.includes('cap')));
  let call = await rpc(url, 'tools/call', { name: 'crew_roster', arguments: {} });
  check('roster outside a turn: refused', call.result?.isError === true, call);
  crew.identity.beginTurn(ct.id);
  call = await rpc(url, 'tools/call', { name: 'crew_roster', arguments: {} });
  const out = call.result?.content?.[0]?.text ?? '';
  check('roster in a turn: you, the user, teammates, rooms', !call.result?.isError && out.includes('You: @AdaLovelace — planner') && out.includes('The user: Sam') && out.includes('@Tess — tester (Codex · gpt-6-luna)') && out.includes('@Max'), out);
  const noDev = await rpc(url, 'tools/call', { name: 'crew_roster', arguments: {} }, {});
  check('without X-Device-Id: 401', noDev.status === 401);
  const oct = thread({ botId: tess.id, engine: 'OPENCODE', chatId: 'view-uuid' });
  crew.store.putThread(oct);
  crew.identity.beginTurn(oct.id);
  const ocSetup = crew.setupFor(oct);
  call = await rpc(ocSetup.sharedMcp!.url, 'tools/call', { name: 'crew_roster', arguments: {}, _meta: { 'ai.opencode/sessionID': 'ses_mapped' } });
  check('OpenCode call: the session id maps to the view chat through externalId', (call.result?.content?.[0]?.text ?? '').startsWith('You: @Tess'), call);
  mcp.stop();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
