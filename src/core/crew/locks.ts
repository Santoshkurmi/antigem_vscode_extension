// One turn at a time per bot across the whole crew (docs/crew/PLAN.md §7 "Turn-taking"): its DM, every room it sits in
// and its jobs share one "busy" mark, so a bot never answers in two places at once and each answer sees what it just
// did. Rooms and jobs wait for the bot (showing where it is busy); the user's own DM messages never wait, they only
// mark it busy.

export interface Holder {
  token: number;
  /** "#Room", "its DM", "job j_7f…" */
  where: string;
  since: number;
}

const POLL_MS = 400;

export class BotLocks {
  private held = new Map<string, Holder[]>();
  private seq = 0;
  /** Called whenever a bot becomes busy or free (the Crew screen's working rings). */
  onChange: (() => void) | null = null;

  /** Where the bot is busy now (null = free). */
  busy(botId: string): Holder | null {
    return this.held.get(botId)?.[0] ?? null;
  }

  /** Marks the bot busy now, even if it already is (a DM turn the user started). Returns the release. */
  mark(botId: string, where: string): () => void {
    const h: Holder = { token: ++this.seq, where, since: Date.now() };
    const list = this.held.get(botId) ?? [];
    list.push(h);
    this.held.set(botId, list);
    this.onChange?.();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const cur = (this.held.get(botId) ?? []).filter((x) => x.token !== h.token);
      if (cur.length) this.held.set(botId, cur);
      else this.held.delete(botId);
      this.onChange?.();
    };
  }

  /**
   * Waits until the bot is free, then marks it busy. Null = cancelled or still busy after timeoutMs. `onWait` is told
   * where it is busy (again when that changes).
   */
  async acquire(botId: string, where: string, opts: { cancelled(): boolean; onWait?(busyWhere: string): void; timeoutMs?: number } = { cancelled: () => false }): Promise<(() => void) | null> {
    const until = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
    let told: string | null = null;
    for (;;) {
      if (opts.cancelled()) return null;
      const h = this.busy(botId);
      if (!h) return this.mark(botId, where);
      if (Date.now() > until) return null;
      if (h.where !== told) {
        told = h.where;
        opts.onWait?.(h.where);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}
