// Jarvis as a manager: work handed over ("build the release and tell me when it's done") runs as a task in its own
// chat (port of the app's JarvisTasks.kt). Each task chat is watched live (driver.ts) so its approvals, questions and
// end are seen while other chats are on screen; changes (finished, failed, stuck) go to controller.onTaskEvent, which
// hands them to the Jarvis chat that owns the task.
import { randomUUID } from 'node:crypto';
import type { AgentKind } from '../../../shared/model';
import { collapseExpansions, hiddenBlock } from '../text';
import type { KeyValueStore } from '../types';
import type { JarvisEngine } from './engine';
import * as JText from './text';
import { isActiveState, needsUserState, type Task, type TaskState } from './types';

const KEY = 'jarvis.tasks';
const KEEP = 30;
/** How much of a finished task's reply goes into its news (its end; the whole reply can be read with jarvis_read_chat). */
export const RESULT_MAX = 3500;
/** A task that never showed as running within this time after a message is taken as finished. */
const START_GRACE_MS = 25_000;
const HOLD = 'task';

export class Tasks {
  private list: Task[] = [];
  private attachedAt = new Map<string, number>();
  private progressSig = new Map<string, string>();
  private releaseTimers = new Map<string, NodeJS.Timeout>();
  private tick = 0;

  constructor(
    private j: JarvisEngine,
    private store: KeyValueStore,
  ) {
    this.load();
  }

  // ------------------------------------------------------------------ lookups

  /** Newest first. */
  all(): Task[] {
    return this.list;
  }

  /** The task with [id], or the one whose id starts with it (models often shorten ids; at least 4 characters). */
  find(id: string | null | undefined, exact = false): Task | undefined {
    const i = (id ?? '').trim();
    if (!i) return undefined;
    return this.list.find((t) => t.id === i) ?? (!exact && i.length >= 4 ? this.list.find((t) => t.id.startsWith(i)) : undefined);
  }

  isTask(id: string | null | undefined): boolean {
    return !!id && this.list.some((t) => t.id === id);
  }

  isActive(t: Task): boolean {
    return isActiveState(t.state);
  }

  active(): Task[] {
    return this.list.filter((t) => isActiveState(t.state));
  }

  anyActive(): boolean {
    return this.list.some((t) => isActiveState(t.state));
  }

  /** The tasks of one Jarvis chat (newest first). */
  ownedBy(owner: string | null): Task[] {
    return this.list.filter((t) => this.j.managers.ownerOf(t.owner) === owner);
  }

  // ------------------------------------------------------------------ starting and steering

  /**
   * Starts [goal] in a new chat of [agent]. [projectPath] null = the active project. [owner] gets the task's news,
   * [brief] goes hidden in front of the goal (how a sub-agent of Jarvis works, the team's role). Returns the task.
   */
  async start(agent: AgentKind, goal: string, title: string | null, modelId: string | null, projectPath: string | null, owner: string, team: string, brief: string | null): Promise<Task> {
    const text = goal.trim();
    if (!text) throw new Error('The task needs a goal.');
    const b = this.j.host.backend(agent);
    if (!b) throw new Error(`${agent} is turned off (Settings → Agents).`);
    const st = b.status();
    if (st.state === 'not_installed' || st.state === 'disabled') throw new Error(`${st.label} is not available: ${st.detail ?? st.state}.`);
    // the task chat gets Jarvis' brief and the user's global context entries allowed for Jarvis
    const hidden = [brief?.trim() ? brief : null, this.j.skill.taskBody()].filter(Boolean).join('\n\n');
    const prompt = (hidden ? hiddenBlock(hidden) : '') + this.j.host.expand(text);
    const id = randomUUID();
    const ws = projectPath ?? this.j.activeProjectPath();
    this.j.driver.remember(id, agent);
    this.j.driver.watch(id, HOLD, agent);
    this.attachedAt.set(id, Date.now());
    try {
      await b.send({ conversationId: id, isNew: true, text: prompt, attachments: [], modelId: modelId || null, workspaceUri: ws ? (ws.startsWith('file://') ? ws : `file://${ws}`) : null });
    } catch (e) {
      this.j.driver.release(id, HOLD);
      throw e;
    }
    const now = Date.now();
    const task: Task = {
      id,
      agent,
      title: title?.trim() ? title.trim().slice(0, 60) : shortTitle(text),
      goal: text.slice(0, 600),
      project: projectPath ?? '',
      state: 'STARTING',
      createdAt: now,
      turnAt: now,
      updatedAt: now,
      progressAt: now,
      seenRunning: false,
      followUps: 0,
      note: 'Started',
      result: '',
      resultChars: 0,
      reported: true,
      adopted: false,
      owner,
      team: team.trim(),
    };
    this.put(task);
    this.j.log('task', `Started "${task.title}" (${agent.toLowerCase()})`, owner, id);
    // the chat's title: the backends name it after the first line; a given title replaces that once it is saved
    if (title?.trim() && agent !== 'AGY') {
      setTimeout(() => void b.conversationAction(id, 'rename', title.trim().slice(0, 60)).catch(() => undefined), 8000);
    }
    return task;
  }

  /** Watches an existing chat the user named (a message is about to be sent to it). Its news goes to [owner]. */
  adopt(id: string, agent: AgentKind, message: string, owner: string) {
    const now = Date.now();
    const existing = this.find(id, true);
    if (existing) {
      this.put({ ...existing, state: 'STARTING', turnAt: now, updatedAt: now, progressAt: now, seenRunning: false, followUps: existing.followUps + 1, note: 'Follow-up sent', reported: true });
      return;
    }
    const conv = this.j.host.conversations().find((c) => c.id === id);
    this.put({
      id,
      agent,
      title: conv?.title && conv.title !== 'New Chat' ? conv.title.slice(0, 60) : shortTitle(message),
      goal: message.trim().slice(0, 600),
      project: conv?.workspaceUri?.replace(/^file:\/\//, '') ?? '',
      state: 'STARTING',
      createdAt: now,
      turnAt: now,
      updatedAt: now,
      progressAt: now,
      seenRunning: false,
      followUps: 0,
      note: 'Message sent',
      result: '',
      resultChars: 0,
      reported: true,
      adopted: true,
      owner,
      team: '',
    });
  }

  /** Sends a follow-up, a correction or a new direction to the task. With [interrupt] a running task is stopped first. */
  async reply(id: string, message: string, interrupt: boolean): Promise<string> {
    const t = this.find(id);
    if (!t) return 'No task with that id. Use jarvis_task_list.';
    const text = message.trim();
    if (!text) return 'The message is empty.';
    if (this.j.driver.isBusy(t.id)) {
      if (!interrupt) return 'The task is still working. Pass interrupt=true to stop it and send this instead, or wait for it to finish.';
      await this.stop(t.id, true);
      for (let w = 0; w < 24 && this.j.driver.isBusy(t.id); w++) await new Promise((r) => setTimeout(r, 500));
    }
    // the user's every-message entries allowed for Jarvis go along with each follow-up
    const outgoing = this.j.skill.taskFollowUp(this.j.host.expand(text));
    this.j.driver.watch(t.id, HOLD, t.agent);
    this.cancelRelease(t.id);
    try {
      await this.j.driver.send(t.id, outgoing);
    } catch (e) {
      return `Could not send: ${e instanceof Error ? e.message : String(e)}`;
    }
    const now = Date.now();
    this.put({ ...t, state: 'STARTING', turnAt: now, updatedAt: now, progressAt: now, seenRunning: false, followUps: t.followUps + 1, note: `Follow-up: ${text.slice(0, 60)}`, result: '', resultChars: 0, reported: true });
    return 'Sent to the task.';
  }

  /** Stops what the task is doing. */
  async stop(id: string, quiet = false): Promise<string> {
    const t = this.find(id);
    if (!t) return 'No task with that id.';
    try {
      await this.j.driver.stop(t.id);
    } catch (e) {
      return `Could not stop: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (!quiet) {
      this.put({ ...t, state: 'STOPPED', updatedAt: Date.now(), note: 'Stopped', reported: true });
      this.releaseSoon(t.id);
    }
    return 'Stopped.';
  }

  /** Forgets the task (the chat itself stays). */
  close(id: string): boolean {
    const t = this.find(id);
    if (!t) return false;
    this.unwatch(t.id);
    this.list = this.list.filter((x) => x.id !== t.id);
    this.save();
    return true;
  }

  /** Removes the finished tasks from the list. */
  clearFinished() {
    for (const t of this.list) if (!isActiveState(t.state)) this.unwatch(t.id);
    this.list = this.list.filter((t) => isActiveState(t.state));
    this.save();
  }

  /** The task's last reply text, whole (its thinking and tool markers out, an error as one closing line). */
  async fullReply(t: Task): Promise<string> {
    const msgs = this.j.driver.liveMessages(t.id)?.length ? this.j.driver.liveMessages(t.id)! : await this.j.driver.readChat(t.id);
    const last = [...msgs].reverse().find((m) => m.role === 'ASSISTANT' && m.content.trim());
    return JText.report(last?.content ?? '');
  }

  // ------------------------------------------------------------------ watching

  private unwatch(id: string) {
    this.cancelRelease(id);
    this.j.driver.release(id, HOLD);
    this.attachedAt.delete(id);
    this.progressSig.delete(id);
  }

  private cancelRelease(id: string) {
    const r = this.releaseTimers.get(id);
    if (r) clearTimeout(r);
    this.releaseTimers.delete(id);
  }

  /** Keep the chat readable, but stop listening to it a while after it ended. */
  private releaseSoon(id: string) {
    this.cancelRelease(id);
    this.releaseTimers.set(
      id,
      setTimeout(() => {
        this.releaseTimers.delete(id);
        const t = this.find(id, true);
        if (!t || !isActiveState(t.state)) {
          this.j.driver.release(id, HOLD);
          this.attachedAt.delete(id);
        }
      }, 90_000),
    );
  }

  /** One look at every active task (every 1.5 s). */
  async loop() {
    this.tick++;
    for (const t of this.list.filter((x) => isActiveState(x.state))) {
      try {
        await this.check(t);
      } catch (e) {
        this.j.logLine(`[jarvis] check ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async check(t0: Task) {
    let t = t0;
    const now = Date.now();
    if (!this.j.driver.isWatched(t.id, HOLD)) {
      if (!this.j.driver.watch(t.id, HOLD, t.agent)) return; // its agent is off: nothing to look at
      this.attachedAt.set(t.id, now);
    }
    const st = this.j.driver.state(t.id);
    const running = this.j.driver.isBusy(t.id);
    const needsApproval = (st?.approvals.length ?? 0) > 0;
    const asking = st?.question != null;
    const msgs = st?.messages ?? [];
    const last = msgs[msgs.length - 1];
    // a failed turn shows as an error card in the reply (usage limit, provider error, no answer)
    const card = !running && last?.role === 'ASSISTANT' ? JText.errorCardMessage(last.content) : null;
    const error: string | null = st?.error ?? (card != null ? card || 'the agent failed' : null);
    const sig = `${msgs.length}:${last?.content.length}:${last?.toolCalls.length}:${last?.toolCalls[last.toolCalls.length - 1]?.status}`;
    if (this.progressSig.get(t.id) !== sig) {
      this.progressSig.set(t.id, sig);
      t = { ...t, progressAt: now };
    }
    if (running && !t.seenRunning) t = { ...t, seenRunning: true };
    const graceFrom = Math.max(t.turnAt, this.attachedAt.get(t.id) ?? 0);
    const stallMs = this.j.prefs.get('stallMinutes') * 60_000;
    let next: TaskState;
    if (needsApproval) next = 'NEEDS_APPROVAL';
    else if (asking) next = 'NEEDS_ANSWER';
    else if (running && stallMs > 0 && now - t.progressAt > stallMs) next = 'STALLED';
    else if (running) next = 'RUNNING';
    else if (t.seenRunning || now - graceFrom > START_GRACE_MS) next = error != null ? 'FAILED' : 'DONE';
    else next = 'STARTING';
    if (next !== t.state) {
      const note =
        next === 'NEEDS_APPROVAL'
          ? 'Waiting for an approval'
          : next === 'NEEDS_ANSWER'
            ? 'Asking a question'
            : next === 'STALLED'
              ? `No progress for ${Math.floor((now - t.progressAt) / 60_000)} min`
              : next === 'RUNNING'
                ? 'Working'
                : next === 'DONE'
                  ? 'Finished'
                  : next === 'FAILED'
                    ? `Failed: ${(error ?? '').slice(0, 80)}`
                    : t.note;
      t = { ...t, state: next, updatedAt: now, reported: false, note };
      // the manager gets the sub-agent's whole report (cut only when very long)
      if (next === 'DONE' || next === 'FAILED') {
        const full = await this.fullReply(t);
        t = { ...t, result: cutEnd(full, RESULT_MAX), resultChars: full.length };
      }
    }
    this.put(t);
    if (!t.reported) {
      // approvals and questions are reported by the controller's own loop (they can be answered there)
      const kind = t.state === 'DONE' ? 'done' : t.state === 'FAILED' ? 'failed' : t.state === 'STALLED' ? 'stalled' : null;
      t = { ...t, reported: true };
      this.put(t);
      if (kind) this.j.controller.onTaskEvent(t, kind, kind === 'failed' ? (error ?? '') : t.result);
      if (!isActiveState(t.state)) this.releaseSoon(t.id);
    }
  }

  // ------------------------------------------------------------------ list and storage

  private put(task: Task) {
    const prev = this.list.find((x) => x.id === task.id);
    const changed = !prev || JSON.stringify(prev) !== JSON.stringify(task);
    this.list = [task, ...this.list.filter((x) => x.id !== task.id)].sort((a, b) => b.createdAt - a.createdAt).slice(0, KEEP);
    if (changed) this.save();
  }

  private save() {
    this.store.set(
      KEY,
      this.list.map((t) => ({
        id: t.id,
        agent: t.agent,
        title: t.title,
        goal: t.goal,
        project: t.project,
        state: t.state,
        created: t.createdAt,
        turn: t.turnAt,
        updated: t.updatedAt,
        seen: t.seenRunning,
        follow: t.followUps,
        note: t.note,
        result: t.result.slice(0, RESULT_MAX + 1),
        chars: t.resultChars,
        adopted: t.adopted,
        owner: t.owner,
        team: t.team,
      })),
    );
    this.j.changed();
  }

  private load() {
    const raw = this.store.get<Record<string, unknown>[]>(KEY);
    if (!Array.isArray(raw)) return;
    const now = Date.now();
    const states: TaskState[] = ['STARTING', 'RUNNING', 'NEEDS_APPROVAL', 'NEEDS_ANSWER', 'STALLED', 'DONE', 'FAILED', 'STOPPED'];
    this.list = raw
      .map((o): Task | null => {
        const agent = o.agent;
        if (agent !== 'AGY' && agent !== 'CLAUDE' && agent !== 'CODEX' && agent !== 'OPENCODE') return null;
        const state = states.includes(o.state as TaskState) ? (o.state as TaskState) : 'DONE';
        const active = isActiveState(state);
        return {
          id: String(o.id),
          agent,
          title: String(o.title ?? ''),
          goal: String(o.goal ?? ''),
          project: String(o.project ?? ''),
          // a task that was working when the host closed is checked again (the chat may still be running)
          state: active ? 'STARTING' : state,
          createdAt: Number(o.created ?? now),
          turnAt: active ? now : Number(o.turn ?? now),
          updatedAt: Number(o.updated ?? now),
          progressAt: now,
          seenRunning: false,
          followUps: Number(o.follow ?? 0),
          note: String(o.note ?? ''),
          result: String(o.result ?? ''),
          resultChars: Number(o.chars ?? 0),
          reported: true,
          adopted: o.adopted === true,
          owner: String(o.owner ?? ''),
          team: String(o.team ?? ''),
        };
      })
      .filter((t): t is Task => !!t)
      .slice(0, KEEP);
  }

  dispose() {
    for (const r of this.releaseTimers.values()) clearTimeout(r);
    this.releaseTimers.clear();
  }

  static needsUser(t: Task) {
    return needsUserState(t.state);
  }
}

/** [text] cut to its last [max] characters: the end of a reply holds the agent's conclusion. */
export function cutEnd(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max).trimStart()}` : text;
}

function shortTitle(text: string): string {
  const first =
    collapseExpansions(text)
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  return first.length > 48 ? `${first.slice(0, 48).trimEnd()}…` : first || 'Task';
}
