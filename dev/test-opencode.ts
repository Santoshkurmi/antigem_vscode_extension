// Headless test of the OpenCode backend against the running bridge (port 1244):
//   npx esbuild dev/test-opencode.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist/test-opencode.js
//   node dist/test-opencode.js            read-only: status, models, chat list, 2–3 chats, settings pages
//   LIVE=1 node dist/test-opencode.js     + one tiny new chat in the scratch workspace, streamed, then deleted
// Preferences go to an in-memory store (nothing is written to the dev state file).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/model';
import type { SettingsPage } from '../shared/protocol';
import { BridgeManager } from '../src/core/bridge/BridgeManager';
import { OpenCodeBackend } from '../src/core/opencode/OpenCodeBackend';
import { answer, answersFrom, formFields, integrations, missing, orderedMethods, visibleFields } from '../src/core/opencode/auth';
import type { ChatState, KeyValueStore } from '../src/core/types';

const ROOT = path.resolve(__dirname, '..');
const SCRATCH_WS = '/tmp/claude-1000/-home-cat-agy-cli-hub-antiGem/b3105e30-1c88-43b9-a135-671615f51faa/scratchpad/agy-test-ws';
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (l: string) => console.log(el(), l);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(200);
  }
  log(`TIMEOUT waiting for ${what}`);
  return false;
}

const mem = new Map<string, unknown>();
const kv: KeyValueStore = { get: <T>(k: string) => mem.get(k) as T | undefined, set: (k, v) => void mem.set(k, v) };

const bridge = new BridgeManager({
  binPath: path.join(ROOT, 'bin', 'antigem-bridge-linux-x64'),
  port: 1244,
  hubPort: 1245,
  workspaceDir: SCRATCH_WS,
  logFile: path.join(os.homedir(), '.antigem-vscode-dev', 'bridge.log'),
  log,
});

const backend = new OpenCodeBackend(bridge, kv, (l) => log(`  [log] ${l}`), { openUrl: (u) => log(`openUrl ${u}`) });
const toasts: string[] = [];
backend.setNotifier((level, message) => {
  toasts.push(`${level}: ${message}`);
  log(`TOAST ${level}: ${message}`);
});
const changes: Record<string, number> = {};
backend.onChange((w) => (changes[w] = (changes[w] ?? 0) + 1));

// event types seen (logging only)
const eventTypes: Record<string, number> = {};
const orig = (backend as any).handleEvent.bind(backend);
(backend as any).handleEvent = (e: any) => {
  if (e?.type) eventTypes[e.type] = (eventTypes[e.type] ?? 0) + 1;
  orig(e);
};

const short = (s: string, n = 110) => JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s);

function dumpMessages(msgs: ChatMessage[], max = 14) {
  const pick = msgs.length > max ? [...msgs.slice(0, 4), ...msgs.slice(-(max - 4))] : msgs;
  if (msgs.length > max) console.log(`     … showing first 4 and last ${max - 4} of ${msgs.length}`);
  for (const m of pick) {
    const tools = m.toolCalls.map((t) => `${t.toolType}:${t.name}:${t.status}${t.command ? `(${short(t.command, 40)})` : ''}`).join(', ');
    const u = m.tokenUsage ? ` tokens=${m.tokenUsage.totalTokens} in=${m.tokenUsage.promptTokens} out=${m.tokenUsage.outputTokens} cache=${m.tokenUsage.cachedTokens} ${m.tokenUsage.durationMs}ms model=${m.tokenUsage.model}` : '';
    const thought = m.thoughtText ? ` thought(${m.thoughtText.length}ch)` : '';
    const att = m.attachments.length ? ` attachments=${m.attachments.length}` : '';
    console.log(`     ${m.role.padEnd(9)} ${m.id.slice(0, 14)} ${short(m.content.replace(/<!-- thought(:streaming)? -->[\s\S]*?<!-- \/thought -->/g, '[thought]'))}${thought}${att}${tools ? ` tools=[${tools.slice(0, 300)}]` : ''}${u}${m.isStreaming ? ' (streaming)' : ''}`);
  }
}

function dumpPage(p: SettingsPage | null) {
  if (!p) return console.log('   (null page)');
  console.log(`   PAGE ${p.id} "${p.title}" sections=${p.sections.length}`);
  for (const s of p.sections) {
    console.log(`     section ${s.id} title=${JSON.stringify(s.title)}`);
    for (const it of s.items) {
      const x = it as any;
      let detail = '';
      if (x.kind === 'info') detail = `= ${short(String(x.value), 90)} (${x.tone ?? ''})`;
      else if (x.kind === 'select') detail = `= ${x.value} of [${x.options.map((o: any) => o.value).join(',')}]`;
      else if (x.kind === 'toggle') detail = `= ${x.value}`;
      else if (x.kind === 'checklist') detail = `= ${x.values.length}/${x.options.length} ticked`;
      else if (x.kind === 'list') detail = `rows=${x.rows.length}${x.rows.length ? ` e.g. ${x.rows.slice(0, 4).map((r: any) => `${r.title}[${r.status ?? ''}]${r.subtitle ? ` ${short(r.subtitle, 50)}` : ''}`).join(' | ')}` : ` empty=${JSON.stringify(x.emptyText)}`}${x.addForm ? ` addForm=${x.addForm.map((f: any) => f.id).join(',')}` : ''}`;
      else if (x.kind === 'button') detail = `${x.disabled ? '(disabled)' : ''}${x.form ? ` form=${x.form.map((f: any) => `${f.id}${f.options ? `(${f.options.length} options)` : ''}`).join(',')}` : ''}${x.confirm ? ' confirm' : ''}`;
      else if (x.kind === 'page') detail = `→ ${x.badge ?? ''} ${x.description ? short(x.description, 60) : ''}`;
      else if (x.kind === 'text') detail = `(${String(x.value).length} chars)`;
      console.log(`       ${x.kind.padEnd(9)} ${x.id} "${x.label}" ${detail}`);
    }
  }
}

async function openChat(id: string, title: string) {
  console.log(`\n== open ${id} ${JSON.stringify(title)}`);
  let last: ChatState | null = null;
  let emits = 0;
  const unsub = backend.subscribe(id, (s) => {
    last = s;
    emits++;
  });
  const ok = await waitFor(`chat ${id}`, () => !!last && !last.isLoading && (last.messages.length > 0 || !!last.error), 60_000);
  const st = last as ChatState | null;
  if (!ok || !st) {
    unsub();
    return;
  }
  console.log(`   emits=${emits} messages=${st.messages.length} streaming=${st.isStreaming} error=${st.error} approvals=${st.approvals.length} question=${!!st.question}`);
  console.log(`   conversation: id=${st.conversation?.id} model=${st.conversation?.modelId} ws=${st.conversation?.workspaceUri}`);
  console.log(`   controls: ${(st.controls ?? []).map((c) => `${c.id}=${c.value}(${c.label}, title=${c.title})`).join(' ')} notice=${(st as any).notice} modelId=${(st as any).modelId}`);
  const roles: Record<string, number> = {};
  const toolTypes: Record<string, number> = {};
  let thoughts = 0;
  for (const m of st.messages) {
    roles[m.role] = (roles[m.role] ?? 0) + 1;
    if (m.thoughtText) thoughts++;
    for (const t of m.toolCalls) toolTypes[`${t.toolType}/${t.status}`] = (toolTypes[`${t.toolType}/${t.status}`] ?? 0) + 1;
  }
  console.log(`   roles=${JSON.stringify(roles)} withThought=${thoughts} tools=${JSON.stringify(toolTypes)}`);
  dumpMessages(st.messages);
  // unchanged messages keep their identity between renders
  const again = backend.getState(id).messages;
  const same = again.filter((m, i) => m === st.messages[i]).length;
  console.log(`   identity kept on re-render: ${same}/${again.length}`);
  unsub();
}

async function liveTest() {
  const models = backend.models();
  const preferred = ['opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free'];
  const modelId = preferred.find((p) => models.models.some((m) => m.id === p)) ?? models.selectedId;
  if (!modelId) {
    console.log('\n== live test skipped: no model');
    return;
  }
  const viewId = randomUUID();
  console.log(`\n== LIVE: new chat ${viewId} model=${modelId} ws=${SCRATCH_WS}`);
  let last: ChatState | null = null;
  let sawStreaming = false;
  const labels = new Set<string>();
  let emits = 0;
  const unsub = backend.subscribe(viewId, (s) => {
    last = s;
    emits++;
    if (s.isStreaming) sawStreaming = true;
    if (s.workingLabel) labels.add(s.workingLabel);
  });
  const ses: string = (backend as any).aliases.get(viewId);
  console.log(`   alias → session ${ses}`);
  const tSend = Date.now();
  const folder = { id: 'att_folder', name: path.basename(SCRATCH_WS), path: SCRATCH_WS, isImage: false, isAudio: false, size: 0, reference: true, kind: 'folder' as const, mimeType: 'inode/directory' };
  await backend.send({ conversationId: viewId, isNew: true, text: 'Reply with exactly: OK', attachments: [folder], modelId, workspaceUri: `file://${SCRATCH_WS}` });
  console.log(`   send() returned after ${Date.now() - tSend} ms; streaming=${(last as ChatState | null)?.isStreaming} listed=${backend.conversations().some((c) => c.id === viewId)}`);
  try {
    const done = await waitFor(
      'reply',
      () => {
        const s = last as ChatState | null;
        return !!s && sawStreaming && !s.isStreaming && s.messages.some((m) => m.role === 'ASSISTANT') && !s.messages.some((m) => m.isStreaming);
      },
      150_000,
    );
    console.log(`   turn ${done ? 'finished' : 'did NOT finish'} after ${((Date.now() - tSend) / 1000).toFixed(1)} s, emits=${emits}, workingLabels=${JSON.stringify([...labels])}`);
    await sleep(1500); // the reload after the turn (400 ms)
    const s = backend.getState(viewId);
    console.log(`   conversation: id=${s.conversation?.id} title=${JSON.stringify(s.conversation?.title)} model=${s.conversation?.modelId} running=${s.conversation?.isRunning} ws=${s.conversation?.workspaceUri}`);
    console.log(`   error=${s.error} approvals=${s.approvals.length}`);
    dumpMessages(s.messages);
    const reply = s.messages.filter((m) => m.role === 'ASSISTANT').pop();
    console.log(`   reply text: ${JSON.stringify(reply?.content.replace(/<!-- thought(:streaming)? -->[\s\S]*?<!-- \/thought -->/g, '').trim())}`);
    const listed = backend.conversations().find((c) => c.id === viewId);
    console.log(`   listed under view id: ${!!listed} (server id ${ses}); externalId(view id) = ${backend.externalId(viewId)}`);
    const user = s.messages.find((m) => m.role === 'USER');
    console.log(`   user bubble attachments: ${JSON.stringify(user?.attachments.map((a) => ({ name: a.name, mime: a.mimeType, size: a.size })))}`);
    const hits = await backend.search('Reply with exactly');
    console.log(`   search("Reply with exactly") → ${JSON.stringify(hits)}`);
  } finally {
    unsub();
    try {
      await backend.conversationAction(viewId, 'delete');
      console.log('   deleted the test chat');
    } catch (e) {
      console.log(`   DELETE FAILED: ${e instanceof Error ? e.message : e}`);
    }
    await backend.refreshSessions();
    const still = backend.conversations().some((c) => c.id === viewId || c.id === ses);
    let gone = false;
    try {
      await backend.client.get(`/session/${ses}`);
    } catch {
      gone = true;
    }
    console.log(`   after delete: listed=${still} GET /session/${ses} fails=${gone}`);
  }
}

async function main() {
  log('start');
  backend.start();
  await waitFor('online', () => backend.status().state === 'online', 90_000);
  await waitFor('models + chats + events', () => backend.models().models.length > 0 && backend.conversations().length > 0 && backend.isConnected, 90_000);
  const st = backend.status();
  console.log(`\n== status: ${st.state} ${st.detail} events=${backend.isConnected}`);
  const ms = backend.models();
  console.log(`== models: ${ms.models.length} selected=${ms.selectedId} groups=${JSON.stringify(ms.groups)}`);
  for (const m of ms.models) console.log(`     ${m.isDefault ? '*' : ' '} ${m.id.padEnd(40)} ${m.displayName.padEnd(28)} ${m.description} [group=${m.group}]`);
  console.log(`== agents: ${backend.agents.map((a) => a.id).join(', ')}`);
  console.log(`== controls(null): ${JSON.stringify(backend.controls(null).map((c) => ({ id: c.id, value: c.value, label: c.label, options: c.options?.map((o) => o.value), icon: c.icon, tone: c.tone })))}`);
  console.log(`== commands: ${backend.commands().length}`);
  const convs = backend.conversations();
  console.log(`\n== conversations: ${convs.length}`);
  for (const c of convs) console.log(`     ${c.id} ${JSON.stringify(c.title)} model=${c.modelId} running=${c.isRunning} archived=${c.archived} ws=${c.workspaceUri} updated=${new Date(c.updatedAt).toISOString()}`);

  for (const c of convs.slice(0, 3)) await openChat(c.id, c.title);

  console.log('\n== host hooks');
  const first = convs[0];
  if (first) {
    console.log(`   externalId(${first.id}) = ${backend.externalId(first.id)}`);
    const msgs = await backend.loadMessages(first.id);
    console.log(`   loadMessages(${first.id}) → ${msgs.length} messages`);
  }
  const ts = Date.now();
  const hits = await backend.search('hello');
  console.log(`   search("hello") → ${hits.length} hits in ${Date.now() - ts} ms: ${JSON.stringify(hits).slice(0, 300)}`);
  const ts2 = Date.now();
  const hits2 = await backend.search('plan');
  console.log(`   search("plan") (cached) → ${hits2.length} hits in ${Date.now() - ts2} ms: ${JSON.stringify(hits2.map((h) => h.snippet.slice(0, 80)))}`);
  console.log(`   search("zzqqxx-none") → ${(await backend.search('zzqqxx-none')).length} hits`);
  await backend.toolAction('no-such-chat-id', 'tool', 'approve');
  console.log('   toolAction on an unknown chat: no-op');

  console.log('\n== sign-in forms (from /integration, nothing sent)');
  const integ = integrations(await backend.client.get('/integration'));
  const withForms = integ.filter((i) => i.methods.some((m) => m.form.length));
  console.log(`   ${integ.length} providers, ${withForms.length} with method questions`);
  for (const i of withForms.slice(0, 4)) {
    for (const m of orderedMethods(i).filter((x) => x.form.length).slice(0, 1)) {
      const fields = formFields(m);
      console.log(`   ${i.id} / ${m.type}:${m.id ?? ''} "${m.label ?? ''}" fields=${JSON.stringify(fields.map((f) => `${f.id}:${f.kind}${f.required ? '*' : ''}${f.value ? `=${f.value}` : ''}`))}`);
      const empty = answersFrom(m, {});
      console.log(`      visible(empty)=${visibleFields(m.form, empty).map((f) => f.key).join(',')} missing(empty)=${missing(m.form, empty)} answer(defaults)=${JSON.stringify(answer(m.form, empty))}`);
    }
  }

  console.log('\n== settings');
  const root = backend.settings.rootItem() as any;
  console.log(`   rootItem: ${root.kind} ${root.id} "${root.label}" ${root.description} badge=${root.badge}`);
  for (const id of ['opencode', 'opencode.permissions', 'opencode.providers', 'opencode.models', 'opencode.mcp', 'opencode.cli']) dumpPage(await backend.settings.page(id));
  const prov = await backend.settings.page('opencode.providers');
  const quick = prov?.sections.flatMap((x) => x.items).find((x) => x.id === 'quick') as any;
  for (const r of quick?.rows ?? []) console.log(`     quick ${r.id}: ${r.actions.map((a: any) => `${a.id} "${a.label.slice(0, 60)}"${a.form ? ` form=[${a.form.map((f: any) => f.id).join(',')}]` : ''}`).join(' | ')}`);
  await sleep(1500);
  console.log('   main page again (counts loaded in the background):');
  dumpPage(await backend.settings.page('opencode'));

  if (process.env.LIVE === '1') await liveTest();
  else console.log('\n== live test skipped (LIVE=1 to run it)');

  console.log(`\n== toasts: ${JSON.stringify(toasts)}`);
  console.log(`== backend changes: ${JSON.stringify(changes)}`);
  console.log(`== event types seen: ${JSON.stringify(eventTypes)}`);
  backend.dispose();
  log('done');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED', e);
  backend.dispose();
  process.exit(1);
});
setTimeout(() => {
  console.log('GLOBAL TIMEOUT');
  backend.dispose();
  process.exit(2);
}, 6 * 60_000).unref();
