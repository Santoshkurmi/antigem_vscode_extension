// A Crew bot's setup as Claude Code spawn options (the bridge's CrewSpawn, bridge/pkg/claude/crew.go).
import type { CrewAccess, ThreadSetup } from '../../types';
import { CLAUDE_ASK_RULES } from '../access/outward';

export interface ClaudeCrewSpawn {
  key: string;
  append_system_prompt?: string;
  mcp_servers?: Record<string, { type: 'http'; url: string; headers: Record<string, string> }>;
  strict_mcp?: boolean;
  /** Built-in tools; absent = all, [] = none. */
  tools?: string[];
  allowed_tools?: string[];
  disallowed_tools?: string[];
  add_dirs?: string[];
  /** Rules that always ask, even in auto mode (outward commands at Auto / Full: the crew's broker decides). */
  ask_tools?: string[];
}

/** Built-in tools of a read-only bot. */
export const CLAUDE_READ_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'TodoWrite'];

/** Claude's permission mode for an access level ('full' asks the crew broker in Phase 4; until then like auto). */
export function claudeMode(access: CrewAccess): string {
  if (access === 'edit') return 'acceptEdits';
  if (access === 'auto' || access === 'full') return 'auto';
  return 'default';
}

export function claudeCrew(setup: ThreadSetup): { crew: ClaudeCrewSpawn; permissionMode: string } {
  const servers: ClaudeCrewSpawn['mcp_servers'] = {};
  for (const s of setup.mcp) servers[s.name] = { type: 'http', url: s.url, headers: s.headers };
  // its own crew tools never ask
  const allowed = setup.mcp.map((s) => `mcp__${s.name}`);
  const crew: ClaudeCrewSpawn = { key: setup.key };
  if (setup.instructions) crew.append_system_prompt = setup.instructions;
  if (setup.mcp.length) crew.mcp_servers = servers;
  // talk-only: none of the user's MCP servers either (their tools would be tools)
  if (setup.onlyOwnMcp || setup.access === 'talk') crew.strict_mcp = true;
  if (setup.access === 'talk') crew.tools = [];
  else if (setup.access === 'read') {
    crew.tools = CLAUDE_READ_TOOLS;
    allowed.push(...CLAUDE_READ_TOOLS);
  }
  if (allowed.length) crew.allowed_tools = allowed;
  if (setup.addDirs.length) crew.add_dirs = setup.addDirs;
  // auto mode runs commands its own classifier allows: outward ones still come to the broker (and the Inbox)
  if (setup.access === 'auto' || setup.access === 'full') crew.ask_tools = CLAUDE_ASK_RULES;
  return { crew, permissionMode: claudeMode(setup.access) };
}
