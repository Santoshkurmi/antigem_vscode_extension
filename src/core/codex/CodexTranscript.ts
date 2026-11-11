// One Codex chat (thread) as the chat UI shows it: a port of the app's CodexTranscript.kt.
//
// Codex describes a chat as turns, each a list of items (the user's message, the agent's messages and reasoning,
// commands, file changes, tool calls…). History (`thread/turns/list`) and live events (`item/started`, deltas,
// `item/completed`, `turn/completed`…) fill the same model here, which is rendered into ChatMessages: every user
// message is one message, and the items between two user messages become one assistant message.
//
// Rendering is cached per turn (by a revision bumped on every change), so a turn that did not change keeps the very
// same ChatMessage objects between emits (the host then skips it without serializing it).
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';
import type { ChatAttachment, ChatMessage, ChoiceQuestion, ChoiceQuestionnaire, TokenUsage, ToolCall, ToolType } from '../../../shared/model';
import { displayUserText } from '../text';
import type { CodexTurnMeta } from './client';
import { arr, num, o, obj, str, type J } from './util';

const MAX_OUTPUT = 200_000;
const PLAN_TYPE = '__plan';
const USAGE_KEYS = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
const UNSAFE_ID = /[^A-Za-z0-9_-]/g;
/** Inline previews of images sent by path (a file on this machine), at most this big. */
const MAX_INLINE_IMAGE = 3 * 1024 * 1024;

let revCounter = 0;
const nextRev = () => ++revCounter;

class Item {
  /** agentMessage / plan text (deltas while it streams). */
  text = '';
  /** reasoning summary parts. */
  summary: string[] = [];
  /** raw reasoning text (only some models send it). */
  reasoning = '';
  /** command output while it runs. */
  output = '';
  streaming = false;
  startedAt: number | null = null;
  completedAt: number | null = null;
  /** Bumped on every change of this item (message cache key). */
  rev = nextRev();
  constructor(
    readonly id: string,
    public type: string,
    public json: J,
    readonly owner: Turn,
  ) {}
}

export class Turn {
  readonly items = new Map<string, Item>();
  /** The turn this one belongs to (a review runs as an inner turn of the review/start turn). */
  rootTurnId: string | null = null;
  /** The model that ran this turn (live: the chat's model when it started; history: Codex's record). */
  model: string | null = null;
  status = 'inProgress';
  error: J | null = null;
  startedAt: number | null = null;
  completedAt: number | null = null;
  durationMs: number | null = null;
  /** Codex's todo list for this turn (`turn/plan/updated`): [step, status]. */
  plan: [string, string][] | null = null;
  /** Token use of this turn (live turns only: history has none). */
  usage: TokenUsage | null = null;
  /** Thread total before this turn's first model request. */
  usageBase: Record<string, number> | null = null;
  /** Bumped on every change of the turn or one of its items (turn cache key). */
  rev = nextRev();
  /** Bumped when a field of the turn itself changes (status, error, usage, model, plan…). */
  metaRev = nextRev();
  constructor(readonly id: string) {}
}

/** A prompt sent from this extension that Codex has not shown as a user message yet. */
interface LocalPrompt {
  clientId: string;
  text: string;
  attachmentNames: string[];
  created: number;
  /** Images sent with it, shown as previews until Codex confirms the message. */
  images: ChatAttachment[];
}

/** A question Codex asked (`item/tool/requestUserInput`), answered in the chat's question panel. */
export interface CodexQuestion {
  key: string;
  turnId: string | null;
  questions: J[];
}

/** A field of the turn itself changed. */
const touch = (t: Turn) => {
  t.rev = t.metaRev = nextRev();
};
/** An item changed (its turn's cache too). */
const bump = (it: Item) => {
  it.rev = nextRev();
  it.owner.rev = nextRev();
};

export class CodexTranscript {
  private turns = new Map<string, Turn>();
  private localPrompts = new Map<string, LocalPrompt>();
  private errorCards: { at: number; title: string; message: string }[] = [];
  /** A prompt was sent and its turn has not started yet. */
  private awaitingStart = false;
  /** The model of the chat (Codex does not say per reply). */
  model: string | null = null;

  // render caches
  private turnCache = new Map<string, { key: string; messages: ChatMessage[] }>();
  private localCache = new Map<string, { key: string; message: ChatMessage }>();
  /** Messages of changed turns that did not change themselves keep their object (by message id). */
  private msgCache = new Map<string, { key: string; message: ChatMessage }>();
  private nextMsgCache = new Map<string, { key: string; message: ChatMessage }>();
  private static imageCache = new Map<string, { mtime: number; b64: string | null }>();

  constructor(public threadId = '') {}

  get isTurnActive(): boolean {
    return this.awaitingStart || [...this.turns.values()].some((t) => t.status === 'inProgress');
  }

  /** The running turn's id, if any (steer, interrupt). */
  get activeTurnId(): string | null {
    let id: string | null = null;
    for (const t of this.turns.values()) if (t.status === 'inProgress') id = t.id;
    return id;
  }

  get isEmpty(): boolean {
    return this.turns.size === 0 && this.localPrompts.size === 0;
  }

  get turnCount(): number {
    return this.turns.size;
  }

  // ------------------------------------------------------------------ history

  /** Replaces everything with stored turns (oldest first). `active`: the thread has a turn running. */
  loadHistory(stored: J[], active: boolean) {
    // usage and model of turns seen live survive a reload (history has neither; applyMeta adds Codex's record)
    const previous = new Map(this.turns);
    this.turns = new Map();
    for (const t of stored) {
      const turn = this.turnOf(t);
      const p = previous.get(turn.id);
      if (p) {
        turn.usage = p.usage;
        turn.model = p.model;
      }
      this.turns.set(turn.id, turn);
    }
    {
      // Codex saves an item only once it is finished: the running turn's answer so far is only in what was seen
      // live. Merge it into the stored turn (and into a turn stopped meanwhile: its unfinished items are never saved).
      for (const [id, p] of previous) {
        if (p.status !== 'inProgress' && p.status !== 'interrupted') continue;
        const turn = this.turns.get(id);
        if (!active && turn?.status !== 'interrupted') continue;
        if (!turn) {
          this.turns.set(id, p);
          continue;
        }
        for (const [itemId, live] of p.items) {
          const st = turn.items.get(itemId);
          if (!st) {
            const copy = new Item(live.id, live.type, live.json, turn);
            Object.assign(copy, { text: live.text, summary: [...live.summary], reasoning: live.reasoning, output: live.output, streaming: live.streaming, startedAt: live.startedAt, completedAt: live.completedAt });
            turn.items.set(itemId, copy);
          } else {
            if (!st.text && live.text) st.text = live.text;
            if (st.summary.every((s) => !s) && live.summary.some((s) => !!s)) st.summary = [...live.summary];
            if (!st.output && live.output) st.output = live.output;
            if (st.completedAt == null) st.streaming = live.streaming;
            bump(st);
          }
        }
        if (turn.plan == null) turn.plan = p.plan;
        touch(turn);
      }
    }
    if (!active) {
      for (const t of this.turns.values()) if (t.status === 'inProgress') t.status = 'interrupted';
      this.awaitingStart = false;
    }
    // prompts sent a moment ago stay until their user message shows up
    for (const t of this.turns.values()) for (const it of t.items.values()) {
      const cid = str(it.json, 'clientId');
      if (cid) this.localPrompts.delete(cid);
    }
    for (const t of this.turns.values()) this.finishStreaming(t, t.status === 'inProgress');
  }

  private turnOf(t: J): Turn {
    const turn = new Turn(str(t, 'id') ?? '');
    this.applyTurnFields(turn, t);
    for (const x of arr(t, 'items')) {
      const io = obj(x);
      if (!io) continue;
      const item = this.itemOf(io, turn);
      turn.items.set(item.id, item);
    }
    return turn;
  }

  private applyTurnFields(turn: Turn, t: J) {
    const status = str(t, 'status');
    if (status) turn.status = status;
    const root = str(t, 'rootTurnId');
    if (root && root !== turn.id) turn.rootTurnId = root;
    turn.error = o(t, 'error') ?? turn.error;
    const s = num(t, 'startedAt');
    if (s != null) turn.startedAt = s * 1000;
    const c = num(t, 'completedAt');
    if (c != null) turn.completedAt = c * 1000;
    const d = num(t, 'durationMs');
    if (d != null) turn.durationMs = d;
    touch(turn);
  }

  private itemOf(io: J, turn: Turn): Item {
    const item = new Item(str(io, 'id') ?? '', str(io, 'type') ?? '', io, turn);
    this.fillFromJson(item, io);
    return item;
  }

  private fillFromJson(item: Item, io: J) {
    item.json = io;
    item.type = str(io, 'type') ?? item.type;
    const s = num(io, 'startedAtMs');
    if (s != null) item.startedAt = s;
    const c = num(io, 'completedAtMs');
    if (c != null) item.completedAt = c;
    switch (item.type) {
      case 'agentMessage':
      case 'plan': {
        const t = str(io, 'text');
        if (t != null && (t || !item.text)) item.text = t;
        break;
      }
      case 'reasoning': {
        const parts = arr(io, 'summary').filter((x) => typeof x === 'string') as string[];
        if (parts.length) item.summary = [...parts];
        const content = (arr(io, 'content').filter((x) => typeof x === 'string') as string[]).join('\n');
        if (content) item.reasoning = content;
        break;
      }
      case 'commandExecution': {
        const out = str(io, 'aggregatedOutput');
        if (out != null) item.output = out;
        break;
      }
    }
    bump(item);
  }

  // ------------------------------------------------------------------ live events

  /** The prompt was sent from here: shown at once (its user message replaces it, matched by `clientId`). */
  addLocalPrompt(clientId: string, text: string, attachmentNames: string[], startsTurn: boolean, images: ChatAttachment[] = []) {
    this.localPrompts.set(clientId, { clientId, text, attachmentNames, created: Date.now(), images });
    if (startsTurn) this.awaitingStart = true;
  }

  removeLocalPrompt(clientId: string) {
    this.localPrompts.delete(clientId);
    this.awaitingStart = false;
  }

  /** Something is starting that has no turn yet (compaction, review): show the reply spinner until it does. */
  markAwaitingStart(on: boolean) {
    this.awaitingStart = on;
  }

  /** A failure found here (could not send…): an error card at the end. */
  addError(title: string, message: string) {
    this.errorCards.push({ at: Date.now(), title, message });
    this.awaitingStart = false;
  }

  private turn(id: string | null): Turn | null {
    if (!id) return null;
    let t = this.turns.get(id);
    if (!t) {
      t = new Turn(id);
      t.startedAt = Date.now();
      this.turns.set(id, t);
    }
    return t;
  }

  private lastTurn(): Turn | null {
    let last: Turn | null = null;
    for (const t of this.turns.values()) last = t;
    return last;
  }

  private item(turnId: string | null, itemId: string | null, type: string): Item | null {
    if (!itemId) return null;
    const t = this.turn(turnId) ?? this.lastTurn();
    if (!t) return null;
    const own = t.items.get(itemId);
    if (own) return own;
    // an item of this id in another turn (history loaded mid-turn)
    for (const other of this.turns.values()) {
      const it = other.items.get(itemId);
      if (it) return it;
    }
    const it = new Item(itemId, type, { id: itemId, type }, t);
    t.items.set(itemId, it);
    return it;
  }

  /** Applies one notification of this thread; true when something visible changed. */
  apply(method: string, p: J): boolean {
    const turnId = str(p, 'turnId');
    switch (method) {
      case 'turn/started': {
        const t = o(p, 'turn');
        const turn = this.turn(str(t, 'id'));
        if (!t || !turn) return false;
        this.applyTurnFields(turn, t);
        turn.status = 'inProgress';
        // the chat's model right now runs this turn (a model switch comes as thread/settings/updated first)
        if (turn.model == null) turn.model = this.model;
        this.awaitingStart = false;
        break;
      }
      case 'thread/settings/updated': {
        const m = str(o(p, 'threadSettings'), 'model');
        if (m && m.trim()) this.model = m;
        return false;
      }
      case 'model/rerouted': {
        // Codex moved the turn to another model (e.g. the requested one is busy)
        const t = turnId ? this.turns.get(turnId) : null;
        const to = str(p, 'toModel');
        if (!t || !to) return false;
        t.model = to;
        touch(t);
        break;
      }
      case 'turn/completed': {
        const t = o(p, 'turn');
        const turn = this.turn(str(t, 'id'));
        if (!t || !turn) return false;
        this.applyTurnFields(turn, t);
        if (turn.status === 'inProgress') turn.status = 'completed';
        this.finishStreaming(turn, false);
        // a review's inner turn ends with its outer turn (only the outer one reports turn/completed)
        for (const other of this.turns.values()) {
          if (other.rootTurnId === turn.id && other.status === 'inProgress') {
            other.status = turn.status;
            touch(other);
            this.finishStreaming(other, false);
          }
        }
        break;
      }
      case 'item/started':
      case 'item/completed': {
        const io = o(p, 'item');
        const t = this.turn(turnId);
        const id = str(io, 'id');
        if (!io || !t || !id) return false;
        const existing = t.items.get(id);
        if (!existing) t.items.set(id, this.itemOf(io, t));
        else this.fillFromJson(existing, io);
        const it = t.items.get(id)!;
        it.streaming = method === 'item/started';
        bump(it);
        if (it.type === 'userMessage') {
          const cid = str(it.json, 'clientId');
          if (cid) this.localPrompts.delete(cid);
        }
        break;
      }
      case 'item/agentMessage/delta':
      case 'item/plan/delta': {
        const it = this.item(turnId, str(p, 'itemId'), method === 'item/plan/delta' ? 'plan' : 'agentMessage');
        if (!it) return false;
        it.text += str(p, 'delta') ?? '';
        it.streaming = true;
        bump(it);
        break;
      }
      case 'item/reasoning/summaryPartAdded': {
        const it = this.item(turnId, str(p, 'itemId'), 'reasoning');
        if (!it) return false;
        const i = num(p, 'summaryIndex') ?? it.summary.length;
        while (it.summary.length <= i) it.summary.push('');
        bump(it);
        break;
      }
      case 'item/reasoning/summaryTextDelta': {
        const it = this.item(turnId, str(p, 'itemId'), 'reasoning');
        if (!it) return false;
        const i = num(p, 'summaryIndex') ?? 0;
        while (it.summary.length <= i) it.summary.push('');
        it.summary[i] += str(p, 'delta') ?? '';
        it.streaming = true;
        bump(it);
        break;
      }
      case 'item/reasoning/textDelta': {
        const it = this.item(turnId, str(p, 'itemId'), 'reasoning');
        if (!it) return false;
        it.reasoning += str(p, 'delta') ?? '';
        it.streaming = true;
        bump(it);
        break;
      }
      case 'item/commandExecution/outputDelta': {
        const it = this.item(turnId, str(p, 'itemId'), 'commandExecution');
        if (!it) return false;
        it.output += str(p, 'delta') ?? '';
        if (it.output.length > MAX_OUTPUT) it.output = it.output.slice(it.output.length - MAX_OUTPUT);
        bump(it);
        break;
      }
      case 'item/fileChange/patchUpdated': {
        const it = this.item(turnId, str(p, 'itemId'), 'fileChange');
        const changes = p?.changes;
        if (!it || !Array.isArray(changes)) return false;
        it.json = { ...it.json, changes };
        bump(it);
        break;
      }
      case 'turn/plan/updated': {
        const t = turnId ? this.turns.get(turnId) : null;
        if (!t) return false;
        t.plan = arr(p, 'plan')
          .map((s) => obj(s))
          .filter((s): s is J => s != null)
          .map((s) => [str(s, 'step') ?? '', str(s, 'status') ?? 'pending'] as [string, string]);
        // the plan card sits where the plan first came
        const key = planKey(t.id);
        if (!t.items.has(key)) t.items.set(key, new Item(key, PLAN_TYPE, {}, t));
        touch(t);
        break;
      }
      case 'thread/tokenUsage/updated': {
        // only a turn already known: on resume Codex repeats the last usage of an old turn
        const t = turnId ? this.turns.get(turnId) : null;
        const usage = o(p, 'tokenUsage');
        const total = o(usage, 'total');
        if (!t || !usage || !total) return false;
        if (t.usageBase == null) {
          // the total before this request is the total minus this request
          const last = o(usage, 'last');
          const base: Record<string, number> = {};
          for (const k of USAGE_KEYS) base[k] = (num(total, k) ?? 0) - (num(last, k) ?? 0);
          t.usageBase = base;
        }
        const base = t.usageBase;
        const d = (k: string) => Math.max(0, (num(total, k) ?? 0) - (base[k] ?? 0));
        const input = d('inputTokens');
        const cached = d('cachedInputTokens');
        t.usage = {
          promptTokens: Math.max(0, input - cached),
          outputTokens: d('outputTokens'),
          cachedTokens: cached,
          cacheCreationTokens: d('cacheWriteInputTokens'),
          totalTokens: d('totalTokens'),
          durationMs: 0,
          isEstimated: false,
          model: t.model ?? this.model,
        };
        touch(t);
        return false;
      }
      case 'error': {
        if (str(p, 'willRetry') === 'true') return false;
        const t = turnId ? this.turns.get(turnId) : null;
        if (!t) return false;
        const e = o(p, 'error');
        if (e) t.error = e;
        touch(t);
        break;
      }
      default:
        return false;
    }
    return true;
  }

  /** Codex's record of each turn (model, token use, duration), which history leaves out. */
  applyMeta(meta: Record<string, CodexTurnMeta>) {
    for (const t of this.turns.values()) {
      const m = meta[t.id];
      if (!m) continue;
      if (m.model) t.model = m.model;
      if (m.durationMs != null && !t.durationMs) t.durationMs = m.durationMs;
      if (m.usage && m.usage.totalTokens > 0) t.usage = { ...m.usage, model: t.model ?? m.usage.model };
      touch(t);
    }
  }

  /** Codex says the thread is idle: nothing can still be running (a lost turn/completed would otherwise spin forever). */
  settleAll() {
    this.awaitingStart = false;
    for (const t of this.turns.values())
      if (t.status === 'inProgress') {
        t.status = 'completed';
        touch(t);
        this.finishStreaming(t, false);
      }
  }

  /** The turn holding item `itemId` (a chat message id: a user message, or the first item of a reply). */
  turnOfItem(itemId: string): Turn | null {
    const raw = itemId.replace(/^turn_/, '');
    const direct = this.turns.get(raw);
    if (direct) return direct;
    for (const t of this.turns.values()) if (t.items.has(itemId)) return t;
    return null;
  }

  /** The text of the first user message of `turn` (what was asked). */
  promptOf(turn: Turn): string | null {
    for (const it of turn.items.values()) {
      if (it.type !== 'userMessage') continue;
      return userText(it.json);
    }
    return null;
  }

  /** The text of the user message `itemId` (as sent: hidden blocks included). */
  userTextOf(turn: Turn, itemId: string): string | null {
    const it = turn.items.get(itemId);
    return it && it.type === 'userMessage' ? userText(it.json) : null;
  }

  /** The command a tool card shows: its item id and process (Codex's background terminal), if it has one yet. */
  commandOfTool(toolId: string): { itemId: string; processId: string | null } | null {
    for (const turn of this.turns.values())
      for (const it of turn.items.values()) if (safeId(it.id) === toolId && it.type === 'commandExecution') return { itemId: it.id, processId: str(it.json, 'processId') };
    return null;
  }

  /** What was asked in each turn, oldest first (as sent: hidden blocks included). */
  prompts(): string[] {
    return [...this.turns.values()].map((t) => this.promptOf(t)).filter((x): x is string => x != null);
  }

  /** The last plan Codex proposed (plan mode), if the newest finished turn has one. */
  get lastPlan(): string | null {
    let last: Turn | null = null;
    for (const t of this.turns.values()) if (t.status !== 'inProgress') last = t;
    if (!last) return null;
    let plan: Item | null = null;
    for (const it of last.items.values()) if (it.type === 'plan') plan = it;
    return plan && plan.text.trim() ? plan.text : null;
  }

  private finishStreaming(t: Turn, running: boolean) {
    if (running) return;
    for (const it of t.items.values())
      if (it.streaming) {
        it.streaming = false;
        bump(it);
      }
  }

  // ------------------------------------------------------------------ output

  /**
   * The chat as messages. `awaiting`: item ids waiting for an approval; `question`: a question Codex is waiting on
   * (shown as a choice card at the end of its turn).
   */
  toChatMessages(conversationId: string, awaiting: Set<string>, question: CodexQuestion | null): ChatMessage[] {
    const out: ChatMessage[] = [];
    const nextCache = new Map<string, { key: string; messages: ChatMessage[] }>();
    this.nextMsgCache = new Map();
    for (const t of this.turns.values()) {
      const waitingHere = [...t.items.keys()].filter((id) => awaiting.has(id)).join(',');
      const q = question && question.turnId === t.id ? question : null;
      const key = `${conversationId}|${t.rev}|${waitingHere}|${q ? `${q.key}:${JSON.stringify(q.questions)}` : ''}|${this.model ?? ''}`;
      const cached = this.turnCache.get(t.id);
      const hit = cached && cached.key === key;
      const messages = hit ? cached.messages : this.renderTurn(conversationId, t, awaiting, q);
      if (hit) for (const m of messages) this.keepMessage(m.id);
      nextCache.set(t.id, hit ? cached : { key, messages });
      out.push(...messages);
    }
    this.turnCache = nextCache;
    this.msgCache = this.nextMsgCache;
    const nextLocal = new Map<string, { key: string; message: ChatMessage }>();
    for (const lp of this.localPrompts.values()) {
      const id = `local_${lp.clientId}`;
      const key = conversationId;
      const cached = this.localCache.get(id);
      let msg = cached && cached.key === key ? cached.message : null;
      if (!msg) {
        const { text, cards } = displayUserText(lp.text, id);
        msg = {
          id,
          conversationId,
          role: 'USER',
          content: text + attachmentsSuffix(lp.attachmentNames),
          toolCalls: [],
          isStreaming: false,
          attachments: [...lp.images, ...cards],
          createdAt: lp.created,
        };
      }
      nextLocal.set(id, { key, message: msg });
      out.push(msg);
    }
    for (const e of this.errorCards) {
      const id = `err_${e.at}`;
      const key = conversationId;
      const cached = this.localCache.get(id);
      const msg: ChatMessage =
        cached && cached.key === key
          ? cached.message
          : { id, conversationId, role: 'ASSISTANT', content: errorMarker(e.title, e.message, null), toolCalls: [], isStreaming: false, attachments: [], createdAt: e.at };
      nextLocal.set(id, { key, message: msg });
      out.push(msg);
    }
    this.localCache = nextLocal;
    return out;
  }

  /** A message of an unchanged turn: its cache entry stays. */
  private keepMessage(id: string) {
    const e = this.msgCache.get(id);
    if (e) this.nextMsgCache.set(id, e);
  }

  /** The cached message `id` when `key` (everything it is made of) is unchanged, else a new one. */
  private cachedMessage(id: string, key: string, build: () => ChatMessage): ChatMessage {
    const e = this.msgCache.get(id);
    const message = e && e.key === key ? e.message : build();
    this.nextMsgCache.set(id, e && e.key === key ? e : { key, message });
    return message;
  }

  private renderTurn(conversationId: string, t: Turn, awaiting: Set<string>, question: CodexQuestion | null): ChatMessage[] {
    const out: ChatMessage[] = [];
    let group: Item[] = [];
    const flush = (turnEnd: boolean) => {
      if (group.length || (turnEnd && (t.error != null || question != null))) {
        const items = group;
        const waiting = items.filter((i) => awaiting.has(i.id)).map((i) => i.id).join(',');
        const q = turnEnd && question ? `${question.key}:${JSON.stringify(question.questions)}` : '';
        const key = `a|${conversationId}|${items.map((i) => `${i.id}:${i.rev}`).join(',')}|${turnEnd}|${t.metaRev}|${this.model ?? ''}|${waiting}|${q}`;
        out.push(this.cachedMessage(items[0]?.id ?? `turn_${t.id}`, key, () => this.assistantMessage(conversationId, t, items, turnEnd, awaiting, question)));
      }
      group = [];
    };
    for (const item of t.items.values()) {
      if (item.type === 'userMessage') {
        flush(false);
        out.push(this.cachedMessage(item.id, `u|${conversationId}|${item.rev}|${t.startedAt}`, () => this.userMessage(conversationId, item, t)));
      } else if (item.type === 'contextCompaction') {
        flush(false);
        out.push(this.cachedMessage(item.id, `s|${conversationId}|${item.rev}|${t.startedAt}`, () => ({
          id: item.id,
          conversationId,
          role: 'SUMMARY',
          content: 'The conversation was compacted.',
          contextSummary: 'The conversation was compacted.',
          toolCalls: [],
          isStreaming: false,
          attachments: [],
          createdAt: item.startedAt ?? t.startedAt ?? 0,
        })));
      } else group.push(item);
    }
    flush(true);
    return out;
  }

  private userMessage(conversationId: string, item: Item, t: Turn): ChatMessage {
    const parts = arr(item.json, 'content').map((x) => obj(x)).filter((x): x is J => x != null);
    // files sent by path are listed in the message's hidden text: shown as cards
    const { text, cards } = displayUserText(userText(item.json) ?? '', item.id);
    // images show as previews: a localImage is a file on this machine, an image a data URL
    const images: ChatAttachment[] = [];
    parts.forEach((p, i) => {
      const type = str(p, 'type');
      if (type === 'localImage') {
        const pth = str(p, 'path');
        if (!pth || !pth.trim()) return;
        images.push({
          id: `${item.id}_img_${i}`,
          name: path.basename(pth),
          path: pth,
          isImage: true,
          isAudio: false,
          size: 0,
          mimeType: mimeOf(pth),
          base64: CodexTranscript.inlineImage(pth),
        });
      } else if (type === 'image') {
        const url = str(p, 'url');
        if (!url || !url.startsWith('data:') || !url.includes(';base64,')) return;
        images.push({
          id: `${item.id}_img_${i}`,
          name: 'image',
          path: '',
          isImage: true,
          isAudio: false,
          size: 0,
          mimeType: url.slice(5, url.indexOf(';')),
          base64: url.slice(url.indexOf(';base64,') + 8),
        });
      }
    });
    const names = parts
      .map((p) => {
        switch (str(p, 'type')) {
          case 'localAudio':
            return path.basename(str(p, 'path') ?? '') || null;
          case 'image':
            return str(p, 'url')?.startsWith('data:') ? null : 'image';
          case 'mention':
            return `@${str(p, 'name') ?? ''}`;
          case 'skill':
            return `$${str(p, 'name') ?? ''}`;
          default:
            return null;
        }
      })
      .filter((x): x is string => !!x);
    return {
      id: item.id,
      conversationId,
      role: 'USER',
      content: text + attachmentsSuffix(names),
      toolCalls: [],
      isStreaming: false,
      attachments: [...images, ...cards],
      createdAt: item.startedAt ?? t.startedAt ?? 0,
    };
  }

  /** Base64 of a small image on this machine (cached by modification time), or null. */
  private static inlineImage(p: string): string | null {
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_INLINE_IMAGE) return null;
      const c = CodexTranscript.imageCache.get(p);
      if (c && c.mtime === st.mtimeMs) return c.b64;
      const b64 = fs.readFileSync(p).toString('base64');
      CodexTranscript.imageCache.set(p, { mtime: st.mtimeMs, b64 });
      if (CodexTranscript.imageCache.size > 64) CodexTranscript.imageCache.delete(CodexTranscript.imageCache.keys().next().value!);
      return b64;
    } catch {
      return null;
    }
  }

  private assistantMessage(conversationId: string, t: Turn, items: Item[], turnEnd: boolean, awaiting: Set<string>, question: CodexQuestion | null): ChatMessage {
    const content: string[] = [];
    const thoughts: string[] = [];
    const tools: ToolCall[] = [];
    const running = t.status === 'inProgress';
    for (const item of items) {
      switch (item.type) {
        case 'agentMessage':
        case 'plan': {
          const tx = item.text.trim();
          if (tx) content.push(tx);
          break;
        }
        case 'reasoning': {
          const tx = item.summary.map((s) => s.trim()).join('\n\n').trim() || item.reasoning.trim();
          if (tx) {
            const tag = item.streaming && running ? ':streaming' : '';
            content.push(`<!-- thought${tag} -->\n${tx}\n<!-- /thought -->`);
            thoughts.push(tx);
          }
          break;
        }
        case 'enteredReviewMode':
          content.push(`*Reviewing: ${str(item.json, 'review') ?? ''}*`);
          break;
        case 'exitedReviewMode': {
          const r = str(item.json, 'review');
          if (r && r.trim()) content.push(r);
          break;
        }
        case 'userMessage':
        case 'contextCompaction':
        case 'hookPrompt':
        case 'functionCallOutput':
        case 'sleep':
          break;
        default: {
          const call = this.toolCall(item, t, awaiting, running);
          if (call && !tools.some((x) => x.id === call.id)) {
            tools.push(call);
            content.push(`<!-- tool_call:${call.id} -->`);
          }
        }
      }
    }
    if (turnEnd && question != null && question.turnId === t.id) {
      const q = CodexTranscript.questionnaireOf(question);
      if (q) {
        const id = questionToolId(question.key);
        tools.push({ id, name: 'question', toolType: 'ASK_CHOICE', command: q.title, status: 'AWAITING_CHOICE', output: '', interactionType: 'codex', questionnaire: q });
        content.push(`<!-- tool_call:${id} -->`);
      }
    }
    if (turnEnd && t.error) content.push(errorMarker(errorTitle(t.error), str(t.error, 'message') ?? '', str(t.error, 'additionalDetails')));
    const streaming = running && turnEnd;
    const started = items[0]?.startedAt ?? t.startedAt ?? 0;
    const usage = t.usage;
    const turnModel = t.model ?? this.model;
    const thoughtText = thoughts.join('\n\n').trim();
    return {
      id: items[0]?.id ?? `turn_${t.id}`,
      conversationId,
      role: 'ASSISTANT',
      content: content.join('\n\n').trim(),
      thoughtText: thoughtText || null,
      toolCalls: tools,
      isStreaming: streaming,
      tokenUsage: !turnEnd || running || usage == null || usage.totalTokens === 0 ? null : { ...usage, durationMs: t.durationMs ?? usage.durationMs, model: turnModel },
      attachments: [],
      createdAt: started,
      modelId: turnModel,
    };
  }

  private toolCall(item: Item, t: Turn, awaiting: Set<string>, turnRunning: boolean): ToolCall | null {
    const j = item.json;
    const pendingApproval = awaiting.has(item.id);
    const duration = num(j, 'durationMs') ?? (item.startedAt != null && item.completedAt != null ? Math.max(0, item.completedAt - item.startedAt) : null);
    const status = (raw: string | null, ok = true): string => {
      if (pendingApproval) return 'PENDING_APPROVAL';
      if (raw === 'inProgress') return turnRunning ? 'RUNNING' : 'TERMINATED';
      if (raw === 'declined') return 'REJECTED';
      if (raw === 'failed') return 'FAILED';
      if (raw === 'completed') return ok ? 'SUCCESS' : 'FAILED';
      return turnRunning ? 'RUNNING' : 'SUCCESS';
    };
    const id = safeId(item.id);
    const call = (name: string, toolType: ToolType, command: string, st: string, output = '', extra: Partial<ToolCall> = {}): ToolCall => ({
      id,
      name,
      toolType,
      command,
      status: st,
      output,
      durationMs: duration,
      interactionType: 'codex',
      ...extra,
    });
    switch (item.type) {
      case 'commandExecution': {
        const actions = arr(j, 'commandActions').map((x) => obj(x)).filter((x): x is J => x != null);
        const single = actions.length === 1 ? actions[0] : null;
        const at = str(single, 'type');
        const type: ToolType = at === 'read' ? 'VIEW_FILE' : at === 'listFiles' ? 'LIST_DIR' : at === 'search' ? 'GREP_SEARCH' : 'BASH';
        const command =
          actions
            .map((a) => str(a, 'command'))
            .filter((x): x is string => !!x)
            .join(' && ') || unwrapShell(str(j, 'command') ?? '');
        const exit = num(j, 'exitCode');
        return call('shell', type, command, status(str(j, 'status'), exit == null || exit === 0), item.output, { exitCode: exit });
      }
      case 'fileChange': {
        const changes = arr(j, 'changes').map((x) => obj(x)).filter((x): x is J => x != null);
        const names = [...new Set(changes.map((c) => str(c, 'path')).filter((x): x is string => !!x).map((p) => path.basename(p)))];
        return call('apply_patch', 'EDIT_FILE', names.join(', ') || 'Edit files', status(str(j, 'status')), changes.map((c) => diffOf(c)).join('\n'));
      }
      case 'mcpToolCall': {
        const result = o(j, 'result');
        const err = str(o(j, 'error'), 'message');
        const text = arr(result, 'content')
          .map((c) => obj(c))
          .filter((c): c is J => c != null && str(c, 'type') === 'text')
          .map((c) => str(c, 'text') ?? '')
          .join('\n');
        const server = str(j, 'server') ?? '';
        const tool = str(j, 'tool') ?? '';
        return call(`${server}_${tool}`, 'MCP', `${server} · ${tool}`, status(str(j, 'status'), err == null), [text || null, err].filter(Boolean).join('\n'));
      }
      case 'dynamicToolCall':
        return call(str(j, 'tool') ?? 'tool', 'UNKNOWN', str(j, 'tool') ?? '', status(str(j, 'status'), j?.success !== false));
      case 'webSearch': {
        const action = o(j, 'action');
        const queries = arr(action, 'queries').filter((q) => typeof q === 'string' && q.trim()) as string[];
        const command = (str(j, 'query') || null) ?? (str(action, 'query') || null) ?? (queries.length ? queries.join(' · ') : null) ?? str(action, 'url') ?? 'Web search';
        return call('web_search', 'SEARCH_WEB', command, turnRunning && item.streaming ? 'RUNNING' : 'SUCCESS');
      }
      case 'imageView': {
        const p = str(j, 'path');
        return call('view_image', 'VIEW_FILE', p ? path.basename(p) : 'Image', 'SUCCESS', p ?? '');
      }
      case 'imageGeneration':
        return call('image_generation', 'GENERATE_IMAGE', str(j, 'revisedPrompt') ?? 'Generate an image', o(j, 'failure') ? 'FAILED' : status(str(j, 'status')), str(j, 'savedPath') ?? '');
      case 'collabAgentToolCall':
      case 'subAgentActivity':
        return call('subagent', 'UNKNOWN', (str(j, 'prompt') ?? '').slice(0, 80) || str(j, 'agentPath') || 'Sub-agent', status(str(j, 'status')));
      case PLAN_TYPE: {
        const plan = t.plan;
        if (!plan) return null;
        const done = plan.filter(([, s]) => s === 'completed').length;
        return call(
          'update_plan',
          'UNKNOWN',
          `Plan (${done}/${plan.length} done)`,
          turnRunning && done < plan.length ? 'RUNNING' : 'SUCCESS',
          plan.map(([step, s]) => `${s === 'completed' ? '☑' : s === 'inProgress' ? '◐' : '☐'} ${step}`).join('\n'),
        );
      }
      default:
        return null;
    }
  }

  /** Codex's question as the chat's question card. */
  static questionnaireOf(q: CodexQuestion): ChoiceQuestionnaire | null {
    const questions: ChoiceQuestion[] = [];
    for (const x of q.questions) {
      const qid = str(x, 'id');
      if (!qid) continue;
      const opts = arr(x, 'options').map((op) => obj(op)).filter((op): op is J => op != null);
      const header = str(x, 'header');
      const prompt = str(x, 'question') ?? header ?? qid;
      questions.push({
        id: qid,
        prompt,
        description: header && header !== str(x, 'question') ? header : null,
        isMultiSelect: false,
        options: opts
          .map((op) => str(op, 'label'))
          .filter((l): l is string => !!l)
          .map((label) => ({ id: label, label, description: str(opts.find((op) => str(op, 'label') === label), 'description') })),
        allowCustomAnswer: x?.isOther === true || opts.length === 0,
      });
    }
    if (!questions.length) return null;
    return { title: 'Codex has a question', description: null, questions, allowCustomNote: false };
  }
}

// ------------------------------------------------------------------------------------------------ helpers

function userText(json: J): string | null {
  const parts = arr(json, 'content')
    .map((x) => obj(x))
    .filter((x): x is J => x != null && str(x, 'type') === 'text');
  return parts.map((p) => str(p, 'text') ?? '').join('\n');
}

function attachmentsSuffix(names: string[]): string {
  return names.length ? `\n\n📎 ${names.join(', ')}` : '';
}

function mimeOf(p: string): string {
  const ext = path.extname(p).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg';
}

/** Ids as the chat renderer's markers accept them. */
export function safeId(raw: string): string {
  return raw.replace(UNSAFE_ID, '_');
}

export function questionToolId(key: string): string {
  return `codexq_${safeId(key)}`;
}

function planKey(turnId: string): string {
  return `plan_${turnId}`;
}

/** `/bin/bash -lc "cmd"` → `cmd`. */
export function unwrapShell(command: string): string {
  const t = command.trim();
  const m = /^\S*(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(t);
  if (m) return m[2];
  // Windows: `"C:\…\powershell.exe" -Command "…"` (pwsh too, maybe -NoProfile / -NoLogo first)
  const w = /^(?:"[^"]*?(?:powershell|pwsh)(?:\.exe)?"|\S*?(?:powershell|pwsh)(?:\.exe)?)(?:\s+-(?:NoProfile|NoLogo|NonInteractive))*\s+-(?:Command|c)\s+(['"]?)([\s\S]*)\1$/i.exec(t);
  return w ? w[2] : command;
}

/** One file change as the edit card shows it: added lines "+", removed "-", hunks "@@ … @@". */
export function diffOf(change: J): string {
  const diff = str(change, 'diff') ?? '';
  const kind = str(o(change, 'kind'), 'type');
  if (kind === 'add')
    return diff
      .replace(/\n+$/, '')
      .split('\n')
      .map((l) => `+${l}`)
      .join('\n');
  if (kind === 'delete')
    return diff
      .replace(/\n+$/, '')
      .split('\n')
      .map((l) => `-${l}`)
      .join('\n');
  return diff
    .split('\n')
    .filter((l) => !l.startsWith('--- ') && !l.startsWith('+++ ') && !l.startsWith('diff --git') && !l.startsWith('index '))
    .join('\n')
    .replace(/\n+$/, '');
}

export function errorTitle(e: J): string {
  const info = e?.codexErrorInfo;
  const kind = typeof info === 'string' ? info : (Object.keys(obj(info) ?? {})[0] ?? '');
  switch (kind) {
    case 'usageLimitExceeded':
      return 'Usage limit reached';
    case 'unauthorized':
      return 'Not signed in to Codex';
    case 'contextWindowExceeded':
      return 'The conversation is too long';
    case 'rateLimitExceeded':
    case 'serverOverloaded':
      return 'Codex is busy';
    case 'modelNotFound':
      return 'Model not available';
    case 'sandboxError':
      return 'Sandbox error';
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
      return 'Connection problem';
    default:
      return 'Codex error';
  }
}

export function errorMarker(title: string, message: string, details: string | null): string {
  const err = { title, userMessage: message, shortError: message, fullError: details ?? '' };
  return `<!-- error -->\n${JSON.stringify(err)}\n<!-- /error -->`;
}
