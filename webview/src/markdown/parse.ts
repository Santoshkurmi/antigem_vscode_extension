// Port of parseMarkdownBlocks() from the app's ui/components/MarkdownContent.kt.
// Line based, like the app: every non-blank line that is not part of a bigger construct is its own paragraph block.
// Tool cards are referenced by id (resolved from message.toolCalls at render time), so a tool's status change does
// not need a re-parse. parseIncremental() re-parses only the tail of a streaming message.
import type { ToolCall } from '@shared/model';

export type AlertType = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION';
export type Align = 'left' | 'center' | 'right';

export interface AgentErrorBlock {
  t: 'error';
  title: string;
  userMessage: string;
  shortError: string;
  fullError: string;
  errorCode: number | null;
  errorId: string;
  rawJson: string;
  action: string | null;
}

export type Block =
  | { t: 'p'; text: string }
  | { t: 'alert'; kind: AlertType; title: string | null; text: string }
  | { t: 'thought'; thought: string; durationMs: number | null; streaming: boolean }
  /** A tool card: `id` of a call in message.toolCalls, or a synthetic call built from an inline tag. */
  | { t: 'tool'; id: string; synthetic?: ToolCall }
  | AgentErrorBlock
  | { t: 'h'; level: number; text: string }
  | { t: 'li'; indent: number; text: string }
  | { t: 'ol'; num: string; text: string }
  | { t: 'task'; checked: boolean; text: string }
  | { t: 'quote'; text: string }
  /** `open`: the closing fence has not arrived (yet). */
  | { t: 'code'; lang: string; code: string; open: boolean }
  | { t: 'math'; latex: string; display: boolean }
  | { t: 'mermaid'; code: string }
  | { t: 'ui'; html: string; title: string }
  | { t: 'img'; alt: string; url: string }
  | { t: 'video'; alt: string; url: string }
  | { t: 'yt'; videoId: string; url: string; title: string; thumb: string | null }
  | { t: 'details'; summary: string; body: string; open: boolean }
  | { t: 'table'; headers: string[]; rows: string[][]; align: Align[] }
  | { t: 'hr' };

const THOUGHT_START = /<(?:!--\s*)?thought(?:[:\s]+(streaming))?(?:[:\s]+(?:duration=)?["']?([0-9]+)["']?)?(?:\s*--)?>/i;
const THOUGHT_START_G = new RegExp(THOUGHT_START.source, 'gi');
const THOUGHT_END_G = /<(?:!--\s*)?\/thought(?:\s*--)?>/gi;
const ERROR_START = /<(?:!--\s*)?error(?:[:\s]+([a-zA-Z0-9_-]+))?(?:\s*--)?>/i;
const ERROR_START_G = new RegExp(ERROR_START.source, 'gi');
const ERROR_END_G = /<(?:!--\s*)?\/error(?:\s*--)?>/gi;
const TOOL_MARKER = /<!--\s*tool_call:([a-zA-Z0-9_-]+)\s*-->/;
const UNIFIED_TOOL = /<tool_call\s+name=["']?([a-zA-Z0-9_-]+)["']?\s*>([\s\S]*?)<\/tool_call>/i;
const CHOICE = /<(ask_choices|user_choice)>([\s\S]*?)<\/(ask_choices|user_choice)>/;
const EXEC_CMD = /<execute_command>([\s\S]*?)<\/execute_command>/;
const WEB_SEARCH = /<web_search>([\s\S]*?)<\/web_search>/;
const READ_URL = /<read_url>([\s\S]*?)<\/read_url>/;
const VIDEO_OPEN_TAG = /<video\b[^>]*>/i;
const SOURCE_TAG_G = /<source\b[^>]*>/gi;
const HTML_SRC_ATTR = /\bsrc\s*=\s*["']([^"']+)["']/i;
const HTML_TITLE_ATTR = /\b(title|aria-label)\s*=\s*["']([^"']*)["']/i;
const CHAT_TITLE_G = /<chat_title>[\s\S]*?<\/chat_title>\s*/gi;
const INFLIGHT_CHAT_TITLE = /<\s*chat_title[\s\S]*/i;
const DURATION = /(?:duration=|:)([0-9]+)/i;
const LINKED_IMAGE = /^\s*\[!\[(.*?)\]\((.*?)\)\]\((.*?)\)\s*$/i;
const VIDEO_LINK = /^\s*!?\[(.*?)\]\(([^\s)]+\.(?:mp4|webm|mov|m4v|3gp)(?:\?[^\s)]*)?)\)\s*$/i;
const IMAGE = /^\s*!\[(.*?)\]\(((?:https?:\/\/|file:\/\/|content:\/\/|data:image\/)[^\s)]+)\)\s*$/i;
const LINK_IMG = /^\s*!?\[(.*?)\]\(([^\s)]+\.(?:png|jpe?g|webp|gif|svg)(?:\?[^\s)]*)?)\)\s*$/i;
const BARE_IMAGE = /^\s*((?:https?:\/\/|file:\/\/)\S+\.(?:png|jpe?g|webp|gif|svg)(?:\?\S*)?)\s*$/i;
const HEADER = /^(#{1,6})\s+(.*)/;
const TASK = /^[-*]\s+\[([ xX])\]\s+(.*)/;
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO)\](.*)/i;
const ALERT_LINE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO)\](\s+.*)?$/i;
const NUMBERED = /^(\d+\.)\s+(.*)/;
const YT = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/|img\.youtube\.com\/vi\/)([a-zA-Z0-9_-]{11})/i;

const UI_LANGS = new Set(['interactive_ui', 'interactive_app', 'html_app', 'canvas_app', 'widget', 'ui', 'mini_app']);
const UI_TOOL_NAMES = new Set(['interactive_ui', 'render_ui', 'create_interactive_app', 'interactive_app']);

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function trimStart(s: string) {
  return s.replace(/^\s+/, '');
}

function ytId(url: string): string | null {
  return YT.exec(url)?.[1] ?? null;
}

function alertKind(tag: string): AlertType {
  switch (tag.toUpperCase()) {
    case 'TIP':
      return 'TIP';
    case 'IMPORTANT':
      return 'IMPORTANT';
    case 'WARNING':
      return 'WARNING';
    case 'CAUTION':
      return 'CAUTION';
    default:
      return 'NOTE';
  }
}

export function parseErrorPayload(raw: string): AgentErrorBlock {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const j = JSON.parse(trimmed);
      const s = (v: unknown) => (v == null ? '' : String(v));
      return {
        t: 'error',
        title: j.title != null ? s(j.title) : 'Agent Execution Error',
        userMessage: s(j.userMessage),
        shortError: s(j.shortError),
        fullError: s(j.fullError),
        errorCode: typeof j.errorCode === 'number' ? j.errorCode : j.errorCode != null && !isNaN(+j.errorCode) ? +j.errorCode : null,
        errorId: s(j.errorId),
        rawJson: s(j.rawJson),
        action: j.action != null ? s(j.action) : null,
      };
    } catch {
      /* not JSON: plain text below */
    }
  }
  const clean = raw.replace(/^⚠️/, '').trim();
  const lines = splitLines(clean);
  const firstLine = lines[0] ?? 'Agent Execution Error';
  const rest = lines.length > 1 ? lines.slice(1).join('\n').trim() : '';
  const isStack = /stack trace/i.test(rest) || /Wraps:/i.test(rest);
  return {
    t: 'error',
    title: firstLine.length < 50 ? firstLine : 'Execution Notice',
    userMessage: firstLine.length >= 50 ? firstLine : rest && !isStack ? rest : firstLine,
    shortError: rest && !isStack ? rest : firstLine.length >= 50 ? firstLine : '',
    fullError: isStack ? rest : /stack trace/i.test(clean) ? clean : '',
    errorCode: null,
    errorId: '',
    rawJson: '',
    action: null,
  };
}

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.substring(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.substring(0, t.length - 1);
  return t
    .replace(/\\\|/g, '\u0000')
    .split('|')
    .map((c) => c.replace(/\u0000/g, '|').trim());
}

function parseTable(lines: string[], start: number): [Block, number] | null {
  if (start + 1 >= lines.length) return null;
  const headerLine = lines[start].trim();
  const sepLine = lines[start + 1].trim();
  if (!headerLine.includes('|') || !sepLine.includes('|')) return null;
  const sepCells = splitTableRow(sepLine);
  if (!sepCells.length || !sepCells.every((c) => /^:?-+:?$/.test(c.replace(/ /g, '')))) return null;
  const rawHeaders = splitTableRow(headerLine);
  const aligns: Align[] = sepCells.map((c) => {
    const x = c.replace(/ /g, '');
    const l = x.startsWith(':');
    const r = x.endsWith(':');
    return l && r ? 'center' : r ? 'right' : 'left';
  });
  const n = Math.max(rawHeaders.length, sepCells.length);
  const pad = <T,>(a: T[], fill: T) => (a.length < n ? [...a, ...Array(n - a.length).fill(fill)] : a.slice(0, n));
  const headers = rawHeaders.length ? pad(rawHeaders, '') : Array.from({ length: n }, (_, i) => `Column ${i + 1}`);
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const row = lines[i].trim();
    if (!row || !row.includes('|')) break;
    const cells = splitTableRow(row);
    if (!cells.length) break;
    rows.push(pad(cells, ''));
    i++;
  }
  return [{ t: 'table', headers, rows, align: pad(aligns, 'left' as Align) }, i];
}

interface ToolIndex {
  calls: ToolCall[];
}

function syntheticTool(name: string, command: string, status: string): ToolCall {
  return {
    id: `syn_${name}_${hash(command)}`,
    name,
    toolType: toolTypeOf(name),
    command,
    status,
    output: '',
  };
}

function toolTypeOf(name: string): ToolCall['toolType'] {
  switch (name) {
    case 'web_search':
      return 'SEARCH_WEB';
    case 'read_url':
      return 'READ_URL';
    case 'ask_choices':
    case 'user_choice':
      return 'ASK_CHOICE';
    default:
      return 'BASH';
  }
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Parses lines[from..] into blocks; `starts` gets each block's first line. Mirrors the app's parser branch by branch.
 * Orphan tool calls are NOT appended here (see finishBlocks).
 */
function parseLines(lines: string[], from: number, tools: ToolIndex, out: Block[], starts: number[], handledIds: Set<string>) {
  let i = from;
  const push = (b: Block, line: number) => {
    out.push(b);
    starts.push(line);
  };
  while (i < lines.length) {
    const line = lines[i];
    const at = i;

    if (line.includes('<')) {
      // structured agent error <!-- error -->…<!-- /error -->
      if (ERROR_START.test(line)) {
        const closes = (l: string) => /<\/error>/i.test(l) || l.includes('<!-- /error -->');
        if (closes(line)) {
          const raw = line.replace(ERROR_START_G, '').replace(ERROR_END_G, '').trim();
          if (raw) push(parseErrorPayload(raw), at);
          i++;
          continue;
        }
        const errLines: string[] = [];
        const first = line.replace(ERROR_START_G, '').trim();
        if (first) errLines.push(first);
        i++;
        while (i < lines.length) {
          const cur = lines[i];
          if (closes(cur)) {
            const end = cur.replace(ERROR_END_G, '').trim();
            if (end) errLines.push(end);
            i++;
            break;
          }
          errLines.push(cur);
          i++;
        }
        const payload = errLines.join('\n').trim();
        if (payload) push(parseErrorPayload(payload), at);
        continue;
      }

      // thought <!-- thought[:streaming][:duration] -->…<!-- /thought -->
      const tm = THOUGHT_START.exec(line);
      if (tm) {
        const explicitStreaming = /:streaming/i.test(line) || / streaming/i.test(line);
        const dm = DURATION.exec(line);
        const durationMs = dm ? +dm[1] : tm[2] ? +tm[2] : null;
        const closes = (l: string) => /<\/thought>/i.test(l) || l.includes('<!-- /thought -->');
        if (closes(line)) {
          const raw = line.replace(THOUGHT_START_G, '').replace(THOUGHT_END_G, '').trim();
          if (raw) push({ t: 'thought', thought: raw, durationMs, streaming: explicitStreaming }, at);
          i++;
          continue;
        }
        const tl: string[] = [];
        const first = line.replace(THOUGHT_START_G, '').trim();
        if (first) tl.push(first);
        i++;
        let closed = false;
        while (i < lines.length) {
          const cur = lines[i];
          if (closes(cur)) {
            const end = cur.replace(THOUGHT_END_G, '').trim();
            if (end) tl.push(end);
            closed = true;
            i++;
            break;
          }
          tl.push(cur);
          i++;
        }
        const thought = tl.join('\n').trim();
        if (thought) push({ t: 'thought', thought, durationMs, streaming: explicitStreaming || !closed }, at);
        else if (!closed || explicitStreaming) push({ t: 'thought', thought: 'Thinking...', durationMs, streaming: true }, at);
        continue;
      }

      // inline tool call marker <!-- tool_call:ID -->
      const mm = TOOL_MARKER.exec(line);
      if (mm) {
        const toolId = mm[1];
        const step = toolId.substring(toolId.lastIndexOf('_') + 1);
        const match =
          tools.calls.find((c) => c.id === toolId) ??
          tools.calls.find((c) => !handledIds.has(c.id) && c.id.substring(c.id.lastIndexOf('_') + 1) === step);
        if (match) {
          handledIds.add(match.id);
          push({ t: 'tool', id: match.id }, at);
        }
        i++;
        continue;
      }

      const um = UNIFIED_TOOL.exec(line);
      if (um) {
        const name = um[1].trim().toLowerCase();
        const payload = um[2].trim();
        if (UI_TOOL_NAMES.has(name)) {
          push({ t: 'ui', html: payload, title: 'Interactive App' }, at);
          i++;
          continue;
        }
        const match = tools.calls.find((c) => c.command === payload);
        if (match) {
          handledIds.add(match.id);
          push({ t: 'tool', id: match.id }, at);
        } else {
          const syn = syntheticTool(name, payload, name === 'ask_choices' ? 'AWAITING_CHOICE' : 'RUNNING');
          push({ t: 'tool', id: syn.id, synthetic: syn }, at);
        }
        i++;
        continue;
      }

      const tagged: [RegExp, (m: RegExpExecArray) => [string, string, string]][] = [
        [CHOICE, (m) => ['ask_choices', m[2].trim(), 'AWAITING_CHOICE']],
        [EXEC_CMD, (m) => ['', m[1].trim(), 'RUNNING']],
        [WEB_SEARCH, (m) => ['web_search', m[1].trim(), 'RUNNING']],
        [READ_URL, (m) => ['read_url', m[1].trim(), 'RUNNING']],
      ];
      let tagHit = false;
      for (const [re, fn] of tagged) {
        const m = re.exec(line);
        if (!m) continue;
        const [name, cmd, status] = fn(m);
        const match = tools.calls.find(
          (c) => c.command === cmd && (name === '' || c.name === name || (name === 'ask_choices' && c.name === 'user_choice')),
        );
        if (match) {
          handledIds.add(match.id);
          push({ t: 'tool', id: match.id }, at);
        } else {
          const syn = syntheticTool(name || 'run_command', cmd, status);
          push({ t: 'tool', id: syn.id, synthetic: syn }, at);
        }
        i++;
        tagHit = true;
        break;
      }
      if (tagHit) continue;
    }

    // ⚠️ notice
    if (trimStart(line).startsWith('⚠️')) {
      const el = [trimStart(line)];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !lines[i].startsWith('#') &&
        !lines[i].startsWith('<') &&
        !lines[i].startsWith('```') &&
        !lines[i].startsWith('$$')
      ) {
        el.push(lines[i]);
        i++;
      }
      push(parseErrorPayload(el.join('\n').trim()), at);
      continue;
    }

    const ts = trimStart(line);

    // $$ math
    if (ts.startsWith('$$')) {
      const firstContent = ts.substring(2);
      if (firstContent.endsWith('$$') && firstContent.length >= 2) {
        push({ t: 'math', latex: firstContent.slice(0, -2).trim(), display: true }, at);
        i++;
        continue;
      }
      const ml: string[] = [];
      if (firstContent.trim()) ml.push(firstContent);
      i++;
      while (i < lines.length && !lines[i].includes('$$')) {
        ml.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        const last = lines[i].substring(0, lines[i].indexOf('$$')).trim();
        if (last) ml.push(last);
      }
      push({ t: 'math', latex: ml.join('\n').trim(), display: true }, at);
      i++;
      continue;
    }

    // \[ math
    if (ts.startsWith('\\[')) {
      const firstContent = ts.substring(2);
      if (firstContent.includes('\\]')) {
        push({ t: 'math', latex: firstContent.substring(0, firstContent.indexOf('\\]')).trim(), display: true }, at);
        i++;
        continue;
      }
      const ml: string[] = [];
      if (firstContent.trim()) ml.push(firstContent);
      i++;
      while (i < lines.length && !lines[i].includes('\\]')) {
        ml.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        const last = lines[i].substring(0, lines[i].indexOf('\\]')).trim();
        if (last) ml.push(last);
      }
      push({ t: 'math', latex: ml.join('\n').trim(), display: true }, at);
      i++;
      continue;
    }

    // ``` fenced code
    if (ts.startsWith('```')) {
      const lang = ts.substring(3).trim();
      const cl: string[] = [];
      i++;
      while (i < lines.length && !trimStart(lines[i]).startsWith('```')) {
        cl.push(lines[i]);
        i++;
      }
      const open = i >= lines.length;
      const l = lang.toLowerCase();
      if (l === 'math' || l === 'latex' || l === 'katex') push({ t: 'math', latex: cl.join('\n'), display: true }, at);
      else if (l === 'mermaid') push({ t: 'mermaid', code: cl.join('\n').trim() }, at);
      else if (UI_LANGS.has(l)) push({ t: 'ui', html: cl.join('\n').trim(), title: 'Interactive App' }, at);
      else push({ t: 'code', lang, code: cl.join('\n'), open }, at);
      i++;
      continue;
    }

    // <details><summary>
    if (/^<details/i.test(ts)) {
      const open = /open/i.test(line);
      let summary = 'Details';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^<\/details>/i.test(trimStart(lines[i]))) {
        const cur = lines[i];
        if (/^<summary>/i.test(trimStart(cur))) summary = cur.replace(/<\/?summary>/gi, '').trim();
        else body.push(cur);
        i++;
      }
      push({ t: 'details', summary, body: body.join('\n').trim(), open }, at);
      i++;
      continue;
    }

    // <video>
    if (/^<video/i.test(ts)) {
      let end = i;
      while (end < lines.length && end - i < 20 && !/<\/video>/i.test(lines[end])) end++;
      if (end >= lines.length || end - i >= 20) end = i;
      const html = lines.slice(i, end + 1).join('\n');
      const openTag = VIDEO_OPEN_TAG.exec(html)?.[0] ?? '';
      let src = HTML_SRC_ATTR.exec(openTag)?.[1] ?? null;
      if (!src) {
        for (const s of html.match(SOURCE_TAG_G) ?? []) {
          const m = HTML_SRC_ATTR.exec(s);
          if (m) {
            src = m[1];
            break;
          }
        }
      }
      if (src && src.trim()) {
        push({ t: 'video', alt: HTML_TITLE_ATTR.exec(openTag)?.[2] ?? '', url: src.trim() }, at);
        i = end + 1;
        continue;
      }
    }

    // [![alt](img)](link)
    let m = LINKED_IMAGE.exec(line);
    if (m) {
      const [, alt, imgUrl, linkUrl] = m;
      const id = ytId(linkUrl) ?? ytId(imgUrl);
      if (id) push({ t: 'yt', videoId: id, url: linkUrl || `https://www.youtube.com/watch?v=${id}`, title: alt || 'YouTube Video', thumb: imgUrl || null }, at);
      else push({ t: 'img', alt, url: imgUrl }, at);
      i++;
      continue;
    }
    m = VIDEO_LINK.exec(line);
    if (m) {
      push({ t: 'video', alt: m[1], url: m[2] }, at);
      i++;
      continue;
    }
    m = IMAGE.exec(line);
    if (m) {
      const [, alt, url] = m;
      const id = ytId(url);
      if (id)
        push({
          t: 'yt',
          videoId: id,
          url: url.includes('youtube.com/watch') || url.includes('youtu.be') ? url : `https://www.youtube.com/watch?v=${id}`,
          title: alt || 'YouTube Video',
          thumb: url.includes('img.youtube.com') ? url : null,
        }, at);
      else push({ t: 'img', alt, url }, at);
      i++;
      continue;
    }
    m = LINK_IMG.exec(line);
    if (m) {
      push({ t: 'img', alt: m[1], url: m[2] }, at);
      i++;
      continue;
    }
    m = BARE_IMAGE.exec(line);
    if (m) {
      push({ t: 'img', alt: '', url: m[1] }, at);
      i++;
      continue;
    }

    // GFM table
    if (line.includes('|') && i + 1 < lines.length) {
      const tr = parseTable(lines, i);
      if (tr) {
        push(tr[0], at);
        i = tr[1];
        continue;
      }
    }

    const hm = HEADER.exec(ts);
    if (hm) {
      push({ t: 'h', level: hm[1].length, text: hm[2].trim() }, at);
    } else if (/^[-*]\s+\[([ xX])\]\s+.*/.test(ts)) {
      const tk = TASK.exec(ts);
      if (tk) push({ t: 'task', checked: tk[1].trim().toLowerCase() === 'x', text: tk[2].trim() }, at);
      else push({ t: 'p', text: line }, at);
    } else if (ts.startsWith('>')) {
      const ql = [ts.substring(1).trim()];
      i++;
      while (i < lines.length && trimStart(lines[i]).startsWith('>')) {
        ql.push(trimStart(lines[i]).substring(1).trim());
        i++;
      }
      const am = ALERT.exec(ql[0] ?? '');
      if (am) {
        const body: string[] = [];
        if (am[2].trim()) body.push(am[2].trim());
        if (ql.length > 1) body.push(...ql.slice(1));
        push({ t: 'alert', kind: alertKind(am[1]), title: null, text: body.join('\n').trim() }, at);
      } else {
        push({ t: 'quote', text: ql.join('\n').trim() }, at);
      }
      continue;
    } else if (ALERT_LINE.test(ts)) {
      const am = ALERT.exec(ts)!;
      const body: string[] = [];
      if (am[2].trim()) body.push(am[2].trim());
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !lines[i].startsWith('#') &&
        !lines[i].startsWith('```') &&
        !lines[i].startsWith('>') &&
        !lines[i].startsWith('<') &&
        !/^[-*]\s+.*/.test(lines[i]) &&
        !/^\d+\.\s+.*/.test(lines[i])
      ) {
        body.push(lines[i].trim());
        i++;
      }
      push({ t: 'alert', kind: alertKind(am[1]), title: null, text: body.join('\n').trim() }, at);
      continue;
    } else if (line.trim() === '---' || line.trim() === '***' || line.trim() === '___') {
      push({ t: 'hr' }, at);
    } else if (/^\d+\.\s+.*/.test(ts)) {
      const nm = NUMBERED.exec(ts);
      if (nm) push({ t: 'ol', num: nm[1], text: nm[2] }, at);
      else push({ t: 'p', text: line }, at);
    } else if (ts.startsWith('- ') || ts.startsWith('* ') || ts.startsWith('+ ')) {
      const lead = /^[ \t]*/.exec(line)![0].length;
      push({ t: 'li', indent: Math.min(3, Math.max(0, Math.floor(lead / 2))), text: ts.substring(2).trim() }, at);
    } else if (line.trim()) {
      push({ t: 'p', text: line }, at);
    }
    i++;
  }
}

/** Tool calls the text never placed get their card at the end (as the app does). */
function finishBlocks(blocks: Block[], calls: ToolCall[]): Block[] {
  const handled = blocks.filter((b): b is Extract<Block, { t: 'tool' }> => b.t === 'tool');
  const handledIds = new Set(handled.map((b) => b.id));
  // a call the text showed through an inline tag (<execute_command> …) already has its card
  const synthetic = handled.map((b) => b.synthetic).filter((x): x is ToolCall => !!x);
  const out = blocks.slice();
  for (const c of calls) {
    if (handledIds.has(c.id)) continue;
    const covered = synthetic.some(
      (h) => normalizeToolName(h.name) === normalizeToolName(c.name) && (h.command === c.command || !h.command || !c.command),
    );
    if (!covered) out.push({ t: 'tool', id: c.id });
  }
  return out;
}

function normalizeToolName(n: string): string {
  return (n || '').toLowerCase().replace(/^tool_/, '').replace(/[^a-z0-9]/g, '');
}

export function cleanContent(raw: string): string {
  if (!raw.includes('<')) return raw;
  return raw.replace(CHAT_TITLE_G, '').replace(INFLIGHT_CHAT_TITLE, '');
}

export function parseBlocks(raw: string, calls: ToolCall[] = []): Block[] {
  const out: Block[] = [];
  parseLines(splitLines(cleanContent(raw)), 0, { calls }, out, [], new Set());
  return finishBlocks(out, calls);
}

// ---------------------------------------------------------------------------------------------- incremental

interface CacheEntry {
  text: string;
  toolKey: string;
  /** Blocks from the text only (no orphan tools), with their first line. */
  body: Block[];
  starts: number[];
  result: Block[];
}

const cache = new Map<string, CacheEntry>();

function sameBlock(a: Block, b: Block): boolean {
  if (a === b) return true;
  if (a.t !== b.t) return false;
  // blocks are small plain objects; tables/code compare by their strings
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Blocks of a message, re-using the previous parse: when the new text only grew (streaming), everything before the
 * last two blocks is kept and only the tail is parsed again. Unchanged blocks keep their object identity, so the
 * view never re-renders them.
 */
export function parseIncremental(key: string, raw: string, calls: ToolCall[]): Block[] {
  const text = cleanContent(raw);
  const toolKey = calls.map((c) => c.id + '\u0001' + c.name + '\u0001' + c.command).join('\u0002');
  const prev = cache.get(key);
  if (prev && prev.text === text && prev.toolKey === toolKey) return prev.result;

  const lines = splitLines(text);
  let body: Block[] = [];
  let starts: number[] = [];
  const handled = new Set<string>();
  if (prev && prev.toolKey === toolKey && text.startsWith(prev.text) && prev.body.length > 2) {
    // keep everything before the last two blocks (a table header turns from a paragraph into a table only when the
    // separator line arrives, so the block before the last can still change)
    const keep = prev.body.length - 2;
    body = prev.body.slice(0, keep);
    starts = prev.starts.slice(0, keep);
    for (const b of body) if (b.t === 'tool') handled.add(b.id);
    parseLines(lines, prev.starts[keep], { calls }, body, starts, handled);
  } else {
    parseLines(lines, 0, { calls }, body, starts, handled);
  }

  // keep object identity of unchanged blocks
  if (prev) {
    for (let i = 0; i < body.length && i < prev.body.length; i++) {
      if (sameBlock(prev.body[i], body[i])) body[i] = prev.body[i];
    }
  }
  let result = finishBlocks(body, calls);
  if (prev) {
    for (let i = body.length; i < result.length; i++) {
      const old = prev.result[i];
      if (old && sameBlock(old, result[i])) result[i] = old;
    }
    if (result.length === prev.result.length && result.every((b, i) => b === prev.result[i])) result = prev.result;
  }
  cache.set(key, { text, toolKey, body, starts, result });
  if (cache.size > 400) cache.delete(cache.keys().next().value!);
  return result;
}

export function dropParseCache(key: string) {
  cache.delete(key);
}
