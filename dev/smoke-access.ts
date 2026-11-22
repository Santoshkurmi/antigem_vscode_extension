// Live smoke of Crew Phase 4 (Access & Inbox) with real agents on small models: approvals from three bots land in one
// Inbox at once (an outward `git push` in a throwaway git repo with no remote, so nothing can leave), Allow / Deny with
// a note / Always reach the agents, and talk-only bots cannot create files (Claude: no tools; Codex: read-only
// sandbox).
//   npx esbuild dev/smoke-access.ts --bundle --platform=node --outfile=/tmp/crew-smoke/access.js
//   node /tmp/crew-smoke/access.js        (from the repo root)
// Ports: bridge 1254, MCP 1256 (no hub). Every chat it makes is deleted; launched-binary.json is put back.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind } from '../shared/model';
import { BridgeManager, cliPathArgs } from '../src/core/bridge/BridgeManager';
import { ClaudeBackend } from '../src/core/claude/ClaudeBackend';
import { CodexBackend } from '../src/core/codex/CodexBackend';
import { McpHost } from '../src/core/mcp/server';
import { CrewEngine } from '../src/core/crew/engine';
import { RoomEngine } from '../src/core/crew/rooms/engine';
import type { AgentBackend, KeyValueStore, SendRequest } from '../src/core/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-access-live-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo, { recursive: true });
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
git('init', '-q');
fs.writeFileSync(path.join(repo, 'README.md'), 'test\n');
git('add', '.');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
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
const kvData: Record<string, unknown> = {};
const kv: KeyValueStore = { get: <T>(k: string) => kvData[k] as T | undefined, set: (k, v) => void (kvData[k] = v) };
const LAUNCHED = path.join(os.homedir(), '.antigem_bridge', 'launched-binary.json');
const launchedBefore = fs.existsSync(LAUNCHED) ? fs.readFileSync(LAUNCHED, 'utf8') : null;
const bridge = new BridgeManager({
  binPath: path.resolve('bin/antigem-bridge-linux-x64'),
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
const raw: Partial<Record<AgentKind, AgentBackend>> = { CLAUDE: new ClaudeBackend(bridge, kv, log, opts as any), CODEX: new CodexBackend(bridge, kv, log, opts as any) };
const sent: { kind: AgentKind; chat: string }[] = [];
const backends: Partial<Record<AgentKind, AgentBackend>> = {};
for (const [k, be] of Object.entries(raw) as [AgentKind, AgentBackend][]) {
  backends[k] = new Proxy(be, {
    get(t, p, r) {
      if (p === 'send')
        return (req: SendRequest) => {
          sent.push({ kind: k, chat: req.conversationId });
          return t.send(req);
        };
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}
const mcp = new McpHost({ port: 1256, deviceId: randomBytes(16).toString('hex'), log });
const crew = new CrewEngine({ mcpUrl: (p) => mcp.url(p), mcpHeaders: () => mcp.headers(), root: path.join(tmp, 'crew'), groupsDir: path.join(tmp, 'none') });
const toasts: string[] = [];
crew.bind({
  backend: (k) => backends[k],
  enabledKinds: () => ['CLAUDE', 'CODEX'],
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => repo,
  showChat: () => undefined,
  postActive: () => undefined,
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  openFile: () => undefined,
  notify: (t) => toasts.push(t),
  log,
});
mcp.register(crew.crew.mcp());
const rooms = new RoomEngine(crew.rooms);
crew.onPause = (ids) => rooms.pauseBots(ids);
rooms.bind({
  backend: (k) => backends[k],
  enabledKinds: () => ['CLAUDE', 'CODEX'],
  conversations: () => Object.values(raw).flatMap((b) => b!.conversations()),
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => repo,
  showChat: () => undefined,
  postActive: () => undefined,
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  log: (l) => log(`[rooms] ${l}`),
  crew: () => crew.roomApi(),
});

async function waitOnline(kind: AgentKind) {
  raw[kind]!.start();
  for (let i = 0; i < 120; i++) {
    if (raw[kind]!.status().state === 'online') return true;
    await sleep(500);
  }
  return false;
}
async function settle(id: string, ms = 300_000) {
  const end = Date.now() + ms;
  await sleep(600);
  while (Date.now() < end) {
    if (!(rooms as any).isBusy(id)) return;
    await sleep(500);
  }
  say('  (room still busy)');
}

async function main() {
  say(`log: ${logFile}`);
  check('crew MCP host on 1256', await mcp.start());
  await bridge.ensureRunning();
  for (const k of ['CLAUDE', 'CODEX'] as AgentKind[]) check(`${k} online`, await waitOnline(k));
  try {
    const soul = (n: string) => `You are ${n}. You do exactly what the user asks, using your tools, then reply in one short sentence.`;
    const mk = (f: Record<string, unknown>) => crew.createBot({ chattiness: 0, ...f, soul: soul(String(f.name)) });
    const ada = mk({ name: 'Ada', agent: 'CLAUDE', modelId: 'haiku', access: 'edit' });
    const bea = mk({ name: 'Bea', agent: 'CLAUDE', modelId: 'haiku', access: 'edit' });
    const cleo = mk({ name: 'Cleo', agent: 'CLAUDE', modelId: 'haiku', access: 'full' });
    const g = rooms.create({ title: 'Release', userName: 'Sam' });
    for (const b of [ada, bea, cleo]) rooms.addMember(g.id, b.id);
    rooms.update(g.id, { mode: 'everyone', drafting: 'parallel' });

    say('\nthree bots ask to `git push` (outward: asks at every level)');
    rooms.post(g.id, `Each of you, now: run exactly \`git push\` in ${repo} with your Bash tool (this repo has no remote, so it will just fail; that is fine) and reply with its first output line.`);
    let max = 0;
    const end = Date.now() + 240_000;
    while (Date.now() < end) {
      const n = crew.inbox.items().filter((i) => i.kind === 'approval').length;
      max = Math.max(max, n);
      if (n >= 3) break;
      if (!(rooms as any).isBusy(g.id)) break;
      await sleep(500);
    }
    const items = crew.inbox.items().filter((i) => i.kind === 'approval');
    for (const i of items) say(`    Inbox: ${i.bot?.name}: ${i.title} — ${i.why}`);
    check('approvals from three bots in one Inbox at once', new Set(items.map((i) => i.bot?.name)).size === 3 && items.every((i) => i.outward), { max, items: items.map((i) => [i.bot?.name, i.title]) });
    check('a toast for each', toasts.filter((t) => /needs you/.test(t)).length >= items.length);
    const of = (n: string) => items.find((i) => i.bot?.name === n);
    if (of('Ada')) await crew.handle('v', () => undefined, { type: 'inboxAnswer', id: of('Ada')!.id, choice: 'allow' });
    if (of('Bea')) await crew.handle('v', () => undefined, { type: 'inboxAnswer', id: of('Bea')!.id, choice: 'deny', note: 'no pushing today' });
    if (of('Cleo')) await crew.handle('v', () => undefined, { type: 'inboxAnswer', id: of('Cleo')!.id, choice: 'allow_always' });
    await settle(g.id);
    const cur = rooms.find(g.id)!;
    for (const m of cur.messages.filter((x) => cur.bots.some((b) => b.id === x.from))) say(`    ${m.name}: ${m.text.replace(/\s+/g, ' ').slice(0, 160)}${m.digest ? ` {${m.digest}}` : ''}`);
    const said = (id: string) => cur.messages.filter((m) => m.from === id).map((m) => m.text).join(' ');
    check('allowed: Ada ran it (git says there is no push destination)', /destination|remote|fatal|no configured/i.test(said(ada.id)), said(ada.id));
    check('denied with a note: Bea did not run it and knows why', !/no configured push destination/i.test(said(bea.id)) && said(bea.id).length > 0, said(bea.id));
    check('"always" saved for Cleo only', crew.inbox.broker.rules(cleo.id).includes('Bash(git push)') && !crew.inbox.broker.rules(ada.id).length);
    check('the Inbox is empty', crew.inbox.items().length === 0);

    say('\ntalk-only bots cannot create files');
    const tim = mk({ name: 'Tim', agent: 'CLAUDE', modelId: 'haiku', access: 'talk' });
    const tess = mk({ name: 'Tess', agent: 'CODEX', effort: 'low', access: 'talk' });
    const g2 = rooms.create({ title: 'Quiet', userName: 'Sam' });
    for (const b of [tim, tess]) rooms.addMember(g2.id, b.id);
    rooms.update(g2.id, { mode: 'everyone', drafting: 'parallel' });
    rooms.post(g2.id, `Each of you: create the file ${path.join(repo, 'NOTE-<your name>.md')} containing "hello", using your tools, then say whether it worked.`);
    await settle(g2.id);
    const c2 = rooms.find(g2.id)!;
    for (const m of c2.messages.filter((x) => c2.bots.some((b) => b.id === x.from))) say(`    ${m.name}: ${m.text.replace(/\s+/g, ' ').slice(0, 160)}${m.digest ? ` {${m.digest}}` : ''}`);
    const notes = fs.readdirSync(repo).filter((f) => /^NOTE/i.test(f));
    check('no file was created (Claude: no tools; Codex: read-only sandbox)', notes.length === 0, notes);
    check('nothing asked the Inbox (refused by the engine or the level)', crew.inbox.items().length === 0);
  } catch (e) {
    check('no crash', false, String((e as Error)?.stack ?? e));
  }
  rooms.dispose();
  crew.dispose();
  await sleep(1500);
  const chats = new Set<string>();
  for (const t of crew.crew.store.threads()) if (t.chatId) chats.add(`${t.engine}|${t.chatId}`);
  for (const s of sent) chats.add(`${s.kind}|${s.chat}`);
  for (const c of chats) {
    const [k, id] = c.split('|') as [AgentKind, string];
    await raw[k]?.conversationAction(id, 'delete').catch(() => undefined);
  }
  say(`  deleted ${chats.size} chats`);
  await bridge.shutdown().catch(() => undefined);
  mcp.stop();
  if (launchedBefore !== null) fs.writeFileSync(LAUNCHED, launchedBefore);
  say(`\n${failures ? `${failures} FAILED` : 'all passed'} (log ${logFile})`);
  process.exit(failures ? 1 : 0);
}

process.on('SIGINT', () => {
  if (launchedBefore !== null) fs.writeFileSync(LAUNCHED, launchedBefore);
  process.exit(130);
});
void main();
