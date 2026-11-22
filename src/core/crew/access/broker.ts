// The access broker and the Inbox (docs/crew/PLAN.md §11): every crew bot's permission request (rooms, jobs, DMs) is
// decided by policy.ts; what needs the user becomes one Inbox item — the bot's face, what it wants, why ("for Lead's
// job: …", "in #Ops"), Allow once / for this session / always / Deny with a note. A turn waiting on the user is not
// timed out. "Always" rules live in ~/.antigem/crew/access.json (bot + tool key), "this session" ones in memory.
// Other things that need the user are Inbox items too (Antigravity's crew server: ask before adding it).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AgentKind } from '../../../../shared/model';
import type { ApprovalView } from '../../../../shared/protocol';
import { readJson, writeJson } from '../store/fsx';
import type { CrewAccess } from '../types';
import { decide, refusalNote, type Decision } from './policy';

export type InboxChoice = 'allow' | 'allow_session' | 'allow_always' | 'deny' | 'add' | 'later' | 'answer' | 'dismiss';

export interface InboxItem {
  id: string;
  kind: 'approval' | 'setup' | 'question';
  botId: string | null;
  /** What it wants, one line ("run the command: git push"). */
  title: string;
  /** Where and why it asks ("in #Ops · it reaches outside"). */
  why: string;
  /** The command / diff / text to look at. */
  detail: string | null;
  tool: string | null;
  /** "Always allow" remembers this. */
  key: string | null;
  outward: boolean;
  risk: string | null;
  /** The chat it comes from (Open). */
  chat: { engine: AgentKind; chatId: string } | null;
  /** A DM's request: its card is in the chat too (answering there clears this). */
  inChat: boolean;
  choices: InboxChoice[];
  createdAt: number;
}

export interface Answer {
  choice: InboxChoice;
  note?: string | null;
}

/** What the turn runner does with a request: answer now, or wait for the user. */
export type ApproveResult = { allow: boolean; note?: string } | { wait: Promise<{ allow: boolean; note?: string }>; cancel(): void };

export interface ApproveInput {
  botId: string;
  access: CrewAccess;
  approval: ApprovalView;
  folders: string[];
  /** "in #Ops", "for Lead's job: write the tests", "in its DM" */
  where: string;
  chat: { engine: AgentKind; chatId: string } | null;
  inChat?: boolean;
}

interface RulesFile {
  always: { botId: string; key: string; at: number }[];
}

export class AccessBroker {
  private items = new Map<string, { item: InboxItem; resolve(a: Answer): void }>();
  private session = new Set<string>();
  /** The list changed (views, status bar). */
  onChange: (() => void) | null = null;
  /** A new item (a toast when the user is not looking). */
  onNew: ((item: InboxItem) => void) | null = null;

  constructor(private root: string) {}

  private file() {
    return path.join(this.root, 'access.json');
  }

  private rulesFile(): RulesFile {
    const raw = readJson<Partial<RulesFile>>(this.file());
    return { always: Array.isArray(raw?.always) ? raw!.always.filter((r) => r && typeof r.botId === 'string' && typeof r.key === 'string') : [] };
  }

  /** A bot's "always allow" keys. */
  rules(botId: string): string[] {
    return this.rulesFile()
      .always.filter((r) => r.botId === botId)
      .map((r) => r.key);
  }

  forget(botId: string, key: string) {
    const f = this.rulesFile();
    writeJson(this.file(), { always: f.always.filter((r) => !(r.botId === botId && r.key === key)) });
    this.session.delete(`${botId}|${key}`);
    this.onChange?.();
  }

  private remember(botId: string, key: string, always: boolean) {
    this.session.add(`${botId}|${key}`);
    if (!always) return;
    const f = this.rulesFile();
    if (!f.always.some((r) => r.botId === botId && r.key === key)) writeJson(this.file(), { always: [...f.always, { botId, key, at: Date.now() }] });
  }

  allowed(botId: string, key: string): boolean {
    return this.session.has(`${botId}|${key}`) || this.rulesFile().always.some((r) => r.botId === botId && r.key === key);
  }

  /** The policy's verdict alone (tests, the DM card). */
  decision(i: ApproveInput): Decision {
    return decide({ access: i.access, approval: i.approval, folders: i.folders, allowed: (k) => this.allowed(i.botId, k) });
  }

  /** A bot's permission request: allowed / refused by its level and your rules, or an Inbox item to wait on. */
  approve(i: ApproveInput): ApproveResult {
    const d = this.decision(i);
    if (d.verdict === 'allow') return { allow: true };
    if (d.verdict === 'deny') return { allow: false, note: refusalNote(i.access, d.reason) };
    const a = i.approval;
    const detail = [a.preview, a.markdown, a.target && !a.preview ? a.target : null].filter((x): x is string => !!x && !!x.trim()).join('\n').slice(0, 4000) || null;
    const { promise, cancel } = this.ask({
      kind: 'approval',
      botId: i.botId,
      title: d.summary,
      why: `${i.where} · ${d.reason}`,
      detail,
      tool: d.tool,
      key: d.key,
      outward: d.outward,
      risk: d.outward ? 'OUTWARD' : d.risk,
      chat: i.chat,
      inChat: !!i.inChat,
      choices: ['allow', 'allow_session', 'allow_always', 'deny'],
    });
    const wait = promise.then((ans) => {
      if (ans.choice === 'deny') return { allow: false, note: refusalNote(i.access, d.reason, ans.note ?? 'no') };
      if (ans.choice === 'allow_session' || ans.choice === 'allow_always') this.remember(i.botId, d.key, ans.choice === 'allow_always');
      return { allow: true };
    });
    return { wait, cancel };
  }

  /** Puts an item in the Inbox; the promise resolves with the user's answer (never, if cancelled). */
  ask(fields: Omit<InboxItem, 'id' | 'createdAt'>): { id: string; promise: Promise<Answer>; cancel(): void } {
    const id = `ib_${randomBytes(5).toString('hex')}`;
    const item: InboxItem = { ...fields, id, createdAt: Date.now() };
    let resolve!: (a: Answer) => void;
    const promise = new Promise<Answer>((r) => (resolve = r));
    this.items.set(id, { item, resolve });
    this.onNew?.(item);
    this.onChange?.();
    return { id, promise, cancel: () => this.cancel(id) };
  }

  /** The user's answer (from the Inbox). */
  answer(id: string, a: Answer): boolean {
    const it = this.items.get(id);
    if (!it) return false;
    if (!it.item.choices.includes(a.choice)) throw new Error(`"${a.choice}" is not an answer to this.`);
    this.items.delete(id);
    it.resolve(a);
    this.onChange?.();
    return true;
  }

  /** It went away (answered in the chat, the turn ended). */
  cancel(id: string) {
    if (this.items.delete(id)) this.onChange?.();
  }

  list(): InboxItem[] {
    return [...this.items.values()].map((x) => x.item).sort((a, b) => a.createdAt - b.createdAt);
  }

  has(pred: (i: InboxItem) => boolean): boolean {
    return this.list().some(pred);
  }
}
