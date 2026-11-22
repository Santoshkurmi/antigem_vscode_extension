// A Crew bot's setup on Antigravity, which has no per-chat system prompt, MCP config or tool limits: the crew server
// is one global entry of its mcp_config.json (the bot passes its cap in every call), and the persona goes in a
// hidden block in front of the message: on the chat's first message and again whenever the setup changes.
import type { ThreadSetup } from '../../types';

/** The crew server's name in Antigravity's mcp_config.json. */
export const AGY_CREW_SERVER = 'antigem_crew';

export function softPreamble(setup: ThreadSetup): string {
  return `<antigem-expansion command="">\n<crew-instructions version="${setup.key}">\n${setup.instructions}\n</crew-instructions>\n</antigem-expansion>\n\n`;
}
