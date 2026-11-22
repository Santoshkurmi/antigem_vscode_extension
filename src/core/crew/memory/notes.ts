// One set of memory files and their journal: a bot's MEMORY.md + memory/*.md (journal memory/journal.ndjson), or the
// crew's about-me.md (journal about-me.journal.ndjson). Every change replaces a few lines of one file, is written
// atomically and journaled with the lines before and after, so it can be undone while those lines are still as it
// left them. Struck-through lines older than 30 days are dropped on the file's next write.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendLine, readLines, readText, writeAtomic } from '../store/fsx';
import { addDays, day, entriesOf, parseLine, splitLines, type Entry } from './files';

export type MemoryActor = 'bot' | 'user' | 'capture' | 'tidy';
export type MemoryAction = 'add' | 'update' | 'forget' | 'expire' | 'undo';

/** One line of a journal: one change to one file. */
export interface JournalRecord {
  id: string;
  at: number;
  actor: MemoryActor;
  action: MemoryAction;
  /** The file, from the set's folder: 'MEMORY.md', 'memory/deploy.md', 'about-me.md'. */
  file: string;
  /** The lines the change replaced (null: it only added). */
  before: string | null;
  /** The lines it wrote (null: it only removed). */
  after: string | null;
  /** Where in the file it happened (line number from 0, at the time). */
  line: number;
  /** About me: the bot that added the line ('user' for the user). */
  by?: string;
  /** An undo: the record it undid. */
  undoes?: string;
}

/** Replace `remove` lines at `at` with `insert`. */
export interface Edit {
  at: number;
  remove: number;
  insert: string[];
}

export interface ChangeMeta {
  actor: MemoryActor;
  action: MemoryAction;
  by?: string;
  undoes?: string;
  /** The time of the change (default: the set's clock). */
  now?: number;
}

const PRUNE_DAYS = 30;
const JOURNAL_MAX_BYTES = 1024 * 1024;
const JOURNAL_KEEP = 2000;

export class NoteSet {
  constructor(
    readonly dir: string,
    private journalName: string,
    private clock: () => number,
  ) {}

  path(file: string): string {
    return path.join(this.dir, file);
  }

  lines(file: string): string[] {
    const text = readText(this.path(file));
    return text ? splitLines(text) : [];
  }

  entries(file: string): Entry[] {
    return entriesOf(this.lines(file));
  }

  /**
   * Applies the edits (they must not overlap; line numbers are the file's as it is now), drops old struck lines,
   * writes the file once and journals each change. Nothing is written when nothing changes.
   */
  apply(file: string, edits: Edit[], meta: ChangeMeta): JournalRecord[] {
    const lines = this.lines(file);
    const now = meta.now ?? this.clock();
    const recs: JournalRecord[] = [];
    for (const e of [...edits].sort((a, b) => b.at - a.at)) {
      const removed = lines.splice(e.at, e.remove, ...e.insert);
      recs.unshift(this.record(meta, file, removed, e.insert, e.at, now));
    }
    // an undo may bring back an old struck line on purpose
    if (meta.action !== 'undo') recs.push(...this.prune(file, lines, now));
    if (!recs.length) return recs;
    this.write(file, lines);
    for (const r of recs) this.log(r);
    return recs;
  }

  private record(meta: ChangeMeta, file: string, before: string[], after: string[], line: number, at: number): JournalRecord {
    return {
      id: `j_${randomBytes(4).toString('hex')}`,
      at,
      actor: meta.actor,
      action: meta.action,
      file,
      before: before.length ? before.join('\n') : null,
      after: after.length ? after.join('\n') : null,
      line,
      ...(meta.by ? { by: meta.by } : {}),
      ...(meta.undoes ? { undoes: meta.undoes } : {}),
    };
  }

  /** Removes (from `lines`) struck lines superseded more than 30 days ago. */
  private prune(file: string, lines: string[], now: number): JournalRecord[] {
    const cutoff = addDays(day(now), -PRUNE_DAYS);
    const old = entriesOf(lines).filter((e) => e.struck && e.struck < cutoff);
    const recs: JournalRecord[] = [];
    for (const e of old.reverse()) {
      lines.splice(e.index, 1);
      recs.unshift(this.record({ actor: 'tidy', action: 'expire' }, file, [e.raw], [], e.index, now));
    }
    return recs;
  }

  private write(file: string, lines: string[]) {
    const p = this.path(file);
    if (lines.some((l) => l.trim())) writeAtomic(p, `${lines.join('\n')}\n`);
    else fs.rmSync(p, { force: true });
  }

  private log(r: JournalRecord) {
    const f = this.path(this.journalName);
    appendLine(f, r);
    try {
      if (fs.statSync(f).size > JOURNAL_MAX_BYTES) {
        const keep = readLines<JournalRecord>(f).slice(-JOURNAL_KEEP);
        writeAtomic(f, `${keep.map((x) => JSON.stringify(x)).join('\n')}\n`);
      }
    } catch {
      /* trimming can wait for the next write */
    }
  }

  /** The newest records first. */
  journal(limit = 50): JournalRecord[] {
    return readLines<JournalRecord>(this.path(this.journalName))
      .filter((r) => r && typeof r.id === 'string')
      .slice(-Math.max(1, limit))
      .reverse();
  }

  /**
   * Puts back what the record changed, only if the lines it wrote are still there as it wrote them (or, when it
   * removed lines, nothing with their id is back). False, with nothing changed, otherwise.
   */
  undo(journalId: string, actor: MemoryActor = 'user'): boolean {
    const rec = readLines<JournalRecord>(this.path(this.journalName)).find((r) => r?.id === journalId);
    if (!rec || typeof rec.file !== 'string' || rec.file.split(/[\\/]/).includes('..')) return false;
    if (rec.before == null && rec.after == null) return false;
    const lines = this.lines(rec.file);
    const before = rec.before == null ? [] : rec.before.split('\n');
    let edit: Edit;
    if (rec.after != null) {
      const block = rec.after.split('\n');
      const at = findBlock(lines, block, rec.line);
      if (at < 0) return false;
      edit = { at, remove: block.length, insert: before };
    } else {
      const ids = new Set(entriesOf(lines).map((e) => e.id));
      const back = before.some((l) => l.trim() && (lines.includes(l) || ids.has(parseLine(l)?.id ?? '')));
      if (back) return false;
      edit = { at: Math.min(Math.max(0, rec.line), lines.length), remove: 0, insert: before };
    }
    this.apply(rec.file, [edit], { actor, action: 'undo', undoes: rec.id, ...(rec.by ? { by: rec.by } : {}) });
    return true;
  }
}

/** Where `block` sits in `lines` (the match nearest `hint`), or -1. */
function findBlock(lines: string[], block: string[], hint: number): number {
  let best = -1;
  for (let i = 0; i + block.length <= lines.length; i++) {
    if (block.every((b, k) => lines[i + k] === b) && (best < 0 || Math.abs(i - hint) < Math.abs(best - hint))) best = i;
  }
  return best;
}
