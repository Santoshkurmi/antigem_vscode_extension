// Dev only: the mock host's settings pages (every SettingItem kind, sub-pages, an agent section, lists with add /
// edit forms, a read-only install log) and the shared view prefs (UiPrefs).
import type { HostToView, SettingFormField, SettingItem, SettingsPage, UiPrefs, ViewToHost } from '@shared/protocol';
import type { AgentKind } from '@shared/model';

type Post = (m: HostToView) => void;

const mcpForm = (v: { name?: string; transport?: string; target?: string; env?: string } = {}): SettingFormField[] => [
  { id: 'name', label: 'Name', kind: 'text', placeholder: 'github', value: v.name ?? '', required: true },
  {
    id: 'transport',
    label: 'Transport',
    kind: 'select',
    value: v.transport ?? 'stdio',
    options: [
      { value: 'stdio', label: 'stdio' },
      { value: 'http', label: 'http' },
      { value: 'sse', label: 'sse' },
    ],
  },
  { id: 'target', label: 'Command or URL', kind: 'text', placeholder: 'npx -y @modelcontextprotocol/server-github', value: v.target ?? '', required: true },
  { id: 'env', label: 'Environment (KEY=value per line)', kind: 'multiline', value: v.env ?? '' },
  { id: 'token', label: 'API token', kind: 'password', placeholder: 'optional' },
  { id: 'enabled', label: 'Enable right away', kind: 'toggle', value: 'true' },
];

function buildPages(enabled: AgentKind[] = ['AGY', 'CLAUDE', 'CODEX', 'OPENCODE']): Record<string, SettingsPage> {
  return {
    // the host's root: section titles are empty (every section is its own card, no labels between them)
    root: {
      id: 'root',
      title: 'Settings',
      sections: [
        { id: 'agents', title: '', items: [{ kind: 'page', id: 'agents', label: 'Agents', icon: 'smart_toy', description: `${enabled.length} on` }] },
        {
          id: 'chat',
          title: '',
          items: [
            { kind: 'page', id: 'slash', label: 'Slash commands', icon: 'code', description: 'Your own /commands for every agent', badge: '2' },
            { kind: 'page', id: 'context', label: 'Global context', icon: 'description', description: 'Instructions added to your chats', badge: '1' },
          ],
        },
        { id: 'system', title: '', items: [{ kind: 'page', id: 'connection', label: 'Bridge & connection', icon: 'lan', description: '127.0.0.1:1244' }] },
      ],
    },
    agents: {
      id: 'agents',
      title: 'Agents',
      sections: [
        {
          id: 'enabled',
          title: '',
          items: [
            {
              kind: 'checklist',
              id: 'agents.enabled',
              label: 'Enabled agents',
              description: 'Agents you turn off do not run at all: their settings and chats are hidden (chats stay on disk).',
              values: [...enabled],
              options: [
                { value: 'AGY', label: 'Antigravity', description: "Google's agent: Gemini, Claude and GPT models" },
                { value: 'CLAUDE', label: 'Claude Code', description: "Anthropic's coding agent (your Claude plan or API key)" },
                { value: 'CODEX', label: 'Codex', description: "OpenAI's coding agent (ChatGPT plan or API key)" },
                { value: 'OPENCODE', label: 'OpenCode', description: 'Open source agent, any provider' },
              ],
            },
          ],
        },
        {
          id: 'pages',
          title: '',
          items: enabled.map((a) =>
            a === 'AGY'
              ? { kind: 'page' as const, id: 'agy', label: 'Antigravity', icon: 'rocket_launch', description: 'agy 1.5.2' }
              : a === 'CLAUDE'
                ? { kind: 'page' as const, id: 'claude', label: 'Claude Code', icon: 'auto_awesome', description: 'Max · 2.4.1' }
                : a === 'CODEX'
                  ? { kind: 'page' as const, id: 'codex', label: 'Codex', icon: 'terminal', description: 'Plus · 0.48' }
                  : { kind: 'page' as const, id: 'opencode', label: 'OpenCode', icon: 'code', description: '1.0.3' },
          ),
        },
      ],
    },
    agy: {
      id: 'agy',
      title: 'Antigravity',
      sections: [
        {
          id: 'account',
          title: '',
          agent: 'AGY',
          items: [
            { kind: 'info', id: 'agy.hub', label: 'Hub', value: 'Online', tone: 'ok' },
            { kind: 'info', id: 'agy.account', label: 'Account', value: 'dev@example.com', tone: 'ok', description: 'Google AI Pro' },
            { kind: 'button', id: 'agy.signout', label: 'Sign out', style: 'danger', confirm: 'Sign out of Antigravity? Running chats stop and you need to sign in again to use it.' },
            { kind: 'button', id: 'agy.plan', label: 'Manage plan' },
          ],
        },
        {
          id: 'usage',
          title: '',
          agent: 'AGY',
          items: [
            {
              kind: 'quota',
              id: 'agy.quota',
              label: 'Usage limits',
              groups: [
                { name: 'Gemini', windows: [{ label: '5h', remaining: 0.42, resetText: 'in 3h 5m' }, { label: 'Weekly', remaining: 0.81, resetText: 'Tue 09:00' }] },
                { name: 'Claude & GPT', windows: [{ label: '5h', remaining: 0.06, resetText: 'in 58m' }] },
              ],
            },
          ],
        },
        {
          id: 'links',
          title: '',
          agent: 'AGY',
          items: [
            { kind: 'page', id: 'agy.permissions', label: 'Commands & permissions', icon: 'security', description: 'Auto-run, file access, permission rules' },
            { kind: 'page', id: 'agy.mcp', label: 'MCP servers', icon: 'hub', badge: '2 active' },
            { kind: 'page', id: 'agy.skills', label: 'Skills & plugins', icon: 'auto_awesome', badge: '12 skills' },
            { kind: 'page', id: 'agy.cli', label: 'Antigravity CLI', icon: 'terminal', badge: '1.5.2' },
          ],
        },
      ],
    },
    connection: {
      id: 'connection',
      title: 'Bridge & connection',
      sections: [
        {
          id: 'connection',
          title: '',
          items: [
            { kind: 'info', id: 'bridge', label: 'Bridge', value: 'Running · 127.0.0.1:1244', tone: 'ok' },
            { kind: 'info', id: 'hub', label: 'Antigravity hub', value: 'Starting…', tone: 'warn' },
            { kind: 'button', id: 'restart', label: 'Restart bridge', confirm: 'Running chats are stopped while the bridge restarts.' },
            { kind: 'button', id: 'logs', label: 'Show logs' },
          ],
        },
      ],
    },
    'agy.mcp': {
      id: 'agy.mcp',
      title: 'MCP servers',
      sections: [
        {
          id: 'servers',
          title: 'Tools Antigravity can call',
          agent: 'AGY',
          description: 'Servers in ~/.gemini/antigravity/mcp_config.json',
          items: [
            {
              kind: 'list',
              id: 'mcp',
              label: 'Configured servers',
              emptyText: 'No MCP servers yet. Add one to give the agent more tools.',
              addLabel: 'Add MCP server',
              addForm: mcpForm(),
              rows: [
                {
                  id: 'browser',
                  title: 'browser_mcp',
                  subtitle: 'http://127.0.0.1:1244/browser · 14 tools',
                  status: 'Connected',
                  statusTone: 'ok',
                  toggle: true,
                  actions: [
                    { id: 'edit', label: 'Edit', form: mcpForm({ name: 'browser_mcp', transport: 'http', target: 'http://127.0.0.1:1244/browser' }) },
                    { id: 'tools', label: 'List tools' },
                    { id: 'remove', label: 'Remove', danger: true, confirm: 'Remove browser_mcp? Its tools are no longer available to the agent.' },
                  ],
                },
                {
                  id: 'github',
                  title: 'github',
                  subtitle: 'npx -y @modelcontextprotocol/server-github',
                  status: 'Needs sign-in',
                  statusTone: 'warn',
                  toggle: true,
                  actions: [
                    { id: 'edit', label: 'Edit', form: mcpForm({ name: 'github', transport: 'stdio', target: 'npx -y @modelcontextprotocol/server-github', env: 'GITHUB_TOKEN=' }) },
                    { id: 'remove', label: 'Remove', danger: true, confirm: 'Remove github?' },
                  ],
                },
                { id: 'fs', title: 'filesystem', subtitle: 'stdio · /home/dev', status: 'Disabled', statusTone: 'muted', toggle: false, actions: [{ id: 'remove', label: 'Remove', danger: true, confirm: 'Remove filesystem?' }] },
              ],
            },
          ],
        },
      ],
    },
    'agy.permissions': {
      id: 'agy.permissions',
      title: 'Commands & permissions',
      sections: [
        {
          id: 'policy',
          title: 'Terminal commands',
          agent: 'AGY',
          items: [
            {
              kind: 'select',
              id: 'policy',
              label: 'Auto-execution',
              value: 'ask',
              options: [
                { value: 'ask', label: 'Ask first', description: 'Every command waits for your approval' },
                { value: 'auto', label: 'Smart safety', description: 'Safe read-only commands run, the rest ask' },
                { value: 'eager', label: 'Auto-run', description: 'Run everything without asking (sandboxes only)' },
              ],
            },
            { kind: 'toggle', id: 'web', label: 'Allow web access', description: 'Search and read pages without asking', value: true },
            {
              kind: 'list',
              id: 'allow',
              label: 'Always allowed',
              rows: [
                { id: 'git', title: 'git status', subtitle: 'exact command', actions: [{ id: 'remove', label: 'Remove', danger: true }] },
                { id: 'npm', title: 'npm test *', subtitle: 'prefix', actions: [{ id: 'remove', label: 'Remove', danger: true }] },
              ],
              addLabel: 'Add rule',
              addForm: [
                { id: 'pattern', label: 'Command or prefix', kind: 'text', placeholder: 'npm run *', required: true },
                {
                  id: 'decision',
                  label: 'Decision',
                  kind: 'select',
                  value: 'allow',
                  options: [
                    { value: 'allow', label: 'Allow' },
                    { value: 'deny', label: 'Deny' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    'agy.skills': {
      id: 'agy.skills',
      title: 'Skills & plugins',
      sections: [
        {
          id: 'skills',
          title: 'Skills',
          items: [
            {
              kind: 'list',
              id: 'skills',
              label: 'Installed skills',
              rows: [
                { id: 'pdf', title: 'pdf', subtitle: 'Read, fill and merge PDFs', toggle: true },
                { id: 'design', title: 'frontend-design', subtitle: 'Design guidance for polished UIs', toggle: true },
                { id: 'rea', title: 'rea', subtitle: 'Reverse engineering (proot Ubuntu)', status: 'Update', statusTone: 'warn', toggle: false },
              ],
            },
          ],
        },
      ],
    },
    'agy.cli': {
      id: 'agy.cli',
      title: 'Antigravity CLI',
      sections: [
        {
          id: 'cli',
          title: 'agy',
          agent: 'AGY',
          items: [
            { kind: 'info', id: 'ver', label: 'Version', value: '1.5.2', tone: 'ok' },
            { kind: 'text', id: 'path', label: 'Path', description: 'Empty = found on PATH', value: '~/.local/bin/agy', placeholder: 'auto-detect' },
            { kind: 'button', id: 'reinstall', label: 'Reinstall CLI', style: 'primary', confirm: 'Download and install the latest agy CLI?' },
            { kind: 'text', id: 'log', label: 'Install log', value: '$ curl -fsSL https://antigravity.google/install.sh | sh\n› downloading agy 1.5.2 (linux-x64)…\n› installed to ~/.local/bin/agy\n✓ done', multiline: true, disabled: true },
          ],
        },
      ],
    },
    claude: {
      id: 'claude',
      title: 'Claude Code',
      sections: [
        {
          id: 'account',
          title: '',
          agent: 'CLAUDE',
          items: [
            { kind: 'info', id: 'email', label: 'Signed in', value: 'dev@example.com · Max', tone: 'ok' },
            {
              kind: 'quota',
              id: 'limits',
              label: 'Plan limits',
              groups: [{ name: 'Plan limits', windows: [{ label: 'Current session (5h)', remaining: 0.09, resetText: 'in 2h 20m' }, { label: 'Weekly', remaining: 0.32, resetText: 'Tue 09:00' }] }],
            },
          ],
        },
        {
          id: 'defaults',
          title: '',
          agent: 'CLAUDE',
          description: 'Saved in ~/.claude/settings.json, shared with the terminal CLI.',
          items: [
            {
              kind: 'select',
              id: 'model',
              label: 'Default model',
              value: 'default',
              options: [
                { value: 'default', label: 'Default' },
                { value: 'opus', label: 'Opus 5.5' },
                { value: 'sonnet', label: 'Sonnet 5.5' },
                { value: 'haiku', label: 'Haiku 4.5' },
              ],
            },
            {
              kind: 'select',
              id: 'mode',
              label: 'Default permission mode',
              value: 'auto',
              options: [
                { value: 'default', label: 'Manual', description: 'Ask before edits and commands' },
                { value: 'acceptEdits', label: 'Accept edits', description: 'Apply file edits without asking' },
                { value: 'plan', label: 'Plan', description: 'Explore and propose a plan, no changes' },
                { value: 'auto', label: 'Auto', description: 'Claude decides what is safe to run' },
              ],
            },
            { kind: 'toggle', id: 'thinking', label: 'Thinking', description: 'Reason before answering', value: true },
            {
              kind: 'select',
              id: 'lang',
              label: 'Reply language',
              value: 'en',
              options: ['English', 'Español', 'Deutsch', 'Français', 'Italiano', 'Português', '日本語', '한국어', '中文', 'हिन्दी', 'Nepali'].map((l, i) => ({
                value: ['en', 'es', 'de', 'fr', 'it', 'pt', 'ja', 'ko', 'zh', 'hi', 'ne'][i],
                label: l,
              })),
            },
            { kind: 'text', id: 'dictation', label: 'Dictation language', description: 'Language code for voice input (e.g. en, es, de, ja)', value: 'en' },
          ],
        },
      ],
    },
    opencode: { id: 'opencode', title: 'OpenCode', sections: [{ id: 'oc', title: '', agent: 'OPENCODE', items: [{ kind: 'info', id: 'state', label: 'State', value: 'Running · opencode 1.0.3', tone: 'ok' }] }] },
    codex: { id: 'codex', title: 'Codex', sections: [{ id: 'cx', title: '', agent: 'CODEX', items: [{ kind: 'info', id: 'acct', label: 'ChatGPT', value: 'dev@example.com · Plus', tone: 'ok' }] }] },
    slash: {
      id: 'slash',
      title: 'Custom slash commands',
      sections: [
        {
          id: 'cmds',
          title: 'Your commands',
          description: 'Typed as /name: the text replaces it before the message is sent.',
          items: [
            {
              kind: 'list',
              id: 'commands',
              label: 'Commands',
              addLabel: 'New command',
              addForm: [
                { id: 'name', label: 'Name', kind: 'text', placeholder: 'deploy', required: true },
                { id: 'text', label: 'Prompt', kind: 'multiline', placeholder: 'Build and publish…', required: true },
              ],
              rows: [
                { id: 'deploy', title: '/deploy', subtitle: 'Build and publish to GitHub Pages', actions: [{ id: 'edit', label: 'Edit', form: [{ id: 'name', label: 'Name', kind: 'text', value: 'deploy', required: true }, { id: 'text', label: 'Prompt', kind: 'multiline', value: 'Build the site and publish it to GitHub Pages.' }] }, { id: 'delete', label: 'Delete', danger: true, confirm: 'Delete /deploy?' }] },
                { id: 'review', title: '/review-ui', subtitle: 'Review the UI for accessibility', actions: [{ id: 'delete', label: 'Delete', danger: true, confirm: 'Delete /review-ui?' }] },
              ],
            },
          ],
        },
      ],
    },
    context: {
      id: 'context',
      title: 'Global context',
      sections: [
        {
          id: 'ctx',
          title: 'Added to every chat',
          items: [{ kind: 'text', id: 'text', label: 'Instructions', multiline: true, value: 'Prefer small, focused diffs. Explain trade-offs briefly.', placeholder: 'Write instructions every agent should follow' }],
        },
      ],
    },
  };
}

const NEON: UiPrefs['customThemes'] = [
  {
    id: 'custom_neon_night',
    name: 'Neon Night',
    dark: true,
    about: 'Hot pink and cyan on near-black',
    base: 'midnight_aurora',
    colors: { background: '#07060d', surface: '#0c0a16', card: '#14111f', surface_variant: '#221a33', primary: '#ff4fd8', secondary: '#7c3aed', tertiary: '#22d3ee', info: '#22d3ee' },
  },
];

export function createMockSettings(post: Post) {
  const pages = buildPages();
  const open = new Set<string>();
  let prefs: UiPrefs = { theme: 'auto', lightTheme: 'antigem_light', darkTheme: 'midnight_aurora', chatFontScale: 1, groupByWorkspace: false, quotaPillWindow: '5h', customThemes: NEON };

  const sendPage = (id: string, delay = 120) => {
    const p = pages[id];
    if (!p) {
      setTimeout(() => post({ type: 'settings', page: { id, title: id, sections: [{ id: 'none', title: 'Not available', items: [{ kind: 'info', id: 'x', label: 'This page', value: 'is not in the mock', tone: 'muted' }] }] } }), delay);
      return;
    }
    setTimeout(() => post({ type: 'settings', page: JSON.parse(JSON.stringify(p)) }), delay);
  };
  const findItem = (pageId: string, id: string): SettingItem | undefined => {
    for (const s of pages[pageId]?.sections ?? []) for (const it of s.items) if (it.id === id) return it;
    return undefined;
  };
  const toast = (message: string, level: 'info' | 'warning' | 'error' = 'info') => post({ type: 'toast', level, message });

  return {
    sendPrefs: () => post({ type: 'uiPrefs', prefs }),
    handle(m: ViewToHost): boolean {
      switch (m.type) {
        case 'requestSettings':
          open.add(m.page);
          // the first time a page loads slowly (header spinner)
          sendPage(m.page, m.page === 'root' ? 500 : 350);
          return true;
        case 'closeSettings':
          open.clear();
          return true;
        case 'setUiPref':
          prefs = { ...prefs, [m.key]: m.value };
          setTimeout(() => post({ type: 'uiPrefs', prefs }), 40);
          return true;
        case 'settingChange': {
          const it = findItem(m.page, m.id);
          if (it?.kind === 'list' && m.rowId) {
            const row = it.rows.find((r) => r.id === m.rowId);
            if (row) {
              row.toggle = !!m.value;
              if (row.status === 'Disabled' || row.status === 'Connected') {
                row.status = m.value ? 'Connected' : 'Disabled';
                row.statusTone = m.value ? 'ok' : 'muted';
              }
            }
          } else if (it && (it.kind === 'toggle' || it.kind === 'select' || it.kind === 'text')) {
            (it as { value: unknown }).value = it.kind === 'toggle' ? !!m.value : String(m.value);
          } else if (it?.kind === 'checklist' && Array.isArray(m.value)) {
            it.values = m.value.map(String);
            if (m.id === 'agents.enabled') {
              // the agent page links follow the enabled agents
              const fresh = buildPages(it.values as AgentKind[]);
              pages.agents.sections[1] = fresh.agents.sections[1];
              pages.root.sections[0] = fresh.root.sections[0];
              sendPage('root', 150);
            }
          }
          sendPage(m.page, 150);
          return true;
        }
        case 'settingAction': {
          const it = findItem(m.page, m.id);
          if (it?.kind === 'list') {
            if (m.actionId === 'add' && m.values) {
              const name = m.values.name || m.values.pattern || 'new';
              it.rows.push({
                id: `row-${Date.now()}`,
                title: m.page === 'slash' ? `/${name}` : name,
                subtitle: m.values.target || m.values.text || m.values.decision || '',
                status: m.page === 'agy.mcp' ? 'Starting' : null,
                statusTone: 'warn',
                toggle: m.page === 'agy.mcp' ? m.values.enabled === 'true' : null,
                actions: [{ id: 'remove', label: 'Remove', danger: true, confirm: `Remove ${name}?` }],
              });
              toast(`Added ${name}`);
            } else if (m.actionId === 'remove' || m.actionId === 'delete') {
              it.rows = it.rows.filter((r) => r.id !== m.rowId);
              toast('Removed');
            } else if (m.actionId === 'edit' && m.values) {
              const row = it.rows.find((r) => r.id === m.rowId);
              if (row) {
                row.title = m.page === 'slash' ? `/${m.values.name}` : m.values.name || row.title;
                row.subtitle = m.values.target || m.values.text || row.subtitle;
              }
              toast('Saved');
            } else toast(`${m.actionId} · ${m.rowId}`);
            sendPage(m.page, 200);
          } else if (m.id === 'reinstall') {
            const log = findItem('agy.cli', 'log') as Extract<SettingItem, { kind: 'text' }>;
            pages['agy.cli'].loading = true;
            log.value = '$ curl -fsSL https://antigravity.google/install.sh | sh';
            sendPage('agy.cli', 50);
            const lines = ['› downloading agy 1.5.3 (linux-x64)…', '› 12.4 MB / 31.0 MB', '› 31.0 MB / 31.0 MB', '› verifying checksum', '› installed to ~/.local/bin/agy', '✓ done: agy 1.5.3'];
            lines.forEach((l, i) =>
              setTimeout(() => {
                log.value += `\n${l}`;
                if (i === lines.length - 1) {
                  pages['agy.cli'].loading = false;
                  (findItem('agy.cli', 'ver') as { value: string }).value = '1.5.3';
                  toast('Antigravity CLI 1.5.3 installed');
                }
                sendPage('agy.cli', 0);
              }, 500 * (i + 1)),
            );
          } else if (m.id === 'restart') {
            toast('Restarting the bridge…');
          } else if (m.id === 'logs') {
            toast('Would open the AntiGem output channel');
          } else if (m.id === 'agy.signout') {
            toast('Signed out of Antigravity', 'warning');
          } else toast(`Action ${m.id}`);
          return true;
        }
      }
      return false;
    },
  };
}
