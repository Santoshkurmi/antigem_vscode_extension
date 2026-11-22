// The Crew on disk (~/.antigem/crew, shared with the Android app; layout in docs/crew/PLAN.md §4). Plain files, so
// another window, the app or the user can read and edit them; every read tolerates older or hand-edited files
// (normalize*), every write is atomic.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind } from '../../../../shared/model';
import { CREW_SCHEMA, type BotProfile, type CrewAccess, type CrewSettings, type RoomLine, type RoomMode, type RoomRecord, type ThreadRecord } from '../types';
import { appendLine, listDirs, readJson, readLines, readText, writeAtomic, writeJson } from './fsx';

export const ACCESS_LEVELS: CrewAccess[] = ['talk', 'read', 'edit', 'auto', 'full'];
export const SOUL_MAX_BYTES = 24 * 1024;

export const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString('hex')}`;

export class CrewStore {
  readonly root: string;

  constructor(root = path.join(os.homedir(), '.antigem', 'crew')) {
    this.root = root;
  }

  private p(...parts: string[]) {
    return path.join(this.root, ...parts);
  }

  // ------------------------------------------------------------------ crew.json

  settings(): CrewSettings {
    return normalizeSettings(readJson<Partial<CrewSettings>>(this.p('crew.json')) ?? {});
  }

  saveSettings(s: CrewSettings) {
    writeJson(this.p('crew.json'), { ...s, updatedAt: Date.now() });
  }

  /** Whether crew.json exists (a crew was ever set up here or by the app). */
  exists(): boolean {
    return fs.existsSync(this.p('crew.json'));
  }

  /**
   * The key the crew MCP server signs callers' tokens with (created once, private). Persisted: a bot's Claude process
   * outlives an editor reload and keeps the URL it was started with. Kept next to the crew folder, not in it: bots
   * may read the crew folder, and the phone app never gets this device's key.
   */
  secret(): Buffer {
    const f = `${this.root}.secret`;
    const have = readText(f)?.trim();
    if (have && /^[0-9a-f]{64}$/.test(have)) return Buffer.from(have, 'hex');
    const fresh = randomBytes(32).toString('hex');
    writeAtomic(f, fresh, 0o600);
    return Buffer.from(fresh, 'hex');
  }

  // ------------------------------------------------------------------ bots

  bots(): BotProfile[] {
    return listDirs(this.p('bots'))
      .map((id) => this.bot(id))
      .filter((b): b is BotProfile => !!b)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  bot(id: string): BotProfile | null {
    const raw = readJson<Partial<BotProfile>>(this.p('bots', id, 'bot.json'));
    return raw ? normalizeBot(raw, id) : null;
  }

  putBot(b: BotProfile) {
    writeJson(this.p('bots', b.id, 'bot.json'), { ...b, updatedAt: Date.now() });
  }

  soul(id: string): string {
    return readText(this.p('bots', id, 'SOUL.md')) ?? '';
  }

  setSoul(id: string, text: string) {
    writeAtomic(this.p('bots', id, 'SOUL.md'), Buffer.from(text, 'utf8').subarray(0, SOUL_MAX_BYTES));
  }

  soulPath(id: string): string {
    return this.p('bots', id, 'SOUL.md');
  }

  /** The bot's private folder (it works there at talk / read level, away from any project). */
  botFolder(id: string): string {
    const d = this.p('bots', id, 'files');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  memory(id: string): string {
    return readText(this.p('bots', id, 'MEMORY.md')) ?? '';
  }

  deleteBot(id: string) {
    fs.rmSync(this.p('bots', id), { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ rooms

  rooms(): RoomRecord[] {
    return listDirs(this.p('rooms'))
      .map((id) => this.room(id))
      .filter((r): r is RoomRecord => !!r)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  room(id: string): RoomRecord | null {
    const raw = readJson<Partial<RoomRecord>>(this.p('rooms', id, 'room.json'));
    return raw ? normalizeRoom(raw, id) : null;
  }

  putRoom(r: RoomRecord) {
    writeJson(this.p('rooms', r.id, 'room.json'), { ...r, updatedAt: Date.now() });
  }

  transcript(roomId: string): RoomLine[] {
    return readLines<RoomLine>(this.p('rooms', roomId, 'transcript.ndjson'));
  }

  appendLine(roomId: string, line: RoomLine) {
    appendLine(this.p('rooms', roomId, 'transcript.ndjson'), line);
  }

  /** Writes a whole transcript at once (migration). */
  writeTranscript(roomId: string, lines: RoomLine[]) {
    writeAtomic(this.p('rooms', roomId, 'transcript.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));
  }

  /** The room's private folder (talk-only and read-only members run there, away from any project). */
  roomFolder(roomId: string): string {
    const d = this.p('rooms', roomId, 'files');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  /** The room's rolling summary of older lines (summary.md; '' = none yet). */
  roomSummary(roomId: string): string {
    return readText(this.p('rooms', roomId, 'summary.md')) ?? '';
  }

  setRoomSummary(roomId: string, text: string) {
    writeAtomic(this.p('rooms', roomId, 'summary.md'), text);
  }

  /** usage.ndjson: one line per bot turn (tokens / cost per bot, room, job). */
  logUsage(entry: Record<string, unknown>) {
    try {
      appendLine(this.p('usage.ndjson'), { at: Date.now(), ...entry });
    } catch {
      /* usage is a nice-to-have */
    }
  }

  deleteRoom(id: string) {
    fs.rmSync(this.p('rooms', id), { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ threads

  threads(): ThreadRecord[] {
    const raw = readJson<Partial<ThreadRecord>[]>(this.p('threads.json'));
    return Array.isArray(raw) ? raw.filter((t) => t && typeof t.id === 'string').map(normalizeThread) : [];
  }

  thread(id: string): ThreadRecord | null {
    return this.threads().find((t) => t.id === id) ?? null;
  }

  threadByChat(engine: AgentKind, chatId: string): ThreadRecord | null {
    return this.threads().find((t) => t.engine === engine && t.chatId === chatId) ?? null;
  }

  putThread(t: ThreadRecord) {
    const all = this.threads().filter((x) => x.id !== t.id);
    all.push({ ...t, updatedAt: Date.now() });
    writeJson(this.p('threads.json'), all);
  }

  putThreads(list: ThreadRecord[]) {
    const ids = new Set(list.map((t) => t.id));
    const now = Date.now();
    writeJson(this.p('threads.json'), [...this.threads().filter((x) => !ids.has(x.id)), ...list.map((t) => ({ ...t, updatedAt: now }))]);
  }

  deleteThread(id: string) {
    writeJson(
      this.p('threads.json'),
      this.threads().filter((t) => t.id !== id),
    );
  }
}

// ------------------------------------------------------------------------------------------------ normalize

const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};
/** A positive limit, or null (none). */
const positive = (v: unknown, whole: boolean): number | null => {
  const n = Number(v);
  if (!v || !Number.isFinite(n) || n <= 0) return null;
  return whole ? Math.round(n) : Math.round(n * 100) / 100;
};
const access = (v: unknown, d: CrewAccess): CrewAccess => (ACCESS_LEVELS.includes(v as CrewAccess) ? (v as CrewAccess) : d);
const ENGINES: AgentKind[] = ['CLAUDE', 'CODEX', 'OPENCODE', 'AGY'];
const engine = (v: unknown): AgentKind => (ENGINES.includes(v as AgentKind) ? (v as AgentKind) : 'CLAUDE');

export function normalizeSettings(raw: Partial<CrewSettings>): CrewSettings {
  const now = Date.now();
  return {
    schema: num(raw.schema, CREW_SCHEMA, 1, 1000),
    chiefId: strOrNull(raw.chiefId),
    crewAccess: raw.crewAccess ? access(raw.crewAccess, 'edit') : null,
    migratedGroups: Array.isArray(raw.migratedGroups) ? raw.migratedGroups.filter((x): x is string => typeof x === 'string') : [],
    paused: raw.paused === true,
    webhookPort: num(raw.webhookPort, 1248, 1024, 65535),
    caps: { dayTokens: positive(raw.caps?.dayTokens, true), dayUsd: positive(raw.caps?.dayUsd, false) },
    tourDone: raw.tourDone === true,
    agyCrewServer: raw.agyCrewServer === 'allowed' || raw.agyCrewServer === 'declined' ? raw.agyCrewServer : 'ask',
    createdAt: num(raw.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: num(raw.updatedAt, now, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function normalizeBot(raw: Partial<BotProfile>, id: string): BotProfile {
  const now = Date.now();
  const lvl = access(raw.access, 'edit');
  return {
    id,
    name: str(raw.name, 'Bot').replace(/\s+/g, '') || 'Bot',
    title: str(raw.title),
    description: str(raw.description),
    emoji: str(raw.emoji, '🤖'),
    color: /^#[0-9a-fA-F]{6}$/.test(str(raw.color)) ? str(raw.color) : '#6366F1',
    engine: engine(raw.engine),
    model: strOrNull(raw.model),
    effort: str(raw.effort, 'default'),
    fallbackModels: Array.isArray(raw.fallbackModels) ? raw.fallbackModels.filter((x): x is string => typeof x === 'string') : [],
    access: lvl,
    accessCeiling: access(raw.accessCeiling, ACCESS_LEVELS[Math.max(ACCESS_LEVELS.indexOf(lvl), ACCESS_LEVELS.indexOf('edit'))]),
    tools: {
      mcp: Array.isArray(raw.tools?.mcp) ? raw.tools!.mcp!.filter((x): x is string => typeof x === 'string') : null,
      off: Array.isArray(raw.tools?.off) ? raw.tools!.off.filter((x): x is string => typeof x === 'string') : [],
    },
    folder: strOrNull(raw.folder),
    chattiness: num(raw.chattiness, 40, 0, 100),
    department: strOrNull(raw.department),
    chief: raw.chief === true,
    reportsTo: strOrNull(raw.reportsTo),
    memory: { enabled: raw.memory?.enabled !== false, capture: raw.memory?.capture === true },
    checkWork: strOrNull(raw.checkWork),
    browser: raw.browser === true,
    voice: strOrNull(raw.voice),
    aliases: Array.isArray(raw.aliases) ? [...new Set(raw.aliases.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 40) : [],
    paused: raw.paused === true,
    pinned: raw.pinned === true,
    createdAt: num(raw.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: num(raw.updatedAt, now, 0, Number.MAX_SAFE_INTEGER),
  };
}

const ROOM_MODES: RoomMode[] = ['mentions', 'lead', 'everyone', 'auto', 'moderator'];

export function normalizeRoom(raw: Partial<RoomRecord>, id: string): RoomRecord {
  const now = Date.now();
  const members = Array.isArray(raw.members) ? [...new Set(raw.members.filter((x): x is string => typeof x === 'string'))] : [];
  const lead = strOrNull(raw.lead);
  return {
    id,
    name: str(raw.name, 'Room') || 'Room',
    members,
    lead: lead && members.includes(lead) ? lead : (members[0] ?? null),
    bulletin: str(raw.bulletin),
    mode: ROOM_MODES.includes(raw.mode as RoomMode) ? (raw.mode as RoomMode) : 'mentions',
    drafting: raw.drafting === 'parallel' ? 'parallel' : 'turns',
    turnsPerMember: num(raw.turnsPerMember, 1, 1, 5),
    maxBotTurns: num(raw.maxBotTurns, 6, 1, 50),
    autoTalk: { on: raw.autoTalk?.on === true, idleSeconds: num(raw.autoTalk?.idleSeconds, 60, 10, 3600) },
    folder: strOrNull(raw.folder),
    holds: raw.holds && typeof raw.holds === 'object' ? Object.fromEntries(Object.entries(raw.holds).filter(([, v]) => v === true)) : {},
    department: strOrNull(raw.department),
    router: { engine: raw.router?.engine ? engine(raw.router.engine) : null, model: strOrNull(raw.router?.model) },
    goal:
      raw.goal && typeof raw.goal.text === 'string'
        ? {
            text: raw.goal.text,
            status: ['running', 'completed', 'needs-input', 'blocked', 'stopped'].includes(raw.goal.status) ? raw.goal.status : 'stopped',
            turns: num(raw.goal.turns, 0, 0, 1000),
            maxTurns: num(raw.goal.maxTurns, 13, 1, 100),
            note: str(raw.goal.note),
            startedAt: num(raw.goal.startedAt, now, 0, Number.MAX_SAFE_INTEGER),
            updatedAt: num(raw.goal.updatedAt, now, 0, Number.MAX_SAFE_INTEGER),
          }
        : null,
    heldMessages: Array.isArray(raw.heldMessages)
      ? raw.heldMessages.filter((h) => h && typeof h.botId === 'string' && typeof h.lineId === 'string' && members.includes(h.botId)).slice(-50)
      : [],
    summary: { upTo: num(raw.summary?.upTo, 0, 0, Number.MAX_SAFE_INTEGER), at: num(raw.summary?.at, 0, 0, Number.MAX_SAFE_INTEGER) },
    fromGroup: strOrNull(raw.fromGroup),
    userName: str(raw.userName, 'You').trim() || 'You',
    paused: raw.paused === true,
    talk: { botTurns: num(raw.talk?.botTurns, 0, 0, 1_000_000), waiting: raw.talk?.waiting === true },
    createdAt: num(raw.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: num(raw.updatedAt, now, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function normalizeThread(raw: Partial<ThreadRecord>): ThreadRecord {
  const now = Date.now();
  const kinds: ThreadRecord['kind'][] = ['dm', 'room', 'work', 'automation', 'router', 'problems'];
  return {
    id: str(raw.id),
    botId: strOrNull(raw.botId),
    engine: engine(raw.engine),
    chatId: strOrNull(raw.chatId),
    kind: kinds.includes(raw.kind as ThreadRecord['kind']) ? (raw.kind as ThreadRecord['kind']) : 'work',
    roomId: strOrNull(raw.roomId),
    jobId: strOrNull(raw.jobId),
    seen: num(raw.seen, 0, 0, Number.MAX_SAFE_INTEGER),
    setupKey: strOrNull(raw.setupKey),
    createdAt: num(raw.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
    updatedAt: num(raw.updatedAt, now, 0, Number.MAX_SAFE_INTEGER),
  };
}
