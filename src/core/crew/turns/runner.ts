// One bot turn on any engine (docs/crew/PLAN.md §5 "Turn runner"): send to the bot's hidden chat, watch it (live
// activity, permission requests answered by its access level, questions turned back), settle when it is quiet, and
// return a TurnResult: its final words (after the last tool call; thinking and markers out), what it did (evidence
// from its tool calls), its tokens, and a question when it needs one answered. Rooms and jobs both run turns here.
import type { AgentKind, ChatAttachment, ChatMessage, TokenUsage, ToolCall } from '../../../../shared/model';
import type { ApprovalView } from '../../../../shared/protocol';
import { describeApproval } from '../../jarvis/controller';
import * as JText from '../../jarvis/text';
import { pathToUri } from '../../paths';
import type { AgentBackend, ChatState, CrewAccess, ThreadSetup } from '../../types';
import type { ApproveResult } from '../access/broker';
import type { Evidence } from '../types';
import { evidenceOf } from './evidence';

/** A turn that never ends is stopped after this long. */
export const TURN_TIMEOUT_MS = 10 * 60_000;
/** A turn that has not started within this long failed (agent down, send lost). */
export const START_TIMEOUT_MS = 90_000;
/** Quiet this long after running = the turn is over (some agents end one step and start the next). */
const SETTLE_MS = 1200;
/** The live step line changes at most this often. */
const STEP_EVERY_MS = 2000;

export interface Activity {
  kind: 'typing' | 'working';
  /** What it does now ("editing api.ts"), or null while it writes. */
  step: string | null;
}

export interface TurnSpec {
  backend: AgentBackend;
  agent: AgentKind;
  chatId: string;
  isNew: boolean;
  text: string;
  attachments?: ChatAttachment[];
  modelId?: string | null;
  /** The folder a new chat runs in. */
  folder: string;
  effort?: string;
  setup?: ThreadSetup | null;
  access: CrewAccess;
  cancelled(): boolean;
  /** Antigravity: the chat list says whether it runs (its state may lag). */
  isRunning?(): boolean;
  onActivity?(a: Activity): void;
  /** Answers a permission request (default: by `access`), at once or after the user answered it in the Inbox. */
  approve?(a: ApprovalView): ApproveResult;
  /** What a refused request is told. */
  denyNote?: string;
  /** What a question card is told when it is skipped. */
  questionNote?: string;
  /** A turn that used tools but said nothing is asked once for a short reply (default true). */
  reask?: boolean;
  timeoutMs?: number;
  /** Quiet this long after running = done (default SETTLE_MS; a tool-less router turn can settle sooner). */
  settleMs?: number;
}

export interface TurnResult {
  cancelled: boolean;
  /** Everything it wrote this turn (markers included). */
  raw: string;
  /** Its final words. */
  text: string;
  error: string | null;
  evidence: Evidence;
  toolCalls: ToolCall[];
  usage: TokenUsage | null;
  /** A question card it opened (skipped), or a "NEEDS INPUT:" line of its reply. */
  question: string | null;
  timedOut: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The default policy until the Inbox (Phase 4): talk denies all, read allows reads, edit and up allow. */
export function approveByAccess(access: CrewAccess, a: ApprovalView): 'allow' | 'deny' {
  if (access === 'talk') return 'deny';
  if (access === 'read') return describeApproval(a).risk === 'READ' ? 'allow' : 'deny';
  return 'allow';
}

const DENY_NOTE: Record<CrewAccess, string> = {
  talk: 'You are talk-only here. Do not use tools; just reply.',
  read: 'You have read-only access here. Do not change anything; reply instead.',
  edit: 'Not allowed here.',
  auto: 'Not allowed here.',
  full: 'Not allowed here.',
};

export async function runTurn(spec: TurnSpec): Promise<TurnResult> {
  const { backend, chatId } = spec;
  let state: ChatState | null = null;
  const unsub = backend.subscribe(chatId, (s) => (state = s));
  try {
    if (!state) {
      try {
        state = backend.getState(chatId);
      } catch {
        state = null;
      }
    }
    // an existing chat loads its history first, so the agent resumes it
    if (!spec.isNew) {
      const until = Date.now() + 10_000;
      while (Date.now() < until && (!state || (state as ChatState).isLoading)) await sleep(200);
    }
    const first = await sendAndWait(spec, () => state, spec.text, spec.isNew, spec.attachments ?? []);
    if (first.cancelled) return cancelledResult();
    let s = state as ChatState | null;
    let from = first.from;
    let raw = s ? replyAfter(s.messages, from) : '';
    let calls = s ? callsAfter(s.messages, from) : [];
    let { text, error } = finalReply(raw);
    // it worked but said nothing: one short re-ask (never new work)
    if (!text && !error && calls.length && spec.reask !== false && !first.timedOut && !spec.cancelled()) {
      const again = await sendAndWait({ ...spec, attachments: [] }, () => state, 'Reply now with one short message saying what you did and found. Do not start new work.', false, []);
      if (again.cancelled) return cancelledResult();
      s = state as ChatState | null;
      if (s) {
        const more = replyAfter(s.messages, again.from);
        raw = `${raw}\n\n${more}`;
        calls = [...calls, ...callsAfter(s.messages, again.from)];
        ({ text, error } = finalReply(more));
      }
      from = again.from;
    }
    if (!raw.trim() && s?.error) error = s.error;
    const question = first.question ?? needsInput(text);
    return {
      cancelled: false,
      raw,
      text,
      error,
      evidence: evidenceOf(calls),
      toolCalls: calls,
      usage: s ? usageAfter(s.messages, from) : null,
      question,
      timedOut: first.timedOut,
    };
  } finally {
    unsub();
  }
}

function cancelledResult(): TurnResult {
  return { cancelled: true, raw: '', text: '', error: null, evidence: evidenceOf([]), toolCalls: [], usage: null, question: null, timedOut: false };
}

/** Sends one message and waits until the turn settles. `from` = index of the message sent (its reply follows it). */
async function sendAndWait(
  spec: TurnSpec,
  get: () => ChatState | null,
  text: string,
  isNew: boolean,
  attachments: ChatAttachment[],
): Promise<{ cancelled: boolean; timedOut: boolean; from: number; question: string | null }> {
  const { backend, chatId } = spec;
  const usersBefore = countUsers(get());
  await backend.send({
    conversationId: chatId,
    isNew,
    text,
    attachments,
    modelId: isNew ? (spec.modelId ?? null) : null,
    workspaceUri: isNew ? pathToUri(spec.folder) : null,
    effort: isNew && spec.effort && spec.effort !== 'default' ? spec.effort : null,
    thinking: null,
    setup: spec.setup ?? null,
  });
  const started = Date.now();
  const limit = spec.timeoutMs ?? TURN_TIMEOUT_MS;
  let seenRunning = false;
  let quietSince = 0;
  let question: string | null = null;
  const handled = new Set<string>();
  let lastStep: string | null = null;
  let lastStepAt = 0;
  /** Requests waiting on the user (Inbox): key → cancel. Time spent waiting does not count toward the limit. */
  const asking = new Map<string, () => void>();
  let waited = 0;
  let tick = Date.now();
  const answer = (a: ApprovalView, r: { allow: boolean; note?: string }) =>
    r.allow ? backend.approval(chatId, a.key, a.primary.id, false).catch(() => undefined) : backend.approval(chatId, a.key, undefined, true, r.note ?? spec.denyNote ?? DENY_NOTE[spec.access]).catch(() => undefined);
  const done = () => {
    for (const c of asking.values()) c();
    asking.clear();
  };
  for (;;) {
    if (spec.cancelled()) {
      done();
      await backend.stop(chatId).catch(() => undefined);
      return { cancelled: true, timedOut: false, from: 0, question };
    }
    await sleep(spec.settleMs !== undefined && spec.settleMs < 400 ? 150 : 400);
    const s = get();
    const now = Date.now();
    if (asking.size) waited += now - tick;
    tick = now;
    if (s) {
      for (const a of s.approvals) {
        if (handled.has(a.key)) continue;
        handled.add(a.key);
        const r: ApproveResult = spec.approve ? spec.approve(a) : approveByAccess(spec.access, a) === 'allow' ? { allow: true } : { allow: false };
        if ('wait' in r) {
          asking.set(a.key, r.cancel);
          void r.wait.then((x) => {
            if (!asking.delete(a.key)) return;
            void answer(a, x);
          });
        } else await answer(a, r);
      }
      // a request answered elsewhere (the chat card, the agent gave up): its Inbox item goes
      for (const [k, cancel] of asking) {
        if (!s.approvals.some((a) => a.key === k)) {
          cancel();
          asking.delete(k);
        }
      }
      if (s.question && !handled.has(`q:${s.question.key}`)) {
        handled.add(`q:${s.question.key}`);
        question = questionText(s.question);
        await backend.answer(chatId, s.question.key, {}, spec.questionNote ?? 'Nobody can answer question cards here: put your question in your reply instead.', true).catch(() => undefined);
      }
    }
    const busy = !!s?.isStreaming || !!spec.isRunning?.() || !!s?.approvals.length;
    if (busy) {
      seenRunning = true;
      quietSince = 0;
      const step = stepOf(s);
      if (step !== lastStep && (now - lastStepAt > STEP_EVERY_MS || step === null || lastStep === null)) {
        lastStep = step;
        lastStepAt = now;
        spec.onActivity?.({ kind: step ? 'working' : 'typing', step });
      }
    } else {
      const replied = countUsers(s) > usersBefore && hasReplyAfterLastUser(s);
      if (seenRunning || replied) {
        if (!quietSince) quietSince = now;
        if (now - quietSince > (spec.settleMs ?? SETTLE_MS)) break;
      } else if (now - started > START_TIMEOUT_MS) {
        throw new Error(s?.error || 'the agent did not start');
      }
    }
    if (now - started - waited > limit) {
      done();
      await backend.stop(chatId).catch(() => undefined);
      return { cancelled: false, timedOut: true, from: lastUserIndex(get()?.messages ?? []), question };
    }
  }
  done();
  return { cancelled: false, timedOut: false, from: lastUserIndex(get()?.messages ?? []), question };
}

// ------------------------------------------------------------------------------------------------ reading a turn

const TOOL_MARK = /<!--\s*tool_call:[^>]*-->/g;

/**
 * A turn's words as a message: thinking, tool markers and hidden blocks out. When it used tools, what it wrote before
 * the last tool call was narration ("let me check…"): only the words after it are its answer.
 */
export function finalReply(raw: string): { text: string; error: string | null } {
  const marks = [...raw.matchAll(TOOL_MARK)];
  if (marks.length) {
    const last = marks[marks.length - 1];
    const after = JText.reply(raw.slice(last.index! + last[0].length));
    if (after.text) return after;
  }
  return JText.reply(raw);
}

/** "NEEDS INPUT: …" at the start of a line of its reply. */
export function needsInput(text: string): string | null {
  const m = /^\s*\**NEEDS INPUT\**\s*:\s*(.+)$/im.exec(text);
  return m ? m[1].trim().slice(0, 600) : null;
}

function questionText(q: NonNullable<ChatState['question']>): string {
  const qn = q.questionnaire;
  const parts = [qn?.title, ...(qn?.questions ?? []).map((x) => `${x.prompt}${x.options.length ? ` (${x.options.map((o) => o.label).join(' / ')})` : ''}`)].filter(
    (x): x is string => !!x && !!x.trim(),
  );
  return parts.join(' — ').slice(0, 600) || 'a question';
}

/** The tokens of a chat's last turn (everything after the last user message). */
export function lastTurnUsage(msgs: ChatMessage[]): TokenUsage | null {
  return usageAfter(msgs, lastUserIndex(msgs));
}

export function countUsers(s: ChatState | null): number {
  return s ? s.messages.filter((m) => m.role === 'USER').length : 0;
}

function lastUserIndex(msgs: ChatMessage[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'USER') return i;
  return -1;
}

function hasReplyAfterLastUser(s: ChatState | null): boolean {
  if (!s) return false;
  const i = lastUserIndex(s.messages);
  return s.messages.slice(i + 1).some((m) => m.role === 'ASSISTANT' && m.content.trim());
}

/** Everything the agent wrote after message [from] (one turn may be several messages). */
function replyAfter(msgs: ChatMessage[], from: number): string {
  return msgs
    .slice(from + 1)
    .filter((m) => m.role === 'ASSISTANT')
    .map((m) => m.content)
    .join('\n\n');
}

function callsAfter(msgs: ChatMessage[], from: number): ToolCall[] {
  return msgs.slice(from + 1).flatMap((m) => m.toolCalls ?? []);
}

/** The turn's tokens (summed over its messages). */
function usageAfter(msgs: ChatMessage[], from: number): TokenUsage | null {
  const list = msgs
    .slice(from + 1)
    .map((m) => m.tokenUsage)
    .filter((u): u is TokenUsage => !!u);
  if (!list.length) return null;
  const sum = (k: 'promptTokens' | 'outputTokens' | 'cachedTokens' | 'cacheCreationTokens' | 'totalTokens' | 'durationMs') => list.reduce((n, u) => n + (u[k] || 0), 0);
  const costs = list.map((u) => u.costUsd).filter((c): c is number => typeof c === 'number');
  return {
    promptTokens: sum('promptTokens'),
    outputTokens: sum('outputTokens'),
    cachedTokens: sum('cachedTokens'),
    cacheCreationTokens: sum('cacheCreationTokens'),
    totalTokens: sum('totalTokens'),
    durationMs: sum('durationMs'),
    isEstimated: list.some((u) => u.isEstimated),
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    model: list[list.length - 1].model ?? null,
  };
}

/** What a running turn is doing now, in a few words ("editing api.ts"); null = writing. */
function stepOf(s: ChatState | null): string | null {
  if (!s) return null;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.role === 'USER') return null;
    const c = [...(m.toolCalls ?? [])].reverse().find((t) => t.status === 'RUNNING');
    if (c) return describeCall(c);
  }
  return null;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function describeCall(c: ToolCall): string {
  const cmd = (c.command || '').split('\n')[0].trim();
  switch (c.toolType) {
    case 'BASH':
      return `running ${cmd.slice(0, 48) || 'a command'}`;
    case 'EDIT_FILE':
      return `editing ${baseName(cmd.split(',')[0] ?? '') || 'files'}`;
    case 'VIEW_FILE':
      return `reading ${baseName(cmd) || 'a file'}`;
    case 'GREP_SEARCH':
    case 'FIND':
    case 'LIST_DIR':
      return 'searching the files';
    case 'SEARCH_WEB':
    case 'READ_URL':
      return 'on the web';
    case 'MCP':
      return /crew_/.test(c.name) ? 'talking to the crew' : `using ${(c.name || 'a tool').replace(/^mcp__/, '').replace(/__/g, ' ')}`;
    default:
      return `using ${c.label || c.name || 'a tool'}`;
  }
}
