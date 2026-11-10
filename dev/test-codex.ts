// Headless test of the Codex backend against the running bridge (never stops or restarts it).
//   node esbuild … dev/test-codex.ts → dist/test-codex.js; node dist/test-codex.js [--no-send]
// Read-only: account, models, chat list, a few existing chats (printed as ChatMessages), the settings pages.
// When Codex is signed in (and --no-send is not given): ONE tiny new chat in the scratch workspace, streamed through
// the backend to the end, then deleted. No sign-in, no config writes, no installs; other chats are only read.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/model';
import type { SettingsPage } from '../shared/protocol';
import { BridgeManager } from '../src/core/bridge/BridgeManager';
import { CodexBackend } from '../src/core/codex/CodexBackend';
import type { ChatState, KeyValueStore } from '../src/core/types';

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = '/tmp/claude-1000/-home-cat-agy-cli-hub-antiGem/b3105e30-1c88-43b9-a135-671615f51faa/scratchpad/agy-test-ws';
const stateDir = path.join(os.homedir(), '.antigem-vscode-dev');
const log = (l: string) => console.log(new Date().toISOString().slice(11, 19), l);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_SEND = process.argv.includes('--no-send');

// existing chats with commands, file changes + web search, and a plan (read only)
const SAMPLE_THREADS = ['01a1b6c3-ff31-71e3-bb48-2a6e5ac9c68d', '01a157b9-bf9e-7421-a8b8-7f45dd023a9c', '01a1b6c5-cb17-7fa1-8b7a-aeef73477ad0'];
const BIG_THREAD = '01a14f3b-3c13-7a62-8506-c397b0d8bb31';

// in memory: nothing of the test lands in the dev server's state file
const mem = new Map<string, unknown>([['codex.autoTitle', false]]);
const kv: KeyValueStore = { get: <T>(k: string) => mem.get(k) as T | undefined, set: (k, v) => void mem.set(k, v) };

fs.mkdirSync(WORKSPACE, { recursive: true });
const bridge = new BridgeManager({
  binPath: path.join(ROOT, 'bin', 'antigem-bridge-linux-x64'),
  port: 1244,
  hubPort: 1245,
  workspaceDir: WORKSPACE,
  logFile: path.join(stateDir, 'bridge.log'),
  log,
});

const opened: string[] = [];
const backend = new CodexBackend(bridge, kv, (l) => log(l), { openUrl: (u) => opened.push(u) });
const toasts: string[] = [];
backend.setNotifier((level, message) => {
  toasts.push(`${level}: ${message}`);
  log(`   toast ${level}: ${message}`);
});
let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
};

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n).replace(/\n/g, '⏎')}…(${s.length})` : s.replace(/\n/g, '⏎'));

function printMessages(msgs: ChatMessage[], max = 40) {
  for (const m of msgs.slice(0, max)) {
    const tu = m.tokenUsage ? ` tokens{in ${m.tokenUsage.promptTokens} cached ${m.tokenUsage.cachedTokens} out ${m.tokenUsage.outputTokens} ${m.tokenUsage.durationMs}ms ${m.tokenUsage.model}}` : '';
    console.log(`  [${m.role}] ${m.id.slice(0, 28)} model=${m.modelId ?? '-'} streaming=${m.isStreaming}${tu}`);
    console.log(`     content: ${clip(m.content)}`);
    if (m.thoughtText) console.log(`     thought: ${clip(m.thoughtText, 100)}`);
    for (const a of m.attachments) console.log(`     attachment: ${a.name} image=${a.isImage} b64=${a.base64 ? a.base64.length : 0}`);
    for (const t of m.toolCalls.slice(0, 6))
      console.log(`     tool ${t.toolType} ${t.name} [${t.status}] exit=${t.exitCode ?? '-'} ${t.durationMs ?? '-'}ms: ${clip(t.command, 80)} | out ${clip(t.output, 90)}`);
    if (m.toolCalls.length > 6) console.log(`     … ${m.toolCalls.length - 6} more tools`);
  }
  if (msgs.length > max) console.log(`  … ${msgs.length - max} more messages`);
}

function printPage(p: SettingsPage | null) {
  if (!p) {
    console.log('  (no page)');
    return;
  }
  console.log(`  page ${p.id} "${p.title}"`);
  for (const s of p.sections) {
    console.log(`   section ${s.id} title="${s.title}"${s.description ? ` — ${clip(s.description, 90)}` : ''}`);
    for (const it of s.items) {
      const v =
        it.kind === 'info' || it.kind === 'select' || it.kind === 'text'
          ? ` = ${clip(String(it.value), 80)}`
          : it.kind === 'toggle'
            ? ` = ${it.value}`
            : it.kind === 'quota'
              ? ` = ${JSON.stringify(it.groups)}`
              : it.kind === 'list'
                ? ` rows=${it.rows.length}`
                : it.kind === 'page'
                  ? ` → ${it.description ?? ''} [${it.badge ?? ''}]`
                  : '';
      console.log(`     ${it.kind} ${it.id} "${it.label}"${v}`);
    }
  }
}

/** Waits for a chat's state to satisfy `ok` (states come from the backend's listener). */
async function openChat(id: string, ok: (s: ChatState) => boolean, timeoutMs = 60_000): Promise<ChatState | null> {
  let last: ChatState | null = null;
  const unsub = backend.subscribe(id, (s) => {
    last = s;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !(last && ok(last))) await sleep(200);
  // keep it a moment: later emits must reuse unchanged message objects
  const before = last as ChatState | null;
  await sleep(300);
  const after = last as ChatState | null;
  unsub();
  if (before && after && before !== after) {
    const same = after.messages.filter((m, i) => before.messages[i] === m).length;
    log(`   identity: ${same}/${after.messages.length} messages kept between emits`);
  }
  return last;
}

async function main() {
  // nothing else may be running this test
  backend.start();
  const t0 = Date.now();
  while (backend.codexState === 'CHECKING' && Date.now() - t0 < 90_000) await sleep(300);
  log(`status: ${JSON.stringify(backend.status())}`);
  log(`bridge codex: ${JSON.stringify({ ...backend.bridgeStatus, logs: undefined })}`);
  check(backend.codexState !== 'CHECKING', 'Codex state known');

  // ---- account, limits, models
  log(`account: ${JSON.stringify(backend.account)} limits: ${JSON.stringify(backend.rateLimits)}`);
  while (!backend.models().models.length && Date.now() - t0 < 60_000) await sleep(300);
  const ms = backend.models();
  log(`models: ${ms.models.length}, selected ${ms.selectedId}, groups ${JSON.stringify(ms.groups)}`);
  for (const m of ms.models) console.log(`  ${m.id} "${m.displayName}" default=${m.isDefault} efforts=[${backend.effortsOf(m.id).join(',')}] pill=${m.quotaText} group=${m.group}`);
  check(ms.models.length > 0 || backend.codexState !== 'READY', 'models listed');
  log(`controls (new chat): ${JSON.stringify(backend.controls(null).map((c) => `${c.id}:${c.label}=${c.value}${c.options ? `[${c.options.map((o) => o.value).join('|')}]` : ''}`))}`);
  await sleep(1500); // skills
  log(`commands: ${backend.commands().length} → ${backend.commands().slice(0, 9).map((c) => `${c.command}(${c.kind}${c.runsOnTap ? ',tap' : ''})`).join(' ')}`);

  // ---- chat list
  while (!backend.conversations().length && Date.now() - t0 < 60_000) await sleep(300);
  const convs = backend.conversations();
  log(`conversations: ${convs.length} (archived ${convs.filter((c) => c.archived).length}, running ${convs.filter((c) => c.isRunning).length})`);
  for (const c of convs.slice(0, 6)) console.log(`  ${c.id} "${clip(c.title, 50)}" ${c.modelId} ${new Date(c.updatedAt).toISOString()} ${c.workspaceUri}`);
  check(convs.length > 0, 'threads listed');

  // ---- existing chats (read only)
  for (const id of SAMPLE_THREADS) {
    log(`open ${id}`);
    const st = await openChat(id, (s) => !s.isLoading && s.messages.length > 0);
    if (!st) {
      check(false, `chat ${id} loaded`);
      continue;
    }
    log(`  conversation "${st.conversation?.title}" chat model=${st.modelId ?? '(picker)'} controls=${JSON.stringify(st.controls?.map((c) => `${c.id}=${c.value}`))} streaming=${st.isStreaming} error=${st.error} queued=${st.queued.length}`);
    printMessages(st.messages);
    check(st.messages.some((m) => m.role === 'USER') && st.messages.some((m) => m.role === 'ASSISTANT'), `chat ${id.slice(0, 8)} has user + assistant messages`);
  }
  {
    log(`open big chat ${BIG_THREAD} (summary only)`);
    const st = await openChat(BIG_THREAD, (s) => !s.isLoading && s.messages.length > 0, 90_000);
    if (st) {
      const tools = st.messages.flatMap((m) => m.toolCalls);
      const byType: Record<string, number> = {};
      for (const t of tools) byType[`${t.toolType}/${t.status}`] = (byType[`${t.toolType}/${t.status}`] ?? 0) + 1;
      log(`  ${st.messages.length} messages, ${tools.length} tools ${JSON.stringify(byType)}`);
      log(`  with thinking: ${st.messages.filter((m) => m.thoughtText).length}, with tokens: ${st.messages.filter((m) => m.tokenUsage).length}, summaries: ${st.messages.filter((m) => m.role === 'SUMMARY').length}`);
      const edit = st.messages.find((m) => m.toolCalls.some((t) => t.toolType === 'EDIT_FILE'));
      const diff = edit?.toolCalls.find((t) => t.toolType === 'EDIT_FILE');
      if (diff) console.log(`  sample diff (${diff.command}):\n${diff.output.split('\n').slice(0, 8).map((l) => `    ${l}`).join('\n')}`);
      const thought = st.messages.find((m) => m.thoughtText);
      if (thought) console.log(`  sample thinking: ${clip(thought.thoughtText!, 200)}`);
      const last = st.messages.filter((m) => m.role === 'ASSISTANT').pop();
      if (last) printMessages([last]);
      check(tools.length > 0, 'big chat has tool calls');
    } else check(false, 'big chat loaded');
  }

  // ---- settings pages
  log('settings:');
  console.log(`  root item: ${JSON.stringify(backend.settings.rootItem())}`);
  for (const p of ['codex', 'codex.permissions', 'codex.cli', 'codex.mcp']) printPage(await backend.settings.page(p));
  check(opened.length === 0, 'no URL opened (no sign-in started)');

  // ---- new optional members (read only)
  log(`externalId(${SAMPLE_THREADS[0].slice(0, 8)}) = ${backend.externalId(SAMPLE_THREADS[0])}`);
  const hits = await backend.search('video');
  log(`search "video": ${hits.length} hits ${JSON.stringify(hits.slice(0, 3).map((h) => [h.conversationId.slice(0, 8), clip(h.snippet, 60)]))}`);
  check(hits.some((h) => h.conversationId === SAMPLE_THREADS[1]), 'search finds the video chat');
  const exported = await backend.loadMessages(SAMPLE_THREADS[0]);
  check(exported.length >= 2, `loadMessages of a closed chat (${exported.length} messages)`);
  const before = toasts.length;
  await backend.setControl(null, 'mode', 'details');
  check(toasts.length === before + 1, 'chip details answered with a toast');
  log(`controls: ${JSON.stringify(backend.controls(null).map((c) => ({ id: c.id, kind: c.kind, title: c.title ?? null })))}`);
  // command feedback: toasts, no thread, no Codex turn
  for (const cmd of ['/status', '/plan']) {
    const vid = randomUUID();
    const n = toasts.length;
    await backend.send({ conversationId: vid, isNew: true, text: cmd, attachments: [], modelId: null, workspaceUri: `file://${WORKSPACE}` });
    check(toasts.length === n + 1 && backend.threadIdOf(vid) === vid, `${cmd} answered with a toast, no thread created`);
  }
  log(`new-chat controls after /plan: ${JSON.stringify(backend.controls(null).map((c) => `${c.id}=${c.value}`))}`);
  await backend.setControl(null, 'plan', 'off');

  // ---- one tiny new chat: an approval, a command terminated while it runs, a queued message; then deleted
  if (NO_SEND || backend.codexState !== 'READY') {
    log(NO_SEND ? 'skip sending (--no-send)' : `not signed in / not ready (${backend.codexState}): read paths only`);
  } else {
    const viewId = randomUUID();
    log(`new chat (view id ${viewId}) in ${WORKSPACE}`);
    const states: ChatState[] = [];
    const last = () => states[states.length - 1];
    const unsub = backend.subscribe(viewId, (s) => states.push(s));
    const cheap = ms.models.find((m) => m.id === 'gpt-6-luna')?.id ?? ms.selectedId;
    if (backend.effortsOf(cheap).includes('low')) await backend.setControl(viewId, 'effort', 'low');
    // "Ask first" (a local choice, in memory here): Codex asks before running the command
    await backend.setControl(viewId, 'mode', 'ask');
    const sentAt = Date.now();
    await backend.send({
      conversationId: viewId,
      isNew: true,
      text: 'Run exactly this shell command in the current directory: `sleep 25 && echo slept`. Then reply with exactly: DONE',
      attachments: [],
      modelId: cheap,
      workspaceUri: `file://${WORKSPACE}`,
    });
    const threadId = backend.threadIdOf(viewId);
    check(threadId !== viewId && backend.externalId(viewId) === threadId, `view id mapped to thread ${threadId}; externalId gives it`);
    const waitFor = async (what: string, ok: (s: ChatState) => boolean, ms2: number) => {
      const end = Date.now() + ms2;
      while (Date.now() < end) {
        const st = last();
        if (st && ok(st)) return st;
        await sleep(200);
      }
      log(`   (timeout waiting for ${what})`);
      return null;
    };
    const asked = await waitFor('an approval', (s) => s.approvals.length > 0 || s.messages.some((m) => m.toolCalls.some((t) => t.status === 'RUNNING')), 60_000);
    if (asked?.approvals.length) {
      const a = asked.approvals[0];
      log(`approval: ${JSON.stringify({ key: a.key, icon: a.icon, title: a.title, subtitle: a.subtitle, preview: a.preview, primary: a.primary, always: a.always.map((x) => x.id) })}`);
      check(a.title === 'Run a command?' && !!a.preview?.includes('sleep'), 'approval card built');
      await backend.approval(viewId, a.key, 'once', false);
    } else log('no approval asked (Codex ran it directly)');
    const runningTool = await waitFor('the running command', (s) => s.messages.some((m) => m.toolCalls.some((t) => t.toolType === 'BASH' && t.status === 'RUNNING')), 60_000);
    // a second message while the turn runs: Codex's queue
    await backend.send({ conversationId: viewId, isNew: false, text: 'Reply with exactly: QUEUED', attachments: [], modelId: cheap, workspaceUri: null });
    const queued = await waitFor('the queue', (s) => s.queued.length > 0, 10_000);
    check(!!queued, `queued message listed (${JSON.stringify(queued?.queued.map((q) => q.text))})`);
    if (runningTool) {
      const tool = runningTool.messages.flatMap((m) => m.toolCalls).find((t) => t.toolType === 'BASH' && t.status === 'RUNNING')!;
      log(`terminate ${tool.id} (${tool.command}) after ${((Date.now() - sentAt) / 1000).toFixed(1)}s`);
      const t0b = Date.now();
      await backend.toolAction(viewId, tool.id, 'terminate');
      const ended = await waitFor('the command to end', (s) => s.messages.flatMap((m) => m.toolCalls).some((t) => t.id === tool.id && t.status !== 'RUNNING'), 30_000);
      const st = ended?.messages.flatMap((m) => m.toolCalls).find((t) => t.id === tool.id);
      log(`   command now ${st?.status} exit=${st?.exitCode} after ${((Date.now() - t0b) / 1000).toFixed(1)}s`);
      check(!!ended && Date.now() - t0b < 20_000, 'running command ended by toolAction');
    } else check(false, 'command seen running');
    // the queued message runs after the first turn; a stopped turn leaves it queued ("Send now" starts it)
    let done = await waitFor('the queued reply', (s) => !s.isStreaming && s.messages.some((m) => m.role === 'ASSISTANT' && /\bQUEUED\b/.test(m.content)), 20_000);
    if (!done) {
      const q = last()?.queued[0];
      log(`turn was stopped: queue ${JSON.stringify(last()?.queued.map((x) => x.text))}; send now ${q?.id}`);
      check(!!q, 'queued message kept after the stop');
      if (q) await backend.queueAction(viewId, q.id, 'sendNow');
      done = await waitFor('the queued reply', (s) => !s.isStreaming && s.messages.some((m) => m.role === 'ASSISTANT' && /\bQUEUED\b/.test(m.content)), 120_000);
    }
    await sleep(1500); // the reload after turn/completed
    const final = last();
    log(`emits: ${states.length}, ${((Date.now() - sentAt) / 1000).toFixed(1)}s, notice seen: ${JSON.stringify([...new Set(states.map((s) => (s as ChatState & { notice?: string | null }).notice).filter(Boolean))])}`);
    printMessages(final?.messages ?? []);
    check(!!done, 'queued message answered');
    check(!!final && final.messages.some((m) => m.toolCalls.some((t) => t.command.includes('sleep'))), 'stopped command still shown after the reload');
    check(final?.conversation?.id === viewId, `conversation listed under the view id`);
    const users = states.map((s) => s.messages.find((m) => m.role === 'USER' && !m.id.startsWith('local_'))).filter(Boolean);
    log(`first user message: ${users.length} emits, ${new Set(users).size} distinct objects`);
    unsub();
    // clean up: delete only this chat
    await backend.conversationAction(viewId, 'delete');
    const after = await backend.client.rpc('thread/list', { limit: 100, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'exec', 'appServer'] });
    check(!(after?.data ?? []).some((t: { id: string }) => t.id === threadId), 'test thread deleted');
  }
  log(`toasts: ${JSON.stringify(toasts)}`);

  backend.dispose();
  log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  backend.dispose();
  process.exit(2);
});
