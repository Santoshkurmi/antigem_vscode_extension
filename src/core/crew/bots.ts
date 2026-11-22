// Bots for the Crew screen, the Chief and crew_admin (engine.ts): create and edit one (a free one-word name, who checks
// its work, its aliases), pause it, delete it (asking first, or not: the Chief's Undo).
import type { AgentKind } from '../../../shared/model';
import type { CrewDms } from './dms';
import type { CrewEngine, CrewEngineApi } from './engine';
import { ACCESS_LEVELS, newId, normalizeBot, type CrewStore } from './store/store';
import type { BotProfile, CrewAccess } from './types';

export const ENGINES: AgentKind[] = ['CLAUDE', 'CODEX', 'OPENCODE', 'AGY'];
const RESERVED = /^(all|everyone|here|you|user)$/i;
const PALETTE = ['#6366F1', '#EC4899', '#10B981', '#F59E0B', '#06B6D4', '#8B5CF6', '#EF4444', '#84CC16'];

export function needBot(store: CrewStore, id: string): BotProfile {
  const b = store.bot(id);
  if (!b) throw new Error('No such bot.');
  return b;
}

/** Paused bots: their room turns stop (the RoomEngine), their jobs wait. */
export function pauseBots(e: Pick<CrewEngine, 'onPause' | 'jobs'>, botIds: string[]) {
  e.onPause?.(botIds);
  e.jobs.pause(botIds);
}

export class CrewBots {
  constructor(
    private e: CrewEngine,
    private api: () => CrewEngineApi | null,
    private dms: CrewDms,
  ) {}

  private get store() {
    return this.e.crew.store;
  }

  /** A free one-word name (unique in the crew: bots are @-mentioned anywhere). */
  private checkName(raw: unknown, self: string | null): string {
    const name = String(raw ?? '')
      .replace(/[^\p{L}\p{N}_-]+/gu, '')
      .slice(0, 24);
    if (!name) throw new Error('A bot needs a one-word name.');
    if (RESERVED.test(name)) throw new Error(`"${name}" is a reserved word; pick another name.`);
    if (this.store.bots().some((b) => b.id !== self && b.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a bot called ${name}.`);
    return name;
  }

  /** Who checks a bot's work: 'auto', another bot's id, or null (off). */
  private checkerOf(v: unknown, self: string | null): string | null {
    const s = v == null ? '' : String(v);
    if (s === 'auto') return 'auto';
    return s && s !== self && this.store.bot(s) ? s : null;
  }

  createBot(d: Record<string, unknown>): BotProfile {
    const count = this.store.bots().length;
    const kinds = this.api()?.enabledKinds() ?? ENGINES;
    const engine = ENGINES.includes(d.agent as AgentKind) ? (d.agent as AgentKind) : (this.api()?.defaultAgent() ?? kinds[0] ?? 'CLAUDE');
    const access = ACCESS_LEVELS.includes(d.access as CrewAccess) ? (d.access as CrewAccess) : 'edit';
    const b = normalizeBot(
      {
        name: this.checkName(d.name, null),
        title: String(d.title ?? '').slice(0, 80),
        description: String(d.description ?? '').slice(0, 400),
        emoji: String(d.emoji ?? '').trim().slice(0, 8) || String(d.name ?? '?').slice(0, 1).toUpperCase(),
        color: /^#[0-9a-f]{6}$/i.test(String(d.color ?? '')) ? String(d.color) : PALETTE[count % PALETTE.length],
        engine,
        model: d.modelId ? String(d.modelId) : null,
        effort: String(d.effort ?? 'default'),
        access,
        accessCeiling: ACCESS_LEVELS.includes(d.accessCeiling as CrewAccess) ? (d.accessCeiling as CrewAccess) : undefined,
        chattiness: Number(d.chattiness ?? 40),
        aliases: aliasesOf(d.aliases),
        checkWork: this.checkerOf(d.checkWork, null),
        browser: d.browser === true,
        voice: d.voice ? String(d.voice).slice(0, 200) : null,
      },
      newId('b'),
    );
    this.store.putBot(b);
    this.store.setSoul(b.id, String(d.soul ?? '').trim());
    this.e.changed();
    return b;
  }

  updateBot(id: string, d: Record<string, unknown>): BotProfile {
    const b = needBot(this.store, id);
    const next: BotProfile = { ...b };
    if (d.name !== undefined) next.name = this.checkName(d.name, id);
    if (d.title !== undefined) next.title = String(d.title).slice(0, 80);
    if (d.description !== undefined) next.description = String(d.description).slice(0, 400);
    if (d.emoji !== undefined) next.emoji = String(d.emoji).trim().slice(0, 8) || next.name.slice(0, 1).toUpperCase();
    if (d.color !== undefined && /^#[0-9a-f]{6}$/i.test(String(d.color))) next.color = String(d.color);
    if (d.agent !== undefined && ENGINES.includes(d.agent as AgentKind) && d.agent !== b.engine) {
      next.engine = d.agent as AgentKind;
      next.model = null;
    }
    if (d.modelId !== undefined) next.model = d.modelId ? String(d.modelId) : null;
    if (d.effort !== undefined) next.effort = String(d.effort) || 'default';
    if (d.access !== undefined && ACCESS_LEVELS.includes(d.access as CrewAccess)) next.access = d.access as CrewAccess;
    if (d.accessCeiling !== undefined && ACCESS_LEVELS.includes(d.accessCeiling as CrewAccess)) next.accessCeiling = d.accessCeiling as CrewAccess;
    // raising a bot above its ceiling raises the ceiling too (it is the user's own choice)
    if (ACCESS_LEVELS.indexOf(next.access) > ACCESS_LEVELS.indexOf(next.accessCeiling)) next.accessCeiling = next.access;
    if (d.chattiness !== undefined) next.chattiness = Math.max(0, Math.min(100, Math.round(Number(d.chattiness) || 0)));
    if (d.paused !== undefined) next.paused = d.paused === true;
    if (d.aliases !== undefined) next.aliases = aliasesOf(d.aliases);
    if (d.memoryEnabled !== undefined) next.memory = { ...next.memory, enabled: d.memoryEnabled === true };
    if (d.memoryCapture !== undefined) next.memory = { ...next.memory, capture: d.memoryCapture === true };
    if (d.checkWork !== undefined) next.checkWork = this.checkerOf(d.checkWork, id);
    if (d.browser !== undefined) next.browser = d.browser === true;
    if (d.voice !== undefined) next.voice = d.voice ? String(d.voice).slice(0, 200) : null;
    this.store.putBot(normalizeBot(next, id));
    if (next.paused && !b.paused) pauseBots(this.e, [id]);
    if (!next.paused && b.paused) this.e.jobs.resumeBots([id]);
    if (d.soul !== undefined) this.store.setSoul(id, String(d.soul));
    // another engine: its DM is a chat of the old agent, so the next message starts a new one there
    if (next.engine !== b.engine) {
      const dm = this.dms.dmThread(id);
      if (dm?.chatId) this.store.putThread({ ...dm, chatId: null, engine: next.engine, setupKey: null });
    }
    this.e.onRoomsChanged?.();
    this.e.changed();
    return needBot(this.store, id);
  }

  /** Deletes a bot without asking (the Chief's Undo of a bot it made). */
  removeBotNow(id: string) {
    const b = this.store.bot(id);
    if (!b) return;
    for (const t of this.store.threads().filter((x) => x.botId === id)) {
      if (t.chatId && t.kind !== 'room') void this.api()?.backend(t.engine)?.conversationAction(t.chatId, 'delete').catch(() => undefined);
      if (t.kind !== 'room') this.store.deleteThread(t.id);
    }
    this.e.removeFromRooms?.(id);
    if (this.store.settings().chiefId === id) this.e.chief.setChief(null);
    this.store.deleteBot(id);
    this.e.changed();
  }

  async deleteBot(id: string): Promise<string | void> {
    const b = needBot(this.store, id);
    const rooms = this.store.rooms().filter((r) => r.members.includes(id));
    const ok = (await this.api()?.confirm(
      `Delete ${b.name}? ${rooms.length ? `It leaves ${rooms.map((r) => r.name).join(', ')}. ` : ''}Its DM and its memory are deleted; what it said in rooms stays.`,
      'Delete',
    )) ?? true;
    if (!ok) return;
    // its DM and its hidden chats (jobs, automations, Problems) go too; what it said in rooms stays
    this.removeBotNow(id);
    return `${b.name} left the crew`;
  }
}

/** Aliases from the editor ("deploy, docker") or a list: lowercase, unique, at most 40. */
function aliasesOf(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[,\n]/);
  return [...new Set(list.map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 40);
}
