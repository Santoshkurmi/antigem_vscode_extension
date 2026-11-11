// "Your chat needs you": follows the chats the user sends from AntiGem and tells them when one finishes, stops with an
// error, asks for a permission or asks a question — unless they are looking at that chat. Agent-neutral: it only reads
// the ChatState every backend gives (isStreaming, approvals, question, queued, messages).
import type { AgentKind } from '../../shared/model';
import type { AgentBackend, ChatState } from './types';

export type ChatAlertKind = 'done' | 'error' | 'approval' | 'question';

export interface ChatAlert {
  kind: ChatAlertKind;
  conversationId: string;
  agent: AgentKind;
  /** "Claude Code finished" */
  title: string;
  /** The chat's title, then what happened (the reply's first words, the command it wants to run…), one per line. */
  body: string;
}

export interface NotifyPrefs {
  /** A reply finished (or the chat stopped with an error). */
  done: boolean;
  /** A permission request or a question. */
  waiting: boolean;
  /** The desktop's own notification when VS Code is not the focused window. */
  system: boolean;
  /** A VS Code pop-up when VS Code is focused but the chat is not on screen. */
  inApp: boolean;
  /** The count on the AntiGem icon (chats that need a look). */
  badge: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { done: true, waiting: true, system: true, inApp: true, badge: true };

export interface NotifierDeps {
  backend(kind: AgentKind): AgentBackend | undefined;
  chatTitle(id: string): string;
  /** The user has this chat on screen right now (VS Code focused, a visible view shows it). */
  isWatching(id: string): boolean;
  windowFocused(): boolean;
  prefs(): NotifyPrefs;
  /** The desktop notification; false when it could not be shown (then the VS Code pop-up is used). */
  system?(alert: ChatAlert): Promise<boolean>;
  inApp?(alert: ChatAlert): void;
  setBadge?(count: number, tooltip: string): void;
  log(line: string): void;
}

export const AGENT_NAMES: Record<AgentKind, string> = { AGY: 'Antigravity', CLAUDE: 'Claude Code', CODEX: 'Codex', OPENCODE: 'OpenCode' };

/** Idle this long (and still idle) = the turn is over; agents go briefly idle between steps. */
const SETTLE_MS = 1500;
/** A chat that never started working after a send (the send failed, a local slash command) is let go. */
const NEVER_STARTED_MS = 3 * 60_000;

interface Tracked {
  agent: AgentKind;
  unsub: (() => void) | null;
  /** It worked since the send: going idle now ends the turn. */
  sawRunning: boolean;
  /** The user pressed stop: the turn ends without a "finished". */
  stopped: boolean;
  /** Approvals / questions already told about (by key). */
  alerted: Set<string>;
  settle?: NodeJS.Timeout;
  giveUp?: NodeJS.Timeout;
  last: ChatState | null;
}

const running = (s: ChatState) => s.isStreaming || !!s.messages[s.messages.length - 1]?.isStreaming || !!s.conversation?.isRunning;
const waiting = (s: ChatState | null) => !!s && (s.approvals.length > 0 || !!s.question);

/** A reply's first words for a notification: no code blocks, thoughts, tags or markdown marks. */
export function replyPreview(text: string, max = 150): string {
  const t = text
    .replace(/<(!--\s*)?thought[\s\S]*?(<\/thought>|-->|$)/g, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export class ChatNotifier {
  private chats = new Map<string, Tracked>();
  /** Chats that told the user something they have not looked at yet (the icon's count). */
  private unread = new Map<string, ChatAlert>();

  constructor(private d: NotifierDeps) {}

  /** The user sent a message in this chat (from a view of this window): follow it until the turn is over. */
  track(conversationId: string, agent: AgentKind) {
    let t = this.chats.get(conversationId);
    if (!t) {
      const backend = this.d.backend(agent);
      if (!backend) return;
      t = { agent, unsub: null, sawRunning: false, stopped: false, alerted: new Set(), last: null };
      this.chats.set(conversationId, t);
      t.unsub = backend.subscribe(conversationId, (s) => this.onState(conversationId, s));
    }
    t.stopped = false;
    // they are in this chat: what it told them before is read
    this.markRead(conversationId);
    clearTimeout(t.giveUp);
    const tr = t;
    tr.giveUp = setTimeout(() => {
      if (!tr.sawRunning && !waiting(tr.last)) this.untrack(conversationId);
    }, NEVER_STARTED_MS);
  }

  /** The user pressed stop: no "finished" for this turn. */
  stopped(conversationId: string) {
    const t = this.chats.get(conversationId);
    if (t) t.stopped = true;
  }

  /** Visibility / focus changed, or a view opened a chat: what is on screen now is read. */
  seen() {
    let changed = false;
    for (const id of [...this.unread.keys()])
      if (this.d.isWatching(id)) {
        this.unread.delete(id);
        changed = true;
      }
    if (changed) this.pushBadge();
  }

  /** The notification settings changed: the icon's count follows (off = no count). */
  refreshBadge() {
    if (!this.d.prefs().badge) this.unread.clear();
    this.pushBadge();
  }

  markRead(conversationId: string) {
    if (this.unread.delete(conversationId)) this.pushBadge();
  }

  /** Settings → Notifications → "Send a test notification": how it went, for a toast. */
  async test(): Promise<string> {
    const p = this.d.prefs();
    const alert: ChatAlert = {
      kind: 'done',
      conversationId: '',
      agent: 'CLAUDE',
      title: 'AntiGem notifications work',
      body: 'This is how a finished chat is announced.',
    };
    if (p.system && this.d.system && (await this.d.system(alert))) return 'Sent a system notification';
    if (this.d.inApp) {
      this.d.inApp(alert);
      return p.system ? 'System notifications are not available here: showed a VS Code pop-up instead' : 'Showed a VS Code pop-up (system notifications are off)';
    }
    return 'Notifications are not available here';
  }

  dispose() {
    for (const id of [...this.chats.keys()]) this.untrack(id);
  }

  // ------------------------------------------------------------------------------------------------

  private onState(id: string, s: ChatState) {
    const t = this.chats.get(id);
    if (!t) return;
    t.last = s;
    if (running(s)) {
      t.sawRunning = true;
      clearTimeout(t.settle);
      t.settle = undefined;
    }
    const chat = this.d.chatTitle(id);
    const name = AGENT_NAMES[t.agent] ?? t.agent;
    for (const a of s.approvals) {
      if (t.alerted.has(`a:${a.key}`)) continue;
      t.alerted.add(`a:${a.key}`);
      const what = [a.title, a.target || a.subtitle].filter(Boolean).join(': ');
      this.alert({ kind: 'approval', conversationId: id, agent: t.agent, title: `${name} needs your permission`, body: lines(chat, what) });
    }
    if (s.question && !t.alerted.has(`q:${s.question.key}`)) {
      t.alerted.add(`q:${s.question.key}`);
      const q = s.question.questionnaire;
      const what = q.questions[0]?.prompt || q.title;
      this.alert({ kind: 'question', conversationId: id, agent: t.agent, title: `${name} has a question`, body: lines(chat, what) });
    }
    // the turn is over: worked, now idle, nothing asked, nothing queued to send next — and it stays so for a moment
    if (t.sawRunning && !running(s) && !waiting(s) && !s.queued.length && !t.settle) {
      t.settle = setTimeout(() => {
        t.settle = undefined;
        const now = t.last;
        if (!now || running(now) || waiting(now) || now.queued.length) return;
        this.finish(id, t, now);
      }, SETTLE_MS);
    }
  }

  private finish(id: string, t: Tracked, s: ChatState) {
    this.untrack(id);
    if (t.stopped) return;
    const name = AGENT_NAMES[t.agent] ?? t.agent;
    const chat = this.d.chatTitle(id);
    if (s.error) {
      this.alert({ kind: 'error', conversationId: id, agent: t.agent, title: `${name} stopped with an error`, body: lines(chat, replyPreview(s.error)) });
      return;
    }
    const reply = [...s.messages].reverse().find((m) => m.role === 'ASSISTANT' && m.content.trim());
    this.alert({ kind: 'done', conversationId: id, agent: t.agent, title: `${name} finished`, body: lines(chat, reply ? replyPreview(reply.content) : '') });
  }

  private untrack(id: string) {
    const t = this.chats.get(id);
    if (!t) return;
    this.chats.delete(id);
    clearTimeout(t.settle);
    clearTimeout(t.giveUp);
    t.unsub?.();
  }

  private alert(a: ChatAlert) {
    const p = this.d.prefs();
    if ((a.kind === 'done' || a.kind === 'error') && !p.done) return;
    if ((a.kind === 'approval' || a.kind === 'question') && !p.waiting) return;
    // on screen: they see it happen
    if (this.d.isWatching(a.conversationId)) return;
    if (p.badge) {
      this.unread.set(a.conversationId, a);
      this.pushBadge();
    }
    if (!this.d.windowFocused() && p.system && this.d.system) {
      void this.d.system(a).then((ok) => {
        if (!ok && p.inApp) this.d.inApp?.(a);
      });
      return;
    }
    if (p.inApp) this.d.inApp?.(a);
  }

  private pushBadge() {
    if (!this.d.setBadge) return;
    const list = [...this.unread.values()];
    const tip = list.length === 1 ? `${list[0].title} · ${this.d.chatTitle(list[0].conversationId)}` : `${list.length} chats need a look`;
    this.d.setBadge(this.d.prefs().badge ? list.length : 0, tip);
  }
}

function lines(...parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join('\n');
}
