// Import review and export for Crew packages (docs/crew/PLAN.md §14). planImport turns a parsed package into what the
// review screen shows and what Add creates: one-word bot names that are free (Ada, Ada2…), access capped at Edit, MCP
// servers that arrive off, automations that arrive paused, secrets redacted and counted. exportCrew builds a package
// from live bots and rooms: never chats, the user's memory, approvals or secrets; engine, model and access only as
// suggestions. redactSecrets is the one scrubber both use.
import type { AgentKind } from '../../../../shared/model';
import type { BotProfile, CrewAccess, RoomMode, RoomRecord } from '../types';
import { clipBytes, normalizePackage, PACKAGE_LIMITS, type CrewPackage, type CrewPlaybook, type McpRequirement } from './format';
import { describeCrew } from './prose';

// ------------------------------------------------------------------------------------------------ secrets

const MARK = '[redacted]';
/** Shapes that are unmistakably credentials (a provider's key prefix). */
const KEY_SHAPES: RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // anthropic / openai
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // stripe
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // github
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // gitlab
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // slack
  /\bxapp-\d-[A-Za-z0-9-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // aws
  /\bAIza[0-9A-Za-z_-]{30,}/g, // google
  /\bhf_[A-Za-z0-9]{30,}/g, // hugging face
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bxai-[A-Za-z0-9_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{40,}/g, // groq
  /\bwhsec_[A-Za-z0-9_-]{20,}/g, // webhook secrets
  /\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g, // JWT
];
const SECRET_WORD = '(?:api[_-]?keys?|apikeys?|client[_-]?secrets?|secrets?|access[_-]?tokens?|auth[_-]?tokens?|tokens?|passwords?|passwd|pwd|access[_-]?keys?|private[_-]?keys?)';
/** password=…, "api_key": "…", TOKEN: … (the name is kept, the value goes). */
const ASSIGNED = new RegExp(`(?<![A-Za-z0-9])(${SECRET_WORD})(["']?\\s*[=:]\\s*)(["']?)([^\\s"'\`,;<>\\[\\]]{8,})`, 'gi');
/** "my token is 9f8e…", "api key: AbC123…": a long letters-and-digits run right after a secret word. */
const AFTER_WORD = new RegExp(`(?<![A-Za-z0-9])(${SECRET_WORD.replace('(?:', '(?:keys?|')})(\\s*[:=]\\s*|\\s+(?:is\\s+)?)(["'\`]?)([A-Za-z0-9._~+/=-]{20,})`, 'gi');
const FLAG = /(--(?:token|password|passwd|api-key|apikey|secret|access-key|auth-token)(?:=|\s+))(["']?)([^\s"'[$-][^\s"']*)/gi;
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/g;
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/g;

/** Text with API keys, tokens, passwords and private key blocks replaced by [redacted]; count = how many. Idempotent. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  const hit = (s: string) => {
    count++;
    return s;
  };
  let out = '';
  let last = 0;
  for (PEM_BEGIN.lastIndex = 0; ; ) {
    const begin = PEM_BEGIN.exec(text);
    if (!begin) break;
    PEM_END.lastIndex = PEM_BEGIN.lastIndex;
    const end = PEM_END.exec(text);
    if (!end) break;
    out += `${text.slice(last, begin.index)}[redacted private key]`;
    last = PEM_BEGIN.lastIndex = PEM_END.lastIndex;
    count++;
  }
  let s = out + text.slice(last);
  const value = (v: string) => v.replace(/[.,;:!?)]+$/, '');
  s = s.replace(BEARER, (_m, head: string) => hit(head + MARK));
  for (const re of KEY_SHAPES) s = s.replace(re, () => hit(MARK));
  s = s.replace(ASSIGNED, (m, name: string, sep: string, q: string, raw: string) => {
    const v = value(raw);
    // a word with no digit or symbol ("password: required") is prose, and $TOKEN / {key} / %KEY% are placeholders
    if (v.length < 8 || (!/[^A-Za-z]/.test(v) && v.length < 20) || /^[$%{]/.test(v)) return m;
    return hit(name + sep + q + MARK + raw.slice(v.length));
  });
  s = s.replace(AFTER_WORD, (m, name: string, sep: string, q: string, raw: string) => {
    const v = value(raw);
    if (v.length < 20 || !/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return m;
    return hit(name + sep + q + MARK + raw.slice(v.length));
  });
  s = s.replace(FLAG, (_m, head: string, q: string) => hit(head + q + MARK));
  return { text: s, count };
}

// ------------------------------------------------------------------------------------------------ import

const ACCESS: CrewAccess[] = ['talk', 'read', 'edit', 'auto', 'full'];
const IMPORT_CAP: CrewAccess = 'edit';
const RESERVED = /^(all|everyone|here|you|user)$/i;

export interface PlannedBot {
  /** The name it gets here: one word, free in the crew. */
  name: string;
  /** Its name in the package. */
  from: string;
  title: string;
  description: string;
  soul: string;
  emoji: string;
  color: string;
  /** Suggestions (null = the crew's default). */
  engine: AgentKind | null;
  model: string | null;
  /** At most Edit. */
  access: CrewAccess;
  aliases: string[];
  chief: boolean;
  seedMemory: string[];
}

export interface ImportPlan {
  name: string;
  tagline: string;
  outcomes: string[];
  bots: PlannedBot[];
  /** Members and lead use the planned bot names. */
  rooms: { name: string; members: string[]; lead: string | null; bulletin: string; mode: RoomMode | null }[];
  chief: string | null;
  mcp: { name: string; reason: string; url: string | null; command: string | null; state: 'off' }[];
  automations: { name: string; bot: string; when: string; instructions: string; room: string | null; state: 'paused' }[];
  playbooks: CrewPlaybook[];
  body: string;
  counts: { bots: number; rooms: number; mcp: number; automations: number; playbooks: number };
  /** Secrets taken out of souls, memory, playbooks, bulletins, instructions, addresses and the body. */
  redacted: number;
  /** What was not brought over, and why. */
  leftOut: string[];
  warnings: string[];
}

/** A one-word @-mentionable name (letters, digits, _ and -; ≤ 24), not reserved and not taken (Ada, Ada2, Ada3…). */
function freeName(raw: string, taken: Set<string>): string {
  const base = raw.replace(/[^\p{L}\p{N}_-]+/gu, '').slice(0, 24) || 'Bot';
  let name = base;
  for (let k = 2; taken.has(name.toLowerCase()) || RESERVED.test(name); k++) name = base.slice(0, 24 - String(k).length) + k;
  taken.add(name.toLowerCase());
  return name;
}

/** What importing `pkg` into a crew that has `existing.botNames` would create (nothing is written). */
export function planImport(pkg: CrewPackage, existing: { botNames: string[] }): ImportPlan {
  let redacted = 0;
  const clean = (s: string) => {
    const r = redactSecrets(s);
    redacted += r.count;
    return r.text;
  };
  const leftOut: string[] = [];
  const warnings: string[] = [];
  const taken = new Set(existing.botNames.map((n) => n.toLowerCase()));
  const nameOf = new Map<string, string>();

  const bots = pkg.bots.map((b): PlannedBot => {
    const name = freeName(b.name, taken);
    nameOf.set(b.name, name);
    if (name !== b.name) {
      const oneWord = b.name.replace(/[^\p{L}\p{N}_-]+/gu, '').slice(0, 24);
      const why = RESERVED.test(oneWord) ? 'reserved' : 'taken';
      warnings.push(oneWord !== b.name && name === oneWord ? `"${b.name}" is called ${name} here (one word, so it can be @mentioned).` : `"${b.name}" is called ${name} here: the name ${oneWord || b.name} is ${why}.`);
    }
    let access: CrewAccess = b.access ?? IMPORT_CAP;
    if (ACCESS.indexOf(access) > ACCESS.indexOf(IMPORT_CAP)) {
      leftOut.push(`${name}'s "${access}" access: imported bots start at Edit at most (raise it yourself after a look)`);
      access = IMPORT_CAP;
    }
    return {
      name,
      from: b.name,
      title: clean(b.title),
      description: clean(b.description),
      soul: clean(b.soul),
      emoji: b.emoji,
      color: b.color,
      engine: b.engine ?? null,
      model: b.model ?? null,
      access,
      aliases: b.aliases ?? [],
      chief: b.name === pkg.chief,
      seedMemory: (b.seedMemory ?? []).map(clean),
    };
  });
  const mapped = (n: string | undefined) => (n ? (nameOf.get(n) ?? null) : null);

  const rooms = pkg.rooms.map((r) => ({
    name: r.name,
    members: r.members.map((m) => nameOf.get(m)).filter((m): m is string => !!m),
    lead: mapped(r.lead),
    bulletin: clean(r.bulletin),
    mode: r.mode ?? null,
  }));
  const mcp = pkg.requirements.mcp.map((m) => ({
    name: m.name,
    reason: clean(m.reason),
    url: m.url ? clean(m.url) : null,
    command: m.command ? clean(m.command) : null,
    state: 'off' as const,
  }));
  const automations = pkg.automations
    .filter((a) => nameOf.has(a.bot))
    .map((a) => ({ name: a.name, bot: nameOf.get(a.bot)!, when: a.when, instructions: clean(a.instructions), room: a.room ?? null, state: 'paused' as const }));
  const playbooks = pkg.playbooks.map((p) => ({ name: p.name, text: clean(p.text) }));
  if (redacted) leftOut.push(`${redacted} secret${redacted > 1 ? 's' : ''} (keys, tokens or passwords in the text were replaced by [redacted])`);

  return {
    name: pkg.name,
    tagline: clean(pkg.tagline),
    outcomes: pkg.outcomes.map(clean),
    bots,
    rooms,
    chief: mapped(pkg.chief),
    mcp,
    automations,
    playbooks,
    body: clean(pkg.body),
    counts: { bots: bots.length, rooms: rooms.length, mcp: mcp.length, automations: automations.length, playbooks: playbooks.length },
    redacted,
    leftOut,
    warnings,
  };
}

// ------------------------------------------------------------------------------------------------ export

export interface ExportInput {
  name: string;
  tagline?: string;
  /** The prose playbook; written from the crew when left out. */
  body?: string;
  bots: { profile: BotProfile; soul: string; seedMemory?: string[] }[];
  rooms: RoomRecord[];
  chiefId?: string | null;
  automations?: { name: string; botName: string; when: string; instructions: string; room?: string }[];
  /** MCP servers the crew needs, as the user set them up (secrets in them are redacted). */
  mcp?: McpRequirement[];
  outcomes?: string[];
  playbooks?: CrewPlaybook[];
}

/** A package plus how many secrets were taken out on the way, and what was clipped or dropped. */
export interface ExportedCrew extends CrewPackage {
  redacted: number;
  warnings: string[];
}

/**
 * A package from live bots and rooms. Only names, looks, souls, starter notes, room setups, playbooks and automations
 * travel: no ids, folders, chats, transcripts, the user's memory, approvals or secrets. Room members outside the
 * export are dropped (and rooms left empty).
 */
export function exportCrew(input: ExportInput): ExportedCrew {
  let redacted = 0;
  const clean = (s: string) => {
    const r = redactSecrets(s);
    redacted += r.count;
    return r.text;
  };
  const nameById = new Map(input.bots.map((b) => [b.profile.id, b.profile.name]));
  const chief = (input.chiefId && nameById.get(input.chiefId)) || input.bots.find((b) => b.profile.chief)?.profile.name;
  const bots = input.bots.map(({ profile: p, soul, seedMemory }) => ({
    name: p.name,
    title: clean(p.title),
    description: clean(p.description),
    soul: clipBytes(clean(soul), PACKAGE_LIMITS.soulBytes),
    emoji: p.emoji,
    color: p.color,
    engine: p.engine,
    model: p.model ?? undefined,
    access: p.access,
    aliases: p.aliases,
    chief: p.name === chief || undefined,
    seedMemory: (seedMemory ?? []).map(clean),
  }));
  const rooms = input.rooms.flatMap((r) => {
    const members = r.members.map((id) => nameById.get(id)).filter((n): n is string => !!n);
    if (!members.length) return [];
    const lead = r.lead ? nameById.get(r.lead) : undefined;
    return [{ name: r.name, members, lead: lead && members.includes(lead) ? lead : undefined, bulletin: clean(r.bulletin), mode: r.mode }];
  });
  const botNames = new Set(bots.map((b) => b.name));
  const roomNames = new Set(rooms.map((r) => r.name));
  const automations = (input.automations ?? [])
    .filter((a) => botNames.has(a.botName))
    .map((a) => ({ name: a.name, bot: a.botName, when: a.when, instructions: clean(a.instructions), room: a.room && roomNames.has(a.room) ? a.room : undefined }));

  // MCP servers: the ones given, then any a bot is limited to that are not listed yet
  const mcp = (input.mcp ?? []).map((m) => ({ name: m.name, reason: clean(m.reason), url: m.url ? clean(m.url) : undefined, command: m.command ? clean(m.command) : undefined }));
  const users = new Map<string, string[]>();
  for (const { profile } of input.bots) for (const server of profile.tools.mcp ?? []) users.set(server, [...(users.get(server) ?? []), profile.name]);
  for (const [server, who] of users) if (!mcp.some((m) => m.name.toLowerCase() === server.toLowerCase())) mcp.push({ name: server, reason: `Used by ${who.join(', ')}`, url: undefined, command: undefined });

  const raw = {
    name: input.name,
    tagline: clean(input.tagline ?? ''),
    outcomes: (input.outcomes ?? []).map(clean),
    requirements: { mcp },
    chief,
    bots,
    rooms,
    playbooks: (input.playbooks ?? []).map((p) => ({ name: p.name, text: clean(p.text) })),
    automations,
  };
  const warnings: string[] = [];
  const pkg = normalizePackage(JSON.parse(JSON.stringify(raw)) as Record<string, unknown>, '', warnings);
  pkg.body = input.body !== undefined ? clean(input.body) : describeCrew(pkg);
  return { ...pkg, redacted, warnings };
}
