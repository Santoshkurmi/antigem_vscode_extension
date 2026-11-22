// The AntiGem Crew package (docs/crew/PLAN.md §14): ONE Markdown file. Its YAML frontmatter (`antigem-crew: 1`) holds
// the crew: bots (with their souls), rooms, the Chief, playbooks, automations and the MCP servers it needs (a reason
// each, never secrets); the body is a prose playbook any agent can follow. Engine, model and access are suggestions.
// Never in a package: chats, the user's memory, approval grants, secrets (plan.ts redacts and counts them).
// parsePackage is lenient: it keeps what it can, clips what is too long and says so in warnings.
import type { AgentKind } from '../../../../shared/model';
import type { CrewAccess, RoomMode } from '../types';
import { parseYaml, stringifyYaml, YamlError } from './yaml';

export const CREW_PACKAGE_VERSION = 1;

export const PACKAGE_LIMITS = {
  bytes: 4 * 1024 * 1024, soulBytes: 24 * 1024, seedBytes: 24 * 1024, seedNotes: 200,
  bots: 40, rooms: 20, playbooks: 80, automations: 50, mcp: 20, outcomes: 12, aliases: 20,
  name: 100, tagline: 200, title: 200, description: 4000, bulletin: 12000, playbookText: 24000, instructions: 20000,
};

/** An MCP server the crew needs. It arrives off; secrets (tokens, env values, headers) never travel. */
export interface McpRequirement {
  name: string;
  reason: string;
  url?: string;
  command?: string;
}

export interface CrewPackageBot {
  /** As written in the package; references (rooms, automations, chief) use it. Import makes it one word. */
  name: string;
  title: string;
  description: string;
  /** Standing instructions (SOUL.md), ≤ 24 KB. */
  soul: string;
  emoji: string;
  color: string;
  /** Suggestions only. */
  engine?: AgentKind;
  model?: string;
  access?: CrewAccess;
  aliases?: string[];
  chief?: boolean;
  /** Starter notes for its MEMORY.md. */
  seedMemory?: string[];
}

export interface CrewPackageRoom {
  name: string;
  /** Bot names. */
  members: string[];
  lead?: string;
  bulletin: string;
  mode?: RoomMode;
}

export interface CrewPlaybook {
  name: string;
  text: string;
}

/** Always arrives paused. `when`: a sentence or a schedule ("daily 09:00 mon-fri", "every 30m", "cron 0 9 * * 1"). */
export interface CrewAutomation {
  name: string;
  bot: string;
  when: string;
  instructions: string;
  room?: string;
}

export interface CrewPackage {
  name: string;
  tagline: string;
  outcomes: string[];
  requirements: { mcp: McpRequirement[] };
  bots: CrewPackageBot[];
  rooms: CrewPackageRoom[];
  /** A bot name. */
  chief?: string;
  playbooks: CrewPlaybook[];
  automations: CrewAutomation[];
  /** The prose playbook (Markdown after the frontmatter). */
  body: string;
}

export class PackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageError';
  }
}

const ENGINE_NAMES: Record<string, AgentKind> = { claude: 'CLAUDE', 'claude-code': 'CLAUDE', codex: 'CODEX', opencode: 'OPENCODE', agy: 'AGY', antigravity: 'AGY' };
const ACCESS: CrewAccess[] = ['talk', 'read', 'edit', 'auto', 'full'];
const MODES: RoomMode[] = ['mentions', 'lead', 'everyone', 'auto', 'moderator'];
const PALETTE = ['#8B5CF6', '#EF4444', '#10B981', '#F59E0B', '#3B82F6', '#EC4899', '#14B8A6', '#F97316', '#6366F1', '#84CC16'];
/** OpenMausBot's color names (src/lib/mascot.ts MAUS_COLORS), also accepted here. */
export const NAMED_COLORS: Record<string, string> = {
  green: '#009957', blue: '#377FE6', red: '#D94B52', orange: '#E78531', purple: '#8057C8', cyan: '#0EA5C6',
  pink: '#D84F8B', yellow: '#D8A729', teal: '#01A492', coral: '#E5634E', silver: '#A8ADB4', chrome: '#B3BAC4',
};
const SECRET_FIELDS = /^(env|headers?|token|api[_-]?key|apikey|password|secret|auth|authorization|credentials?|bearer)$/i;
const BOM = String.fromCharCode(0xfeff);

// ------------------------------------------------------------------------------------------------ parse

/** Reads an AntiGem Crew package. Throws PackageError when it is not one; everything else becomes a warning. */
export function parsePackage(text: string): { pkg: CrewPackage; warnings: string[] } {
  if (typeof text !== 'string') throw new PackageError('A crew package is a Markdown text.');
  if (Buffer.byteLength(text, 'utf8') > PACKAGE_LIMITS.bytes) throw new PackageError('This package is larger than 4 MB.');
  const fm = splitFrontmatter(text);
  if (!fm) throw new PackageError('This is not an AntiGem crew package: it has no YAML frontmatter (a --- block at the top).');
  const raw = readFrontmatter(fm);
  const version = raw['antigem-crew'];
  if (version === undefined) throw new PackageError('This Markdown is not an AntiGem crew package ("antigem-crew: 1" is missing from its frontmatter).');
  if (Number(version) > CREW_PACKAGE_VERSION) throw new PackageError('This package was made by a newer AntiGem. Update the extension, then import it again.');
  if (Number(version) !== CREW_PACKAGE_VERSION) throw new PackageError(`Unknown crew package version: ${String(version)}.`);
  const warnings: string[] = [];
  return { pkg: normalizePackage(raw, fm.body, warnings), warnings };
}

/** The frontmatter between the first two --- lines, the body after it (blank lines at its top dropped). */
export function splitFrontmatter(text: string): { yaml: string; body: string; line: number } | null {
  const lines = (text.startsWith(BOM) ? text.slice(1) : text).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (!/^---\s*$/.test(lines[i] ?? '')) return null;
  for (let j = i + 1; j < lines.length; j++) {
    if (!/^(---|\.\.\.)\s*$/.test(lines[j])) continue;
    let k = j + 1;
    while (k < lines.length && lines[k].trim() === '') k++;
    return { yaml: lines.slice(i + 1, j).join('\n'), body: lines.slice(k).join('\n'), line: i + 2 };
  }
  return null;
}

/** The frontmatter as an object; YAML errors name the file's line. */
export function readFrontmatter(fm: { yaml: string; line: number }): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = parseYaml(fm.yaml);
  } catch (e) {
    if (e instanceof YamlError) throw new PackageError(`The frontmatter is not valid YAML: ${e.reason} (line ${e.line + fm.line - 1}).`);
    throw e;
  }
  if (!isObj(raw)) throw new PackageError('The frontmatter is not a list of "key: value" fields.');
  return raw;
}

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const asText = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

/** A name: case-insensitively new among `taken` (then added), else "Name 2", "Name 3"… */
export function uniqueName(base: string, taken: Set<string>, sep = ' ', max = 100): string {
  let name = base;
  for (let k = 2; taken.has(name.toLowerCase()); k++) name = base.slice(0, max - sep.length - String(k).length) + sep + k;
  taken.add(name.toLowerCase());
  return name;
}

/** Text cut to a UTF-8 byte size, never inside a character. */
export function clipBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  return Buffer.from(s, 'utf8').subarray(0, max).toString('utf8').replace(/\uFFFD+$/, '');
}

/**
 * A raw package object (the frontmatter, or one built by openmaus.ts / plan.ts) → a checked CrewPackage. Unknown bots
 * in rooms / automations / chief are dropped, names made unique, colors filled in, limits applied; each change → a warning.
 */
export function normalizePackage(raw: Record<string, unknown>, body: string, warnings: string[]): CrewPackage {
  const warn = (s: string) => warnings.push(s);
  const line = (v: unknown, max: number, what: string) => {
    const s = asText(v).replace(/\s+/g, ' ').trim();
    if (s.length > max) warn(`${what} was cut to ${max} characters.`);
    return s.slice(0, max);
  };
  const text = (v: unknown, max: number, what: string) => {
    const s = asText(v).trim();
    if (s.length > max) warn(`${what} was cut to ${max} characters.`);
    return s.slice(0, max);
  };
  const capped = <T>(items: T[], max: number, what: string) => {
    if (items.length > max) warn(`Only the first ${max} of ${items.length} ${what} were kept.`);
    return items.slice(0, max);
  };
  const known = new Set(['antigem-crew', 'name', 'tagline', 'outcomes', 'requirements', 'chief', 'bots', 'rooms', 'playbooks', 'automations']);
  for (const k of Object.keys(raw)) if (!known.has(k)) warn(`Ignored the field "${k}".`);

  // bots
  const names = new Set<string>();
  const byLower = new Map<string, string>();
  const marked: string[] = [];
  const bots: CrewPackageBot[] = [];
  capped(asList(raw.bots), PACKAGE_LIMITS.bots, 'bots').forEach((b, i) => {
    const src: Record<string, unknown> | null = isObj(b) ? b : typeof b === 'string' ? { name: b } : null;
    const given = src ? line(src.name, PACKAGE_LIMITS.name, `Bot ${i + 1}'s name`) : '';
    if (!src || !given) return warn(`Bot ${i + 1} has no name; it was left out.`);
    const name = uniqueName(given, names);
    if (name !== given) warn(`Two bots are called ${given}; the second is now ${name}.`);
    byLower.set(name.toLowerCase(), name);
    if (src.chief === true) marked.push(name);
    bots.push(bot(src, name, i));
  });
  if (!bots.length) throw new PackageError('This package has no bots.');
  const botName = (v: unknown) => byLower.get(asText(v).trim().replace(/^@/, '').toLowerCase());

  function bot(b: Record<string, unknown>, name: string, i: number): CrewPackageBot {
    const soul = asText(b.soul ?? b.persona).trim();
    if (Buffer.byteLength(soul, 'utf8') > PACKAGE_LIMITS.soulBytes) warn(`${name}'s soul was cut to 24 KB.`);
    const color = asText(b.color).trim().toLowerCase();
    const hex = /^#[0-9a-f]{6}$/.test(color) ? color.toUpperCase() : /^#[0-9a-f]{3}$/.test(color) ? '#' + [...color.slice(1)].map((c) => c + c).join('').toUpperCase() : NAMED_COLORS[color];
    if (color && !hex) warn(`${name}'s color "${color}" is not a #RRGGBB color; it got another.`);
    const out: CrewPackageBot = {
      name,
      title: line(b.title, PACKAGE_LIMITS.title, `${name}'s title`),
      description: text(b.description, PACKAGE_LIMITS.description, `${name}'s description`),
      soul: clipBytes(soul, PACKAGE_LIMITS.soulBytes),
      emoji: [...asText(b.emoji).trim()].slice(0, 8).join('') || '🤖',
      color: hex ?? PALETTE[i % PALETTE.length],
    };
    const engine = asText(b.engine).trim().toLowerCase();
    if (ENGINE_NAMES[engine]) out.engine = ENGINE_NAMES[engine];
    else if (engine) warn(`${name}'s engine "${engine}" is unknown; the default engine will be used.`);
    const model = line(b.model, 200, `${name}'s model`);
    if (model) out.model = model;
    const access = asText(b.access).trim().toLowerCase();
    if (ACCESS.includes(access as CrewAccess)) out.access = access as CrewAccess;
    else if (access) warn(`${name}'s access "${access}" is unknown; it was left out.`);
    const aliases = [...new Set(asList(b.aliases).map((a) => asText(a).trim().toLowerCase()).filter(Boolean))];
    if (aliases.length) out.aliases = capped(aliases, PACKAGE_LIMITS.aliases, `${name}'s aliases`);
    const seed = seedNotes(asList(b.seedMemory ?? b.memory), name);
    if (seed.length) out.seedMemory = seed;
    const knownBot = new Set(['name', 'title', 'description', 'soul', 'persona', 'emoji', 'color', 'engine', 'model', 'access', 'aliases', 'chief', 'seedMemory', 'memory']);
    const extra = Object.keys(b).filter((k) => !knownBot.has(k));
    if (extra.length) warn(`Ignored ${name}'s field${extra.length > 1 ? 's' : ''} ${extra.map((k) => `"${k}"`).join(', ')}.`);
    return out;
  }

  function seedNotes(items: unknown[], name: string): string[] {
    const out: string[] = [];
    let bytes = 0;
    for (const item of items) {
      const note = asText(item).trim();
      if (!note) continue;
      bytes += Buffer.byteLength(note, 'utf8') + 1;
      if (out.length >= PACKAGE_LIMITS.seedNotes || bytes > PACKAGE_LIMITS.seedBytes) {
        warn(`${name}'s starter memory was cut to ${out.length} notes (24 KB at most).`);
        break;
      }
      out.push(note);
    }
    return out;
  }

  // the Chief: the top-level field, else the first bot marked chief (only the Chief's bot carries chief: true)
  const chief = raw.chief !== undefined && raw.chief !== null ? botName(raw.chief) : marked[0];
  if (raw.chief && !chief) warn(`The Chief "${asText(raw.chief)}" is not one of the bots.`);
  if (!raw.chief && marked.length > 1) warn(`Several bots are marked chief; ${marked[0]} is the Chief.`);
  for (const b of bots) if (b.name === chief) b.chief = true;

  // rooms
  const roomNames = new Map<string, string>();
  const rooms: CrewPackageRoom[] = [];
  capped(asList(raw.rooms), PACKAGE_LIMITS.rooms, 'rooms').forEach((r, i) => {
    if (!isObj(r)) return warn(`Room ${i + 1} is not a "key: value" map; it was left out.`);
    const name = line(r.name, PACKAGE_LIMITS.name, `Room ${i + 1}'s name`) || `Room ${i + 1}`;
    const members: string[] = [];
    for (const m of asList(r.members)) {
      const b = botName(m);
      if (!b) warn(`Room ${name}: "${asText(m)}" is not one of the bots.`);
      else if (!members.includes(b)) members.push(b);
    }
    if (!members.length) return warn(`Room ${name} has no members; it was left out.`);
    const room: CrewPackageRoom = { name, members, bulletin: text(r.bulletin, PACKAGE_LIMITS.bulletin, `Room ${name}'s bulletin`) };
    const lead = r.lead === undefined || r.lead === null ? undefined : botName(r.lead);
    if (lead && members.includes(lead)) room.lead = lead;
    else if (r.lead) warn(`Room ${name}: the lead "${asText(r.lead)}" is not a member.`);
    const mode = asText(r.mode).trim().toLowerCase();
    if (MODES.includes(mode as RoomMode)) room.mode = mode as RoomMode;
    else if (mode) warn(`Room ${name}: the mode "${mode}" is unknown; the default is used.`);
    if (!roomNames.has(name.toLowerCase())) roomNames.set(name.toLowerCase(), name);
    rooms.push(room);
  });

  const playbooks: CrewPlaybook[] = [];
  capped(asList(raw.playbooks), PACKAGE_LIMITS.playbooks, 'playbooks').forEach((p, i) => {
    const src: Record<string, unknown> = isObj(p) ? p : { text: p };
    const body = text(src.text ?? src.instructions, PACKAGE_LIMITS.playbookText, `Playbook ${i + 1}`);
    if (!body) return warn(`Playbook ${i + 1} has no text; it was left out.`);
    playbooks.push({ name: line(src.name, PACKAGE_LIMITS.name, `Playbook ${i + 1}'s name`) || `Playbook ${i + 1}`, text: body });
  });

  const automations: CrewAutomation[] = [];
  capped(asList(raw.automations), PACKAGE_LIMITS.automations, 'automations').forEach((a, i) => {
    if (!isObj(a)) return warn(`Automation ${i + 1} is not a "key: value" map; it was left out.`);
    const name = line(a.name, 80, `Automation ${i + 1}'s name`) || `Automation ${i + 1}`;
    const owner = botName(a.bot);
    const when = line(a.when ?? a.schedule, 200, `${name}'s schedule`);
    const instructions = text(a.instructions ?? a.prompt, PACKAGE_LIMITS.instructions, `${name}'s instructions`);
    if (!owner) return warn(`Automation ${name}: "${asText(a.bot)}" is not one of the bots; it was left out.`);
    if (!when || !instructions) return warn(`Automation ${name} needs both "when" and "instructions"; it was left out.`);
    const auto: CrewAutomation = { name, bot: owner, when, instructions };
    const room = a.room ? roomNames.get(asText(a.room).trim().toLowerCase()) : undefined;
    if (room) auto.room = room;
    else if (a.room) warn(`Automation ${name}: the room "${asText(a.room)}" is not in the package; it posts to ${owner}'s chat.`);
    automations.push(auto);
  });

  const nameGiven = line(raw.name, PACKAGE_LIMITS.name, 'The package name');
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim().slice(0, PACKAGE_LIMITS.name);
  if (!nameGiven) warn('The package has no name.');
  const pkg: CrewPackage = {
    name: nameGiven || heading || 'Crew',
    tagline: line(raw.tagline, PACKAGE_LIMITS.tagline, 'The tagline'),
    outcomes: capped(asList(raw.outcomes).map((o, i) => line(o, 240, `Outcome ${i + 1}`)).filter(Boolean), PACKAGE_LIMITS.outcomes, 'outcomes'),
    requirements: { mcp: requirements(raw.requirements, warn) },
    bots,
    rooms,
    playbooks,
    automations,
    body,
  };
  if (chief) pkg.chief = chief;
  return pkg;
}

/** requirements: {mcp: [...]} (or a bare list): name + reason, and a url or a command; secret-bearing fields dropped. */
function requirements(raw: unknown, warn: (s: string) => void): McpRequirement[] {
  if (isObj(raw)) for (const k of Object.keys(raw)) if (k !== 'mcp') warn(`Ignored the requirement field "${k}".`);
  const items = Array.isArray(raw) ? raw : isObj(raw) ? asList(raw.mcp) : [];
  const out: McpRequirement[] = [];
  const seen = new Set<string>();
  for (const m of items.slice(0, PACKAGE_LIMITS.mcp)) {
    const src: Record<string, unknown> = isObj(m) ? m : { name: m };
    const name = asText(src.name ?? src.key ?? src.id).trim().slice(0, 64);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const req: McpRequirement = { name, reason: asText(src.reason ?? src.why ?? src.description).replace(/\s+/g, ' ').trim().slice(0, 240) };
    const dropped = Object.keys(src).filter((k) => SECRET_FIELDS.test(k));
    if (dropped.length) warn(`MCP server ${name}: dropped ${dropped.join(', ')} (secrets never travel in a package).`);
    const url = cleanUrl(asText(src.url).trim(), name, warn);
    // a command line as written, or a list of words (+ args) quoted where they hold spaces
    const quote = (a: string) => (/[\s"']/.test(a) ? JSON.stringify(a) : a);
    const words = [...(Array.isArray(src.command) ? src.command : []), ...asList(src.args)].map(asText).filter(Boolean).map(quote);
    const command = [Array.isArray(src.command) ? '' : asText(src.command).trim(), ...words].filter(Boolean).join(' ');
    if (url) req.url = url;
    if (command && !url) req.command = command;
    else if (command) warn(`MCP server ${name} has both a url and a command; the url is kept.`);
    out.push(req);
  }
  if (items.length > PACKAGE_LIMITS.mcp) warn(`Only the first ${PACKAGE_LIMITS.mcp} MCP servers were kept.`);
  return out;
}

/** An http(s) address without a user name, password or secret-looking query values; '' if it is not one. */
function cleanUrl(raw: string, name: string, warn: (s: string) => void): string {
  if (!raw) return '';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    warn(`MCP server ${name}: "${raw.slice(0, 80)}" is not an address; it was left out.`);
    return '';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    warn(`MCP server ${name}: only http(s) addresses are kept.`);
    return '';
  }
  let changed = false;
  if (u.username || u.password) {
    u.username = '';
    u.password = '';
    changed = true;
  }
  for (const k of [...u.searchParams.keys()]) {
    if (/token|key|secret|password|passwd|auth|sig|credential/i.test(k)) {
      u.searchParams.delete(k);
      changed = true;
    }
  }
  if (changed) warn(`MCP server ${name}: credentials were taken out of its address.`);
  return changed ? u.toString() : raw;
}

// ------------------------------------------------------------------------------------------------ write

/** The package as Markdown: frontmatter (empty fields left out) + the body as it is. parsePackage reads it back. */
export function serializePackage(pkg: CrewPackage): string {
  const some = <T>(list: T[] | undefined) => (list && list.length ? list : undefined);
  const fm = {
    'antigem-crew': CREW_PACKAGE_VERSION,
    name: pkg.name,
    tagline: pkg.tagline || undefined,
    outcomes: some(pkg.outcomes),
    requirements: pkg.requirements.mcp.length
      ? { mcp: pkg.requirements.mcp.map((r) => ({ name: r.name, reason: r.reason || undefined, url: r.url || undefined, command: r.command || undefined })) }
      : undefined,
    chief: pkg.chief,
    bots: pkg.bots.map((b) => ({
      name: b.name,
      title: b.title || undefined,
      description: b.description || undefined,
      emoji: b.emoji,
      color: b.color,
      engine: b.engine?.toLowerCase(),
      model: b.model,
      access: b.access,
      aliases: some(b.aliases),
      chief: b.chief || undefined,
      seedMemory: some(b.seedMemory),
      soul: b.soul || undefined,
    })),
    rooms: some(pkg.rooms.map((r) => ({ name: r.name, members: r.members, lead: r.lead, mode: r.mode, bulletin: r.bulletin || undefined }))),
    playbooks: some(pkg.playbooks),
    automations: some(pkg.automations.map((a) => ({ name: a.name, bot: a.bot, when: a.when, room: a.room, instructions: a.instructions }))),
  };
  return `---\n${stringifyYaml(fm)}---\n${pkg.body ? `\n${pkg.body}` : ''}`;
}
