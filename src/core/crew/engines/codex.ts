// A Crew bot's setup as Codex app-server thread / turn parameters. Verified (2026-11-22): developerInstructions
// only count at thread/start (thread/resume and a turn's collaborationMode ignore a new one), but application
// additionalContext on a turn does reach the model; the `config` override's MCP server is per thread and is applied
// again by thread/resume (a fresh app-server needs that before the thread's next turn); MCP calls need
// default_tools_approval_mode "approve" or approvalPolicy "never" refuses them.
import type { CrewAccess, ThreadSetup } from '../../types';

type J = Record<string, unknown>;

export function codexSandbox(access: CrewAccess): 'read-only' | 'workspace-write' {
  return access === 'talk' || access === 'read' ? 'read-only' : 'workspace-write';
}

/** Talk / read never ask (a refused action goes back to the bot); edit and up ask only to leave the sandbox. */
export function codexApproval(access: CrewAccess): string {
  return access === 'talk' || access === 'read' ? 'never' : 'on-request';
}

export function codexSandboxPolicy(access: CrewAccess): J {
  if (codexSandbox(access) === 'read-only') return { type: 'readOnly', networkAccess: false };
  return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

/** `config` override with the bot's own MCP servers. */
export function codexConfig(setup: ThreadSetup): J {
  const servers: J = {};
  for (const s of setup.mcp) servers[s.name] = { url: s.url, http_headers: s.headers, default_tools_approval_mode: 'approve' };
  return setup.mcp.length ? { mcp_servers: servers } : {};
}

/** thread/start (new chat) or thread/resume (existing chat, once per app-server and setup) parameters. */
export function codexThreadParams(setup: ThreadSetup): J {
  return {
    developerInstructions: setup.instructions || null,
    config: codexConfig(setup),
    sandbox: codexSandbox(setup.access),
    approvalPolicy: codexApproval(setup.access),
  };
}

/** A turn's additionalContext carrying a persona edited after the thread started. */
export function codexPersonaContext(setup: ThreadSetup): J {
  return { 'antigem.crew.persona': { kind: 'application', value: `Your instructions changed. From now on follow these instead of the earlier ones:\n\n${setup.instructions}` } };
}
