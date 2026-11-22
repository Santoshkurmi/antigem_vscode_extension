// What the crew spent (docs/crew/PLAN.md §17 Phase 9 "usage caps + cost meter"). usage.ndjson has one line per bot
// turn (DM, room, job, automation) with its tokens and, when the engine reports it, its cost. Today's totals feed the
// cost meter; the daily budget is checked before new work starts (a room turn, a hand-off, an automation run, the
// Chief's look at a failure). Work already running is never cut, and a DM the user writes still answers.
import fs from 'node:fs';
import path from 'node:path';
import type { TokenUsage } from '../../../shared/model';
import type { CrewStore } from './store/store';

export interface Spend {
  tokens: number;
  usd: number;
  turns: number;
}

interface UsageLine {
  at: number;
  botId?: string;
  input?: number;
  output?: number;
  costUsd?: number | null;
}

const empty = (): Spend => ({ tokens: 0, usd: 0, turns: 0 });
const add = (s: Spend, tokens: number, usd: number) => {
  s.tokens += tokens;
  s.usd += usd;
  s.turns++;
};

function startOfDay(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class UsageMeter {
  /** Today's totals and how far into usage.ndjson they are read (only new lines are read after that). */
  private acc: { day: number; offset: number; crew: Spend; bots: Map<string, Spend> } | null = null;

  constructor(private store: CrewStore) {}

  /** One bot turn's tokens (nothing is written when the engine reported none). */
  log(botId: string, kind: string, u: TokenUsage | null | undefined, extra: Record<string, unknown> = {}) {
    if (!u) return;
    this.store.logUsage({ botId, kind, ...extra, input: u.promptTokens, output: u.outputTokens, cached: u.cachedTokens, costUsd: u.costUsd ?? null });
  }

  /** Today's spend for the crew and per bot. */
  today(): { crew: Spend; bots: Map<string, Spend> } {
    const file = path.join(this.store.root, 'usage.ndjson');
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* nothing spent yet */
    }
    const day = startOfDay();
    // a new day, or the file was replaced: count again from the start
    if (!this.acc || this.acc.day !== day || size < this.acc.offset) this.acc = { day, offset: 0, crew: empty(), bots: new Map() };
    if (size > this.acc.offset) this.readFrom(file, size);
    return this.acc;
  }

  /** Adds today's lines between the last read and [size] (a half-written last line waits for the next read). */
  private readFrom(file: string, size: number) {
    const acc = this.acc!;
    let buf: Buffer;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        buf = Buffer.alloc(size - acc.offset);
        fs.readSync(fd, buf, 0, buf.length, acc.offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return;
    acc.offset += end + 1;
    for (const raw of buf.subarray(0, end).toString('utf8').split('\n')) {
      let l: UsageLine;
      try {
        l = JSON.parse(raw) as UsageLine;
      } catch {
        continue;
      }
      if (!l || !(l.at >= acc.day)) continue;
      const tokens = (l.input ?? 0) + (l.output ?? 0);
      const usd = typeof l.costUsd === 'number' ? l.costUsd : 0;
      add(acc.crew, tokens, usd);
      if (!l.botId) continue;
      const b = acc.bots.get(l.botId) ?? empty();
      add(b, tokens, usd);
      acc.bots.set(l.botId, b);
    }
  }

  /** Why new work may not start today (the daily budget is used up), or null. */
  overBudget(): string | null {
    const caps = this.store.settings().caps;
    if (!caps.dayTokens && !caps.dayUsd) return null;
    const t = this.today().crew;
    if (caps.dayTokens && t.tokens >= caps.dayTokens) return `the crew's daily budget of ${caps.dayTokens.toLocaleString('en-US')} tokens is used up`;
    if (caps.dayUsd && t.usd >= caps.dayUsd) return `the crew's daily budget of $${caps.dayUsd.toFixed(2)} is used up`;
    return null;
  }
}
