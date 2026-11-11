// The brain of Jarvis in the host (port of the text-chat parts of the app's JarvisController.kt): approvals and
// questions of the chats Jarvis runs (permission loop with the risk rules and the user's policy, question loop),
// task news, the hidden note in front of every message to a Jarvis chat, starting Jarvis chats, driving other chats
// for the user, notices, the activity log and timers. Everything voice (listening, speaking, wake phrase) is left out.
import type { AgentKind, ChoiceQuestion, ChoiceQuestionnaire } from '../../../shared/model';
import type { ApprovalView, JarvisLogEntry, JarvisNoticeView } from '../../../shared/protocol';
import { hiddenBlock } from '../text';
import { baseName } from '../paths';
import type { KeyValueStore } from '../types';
import type { JarvisEngine } from './engine';
import { newEvent } from './events';
import type { Perm, Risk, Task } from './types';

const LOG_KEY = 'jarvis.log';
const LOG_KEEP = 500;

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch']);
const RISKY_BASH =
  /\brm\s|\bsudo\b|git\s+push|git\s+reset\s+--hard|git\s+clean|\bmkfs|\bdd\s+if=|chmod\s+-R|chown\s|(curl|wget)[^|]*\|\s*(sh|bash)|:\(\)\s*\{|\bpkill\b|kill\s+-9|drop\s+table|npm\s+publish|--force|\bformat\b|>\s*\/(dev|etc|usr)/;
const READ_BASH = /^\s*(ls|cat|pwd|echo|head|tail|wc|grep|rg|find|which|date|whoami|df|du|ps|stat|file|tree|git\s+(status|log|diff|branch|show|remote))\b/;
const UNSAFE_IN_READ = /[>;&]|\b(rm|mv|cp|sh|bash|xargs|sudo|tee|dd)\b|-delete|-exec/;
const SKIP_WORDS = /\b(skip|cancel|never ?mind|you decide|up to you|whatever|don'?t care|your call)\b/i;
const NUMBER_WORDS: Record<string, number> = { one: 1, first: 1, '1': 1, two: 2, second: 2, '2': 2, three: 3, third: 3, '3': 3, four: 4, fourth: 4, '4': 4, five: 5, fifth: 5, '5': 5, six: 6, sixth: 6, '6': 6 };

export function bashRisk(cmd: string | null | undefined): Risk {
  const c = cmd ?? '';
  if (RISKY_BASH.test(c)) return 'RISKY';
  if (READ_BASH.test(c) && !UNSAFE_IN_READ.test(c)) return 'READ';
  return 'NORMAL';
}

/** Jarvis' own tools (any agent's naming) never need the user. */
export function isJarvisTool(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('mcp__jarvis_mcp') || n.startsWith('mcp_jarvis_mcp') || n.startsWith('jarvis_mcp') || n.startsWith('jarvis_') || n.includes('mcp · jarvis_mcp');
}

/** The command an approval card shows ("$ npm test" → "npm test"). */
function commandOf(a: ApprovalView): string {
  const p = a.preview ?? '';
  return p.startsWith('$ ') ? p.slice(2).split('\n')[0] : p.split('\n')[0];
}

const base = (p: string | null | undefined) => (p ? baseName(p) : '');

/** An approval card as Jarvis sees it: what it wants (one line), the tool, the risk. */
export function describeApproval(a: ApprovalView): { tool: string; summary: string; risk: Risk } {
  const tool = a.subtitle?.trim() || a.title;
  const hay = `${a.subtitle ?? ''} ${a.title} ${a.target ?? ''}`;
  if (isJarvisTool(tool) || /jarvis_mcp|\bjarvis_[a-z_]+/.test(hay)) return { tool: tool || 'jarvis_mcp', summary: `use the Jarvis tool ${tool}`, risk: 'READ' };
  switch (a.icon) {
    case 'terminal': {
      const cmd = commandOf(a);
      return { tool: tool || 'Bash', summary: `run the command: ${cmd.slice(0, 140)}`, risk: bashRisk(cmd) };
    }
    case 'edit':
      return { tool, summary: `edit ${base(a.target) || 'files'}`, risk: 'NORMAL' };
    case 'file': {
      const read = READ_TOOLS.has(tool) || /^(read|list|glob|grep)$/i.test(tool) || /^read|outside/i.test(a.title);
      return read ? { tool, summary: `read ${base(a.target) || 'a file'}`, risk: 'READ' } : { tool, summary: `write ${base(a.target) || 'a file'}`, risk: 'NORMAL' };
    }
    case 'web':
      return { tool, summary: `open ${a.target || (a.preview ?? '').split('\n')[0] || 'a web page'}`, risk: READ_TOOLS.has(tool) || /websearch|webfetch/i.test(tool) ? 'READ' : 'NORMAL' };
    case 'plan':
      return { tool: 'ExitPlanMode', summary: 'start working on its plan', risk: 'NORMAL' };
    case 'mcp':
      return { tool, summary: `use the tool ${tool.replace(/^mcp__/, '').replace(/__/g, ' ')}`, risk: 'NORMAL' };
    default:
      return { tool, summary: `${a.title.replace(/\?$/, '')}${a.target ? ` (${a.target})` : ''}`.slice(0, 160), risk: 'NORMAL' };
  }
}

export class Controller {
  private handledPermissions = new Set<string>();
  private handledQuestions = new Set<string>();
  private noticeList: JarvisNoticeView[] = [];
  private noticeSeq = 0;
  private logList: JarvisLogEntry[];
  private logTimer: NodeJS.Timeout | null = null;
  private timerList: { id: number; label: string; endsAt: number; handle: NodeJS.Timeout }[] = [];
  private timerSeq = 0;
  private toolsMissing = new Set<string>();
  /** "<chat id>|<hash>": the Jarvis chats that already know the current persona and notes. */
  private profileSent: Record<string, string>;

  constructor(
    private j: JarvisEngine,
    private store: KeyValueStore,
  ) {
    const raw = store.get<JarvisLogEntry[]>(LOG_KEY);
    this.logList = Array.isArray(raw) ? raw.slice(-LOG_KEEP) : [];
    this.profileSent = store.get<Record<string, string>>('jarvis.profileSent') ?? {};
  }

  // ------------------------------------------------------------------ notices, log, timers

  /** A problem or news the user should see (the overlay's notice chip). [action]: what tapping it does. */
  notice(text: string, level: JarvisNoticeView['level'] = 'info', action: JarvisNoticeView['action'] = null, chatId: string | null = null) {
    const n: JarvisNoticeView = { id: `n${++this.noticeSeq}`, text, level, action, chatId, at: Date.now() };
    this.noticeList = [...this.noticeList.filter((x) => x.text !== text), n].slice(-5);
    this.log('notice', text, chatId);
    this.j.changed();
  }

  notices(): JarvisNoticeView[] {
    return this.noticeList;
  }

  dismissNotice(id: string | null | undefined) {
    const before = this.noticeList.length;
    this.noticeList = id ? this.noticeList.filter((n) => n.id !== id) : [];
    if (this.noticeList.length !== before) this.j.changed();
  }

  /** Notices go away by themselves (9 s; 30 s when they offer an action). */
  expireNotices(now: number) {
    const keep = this.noticeList.filter((n) => now - n.at <= (n.action ? 30_000 : 9_000));
    if (keep.length !== this.noticeList.length) {
      this.noticeList = keep;
      this.j.changed();
    }
  }

  log(kind: JarvisLogEntry['kind'], text: string, chatId: string | null = null, taskId: string | null = null) {
    this.logList = [...this.logList, { at: Date.now(), kind, text: text.slice(0, 4000), chatId, taskId }].slice(-LOG_KEEP);
    if (this.logTimer) clearTimeout(this.logTimer);
    this.logTimer = setTimeout(() => {
      this.logTimer = null;
      this.store.set(LOG_KEY, this.logList);
    }, 1200);
    this.j.changed();
  }

  logEntries(): JarvisLogEntry[] {
    return this.logList;
  }

  clearLog() {
    this.logList = [];
    this.store.set(LOG_KEY, []);
    this.j.changed();
  }

  timers() {
    return this.timerList.map(({ id, label, endsAt }) => ({ id, label, endsAt }));
  }

  addTimer(seconds: number, label: string) {
    const item = { id: ++this.timerSeq, label: label.trim(), endsAt: Date.now() + seconds * 1000, handle: null as unknown as NodeJS.Timeout };
    item.handle = setTimeout(() => {
      if (!this.timerList.some((t) => t.id === item.id)) return;
      this.timerList = this.timerList.filter((t) => t.id !== item.id);
      const msg = `Your ${item.label || 'timer'} is done.`;
      this.j.host.broadcast({ type: 'toast', level: 'info', message: `⏰ ${msg}` });
      this.notice(msg, 'info');
    }, seconds * 1000);
    this.timerList = [...this.timerList, item];
    this.j.changed();
    return item;
  }

  cancelTimer(id: number): boolean {
    const t = this.timerList.find((x) => x.id === id);
    if (!t) return false;
    clearTimeout(t.handle);
    this.timerList = this.timerList.filter((x) => x.id !== id);
    this.j.changed();
    return true;
  }

  setToolsMissing(chatId: string, missing: boolean) {
    const had = this.toolsMissing.has(chatId);
    if (missing === had) return;
    if (missing) {
      this.toolsMissing.add(chatId);
      const agent = this.j.managers.of(chatId).agent;
      this.notice(`This Jarvis chat's agent (${agentName(agent)}) has no Jarvis tools yet. Add the Jarvis MCP server: Settings → Jarvis → Setup.`, 'warning', 'setup', chatId);
    } else this.toolsMissing.delete(chatId);
    this.j.changed();
  }

  isToolsMissing(chatId: string) {
    return this.toolsMissing.has(chatId);
  }

  /** A jarvis_mcp tool was called (the tools are connected). */
  onToolCall(caller: string | null) {
    if (caller && this.toolsMissing.delete(caller)) {
      this.noticeList = this.noticeList.filter((n) => !(n.action === 'setup' && n.chatId === caller));
      this.j.changed();
    }
  }

  // ------------------------------------------------------------------ approvals

  /** Everything waiting for approval in the chats Jarvis runs: its tasks and its own Jarvis chats. */
  allPending(): Perm[] {
    const out = new Map<string, Perm>();
    const add = (chatId: string, source: Perm['source'], agent: AgentKind) => {
      const st = this.j.driver.state(chatId);
      for (const a of st?.approvals ?? []) {
        const key = a.key;
        if (out.has(key)) continue;
        const d = describeApproval(a);
        out.set(key, { key, source, chatId, agent, tool: d.tool, summary: d.summary, risk: d.risk, approveChoice: a.primary.id });
      }
    };
    // tasks first: their entry wins
    for (const t of this.j.tasks.active()) add(t.id, 'task', t.agent);
    for (const k of this.j.managers.keys()) add(k, 'manager', this.j.managers.of(k).agent);
    return [...out.values()];
  }

  /** What [caller] may answer of what is waiting (each Jarvis chat answers only for its own tasks). */
  pendingFor(caller: string | null): Perm[] {
    return this.allPending().filter((p) => this.canResolve(p, caller));
  }

  private canResolve(p: Perm, caller: string | null): boolean {
    if (p.source !== 'task' || !caller) return false;
    const t = this.j.tasks.find(p.chatId, true);
    return !!t && this.j.managers.ownerOf(t.owner) === caller;
  }

  private async approve(p: Perm) {
    await this.j.driver.backendOf(p.chatId)?.approval(p.chatId, p.key, p.approveChoice, false);
  }

  private async reject(p: Perm, why: string | null) {
    await this.j.driver.backendOf(p.chatId)?.approval(p.chatId, p.key, undefined, true, why ?? undefined);
  }

  /** New approvals: Jarvis' own tools go through, the policy approves what it allows, the rest goes to the owner. */
  async permissionLoop() {
    const live = this.allPending();
    const keys = new Set(live.map((p) => p.key));
    for (const k of [...this.handledPermissions]) if (!keys.has(k)) this.handledPermissions.delete(k);
    for (const p of live) {
      if (this.handledPermissions.has(p.key)) continue;
      this.handledPermissions.add(p.key);
      try {
        await this.handlePermission(p);
      } catch (e) {
        this.j.logLine(`[jarvis] permission: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async handlePermission(p: Perm) {
    if (p.source === 'manager') {
      // a Jarvis chat is a normal chat: Jarvis' own tools go through, everything else is the user's call
      if (isJarvisTool(p.tool) || p.summary.startsWith('use the Jarvis tool')) {
        await this.approve(p);
        return;
      }
      if (this.j.host.screenChat()?.conversationId !== p.chatId) {
        const title = this.j.host.conversations().find((c) => c.id === p.chatId)?.title?.slice(0, 40) || 'A Jarvis chat';
        this.notice(`“${title}” is waiting for your approval: ${p.summary.slice(0, 90)}`, 'warning', 'chat', p.chatId);
      }
      return;
    }
    const policy = this.j.prefs.get('permissionPolicy');
    const auto =
      isJarvisTool(p.tool) || policy === 'auto_all' || (policy === 'auto_except_risky' && p.risk !== 'RISKY') || (policy === 'auto_readonly' && p.risk === 'READ');
    if (auto) {
      await this.approve(p);
      this.log('approval', `Approved automatically: ${p.summary.slice(0, 120)}`, null, p.chatId);
      return;
    }
    const task = this.j.tasks.find(p.chatId, true);
    const owner = this.j.managers.ownerOf(task?.owner);
    if (task && owner) {
      // the Jarvis chat that runs the task decides
      this.j.events.post(
        owner,
        newEvent('task_approval', { taskId: task.id, title: task.title, agent: task.agent.toLowerCase(), team: task.team, goal: task.goal, body: p.summary, key: p.key, risk: p.risk.toLowerCase() }),
      );
      return;
    }
    // a task whose Jarvis chat is gone: the user decides in that chat
    this.notice(`“${task?.title ?? 'A task'}” is waiting for your approval: ${p.summary.slice(0, 90)}`, 'warning', 'chat', p.chatId);
  }

  /** Approves or rejects waiting requests from a tool call (each Jarvis chat answers only for its own work). */
  async resolve(key: string | null, approve: boolean, all: boolean, reason: string | null, caller: string | null): Promise<string> {
    const every = this.allPending();
    const list = every.filter((p) => this.canResolve(p, caller));
    if (!all && key && !list.some((p) => p.key === key) && every.some((p) => p.key === key)) {
      return "That request belongs to another Jarvis chat's work (or to a Jarvis chat itself): only that chat, or the user, can answer it.";
    }
    const targets = all || !key ? list : list.filter((p) => p.key === key);
    if (!targets.length) return 'Nothing of yours is waiting for approval.';
    for (const p of targets) {
      if (approve) await this.approve(p);
      else await this.reject(p, reason);
      this.log('approval', `${approve ? 'Approved' : 'Rejected'} by Jarvis: ${p.summary.slice(0, 120)}`, caller, p.chatId);
    }
    return `${approve ? 'Approved' : 'Rejected'} ${targets.length} request${targets.length === 1 ? '' : 's'}.`;
  }

  // ------------------------------------------------------------------ questions the task agents ask

  /** A task's questions as plain lines (the body of a question event). */
  private questionBody(qn: ChoiceQuestionnaire): string {
    let s = '';
    qn.questions.forEach((q, i) => {
      s += `${i + 1}. ${q.prompt.trim()}`;
      const opts = q.options.filter((o) => !o.isCustomInput);
      if (opts.length) s += ` Options: ${opts.map((o, j) => `${j + 1}) ${o.label.trim()}`).join('; ')}`;
      if (q.isMultiSelect) s += ' (several allowed)';
      s += '\n';
    });
    return `${s}Answer with jarvis_task_answer (for several questions separate the answers with ';').`;
  }

  /** New questions of tasks go to the Jarvis chat that runs the task. */
  questionLoop() {
    const live = new Set<string>();
    for (const t of this.j.tasks.active()) {
      const q = this.j.driver.state(t.id)?.question;
      if (!q) continue;
      const key = `${t.id}|${q.key}`;
      live.add(key);
      if (this.handledQuestions.has(key)) continue;
      this.handledQuestions.add(key);
      const owner = this.j.managers.ownerOf(t.owner);
      if (!owner) {
        this.notice(`“${t.title}” asks a question: open its chat to answer.`, 'warning', 'chat', t.id);
        continue;
      }
      this.j.events.post(owner, newEvent('task_question', { taskId: t.id, title: t.title, agent: t.agent.toLowerCase(), team: t.team, goal: t.goal, body: this.questionBody(q.questionnaire) }));
    }
    for (const k of [...this.handledQuestions]) if (!live.has(k)) this.handledQuestions.delete(k);
  }

  private pickOptions(answer: string, q: ChoiceQuestion): { ids: string[]; labels: string[]; write: string | null } {
    const a = answer.toLowerCase();
    const words: string[] = a.match(/[a-z0-9']+/g) ?? [];
    const opts = q.options.filter((o) => !o.isCustomInput);
    const picked: typeof opts = [];
    const pick = (o: (typeof opts)[number]) => {
      if (!picked.includes(o)) picked.push(o);
    };
    for (const w of words) {
      const i = NUMBER_WORDS[w];
      if (i && opts[i - 1]) pick(opts[i - 1]);
    }
    for (const o of opts) {
      const label = o.label.toLowerCase();
      const sig: string[] = (label.match(/[a-z0-9']+/g) ?? []).filter((x) => x.length > 3);
      if (label.trim() && (a.includes(label) || (sig.length && sig.filter((x) => words.includes(x)).length * 2 >= sig.length))) pick(o);
    }
    if (q.isMultiSelect && (words.includes('all') || words.includes('everything'))) opts.forEach(pick);
    const selected = q.isMultiSelect ? picked : picked.slice(0, 1);
    const write = !selected.length && (q.allowCustomAnswer || !opts.length) ? answer.trim() : null;
    return { ids: selected.map((o) => o.id), labels: selected.map((o) => o.label), write };
  }

  /** Answers the question a task is asking (jarvis_task_answer). */
  async answerTaskQuestion(id: string, answer: string): Promise<string> {
    const st = this.j.driver.state(id);
    const q = st?.question;
    if (!q) return 'That task is not asking anything right now.';
    const b = this.j.driver.backendOf(id);
    if (!b) return 'That task is not asking anything right now.';
    const a = answer.trim();
    if (!a) return 'The answer is empty.';
    if (SKIP_WORDS.test(a)) {
      await b.answer(id, q.key, {}, undefined, true);
      this.handledQuestions.add(`${id}|${q.key}`);
      return 'Told it to use its best judgement.';
    }
    const qs = q.questionnaire.questions;
    const parts = qs.length > 1 ? a.split(/[;|]/).map((x) => x.trim()).filter(Boolean) : [a];
    const answers: Record<string, string[]> = {};
    const summary: string[] = [];
    qs.forEach((qq, i) => {
      const r = this.pickOptions(parts[i] ?? parts[parts.length - 1] ?? a, qq);
      // a typed answer travels like the view's "Other…" text (the backends take it as the answer itself)
      answers[qq.id] = r.write ? [r.write] : r.ids;
      summary.push([...r.labels, ...(r.write ? [r.write] : [])].join(', '));
    });
    await b.answer(id, q.key, answers, undefined, false);
    this.handledQuestions.add(`${id}|${q.key}`);
    return `Answered: ${summary.join('; ')}.`;
  }

  // ------------------------------------------------------------------ task news

  /**
   * News from a task: "done", "failed" or "stalled". The Jarvis chat that started the task gets it (batched with
   * whatever else came in, see events.ts) and decides what to say and do; with event routing "speak" ("just tell
   * me") it only shows as a notice, without a model turn.
   */
  onTaskEvent(t: Task, kind: 'done' | 'failed' | 'stalled', detail: string) {
    const owner = this.j.managers.ownerOf(t.owner);
    const line = (kind === 'done' ? `Done: ${t.title}` : kind === 'failed' ? `Failed: ${t.title}` : `Stuck: ${t.title}`).slice(0, 60);
    this.log('task', kind === 'done' ? `Finished "${t.title}"` : kind === 'failed' ? `"${t.title}" failed: ${detail.slice(0, 120)}` : `"${t.title}" shows no progress`, owner, t.id);
    if (owner) this.j.managers.setStatus(owner, line);
    if (owner && this.j.prefs.get('eventRouting') !== 'speak') {
      this.j.events.post(owner, newEvent(`task_${kind}`, { taskId: t.id, title: t.title, agent: t.agent.toLowerCase(), team: t.team, goal: t.goal, body: detail, replyChars: kind === 'done' ? t.resultChars : 0 }));
      return;
    }
    const msg = kind === 'done' ? `${t.title} is done.` : kind === 'failed' ? `${t.title} ran into a problem.${detail ? ` ${firstSentence(detail, 140)}` : ''}` : `${t.title} hasn't made progress for a while.`;
    this.notice(msg, kind === 'done' ? 'info' : 'warning', 'chat', t.id);
  }

  // ------------------------------------------------------------------ messages to a Jarvis chat

  /** The user's message to a Jarvis chat with its hidden note in front (the guide on its first message, then the rules). */
  wrapManagerMessage(chatId: string, text: string): string {
    const m = this.j.managers.of(chatId);
    const version = this.j.skill.managerVersion();
    const boot = m.bootFor !== version;
    const ctx = this.j.prefs.get('contextInPrompt') || boot ? this.j.skill.liveContext('typed in the chat', chatId) : '';
    let note = boot ? this.j.skill.managerBootPack(chatId, ctx) : this.j.skill.managerPreamble(chatId, ctx);
    // the user changed the persona or their notes in Settings since this chat was told: tell it once
    const ph = this.j.skill.profileHash();
    if (!boot && this.profileSent[chatId] && this.profileSent[chatId] !== ph) {
      note += `\n\n[Updated by the user in Settings → Jarvis, follow from now on]\n${this.j.skill.profileSection() ?? 'The persona and the notes about the user were cleared: drop what they said.'}`;
    }
    this.profileSent = { ...this.profileSent, [chatId]: ph };
    this.store.set('jarvis.profileSent', this.profileSent);
    const guard = this.j.events.takeGuardNote(chatId);
    this.j.managers.update(chatId, (x) => ({ ...x, bootFor: version, lastSentAt: Date.now() }));
    this.j.managers.resetNudges(chatId);
    return hiddenBlock(note + (guard ? `\n<app_note>\n${guard}\n</app_note>` : '')) + text;
  }

  /** "New Jarvis chat": the agent (and model) a new Jarvis chat starts with. */
  newChatTarget(agent: AgentKind | null | undefined): { agent: AgentKind; modelId: string | null } | string {
    const enabled = this.j.host.enabledKinds();
    if (!enabled.length) return 'Turn on an agent first (Settings → Agents).';
    const remembered = this.j.prefs.get('textChatAgent') as AgentKind | '';
    const picked = this.j.prefs.agentKind();
    const a = agent ?? [picked, remembered || null, this.j.host.defaultAgent()].find((x): x is AgentKind => !!x && enabled.includes(x)) ?? enabled[0];
    if (!enabled.includes(a)) return 'That agent is turned off (Settings → Agents).';
    this.j.prefs.set('textChatAgent', a);
    const model = picked === a && this.j.prefs.get('modelId') ? this.j.prefs.get('modelId') : null;
    return { agent: a, modelId: model };
  }

  // ------------------------------------------------------------------ chats Jarvis drives for the user

  /** Sends [text] to an existing chat by id; the chat becomes a watched task. Does not change the chat on screen. */
  async sendToChat(id: string, text: string, owner: string): Promise<string> {
    if (this.j.managers.isManager(id) || this.j.prefs.isJarvisChat(id)) return 'That is a Jarvis chat, not a work chat.';
    if (this.j.tasks.isTask(id)) return this.j.tasks.reply(id, text, false);
    if (this.j.driver.isBusy(id)) return 'That chat is busy working, so nothing was sent. Do not interrupt it: handle the request yourself, or ask the user.';
    const agent = this.j.driver.agentOf(id);
    if (!agent) return 'No chat with that id. Use jarvis_list_chats.';
    this.j.tasks.adopt(id, agent, text, owner);
    return this.j.tasks.reply(id, text, false);
  }

  async stopChat(id: string): Promise<string> {
    if (!id) return 'No chat.';
    if (this.j.tasks.isTask(id)) return this.j.tasks.stop(id);
    try {
      await this.j.driver.stop(id);
      return 'Stopped.';
    } catch (e) {
      return `Could not stop: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Sets the model of a chat. Applies to its next message. */
  setChatModel(id: string, kind: AgentKind, modelId: string) {
    this.j.host.backend(kind)?.selectModel(id, modelId);
  }

  dispose() {
    for (const t of this.timerList) clearTimeout(t.handle);
    this.timerList = [];
    if (this.logTimer) {
      clearTimeout(this.logTimer);
      this.store.set(LOG_KEY, this.logList);
    }
  }
}

export function agentName(a: AgentKind): string {
  return a === 'CLAUDE' ? 'Claude Code' : a === 'OPENCODE' ? 'OpenCode' : a === 'CODEX' ? 'Codex' : 'Antigravity';
}

function firstSentence(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = /[.!?](\s|$)/.exec(flat);
  const end = m ? m.index + 1 : flat.length;
  return flat.slice(0, Math.min(end, max)).trim();
}
