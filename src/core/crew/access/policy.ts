// What a Crew bot may do without asking (docs/crew/PLAN.md §11). Every permission request from a bot's chat (room,
// job, DM) is decided here first; the engines already enforce what they can (crew/engines/*: Claude tools + permission
// mode, Codex sandbox, OpenCode rules), so this decides what still reaches us:
//   talk  → refuse (crew tools only)          read → reads only
//   edit  → files in its folders, ordinary commands; anything outside its folders or risky → ask
//   auto  → anything but risky                full → anything
// and in EVERY mode an outward action (git push, publishing, posting, sending, paying; MCP tools that send) asks the
// user, unless they chose "Always allow" for that exact bot + tool. "ask" = an Inbox item the user answers.
import path from 'node:path';
import type { ApprovalView } from '../../../../shared/protocol';
import { bashRisk, describeApproval } from '../../jarvis/controller';
import type { CrewAccess } from '../types';
import { OUTWARD_TOOL } from '../turns/evidence';

export type Verdict = 'allow' | 'deny' | 'ask';
export type Risk = 'READ' | 'NORMAL' | 'RISKY';

export interface Decision {
  verdict: Verdict;
  /** Why (the Inbox says it; a refusal tells the bot). */
  reason: string;
  /** "Always allow" is remembered under this (bot + tool + command / server). */
  key: string;
  outward: boolean;
  risk: Risk;
  /** One line: "run the command: npm test" */
  summary: string;
  tool: string;
}

/** Commands that reach outside the machine. */
const OUTWARD_BASH =
  /\bgit\s+push\b|\bgh\s+(pr|issue|release|repo|gist)\s+(create|merge|comment|edit|delete|close|review)|\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bcurl\b[^|\n]*(-X\s*(POST|PUT|DELETE|PATCH)\b|--data\b|\s-d\s|--form\b|\s-F\s)|\bwget\b[^|\n]*--post|\bscp\s|\brsync\b[^|\n]*\S+:|\bssh\s|\bkubectl\s+(apply|delete|create|rollout)|\bterraform\s+(apply|destroy)\b|\b(sendmail|mailx?)\b/i;
const CREW_TOOL = /(^|__|_|\s)crew_[a-z]+\b|mcp__crew__|antigem_crew/i;

/** The command a Bash approval runs ("$ npm test" → "npm test"). */
function commandOf(a: ApprovalView): string {
  const p = (a.preview ?? a.target ?? '').split('\n')[0] ?? '';
  return p.replace(/^\s*\$\s*/, '').trim();
}

/** "Bash(git push)", "Edit(/abs/dir)", "mcp(slack send_message)": what "always allow" remembers. */
export function approvalKey(a: ApprovalView, tool: string): string {
  if (/^bash$/i.test(tool) || a.icon === 'terminal') {
    const words = commandOf(a).split(/\s+/).filter((w) => w && !w.includes('='));
    const head = words[0] ?? '';
    // "git push", "npm test", "docker push": the sub-command is part of the key
    const sub = words[1] && /^[a-z][\w:-]*$/i.test(words[1]) && !words[1].startsWith('-') ? ` ${words[1]}` : '';
    return `Bash(${head}${sub})`;
  }
  if (/edit|write|multiedit|notebookedit|apply_patch/i.test(tool) || a.icon === 'edit' || a.icon === 'file') {
    const t = a.target ?? '';
    return `Edit(${t ? path.dirname(t) : '*'})`;
  }
  return `${tool || a.title}`.slice(0, 120);
}

const inside = (file: string, dir: string) => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export interface DecideInput {
  access: CrewAccess;
  approval: ApprovalView;
  /** Folders its edits may change without asking (its work folder / the room's project / its own folder). */
  folders: string[];
  /** The user chose "always" / "for this session" for this bot + key. */
  allowed(key: string): boolean;
}

export function decide(i: DecideInput): Decision {
  const a = i.approval;
  const d = describeApproval(a);
  const tool = d.tool || a.title;
  const key = approvalKey(a, tool);
  const hay = `${tool} ${a.title} ${a.subtitle ?? ''} ${a.target ?? ''}`;
  const cmd = /^bash$/i.test(tool) || a.icon === 'terminal' ? commandOf(a) : '';
  const risk: Risk = cmd ? bashRisk(cmd) : d.risk === 'READ' ? 'READ' : 'NORMAL';
  const outward = (!!cmd && OUTWARD_BASH.test(cmd)) || (/^mcp|mcp__|\bmcp\b/i.test(`${tool} ${a.icon}`) && OUTWARD_TOOL.test(tool));
  const out = (verdict: Verdict, reason: string): Decision => ({ verdict, reason, key, outward, risk, summary: d.summary, tool });
  // its own crew tools never ask
  if (CREW_TOOL.test(hay)) return out('allow', 'a crew tool');
  if (i.access === 'talk') return out('deny', 'it is talk-only');
  if (i.access === 'read') return risk === 'READ' ? out('allow', 'a read') : out('deny', 'it is read-only');
  const remembered = i.allowed(key);
  if (outward) return remembered ? out('allow', 'you always allow this') : out('ask', 'it reaches outside (asks at every level)');
  if (i.access === 'full') return out('allow', 'full access');
  if (risk === 'RISKY') return remembered ? out('allow', 'you always allow this') : out('ask', 'a risky command');
  if (i.access === 'auto') return out('allow', 'auto access');
  // edit: files in its folders, ordinary commands
  const isEdit = /edit|write|apply_patch/i.test(tool) || a.icon === 'edit';
  if (isEdit && a.target && i.folders.length && !i.folders.some((f) => inside(a.target!, f))) {
    return remembered ? out('allow', 'you always allow this') : out('ask', 'a file outside its folder');
  }
  return out('allow', risk === 'READ' ? 'a read' : 'edit access');
}

/** What a refused request tells the bot. */
export function refusalNote(access: CrewAccess, why: string, note?: string | null): string {
  if (note?.trim()) return `The user said no: ${note.trim()}`;
  if (access === 'talk') return 'You are talk-only here. Do not use tools; just reply.';
  if (access === 'read') return 'You have read-only access here. Do not change anything; reply instead.';
  return `Not allowed (${why}). Do it another way or say what you need in your reply.`;
}
