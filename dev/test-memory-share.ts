// Offline test of Crew Phases 7-8 wired in (docs/crew/PLAN.md §12, §14, §15): a fact told in a DM is filed by
// capture and used later in a room (stable prompt + recall), crew_memory (add / search / forget / prefer → every bot),
// the bot editor's memory actions; crew packages: the library, review then Add (names, Chief, rooms, paused
// automations, playbooks, starter notes), export without secrets and import again, a GitHub link; crew_admin
// (overview, send to a bot and a room + wait, make a bot, import, export). Fake agents; a crew in a temp folder.
//   npx esbuild dev/test-memory-share.ts --bundle --platform=node --outfile=<tmp>/t.js && node <tmp>/t.js
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, ChatMessage } from '../shared/model';
import type { HostToView } from '../shared/protocol';
import { CrewEngine, MEMORY_TIMING } from '../src/core/crew/engine';
import { RoomEngine } from '../src/core/crew/rooms/engine';
import type { ThreadRecord } from '../src/core/crew/types';
import type { McpServerDef } from '../src/core/mcp/server';
import type { AgentBackend, ChatState, SendRequest } from '../src/core/types';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 700)}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, f: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
MEMORY_TIMING.captureQuietMs = 300;

let script: (who: string, text: string) => { text: string; delay?: number } = (who) => ({ text: `${who} ok` });
class FakeBackend {
  chats = new Map<string, ChatState>();
  subs = new Map<string, Set<(s: ChatState) => void>>();
  sent: (SendRequest & { who: string })[] = [];
  constructor(readonly kind: AgentKind) {}
  status() {
    return { kind: this.kind, label: this.kind, state: 'online' as const };
  }
  conversations() {
    return [];
  }
  models() {
    return { agent: this.kind, models: [], selectedId: null };
  }
  subscribe(id: string, l: (s: ChatState) => void) {
    let s = this.subs.get(id);
    if (!s) this.subs.set(id, (s = new Set()));
    s.add(l);
    return () => s!.delete(l);
  }
  getState(id: string): ChatState {
    let st = this.chats.get(id);
    if (!st) {
      st = { conversation: null, agent: this.kind, messages: [], isStreaming: false, isLoading: false, error: null, queued: [], approvals: [], question: null, artifacts: [], workingLabel: null };
      this.chats.set(id, st);
    }
    return st;
  }
  private emit(id: string) {
    const st = this.chats.get(id)!;
    for (const l of this.subs.get(id) ?? []) l({ ...st, messages: [...st.messages] });
  }
  async send(req: SendRequest) {
    const who = /# You are ([\p{L}\p{N}_-]+)/u.exec(req.setup?.instructions ?? '')?.[1] ?? (/durable facts|worth remembering/i.test(req.text) ? 'CAPTURE' : '?');
    this.sent.push({ ...req, who });
    const r = script(who, req.text);
    const st = this.getState(req.conversationId);
    st.messages.push(msg('USER', req.text));
    st.isStreaming = true;
    this.emit(req.conversationId);
    setTimeout(() => {
      st.messages.push(msg('ASSISTANT', r.text));
      st.isStreaming = false;
      this.emit(req.conversationId);
    }, r.delay ?? 700);
  }
  async approval() {}
  async answer() {}
  async stop(id: string) {
    const st = this.getState(id);
    st.isStreaming = false;
    this.emit(id);
  }
  async conversationAction() {}
}
let n = 0;
const msg = (role: 'USER' | 'ASSISTANT', content: string): ChatMessage => ({ id: `m${++n}`, conversationId: '', role, content, toolCalls: [], isStreaming: false, attachments: [], createdAt: Date.now() }) as ChatMessage;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-memshare-'));
const backends: Partial<Record<AgentKind, FakeBackend>> = { CLAUDE: new FakeBackend('CLAUDE'), CODEX: new FakeBackend('CODEX') };
const active: HostToView[] = [];
const saved: { name: string; content: string }[] = [];
const crew = new CrewEngine({ mcpUrl: (p) => `http://127.0.0.1:1${p}`, mcpHeaders: () => ({}), root: path.join(tmp, 'crew'), groupsDir: path.join(tmp, 'none') });
crew.bind({
  backend: (k) => backends[k] as unknown as AgentBackend | undefined,
  enabledKinds: () => ['CLAUDE', 'CODEX'],
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => tmp,
  showChat: () => undefined,
  postActive: (m) => active.push(m),
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  openFile: () => undefined,
  saveText: async (name, content) => void saved.push({ name, content }),
  log: () => undefined,
});
const rooms = new RoomEngine(crew.rooms);
crew.onRoomsChanged = () => rooms.refresh();
crew.roomReport = (r, b, t) => rooms.reportTurn(r, b, t);
crew.roomPost = (r, b, t, l) => rooms.postAs(r, b, t, l);
crew.removeFromRooms = (id) => rooms.removeBotEverywhere(id);
crew.roomsHook = {
  create: (i) => rooms.create(i),
  addMember: (r, b) => void rooms.addMember(r, b),
  update: (r, d) => rooms.update(r, d),
  remove: (r) => rooms.remove(r),
  post: (r, t) => rooms.post(r, t),
  busy: (r) => rooms.summaries().find((x) => x.id === r)?.active ?? false,
  transcript: (r, k) => rooms.readTranscript(r, k),
  pause: (r) => rooms.pause(r),
  lines: (r) => rooms.find(r)?.messages.map((x) => ({ from: x.from, name: x.name, text: x.text })) ?? [],
};
rooms.bind({
  backend: (k) => backends[k] as unknown as AgentBackend | undefined,
  enabledKinds: () => ['CLAUDE', 'CODEX'],
  conversations: () => [],
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => tmp,
  showChat: () => undefined,
  postActive: () => undefined,
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  log: () => undefined,
  crew: () => crew.roomApi(),
});
const mcpBase = crew.crew.mcp();
async function tool(thread: ThreadRecord, name: string, args: Record<string, unknown>) {
  crew.crew.identity.beginTurn(thread.id);
  const def = mcpBase.resolve!(new URLSearchParams({ t: thread.id, cap: crew.crew.identity.cap(thread.id) })) as McpServerDef;
  const r = await def.call(name, args, { meta: null });
  return { text: (r.content[0] as any).text as string, error: !!r.isError };
}
const admin = crew.adminMcp();
const adm = async (name: string, args: Record<string, unknown>) => {
  const r = await admin.call(name, args, { meta: null });
  return { text: (r.content[0] as any).text as string, error: !!r.isError };
};

async function main() {
  console.log('memory: a fact told in a DM, used later in a room');
  const ada = crew.createBot({ name: 'Ada', agent: 'CLAUDE', access: 'talk', chattiness: 0 });
  crew.updateBot(ada.id, { memoryCapture: true });
  script = (who, text) => (who === 'CAPTURE' ? { text: /Miso/.test(text) ? '- Sam\'s cat is called Miso\n- [pets] Miso is a grey tabby' : 'NOTHING', delay: 100 } : { text: who === 'Ada' && /cat/.test(text) ? 'What a lovely name!' : 'ok' });
  active.length = 0;
  crew.openDm(ada.id);
  const tag = (active.find((m) => m.type === 'crewDm') as any).tag;
  await backends.CLAUDE!.send(crew.prepareSend({ conversationId: 'dm-ada', isNew: true, text: 'My cat is called Miso, she is a grey tabby.', attachments: [], modelId: null, workspaceUri: null }, 'CLAUDE', tag.threadId));
  await until('filed', () => crew.memory.notes(ada.id).some((m) => /Miso/.test(m.text)), 15_000);
  const notes = crew.memory.notes(ada.id);
  check('capture filed the fact (core) and a detail (topic), from the DM', notes.some((m) => m.where === 'core' && /cat is called Miso/.test(m.text) && m.from === 'DM') && notes.some((m) => m.where === 'pets'), notes.map((m) => [m.where, m.text, m.from]));
  const room = rooms.create({ title: 'Home', userName: 'Sam' });
  rooms.addMember(room.id, ada.id);
  script = (who) => ({ text: `${who}: sure` });
  rooms.post(room.id, '@Ada what should we get Miso for her birthday?');
  await until('answered', () => rooms.find(room.id)!.messages.some((m) => m.from === ada.id));
  const roomSend = backends.CLAUDE!.sent.filter((s) => s.who === 'Ada').at(-1)!;
  check('later, in a room: the fact is in its prompt', roomSend.setup!.instructions.includes('## Your memory') && /cat is called Miso/.test(roomSend.setup!.instructions));
  check('and the matching topic note is recalled in front of the turn', /🧠 You remember/.test(roomSend.text) && /grey tabby/.test(roomSend.text), roomSend.text.slice(0, 400));
  const dmT = crew.crew.store.thread(tag.threadId)!;
  const add = await tool(dmT, 'crew_memory', { action: 'add', text: 'Sam ships on Fridays', topic: 'work' });
  const search = await tool(dmT, 'crew_memory', { action: 'search', text: 'friday ships' });
  check('crew_memory add / search', /Noted under work/.test(add.text) && /ships on Fridays/.test(search.text), [add.text, search.text]);
  const pref = await tool(dmT, 'crew_memory', { action: 'prefer', text: 'Sam likes short answers' });
  const tess = crew.createBot({ name: 'Tess', agent: 'CODEX' });
  check('prefer: every bot knows it (About you in their prompt)', /every bot/.test(pref.text) && crew.crew.setupFor({ ...dmT, id: 'x', botId: tess.id, engine: 'CODEX' }).instructions.includes('Sam likes short answers'));
  check('About you lists who added it', crew.state().aboutMe.some((l) => l.text === 'Sam likes short answers' && l.by === 'Ada'));
  const forget = await tool(dmT, 'crew_memory', { action: 'forget', text: 'ships on Fridays' });
  check('forget', /Forgot/.test(forget.text) && !crew.memory.notes(ada.id).some((m) => /Fridays/.test(m.text) && m.struck === null));
  const view = crew.state().bots.find((b) => b.id === ada.id)!.memory;
  await crew.handle('v', () => undefined, { type: 'crewAction', action: 'undoMemory', botId: ada.id, data: { id: view.undo!.id } });
  check('the editor\'s Undo brings the forgotten note back', crew.memory.notes(ada.id).some((m) => /Fridays/.test(m.text) && m.struck === null));
  await crew.handle('v', () => undefined, { type: 'crewAction', action: 'aboutMe', data: { text: 'I work in TypeScript' } });
  check('you can add to About you', crew.state().aboutMe.some((l) => l.text === 'I work in TypeScript' && l.by === 'you'));

  console.log('crew packages: the library, review, Add');
  let imp: any = null;
  const post = (m: HostToView) => m.type === 'crewImport' && (imp = m);
  await crew.handle('v', post, { type: 'crewAction', action: 'library' });
  check('the library lists ready-made crews', imp?.library?.some((l: any) => l.id === 'feature-squad') && imp.library.length >= 4);
  await crew.handle('v', post, { type: 'crewAction', action: 'importPreview', data: { library: 'feature-squad' } });
  const pv = imp.preview;
  check('a review: faces, the Chief, the room', pv?.bots.map((b: any) => b.name).join() === 'Nora,Bob,Tess2,Rita' && pv.chief === 'Nora' && pv.rooms[0].name === 'Squad', pv);
  check('a name already taken gets a number', pv.bots[2].from === 'Tess');
  const r = await crew.handle('v', () => undefined, { type: 'crewAction', action: 'importApply', data: { library: 'feature-squad' } });
  const nora = crew.crew.store.bots().find((b) => b.name === 'Nora')!;
  check('Add made the bots, the Chief and the room', /Added 4 bots, 1 room/.test(String(r)) && crew.chief.chiefId() === nora.id && rooms.summaries().some((x) => x.title === 'Squad' && x.bots.length === 4), r);
  check('access is at most what it asked (and at most Edit)', crew.crew.store.bots().find((b) => b.name === 'Rita')!.access === 'read' && crew.crew.store.bots().find((b) => b.name === 'Bob')!.access === 'edit');
  await crew.handle('v', () => undefined, { type: 'crewAction', action: 'importApply', data: { library: 'bug-hunters' } });
  const inv = crew.automations.store.all().find((a) => a.name === 'Investigate failing tests')!;
  check('its automation arrives paused, as a sentence', !!inv && inv.paused && /When tests fail, Tracy/.test(crew.automations.sentence(inv)));

  console.log('export, then import it again; a GitHub link');
  crew.updateBot(nora.id, { soul: `${crew.crew.store.soul(nora.id)}\nDeploy token: ghp_abcdefghijklmnopqrstuvwxyz0123456789` });
  const ex = await crew.handle('v', () => undefined, { type: 'crewAction', action: 'export', data: { botIds: [nora.id, crew.crew.store.bots().find((b) => b.name === 'Bob')!.id], name: 'Two of us' } });
  const file = saved.at(-1)!;
  check('export saves one file without the secret', file.name === 'two-of-us.crew.md' && /antigem-crew: 1/.test(file.content) && !file.content.includes('ghp_') && /1 secret/.test(String(ex)), [file.name, String(ex)]);
  await crew.handle('v', post, { type: 'crewAction', action: 'importPreview', data: { text: file.content } });
  check('it reads back (names numbered)', imp.preview?.bots.map((b: any) => b.name).sort().join() === 'Bob2,Nora2', imp.preview?.bots);
  (crew.sharing as any).d.fetch = async (u: string) => ({ ok: u.endsWith('/crew.md'), status: u.endsWith('/crew.md') ? 200 : 404, text: async () => file.content });
  await crew.handle('v', post, { type: 'crewAction', action: 'importPreview', data: { url: 'https://github.com/someone/team' } });
  check('a GitHub repo link finds its crew.md', imp.preview?.from === 'https://raw.githubusercontent.com/someone/team/HEAD/crew.md' && imp.preview.bots.length === 2, imp);
  await crew.handle('v', post, { type: 'crewAction', action: 'importPreview', data: { text: 'just words' } });
  check('a file that is not a crew: a clear error', !!imp.error && !imp.preview);

  console.log('crew_admin (Jarvis, other chats)');
  const ov = JSON.parse((await adm('crew_overview', {})).text);
  check('overview: the Chief, bots, rooms, automations', ov.chief === 'Nora' && ov.bots.some((b: any) => b.name === 'Bob') && ov.rooms.some((x: any) => x.name === 'Squad') && ov.automations.length >= 1, { chief: ov.chief, rooms: ov.rooms, autos: ov.automations });
  script = (who) => ({ text: who === 'Bob' ? 'Built it.' : `${who} here` });
  const sent = await adm('crew_send', { to: '@Bob', text: 'Build the login page.', send_id: 'abc' });
  const again = await adm('crew_send', { to: '@Bob', text: 'Build the login page.', send_id: 'abc' });
  const id = /id (s_[0-9a-f]+)/.exec(sent.text)![1];
  check('send to a bot; the same send_id is sent once', /Already sent: id s_/.test(again.text) && backends.CLAUDE!.sent.filter((s) => s.who === 'Bob' && /login page/.test(s.text)).length <= 1);
  const w = JSON.parse((await adm('crew_wait', { id, timeout: 20 })).text);
  check('wait: its answer', w.status === 'done' && w.answer === 'Built it.', w);
  const rs = await adm('crew_send', { to: '#Squad', text: '@Rita review it' });
  const rw = JSON.parse((await adm('crew_wait', { id: /id (s_[0-9a-f]+)/.exec(rs.text)![1], timeout: 30 })).text);
  check('send to a room (as you), wait for the replies', rw.status === 'done' && rw.replies.some((x: any) => x.from === 'Rita'), rw);
  const mk = await adm('crew_create_bot', { name: 'Zed', title: 'helper', access: 'full' });
  check('make a bot (at most Edit)', /Made @Zed/.test(mk.text) && crew.crew.store.bots().find((b) => b.name === 'Zed')!.access === 'edit');
  const ad = await adm('crew_import', { library: 'docs-team' });
  check('import from the library', /Added 2 bots, 1 room/.test(ad.text), ad.text);
  const exp = await adm('crew_export', { bots: ['Zed'] });
  check('export', /antigem-crew: 1/.test(exp.text) && /name: Zed/.test(exp.text));
  const no = await adm('crew_delete_bot', { bot: 'Zed' });
  check('no deleting from outside', no.error);

  rooms.dispose();
  crew.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
