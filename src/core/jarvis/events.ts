// News for the Jarvis chats (port of the app's JarvisEvents.kt): a task finished, failed, got stuck, wants an approval
// or asks something, or the autopilot nudges an unfinished mission. News is queued per Jarvis chat and handed over in
// ONE message once that chat is free (everything that came in meanwhile, together), as a structured block the model
// cannot confuse with the user's words or with another chat's: `<jarvis_events>` with one `<event>` per item and the
// sub-agent's own reply inside `<task_reply>`. The chat shows only a one-line label (rendered as a card).
//
// It also guards the Jarvis chats: one that sleeps or polls while it waits for its tasks (a `sleep 60`, a wait loop,
// ScheduleWakeup…) is stopped so the news reaches it, and the autopilot keeps an unfinished mission going.
import type { JarvisEventView, ToolCall } from '../../../shared/model';
import { labeledBlock } from '../text';
import type { KeyValueStore } from '../types';
import type { JarvisEngine } from './engine';
import { missionActive } from './managers';
import { MCP_MISSING } from './skill';
import type { JarvisEvent } from './types';

const CARDS_KEY = 'jarvis.eventCards';
const CARDS_KEEP = 300;
/** How a real news block starts (the rules every message carries only mention "<jarvis_events>"). */
const OPEN = '<jarvis_events count="';

export const newEvent = (kind: string, o: Partial<JarvisEvent> = {}): JarvisEvent => ({
  kind,
  taskId: '',
  title: '',
  agent: '',
  team: '',
  goal: '',
  body: '',
  key: '',
  risk: '',
  replyChars: 0,
  at: Date.now(),
  ...o,
});

interface InFlight {
  batch: JarvisEvent[];
  at: number;
  messagesBefore: number;
}

/** A batch delivered to a Jarvis chat: the chat shows [label]; the card shows [events]. */
interface Card {
  chatId: string;
  label: string;
  events: JarvisEventView[];
  at: number;
}

export class Events {
  private queues = new Map<string, JarvisEvent[]>();
  /** Why the chat's last turn was stopped by the guard (told once, with the next news). */
  private guardNotes = new Map<string, string>();
  /** A message to a Jarvis chat was just sent: it is not sent another one until it shows as working (or a while passed). */
  private sentAt = new Map<string, number>();
  private busyBefore = new Map<string, boolean>();
  private idleSince = new Map<string, number>();
  private lastNudgeAt = new Map<string, number>();
  private waitSeen = new Map<string, { toolId: string; at: number }>();
  private inFlight = new Map<string, InFlight>();
  private orphanNotice = false;
  private cards: Card[];

  constructor(
    private j: JarvisEngine,
    private store: KeyValueStore,
  ) {
    const raw = store.get<Card[]>(CARDS_KEY);
    this.cards = Array.isArray(raw) ? raw.filter((c) => c && typeof c.chatId === 'string' && typeof c.label === 'string') : [];
  }

  // ------------------------------------------------------------------ queue

  post(owner: string | null, e: JarvisEvent) {
    const key = this.j.managers.ownerOf(owner);
    if (!key) {
      // that Jarvis chat is gone: nobody can take the news (the app's "voice chat" fallback does not exist here)
      this.j.controller.notice(`News of "${e.title || 'a task'}" could not be delivered: its Jarvis chat was deleted.`, 'warning');
      return;
    }
    const q = this.queues.get(key) ?? [];
    // a newer state of the same task replaces the older news of the same kind (no stale duplicates)
    const next = q.filter((x) => !(x.taskId && x.taskId === e.taskId && x.kind === e.kind && x.key === e.key));
    next.push(e);
    this.queues.set(key, next);
    if (e.kind === 'task_done' || e.kind === 'task_failed') this.j.managers.resetNudges(key);
    this.j.changed();
  }

  pending(owner: string): number {
    return this.queues.get(owner)?.length ?? 0;
  }

  drain(owner: string): JarvisEvent[] {
    const q = this.queues.get(owner) ?? [];
    this.queues.delete(owner);
    return q;
  }

  takeGuardNote(owner: string): string | null {
    const n = this.guardNotes.get(owner) ?? null;
    this.guardNotes.delete(owner);
    return n;
  }

  forget(owner: string) {
    this.queues.delete(owner);
    this.inFlight.delete(owner);
    this.guardNotes.delete(owner);
    this.sentAt.delete(owner);
    this.busyBefore.delete(owner);
    this.idleSince.delete(owner);
    this.waitSeen.delete(owner);
    this.lastNudgeAt.delete(owner);
    const before = this.cards.length;
    this.cards = this.cards.filter((c) => c.chatId !== owner);
    if (this.cards.length !== before) this.store.set(CARDS_KEY, this.cards);
  }

  // ------------------------------------------------------------------ the message

  /** The one line the chat shows for the whole batch. */
  label(events: JarvisEvent[]): string {
    const parts = events.map((e) => (e.title.trim() ? `${e.title.slice(0, 30)}: ${kindWord(e.kind)}` : `Mission: ${kindWord(e.kind)}`));
    const head = events.length === 1 ? '⚡ Jarvis · ' : `⚡ Jarvis · ${events.length} updates — `;
    return head + parts.slice(0, 4).join(' · ') + (parts.length > 4 ? ` · +${parts.length - 4} more` : '');
  }

  private toXml(e: JarvisEvent, n: number): string {
    let s = `<event n="${n}" kind="${e.kind}"`;
    if (e.taskId) s += ` task_id="${attr(e.taskId)}"`;
    if (e.title) s += ` task="${attr(e.title)}"`;
    if (e.team) s += ` team="${attr(e.team)}"`;
    if (e.agent) s += ` agent="${attr(e.agent)}"`;
    s += '>\n';
    if (e.goal.trim()) s += `<task_goal>\n${inner(e.goal.slice(0, 600))}\n</task_goal>\n`;
    switch (e.kind) {
      case 'task_done':
        if (!e.body.trim()) s += '<task_reply>(no text reply; use jarvis_task_get)</task_reply>\n';
        // a long reply comes as its end: say so, so it is not taken as the whole report
        else if (e.replyChars > e.body.length) s += `<task_reply cut="only the last ${e.body.length - 1} of ${e.replyChars} characters">\n${inner(e.body)}\n</task_reply>\n`;
        else s += `<task_reply>\n${inner(e.body)}\n</task_reply>\n`;
        break;
      case 'task_failed':
        s += `<error>\n${inner(e.body.trim() || 'unknown error')}\n</error>\n`;
        break;
      case 'task_stalled':
        s += `<error>No visible progress for ${this.j.prefs.get('stallMinutes')} minutes while still running.</error>\n`;
        break;
      case 'task_approval':
        s += `<approval key="${attr(e.key)}" risk="${attr(e.risk)}">\nwants to ${inner(e.body)}\n</approval>\n`;
        break;
      case 'task_question':
        s += `<question>\n${inner(e.body)}\n</question>\n`;
        break;
      case 'nudge':
      case 'autopilot_paused':
        s += `<nudge>\n${inner(e.body)}\n</nudge>\n`;
        break;
    }
    return `${s}</event>\n`;
  }

  private handling(events: JarvisEvent[]): string {
    const kinds = new Set(events.map((e) => e.kind));
    let s = "These are automatic messages from the AntiGem extension about work YOU delegated; they are not the user's words. ";
    s += "Each <event> is separate: read every <task_reply> as that sub-agent's own report.\n";
    s += '- Write the user a short update in this chat (a line per event, plain and concrete).\n';
    if (kinds.has('task_done'))
      s +=
        '- Done: check the result against the task goal and the mission. Do not trust "done" blindly: verify what matters (read the files, run the tests, or send a reviewer team). Good → mark the mission step done (jarvis_mission_update) and delegate the next step. Not good enough → jarvis_task_reply with precise feedback.\n';
    if (events.some((e) => e.kind === 'task_done' && e.replyChars > e.body.length))
      s +=
        '- A <task_reply cut=…> is only the END of a long reply (usually its conclusion), which is often enough. ' +
        'When the missing part matters (you hand the work on to another team, you check its details, or the user asks what it said), first read the whole reply: ' +
        'jarvis_read_chat(id=<task_id>, role="assistant", limit=1, max_chars=30000). Never pass a cut report on as if it were complete.\n';
    if (kinds.has('task_failed') || kinds.has('task_stalled'))
      s += '- Failed / stuck: find out why (jarvis_task_get), then redirect it with jarvis_task_reply, or start a fresh task with a better plan. Ask the user before anything big or risky.\n';
    if (kinds.has('task_approval'))
      s +=
        '- Approval: if it clearly serves the task\'s goal and is not risky, approve it with jarvis_resolve_permission(key, approve=true). Risky or unclear: ask the user in your reply and decide after their answer.\n';
    if (kinds.has('task_question')) s += '- Question: if you or the user already know the answer, give it with jarvis_task_answer; otherwise ask the user, then answer.\n';
    if (kinds.has('nudge'))
      s +=
        '- Nudge: your mission is not done and nothing is running. Continue: delegate the next step, verify, or if everything in done_when is met, call jarvis_mission_update(status="done") and report. If you are blocked, say exactly what you need from the user.\n';
    if (kinds.has('autopilot_paused')) s += '- Autopilot paused itself after several nudges without progress. Tell the user what is blocking and what you need.\n';
    s += '- Start independent tasks in parallel (several jarvis_task_start calls in one turn).\n';
    s +=
      '- Then END YOUR TURN. Never wait for tasks: no sleep / timeout / watch / wait loops, no ScheduleWakeup or Monitor, no repeated jarvis_task_get / jarvis_task_list / jarvis_read_chat to see if they finished. The next news arrives by itself as a message like this one.';
    return s;
  }

  /** The whole message for a batch: label for the chat, structured events, the manager's brief, how to handle it. */
  format(owner: string, events: JarvisEvent[], guardNote: string | null): string {
    let body = `${OPEN}${events.length}" from="AntiGem extension (automatic, not typed by the user)">\n`;
    events.forEach((e, i) => (body += this.toXml(e, i + 1)));
    body += '</jarvis_events>\n\n';
    if (guardNote?.trim()) body += `<app_note>\n${guardNote}\n</app_note>\n\n`;
    body += `${this.j.managers.brief(owner)}\n\n`;
    body += `<how_to_handle>\n${this.handling(events)}\n</how_to_handle>`;
    return labeledBlock(this.label(events), body);
  }

  // ------------------------------------------------------------------ reading it back (the chat's event card)

  static isEventMessage(raw: string): boolean {
    return raw.includes(OPEN);
  }

  /** The events of a message Jarvis' app sent (null when it is not one). */
  static parse(raw: string): JarvisEventView[] | null {
    const start = raw.indexOf(OPEN);
    if (start < 0) return null;
    const endAt = raw.indexOf('</jarvis_events>', start);
    const block = raw.slice(start, endAt > 0 ? endAt : raw.length);
    const out: JarvisEventView[] = [];
    for (const m of block.matchAll(/<event ([^>]*)>([\s\S]*?)<\/event>/g)) {
      const attrs: Record<string, string> = {};
      for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2].replace(/&amp;/g, '&');
      const text = [...m[2].matchAll(/<(task_reply|error|question|approval|nudge)[^>]*>([\s\S]*?)<\/\1>/g)].map((x) => x[2].trim()).join('\n\n');
      out.push({ kind: attrs.kind ?? '', title: attrs.task ?? '', team: attrs.team ?? '', agent: attrs.agent ?? '', taskId: attrs.task_id ?? '', text });
    }
    return out;
  }

  private static toView(e: JarvisEvent): JarvisEventView {
    const text =
      e.kind === 'task_stalled' ? 'No visible progress while still running.' : e.kind === 'task_approval' ? `wants to ${e.body}` : e.kind === 'task_failed' ? e.body.trim() || 'unknown error' : e.body.trim();
    return { kind: e.kind, title: e.title, team: e.team, agent: e.agent, taskId: e.taskId, text };
  }

  private remember(chatId: string, events: JarvisEvent[]) {
    this.cards.push({ chatId, label: this.label(events), events: events.map((e) => Events.toView(e)), at: Date.now() });
    if (this.cards.length > CARDS_KEEP) this.cards = this.cards.slice(-CARDS_KEEP);
    this.store.set(CARDS_KEY, this.cards);
  }

  /**
   * The events of the [nth] message (counted from the newest) with [label] in chat [chatId]: the backends only keep the
   * label of a sent message, so the host remembers each delivered batch.
   */
  cardFor(chatId: string, label: string, nthFromEnd: number): JarvisEventView[] | null {
    let n = 0;
    for (let i = this.cards.length - 1; i >= 0; i--) {
      const c = this.cards[i];
      if (c.chatId !== chatId || c.label !== label) continue;
      if (n === nthFromEnd) return c.events;
      n++;
    }
    return null;
  }

  // ------------------------------------------------------------------ the wait guard

  /**
   * A loop that only waits: `watch …` as a command, or a shell while / until loop with a sleep inside its body
   * (`while …; do …; sleep 5; done`). A Python `while True:` with time.sleep, or a sleep after the loop, is not one.
   */
  static isWaitCommand(cmd: string): boolean {
    if (/((^|[;&|(]\s*)watch\s)|(\b(while|until)\b[^\n]*?;\s*do\b[\s\S]*?\bsleep\s+\d[\s\S]*?\bdone\b)/i.test(cmd)) return true;
    for (const m of cmd.matchAll(/(^|[\s;&|(`])sleep\s+(\d+(?:\.\d+)?)([smhd]?)/gi)) {
      const n = Number(m[2]) || 0;
      const unit = m[3].toLowerCase();
      const secs = unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : unit === 'd' ? n * 86400 : n;
      if (secs >= 10) return true;
    }
    return false;
  }

  /** A tool that only waits (a long sleep, a wait loop, a wake-up timer). */
  static isWaitTool(t: Pick<ToolCall, 'name' | 'command'>): boolean {
    const n = t.name.toLowerCase();
    if (n.includes('schedulewakeup') || n === 'monitor' || n.includes('sleep') || n === 'wait') return true;
    const shell = n === 'bash' || n === 'shell' || n.includes('terminal') || n.includes('command') || n === 'run_command';
    return shell && Events.isWaitCommand(t.command);
  }

  private async guard(owner: string, hasNews: boolean, now: number) {
    const mode = this.j.prefs.get('waitGuard');
    if (mode === 'off') return;
    const tool = this.j.driver.runningTool(owner);
    if (!tool || !Events.isWaitTool(tool)) {
      this.waitSeen.delete(owner);
      return;
    }
    let seen = this.waitSeen.get(owner);
    if (!seen || seen.toolId !== tool.id) {
      seen = { toolId: tool.id, at: now };
      this.waitSeen.set(owner, seen);
    }
    const waited = now - seen.at;
    const what = tool.command.trim().slice(0, 60) || tool.name;
    const note =
      `You were waiting inside your turn (\`${what}\`) for work you delegated. Never do that: delegate, then end your turn. ` +
      'The extension delivers every result to you by itself as a <jarvis_events> message.';
    if (mode === 'remind') {
      this.guardNotes.set(owner, note);
      return;
    }
    if ((hasNews && waited > 3_000) || waited > 12_000) {
      this.j.logLine(`[jarvis] stopping ${owner}: it waits (${what})`);
      this.waitSeen.delete(owner);
      this.guardNotes.set(owner, `The extension stopped your previous turn. ${note}`);
      this.j.log('event', `Stopped a turn that waited (${what})`, owner);
      await this.j.driver.stop(owner).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ the loop: delivery, guard, autopilot

  /** One look at every Jarvis chat (every 1.5 s). */
  async loop() {
    const owners = [...new Set([...this.j.managers.keys(), ...this.queues.keys()])];
    for (const o of owners) {
      try {
        await this.tick(o);
      } catch (e) {
        this.j.logLine(`[jarvis] tick ${o}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async tick(owner: string) {
    const now = Date.now();
    if (!this.j.managers.isManager(owner)) {
      // that Jarvis chat is gone: its news cannot be delivered
      const n = this.drain(owner).length + (this.inFlight.get(owner)?.batch.length ?? 0);
      this.forget(owner);
      if (n && !this.orphanNotice) {
        this.orphanNotice = true;
        this.j.controller.notice(`${n} update${n === 1 ? '' : 's'} could not be delivered: their Jarvis chat was deleted.`, 'warning');
      }
      return;
    }
    const queued = this.queues.get(owner) ?? [];
    const oldest = queued.length ? Math.min(...queued.map((e) => e.at)) : null;
    const active = this.j.tasks.ownedBy(owner).some((t) => this.j.tasks.isActive(t));
    // a Jarvis chat with something going on keeps a live watch (its state, messages and approvals stay current)
    if (queued.length || active || this.inFlight.has(owner)) this.j.driver.watch(owner, 'manager');
    const busy = this.j.driver.isBusy(owner);

    // ---- turn edges
    const was = this.busyBefore.get(owner) ?? false;
    this.busyBefore.set(owner, busy);
    if (busy) {
      this.idleSince.delete(owner);
      if (!was) this.sentAt.delete(owner);
    } else if (was || this.idleSince.get(owner) == null) this.idleSince.set(owner, now);
    // news sent counts as delivered once the chat works on it (or shows a new message); a send that silently did
    // nothing (the agent offline, the chat not loaded) puts it back in the queue
    const f = this.inFlight.get(owner);
    if (f) {
      const grew = f.messagesBefore >= 0 && (this.j.driver.liveMessages(owner)?.length ?? -1) > f.messagesBefore;
      if (busy || grew) this.inFlight.delete(owner);
      else if (now - f.at > 30_000) {
        this.inFlight.delete(owner);
        this.j.logLine(`[jarvis] news to ${owner} was not taken up: queued again`);
        this.queues.set(owner, [...f.batch, ...(this.queues.get(owner) ?? [])]);
        this.sentAt.set(owner, now);
      }
    }
    if (was && !busy) await this.onTurnEnded(owner);

    // ---- the guard: waiting for tasks inside a turn
    if (busy && (queued.length || active)) await this.guard(owner, queued.length > 0, now);
    else this.waitSeen.delete(owner);

    // ---- delivery
    const batchMs = Math.min(30_000, Math.max(0, this.j.prefs.get('eventBatchMs')));
    if (queued.length && oldest != null && now - oldest >= batchMs && !busy && !this.inFlight.has(owner) && now - (this.sentAt.get(owner) ?? 0) > 25_000) {
      const batch = this.drain(owner);
      if (batch.length) {
        this.sentAt.set(owner, now);
        this.j.managers.markSent(owner);
        this.j.driver.watch(owner, 'manager');
        const before = this.j.driver.liveMessages(owner)?.length ?? -1;
        try {
          await this.j.driver.send(owner, this.format(owner, batch, this.takeGuardNote(owner)));
          this.remember(owner, batch);
          this.j.log('event', `${this.label(batch).replace(/^⚡ Jarvis · /, '')}`, owner);
          this.inFlight.set(owner, { batch, at: now, messagesBefore: before });
        } catch (e) {
          this.j.logLine(`[jarvis] send to ${owner} failed: ${e instanceof Error ? e.message : String(e)}`);
          // put it back and try again later
          this.queues.set(owner, [...batch, ...(this.queues.get(owner) ?? [])]);
          this.sentAt.set(owner, now);
        }
        this.j.changed();
      }
    }

    // ---- a Jarvis chat with nothing going on for a while does not need its live watch any more
    const m = this.j.managers.of(owner);
    if (!queued.length && !active && !busy && !m.mission.autopilot && !this.inFlight.has(owner) && now - (this.idleSince.get(owner) ?? now) > 180_000 && this.j.driver.isWatched(owner, 'manager')) {
      this.j.driver.release(owner, 'manager');
    }

    // ---- autopilot
    if (missionActive(m.mission) && m.mission.autopilot && !busy && !(this.queues.get(owner)?.length) && !active && !this.inFlight.has(owner)) {
      const idleFor = now - (this.idleSince.get(owner) ?? now);
      const sinceNudge = now - (this.lastNudgeAt.get(owner) ?? 0);
      const sinceSent = now - (this.sentAt.get(owner) ?? 0);
      if (idleFor > 30_000 && sinceNudge > 60_000 && sinceSent > 25_000) {
        // looked at now: the next look is a minute away, whether it nudges or not
        this.lastNudgeAt.set(owner, now);
        if (await this.waitingForUser(owner)) return;
        const max = Math.min(20, Math.max(1, this.j.prefs.get('autopilotMaxNudges')));
        if (m.mission.nudges >= max) {
          this.j.managers.update(owner, (x) => ({ ...x, mission: { ...x.mission, autopilot: false, nudges: 0 } }));
          this.post(owner, newEvent('autopilot_paused', { body: `Autopilot nudged you ${max} times in a row without any progress, so it paused.` }));
        } else {
          this.j.managers.update(owner, (x) => ({ ...x, mission: { ...x.mission, nudges: x.mission.nudges + 1 } }));
          const left = m.mission.steps
            .filter((s) => s.status !== 'done')
            .map((s) => `${s.n}. ${s.text}`)
            .join('; ')
            .slice(0, 400);
          this.post(
            owner,
            newEvent('nudge', {
              body: `The mission "${m.mission.goal.slice(0, 120)}" is not done and no team is working.${left ? ` Open steps: ${left}` : ''} (nudge ${m.mission.nudges + 1} of ${max})`,
            }),
          );
        }
      }
    }
  }

  /** The chat's last words asked the user something: the answer is theirs to give, the autopilot does not push. */
  private async waitingForUser(owner: string): Promise<boolean> {
    const last = await this.j.driver.lastReply(owner).catch(() => '');
    return last.trimEnd().endsWith('?');
  }

  private async onTurnEnded(owner: string) {
    this.j.managers.setStatus(owner, null);
    setTimeout(() => this.j.managers.clearSteps(owner), 5000);
    // the agent has no jarvis_mcp tools: it answered the marker (the strip offers the setup)
    const reply = await this.j.driver.lastReply(owner).catch(() => '');
    this.j.controller.setToolsMissing(owner, reply.includes(MCP_MISSING));
  }

  dispose() {
    this.queues.clear();
  }
}

function kindWord(kind: string): string {
  switch (kind) {
    case 'task_done':
      return 'done';
    case 'task_failed':
      return 'failed';
    case 'task_stalled':
      return 'stuck';
    case 'task_approval':
      return 'needs approval';
    case 'task_question':
      return 'asks a question';
    case 'nudge':
      return 'keep going';
    case 'autopilot_paused':
      return 'autopilot paused';
    default:
      return kind;
  }
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, "'").replace(/</g, '‹').replace(/>/g, '›').replace(/\n/g, ' ').trim();

/** Text inside a section: its closing tag cannot appear in it. */
const inner = (s: string) => s.replace(/<\/(task_reply|task_goal|error|question|approval|nudge|event|jarvis_events)>/g, '‹/$1›').trim();
