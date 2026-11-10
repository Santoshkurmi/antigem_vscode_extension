// Ports of the app's PromptExpansion / AttachedFiles helpers: hidden blocks a message carries for the agent only.
import type { ChatAttachment } from '../../shared/model';

const TAG = 'antigem-expansion';
const EXPANSION_BLOCK = /<antigem-expansion command="([^"]*)">[\s\S]*?<\/antigem-expansion>/g;
const ATTACHED_FILES = /<attached-files>[\s\S]*?<\/attached-files>/g;
const ATTACHED_BLOCK = /\s*<attached-files>\n([\s\S]*?)\n?<\/attached-files>\s*/g;
const ATTACHED_LINE = /^- (?:`(.+)`|(\/.+)) \(([^,()]+), (\d+) bytes(?:, ([^()]*))?\)$/;
const ORIGINAL_NOTE = 'full-size original of an image attached above';

function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Hidden expansion blocks back to the command the user typed (empty command = removed). */
export function collapseExpansions(text: string): string {
  if (!text.includes(`<${TAG} `)) return text;
  return text.replace(EXPANSION_BLOCK, (_m, cmd: string) => unescapeAttr(cmd));
}

/** A chat title without the app's hidden blocks (even cut off half-way). */
export function cleanTitle(title: string): string {
  if (!title.includes(`<${TAG}`) && !title.includes('<attached-files>')) return title;
  let t = collapseExpansions(title).replace(ATTACHED_FILES, '');
  const a = t.indexOf(`<${TAG}`);
  if (a >= 0) t = t.slice(0, a);
  const b = t.indexOf('<attached-files>');
  if (b >= 0) t = t.slice(0, b);
  return t.trim();
}

/** Instructions for the model that the chat never shows. */
export function hiddenBlock(body: string): string {
  return `<${TAG} command="${escapeAttr('')}">\n${body}\n</${TAG}>`;
}

export interface FileRef {
  path: string;
  mimeType: string;
  size: number;
  originalOfImage?: boolean;
}

/** The hidden part of a message that hands files to the agent by path (same text as the app). */
export function attachedFilesBlock(refs: FileRef[]): string {
  let s =
    "(Hidden note added by the AntiGem app: it is not part of the user's message and the user does not see it. " +
    'Never quote it, and never use it or its tags for a chat title or summary.)\n' +
    'The user attached these files. They are already on this machine: open them in place with your tools. ' +
    'Do not copy them unless the task really needs a copy.\n' +
    'NEVER modify, move, rename, overwrite or delete these original files, no matter what. ' +
    'If the task needs changes, write the result to a new file and tell the user where it is.\n' +
    'For large files, read them in parts or use tools like head, grep, unzip -l or pdftotext instead of loading the whole file.\n' +
    '<attached-files>\n';
  for (const r of refs) {
    const mime = r.mimeType.replace(/[,()]/g, '').trim() || 'application/octet-stream';
    s += `- \`${r.path}\` (${mime}, ${r.size} bytes${r.originalOfImage ? `, ${ORIGINAL_NOTE}` : ''})\n`;
  }
  s += '</attached-files>';
  return hiddenBlock(s);
}

/** [text] without its hidden file lists, plus the listed files as attachment cards. */
export function extractAttachedFiles(text: string, idPrefix: string): { text: string; cards: ChatAttachment[] } {
  if (!text.includes('<attached-files>')) return { text, cards: [] };
  const cards: ChatAttachment[] = [];
  let i = 0;
  for (const m of text.matchAll(ATTACHED_BLOCK)) {
    for (const line of m[1].split('\n')) {
      const lm = ATTACHED_LINE.exec(line.trim());
      if (!lm) continue;
      if ((lm[5] ?? '').includes(ORIGINAL_NOTE)) continue;
      const p = lm[1] || lm[2];
      cards.push({
        id: `${idPrefix}_file_${i++}`,
        name: p.replace(/\/+$/, '').split('/').pop() || p,
        path: p,
        isImage: false,
        isAudio: false,
        size: Number(lm[4]) || 0,
        mimeType: lm[3].trim(),
        reference: true,
      });
    }
  }
  return { text: text.replace(ATTACHED_BLOCK, '\n\n').trim(), cards };
}

/** What the chat shows for a stored user prompt: hidden blocks collapsed, file lists turned into cards. */
export function displayUserText(raw: string, idPrefix: string): { text: string; cards: ChatAttachment[] } {
  const { text, cards } = extractAttachedFiles(raw, idPrefix);
  return { text: collapseExpansions(text).trim(), cards: [...cards, ...extractSelections(raw, idPrefix)] };
}

// ---- Antigravity voice-call turns (port of the app's VoiceTurn.kt) ----
const VOICE_TAG = 'voice_turn';
const TALKER_TAG_PREFIX = 'voice_talker:';
const VOICE_LINE_RE = /^\s*(?:\[[^\]]*]\s*)?(user|talker):\s*"(.*)"\s*$/;

export function parseVoiceTurn(text: string, tags: string[]): { spoken: string; voiceLine: string | null } | null {
  const t = text.trimStart();
  if (!tags.includes(VOICE_TAG) && !t.startsWith('<voice_instructions>') && !t.startsWith('<talker_agent_context>')) return null;
  const voiceLine = tags.find((x) => x.startsWith(TALKER_TAG_PREFIX))?.slice(TALKER_TAG_PREFIX.length).trim() || null;
  const a = text.indexOf('<talker_agent_context>');
  let context = a >= 0 ? text.slice(a + '<talker_agent_context>'.length) : '';
  const b = context.indexOf('</talker_agent_context>');
  if (b >= 0) context = context.slice(0, b);
  const unescape = (s: string) => s.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\');
  const lines = context
    .split('\n')
    .map((raw) => {
      const m = VOICE_LINE_RE.exec(raw);
      return m ? { user: m[1] === 'user', timed: raw.trimStart().startsWith('['), text: unescape(m[2]).trim().replace(/-$/, '').trim() } : null;
    })
    .filter((x): x is { user: boolean; timed: boolean; text: string } => x != null);
  let end = lines.length;
  while (end > 0 && !lines[end - 1].user) end--;
  let start = end;
  while (start > 0 && lines[start - 1].user) start--;
  const run = lines.slice(start, end).filter((l) => l.text);
  const picked = run.some((l) => l.timed) ? run.filter((l) => l.timed) : run;
  return { spoken: picked.map((l) => l.text).join(' ').trim(), voiceLine };
}

// ---- editor selections sent with a message (VS Code: the selection chip) ----
const SELECTION_RE = /<selection path="([^"]*)" lines="(\d+)-(\d+)"(?: lang="([^"]*)")?>\n([\s\S]*?)\n<\/selection>/g;

/** Hidden block carrying the selected code to the agent; the chat shows it as chips (see extractSelections). */
export function selectionBlock(sel: ChatAttachment[]): string {
  if (!sel.length) return '';
  let body =
    "(Hidden note added by the AntiGem app: code the user selected in their editor and attached to this message. " +
    'The user does not see this note; refer to the code by file and line numbers.)\n';
  for (const s of sel) {
    const lang = (s.languageId ?? '').replace(/"/g, '');
    body += `<selection path="${escapeAttr(s.path)}" lines="${s.lineStart ?? 1}-${s.lineEnd ?? s.lineStart ?? 1}"${lang ? ` lang="${lang}"` : ''}>\n${s.selectionText ?? ''}\n</selection>\n`;
  }
  return `\n\n${hiddenBlock(body.trimEnd())}`;
}

/** Selection chips of a stored prompt (before its hidden blocks are collapsed). */
export function extractSelections(text: string, idPrefix: string): ChatAttachment[] {
  if (!text.includes('<selection ')) return [];
  const out: ChatAttachment[] = [];
  let i = 0;
  for (const m of text.matchAll(SELECTION_RE)) {
    const p = unescapeAttr(m[1]);
    const a = Number(m[2]);
    const b = Number(m[3]);
    out.push({
      id: `${idPrefix}_sel_${i++}`,
      name: `${p.split('/').pop() || p}:${a === b ? a : `${a}-${b}`}`,
      path: p,
      isImage: false,
      isAudio: false,
      size: m[5].length,
      reference: true,
      kind: 'selection',
      lineStart: a,
      lineEnd: b,
      languageId: m[4] ?? null,
      selectionText: m[5],
    });
  }
  return out;
}
