// Bots' memory around their turns (engine.ts; DMs, rooms and jobs all use it): the notes a bot recalls for a turn's
// text, and capture (answered turns are kept, then a quick model files the new facts).
import { labeledBlock } from '../text';
import type { CrewEngine, CrewEngineApi } from './engine';
import { capturePrompt, parseCapture } from './memory/memory';

/** Memory capture: after this long without a turn (or 6 turns) a quick model files new facts. A test may shorten it. */
export const MEMORY_TIMING = { captureQuietMs: 2 * 60_000, captureTurns: 6 };

export class TurnMemory {
  /** Turns waiting to be filed into memory (per bot). */
  private captures = new Map<string, { lines: string[]; turns: number; timer: NodeJS.Timeout | null; source: string }>();

  constructor(
    private e: CrewEngine,
    private api: () => CrewEngineApi | null,
  ) {}

  private get store() {
    return this.e.crew.store;
  }

  /** Notes a bot recalls for a turn's text, as a hidden block ('' = nothing matches, or memory is off). */
  recall(botId: string, text: string): string {
    const b = this.store.bot(botId);
    if (!b?.memory.enabled) return '';
    const r = this.e.memory.recall(botId, text);
    return r ? labeledBlock('🧠 You remember', r) : '';
  }

  /** A bot answered: kept for memory capture (after 2 min of quiet, or 6 turns, a quick model files new facts). */
  noteTurn(botId: string, where: string, ask: string, reply: string) {
    const b = this.store.bot(botId);
    if (!b?.memory.enabled || !b.memory.capture || !reply.trim()) return;
    const c = this.captures.get(botId) ?? { lines: [], turns: 0, timer: null, source: where };
    c.lines.push(`(${where})\n${ask.trim().slice(-1500)}\n${b.name}: ${reply.trim().slice(0, 1500)}`);
    c.lines = c.lines.slice(-12);
    c.turns++;
    c.source = where;
    this.captures.set(botId, c);
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    if (c.turns >= MEMORY_TIMING.captureTurns) void this.capture(botId);
    else c.timer = setTimeout(() => void this.capture(botId), MEMORY_TIMING.captureQuietMs);
  }

  private async capture(botId: string) {
    const c = this.captures.get(botId);
    const b = this.store.bot(botId);
    this.captures.delete(botId);
    if (!c || !b) return;
    if (c.timer) clearTimeout(c.timer);
    const reply = await this.e.cheap(b.engine, capturePrompt(b.name, this.e.memory.core(botId), c.lines.join('\n\n')));
    let n = 0;
    for (const f of parseCapture(reply, this.e.memory.core(botId))) {
      try {
        if (!this.e.memory.add(botId, { text: f.text, topic: f.topic ?? null, source: c.source, actor: 'capture' }).duplicate) n++;
      } catch {
        /* a fact it could not file */
      }
    }
    if (n) {
      this.api()?.log(`[crew] ${b.name} remembered ${n} new thing${n === 1 ? '' : 's'}`);
      this.e.changed(false);
    }
  }

  /** Drops the turns still waiting (the engine is going away). */
  dispose() {
    for (const c of this.captures.values()) if (c.timer) clearTimeout(c.timer);
  }
}
