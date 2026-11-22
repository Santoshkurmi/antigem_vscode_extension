// What BotMemory (memory.ts) hands out: notes, add results, search hits, topics, About me lines.
import type { MemoryActor } from './notes';

/** A note as the Memory panel and the tools see it. */
export interface MemoryNote {
  id: string;
  text: string;
  /** 'core' (MEMORY.md) or the topic. */
  where: string;
  date: string | null;
  /** Where it was learned ("#ops", "DM", "job j_ab12"). */
  from: string | null;
  until: string | null;
  /** Superseded: the day it was ('' when struck by hand); null = current. */
  struck: string | null;
  /** Written by hand (no id in the line; its id comes from its text). */
  handWritten: boolean;
  /** The line as it is in the file. */
  line: string;
}

export interface AddInput {
  text: string;
  /** A topic name (made into a file name); none = core memory. */
  topic?: string | null;
  /** The last day it holds: "2026-12-01", "7d", "2w", "3m", a timestamp. */
  until?: string | number | null;
  source?: string | null;
  actor: MemoryActor;
}

export interface AddResult {
  id: string;
  line: string;
  where: string;
  /** The same note was there already (nothing was written; id and line are the existing note's). */
  duplicate: boolean;
  /** For the bot: secrets were removed, core memory is getting too long… */
  note?: string;
}

export interface SearchHit {
  id: string;
  text: string;
  where: string;
  score: number;
  date: string | null;
  from: string | null;
}

export interface TopicInfo {
  topic: string;
  /** Current notes (struck and expired ones not counted). */
  lines: number;
  updatedAt: number;
}

export interface AboutMeLine {
  id: string;
  text: string;
  /** The bot that added it, or 'user' (the user, or written by hand). */
  by: string;
  /** The day it was added (local midnight), 0 when the line has no date. */
  at: number;
}

