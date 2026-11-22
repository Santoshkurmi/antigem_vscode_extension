// Rooms on the crew's files: the room engine works on an in-memory room (`Group`) and this store keeps it in
// room.json + transcript.ndjson + summary.md; its members are crew bots (shared by every room they sit in: one
// profile, one SOUL.md), and each member's hidden chat in a room is a room thread in threads.json (the router's: a
// router thread). Changes are saved 300 ms after the engine's last put.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '../../../../shared/model';
import type { Bot, Group, GroupStoreLike, Msg } from './types';
import { clamp } from '../store/legacyGroups';
import { newId, normalizeRoom, type CrewStore } from '../store/store';
import type { CrewAccess, RoomLine, RoomRecord, ThreadRecord } from '../types';

const MAX_MESSAGES = 3000;

const TO_GROUP_ACCESS = (a: CrewAccess): Bot['access'] => (a === 'talk' ? 'chat' : a === 'read' ? 'read' : 'edit');

export class CrewRoomStore implements GroupStoreLike {
  private groups = new Map<string, Group>();
  /** What this window last read / wrote of each room (file stamps), to see another window's changes. */
  private stamps = new Map<string, string>();
  /** Message ids of the room's transcript as on disk (new ones are appended). */
  private written = new Map<string, string[]>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(readonly crew: CrewStore) {
    this.scan();
  }

  get dir(): string {
    return path.join(this.crew.root, 'rooms');
  }

  /** The room's private folder (talk-only bots run there). */
  roomDir(id: string): string {
    return this.crew.roomFolder(id);
  }

  private stamp(room: RoomRecord): string {
    const f = (p: string) => {
      try {
        const st = fs.statSync(p);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '-';
      }
    };
    const r = path.join(this.crew.root, 'rooms', room.id);
    const bots = room.members.map((b) => `${f(path.join(this.crew.root, 'bots', b, 'bot.json'))}/${f(path.join(this.crew.root, 'bots', b, 'SOUL.md'))}`);
    return [f(path.join(r, 'room.json')), f(path.join(r, 'transcript.ndjson')), ...bots].join('|');
  }

  /** Reads rooms added or changed on disk (another window, the Crew screen) unless [busy] says one is in use here. */
  scan(busy: (id: string) => boolean = () => false) {
    const seen = new Set<string>();
    const threads = this.crew.threads();
    for (const room of this.crew.rooms()) {
      seen.add(room.id);
      if (this.timers.has(room.id) || busy(room.id)) continue;
      const st = this.stamp(room);
      if (this.groups.has(room.id) && this.stamps.get(room.id) === st) continue;
      const lines = this.crew.transcript(room.id);
      const g = this.toGroup(room, lines, threads);
      this.groups.set(room.id, g);
      this.written.set(room.id, lines.map((l) => l.id));
      this.stamps.set(room.id, st);
    }
    for (const id of [...this.groups.keys()]) if (!seen.has(id) && !this.timers.has(id) && !busy(id)) this.groups.delete(id);
  }

  all(): Group[] {
    return [...this.groups.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Group | undefined {
    return this.groups.get(id);
  }

  put(g: Group) {
    if (g.messages.length > MAX_MESSAGES) {
      const drop = g.messages.length - MAX_MESSAGES;
      g.messages = g.messages.slice(drop);
      for (const b of g.bots) b.seen = Math.max(0, b.seen - drop);
      g.moderatorSeen = Math.max(0, g.moderatorSeen - drop);
      g.summaryUpTo = Math.max(0, g.summaryUpTo - drop);
    }
    this.groups.set(g.id, g);
    const old = this.timers.get(g.id);
    if (old) clearTimeout(old);
    this.timers.set(
      g.id,
      setTimeout(() => {
        this.timers.delete(g.id);
        this.write(g.id);
      }, 300),
    );
  }

  delete(id: string) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.groups.delete(id);
    this.stamps.delete(id);
    this.written.delete(id);
    for (const th of this.crew.threads()) if (th.roomId === id) this.crew.deleteThread(th.id);
    this.crew.deleteRoom(id);
  }

  flush() {
    for (const [id, t] of this.timers) {
      clearTimeout(t);
      this.write(id);
    }
    this.timers.clear();
  }

  // ------------------------------------------------------------------ crew → group

  private toGroup(room: RoomRecord, lines: RoomLine[], threads: ThreadRecord[]): Group {
    const mine = threads.filter((t) => t.roomId === room.id);
    const bots: Bot[] = [];
    for (const id of room.members) {
      const b = this.crew.bot(id);
      if (!b) continue;
      const th = mine.find((t) => t.kind === 'room' && t.botId === id);
      bots.push({
        id,
        name: b.name,
        agent: b.engine,
        modelId: b.model,
        persona: this.crew.soul(id),
        emoji: b.emoji,
        color: b.color,
        chattiness: b.chattiness,
        access: TO_GROUP_ACCESS(b.access),
        effort: b.effort,
        muted: room.holds[id] === true,
        chatId: th?.chatId ?? null,
        seen: th?.seen ?? lines.length,
        title: b.title,
        description: b.description,
        aliases: b.aliases,
        voice: b.voice,
      });
    }
    const router = mine.find((t) => t.kind === 'router');
    return {
      id: room.id,
      title: room.name,
      topic: room.bulletin,
      userName: room.userName,
      bots,
      mode: room.mode,
      lead: room.lead,
      drafting: room.drafting,
      turnsPerMember: room.turnsPerMember,
      moderatorAgent: room.router.engine,
      moderatorModelId: room.router.model,
      moderatorChatId: router?.chatId ?? null,
      moderatorSeen: router?.seen ?? lines.length,
      maxBotTurns: room.maxBotTurns,
      autoTalk: room.autoTalk.on,
      idleSeconds: room.autoTalk.idleSeconds,
      project: room.folder,
      paused: room.paused,
      botTurns: room.talk.botTurns,
      waiting: room.talk.waiting,
      heldMessages: room.heldMessages,
      goal: room.goal,
      summaryUpTo: Math.min(room.summary.upTo, lines.length),
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      messages: lines.map(
        (l): Msg => ({
          id: l.id,
          from: l.from,
          name: l.name,
          text: l.text,
          at: l.at,
          attachments: (l.attachments ?? []) as Msg['attachments'],
          ...(l.replyTo ? { replyTo: l.replyTo } : {}),
          ...(l.picked ? { picked: l.picked } : {}),
          ...(l.digest ? { digest: l.digest } : {}),
          ...(l.evidence ? { evidence: l.evidence } : {}),
          ...(l.usage ? { usage: l.usage } : {}),
        }),
      ),
    };
  }

  // ------------------------------------------------------------------ group → crew

  private write(id: string) {
    const g = this.groups.get(id);
    if (!g) return;
    try {
      const old = this.crew.room(id);
      const room = normalizeRoom(
        {
          ...(old ?? {}),
          name: g.title,
          members: g.bots.map((b) => b.id),
          lead: g.lead && g.bots.some((b) => b.id === g.lead) ? g.lead : (g.bots[0]?.id ?? null),
          bulletin: g.topic,
          mode: g.mode,
          drafting: g.drafting,
          turnsPerMember: g.turnsPerMember,
          heldMessages: g.heldMessages,
          goal: g.goal,
          summary: { upTo: g.summaryUpTo, at: old?.summary.at ?? 0 },
          maxBotTurns: g.maxBotTurns,
          autoTalk: { on: g.autoTalk, idleSeconds: g.idleSeconds },
          folder: g.project,
          holds: Object.fromEntries(g.bots.filter((b) => b.muted).map((b) => [b.id, true])),
          router: { engine: g.moderatorAgent, model: g.moderatorModelId },
          userName: g.userName,
          paused: g.paused,
          talk: { botTurns: g.botTurns, waiting: g.waiting },
          createdAt: g.createdAt,
        },
        id,
      );
      this.crew.putRoom({ ...room, updatedAt: g.updatedAt });
      this.writeTranscript(g);
      this.writeThreads(g);
      const fresh = this.crew.room(id);
      if (fresh) this.stamps.set(id, this.stamp(fresh));
    } catch {
      /* the next change saves again */
    }
  }

  private writeTranscript(g: Group) {
    const onDisk = this.written.get(g.id) ?? [];
    const ids = g.messages.map((m) => m.id);
    const line = (m: Msg): RoomLine => ({
      id: m.id,
      from: m.from,
      name: m.name,
      text: m.text,
      at: m.at,
      ...(m.attachments.length ? { attachments: m.attachments } : {}),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      ...(m.picked ? { picked: m.picked } : {}),
      ...(m.digest ? { digest: m.digest } : {}),
      ...(m.evidence ? { evidence: m.evidence } : {}),
      ...(m.usage ? { usage: m.usage } : {}),
    });
    const prefix = onDisk.length <= ids.length && onDisk.every((x, i) => ids[i] === x);
    if (prefix) for (const m of g.messages.slice(onDisk.length)) this.crew.appendLine(g.id, line(m));
    // cleared, trimmed or edited: written again as a whole
    else this.crew.writeTranscript(g.id, g.messages.map(line));
    this.written.set(g.id, ids);
  }

  /** Each bot's hidden chat here = a room thread; the moderator's = the router thread. */
  private writeThreads(g: Group) {
    const all = this.crew.threads().filter((t) => t.roomId === g.id);
    const now = Date.now();
    const keep: ThreadRecord[] = [];
    const drop: string[] = [];
    const upsert = (kind: 'room' | 'router', botId: string | null, engine: AgentKind, chatId: string | null, seen: number) => {
      const have = all.find((t) => t.kind === kind && t.botId === botId);
      if (!chatId) {
        if (have) drop.push(have.id);
        return;
      }
      if (have && have.chatId === chatId && have.seen === seen && have.engine === engine) return;
      keep.push({ ...(have ?? { id: newId('t'), kind, botId, roomId: g.id, jobId: null, setupKey: null, createdAt: now, updatedAt: now }), engine, chatId, seen: clamp(seen, 0, Number.MAX_SAFE_INTEGER) });
    };
    for (const b of g.bots) upsert('room', b.id, b.agent, b.chatId, b.seen);
    upsert('router', null, g.moderatorAgent ?? g.bots[0]?.agent ?? 'CLAUDE', g.moderatorChatId, g.moderatorSeen);
    // threads of bots that left
    for (const t of all) if (t.kind === 'room' && t.botId && !g.bots.some((b) => b.id === t.botId)) drop.push(t.id);
    for (const id of drop) this.crew.deleteThread(id);
    if (keep.length) this.crew.putThreads(keep);
  }

  soulOf(botId: string): string {
    return this.crew.soul(botId);
  }

  refreshBots(id: string): { botId: string; engineChanged: boolean; modelChanged: boolean; oldEngine: AgentKind }[] {
    const g = this.groups.get(id);
    if (!g) return [];
    const out: { botId: string; engineChanged: boolean; modelChanged: boolean; oldEngine: AgentKind }[] = [];
    for (const b of g.bots) {
      const p = this.crew.bot(b.id);
      if (!p) continue;
      const oldEngine = b.agent;
      const engineChanged = p.engine !== b.agent;
      const modelChanged = p.model !== b.modelId;
      b.name = p.name;
      b.agent = p.engine;
      b.modelId = p.model;
      b.persona = this.crew.soul(b.id);
      b.emoji = p.emoji;
      b.color = p.color;
      b.chattiness = p.chattiness;
      b.access = TO_GROUP_ACCESS(p.access);
      b.effort = p.effort;
      b.title = p.title;
      b.description = p.description;
      b.aliases = p.aliases;
      if (engineChanged || modelChanged) out.push({ botId: b.id, engineChanged, modelChanged, oldEngine });
    }
    return out;
  }

  summary(id: string): string {
    return this.crew.roomSummary(id);
  }

  setSummary(id: string, text: string, upTo: number) {
    this.crew.setRoomSummary(id, text);
    const g = this.groups.get(id);
    if (g) g.summaryUpTo = upTo;
  }

  /** The room thread of a bot (the crew sets its chat up and tells crew_mcp who calls). */
  threadOf(groupId: string, botId: string, chatId: string): ThreadRecord {
    const have = this.crew.threads().find((t) => t.roomId === groupId && t.kind === 'room' && t.botId === botId);
    const g = this.groups.get(groupId);
    const bot = g?.bots.find((b) => b.id === botId);
    if (have && have.chatId === chatId) return have;
    const now = Date.now();
    const t: ThreadRecord = { ...(have ?? { id: newId('t'), kind: 'room', botId, roomId: groupId, jobId: null, setupKey: null, createdAt: now, updatedAt: now, seen: 0 }), engine: bot?.agent ?? have?.engine ?? 'CLAUDE', chatId };
    this.crew.putThread(t);
    return t;
  }
}
