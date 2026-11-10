// Offline test of Jarvis (src/core/jarvis): the real AppHost + JarvisEngine + jarvis_mcp over HTTP, with fake agent
// backends and a controllable clock. No bridge, no real agents, nothing written outside memory.
//   npx esbuild dev/test-jarvis.ts --bundle --platform=node --outfile=<tmp>/test-jarvis.js && node <tmp>/test-jarvis.js
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AgentKind, ChatMessage, Conversation } from '../shared/model';
import type { AgentStatus, ApprovalView, HostToView, ModelsState, QuestionView } from '../shared/protocol';
import { AppHost, type Platform } from '../src/core/host';
import { JarvisEngine } from '../src/core/jarvis/engine';
import { Events } from '../src/core/jarvis/events';
import { jarvisMcp } from '../src/core/jarvis/mcp';
import { McpHost } from '../src/core/mcp/server';
import type { AgentBackend, ChatState, KeyValueStore, SendRequest } from '../src/core/types';

// ------------------------------------------------------------------------------------------------ clock & checks

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const advance = (ms: number) => (offset += ms);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`);
  }
}

// ------------------------------------------------------------------------------------------------ fakes

const blank = (agent: AgentKind): ChatState => ({
  conversation: null,
  agent,
  messages: [],
  isStreaming: false,
  isLoading: false,
  error: null,
  queued: [],
  approvals: [],
  question: null,
  artifacts: [],
  workingLabel: null,
});

let msgSeq = 0;
const msg = (conversationId: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${++msgSeq}`,
  conversationId,
  role,
  content,
  toolCalls: [],
  isStreaming: false,
  attachments: [],
  createdAt: Date.now(),
  ...extra,
});

class FakeBackend implements AgentBackend {
  sends: SendRequest[] = [];
  stops: string[] = [];
  approvalCalls: any[] = [];
  answerCalls: any[] = [];
  actions: any[] = [];
  controlsSet: any[] = [];
  modelSets: any[] = [];
  convs = new Map<string, Conversation>();
  states = new Map<string, ChatState>();
  listeners = new Map<string, Set<(s: ChatState) => void>>();
  constructor(readonly kind: AgentKind) {}
  status(): AgentStatus {
    return { kind: this.kind, label: this.kind, state: 'online' };
  }
  conversations() {
    return [...this.convs.values()];
  }
  models(): ModelsState {
    return {
      agent: this.kind,
      models: [
        { id: `${this.kind.toLowerCase()}-fast`, displayName: 'Fast One', family: 'OTHER', description: '', isDefault: true, baseName: 'fast' },
        { id: `${this.kind.toLowerCase()}-opus`, displayName: 'Opus Big', family: 'CLAUDE', description: '', isDefault: false, baseName: 'opus' },
      ],
      selectedId: `${this.kind.toLowerCase()}-fast`,
      groups: [{ name: 'Usage', windows: [{ label: '5h', remaining: 0.6, resetText: '2h' }] }],
    };
  }
  start() {}
  private changeListeners = new Set<(w: any) => void>();
  onChange(cb: (w: any) => void) {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }
  subscribe(id: string, l: (s: ChatState) => void) {
    const set = this.listeners.get(id) ?? new Set();
    set.add(l);
    this.listeners.set(id, set);
    l(this.getState(id));
    return () => set.delete(l);
  }
  getState(id: string) {
    return this.states.get(id) ?? blank(this.kind);
  }
  set(id: string, patch: Partial<ChatState>) {
    this.states.set(id, { ...this.getState(id), ...patch });
    const c = this.convs.get(id);
    if (c && patch.isStreaming !== undefined) this.convs.set(id, { ...c, isRunning: patch.isStreaming });
    for (const l of this.listeners.get(id) ?? []) l(this.getState(id));
  }
  addMessage(id: string, m: ChatMessage) {
    this.set(id, { messages: [...this.getState(id).messages, m] });
  }
  async send(req: SendRequest) {
    this.sends.push(req);
    if (!this.convs.has(req.conversationId)) {
      const now = Date.now();
      this.convs.set(req.conversationId, {
        id: req.conversationId,
        title: 'Chat',
        modelId: req.modelId ?? '',
        createdAt: now,
        updatedAt: now,
        isRunning: false,
        notFullyIdle: false,
        hasActivity: true,
        runStatus: 'IDLE',
        stepCount: 0,
        workspaceUri: req.workspaceUri ?? '',
        nestingDepth: 0,
        agent: this.kind,
        archived: false,
      });
    }
    // the chat shows the collapsed text (as the real backends do)
    const shown = req.text.replace(/<antigem-expansion command="([^"]*)">[\s\S]*?<\/antigem-expansion>/g, (_m, c: string) => c.replace(/&amp;/g, '&')).trim();
    this.addMessage(req.conversationId, msg(req.conversationId, 'USER', shown));
    for (const l of this.changeListeners) l('conversations');
  }
  async stop(id: string) {
    this.stops.push(id);
    this.set(id, { isStreaming: false });
  }
  async approval(conversationId: string, key: string, choiceId: string | undefined, deny: boolean, feedback?: string) {
    this.approvalCalls.push({ conversationId, key, choiceId, deny, feedback });
    this.set(conversationId, { approvals: this.getState(conversationId).approvals.filter((a) => a.key !== key) });
  }
  async answer(conversationId: string, key: string, answers: Record<string, string[]>, note?: string, skip?: boolean) {
    this.answerCalls.push({ conversationId, key, answers, note, skip });
    this.set(conversationId, { question: null });
  }
  selectModel(conversationId: string | null, modelId: string) {
    this.modelSets.push({ conversationId, modelId });
  }
  commands() {
    return [];
  }
  controls() {
    return [];
  }
  async setControl(conversationId: string | null, id: string, value: string) {
    this.controlsSet.push({ conversationId, id, value });
  }
  refreshModels() {}
  async conversationAction(id: string, action: string, value?: string) {
    this.actions.push({ id, action, value });
    if (action === 'delete') this.convs.delete(id);
    if (action === 'rename' && value) {
      const c = this.convs.get(id);
      if (c) this.convs.set(id, { ...c, title: value });
    }
  }
  async queueAction() {}
  retry() {}
  dispose() {}
}

const mem = new Map<string, unknown>();
const store: KeyValueStore = { get: <T>(k: string) => mem.get(k) as T | undefined, set: (k, v) => void mem.set(k, JSON.parse(JSON.stringify(v ?? null))) };

const opened: string[] = [];
const platform: Platform = {
  workspaceFolders: () => [{ name: 'ws', uri: 'file:///tmp/ws', path: '/tmp/ws' }],
  defaultAgent: () => 'CLAUDE',
  openFile: (p) => void opened.push(p),
  openUrl: (u) => void opened.push(u),
  copy: () => undefined,
  pickAttachments: async () => [],
  searchFiles: async (q) => (q.includes('main') ? [{ path: '/tmp/ws/src/main.ts', relativePath: 'src/main.ts', kind: 'file' as const }] : []),
  saveText: async () => undefined,
  runInTerminal: () => undefined,
  openText: () => undefined,
  revealRange: () => undefined,
  openInEditor: () => undefined,
  confirm: async () => true,
  prompt: async (_m, v) => v,
  restartBridge: async () => undefined,
  powerOff: async () => undefined,
  powerOn: () => undefined,
  isOff: () => false,
  bridgeInfo: () => ({ port: 1, hubPort: 2, logFile: '' }),
  pickFolder: async () => null,
  savedProjects: async () => [{ name: 'proj', path: '/tmp/proj' }],
  saveProject: async () => undefined,
  forgetProject: async () => undefined,
  cliStatus: async () => ({}),
  saveCopy: async () => undefined,
};

const bridgeCalls: string[] = [];
const bridge = {
  async json<T = any>(p: string, init?: RequestInit): Promise<T> {
    bridgeCalls.push(`${init?.method ?? 'GET'} ${p}`);
    if (p.startsWith('/api/mcp/config')) return (init?.method === 'POST' ? { success: true } : { content: '{"mcpServers":{}}' }) as T;
    if (p.startsWith('/api/opencode/mcp')) return { success: true, servers: {} } as T;
    if (p.startsWith('/api/claude/mcp')) return { success: true, servers: [] } as T;
    if (p.startsWith('/api/claude/settings')) return { success: true, settings: {} } as T;
    if (p.startsWith('/api/codex/rpc')) return { success: true, result: { config: { mcp_servers: {} } } } as T;
    if (p.startsWith('/api/search')) return [] as T;
    throw new Error(`unexpected bridge call ${p}`);
  },
};

// ------------------------------------------------------------------------------------------------ setup

const claude = new FakeBackend('CLAUDE');
const codex = new FakeBackend('CODEX');
const host = new AppHost({ CLAUDE: claude, CODEX: codex }, platform, () => undefined, store);
const mcp = new McpHost({ port: Number(process.env.ANTIGEM_MCP_PORT ?? 1257), deviceId: 'test-device', log: () => undefined });
const jarvis = new JarvisEngine({ host: host.jarvisApi(), store, log: (l) => process.env.VERBOSE && console.log(l), bridge, mcp });
host.attachJarvis(jarvis);
mcp.register(jarvisMcp(jarvis));

const posted: HostToView[] = [];
const viewId = host.attachView({ kind: 'browser', post: (m) => void posted.push(JSON.parse(JSON.stringify(m))) });
const view = (m: any) => host.handle(viewId, m);
const lastOf = <T extends HostToView['type']>(t: T) => [...posted].reverse().find((m) => m.type === t) as Extract<HostToView, { type: T }> | undefined;

let session: string | null = null;
let rpcId = 0;
async function rpc(method: string, params?: unknown, sess = session) {
  const res = await fetch(`http://127.0.0.1:${mcp.port}/jarvis`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Device-Id': 'test-device', ...(sess ? { 'Mcp-Session-Id': sess } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const sid = res.headers.get('mcp-session-id');
  const body: any = await res.json();
  return { body, sid };
}
async function tool(name: string, args: Record<string, unknown> = {}, sess = session): Promise<{ text: string; isError: boolean; raw: any }> {
  const { body } = await rpc('tools/call', { name, arguments: args }, sess);
  if (body.error) return { text: body.error.message, isError: true, raw: body };
  return { text: body.result.content.map((c: any) => c.text).join('\n'), isError: body.result.isError === true, raw: body };
}

async function ticks(n = 1) {
  for (let i = 0; i < n; i++) {
    await jarvis.tasks.loop();
    await jarvis.controller.permissionLoop();
    jarvis.controller.questionLoop();
    await jarvis.events.loop();
  }
}

// ------------------------------------------------------------------------------------------------ the test

async function main() {
  await mcp.start();
  await view({ type: 'ready' });

  console.log('Jarvis off');
  {
    const { body } = await rpc('initialize', {});
    check('MCP refuses while Jarvis is off', body.error?.message?.includes('Jarvis is turned off'), body);
    check('root settings has a Jarvis row', true);
    await view({ type: 'requestSettings', page: 'root' });
    const root = lastOf('settings')!.page;
    check('root settings lists the jarvis page', JSON.stringify(root).includes('"id":"jarvis"'), root.sections.map((s) => s.id));
  }

  console.log('Turning Jarvis on, new Jarvis chat');
  await view({ type: 'settingChange', page: 'jarvis', id: 'jarvis.enabled', value: true });
  check('prefs enabled', jarvis.prefs.get('enabled') === true);
  await view({ type: 'jarvisAction', action: 'newChat' });
  const nc = lastOf('jarvisNewChat');
  check('newChat answers jarvisNewChat', nc?.agent === 'CLAUDE', nc);
  const J1 = '11111111-aaaa-4bbb-8ccc-000000000001';
  await view({ type: 'send', conversationId: J1, isNew: true, agent: 'CLAUDE', text: 'Build me a thing', attachments: [], modelId: null, workspaceUri: null, jarvis: true });
  const first = claude.sends.find((s) => s.conversationId === J1)!;
  check('first message carries the boot pack', first.text.includes('[Jarvis command-center guide') && first.text.includes(`manager_id=${J1}`) && first.text.endsWith('Build me a thing'), first.text.slice(0, 200));
  check('boot pack lists the tools', first.text.includes('- jarvis_task_start(goal*') && !first.text.includes('jarvis_speak('));
  check('chat is a manager + Jarvis id', jarvis.managers.isManager(J1) && jarvis.prefs.isJarvisChat(J1));
  await view({ type: 'send', conversationId: J1, isNew: false, agent: 'CLAUDE', text: 'second', attachments: [], modelId: null, workspaceUri: null });
  const second = claude.sends.filter((s) => s.conversationId === J1)[1];
  check('later messages carry the preamble + brief', second.text.includes('[Jarvis] command center') && second.text.includes('<mission_brief') && !second.text.includes('command-center guide'), second.text.slice(0, 300));
  const convs = lastOf('conversations')!.conversations;
  check('conversation flagged isJarvis + hidden (listMode none)', convs.some((c) => c.id === J1 && c.isJarvis && c.jarvisHidden), convs);

  console.log('MCP');
  {
    const init = await rpc('initialize', {}, null);
    session = init.sid;
    check('initialize gives a session id', !!session && init.body.result?.serverInfo?.name === 'jarvis_mcp', init.body);
    const list = await rpc('tools/list');
    const names: string[] = list.body.result.tools.map((t: any) => t.name);
    check(`tools/list has 55 tools (no voice/github) [${names.length}]`, names.length === 55 && !names.includes('jarvis_speak') && !names.some((n) => n.includes('github')), names);
    const sp = await tool('jarvis_speak', { text: 'hi', manager_id: J1 });
    check('hidden voice tool answers "no voice"', sp.isError && sp.text.includes('no voice'), sp.text);
    const help = await tool('jarvis_help');
    check('jarvis_help returns the guide', help.text.includes('# Jarvis command center') && help.text.includes('jarvis_mcp tools'));
  }

  console.log('Mission & teams');
  {
    const r = await tool('jarvis_mission_set', { goal: 'Ship the feature', done_when: 'tests green', steps: '1. build\n2. review', autopilot: false, manager_id: J1 });
    check('mission set', r.text.includes('Mission set with 2 step(s)'), r.text);
    const t = await tool('jarvis_team_create', { name: 'builders', agent: 'codex', model: 'opus', role: 'implement with tests', manager_id: J1 });
    check('team created with resolved model', t.text.includes('Created team builders (codex, codex-opus)'), t.text);
    const u = await tool('jarvis_mission_update', { step: 1, step_status: 'doing', manager_id: J1 });
    check('mission update', u.text.includes('step 1 → doing'), u.text);
  }

  console.log('Tasks: start, run, finish, news');
  let T1 = '';
  {
    const r = await tool('jarvis_task_start', { goal: 'Implement the parser', title: 'Parser', team: 'builders', manager_id: J1 });
    check('task_start returns a task id', !r.isError && r.text.includes('"task_id"'), r.text);
    T1 = JSON.parse(r.text).task_id;
    const s = codex.sends.find((x) => x.conversationId === T1)!;
    check('task chat got the sub-agent brief + team role, hidden', s?.isNew === true && s.text.includes('You are a sub-agent of Jarvis') && s.text.includes('Your role: implement with tests') && s.text.endsWith('Implement the parser'), s?.text.slice(0, 200));
    check('task uses the team model', s.modelId === 'codex-opus', s.modelId);
    await ticks();
    check('task starting', jarvis.tasks.find(T1)?.state === 'STARTING', jarvis.tasks.find(T1)?.state);
    codex.set(T1, { isStreaming: true });
    await ticks();
    check('task running', jarvis.tasks.find(T1)?.state === 'RUNNING', jarvis.tasks.find(T1)?.state);
    // anti-poll: a 4th list within two minutes while a task runs
    let last = { text: '', isError: false };
    for (let i = 0; i < 4; i++) last = await tool('jarvis_task_list', { manager_id: J1 });
    check('task_list polling is stopped', last.isError && last.text.startsWith('Stop polling'), last.text);
    jarvis.prefs.set('eventBatchMs', 0);
    codex.addMessage(T1, msg(T1, 'ASSISTANT', '<!-- thought -->thinking…<!-- /thought -->Done: parser written, 12 tests pass.'));
    codex.set(T1, { isStreaming: false });
    const before = claude.sends.length;
    await ticks();
    const t = jarvis.tasks.find(T1)!;
    check('task done with result (thinking removed)', t.state === 'DONE' && t.result === 'Done: parser written, 12 tests pass.', t);
    const news = claude.sends.slice(before).find((x) => x.conversationId === J1);
    check('news delivered to the Jarvis chat as one labelled message', !!news && news.text.startsWith('<antigem-expansion command="⚡ Jarvis · Parser: done">') && news.text.includes('<jarvis_events count="1"') && news.text.includes('<task_reply>\nDone: parser written'), news?.text.slice(0, 300));
    // the view shows the Jarvis chat: the labelled message carries its events
    await view({ type: 'openConversation', id: J1, agent: 'CLAUDE' });
    await sleep(50);
    const chat = [...posted].reverse().find((m) => m.type === 'chat' && m.conversationId === J1 && (m.patch.upserts?.length ?? 0) > 0) as any;
    const card = chat?.patch.upserts?.find((m: ChatMessage) => m.jarvisEvents);
    check('view gets jarvisEvents on the labelled message', card?.content === '⚡ Jarvis · Parser: done' && card.jarvisEvents[0].kind === 'task_done' && card.jarvisEvents[0].taskId === T1, card);
    const parsed = Events.parse(news!.text);
    check('Events.parse reads the delivered block', parsed?.[0]?.title === 'Parser' && parsed[0].team === 'builders' && parsed[0].text.startsWith('Done: parser'), parsed);
  }

  console.log('Approvals and questions');
  let T2 = '';
  {
    const r = await tool('jarvis_task_start', { goal: 'Clean the build', title: 'Cleanup', agent: 'claude', manager_id: J1 });
    T2 = JSON.parse(r.text).task_id;
    claude.set(T2, { isStreaming: true });
    await ticks();
    const risky: ApprovalView = {
      key: 'tool-1',
      agent: 'CLAUDE',
      icon: 'terminal',
      title: 'Run a command?',
      subtitle: 'Bash',
      preview: '$ rm -rf build',
      primary: { id: 'allow', label: 'Allow' },
      secondary: [],
      always: [],
      denyLabel: 'Deny',
      denyPlaceholder: '',
    };
    claude.set(T2, { approvals: [risky] });
    // the last news went out just now: the next goes 25 s later at the earliest
    advance(26_000);
    const before = claude.sends.length;
    await ticks();
    check('task waits for approval', jarvis.tasks.find(T2)?.state === 'NEEDS_APPROVAL');
    const news = claude.sends.slice(before).find((x) => x.conversationId === J1);
    check('approval event to the manager with risk', !!news && news.text.includes('kind="task_approval"') && news.text.includes('risk="risky"') && news.text.includes('wants to run the command: rm -rf build'), news?.text.slice(0, 600));
    claude.set(J1, { isStreaming: false });
    const lp = await tool('jarvis_list_permissions', { manager_id: J1 });
    check('list_permissions shows it', lp.text.includes('"key": "tool-1"') && lp.text.includes('"risk": "risky"'), lp.text);
    const res = await tool('jarvis_resolve_permission', { key: 'tool-1', approve: true, manager_id: J1 });
    check('resolve approves through the backend', res.text === 'Approved 1 request.' && claude.approvalCalls.some((a) => a.key === 'tool-1' && a.choiceId === 'allow' && !a.deny), res.text);
    // auto: read-only policy approves `ls` at once
    jarvis.prefs.set('permissionPolicy', 'auto_readonly');
    claude.set(T2, { approvals: [{ ...risky, key: 'tool-2', preview: '$ ls -la' }] });
    await ticks();
    check('read-only command approved automatically', claude.approvalCalls.some((a) => a.key === 'tool-2' && !a.deny));
    // a question
    const q: QuestionView = {
      key: 'q-1',
      agent: 'CLAUDE',
      questionnaire: {
        title: 'Pick',
        questions: [{ id: 'q', prompt: 'Which database?', isMultiSelect: false, allowCustomAnswer: true, options: [{ id: 'o1', label: 'Postgres' }, { id: 'o2', label: 'SQLite' }] }],
        allowCustomNote: false,
      },
    };
    claude.set(T2, { question: q });
    // the manager must be free to get news: it is idle and nothing is in flight (sentAt older than 25 s)
    advance(26_000);
    const b2 = claude.sends.length;
    await ticks();
    const qn = claude.sends.slice(b2).find((x) => x.conversationId === J1);
    check('question event to the manager', !!qn && qn.text.includes('kind="task_question"') && qn.text.includes('1) Postgres; 2) SQLite'), qn?.text.slice(0, 500));
    const ans = await tool('jarvis_task_answer', { id: T2.slice(0, 8), answer: 'the second one', manager_id: J1 });
    check('task_answer picks option 2', ans.text === 'Answered: SQLite.' && claude.answerCalls.some((a) => a.answers.q?.[0] === 'o2'), { ans: ans.text, calls: claude.answerCalls });
  }

  console.log('Ownership and caller');
  const J2 = '22222222-aaaa-4bbb-8ccc-000000000002';
  {
    await view({ type: 'send', conversationId: J2, isNew: true, agent: 'CODEX', text: 'Another job', attachments: [], modelId: null, workspaceUri: null, jarvis: true });
    const other = await tool('jarvis_task_stop', { id: T1, manager_id: J2 });
    check("another Jarvis chat can't steer my task", other.isError && other.text.includes('belongs to'), other.text);
    const noid = await tool('jarvis_task_stop', { id: T1 }, null);
    check('acting without manager_id (two Jarvis chats) asks for it', noid.isError && noid.text.startsWith('Pass manager_id'), noid.text);
    const send = await tool('jarvis_send_to_chat', { id: J1, message: 'hi', reason: 'user_named_this_chat', manager_id: J2 });
    check("Jarvis chats don't control each other", send.isError && send.text.includes("don't control each other"), send.text);
  }

  console.log('Stall');
  let T3 = '';
  {
    jarvis.prefs.set('stallMinutes', 5);
    const r = await tool('jarvis_task_start', { goal: 'Long job', title: 'Long', agent: 'codex', manager_id: J2 });
    T3 = JSON.parse(r.text).task_id;
    codex.set(T3, { isStreaming: true });
    await ticks();
    advance(6 * 60_000);
    const before = codex.sends.length;
    await ticks();
    check('no progress → stalled', jarvis.tasks.find(T3)?.state === 'STALLED', jarvis.tasks.find(T3)?.state);
    const news = codex.sends.slice(before).find((x) => x.conversationId === J2);
    check('stalled news to its own manager', !!news && news.text.includes('kind="task_stalled"'), news?.text.slice(0, 300));
  }

  console.log('Wait guard');
  {
    // J2 waits inside its turn with `sleep 60` while its task runs
    codex.set(J2, {
      isStreaming: true,
      messages: [...codex.getState(J2).messages, msg(J2, 'ASSISTANT', 'waiting', { toolCalls: [{ id: 'tc1', name: 'shell', toolType: 'BASH', command: 'sleep 60', status: 'RUNNING', output: '' }] })],
    });
    await ticks();
    advance(13_000);
    await ticks();
    check('a waiting turn is stopped', codex.stops.includes(J2), codex.stops);
    check('wait detection rules', Events.isWaitCommand('sleep 30') && !Events.isWaitCommand('sleep 2') && Events.isWaitCommand('while true; do curl x; sleep 5; done') && !Events.isWaitCommand('npm test'));
  }

  console.log('Autopilot');
  {
    await jarvis.tasks.stop(T3);
    const mid = await tool('jarvis_mission_set', { goal: 'Keep going', steps: 'a\nb', autopilot: true, manager_id: J2 });
    check('autopilot mission', mid.text.includes('autopilot ON'), mid.text);
    codex.set(J2, { isStreaming: false });
    await ticks();
    advance(61_000);
    await ticks();
    advance(31_000);
    const before = codex.sends.length;
    await ticks();
    await ticks();
    const nudge = codex.sends.slice(before).find((x) => x.conversationId === J2);
    check('an idle unfinished mission is nudged', !!nudge && nudge.text.includes('kind="nudge"') && nudge.text.includes('(nudge 1 of 4)'), nudge?.text.slice(0, 400) ?? jarvis.events.pending(J2));
    check('the guard note goes with the next news', !!nudge && nudge.text.includes('<app_note>') && nudge.text.includes('sleep 60'), nudge?.text.slice(0, 600));
  }

  console.log('State pushed to the views');
  {
    await sleep(400);
    const all = posted.filter((m) => m.type === 'jarvis') as Extract<HostToView, { type: 'jarvis' }>[];
    const merged: any = {};
    for (const m of all) Object.assign(merged, m.state);
    const m1 = merged.managers?.find((m: any) => m.chatId === J1);
    check('jarvis state has managers with mission/teams', m1?.mission?.goal === 'Ship the feature' && m1.teams[0]?.name === 'builders', m1);
    check('jarvis state has tasks', merged.tasks?.some((t: any) => t.id === T1 && t.state === 'done') && merged.tasks.some((t: any) => t.id === T3 && t.state === 'stopped'), merged.tasks);
    check('jarvis state has a log', merged.log?.length > 3, merged.log?.length);
    await view({ type: 'jarvisAction', action: 'setAutopilot', chatId: J2, on: false });
    check('setAutopilot action', jarvis.managers.of(J2).mission.autopilot === false);
    await view({ type: 'jarvisAction', action: 'dismissTask', taskId: T3 });
    check('dismissTask action', !jarvis.tasks.find(T3, true));
  }

  console.log('Chats, models, settings, VS Code tools');
  {
    const lc = await tool('jarvis_list_chats', { include_jarvis: true });
    check('list_chats', lc.text.includes(`"id": "${J1}"`) && lc.text.includes('"jarvis_chat": true'), lc.text.slice(0, 300));
    const lm = await tool('jarvis_list_models', { agent: 'all' });
    check('list_models', lm.text.includes('claude-opus') && lm.text.includes('codex-fast'), lm.text.slice(0, 200));
    const sm = await tool('jarvis_set_model', { id: T1, model: 'opus', manager_id: J1 });
    check('set_model on a task', sm.text.includes('Opus Big') && codex.modelSets.some((x) => x.conversationId === T1 && x.modelId === 'codex-opus'), sm.text);
    const eff = await tool('jarvis_set_effort', { id: T2, level: 'high' });
    check('set_effort on a Claude chat', eff.text === 'Effort set to high.' && claude.controlsSet.some((c) => c.id === 'effort' && c.value === 'high'), eff.text);
    const gs = await tool('jarvis_set_setting', { key: 'theme_mode', value: 'dark' });
    check('app settings need permission', gs.isError && gs.text.includes('not allowed'), gs.text);
    const js = await tool('jarvis_set_setting', { key: 'jarvis_stall_minutes', value: '20' });
    check("Jarvis' own settings change", js.text === 'jarvis_stall_minutes set to 20.' && jarvis.prefs.get('stallMinutes') === 20, js.text);
    const of = await tool('jarvis_ide_open_file', { file: 'main' });
    check('ide_open_file resolves a name', of.text === 'Opened main.ts.' || of.text.includes('Could not read'), of.text);
    const op = await tool('jarvis_ide_open_project', { project: 'proj' });
    check('ide_open_project sets the active project', jarvis.activeProjectPath() === '/tmp/proj', op.text);
    const st = await tool('jarvis_get_state', {});
    check('get_state', st.text.includes('"active_project": "/tmp/proj"'), st.text.slice(0, 200));
    const us = await tool('jarvis_get_usage', {});
    check('get_usage reads the quota groups', us.text.includes('"percent_left": 60'), us.text.slice(0, 200));
    const g = await tool('jarvis_app_guide', { topic: 'how do I add an mcp server' });
    check('app_guide', g.text.includes('## mcp'), g.text.slice(0, 80));
    const scr = await tool('jarvis_open_screen', { screen: 'notes' });
    check('open_screen navigates the view', scr.text === 'Opened notes.' && lastOf('jarvisNavigate')?.screen === 'notes');
    const del = await tool('jarvis_delete_chat', { id: T2, confirm: true, manager_id: J1 });
    check('delete_chat of an own task', del.text === 'Deleted.' && claude.actions.some((a) => a.id === T2 && a.action === 'delete') && !jarvis.tasks.find(T2, true), del.text);
  }

  console.log('Settings pages');
  {
    for (const p of ['jarvis', 'jarvis.agent', 'jarvis.personality', 'jarvis.setup', 'jarvis.tasks', 'jarvis.approvals', 'jarvis.chat']) {
      await view({ type: 'requestSettings', page: p });
      const page = lastOf('settings')!.page;
      check(`page ${p}`, page.id === p && page.sections.length > 0 && !page.error, page.error ?? page.id);
    }
    await sleep(100);
    await view({ type: 'requestSettings', page: 'jarvis.setup' });
    const setup = lastOf('settings')!.page;
    check('setup page lists enabled agents with status', JSON.stringify(setup).includes('"status":"Not added"'), JSON.stringify(setup).slice(0, 400));
    await view({ type: 'settingAction', page: 'jarvis.setup', id: 'jarvis.setup.agents', rowId: 'CODEX', actionId: 'add' });
    check('setup add (Codex) writes mcp_servers.jarvis_mcp through /api/codex/rpc', bridgeCalls.includes('POST /api/codex/rpc'), bridgeCalls);
    await view({ type: 'settingChange', page: 'jarvis.chat', id: 'jarvis.memory', value: 'likes short answers' });
    check('memory setting', jarvis.prefs.get('memory') === 'likes short answers');
  }

  console.log('Chat deleted');
  {
    await view({ type: 'conversationAction', id: J2, action: 'delete' });
    check('a deleted Jarvis chat is forgotten', !jarvis.managers.isManager(J2) && !jarvis.prefs.isJarvisChat(J2));
  }

  mcp.stop();
  jarvis.dispose();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
