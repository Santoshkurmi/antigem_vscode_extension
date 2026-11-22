// The Crew core's entry point (docs/crew/PLAN.md §3). Phase 0: the store, caller identity, thread setups and the
// crew MCP server; rooms, jobs, the turn runner and the UI build on it in later phases.
import path from 'node:path';
import type { AgentKind } from '../../../shared/model';
import type { AgentBackend, ThreadSetup } from '../types';
import { buildSetup, CREW_MCP_PATH, effectiveAccess } from './engines/setup';
import { CrewIdentity, type CallerLookup } from './mcp/identity';
import { crewMcp } from './mcp/server';
import { migrateSchema } from './store/migrate';
import { CrewStore } from './store/store';
import type { Automations } from './automations/runner';
import type { BotMemory } from './memory/memory';
import { UsageMeter } from './usage';
import type { Chief } from './chief';
import type { JobRuntime } from './jobs/runtime';
import type { BotProfile, CrewAccess, ThreadRecord } from './types';
import type { McpServerDef } from '../mcp/server';

export interface CrewHostApi {
  backend(kind: AgentKind): AgentBackend | undefined;
  /** http://127.0.0.1:<port><path> of the MCP host. */
  mcpUrl(path: string): string;
  mcpHeaders(): Record<string, string>;
  userName(): string;
  /** This window does not run the crew (another window owns the MCP port). */
  notLeader?(): boolean;
}

export class Crew {
  readonly store: CrewStore;
  private ident: CrewIdentity | null = null;

  constructor(
    private api: CrewHostApi,
    root?: string,
  ) {
    this.store = new CrewStore(root);
    this.usage = new UsageMeter(this.store);
  }

  /** Created on first use (it makes the secret), with crew.json brought up to date. */
  get identity(): CrewIdentity {
    if (!this.ident) {
      migrateSchema(this.store);
      this.ident = new CrewIdentity(this.store.secret());
    }
    return this.ident;
  }

  readonly lookup: CallerLookup = {
    thread: (id) => this.store.thread(id),
    threadByEngineChat: (engine, engineChatId) => {
      const be = this.api.backend(engine);
      return this.store.threads().find((t) => t.engine === engine && !!t.chatId && (t.chatId === engineChatId || be?.externalId?.(t.chatId) === engineChatId)) ?? null;
    },
  };

  /** Jobs (crew_assign & co.), set by the CrewEngine. */
  jobs: JobRuntime | null = null;
  /** The Chief (crew_manage), set by the CrewEngine. */
  chief: Chief | null = null;
  /** Automations (crew_later, crew_automation), set by the CrewEngine. */
  automations: Automations | null = null;
  /** Bots' memory (crew_memory, the prompt), set by the CrewEngine. */
  memory: BotMemory | null = null;
  /** What the crew spent today (the cost meter, the daily budget). */
  readonly usage: UsageMeter;
  /** An Antigravity bot is set up while the user has not said yes or no to its crew server (the Inbox asks). */
  onAgyAsk: (() => void) | null = null;

  /** The level a bot really runs at (its own, raised by the whole-crew switch, capped by its ceiling). */
  effectiveAccess(bot: BotProfile): CrewAccess {
    return effectiveAccess(bot, this.store.settings());
  }

  /** The setup a bot thread's every message is sent with (`cap`: at most this level, e.g. a consultation job). */
  setupFor(thread: ThreadRecord, cap: CrewAccess | null = null): ThreadSetup {
    const bot = thread.botId ? this.store.bot(thread.botId) : null;
    if (!bot) throw new Error('This crew thread has no bot');
    const settings = this.store.settings();
    if (thread.engine === 'AGY' && settings.agyCrewServer === 'ask') this.onAgyAsk?.();
    return buildSetup(bot, thread, {
      identity: this.identity,
      settings,
      agyServer: settings.agyCrewServer === 'allowed',
      memory: bot.memory.enabled ? (this.memory?.indexForPrompt(bot.id) ?? '') : '',
      aboutMe: this.memory?.aboutMe() ?? '',
      soul: this.store.soul(bot.id),
      userName: this.api.userName(),
      mcpUrl: (p) => this.api.mcpUrl(p),
      mcpHeaders: this.api.mcpHeaders(),
      addDirs: [path.join(this.store.root, 'bots', bot.id)],
      cap,
    });
  }

  /** crew_mcp for the MCP host (CREW_MCP_PATH). */
  mcp(): McpServerDef {
    const def = crewMcp({
      store: this.store,
      identity: () => this.identity,
      lookup: this.lookup,
      userName: () => this.api.userName(),
      jobs: () => this.jobs,
      chief: () => this.chief,
      automations: () => this.automations,
      memory: () => this.memory,
      notReady: () => (this.api.notLeader?.() ? 'The crew runs in another VS Code window' : null),
    });
    return { ...def, path: CREW_MCP_PATH };
  }
}
