// What each engine can enforce for a Crew bot, verified live on 2026-11-22 (Phase 0 spike, docs/crew/ENGINES.md):
// Claude Code 2.1.322, Codex 0.167.0 (app-server), OpenCode 2.2.7, Antigravity (hub). The UI uses `note`s to be
// honest about what is only asked of the model.
import type { AgentKind } from '../../../../shared/model';
import type { CrewAccess } from '../../types';

export type Strength = 'hard' | 'soft';

export interface EngineCaps {
  /** Persona as a real system / developer prompt (hard) or a labeled block in the message (soft). */
  persona: Strength;
  /** An edited persona reaches an existing chat without losing it. */
  personaUpdate: 'restart' | 'context' | 'reload' | 'message';
  /** How the crew MCP server knows which chat calls: per-chat URL, the engine's own call metadata, or a cap argument. */
  identity: 'url' | 'meta' | 'argument';
  /** The bot's own MCP server is attached per chat (not to every chat of the engine). */
  ownMcp: Strength;
  /** Talk-only (no tools but crew tools) is enforced. */
  talkOnly: Strength;
  /** Read-only is enforced. */
  readOnly: Strength;
  /** The user's own MCP servers can be left out. */
  onlyOwnMcp: Strength;
  /** Steer a running turn. */
  steer: boolean;
  notes: Partial<Record<CrewAccess | 'mcp' | 'persona', string>>;
}

export const ENGINE_CAPS: Record<AgentKind, EngineCaps> = {
  CLAUDE: {
    persona: 'hard',
    personaUpdate: 'restart',
    identity: 'url',
    ownMcp: 'hard',
    talkOnly: 'hard',
    readOnly: 'hard',
    onlyOwnMcp: 'hard',
    steer: false,
    notes: {
      persona: '--append-system-prompt-file with --system-prompt-snapshot off; a change restarts the process (history kept).',
    },
  },
  CODEX: {
    persona: 'hard',
    personaUpdate: 'context',
    identity: 'url',
    ownMcp: 'hard',
    talkOnly: 'soft',
    readOnly: 'hard',
    onlyOwnMcp: 'soft',
    steer: true,
    notes: {
      talk: 'Codex cannot turn its shell off: a talk-only bot runs in a read-only sandbox (it can look, not change).',
      persona: 'developerInstructions at thread start; later edits go in as application context on the next turn.',
      mcp: "The user's own MCP servers stay available to the bot.",
    },
  },
  OPENCODE: {
    persona: 'hard',
    personaUpdate: 'reload',
    identity: 'meta',
    ownMcp: 'soft',
    talkOnly: 'hard',
    readOnly: 'hard',
    onlyOwnMcp: 'soft',
    steer: false,
    notes: {
      persona: 'A hidden agent of AntiGem’s OpenCode config (system prompt + permission rules); edits reload the config.',
      mcp: 'One crew server for all bots; OpenCode tells it which chat calls. Other chats have its tools denied.',
    },
  },
  AGY: {
    persona: 'soft',
    personaUpdate: 'message',
    identity: 'argument',
    ownMcp: 'soft',
    talkOnly: 'soft',
    readOnly: 'soft',
    onlyOwnMcp: 'soft',
    steer: false,
    notes: {
      persona: 'Antigravity has no per-chat system prompt: the persona goes in a hidden block of the message.',
      talk: 'Talk-only can’t be enforced on Antigravity: tool approvals are refused, but some tools run without one.',
      read: 'Read-only can’t be fully enforced on Antigravity: change approvals are refused.',
      mcp: 'Needs the AntiGem Crew server in Antigravity’s MCP servers; the bot passes its cap in each crew call.',
    },
  },
};

/** One line saying what is not enforced for a bot on [engine] at [access] (null = all of it is). */
export function softNote(engine: AgentKind, access: CrewAccess): string | null {
  const c = ENGINE_CAPS[engine];
  if (access === 'talk' && c.talkOnly === 'soft') return c.notes.talk ?? null;
  if (access === 'read' && c.readOnly === 'soft') return c.notes.read ?? null;
  return null;
}
