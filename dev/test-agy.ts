// Headless test of the Antigravity (agy) backend against the running bridge + hub (never stops or restarts them).
//   npx esbuild dev/test-agy.ts --bundle --platform=node --target=node20 --outfile=dist/test-agy.js; node dist/test-agy.js [--no-send]
// Read-only on the user's data: account, models + usage limits, chat list, existing chats (media, model, search), every
// settings page the backend draws (nothing is written: byte patches are built and decoded, never sent).
// Unless --no-send: ONE tiny new chat in the scratch workspace (a command that waits for approval, is terminated while
// it runs, a queued message), then removed through rewind of its first prompt (which deletes it). No settings writes,
// no sign-in / out, no installs.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../shared/model';
import type { SettingsPage } from '../shared/protocol';
import { BridgeManager } from '../src/core/bridge/BridgeManager';
import { AgyBackend } from '../src/core/agy/AgyBackend';
import { decodeAs, encodeAs, lengthDelimited, patchMessage, rawFields } from '../src/core/agy/proto';
import type { ChatState, KeyValueStore } from '../src/core/types';

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = '/tmp/claude-1000/-home-cat-agy-cli-hub-antiGem/b3105e30-1c88-43b9-a135-671615f51faa/scratchpad/agy-test-ws';
const stateDir = path.join(os.homedir(), '.antigem-vscode-dev');
const log = (l: string) => console.log(new Date().toISOString().slice(11, 19), l);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_SEND = process.argv.includes('--no-send');

// in memory: nothing of the test lands in the dev server's state file
const mem = new Map<string, unknown>();
const kv: KeyValueStore = { get: <T>(k: string) => mem.get(k) as T | undefined, set: (k, v) => void mem.set(k, v) };

fs.mkdirSync(WORKSPACE, { recursive: true });
const bridge = new BridgeManager({
  binPath: path.join(ROOT, 'bin', 'antigem-bridge-linux-x64'),
  port: 1244,
  hubPort: 1245,
  workspaceDir: WORKSPACE,
  logFile: path.join(stateDir, 'bridge.log'),
  agyDataDir: () => 'antigravity-ide',
  log,
});

const opened: string[] = [];
const openedFiles: string[] = [];
const toasts: string[] = [];
const backend = new AgyBackend(bridge, kv, (l) => log(l), { openUrl: (u) => opened.push(u), openFile: (p) => openedFiles.push(p) });
backend.setNotifier((level, message) => toasts.push(`${level}: ${message}`));
// the test chat must not re-point the hub's default project (a project write): skipped here
(backend as unknown as { pointDefaultProject: (u: string) => Promise<void> }).pointDefaultProject = async (u) => log(`   (test: UpdateProject of the default project to ${u} skipped)`);

let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
};
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n).replace(/\n/g, '⏎')}…(${s.length})` : s.replace(/\n/g, '⏎'));

function printMessages(msgs: ChatMessage[], max = 12) {
  for (const m of msgs.slice(-max)) {
    const tu = m.tokenUsage ? ` tokens{in ${m.tokenUsage.promptTokens} out ${m.tokenUsage.outputTokens} ${m.tokenUsage.durationMs}ms ${m.tokenUsage.model}}` : '';
    console.log(`  [${m.role}] ${m.id.slice(0, 44)} model=${m.modelId ?? '-'} streaming=${m.isStreaming}${tu}`);
    console.log(`     content: ${clip(m.content)}`);
    for (const a of m.attachments) console.log(`     attachment: ${a.name} image=${a.isImage} b64=${a.base64 ? a.base64.length : 0} path=${clip(a.path, 60)}`);
    for (const t of m.toolCalls.slice(0, 5))
      console.log(`     tool ${t.toolType} ${t.name} [${t.status}] exit=${t.exitCode ?? '-'} ${t.interactionType ?? ''}: ${clip(t.command, 70)} | out ${clip(t.output, 70)}`);
    if (m.toolCalls.length > 5) console.log(`     … ${m.toolCalls.length - 5} more tools`);
  }
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
          ? ` = ${clip(String(it.value), 80)}${it.kind === 'select' ? ` [${it.options.map((o) => o.value).join('|')}]` : ''}`
          : it.kind === 'toggle'
            ? ` = ${it.value}`
            : it.kind === 'quota'
              ? ` = ${JSON.stringify(it.groups)}`
              : it.kind === 'list'
                ? ` rows=${it.rows.length}`
                : it.kind === 'page'
                  ? ` → ${it.description ?? ''} [${it.badge ?? ''}]`
                  : it.kind === 'button'
                    ? ` (${it.description ?? ''})${it.disabled ? ' disabled' : ''}`
                    : '';
      console.log(`     ${it.kind} ${it.id} "${it.label}"${v}`);
      if (it.kind === 'list')
        for (const r of it.rows.slice(0, 4))
          console.log(`        · ${clip(r.title, 50)} [${r.status ?? ''}] ${clip(r.subtitle ?? '', 70)} {${(r.actions ?? []).map((a) => a.id).join(',')}}${r.toggle != null ? ` toggle=${r.toggle}` : ''}`);
    }
  }
}

/** Opens a chat, waits until `ok`, and checks unchanged messages keep their identity between emits. */
async function openChat(id: string, ok: (s: ChatState) => boolean, timeoutMs = 45_000): Promise<ChatState | null> {
  let last: ChatState | null = null;
  const unsub = backend.subscribe(id, (s) => {
    last = s;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !(last && ok(last))) await sleep(200);
  await sleep(1500); // media / model adoption land a moment later
  const before = last as ChatState | null;
  backend.getState(id);
  await sleep(300);
  unsub();
  return before;
}

async function hubReachable(): Promise<boolean> {
  try {
    const r = await fetch('http://127.0.0.1:1244/api/health', { signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function main() {
  // never start a bridge from here: it must already be running
  if (!(await hubReachable())) {
    log('the bridge on 127.0.0.1:1244 is not running: nothing tested (this test never starts it)');
    process.exit(3);
  }
  backend.start();
  const t0 = Date.now();
  while (backend.status().state !== 'online' && Date.now() - t0 < 90_000) await sleep(300);
  check(backend.status().state === 'online', `hub online (${JSON.stringify(backend.status())})`);
  while (backend.settings.signedIn() === null && Date.now() - t0 < 30_000) await sleep(200);
  const st0 = backend.status();
  log(`status: ${JSON.stringify(st0)}`);
  check(backend.settings.signedIn() !== null, `account known (signed in: ${backend.settings.signedIn()}, account ${st0.account})`);

  // ---- models, limits, quota group override (memory store only)
  while ((!backend.models().models.length || !backend.models().groups?.length) && Date.now() - t0 < 60_000) await sleep(300);
  const ms = backend.models();
  log(`models: ${ms.models.length}, selected ${ms.selectedId}, groups ${JSON.stringify(ms.groups)}`);
  for (const m of ms.models) console.log(`  ${m.id} key=${m.key} "${m.displayName}" base=${m.baseName} tier=${m.tier} group=${m.group} pill=${m.quotaText}`);
  check(ms.models.length > 0, 'models listed');
  check(!!ms.selectedId && ms.models.some((m) => m.id === ms.selectedId), 'a listed model is selected');
  if ((ms.groups?.length ?? 0) > 1) {
    const m = ms.models[0];
    const other = ms.groups!.find((g) => g.name !== m.group)!;
    backend.setQuotaGroup(m.id, other.name);
    const moved = backend.models().models.filter((x) => x.baseName === m.baseName);
    check(moved.every((x) => x.group === other.name), `setQuotaGroup moves ${m.baseName} (all tiers) to "${other.name}"`);
    log(`   overrides: ${JSON.stringify(mem.get('agy.quotaOverrides'))}`);
    backend.setQuotaGroup(m.id, null);
    check(backend.models().models.find((x) => x.id === m.id)?.group === m.group, 'setQuotaGroup(null) restores the automatic group');
  }
  await sleep(1000);
  log(`commands: ${backend.commands().length} → ${backend.commands().slice(0, 8).map((c) => `${c.command}(${c.kind})`).join(' ')}`);

  // ---- chat list
  while (!backend.conversations().length && Date.now() - t0 < 60_000) await sleep(300);
  const convs = backend.conversations().sort((a, b) => b.updatedAt - a.updatedAt);
  log(`conversations: ${convs.length} (archived ${convs.filter((c) => c.archived).length}, running ${convs.filter((c) => c.isRunning).length})`);
  for (const c of convs.slice(0, 5)) console.log(`  ${c.id} "${clip(c.title, 50)}" ${new Date(c.updatedAt).toISOString()} ${c.workspaceUri}`);
  check(convs.length > 0, 'chats listed');

  // raw annotations: an archive request is built from the hub's own bytes (decoded here, never sent)
  const rawAnn = (backend as unknown as { rawAnnotations: Map<string, Uint8Array> }).rawAnnotations;
  log(`raw annotations kept for ${rawAnn.size} chats`);
  const titled = convs.find((c) => rawAnn.has(c.id) && c.title);
  if (titled) {
    const ann = patchMessage('ConversationAnnotations', rawAnn.get(titled.id)!, { archived: titled.archived, archival_status_timestamp: { seconds: 1, nanos: 0 } });
    const head = encodeAs('UpdateConversationAnnotationsRequest', { cascade_ids: [titled.id] });
    const req = new Uint8Array([...head, ...lengthDelimited(2, ann)]);
    const back = decodeAs('UpdateConversationAnnotationsRequest', req);
    const orig = decodeAs('ConversationAnnotations', rawAnn.get(titled.id)!);
    check(back.annotations?.title === orig.title && back.merge_annotations !== true && (back.annotations?.archived === true) === titled.archived, `archive request keeps the annotations (title "${clip(String(back.annotations?.title ?? ''), 30)}"), no merge`);
    const explicit = rawFields(ann).some((f) => f.id === 4);
    check(explicit, 'archived written explicitly (also when false)');
  }

  // ---- existing chats (read only): messages, chat model, media, identity
  const sample = convs.filter((c) => !c.isRunning).slice(0, 8);
  let imagesSeen = 0;
  let imagesInline = 0;
  let searchWord = '';
  let searchChat = '';
  for (const c of sample) {
    log(`open ${c.id} "${clip(c.title, 40)}"`);
    const st = await openChat(c.id, (s) => !s.isLoading && (s.messages.length > 0 || !!s.error));
    if (st?.error && !st.messages.length) {
      log(`   error shown: ${st.error}`);
      check(/history|connect|load/i.test(st.error), `chat ${c.id.slice(0, 8)} without history shows an error (no endless retry)`);
      continue;
    }
    if (!st) {
      check(false, `chat ${c.id.slice(0, 8)} loaded`);
      continue;
    }
    const tools = st.messages.flatMap((m) => m.toolCalls);
    const byType: Record<string, number> = {};
    for (const t of tools) byType[`${t.toolType}/${t.status}`] = (byType[`${t.toolType}/${t.status}`] ?? 0) + 1;
    log(`   ${st.messages.length} messages, tools ${JSON.stringify(byType)}, chat model=${st.modelId ?? '-'} notice=${st.notice ?? '-'} error=${st.error ?? '-'} queued=${st.queued.length} approvals=${st.approvals.length}`);
    const lastModel = [...st.messages].reverse().find((m) => m.role === 'ASSISTANT' && m.modelId)?.modelId;
    if (lastModel && ms.models.some((m) => m.id === lastModel || m.key === lastModel)) check(!!st.modelId, `chat ${c.id.slice(0, 8)} adopted its model (${st.modelId})`);
    for (const m of st.messages) {
      for (const t of m.toolCalls)
        if (t.toolType === 'GENERATE_IMAGE' && t.status !== 'RUNNING' && t.output) {
          imagesSeen++;
          if (t.output.startsWith('data:image/') || /^https?:/.test(t.output)) imagesInline++;
          else log(`   image not inlined: ${clip(t.output, 80)}`);
        }
      for (const a of m.attachments)
        if (a.isImage) {
          imagesSeen++;
          if (a.base64) imagesInline++;
          else log(`   attachment image not inlined: ${a.name} ${clip(a.path, 80)}`);
        }
    }
    const usage = st.messages.filter((m) => m.tokenUsage?.model);
    if (usage.length) log(`   usage pill model names: ${[...new Set(usage.map((m) => m.tokenUsage!.model))].join(', ')}`);
    if (!searchWord) {
      // reply text only (thoughts are not searched)
      const visible = (m: ChatMessage) => m.content.replace(/<!-- thought[^>]*-->[\s\S]*?<!-- \/thought -->/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
      const reply = st.messages.find((m) => m.role === 'ASSISTANT' && /[a-z]{9,}/i.test(visible(m)));
      const w = reply ? visible(reply).match(/[A-Za-z]{9,}/)?.[0] : undefined;
      if (w && !c.title.toLowerCase().includes(w.toLowerCase())) {
        searchWord = w;
        searchChat = c.id;
      }
    }
    check(st.messages.some((m) => m.role === 'USER'), `chat ${c.id.slice(0, 8)} shows its prompts`);
  }
  printMessages((await openChat(sample[0].id, (s) => s.messages.length > 0 || !!s.error, 15_000))?.messages ?? [], 4);
  log(`images in the opened chats: ${imagesSeen}, shown inline: ${imagesInline}`);
  if (imagesSeen) check(imagesInline === imagesSeen, 'every image of the opened chats resolved to inline data');
  {
    // hub media: a generated image / attachment given by path becomes inline data (a local file here)
    const img = path.join(ROOT, 'media', 'icon.svg');
    const msg: ChatMessage = {
      id: 'm1',
      conversationId: 'x',
      role: 'ASSISTANT',
      content: '<!-- tool_call:3 -->',
      toolCalls: [{ id: '3', name: 'generate_image', toolType: 'GENERATE_IMAGE', command: 'a logo', status: 'SUCCESS', output: `file://${img}` }],
      isStreaming: false,
      attachments: [{ id: 'a', name: 'pic', path: img, isImage: true, isAudio: false, size: 0 }],
      createdAt: 0,
    };
    let ready = 0;
    const first = backend.media.apply([msg], () => ready++)[0];
    for (let i = 0; i < 50 && !ready; i++) await sleep(50);
    const second = backend.media.apply([msg], () => undefined)[0];
    const again = backend.media.apply([msg], () => undefined)[0];
    check(first === msg && second.toolCalls[0].output.startsWith('data:image/svg+xml;base64,') && !!second.attachments[0].base64 && again === second, 'hub media: paths → inline data, cached, identity kept');
  }

  // ---- search (chat text of chats opened in this run + the hub's summaries)
  if (searchWord) {
    const hits = await backend.search(searchWord);
    log(`search "${searchWord}": ${hits.length} hits ${JSON.stringify(hits.slice(0, 3).map((h) => [h.conversationId.slice(0, 8), clip(h.snippet, 60)]))}`);
    check(hits.some((h) => h.conversationId === searchChat), 'search finds a chat by its content');
  }

  // ---- settings pages (read only)
  log('settings:');
  console.log(`  root item: ${JSON.stringify(backend.settings.rootItem())}`);
  printPage(await backend.settings.page('agy'));
  await sleep(2500); // the main page's background loads (MCP, skills)
  const main = await backend.settings.page('agy');
  printPage(main);
  const rows = main?.sections.flatMap((s) => s.items) ?? [];
  check(rows.some((i) => i.id === 'agy.skills' && i.kind === 'page' && /skills/.test(i.description ?? '')), 'Skills row shows its counts');
  check(rows.some((i) => i.id === 'agy.account' && i.kind === 'info' && i.value !== 'Checking…'), 'account row filled');
  const perms = await backend.settings.page('agy.permissions');
  printPage(perms);
  check(!!perms?.sections.find((s) => s.id === 'projects'), 'project overrides listed');
  log(`   prompts carry auto-run policy: ${mem.get('agy.autoExecPolicy') || '(hub unset → EAGER)'}`);
  printPage(await backend.settings.page('agy.mcp'));
  const cat = await backend.settings.page('agy.mcp.catalog');
  printPage(cat);
  const catRows = cat?.sections[0].items.find((i) => i.kind === 'list');
  check(!!catRows && catRows.kind === 'list' && catRows.rows.length > 0, 'MCP catalog listed');
  await backend.settings.change('agy.mcp.catalog', 'search', 'firebase');
  const catQ = await backend.settings.page('agy.mcp.catalog');
  const catQRows = catQ?.sections[0].items.find((i) => i.kind === 'list');
  log(`   catalog "firebase": ${catQ?.sections[0].description}`);
  check(!!catQRows && catQRows.kind === 'list' && catQRows.rows.length > 0 && catQRows.rows.length < (catRows?.kind === 'list' ? catRows.rows.length : 0), 'catalog search narrows the list');
  if (catQRows?.kind === 'list' && catQRows.rows[0]?.actions?.some((a) => a.id === 'readme')) {
    await backend.settings.action('agy.mcp.catalog', 'plugins', catQRows.rows[0].id, 'readme');
    check(opened.length === 1 && /^https?:/.test(opened[0]), `README opens ${opened[0]}`);
    opened.length = 0;
  }
  for (const scope of ['GLOBAL', 'WORKSPACE', 'ALL']) {
    await backend.settings.change('agy.skills', 'scope', scope);
    const p = await backend.settings.page('agy.skills');
    if (scope === 'GLOBAL') printPage(p);
    else console.log(`  skills ${scope}: ${p?.sections[0].title} — ${p?.sections[0].description}`);
  }
  const sk = await backend.settings.page('agy.skills');
  const skList = sk?.sections[0].items.find((i) => i.kind === 'list');
  if (skList?.kind === 'list' && skList.rows[0]) {
    await backend.settings.action('agy.skills', 'skills', skList.rows[0].id, 'view');
    check(openedFiles.length === 1 && fs.existsSync(openedFiles[0]), `View SKILL.md opens ${openedFiles[0]}`);
  }
  printPage(await backend.settings.page('agy.cli'));
  check(opened.length === 0, 'no URL opened (no sign-in started)');

  // project / default-project byte patches: built and decoded, never sent
  const rawProjects = await backend.callHubRaw('ReadProjects', encodeAs('ReadProjectsRequest', { ids: ['default-cli-project'] }));
  const proj = rawFields(rawProjects).find((f) => f.id === 1)?.payload;
  if (proj) {
    const orig = decodeAs('Project', proj);
    const named = decodeAs('Project', patchMessage('Project', proj, { name: 'agy-test-ws', project_resources: { resources: [{ folder_uri: `file://${WORKSPACE}` }] } }));
    check(
      named.name === 'agy-test-ws' && named.project_resources?.resources?.[0]?.folder_uri === `file://${WORKSPACE}` && JSON.stringify(named.permission_grants) === JSON.stringify(orig.permission_grants) && JSON.stringify(named.settings) === JSON.stringify(orig.settings),
      'default project patch changes only name + folder (rules and settings kept)',
    );
    const fields = rawFields(proj);
    const settings = patchMessage('ProjectSettings', fields.find((f) => f.id === 10)?.payload ?? new Uint8Array(0), { auto_execution_policy: 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER', file_access_policy: 'AGENT_SETTING_POLICY_ALLOW' });
    const withPreset = decodeAs('Project', new Uint8Array([...fields.filter((f) => f.id !== 10).flatMap((f) => [...f.bytes]), ...lengthDelimited(10, settings)]));
    check(withPreset.settings?.auto_execution_policy === 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER' && withPreset.name === orig.name && JSON.stringify(withPreset.project_resources) === JSON.stringify(orig.project_resources), 'project preset patch keeps the project');
  }

  // ---- one tiny new chat
  const signedIn = backend.settings.signedIn() === true;
  if (NO_SEND || !signedIn) {
    log(NO_SEND ? 'skip sending (--no-send)' : 'not signed in: read paths only');
  } else {
    const viewId = randomUUID();
    const flash = ms.models.filter((m) => /flash/i.test(`${m.key} ${m.displayName}`)).sort((a, b) => (a.tier === 'Low' ? -1 : b.tier === 'Low' ? 1 : 0))[0] ?? ms.models[0];
    // "Ask first" for this chat's prompts (an in-memory choice here, the hub's setting is untouched)
    mem.set('agy.autoExecPolicy', 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF');
    log(`new chat ${viewId} in ${WORKSPACE} with ${flash.id} (${flash.displayName})`);
    const states: ChatState[] = [];
    const last = () => states[states.length - 1];
    const unsub = backend.subscribe(viewId, (s) => states.push(s));
    const waitFor = async (what: string, ok: (s: ChatState) => boolean, ms2: number) => {
      const end = Date.now() + ms2;
      while (Date.now() < end) {
        const s = last();
        if (s && ok(s)) return s;
        await sleep(200);
      }
      log(`   (timeout waiting for ${what})`);
      return null;
    };
    const sentAt = Date.now();
    try {
      await backend.send({
        conversationId: viewId,
        isNew: true,
        text: 'Run this shell command in the current directory: `sleep 30 && echo slept`. Then reply with exactly: OK',
        attachments: [],
        modelId: flash.id,
        workspaceUri: `file://${WORKSPACE}`,
      });
      check(last()?.isStreaming === true && last()?.modelId === flash.id, 'sent: streaming at once, chat model set');
      const asked = await waitFor('an approval or the running command', (s) => s.approvals.length > 0 || s.messages.some((m) => m.toolCalls.some((t) => t.toolType === 'BASH' && t.status === 'RUNNING')), 90_000);
      if (asked?.approvals.length) {
        const a = asked.approvals[0];
        const tool = asked.messages.flatMap((m) => m.toolCalls).find((t) => t.id === a.key);
        log(`approval: ${JSON.stringify({ key: a.key, icon: a.icon, title: a.title, preview: a.preview, reason: a.reason, always: a.always.map((x) => x.id), interaction: tool?.interactionType })}`);
        check(!!a.preview?.includes('sleep'), 'approval card built for the command');
        await backend.approval(viewId, a.key, 'once', false);
      } else log('no approval asked (the hub ran it directly)');
      const running = await waitFor('the running command', (s) => s.messages.some((m) => m.toolCalls.some((t) => t.toolType === 'BASH' && t.status === 'RUNNING')), 60_000);
      // a second message while it runs: queued until the agent is done
      await backend.send({ conversationId: viewId, isNew: false, text: 'Reply with exactly: OK', attachments: [], modelId: null, workspaceUri: null });
      const queued = await waitFor('the queue', (s) => s.queued.length > 0, 10_000);
      check(!!queued, `queued message listed (${JSON.stringify(queued?.queued.map((q) => [q.text, q.isPending, q.canSendNow]))})`);
      if (running) {
        const tool = running.messages.flatMap((m) => m.toolCalls).find((t) => t.toolType === 'BASH' && t.status === 'RUNNING')!;
        log(`terminate ${tool.id} (${tool.command}) after ${((Date.now() - sentAt) / 1000).toFixed(1)}s`);
        const tb = Date.now();
        await backend.toolAction(viewId, tool.id, 'terminate');
        const ended = await waitFor('the command to end', (s) => s.messages.flatMap((m) => m.toolCalls).some((t) => t.id === tool.id && t.status !== 'RUNNING'), 20_000);
        const t2 = ended?.messages.flatMap((m) => m.toolCalls).find((t) => t.id === tool.id);
        log(`   command now ${t2?.status} after ${((Date.now() - tb) / 1000).toFixed(1)}s: ${clip(t2?.output ?? '', 80)}`);
        check(!!ended && Date.now() - tb < 15_000, 'running command ended by toolAction (CancelCascadeSteps)');
        await sleep(4000);
        const t3 = last()?.messages.flatMap((m) => m.toolCalls).find((t) => t.id === tool.id);
        log(`   hub's status for it: ${t3?.status}`);
        check(t3?.status !== 'RUNNING', 'the hub confirms the command stopped');
      } else check(false, 'command seen running');
      const done = await waitFor('the queued reply', (s) => !s.isStreaming && s.queued.length === 0 && s.messages.filter((m) => m.role === 'USER').length >= 2, 120_000);
      check(!!done, 'queued message delivered after the run');
      await sleep(2000);
      const final = last();
      log(`emits: ${states.length}, ${((Date.now() - sentAt) / 1000).toFixed(1)}s, notices: ${JSON.stringify([...new Set(states.map((s) => s.notice).filter(Boolean))])}`);
      printMessages(final?.messages ?? []);
      check(final?.conversation?.id === viewId && final.conversation.modelId === flash.id, 'conversation listed with its model');
      const hits = await backend.search('slept');
      check(hits.some((h) => h.conversationId === viewId) || !final?.messages.some((m) => /slept/.test(m.content)), 'search finds the open chat');
      // remove it: ✎ on its first prompt deletes the chat (the app's revert of the first message)
      const first = final?.messages.find((m) => m.role === 'USER');
      if (first) {
        const text = await backend.rewind(viewId, first.id);
        check(!!text?.includes('sleep 30'), 'rewind of the first prompt returns its text');
        await sleep(2500);
        check(!backend.conversations().some((c) => c.id === viewId), 'test chat removed from the list');
      }
    } finally {
      unsub();
      // whatever happened above: the test chat must not stay
      await backend.conversationAction(viewId, 'delete').catch((e) => log(`   (delete: ${e instanceof Error ? e.message : e})`));
    }
  }

  // ---- retry: everything reconnects
  backend.retry();
  await sleep(4000);
  check(backend.status().state === 'online' && backend.conversations().length > 0, 'retry reconnects (hub online, chats listed)');
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
