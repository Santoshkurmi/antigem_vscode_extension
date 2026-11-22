// Goals (docs/crew/PLAN.md §7 "Goals"): what the bots are told and how their answers are read.
// - Room goal: the room's lead drives it in bounded team turns. Each lead turn ends with a control block
//   {"status": "continue|completed|needs-input|blocked", "next": "<member>", "instruction": "…"} that the host strips
//   from the posted message and follows (the next member acts, then the lead again).
// - Bot goal: one bot keeps going on a standing objective; after each of its turns a cheap judge says DONE, CONTINUE
//   or WAIT <minutes>.
import { labeledBlock } from '../text';

export type GoalStatus = 'continue' | 'completed' | 'needs-input' | 'blocked';

export interface Control {
  status: GoalStatus;
  next: string;
  instruction: string;
}

// ------------------------------------------------------------------------------------------------ room goals

/** The lead's turn: the goal, the turn count, the members, the control block it must end with. */
export function leadInstruction(goal: string, turn: number, max: number, members: string[], extra = ''): string {
  return labeledBlock(
    `🎯 Room goal · team turn ${turn} of ${max}`,
    [
      `You lead the room toward this goal: ${goal}`,
      `Members you can hand the next step to: ${members.map((m) => `@${m}`).join(', ') || '(only you)'}.`,
      extra,
      'Write your message for the room (short), then end it with ONE line of JSON exactly like this:',
      '{"status": "continue", "next": "<member name, or empty to keep going yourself>", "instruction": "<what they should do next>"}',
      'status: continue (more steps needed), completed (the goal is reached: say how), needs-input (only the user can decide: ask them), blocked (it cannot be done: say why).',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/** A member's goal step, handed to it by the lead. */
export function stepInstruction(lead: string, goal: string, instruction: string): string {
  return `(For the room goal "${goal.slice(0, 200)}", @${lead} asks you: ${instruction || 'do the next step'}. Do it, then report briefly.)`;
}

/**
 * The control block at the end of a lead's message (the last {...} with a "status"), and the message without it.
 * Lenient: single quotes, a ```json fence, trailing words, "done" for completed.
 */
export function parseControl(text: string): { text: string; control: Control | null } {
  const re = /(```(?:json)?\s*)?(\{[^{}]*['"]?status['"]?\s*:[^{}]*\})(\s*```)?/gi;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return { text, control: null };
  let raw: Record<string, unknown> | null = null;
  try {
    raw = JSON.parse(last[2]);
  } catch {
    try {
      raw = JSON.parse(last[2].replace(/'/g, '"').replace(/([{,]\s*)([a-z]+)\s*:/gi, '$1"$2":'));
    } catch {
      raw = null;
    }
  }
  if (!raw) return { text, control: null };
  const s = String(raw.status ?? '').toLowerCase().replace(/[_\s]/g, '-');
  const status: GoalStatus | null = /^(continue|in-progress|next)$/.test(s) ? 'continue' : /^(completed|complete|done|finished)$/.test(s) ? 'completed' : /^(needs-input|need-input|input|ask)$/.test(s) ? 'needs-input' : /^(blocked|stuck|fail|failed)$/.test(s) ? 'blocked' : null;
  if (!status) return { text, control: null };
  const rest = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
  return { text: rest, control: { status, next: String(raw.next ?? '').replace(/^@/, '').trim(), instruction: String(raw.instruction ?? '').trim().slice(0, 1000) } };
}

// ------------------------------------------------------------------------------------------------ bot goals

export function goalEnvelope(goal: string, userName: string, maxTurns: number): string {
  return labeledBlock(
    '🎯 Your standing goal',
    [
      `${userName} gave you a standing goal: ${goal}`,
      `Work toward it on your own, one step per turn (at most ${maxTurns} turns). Use your tools; hand parts to teammates with crew_assign if that is faster.`,
      'End every turn with what you did, what is left, and what is not verified. If only the user can decide something, end with a line "NEEDS INPUT: <question>".',
    ].join('\n'),
  );
}

export function continueText(turn: number, max: number): string {
  return `(Goal turn ${turn} of ${max}: take the next step toward your goal, then report.)`;
}

export function judgePrompt(goal: string, report: string): string {
  return [
    'You judge progress toward a goal. Reply with ONE line only:',
    'DONE (the goal is reached), CONTINUE (more work is needed now), or WAIT <minutes> (nothing to do until later, e.g. waiting for a build or a deadline; 5 to 1440).',
    '',
    `Goal: ${goal.slice(0, 1500)}`,
    '',
    'Latest report from the bot working on it:',
    report.slice(0, 4000) || '(it said nothing)',
  ].join('\n');
}

export function parseJudge(reply: string): { verdict: 'done' | 'continue' | 'wait'; minutes: number } {
  const line = reply.trim().split('\n').find((l) => l.trim()) ?? '';
  const w = /\bWAIT\b\D*(\d+)?/i.exec(line);
  if (w) return { verdict: 'wait', minutes: Math.min(1440, Math.max(5, Number(w[1] ?? 30))) };
  if (/\bDONE\b/i.test(line)) return { verdict: 'done', minutes: 0 };
  return { verdict: 'continue', minutes: 0 };
}
