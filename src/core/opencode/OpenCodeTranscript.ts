// Port of the app's OpenCodeTranscript.kt: one OpenCode chat as the chat UI shows it. OpenCode's v2 messages
// (`GET /session/{id}/message`) and its live events (`/event`) describe the same thing — user prompts, assistant steps
// made of text / reasoning / tool parts — so both are folded into the same model here and rendered into ChatMessages.
// Consecutive assistant steps after a prompt become one assistant message (like a Claude turn), with their usage summed.
//
// Unchanged messages keep their ChatMessage object between renders (each Msg carries a revision), so the host never
// re-sends them to the views.
import type { ChatAttachment, ChatMessage, ChoiceOption, ChoiceQuestion, ChoiceQuestionnaire, TokenUsage, ToolCall, ToolType } from '../../../shared/model';
import { displayUserText } from '../text';
import { arr, bool, modelRef, num, obj, str, type Json } from './common';

type PartKind = 'TEXT' | 'REASONING' | 'TOOL';

class Part {
  text = '';
  streaming = false;
  // tool
  toolName = '';
  toolStatus = 'RUNNING';
  toolInput: Json = {};
  toolOutput = '';
  toolError: string | null = null;
  startedAt: number | null = null;
  endedAt: number | null = null;
  exitCode: number | null = null;
  /** Waiting for a permission reply (status shown as such; the request itself is in pendingPermissions). */
  awaitingPermission = false;
  constructor(
    readonly key: string,
    readonly kind: PartKind,
  ) {}
}

class Msg {
  rev = 0;
  // user
  text = '';
  attachmentNames: string[] = [];
  /** Images sent with the prompt, shown as previews (OpenCode keeps their data with the message). */
  images: ChatAttachment[] = [];
  // assistant
  parts: Part[] = [];
  model: string | null = null;
  agent: string | null = null;
  inputTokens = 0;
  outputTokens = 0;
  reasoningTokens = 0;
  cacheRead = 0;
  cacheWrite = 0;
  cost = 0;
  completed: number | null = null;
  finish: string | null = null;
  error: string | null = null;
  errorTitle: string | null = null;
  /** The provider rejected the account (expired sign-in, invalid key): the card offers to reconnect. */
  errorAuth = false;
  /** The user message was sent from here and is not confirmed by OpenCode yet. */
  pending = false;
  /** Made here (a prompt just sent, an error card): kept until the stored history has it. */
  local = false;
  constructor(
    readonly id: string,
    readonly role: 'user' | 'assistant' | 'summary',
    public created: number,
  ) {}
}

export interface Permission {
  id: string;
  sessionId: string;
  action: string;
  resources: string[];
  save: string[];
  toolCallId: string | null;
  messageId: string | null;
  metadata: Json;
}

export interface Form {
  id: string;
  sessionId: string;
  title: string;
  fields: Json[];
}

/** Retries of a busy / rate-limited provider before the turn is stopped (OpenCode itself keeps going). */
export const MAX_RETRIES = 3;

const UNSAFE_ID = /[^A-Za-z0-9_-]/g;
/** Tool ids as the chat renderer's markers accept them (some providers use ':' or '.'). */
export const safeId = (raw: string) => raw.replace(UNSAFE_ID, '_');
export const formToolId = (formId: string) => `form_${safeId(formId)}`;

const strings = (a: Json[]) => a.filter((x) => typeof x === 'string' || typeof x === 'number').map(String);

export class OpenCodeTranscript {
  private messages = new Map<string, Msg>();
  readonly pendingPermissions = new Map<string, Permission>();
  readonly pendingForms = new Map<string, Form>();
  private revCounter = 0;
  private formsRev = 0;
  private cache = new Map<string, { key: string; msg: ChatMessage }>();

  /** A turn is running (OpenCode's execution.started … succeeded / failed / interrupted). */
  isTurnActive = false;
  /** Last retry notice while the provider is busy ("The provider is busy — retry 2 of 3: overloaded"). */
  retryNotice: string | null = null;
  compacting = false;
  lastTitle: string | null = null;
  /** Retries OpenCode scheduled in the current turn (provider busy / rate limited). */
  retries = 0;
  /** The last retry's reason (shown when giving up). */
  lastRetryError = '';

  constructor(public sessionId = '') {}

  private touch(m: Msg | null | undefined) {
    if (m) m.rev = ++this.revCounter;
  }
  private touchAll() {
    for (const m of this.messages.values()) this.touch(m);
  }

  reset(id: string) {
    this.sessionId = id;
    this.messages.clear();
    this.pendingPermissions.clear();
    this.pendingForms.clear();
    this.formsRev++;
    this.cache.clear();
    this.isTurnActive = false;
    this.retryNotice = null;
    this.compacting = false;
    this.lastTitle = null;
  }

  get isEmpty() {
    return this.messages.size === 0;
  }

  // ------------------------------------------------------------------ history

  /** Replaces everything with the stored messages (`items` newest or oldest first, both work). */
  loadHistory(items: Json[], active: boolean) {
    // prompts sent a moment ago (and local error cards) that the stored list does not show yet stay visible
    const storedIds = new Set(items.map((m) => str(m, 'id')).filter(Boolean));
    const keep = [...this.messages.values()].filter((m) => (m.local || m.pending) && !storedIds.has(m.id));
    this.messages.clear();
    const sorted = [...items].sort((a, b) => (num(obj(a, 'time'), 'created') ?? 0) - (num(obj(b, 'time'), 'created') ?? 0) || (str(a, 'id') ?? '').localeCompare(str(b, 'id') ?? ''));
    for (const m of sorted) this.applyStored(m);
    if (keep.length) {
      const merged = [...this.messages.values(), ...keep].sort((a, b) => a.created - b.created);
      this.messages.clear();
      for (const m of merged) this.messages.set(m.id, m);
    }
    this.isTurnActive = active;
    if (!active) {
      for (const msg of this.messages.values())
        for (const part of msg.parts) {
          part.streaming = false;
          if (part.kind === 'TOOL' && part.toolStatus === 'RUNNING') part.toolStatus = 'TERMINATED';
        }
    }
    this.touchAll();
  }

  private applyStored(m: Json) {
    const id = str(m, 'id');
    if (!id) return;
    const created = num(obj(m, 'time'), 'created') ?? 0;
    switch (str(m, 'type')) {
      case 'user': {
        const msg = new Msg(id, 'user', created);
        msg.text = str(m, 'text') ?? str(obj(m, 'payload'), 'text') ?? '';
        const files = (Array.isArray(m.files) ? m.files : arr(obj(m, 'payload'), 'files')).filter((f: Json) => f && typeof f === 'object');
        // a stored file is {data (base64), mime, source, name}: images become previews, the rest a name
        msg.images = files
          .map((f: Json, i: number) => {
            const mime = str(f, 'mime') ?? '';
            const data = str(f, 'data') ?? '';
            if (!mime.startsWith('image/') || !data) return null;
            return { id: `${id}_img_${i}`, name: str(f, 'name') ?? 'image', path: '', isImage: true, isAudio: false, size: 0, mimeType: mime, base64: data } satisfies ChatAttachment;
          })
          .filter((x: ChatAttachment | null): x is ChatAttachment => x != null);
        msg.attachmentNames = files
          .filter((f: Json) => !((str(f, 'mime') ?? '').startsWith('image/') && str(f, 'data')))
          .map((f: Json) => str(f, 'name') ?? str(f, 'uri')?.split('/').pop())
          .filter((x: string | undefined): x is string => !!x);
        this.messages.set(id, msg);
        break;
      }
      case 'assistant': {
        const msg = new Msg(id, 'assistant', created);
        msg.model = modelRef(obj(m, 'model'));
        msg.agent = str(m, 'agent') ?? null;
        msg.completed = num(obj(m, 'time'), 'completed') ?? null;
        msg.finish = str(m, 'finish') ?? null;
        this.applyTokens(msg, obj(m, 'tokens'), num(m, 'cost'));
        const err = obj(m, 'error');
        if (err) this.setError(msg, err);
        let textN = 0;
        let reasoningN = 0;
        for (const co of arr(m, 'content')) {
          if (!co || typeof co !== 'object') continue;
          switch (str(co, 'type')) {
            case 'text': {
              const p = new Part(`text:${textN++}`, 'TEXT');
              p.text = str(co, 'text') ?? '';
              msg.parts.push(p);
              break;
            }
            case 'reasoning': {
              const p = new Part(`reasoning:${reasoningN++}`, 'REASONING');
              p.text = str(co, 'text') ?? '';
              msg.parts.push(p);
              break;
            }
            case 'tool': {
              const p = new Part(`tool:${str(co, 'id')}`, 'TOOL');
              p.toolName = str(co, 'name') ?? '';
              const state = obj(co, 'state');
              const input = obj(state, 'input');
              if (input) p.toolInput = input;
              p.toolOutput = contentText(arr(state, 'content'));
              const st = str(state, 'status');
              p.toolStatus = st === 'completed' ? 'SUCCESS' : st === 'error' || st === 'failed' ? 'FAILED' : 'RUNNING';
              const e = obj(state, 'error');
              if (e) {
                p.toolError = str(e, 'message') ?? null;
                if (p.toolStatus === 'RUNNING') p.toolStatus = 'FAILED';
              }
              const exit = num(obj(state, 'metadata'), 'exit');
              if (exit != null) p.exitCode = Math.trunc(exit);
              p.startedAt = num(obj(co, 'time'), 'ran') ?? num(obj(co, 'time'), 'created') ?? null;
              p.endedAt = num(obj(co, 'time'), 'completed') ?? null;
              msg.parts.push(p);
              break;
            }
          }
        }
        this.messages.set(id, msg);
        break;
      }
      case 'idle': {
        // a failed run leaves its error on the idle marker
        if (str(m, 'outcome') === 'failed') {
          const err = obj(m, 'error');
          const last = this.lastAssistant();
          if (err && last) this.setError(last, err);
        }
        break;
      }
      case 'compaction':
      case 'summary': {
        const msg = new Msg(id, 'summary', created);
        msg.text = str(m, 'text') ?? str(m, 'summary') ?? 'The conversation was compacted.';
        this.messages.set(id, msg);
        break;
      }
    }
  }

  // ------------------------------------------------------------------ live events

  /** The prompt was sent from here: shown at once (OpenCode confirms it with the same id). */
  addLocalPrompt(id: string, text: string, attachmentNames: string[], images: ChatAttachment[] = []) {
    const msg = new Msg(id, 'user', Date.now());
    msg.text = text;
    msg.attachmentNames = attachmentNames;
    msg.images = images;
    msg.pending = true;
    msg.local = true;
    this.touch(msg);
    this.messages.set(id, msg);
    this.isTurnActive = true;
    this.retries = 0;
    this.touch(this.lastAssistant());
  }

  /** The prompt the assistant message `assistantId` answers (the user message right before its turn). */
  promptBefore(assistantId: string): { id: string; text: string; local: boolean } | null {
    let lastUser: Msg | null = null;
    for (const m of this.messages.values()) {
      if (m.id === assistantId) return lastUser ? { id: lastUser.id, text: lastUser.text, local: lastUser.local } : null;
      if (m.role === 'user') lastUser = m;
    }
    return null;
  }

  userMessage(id: string): { id: string; text: string; local: boolean } | null {
    const m = this.messages.get(id);
    return m && m.role === 'user' ? { id: m.id, text: m.text, local: m.local } : null;
  }

  /** The user's prompts in this chat, oldest first (as sent: hidden blocks included). */
  userPrompts(): string[] {
    return [...this.messages.values()].filter((m) => m.role === 'user').map((m) => m.text);
  }

  /**
   * The turn waits for the model itself: no command or tool is running, nothing waits for the user. Only then does a
   * long silence mean the provider is stuck.
   */
  get isWaitingOnModel(): boolean {
    return (
      this.isTurnActive &&
      this.pendingPermissions.size === 0 &&
      this.pendingForms.size === 0 &&
      !this.compacting &&
      ![...this.messages.values()].some((m) => m.parts.some((p) => p.kind === 'TOOL' && p.toolStatus === 'RUNNING' && !p.awaitingPermission))
    );
  }

  setNotice(text: string | null) {
    this.retryNotice = text;
  }

  removeLocalPrompt(id: string) {
    if (this.messages.get(id)?.pending) this.messages.delete(id);
  }

  /** Applies one event of this session; returns true when something visible changed. */
  apply(type: string, d: Json): boolean {
    switch (type) {
      case 'session.execution.started':
        this.isTurnActive = true;
        this.retryNotice = null;
        this.retries = 0;
        this.touch(this.lastAssistant());
        return true;
      case 'session.execution.succeeded':
      case 'session.idle':
      case 'session.execution.interrupted':
        this.endTurn(null);
        return true;
      case 'session.execution.failed':
        this.endTurn(obj(d, 'error') ?? null);
        return true;
      case 'session.inbox.enqueued': {
        const id = str(d, 'inboxID');
        if (!id) return false;
        const item = obj(d, 'item');
        if (str(item, 'type') !== 'user') return false;
        const existing = this.messages.get(id);
        if (existing) {
          existing.pending = false;
          this.touch(existing);
          return true;
        }
        const msg = new Msg(id, 'user', Date.now());
        msg.text = str(obj(item, 'payload'), 'text') ?? '';
        this.touch(msg);
        this.messages.set(id, msg);
        return true;
      }
      case 'session.inbox.delivered': {
        const m = this.messages.get(str(d, 'inboxID') ?? '');
        if (!m) return false;
        m.pending = false;
        this.touch(m);
        return true;
      }
      case 'session.inbox.cancelled':
        return this.messages.delete(str(d, 'inboxID') ?? '');
      case 'session.step.started': {
        this.isTurnActive = true;
        this.retryNotice = null;
        const aid = str(d, 'assistantMessageID');
        if (!aid) return false;
        const msg = this.assistant(aid, num(d, 'started') ?? null);
        msg.model = modelRef(obj(d, 'model')) ?? msg.model;
        msg.agent = str(d, 'agent') ?? msg.agent;
        this.touch(msg);
        return true;
      }
      case 'session.step.ended': {
        const msg = this.messages.get(str(d, 'assistantMessageID') ?? '');
        if (!msg) return false;
        msg.finish = str(d, 'finish') ?? null;
        msg.completed = Date.now();
        this.applyTokens(msg, obj(d, 'tokens'), num(d, 'cost'));
        for (const p of msg.parts) p.streaming = false;
        this.touch(msg);
        return true;
      }
      case 'session.step.failed': {
        const msg = this.messages.get(str(d, 'assistantMessageID') ?? '');
        if (!msg) return false;
        const err = obj(d, 'error');
        if (err) this.setError(msg, err);
        for (const p of msg.parts) p.streaming = false;
        this.touch(msg);
        return true;
      }
      case 'session.text.started':
      case 'session.text.delta':
      case 'session.text.ended':
      case 'session.reasoning.started':
      case 'session.reasoning.delta':
      case 'session.reasoning.ended': {
        const aid = str(d, 'assistantMessageID');
        if (!aid) return false;
        const msg = this.assistant(aid, null);
        const reasoning = type.startsWith('session.reasoning');
        const key = `${reasoning ? 'reasoning:' : 'text:'}${num(d, 'ordinal') ?? 0}`;
        let part = msg.parts.find((p) => p.key === key);
        if (!part) {
          part = new Part(key, reasoning ? 'REASONING' : 'TEXT');
          msg.parts.push(part);
        }
        if (type.endsWith('.started')) part.streaming = true;
        else if (type.endsWith('.delta')) {
          part.text += str(d, 'delta') ?? '';
          part.streaming = true;
        } else {
          const t = str(d, 'text');
          if (t != null) part.text = t;
          part.streaming = false;
        }
        this.touch(msg);
        return true;
      }
      case 'session.tool.input.started':
      case 'session.tool.input.ended':
      case 'session.tool.called':
      case 'session.tool.progress':
      case 'session.tool.success':
      case 'session.tool.failed': {
        const aid = str(d, 'assistantMessageID');
        const toolId = str(d, 'id');
        if (!aid || !toolId) return false;
        const msg = this.assistant(aid, null);
        const key = `tool:${toolId}`;
        let part = msg.parts.find((p) => p.key === key);
        if (!part) {
          part = new Part(key, 'TOOL');
          msg.parts.push(part);
        }
        const name = str(d, 'name');
        if (name) part.toolName = name;
        switch (type) {
          case 'session.tool.input.started':
            part.toolStatus = 'RUNNING';
            part.startedAt = Date.now();
            break;
          case 'session.tool.input.ended': {
            const t = str(d, 'text');
            if (t != null) {
              try {
                const parsed = JSON.parse(t);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) part.toolInput = parsed;
              } catch {
                /* partial input */
              }
            }
            break;
          }
          case 'session.tool.called': {
            const input = obj(d, 'input');
            if (input) part.toolInput = input;
            break;
          }
          case 'session.tool.progress': {
            const md = obj(d, 'metadata');
            const out = str(md, 'output') ?? str(md, 'stdout');
            if (out != null) part.toolOutput = out;
            break;
          }
          case 'session.tool.success': {
            part.toolStatus = 'SUCCESS';
            part.awaitingPermission = false;
            part.toolOutput = contentText(arr(d, 'content')) || part.toolOutput;
            const exit = num(obj(d, 'metadata'), 'exit');
            if (exit != null) part.exitCode = Math.trunc(exit);
            part.endedAt = Date.now();
            break;
          }
          case 'session.tool.failed':
            part.toolStatus = 'FAILED';
            part.awaitingPermission = false;
            part.toolError = str(obj(d, 'error'), 'message') ?? null;
            part.toolOutput = contentText(arr(d, 'content')) || part.toolOutput;
            part.endedAt = Date.now();
            break;
        }
        this.touch(msg);
        return true;
      }
      case 'session.retry.scheduled': {
        // "attempt" is the attempt about to run: attempt 2 is the first retry
        const attempt = num(d, 'attempt');
        this.retries = attempt != null ? Math.trunc(attempt) - 1 : this.retries + 1;
        const why = (str(obj(d, 'error'), 'message') ?? '').slice(0, 160);
        this.retryNotice = `The provider is busy — retry ${this.retries} of ${MAX_RETRIES}${why ? `: ${why}` : ''}`;
        this.lastRetryError = why;
        return true;
      }
      case 'session.compaction.started':
        this.compacting = true;
        return true;
      case 'session.compaction.ended':
      case 'session.compaction.failed':
        this.compacting = false;
        return true;
      case 'session.renamed':
        this.lastTitle = str(d, 'title') ?? null;
        return true;
      case 'permission.asked': {
        const id = str(d, 'id');
        if (!id) return false;
        this.addPermission(permissionOf(d, this.sessionId)!);
        return true;
      }
      case 'permission.replied': {
        const perm = this.pendingPermissions.get(str(d, 'requestID') ?? '');
        if (!perm) return false;
        this.pendingPermissions.delete(perm.id);
        const hit = this.findTool(perm.toolCallId);
        if (hit) {
          hit.part.awaitingPermission = false;
          if (str(d, 'reply') === 'reject') {
            hit.part.toolStatus = 'REJECTED';
            hit.part.endedAt = Date.now();
          }
          this.touch(hit.msg);
        }
        return true;
      }
      case 'form.created': {
        const f = obj(d, 'form');
        const id = str(f, 'id');
        if (!f || !id) return false;
        this.addForm({ id, sessionId: str(f, 'sessionID') ?? this.sessionId, title: str(f, 'title') ?? '', fields: arr(f, 'fields').filter((x) => x && typeof x === 'object') });
        return true;
      }
      case 'form.replied':
      case 'form.cancelled':
        this.removeForm(str(d, 'formID') ?? str(d, 'id') ?? str(obj(d, 'form'), 'id') ?? '');
        return true;
      default:
        return false;
    }
  }

  addPermission(p: Permission) {
    this.pendingPermissions.set(p.id, p);
    const hit = this.findTool(p.toolCallId);
    if (hit) {
      hit.part.awaitingPermission = true;
      this.touch(hit.msg);
    }
  }

  addForm(f: Form) {
    this.pendingForms.set(f.id, f);
    this.formsRev++;
  }

  removePermission(id: string, rejected: boolean) {
    const perm = this.pendingPermissions.get(id);
    if (!perm) return;
    this.pendingPermissions.delete(id);
    const hit = this.findTool(perm.toolCallId);
    if (hit) {
      hit.part.awaitingPermission = false;
      if (rejected) {
        hit.part.toolStatus = 'REJECTED';
        hit.part.endedAt = Date.now();
      }
      this.touch(hit.msg);
    }
  }

  removeForm(id: string) {
    if (this.pendingForms.delete(id)) this.formsRev++;
  }

  /** A failure found here (could not send, gave up after retries, no answer): an error card at the end. */
  addError(title: string, message: string) {
    const id = `err_${process.hrtime.bigint()}`;
    const msg = new Msg(id, 'assistant', Date.now());
    msg.errorTitle = title;
    msg.error = message;
    msg.local = true;
    this.touch(msg);
    this.messages.set(id, msg);
  }

  private endTurn(error: Json | null) {
    this.isTurnActive = false;
    this.retryNotice = null;
    this.compacting = false;
    for (const msg of this.messages.values()) {
      msg.pending = false;
      for (const p of msg.parts) {
        p.streaming = false;
        if (p.kind === 'TOOL' && p.toolStatus === 'RUNNING') p.toolStatus = 'TERMINATED';
      }
    }
    if (error) {
      const target = this.lastAssistant();
      if (target && target.error == null) this.setError(target, error);
      else if (!target) this.addError(errorTitle(error), str(error, 'message') ?? '');
    }
    this.touchAll();
  }

  private assistant(id: string, started: number | null): Msg {
    let m = this.messages.get(id);
    if (!m) {
      m = new Msg(id, 'assistant', started ?? Date.now());
      this.messages.set(id, m);
    }
    return m;
  }

  private lastAssistant(): Msg | undefined {
    return [...this.messages.values()].reverse().find((m) => m.role === 'assistant');
  }

  private findTool(toolId: string | null): { msg: Msg; part: Part } | null {
    if (!toolId) return null;
    const key = `tool:${toolId}`;
    for (const msg of [...this.messages.values()].reverse()) {
      const part = msg.parts.find((p) => p.key === key);
      if (part) return { msg, part };
    }
    return null;
  }

  private applyTokens(msg: Msg, t: Json | undefined, cost: number | undefined) {
    if (!t) return;
    msg.inputTokens = num(t, 'input') ?? 0;
    msg.outputTokens = num(t, 'output') ?? 0;
    msg.reasoningTokens = num(t, 'reasoning') ?? 0;
    msg.cacheRead = num(obj(t, 'cache'), 'read') ?? 0;
    msg.cacheWrite = num(obj(t, 'cache'), 'write') ?? 0;
    if (cost != null) msg.cost = cost;
  }

  private setError(msg: Msg, err: Json) {
    msg.errorTitle = errorTitle(err);
    msg.error = str(err, 'message') ?? JSON.stringify(err);
    msg.errorAuth = isAuthError(err);
    this.touch(msg);
  }

  // ------------------------------------------------------------------ output

  toChatMessages(conversationId: string): ChatMessage[] {
    const out: ChatMessage[] = [];
    let group: Msg[] = [];
    const all = [...this.messages.values()];
    const flush = (trailing: boolean) => {
      if (group.length) out.push(this.assistantMessage(conversationId, group, trailing));
      group = [];
    };
    for (const m of all) {
      if (m.role === 'user') {
        flush(false);
        out.push(this.cached(`${conversationId}|${m.id}`, `u${m.rev}`, () => {
          // files sent by path are listed in the message's hidden text: shown as cards
          const { text, cards } = displayUserText(m.text, m.id);
          return {
            id: m.id,
            conversationId,
            role: 'USER',
            content: text + (m.attachmentNames.length ? `\n\n📎 ${m.attachmentNames.join(', ')}` : ''),
            toolCalls: [],
            isStreaming: false,
            attachments: [...m.images, ...cards],
            createdAt: m.created,
          };
        }));
      } else if (m.role === 'summary') {
        flush(false);
        out.push(
          this.cached(`${conversationId}|${m.id}`, `s${m.rev}`, () => ({
            id: m.id,
            conversationId,
            role: 'SUMMARY',
            content: m.text,
            contextSummary: m.text,
            toolCalls: [],
            isStreaming: false,
            attachments: [],
            createdAt: m.created,
          })),
        );
      } else group.push(m);
    }
    flush(true);
    // forget messages that are gone (reloaded history, removed prompts)
    if (this.cache.size > out.length) {
      const keep = new Set(out.map((m) => `${conversationId}|${m.id}`));
      for (const k of [...this.cache.keys()]) if (!keep.has(k)) this.cache.delete(k);
    }
    return out;
  }

  private cached(id: string, key: string, build: () => ChatMessage): ChatMessage {
    const hit = this.cache.get(id);
    if (hit && hit.key === key) return hit.msg;
    const msg = build();
    this.cache.set(id, { key, msg });
    return msg;
  }

  private assistantMessage(conversationId: string, steps: Msg[], trailing: boolean): ChatMessage {
    // only the reply after the newest prompt streams: right after a new prompt (before its reply has a step) the
    // previous reply is finished and keeps its usage card and actions
    const active = this.isTurnActive && trailing;
    const forms = trailing ? [...this.pendingForms.values()] : [];
    const key = `${steps.map((s) => `${s.id}:${s.rev}`).join(',')}|${active}|${trailing ? this.formsRev : ''}`;
    return this.cached(`${conversationId}|${steps[0].id}`, key, () => this.buildAssistant(conversationId, steps, active, forms));
  }

  private buildAssistant(conversationId: string, steps: Msg[], active: boolean, forms: Form[]): ChatMessage {
    const content: string[] = [];
    const thoughts: string[] = [];
    const tools: ToolCall[] = [];
    let prompt = 0;
    let output = 0;
    let cached = 0;
    let cacheWrite = 0;
    let cost = 0;
    let model: string | null = null;
    for (const step of steps) {
      model = step.model ?? model;
      for (const p of step.parts) {
        if (p.kind === 'REASONING') {
          const t = p.text.trim();
          if (t) {
            const tag = p.streaming && active ? ':streaming' : '';
            content.push(`<!-- thought${tag} -->\n${t}\n<!-- /thought -->`);
            thoughts.push(t);
          }
        } else if (p.kind === 'TEXT') {
          const t = p.text.trim();
          if (t) content.push(t);
        } else {
          const call = toolCall(p);
          if (!tools.some((t) => t.id === call.id)) {
            tools.push(call);
            content.push(`<!-- tool_call:${call.id} -->`);
          }
        }
      }
      if (step.error != null) {
        const err: Record<string, string> = {
          title: step.errorTitle ?? 'OpenCode error',
          userMessage: step.error,
          shortError: step.error,
          fullError: '',
        };
        if (step.errorAuth) err.action = 'opencode_providers';
        content.push(`<!-- error -->\n${JSON.stringify(err)}\n<!-- /error -->`);
      }
      prompt += step.inputTokens;
      output += step.outputTokens + step.reasoningTokens;
      cached += step.cacheRead;
      cacheWrite += step.cacheWrite;
      cost += step.cost;
    }
    // a question (form) is shown as a choice card at the end of the reply
    for (const f of forms) {
      const q = questionnaireOf(f);
      if (!q) continue;
      const id = formToolId(f.id);
      tools.push({ id, name: 'question', toolType: 'ASK_CHOICE', command: f.title || 'Question', status: 'AWAITING_CHOICE', output: '', interactionType: 'opencode', questionnaire: q });
      content.push(`<!-- tool_call:${id} -->`);
    }
    const first = steps[0];
    const last = steps[steps.length - 1];
    const started = first.created;
    const ended = last.completed;
    const total = prompt + output + cached + cacheWrite;
    const usage: TokenUsage | null =
      active || total === 0
        ? null
        : {
            promptTokens: prompt,
            outputTokens: output,
            cachedTokens: cached,
            cacheCreationTokens: cacheWrite,
            totalTokens: total,
            durationMs: ended != null && ended > started ? ended - started : 0,
            isEstimated: false,
            costUsd: cost > 0 ? cost : null,
            model,
          };
    const thought = thoughts.join('\n\n').trim();
    return {
      id: first.id,
      conversationId,
      role: 'ASSISTANT',
      content: content.join('\n\n').trim(),
      thoughtText: thought || null,
      toolCalls: tools,
      isStreaming: active,
      tokenUsage: usage,
      attachments: [],
      createdAt: started,
      modelId: model,
    };
  }
}

// ------------------------------------------------------------------ helpers

export function permissionOf(p: Json, fallbackSession = ''): Permission | null {
  const id = str(p, 'id');
  if (!id) return null;
  const src = obj(p, 'source');
  return {
    id,
    sessionId: str(p, 'sessionID') ?? fallbackSession,
    action: str(p, 'action') ?? '',
    resources: strings(arr(p, 'resources')),
    save: strings(arr(p, 'save')),
    toolCallId: str(src, 'id') ?? null,
    messageId: str(src, 'messageID') ?? null,
    metadata: obj(p, 'metadata') ?? {},
  };
}

function isAuthError(err: Json): boolean {
  const type = (str(err, 'type') ?? '').toLowerCase();
  const status = num(err, 'status');
  const text = `${str(err, 'message') ?? ''} ${str(obj(err, 'response'), 'body') ?? ''}`.toLowerCase();
  return (
    type.includes('auth') ||
    status === 401 ||
    status === 403 ||
    ['unauthorized', 'invalid api key', 'invalid_api_key', 'incorrect api key', 'expired', 'not signed in', 'invalid token', 'authentication'].some((s) => text.includes(s))
  );
}

function errorTitle(err: Json): string {
  const type = str(err, 'type') ?? '';
  if (type.includes('rate-limit')) return 'Rate limited';
  if (type.includes('auth')) return 'Not signed in to the provider';
  if (type.startsWith('provider')) return 'Provider error';
  return 'OpenCode error';
}

export function contentText(content: Json[]): string {
  return content
    .filter((c) => c && typeof c === 'object' && str(c, 'type') === 'text')
    .map((c) => str(c, 'text') ?? '')
    .join('\n')
    .trim();
}

export function toolTypeFor(name: string): ToolType {
  switch (name.toLowerCase()) {
    case 'shell':
    case 'bash':
    case 'pty':
    case 'terminal':
      return 'BASH';
    case 'read':
    case 'view':
      return 'VIEW_FILE';
    case 'edit':
    case 'write':
    case 'patch':
    case 'apply_patch':
    case 'multiedit':
      return 'EDIT_FILE';
    case 'glob':
    case 'find':
      return 'FIND';
    case 'grep':
    case 'search':
    case 'codesearch':
      return 'GREP_SEARCH';
    case 'list':
    case 'ls':
      return 'LIST_DIR';
    case 'websearch':
    case 'web_search':
      return 'SEARCH_WEB';
    case 'webfetch':
    case 'fetch':
    case 'web_fetch':
      return 'READ_URL';
    case 'question':
      return 'ASK_CHOICE';
    default:
      return name.includes('_') && !name.startsWith('todo') ? 'MCP' : 'UNKNOWN';
  }
}

export function describeTool(name: string, input: Json): string {
  const s = (...keys: string[]) => {
    for (const k of keys) {
      const v = str(input, k);
      if (v && v.trim()) return v;
    }
    return '';
  };
  const file = (...keys: string[]) => {
    const p = s(...keys);
    return p.split('/').pop() || p;
  };
  let out: string;
  switch (name.toLowerCase()) {
    case 'shell':
    case 'bash':
      out = s('command', 'cmd');
      break;
    case 'read':
    case 'view':
    case 'edit':
    case 'write':
    case 'patch':
    case 'multiedit':
      out = file('path', 'filePath', 'file_path');
      break;
    case 'apply_patch':
      out = 'Apply a patch';
      break;
    case 'glob':
    case 'find':
      out = s('pattern', 'glob');
      break;
    case 'grep':
    case 'search': {
      const where = s('path');
      out = s('pattern', 'query') + (where ? ` in ${where}` : '');
      break;
    }
    case 'list':
    case 'ls':
      out = s('path') || '.';
      break;
    case 'websearch':
    case 'web_search':
      out = s('query');
      break;
    case 'webfetch':
    case 'fetch':
      out = s('url');
      break;
    case 'task':
    case 'agent':
    case 'subagent':
      out = s('description', 'prompt').slice(0, 80) || 'Subagent';
      break;
    case 'todowrite': {
      const todos = arr(input, 'todos').filter((t) => t && typeof t === 'object');
      out = `Todo list (${todos.filter((t) => str(t, 'status') === 'completed').length}/${todos.length} done)`;
      break;
    }
    case 'skill':
      out = s('name', 'id');
      break;
    default: {
      const first = Object.values(input ?? {}).find((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
      out = first != null ? String(first).slice(0, 80) : '';
    }
  }
  return out.trim() ? out : name;
}

export function todoChecklist(input: Json): string {
  return arr(input, 'todos')
    .filter((t) => t && typeof t === 'object')
    .map((t) => `${str(t, 'status') === 'completed' ? '☑' : str(t, 'status') === 'in_progress' ? '◐' : '☐'} ${str(t, 'content') ?? ''}`)
    .join('\n');
}

function toolCall(p: Part): ToolCall {
  const status = p.awaitingPermission && p.toolStatus === 'RUNNING' ? 'PENDING_APPROVAL' : p.toolStatus;
  let output = p.toolOutput;
  if (p.toolError && !p.toolOutput.includes(p.toolError)) output += (output ? '\n' : '') + p.toolError;
  if (!output && p.toolName.toLowerCase() === 'todowrite') output = todoChecklist(p.toolInput);
  return {
    id: safeId(p.key.replace(/^tool:/, '')),
    name: p.toolName || 'tool',
    toolType: toolTypeFor(p.toolName),
    command: describeTool(p.toolName, p.toolInput),
    status,
    output,
    exitCode: p.exitCode,
    durationMs: p.startedAt != null && p.endedAt != null ? Math.max(0, p.endedAt - p.startedAt) : null,
    interactionType: 'opencode',
  };
}

/** A form's fields as choice questions (question id = the field key). */
export function questionnaireOf(f: Form): ChoiceQuestionnaire | null {
  const questions: ChoiceQuestion[] = [];
  for (const field of f.fields) {
    if (bool(field, 'hidden') === true) continue;
    const key = str(field, 'key');
    if (!key) continue;
    const prompt = str(field, 'title') ?? str(field, 'description') ?? key;
    const desc = str(field, 'description');
    const description = desc && desc !== prompt ? desc : null;
    switch (str(field, 'type')) {
      case 'multiselect': {
        const max = num(field, 'maxItems');
        const options: ChoiceOption[] = arr(field, 'options')
          .filter((o) => o && typeof o === 'object' && str(o, 'value') != null)
          .map((o) => ({ id: str(o, 'value')!, label: str(o, 'label') ?? str(o, 'value')!, description: str(o, 'description') ?? null }));
        questions.push({ id: key, prompt, description, isMultiSelect: max == null || max > 1, options, allowCustomAnswer: bool(field, 'custom') !== false });
        break;
      }
      case 'boolean':
        questions.push({
          id: key,
          prompt,
          description,
          isMultiSelect: false,
          options: [
            { id: 'true', label: 'Yes' },
            { id: 'false', label: 'No' },
          ],
          allowCustomAnswer: false,
        });
        break;
      case 'string':
      case 'number':
      case 'integer':
        questions.push({ id: key, prompt, description: description ?? str(field, 'placeholder') ?? null, isMultiSelect: false, options: [], allowCustomAnswer: true });
        break;
    }
  }
  if (!questions.length) return null;
  return { title: f.title || 'OpenCode has a question', questions, allowCustomNote: false };
}
