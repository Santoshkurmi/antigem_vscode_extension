// Automations (docs/crew/PLAN.md §13): "when X happens, bot Y does Z". Schedules (with one catch-up of the newest
// missed run, ≤ 12 h late), editor events (batched, ≤ 24 AI runs a day each), webhooks (a local receiver: only
// /hooks/<id>, bearer token), waits (plain-code checks, no AI until true) and check-backs. Each run is a turn on the
// automation's own hidden thread; "NOTHING NEW" posts nothing, "Needs input:" asks the user in the Inbox, a result
// posts in its room (or as a notice). An overlapping run is skipped and counted; a blip is retried once; failures
// never turn it off (three in a row: "Needs you").
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { labeledBlock } from '../../text';
import type { Crew } from '../crew';
import type { BotLocks } from '../locks';
import { newId } from '../store/store';
import type { TurnResult } from '../turns/runner';
import type { ThreadRecord } from '../types';
import { AutomationStore, newAutomation, today, type Automation, type PostTo, type RunStatus } from './store';
import { describeWhen, globTest, nextRun, type EditorEvent, type When } from './when';

/** Timing a test may shorten: the check tick, the event batch window, the retry after a blip. */
export const AUTO_TIMING = { tickMs: 30_000, batchMs: 5_000, retryMs: 60_000 };
const CATCH_UP_MS = 12 * 3600_000;
const AI_RUNS_A_DAY = 24;
const RUN_LIMIT_MS = 60 * 60_000;
const NEW_CHAT_EVERY = 20;

export interface AutomationDeps {
  crew: Crew;
  locks: BotLocks;
  isPaused(botId: string): boolean;
  /** A turn on a crew thread as its bot (waits until the bot is free; null = it stayed busy). */
  runOnThread(t: ThreadRecord, text: string, where: string, opts: { timeoutMs: number; waitMs: number }): Promise<TurnResult | null>;
  /** A bot line in a room (no turn), headed with the automation's name. */
  roomPost?(roomId: string, botId: string, text: string, label: string): void;
  /** A member's turn in its room (a check-back made in a room). */
  roomTurn?(roomId: string, botId: string, text: string): Promise<string | null>;
  /** An Inbox question (Needs input); resolves with the answer. */
  ask(fields: { botId: string; title: string; why: string; detail: string | null }): { promise: Promise<{ choice: string; note?: string | null }>; cancel(): void };
  notify(text: string, open?: () => void): void;
  showChat(chatId: string, engine: ThreadRecord['engine']): void;
  /** A run failed for good (the Chief may look at it). */
  onFailed?(a: Automation, why: string): void;
  changed(): void;
  log(line: string): void;
  webhookPort(): number;
}

export interface CreateInput {
  name: string;
  botId: string;
  when: When;
  instructions: string;
  postTo: PostTo;
  threadId?: string | null;
}

export class Automations {
  readonly store: AutomationStore;
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();
  private checking = new Set<string>();
  private batches = new Map<string, { timer: NodeJS.Timeout; details: string[] }>();
  private server: http.Server | null = null;
  private pendingHooks = new Map<string, number>();

  constructor(private d: AutomationDeps) {
    this.store = new AutomationStore(d.crew.store.root);
  }

  private get crewStore() {
    return this.d.crew.store;
  }

  start() {
    if (this.timer) return;
    this.catchUp();
    this.timer = setInterval(() => void this.tick(), AUTO_TIMING.tickMs);
    this.syncWebhook();
    setTimeout(() => void this.tick(), 2000);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const b of this.batches.values()) clearTimeout(b.timer);
    this.server?.close();
    this.server = null;
  }

  // ------------------------------------------------------------------ definitions

  sentence(a: Automation): string {
    const bot = this.crewStore.bot(a.botId);
    const room = a.postTo.kind === 'room' ? this.crewStore.room(a.postTo.roomId) : null;
    const first = a.instructions.split('\n')[0].replace(/\.$/, '');
    return `${describeWhen(a.when)}, ${bot?.name ?? '(a deleted bot)'}: ${first.length > 120 ? `${first.slice(0, 119)}…` : first}${room ? ` → #${room.name}` : ''}`;
  }

  private schedule(a: Automation, after = Date.now()): Automation {
    if (a.when.kind === 'schedule') a.nextRunAt = nextRun(a.when.schedule, after, a.createdAt);
    else if (a.when.kind === 'checkback') a.nextRunAt = a.when.at;
    else a.nextRunAt = null;
    return a;
  }

  create(by: string, input: CreateInput): Automation {
    if (!this.crewStore.bot(input.botId)) throw new Error('No such bot.');
    if (!input.instructions.trim()) throw new Error('Write the instructions: what the bot does when it runs (it will not see this chat).');
    const a = this.schedule(newAutomation({ ...input, name: input.name || input.instructions.split('\n')[0].slice(0, 60), createdBy: by, threadId: input.threadId ?? null }));
    if (a.when.kind === 'wait' && a.when.wait === 'file_changed') a.when = { ...a.when, text: String(fileStamp(a.when.target)) };
    const saved = this.store.put(a, by);
    this.syncWebhook();
    this.d.changed();
    return saved;
  }

  update(id: string, by: string, fields: Partial<Pick<Automation, 'name' | 'when' | 'instructions' | 'postTo' | 'botId'>>): Automation {
    const a = this.need(id);
    const next = this.schedule({ ...a, ...fields, needsFix: null, done: false });
    const saved = this.store.put(next, by);
    this.syncWebhook();
    this.d.changed();
    return saved;
  }

  setPaused(id: string, paused: boolean, by: string): Automation {
    const a = this.need(id);
    const saved = this.store.put(this.schedule({ ...a, paused }), by);
    this.d.changed();
    return saved;
  }

  remove(id: string, by: string) {
    this.need(id);
    this.store.delete(id, by);
    this.syncWebhook();
    this.d.changed();
  }

  undoLast(id: string): string {
    const c = this.store.lastChange(id);
    if (!c) throw new Error('Nothing to undo.');
    const msg = this.store.undo(c.id);
    this.syncWebhook();
    this.d.changed();
    return msg;
  }

  runNow(id: string) {
    void this.run(this.need(id), 'run now');
  }

  private need(id: string): Automation {
    const a = this.store.get(id) ?? this.store.all().find((x) => x.id.endsWith(id.replace(/^a_/, '')) && id.length >= 4);
    if (!a) throw new Error(`No automation ${id}.`);
    return a;
  }

  /** The bot's automations (crew_later list, crew_automation info). */
  of(botId: string): Automation[] {
    return this.store.all().filter((a) => a.botId === botId && !a.done);
  }

  // ------------------------------------------------------------------ triggers

  /** Schedules missed while the editor was closed: only the newest, if it is at most 12 h late. */
  private catchUp() {
    const now = Date.now();
    for (const a of this.store.all()) {
      if (a.paused || a.done || a.when.kind !== 'schedule' || !a.nextRunAt || a.nextRunAt > now) continue;
      const late = now - a.nextRunAt;
      this.schedule(a, now);
      this.store.touch(a);
      if (late <= CATCH_UP_MS) void this.run(a, 'catch-up (missed while the editor was closed)');
    }
  }

  private async tick() {
    const now = Date.now();
    for (const a of this.store.all()) {
      if (a.paused || a.done) continue;
      if ((a.when.kind === 'schedule' || a.when.kind === 'checkback') && a.nextRunAt && a.nextRunAt <= now) {
        if (a.when.kind === 'checkback') void this.checkBack(a);
        else {
          this.schedule(a, now);
          this.store.touch(a);
          void this.run(a, 'schedule');
        }
      } else if (a.when.kind === 'wait' && !this.checking.has(a.id)) {
        if (a.when.expiresAt < now) {
          this.finish(a, { done: true, lastStatus: 'skipped', lastResult: 'gave up waiting' });
          this.d.notify(`⏰ Stopped waiting: ${this.sentence(a)}`);
          continue;
        }
        this.checking.add(a.id);
        void this.condition(a)
          .then((ok) => (ok ? this.run(a, `waited: ${describeWhen(a.when)}`) : undefined))
          .finally(() => this.checking.delete(a.id));
      }
    }
  }

  /** An editor event (the host's watchers): matching automations run once per batch of events. */
  editorEvent(kind: EditorEvent, detail: string) {
    for (const a of this.store.all()) {
      if (a.paused || a.done || a.when.kind !== 'event' || a.when.event !== kind) continue;
      const filter = a.when.filter;
      const pathy = kind === 'file_saved' || kind === 'files_changed';
      if (filter && !(pathy ? globTest(filter)(detail) : detail.toLowerCase().includes(filter.toLowerCase()))) continue;
      const b = this.batches.get(a.id);
      if (b) {
        if (!b.details.includes(detail)) b.details.push(detail);
        continue;
      }
      const details = [detail];
      this.batches.set(a.id, {
        details,
        timer: setTimeout(() => {
          this.batches.delete(a.id);
          const cur = this.store.get(a.id);
          if (cur) void this.run(cur, `${kind.replace('_', ' ')}: ${details.slice(0, 10).join(', ')}${details.length > 10 ? ` (+${details.length - 10})` : ''}`);
        }, AUTO_TIMING.batchMs),
      });
    }
  }

  /** Event kinds and file globs some automation listens to (the host only watches those). */
  listening(): { events: Set<EditorEvent>; globs: string[] } {
    const events = new Set<EditorEvent>();
    const globs: string[] = [];
    for (const a of this.store.all()) {
      if (a.paused || a.done || a.when.kind !== 'event') continue;
      events.add(a.when.event);
      if (a.when.event === 'files_changed') globs.push(a.when.filter ?? '**/*');
    }
    return { events, globs };
  }

  // ------------------------------------------------------------------ runs

  private thread(a: Automation): ThreadRecord {
    const bot = this.crewStore.bot(a.botId)!;
    let t = this.crewStore.threads().find((x) => x.kind === 'automation' && x.jobId === a.id);
    if (t && (t.engine !== bot.engine || t.botId !== bot.id || a.threadRuns >= NEW_CHAT_EVERY)) {
      a.threadRuns = 0;
      t = { ...t, botId: bot.id, engine: bot.engine, chatId: null, setupKey: null };
    }
    if (!t) {
      const now = Date.now();
      t = { id: newId('t'), botId: bot.id, engine: bot.engine, chatId: null, kind: 'automation', roomId: null, jobId: a.id, seen: 0, setupKey: null, createdAt: now, updatedAt: now };
    }
    this.crewStore.putThread(t);
    return this.crewStore.thread(t.id)!;
  }

  private envelope(a: Automation, trigger: string): string {
    const room = a.postTo.kind === 'room' ? this.crewStore.room(a.postTo.roomId) : null;
    return labeledBlock(
      `⏰ Automation: ${a.name}`,
      [
        `It runs: ${describeWhen(a.when)}. This run: ${trigger}. Now: ${new Date().toString()}.`,
        '',
        'Instructions (they are all you get: you do not see the chat it was made in):',
        a.instructions.trim(),
        '',
        `Do it now, then reply with only the result to post${room ? ` in #${room.name}` : ''}.`,
        'If there is nothing new to report, reply with exactly NOTHING NEW (nothing is posted).',
        'If only the user can decide something, start your reply with "Needs input:" and the question.',
      ].join('\n'),
    );
  }

  /** One run (skipped when one is still going, the bot is paused, or today's AI runs are used up). */
  async run(a: Automation, trigger: string, retry = false): Promise<void> {
    if (this.running.has(a.id)) {
      a.skipped++;
      this.store.touch(a);
      return;
    }
    const bot = this.crewStore.bot(a.botId);
    if (!bot) return this.finish(a, { needsFix: 'its bot was deleted: pick another bot' });
    if (this.d.isPaused(a.botId)) return this.record(a, trigger, 'skipped', 'the bot is paused', 0);
    const over = this.d.crew.usage.overBudget();
    if (over) return this.record(a, trigger, 'skipped', over, 0);
    const capped = a.when.kind !== 'schedule' && a.when.kind !== 'checkback';
    if (a.runsToday.day !== today()) a.runsToday = { day: today(), count: 0 };
    if (capped && a.runsToday.count >= AI_RUNS_A_DAY) return this.record(a, trigger, 'skipped', `${AI_RUNS_A_DAY} runs today already`, 0);
    this.running.add(a.id);
    const started = Date.now();
    try {
      a.runsToday.count++;
      const t = this.thread(a);
      a.threadRuns++;
      this.store.touch(a);
      this.d.changed();
      const res = await this.d.runOnThread(t, this.envelope(a, trigger), `automation "${a.name}"`, { timeoutMs: RUN_LIMIT_MS, waitMs: 15 * 60_000 });
      if (!res) return this.record(a, trigger, 'skipped', `${bot.name} stayed busy`, Date.now() - started);
      const text = res.text.trim();
      if (!text) {
        if (!retry && !res.evidence.outward.length) {
          setTimeout(() => void this.run(this.store.get(a.id) ?? a, `${trigger} (retry)`, true), AUTO_TIMING.retryMs);
          return this.record(a, trigger, 'failed', res.error ?? 'no answer (trying once more in a minute)', Date.now() - started, false);
        }
        return this.record(a, trigger, 'failed', res.error ?? 'no answer', Date.now() - started);
      }
      if (/^\W*nothing new\W*$/i.test(text)) return this.record(a, trigger, 'nothing', 'nothing new', Date.now() - started);
      const ask = /^\s*\**needs input\**\s*:\s*([\s\S]+)/i.exec(text);
      if (ask) {
        this.record(a, trigger, 'needs-input', ask[1].trim(), Date.now() - started);
        const q = this.d.ask({ botId: bot.id, title: ask[1].trim().split('\n')[0].slice(0, 300), why: `automation "${a.name}"`, detail: ask[1].trim().slice(0, 2000) });
        void q.promise.then(async (ans) => {
          if (ans.choice !== 'answer' || !ans.note) return;
          const more = await this.d.runOnThread(this.thread(this.store.get(a.id) ?? a), `The user answered: ${ans.note}\n\nFinish the run: reply with only the result to post (or NOTHING NEW).`, `automation "${a.name}"`, { timeoutMs: RUN_LIMIT_MS, waitMs: 15 * 60_000 });
          const out = more?.text.trim() ?? '';
          if (out && !/^\W*nothing new\W*$/i.test(out)) this.deliver(this.store.get(a.id) ?? a, out, t);
        });
        return;
      }
      this.deliver(a, text, t);
      return this.record(a, trigger, 'ok', text, Date.now() - started);
    } catch (e) {
      return this.record(a, trigger, 'failed', e instanceof Error ? e.message : String(e), Date.now() - started);
    } finally {
      this.running.delete(a.id);
      this.d.changed();
    }
  }

  private deliver(a: Automation, text: string, t: ThreadRecord) {
    const bot = this.crewStore.bot(a.botId);
    if (a.postTo.kind === 'room' && this.d.roomPost && this.crewStore.room(a.postTo.roomId)) this.d.roomPost(a.postTo.roomId, a.botId, text, a.name);
    else if (a.postTo.kind !== 'none') {
      const chat = this.crewStore.thread(t.id);
      this.d.notify(`⏰ ${bot ? `${bot.emoji} ${bot.name}` : ''} · ${a.name}: ${text.split('\n').find((l) => l.trim())?.slice(0, 160) ?? ''}`, chat?.chatId ? () => this.d.showChat(chat.chatId!, chat.engine) : undefined);
    }
  }

  /** A run's outcome: history, state, "Needs you" after three failures in a row; one-shots end. */
  private record(a: Automation, trigger: string, status: RunStatus, result: string, ms: number, counts = true) {
    const cur = this.store.get(a.id) ?? a;
    this.store.addRun({ automationId: a.id, at: Date.now(), status, trigger, result: result.slice(0, 2000), ms });
    const failed = status === 'failed';
    const failures = failed && counts ? cur.failuresInRow + 1 : failed ? cur.failuresInRow : 0;
    const oneShot = (cur.when.kind === 'schedule' && cur.when.schedule.type === 'once') || cur.when.kind === 'wait';
    this.finish(cur, {
      lastRunAt: Date.now(),
      lastStatus: status,
      lastResult: result.slice(0, 2000),
      failuresInRow: failures,
      needsFix: failures >= 3 ? `failed ${failures} times in a row: ${result.slice(0, 200)}` : status === 'ok' || status === 'nothing' ? null : cur.needsFix,
      done: cur.done || (oneShot && (status === 'ok' || status === 'nothing' || status === 'needs-input')),
    });
    if (failed && counts && failures === 3) {
      this.d.notify(`⏰ "${cur.name}" needs you: it failed 3 times in a row`);
      this.d.onFailed?.(cur, result);
    }
  }

  private finish(a: Automation, fields: Partial<Automation>) {
    const cur = this.store.get(a.id);
    if (!cur) return;
    this.store.touch({ ...cur, ...fields });
    this.d.changed();
  }

  /** "Come back to this chat at …": a turn in the thread it was set in (its DM, its room, its work thread). */
  private async checkBack(a: Automation) {
    this.finish(a, { done: true, lastRunAt: Date.now(), lastStatus: 'ok' });
    const t = a.threadId ? this.crewStore.thread(a.threadId) : null;
    const text = `(The check-back you set: ${a.instructions})`;
    try {
      if (t?.kind === 'room' && t.roomId && this.d.roomTurn) await this.d.roomTurn(t.roomId, a.botId, text);
      else if (t) await this.d.runOnThread(t, text, 'a check-back', { timeoutMs: RUN_LIMIT_MS, waitMs: 30 * 60_000 });
      this.store.addRun({ automationId: a.id, at: Date.now(), status: 'ok', trigger: 'check-back', result: a.instructions.slice(0, 500), ms: 0 });
    } catch (e) {
      this.d.log(`[crew] check-back ${a.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ------------------------------------------------------------------ waits (no AI until true)

  private async condition(a: Automation): Promise<boolean> {
    if (a.when.kind !== 'wait') return false;
    const w = a.when;
    switch (w.wait) {
      case 'url_contains':
      case 'url_missing': {
        const body = await fetch(w.target, { signal: AbortSignal.timeout(10_000) })
          .then((r) => r.text())
          .catch(() => null);
        if (body === null) return false;
        const has = body.includes(w.text ?? '');
        return w.wait === 'url_contains' ? has : !has;
      }
      case 'file_exists':
        return fs.existsSync(w.target);
      case 'file_missing':
        return !fs.existsSync(w.target);
      case 'file_changed':
        return String(fileStamp(w.target)) !== (w.text ?? '');
      case 'process_running':
      case 'process_gone': {
        const list = await processes();
        if (list === null) return false;
        const has = list.toLowerCase().includes(w.target.toLowerCase());
        return w.wait === 'process_running' ? has : !has;
      }
      case 'bot_idle': {
        const b = this.crewStore.bots().find((x) => x.name.toLowerCase() === w.target.replace(/^@/, '').toLowerCase());
        return !!b && !this.d.locks.busy(b.id);
      }
    }
  }

  // ------------------------------------------------------------------ webhooks

  /** http://127.0.0.1:<port>/hooks/<id> (the receiver runs while some automation has a webhook). */
  webhookUrl(a: Automation): string {
    return `http://127.0.0.1:${this.d.webhookPort()}/hooks/${a.id}`;
  }

  private syncWebhook() {
    const want = this.store.all().some((a) => a.when.kind === 'webhook' && !a.done);
    if (want && !this.server) {
      this.server = http.createServer((req, res) => void this.hook(req, res));
      this.server.on('error', (e) => {
        this.d.log(`[crew] webhook receiver: ${e.message}`);
        this.server = null;
      });
      this.server.listen(this.d.webhookPort(), '127.0.0.1');
    } else if (!want && this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private async hook(req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (code: number, msg: string) => {
      res.writeHead(code, { 'content-type': 'text/plain' });
      res.end(msg);
    };
    const m = /^\/hooks\/([A-Za-z0-9_]+)$/.exec(req.url?.split('?')[0] ?? '');
    if (!m || req.method !== 'POST') return send(404, 'not found');
    const a = this.store.get(m[1]);
    if (!a || a.when.kind !== 'webhook' || a.done) return send(404, 'not found');
    if (req.headers.authorization !== `Bearer ${a.token}`) return send(401, 'bad token');
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 256 * 1024) return send(413, 'too big');
    }
    if (a.paused) return send(202, 'paused');
    if (a.when.filter && !body.includes(a.when.filter)) return send(202, 'filtered out');
    const pending = this.pendingHooks.get(a.id) ?? 0;
    if (pending >= 3) return send(429, 'too many pending runs');
    this.pendingHooks.set(a.id, pending + 1);
    send(202, 'queued');
    await this.run(a, `webhook: ${body.slice(0, 1500)}`).finally(() => this.pendingHooks.set(a.id, Math.max(0, (this.pendingHooks.get(a.id) ?? 1) - 1)));
  }
}

function fileStamp(p: string): number {
  try {
    const st = fs.statSync(p);
    return st.mtimeMs + st.size;
  } catch {
    return 0;
  }
}

/** Running processes as one text (null = could not list them). */
function processes(): Promise<string | null> {
  return new Promise((resolve) => {
    const [cmd, args] = process.platform === 'win32' ? ['tasklist', ['/fo', 'csv', '/nh']] : ['ps', ['-A', '-o', 'args=']];
    execFile(cmd, args as string[], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? null : out));
  });
}
