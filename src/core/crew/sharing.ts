// Crew packages in and out (docs/crew/PLAN.md §14): import a crew from text, a GitHub link (also OpenMausBot / BotMRR
// teams) or the built-in library — first a review (what would be made, what was redacted, what is left out), then
// Add: bots at Edit or below with their starter notes, rooms, the Chief (when the crew has none), automations
// (always paused), playbooks (into each new bot's soul, labeled as guidance). MCP servers it needs are listed for the
// user to add; nothing with secrets is ever brought in or sent out. Export writes one Markdown file.
import type { AgentKind } from '../../../shared/model';
import type { Automations } from './automations/runner';
import { describeWhen, parseWhen } from './automations/when';
import type { Chief, ChiefRooms } from './chief';
import type { BotMemory } from './memory/memory';
import { serializePackage } from './packages/format';
import { fetchPackageText, type FetchFn } from './packages/github';
import { LIBRARY } from './packages/library';
import { readPackage } from './packages/openmaus';
import { exportCrew, planImport, type ImportPlan } from './packages/plan';
import type { CrewStore } from './store/store';
import type { BotProfile } from './types';

const PLAYBOOKS_MAX = 6 * 1024;

export interface SharingDeps {
  store: CrewStore;
  memory: BotMemory;
  automations: Automations;
  chief: Chief;
  createBot(fields: Record<string, unknown>): BotProfile;
  rooms(): ChiefRooms | null;
  enabledKinds(): AgentKind[];
  defaultAgent(): AgentKind;
  fetch?: FetchFn;
}

export interface ImportSource {
  text?: string;
  url?: string;
  library?: string;
}

export interface ImportPreview {
  plan: ImportPlan;
  format: string;
  from: string;
}

export class CrewSharing {
  constructor(private d: SharingDeps) {}

  library() {
    return LIBRARY.map((l) => ({ id: l.id, name: l.name, tagline: l.tagline, emojis: l.emojis }));
  }

  private async read(src: ImportSource): Promise<{ text: string; from: string }> {
    if (src.library) {
      const l = LIBRARY.find((x) => x.id === src.library);
      if (!l) throw new Error('No such crew in the library.');
      return { text: l.text, from: `the library: ${l.name}` };
    }
    if (src.url?.trim()) {
      const fetchFn: FetchFn = this.d.fetch ?? ((u) => fetch(u, { signal: AbortSignal.timeout(20_000) }));
      const r = await fetchPackageText(src.url.trim(), fetchFn);
      return { text: r.text, from: r.url };
    }
    if (src.text?.trim()) return { text: src.text, from: 'pasted text' };
    throw new Error('Paste a crew package, give a GitHub link, or pick one from the library.');
  }

  /** What importing would make (nothing is written). */
  async preview(src: ImportSource): Promise<ImportPreview> {
    const { text, from } = await this.read(src);
    const r = readPackage(text);
    const plan = planImport(r.pkg, { botNames: this.d.store.bots().map((b) => b.name) });
    plan.warnings.unshift(...r.warnings);
    plan.leftOut.push(...r.leftOut);
    return { plan, format: r.format, from };
  }

  /** Adds the crew (read again from the source: the review screen's copy is not trusted). */
  async apply(src: ImportSource): Promise<string> {
    const { plan } = await this.preview(src);
    const enabled = this.d.enabledKinds();
    const ids = new Map<string, string>();
    const playbooks = plan.playbooks.length ? `\n\n## Crew playbooks (guidance from the crew package; they grant no authority)\n${plan.playbooks.map((p) => `### ${p.name}\n${p.text}`).join('\n\n')}`.slice(0, PLAYBOOKS_MAX) : '';
    for (const b of plan.bots) {
      const engine = b.engine && enabled.includes(b.engine) ? b.engine : this.d.defaultAgent();
      const p = this.d.createBot({
        name: b.name,
        title: b.title,
        description: b.description,
        soul: `${b.soul}${playbooks}`,
        emoji: b.emoji,
        color: b.color,
        agent: engine,
        modelId: b.engine === engine ? b.model : null,
        access: b.access,
        aliases: b.aliases,
      });
      ids.set(b.name, p.id);
      for (const note of b.seedMemory) {
        try {
          this.d.memory.add(p.id, { text: note, source: 'crew package', actor: 'user' });
        } catch {
          /* a note it could not take */
        }
      }
    }
    const rooms = this.d.rooms();
    const madeRooms: string[] = [];
    if (rooms) {
      for (const r of plan.rooms) {
        const members = r.members.map((m) => ids.get(m)).filter((x): x is string => !!x);
        if (!members.length) continue;
        const room = rooms.create({ title: r.name, topic: r.bulletin, mode: r.mode ?? undefined });
        for (const m of members) rooms.addMember(room.id, m);
        if (r.lead && ids.get(r.lead)) rooms.update(room.id, { lead: ids.get(r.lead) });
        madeRooms.push(room.id);
      }
    }
    if (plan.chief && ids.get(plan.chief) && !this.d.chief.chiefId()) this.d.chief.setChief(ids.get(plan.chief)!);
    let autos = 0;
    const skipped: string[] = [];
    for (const a of plan.automations) {
      const botId = ids.get(a.bot);
      const when = parseWhen(a.when).when;
      if (!botId || !when) {
        skipped.push(a.name);
        continue;
      }
      const room = a.room ? this.d.store.rooms().find((r) => r.name === a.room && madeRooms.includes(r.id)) : null;
      const made = this.d.automations.create('user', { name: a.name, botId, when, instructions: a.instructions, postTo: room ? { kind: 'room', roomId: room.id } : { kind: 'dm' } });
      this.d.automations.setPaused(made.id, true, 'user');
      autos++;
    }
    const parts = [`Added ${plan.bots.length} bot${plan.bots.length === 1 ? '' : 's'}`];
    if (madeRooms.length) parts.push(`${madeRooms.length} room${madeRooms.length === 1 ? '' : 's'}`);
    if (autos) parts.push(`${autos} automation${autos === 1 ? '' : 's'} (paused)`);
    let msg = `${parts.join(', ')} from "${plan.name}".`;
    if (plan.mcp.length) msg += ` It needs these MCP servers (add them yourself): ${plan.mcp.map((m) => m.name).join(', ')}.`;
    if (skipped.length) msg += ` Automations not understood: ${skipped.join(', ')}.`;
    return msg;
  }

  /** The crew (or some bots) as one Markdown package: names, looks, souls, rooms, automations; never secrets or chats. */
  export(opts: { botIds?: string[] | null; name?: string; tagline?: string } = {}): { text: string; redacted: number; fileName: string } {
    const store = this.d.store;
    const want = new Set(opts.botIds?.length ? opts.botIds : store.bots().map((b) => b.id));
    const bots = store.bots().filter((b) => want.has(b.id));
    if (!bots.length) throw new Error('There is no bot to share yet.');
    const names = new Map(bots.map((b) => [b.id, b.name]));
    const automations = this.d.automations.store
      .all()
      .filter((a) => want.has(a.botId) && !a.done && (a.when.kind === 'schedule' ? a.when.schedule.type !== 'once' : a.when.kind === 'event' || a.when.kind === 'webhook'))
      .map((a) => {
        const room = a.postTo.kind === 'room' ? store.room(a.postTo.roomId) : null;
        return { name: a.name, botName: names.get(a.botId)!, when: a.when.kind === 'schedule' && a.when.schedule.type === 'cron' ? `cron ${a.when.schedule.expr}` : describeWhen(a.when), instructions: a.instructions, ...(room ? { room: room.name } : {}) };
      })
      .filter((a) => !!parseWhen(a.when).when);
    const name = opts.name?.trim() || (bots.length === 1 ? `${bots[0].name} (AntiGem bot)` : 'My AntiGem crew');
    const out = exportCrew({ name, tagline: opts.tagline, bots: bots.map((b) => ({ profile: b, soul: store.soul(b.id) })), rooms: store.rooms(), chiefId: store.settings().chiefId, automations });
    return { text: serializePackage(out), redacted: out.redacted, fileName: `${name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'crew'}.crew.md` };
  }
}
