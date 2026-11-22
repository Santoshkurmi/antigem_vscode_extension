// ?mock: a fake Group chats host (src/core/groups) so the screen can be worked on in a browser: one sample room, and
// a bot that "types" and answers whatever you send.
import type { AgentKind } from '@shared/model';
import type { GroupMessageView, GroupSummaryView, GroupView, HostToView, ViewToHost } from '@shared/protocol';

export function createMockGroups(post: (m: HostToView) => void) {
  const now = Date.now();
  const MIN = 60_000;
  const bot = (id: string, name: string, emoji: string, color: string, agent: AgentKind, modelId: string | null, persona: string, chattiness: number) => ({
    id,
    name,
    emoji,
    color,
    agent,
    modelId,
    persona,
    chattiness,
    access: 'chat' as const,
    effort: 'default',
    muted: false,
    chatId: `chat-${id}`,
    title: '',
    aliases: [] as string[],
    held: 0, voice: null,
  });
  const g: GroupView = {
    id: 'g1',
    title: 'Coffee break',
    topic: 'Casual chat, jokes and developer stories.',
    userName: 'Boss',
    bots: [
      bot('b1', 'Ziggy', '🎤', '#EC4899', 'CLAUDE', 'claude-sonnet-5-5', 'A stand-up comedian who loves puns and roasting bad code.', 70),
      bot('b2', 'Grumps', '👴', '#6366F1', 'CODEX', null, 'A grumpy veteran developer who misses the old days.', 50),
      bot('b3', 'Bean', '🐣', '#F59E0B', 'OPENCODE', null, 'An overexcited intern who loves every new framework!', 60),
    ],
    mode: 'auto',
    lead: 'b2',
    drafting: 'turns',
    turnsPerMember: 1,
    queue: [],
    goal: { text: 'Ship the todo app with tests by Friday', status: 'running', turns: 3, maxTurns: 13, note: 'Grumps writes the file loop next' },
    others: [{ id: 'b9', name: 'Tess', emoji: '🧪', color: '#10B981', title: 'tester', agent: 'CLAUDE' }],
    moderatorAgent: null,
    moderatorModelId: null,
    maxBotTurns: 6,
    autoTalk: false,
    idleSeconds: 60,
    project: null,
    paused: false,
    waiting: false,
    typing: [],
    status: null,
    createdAt: now - 60 * MIN,
    updatedAt: now - 2 * MIN,
  };
  const m = (id: string, from: string, name: string, text: string, ago: number): GroupMessageView => ({ id, from, name, text, at: now - ago * MIN, attachments: [] });
  let msgs: GroupMessageView[] = [
    m('m0', 'system', '', '🎤 Ziggy, 👴 Grumps, 🐣 Bean joined.', 60),
    m('m1', 'user', 'Boss', 'Morning all ☕ what is everyone working on? @all', 30),
    m('m2', 'b3', 'Bean', 'OMG I just rewrote the todo app in **three** new frameworks!!! 🚀 Which one should we ship?', 29),
    m('m3', 'b2', 'Grumps', 'Three frameworks for a todo list. In my day we had a text file and we *liked* it.\n\n```sh\necho "buy milk" >> todo.txt\n```', 28.5),
    m('m4', 'b1', 'Ziggy', "Bean's todo app has more dependencies than tasks. That's not a todo list, that's a **to-don't** list. 🥁", 28),
    m('m5', 'user', 'Boss', '😂 ok @Grumps, settle it: how would you structure it?', 3),
    {
      ...m('m6', 'b2', 'Grumps', 'Fine. One file, one loop, no build step:\n\n```mermaid\nflowchart LR\n  A[todo.txt] --> B[read] --> C[print]\n```\n\nShip *that*.', 2),
      picked: { by: 'mention' },
      digest: 'ran 2 commands, edited todo.sh',
      evidence: ['$ touch todo.txt → exit 0', '$ sh todo.sh → exit 0', 'changed: todo.sh'],
      usage: { input: 1200, output: 180, cached: 9000, costUsd: 0.004 },
    },
  ];
  const list = (): GroupSummaryView[] => [
    {
      id: g.id,
      title: g.title,
      topic: g.topic,
      bots: g.bots.map((b) => ({ name: b.name, emoji: b.emoji, color: b.color, agent: b.agent })),
      lastText: msgs[msgs.length - 1].text.slice(0, 120),
      lastName: msgs[msgs.length - 1].name,
      messageCount: msgs.length,
      updatedAt: g.updatedAt,
      active: g.typing.length > 0,
    },
    {
      id: 'g2',
      title: 'Code review panel',
      topic: 'Review the code',
      bots: [
        { name: 'Archie', emoji: '🏛️', color: '#3B82F6', agent: 'CLAUDE' },
        { name: 'Sentinel', emoji: '🛡️', color: '#EF4444', agent: 'CODEX' },
        { name: 'Tess', emoji: '🧪', color: '#10B981', agent: 'OPENCODE' },
      ],
      lastText: 'The retry loop in fetchForecast never backs off.',
      lastName: 'Sentinel',
      messageCount: 14,
      updatedAt: now - 3 * 60 * MIN,
      active: false,
    },
  ];
  let watching: string | null = null;
  const state = () => post({ type: 'groupState', groupId: g.id, group: JSON.parse(JSON.stringify(g)) });

  return (msg: ViewToHost): boolean => {
    if (msg.type === 'groupWatch') {
      watching = msg.open ? msg.groupId : null;
      if (!msg.open) return true;
      setTimeout(() => {
        post({ type: 'groupList', groups: list() });
        if (msg.groupId === g.id) {
          state();
          post({ type: 'groupMessages', groupId: g.id, messages: msgs, full: true });
        }
      }, 80);
      return true;
    }
    if (msg.type === 'groupSend') {
      const u = m(`u${Date.now()}`, 'user', g.userName, msg.text, 0);
      u.attachments = msg.attachments;
      msgs = [...msgs, u];
      post({ type: 'groupMessages', groupId: g.id, messages: [u], full: false });
      const who = g.bots.find((b) => msg.text.toLowerCase().includes(`@${b.name.toLowerCase()}`)) ?? g.bots[Math.floor(Math.random() * g.bots.length)];
      setTimeout(() => {
        g.typing = [{ botId: who.id, activity: 'typing' }];
        if (watching === g.id) state();
      }, 400);
      setTimeout(() => {
        g.typing = [];
        const r = m(`r${Date.now()}`, who.id, who.name, `${who.emoji} *${who.name} here.* You said: "${msg.text.slice(0, 80)}"`, 0);
        msgs = [...msgs, r];
        if (watching === g.id) {
          state();
          post({ type: 'groupMessages', groupId: g.id, messages: [r], full: false });
        }
      }, 2400);
      return true;
    }
    if (msg.type === 'groupAction') {
      if (msg.action === 'pause' || msg.action === 'resume') {
        g.paused = msg.action === 'pause';
        state();
      } else if (msg.action === 'create') post({ type: 'groupNavigate', groupId: g.id });
      else post({ type: 'toast', level: 'info', message: `Group: ${msg.action}` });
      return true;
    }
    return false;
  };
}
