// Schema migrations of ~/.antigem/crew, and the one-time copy of Group chats (~/.antigem/groups) into Crew rooms and
// bots. The groups folder is only read: Group chats keep working until the Crew screen replaces them (Phase 1).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalize as normalizeGroup } from './legacyGroups';
import type { Group } from '../rooms/types';
import { CREW_SCHEMA, type BotProfile, type CrewAccess, type RoomLine, type RoomRecord, type ThreadRecord } from '../types';
import { listDirs, readJson } from './fsx';
import { newId, normalizeBot, normalizeRoom, type CrewStore } from './store';

/** Steps from schema n to n + 1. */
const STEPS: Record<number, (store: CrewStore) => void> = {
  // Rooms v2: 'mentions' now means "only who is @mentioned answers"; until now it stood for the Group chats' natural
  // mode (the user always got an answer), which is 'auto' now
  1: (store) => {
    for (const r of store.rooms()) if (r.mode === 'mentions') store.putRoom({ ...r, mode: 'auto' });
  },
};

/** Brings crew.json (and what it describes) up to CREW_SCHEMA. Returns the steps run. */
export function migrateSchema(store: CrewStore): number[] {
  const s = store.settings();
  const ran: number[] = [];
  if (!store.exists()) {
    store.saveSettings({ ...s, schema: CREW_SCHEMA });
    return ran;
  }
  if (s.schema > CREW_SCHEMA) throw new Error(`The crew folder is from a newer AntiGem (schema ${s.schema}); update AntiGem to open it`);
  for (let n = s.schema; n < CREW_SCHEMA; n++) {
    STEPS[n]?.(store);
    ran.push(n);
  }
  if (ran.length) store.saveSettings({ ...store.settings(), schema: CREW_SCHEMA });
  return ran;
}

export interface GroupsMigration {
  rooms: string[];
  bots: string[];
  /** Group bots that were the same as an existing crew bot (same name, engine and persona). */
  reused: string[];
  skipped: string[];
}

const ACCESS: Record<string, CrewAccess> = { chat: 'talk', read: 'read', edit: 'edit' };

/**
 * Copies every Group chat not copied yet into a room (same id): its bots become crew bots (one per name + engine +
 * persona across all groups), its messages the room transcript, each bot's hidden chat a room thread that goes on
 * where it was (and the moderator's chat the room's router thread).
 */
export function migrateGroups(store: CrewStore, groupsDir = path.join(os.homedir(), '.antigem', 'groups')): GroupsMigration {
  const out: GroupsMigration = { rooms: [], bots: [], reused: [], skipped: [] };
  const settings = store.settings();
  const done = new Set(settings.migratedGroups);
  const sameBot = (name: string, engine: string, soul: string) =>
    store.bots().find((b) => b.name.toLowerCase() === name.toLowerCase() && b.engine === engine && store.soul(b.id).trim() === soul.trim());
  // names are unique in the crew (they are @-mentioned anywhere): another bot of the same name gets a number
  const freeName = (base: string) => {
    const taken = new Set(store.bots().map((b) => b.name.toLowerCase()));
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}${n}`;
    return name;
  };

  for (const gid of listDirs(groupsDir)) {
    if (done.has(gid)) continue;
    const raw = readJson<Partial<Group>>(path.join(groupsDir, gid, 'group.json'));
    if (!raw) {
      out.skipped.push(gid);
      continue;
    }
    const g = normalizeGroup(raw, gid);
    const memberOf = new Map<string, string>();
    for (const gb of g.bots) {
      const name = gb.name.replace(/\s+/g, '') || 'Bot';
      const existing = sameBot(name, gb.agent, gb.persona);
      if (existing) {
        memberOf.set(gb.id, existing.id);
        out.reused.push(existing.id);
        continue;
      }
      const id = newId('b');
      const bot: BotProfile = normalizeBot(
        {
          name: freeName(name),
          title: '',
          description: gb.persona.split('\n')[0].slice(0, 200),
          emoji: gb.emoji,
          color: gb.color,
          engine: gb.agent,
          model: gb.modelId,
          effort: gb.effort,
          access: ACCESS[gb.access] ?? 'talk',
          chattiness: gb.chattiness,
          createdAt: g.createdAt,
        },
        id,
      );
      store.putBot(bot);
      store.setSoul(id, gb.persona);
      memberOf.set(gb.id, id);
      out.bots.push(id);
    }
    const members = g.bots.map((b) => memberOf.get(b.id)!).filter(Boolean);
    const room: RoomRecord = normalizeRoom(
      {
        name: g.title,
        members,
        lead: members[0] ?? null,
        bulletin: g.topic,
        mode: g.mode === 'everyone' ? 'everyone' : g.mode === 'moderator' ? 'moderator' : 'auto',
        maxBotTurns: g.maxBotTurns,
        autoTalk: { on: g.autoTalk, idleSeconds: g.idleSeconds },
        folder: g.project,
        holds: Object.fromEntries(g.bots.filter((b) => b.muted && memberOf.has(b.id)).map((b) => [memberOf.get(b.id)!, true])),
        router: { engine: g.moderatorAgent, model: g.moderatorModelId },
        fromGroup: gid,
        userName: g.userName,
        paused: g.paused,
        talk: { botTurns: g.botTurns, waiting: g.waiting },
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
      },
      gid,
    );
    store.putRoom(room);
    const lines: RoomLine[] = g.messages.map((m) => ({
      id: m.id,
      from: m.from === 'user' || m.from === 'system' || m.from === 'notice' ? m.from : (memberOf.get(m.from) ?? m.from),
      name: m.name,
      text: m.text,
      at: m.at,
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    }));
    store.writeTranscript(gid, lines);
    const now = Date.now();
    const threads: ThreadRecord[] = [];
    for (const gb of g.bots) {
      if (!gb.chatId || !memberOf.has(gb.id)) continue;
      threads.push({ id: newId('t'), botId: memberOf.get(gb.id)!, engine: gb.agent, chatId: gb.chatId, kind: 'room', roomId: gid, jobId: null, seen: gb.seen, setupKey: null, createdAt: now, updatedAt: now });
    }
    if (g.moderatorChatId && g.moderatorAgent) {
      threads.push({ id: newId('t'), botId: null, engine: g.moderatorAgent, chatId: g.moderatorChatId, kind: 'router', roomId: gid, jobId: null, seen: g.moderatorSeen, setupKey: null, createdAt: now, updatedAt: now });
    }
    if (threads.length) store.putThreads(threads);
    // the group's private folder (talk-only bots ran there) stays the room's
    const oldRoom = path.join(groupsDir, gid, 'room');
    if (fs.existsSync(oldRoom) && !room.folder) {
      try {
        fs.cpSync(oldRoom, store.roomFolder(gid), { recursive: true, errorOnExist: false });
      } catch {
        /* an empty folder is fine */
      }
    }
    done.add(gid);
    out.rooms.push(gid);
    // saved after each group: a failure later never copies this one twice
    store.saveSettings({ ...store.settings(), migratedGroups: [...done] });
  }
  return out;
}
