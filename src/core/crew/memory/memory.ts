// A bot's memory (docs/crew/PLAN.md §12), plain Markdown under the crew folder:
//   bots/<botId>/MEMORY.md              core notes: the first 200 lines / 24 KB go into the bot's stable prompt
//   bots/<botId>/memory/<topic>.md      topic notes: only an index ("Topics: deploy (12 notes)") is in the prompt,
//                                       the notes come up through search and recall
//   bots/<botId>/memory/journal.ndjson  every write with the lines before and after (Undo)
//   about-me.md + about-me.journal.ndjson   what every bot knows about the user; each line says which bot added it
// Line format in files.ts. Pure file and text work: the engine runs the cheap-model capture turns (capture.ts).
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './capture';
import {
  TEXT_MAX,
  cleanSource,
  cleanText,
  day,
  dayMs,
  expired,
  formatEntry,
  newNoteId,
  normText,
  parseUntil,
  promptView,
  slugTopic,
  strikeEntry,
  within,
  type Entry,
} from './files';
import { NoteSet, type JournalRecord, type MemoryActor } from './notes';
import { rank } from './search';
import type { AboutMeLine, AddInput, AddResult, MemoryNote, SearchHit, TopicInfo } from './types';

export { CAPTURE_MAX, capturePrompt, looksSecret, parseCapture, redact, type CaptureFact } from './capture';
export type { JournalRecord, MemoryAction, MemoryActor } from './notes';
export type { AboutMeLine, AddInput, AddResult, MemoryNote, SearchHit, TopicInfo } from './types';

export const CORE_MAX_LINES = 200;
export const CORE_MAX_BYTES = 24 * 1024;
export const ABOUT_ME_MAX_BYTES = 8 * 1024;
const CORE = 'MEMORY.md';
const ABOUT = 'about-me.md';

interface Located {
  e: Entry;
  file: string;
  where: string;
}

export class BotMemory {
  constructor(
    readonly root: string,
    private clock: () => number = () => Date.now(),
  ) {}

  private set(botId: string): NoteSet {
    if (!/^[\w-]+$/.test(botId)) throw new Error(`not a bot id: ${botId}`);
    return new NoteSet(path.join(this.root, 'bots', botId), 'memory/journal.ndjson', this.clock);
  }

  private aboutSet(): NoteSet {
    return new NoteSet(this.root, 'about-me.journal.ndjson', this.clock);
  }

  private today(): string {
    return day(this.clock());
  }

  /** Core first, then the topic files by name. */
  private files(set: NoteSet): { file: string; where: string }[] {
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(set.path('memory'))
        .filter((n) => n.endsWith('.md') && !n.startsWith('.'))
        .sort();
    } catch {
      /* no topics yet */
    }
    return [{ file: CORE, where: 'core' }, ...names.map((n) => ({ file: `memory/${n}`, where: n.slice(0, -3) }))];
  }

  private all(set: NoteSet): Located[] {
    return this.files(set).flatMap((f) => set.entries(f.file).map((e) => ({ e, file: f.file, where: f.where })));
  }

  private live(l: Located, today: string): boolean {
    return l.e.struck === null && !expired(l.e, today);
  }

  /** A topic's file: an existing file by that exact name (a hand-made one), else the slug's. */
  private topicFile(set: NoteSet, topic: string): string | null {
    const t = topic.trim();
    if (/^[\w .-]+$/.test(t) && !t.startsWith('.') && fs.existsSync(set.path(`memory/${t}.md`))) return `memory/${t}.md`;
    const slug = slugTopic(t);
    return slug ? `memory/${slug}.md` : null;
  }

  /** The note's file (MEMORY.md, or the topic's), to open in an editor. */
  file(botId: string, topic?: string | null): string {
    const set = this.set(botId);
    return set.path((topic && this.topicFile(set, topic)) || CORE);
  }

  // ------------------------------------------------------------------ reading

  private coreView(set: NoteSet) {
    return within(promptView(set.lines(CORE), this.today()), CORE_MAX_LINES, CORE_MAX_BYTES);
  }

  /** Core memory as the prompt gets it: no comments, struck or expired notes; the first 200 lines / 24 KB. */
  core(botId: string): string {
    return this.coreView(this.set(botId))
      .map((v) => v.text)
      .join('\n');
  }

  topics(botId: string): TopicInfo[] {
    const set = this.set(botId);
    const today = this.today();
    return this.files(set)
      .slice(1)
      .map((f) => {
        let updatedAt = 0;
        try {
          updatedAt = fs.statSync(set.path(f.file)).mtimeMs;
        } catch {
          /* gone meanwhile */
        }
        return { topic: f.where, lines: set.entries(f.file).filter((e) => e.struck === null && !expired(e, today)).length, updatedAt };
      });
  }

  /** A topic's notes as a prompt shows them ('' when there is no such topic). */
  topic(botId: string, topic: string): string {
    const set = this.set(botId);
    const f = this.topicFile(set, topic);
    if (!f) return '';
    return within(promptView(set.lines(f), this.today()), Infinity, CORE_MAX_BYTES)
      .map((v) => v.text)
      .join('\n');
  }

  /** Every note in every file (struck ones too), core first. */
  notes(botId: string): MemoryNote[] {
    return this.all(this.set(botId)).map(toNote);
  }

  /** The notes an id or a text points at: the id, else notes with exactly that text, else notes containing it. */
  find(botId: string, idOrText: string): MemoryNote[] {
    return locate(this.all(this.set(botId)), idOrText).hits.map(toNote);
  }

  // ------------------------------------------------------------------ writing

  add(botId: string, input: AddInput): AddResult {
    const set = this.set(botId);
    const file = (input.topic && this.topicFile(set, input.topic)) || CORE;
    const where = file === CORE ? 'core' : file.slice('memory/'.length, -3);
    const res = this.insert(set, file, where, this.all(set), input.text, { until: input.until, source: input.source, actor: input.actor });
    if (!res.duplicate && file === CORE) {
      const view = promptView(set.lines(CORE), this.today());
      const bytes = Buffer.byteLength(view.map((v) => v.text).join('\n'));
      if (view.length > CORE_MAX_LINES || bytes > CORE_MAX_BYTES) {
        const over = `core memory is ${view.length} lines / ${Math.ceil(bytes / 1024)} KB and only the first ${CORE_MAX_LINES} lines / ${CORE_MAX_BYTES / 1024} KB reach your prompt: move older notes into topics (add them with a topic, then forget them here)`;
        res.note = res.note ? `${res.note}; ${over}` : over;
      }
    }
    return res;
  }

  private insert(
    set: NoteSet,
    file: string,
    where: string,
    existing: Located[],
    text: string,
    o: { until?: string | number | null; source?: string | null; actor: MemoryActor; by?: string | null; journalBy?: string },
  ): AddResult {
    const clean = cleanText(text);
    if (!clean) throw new Error('the note is empty');
    const safe = redact(clean).slice(0, TEXT_MAX);
    const today = this.today();
    const n = normText(safe);
    const dup = existing.find((l) => this.live(l, today) && normText(l.e.text) === n);
    if (dup) return { id: dup.e.id, line: dup.e.raw, where: dup.where, duplicate: true, note: 'already remembered' };
    const until = o.until != null && o.until !== '' ? parseUntil(o.until, this.clock()) : null;
    const id = newNoteId(new Set(existing.map((l) => l.e.id)));
    const line = formatEntry({ date: today, from: cleanSource(o.source), text: safe, id, until, by: o.by });
    const lines = set.lines(file);
    let at = lines.length;
    while (at > 0 && !lines[at - 1].trim()) at--;
    set.apply(file, [{ at, remove: 0, insert: [line] }], { actor: o.actor, action: 'add', ...(o.journalBy ? { by: o.journalBy } : {}) });
    return { id, line, where, duplicate: false, ...(safe !== clean ? { note: 'secrets were removed from it' } : {}) };
  }

  /**
   * Supersedes a note: the old line is struck through and dated, the new one goes right after it (with a new id; it
   * keeps the old note's "until" and "from" unless given). Null when nothing (or more than one note) matches.
   */
  update(
    botId: string,
    idOrText: string,
    text: string,
    actor: MemoryActor,
    opts: { until?: string | number | null; source?: string | null } = {},
  ): (AddResult & { replaced: string }) | null {
    const set = this.set(botId);
    const all = this.all(set);
    const old = pick(locate(all, idOrText));
    if (!old || old.e.struck !== null) return null;
    const clean = cleanText(text);
    if (!clean) throw new Error('the note is empty');
    const safe = redact(clean).slice(0, TEXT_MAX);
    const today = this.today();
    if (normText(safe) === normText(old.e.text) && opts.until === undefined && opts.source === undefined) {
      return { id: old.e.id, line: old.e.raw, where: old.where, duplicate: true, replaced: old.e.id, note: 'nothing changed' };
    }
    const until =
      opts.until === undefined ? (old.e.until && old.e.until >= today ? old.e.until : null) : opts.until != null && opts.until !== '' ? parseUntil(opts.until, this.clock()) : null;
    const id = newNoteId(new Set(all.map((l) => l.e.id)));
    const from = opts.source === undefined ? old.e.from : cleanSource(opts.source);
    const line = formatEntry({ date: today, from, text: safe, id, until, by: old.e.by });
    set.apply(old.file, [{ at: old.e.index, remove: 1, insert: [strikeEntry(old.e, today), line] }], { actor, action: 'update' });
    return { id, line, where: old.where, duplicate: false, replaced: old.e.id, ...(safe !== clean ? { note: 'secrets were removed from it' } : {}) };
  }

  /** Removes the note's line. Null when nothing (or more than one note) matches. */
  forget(botId: string, idOrText: string, actor: MemoryActor): MemoryNote | null {
    const set = this.set(botId);
    const hit = pick(locate(this.all(set), idOrText));
    if (!hit) return null;
    set.apply(hit.file, [{ at: hit.e.index, remove: 1, insert: [] }], { actor, action: 'forget' });
    return toNote(hit);
  }

  /** Removes notes whose "until" day has passed (and struck lines older than 30 days). Returns how many notes. */
  expire(botId: string, now = this.clock()): number {
    const set = this.set(botId);
    const today = day(now);
    let n = 0;
    for (const f of this.files(set)) {
      const gone = set.entries(f.file).filter((e) => e.struck === null && expired(e, today));
      n += gone.length;
      set.apply(
        f.file,
        gone.map((e) => ({ at: e.index, remove: 1, insert: [] })),
        { actor: 'tidy', action: 'expire', now },
      );
    }
    return n;
  }

  /** The newest writes first. */
  journal(botId: string, limit = 50): JournalRecord[] {
    return this.set(botId).journal(limit);
  }

  /** Undoes one write, if its lines are still as it left them (false, and no change, otherwise). */
  undo(botId: string, journalId: string): boolean {
    return this.set(botId).undo(journalId, 'user');
  }

  // ------------------------------------------------------------------ search, recall, prompt

  private ranked(items: Located[], query: string) {
    return rank(
      items,
      (l) => `${l.e.text} ${l.e.from ?? ''}`,
      query,
      (l) => (l.where === 'core' ? '' : l.where.replace(/-/g, ' ')),
    ).sort((a, b) => b.score - a.score || (b.item.e.date ?? '').localeCompare(a.item.e.date ?? '') || b.item.e.index - a.item.e.index);
  }

  /** Current notes matching the words of the query, best first (newer first on a tie). */
  search(botId: string, query: string, limit = 8): SearchHit[] {
    const today = this.today();
    return this.ranked(
      this.all(this.set(botId)).filter((l) => this.live(l, today)),
      query,
    )
      .slice(0, Math.max(0, limit))
      .map(({ item, score }) => ({ id: item.e.id, text: item.e.text, where: item.where, score, date: item.e.date, from: item.e.from }));
  }

  /**
   * The notes that best match a turn's text, as a short block for the front of the turn ('' when none match). Core
   * notes already in the stable prompt are left out; expired notes never come.
   */
  recall(botId: string, text: string, opts: { maxNotes?: number; maxBytes?: number } = {}): string {
    const maxNotes = opts.maxNotes ?? 4;
    const maxBytes = opts.maxBytes ?? 6144;
    const set = this.set(botId);
    const today = this.today();
    const inPrompt = new Set(this.coreView(set).map((v) => v.entry?.id));
    const pool = this.all(set).filter((l) => this.live(l, today) && !(l.where === 'core' && inPrompt.has(l.e.id)));
    const hits = this.ranked(pool, text).slice(0, Math.max(0, maxNotes));
    const head = 'From your memory (notes that may help here):';
    let out = head;
    for (const { item } of hits) {
      const room = maxBytes - Buffer.byteLength(out) - 1;
      if (room < 24) break;
      let line = `- ${item.where === 'core' ? '' : `[${item.where}] `}${item.e.visible}${item.e.until ? ` (until ${item.e.until})` : ''}`;
      if (Buffer.byteLength(line) > room) line = `${cutBytes(line, room - 3)}…`;
      out += `\n${line}`;
    }
    return out === head ? '' : out;
  }

  /** For the bot's stable prompt: core memory (limited) and one line listing the topics; '' when there is none. */
  indexForPrompt(botId: string): string {
    const topics = this.topics(botId).filter((t) => t.lines > 0);
    const index = topics.length ? `Topics: ${topics.map((t) => `${t.topic} (${t.lines} ${t.lines === 1 ? 'note' : 'notes'})`).join(', ')}` : '';
    return [this.core(botId), index].filter(Boolean).join('\n\n');
  }

  // ------------------------------------------------------------------ about me (shared by every bot)

  /** about-me.md as prompts get it (no comments or struck lines), at most 8 KB. */
  aboutMe(): string {
    return within(promptView(this.aboutSet().lines(ABOUT), this.today()), Infinity, ABOUT_ME_MAX_BYTES)
      .map((v) => v.text)
      .join('\n');
  }

  aboutMeLines(): AboutMeLine[] {
    return this.aboutSet()
      .entries(ABOUT)
      .filter((e) => e.struck === null)
      .map((e) => ({ id: e.id, text: e.text, by: e.by ?? 'user', at: e.date ? dayMs(e.date) : 0 }));
  }

  /** Adds a line about the user (redacted; a repeat returns the existing line). byBotId 'user': the user wrote it. */
  prefer(text: string, byBotId: string): AddResult {
    const set = this.aboutSet();
    const by = byBotId === 'user' ? null : byBotId.replace(/[^\w-]/g, '') || null;
    const existing = set.entries(ABOUT).map((e) => ({ e, file: ABOUT, where: 'about-me' }));
    const res = this.insert(set, ABOUT, 'about-me', existing, text, { actor: by ? 'bot' : 'user', by, journalBy: by ?? 'user' });
    if (!res.duplicate) {
      const bytes = Buffer.byteLength(promptView(set.lines(ABOUT), this.today()).map((v) => v.text).join('\n'));
      if (bytes > ABOUT_ME_MAX_BYTES) {
        const over = `About me is ${Math.ceil(bytes / 1024)} KB and only the first ${ABOUT_ME_MAX_BYTES / 1024} KB reach prompts`;
        res.note = res.note ? `${res.note}; ${over}` : over;
      }
    }
    return res;
  }

  /** Removes a line (by id, or its text). False when nothing (or more than one line) matches. */
  removeAboutMe(idOrText: string): boolean {
    const set = this.aboutSet();
    const hit = pick(locate(set.entries(ABOUT).map((e) => ({ e, file: ABOUT, where: 'about-me' })), idOrText));
    if (!hit) return false;
    set.apply(ABOUT, [{ at: hit.e.index, remove: 1, insert: [] }], { actor: 'user', action: 'forget' });
    return true;
  }

  aboutMeJournal(limit = 50): JournalRecord[] {
    return this.aboutSet().journal(limit);
  }

  undoAboutMe(journalId: string): boolean {
    return this.aboutSet().undo(journalId, 'user');
  }
}

// ------------------------------------------------------------------ helpers

function toNote(l: Located): MemoryNote {
  const { e } = l;
  return { id: e.id, text: e.text, where: l.where, date: e.date, from: e.from, until: e.until, struck: e.struck, handWritten: !e.tagged, line: e.raw };
}

/** sure: matched by id or by the whole text (take the first); else by part of the text (only one may match). */
function locate(all: Located[], idOrText: string): { hits: Located[]; sure: boolean } {
  const key = idOrText.trim().replace(/^m:/, '');
  if (!key) return { hits: [], sure: false };
  const byId = all.filter((l) => l.e.id === key);
  if (byId.length) return { hits: byId.sort((a, b) => Number(b.e.struck === null) - Number(a.e.struck === null)), sure: true };
  const n = normText(key);
  const current = all.filter((l) => l.e.struck === null);
  const same = current.filter((l) => normText(l.e.text) === n);
  if (same.length) return { hits: same, sure: true };
  return { hits: n.length >= 3 ? current.filter((l) => normText(l.e.text).includes(n)) : [], sure: false };
}

function pick(r: { hits: Located[]; sure: boolean }): Located | null {
  return r.sure || r.hits.length === 1 ? (r.hits[0] ?? null) : null;
}

/** The start of s that fits in n bytes of UTF-8 (never half a character). */
function cutBytes(s: string, n: number): string {
  let cut = s.slice(0, Math.max(0, n));
  while (Buffer.byteLength(cut) > n) cut = cut.slice(0, -1);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
