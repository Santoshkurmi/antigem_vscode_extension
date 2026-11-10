// Jarvis as a lead agent ("command center"): port of the app's JarvisManagers.kt. Every Jarvis chat is a manager
// (key = that chat's id). A manager owns the tasks it starts (their news goes back to it, see events.ts), keeps a
// mission (goal, done-when, steps, autopilot) and teams (named roles: agent, model, project, instructions). The
// mission and teams live here, in the host, and are repeated to the model in every message (brief()), so a manager
// that works for hours never forgets what it is doing, even after its own context was compacted.
import type { AgentKind } from '../../../shared/model';
import type { KeyValueStore } from '../types';
import type { JarvisEngine } from './engine';
import { TASK_LABEL, type Manager, type Mission, type Step, type StepStatus, type Team } from './types';

const KEY = 'jarvis.managers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

export const emptyMission = (): Mission => ({ goal: '', doneWhen: '', steps: [], status: 'active', autopilot: false, notes: '', updatedAt: Date.now(), nudges: 0 });
export const missionIsEmpty = (m: Mission) => !m.goal.trim() && m.steps.length === 0;
export const missionDone = (m: Mission) => m.steps.filter((s) => s.status === 'done').length;
export const missionActive = (m: Mission) => !missionIsEmpty(m) && m.status === 'active';

/** Who is calling a tool, and whether that is certain (not a guess between several Jarvis chats at work). */
export interface Caller {
  key: string | null;
  sure: boolean;
}

export class Managers {
  private map = new Map<string, Manager>();
  /** What each manager says it is doing right now (jarvis_status, a tool), shown on its command strip. */
  private statusMap = new Map<string, string>();
  /** The last few status lines of each manager (the activity card). */
  private stepsMap = new Map<string, { text: string; at: number; done: boolean }[]>();
  /** MCP connection (session id) → the manager it belongs to, learned from calls that named their manager_id. */
  private sessionOwner = new Map<string, string>();
  /** Connections shared by several managers (an agent that uses one connection for all its chats). */
  private sharedSessions = new Set<string>();

  constructor(
    private j: JarvisEngine,
    private store: KeyValueStore,
  ) {
    this.map = Managers.parse(store.get<unknown[]>(KEY));
  }

  // ------------------------------------------------------------------ lookups

  get(key: string | null | undefined): Manager | undefined {
    return key ? this.map.get(key) : undefined;
  }

  /** The manager (an empty one when unknown). */
  of(key: string): Manager {
    return this.map.get(key) ?? Managers.blank(key, this.j.driver.agentOf(key) ?? 'CLAUDE');
  }

  isManager(id: string | null | undefined): boolean {
    return !!id && this.map.has(id);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  all(): Manager[] {
    return [...this.map.values()];
  }

  /** A valid owner: a Jarvis chat that still exists as a manager, otherwise null (an orphan task). */
  ownerOf(key: string | null | undefined): string | null {
    return this.isManager(key) ? key! : null;
  }

  status(key: string): string | null {
    return this.statusMap.get(key) ?? null;
  }

  steps(key: string) {
    return this.stepsMap.get(key) ?? [];
  }

  private learnSession(session: string | null, key: string) {
    if (!session || this.sharedSessions.has(session)) return;
    // only Claude Code connects once per chat (one process each); the others share one connection between all
    // their chats, so their connection says nothing about who is calling
    if (this.of(key).agent !== 'CLAUDE') return;
    const prev = this.sessionOwner.get(session);
    if (prev == null) this.sessionOwner.set(session, key);
    else if (prev !== key) {
      this.sessionOwner.delete(session);
      this.sharedSessions.add(session);
    }
  }

  /**
   * Which Jarvis chat is calling a tool: the manager_id it passed (every message tells it its id), else the one its
   * MCP connection belongs to, else, when exactly one Jarvis chat exists, that one. Anything else is a guess
   * (sure = false): tools that act for a manager then ask for the manager_id instead of guessing.
   */
  resolveCaller(arg: string | null | undefined, session: string | null | undefined): Caller {
    const a = (arg ?? '').trim();
    if (a) {
      const key = this.map.has(a) ? a : a.length >= 6 ? (this.keys().find((k) => k.startsWith(a)) ?? null) : null;
      if (key) {
        this.learnSession(session ?? null, key);
        return { key, sure: true };
      }
    }
    if (session && !this.sharedSessions.has(session)) {
      const k = this.sessionOwner.get(session);
      if (k && this.map.has(k)) return { key: k, sure: true };
    }
    const all = this.keys();
    if (all.length === 0) return { key: null, sure: false };
    if (all.length === 1) return { key: all[0], sure: true };
    // several: a guess only (busy states can lag behind), never certain
    const busy = all.filter((k) => this.j.driver.isBusy(k));
    if (busy.length === 1) return { key: busy[0], sure: false };
    const pool = busy.length ? busy : all;
    const recent = pool.reduce((best, k) => (this.of(k).lastSentAt > this.of(best).lastSentAt ? k : best), pool[0]);
    return { key: recent, sure: false };
  }

  /** A Jarvis chat's name for messages ("the Jarvis chat \"Release\""). */
  nameOf(key: string | null): string {
    if (!key) return 'a Jarvis chat that was deleted';
    const t = this.j.host.conversations().find((c) => c.id === key)?.title?.trim();
    return t ? `the Jarvis chat "${t.slice(0, 40)}"` : 'another Jarvis chat';
  }

  // ------------------------------------------------------------------ changes

  update(key: string, change: (m: Manager) => Manager) {
    const cur = this.map.get(key) ?? Managers.blank(key, this.j.driver.agentOf(key) ?? 'CLAUDE');
    const next = change(cur);
    if (next === cur && this.map.has(key)) return;
    this.map.set(key, next);
    this.save();
  }

  /** Makes [chatId] a Jarvis chat (it is listed under Jarvis and gets the command-center guide). */
  register(chatId: string, agent: AgentKind) {
    if (!chatId) return;
    this.j.prefs.addChatId(chatId);
    if (this.map.has(chatId)) return;
    this.map.set(chatId, Managers.blank(chatId, agent));
    this.save();
  }

  remove(key: string) {
    if (!this.map.delete(key)) return;
    this.statusMap.delete(key);
    this.stepsMap.delete(key);
    this.save();
  }

  markSent(key: string) {
    this.update(key, (m) => ({ ...m, lastSentAt: Date.now() }));
  }

  setStatus(key: string, text: string | null) {
    const t = text?.trim().replace(/\s+/g, ' ').slice(0, 70) ?? '';
    if (!t) {
      if (this.statusMap.delete(key)) this.j.changed();
      return;
    }
    if (this.statusMap.get(key) === t) return;
    this.statusMap.set(key, t);
    const cur = this.stepsMap.get(key) ?? [];
    if (cur[cur.length - 1]?.text !== t) this.stepsMap.set(key, [...cur.map((s) => ({ ...s, done: true })), { text: t, at: Date.now(), done: false }].slice(-4));
    this.j.changed();
  }

  /** The activity card is cleared a few seconds after the work ended. */
  clearSteps(key: string) {
    if (this.stepsMap.delete(key)) this.j.changed();
  }

  // ---- mission

  setMission(key: string, goal: string, doneWhen: string, steps: string[], autopilot: boolean | null) {
    this.update(key, (m) => ({
      ...m,
      mission: {
        ...emptyMission(),
        goal: goal.trim().slice(0, 600),
        doneWhen: doneWhen.trim().slice(0, 400),
        steps: steps
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 40)
          .map((s, i): Step => ({ n: i + 1, text: s.slice(0, 200), status: 'todo', note: '' })),
        autopilot: autopilot ?? m.mission.autopilot,
      },
    }));
  }

  /** Changes one step, adds steps, sets the mission's status, autopilot or notes. Returns what changed, for the reply. */
  updateMission(
    key: string,
    step: number | null,
    stepStatus: StepStatus | null,
    note: string | null,
    addSteps: string[],
    status: string | null,
    autopilot: boolean | null,
    notes: string | null,
  ): string {
    const changes: string[] = [];
    this.update(key, (m) => {
      let mi = m.mission;
      // real progress (a step started or done, the mission finished) gives the autopilot its patience back
      let progress = false;
      if (step != null) {
        const s = mi.steps.find((x) => x.n === step);
        if (s) {
          if ((stepStatus === 'done' && s.status !== 'done') || (stepStatus === 'doing' && s.status === 'todo')) progress = true;
          mi = { ...mi, steps: mi.steps.map((x) => (x.n === step ? { ...x, status: stepStatus ?? x.status, note: note != null ? note.trim().slice(0, 200) : x.note } : x)) };
          changes.push(`step ${step}${stepStatus ? ` → ${stepStatus}` : ''}`);
        } else changes.push(`no step ${step}`);
      }
      const added = addSteps.map((s) => s.trim()).filter(Boolean);
      if (added.length) {
        let n = mi.steps.reduce((a, s) => Math.max(a, s.n), 0);
        mi = { ...mi, steps: [...mi.steps, ...added.map((t): Step => ({ n: ++n, text: t.slice(0, 200), status: 'todo', note: '' }))] };
        changes.push(`${addSteps.length} step(s) added`);
      }
      if (status === 'active' || status === 'done' || status === 'paused') {
        if (status !== mi.status) progress = true;
        mi = { ...mi, status, autopilot: status !== 'active' ? false : mi.autopilot };
        changes.push(`mission ${status}`);
      }
      if (autopilot != null) {
        if (autopilot !== mi.autopilot) progress = true;
        mi = { ...mi, autopilot };
        changes.push(`autopilot ${autopilot ? 'on' : 'off'}`);
      }
      if (notes != null) {
        mi = { ...mi, notes: notes.trim().slice(0, 1500) };
        changes.push('notes saved');
      }
      return { ...m, mission: { ...mi, updatedAt: Date.now(), nudges: progress ? 0 : mi.nudges } };
    });
    return changes.join(', ') || 'nothing changed';
  }

  clearMission(key: string) {
    this.update(key, (m) => ({ ...m, mission: emptyMission() }));
  }

  setAutopilot(key: string, on: boolean) {
    this.update(key, (m) => ({ ...m, mission: { ...m.mission, autopilot: on, nudges: 0, status: on && m.mission.status !== 'active' ? 'active' : m.mission.status } }));
  }

  /** Something moved (a task finished, the user wrote): the autopilot's patience starts over. */
  resetNudges(key: string) {
    if ((this.map.get(key)?.mission.nudges ?? 0) === 0) return;
    this.update(key, (m) => ({ ...m, mission: { ...m.mission, nudges: 0 } }));
  }

  // ---- teams

  upsertTeam(key: string, team: Team) {
    this.update(key, (m) => ({ ...m, teams: [...m.teams.filter((t) => t.name.toLowerCase() !== team.name.toLowerCase()), team].slice(0, 12) }));
  }

  removeTeam(key: string, name: string): boolean {
    const had = this.of(key).teams.some((t) => t.name.toLowerCase() === name.toLowerCase());
    if (had) this.update(key, (m) => ({ ...m, teams: m.teams.filter((t) => t.name.toLowerCase() !== name.toLowerCase()) }));
    return had;
  }

  team(key: string, name: string | null | undefined): Team | undefined {
    const n = name?.trim();
    if (!n) return undefined;
    return this.of(key).teams.find((t) => t.name.toLowerCase() === n.toLowerCase());
  }

  // ------------------------------------------------------------------ what the model is told every time

  /**
   * The manager's memory, repeated in every message it gets: mission with its steps, teams and its own tasks. Short
   * enough to send each time; the host keeps it, so it survives compaction.
   */
  brief(key: string): string {
    const m = this.of(key);
    const now = Date.now();
    const mine = this.j.tasks.ownedBy(key).filter((t) => this.j.tasks.isActive(t) || now - t.updatedAt < 30 * 60_000);
    let s = `<mission_brief manager_id="${key}">\n`;
    const mi = m.mission;
    if (missionIsEmpty(mi)) {
      s += 'mission: none yet. For any job with more than one step call jarvis_mission_set first (goal, done_when, steps).\n';
    } else {
      s += `mission: ${mi.goal}\n`;
      s += `status: ${mi.status}`;
      if (mi.steps.length) s += ` · ${missionDone(mi)}/${mi.steps.length} steps done`;
      s += ` · autopilot ${mi.autopilot ? 'ON (keep going until done_when is met)' : 'off'}\n`;
      if (mi.doneWhen.trim()) s += `done when: ${mi.doneWhen}\n`;
      if (mi.steps.length) {
        s += 'steps:\n';
        for (const st of mi.steps) s += `  ${mark(st.status)} ${st.n}. ${st.text}${st.note.trim() ? ` — ${st.note}` : ''}\n`;
      }
      if (mi.notes.trim()) s += `notes: ${mi.notes.slice(0, 600)}\n`;
    }
    if (m.teams.length) {
      s += `teams: ${m.teams.map((t) => `${t.name} (${t.agent.toLowerCase()}${t.model ? `, ${t.model}` : ''})${t.role ? `: ${t.role.slice(0, 80)}` : ''}`).join(' · ')}\n`;
    }
    if (!mine.length) s += 'your tasks: none running\n';
    else {
      s += 'your tasks:\n';
      for (const t of mine.slice(0, 10)) {
        s += `  - "${t.title.slice(0, 40)}" id ${t.id.slice(0, 8)}`;
        if (t.team) s += ` · team ${t.team}`;
        s += ` · ${t.agent.toLowerCase()} · ${TASK_LABEL[t.state]} · started ${ago(t.createdAt)} ago`;
        if (t.note && t.note !== 'Working') s += ` · ${t.note.slice(0, 60)}`;
        s += '\n';
      }
    }
    return `${s}</mission_brief>`;
  }

  // ------------------------------------------------------------------ storage

  private save() {
    this.store.set(
      KEY,
      [...this.map.values()].map((m) => ({
        key: m.key,
        agent: m.agent,
        boot: m.bootFor,
        created: m.createdAt,
        sent: m.lastSentAt,
        mission: {
          goal: m.mission.goal,
          done_when: m.mission.doneWhen,
          status: m.mission.status,
          autopilot: m.mission.autopilot,
          notes: m.mission.notes,
          updated: m.mission.updatedAt,
          nudges: m.mission.nudges,
          steps: m.mission.steps.map((s) => ({ n: s.n, text: s.text, status: s.status, note: s.note })),
        },
        teams: m.teams.map((t) => ({ name: t.name, agent: t.agent, model: t.model, role: t.role, project: t.project })),
      })),
    );
    this.j.changed();
  }

  static blank(key: string, agent: AgentKind): Manager {
    return { key, agent, mission: emptyMission(), teams: [], bootFor: '', createdAt: Date.now(), lastSentAt: 0 };
  }

  private static parse(raw: unknown): Map<string, Manager> {
    const out = new Map<string, Manager>();
    if (!Array.isArray(raw)) return out;
    const agentOf = (v: unknown): AgentKind | null => (v === 'AGY' || v === 'CLAUDE' || v === 'CODEX' || v === 'OPENCODE' ? v : null);
    for (const o of raw as J[]) {
      const key = String(o?.key ?? '');
      if (!key) continue;
      const mo = (o.mission ?? {}) as J;
      const steps: Step[] = (Array.isArray(mo.steps) ? mo.steps : []).map((s: J, j: number) => ({
        n: Number(s?.n ?? j + 1),
        text: String(s?.text ?? ''),
        status: (['todo', 'doing', 'done', 'blocked'].includes(s?.status) ? s.status : 'todo') as StepStatus,
        note: String(s?.note ?? ''),
      }));
      const teams: Team[] = (Array.isArray(o.teams) ? o.teams : [])
        .map((t: J) => {
          const agent = agentOf(t?.agent);
          return agent ? { name: String(t.name ?? ''), agent, model: String(t.model ?? ''), role: String(t.role ?? ''), project: String(t.project ?? '') } : null;
        })
        .filter((t: Team | null): t is Team => !!t);
      out.set(key, {
        key,
        agent: agentOf(o.agent) ?? 'CLAUDE',
        mission: {
          goal: String(mo.goal ?? ''),
          doneWhen: String(mo.done_when ?? ''),
          steps,
          status: mo.status === 'done' || mo.status === 'paused' ? mo.status : 'active',
          autopilot: mo.autopilot === true,
          notes: String(mo.notes ?? ''),
          updatedAt: Number(mo.updated ?? Date.now()),
          nudges: Number(mo.nudges ?? 0),
        },
        teams,
        bootFor: String(o.boot ?? ''),
        createdAt: Number(o.created ?? Date.now()),
        lastSentAt: Number(o.sent ?? 0),
      });
    }
    return out;
  }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function mark(status: string): string {
  return status === 'done' ? '[x]' : status === 'doing' ? '[>]' : status === 'blocked' ? '[!]' : '[ ]';
}
