// A fake extension host for `?mock` in a browser: conversations for all four agents (running, archived, nested
// sub-agents, several workspaces), agent status, models with quota, `/` commands, and an open Claude Code chat that
// replays a realistic turn — prompt with attachments → thinking → markdown → tool calls (RUNNING → SUCCESS/FAILED,
// output, a diff) → a pending approval → a question → a queued message → final reply with token usage.
// URL options: ?mock&view=panel (editor tab layout) · &empty (start on a new chat) · &theme=light|dark · &fast
import type { AgentKind, AiModel, ArtifactSnapshot, ChatAttachment, ChatMessage, Conversation, QueuedMessage, ToolCall } from '@shared/model';
import type { AgentStatus, ApprovalView, ChatPatch, ControlChipView, HostToView, ModelsState, QuestionView, SlashCommandView, ViewToHost } from '@shared/protocol';
import { createMockSettings } from './mockSettings';

type Post = (m: HostToView) => void;

const params = new URLSearchParams(location.search);
const SPEED = params.has('fast') ? 0.25 : 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * SPEED));
const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WS = {
  weather: 'file:///home/dev/projects/nebula-weather',
  antigem: 'file:///home/dev/projects/antigem',
  api: 'file:///home/dev/projects/api-server',
  dots: 'file:///home/dev/dotfiles',
};
let seq = 0;
const id = (p: string) => `${p}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function conv(p: Partial<Conversation> & { id: string; title: string; agent: AgentKind }): Conversation {
  return {
    modelId: 'default',
    createdAt: now - DAY,
    updatedAt: now - HOUR,
    isRunning: false,
    notFullyIdle: false,
    hasActivity: false,
    runStatus: 'IDLE',
    stepCount: 4,
    workspaceUri: WS.weather,
    nestingDepth: 0,
    archived: false,
    ...p,
  };
}

const MAIN = 'conv-weather-dashboard';
const SHOWCASE = 'conv-vscode-tour';

function buildConversations(): Conversation[] {
  return [
    conv({ id: MAIN, title: 'Build a single page weather dashboard', agent: 'CLAUDE', updatedAt: now - 2 * MIN, workspaceUri: WS.weather }),
    conv({ id: 'c-explore', title: 'Explore: chart libraries', agent: 'CLAUDE', parentConversationId: MAIN, subagentRole: 'Explore · chart libraries', nestingDepth: 1, updatedAt: now - 3 * MIN }),
    conv({ id: 'agy-refactor', title: 'Refactor the bridge websocket hub', agent: 'AGY', updatedAt: now - 8 * MIN, isRunning: true, runStatus: 'RUNNING', workspaceUri: WS.antigem }),
    conv({ id: 'agy-sub-1', title: 'Write unit tests for hub.go', agent: 'AGY', parentConversationId: 'agy-refactor', subagentRole: 'Test writer', nestingDepth: 1, isRunning: true, updatedAt: now - 9 * MIN, workspaceUri: WS.antigem }),
    conv({ id: 'agy-sub-2', title: 'Review lock ordering', agent: 'AGY', parentConversationId: 'agy-refactor', subagentRole: 'Reviewer', nestingDepth: 1, updatedAt: now - 30 * MIN, workspaceUri: WS.antigem }),
    conv({ id: 'agy-sub-2a', title: 'Check race detector output', agent: 'AGY', parentConversationId: 'agy-sub-2', subagentRole: 'Race check', nestingDepth: 2, updatedAt: now - 32 * MIN, workspaceUri: WS.antigem }),
    conv({ id: SHOWCASE, title: 'VS Code features tour', agent: 'CLAUDE', updatedAt: now - 30 * MIN, workspaceUri: WS.weather, modelId: 'opus' }),
    conv({ id: 'oc-api', title: 'Add pagination to /v1/orders', agent: 'OPENCODE', updatedAt: now - 2 * HOUR, workspaceUri: WS.api, hasActivity: true }),
    conv({ id: 'codex-ci', title: 'Fix flaky CI job on arm64', agent: 'CODEX', updatedAt: now - 5 * HOUR, workspaceUri: WS.antigem }),
    conv({ id: 'claude-zsh', title: 'Speed up zsh startup', agent: 'CLAUDE', updatedAt: now - DAY - 3 * HOUR, workspaceUri: WS.dots }),
    conv({ id: 'agy-readme', title: 'Rewrite the README intro', agent: 'AGY', updatedAt: now - 2 * DAY, workspaceUri: WS.antigem }),
    conv({ id: 'codex-sql', title: 'Optimize the orders SQL query', agent: 'CODEX', updatedAt: now - 3 * DAY, workspaceUri: WS.api }),
    conv({ id: 'oc-docker', title: 'Dockerfile for the api server', agent: 'OPENCODE', updatedAt: now - 6 * DAY, workspaceUri: WS.api }),
    conv({ id: 'claude-regex', title: 'Regex for semver ranges', agent: 'CLAUDE', updatedAt: now - 12 * DAY, workspaceUri: '' }),
    conv({ id: 'agy-old', title: 'Prototype voice notes', agent: 'AGY', updatedAt: now - 40 * DAY, workspaceUri: WS.antigem, archived: true }),
    conv({ id: 'claude-old', title: 'Old: migrate to Gradle 9', agent: 'CLAUDE', updatedAt: now - 70 * DAY, workspaceUri: WS.antigem, archived: true }),
    conv({ id: 'agy-weather-icons', title: 'Weather icon set (SVG)', agent: 'AGY', updatedAt: now - 4 * DAY, workspaceUri: WS.weather }),
    conv({ id: 'claude-css', title: 'Glassmorphism card CSS', agent: 'CLAUDE', updatedAt: now - 5 * DAY, workspaceUri: WS.weather }),
    conv({ id: 'codex-a11y', title: 'Accessibility pass on the dashboard', agent: 'CODEX', updatedAt: now - 7 * DAY, workspaceUri: WS.weather }),
    conv({ id: 'oc-fetch', title: 'Mock weather API client', agent: 'OPENCODE', updatedAt: now - 8 * DAY, workspaceUri: WS.weather }),
    conv({ id: 'agy-deploy', title: 'Deploy to GitHub Pages', agent: 'AGY', updatedAt: now - 9 * DAY, workspaceUri: WS.weather }),
  ];
}

const AGENTS: AgentStatus[] = [
  { kind: 'AGY', label: 'Ready', state: 'online', detail: 'dev@example.com · Pro' },
  { kind: 'CLAUDE', label: 'Ready', state: 'online', detail: 'dev@example.com · Max · 2.4.1' },
  { kind: 'OPENCODE', label: 'Starting…', state: 'starting', detail: 'Starting… waiting for the server.' },
  { kind: 'CODEX', label: 'Ready', state: 'online', detail: 'dev@example.com · Plus · Codex 0.48' },
];

// the weather chat's artifacts (ArtifactsDrawerContent)
const ARTIFACTS: ArtifactSnapshot[] = [
  { name: 'implementation_plan.md', absoluteUri: 'file:///home/dev/.gemini/brain/weather/implementation_plan.md', lastEdited: new Date(Date.now() - 6 * 60_000).toISOString(), summary: 'Three glass cards over an aurora gradient: current weather, 7 day forecast, hourly canvas chart. No build step, no dependencies.', requestFeedback: true, userFacing: true },
  { name: 'walkthrough.md', absoluteUri: 'file:///home/dev/.gemini/brain/weather/walkthrough.md', lastEdited: new Date(Date.now() - 2 * 60_000).toISOString(), summary: 'What was built, how to run it (open index.html) and how the mock data is shaped.', requestFeedback: false, userFacing: true },
  { name: 'dashboard_screenshot.png', absoluteUri: 'file:///home/dev/projects/nebula-weather/dashboard_screenshot.png', lastEdited: new Date(Date.now() - 60_000).toISOString(), summary: '', requestFeedback: false, userFacing: true },
  { name: 'hourly-chart-notes.txt', absoluteUri: 'file:///home/dev/projects/nebula-weather/notes/hourly-chart-notes.txt', lastEdited: new Date(Date.now() - 60_000).toISOString(), summary: '', requestFeedback: false, userFacing: false },
];

// ---------------------------------------------------------------- controls strips (per chat, and per agent for new chats)

type Ctl = Record<string, string>;
const CTL_DEFAULTS: Record<AgentKind, Ctl> = {
  CLAUDE: { mode: 'auto', effort: '', thinking: 'on' },
  CODEX: { plan: 'off', reasoning: 'medium', approvals: 'auto' },
  OPENCODE: { agent: 'build', approvals: 'ask' },
  AGY: {},
};
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

function controlsFor(agent: AgentKind, c: Ctl, started: boolean): ControlChipView[] {
  if (agent === 'CLAUDE') {
    const modes: [string, string, string][] = [
      ['default', 'Manual', 'Ask before edits and commands'],
      ['acceptEdits', 'Accept edits', 'Apply file edits without asking'],
      ['plan', 'Plan', 'Explore and propose a plan, no changes'],
      ['auto', 'Auto', 'Claude decides what is safe to run'],
    ];
    const efforts: [string, string, string][] = [
      ['', 'Default', "The model's own default"],
      ['low', 'Low', 'Quick answers with light reasoning'],
      ['medium', 'Medium', 'Balanced speed and depth'],
      ['high', 'High', 'Thorough work on hard tasks'],
      ['xhigh', 'Extra high', 'Extra depth for complex changes'],
      ['max', 'Max', 'Most thorough; uses plan limits fastest'],
    ];
    const effortName = efforts.find((e) => e[0] === c.effort)?.[1] ?? c.effort;
    const out: ControlChipView[] = [
      { id: 'mode', title: 'Permission mode', note: 'Auto asks only for risky actions. For fewer prompts without giving up checks, turn on Sandbox commands in Settings → Claude Code → Permissions.', label: modes.find((m) => m[0] === c.mode)?.[1] ?? c.mode, kind: 'select', value: c.mode, icon: 'pan_tool', tone: c.mode === 'default' ? null : 'accent', options: modes.map(([value, label, description]) => ({ value, label, description })) },
      { id: 'effort', title: 'Effort', label: `Effort · ${effortName}${c.effort === '' ? ' (Medium)' : ''}`, kind: 'select', value: c.effort, icon: 'speed', tone: c.effort ? 'accent' : null, options: efforts.map(([value, label, description]) => ({ value, label, description })) },
      { id: 'thinking', label: c.thinking === 'on' ? 'Thinking' : 'No thinking', kind: 'toggle', value: c.thinking, icon: 'lightbulb', tone: c.thinking === 'on' ? 'accent' : 'muted' },
    ];
    if (started) {
      out.push({ id: 'cache', label: 'Cache 61m', kind: 'info', value: '61', icon: 'timer', tone: 'success' });
      out.push({ id: 'context', label: 'Context 34%', kind: 'info', value: '34', icon: 'data_usage', tone: 'success' });
    }
    return out;
  }
  if (agent === 'CODEX') {
    const modes: [string, string, string, string][] = [
      ['read-only', 'Read only', 'Reads the project. Asks before changing files or running anything that needs more.', 'lock'],
      ['ask', 'Ask first', 'Edits files in the project; asks before running commands (except known safe ones).', 'pan_tool'],
      ['auto', 'Auto', "Codex's default: edits and runs commands inside the project; asks before going outside it or online.", 'verified_user'],
      ['full', 'Full access', 'No sandbox and no questions: Codex can change anything and use the network.', 'warning_amber'],
    ];
    const m = modes.find((x) => x[0] === c.approvals) ?? modes[2];
    const efforts: [string, string][] = [
      ['minimal', 'Fast answers for simple tasks.'],
      ['low', 'Fast answers for simple tasks.'],
      ['medium', 'Balanced: the usual choice.'],
      ['high', 'Thinks longer on hard problems (uses more of your limits).'],
      ['xhigh', 'Longest thinking (uses the most of your limits).'],
    ];
    const effortName = (e: string) => (e === 'xhigh' ? 'Extra high' : cap(e));
    return [
      ...(c.plan === 'on' && started ? [{ id: 'implement', label: 'Implement plan', kind: 'action' as const, value: 'run', icon: 'play_arrow', tone: 'success' as const }] : []),
      { id: 'plan', label: c.plan === 'on' ? 'Plan mode' : 'Plan', kind: 'toggle', value: c.plan, icon: 'lightbulb', tone: c.plan === 'on' ? 'accent' : null },
      { id: 'reasoning', title: 'Reasoning', note: 'Applies to the next message and to new chats.', label: `Reasoning: ${effortName(c.reasoning)}`, kind: 'select', value: c.reasoning, icon: 'psychology', tone: c.reasoning === 'high' || c.reasoning === 'xhigh' ? 'accent' : null, options: efforts.map(([value, description]) => ({ value, label: effortName(value), description })) },
      { id: 'approvals', title: 'Approvals', note: 'Applies to the next message of this chat and to new chats. Requests show above the message box.', label: m[1], kind: 'select', value: m[0], icon: m[3], tone: m[0] === 'full' ? 'warn' : null, options: modes.map(([value, label, description]) => ({ value, label, description })) },
    ];
  }
  if (agent === 'OPENCODE') {
    const modes: [string, string, string, string][] = [
      ['ask', 'Ask first', 'Ask before commands, file changes and web access. Reading the project is allowed.', 'pan_tool'],
      ['auto', 'Allow all', 'Commands, edits and web access run without asking.', 'warning_amber'],
      ['default', 'OpenCode rules', "OpenCode's own rules from its config (by default most tools run without asking).", 'rule'],
    ];
    const m = modes.find((x) => x[0] === c.approvals) ?? modes[0];
    return [
      {
        id: 'agent',
        title: 'Agent',
        note: 'Switching applies to the next message of this chat. New chats use the agent from Settings → OpenCode → Permissions.',
        label: cap(c.agent),
        kind: 'select',
        value: c.agent,
        icon: c.agent === 'plan' ? 'lightbulb' : 'smart_toy',
        tone: c.agent === 'plan' ? 'accent' : null,
        options: [
          { value: 'build', label: 'Build', description: 'Makes changes: edits files and runs commands to get the job done.' },
          { value: 'plan', label: 'Plan', description: 'Read-only: explores the code and plans the work, without changing files.' },
        ],
      },
      { id: 'approvals', title: 'Approvals', note: 'Applies to this chat right away and to new chats. Requests show above the message box.', label: m[1], kind: 'select', value: m[0], icon: m[3], tone: m[0] === 'auto' ? 'warn' : null, options: modes.map(([value, label, description]) => ({ value, label, description })) },
    ];
  }
  return [];
}

function model(p: Partial<AiModel> & { id: string; displayName: string }): AiModel {
  return { family: 'OTHER', description: '', isDefault: false, baseName: '', ...p };
}

const MODELS: Record<AgentKind, ModelsState> = {
  CLAUDE: {
    agent: 'CLAUDE',
    selectedId: 'default',
    groups: [{ name: 'All models', windows: [{ label: '5h', remaining: 0.91, resetText: '2h 20m' }, { label: '7d', remaining: 0.68, resetText: '2d 17h' }] }],
    models: [
      model({ id: 'default', displayName: 'Default (Sonnet 5.5)', baseName: 'Default (recommended)', family: 'CLAUDE', description: 'Sonnet 5.5 · Efficient for routine tasks', isDefault: true, quotaRemaining: 0.9, quotaText: '90%', group: 'All models' }),
      model({ id: 'opus', displayName: 'Opus 5.5', baseName: 'Opus 5.5', family: 'CLAUDE', description: 'For complex work and everyday tasks', quotaRemaining: 0.9, group: 'All models' }),
      model({ id: 'sonnet', displayName: 'Sonnet 5.5', baseName: 'Sonnet 5.5', family: 'CLAUDE', description: 'Most efficient for simpler tasks', quotaRemaining: 0.9, group: 'All models' }),
      model({ id: 'haiku', displayName: 'Haiku 4.5', baseName: 'Haiku 4.5', family: 'CLAUDE', description: 'Fastest model for quick answers', quotaRemaining: 0.9, group: 'All models' }),
    ],
  },
  AGY: {
    agent: 'AGY',
    selectedId: 'gemini-3-pro-high',
    groups: [
      { name: 'Gemini', windows: [{ label: '5h', remaining: 0.42, resetText: '3h 5m' }] },
      { name: 'Claude & GPT', windows: [{ label: '5h', remaining: 0.15, resetText: '58m' }, { label: '7d', remaining: 0.81, resetText: '4d 2h' }] },
    ],
    models: [
      model({ id: 'gemini-3-pro-high', displayName: 'Gemini 3 Pro (High)', baseName: 'Gemini 3 Pro', tier: 'High', family: 'GEMINI', description: 'Deep reasoning for hard problems', quotaRemaining: 0.42, group: 'Gemini' }),
      model({ id: 'gemini-3-pro-low', displayName: 'Gemini 3 Pro (Low)', baseName: 'Gemini 3 Pro', tier: 'Low', family: 'GEMINI', description: 'Deep reasoning for hard problems', quotaRemaining: 0.42, group: 'Gemini' }),
      model({ id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', baseName: 'Gemini 3 Flash', family: 'GEMINI', description: 'Fast and light', quotaRemaining: 0.42, group: 'Gemini' }),
      model({ id: 'claude-sonnet-thinking', displayName: 'Claude Sonnet 4.5 (Thinking)', baseName: 'Claude Sonnet 4.5', family: 'CLAUDE', description: 'Anthropic, via Antigravity', quotaRemaining: 0.15, group: 'Claude & GPT' }),
      model({ id: 'gpt-oss', displayName: 'GPT-OSS 120B (Medium)', baseName: 'GPT-OSS 120B', family: 'OTHER', description: 'Open weights', quotaRemaining: 0.15, group: 'Claude & GPT' }),
    ],
  },
  OPENCODE: {
    agent: 'OPENCODE',
    selectedId: 'anthropic/claude-sonnet-4-5',
    // like the host (OpenCodeBackend): baseName and group = the provider's name
    models: (
      [
        ['anthropic/claude-sonnet-4-5', 'Claude Sonnet 4.5', 'Anthropic', 200, false, 'CLAUDE'],
        ['anthropic/claude-opus-4-1', 'Claude Opus 4.1', 'Anthropic', 200, false, 'CLAUDE'],
        ['anthropic/claude-haiku-4-5', 'Claude Haiku 4.5', 'Anthropic', 200, false, 'CLAUDE'],
        ['openai/gpt-5', 'GPT-5', 'OpenAI', 400, false, 'OTHER'],
        ['openai/gpt-5-mini', 'GPT-5 mini', 'OpenAI', 400, false, 'OTHER'],
        ['google/gemini-2.5-pro', 'Gemini 2.5 Pro', 'Google', 1048, false, 'GEMINI'],
        ['opencode/grok-code', 'Grok Code Fast 1', 'OpenCode Zen', 256, true, 'OTHER'],
        ['opencode/qwen3-coder', 'Qwen3 Coder', 'OpenCode Zen', 262, true, 'OTHER'],
        ['opencode/big-pickle', 'Big Pickle', 'OpenCode Zen', 200, true, 'OTHER'],
      ] as [string, string, string, number, boolean, AiModel['family']][]
    ).map(([id, displayName, provider, ctx, free, family]) =>
      model({ id, key: id, displayName, family, description: [provider, `${ctx}K context`, free ? 'free' : null].filter(Boolean).join(' · '), baseName: provider, group: provider, isDefault: id === 'anthropic/claude-sonnet-4-5' }),
    ),
  },
  CODEX: {
    agent: 'CODEX',
    selectedId: 'gpt-5-codex-medium',
    groups: [{ name: 'ChatGPT Plus', windows: [{ label: '5h', remaining: 0.73, resetText: '1h 12m' }, { label: '7d', remaining: 0.55, resetText: '5d' }] }],
    models: [
      model({ id: 'gpt-5-codex-low', displayName: 'gpt-5-codex (Low)', baseName: 'gpt-5-codex', tier: 'Low', description: 'Optimized for coding agents', quotaRemaining: 0.73, group: 'ChatGPT Plus' }),
      model({ id: 'gpt-5-codex-medium', displayName: 'gpt-5-codex (Medium)', baseName: 'gpt-5-codex', tier: 'Medium', description: 'Optimized for coding agents', quotaRemaining: 0.73, quotaText: '73%', isDefault: true, group: 'ChatGPT Plus' }),
      model({ id: 'gpt-5-codex-high', displayName: 'gpt-5-codex (High)', baseName: 'gpt-5-codex', tier: 'High', description: 'Optimized for coding agents', quotaRemaining: 0.73, group: 'ChatGPT Plus' }),
      model({ id: 'gpt-5', displayName: 'gpt-5 (Medium)', baseName: 'gpt-5', description: 'Broad world knowledge', quotaRemaining: 0.73, group: 'ChatGPT Plus' }),
    ],
  },
};

const COMMANDS: SlashCommandView[] = [
  { command: '/compact', description: 'Summarize the conversation to free up context', runsOnTap: true, kind: 'command' },
  { command: '/clear', description: 'Start over with an empty context', runsOnTap: true, kind: 'command' },
  { command: '/review', description: 'Review the pending changes on this branch', argumentHint: '[pr]', kind: 'command' },
  { command: '/init', description: 'Write a CLAUDE.md for this project', runsOnTap: true, kind: 'command' },
  { command: '/model', description: 'Switch the model', kind: 'app' },
  { command: '/settings', description: 'Open the settings', kind: 'app' },
  { command: '/theme', description: 'Try another theme', kind: 'app' },
  { command: '/cost', description: 'Show the token cost of this chat', runsOnTap: true, kind: 'command' },
  { command: '/memory', description: 'Edit CLAUDE.md memory files', kind: 'command' },
  { command: '/add-dir', description: 'Add a working directory', argumentHint: '<path>', kind: 'command' },
  { command: '/xlsx', description: 'Create and edit spreadsheets', kind: 'skill', pluginName: 'docs' },
  { command: '/release-notes', description: 'Draft release notes from the git log', kind: 'plugin', pluginName: 'antigem-tools' },
  { command: '/frontend-design', description: 'Design guidance for polished UIs', kind: 'skill' },
  { command: '/pdf', description: 'Read, fill and merge PDF files', kind: 'skill', pluginName: 'docs' },
  { command: '/deploy', description: 'Build and publish to GitHub Pages', argumentHint: '<branch>', kind: 'custom' },
];

const FILES = [
  'index.html', 'style.css', 'app.js', 'README.md', 'package.json', 'assets/icons/sun.svg', 'assets/icons/cloud.svg',
  'assets/icons/rain.svg', 'src/api/client.js', 'src/chart/hourly.js', 'src/chart/axis.js', 'tests/app.test.js',
].map((p) => ({ path: `/home/dev/projects/nebula-weather/${p}`, relativePath: p, kind: 'file' as const, isOpen: p === 'app.js' || p === 'style.css' }));
const FOLDERS = ['assets', 'assets/icons', 'src', 'src/api', 'src/chart', 'tests'].map((p) => ({
  path: `/home/dev/projects/nebula-weather/${p}`,
  relativePath: `${p}/`,
  kind: 'folder' as const,
}));

const SVG_THUMB = btoa(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f46e5"/><stop offset=".5" stop-color="#0ea5e9"/><stop offset="1" stop-color="#14b8a6"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><rect x="24" y="28" width="150" height="100" rx="16" fill="#ffffff" fill-opacity=".18" stroke="#fff" stroke-opacity=".4"/><circle cx="64" cy="68" r="18" fill="#fde68a"/><text x="96" y="76" font-family="sans-serif" font-size="22" fill="#fff">18&#176;</text><rect x="190" y="28" width="106" height="44" rx="12" fill="#fff" fill-opacity=".14"/><rect x="190" y="84" width="106" height="44" rx="12" fill="#fff" fill-opacity=".14"/><path d="M24 160 C70 140 110 150 150 135 S240 120 296 140" stroke="#fff" stroke-width="3" fill="none" stroke-opacity=".8"/></svg>`,
);

const ATTACHMENTS: ChatAttachment[] = [
  { id: 'att-1', name: 'mockup.png', path: '', isImage: true, isAudio: false, size: 48213, mimeType: 'image/svg+xml', base64: SVG_THUMB },
  { id: 'att-2', name: 'style-guide.md', path: '/home/dev/projects/nebula-weather/docs/style-guide.md', isImage: false, isAudio: false, size: 3120, mimeType: 'text/markdown', reference: true },
];

const PROMPT =
  'Build a single page weather dashboard in this folder: index.html, style.css and app.js. Dark glassmorphism UI with an animated aurora gradient background, a big current weather card, a 7 day forecast row and an hourly temperature chart drawn on a canvas. Keep it under 250 lines total and follow the attached style guide.\nUse mock data for now.';

const THOUGHT =
  "I'm going to lay out a short todo list first, then start writing the files, keeping the whole thing under 250 lines. The mockup shows three glass cards over a teal-to-indigo gradient, so I'll use backdrop-filter for the cards and three blurred blobs for the aurora. I'm leaving out the dataviz skill since this isn't a charting job, so I'll just draw the hourly curve on a canvas directly.";

const DIFF_HTML = `--- a/index.html
+++ b/index.html
@@ -1,6 +1,22 @@
 <!doctype html>
 <html lang="en">
 <head>
-  <title>Weather</title>
+  <meta charset="utf-8" />
+  <meta name="viewport" content="width=device-width, initial-scale=1" />
+  <title>Nebula Weather</title>
+  <link rel="stylesheet" href="style.css" />
 </head>
 <body>
+  <div class="aurora"><span></span><span></span><span></span></div>
+  <main class="grid">
+    <section class="card current" id="current"></section>
+    <section class="card hourly">
+      <h2>Next 24 hours</h2>
+      <canvas id="chart" height="160"></canvas>
+    </section>
+    <section class="card forecast" id="forecast"></section>
+  </main>
+  <script src="app.js"></script>
 </body>
 </html>`;

const DIFF_CSS = `--- a/style.css
+++ b/style.css
@@ -0,0 +1,14 @@
+:root { --glass: rgba(255,255,255,.08); --edge: rgba(255,255,255,.18); }
+body { margin: 0; min-height: 100vh; background: #070b1a; color: #e8eaf6; font: 15px/1.5 system-ui; }
+.aurora span { position: fixed; width: 60vmax; height: 60vmax; border-radius: 50%; filter: blur(80px); opacity: .55; animation: drift 24s ease-in-out infinite alternate; }
+.aurora span:nth-child(1) { background: #4f46e5; top: -20%; left: -10%; }
+.aurora span:nth-child(2) { background: #0ea5e9; bottom: -25%; right: -15%; animation-delay: -8s; }
+.aurora span:nth-child(3) { background: #14b8a6; top: 30%; left: 40%; animation-delay: -16s; }
+.card { background: var(--glass); border: 1px solid var(--edge); border-radius: 20px; backdrop-filter: blur(18px); padding: 20px; }
+@keyframes drift { to { transform: translate(10vmax, 6vmax) scale(1.15); } }
+@media (prefers-reduced-motion: reduce) { .aurora span { animation: none; } }`;

const APP_JS_CODE = `const hourly = Array.from({ length: 24 }, (_, h) => ({
  hour: h,
  temp: 9 + 6 * Math.sin(((h - 9) / 24) * Math.PI * 2),
}));

function drawChart(canvas, points) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const min = Math.min(...points.map((p) => p.temp)) - 1;
  const max = Math.max(...points.map((p) => p.temp)) + 1;
  const x = (i) => (i / (points.length - 1)) * width;
  const y = (t) => height - ((t - min) / (max - min)) * height;
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, 'rgba(94, 234, 212, 0.45)');
  grad.addColorStop(1, 'rgba(94, 234, 212, 0)');
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.temp)) : ctx.moveTo(0, y(p.temp))));
  ctx.strokeStyle = '#5eead4'; // the aurora teal
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.fillStyle = grad;
  ctx.fill();
}

drawChart(document.getElementById('chart'), hourly);`;

const FINAL_TEXT = `I built the dashboard in \`/home/dev/projects/nebula-weather\`. It comes to **218 lines** total, under your 250 limit. \`app.js\` passes a Node syntax check, but I haven't opened the page in a browser, so the visuals are untested.

- \`index.html\` (44 lines): the layout, with the current-weather card, the hourly chart section and the 7-day forecast row.
- \`style.css\` (71 lines): a dark theme with three blurred, drifting colour blobs as the aurora background. The cards are frosted glass using \`backdrop-filter\`.
  - The aurora animation turns off if the device is set to *reduced motion*.
- \`app.js\` (103 lines): hard-coded mock data for Reykjavík, the current card, the 7-day row and the canvas chart.

The chart is drawn like this (sharp on high-DPI screens):

\`\`\`javascript
${APP_JS_CODE}
\`\`\`

| File | Lines | Notes |
|:-----|------:|:------|
| index.html | 44 | layout and canvas |
| style.css | 71 | aurora + glass cards, \`#5eead4\` accent |
| app.js | 103 | mock data, rendering, chart |

> [!TIP]
> To view it, open [index.html](file:///home/dev/projects/nebula-weather/index.html) in a browser, or run \`python -m http.server\` in that folder.

The test run failed on a missing \`jsdom\` setup, see the ~~red~~ failed step above; I left the test file in place for later.`;

// ------------------------------------------------------------------------------------------------ the fake host

interface ChatData {
  messages: ChatMessage[];
  queued: QueuedMessage[];
  isStreaming: boolean;
}

export function startMock(post: Post): (m: ViewToHost) => void {
  let conversations = buildConversations();
  const agents = AGENTS.map((a) => ({ ...a }));
  const models: Record<string, ModelsState> = JSON.parse(JSON.stringify(MODELS));
  const chats = new Map<string, ChatData>();
  let current: string | null = null;
  let waitApproval: ((r: { allow: boolean }) => void) | null = null;
  let waitAnswer: ((r: Record<string, string[]>, custom?: Record<string, string>) => void) | null = null;
  let stopped = false;

  const patch = (conversationId: string | null, p: ChatPatch) => {
    if (conversationId === current) post({ type: 'chat', conversationId, patch: p });
  };
  const chatOf = (cid: string): ChatData => {
    let c = chats.get(cid);
    if (!c) {
      c = { messages: historyFor(cid), queued: [], isStreaming: false };
      chats.set(cid, c);
    }
    return c;
  };
  const upsert = (cid: string, m: ChatMessage) => {
    const c = chatOf(cid);
    const i = c.messages.findIndex((x) => x.id === m.id);
    const copy = JSON.parse(JSON.stringify(m)) as ChatMessage;
    if (i < 0) {
      c.messages.push(copy);
      patch(cid, { order: c.messages.map((x) => x.id), upserts: [copy] });
    } else {
      c.messages[i] = copy;
      patch(cid, { upserts: [copy] });
    }
  };
  const sendConversations = () => post({ type: 'conversations', conversations: JSON.parse(JSON.stringify(conversations)) });
  const touch = (cid: string, p: Partial<Conversation>) => {
    conversations = conversations.map((c) => (c.id === cid ? { ...c, ...p } : c));
    sendConversations();
  };

  const loadFailed = new Set<string>();
  const ctls = new Map<string, Ctl>();
  const ctlOf = (key: string, agent: AgentKind): Ctl => {
    if (!ctls.has(key)) ctls.set(key, { ...(ctls.get(`new:${agent}`) ?? CTL_DEFAULTS[agent]) });
    return ctls.get(key)!;
  };
  const controlsOf = (cid: string | null, agent: AgentKind) => controlsFor(agent, ctlOf(cid ?? `new:${agent}`, agent), !!cid);
  const open = (cid: string | null, agent?: AgentKind) => {
    current = cid;
    if (!cid) {
      post({ type: 'chat', conversationId: null, patch: { reset: true, agent: agent ?? 'CLAUDE', controls: controlsOf(null, agent ?? 'CLAUDE') } });
      return;
    }
    const conversation = conversations.find((c) => c.id === cid) ?? null;
    const c = chatOf(cid);
    post({ type: 'chat', conversationId: cid, patch: { reset: true, conversation, agent: conversation?.agent, isLoading: true, controls: controlsOf(cid, conversation?.agent ?? 'CLAUDE') } });
    setTimeout(() => {
      if (current !== cid) return;
      // ?loaderr: the first load of a chat fails (the Retry button then loads it)
      if (params.has('loaderr') && !loadFailed.has(cid)) {
        loadFailed.add(cid);
        patch(cid, { isLoading: false, error: 'Cannot load the chat: the agent did not answer in 30 s (hub at 127.0.0.1:5199).' });
        return;
      }
      patch(cid, {
        isLoading: false,
        error: null,
        order: c.messages.map((m) => m.id),
        upserts: c.messages,
        isStreaming: c.isStreaming,
        queued: c.queued,
        artifacts: cid === MAIN || conversation?.agent === 'AGY' ? ARTIFACTS : [],
        // Claude chats keep their own model (the pill prefers it)
        modelId: conversation?.agent === 'CLAUDE' && conversation.modelId && conversation.modelId !== 'default' ? conversation.modelId : null,
        // Codex / OpenCode: a provider notice above the strip for a while
        notice: conversation?.agent === 'CODEX' ? 'Model rerouted: gpt-5-codex is busy, using gpt-5 · retrying in 3s' : null,
      });
      if (conversation?.agent === 'CODEX') setTimeout(() => current === cid && patch(cid, { notice: null }), 7000 * SPEED);
    }, 450 * SPEED);
  };

  // ---------------------------------------------------------------- streaming helpers
  async function streamInto(cid: string, msg: ChatMessage, field: 'content' | 'thoughtText', text: string, cps = 260) {
    const cur: string = (msg as any)[field] ?? '';
    let i = text.startsWith(cur) ? cur.length : 0;
    while (i < text.length) {
      if (stopped) return;
      const step = Math.max(2, Math.round((cps / 1000) * 35 * (0.6 + Math.random() * 0.8)));
      i = Math.min(text.length, i + step);
      (msg as any)[field] = text.substring(0, i);
      upsert(cid, msg);
      await sleep(35);
    }
  }

  async function runTool(cid: string, msg: ChatMessage, t: ToolCall, opts: { ms: number; output?: string; streamOutput?: string[]; fail?: boolean }) {
    msg.toolCalls.push(t);
    msg.content += `\n<!-- tool_call:${t.id} -->\n`;
    upsert(cid, msg);
    const start = performance.now();
    if (opts.streamOutput) {
      for (const line of opts.streamOutput) {
        if (stopped) break;
        await sleep(opts.ms / opts.streamOutput.length);
        t.output = (t.output ? t.output + '\n' : '') + line;
        upsert(cid, msg);
      }
    } else await sleep(opts.ms);
    if (stopped) {
      t.status = 'TERMINATED';
    } else {
      t.status = opts.fail ? 'FAILED' : 'SUCCESS';
      t.exitCode = opts.fail ? 1 : 0;
      if (opts.output != null) t.output = opts.output;
    }
    t.durationMs = Math.round((performance.now() - start) / SPEED);
    upsert(cid, msg);
  }

  // ---------------------------------------------------------------- the scripted turn
  async function scenario() {
    const cid = MAIN;
    const c = chatOf(cid);
    stopped = false;
    await sleep(1400);
    const user: ChatMessage = {
      id: id('u'),
      conversationId: cid,
      role: 'USER',
      content: PROMPT,
      toolCalls: [],
      isStreaming: false,
      attachments: ATTACHMENTS,
      createdAt: Date.now(),
    };
    upsert(cid, user);
    c.isStreaming = true;
    patch(cid, { isStreaming: true });
    touch(cid, { isRunning: true, updatedAt: Date.now() });
    await sleep(900);

    const msg: ChatMessage = {
      id: id('a'),
      conversationId: cid,
      role: 'ASSISTANT',
      content: '',
      thoughtText: '',
      toolCalls: [],
      isStreaming: true,
      attachments: [],
      createdAt: Date.now(),
      modelId: 'default',
    };
    upsert(cid, msg);
    await sleep(1200);
    const thinkStart = performance.now();
    await streamInto(cid, msg, 'thoughtText', THOUGHT, 180);
    msg.thoughtDurationMs = Math.round((performance.now() - thinkStart) / SPEED) + 1800;
    upsert(cid, msg);
    await sleep(500);

    await streamInto(cid, msg, 'content', '## Todo\n\n1. Write `index.html` (layout and canvas)\n2. Write `style.css` (aurora background and glass cards)\n3. Write `app.js` (mock data, rendering, canvas chart)\n4. Check line count and syntax\n', 320);
    await sleep(400);

    await runTool(cid, msg, { id: 'toolu_01', name: 'Read', toolType: 'VIEW_FILE', command: 'docs/style-guide.md', status: 'RUNNING', output: '' }, {
      ms: 700,
      output: '# Nebula style guide\n\n- Background: #070b1a, accents #4f46e5 / #0ea5e9 / #14b8a6\n- Cards: frosted glass, 20px radius, 1px white @ 18%\n- Type: system-ui, 15px body, tabular numbers for temperatures',
    });
    await runTool(cid, msg, { id: 'toolu_02', name: 'Write', toolType: 'EDIT_FILE', command: 'index.html', status: 'RUNNING', output: '' }, { ms: 1500, output: DIFF_HTML });
    await runTool(cid, msg, { id: 'toolu_03', name: 'Write', toolType: 'EDIT_FILE', command: 'style.css', status: 'RUNNING', output: '' }, { ms: 1300, output: DIFF_CSS });
    await runTool(cid, msg, { id: 'toolu_04', name: 'Grep', toolType: 'GREP_SEARCH', command: 'getElementById', status: 'RUNNING', output: '' }, {
      ms: 600,
      output: 'index.html:12:    <section class="card current" id="current"></section>\nindex.html:15:      <canvas id="chart" height="160"></canvas>\nindex.html:17:    <section class="card forecast" id="forecast"></section>',
    });
    await runTool(cid, msg, { id: 'toolu_05', name: 'Bash', toolType: 'BASH', command: 'npm test -- --silent', status: 'RUNNING', output: '' }, {
      ms: 1800,
      streamOutput: [
        '> nebula-weather@0.1.0 test',
        '> node --test tests/',
        '',
        '✖ tests/app.test.js',
        "  ReferenceError: document is not defined",
        '      at drawChart (app.js:7:20)',
        '',
        'ℹ tests 3  pass 2  fail 1',
      ],
      fail: true,
    });
    if (stopped) return finish(cid, msg);

    await streamInto(cid, msg, 'content', msg.content + '\nThe test needs a DOM. I\'ll add `jsdom` as a dev dependency so `node --test` can run it.\n', 320);

    // ---- a pending approval
    const t6: ToolCall = { id: 'toolu_06', name: 'Bash', toolType: 'BASH', command: 'npm install --save-dev jsdom', status: 'PENDING_APPROVAL', output: '' };
    msg.toolCalls.push(t6);
    msg.content += `\n<!-- tool_call:${t6.id} -->\n`;
    upsert(cid, msg);
    const approval: ApprovalView = {
      key: 'perm-1',
      agent: 'CLAUDE',
      icon: 'terminal',
      title: 'Run a command?',
      subtitle: 'Bash',
      target: '/home/dev/projects/nebula-weather',
      preview: '$ npm install --save-dev jsdom\n# adds 47 packages to node_modules\n+ "jsdom": "^25.0.1"',
      reason: 'Needed so the canvas test can run under node --test.',
      primary: { id: 'allow', label: 'Allow' },
      secondary: [],
      always: [
        { id: 'always-cmd', label: 'Always allow `npm install`', description: 'In this project' },
        { id: 'always-bash', label: 'Allow all Bash this session', description: 'Until the chat restarts' },
      ],
      denyLabel: 'Deny',
      denyPlaceholder: 'Tell Claude what to do instead (optional)',
    };
    patch(cid, { approvals: [approval] });
    const decision = await new Promise<{ allow: boolean }>((r) => (waitApproval = r));
    waitApproval = null;
    patch(cid, { approvals: [] });
    if (stopped) return finish(cid, msg);
    if (decision.allow) {
      t6.status = 'RUNNING';
      upsert(cid, msg);
      const s = performance.now();
      for (const line of ['', 'added 47 packages, and audited 48 packages in 3s', '', '9 packages are looking for funding', '  run `npm fund` for details', '', 'found 0 vulnerabilities']) {
        await sleep(280);
        t6.output = (t6.output ? t6.output + '\n' : '') + line;
        upsert(cid, msg);
      }
      t6.status = 'SUCCESS';
      t6.exitCode = 0;
      t6.durationMs = Math.round((performance.now() - s) / SPEED);
    } else {
      t6.status = 'REJECTED';
    }
    upsert(cid, msg);
    await sleep(500);

    // ---- a question
    const t7: ToolCall = {
      id: 'toolu_07',
      name: 'AskUserQuestion',
      toolType: 'ASK_CHOICE',
      command: 'Units and city',
      status: 'AWAITING_CHOICE',
      output: '',
      questionnaire: {
        title: 'A couple of choices',
        allowCustomNote: false,
        questions: [
          {
            id: 'units',
            prompt: 'Which temperature units should the dashboard show?',
            description: 'Units',
            isMultiSelect: false,
            allowCustomAnswer: false,
            options: [
              { id: 'c', label: 'Celsius', description: 'Shown as 18°' },
              { id: 'f', label: 'Fahrenheit', description: 'Shown as 64°' },
              { id: 'both', label: 'Both, with a toggle', description: 'A °C / °F switch in the header' },
            ],
          },
          {
            id: 'extras',
            prompt: 'Anything else on the current-weather card?',
            description: 'Pick any that apply to the big card at the top',
            isMultiSelect: true,
            allowCustomAnswer: true,
            options: [
              { id: 'wind', label: 'Wind speed and direction' },
              { id: 'uv', label: 'UV index' },
              { id: 'sun', label: 'Sunrise and sunset' },
            ],
          },
        ],
      },
    };
    msg.toolCalls.push(t7);
    msg.content += `\n<!-- tool_call:${t7.id} -->\n`;
    upsert(cid, msg);
    const question: QuestionView = { key: 'q-1', agent: 'CLAUDE', questionnaire: t7.questionnaire! };
    patch(cid, { question });
    const answers = await new Promise<{ a: Record<string, string[]>; custom?: Record<string, string> }>((r) => (waitAnswer = (a, custom) => r({ a, custom })));
    waitAnswer = null;
    patch(cid, { question: null });
    const label = (qid: string, oid: string) => t7.questionnaire!.questions.find((q) => q.id === qid)?.options.find((o) => o.id === oid)?.label ?? oid;
    t7.status = 'SUCCESS';
    t7.output = t7.questionnaire!.questions
      .map((q) => `• ${q.prompt}: ${[...(answers.a[q.id] ?? []).map((o) => label(q.id, o)), answers.custom?.[q.id]].filter(Boolean).join(', ') || 'Skipped'}`)
      .join('\n');
    upsert(cid, msg);
    if (stopped) return finish(cid, msg);

    // ---- a message the user "typed" while the agent works
    c.queued = [{ id: 'q-auto', text: 'Also add a small "updated 2 min ago" label under the city name', attachmentCount: 0, canSendNow: true, canDelete: true, isPending: false }];
    patch(cid, { queued: c.queued });

    await runTool(cid, msg, { id: 'toolu_08', name: 'Write', toolType: 'EDIT_FILE', command: 'app.js', status: 'RUNNING', output: '' }, {
      ms: 1600,
      output: `--- a/app.js\n+++ b/app.js\n@@ -0,0 +1,8 @@\n${APP_JS_CODE.split('\n').slice(0, 8).map((l) => '+' + l).join('\n')}`,
    });
    await runTool(cid, msg, { id: 'toolu_09', name: 'Bash', toolType: 'BASH', command: 'wc -l index.html style.css app.js && node --check app.js', status: 'RUNNING', output: '' }, {
      ms: 900,
      output: '   44 index.html\n   71 style.css\n  103 app.js\n  218 total',
    });
    if (stopped) return finish(cid, msg);
    await sleep(300);
    await streamInto(cid, msg, 'content', msg.content + '\n' + FINAL_TEXT, 520);
    await finish(cid, msg, true);
  }

  async function finish(cid: string, msg: ChatMessage, ok = false) {
    const c = chatOf(cid);
    for (const t of msg.toolCalls) if (t.status === 'RUNNING' || t.status === 'PENDING_APPROVAL') t.status = 'TERMINATED';
    msg.isStreaming = false;
    if (ok || msg.content) {
      msg.tokenUsage = {
        promptTokens: 16_300,
        outputTokens: 5_100,
        cachedTokens: 64_500,
        cacheCreationTokens: 2_100,
        totalTokens: 88_000,
        durationMs: 34_000,
        isEstimated: false,
        costUsd: 0.0912,
        model: 'claude-sonnet-5-5',
      };
    }
    upsert(cid, msg);
    patch(cid, { approvals: [], question: null });
    await sleep(250);
    c.isStreaming = false;
    patch(cid, { isStreaming: false });
    touch(cid, { isRunning: false, updatedAt: Date.now() });
    // deliver what was queued
    const next = c.queued.shift();
    if (next && !stopped) {
      patch(cid, { queued: c.queued });
      await sleep(700);
      await reply(cid, next.text, []);
    }
  }

  /**
   * A turn as the real host sends it: the user message (`user_<conv>_<step>`) and an empty streaming assistant message
   * (`<conv>_<n>`) arrive together; ~120 ms later both are re-upserted with small changes (rawContent, createdAt);
   * then the text streams. A new chat first gets a reset with the full state of its new id (the host re-subscribes).
   */
  async function reply(cid: string, text: string, attachments: ChatAttachment[], isNew = false) {
    const c = chatOf(cid);
    stopped = false;
    const step = c.messages.length;
    const conv = conversations.find((x) => x.id === cid);
    const user: ChatMessage = {
      id: `user_${cid}_${step}`,
      conversationId: cid,
      role: 'USER',
      content: text,
      toolCalls: [],
      isStreaming: false,
      attachments,
      createdAt: Date.now() - 40,
      stepIndex: step,
    };
    const msg: ChatMessage = {
      id: `${cid}_${step + 1}`,
      conversationId: cid,
      role: 'ASSISTANT',
      content: '',
      thoughtText: '',
      toolCalls: [],
      isStreaming: true,
      attachments: [],
      createdAt: Date.now(),
      modelId: models[conv?.agent ?? 'CLAUDE']?.selectedId ?? 'default',
    };
    await sleep(60);
    c.messages.push(JSON.parse(JSON.stringify(user)), JSON.parse(JSON.stringify(msg)));
    c.isStreaming = true;
    if (isNew) {
      post({
        type: 'chat',
        conversationId: cid,
        patch: { reset: true, conversation: conv ?? null, agent: conv?.agent, order: c.messages.map((x) => x.id), upserts: JSON.parse(JSON.stringify(c.messages)), isStreaming: true, controls: controlsOf(cid, conv?.agent ?? 'CLAUDE') },
      });
    } else {
      patch(cid, { order: c.messages.map((x) => x.id), upserts: JSON.parse(JSON.stringify([user, msg])), isStreaming: true });
    }
    touch(cid, { isRunning: true, updatedAt: Date.now() });
    await sleep(120);
    user.rawContent = text;
    user.createdAt += 37;
    msg.createdAt += 12;
    upsert(cid, user);
    upsert(cid, msg);
    await sleep(300);
    await streamInto(cid, msg, 'thoughtText', `The user asked: "${text.slice(0, 80)}". A small change; I'll edit the file and keep the style consistent.`, 200);
    msg.thoughtDurationMs = 2400;
    await runTool(cid, msg, { id: id('tool'), name: 'Edit', toolType: 'EDIT_FILE', command: 'app.js', status: 'RUNNING', output: '' }, {
      ms: 1200,
      output: `--- a/app.js\n+++ b/app.js\n@@ -41,6 +41,7 @@ function renderCurrent(data) {\n   el.querySelector('.city').textContent = data.city;\n+  el.querySelector('.updated').textContent = \`updated \${ago(data.at)}\`;\n   el.querySelector('.temp').textContent = fmt(data.temp);\n }`,
    });
    if (!stopped) {
      await streamInto(
        cid,
        msg,
        'content',
        msg.content + `\nDone. The card now shows **updated 2 min ago** under the city, refreshed every minute by \`setInterval\`:\n\n\`\`\`js\nsetInterval(() => renderCurrent(state.current), 60_000);\n\`\`\`\n`,
        420,
      );
    }
    msg.isStreaming = false;
    msg.tokenUsage = { promptTokens: 18_900, outputTokens: 640, cachedTokens: 80_200, cacheCreationTokens: 0, totalTokens: 99_740, durationMs: 9_400, isEstimated: false, model: 'claude-sonnet-5-5' };
    upsert(cid, msg);
    await sleep(200);
    c.isStreaming = false;
    patch(cid, { isStreaming: false });
    touch(cid, { isRunning: false, updatedAt: Date.now() });
    const next = c.queued.shift();
    if (next) {
      patch(cid, { queued: c.queued });
      await sleep(600);
      await reply(cid, next.text, []);
    }
  }

  // ---------------------------------------------------------------- view → host
  const mockSettings = createMockSettings(post);
  let savedProjects = [WS.api, 'file:///home/dev/projects/old-blog'];
  return (m: ViewToHost) => {
    if (mockSettings.handle(m)) return;
    switch (m.type) {
      case 'ready': {
        const view = (params.get('view') as 'sidebar' | 'panel') ?? 'sidebar';
        post({
          type: 'init',
          viewKind: view === 'panel' ? 'panel' : 'sidebar',
          workspaceFolders: [
            { name: 'nebula-weather', uri: WS.weather, path: '/home/dev/projects/nebula-weather' },
            { name: 'antigem', uri: WS.antigem, path: '/home/dev/projects/antigem' },
          ],
          conversationId: params.has('empty') ? null : MAIN,
          defaultAgent: 'CLAUDE',
        });
        // ?offline=AGENT (default: the weather chat's Claude Code): that agent is down (the disconnected banner)
        if (params.has('offline')) {
          const k = (params.get('offline') || 'CLAUDE').toUpperCase();
          const a = agents.find((x) => x.kind === k);
          if (a) Object.assign(a, { state: 'offline', label: 'Offline', detail: 'Cannot reach the hub at 127.0.0.1:5199' });
        }
        post({ type: 'agents', agents: agents.map((a) => ({ ...a })) });
        // the VS Code editor: app.js open, then a selection in it (?editor=none / file / sel)
        {
          const ed = params.get('editor') ?? 'sel';
          const base = { path: '/home/dev/projects/nebula-weather/app.js', relativePath: 'app.js', name: 'app.js', languageId: 'javascript' };
          if (ed !== 'none') post({ type: 'editorContext', context: { ...base, selection: null } });
          if (ed === 'sel')
            setTimeout(
              () =>
                post({
                  type: 'editorContext',
                  context: { ...base, selection: { startLine: 12, endLine: 30, text: 'function drawChart(canvas, points) {\n  const dpr = window.devicePixelRatio || 1;\n  // …\n}' } },
                }),
              1800 * SPEED,
            );
        }
        // ?addatt: the "Add to AntiGem Chat" command pushes chips (a file, a folder, a selection)
        if (params.has('addatt'))
          setTimeout(
            () =>
              post({
                type: 'addAttachments',
                attachments: [
                  { id: id('add'), name: 'client.js', path: '/home/dev/projects/nebula-weather/src/api/client.js', isImage: false, isAudio: false, size: 3_480, reference: true, kind: 'file' },
                  { id: id('add'), name: 'chart', path: '/home/dev/projects/nebula-weather/src/chart', isImage: false, isAudio: false, size: 0, reference: true, kind: 'folder' },
                  { id: id('add'), name: 'style.css:40-58', path: '/home/dev/projects/nebula-weather/style.css', isImage: false, isAudio: false, size: 610, reference: true, kind: 'selection', lineStart: 40, lineEnd: 58, selectionText: '.card { … }', languageId: 'css' },
                  { id: id('add'), name: 'dashboard_screenshot.png', path: '/home/dev/projects/nebula-weather/dashboard_screenshot.png', isImage: true, isAudio: false, size: 182_000, reference: true, kind: 'image' },
                ],
              }),
            2500 * SPEED,
          );
        // shared view prefs arrive a moment later (the view starts on its defaults)
        setTimeout(mockSettings.sendPrefs, 300 * SPEED);
        setTimeout(sendConversations, 700 * SPEED);
        for (const s of Object.values(models)) post({ type: 'models', state: s });
        if (params.has('empty')) open(null, 'CLAUDE');
        else {
          open(MAIN);
          void scenario();
        }
        // OpenCode finishes starting
        setTimeout(() => {
          const oc = agents.find((a) => a.kind === 'OPENCODE')!;
          oc.state = 'online';
          oc.label = 'Ready';
          oc.detail = 'OpenCode 1.0.3 · running';
          post({ type: 'agents', agents: agents.map((a) => ({ ...a })) });
        }, 9000);
        break;
      }
      case 'openConversation':
        open(m.id, m.agent);
        break;
      case 'send': {
        const c = chatOf(m.conversationId);
        if (m.isNew && !conversations.some((x) => x.id === m.conversationId)) {
          const title = m.text.split('\n')[0].slice(0, 48) || 'New Chat';
          conversations = [conv({ id: m.conversationId, title, agent: m.agent, updatedAt: Date.now(), createdAt: Date.now(), workspaceUri: m.workspaceUri ?? '' }), ...conversations];
          sendConversations();
          current = m.conversationId;
          void reply(m.conversationId, m.text, m.attachments, true);
          break;
        }
        if (c.isStreaming) {
          c.queued = [...c.queued, { id: id('q'), text: m.text, attachmentCount: m.attachments.length, canSendNow: true, canDelete: true, isPending: false }];
          patch(m.conversationId, { queued: c.queued });
        } else void reply(m.conversationId, m.text, m.attachments);
        break;
      }
      case 'stop': {
        stopped = true;
        waitApproval?.({ allow: false });
        waitAnswer?.({}, undefined);
        const c = chatOf(m.conversationId);
        const last = c.messages[c.messages.length - 1];
        if (last?.isStreaming) void finish(m.conversationId, last);
        else {
          c.isStreaming = false;
          patch(m.conversationId, { isStreaming: false });
        }
        break;
      }
      case 'approval':
        waitApproval?.({ allow: !m.deny });
        break;
      case 'answer':
        waitAnswer?.(m.skip ? {} : m.answers, m.custom);
        break;
      case 'queueAction': {
        const c = chatOf(m.conversationId);
        if (m.action === 'delete') c.queued = c.queued.filter((q) => q.id !== m.id);
        else c.queued = c.queued.map((q) => (q.id === m.id ? { ...q, isPending: true, canSendNow: false } : q));
        patch(m.conversationId, { queued: c.queued });
        break;
      }
      case 'requestModels': {
        const s = models[m.agent];
        if (!s) break;
        post({ type: 'models', state: { ...s, refreshing: true } });
        setTimeout(() => post({ type: 'models', state: { ...s, refreshing: false } }), 900);
        break;
      }
      case 'requestCommands':
        post({ type: 'commands', agent: m.agent, commands: m.agent === 'CLAUDE' || m.agent === 'CODEX' ? COMMANDS : COMMANDS.filter((c) => c.kind !== 'command') });
        break;
      case 'selectModel': {
        const s = models[m.agent];
        if (s) {
          s.selectedId = m.modelId;
          post({ type: 'models', state: s });
        }
        break;
      }
      case 'conversationAction': {
        const target = conversations.find((c) => c.id === m.id);
        if (!target) break;
        if (m.action === 'delete') {
          conversations = conversations.filter((c) => c.id !== m.id && c.parentConversationId !== m.id);
          sendConversations();
        } else if (m.action === 'archive' || m.action === 'unarchive') touch(m.id, { archived: m.action === 'archive' });
        else if (m.action === 'rename' && m.value) touch(m.id, { title: m.value });
        else if (m.action === 'fork') {
          const fid = id('fork');
          conversations = [{ ...target, id: fid, title: `${target.title} (fork)`, updatedAt: Date.now(), parentConversationId: null, isRunning: false }, ...conversations];
          chats.set(fid, { ...chatOf(m.id), queued: [], isStreaming: false });
          sendConversations();
          post({ type: 'toast', level: 'info', message: 'Conversation forked' });
        } else if (m.action === 'openInEditor') post({ type: 'toast', level: 'info', message: 'Would open the chat in an editor tab' });
        break;
      }
      case 'openFile':
        post({ type: 'toast', level: 'info', message: `Open ${m.path}${m.line ? `:${m.line}` : ''}` });
        break;
      case 'openUrl':
        post({ type: 'toast', level: 'info', message: `Open ${m.url}` });
        break;
      case 'copy':
        navigator.clipboard?.writeText(m.text).catch(() => {});
        break;
      case 'pickAttachments':
        setTimeout(
          () =>
            post({
              type: 'attachments',
              reqId: m.reqId,
              attachments: [{ id: id('att'), name: 'forecast-sample.json', path: '/home/dev/projects/nebula-weather/data/forecast-sample.json', isImage: false, isAudio: false, size: 8_412, mimeType: 'application/json', reference: true }],
            }),
          300,
        );
        break;
      case 'searchFiles': {
        const q = m.query.toLowerCase();
        // open editors first, then files, then folders (like the host)
        const hits = [...FILES, ...FOLDERS].filter((f) => !q || f.relativePath.toLowerCase().includes(q));
        hits.sort((a, b) => Number(!!(b as { isOpen?: boolean }).isOpen) - Number(!!(a as { isOpen?: boolean }).isOpen));
        post({ type: 'fileSearchResult', reqId: m.reqId, files: hits.slice(0, 12) });
        break;
      }
      case 'retry':
        post({ type: 'toast', level: 'info', message: 'Regenerating…' });
        break;
      case 'rewind': {
        const c = chatOf(m.conversationId);
        const i = c.messages.findIndex((x) => x.id === m.messageId);
        if (i >= 0) {
          const prompt = c.messages[i].content;
          c.messages = c.messages.slice(0, i);
          patch(m.conversationId, { order: c.messages.map((x) => x.id) });
          post({ type: 'insertText', text: prompt });
          if (m.restoreFiles) post({ type: 'toast', level: 'info', message: 'Restored the files changed after this message' });
        }
        break;
      }
      case 'requestProjects': {
        const byWs = new Map<string, number>();
        for (const c of conversations) if (c.workspaceUri) byWs.set(c.workspaceUri, (byWs.get(c.workspaceUri) ?? 0) + 1);
        const proj = (uri: string, source: 'workspace' | 'saved' | 'recent', lastUsed?: number) => {
          const path = uri.replace(/^file:\/\//, '');
          return { name: path.substring(path.lastIndexOf('/') + 1), uri, path, source, lastUsed: lastUsed ?? null, chats: byWs.get(uri) ?? 0 };
        };
        setTimeout(
          () =>
            post({
              type: 'projects',
              reqId: m.reqId,
              projects: [
                proj(WS.weather, 'workspace', now - 2 * MIN),
                proj(WS.antigem, 'workspace', now - 8 * MIN),
                ...savedProjects.map((u) => proj(u, 'saved', now - 3 * DAY)),
                proj(WS.dots, 'recent', now - DAY),
              ],
            }),
          250,
        );
        break;
      }
      case 'pickFolder':
        setTimeout(() => {
          const uri = 'file:///home/dev/projects/rust-ray-tracer';
          if (!savedProjects.includes(uri)) savedProjects.push(uri);
          post({ type: 'folderPicked', reqId: m.reqId, project: { name: 'rust-ray-tracer', uri, path: '/home/dev/projects/rust-ray-tracer', source: 'saved', chats: 0 } });
        }, 400);
        break;
      case 'setControl': {
        const key = m.conversationId ?? `new:${m.agent}`;
        const ctl = ctlOf(key, m.agent);
        if (m.value === 'details') {
          post({ type: 'toast', level: 'info', message: m.id === 'cache' ? 'Prompt cache warm: about 61 min left (1-hour cache).' : 'Context: 68k of 200k tokens used (34%). Send /compact to free space.' });
          break;
        }
        if (m.value === 'run') {
          ctl.plan = 'off';
          post({ type: 'toast', level: 'info', message: 'Implementing the plan…' });
        } else ctl[m.id] = m.value;
        setTimeout(() => post({ type: 'chat', conversationId: m.conversationId, patch: { controls: controlsOf(m.conversationId, m.agent) } }), 120 * SPEED);
        break;
      }
      case 'readImage': {
        // any image path: a generated picture named after the file
        const name = m.path.substring(m.path.lastIndexOf('/') + 1);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#0ea5e9"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="520" cy="90" r="46" fill="#fde68a"/><text x="40" y="320" font-family="sans-serif" font-size="28" fill="#fff">${name}</text></svg>`;
        setTimeout(() => post({ type: 'imageData', reqId: m.reqId, dataUrl: /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(name) ? `data:image/svg+xml;base64,${btoa(svg)}` : null }), 350);
        break;
      }
      case 'resolveDrop':
        setTimeout(
          () =>
            post({
              type: 'attachments',
              reqId: m.reqId,
              attachments: m.uris.map((u) => {
                const path = decodeURI(u.replace(/^file:\/\//, '')).replace(/\/+$/, '');
                const name = path.substring(path.lastIndexOf('/') + 1);
                const folder = !/\.[a-z0-9]+$/i.test(name);
                const image = /\.(png|jpe?g|webp|gif)$/i.test(name);
                return { id: id('drop'), name, path, isImage: image, isAudio: false, size: folder ? 0 : 2048, reference: true, kind: folder ? 'folder' : image ? 'image' : 'file' } as ChatAttachment;
              }),
            }),
          200,
        );
        break;
      case 'searchChats': {
        const q = m.query.toLowerCase();
        const results = conversations
          .map((c) => {
            const hit = historyFor(c.id).find((x) => x.content.toLowerCase().includes(q));
            if (!hit) return null;
            const i = hit.content.toLowerCase().indexOf(q);
            const snippet = (i > 40 ? '…' : '') + hit.content.substring(Math.max(0, i - 40), i + q.length + 80).replace(/\s+/g, ' ').replace(/<!--[^>]*-->/g, '') + '…';
            return { conversationId: c.id, agent: c.agent, title: c.title, snippet, updatedAt: c.updatedAt };
          })
          .filter((x): x is NonNullable<typeof x> => !!x);
        setTimeout(() => post({ type: 'chatSearchResult', reqId: m.reqId, results }), 250);
        break;
      }
      case 'saveFile':
        console.info('[mock] saveFile', m.suggestedName, `${m.content.length} chars`);
        post({ type: 'toast', level: 'info', message: `Save dialog: ${m.suggestedName} (${Math.round(m.content.length / 1024)} KB)` });
        break;
      case 'saveArtifact':
        post({ type: 'toast', level: 'info', message: `Save a copy of ${m.path.substring(m.path.lastIndexOf('/') + 1)}…` });
        break;
      case 'runInTerminal':
        post({ type: 'toast', level: 'info', message: `Terminal (${m.cwd ?? '~'}): ${m.command.split('\n')[0]}` });
        break;
      case 'openText':
        post({ type: 'toast', level: 'info', message: `Opened "${m.title}" in an editor tab` });
        break;
      case 'revealRange':
        post({ type: 'toast', level: 'info', message: `Reveal ${m.path.substring(m.path.lastIndexOf('/') + 1)}:${m.startLine}-${m.endLine}` });
        break;
      case 'toolAction': {
        const c = chatOf(m.conversationId);
        for (const msg of c.messages)
          for (const t of msg.toolCalls)
            if (t.id === m.toolId && t.status === 'RUNNING') {
              t.status = 'TERMINATED';
              t.output += '\n^C';
              upsert(m.conversationId, msg);
            }
        break;
      }
      case 'setQuotaGroup': {
        const ms = models[m.agent];
        if (ms) {
          const target = ms.models.find((x) => x.id === m.modelId);
          const base = target?.baseName;
          for (const x of ms.models) if (x.id === m.modelId || (base && x.baseName === base)) x.group = m.group ?? x.group;
          post({ type: 'models', state: JSON.parse(JSON.stringify(ms)) });
          post({ type: 'toast', level: 'info', message: m.group ? `Moved to ${m.group}` : 'Back to its automatic group' });
        }
        break;
      }
      case 'forgetProject':
        savedProjects = savedProjects.filter((u) => u.replace(/^file:\/\//, '') !== m.path);
        break;
      case 'retryConnections': {
        const down = agents.filter((a) => a.state === 'offline' || a.state === 'error');
        if (!down.length) {
          post({ type: 'toast', level: 'info', message: 'Reconnecting agents…' });
          break;
        }
        // starting for a moment, then back online
        setTimeout(() => {
          for (const a of down) Object.assign(a, { state: 'starting', label: 'Connecting…', detail: 'Connecting…' });
          post({ type: 'agents', agents: agents.map((a) => ({ ...a })) });
        }, 300 * SPEED);
        setTimeout(() => {
          for (const a of down) Object.assign(a, { state: 'online', label: 'Ready', detail: 'dev@example.com' });
          post({ type: 'agents', agents: agents.map((a) => ({ ...a })) });
        }, 2600 * SPEED);
        break;
      }
    }
  };
}

// ------------------------------------------------------------------------------------------------ static histories

function historyFor(cid: string): ChatMessage[] {
  if (cid === SHOWCASE) return showcaseHistory(cid);
  if (cid === MAIN) {
    const t0 = now - DAY - 2 * HOUR;
    return [
      {
        id: 'h-u1',
        conversationId: cid,
        role: 'USER',
        content: 'What would be a nice layout for a weather dashboard on a phone and on a desktop?',
        toolCalls: [],
        isStreaming: false,
        attachments: [],
        createdAt: t0,
      },
      {
        id: 'h-a1',
        conversationId: cid,
        role: 'ASSISTANT',
        content:
          '### Two layouts, one grid\n\nOn a **phone**, stack the cards: current weather first, then the hourly chart, then the 7-day row as a horizontal scroller.\n\nOn a **desktop**, use a 2-column grid:\n\n- the current card spans the left column\n- the hourly chart and the forecast stack on the right\n\n> Keep the temperature in `font-variant-numeric: tabular-nums` so it does not jump while it updates.',
        thoughtText: 'They want layout advice, not code yet. Mobile-first stacking plus a two-column desktop grid is the usual answer.',
        thoughtDurationMs: 3200,
        toolCalls: [],
        isStreaming: false,
        attachments: [],
        createdAt: t0 + 40_000,
        modelId: 'opus',
        tokenUsage: { promptTokens: 2_100, outputTokens: 310, cachedTokens: 0, cacheCreationTokens: 0, totalTokens: 2_410, durationMs: 6_800, isEstimated: false, model: 'claude-opus-5-5' },
      },
    ];
  }
  const c = buildConversations().find((x) => x.id === cid);
  if (!c) return []; // a chat created in this session starts empty
  const title = c.title;
  return [
    { id: `${cid}-u`, conversationId: cid, role: 'USER', content: title, toolCalls: [], isStreaming: false, attachments: [], createdAt: (c?.updatedAt ?? now) - 5 * MIN },
    {
      id: `${cid}-a`,
      conversationId: cid,
      role: 'ASSISTANT',
      content: `Here is what I did for **${title.toLowerCase()}**:\n\n1. Read the relevant files\n2. Made the change\n3. Ran the checks\n\n<!-- tool_call:${cid}-t1 -->\n\nEverything passes. See \`README.md\` for the details.`,
      toolCalls: [{ id: `${cid}-t1`, name: 'Bash', toolType: 'BASH', command: 'make test', status: 'SUCCESS', output: 'ok  \tall tests passed (0.84s)', exitCode: 0, durationMs: 1840 }],
      isStreaming: false,
      attachments: [],
      createdAt: (c?.updatedAt ?? now) - 4 * MIN,
      tokenUsage: { promptTokens: 9_400, outputTokens: 820, cachedTokens: 12_000, cacheCreationTokens: 0, totalTokens: 22_220, durationMs: 21_000, isEstimated: c?.agent === 'OPENCODE', model: c?.agent === 'CODEX' ? 'gpt-5-codex' : c?.agent === 'AGY' ? 'gemini-3-pro' : 'claude-sonnet-5-5' },
    },
  ];
}

// ------------------------------------------------------------------------------------------------ the VS Code tour chat

/** A chat that shows every newer feature: selection / image / folder chips, a context checkpoint, mermaid, media, a
 *  chat link, an error with a fix, HTML preview, a shell block to run, tool cards (image file, long output, running). */
function showcaseHistory(cid: string): ChatMessage[] {
  const t0 = now - 40 * MIN;
  const sel: ChatAttachment = { id: 'sc-sel', name: 'app.js:12-30', path: '/home/dev/projects/nebula-weather/app.js', isImage: false, isAudio: false, size: 640, reference: true, kind: 'selection', lineStart: 12, lineEnd: 30, selectionText: 'function drawChart…', languageId: 'javascript' };
  const img: ChatAttachment = { id: 'sc-img', name: 'dashboard_screenshot.png', path: '/home/dev/projects/nebula-weather/dashboard_screenshot.png', isImage: true, isAudio: false, size: 182_000, reference: true, kind: 'image' };
  const folder: ChatAttachment = { id: 'sc-dir', name: 'chart', path: '/home/dev/projects/nebula-weather/src/chart', isImage: false, isAudio: false, size: 0, reference: true, kind: 'folder' };
  const fence = '```';
  return [
    { id: `${cid}-u1`, conversationId: cid, role: 'USER', content: '/deploy staging, then explain how drawChart scales on high-DPI screens', toolCalls: [], isStreaming: false, attachments: [sel, img, folder], createdAt: t0 },
    {
      id: `${cid}-a1`,
      conversationId: cid,
      role: 'ASSISTANT',
      content: [
        '`drawChart` multiplies the canvas size by `devicePixelRatio`, then scales the context back, so one CSS pixel maps to `dpr` device pixels:',
        '',
        `${fence}mermaid`,
        'flowchart LR',
        '  A[CSS size] -->|x dpr| B[Canvas buffer]',
        '  B --> C{ctx.scale dpr}',
        '  C --> D[Sharp lines]',
        fence,
        '',
        '![Dashboard at 2x](file:///home/dev/projects/nebula-weather/dashboard_screenshot.png)',
        '',
        'A good intro:',
        '',
        '![Canvas on retina screens](https://www.youtube.com/watch?v=dQw4w9WgXcQ)',
        '',
        '[Screen recording of the chart](file:///home/dev/projects/nebula-weather/chart-demo.mp4)',
        '',
        'The first version of the chart is in conversation://conv-weather-dashboard (the build chat).',
        '',
        'The preview of the card markup:',
        '',
        `${fence}html`,
        '<div style="font-family:system-ui;padding:16px;border-radius:16px;background:linear-gradient(135deg,#4f46e5,#14b8a6);color:#fff;width:220px">',
        '  <div style="font-size:13px;opacity:.8">Reykjavík</div>',
        '  <div style="font-size:42px;font-weight:700">18°</div>',
        '  <div style="font-size:13px">Partly cloudy · updated 2 min ago</div>',
        '</div>',
        fence,
        '',
        'Run the tests yourself:',
        '',
        `${fence}bash`,
        '$ npm test -- --watch=false',
        fence,
        '',
        `<!-- tool_call:${cid}-t-img -->`,
        `<!-- tool_call:${cid}-t-long -->`,
        `<!-- tool_call:${cid}-t-run -->`,
        '',
        '<!-- error -->{"title":"OpenCode provider rejected the key","userMessage":"The Anthropic key in OpenCode is invalid or expired.","shortError":"401 Unauthorized","errorCode":401,"action":"opencode_providers"}<!-- /error -->',
      ].join('\n'),
      toolCalls: [
        { id: `${cid}-t-img`, name: 'generate_image', toolType: 'GENERATE_IMAGE', command: 'hourly chart preview', status: 'SUCCESS', output: '/home/dev/projects/nebula-weather/chart_preview.png', exitCode: 0, durationMs: 4200 },
        { id: `${cid}-t-long`, name: 'Bash', toolType: 'BASH', command: 'npm test -- --verbose', status: 'SUCCESS', output: Array.from({ length: 60 }, (_, i) => `  ✓ chart › point ${i + 1} maps to the right pixel (${(i % 7) + 1} ms)`).join('\n'), exitCode: 0, durationMs: 5100 },
        { id: `${cid}-t-run`, name: 'Bash', toolType: 'BASH', command: 'npx serve . --listen 4321', status: 'RUNNING', output: 'Serving! http://localhost:4321', exitCode: null, durationMs: 0 },
      ],
      isStreaming: false,
      attachments: [],
      createdAt: t0 + 60_000,
      tokenUsage: { promptTokens: 18_400, outputTokens: 1_120, cachedTokens: 42_000, cacheCreationTokens: 3_200, totalTokens: 64_720, durationMs: 33_000, isEstimated: false, model: 'anthropic/claude-opus-5-5', costUsd: 0.0912 },
      modelId: 'opus',
    },
    { id: `${cid}-u2`, conversationId: cid, role: 'USER', content: 'Thanks! Now make the forecast cards a bit smaller.', toolCalls: [], isStreaming: false, attachments: [], createdAt: t0 + 5 * MIN, contextSummary: 'The user is building a weather dashboard (index.html, style.css, app.js). Done: glass cards, aurora background, hourly canvas chart with high-DPI scaling. Next: smaller forecast cards.' },
    { id: `${cid}-a2`, conversationId: cid, role: 'ASSISTANT', content: 'Done: the forecast cards are now `min-width: 72px` with `gap: 8px`, so all seven fit on a phone.', toolCalls: [], isStreaming: false, attachments: [], createdAt: t0 + 6 * MIN },
  ];
}
