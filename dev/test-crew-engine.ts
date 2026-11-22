// Offline test of Crew Phase 1 (src/core/crew/engine.ts + rooms/): Group chats copied into rooms, the RoomEngine
// running on them with crew setups, bots edited on the Crew screen vs. in a room, DMs (send hook, faces), delete.
// Fake agent backends, temp folders; no bridge.
//   npx esbuild dev/test-crew-engine.ts --bundle --platform=node --outfile=<tmp>/t.js && node <tmp>/t.js
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, ChatMessage, Conversation } from '../shared/model';
import type { HostToView } from '../shared/protocol';
import { CrewEngine } from '../src/core/crew/engine';
import { RoomEngine } from '../src/core/crew/rooms/engine';
import type { AgentBackend, ChatState, SendRequest } from '../src/core/types';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeBackend {
  chats = new Map<string, ChatState>();
  subs = new Map<string, Set<(s: ChatState) => void>>();
  sent: SendRequest[] = [];
  deleted: string[] = [];
  constructor(readonly kind: AgentKind) {}
  status() {
    return { kind: this.kind, label: this.kind, state: 'online' as const };
  }
  conversations(): Conversation[] {
    return [...this.chats.keys()].map((id) => ({ id, title: 'chat', agent: this.kind, updatedAt: 1 }) as unknown as Conversation);
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
    this.sent.push(req);
    const st = this.getState(req.conversationId);
    st.messages.push(msg('USER', req.text));
    st.isStreaming = true;
    this.emit(req.conversationId);
    setTimeout(() => {
      st.messages.push(msg('ASSISTANT', 'Hello there'));
      st.isStreaming = false;
      this.emit(req.conversationId);
    }, 200);
  }
  async approval() {}
  async answer() {}
  async stop() {}
  async conversationAction(id: string, action: string) {
    if (action === 'delete') this.deleted.push(id);
  }
}
let n = 0;
const msg = (role: 'USER' | 'ASSISTANT', content: string): ChatMessage => ({ id: `m${++n}`, conversationId: '', role, content, toolCalls: [], isStreaming: false, attachments: [], createdAt: Date.now() }) as ChatMessage;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-engine-'));
const root = path.join(tmp, 'crew');
const groupsDir = path.join(tmp, 'groups');
// one Group chat from before the Crew
fs.mkdirSync(path.join(groupsDir, 'g1'), { recursive: true });
fs.writeFileSync(
  path.join(groupsDir, 'g1', 'group.json'),
  JSON.stringify({
    title: 'Old room',
    topic: 'Plans',
    userName: 'Sam',
    mode: 'natural',
    bots: [{ id: 'gb1', name: 'Max', agent: 'CLAUDE', persona: 'You are Max, a designer.', emoji: '🎨', color: '#FF0000', chattiness: 0, access: 'chat', effort: 'default', muted: false, chatId: null, seen: 0 }],
    messages: [{ id: 'm1', from: 'user', name: 'Sam', text: 'Hi', at: 1, attachments: [] }],
    createdAt: 1,
    updatedAt: 2,
  }),
);

const backends: Partial<Record<AgentKind, FakeBackend>> = { CLAUDE: new FakeBackend('CLAUDE'), CODEX: new FakeBackend('CODEX') };
const active: HostToView[] = [];
const shown: string[] = [];
const crew = new CrewEngine({ mcpUrl: (p) => `http://127.0.0.1:1${p}`, mcpHeaders: () => ({ 'X-Device-Id': 'd' }), root, groupsDir });
crew.bind({
  backend: (k) => backends[k] as unknown as AgentBackend | undefined,
  enabledKinds: () => ['CLAUDE', 'CODEX'],
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => tmp,
  showChat: (id) => shown.push(id),
  postActive: (m) => active.push(m),
  refreshConversations: () => undefined,
  pickFolder: async () => path.join(tmp, 'proj'),
  confirm: async () => true,
  openFile: () => undefined,
  log: () => undefined,
});
const groups = new RoomEngine(crew.rooms);
groups.bind({
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
crew.removeFromRooms = (id) => groups.removeBotEverywhere(id);
crew.onRoomsChanged = () => groups.refresh();

async function settle(id: string) {
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (!groups.summaries().find((s) => s.id === id)?.active) return;
  }
}

async function main() {
  console.log('migration');
  const room = crew.crew.store.room('g1');
  const max = crew.crew.store.bots().find((b) => b.name === 'Max')!;
  check('the Group chat became a room with its bot', !!room && room.userName === 'Sam' && !!max && room.members[0] === max.id);
  check('the group engine sees it', groups.summaries().some((s) => s.id === 'g1' && s.title === 'Old room'));

  console.log('a room turn runs as the crew bot');
  groups.post('g1', '@Max hello');
  await settle('g1');
  const claude = backends.CLAUDE!;
  const roomSend = claude.sent.at(-1)!;
  check('the room bot got its crew setup (persona from SOUL.md, crew server)', !!roomSend.setup && roomSend.setup.instructions.includes('You are Max, a designer.') && roomSend.setup.access === 'talk' && roomSend.setup.mcp[0]?.name === 'crew');
  const th = crew.crew.store.threads().find((t) => t.kind === 'room' && t.roomId === 'g1');
  check('its room chat is a room thread', !!th && th.chatId === roomSend.conversationId && th.botId === max.id);
  check('the turn ended (crew tools stop answering after the grace)', !crew.crew.identity.inTurn(th!.id, Date.now() + 60_000));
  const lines = crew.crew.store.transcript('g1');
  await sleep(400);
  const lines2 = crew.crew.store.transcript('g1');
  check('the room transcript has the new messages', lines2.length >= 3 && lines2.some((l) => l.from === max.id && l.text.includes('Hello there')), { before: lines.length, after: lines2.map((l) => l.text) });

  console.log('editing a bot on the Crew screen vs. in a room');
  crew.updateBot(max.id, { soul: 'You are Max, now a sculptor.', title: 'artist' });
  check('SOUL.md changed', crew.crew.store.soul(max.id) === 'You are Max, now a sculptor.');
  check('the room read it again', groups.find('g1')!.bots[0].persona === 'You are Max, now a sculptor.');
  // a stale copy saving must not undo it: the room changes something else
  groups.update('g1', { topic: 'New plans' });
  await sleep(500);
  check('a room save keeps the Crew edit', crew.crew.store.soul(max.id) === 'You are Max, now a sculptor.' && crew.crew.store.bot(max.id)!.title === 'artist');
  groups.updateBot('g1', 'Max', { persona: 'You are Max, a painter.' } as any);
  await sleep(500);
  check('a room edit of the persona reaches SOUL.md', crew.crew.store.soul(max.id) === 'You are Max, a painter.');
  const added = groups.addBot('g1', { name: 'Rex', agent: 'CODEX', persona: 'You are Rex.' } as any);
  await sleep(500);
  check('a bot added in a room is a crew bot', crew.crew.store.bot(added.id)?.name === 'Rex' && crew.crew.store.soul(added.id) === 'You are Rex.');

  console.log('bots on the Crew screen');
  let threw = '';
  try {
    crew.createBot({ name: 'max' });
  } catch (e) {
    threw = String(e);
  }
  check('names are unique in the crew', /already a bot called/.test(threw), threw);
  threw = '';
  try {
    crew.createBot({ name: 'everyone' });
  } catch (e) {
    threw = String(e);
  }
  check('reserved names are refused', /reserved/.test(threw), threw);
  const ada = crew.createBot({ name: 'Ada', agent: 'CODEX', access: 'talk', modelId: 'gpt-x', soul: 'You are Ada.', effort: 'low' });
  check('a new bot with its soul', crew.crew.store.soul(ada.id) === 'You are Ada.' && ada.engine === 'CODEX' && ada.access === 'talk');
  const st = crew.state();
  check('state lists bots with soft notes', st.bots.some((b) => b.id === ada.id && !!b.softNote) && st.softNotes.CODEX?.talk !== undefined && st.softNotes.CLAUDE?.talk === undefined);
  crew.updateBot(ada.id, { access: 'full', accessCeiling: 'edit' });
  check('raising above the ceiling raises the ceiling', crew.crew.store.bot(ada.id)!.accessCeiling === 'full');

  console.log('DMs');
  crew.openDm(ada.id);
  const dm = active.find((m) => m.type === 'crewDm') as Extract<HostToView, { type: 'crewDm' }> | undefined;
  check('opening a new DM asks the view for an empty chat of the bot', !!dm && dm.agent === 'CODEX' && dm.tag.name === 'Ada' && dm.modelId === 'gpt-x');
  crew.updateBot(ada.id, { access: 'talk' });
  const base: SendRequest = { conversationId: 'chat-ada', isNew: true, text: 'hi', attachments: [], modelId: 'other', workspaceUri: 'file:///proj' };
  const out = crew.prepareSend(base, 'CODEX', dm!.tag.threadId);
  check('its first message: setup, the bot’s model and effort, its own folder (talk)', !!out.setup && out.modelId === 'gpt-x' && out.effort === 'low' && !!out.workspaceUri?.includes(path.join('bots', ada.id, 'files')));
  check('the DM is linked to the chat', crew.crew.store.thread(dm!.tag.threadId)?.chatId === 'chat-ada' && crew.isCrewChat('chat-ada'));
  const later = crew.prepareSend({ ...base, isNew: false, modelId: null }, 'CODEX', null);
  check('later messages are found by chat id', !!later.setup && later.modelId === null && later.workspaceUri === 'file:///proj');
  const plain = crew.prepareSend({ ...base, conversationId: 'other-chat' }, 'CODEX', null);
  check('other chats pass unchanged', plain.setup === undefined);
  check('the DM turn is tracked (crew tools answer)', crew.crew.identity.inTurn(dm!.tag.threadId));
  const deco = crew.decorate([{ id: 'chat-ada', title: 'hi' } as Conversation, { id: 'x', title: 'x' } as Conversation]);
  check('the DM row carries the bot’s face', deco[0].crew?.name === 'Ada' && deco[0].title.includes('Ada') && !deco[1].crew);
  active.length = 0;
  crew.openDm(ada.id);
  check('opening it again shows the chat', shown.includes('chat-ada') && !active.some((m) => m.type === 'crewDm'));
  crew.updateBot(ada.id, { agent: 'CLAUDE' });
  check('another agent: the next DM starts a new chat there', crew.crew.store.thread(dm!.tag.threadId)?.chatId === null && crew.crew.store.thread(dm!.tag.threadId)?.engine === 'CLAUDE');

  console.log('delete');
  await crew.deleteBot(max.id);
  await sleep(1700);
  check('a deleted bot leaves its rooms', !groups.find('g1')!.bots.some((b) => b.id === max.id) && !crew.crew.store.bot(max.id));
  check('its room chat is dropped', claude.deleted.includes(th!.chatId!));
  crew.updateBot(ada.id, { agent: 'CODEX' });
  const t2 = crew.crew.store.thread(dm!.tag.threadId)!;
  crew.crew.store.putThread({ ...t2, chatId: 'chat-ada2', engine: 'CODEX' });
  await crew.deleteBot(ada.id);
  check('a deleted bot’s DM chat is deleted', backends.CODEX!.deleted.includes('chat-ada2') && !crew.crew.store.thread(dm!.tag.threadId));

  groups.dispose();
  crew.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
