// OpenMausBot packages → AntiGem Crew packages (docs/crew/PLAN.md §14, docs/crew/OPENMAUSBOT_NOTES.md "Packages").
// Reads BotMRR Markdown (`botmrr: 1`: a v1 package in the frontmatter + a prose body; `botmrr: 2`: a template folder's
// bot.md / team.md, v2 fields) and `openmaus.package` JSON v1–v3, with the field shapes of OpenMausBot's
// shared/package-format.ts. Bots (soul, look, approval, seed memory), the team leader, group chats, routines (paused),
// playbooks and connections (as MCP requirements, without credential values) map onto ours; what has no AntiGem
// equivalent (skills, presets, pictures, tool switches, examples) is listed in leftOut, never silently lost.
import type { CrewAccess, RoomMode } from '../types';
import { describeCrew } from './prose';
import { isObj, NAMED_COLORS, normalizePackage, PACKAGE_LIMITS, PackageError, parsePackage, readFrontmatter, splitFrontmatter, uniqueName, type CrewPackage } from './format';

export type PackageFormat = 'antigem' | 'botmrr' | 'openmaus-json';

/** Which package format a text is (null: none of ours). Cheap: looks at the frontmatter's keys or the JSON's format. */
export function detectFormat(text: string): PackageFormat | null {
  const t = text.trimStart();
  if (t.startsWith('{')) {
    if (t.length > PACKAGE_LIMITS.bytes) return null;
    try {
      const v: unknown = JSON.parse(t);
      return isObj(v) && v.format === 'openmaus.package' ? 'openmaus-json' : null;
    } catch {
      return null;
    }
  }
  const fm = splitFrontmatter(t);
  if (!fm) return null;
  if (/^antigem-crew\s*:/m.test(fm.yaml)) return 'antigem';
  if (/^botmrr\s*:/m.test(fm.yaml)) return 'botmrr';
  return null;
}

/** An OpenMausBot package as a CrewPackage, with warnings (things changed) and leftOut (things not brought over). */
export function fromOpenMaus(text: string): { pkg: CrewPackage; warnings: string[]; leftOut: string[] } {
  if (Buffer.byteLength(text, 'utf8') > PACKAGE_LIMITS.bytes) throw new PackageError('This package is larger than 4 MB.');
  const format = detectFormat(text);
  const newer = () => new PackageError('This package was made by a newer OpenMausBot than AntiGem knows; ask its author for an older export.');
  if (format === 'openmaus-json') {
    const doc = JSON.parse(text.trimStart()) as Record<string, unknown>;
    const version = Number(doc.version);
    if (version > 3) throw newer();
    if (![1, 2, 3].includes(version)) throw new PackageError(`Unknown openmaus.package version: ${String(doc.version)}.`);
    if (!isObj(doc.package)) throw new PackageError('This openmaus.package file has no "package".');
    return mapPackage(doc.package, '', false);
  }
  if (format === 'botmrr') {
    const fm = splitFrontmatter(text)!;
    const { botmrr, ...def } = readFrontmatter(fm);
    if (Number(botmrr) > 2) throw newer();
    if (botmrr !== 1 && botmrr !== 2) throw new PackageError(`Unknown BotMRR version: ${String(botmrr)}.`);
    return mapPackage(def, fm.body, true);
  }
  throw new PackageError('This is not an OpenMausBot package (BotMRR Markdown or openmaus.package JSON).');
}

/** Any package text this module reads (AntiGem, BotMRR, openmaus.package JSON) → a CrewPackage. Throws PackageError. */
export function readPackage(text: string): { format: PackageFormat; pkg: CrewPackage; warnings: string[]; leftOut: string[] } {
  const format = detectFormat(text);
  if (format === 'antigem') return { format, ...parsePackage(text), leftOut: [] };
  if (format) return { format, ...fromOpenMaus(text) };
  throw new PackageError('This is not a crew package: an AntiGem crew file (antigem-crew: 1), a BotMRR file (botmrr: 1) or an openmaus.package file.');
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const items = (v: unknown) => (Array.isArray(v) ? v.filter(isObj) : []);
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function mapPackage(def: Record<string, unknown>, markdownBody: string, isMarkdown: boolean) {
  const warnings: string[] = [];
  const leftOut: string[] = [];
  const agents = items(def.agents);
  if (!agents.length) throw new PackageError('This OpenMausBot package has no bots (only skills or preset bots), so there is no crew to import.');
  const team = isObj(def.team) ? def.team : {};

  // agent keys → bot names (names made unique: references in rooms and routines use the key)
  const taken = new Set<string>();
  const nameOf = new Map<string, string>();
  for (const a of agents) nameOf.set(text(a.key), uniqueName(text(a.name) || text(a.key) || 'Bot', taken));
  const playbookByKey = new Map(items(def.playbooks).map((p) => [text(p.key), p]));
  const leader = text(team.leader) || text(def.chiefOfStaff);

  const bots = agents.map((a) => {
    const name = nameOf.get(text(a.key))!;
    const look = isObj(a.appearance) ? a.appearance : {};
    const used = (Array.isArray(a.playbooks) ? a.playbooks : []).map((k) => text(playbookByKey.get(text(k))?.name)).filter(Boolean);
    const soul = [text(a.soul), used.length ? `Playbooks you use: ${used.join(', ')}.` : ''].filter(Boolean).join('\n\n');
    if (look.avatar) leftOut.push(`${name}'s picture (AntiGem bots use an emoji)`);
    if (Array.isArray(a.skills) && a.skills.length) leftOut.push(`${name}'s skills: ${a.skills.map(text).join(', ')} (skills are not imported yet)`);
    if (isObj(a.tools) && Array.isArray(a.tools.off) && a.tools.off.length) leftOut.push(`${name}'s switched-off tool groups: ${a.tools.off.map(text).join(', ')} (AntiGem's tools differ)`);
    const access: CrewAccess | undefined = a.approval === 'auto' ? 'auto' : a.approval === 'ask' ? 'edit' : undefined;
    return {
      name,
      title: text(a.title),
      description: text(a.description),
      soul,
      emoji: emojiFor(text(a.title), `${name} ${text(a.key)}`),
      color: NAMED_COLORS[text(look.color)] ?? '',
      access,
      chief: text(a.key) === leader || undefined,
      seedMemory: seedNotes(a.seed),
    };
  });

  // group chats → rooms (the default responder becomes the mode + lead)
  const roomTaken = new Set<string>();
  const roomOf = new Map<string, string>();
  const rooms = items(def.rooms).map((r) => {
    const name = uniqueName(text(r.name) || text(r.key) || 'Room', roomTaken);
    roomOf.set(text(r.key), name);
    const resp = isObj(r.defaultResponder) ? r.defaultResponder : {};
    const modes: Record<string, RoomMode> = { agent: 'lead', everyone: 'everyone', mentions: 'mentions', auto: 'auto' };
    return {
      name,
      members: (Array.isArray(r.members) ? r.members : []).map((k) => nameOf.get(text(k))).filter(Boolean),
      lead: nameOf.get(text(resp.agent)),
      bulletin: text(r.bulletin),
      mode: modes[text(resp.kind)],
    };
  });

  // routines → automations (always paused)
  let extraRoutineSettings = false;
  const automations = items(def.routines).flatMap((r) => {
    const name = text(r.name) || text(r.key) || 'Routine';
    const when = whenOf(r.schedule, name, warnings);
    if (!when) return [];
    if (r.runOn === 'cloud') warnings.push(`${name} ran on OpenMausBot's cloud; here it runs on this computer while the editor is open.`);
    if (['durationMinutes', 'timeoutMinutes', 'overlap', 'continuity', 'runOnStartup'].some((k) => r[k] !== undefined)) extraRoutineSettings = true;
    return [{ name, bot: nameOf.get(text(r.agent)) ?? text(r.agent), when, instructions: text(r.prompt), room: r.room ? roomOf.get(text(r.room)) : undefined }];
  });
  if (extraRoutineSettings) leftOut.push('routine run limits, overlap, continuity and run-on-startup settings (AntiGem automations use their own)');

  const playbooks = items(def.playbooks).map((p) => ({
    name: text(p.name) || text(p.key),
    text: [text(p.summary), Array.isArray(p.triggers) && p.triggers.length ? `Use when: ${p.triggers.map(text).join(', ')}` : '', text(p.instructions)].filter(Boolean).join('\n\n'),
  }));

  // connections (credential slots) and required apps → MCP requirements; never values
  const mcp: { name: string; reason: string; url?: string }[] = [];
  for (const c of items(def.connections)) {
    const server = isObj(c.mcp) ? c.mcp : {};
    const label = text(c.label);
    mcp.push({ name: text(c.key) || label, reason: [label, text(c.reason)].filter(Boolean).join(': '), url: text(server.url) || undefined });
    const names = Array.isArray(server.valueNames) ? server.valueNames.map(text).filter(Boolean) : [];
    if (names.length) leftOut.push(`${label || text(c.key)} needs ${names.join(', ')}: add the values yourself when you turn it on (they never travel in a package)`);
  }
  const reqs = isObj(def.requirements) ? def.requirements : {};
  for (const app of items(reqs.apps)) {
    if (mcp.some((m) => m.name === text(app.slug))) continue;
    mcp.push({ name: text(app.slug) || text(app.label), reason: `${[text(app.label), text(app.reason)].filter(Boolean).join(': ')}${app.optional ? ' (optional)' : ''}` });
  }
  if (Array.isArray(reqs.capabilities) && reqs.capabilities.length) leftOut.push(`OpenMausBot capabilities: ${reqs.capabilities.map(text).join(', ')} (bots use this editor's tools instead)`);

  const skills = isObj(def.skills) ? items(def.skills.entries) : [];
  const skillNames = skills.length ? skills.map((s) => text(s.name)) : Array.isArray(def.skills) ? def.skills.map(text) : [];
  if (skillNames.length) leftOut.push(`${skillNames.length} skill${skillNames.length > 1 ? 's' : ''}: ${skillNames.join(', ')} (skills are not imported yet)`);
  if (items(def.presets).length) leftOut.push(`${items(def.presets).length} preset bot(s): ${items(def.presets).map((p) => text(p.name)).join(', ')} (only the crew's own bots are imported)`);
  if (items(def.examples).length) leftOut.push(`${items(def.examples).length} example conversation(s)`);
  const brief = text(team.brief);
  if (brief) leftOut.push("the team brief as shared context: AntiGem has no crew-wide brief yet, so it is kept in the package text (the body)");

  const raw = {
    name: text(def.name) || text(team.name),
    tagline: text(def.tagline),
    outcomes: Array.isArray(def.outcomes) ? def.outcomes : [],
    requirements: { mcp },
    bots,
    rooms,
    playbooks,
    automations,
  };
  const pkg = normalizePackage(JSON.parse(JSON.stringify(raw)) as Record<string, unknown>, '', warnings);
  const author = isObj(def.author) ? text(def.author.name) : '';
  const credit = [author && `By ${author}`, text(def.license) && `${text(def.license)} license`, 'imported from OpenMausBot'].filter(Boolean).join(' · ');
  const intro = [text(def.summary), brief ? `## Team brief\n\n${brief}` : '', `_${credit}_`].filter(Boolean).join('\n\n');
  pkg.body = isMarkdown && markdownBody.trim() ? (brief ? `${markdownBody.trimEnd()}\n\n## Team brief\n\n${brief}\n` : markdownBody) : describeCrew(pkg, intro);
  return { pkg, warnings, leftOut };
}

/** A routine schedule → our `when` ("daily 09:00 mon-fri", "every 30m", "cron 0 10 * * 1", "once 2026-11-22 09:00 UTC"). */
function whenOf(s: unknown, name: string, warnings: string[]): string {
  if (!isObj(s)) {
    warnings.push(`Routine ${name} has no schedule; it was left out.`);
    return '';
  }
  const days = (v: unknown) => {
    const list = Array.isArray(v) ? [...new Set(v.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [];
    if (!list.length || list.length === 7) return '';
    return list.join() === '1,2,3,4,5' ? ' mon-fri' : list.join() === '0,6' ? ' sat,sun' : ' ' + list.map((d) => DAYS[d]).join(',');
  };
  if (s.type === 'daily') return `daily ${text(s.time) || '09:00'}${days(s.weekdays)}`;
  if (s.type === 'interval') {
    const m = Math.max(5, Number(s.everyMinutes) || 60);
    const win = isObj(s.window) ? ` ${text(s.window.start)}-${text(s.window.end)}` : '';
    const until = Number(s.endsAt) > 0 ? ` until ${new Date(Number(s.endsAt)).toISOString().slice(0, 10)}` : '';
    return `every ${m % 60 === 0 ? `${m / 60}h` : `${m}m`}${days(s.weekdays)}${win}${until}`;
  }
  if (s.type === 'cron') {
    const tz = text(s.timeZone);
    if (tz) warnings.push(`${name}: its cron times were in ${tz}; AntiGem reads them in this computer's time.`);
    return `cron ${text(s.expression)}`;
  }
  if (s.type === 'once' && Number.isFinite(Number(s.at))) return `once ${new Date(Number(s.at)).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  warnings.push(`Routine ${name} has a schedule AntiGem does not know ("${text(s.type)}"); it was left out.`);
  return '';
}

/** seed.memory {"MEMORY.md": "- a\n- b", "memory/pricing.md": "..."} → notes: MEMORY.md's lines, one note per topic file. */
function seedNotes(seed: unknown): string[] {
  const files = isObj(seed) && isObj(seed.memory) ? seed.memory : {};
  const notes: string[] = [];
  for (const [path, body] of Object.entries(files)) {
    if (typeof body !== 'string') continue;
    if (path === 'MEMORY.md') {
      notes.push(...body.split('\n').map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim()).filter((l) => l && !l.startsWith('#')));
      continue;
    }
    const flat = body.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim();
    if (flat) notes.push(`${path.replace(/^memory\//, '').replace(/\.md$/, '')}: ${flat}`);
  }
  return notes;
}

/** OpenMausBot bots are mice with a color; ours have an emoji: picked from the role's words, else a mouse. */
const EMOJI: [RegExp, string][] = [
  [/research|scout|analy|investigat|find/, '🔎'],
  [/writ|copy|author|draft|outreach|content/, '✍️'],
  [/edit|review|critic|proof/, '📝'],
  [/chief|lead|manag|coordinat|director|head/, '🧭'],
  [/sales|deal|prospect/, '💼'],
  [/support|help|customer|success/, '💬'],
  [/code|develop|engineer|program|build/, '💻'],
  [/test|qa\b|quality/, '🧪'],
  [/design|visual|brand/, '🎨'],
  [/data|metric|report|insight/, '📊'],
  [/plan|strateg|product|roadmap/, '🗺️'],
  [/ops\b|devops|infra|deploy|release/, '⚙️'],
  [/secur|guard|audit|complian/, '🛡️'],
  [/market|social|growth|seo|campaign/, '📣'],
  [/financ|budget|account|invoice/, '💰'],
  [/legal|law|contract/, '⚖️'],
  [/teach|tutor|coach|mentor/, '🎓'],
  [/news|signal|monitor|watch/, '📡'],
];

/** The title's words first, then the name's. */
function emojiFor(...texts: string[]): string {
  for (const t of texts) {
    const hit = EMOJI.find(([re]) => re.test(t.toLowerCase()));
    if (hit) return hit[1];
  }
  return '🐭';
}
