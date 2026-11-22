// Settings → Appearance → Group Agent Steps (the app's StepGroups in ui/chat/ChatFeedCache.kt): a run of a reply's
// thinking and tool steps (no reply text between them) folds into one pill (StepGroupPill) when it has at least the
// "Fold after" number of steps (theme.ts groupStepsMin, default 2; 1 = every run); shorter runs stay as they are.
// Steps that need the user (an approval, a question), show a picture or are system notices always stay full cards.
import { createEffect, createRoot, createSignal, on } from 'solid-js';
import type { ToolCall } from '@shared/model';
import { state } from './store';

/** One step of a reply: a thought, or a tool call. */
export type Step =
  | { kind: 'thought'; text: string; durationMs: number | null; streaming: boolean }
  | { kind: 'tool'; call: ToolCall };

export interface StepRun {
  /** `<message id>:<start>`: stays the same while the run grows. */
  key: string;
  /** The run's block indexes, [start, end) (-1: the thought shown before the blocks). */
  start: number;
  end: number;
  steps: Step[];
  /** The agent still works on this run. */
  live: boolean;
  /** When the run was seen to start / end (0 = not seen: an older reply). */
  startedAt: number;
  endedAt: number;
}

const IMAGE_FILE = /^(file:\/\/|\/)\S+\.(png|jpe?g|webp|gif|bmp)$/i;

/** A tool that always stays a full card: it needs the user, shows a picture or is a system notice. */
export function keepsCard(c: ToolCall): boolean {
  return (
    c.status === 'PENDING_APPROVAL' ||
    c.status === 'AWAITING_CHOICE' ||
    c.toolType === 'ASK_CHOICE' ||
    c.toolType === 'GENERATE_IMAGE' ||
    c.toolType === 'SYSTEM_NOTIFICATION' ||
    c.name === 'system_notice' ||
    c.output.startsWith('data:image/') ||
    IMAGE_FILE.test(c.output.trim())
  );
}

const startedAt = new Map<string, number>();
const endedAt = new Map<string, number>();

/**
 * The runs to fold in one reply. [entries]: its steps by block index (null: not a step), the first one at index
 * [first] (-1 when a thought shows before the blocks). [streaming]: the reply is still coming in; [createdAt]: when
 * it started (the first run of a reply starts with it); [minSteps]: a run folds with at least this many steps.
 */
export function findRuns(
  msgId: string,
  entries: (Step | null)[],
  first: number,
  streaming: boolean,
  createdAt: number,
  minSteps: number,
): StepRun[] {
  const out: StepRun[] = [];
  let firstRun = true;
  let i = 0;
  while (i < entries.length) {
    if (!entries[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < entries.length && entries[j]) j++;
    const steps = entries.slice(i, j) as Step[];
    const isFirst = firstRun;
    firstRun = false;
    const start = i + first;
    const end = j + first;
    const atEnd = j === entries.length;
    i = j;
    if (steps.length < minSteps) continue;
    const key = `${msgId}:${start}`;
    // still working: a step runs, or the run is the end of a reply that is still coming in (between two steps)
    const live = steps.some((s) => (s.kind === 'tool' ? s.call.status === 'RUNNING' : s.streaming)) || (streaming && atEnd);
    const now = Date.now();
    let started = 0;
    let ended = 0;
    if (live) {
      if (!startedAt.has(key)) startedAt.set(key, isFirst && createdAt > 0 && createdAt <= now ? createdAt : now);
      started = startedAt.get(key)!;
      endedAt.delete(key);
    } else {
      started = startedAt.get(key) ?? 0;
      if (started) {
        if (!endedAt.has(key)) endedAt.set(key, now);
        ended = endedAt.get(key)!;
      }
    }
    out.push({ key, start, end, steps, live, startedAt: started, endedAt: ended });
  }
  return out;
}

// The pills the user opened: only while they stay in that chat (opening another chat closes them all again).
const [openRuns, setOpenRuns] = createSignal<ReadonlySet<string>>(new Set());
createRoot(() =>
  createEffect(
    on(
      () => state.chat.conversationId,
      () => setOpenRuns(new Set<string>()),
      { defer: true },
    ),
  ),
);

export const isRunOpen = (key: string) => openRuns().has(key);

export function toggleRun(key: string) {
  setOpenRuns((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    return n;
  });
}
