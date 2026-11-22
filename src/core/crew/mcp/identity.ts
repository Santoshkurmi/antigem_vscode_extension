// Who is calling the crew MCP server. A bot's tools act as that bot, so every call is tied to one crew thread:
//   Claude, Codex: the thread's own MCP URL carries `t=<thread>&cap=<HMAC(secret, thread)>` (per-process / per-thread
//     config; the URL outlives an editor reload, so the cap is derived from a persisted secret, not random per turn);
//   OpenCode: one shared server; OpenCode itself sends the calling session in `_meta["ai.opencode/sessionID"]`
//     (a client field, the model cannot set it);
//   Antigravity: one global server; the bot passes `cap: "<thread>.<cap>"` (its instructions give it).
// And a call only counts while that thread has a turn running (or just ended: GRACE_MS), so a leaked cap is useless
// between turns. (Verified with each engine's real MCP calls, 2026-11-22.)
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AgentKind } from '../../../../shared/model';
import type { ThreadRecord } from '../types';

export const GRACE_MS = 15_000;

export interface CallerLookup {
  thread(id: string): ThreadRecord | null;
  /** The crew thread whose chat the engine knows by this id (OpenCode's session id). */
  threadByEngineChat(engine: AgentKind, engineChatId: string): ThreadRecord | null;
}

export type Caller = { thread: ThreadRecord } | { error: string };

export class CrewIdentity {
  private live = new Map<string, { since: number; ended: number | null }>();

  constructor(private secret: Buffer) {}

  cap(threadId: string): string {
    return createHmac('sha256', this.secret).update(`crew-thread:${threadId}`).digest('hex').slice(0, 32);
  }

  /** The cap an Antigravity bot passes: "<thread>.<cap>". */
  argCap(threadId: string): string {
    return `${threadId}.${this.cap(threadId)}`;
  }

  verify(threadId: string, cap: string): boolean {
    const want = Buffer.from(this.cap(threadId));
    const got = Buffer.from(cap);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  beginTurn(threadId: string) {
    this.live.set(threadId, { since: Date.now(), ended: null });
  }

  endTurn(threadId: string) {
    const t = this.live.get(threadId);
    if (t) t.ended = Date.now();
  }

  inTurn(threadId: string, now = Date.now()): boolean {
    const t = this.live.get(threadId);
    if (!t) return false;
    if (t.ended === null) return true;
    if (now - t.ended <= GRACE_MS) return true;
    this.live.delete(threadId);
    return false;
  }

  /** When this thread's current (or last) turn began (null = none known). */
  turnStarted(threadId: string): number | null {
    return this.live.get(threadId)?.since ?? null;
  }

  /** Threads with a turn running now. */
  working(): string[] {
    return [...this.live.entries()].filter(([id]) => this.inTurn(id)).map(([id]) => id);
  }

  /**
   * The caller of one tools/call: from the server URL's query, the call's _meta and its arguments. A known caller
   * outside a turn is refused too.
   */
  resolve(query: URLSearchParams, meta: Record<string, unknown> | null, args: Record<string, unknown>, lookup: CallerLookup): Caller {
    let thread: ThreadRecord | null = null;
    const t = query.get('t');
    const engine = query.get('engine');
    if (t) {
      if (!this.verify(t, query.get('cap') ?? '')) return { error: 'This crew link is not valid (wrong or old cap).' };
      thread = lookup.thread(t);
    } else if (engine === 'opencode') {
      const sid = meta?.['ai.opencode/sessionID'];
      if (typeof sid !== 'string' || !sid) return { error: 'OpenCode did not say which chat calls.' };
      thread = lookup.threadByEngineChat('OPENCODE', sid);
      if (!thread) return { error: 'Crew tools are only for AntiGem Crew bots; this chat is not one.' };
    } else {
      const cap = typeof args.cap === 'string' ? args.cap.trim() : '';
      const dot = cap.lastIndexOf('.');
      if (dot <= 0) return { error: 'Pass your crew cap (from your instructions) as the "cap" argument.' };
      const id = cap.slice(0, dot);
      if (!this.verify(id, cap.slice(dot + 1))) return { error: 'This cap is not valid. Use the exact cap from your instructions.' };
      thread = lookup.thread(id);
    }
    if (!thread) return { error: 'This crew thread no longer exists.' };
    if (!this.inTurn(thread.id)) return { error: 'Crew tools work only while you are answering in the crew (no turn is running for this chat).' };
    return { thread };
  }
}
