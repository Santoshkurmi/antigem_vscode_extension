// Claude's permission prompts as approval cards (port of the app's ClaudePermissionPanel.kt): tool approvals (allow
// once / always allow from one of Claude's suggestions / deny with feedback) and plan approval (ExitPlanMode).
// Questions (AskUserQuestion) go to the question panel instead.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ApprovalView } from '../../../shared/protocol';
import type { PendingPermission } from './ClaudeTranscript';
import { permissionModeLabel, str } from './protocol';

/** Choice ids: 'allow' (once), 's<i>' (the i-th permission suggestion), 'plan:<mode>' (approve a plan, then that mode). */
export const ALLOW_ONCE = 'allow';
export const SUGGESTION_PREFIX = 's';
export const PLAN_PREFIX = 'plan:';

export function approvalViews(pending: PendingPermission[]): ApprovalView[] {
  return pending
    .filter((p) => p.toolName !== 'AskUserQuestion')
    .map((p) => {
      if (p.toolName === 'ExitPlanMode') {
        const plan = str(p.input.plan).trim();
        return {
          key: p.toolUseId,
          agent: 'CLAUDE',
          icon: 'plan',
          title: 'Review the plan',
          subtitle: 'Plan mode',
          markdown: plan || '_(empty plan)_',
          primary: { id: `${PLAN_PREFIX}acceptEdits`, label: 'Approve · auto-accept edits' },
          secondary: [{ id: `${PLAN_PREFIX}default`, label: 'Approve · review each edit' }],
          always: [],
          denyLabel: 'Keep planning',
          denyPlaceholder: 'What should change in the plan?',
        } satisfies ApprovalView;
      }
      const [icon, title] = toolTitle(p.toolName);
      const suggestions = (p.suggestions ?? []).map((s, i) => (s && typeof s === 'object' ? { id: `${SUGGESTION_PREFIX}${i}`, label: describeSuggestion(s) } : null));
      return {
        key: p.toolUseId,
        agent: 'CLAUDE',
        icon,
        title,
        subtitle: p.toolName.startsWith('mcp__') ? `MCP · ${p.toolName.slice(5).split('__')[0]}` : p.toolName,
        target: toolTarget(p.toolName, p.input, p.blockedPath),
        preview: toolPreview(p.toolName, p.input),
        reason: p.reason,
        primary: { id: ALLOW_ONCE, label: 'Allow' },
        secondary: [],
        always: suggestions.filter((s): s is { id: string; label: string } => s != null),
        denyLabel: 'Deny',
        denyPlaceholder: 'Tell Claude what to do instead (optional)',
      } satisfies ApprovalView;
    });
}

function toolTitle(name: string): [string, string] {
  if (name === 'Bash') return ['terminal', 'Run a command?'];
  if (name === 'Write') return ['file', 'Create a file?'];
  if (name === 'Edit' || name === 'MultiEdit') return ['edit', 'Edit a file?'];
  if (name === 'NotebookEdit') return ['edit', 'Edit a notebook?'];
  if (name === 'WebFetch') return ['web', 'Fetch a web page?'];
  if (name === 'WebSearch') return ['web', 'Search the web?'];
  if (name === 'Read' || name === 'Glob' || name === 'Grep' || name === 'LS') return ['file', 'Read outside the project?'];
  if (name.startsWith('mcp__')) return ['mcp', `Use ${name.split('__').pop()}?`];
  return ['shield', `Allow ${name}?`];
}

function toolTarget(name: string, input: Record<string, any>, blockedPath: string | null): string | null {
  switch (name) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return str(input.file_path) || str(input.notebook_path) || null;
    case 'WebFetch':
      return str(input.url) || null;
    default:
      return blockedPath;
  }
}

function toolPreview(name: string, input: Record<string, any>): string {
  const lines = (s: string, n: number, prefix: string) =>
    s
      .split('\n')
      .slice(0, n)
      .map((l) => `${prefix}${l}`)
      .join('\n');
  switch (name) {
    case 'Bash':
      return `$ ${str(input.command)}${str(input.description) ? `\n# ${str(input.description)}` : ''}`;
    case 'Write':
      return lines(str(input.content), 40, '+ ');
    case 'Edit':
      return `${lines(str(input.old_string), 20, '- ')}\n${lines(str(input.new_string), 20, '+ ')}`;
    case 'MultiEdit':
      return `${Array.isArray(input.edits) ? input.edits.length : 0} edits`;
    case 'WebFetch':
      return str(input.prompt);
    case 'WebSearch':
      return str(input.query);
    default:
      return Object.entries(input)
        .map(([k, v]) => `${k}: ${(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 200)}`)
        .join('\n');
  }
}

/** Text for one `permission_suggestions` entry. */
function describeSuggestion(s: Record<string, any>): string {
  const where =
    s.destination === 'session'
      ? 'for this session'
      : s.destination === 'localSettings'
        ? 'in this project (only me)'
        : s.destination === 'projectSettings'
          ? 'in this project (shared)'
          : s.destination === 'userSettings'
            ? 'everywhere'
            : '';
  switch (s.type) {
    case 'addRules':
    case 'replaceRules': {
      const rules = (Array.isArray(s.rules) ? s.rules : [])
        .filter((r: any) => r && typeof r === 'object')
        .map((r: any) => (str(r.ruleContent) ? `${str(r.toolName)}(${str(r.ruleContent)})` : str(r.toolName)))
        .join(', ');
      return `Always allow ${rules} ${where}`.trim();
    }
    case 'addDirectories':
      return `Allow access to ${(Array.isArray(s.directories) ? s.directories : []).map(String).join(', ')} ${where}`.trim();
    case 'setMode':
      return `Switch to ${permissionModeLabel(str(s.mode))} ${where}`.trim();
    default:
      return str(s.type);
  }
}
