// Agent-neutral settings and prompt features kept by the host (ports of the app's CustomSlashCommands, GlobalContext
// and PromptExpansion.expand): custom `/` commands, global context, default agent, connection.
import { randomUUID } from 'node:crypto';
import type { AgentKind } from '../../shared/model';
import type { SettingFormField, SettingsPage, SettingsSection, SlashCommandView } from '../../shared/protocol';
import type { KeyValueStore } from './types';
import { hiddenBlock } from './text';

export interface CustomCommand {
  name: string;
  description: string;
  expansion: string;
}

export interface ContextEntry {
  id: string;
  title: string;
  text: string;
  enabled: boolean;
  everyMessage: boolean;
  /** Also told to Jarvis (its chats and the chats it starts for tasks). */
  forJarvis?: boolean;
  /** The agents it is sent to (unset = every agent, also ones added later). */
  agents?: AgentKind[];
}

/** Every agent, in the order the pickers show them. */
export const CONTEXT_AGENTS: AgentKind[] = ['AGY', 'CLAUDE', 'CODEX', 'OPENCODE'];
const AGENT_NAMES: Record<AgentKind, string> = { AGY: 'Antigravity', CLAUDE: 'Claude Code', CODEX: 'Codex', OPENCODE: 'OpenCode' };
const agentOptions = () => CONTEXT_AGENTS.map((a) => ({ value: a, label: AGENT_NAMES[a] }));
/** For one agent? (no agent: any; no list: every agent). */
const appliesTo = (agents: AgentKind[] | undefined, agent: AgentKind | null | undefined) => !agent || !agents || agents.includes(agent);
/** Ticked agents → what is stored: every agent = unset (new agents get it too). */
const agentsValue = (list: AgentKind[]) => (CONTEXT_AGENTS.every((a) => list.includes(a)) ? undefined : list);
/** "Claude Code, Codex" for a list that leaves some out. */
const agentsLabel = (agents: AgentKind[] | undefined) => (agents ? agents.map((a) => AGENT_NAMES[a] ?? a).join(', ') : null);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const TOKEN_RE = /(?<=^|\s)\/([A-Za-z0-9][A-Za-z0-9_-]{0,47})(?=\s|$)/g;
// the app's PromptExpansion TOKEN: `/plu:<plugin>[:<skill>]` (a dangling `:` left by the picker counts as no skill) or a
// custom command
const PLU_TOKEN_RE = /(?<=^|\s)\/(plu:[A-Za-z0-9_-]+(?::[A-Za-z0-9._-]*)?|[A-Za-z0-9][A-Za-z0-9_-]{0,47})(?=\s|$)/g;

const MAX_REMEMBERED_CHATS = 600;

const entriesBlock = (list: ContextEntry[]) => list.map((e) => (e.title.trim() ? `### ${e.title.trim()}\n` : '') + e.text.trim()).join('\n\n');

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const block = (command: string, body: string) => `<antigem-expansion command="${escapeAttr(command)}">\n${body}\n</antigem-expansion>`;

export class HostSettings {
  constructor(private store: KeyValueStore) {}

  /** The note `/plu:<plugin>[:<skill>]` expands to (set by the plugin feature; null = not an enabled plugin). */
  pluginGuide: ((pluginId: string, skill: string | null) => string | null) | null = null;

  // ---------------------------------------------------------------- custom `/` commands

  commandsList(): CustomCommand[] {
    return this.store.get<CustomCommand[]>('custom.commands') ?? [];
  }

  private saveCommands(list: CustomCommand[]) {
    this.store.set('custom.commands', list);
  }

  slashItems(): SlashCommandView[] {
    return this.commandsList().map((c) => ({
      command: `/${c.name}`,
      description: c.description || null,
      argumentHint: c.expansion.includes('$ARGUMENTS') ? 'arguments' : null,
      kind: 'custom',
    }));
  }

  /** Custom commands typed in the message become hidden expansion blocks (the chat still shows the command). */
  expand(text: string): string {
    const cmds = this.commandsList();
    const guide = this.pluginGuide;
    if ((!cmds.length && !guide) || !text.includes('/')) return text;
    let out = '';
    let last = 0;
    for (const m of text.matchAll(guide ? PLU_TOKEN_RE : TOKEN_RE)) {
      const start = m.index ?? 0;
      if (start < last) continue;
      if (guide && m[1].startsWith('plu:')) {
        // `/plu:<plugin>[:<skill>]`: the plugin's guide; the chat shows the command without a dangling colon
        const [plugin, skill] = m[1].slice(4).split(':');
        const note = guide(plugin, skill || null);
        if (note == null) continue;
        out += text.slice(last, start) + block(skill ? m[0] : `/plu:${plugin}`, note);
        last = start + m[0].length;
        continue;
      }
      const cmd = cmds.find((c) => c.name.toLowerCase() === m[1].toLowerCase());
      if (!cmd) continue;
      out += text.slice(last, start);
      if (cmd.expansion.includes('$ARGUMENTS')) {
        const args = text.slice(start + m[0].length).trim();
        return out + block(args ? `${m[0]} ${args}` : m[0], cmd.expansion.replace(/\$ARGUMENTS/g, args));
      }
      out += block(m[0], cmd.expansion);
      last = start + m[0].length;
    }
    return last === 0 ? text : out + text.slice(last);
  }

  // ---------------------------------------------------------------- global context

  contextEntries(): ContextEntry[] {
    return this.store.get<ContextEntry[]>('global.context') ?? [];
  }

  private saveContext(list: ContextEntry[]) {
    this.store.set('global.context', list);
  }

  // ---------------------------------------------------------------- the built-in context (GlobalContext.builtInText)

  /** The built-in context (how to show things in this chat) is on unless the user turned it off. */
  builtInEnabled(): boolean {
    return this.store.get<boolean>('global.context.builtin') !== false;
  }

  /** The agents the built-in context goes to (unset = every agent). */
  builtInAgents(): AgentKind[] | undefined {
    return this.store.get<AgentKind[]>('global.context.builtinAgents');
  }

  /** The built-in context for [agent] (null when off, or not for that agent). */
  builtInFor(agent: AgentKind | null | undefined, h = '##'): string | null {
    return this.builtInEnabled() && appliesTo(this.builtInAgents(), agent) ? this.builtInText(h) : null;
  }

  /** What the extension tells every chat about itself; [h] = the heading level of its section. */
  builtInText(h = '##'): string {
    return [
      `${h} Showing things in this chat`,
      'The user reads you in AntiGem (a chat inside VS Code). Besides Markdown it renders these, each on its own line (absolute paths, no spaces):',
      '- Image: `![caption](/abs/path/pic.png)` (or an https URL)',
      '- Video: `![caption](/abs/path/clip.mp4)` (mp4, webm, mov: plays in the chat) · YouTube: `![title](https://www.youtube.com/watch?v=VIDEO_ID)` (a card that opens it in the browser)',
      '- File: `[name](/abs/path/file.ext)` (the user clicks to open it in the editor)',
      '- Diagram: a ```mermaid code block is drawn as a diagram (flowchart, sequence, class, state, ER, gantt, pie, mindmap, timeline…)',
      '- Math: LaTeX in `$…$` inline or `$$…$$` as a block',
      '- Live web page / mini app: a ```html_app code block runs as an interactive page in the chat (one HTML document: CSS in <style>, ' +
        'JS in <script>; CDN scripts, fonts and images load). For a site of several files on disk, put only the absolute path of its .html ' +
        'file in the block: its CSS, JS and images load from that folder. It runs sandboxed in its own origin: localStorage, ' +
        'sessionStorage, IndexedDB, cookies, fetch to APIs that allow CORS, canvas, WebGL, audio and forms work; alert(), confirm(), ' +
        'prompt() and window.open() / new tabs do NOT (show messages and dialogs inside the page instead); it cannot reach local files, ' +
        'the chat or the editor.',
      'Show the images, videos, diagrams and pages you make this way instead of only naming the path.',
      '',
      `${h} Asking the user`,
      'If you have a tool for asking the user questions with options (e.g. AskUserQuestion, question, ask_question), use it ' +
        'when a request is vague or you are unsure what the user wants and the answer fits a few choices: the chat shows it as a ' +
        'card the user clicks, which is faster than typing. Ask everything you need in one go and still allow a typed answer.',
    ].join('\n');
  }

  /** The first-message context of a normal chat of [agent], or null when there is nothing to send. */
  private firstMessageBody(agent?: AgentKind | null): string | null {
    const parts: string[] = [];
    const builtIn = this.builtInFor(agent);
    if (builtIn) parts.push(builtIn);
    const own = this.activeEntries(agent).filter((e) => !e.everyMessage);
    if (own.length) parts.push("## The user's own instructions\n" + entriesBlock(own));
    return parts.length ? parts.join('\n\n') : null;
  }

  /** The entries switched on, for [agent] (none given: all of them). */
  private activeEntries(agent?: AgentKind | null): ContextEntry[] {
    return this.contextEntries().filter((e) => e.enabled && e.text.trim() && appliesTo(e.agents, agent));
  }

  /** Changes whenever the first-message context of [agent] changes (an extension update, an edited entry). */
  private fingerprint(agent?: AgentKind | null): string {
    const body = this.firstMessageBody(agent) ?? '';
    let h = 0;
    for (let i = 0; i < body.length; i++) h = (Math.imul(31, h) + body.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  /** chat id → fingerprint of the first-message context it got (oldest first). */
  private sentMap(): Record<string, string> {
    return this.store.get<Record<string, string>>('global.context.sent') ?? {};
  }

  private markSent(chatId: string, fp: string) {
    const m = this.sentMap();
    delete m[chatId];
    m[chatId] = fp;
    const keys = Object.keys(m);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_CHATS))) delete m[k];
    this.store.set('global.context.sent', m);
  }

  /**
   * A normal chat message with the hidden context in front (GlobalContext.wrap): the first-message part on a new chat,
   * and again when it changed since this chat got it; every-message entries always.
   */
  wrap(text: string, isNew: boolean, chatId?: string | null, agent?: AgentKind | null): string {
    const first = this.firstMessageBody(agent);
    const fp = this.fingerprint(agent);
    const known = chatId ? this.sentMap()[chatId] : undefined;
    const sendFirst = first != null && (isNew || known !== fp);
    const everyOwn = this.activeEntries(agent).filter((e) => e.everyMessage);
    const every = everyOwn.length ? "[The user's standing instructions, sent with every message]\n" + entriesBlock(everyOwn) : null;
    if (!sendFirst && !every) return text;
    let note = '';
    if (sendFirst) {
      note +=
        isNew
          ? '[AntiGem app context: from the app the user chats through, not written by the user. Follow it for this whole chat; it is not repeated.]'
          : known
            ? '[AntiGem app context, updated: it replaces the earlier copy in this chat. Follow it from now on.]'
            : '[AntiGem app context: from the app the user chats through. Follow it from now on in this chat.]';
      note += '\n\n' + first;
      if (chatId) this.markSent(chatId, fp);
    }
    if (every) note += (note ? '\n\n' : '') + every;
    // a message that starts with a /command must still start with it (the CLI only runs a leading /command)
    if (text.trimStart().startsWith('/')) return `${text}\n\n${hiddenBlock(note)}`;
    return hiddenBlock(note) + text;
  }

  // ---------------------------------------------------------------- default agent

  defaultAgent(fallback: AgentKind): AgentKind {
    return this.store.get<AgentKind>('chat.defaultAgent') ?? fallback;
  }

  // ---------------------------------------------------------------- pages

  connectionPage(info: { port: number; hubPort: number; logFile: string }, canShowLogs: boolean): SettingsPage {
    return {
      id: 'connection',
      title: 'Bridge & connection',
      sections: [
        {
          id: 'connection',
          title: 'Bridge',
          description: 'The local AntiGem bridge runs the agents for every VS Code window.',
          items: [
            { kind: 'info', id: 'conn.bridge', label: 'Bridge', value: `127.0.0.1:${info.port}`, tone: 'muted' },
            { kind: 'info', id: 'conn.hub', label: 'Antigravity hub', value: `127.0.0.1:${info.hubPort}`, tone: 'muted' },
            { kind: 'info', id: 'conn.log', label: 'Bridge log', value: info.logFile, tone: 'muted' },
            { kind: 'button', id: 'conn.restart', label: 'Restart bridge', description: 'Stops the bridge and its agents, then starts them again', confirm: 'Restart the bridge? Running chats are stopped.' },
            ...(canShowLogs ? [{ kind: 'button' as const, id: 'conn.logs', label: 'Show logs' }] : []),
          ],
        },
      ],
    };
  }

  chatSection(): SettingsSection {
    return {
      id: 'chat',
      title: '',
      items: [
        { kind: 'page', id: 'slash', label: 'Slash commands', icon: 'code', description: 'Your own /commands for every agent', badge: String(this.commandsList().length) },
        {
          kind: 'page',
          id: 'context',
          label: 'Global context',
          icon: 'description',
          description: 'Instructions added to your chats',
          badge: String(this.contextEntries().filter((e) => e.enabled).length + (this.builtInEnabled() ? 1 : 0)),
        },
      ],
    };
  }

  private commandForm(c?: CustomCommand): SettingFormField[] {
    return [
      { id: 'name', label: 'Command (without /)', kind: 'text', value: c?.name ?? '', placeholder: 'review', required: true },
      { id: 'description', label: 'Description', kind: 'text', value: c?.description ?? '', placeholder: 'Review the current changes' },
      {
        id: 'expansion',
        label: 'Instructions sent to the agent ($ARGUMENTS = the rest of your message)',
        kind: 'multiline',
        value: c?.expansion ?? '',
        placeholder: 'Review the uncommitted changes for bugs. Focus on: $ARGUMENTS',
        required: true,
      },
    ];
  }

  private contextForm(e?: ContextEntry): SettingFormField[] {
    return [
      { id: 'title', label: 'Title', kind: 'text', value: e?.title ?? '', placeholder: 'Coding style' },
      { id: 'text', label: 'Text', kind: 'multiline', value: e?.text ?? '', placeholder: 'Always use TypeScript strict mode…', required: true },
      {
        id: 'when',
        label: 'Send',
        kind: 'select',
        value: e?.everyMessage ? 'every' : 'first',
        options: [
          { value: 'first', label: 'Once, at the start of each chat' },
          { value: 'every', label: 'With every message' },
        ],
      },
      {
        id: 'agents',
        label: 'Use for',
        kind: 'checklist',
        value: (e?.agents ?? CONTEXT_AGENTS).join(','),
        options: agentOptions(),
      },
      {
        id: 'jarvis',
        label: 'Also tell Jarvis',
        kind: 'select',
        value: e?.forJarvis ? 'yes' : 'no',
        options: [
          { value: 'no', label: 'No (Jarvis has strict rules a note for normal chats could break)' },
          { value: 'yes', label: 'Yes: Jarvis chats and the tasks they start get it too' },
        ],
      },
    ];
  }

  page(id: string): SettingsPage | null {
    if (id === 'slash') {
      return {
        id,
        title: 'Slash commands',
        sections: [
          {
            id: 'custom',
            title: 'Your commands',
            description: 'Type /name in the composer. The chat shows the command; the agent gets the instructions.',
            items: [
              {
                kind: 'list',
                id: 'commands',
                label: 'Commands',
                emptyText: 'No commands yet',
                rows: this.commandsList().map((c) => ({
                  id: c.name,
                  title: `/${c.name}`,
                  subtitle: c.description || c.expansion.split('\n')[0],
                  actions: [
                    { id: 'edit', label: 'Edit', form: this.commandForm(c) },
                    { id: 'delete', label: 'Delete', danger: true, confirm: `Delete /${c.name}?` },
                  ],
                })),
                addLabel: 'Add command',
                addForm: this.commandForm(),
              },
            ],
          },
        ],
      };
    }
    if (id === 'context') {
      return {
        id,
        title: 'Global context',
        sections: [
          {
            id: 'builtin',
            title: 'Built-in',
            description: 'Written by AntiGem: tells every agent how to show images, videos, diagrams, math and live web pages in this chat.',
            items: [
              {
                kind: 'toggle',
                id: 'builtin',
                label: 'Send the built-in context',
                description: 'Once at the start of each chat (again when it changes). Turn it off if your agents should not get it.',
                value: this.builtInEnabled(),
              },
              {
                kind: 'checklist',
                id: 'builtin.agents',
                label: 'Use for',
                description: 'The agents that get it.',
                values: this.builtInAgents() ?? CONTEXT_AGENTS,
                options: agentOptions(),
                disabled: !this.builtInEnabled(),
              },
              { kind: 'text', id: 'builtin.text', label: 'What it says', value: this.builtInText(), multiline: true, rows: 12, disabled: true },
            ],
          },
          {
            id: 'entries',
            title: 'Context',
            description: 'Hidden notes for the agent (the chat never shows them).',
            items: [
              {
                kind: 'list',
                id: 'entries',
                label: 'Entries',
                emptyText: 'No context yet',
                rows: this.contextEntries().map((e) => ({
                  id: e.id,
                  title: e.title || e.text.split('\n')[0].slice(0, 60),
                  subtitle: e.title ? e.text.split('\n')[0].slice(0, 80) : null,
                  status: [e.everyMessage ? 'Every message' : 'Chat start', agentsLabel(e.agents)].filter(Boolean).join(' · '),
                  statusTone: 'muted' as const,
                  toggle: e.enabled,
                  actions: [
                    { id: 'edit', label: 'Edit', form: this.contextForm(e) },
                    { id: 'delete', label: 'Delete', danger: true, confirm: 'Delete this entry?' },
                  ],
                })),
                addLabel: 'Add context',
                addForm: this.contextForm(),
              },
            ],
          },
        ],
      };
    }
    return null;
  }

  /** Returns true when the change was a host setting. */
  change(page: string, id: string, value: unknown, rowId?: string): boolean {
    if (page === 'context' && id === 'builtin') {
      this.store.set('global.context.builtin', value === true);
      return true;
    }
    if (page === 'context' && id === 'builtin.agents' && Array.isArray(value)) {
      const list = CONTEXT_AGENTS.filter((a) => (value as string[]).includes(a));
      if (list.length) this.store.set('global.context.builtinAgents', agentsValue(list));
      return true;
    }
    if (page === 'context' && id === 'entries' && rowId) {
      this.saveContext(this.contextEntries().map((e) => (e.id === rowId ? { ...e, enabled: value === true } : e)));
      return true;
    }
    return false;
  }

  /** Returns a toast text, '' when handled silently, or null when not a host action. */
  action(page: string, id: string, rowId?: string, actionId?: string, values?: Record<string, string>): string | null {
    if (page === 'slash' && id === 'commands') {
      const list = this.commandsList();
      if (actionId === 'delete' && rowId) {
        this.saveCommands(list.filter((c) => c.name !== rowId));
        return `Deleted /${rowId}`;
      }
      if ((actionId === 'add' || actionId === 'edit') && values) {
        const name = (values.name ?? '').trim().replace(/^\//, '');
        if (!NAME_RE.test(name)) throw new Error('Use letters, digits, - or _ (max 48) for the command name');
        if (!values.expansion?.trim()) throw new Error('Enter the instructions');
        const others = list.filter((c) => c.name !== (actionId === 'edit' ? rowId : name));
        if (others.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new Error(`/${name} already exists`);
        const cmd = { name, description: (values.description ?? '').trim(), expansion: values.expansion };
        const next = actionId === 'edit' ? list.map((c) => (c.name === rowId ? cmd : c)) : [...list, cmd];
        this.saveCommands(next);
        return actionId === 'add' ? `Added /${name}` : `Saved /${name}`;
      }
    }
    if (page === 'context' && id === 'entries') {
      const list = this.contextEntries();
      if (actionId === 'delete' && rowId) {
        this.saveContext(list.filter((e) => e.id !== rowId));
        return '';
      }
      if ((actionId === 'add' || actionId === 'edit') && values) {
        if (!values.text?.trim()) throw new Error('Enter the text');
        // an older form has no agents field: every agent
        const picked = values.agents == null ? CONTEXT_AGENTS : CONTEXT_AGENTS.filter((a) => values.agents.split(',').includes(a));
        if (!picked.length) throw new Error('Pick at least one agent');
        const entry = {
          title: (values.title ?? '').trim(),
          text: values.text,
          everyMessage: values.when === 'every',
          forJarvis: values.jarvis === 'yes',
          agents: agentsValue(picked),
        };
        if (actionId === 'edit' && rowId) this.saveContext(list.map((e) => (e.id === rowId ? { ...e, ...entry } : e)));
        else this.saveContext([...list, { id: randomUUID(), enabled: true, ...entry }]);
        return '';
      }
    }
    return null;
  }
}
