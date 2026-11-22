// What a bot turn did, read from its tool calls (engine-neutral ToolCall types): commands with exit codes, files it
// changed, failures, calls that reach outside. Rooms show it as a one-line digest under the bot's words ("[What Grit
// did: ran 3 commands, edited api.ts]"); job reports (Phase 3) carry it as the observed facts next to the bot's own
// account.
import path from 'node:path';
import type { ToolCall } from '../../../../shared/model';
import type { Evidence } from '../types';

/** MCP tools that send something out of the machine (asked in every access mode, Phase 4). */
export const OUTWARD_TOOL = /(^|[_\W])(send|post|publish|push|tweet|mail|email|message|reply|comment|pay|transfer|deploy|merge|create_pull|create_issue|upload)([_\W]|$)/i;
const CREW_TOOL = /(^|__|_)crew_[a-z]+$/i;

export function emptyEvidence(): Evidence {
  return { commands: [], filesChanged: [], filesRead: 0, searches: 0, web: 0, toolCalls: 0, failedCalls: 0, errors: [], outward: [] };
}

const failed = (c: ToolCall) => c.status === 'FAILED' || (typeof c.exitCode === 'number' && c.exitCode !== 0);

/** The paths an edit call changed (Claude: one path; Codex: "a.ts, b.ts"; OpenCode: a path or a title). */
function editedPaths(c: ToolCall): string[] {
  const raw = (c.command || '').trim();
  if (!raw || /^edit files$/i.test(raw)) return [];
  return raw
    .split(/,\s+/)
    .map((p) => p.trim())
    .filter((p) => p && p.length < 300 && !/\s{2,}/.test(p));
}

export function evidenceOf(calls: ToolCall[]): Evidence {
  const e = emptyEvidence();
  const files = new Set<string>();
  for (const c of calls) {
    const name = c.name || '';
    if (c.toolType === 'MCP' && CREW_TOOL.test(name)) continue;
    if (c.toolType === 'ASK_CHOICE' || c.toolType === 'SYSTEM_NOTIFICATION') continue;
    e.toolCalls++;
    const bad = failed(c);
    if (bad) {
      e.failedCalls++;
      if (e.errors.length < 3) e.errors.push(`${name || c.toolType}: ${firstLine(c.output || c.command || 'failed')}`.slice(0, 200));
    }
    switch (c.toolType) {
      case 'BASH':
        e.commands.push({ cmd: (c.command || '').slice(0, 300), exit: typeof c.exitCode === 'number' ? c.exitCode : c.status === 'SUCCESS' ? 0 : null, ok: !bad && c.status !== 'RUNNING' });
        break;
      case 'EDIT_FILE':
        if (!bad) for (const p of editedPaths(c)) files.add(p);
        break;
      case 'VIEW_FILE':
        e.filesRead++;
        break;
      case 'GREP_SEARCH':
      case 'FIND':
      case 'LIST_DIR':
        e.searches++;
        break;
      case 'SEARCH_WEB':
      case 'READ_URL':
        e.web++;
        break;
      case 'MCP':
        if (OUTWARD_TOOL.test(name)) e.outward.push(name.replace(/^mcp__/, '').replace(/__/g, ' ').slice(0, 80));
        break;
    }
  }
  e.filesChanged = [...files].slice(0, 50);
  return e;
}

const firstLine = (s: string) => (s.trim().split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 160);
const base = (p: string) => path.basename(p) || p;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "names a, b and 2 more" */
function names(list: string[], max = 3): string {
  const shown = list.slice(0, max).map(base);
  const rest = list.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : (shown[0] ?? '');
}

/** One line of what the turn did, or null when it used no tools. */
export function digestOf(e: Evidence): string | null {
  if (!e.toolCalls) return null;
  const parts: string[] = [];
  if (e.commands.length) {
    const bad = e.commands.filter((c) => !c.ok && c.exit !== null).length;
    parts.push(`ran ${plural(e.commands.length, 'command')}${bad ? ` (${bad} failed)` : ''}`);
  }
  if (e.filesChanged.length) parts.push(`edited ${names(e.filesChanged)}`);
  if (e.filesRead) parts.push(`read ${plural(e.filesRead, 'file')}`);
  if (e.searches) parts.push(`searched ${plural(e.searches, 'time')}`);
  if (e.web) parts.push(`looked at ${plural(e.web, 'web page')}`);
  if (e.outward.length) parts.push(`sent out: ${e.outward.slice(0, 2).join(', ')}`);
  const other = e.toolCalls - e.commands.length - (e.filesChanged.length ? 1 : 0) - e.filesRead - e.searches - e.web - e.outward.length;
  if (!parts.length) parts.push(`used ${plural(e.toolCalls, 'tool')}`);
  else if (other > 2) parts.push(`${other} other tool calls`);
  if (e.failedCalls && !e.commands.some((c) => !c.ok)) parts.push(`${plural(e.failedCalls, 'call')} failed`);
  return parts.join(', ');
}

/** Evidence as a few lines for a report (Phase 3) or the room's expanded digest. */
export function evidenceLines(e: Evidence): string[] {
  const out: string[] = [];
  for (const c of e.commands.slice(0, 8)) out.push(`$ ${c.cmd.split('\n')[0].slice(0, 120)}${c.exit === null ? '' : ` → exit ${c.exit}`}`);
  if (e.commands.length > 8) out.push(`… ${e.commands.length - 8} more commands`);
  if (e.filesChanged.length) out.push(`changed: ${e.filesChanged.slice(0, 10).join(', ')}${e.filesChanged.length > 10 ? ` (+${e.filesChanged.length - 10})` : ''}`);
  for (const err of e.errors) out.push(`failed: ${err}`);
  if (e.outward.length) out.push(`outward: ${e.outward.join(', ')}`);
  return out;
}
