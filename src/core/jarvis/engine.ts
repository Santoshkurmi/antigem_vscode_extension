// Jarvis in the host: ties the parts together (port of the app's data/jarvis/* minus voice), runs the loops with the
// app's timings (tasks and news every 1.5 s, approvals and questions every second), keeps the state the views draw
// (pushed as `jarvis` messages: the whole state on init, then only what changed) and implements the host hooks.
import type { AgentKind, ChatMessage, Conversation, JarvisEventView } from '../../../shared/model';
import type { JarvisLogEntry, JarvisManagerView, JarvisState, JarvisTaskState, JarvisTaskView } from '../../../shared/protocol';
import type { McpTool } from '../mcp/server';
import type { KeyValueStore, Logger } from '../types';
import { Controller } from './controller';
import { Driver } from './driver';
import { Events } from './events';
import { JarvisSetup } from './jarvisSetup';
import { Managers, missionDone, missionIsEmpty } from './managers';
import { jarvisTools } from './mcp';
import { JarvisPrefs } from './prefs';
import { JarvisSettings } from './settings';
import { Skill } from './skill';
import { Tasks } from './tasks';
import { TASK_LABEL, isActiveState, needsUserState, type BridgeAccess, type JarvisActionMsg, type JarvisHooks, type JarvisHostApi, type McpAccess, type Task, type TaskState } from './types';

export interface JarvisDeps {
  host: JarvisHostApi;
  store: KeyValueStore;
  log: Logger;
  bridge: BridgeAccess;
  mcp: McpAccess;
}

const STATE_OF: Record<TaskState, JarvisTaskState> = {
  STARTING: 'starting',
  RUNNING: 'running',
  NEEDS_APPROVAL: 'waiting_approval',
  NEEDS_ANSWER: 'asking',
  STALLED: 'no_progress',
  DONE: 'done',
  FAILED: 'failed',
  STOPPED: 'stopped',
};

const LABEL_PREFIX = '⚡ Jarvis · ';

export class JarvisEngine implements JarvisHooks {
  readonly host: JarvisHostApi;
  readonly bridge: BridgeAccess;
  readonly mcp: McpAccess;
  readonly prefs: JarvisPrefs;
  readonly driver: Driver;
  readonly managers: Managers;
  readonly tasks: Tasks;
  readonly events: Events;
  readonly controller: Controller;
  readonly skill: Skill;
  readonly setup: JarvisSetup;
  readonly settings: JarvisSettings;

  private logger: Logger;
  private timers: NodeJS.Timeout[] = [];
  private busy = { tasks: false, events: false, perms: false };
  private flushTimer: NodeJS.Timeout | null = null;
  private sent: Record<string, string> = {};
  private decorated = new WeakMap<ChatMessage, ChatMessage>();
  private tools: McpTool[] | null = null;
  private lastIds = '';
  private leader = false;
  private disposed = false;

  constructor(deps: JarvisDeps) {
    this.host = deps.host;
    this.bridge = deps.bridge;
    this.mcp = deps.mcp;
    this.logger = deps.log;
    this.prefs = new JarvisPrefs(deps.store);
    // the order matters: the managers and tasks look things up through the driver
    this.driver = new Driver(this);
    this.managers = new Managers(this, deps.store);
    this.tasks = new Tasks(this, deps.store);
    this.events = new Events(this, deps.store);
    this.controller = new Controller(this, deps.store);
    this.skill = new Skill(this);
    this.setup = new JarvisSetup(this.bridge, this.mcp, (k) => this.host.backend(k), () => this.host.refreshSettings());
    this.settings = new JarvisSettings(this);
    this.lastIds = this.prefs.chatIds().join(',');
    this.prefs.onChange(() => {
      this.changed();
      const ids = this.prefs.chatIds().join(',');
      if (ids !== this.lastIds) {
        this.lastIds = ids;
        this.host.refreshConversations();
      }
    });
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Runs the loops in this process. Only the window that serves the MCP port should (several VS Code windows share the
   * store: two of them watching the same tasks would hand Jarvis every news twice).
   */
  setLeader(on: boolean) {
    if (on === this.leader || this.disposed) return;
    this.leader = on;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (!on) return;
    const run = (key: keyof typeof this.busy, f: () => Promise<void> | void) => async () => {
      if (this.busy[key] || !this.prefs.get('enabled') || this.host.isOff()) return;
      this.busy[key] = true;
      try {
        await f();
      } catch (e) {
        this.logLine(`[jarvis] ${key}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.busy[key] = false;
      }
    };
    this.timers.push(setInterval(run('tasks', () => this.tasks.loop()), 1500));
    this.timers.push(setInterval(run('events', () => this.events.loop()), 1500));
    this.timers.push(
      setInterval(
        run('perms', async () => {
          await this.controller.permissionLoop();
          this.controller.questionLoop();
          this.controller.expireNotices(Date.now());
          this.deriveStatuses();
          // phases and states move without an explicit change: compare once a second
          this.changed();
        }),
        1000,
      ),
    );
  }

  get isLeader() {
    return this.leader;
  }

  setEnabled(on: boolean) {
    this.prefs.set('enabled', on);
    if (on && !this.prefs.agentKind() && !this.host.enabledKinds().length) this.controller.notice('Turn on an agent first (Settings → Agents).', 'warning', 'settings');
    this.host.refreshConversations();
    this.changed();
  }

  dispose() {
    this.disposed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.controller.dispose();
    this.tasks.dispose();
    this.events.dispose();
    this.driver.dispose();
  }

  // ------------------------------------------------------------------ small helpers for the parts

  logLine(line: string) {
    this.logger(line);
  }

  log(kind: JarvisLogEntry['kind'], text: string, chatId: string | null = null, taskId: string | null = null) {
    this.controller.log(kind, text, chatId, taskId);
  }

  toolList(): McpTool[] {
    if (!this.tools) this.tools = jarvisTools();
    return this.tools;
  }

  /** The project Jarvis works in by default: the one it opened, else this window's first folder. */
  activeProjectPath(): string {
    return this.prefs.get('activeProject') || this.host.workspaceFolders()[0]?.path || '';
  }

  /** What a Jarvis chat runs right now, in plain words, when it did not say itself (the app's deriveToolStatus). */
  private deriveStatuses() {
    for (const k of this.managers.keys()) {
      if (!this.driver.isWatched(k) || !this.driver.isBusy(k)) continue;
      const call = this.driver.runningTool(k);
      if (!call) continue;
      const n = call.name.toLowerCase();
      if (n.includes('jarvis')) continue;
      const s =
        n === 'toolsearch'
          ? 'Loading my tools'
          : n.startsWith('mcp__')
            ? `Using ${n.slice(5).split('__')[0].replace(/_/g, ' ')}`
            : n === 'bash' || n === 'shell' || n.includes('terminal') || n.includes('command')
              ? `Running ${call.command.trim().slice(0, 32) || 'a command'}`
              : n.includes('read') || n.includes('view')
                ? 'Reading a file'
                : n.includes('write') || n.includes('edit')
                  ? 'Editing a file'
                  : n.includes('grep') || n.includes('glob') || n.includes('find') || (n.includes('search') && !n.includes('web'))
                    ? 'Searching the code'
                    : n.includes('web')
                      ? 'Looking it up online'
                      : 'Working on it';
      const cur = this.managers.status(k);
      if (!cur || this.derived.has(cur)) {
        this.managers.setStatus(k, s);
        this.derived.add(s);
      }
    }
  }

  private derived = new Set<string>();

  // ------------------------------------------------------------------ the state the views draw

  /** Something changed: the views get the fields that differ (at most every 250 ms). */
  changed() {
    if (this.flushTimer || this.disposed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 250);
  }

  private flush() {
    const s = this.snapshot();
    const patch: Partial<JarvisState> = {};
    let any = false;
    for (const [k, v] of Object.entries(s)) {
      const json = JSON.stringify(v);
      if (this.sent[k] === json) continue;
      this.sent[k] = json;
      (patch as Record<string, unknown>)[k] = v;
      any = true;
    }
    if (any) this.host.broadcast({ type: 'jarvis', state: patch });
  }

  private taskView(t: Task): JarvisTaskView {
    return {
      id: t.id,
      title: t.title,
      goal: t.goal,
      agent: t.agent,
      state: STATE_OF[t.state],
      stateLabel: TASK_LABEL[t.state],
      active: isActiveState(t.state),
      needsUser: needsUserState(t.state),
      owner: t.owner,
      team: t.team,
      project: t.project,
      note: t.note,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      followUps: t.followUps,
    };
  }

  private managerView(key: string, titles: Map<string, string>): JarvisManagerView {
    const m = this.managers.of(key);
    const mine = this.tasks.ownedBy(key);
    const active = mine.filter((t) => isActiveState(t.state));
    const busy = this.driver.isBusy(key);
    const mi = m.mission;
    return {
      chatId: key,
      agent: m.agent,
      title: titles.get(key) ?? null,
      mission: missionIsEmpty(mi)
        ? null
        : { goal: mi.goal, doneWhen: mi.doneWhen, steps: mi.steps.map((s) => ({ ...s })), status: mi.status, autopilot: mi.autopilot, notes: mi.notes, doneCount: missionDone(mi), updatedAt: mi.updatedAt },
      teams: m.teams.map((t) => ({ ...t, runningTasks: active.filter((x) => x.team.toLowerCase() === t.name.toLowerCase()).length })),
      status: this.managers.status(key),
      phase: busy ? (this.driver.runningTool(key) ? 'working' : 'thinking') : 'idle',
      steps: this.managers.steps(key),
      activeTasks: active.length,
      needsAttention: active.some((t) => needsUserState(t.state)),
      toolsMissing: this.controller.isToolsMissing(key),
      pendingEvents: this.events.pending(key),
    };
  }

  snapshot(): JarvisState {
    const titles = new Map(this.host.conversations().map((c) => [c.id, c.title] as const));
    const tasks = this.tasks.all();
    return {
      enabled: this.prefs.get('enabled'),
      listMode: this.prefs.get('listMode'),
      agent: this.prefs.agentKind(),
      modelId: this.prefs.get('modelId') || null,
      chatIds: this.prefs.chatIds(),
      managers: this.managers.keys().map((k) => this.managerView(k, titles)),
      tasks: tasks.map((t) => this.taskView(t)),
      notices: this.controller.notices(),
      log: this.controller.logEntries().slice(-200),
      timers: this.controller.timers(),
      anyActive: tasks.some((t) => isActiveState(t.state)),
    };
  }

  // ------------------------------------------------------------------ host hooks

  wrapSend(conversationId: string, agent: AgentKind, text: string, isNew: boolean, markJarvis: boolean): string | null {
    if (!this.prefs.get('enabled')) return null;
    if (markJarvis && isNew) {
      this.managers.register(conversationId, agent);
      this.prefs.set('textChatAgent', agent);
      this.log('chat', 'New Jarvis chat', conversationId);
    } else if (!this.managers.isManager(conversationId)) {
      // an older Jarvis chat the user writes in again: it carries on as a Jarvis chat
      if (!this.prefs.isJarvisChat(conversationId)) return null;
      this.managers.register(conversationId, agent);
    }
    this.driver.remember(conversationId, agent);
    this.driver.watch(conversationId, 'manager', agent);
    const out = this.controller.wrapManagerMessage(conversationId, text);
    this.changed();
    return out;
  }

  decorateMessages(conversationId: string, messages: ChatMessage[]): ChatMessage[] {
    if (!this.prefs.isJarvisChat(conversationId) && !messages.some((m) => m.role === 'USER' && m.content.startsWith(LABEL_PREFIX))) return messages;
    let changed = false;
    // the same label can occur several times: count from the newest, as the host remembers the batches
    const seen = new Map<string, number>();
    const out = new Array<ChatMessage>(messages.length);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      out[i] = m;
      if (m.role !== 'USER') continue;
      const raw = m.rawContent ?? '';
      const label = m.content.trim();
      let events: JarvisEventView[] | null = null;
      if (raw && Events.isEventMessage(raw)) events = Events.parse(raw);
      else if (label.startsWith(LABEL_PREFIX)) {
        const nth = seen.get(label) ?? 0;
        seen.set(label, nth + 1);
        events = this.events.cardFor(conversationId, label, nth);
      }
      if (!events?.length) continue;
      const cached = this.decorated.get(m);
      const d = cached ?? { ...m, jarvisEvents: events };
      if (!cached) this.decorated.set(m, d);
      out[i] = d;
      changed = true;
    }
    return changed ? out : messages;
  }

  decorateConversations(list: Conversation[]): Conversation[] {
    if (!this.prefs.get('enabled')) return list;
    const ids = new Set(this.prefs.chatIds());
    if (!ids.size) return list;
    const mode = this.prefs.get('listMode');
    return list.map((c) => {
      if (!ids.has(c.id)) return c;
      const hidden = mode === 'none' || (mode === 'text' && !this.managers.isManager(c.id));
      return { ...c, isJarvis: true, jarvisHidden: hidden };
    });
  }

  async action(msg: JarvisActionMsg, _viewId: string): Promise<string | void> {
    const chat = msg.chatId ?? null;
    switch (msg.action) {
      case 'newChat': {
        if (!this.prefs.get('enabled')) throw new Error('Turn Jarvis on first (Settings → Jarvis).');
        const t = this.controller.newChatTarget(msg.agent ?? null);
        if (typeof t === 'string') throw new Error(t);
        this.host.showChat(null, t.agent);
        this.host.postActive({ type: 'jarvisNewChat', agent: t.agent, modelId: t.modelId });
        return;
      }
      case 'stopTask':
        if (msg.taskId) return this.tasks.stop(msg.taskId);
        return;
      case 'openTask': {
        const t = this.tasks.find(msg.taskId);
        if (t) this.host.showChat(t.id, t.agent);
        return;
      }
      case 'dismissTask':
        if (msg.taskId) this.tasks.close(msg.taskId);
        return;
      case 'clearFinished':
        if (chat) {
          for (const t of this.tasks.ownedBy(chat)) if (!isActiveState(t.state)) this.tasks.close(t.id);
        } else this.tasks.clearFinished();
        return;
      case 'pauseMission':
      case 'resumeMission':
        if (chat) this.managers.updateMission(chat, null, null, null, [], msg.action === 'pauseMission' ? 'paused' : 'active', null, null);
        return;
      case 'clearMission':
        if (chat) this.managers.clearMission(chat);
        return;
      case 'setAutopilot':
        if (chat) this.managers.setAutopilot(chat, msg.on === true);
        return;
      case 'removeTeam':
        if (chat && msg.teamName) this.managers.removeTeam(chat, msg.teamName);
        return;
      case 'stopAll': {
        const keys = chat ? [chat] : this.managers.keys();
        let n = 0;
        for (const k of keys) {
          if (this.driver.isBusy(k)) await this.driver.stop(k).catch(() => undefined);
          for (const t of this.tasks.ownedBy(k).filter((x) => isActiveState(x.state))) {
            await this.tasks.stop(t.id);
            n++;
          }
        }
        return n ? `Stopped ${n} task${n === 1 ? '' : 's'}` : 'Stopped';
      }
      case 'dismissNotice':
        this.controller.dismissNotice(msg.noticeId ?? null);
        return;
      case 'clearLog':
        this.controller.clearLog();
        return;
      case 'setup':
        if (!msg.agent) throw new Error('Which agent?');
        return this.setup.add(msg.agent);
      case 'openSettings':
        this.host.postActive({ type: 'jarvisNavigate', screen: 'settings', settingsPage: msg.settingsPage || 'jarvis', conversationId: null });
        return;
    }
  }

  onChatDeleted(id: string) {
    if (!id) return;
    if (this.tasks.isTask(id)) this.tasks.close(id);
    const was = this.managers.isManager(id) || this.prefs.isJarvisChat(id);
    this.managers.remove(id);
    this.prefs.removeChatId(id);
    this.events.forget(id);
    this.driver.release(id);
    if (was) this.changed();
  }
}
