// Secrets never reach memory, and the "capture" step (docs/crew/PLAN.md §12): after a quiet spell the engine asks a
// cheap model for the new facts in the recent conversation (capturePrompt), then files what it answered
// (parseCapture → BotMemory.add with actor 'capture'). No AI runs here.
import { day, entriesOf, normText, slugTopic, splitLines } from './files';

export const CAPTURE_MAX = 8;
const RECENT_MAX = 16 * 1024;
const R = '[redacted]';

/** Secrets recognizable by their shape alone. */
const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic (sk-ant-…) and friends
  /(?<![A-Za-z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /(?<![A-Za-z0-9])xox[abposre]-[A-Za-z0-9-]{10,}/g, // Slack
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, // AWS access key id
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g, // Google
  /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /(?<![A-Za-z0-9])(?:npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|pypi-[A-Za-z0-9_-]{50,})/g,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/g;
/** scheme://user:password@host */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi;
/** A value after a word like token / key / password (decided by secretValue). */
const KEYWORD = /(?<![A-Za-z0-9])(key|token|secret|password|passwd|pwd|passphrase|credentials?)(s?)(?![A-Za-z0-9])(\s*(?:\bis\b|\bwas\b|=>|=|:)\s*|\s+)(["']?)([^\s"'`,;]+)\4/gi;

function secretValue(word: string, sep: string, value: string): boolean {
  const v = value.replace(/[.)\]]+$/, '');
  if (!v || v.startsWith('[')) return false;
  if (/^(?:pass|pwd)/i.test(word)) {
    // "password is hunter2" yes, "password is required" no
    return /[:=]|is|was/i.test(sep) && v.length >= 4 && (/[^A-Za-z]/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v)));
  }
  // a long hex / base64 run with a digit or mixed case ("token abcd1234…"), not a path
  return v.length >= 16 && /^[A-Za-z0-9+/=_-]+$/.test(v) && !v.startsWith('/') && (/\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v)));
}

/** The text with API keys, tokens, passwords and private keys replaced by "[redacted]". */
export function redact(text: string): string {
  let out = text;
  for (const re of SHAPES) out = out.replace(re, R);
  out = out.replace(BEARER, (_all, kind: string) => `${kind} ${R}`);
  out = out.replace(URL_PASSWORD, `$1${R}$3`);
  out = out.replace(KEYWORD, (all, word: string, plural: string, sep: string, quote: string, value: string) =>
    secretValue(word, sep, value) ? `${word}${plural}${sep}${quote}${R}${quote}` : all,
  );
  return out;
}

export const looksSecret = (text: string) => redact(text) !== text;

/** The cheap model's task: the new durable facts in the recent conversation, one per line, or NOTHING. */
export function capturePrompt(botName: string, existingCore: string, recentText: string, now = Date.now()): string {
  const fence = (s: string) => s.replace(/<\/(memory|conversation)>/gi, '[/$1]');
  let recent = recentText.trim();
  if (recent.length > RECENT_MAX) recent = `…${recent.slice(-RECENT_MAX).replace(/^[^\n]*\n/, '')}`;
  return [
    `You keep the long-term memory of ${botName}, an AI agent on a team. Read the recent conversation below and list the NEW facts worth remembering for weeks to come: the user's preferences, decisions that were made, names of people, projects and things, file paths, URLs, commands that work, deadlines and dates.`,
    '',
    'Rules:',
    '- Only facts that are not in the memory below already.',
    '- Never secrets: no passwords, API keys, tokens or private keys.',
    '- No chit-chat, greetings or moods, and no steps of a task that is already done.',
    '- One fact per line, short and complete on its own (it is read later without this conversation): "- fact". A fact about one subject can go in a topic: "- [topic] fact" (one or two lowercase words, like deploy or clients).',
    `- Write dates as YYYY-MM-DD (today is ${day(now)}).`,
    `- At most ${CAPTURE_MAX} lines. When there is nothing new worth keeping, answer exactly: NOTHING`,
    '',
    'Memory already kept:',
    '<memory>',
    fence(existingCore.trim()) || '(empty)',
    '</memory>',
    '',
    'Recent conversation:',
    '<conversation>',
    fence(recent),
    '</conversation>',
  ].join('\n');
}

export interface CaptureFact {
  text: string;
  topic?: string;
}

const ITEM = /^(?:[-*+•]|\d{1,2}[.)])\s+(.*)$/;
const PREAMBLE = /^(?:here|these|the following|new facts?|facts?|nothing)\b/i;
/** Topic names that mean "no topic". */
const GENERAL = new Set(['general', 'core', 'misc', 'other', 'none', 'memory', 'facts', 'fact']);

/**
 * The facts in the cheap model's answer: list lines ("- fact", "- [topic] fact"); plain lines only when there are no
 * list lines. Leaves out secrets, repeats, and facts the existing core memory (its text, as core() gives it) has.
 */
export function parseCapture(reply: string, existingCore = ''): CaptureFact[] {
  const lines = reply
    .replace(/```[\w-]*/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length || /^\**nothing\**[.!]?$/i.test(lines[0])) return [];
  const items = lines.map((l) => ITEM.exec(l)?.[1]?.trim()).filter((l): l is string => !!l);
  const pool = items.length ? items : lines.filter((l) => !l.endsWith(':') && !l.endsWith('?') && !PREAMBLE.test(l));
  const known = entriesOf(splitLines(existingCore)).map((e) => normText(e.text));
  const seen = new Set<string>();
  const out: CaptureFact[] = [];
  for (const raw of pool) {
    let text = raw;
    let topic: string | undefined;
    const t = /^\[([^\]]{1,40})\]\s*:?\s*(.*)$/.exec(text);
    if (t) {
      const slug = slugTopic(t[1]);
      topic = slug && !GENERAL.has(slug) ? slug : undefined;
      text = t[2];
    }
    text = text
      .replace(/^\*\*(.+)\*\*$/, '$1')
      .replace(/^["'“]+|["'”]+$/g, '')
      .trim()
      .slice(0, 500);
    if (text.length < 4 || /^nothing\b/i.test(text) || looksSecret(text)) continue;
    const n = normText(text);
    if (seen.has(n) || known.some((k) => k === n || (n.length >= 12 && k.includes(n)))) continue;
    seen.add(n);
    out.push(topic ? { text, topic } : { text });
    if (out.length >= CAPTURE_MAX) break;
  }
  return out;
}
