// Turns the engine starts itself, outside DMs and rooms (engine.ts): a turn on a crew thread as its bot (automation
// runs, check-backs), one quick question to an engine's cheapest model, and the check of a job's work before it is done.
import { randomUUID } from 'node:crypto';
import type { AgentKind } from '../../../shared/model';
import { ENGINES } from './bots';
import type { CrewEngine, CrewEngineApi } from './engine';
import { checkPrompt } from './jobs/check';
import { ENGINE_LABEL } from './prompts/stable';
import { cheapTurn } from './turns/cheap';
import { runTurn, type TurnResult } from './turns/runner';
import type { BotProfile, JobRow, ThreadRecord } from './types';

export class BotTurns {
  constructor(
    private e: CrewEngine,
    private api: () => CrewEngineApi | null,
  ) {}

  private get store() {
    return this.e.crew.store;
  }

  /**
   * A turn on a crew thread as its bot (automation runs, check-backs, asking a bot from the Automations page): waits
   * until the bot is free, its setup, its permission requests through the broker. Null = it stayed busy.
   */
  async runOnThread(t: ThreadRecord, text: string, where: string, opts: { timeoutMs: number; waitMs: number; isNew?: boolean }): Promise<TurnResult | null> {
    const b = t.botId ? this.store.bot(t.botId) : null;
    const be = b ? this.api()?.backend(b.engine) : undefined;
    if (!b || !be) return null;
    const release = await this.e.locks.acquire(b.id, where, { cancelled: () => false, timeoutMs: opts.waitMs });
    if (!release) return null;
    let cur = this.store.thread(t.id) ?? t;
    const isNew = opts.isNew ?? !cur.chatId;
    if (!cur.chatId) {
      cur = { ...cur, chatId: randomUUID(), engine: b.engine };
      this.store.putThread(cur);
      this.e.changed(true);
    }
    const chatId = cur.chatId!;
    const setup = this.e.crew.setupFor(cur);
    const folders = this.e.foldersOf(b, setup.access);
    const folder = setup.access === 'talk' || setup.access === 'read' ? this.store.botFolder(b.id) : (b.folder ?? this.api()?.workspaceFolder() ?? this.store.botFolder(b.id));
    this.e.crew.identity.beginTurn(cur.id);
    this.e.changed(false);
    try {
      const res = await runTurn({
        backend: be,
        agent: cur.engine,
        chatId,
        isNew,
        text,
        modelId: b.model,
        folder,
        effort: b.effort,
        setup,
        access: setup.access,
        cancelled: () => false,
        isRunning: cur.engine === 'AGY' ? () => this.api()?.isRunning?.('AGY', chatId) ?? false : undefined,
        approve: (a) => this.e.inbox.broker.approve({ botId: b.id, access: setup.access, approval: a, folders, where, chat: { engine: cur.engine, chatId } }),
        timeoutMs: opts.timeoutMs,
      });
      this.e.crew.usage.log(b.id, cur.kind, res.usage);
      return res;
    } catch (e) {
      if (isNew) this.store.putThread({ ...cur, chatId: null });
      throw e;
    } finally {
      this.e.crew.identity.endTurn(cur.id);
      this.e.jobs.turnEnded(cur.id);
      release();
      this.e.changed(false);
    }
  }

  /** One question to an engine's cheapest model (the goal judge, memory capture). */
  async cheap(engine: AgentKind, text: string): Promise<string> {
    const be = this.api()?.backend(engine);
    if (!be) return '';
    return cheapTurn(be, engine, text, this.store.botFolder('_helper'), { isRunning: (id) => this.api()?.isRunning?.(engine, id) ?? false });
  }

  /**
   * Check before done: the checking bot (its engine and model, in its role) or ('auto') the quickest model of another
   * engine than the bot's own (a second opinion; Antigravity last, it is slow to start). Null = none could run.
   */
  async checkWork(j: JobRow, b: BotProfile): Promise<{ by: string; reply: string } | null> {
    const ready = (this.api()?.enabledKinds() ?? ENGINES).filter((k) => {
      const st = this.api()?.backend(k)?.status().state;
      return !!st && st !== 'not_installed' && st !== 'disabled';
    });
    const checker = b.checkWork && b.checkWork !== 'auto' ? this.store.bot(b.checkWork) : null;
    let engine: AgentKind;
    let model: string | null = null;
    let by: string;
    let persona: string | null = null;
    if (checker && checker.id !== b.id && ready.includes(checker.engine)) {
      engine = checker.engine;
      model = checker.model;
      by = checker.name;
      persona = `${checker.name}${checker.title ? `, ${checker.title}` : ''}${checker.description ? ` (${checker.description})` : ''}`;
    } else {
      const order = [...ready.filter((k) => k !== b.engine && k !== 'AGY'), ...ready.filter((k) => k !== b.engine && k === 'AGY'), b.engine];
      engine = order.find((k) => ready.includes(k)) ?? b.engine;
      by = `a quick ${ENGINE_LABEL[engine]} model`;
    }
    const be = this.api()?.backend(engine);
    if (!be) return null;
    const reply = await cheapTurn(be, engine, checkPrompt(j, b.name, persona), this.store.botFolder('_helper'), { model, timeoutMs: 3 * 60_000, isRunning: (id) => this.api()?.isRunning?.(engine, id) ?? false });
    return reply.trim() ? { by, reply } : null;
  }
}
