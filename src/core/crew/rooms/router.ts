// Who answers a room message (docs/crew/PLAN.md §7 "Who answers"), in order:
//   1. a reply to a bot's message → that bot;  2. @mentions (unique prefixes too; ambiguous ones refused) / @everyone /
//   @here;  3. the room mode: lead, everyone, mentions (nobody), moderator (a model picks), auto: a local heuristic
//   first (names, learned words, role, who edited the file named, follow-ups), the router model when it is unsure,
//   the lead when the router is slow or unsure;  4. chime-ins by chattiness (engine.ts).
// Auto routing learns: when the user re-asks another member right after an auto pick, words of the first message move
// to that member's aliases (shown and editable in its profile).
import { labeledBlock } from '../../text';
import type { Bot, Group, Msg } from './types';
import { transcript } from './prompts';

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------------------------------------------ mentions

export interface Mentions {
  ids: string[];
  /** @all / @everyone */
  all: boolean;
  /** @here: members not busy elsewhere */
  here: boolean;
  /** "@an" matching Ann and Andy: refused, the user is told. */
  ambiguous: { word: string; names: string[] }[];
}

/** The members a message @mentions (exact names, or a unique start of one). Code is ignored. */
export function mentions(text: string, bots: Bot[]): Mentions {
  const plain = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const out: Mentions = { ids: [], all: false, here: false, ambiguous: [] };
  for (const m of plain.matchAll(/(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_.-]+)/gu)) {
    const word = m[2].replace(/[.-]+$/, '');
    const w = word.toLowerCase();
    if (!w) continue;
    if (w === 'all' || w === 'everyone') {
      out.all = true;
      continue;
    }
    if (w === 'here') {
      out.here = true;
      continue;
    }
    const exact = bots.find((b) => b.name.toLowerCase() === w);
    if (exact) {
      if (!out.ids.includes(exact.id)) out.ids.push(exact.id);
      continue;
    }
    if (w.length < 2) continue;
    const starts = bots.filter((b) => b.name.toLowerCase().startsWith(w));
    if (starts.length === 1) {
      if (!out.ids.includes(starts[0].id)) out.ids.push(starts[0].id);
    } else if (starts.length > 1) out.ambiguous.push({ word, names: starts.map((b) => b.name) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ heuristic

const STOP = new Set(
  (
    'a an the and or but if then so to of in on at by for with from up out as is are was were be been being am do does did done have has had ' +
    'i you he she it we they me him her us them my your his its our their this that these those there here what which who whom whose ' +
    'when where why how all any both each few more most other some such no nor not only own same than too very can will just should now ' +
    'could would may might must shall let lets get got make made go going want need like please thanks thank hi hello hey ok okay yes yeah ' +
    'about into over under again further once also still even really think know see look tell say said ask give take use using one two ' +
    'new good great well way thing things something anything everything someone anyone everyone team guys folks bot bots room chat message'
  ).split(' '),
);

/** Content words of a text (lowercase, ≥ 3 letters, no stop words); file names kept whole. */
export function keywords(text: string): string[] {
  const plain = text.replace(/```[\s\S]*?(```|$)/g, ' ').toLowerCase();
  const out = new Set<string>();
  for (const f of plain.matchAll(/[\w-]+\.[a-z0-9]{1,6}\b/g)) out.add(f[0]);
  for (const w of plain.split(/[^\p{L}\p{N}_+#-]+/u)) {
    const t = w.replace(/^[-_]+|[-_]+$/g, '');
    if (t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)) out.add(t);
  }
  return [...out];
}

/** A rough stem so "deploys" / "deploying" / "deployed" match "deploy". */
export function stem(w: string): string {
  if (w.length <= 4 || /\.[a-z0-9]{1,6}$/.test(w)) return w;
  for (const end of ['ing', 'ed', 'es', 's']) if (w.endsWith(end) && w.length - end.length >= 3) return w.slice(0, -end.length);
  return w;
}

export interface Score {
  bot: Bot;
  score: number;
  why: string[];
}

const hasWord = (hay: string, word: string) => new RegExp(`(^|[^\\p{L}\\p{N}_@])${escapeRe(word)}(?![\\p{L}\\p{N}_])`, 'iu').test(hay);

/** Each member's fit for a message nobody @mentioned (no AI): best first. */
export function scoreMembers(g: Group, text: string, members: Bot[], lastBotId: string | null): Score[] {
  const raw = keywords(text);
  const words = new Set(raw.map(stem));
  const lower = text.toLowerCase();
  const files = raw.filter((w) => /\.[a-z0-9]{1,6}$/.test(w));
  const recent = g.messages.slice(-60);
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const followUp = wordCount <= 3 || /^\s*(and|but|why|how|what about|so|ok|okay|then|also|really|wait)\b/i.test(text);
  return members
    .map((bot) => {
      let score = 0;
      const why: string[] = [];
      /** stems already counted (an alias that is also a role word counts once) */
      const got = new Set<string>();
      if (hasWord(text, bot.name)) {
        score += 6;
        why.push('named');
      }
      let a = 0;
      for (const alias of bot.aliases) {
        if (a >= 9) break;
        if (alias.includes(' ') ? lower.includes(alias) : words.has(stem(alias))) {
          a += 3;
          why.push(`"${alias}"`);
          got.add(stem(alias));
        }
      }
      score += a;
      let t = 0;
      for (const w of keywords(bot.title)) {
        if (t < 6 && words.has(stem(w)) && !got.has(stem(w))) {
          t += 2;
          why.push(w);
          got.add(stem(w));
        }
      }
      score += t;
      let d = 0;
      for (const w of keywords(`${bot.description}\n${bot.persona.slice(0, 400)}`)) {
        if (d < 4.5 && words.has(stem(w)) && !got.has(stem(w))) {
          d += 1.5;
          why.push(w);
          got.add(stem(w));
        }
      }
      score += d;
      if (files.length) {
        const edited = recent.filter((m) => m.from === bot.id).flatMap((m) => m.evidence?.filesChanged ?? []);
        const hit = files.find((f) => edited.some((p) => p.toLowerCase().endsWith(f)));
        if (hit) {
          score += 3;
          why.push(`edited ${hit}`);
        }
      }
      if (followUp && bot.id === lastBotId && score < 3) {
        score += 2;
        why.push('follow-up');
      }
      return { bot, score, why };
    })
    .sort((x, y) => y.score - x.score);
}

/** The heuristic's pick when it is sure (clearly ahead), else null (ask the router). */
export function confidentPick(scores: Score[]): Score | null {
  const [top, second] = scores;
  if (!top || top.score < 3) return null;
  if (second && second.score * 2 > top.score) return null;
  return top;
}

export function whyText(s: Score): string {
  const w = s.why.filter((x) => x !== 'named');
  if (s.why.includes('named')) return 'named';
  if (w.includes('follow-up') && w.length === 1) return 'follow-up';
  return w.slice(0, 3).join(', ');
}

// ------------------------------------------------------------------------------------------------ router model

const firstLine = (s: string, n = 120) => {
  const l = s.trim().split('\n')[0] ?? '';
  return l.length > n ? `${l.slice(0, n - 1)}…` : l;
};

function roster(g: Group): string {
  return g.bots
    .filter((b) => !b.muted)
    .map((b) => {
      const about = [b.title, b.description || firstLine(b.persona)].filter(Boolean).join(': ');
      return `- ${b.name}${about ? ` — ${about}` : ''}${b.aliases.length ? ` (topics: ${b.aliases.slice(0, 8).join(', ')})` : ''}${b.id === g.lead ? ' [lead]' : ''}`;
    })
    .join('\n');
}

/** The router's first message: its job, the members, the last few lines, the message to route. */
export function routerIntro(g: Group, msg: Msg): string {
  const rules = [
    `You route messages in a team chat ("${g.title}"). You never answer messages yourself: for each new message from ${g.userName} you say which member should answer it.`,
    g.topic.trim() ? `The room is for: ${g.topic.trim()}` : '',
    '',
    'Members:',
    roster(g),
    '',
    'Reply with ONE line: the member name (or two names, comma-separated, when both are needed), or "everyone" when the message is for all, or "lead" when no one fits better than the lead; then " — " and the reason in at most 10 words. Example: "Tess — asks about failing tests". Do not use tools.',
  ]
    .filter((l, i, a) => l || a[i - 1])
    .join('\n');
  const before = transcript(g, Math.max(0, g.messages.indexOf(msg) - 12), g.messages.indexOf(msg), null);
  return `${labeledBlock(`🧭 ${g.title}: router`, rules)}\n\n${before ? `Recent lines:\n${before}\n\n` : ''}New message:\n[${g.userName}]: ${msg.text}\n\n(Who answers? One line.)`;
}

/** Later: the lines since it last looked (at most 12) and the message to route. */
export function routerTurn(g: Group, msg: Msg): string {
  const at = g.messages.indexOf(msg);
  const before = transcript(g, Math.max(g.moderatorSeen, at - 12), at, null);
  return `${before ? `${before}\n\n` : ''}New message:\n[${g.userName}]: ${msg.text}\n\n(Who answers? Members: ${g.bots
    .filter((b) => !b.muted)
    .map((b) => b.name)
    .join(', ')}. One line: name(s), everyone or lead — reason.)`;
}

export interface RouterPick {
  bots: Bot[];
  everyone: boolean;
  /** Unsure: the lead answers. */
  lead: boolean;
  why: string;
}

/** The router's line → members (at most 2, in its order). Anything unreadable = lead. */
export function parseRouter(text: string, g: Group): RouterPick {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? '';
  const [head, ...rest] = line.split(/\s+[—–-]\s+|:\s+/);
  const why = rest.join(' — ').trim().slice(0, 120);
  const h = (head ?? '').replace(/[*_`"]/g, '').trim();
  if (/^\W*(everyone|all|everybody)\b/i.test(h)) return { bots: [], everyone: true, lead: false, why };
  const found = g.bots
    .filter((b) => !b.muted)
    .map((b) => ({ b, at: h.toLowerCase().search(new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(b.name.toLowerCase())}(?![\\p{L}\\p{N}_])`, 'u')) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .slice(0, 2)
    .map((x) => x.b);
  if (!found.length) return { bots: [], everyone: false, lead: true, why: why || 'unsure' };
  return { bots: found, everyone: false, lead: false, why };
}

// ------------------------------------------------------------------------------------------------ moderator

/** Moderator mode: after every message a model picks 0–2 next speakers (or NONE: wait for the user). */
export function moderatorIntro(g: Group, recent: string): string {
  const rules = [
    'You moderate a group chat in AntiGem. You never write chat messages yourself: after each update you only decide who speaks next.',
    '',
    `Group: ${g.title}`,
    g.topic.trim() ? `Topic: ${g.topic.trim()}` : '',
    '',
    'AI members you can pick:',
    roster(g),
    '',
    `The human user is ${g.userName}; never pick them.`,
    '',
    'You get the new room messages as "[Name]: text". Reply with ONLY the names of who should speak next (0 to 2, the most fitting first), comma-separated, for example "Mia, Bob", or NONE when the conversation should wait for the user. Prefer whoever was asked, whoever knows most about the point, and variety; do not let the same two members bounce forever. Do not use tools.',
  ].join('\n');
  return `${labeledBlock(`🧭 ${g.title}: moderator`, rules)}\n\n${recent}\n\n(Who speaks next? Names or NONE.)`;
}

export function moderatorTurn(g: Group): string {
  const fresh = transcript(g, g.moderatorSeen, g.messages.length, null);
  return `${fresh ? `${fresh}\n\n` : ''}(Who speaks next? Names or NONE. Members: ${g.bots
    .filter((b) => !b.muted)
    .map((b) => b.name)
    .join(', ')})`;
}

/** The bots the moderator named, in its order (at most 2). */
export function parsePicks(text: string, g: Group): Bot[] {
  if (/^\W*none\W*$/i.test(text.trim())) return [];
  const lower = text.toLowerCase();
  return g.bots
    .filter((b) => !b.muted)
    .map((b) => ({ b, at: lower.search(new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(b.name.toLowerCase())}(?![\\p{L}\\p{N}_])`, 'u')) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .slice(0, 2)
    .map((x) => x.b);
}

// ------------------------------------------------------------------------------------------------ learning

/**
 * Words to learn for [target] from a message that was routed to someone else: its content words, without names and
 * words the target already has, longest (most specific) first, at most 3.
 */
export function learnWords(text: string, target: Bot, g: Group): string[] {
  const names = new Set([...g.bots.map((b) => b.name.toLowerCase()), g.userName.toLowerCase()]);
  const have = new Set(target.aliases);
  return keywords(text)
    .filter((w) => !names.has(w) && !have.has(w) && !/\.[a-z0-9]{1,6}$/.test(w) && w.length <= 30)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
}
