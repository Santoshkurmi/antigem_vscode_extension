// Settings → Jarvis (port of the app's JarvisSettingsScreen.kt minus voice, wake and look): the on/off switch, which
// chats the chat list shows, then a page per section: agent & model, personality & you, setup (jarvis_mcp per agent),
// manager & tasks, approvals, Jarvis chat. Host-owned pages 'jarvis' and 'jarvis.*' drawn by the view's settings UI.
import type { AgentKind } from '../../../shared/model';
import type { SettingItem, SettingListRow, SettingsPage, SettingsSection } from '../../../shared/protocol';
import { agentName } from './controller';
import type { JarvisEngine } from './engine';

const ALL: AgentKind[] = ['CLAUDE', 'AGY', 'OPENCODE', 'CODEX'];

const POLICY_LABEL: Record<string, string> = {
  ask_each: 'Decide each time',
  auto_readonly: 'Auto: read-only',
  auto_except_risky: 'Auto: except risky',
  auto_all: 'Auto: everything',
};

export class JarvisSettings {
  constructor(private j: JarvisEngine) {}

  rootItem(): SettingItem {
    const on = this.j.prefs.get('enabled');
    const a = this.j.prefs.agentKind();
    return {
      kind: 'page',
      id: 'jarvis',
      label: 'Jarvis',
      icon: 'smart_toy',
      description: 'A lead agent that plans big jobs and runs them with teams of agents',
      badge: on ? (a ? agentName(a) : 'On') : 'Off',
    };
  }

  async page(id: string): Promise<SettingsPage> {
    const p = this.j.prefs;
    const on = p.get('enabled');
    switch (id) {
      case 'jarvis': {
        const sections: SettingsSection[] = [
          {
            id: 'jarvis',
            title: 'Jarvis',
            items: [
              {
                kind: 'toggle',
                id: 'jarvis.enabled',
                label: 'Turn on Jarvis',
                description:
                  'A command center in the chat list: give a Jarvis chat a big job and it writes a plan, creates teams of agents, hands out tasks in parallel, ' +
                  'checks what comes back and keeps going. Off by default.',
                value: on,
              },
              {
                kind: 'info',
                id: 'jarvis.hint',
                label: 'How',
                value: on ? 'Jarvis tab in the chat list → New Jarvis chat' : 'Turn it on, then open the Jarvis tab in the chat list',
                tone: 'muted',
                description: 'A Jarvis chat is a normal chat of its agent with Jarvis\' tools (jarvis_mcp, see Setup), guide and command strip.',
              },
            ],
          },
        ];
        if (on) {
          sections.push({
            id: 'list',
            title: 'Jarvis chats in the chat list',
            items: [
              {
                kind: 'select',
                id: 'jarvis.listMode',
                label: 'Show Jarvis chats',
                value: p.get('listMode'),
                options: [
                  { value: 'none', label: 'Only under Jarvis', description: 'The work chats Jarvis starts for its tasks are normal chats and always show in All.' },
                  { value: 'text', label: 'My Jarvis chats in All too', description: 'The Jarvis chats you opened also show in All and the agent tabs.' },
                  { value: 'all', label: 'All Jarvis chats in All too', description: 'Every chat ever used as a Jarvis chat.' },
                ],
              },
            ],
          });
        }
        const a = p.agentKind();
        sections.push({
          id: 'pages',
          title: '',
          items: [
            { kind: 'page', id: 'jarvis.agent', label: 'Agent & model', icon: 'smart_toy', description: 'What new Jarvis chats run on', badge: a ? agentName(a) : 'Last used' },
            { kind: 'page', id: 'jarvis.personality', label: 'Personality & you', icon: 'face' },
            ...(on ? [{ kind: 'page' as const, id: 'jarvis.setup', label: 'Setup', icon: 'checklist', description: "Add Jarvis' tools (jarvis_mcp) to each agent" }] : []),
            { kind: 'page', id: 'jarvis.tasks', label: 'Manager & tasks', icon: 'task_alt' },
            { kind: 'page', id: 'jarvis.approvals', label: 'Approvals', icon: 'verified_user', badge: POLICY_LABEL[p.get('permissionPolicy')] ?? null },
            { kind: 'page', id: 'jarvis.chat', label: 'Jarvis chat', icon: 'chat_bubble_outline' },
          ],
        });
        return { id, title: 'Jarvis', sections };
      }
      case 'jarvis.agent': {
        const a = p.agentKind();
        const enabled = this.j.host.enabledKinds();
        const items: SettingItem[] = [
          {
            kind: 'select',
            id: 'jarvis.agent',
            label: 'Agent of new Jarvis chats',
            description: 'Any agent works: a Jarvis chat is a normal chat of it. You can still pick another agent on the new chat screen.',
            value: a ?? '',
            options: [
              { value: '', label: 'The one I used last', description: 'Else the agent new chats use' },
              ...ALL.map((k) => ({ value: k, label: agentName(k), description: enabled.includes(k) ? null : 'Turned off in Settings → Agents' })),
            ],
          },
        ];
        if (a && !enabled.includes(a)) items.push({ kind: 'info', id: 'jarvis.agent.off', label: 'Turned off', value: `${agentName(a)} is turned off in Settings → Agents: turn it on, or pick another agent here.`, tone: 'warn' });
        const models = a ? (this.j.host.backend(a)?.models().models ?? []) : [];
        items.push({
          kind: 'select',
          id: 'jarvis.model',
          label: 'Model',
          description: a ? 'Jarvis plans and checks; a strong model pays off. Big jobs run as tasks with their own models.' : 'Pick the agent first.',
          value: p.get('modelId'),
          disabled: !a,
          options: [{ value: '', label: 'Default model' }, ...models.map((m) => ({ value: m.id, label: m.displayName || m.id, description: m.group ?? null }))],
        });
        return { id, title: 'Agent & model', sections: [{ id: 'agent', title: '', items }] };
      }
      case 'jarvis.personality':
        return {
          id,
          title: 'Personality & you',
          sections: [
            {
              id: 'personality',
              title: '',
              items: [
                {
                  kind: 'select',
                  id: 'jarvis.persona',
                  label: 'Jarvis speaks as',
                  description: 'The grammatical gender Jarvis uses for itself. It matters in languages like Hindi (“main kar rahi hoon” / “main kar raha hoon”).',
                  value: p.get('persona'),
                  options: [
                    { value: '', label: 'Not set' },
                    { value: 'female', label: 'Female' },
                    { value: 'male', label: 'Male' },
                    { value: 'neutral', label: 'Neutral' },
                  ],
                },
                {
                  kind: 'text',
                  id: 'jarvis.aboutUser',
                  label: 'About you and extra instructions',
                  description:
                    'Sent with the first message of every new Jarvis chat. When you change it (or the persona), open Jarvis chats are told with your next message. ' +
                    "Jarvis' own memory note (Jarvis chat page) is separate: Jarvis edits that one itself.",
                  value: p.get('aboutUser'),
                  placeholder: 'e.g. Call me Santosh. Reply in Hinglish. I mostly work on the antigem project.',
                  multiline: true,
                  rows: 5,
                },
              ],
            },
          ],
        };
      case 'jarvis.setup':
        return this.setupPage();
      case 'jarvis.tasks':
        return {
          id,
          title: 'Manager & tasks',
          sections: [
            {
              id: 'tasks',
              title: '',
              description:
                'Give a Jarvis chat a big job: it starts tasks in their own chats and watches them. You can ask how one is going, redirect it, stop it; ' +
                'the strip above the composer and its board list them.',
              items: [
                {
                  kind: 'select',
                  id: 'jarvis.eventRouting',
                  label: 'When a task finishes, fails or gets stuck',
                  value: p.get('eventRouting'),
                  options: [
                    { value: 'model', label: 'Jarvis decides', description: 'The Jarvis chat reads the result, tells you the gist and follows up. A model turn per batch of news.' },
                    { value: 'speak', label: 'Just tell me', description: 'Only a notice, no model turn. Approvals and questions still go to the Jarvis chat.' },
                  ],
                },
                {
                  kind: 'select',
                  id: 'jarvis.taskApprovals',
                  label: 'Approvals inside tasks',
                  value: p.get('taskApprovals'),
                  options: [
                    { value: 'policy', label: 'Use my approval rules', description: 'Approved automatically as the Approvals page allows; the rest goes to the Jarvis chat.' },
                    { value: 'jarvis', label: 'Jarvis decides', description: "Jarvis approves what clearly serves the task's goal and asks you about anything risky or unclear." },
                  ],
                },
                {
                  kind: 'select',
                  id: 'jarvis.stallMinutes',
                  label: 'Report a task with no progress after',
                  value: String(p.get('stallMinutes')),
                  options: [
                    { value: '0', label: 'Never' },
                    { value: '5', label: '5 min' },
                    { value: '10', label: '10 min' },
                    { value: '20', label: '20 min' },
                    { value: '45', label: '45 min' },
                  ],
                },
              ],
            },
            {
              id: 'center',
              title: 'Command center',
              items: [
                {
                  kind: 'select',
                  id: 'jarvis.waitGuard',
                  label: 'When Jarvis sleeps or polls while waiting for its tasks',
                  value: p.get('waitGuard'),
                  options: [
                    { value: 'interrupt', label: 'Stop it, hand it the news', description: 'A turn that waits (sleep, wait loops, wake-up timers) is stopped once news is waiting, or after 12 seconds while its tasks run.' },
                    { value: 'remind', label: 'Only remind it', description: 'The next message tells it not to wait; the news still waits until its turn ends.' },
                    { value: 'off', label: 'Leave it', description: 'No guard: news waits until Jarvis ends its turn by itself.' },
                  ],
                },
                {
                  kind: 'select',
                  id: 'jarvis.eventBatchMs',
                  label: 'Collect news before sending it',
                  description: 'Whatever comes in meanwhile, and everything that finished while Jarvis was busy, goes to it together in one message.',
                  value: String(p.get('eventBatchMs')),
                  options: [
                    { value: '0', label: 'At once' },
                    { value: '2000', label: '2 s' },
                    { value: '5000', label: '5 s' },
                    { value: '15000', label: '15 s' },
                  ],
                },
                {
                  kind: 'select',
                  id: 'jarvis.autopilotMaxNudges',
                  label: 'Autopilot gives up after',
                  description: 'With autopilot on, Jarvis is nudged to continue whenever it stops while the mission is unfinished and nothing runs.',
                  value: String(p.get('autopilotMaxNudges')),
                  options: ['2', '4', '8', '15'].map((n) => ({ value: n, label: `${n} nudges` })),
                },
                {
                  kind: 'info',
                  id: 'jarvis.parallel',
                  label: 'Several Jarvis chats',
                  value: 'Each runs and hears about only its own tasks',
                  tone: 'muted',
                  description: "They never steer each other's work. Only the VS Code window that serves the MCP port runs Jarvis' loops.",
                },
              ],
            },
          ],
        };
      case 'jarvis.approvals':
        return {
          id,
          title: 'Approvals',
          sections: [
            {
              id: 'approvals',
              title: '',
              items: [
                {
                  kind: 'select',
                  id: 'jarvis.permissionPolicy',
                  label: 'Approvals inside tasks',
                  description:
                    "What the agents of Jarvis' tasks may do without a decision. Requests that are not automatic go to the Jarvis chat that runs the task (it approves what clearly serves the goal, " +
                    "or asks you). Jarvis' own tools never need approval. Your own chats are never touched.",
                  value: p.get('permissionPolicy'),
                  options: [
                    { value: 'ask_each', label: POLICY_LABEL.ask_each, description: 'Every request goes to the Jarvis chat.' },
                    { value: 'auto_readonly', label: POLICY_LABEL.auto_readonly, description: 'Reading files and searching is approved.' },
                    { value: 'auto_except_risky', label: POLICY_LABEL.auto_except_risky, description: 'Everything except risky actions (deleting, pushing, installing from the web, sudo…).' },
                    { value: 'auto_all', label: POLICY_LABEL.auto_all, description: 'Nothing is asked: agents run commands, edit and delete without asking, including by mistake.' },
                  ],
                },
                {
                  kind: 'toggle',
                  id: 'jarvis.allowSettingChanges',
                  label: 'Let Jarvis change app settings',
                  description: "Theme, chat text size, new-chat agent. Jarvis' own options can always be changed; approval and security settings never.",
                  value: p.get('allowSettingChanges'),
                },
              ],
            },
          ],
        };
      case 'jarvis.chat':
        return {
          id,
          title: 'Jarvis chat',
          sections: [
            {
              id: 'chat',
              title: '',
              items: [
                {
                  kind: 'toggle',
                  id: 'jarvis.contextInPrompt',
                  label: 'Send live context with every message',
                  description: 'VS Code (workspace, open file, selection), the chat on screen, tasks, approvals and timers, so Jarvis rarely has to look them up.',
                  value: p.get('contextInPrompt'),
                },
                {
                  kind: 'text',
                  id: 'jarvis.memory',
                  label: 'Jarvis memory',
                  description: 'Jarvis can edit this too (jarvis_memory_write). Sent with the first message of every Jarvis chat.',
                  value: p.get('memory'),
                  multiline: true,
                  rows: 6,
                },
                {
                  kind: 'info',
                  id: 'jarvis.context',
                  label: 'Your global context',
                  value: `${this.j.host.contextEntries().filter((e) => e.enabled && e.forJarvis).length} entries also told to Jarvis`,
                  tone: 'muted',
                  description: 'Settings → Global context: entries with "Also tell Jarvis" go to Jarvis chats and the tasks they start.',
                },
              ],
            },
          ],
        };
      default:
        return { id, title: 'Jarvis', sections: [] };
    }
  }

  private setupPage(): SettingsPage {
    const s = this.j.setup;
    const enabled = this.j.host.enabledKinds();
    // the agents are asked in the background (Claude's check starts the CLI): the page shows what is known
    let loading = false;
    for (const k of enabled) {
      const c = s.cached(k);
      if ((!c || Date.now() - c.checkedAt > 120_000) && !s.isChecking(k)) void s.check(k);
      if (!c) loading = true;
    }
    const rows: SettingListRow[] = ALL.filter((k) => enabled.includes(k)).map((k) => {
      const c = s.cached(k);
      const checking = s.isChecking(k);
      const status = c?.added === true ? 'Added' : c?.added === false ? 'Not added' : checking ? 'Checking…' : 'Unknown';
      const parts = [
        c?.state ? `State: ${c.state}` : null,
        k === 'CLAUDE' && c?.added ? (c.allowed ? "Jarvis' tools run without asking" : "Jarvis' tools still ask for approval: tap Allow") : null,
        c?.error ? `Problem: ${c.error.slice(0, 140)}` : null,
      ].filter(Boolean);
      return {
        id: k,
        title: agentName(k),
        subtitle: parts.join(' · ') || (c?.added ? 'Jarvis chats on this agent have their tools' : 'Required for Jarvis chats on this agent'),
        status,
        statusTone: c?.added === true ? 'ok' : c?.added === false ? 'warn' : 'muted',
        actions: [
          { id: 'add', label: c?.added ? 'Add again' : 'Add' },
          ...(k === 'CLAUDE' && c?.added && !c.allowed ? [{ id: 'allow', label: "Allow Jarvis' tools" }] : []),
          { id: 'refresh', label: 'Refresh' },
          ...(c?.added ? [{ id: 'remove', label: 'Remove', danger: true, confirm: `Remove the Jarvis MCP server from ${agentName(k)}?` }] : []),
        ],
      };
    });
    const missing = this.j.managers.keys().filter((key) => this.j.controller.isToolsMissing(key));
    const items: SettingItem[] = [];
    if (missing.length)
      items.push({
        kind: 'info',
        id: 'jarvis.setup.missing',
        label: 'Tools missing',
        value: `${missing.length} Jarvis chat${missing.length === 1 ? '' : 's'} said its agent has no Jarvis tools: add the server below, then send the next message.`,
        tone: 'warn',
      });
    items.push({
      kind: 'list',
      id: 'jarvis.setup.agents',
      label: 'Add the Jarvis MCP server',
      description: "Required: these are the tools a Jarvis chat controls AntiGem with. Each agent keeps its own MCP list; add it to every agent you use for Jarvis chats.",
      rows,
      emptyText: 'No agent is turned on (Settings → Agents).',
    });
    items.push({
      kind: 'info',
      id: 'jarvis.setup.url',
      label: 'Server',
      value: s.url(),
      tone: this.j.mcp.boundPort ? 'ok' : 'muted',
      description: this.j.mcp.boundPort ? 'Served by this VS Code window.' : 'Served by another VS Code window (the first one that started).',
    });
    return {
      id: 'jarvis.setup',
      title: 'Setup',
      loading,
      sections: [
        {
          id: 'setup',
          title: '',
          description:
            'The first message of every Jarvis chat carries the whole guide and the list of its tools with their parameters, so the model acts at once instead of searching. ' +
            'If the Jarvis MCP server is missing, Jarvis says so and its chat shows a warning.',
          items,
        },
      ],
    };
  }

  async change(_page: string, id: string, value: unknown): Promise<void> {
    const p = this.j.prefs;
    const s = String(value ?? '');
    const n = Number(value);
    switch (id) {
      case 'jarvis.enabled':
        this.j.setEnabled(value === true);
        return;
      case 'jarvis.listMode':
        if (s === 'none' || s === 'text' || s === 'all') p.set('listMode', s);
        this.j.host.refreshConversations();
        return;
      case 'jarvis.agent':
        p.set('agent', s === 'AGY' || s === 'CLAUDE' || s === 'CODEX' || s === 'OPENCODE' ? s : '');
        p.set('modelId', '');
        return;
      case 'jarvis.model':
        p.set('modelId', s);
        return;
      case 'jarvis.persona':
        p.set('persona', ['female', 'male', 'neutral'].includes(s) ? s : '');
        return;
      case 'jarvis.aboutUser':
        p.set('aboutUser', s.slice(0, 2000));
        return;
      case 'jarvis.eventRouting':
        if (s === 'model' || s === 'speak') p.set('eventRouting', s);
        return;
      case 'jarvis.taskApprovals':
        if (s === 'policy' || s === 'jarvis') p.set('taskApprovals', s);
        return;
      case 'jarvis.stallMinutes':
        if (Number.isFinite(n)) p.set('stallMinutes', Math.max(0, Math.min(240, Math.round(n))));
        return;
      case 'jarvis.waitGuard':
        if (['interrupt', 'remind', 'off'].includes(s)) p.set('waitGuard', s);
        return;
      case 'jarvis.eventBatchMs':
        if (Number.isFinite(n)) p.set('eventBatchMs', Math.max(0, Math.min(30_000, Math.round(n))));
        return;
      case 'jarvis.autopilotMaxNudges':
        if (Number.isFinite(n)) p.set('autopilotMaxNudges', Math.max(1, Math.min(20, Math.round(n))));
        return;
      case 'jarvis.permissionPolicy':
        if (POLICY_LABEL[s]) p.set('permissionPolicy', s);
        return;
      case 'jarvis.allowSettingChanges':
        p.set('allowSettingChanges', value === true);
        return;
      case 'jarvis.contextInPrompt':
        p.set('contextInPrompt', value === true);
        return;
      case 'jarvis.memory':
        p.set('memory', s.slice(0, 4000));
        return;
    }
  }

  async action(_page: string, id: string, rowId?: string, actionId?: string): Promise<string | void> {
    if (id !== 'jarvis.setup.agents' || !rowId) return;
    const k = rowId as AgentKind;
    if (!ALL.includes(k)) return;
    switch (actionId) {
      case 'add':
        return this.j.setup.add(k);
      case 'allow':
        await this.j.setup.allowClaudeTools();
        await this.j.setup.check(k);
        return "Jarvis' tools now run without asking in Claude Code";
      case 'remove':
        return this.j.setup.remove(k);
      case 'refresh':
        await this.j.setup.check(k);
        return;
    }
  }
}
