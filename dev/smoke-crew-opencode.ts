// Live smoke of Crew Phase 0 on OpenCode without a paid / rate-limited model: the real OpenCode server, bridge and
// OpenCodeBackend, with a fake OpenAI-compatible model that records what OpenCode sends it (system prompt, tool list)
// and always calls the crew roster tool. Checks the bot runs as its hidden agent (persona in the system prompt,
// talk-only = no tools but crew tools), crew_mcp knows the caller from OpenCode's _meta, an edited persona reaches the
// same chat, and a normal chat does not get the crew tools.
// Run it with a temporary HOME (the bridge's OpenCode config, custom provider and csrf token stay in there):
//   (cd bridge && CGO_ENABLED=0 go build -o /tmp/crew-smoke/antigem-bridge-linux-x64 .)
//   npx esbuild dev/smoke-crew-opencode.ts --bundle --platform=node --outfile=/tmp/crew-smoke/smoke-oc.js
//   H=$(mktemp -d) && HOME=$H CREW_OC_BIN=~/.opencode/bin/opencode node /tmp/crew-smoke/smoke-oc.js; rm -rf $H
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/model';
import { BridgeManager } from '../src/core/bridge/BridgeManager';
import { OpenCodeBackend } from '../src/core/opencode/OpenCodeBackend';
import { McpHost, type McpServerDef } from '../src/core/mcp/server';
import { Crew } from '../src/core/crew/crew';
import { newId, normalizeBot } from '../src/core/crew/store/store';
import type { ThreadRecord } from '../src/core/crew/types';
import type { ChatState, KeyValueStore, SendRequest } from '../src/core/types';

if (!os.homedir().startsWith(os.tmpdir())) {
  console.error('Run this with HOME set to a temporary folder (see the header).');
  process.exit(2);
}
const home = os.homedir();
const logFile = path.join(home, 'smoke.log');
const log = (l: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${l}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  const line = `  ${ok ? '✓' : '✗'} ${name}${!ok && detail !== undefined ? ` — ${typeof detail === 'string' ? detail.slice(0, 600) : JSON.stringify(detail).slice(0, 600)}` : ''}`;
  console.log(line);
  log(line);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the fake model
const requests: { system: string; tools: string[]; toolResult: string | null }[] = [];
const fake = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (!req.url?.includes('chat/completions')) return void res.writeHead(404).end();
  const b = JSON.parse(body);
  const system = b.messages
    .filter((m: any) => m.role === 'system')
    .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
  const tools: string[] = (b.tools ?? []).map((t: any) => t.function?.name).filter(Boolean);
  const tool = [...b.messages].reverse().find((m: any) => m.role === 'tool' || m.role === 'user');
  const toolResult = tool?.role === 'tool' ? String(tool.content) : null;
  requests.push({ system, tools, toolResult });
  const roster = tools.find((n) => n.includes('crew_roster'));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: b.model };
  if (!toolResult && roster) {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: roster, arguments: '{}' } }] }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    const text = toolResult ? `Tool said: ${toolResult.slice(0, 300)}` : `No roster tool (tools: ${tools.join(', ')})`;
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  }
  res.end('data: [DONE]\n\n');
});

const kvData: Record<string, unknown> = {};
const kv: KeyValueStore = { get: <T>(k: string) => kvData[k] as T | undefined, set: (k, v) => void (kvData[k] = v) };
const bridge = new BridgeManager({
  binPath: process.env.CREW_SMOKE_BRIDGE ?? '/tmp/crew-smoke/antigem-bridge-linux-x64',
  port: 1254,
  hubPort: 1255,
  workspaceDir: home,
  extraArgs: () => ['--opencode-bin', process.env.CREW_OC_BIN ?? path.join(os.userInfo().homedir, '.opencode', 'bin', 'opencode')],
  agentFlags: () => ['--no-hub', '--no-claude', '--no-codex'],
  logFile: path.join(home, 'bridge.log'),
  log,
});
const oc = new OpenCodeBackend(bridge, kv, log, { openUrl: () => undefined } as any);
const mcp = new McpHost({ port: 1256, deviceId: randomBytes(16).toString('hex'), log });
const crew = new Crew({ backend: (k) => (k === 'OPENCODE' ? oc : undefined), mcpUrl: (p) => mcp.url(p), mcpHeaders: () => mcp.headers(), userName: () => 'Sam' }, path.join(home, 'crew'));
const calls = new Map<string, number>();
const base = crew.mcp();
mcp.register({
  ...base,
  resolve: async (q) => {
    const d = (await base.resolve!(q)) as McpServerDef;
    return {
      ...d,
      call: async (name, args, ctx) => {
        const r = await d.call(name, args, ctx);
        const tid = crew.lookup.threadByEngineChat('OPENCODE', String(ctx?.meta?.['ai.opencode/sessionID'] ?? ''))?.id ?? '?';
        if (!r.isError) calls.set(tid, (calls.get(tid) ?? 0) + 1);
        log(`[crew] ${name} from ${tid}: ${r.isError ? 'ERROR ' : ''}${JSON.stringify(r.content).slice(0, 300)}`);
        return r;
      },
    };
  },
});

function lastReply(msgs: ChatMessage[]): string {
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i].role !== 'USER') i--;
  return msgs
    .slice(i + 1)
    .filter((m) => m.role === 'ASSISTANT')
    .map((m) => m.content)
    .join('\n');
}

async function run(chatId: string, req: Omit<SendRequest, 'conversationId'>, threadId: string | null): Promise<string> {
  let state: ChatState | null = null;
  const unsub = oc.subscribe(chatId, (s) => (state = s));
  if (threadId) crew.identity.beginTurn(threadId);
  try {
    await oc.send({ conversationId: chatId, ...req });
    const started = Date.now();
    let quiet = 0;
    for (;;) {
      await sleep(400);
      const s = state as ChatState | null;
      if (s && !s.isStreaming && lastReply(s.messages).trim()) {
        quiet ||= Date.now();
        if (Date.now() - quiet > 1200) break;
      } else quiet = 0;
      if (Date.now() - started > 90_000) throw new Error(`turn timed out (${(state as ChatState | null)?.error ?? 'no error'})`);
    }
    return lastReply((state as ChatState | null)?.messages ?? []);
  } finally {
    if (threadId) crew.identity.endTurn(threadId);
    unsub();
  }
}

async function main() {
  console.log(`log: ${logFile}`);
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  check('crew MCP host on 1256', await mcp.start());
  await bridge.ensureRunning();
  const prov = await bridge.json<any>('/api/opencode/custom-providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Fake', kind: 'openai', base_url: fakeUrl, models: [{ id: 'm1', name: 'm1' }] }) });
  check('fake provider added', prov?.success === true, prov);
  const model = `${prov?.provider?.id ?? 'fake'}/m1`;
  oc.start();
  for (let i = 0; i < 120 && oc.status().state !== 'online'; i++) await sleep(500);
  check('OpenCode online', oc.status().state === 'online', oc.status());

  const room = crew.store.roomFolder('smoke');
  const olga = normalizeBot({ name: 'Olga', title: 'researcher', engine: 'OPENCODE', access: 'talk', model }, newId('b'));
  crew.store.putBot(olga);
  crew.store.setSoul(olga.id, 'You are Olga, a calm researcher who loves maps.');
  const th: ThreadRecord = { id: newId('t'), botId: olga.id, engine: 'OPENCODE', chatId: randomUUID(), kind: 'dm', roomId: null, jobId: null, seen: 0, setupKey: null, createdAt: Date.now(), updatedAt: Date.now() };
  crew.store.putThread(th);

  console.log('\nOlga on OpenCode (talk)');
  let reply = await run(th.chatId!, { isNew: true, text: 'Who is on your team?', attachments: [], modelId: model, workspaceUri: `file://${room}`, setup: crew.setupFor(th) }, th.id);
  log(`[smoke] Olga said: ${reply}`);
  const first = requests.filter((r) => r.system.includes('Olga'));
  check('persona: the hidden agent’s system prompt reached the model', first.length > 0 && first[0].system.includes('You are Olga, a calm researcher who loves maps.'), requests.map((r) => r.system.slice(0, 120)));
  const tools = first[0]?.tools ?? [];
  check('talk-only: no tools but crew tools (skill is OpenCode’s read-only one)', tools.includes('antigem_crew_roster') && tools.every((t) => t.startsWith('antigem_crew_') || t === 'skill'), tools);
  check('crew_roster answered as Olga (caller from _meta)', (calls.get(th.id) ?? 0) > 0 && reply.includes('You: @Olga'), { calls: Object.fromEntries(calls), reply });

  crew.store.setSoul(olga.id, 'You are Olga, now a sharp-tongued critic who hates maps.');
  const before = calls.get(th.id) ?? 0;
  const n = requests.length;
  reply = await run(th.chatId!, { isNew: false, text: 'And now?', attachments: [], modelId: null, workspaceUri: null, setup: crew.setupFor(th) }, th.id);
  const later = requests.slice(n).filter((r) => r.system.includes('Olga'));
  check('edited persona reached the same chat (config reload)', later.length > 0 && later[0].system.includes('sharp-tongued critic') && !later[0].system.includes('loves maps'), later.map((r) => r.system.slice(0, 200)));
  check('crew tools still work after the reload', (calls.get(th.id) ?? 0) > before, Object.fromEntries(calls));

  console.log('\nA normal OpenCode chat');
  const m = requests.length;
  const normal = randomUUID();
  reply = await run(normal, { isNew: true, text: 'hello', attachments: [], modelId: model, workspaceUri: `file://${room}` }, null);
  const plain = requests.slice(m).filter((r) => r.tools.length);
  check('it does not get the crew tools', plain.length > 0 && !plain.some((r) => r.tools.some((t) => t.startsWith('antigem_crew_'))), plain.map((r) => r.tools));
  check('it has its normal tools', plain.some((r) => r.tools.includes('read') && r.tools.includes('edit')), plain.map((r) => r.tools));

  await bridge.shutdown();
  mcp.stop();
  fake.close();
  console.log(`\n${failures ? `${failures} failed` : 'all passed'} (log ${logFile})`);
  process.exit(failures ? 1 : 0);
}

void main().catch(async (e) => {
  console.log(`smoke crashed: ${e instanceof Error ? e.stack : String(e)}`);
  await bridge.shutdown().catch(() => undefined);
  process.exit(1);
});
