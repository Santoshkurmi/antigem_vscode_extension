// Headless test of the Claude Code backend against the running bridge (reused, never started / stopped here).
//   npx esbuild dev/test-claude.ts --bundle --platform=node --format=cjs --outfile=dist/test-claude.js && node dist/test-claude.js
// Read-only: chat list, three existing chats (history → ChatMessages), models, commands, usage, every settings page.
// The only write: ONE tiny new chat in the scratch workspace ("Reply with exactly: OK"), watched to completion, then
// deleted. No settings writes, no sign-in/out, no installs, no provider / MCP changes.
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/model';
import type { SettingItem, SettingsPage } from '../shared/protocol';
import { BridgeManager } from '../src/core/bridge/BridgeManager';
import { ClaudeBackend } from '../src/core/claude/ClaudeBackend';
import type { ChatState, KeyValueStore } from '../src/core/types';

const ROOT = path.resolve(__dirname, '..');
const WS = '/tmp/claude-1000/-home-cat-agy-cli-hub-antiGem/b3105e30-1c88-43b9-a135-671615f51faa/scratchpad/agy-test-ws';
const stateDir = path.join(os.homedir(), '.antigem-vscode-dev');
const OPEN = (process.env.OPEN_IDS ?? '1d4032c8-a0b0-4e69-aee9-22c972bdf5fb,5a95756c-cedf-4270-9c5e-3f9afb3fb5d7,65b8b7f4-d1c7-47b5-b568-ed882843c291').split(',');
const SKIP_CHAT = process.env.SKIP_CHAT === '1';

const t0 = Date.now();
const log = (l: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${l}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cut = (s: string | null | undefined, n = 120) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// in-memory store: the test never touches the dev server's state file
const mem = new Map<string, unknown>();
const kv: KeyValueStore = { get: <T>(k: string) => mem.get(k) as T | undefined, set: (k, v) => void mem.set(k, v) };

let failures = 0;
function check(ok: boolean, what: string) {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
}

async function until(what: string, fn: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(100);
  }
  log(`timeout waiting for ${what}`);
  return false;
}

function printMessage(m: ChatMessage) {
  const tu = m.tokenUsage ? ` tokens{in ${m.tokenUsage.promptTokens} cached ${m.tokenUsage.cachedTokens} out ${m.tokenUsage.outputTokens}${m.tokenUsage.costUsd ? ` $${m.tokenUsage.costUsd.toFixed(4)}` : ''}${m.tokenUsage.model ? ` ${m.tokenUsage.model}` : ''}}` : '';
  console.log(`   [${m.role}] ${m.id}${m.isStreaming ? ' (streaming)' : ''}${m.thoughtText ? ` thought=${m.thoughtText.length}ch` : ''}${m.attachments.length ? ` atts=${m.attachments.map((a) => a.name).join(',')}` : ''}${tu}`);
  console.log(`      ${cut(m.content, 160)}`);
  for (const t of m.toolCalls) console.log(`      ⚙ ${t.toolType}/${t.name} [${t.status}] ${cut(t.command, 70)} → ${cut(t.output, 90)}`);
}

function printPage(p: SettingsPage) {
  console.log(`   ── page ${p.id} "${p.title}" (${p.sections.length} sections)`);
  for (const s of p.sections) {
    console.log(`      § ${s.id}${s.title ? ` "${s.title}"` : ''}${s.description ? ` — ${cut(s.description, 80)}` : ''}`);
    for (const it of s.items) console.log(`         ${describeItem(it)}`);
  }
}

function describeItem(it: SettingItem): string {
  switch (it.kind) {
    case 'info':
      return `info ${it.id}: ${it.label} = ${cut(it.value, 70)}${it.tone ? ` (${it.tone})` : ''}${it.description ? ` · ${cut(it.description, 60)}` : ''}`;
    case 'select':
      return `select ${it.id}: ${it.label} = ${it.value} [${it.options.map((o) => o.value).join('|')}]`;
    case 'toggle':
      return `toggle ${it.id}: ${it.label} = ${it.value}${it.disabled ? ' (disabled)' : ''}`;
    case 'text':
      return `text ${it.id}: ${it.label} = ${it.id === 'settingsJson' ? `<${it.value.length} chars of JSON>` : `"${cut(it.value, 60)}"`}`;
    case 'button':
      return `button ${it.id}: ${it.label}${it.form ? ` (form: ${it.form.map((f) => f.id).join(',')})` : ''}${it.disabled ? ' (disabled)' : ''}`;
    case 'page':
      return `page ${it.id}: ${it.label}${it.badge ? ` [${it.badge}]` : ''} — ${cut(it.description, 60)}`;
    case 'list':
      return `list ${it.id}: ${it.label} rows=${it.rows.length}${it.rows.length ? ` e.g. "${cut(it.rows[0].title, 40)}"${it.rows[0].status ? ` (${it.rows[0].status})` : ''}${it.rows[0].subtitle ? ` · ${cut(it.rows[0].subtitle, 60)}` : ''}` : ''}${it.addLabel ? ` +${it.addLabel}` : ''}`;
    case 'quota':
      return `quota ${it.id}: ${it.groups.map((g) => `${g.name}{${(g.windows ?? []).map((w) => `${w.label} ${Math.round(w.remaining * 100)}% left${w.resetText ? ` ${w.resetText}` : ''}`).join(', ')}}`).join(' ')}`;
    case 'checklist':
      return `checklist ${it.id}: ${it.values.join(',')}`;
  }
}

async function main() {
  const bridge = new BridgeManager({
    binPath: path.join(ROOT, 'bin', `antigem-bridge-${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`),
    port: 1244,
    hubPort: 1245,
    workspaceDir: WS,
    logFile: path.join(stateDir, 'bridge.log'),
    log,
  });
  await bridge.ensureRunning();
  check(bridge.state === 'running', 'bridge reused');

  const backend = new ClaudeBackend(bridge, kv, log, { openUrl: (u) => log(`[openUrl] ${u}`) });
  const changes: Record<string, number> = {};
  backend.onChange((w) => (changes[w] = (changes[w] ?? 0) + 1));
  const toasts: string[] = [];
  backend.setNotifier((level, message) => {
    toasts.push(`${level}: ${message}`);
    log(`[toast ${level}] ${cut(message, 200)}`);
  });
  backend.start();
  if (process.env.REWIND_TEST === '1') return rewindTest(bridge, backend);

  // ---------------------------------------------------------------- status, list, models, commands
  await until('status', () => backend.status().state !== 'starting', 90_000);
  const st = backend.status();
  log(`status: ${st.state} · ${st.detail} · account=${st.account}`);
  check(st.state === 'online', 'Claude Code online');

  await until('sessions', () => backend.sessionsLoaded, 30_000);
  const convs = backend.conversations().sort((a, b) => b.updatedAt - a.updatedAt);
  log(`conversations: ${convs.length}`);
  for (const c of convs.slice(0, 5)) console.log(`   ${c.id} "${cut(c.title, 50)}" ${c.workspaceUri} running=${c.isRunning} archived=${c.archived}`);
  check(convs.length > 0 && convs.every((c) => c.agent === 'CLAUDE'), 'chat list loaded');

  await until('models', () => backend.models().models.length > 0, 90_000);
  await until('usage', () => backend.usage != null, 60_000);
  const ms = backend.models();
  log(`models: ${ms.models.length}, selected=${ms.selectedId}`);
  for (const m of ms.models) console.log(`   ${m.id.padEnd(28)} ${cut(m.displayName, 28).padEnd(28)} group=${m.group ?? '-'} pill=${m.quotaText ?? '-'}`);
  for (const g of ms.groups ?? []) console.log(`   group ${g.name}: ${(g.windows ?? []).map((w) => `${w.label} ${Math.round(w.remaining * 100)}% left ${w.resetText ?? ''}`).join(' · ')}`);
  check(ms.models.some((m) => m.id === 'default' && m.isDefault), 'models include "default"');

  const cmds = backend.commands();
  log(`commands: ${cmds.length} (${cmds.filter((c) => c.kind === 'command').length} command, ${cmds.filter((c) => c.kind === 'skill').length} skill, ${cmds.filter((c) => c.kind === 'app').length} app)`);
  console.log(`   ${cmds.slice(0, 12).map((c) => `${c.command}[${c.kind}]`).join(' ')}`);
  check(cmds.length > 0, 'commands loaded');

  const ctl = backend.controls(null);
  log(`new-chat controls: ${ctl.map((c) => `${c.id}=${c.value} "${c.label}"`).join(' · ')}`);
  check(ctl.some((c) => c.id === 'mode') && ctl.some((c) => c.id === 'thinking'), 'controls for a new chat');

  // ---------------------------------------------------------------- open existing chats (read-only)
  for (const id of OPEN) {
    let last: ChatState | null = null;
    let emits = 0;
    const unsub = backend.subscribe(id, (s) => {
      last = s;
      emits++;
    });
    const ok = await until(`chat ${id}`, () => !!last && !last.isLoading && last.messages.length > 0, 60_000);
    const s = last as ChatState | null;
    log(`chat ${id}: "${cut(s?.conversation?.title, 50)}" ${s?.messages.length ?? 0} messages, emits=${emits}, error=${s?.error ?? null}`);
    if (s) {
      for (const m of s.messages) printMessage(m);
      log(`   controls: ${(s.controls ?? []).map((c) => `${c.id}="${c.label}"`).join(' · ')} · conversation.modelId=${s.conversation?.modelId}`);
      const tools = s.messages.flatMap((m) => m.toolCalls);
      check(ok && !s.error, `chat ${id.slice(0, 8)} loaded`);
      check(tools.every((t) => t.status !== 'RUNNING' && t.status !== 'PENDING_APPROVAL'), `chat ${id.slice(0, 8)}: no tool left running`);
      // finished messages keep their identity between states (the host then sends nothing)
      const again = backend.getState(id).messages;
      check(again.length === s.messages.length && again.every((m, i) => m === s.messages[i]), `chat ${id.slice(0, 8)}: messages keep identity`);
    }
    if (id === OPEN[0] && s) {
      // an info chip's details come as a toast (the app's cache dialog)
      const before = toasts.length;
      await backend.setControl(id, 'cache', 'details');
      check(toasts.length === before + 1 && /cache/i.test(toasts[toasts.length - 1]), 'cache chip details → toast');
      check((s as ChatState & { modelId?: string }).modelId === s.conversation?.modelId && !!(s as ChatState & { modelId?: string }).modelId, `state carries the chat's model (${(s as ChatState & { modelId?: string }).modelId})`);
      check((s.controls ?? []).every((c) => c.kind !== 'select' || !!c.title), 'select chips have sheet titles');
    }
    unsub();
  }

  // ---------------------------------------------------------------- search (last prompts + chats opened in this run)
  const hits = await backend.search('snake');
  log(`search "snake": ${hits.length} hits · ${hits.slice(0, 3).map((h) => `${h.conversationId.slice(0, 8)} "${cut(h.snippet, 60)}"`).join(' | ')}`);
  check(hits.some((h) => h.conversationId === OPEN[0]), 'content search finds an opened chat');

  // ---------------------------------------------------------------- settings pages
  const settings = backend.settings;
  const root = settings.rootItem();
  log(`settings root item: ${describeItem(root)}`);
  for (const p of ['claude', 'claude.defaults', 'claude.permissions', 'claude.mcp', 'claude.plugins', 'claude.memory', 'claude.providers', 'claude.cli', 'claude.advanced']) {
    const started = Date.now();
    try {
      const page = await settings.page(p);
      if (!page) {
        check(false, `settings page ${p}`);
        continue;
      }
      printPage(page);
      check(page.sections.length > 0, `settings page ${p} (${Date.now() - started} ms)`);
    } catch (e) {
      check(false, `settings page ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // plugin catalog search (view state only, nothing is written)
  await settings.action('claude.plugins', 'search', undefined, undefined, { query: 'commit' });
  const pl = await settings.page('claude.plugins');
  const found = pl?.sections.flatMap((x) => x.items).find((i) => i.id === 'available');
  check(found?.kind === 'list' && found.rows.length > 0, `plugin search lists matches (${found?.kind === 'list' ? found.rows.length : 0})`);
  await settings.action('claude.plugins', 'clearSearch');
  const pv = await settings.page('claude.providers');
  check(!!pv?.sections.some((x) => x.items.some((i) => i.kind === 'button' && i.id === 'add:kimi' && (i.form?.length ?? 0) >= 14)), 'providers page offers presets with the full editor');
  const main = await settings.page('claude');
  check(!!main && main.sections.every((s) => s.title === ''), 'main page sections have no titles');
  check(!!main?.sections.some((s) => s.items.some((i) => i.kind === 'quota')), 'main page shows plan usage');

  // ---------------------------------------------------------------- one tiny new chat, streamed, then deleted
  if (!SKIP_CHAT) {
    const id = randomUUID();
    log(`new chat ${id} in ${WS}`);
    let last: ChatState | null = null;
    const seen = new Set<string>();
    let emits = 0;
    const unsub = backend.subscribe(id, (s) => {
      last = s;
      emits++;
      const a = [...s.messages].reverse().find((m) => m.role === 'ASSISTANT');
      const sig = `streaming=${s.isStreaming} label=${s.workingLabel} msgs=${s.messages.length} asst=${a ? `${a.isStreaming ? 'live' : 'done'}:"${cut(a.content, 40)}"` : '-'}`;
      if (!seen.has(sig)) {
        seen.add(sig);
        log(`   ↳ ${sig}`);
      }
    });
    try {
      // a folder goes in the hidden attached-files list (by path)
      const folder = { id: 'att_folder', name: path.basename(WS), path: WS, isImage: false, isAudio: false, size: 0, reference: true, kind: 'folder' as const, mimeType: 'inode/directory' };
      await backend.send({ conversationId: id, isNew: true, text: 'Reply with exactly: OK (do not use any tools)', attachments: [folder], modelId: 'haiku', workspaceUri: `file://${WS}` });
      await until('user bubble', () => !!(last as ChatState | null)?.messages.some((m) => m.role === 'USER'), 5000);
      const bubble = (last as ChatState | null)?.messages.find((m) => m.role === 'USER');
      check(bubble?.content === 'Reply with exactly: OK (do not use any tools)' && bubble.attachments.some((a) => a.kind === 'folder' && a.path === WS), 'folder shown as a folder card, text without the hidden list');
      check(backend.conversations().some((c) => c.id === id), 'new chat listed locally at once');
      const done = await until(
        'reply',
        () => {
          const s = last as ChatState | null;
          const a = s?.messages.find((m) => m.role === 'ASSISTANT');
          return !!s && !s.isStreaming && !!a && !a.isStreaming && !!a.tokenUsage;
        },
        180_000,
      );
      const s = last as ChatState | null;
      if (s) for (const m of s.messages) printMessage(m);
      const reply = s?.messages.find((m) => m.role === 'ASSISTANT');
      check(done && /\bOK\b/.test(reply?.content ?? ''), `streamed reply "${cut(reply?.content, 40)}" (${emits} emits)`);
      check(reply?.tokenUsage?.model?.includes('haiku') === true, `ran on haiku (${reply?.tokenUsage?.model})`);
      // title, context usage and the cache chip arrive right after the turn
      await until('title', () => (backend.conversations().find((c) => c.id === id)?.title ?? '') !== 'Reply with exactly: OK', 30_000);
      await sleep(2500);
      const s2 = backend.getState(id);
      log(`after the turn: title="${s2.conversation?.title}" controls: ${(s2.controls ?? []).map((c) => `${c.id}="${c.label}"`).join(' · ')}`);
      check((s2.controls ?? []).some((c) => c.id === 'cache' || c.id === 'context'), 'live indicators (cache / context) after the turn');
      check(backend.isOnDisk(id), 'the bridge lists the new chat');
      check((s2 as ChatState & { modelId?: string }).modelId === 'haiku', 'the chat state carries its model (haiku)');
      const h = await bridge.json<{ entries: { type: string; message?: { content?: unknown } }[] }>(`/api/claude/sessions/${id}/history?full=1`);
      const sent = JSON.stringify(h.entries.find((e) => e.type === 'user')?.message?.content ?? '');
      check(sent.includes('<attached-files>') && sent.includes('inode/directory') && sent.includes(WS), 'the prompt carried the folder in <attached-files>');
      const found2 = await backend.search('do not use any tools');
      check(found2.some((x) => x.conversationId === id), 'search finds the new chat by its content');
    } finally {
      unsub();
      try {
        await backend.conversationAction(id, 'delete');
        const list = await bridge.json<{ sessions: { id: string }[] }>('/api/claude/sessions');
        check(!list.sessions.some((x) => x.id === id), 'test chat deleted');
      } catch (e) {
        check(false, `delete test chat: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  log(`change events: ${JSON.stringify(changes)}`);
  backend.dispose();
  log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}

/**
 * Edit & regenerate on ONE new scratch chat (never the user's chats): A, B → rewind before B (B back to the composer)
 * → regenerate A's reply (cut before A, A sent again) → delete the chat.
 */
async function rewindTest(bridge: BridgeManager, backend: ClaudeBackend) {
  await until('sessions', () => backend.sessionsLoaded, 30_000);
  const id = randomUUID();
  log(`rewind test on new chat ${id} in ${WS}`);
  let last: ChatState | null = null;
  const unsub = backend.subscribe(id, (s) => (last = s));
  const state = () => last as ChatState | null;
  const assistants = () => state()?.messages.filter((m) => m.role === 'ASSISTANT') ?? [];
  const replies = (n: number) =>
    until(`${n} replies`, () => {
      const s = state();
      const a = assistants();
      return !!s && !s.isLoading && !s.isStreaming && a.length === n && a.every((m) => !m.isStreaming && !!m.tokenUsage);
    }, 120_000);
  const show = (what: string) => {
    log(`${what}:`);
    for (const m of state()?.messages ?? []) printMessage(m);
  };
  try {
    await backend.send({ conversationId: id, isNew: true, text: 'Reply with exactly: A', attachments: [], modelId: 'haiku', workspaceUri: `file://${WS}` });
    check(await replies(1), 'first reply');
    await until('listed', () => backend.isOnDisk(id), 20_000);
    await backend.send({ conversationId: id, isNew: false, text: 'Reply with exactly: B', attachments: [], modelId: 'haiku', workspaceUri: null });
    check(await replies(2), 'second reply');
    show('before the rewind');
    const userB = state()!.messages.filter((m) => m.role === 'USER')[1];
    const prompt = await backend.rewind(id, userB.id);
    show('after rewinding before B');
    const s1 = state()!;
    check(prompt === 'Reply with exactly: B', `rewind returns the prompt ("${prompt}")`);
    check(s1.messages.length === 2 && s1.messages[0].content === 'Reply with exactly: A' && /\bA\b/.test(s1.messages[1].content), 'chat ends right before B');
    const h1 = await bridge.json<{ entries: { type: string; message?: { content?: unknown } }[] }>(`/api/claude/sessions/${id}/history`);
    const userTexts = (h: typeof h1) => h.entries.filter((e) => e.type === 'user' && JSON.stringify(e.message?.content ?? '').includes('Reply with exactly')).length;
    check(userTexts(h1) === 1, `bridge history cut too (${userTexts(h1)} prompt)`);

    const replyA = assistants()[0];
    await backend.retryMessage(id, replyA.id);
    check(await replies(1), 'regenerated reply');
    show('after regenerating A');
    const s2 = state()!;
    check(s2.messages.length === 2 && s2.messages[0].content === 'Reply with exactly: A' && /\bA\b/.test(s2.messages[1].content) && s2.messages[1] !== replyA, 'A sent again, one fresh reply');
    // the live process' part is only in ?full=1 (an attaching client gets it from the socket)
    const h2 = await bridge.json<{ entries: { type: string; message?: { content?: unknown } }[] }>(`/api/claude/sessions/${id}/history?full=1`);
    check(userTexts(h2) === 1, `bridge transcript (full) has the new branch only (${userTexts(h2)} prompt)`);
    // reopened (history + buffer replay): the same two messages
    backend.retry();
    await sleep(300);
    check(await replies(1), 'reloaded chat');
    const s3 = state()!;
    check(s3.messages.length === 2 && /\bA\b/.test(s3.messages[1].content), `reloaded chat shows the new branch (${s3.messages.length} messages)`);
    let threw = false;
    try {
      await backend.rewind(id, 'user_local_x');
    } catch {
      threw = true;
    }
    check(threw, 'a non-transcript message cannot be rewound');
  } finally {
    unsub();
    try {
      await backend.conversationAction(id, 'delete');
      const list = await bridge.json<{ sessions: { id: string }[] }>('/api/claude/sessions');
      check(!list.sessions.some((x) => x.id === id), 'test chat deleted');
    } catch (e) {
      check(false, `delete test chat: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  backend.dispose();
  log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
