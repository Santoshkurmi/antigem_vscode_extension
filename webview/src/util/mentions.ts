// `@file` mentions: the composer shows a short `@client.js` while the message carries the workspace path
// (`@src/api/client.js`), so the agent knows exactly which file; the chat shows that path short again.

/** A file picked with `@` in the composer: shown as `@label`, sent as `@rel`. */
export interface Mention {
  label: string;
  rel: string;
}

/** `@path` as written in a message (quoted when the path has spaces). */
export const mentionToken = (p: string) => `@${/\s/.test(p) ? `"${p}"` : p}`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// what may follow a mention: the end, a space, punctuation
const AFTER = `(?=$|[\\s.,;:!?)\\]}'"])`;

/** The last part of a path: `client.js`, a folder as `chart/`. */
export function shortName(rel: string): string {
  const folder = rel.endsWith('/');
  const name = rel.replace(/\/+$/, '').split('/').pop() || rel;
  return folder ? `${name}/` : name;
}

/**
 * The label for [rel]: its file name, or as many folders before it as tell it apart from another picked file of the
 * same name (`api/index.ts` next to `ui/index.ts`). An already picked file keeps its label.
 */
export function mentionLabel(rel: string, taken: Mention[]): string {
  const same = taken.find((m) => m.rel === rel);
  if (same) return same.label;
  const folder = rel.endsWith('/');
  const segs = rel.replace(/\/+$/, '').split('/');
  for (let n = 1; n <= segs.length; n++) {
    const label = segs.slice(-n).join('/') + (folder ? '/' : '');
    if (!taken.some((m) => m.label === label)) return label;
  }
  return rel;
}

/** A regex for the `@label` tokens of [mentions] (longest first), group 1 = what came before, group 2 = the token. */
function tokensRe(mentions: Mention[]): RegExp | null {
  if (!mentions.length) return null;
  const alts = [...mentions]
    .sort((a, b) => b.label.length - a.label.length)
    .map((m) => escapeRe(mentionToken(m.label)))
    .join('|');
  return new RegExp(`(^|\\s)(${alts})${AFTER}`, 'g');
}

/** The text as sent: each picked `@label` becomes `@rel` (anything else typed after `@` stays as it is). */
export function expandMentions(text: string, mentions: Mention[]): string {
  const re = tokensRe(mentions);
  if (!re) return text;
  const byToken = new Map(mentions.map((m) => [mentionToken(m.label), m]));
  return text.replace(re, (_x, pre: string, tok: string) => pre + mentionToken(byToken.get(tok)!.rel));
}

/** The composer text in parts, the picked `@label` tokens marked (for the highlight layer behind the box). */
export function splitPicked(text: string, mentions: Mention[]): { t: string; rel?: string }[] {
  const re = tokensRe(mentions);
  if (!re) return [{ t: text }];
  const byToken = new Map(mentions.map((m) => [mentionToken(m.label), m]));
  const parts: { t: string; rel?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[1].length;
    if (start > last) parts.push({ t: text.substring(last, start) });
    parts.push({ t: m[2], rel: byToken.get(m[2])!.rel });
    last = start + m[2].length;
  }
  if (last < text.length) parts.push({ t: text.substring(last) });
  return parts;
}

/**
 * The `@path` mentions in a message: a token after `@` that has a `/` or ends in a file extension (`@src/a.ts`,
 * `@package.json`, `@"my docs/a b.md"`). Trailing punctuation is not part of the path.
 */
export function findPathMentions(text: string): { start: number; end: number; rel: string }[] {
  const out: { start: number; end: number; rel: string }[] = [];
  for (const m of text.matchAll(/(^|\s)@(?:"([^"\n]+)"|([^\s"@]+))/g)) {
    const start = m.index! + m[1].length;
    let rel = m[2] ?? m[3];
    let end = start + 1 + (m[2] != null ? m[2].length + 2 : m[3].length);
    if (m[3] != null) {
      const trail = /[.,;:!?)\]}'"]+$/.exec(rel);
      if (trail) {
        rel = rel.slice(0, -trail[0].length);
        end -= trail[0].length;
      }
    }
    if (!rel || !(rel.includes('/') || /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(rel))) continue;
    out.push({ start, end, rel });
  }
  return out;
}

/** [text] with each `@path` as `@name` (a one-line preview, e.g. a queued message). */
export function shortMentionText(text: string): string {
  const found = findPathMentions(text);
  let out = '';
  let last = 0;
  for (const f of found) {
    out += text.substring(last, f.start) + `@${shortName(f.rel)}`;
    last = f.end;
  }
  return out + text.substring(last);
}

/** Text put into the composer (an edited prompt, inserted text): its `@path`s shown short again, and remembered. */
export function shortenMentions(text: string, taken: Mention[]): { text: string; mentions: Mention[] } {
  const found = findPathMentions(text);
  if (!found.length) return { text, mentions: taken };
  const mentions = [...taken];
  let out = '';
  let last = 0;
  for (const f of found) {
    const label = mentionLabel(f.rel, mentions);
    if (!mentions.some((m) => m.rel === f.rel)) mentions.push({ label, rel: f.rel });
    out += text.substring(last, f.start) + mentionToken(label);
    last = f.end;
  }
  return { text: out + text.substring(last), mentions };
}
