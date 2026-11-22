// A bot thread's ThreadSetup (src/core/types.ts): its stable prompt, its crew MCP server with its identity, its
// effective access. Backends apply it (engines/claude|codex|opencode|agy.ts); Antigravity has no per-chat setup, so
// its backend puts softPreamble() in front of the message instead.
import { createHash } from 'node:crypto';
import type { CrewAccess, ThreadSetup } from '../../types';
import type { CrewIdentity } from '../mcp/identity';
import { stablePart } from '../prompts/stable';
import { ACCESS_LEVELS } from '../store/store';
import type { BotProfile, CrewSettings, ThreadRecord } from '../types';

export const CREW_MCP_PATH = '/crew';
/** A bot's own browser: AntiGem's Browser MCP (Claude: mcp__browser__browser_open_url). */
export const BROWSER_MCP_NAME = 'browser';
export const BROWSER_MCP_PATH = '/browser';

/** The server name in a bot's own MCP config (Claude: mcp__crew__crew_roster). */
export const CREW_MCP_NAME = 'crew';

const rank = (a: CrewAccess) => ACCESS_LEVELS.indexOf(a);
const lower = (a: CrewAccess, b: CrewAccess) => (rank(a) <= rank(b) ? a : b);

/**
 * The access a bot really runs at: its own level, raised by the whole-crew switch (bots at Edit or above only:
 * a talk-only or read-only bot is that by design), never above its ceiling.
 */
export function effectiveAccess(bot: BotProfile, settings: CrewSettings): CrewAccess {
  let a = bot.access;
  if (settings.crewAccess && rank(a) >= rank('edit') && rank(settings.crewAccess) > rank(a)) a = settings.crewAccess;
  return lower(a, bot.accessCeiling);
}

export interface SetupEnv {
  identity: CrewIdentity;
  settings: CrewSettings;
  soul: string;
  userName: string;
  /** http://127.0.0.1:<port><path> of the extension's MCP host. */
  mcpUrl: (path: string) => string;
  mcpHeaders: Record<string, string>;
  /** Folders a bot may read without asking (its own crew folder). */
  addDirs: string[];
  /** At most this level (a consultation job reads only). */
  cap?: CrewAccess | null;
  /** Antigravity: the user allowed the crew server in its mcp_config.json (else its bots run without crew tools). */
  agyServer?: boolean;
  /** Its memory for the prompt and the user's profile (memory on). */
  memory?: string;
  aboutMe?: string;
}

export function buildSetup(bot: BotProfile, thread: ThreadRecord, env: SetupEnv): ThreadSetup {
  const access = env.cap ? lower(effectiveAccess(bot, env.settings), env.cap) : effectiveAccess(bot, env.settings);
  const engine = thread.engine;
  const agyTools = engine !== 'AGY' || env.agyServer === true;
  const instructions = stablePart({ bot, soul: env.soul, access, userName: env.userName, argCap: engine === 'AGY' && agyTools ? env.identity.argCap(thread.id) : null, crewTools: agyTools, chief: env.settings.chiefId === bot.id, memory: env.memory, aboutMe: env.aboutMe });
  const own =
    engine === 'CLAUDE' || engine === 'CODEX'
      ? [
          { name: CREW_MCP_NAME, url: env.mcpUrl(`${CREW_MCP_PATH}?t=${encodeURIComponent(thread.id)}&cap=${env.identity.cap(thread.id)}`), headers: env.mcpHeaders },
          // its own browser (AntiGem's Browser MCP: the user's Chrome, AntiGem tab group, blocklist kept); not at Talk
          ...(bot.browser && access !== 'talk' ? [{ name: BROWSER_MCP_NAME, url: env.mcpUrl(BROWSER_MCP_PATH), headers: env.mcpHeaders }] : []),
        ]
      : [];
  // OpenCode: one server for every bot (its _meta names the caller); Antigravity: one global server (cap argument)
  const sharedMcp =
    engine === 'OPENCODE'
      ? { url: env.mcpUrl(`${CREW_MCP_PATH}?engine=opencode`), headers: env.mcpHeaders }
      : engine === 'AGY' && agyTools
        ? { url: env.mcpUrl(CREW_MCP_PATH), headers: env.mcpHeaders }
        : null;
  const base = {
    instructions,
    mcp: own,
    sharedMcp,
    access,
    // a talk-only bot gets none of the user's MCP servers; an explicit empty list = none either
    onlyOwnMcp: access === 'talk' || (Array.isArray(bot.tools.mcp) && bot.tools.mcp.length === 0),
    addDirs: env.addDirs,
  };
  const key = createHash('sha256').update(JSON.stringify(base)).digest('hex').slice(0, 16);
  return { id: thread.id, key, ...base };
}

export { softPreamble } from './agy';
