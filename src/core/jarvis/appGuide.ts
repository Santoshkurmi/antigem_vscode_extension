// What Jarvis knows about using AntiGem in VS Code ("how do I add an MCP server", "where is the theme"), so it can guide
// the user (port of the app's JarvisAppGuide.kt, topics rewritten for the extension).

export interface GuideEntry {
  topic: string;
  keywords: string[];
  text: string;
}

const SETTINGS_PAGES = `
- Agents (jarvis_open_settings section=agents): which agents are on, where each CLI is.
- Antigravity (section=agy), Claude Code (section=claude), Codex (section=codex), OpenCode (section=opencode): each agent's
  account, models, permissions, MCP servers, plugins/skills and its CLI page (install, update, sign in).
- Slash commands (section=slash): your own /commands that expand into full prompts, for every agent.
- Global context (section=context): notes added to your chats (first message or every message; "Also tell Jarvis").
- Jarvis (section=jarvis): on/off, agent & model of Jarvis chats, personality, setup, manager & tasks, approvals, Jarvis chat.
- Bridge & connection (section=connection): the local bridge, the Antigravity hub, logs, restart.
`.trim();

const ENTRIES: GuideEntry[] = [
  {
    topic: 'overview',
    keywords: ['what is', 'antigem', 'extension', 'features', 'can you', 'overview'],
    text: `
AntiGem for VS Code puts four coding agents in one chat UI: Antigravity (agy, Google), Claude Code (Anthropic), Codex (OpenAI)
and OpenCode (any provider). Every chat runs on one agent; the bridge runs the agents for every VS Code window, so chats keep
working with no view open. It has a sidebar (the whole app) and chats in editor tabs, selection and file chips, @ mentions,
built-in MCP servers (notes, theme, Jarvis…), notes and to-dos, custom slash commands and global context. Settings: the gear in
the drawer, or ask Jarvis to open a page (jarvis_open_settings).
`.trim(),
  },
  { topic: 'settings', keywords: ['settings', 'where', 'find', 'page', 'menu', 'option', 'configure'], text: `Settings pages:\n${SETTINGS_PAGES}` },
  {
    topic: 'agents',
    keywords: ['agent', 'antigravity', 'claude', 'codex', 'opencode', 'turn on', 'enable', 'switch agent', 'new chat agent', 'cli path'],
    text: `
Settings → Agents turns each agent on or off (a turned-off agent does not run and its chats are hidden) and shows where each CLI
was found (you can set your own path; the bridge restarts to use it). The agent of a new chat is picked on the new-chat screen
and remembered (new_chat_agent setting). Each chat keeps its agent.
`.trim(),
  },
  {
    topic: 'claude',
    keywords: ['claude', 'sign in', 'login', 'install claude', 'provider', 'openrouter', 'kimi', 'deepseek', 'effort', 'thinking', 'permission mode', 'claude.md', 'memory'],
    text: `
Claude Code: Settings → Claude Code has the CLI (install, update, sign in), models and providers (any Anthropic-compatible API
such as OpenRouter, Kimi, DeepSeek), permission rules and the default mode, MCP servers, plugins, CLAUDE.md and settings.json.
In a chat the controls strip above the composer changes permission mode, effort and thinking (jarvis_set_permission_mode /
jarvis_set_effort / jarvis_set_thinking for the chat on screen), the model pill changes the model.
`.trim(),
  },
  {
    topic: 'antigravity',
    keywords: ['antigravity', 'agy', 'google', 'quota', 'gemini', 'sign in google', 'hub', 'history'],
    text: `
Antigravity: the extension talks to the agy hub (started by the bridge). Settings → Antigravity has the account, models with
live quota, Commands & Permissions (auto-run policy, sandbox, tool approvals), MCP servers, skills and plugins, and which chat
history (Antigravity IDE, the Antigravity app or the agy CLI) the sidebar shows.
`.trim(),
  },
  {
    topic: 'codex',
    keywords: ['codex', 'openai', 'chatgpt', 'gpt'],
    text: `
Codex is OpenAI's agent on the user's ChatGPT plan (or an API key). Settings → Codex: sign in, models and reasoning effort,
approval and sandbox modes, MCP servers (Codex's config.toml), skills. Its usage limits show in the model picker.
`.trim(),
  },
  {
    topic: 'opencode',
    keywords: ['opencode', 'provider', 'free model', 'nvidia', 'groq', 'openai-compatible'],
    text: `
OpenCode runs models of any provider (OpenAI-compatible APIs, NVIDIA, Groq, free models…). Settings → OpenCode: the server
(install, update, restart), providers and their keys, which models show in the picker, permissions and the agent of new
chats, MCP servers.
`.trim(),
  },
  {
    topic: 'mcp',
    keywords: ['mcp', 'server', 'tool', 'jarvis mcp', 'notes mcp', 'theme mcp', 'add mcp', 'preset'],
    text: `
MCP servers give the agents tools. Each agent has its own MCP page (Settings → <agent> → MCP servers) with one-tap presets
for the extension's built-in servers (Notes & To-dos, Theme, Jarvis, Plugin Developer…) and your own servers. The built-in
servers run in the extension on 127.0.0.1 (one port for all; the first VS Code window serves it). The Jarvis server must be
added to the agent of each Jarvis chat: Settings → Jarvis → Setup has an Add button per agent.
`.trim(),
  },
  {
    topic: 'editor',
    keywords: ['editor', 'selection', 'file', 'chip', 'mention', '@', 'drag', 'drop', 'terminal', 'tab', 'open in editor', 'shortcut', 'keybinding'],
    text: `
VS Code integration: a selection in the editor is offered as a chip in the composer (Ctrl+Alt+K / Cmd+Alt+K adds it, also from
the editor's right-click menu); type @ for files and folders; drag files from the explorer with Shift; paste images. Shell code
blocks run in an AntiGem terminal (▶); diffs and long outputs open in editor tabs; ⋮ → Open in editor tab puts a chat beside
your code. Ctrl+Alt+G focuses the chat. Jarvis opens files (jarvis_ide_open_file) and searches the project
(jarvis_ide_search_code).
`.trim(),
  },
  {
    topic: 'notes',
    keywords: ['note', 'notes', 'todo', 'to-do', 'list', 'reminder'],
    text: 'Notes and to-do lists are on the Notes screen (drawer → Notes; jarvis_open_screen screen=notes). Agents read and change them through the Notes MCP (add the Notes & To-dos preset on an agent\'s MCP page).',
  },
  {
    topic: 'appearance',
    keywords: ['theme', 'dark', 'light', 'font', 'size', 'appearance', 'look'],
    text: `
Settings → Appearance: the mode (Auto follows VS Code, Light, Dark), the light and the dark theme from the gallery, and the chat
text size. Jarvis switches them with jarvis_set_setting (theme_mode, chat_font_scale) when the user allowed app settings. New
themes are made by any chat with the Theme MCP (Theme preset on an agent's MCP page): "create a neon cyberpunk dark theme".
`.trim(),
  },
  {
    topic: 'slash',
    keywords: ['slash', 'command', '/', 'prompt', 'expand', 'arguments'],
    text: 'Settings → Slash commands: your own /name commands for every agent. The chat shows the command; the agent gets the instructions ($ARGUMENTS = the rest of the message).',
  },
  {
    topic: 'context',
    keywords: ['context', 'global', 'instructions', 'every message', 'first message'],
    text: 'Settings → Global context: notes added hidden to your chats, once at the start of a chat or with every message. An entry with "Also tell Jarvis" goes to Jarvis chats and the tasks they start too.',
  },
  {
    topic: 'connection',
    keywords: ['bridge', 'connection', 'offline', 'restart', 'port', 'logs', 'power'],
    text: `
The bridge (127.0.0.1:1244 by default) runs the agents and the Antigravity hub for every VS Code window. Settings → Bridge &
connection shows its ports and log, and restarts it. The drawer's ⏻ turns AntiGem off (the bridge and every agent stop);
Reconnect starts it again. jarvis_get_health says what is up.
`.trim(),
  },
  {
    topic: 'jarvis',
    keywords: ['jarvis', 'command center', 'manager', 'mission', 'team', 'autopilot', 'strip'],
    text: `
Jarvis (Settings → Jarvis): turn it on, then open the drawer's Jarvis tab → New Jarvis chat and type a big job. Jarvis writes a
mission (goal, done-when, steps), creates teams of agents, hands out tasks in parallel (each its own chat), checks what comes
back and keeps going; with autopilot it is nudged until the mission is done. The strip above the composer shows the mission,
the tasks and the switches; news from the tasks shows as cards in the chat. Settings → Jarvis: agent & model of new Jarvis
chats, personality, setup (add the Jarvis MCP server to each agent), manager & tasks, approvals, Jarvis chat options.
`.trim(),
  },
  {
    topic: 'tasks',
    keywords: ['task', 'background', 'monitor', 'running', 'progress', 'status', 'redirect'],
    text: `
Big jobs run as Jarvis tasks: each in its own chat that the extension watches. The Jarvis chat that started it hears when it
finishes, fails, gets stuck, needs an approval or asks a question, and can pass a new direction on (jarvis_task_reply). The
tasks are listed on the strip and the board of their Jarvis chat with open, stop and dismiss buttons.
`.trim(),
  },
  {
    topic: 'troubleshooting',
    keywords: ['not working', 'problem', 'error', 'broken', 'fix', 'cannot', "can't", 'offline', "doesn't"],
    text: `
Jarvis can't control the extension: the Jarvis MCP server is not added to that chat's agent (Settings → Jarvis → Setup → Add,
then send the next message). Tasks never start: the agent is off or not installed (Settings → Agents, the agent's CLI page).
Chats don't answer: jarvis_get_health shows the bridge and each agent; restart the bridge in Settings → Bridge & connection.
Several VS Code windows: only the first one serves the MCP port and runs Jarvis' loops.
`.trim(),
  },
];

export function topics(): string[] {
  return ENTRIES.map((e) => e.topic);
}

/** The entries that best match [query] (a topic name or words), best first. */
export function lookup(query: string, max = 3): GuideEntry[] {
  const q = query.toLowerCase().trim();
  const exact = ENTRIES.find((e) => e.topic === q);
  if (exact) return [exact];
  const words = new Set((q.match(/[a-z0-9.-]+/g) ?? []).filter((w) => w.length > 2));
  return ENTRIES.map((e) => {
    let score = 0;
    for (const k of e.keywords) {
      if (q.includes(k)) score += 3 + Math.floor(k.length / 4);
      else if (k.split(' ').some((w) => words.has(w))) score += 1;
    }
    if (words.has(e.topic)) score += 4;
    return { e, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.e);
}
