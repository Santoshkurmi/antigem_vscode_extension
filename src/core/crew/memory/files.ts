// The memory files' line format (docs/crew/PLAN.md §12). A note is one Markdown list line a person can edit:
//   - 2026-11-22 · from #ops · Deploys go through staging first <!-- m:3f9a2c until:2026-12-01 -->
// The comment holds the note's id, its "until" day and, in about-me.md, the bot that added it ("by:bot_ab12"). A line
// without one (written by hand: a list item or plain text) is a note too, its id a hash of its text. A replaced note
// is struck through and kept 30 days:
//   - ~~2026-11-20 · Deploys go straight to prod~~ (superseded 2026-11-22) <!-- m:77b0e1 -->
// Prompts get the files without the comments, the struck lines and the notes whose day has passed.
import { createHash, randomBytes } from 'node:crypto';

export interface Entry {
  /** Line number in the file (from 0). */
  index: number;
  /** The line as written. */
  raw: string;
  id: string;
  /** The id is written in the line (false: written by hand, the id comes from the text). */
  tagged: boolean;
  /** The list marker with its indent ("- ", "  1. "), '' for a plain text line. */
  prefix: string;
  /** What a reader sees: the line without its marker and comment ("2026-11-22 · from #ops · text"). */
  visible: string;
  date: string | null;
  from: string | null;
  text: string;
  until: string | null;
  by: string | null;
  /** Struck through: the day it was superseded ('' when struck by hand); null = a current note. */
  struck: string | null;
}

export const TEXT_MAX = 1000;

const ITEM = /^(\s*(?:[-*+]|\d{1,3}[.)])\s+)(.*)$/;
const TAG = /\s*<!--\s*m:([\w-]+)((?:\s+[\w-]+:[^\s>]+)*)\s*-->\s*$/;
const STRUCK = /^~~(.+)~~(?:\s*\(superseded\s+(\d{4}-\d{2}-\d{2})\))?$/;
const HEAD = /^(\d{4}-\d{2}-\d{2})\s*·\s*(?:from\s+([^·]+?)\s*·\s*)?(.*)$/;
const FENCE = /^\s*(?:```|~~~)/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const COMMENT = /^\s*<!--.*-->\s*$/;

/** The note on this line, or null for headings, blank lines, rules, tables and comments. */
export function parseLine(raw: string, index = 0): Entry | null {
  const t = raw.trim();
  if (!t || t.startsWith('#') || t.startsWith('|') || RULE.test(raw) || COMMENT.test(raw)) return null;
  const item = ITEM.exec(raw);
  const prefix = item ? item[1] : '';
  let body = (item ? item[2] : t).trim();
  let id: string | null = null;
  let until: string | null = null;
  let by: string | null = null;
  const tag = TAG.exec(body);
  if (tag) {
    id = tag[1];
    for (const m of tag[2].matchAll(/([\w-]+):(\S+)/g)) {
      if (m[1] === 'until' && /^\d{4}-\d{2}-\d{2}$/.test(m[2])) until = m[2];
      else if (m[1] === 'by') by = m[2];
    }
    body = body.slice(0, tag.index).trim();
  }
  let struck: string | null = null;
  const s = STRUCK.exec(body);
  if (s) {
    struck = s[2] ?? '';
    body = s[1].trim();
  }
  const head = HEAD.exec(body);
  const text = (head ? head[3] : body).trim();
  if (!text) return null;
  return {
    index,
    raw,
    id: id ?? derivedId(text),
    tagged: !!id,
    prefix,
    visible: body,
    date: head ? head[1] : null,
    from: head?.[2]?.trim() || null,
    text,
    until,
    by,
    struck,
  };
}

/** Every line with its note (null: not a note). Lines inside code fences are never notes. */
export function parseLines(lines: string[]): { line: string; entry: Entry | null }[] {
  let fence = false;
  return lines.map((line, index) => {
    if (FENCE.test(line)) {
      fence = !fence;
      return { line, entry: null };
    }
    return { line, entry: fence ? null : parseLine(line, index) };
  });
}

export function entriesOf(lines: string[]): Entry[] {
  return parseLines(lines)
    .map((x) => x.entry)
    .filter((e): e is Entry => !!e);
}

export const splitLines = (text: string): string[] => {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

export const expired = (e: Entry, today: string) => !!e.until && e.until < today;

/** A note as a prompt shows it: no comment, its "until" in words. */
export function promptLine(e: Entry): string {
  return `${e.prefix}${e.visible}${e.until ? ` (until ${e.until})` : ''}`;
}

/** The file as a prompt shows it: struck and expired notes and comments left out, no runs of blank lines. */
export function promptView(lines: string[], today: string): { text: string; entry: Entry | null }[] {
  const out: { text: string; entry: Entry | null }[] = [];
  const blank = () => !out.length || !out[out.length - 1].text.trim();
  for (const { line, entry } of parseLines(lines)) {
    if (entry) {
      if (entry.struck === null && !expired(entry, today)) out.push({ text: promptLine(entry), entry });
    } else if (!line.trim()) {
      if (!blank()) out.push({ text: '', entry: null });
    } else if (!COMMENT.test(line)) out.push({ text: line.trimEnd(), entry: null });
  }
  while (out.length && blank()) out.pop();
  return out;
}

/** The first lines that fit in maxLines and maxBytes (joined with newlines), without a blank line at the end. */
export function within<T extends { text: string }>(view: T[], maxLines: number, maxBytes: number): T[] {
  const out: T[] = [];
  let bytes = 0;
  for (const v of view) {
    const next = bytes + Buffer.byteLength(v.text) + (out.length ? 1 : 0);
    if (out.length >= maxLines || next > maxBytes) break;
    out.push(v);
    bytes = next;
  }
  while (out.length && !out[out.length - 1].text.trim()) out.pop();
  return out;
}

const tag = (id: string, until?: string | null, by?: string | null) => `<!-- m:${id}${until ? ` until:${until}` : ''}${by ? ` by:${by}` : ''} -->`;

export function formatEntry(n: { date: string; from?: string | null; text: string; id: string; until?: string | null; by?: string | null }): string {
  return `- ${n.date} · ${n.from ? `from ${n.from} · ` : ''}${n.text} ${tag(n.id, n.until, n.by)}`;
}

/** The note struck through, dated, keeping its id (so Undo and the 30-day prune can find it). */
export function strikeEntry(e: Entry, today: string): string {
  return `${e.prefix || '- '}~~${e.visible}~~ (superseded ${today}) ${tag(e.id, e.until, e.by)}`;
}

// ------------------------------------------------------------------ text

/** Lowercase, single spaces, no quotes or end punctuation: two notes with the same normText are the same note. */
export const normText = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`.!;,]+$/g, '')
    .trim();

/** A note's text as it goes into a line: one line, no list marker, nothing that would end its comment early. */
export const cleanText = (s: string) =>
  s
    .replace(/<!--|-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-*+•]|\d{1,3}[.)])\s+/, '')
    .trim();

/** "#ops", "DM", "job j_ab12": short, one line, no separator dots. */
export function cleanSource(s: string | null | undefined): string | null {
  const v = (s ?? '')
    .replace(/<!--|-->|·/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return v || null;
}

/** A topic's file name: lowercase a-z, 0-9 and dashes (null when nothing is left). */
export function slugTopic(s: string): string | null {
  const slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || null;
}

/** A hand-written line's id: "h" + a hash of its text (random ids are hex, so they never meet). */
export const derivedId = (text: string) => `h${createHash('sha1').update(normText(text)).digest('hex').slice(0, 5)}`;

export function newNoteId(taken: Set<string>): string {
  for (;;) {
    const id = randomBytes(3).toString('hex');
    if (!taken.has(id)) return id;
  }
}

// ------------------------------------------------------------------ days (local time, YYYY-MM-DD)

const pad = (n: number) => String(n).padStart(2, '0');

export function day(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayMs(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function addDays(s: string, days: number, months = 0): string {
  const [y, m, d] = s.split('-').map(Number);
  return day(new Date(y, m - 1 + months, d + days).getTime());
}

/** "2026-12-01", an ISO time, a timestamp, "today", "tomorrow" or a span ("7d", "2 weeks", "3m", "1y"). */
export function parseUntil(v: string | number, now: number): string {
  const today = day(now);
  let out: string | null = null;
  if (typeof v === 'number') out = Number.isFinite(v) ? day(v) : null;
  else {
    const s = v.trim().toLowerCase();
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    const span = /^\+?(\d{1,4})\s*(d|days?|w|weeks?|m|mo|months?|y|years?)$/.exec(s);
    if (iso) {
      const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
      if (d.getMonth() === Number(iso[2]) - 1 && d.getDate() === Number(iso[3])) out = iso[0];
    } else if (s === 'today') out = today;
    else if (s === 'tomorrow') out = addDays(today, 1);
    else if (span) {
      const n = Number(span[1]);
      const u = span[2][0];
      out = u === 'd' ? addDays(today, n) : u === 'w' ? addDays(today, 7 * n) : u === 'm' ? addDays(today, 0, n) : addDays(today, 0, 12 * n);
    }
  }
  if (!out) throw new Error(`until must be a day like 2026-12-01 or a span like 7d, 2w, 3m (got "${String(v)}")`);
  if (out < today) throw new Error(`until ${out} has already passed (today is ${today})`);
  return out;
}
