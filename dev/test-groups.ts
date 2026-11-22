// Offline test of crew rooms (ex Group chats, src/core/crew/rooms): the real RoomEngine + groups_mcp on a crew in a
// temp folder, with fake agent backends. No bridge, no real agents.
//   npx esbuild dev/test-groups.ts --bundle --platform=node --outfile=<tmp>/test-groups.js && node <tmp>/test-groups.js
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, ChatMessage } from '../shared/model';
import type { ApprovalView, HostToView } from '../shared/protocol';
import { CrewEngine } from '../src/core/crew/engine';
import { RoomEngine } from '../src/core/crew/rooms/engine';
import { groupsMcp } from '../src/core/crew/rooms/mcp';
import { CrewRoomStore } from '../src/core/crew/rooms/store';
import { CrewStore } from '../src/core/crew/store/store';
import type { AgentBackend, ChatState, SendRequest } from '../src/core/types';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ fake agents

/** Decides a reply from the prompt: (who is speaking, the prompt) → text with the agent's markers. */
type Replier = (who: string, prompt: string) => string;
let replier: Replier = (who) => `Hi from ${who}`;
/** Prompts that ask for a tool permission first. */
let approvalFor: ((prompt: string) => boolean) | null = null;

class FakeBackend {
  chats = new Map<string, ChatState>();
  subs = new Map<string, Set<(s: ChatState) => void>>();
  sent: SendRequest[] = [];
  deleted: string[] = [];
  approvals: { id: string; key: string; deny: boolean; feedback?: string }[] = [];
  private pending = new Map<string, () => void>();
  constructor(readonly kind: AgentKind) {}
  status() {
    return { kind: this.kind, label: this.kind, state: 'online' as const };
  }
  conversations() {
    return [];
  }
  models() {
    return { agent: this.kind, models: [{ id: `${this.kind.toLowerCase()}-fast`, displayName: 'Fast One', family: 'OTHER' as const, description: '', isDefault: true, baseName: 'fast' }], selectedId: null };
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
    const copy = { ...st, messages: [...st.messages], approvals: [...st.approvals] };
    for (const l of this.subs.get(id) ?? []) l(copy);
  }
  async send(req: SendRequest) {
    this.sent.push(req);
    const st = this.getState(req.conversationId);
    st.messages.push(msg(req.conversationId, 'USER', req.text));
    st.isStreaming = true;
    this.emit(req.conversationId);
    const who =
      /You are ([\p{L}\p{N}_.-]+)/u.exec(req.text)?.[1]?.replace(/[.,]+$/, '') ??
      (/Who answers\?/.test(req.text) ? 'ROUTER' : /moderat/i.test(req.text) || /Who speaks next/.test(req.text) ? 'MODERATOR' : /running summary/.test(req.text) ? 'SUMMARY' : '?');
    const finish = () => {
      st.messages.push(msg(req.conversationId, 'ASSISTANT', replier(who, req.text)));
      st.isStreaming = false;
      this.emit(req.conversationId);
    };
    if (approvalFor?.(req.text)) {
      setTimeout(() => {
        st.approvals = [approval(this.kind, `k-${req.conversationId}`)];
        this.emit(req.conversationId);
        this.pending.set(req.conversationId, finish);
      }, 150);
    } else setTimeout(finish, 250);
  }
  async approval(id: string, key: string, _choice: string | undefined, deny: boolean, feedback?: string) {
    this.approvals.push({ id, key, deny, feedback });
    const st = this.getState(id);
    st.approvals = [];
    this.emit(id);
    const f = this.pending.get(id);
    this.pending.delete(id);
    if (f) setTimeout(f, 100);
  }
  async answer() {}
  async stop(id: string) {
    const st = this.getState(id);
    st.isStreaming = false;
    this.emit(id);
  }
  async conversationAction(id: string, action: string) {
    if (action === 'delete') this.deleted.push(id);
  }
}

function msg(conversationId: string, role: 'USER' | 'ASSISTANT', content: string): ChatMessage {
  return { id: Math.random().toString(36).slice(2), conversationId, role, content, toolCalls: [], isStreaming: false, attachments: [], createdAt: Date.now() };
}

function approval(agent: AgentKind, key: string): ApprovalView {
  return {
    key,
    agent,
    icon: 'edit',
    title: 'Edit file?',
    target: path.join(tmp, 'x.ts'),
    primary: { id: 'allow', label: 'Allow' },
    secondary: [],
    always: [],
    denyLabel: 'Deny',
    denyPlaceholder: '',
    preview: null,
    subtitle: null,
    markdown: null,
    reason: null,
  } as unknown as ApprovalView;
}

// ------------------------------------------------------------------------------------------------ setup

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antigem-groups-'));
const backends: Partial<Record<AgentKind, FakeBackend>> = { CLAUDE: new FakeBackend('CLAUDE'), CODEX: new FakeBackend('CODEX') };
const shown: string[] = [];
const viewMsgs: HostToView[] = [];
const newStore = () => new CrewRoomStore(new CrewStore(path.join(tmp, 'crew')));
/** Where a room's files are. */
const groupDir = (id: string) => path.join(tmp, 'crew', 'rooms', id);
const crew = new CrewEngine({ mcpUrl: (p) => `http://127.0.0.1:1${p}`, mcpHeaders: () => ({}), root: path.join(tmp, 'crew'), groupsDir: path.join(tmp, 'none') });
crew.bind({
  backend: (k) => backends[k] as unknown as AgentBackend | undefined,
  enabledKinds: () => ['CLAUDE', 'CODEX'],
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => tmp,
  showChat: () => undefined,
  postActive: () => undefined,
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  openFile: () => undefined,
  log: () => undefined,
});
const engine = new RoomEngine(crew.rooms);
crew.removeFromRooms = (id) => engine.removeBotEverywhere(id);
crew.onRoomsChanged = () => engine.refresh();
engine.bind({
  backend: (k) => backends[k] as unknown as AgentBackend | undefined,
  enabledKinds: () => ['CLAUDE', 'CODEX'],
  conversations: () => [],
  defaultAgent: () => 'CLAUDE',
  workspaceFolder: () => tmp,
  showChat: (id) => shown.push(id),
  postActive: (m) => viewMsgs.push(m),
  refreshConversations: () => undefined,
  pickFolder: async () => null,
  confirm: async () => true,
  log: () => undefined,
  crew: () => crew.roomApi(),
});
// a view watching the list
void engine.handle('v1', (m) => viewMsgs.push(m), { type: 'groupWatch', groupId: null, open: true });

/** Waits until the group is quiet (no one speaking, nothing queued). */
async function settle(id: string, ms = 20_000) {
  const until = Date.now() + ms;
  await sleep(300);
  while (Date.now() < until) {
    const busy = (engine as any).isBusy(id);
    if (!busy) return;
    await sleep(200);
  }
  throw new Error('group did not settle');
}
const talk = (g: any) => g.messages.filter((m: any) => m.from !== 'notice' && m.from !== 'system');

async function main() {
  const claude = backends.CLAUDE!;
  const codex = backends.CODEX!;

  console.log('natural mode: one reply, clean text, hidden chat');
  const g = engine.create({ title: 'Test room', topic: 'Testing', userName: 'Boss' });
  const ann = engine.addBot(g.id, { name: 'Ann', agent: 'CLAUDE', persona: 'Calm architect.', chattiness: 0 });
  const bob = engine.addBot(g.id, { name: 'Bob Smith', agent: 'CODEX', persona: 'Funny tester.', chattiness: 0 });
  check('name loses its space (mentionable)', bob.name === 'BobSmith', bob.name);
  replier = (who) => `<!-- thought -->secret plan<!-- /thought -->Let me look<!-- tool_call:t1 -->Final answer from ${who}`;
  engine.post(g.id, 'hello team');
  await settle(g.id);
  let cur = engine.find(g.id)!;
  let said = talk(cur);
  check('user message + exactly one bot reply', said.length === 2, said.map((m: any) => m.text));
  check('only the final words are posted', /^Final answer from (Ann|BobSmith)$/.test(said[1]?.text ?? ''), said[1]?.text);
  const firstSpeaker = cur.bots.find((b) => b.id === said[1].from)!;
  check('its chat is a hidden bot chat', !!firstSpeaker.chatId && engine.isBotChat(firstSpeaker.chatId));
  const firstPrompt = (firstSpeaker.agent === 'CLAUDE' ? claude : codex).sent.find((r) => r.conversationId === firstSpeaker.chatId)!;
  check(
    'first prompt has the room rules; the persona is in its crew setup',
    /How the room works/.test(firstPrompt.text) && /PASS/.test(firstPrompt.text) && /hello team/.test(firstPrompt.text) && !!firstPrompt.setup?.instructions.includes(firstSpeaker.persona),
  );
  check('talk-only bot runs in the private room folder', firstPrompt.workspaceUri?.includes('room') === true, firstPrompt.workspaceUri);

  console.log('mentions and deltas');
  const other = firstSpeaker.id === ann.id ? cur.bots.find((b) => b.id === bob.id)! : cur.bots.find((b) => b.id === ann.id)!;
  const otherBackend = other.agent === 'CLAUDE' ? claude : codex;
  const before = otherBackend.sent.length;
  replier = (who) => `Sure, ${who} here.`;
  engine.post(g.id, `@${other.name} what do you think?`);
  await settle(g.id);
  cur = engine.find(g.id)!;
  said = talk(cur);
  check('the mentioned bot answers', said[said.length - 1]?.from === other.id, said.map((m: any) => `${m.name}: ${m.text}`));
  const otherPrompt = otherBackend.sent[before]?.text ?? '';
  check('it saw the earlier bot reply', otherPrompt.includes(`[${firstSpeaker.name}]: Final answer from ${firstSpeaker.name}`), otherPrompt.slice(-400));
  // the first speaker's next prompt carries only what is new (not its own message)
  const fsBackend = firstSpeaker.agent === 'CLAUDE' ? claude : codex;
  const fsBefore = fsBackend.sent.length;
  engine.post(g.id, `@${firstSpeaker.name} and you?`);
  await settle(g.id);
  const delta = fsBackend.sent[fsBefore]?.text ?? '';
  check('later turn = only new messages, no rules', !/Who you are/.test(delta) && delta.includes(`[${other.name}]: Sure, ${other.name} here.`) && !delta.includes('Final answer from'), delta);

  console.log('PASS and @all');
  replier = (who) => (who === ann.name ? 'PASS' : `Yes from ${who}`);
  const n0 = talk(engine.find(g.id)!).length;
  engine.post(g.id, '@all quick poll');
  await settle(g.id);
  said = talk(engine.find(g.id)!);
  check('@all asks both, PASS posts nothing', said.length === n0 + 2 && said[said.length - 1].text === 'Yes from BobSmith', said.slice(n0).map((m: any) => m.text));

  console.log('bot-to-bot limit');
  engine.update(g.id, { maxBotTurns: 3, turnsPerMember: 5 });
  replier = (who) => (who === ann.name ? '@BobSmith ping' : '@Ann pong');
  engine.post(g.id, '@Ann start');
  await settle(g.id, 40_000);
  cur = engine.find(g.id)!;
  const after = cur.messages.slice(cur.messages.findIndex((m) => m.text === '@Ann start') + 1);
  check('stops after 3 bot messages', after.filter((m) => m.from !== 'notice').length === 3 && cur.waiting, after.map((m) => m.text));
  check('tells the user', after.some((m) => m.from === 'notice' && /paused after 3/.test(m.text)));
  const beforeContinue = talk(cur).length;
  engine.continueTalk(g.id);
  await settle(g.id, 40_000);
  check('Continue lets them go on (3 more)', engine.find(g.id)!.waiting && talk(engine.find(g.id)!).length === beforeContinue + 3, talk(engine.find(g.id)!).length - beforeContinue);

  console.log('access and approvals');
  engine.update(g.id, { maxBotTurns: 6 });
  approvalFor = (p) => p.includes('use a tool');
  replier = (who) => `done by ${who}`;
  engine.post(g.id, '@Ann use a tool');
  await settle(g.id);
  check('talk-only bot: permission denied with a reason', claude.approvals.length === 1 && claude.approvals[0].deny && /talk-only/.test(claude.approvals[0].feedback ?? ''), claude.approvals);
  engine.updateBot(g.id, 'Ann', { access: 'edit' });
  const annChatAfterReset = engine.find(g.id)!.bots.find((b) => b.name === 'Ann')!.chatId;
  check('changing access keeps its chat (its crew setup carries the new level)', annChatAfterReset !== null);
  engine.post(g.id, '@Ann use a tool again');
  await settle(g.id);
  check('edit bot: permission allowed', claude.approvals.length === 2 && !claude.approvals[1].deny, claude.approvals);
  approvalFor = null;

  console.log('moderator mode');
  engine.update(g.id, { mode: 'moderator', moderatorAgent: 'CODEX' });
  replier = (who, p) => (who === 'MODERATOR' ? (/Who speaks next/.test(p) && p.includes('[Boss]: what now') ? 'BobSmith' : 'NONE') : `mod-picked ${who}`);
  engine.post(g.id, 'what now');
  await settle(g.id);
  said = talk(engine.find(g.id)!);
  check('the moderator picks who speaks', said[said.length - 1].text === 'mod-picked BobSmith', said.slice(-2).map((m: any) => m.text));
  check('moderator chat is hidden too', engine.isBotChat(engine.find(g.id)!.moderatorChatId ?? ''));

  console.log('groups_mcp');
  const mcp = groupsMcp(engine);
  const created = await mcp.call('group_create', {
    title: 'MCP room',
    topic: 'Made by an agent',
    user_name: 'Sam',
    bots: [
      { name: 'Zed', agent: 'codex', model: 'Fast One', persona: 'Pirate.', emoji: '🏴‍☠️', color: '#112233', chattiness: 80 },
      { name: 'Ivy', agent: 'claude', persona: 'Poet.', access: 'read' },
    ],
  });
  const info = JSON.parse((created.content[0] as any).text);
  check('group_create with bots', info.bots.length === 2 && info.user_name === 'Sam' && info.bots[0].model === 'codex-fast', info);
  check('group_create opens it', viewMsgs.some((m) => m.type === 'groupNavigate' && m.groupId === info.id));
  const bad = await mcp.call('group_add_bot', { group: 'MCP room', name: 'X', agent: 'codex', model: 'nope', persona: 'x' });
  check('unknown model is refused', bad.isError === true && /group_models/.test((bad.content[0] as any).text));
  replier = (who) => `ahoy from ${who}`;
  await mcp.call('group_post', { group: 'MCP room', text: '@Zed hi' });
  await settle(info.id);
  const read = await mcp.call('group_read', { group: info.id });
  check('group_read shows the talk', /\[Sam\]: @Zed hi/.test((read.content[0] as any).text) && /\[Zed\]: ahoy from Zed/.test((read.content[0] as any).text), (read.content[0] as any).text);
  const list = await mcp.call('group_list', {});
  check('group_list lists both', JSON.parse((list.content[0] as any).text).length === 2);

  console.log('persistence and delete');
  (engine as any).store.flush();
  const again = newStore();
  check('saved to disk and read back', again.get(g.id)?.messages.length === engine.find(g.id)!.messages.length);
  const zedChat = engine.find(info.id)!.bots.find((b) => b.name === 'Zed')!.chatId!;
  await mcp.call('group_delete', { group: info.id });
  await sleep(1700);
  check('delete removes the group and its bot chats', !engine.find(info.id) && codex.deleted.includes(zedChat) && !fs.existsSync(groupDir(info.id)));

  engine.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
