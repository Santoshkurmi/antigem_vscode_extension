// A Crew bot's setup as an OpenCode v2 hidden agent (bridge/pkg/opencode/crew.go). Verified (2026-11-22, a fake
// model recording requests): the agent's `system` reaches the model and a config change + reload applies to an
// existing session; permission rules are matched last-wins and a denied tool is not offered at all; tool / action
// ids are read, glob, grep, webfetch, websearch, skill, shell, execute, edit, write, question, subagent; an MCP
// tool is "<server>_<tool>"; the agent's allow beats the config-wide deny that hides crew tools from other chats.
import type { CrewAccess, ThreadSetup } from '../../types';
import { OUTWARD_PREFIXES } from '../access/outward';

export interface OpenCodeRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

/** The shared crew server's name in AntiGem's OpenCode config: tools become antigem_crew_roster, … */
export const OPENCODE_CREW_SERVER = 'antigem';
/** Denied to every chat; bots allow it. */
export const OPENCODE_CREW_TOOLS = `${OPENCODE_CREW_SERVER}_crew_*`;

const rule = (action: string, effect: OpenCodeRule['effect'], resource = '*'): OpenCodeRule => ({ action, resource, effect });

export function opencodeAgentId(setup: ThreadSetup): string {
  return `crew-${setup.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'bot'}`;
}

const outwardAsks = OUTWARD_PREFIXES.flatMap((p) => [rule('shell', 'ask', `${p} *`), rule('shell', 'ask', p)]);

export function opencodeRules(access: CrewAccess, addDirs: string[]): OpenCodeRule[] {
  const crew = rule(OPENCODE_CREW_TOOLS, 'allow');
  const dirs = addDirs.flatMap((d) => [rule('external_directory', 'allow', `${d.replace(/[/\\]+$/, '')}/*`)]);
  switch (access) {
    case 'talk':
      return [rule('*', 'deny'), crew];
    case 'read':
      return [rule('*', 'deny'), ...['read', 'glob', 'grep', 'webfetch', 'websearch', 'skill'].map((a) => rule(a, 'allow')), ...dirs, crew];
    case 'edit':
      // files in its folder freely; commands and other folders ask (the crew's access broker answers, or the Inbox)
      return [rule('*', 'allow'), rule('shell', 'ask'), rule('execute', 'ask'), rule('external_directory', 'ask'), ...dirs, crew];
    default:
      // auto / full: everything, but outward commands ask (the broker sends them to the Inbox)
      return [rule('*', 'allow'), rule('external_directory', 'ask'), ...outwardAsks, ...dirs, crew];
  }
}

/** The agent entry in the bridge's crew config. */
export function opencodeAgent(setup: ThreadSetup) {
  return {
    system: setup.instructions,
    description: 'AntiGem Crew bot',
    mode: 'primary',
    hidden: true,
    permissions: opencodeRules(setup.access, setup.addDirs),
  };
}
