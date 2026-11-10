// A chat reply as words (port of the app's JarvisText.kt). Every agent stores more than the reply in a message's text:
// the model's thinking (`<!-- thought -->…<!-- /thought -->`, possibly still open while it streams), tool-call
// placeholders (`<!-- tool_call:… -->`), error cards (`<!-- error -->{json}<!-- /error -->`) and hidden instructions.
// None of that may ever be passed on as what an agent "said"; the error card becomes one plain sentence instead.
import { collapseExpansions } from '../text';

const THOUGHT = /<!--\s*thought[^>]*-->[\s\S]*?(<!--\s*\/thought\s*-->|$)/g;
// only the app's own thinking marker can be open (still streaming); anything else must be closed
const THOUGHT_TAG = /<thought>[\s\S]*?<\/thought>/gi;
const THINKING_TAG = /<thinking>[\s\S]*?<\/thinking>/gi;
const ERROR_CARD = /<!--\s*error[^>]*-->([\s\S]*?)<!--\s*\/error\s*-->/g;
const COMMENT = /<!--[\s\S]*?-->/g;
const field = (name: string) => new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
const USER_MESSAGE = field('userMessage');
const TITLE = field('title');

export interface Reply {
  /** What the agent wrote for the user (no thinking, markers or hidden blocks). */
  text: string;
  /** The error the turn ended with, in one line, if any. */
  error: string | null;
}

const unescape = (s: string) => s.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\\\/g, '\\');

function errorLine(json: string): string | null {
  const msg = USER_MESSAGE.exec(json)?.[1];
  const t = TITLE.exec(json)?.[1];
  const m = msg != null ? unescape(msg).trim() : null;
  const tt = t != null ? unescape(t).trim() : null;
  const line = [tt || null, m && m !== tt ? m : null].filter(Boolean).join(': ');
  const out = line || json.trim().slice(0, 160) || null;
  return out ? out.slice(0, 300) : null;
}

export function reply(raw: string | null | undefined): Reply {
  if (!raw || !raw.trim()) return { text: '', error: null };
  let s = collapseExpansions(raw);
  const errors = [...s.matchAll(ERROR_CARD)].map((m) => errorLine(m[1])).filter((x): x is string => !!x);
  s = s.replace(ERROR_CARD, ' ');
  s = s.replace(THOUGHT, ' ');
  s = s.replace(THOUGHT_TAG, ' ');
  s = s.replace(THINKING_TAG, ' ');
  s = s.replace(COMMENT, ' ');
  s = s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { text: s, error: errors.length ? errors[errors.length - 1] : null };
}

/** The reply with its error (if any) as a closing sentence: what a manager is told an agent answered. */
export function report(raw: string | null | undefined): string {
  const r = reply(raw);
  if (r.error == null) return r.text;
  if (!r.text.trim()) return `Error: ${r.error}`;
  return `${r.text}\n\nError: ${r.error}`;
}

/** The error card's userMessage of a reply ("the provider failed"), when it has one. */
export function errorCardMessage(content: string): string | null {
  if (!content.includes('<!-- error -->')) return null;
  const m = /"userMessage":"((?:[^"\\]|\\.)*)"/.exec(content);
  return m ? m[1] : '';
}
