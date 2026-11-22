// The Crew's Inbox (docs/crew/PLAN.md §11): one list of everything waiting on the user, from every bot — permission
// requests the access broker could not settle (rooms, jobs, DMs), jobs that ask a question (NEEDS INPUT) or failed,
// and setup questions (add AntiGem's crew server to Antigravity?). Every view gets it (docked in the Crew screens);
// a new item pops a toast when it is not in a chat the user is looking at; the status bar says "Crew: 2 working · 1
// needs you".
import type { AgentKind } from '../../../shared/model';
import type { CrewStatusView, HostToView, InboxItemView } from '../../../shared/protocol';
import type { AgentBackend, ChatState, CrewAccess } from '../types';
import { AccessBroker, type InboxChoice, type InboxItem } from './access/broker';
import type { JobRuntime } from './jobs/runtime';
import { shortId } from './jobs/prompts';
import type { BotLocks } from './locks';
import type { CrewStore } from './store/store';
import type { BotProfile, ThreadRecord } from './types';

export interface InboxDeps {
  store: CrewStore;
  jobs(): JobRuntime;
  locks: BotLocks;
  showChat(chatId: string, engine: AgentKind): void;
  /** A toast with an Open button (VS Code), or a desktop notification when VS Code is not focused. */
  notify?(text: string, open: () => void): void;
  /** The status bar ("Crew: 2 working · 1 needs you"; null text = hide it). */
  status?(s: CrewStatusView, text: string | null): void;
  /** Shows the Crew screen (the Inbox is docked at its top). */
  openCrew?(): void;
  /** Crew settings changed (the Crew screen redraws). */
  changed(): void;
}

const DAY = 24 * 3600_000;

export class CrewInbox {
  readonly broker: AccessBroker;
  private views = new Map<string, (m: HostToView) => void>();
  private timer: NodeJS.Timeout | null = null;
  private agyAsk: { cancel(): void } | null = null;
  /** Job items already toasted. */
  private told = new Set<string>();
  private lastStatus = '';

  constructor(private deps: InboxDeps) {
    this.broker = new AccessBroker(deps.store.root);
    this.broker.onChange = () => this.emit();
    this.broker.onNew = (item) => {
      if (item.inChat) return;
      const b = item.botId ? deps.store.bot(item.botId) : null;
      deps.notify?.(`${b ? `${b.emoji} ${b.name}` : 'Your crew'} needs you: ${item.title}`, () => deps.openCrew?.());
    };
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.agyAsk?.cancel();
  }

  watch(viewId: string, post: (m: HostToView) => void, open: boolean) {
    if (!open) {
      this.views.delete(viewId);
      return;
    }
    this.views.set(viewId, post);
    post({ type: 'crewInbox', items: this.items(), status: this.status() });
  }

  forget(viewId: string) {
    this.views.delete(viewId);
  }

  /** Something changed (an item, a job, a busy bot): views and the status bar follow (≤ 7/s). */
  emit() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const items = this.items();
      const status = this.status(items);
      for (const post of this.views.values()) post({ type: 'crewInbox', items, status });
      const text = status.paused ? 'Crew: paused' : status.working || status.needsYou ? [status.working && `${status.working} working`, status.needsYou && `${status.needsYou} need${status.needsYou === 1 ? 's' : ''} you`].filter(Boolean).join(' · ') : null;
      const line = text && !text.startsWith('Crew') ? `Crew: ${text}` : text;
      if (line !== this.lastStatus) {
        this.lastStatus = line ?? '';
        this.deps.status?.(status, line);
      }
      // jobs that started asking or failed: one toast each
      for (const it of items) {
        if ((it.kind === 'question' || it.kind === 'failed') && !this.told.has(it.id)) {
          this.told.add(it.id);
          this.deps.notify?.(`${it.bot ? `${it.bot.emoji} ${it.bot.name}` : 'A bot'} ${it.kind === 'question' ? 'asks' : 'failed'}: ${it.title}`, () => this.deps.openCrew?.());
        }
      }
    }, 150);
  }

  status(items = this.items()): CrewStatusView {
    const bots = this.deps.store.bots();
    return { working: bots.filter((b) => this.deps.locks.busy(b.id)).length, needsYou: items.length, paused: this.deps.store.settings().paused };
  }

  /** Broker items, then jobs that ask or failed (the last day, not dismissed). */
  items(): InboxItemView[] {
    const bots = new Map(this.deps.store.bots().map((b) => [b.id, b]));
    const face = (id: string | null) => {
      const b = id ? bots.get(id) : undefined;
      return b ? { id: b.id, name: b.name, emoji: b.emoji, color: b.color } : null;
    };
    const out: InboxItemView[] = this.broker.list().map((i) => ({
      id: i.id,
      kind: i.kind,
      bot: face(i.botId),
      title: i.title,
      why: i.why,
      detail: i.detail,
      outward: i.outward,
      risk: i.risk,
      key: i.key,
      choices: i.choices,
      canOpen: !!i.chat,
      jobId: null,
      inChat: i.inChat,
      createdAt: i.createdAt,
    }));
    const since = Date.now() - DAY;
    const jobs = this.deps.jobs().store.all();
    for (const j of jobs) {
      if ((!j.parentId && !j.goal) || j.updatedAt < since) continue;
      const root = jobs.find((r) => r.id === j.rootId);
      const from = j.requester.botId ? bots.get(j.requester.botId) : null;
      const why = `${from ? `for ${from.name}'s job` : 'a job'} ${shortId(j.id)}${j.title ? ` "${j.title}"` : ''}`;
      if (j.status === 'needs_input') {
        out.push({ id: `job:${j.id}`, kind: 'question', bot: face(j.assignee.botId), title: j.question ?? 'a question', why, detail: j.brief.slice(0, 600), outward: false, risk: null, key: null, choices: ['answer'], canOpen: !!j.assignee.threadId, jobId: j.id, inChat: false, createdAt: j.updatedAt });
      } else if (j.status === 'failed' && !j.dismissed && root?.status !== 'cancelled') {
        out.push({ id: `job:${j.id}`, kind: 'failed', bot: face(j.assignee.botId), title: j.outcome ?? 'it failed', why, detail: j.brief.slice(0, 600), outward: false, risk: null, key: null, choices: ['retry', 'dismiss'], canOpen: !!j.assignee.threadId, jobId: j.id, inChat: false, createdAt: j.updatedAt });
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** An Inbox button. */
  answer(id: string, choice: string, note?: string | null): string | void {
    if (id.startsWith('job:')) {
      const jobId = id.slice(4);
      const jobs = this.deps.jobs();
      if (choice === 'answer') return jobs.answer(null, jobId, String(note ?? ''));
      if (choice === 'retry') {
        jobs.retry(jobId);
        return 'Running it again';
      }
      if (choice === 'dismiss') {
        const j = jobs.store.get(jobId);
        if (j) {
          j.dismissed = true;
          jobs.store.put(j);
        }
        this.emit();
        return;
      }
      if (choice === 'open') {
        const t = jobs.threadOf(jobId);
        if (t?.chatId) this.deps.showChat(t.chatId, t.engine);
        return;
      }
      throw new Error(`Unknown answer ${choice}`);
    }
    if (choice === 'open') {
      const it = this.broker.list().find((x) => x.id === id);
      if (it?.chat) this.deps.showChat(it.chat.chatId, it.chat.engine);
      return;
    }
    if (!this.broker.answer(id, { choice: choice as InboxChoice, note })) return 'It was answered already.';
  }

  // ------------------------------------------------------------------ Antigravity's crew server

  /** An Antigravity bot is about to run and the user has not decided: ask once (it runs without crew tools meanwhile). */
  askAgyServer() {
    if (this.agyAsk || this.deps.store.settings().agyCrewServer !== 'ask') return;
    const a = this.broker.ask({
      kind: 'setup',
      botId: null,
      title: 'Add the AntiGem Crew server to Antigravity?',
      why: "Antigravity bots get their crew tools (crew_roster, crew_assign…) only through one entry in Antigravity's own MCP servers (mcp_config.json): \"antigem_crew\". Until then they work without them.",
      detail: null,
      tool: null,
      key: null,
      outward: false,
      risk: null,
      chat: null,
      inChat: false,
      choices: ['add', 'later'],
    });
    this.agyAsk = a;
    void a.promise.then((ans) => {
      this.agyAsk = null;
      this.setAgyServer(ans.choice === 'add');
    });
  }

  setAgyServer(allow: boolean) {
    const s = this.deps.store.settings();
    this.deps.store.saveSettings({ ...s, agyCrewServer: allow ? 'allowed' : 'declined' });
    if (this.agyAsk) {
      this.agyAsk.cancel();
      this.agyAsk = null;
    }
    this.deps.changed();
    this.emit();
  }

  // ------------------------------------------------------------------ DMs

  /**
   * A DM turn's permission requests: settled by the bot's level and rules, else an Inbox item (the card stays in the
   * chat too; answering either one settles both). Returns the poll and the stop of this turn.
   */
  dmTurn(t: ThreadRecord, be: AgentBackend, bot: BotProfile, access: CrewAccess, folders: string[]): { poll(s: ChatState | null): void; stop(): void } {
    const handled = new Set<string>();
    const asking = new Map<string, () => void>();
    const poll = (s: ChatState | null) => {
      if (!s || !t.chatId) return;
      for (const a of s.approvals) {
        if (handled.has(a.key)) continue;
        handled.add(a.key);
        const r = this.broker.approve({ botId: bot.id, access, approval: a, folders, where: 'in its DM', chat: { engine: t.engine, chatId: t.chatId }, inChat: true });
        if ('wait' in r) {
          asking.set(a.key, r.cancel);
          void r.wait.then((x) => {
            if (!asking.delete(a.key)) return;
            void be.approval(t.chatId!, a.key, x.allow ? a.primary.id : undefined, !x.allow, x.allow ? undefined : x.note).catch(() => undefined);
          });
        } else void be.approval(t.chatId, a.key, r.allow ? a.primary.id : undefined, !r.allow, r.allow ? undefined : r.note).catch(() => undefined);
      }
      for (const [k, cancel] of asking) {
        if (!s.approvals.some((a) => a.key === k)) {
          cancel();
          asking.delete(k);
        }
      }
    };
    const stop = () => {
      for (const c of asking.values()) c();
      asking.clear();
    };
    return { poll, stop };
  }
}
