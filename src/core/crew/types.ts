// The Crew data model as stored in ~/.antigem/crew (docs/crew/PLAN.md §4). The Android app reads and writes the
// same files, so field names and meanings are a contract: add fields, never rename them; bump CREW_SCHEMA with a
// migration (store/migrate.ts) for anything else.
import type { AgentKind, ChatAttachment } from '../../../shared/model';
import type { CrewAccess } from '../types';

export type { CrewAccess };

/** 2: rooms saved in the old "natural" mode (stored as 'mentions') answer in 'auto' mode (Rooms v2). */
export const CREW_SCHEMA = 2;

export interface CrewSettings {
  schema: number;
  /** The Chief bot (Jarvis when it is on). */
  chiefId: string | null;
  /** Every bot's access is at most this (the "whole crew" switch); null = each bot's own level. */
  crewAccess: CrewAccess | null;
  /** Group chats already copied into rooms (~/.antigem/groups/<id>). */
  migratedGroups: string[];
  /** Everyone paused: no room turns, no jobs start (running ones stop); DMs still answer the user. */
  paused: boolean;
  /** The local webhook receiver's port (automations "when its webhook is called"). */
  webhookPort: number;
  /** Daily budget for the whole crew (null = no limit): checked before new work starts, running work is never cut. */
  caps: { dayTokens: number | null; dayUsd: number | null };
  /** The Crew home's getting-started guide was closed. */
  tourDone: boolean;
  /**
   * Antigravity's crew tools need the AntiGem Crew server in its global mcp_config.json: added only after the user
   * said yes (an Inbox item asks), 'declined' = not now (the bot editor offers it again).
   */
  agyCrewServer: 'ask' | 'allowed' | 'declined';
  createdAt: number;
  updatedAt: number;
}

export interface BotProfile {
  id: string;
  /** One word, @-mentionable. */
  name: string;
  title: string;
  description: string;
  emoji: string;
  color: string;
  engine: AgentKind;
  model: string | null;
  effort: string;
  fallbackModels: string[];
  access: CrewAccess;
  accessCeiling: CrewAccess;
  tools: { mcp: string[] | null; off: string[] };
  folder: string | null;
  chattiness: number;
  department: string | null;
  chief: boolean;
  reportsTo: string | null;
  memory: { enabled: boolean; capture: boolean };
  /** Words that route a room message to this bot in auto mode (typed by the user or learned from re-asks). */
  aliases: string[];
  /** Check before done: work it hands back is checked first by another model ('auto') or by this bot's model (an id). */
  checkWork: string | null;
  /** It gets AntiGem's Browser MCP as its own tool (Claude Code, Codex). */
  browser: boolean;
  /** The voice its room messages are read in (a speech voice name; null = the default voice). */
  voice: string | null;
  paused: boolean;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export type RoomMode = 'mentions' | 'lead' | 'everyone' | 'auto' | 'moderator';

export interface RoomRecord {
  id: string;
  name: string;
  members: string[];
  lead: string | null;
  bulletin: string;
  mode: RoomMode;
  drafting: 'turns' | 'parallel';
  turnsPerMember: number;
  maxBotTurns: number;
  autoTalk: { on: boolean; idleSeconds: number };
  folder: string | null;
  holds: Record<string, boolean>;
  department: string | null;
  /** The router / moderator engine and model (null = the room lead's engine, its cheapest model). */
  router: { engine: AgentKind | null; model: string | null };
  /** Messages that named a held member while it was held (shown to it when it is released). */
  heldMessages: { botId: string; lineId: string }[];
  /** summary.md covers transcript lines [0, upTo) (written by the cheap model while the room is quiet). */
  summary: { upTo: number; at: number };
  /** A goal the lead drives (Phase 5): bounded team turns, a control block after each lead turn. */
  goal: RoomGoal | null;
  /** The Group chat it came from. */
  fromGroup: string | null;
  /** What the bots call the user here. */
  userName: string;
  paused: boolean;
  /** Bot messages since the user last wrote, and whether the bots stopped to wait for the user (maxBotTurns). */
  talk: { botTurns: number; waiting: boolean };
  createdAt: number;
  updatedAt: number;
}

/** How a member came to answer (Rooms v2 routing), shown on its message ("Picked by router · why"). */
export type PickBy = 'reply' | 'mention' | 'everyone' | 'lead' | 'auto' | 'router' | 'moderator' | 'chime' | 'held' | 'nudge' | 'user' | 'report' | 'goal' | 'automation';

/** What a bot turn did, from its tool calls (crew/turns/evidence.ts): the facts behind its words. */
export interface Evidence {
  /** Shell commands with their exit codes (null = unknown, e.g. still running when the turn ended). */
  commands: { cmd: string; exit: number | null; ok: boolean }[];
  filesChanged: string[];
  filesRead: number;
  searches: number;
  web: number;
  /** Every tool call but the crew_* ones. */
  toolCalls: number;
  failedCalls: number;
  /** Up to 3 failure texts. */
  errors: string[];
  /** MCP calls that reach outside (send, post, push…). */
  outward: string[];
}

/** One line of a room's transcript.ndjson. */
export interface RoomLine {
  id: string;
  /** 'user', 'system' (news the bots are told), 'notice' (for the user only) or a bot id. */
  from: string;
  name: string;
  text: string;
  at: number;
  attachments?: ChatAttachment[];
  /** The line it answers (the user replied to a bot's message). */
  replyTo?: string;
  /** A bot's line: why it spoke. */
  picked?: { by: PickBy; why?: string };
  /** A bot's line: one line of what it did before answering ("ran 3 commands, edited api.ts"). */
  digest?: string;
  evidence?: Evidence;
  /** A bot's line: the turn's tokens. */
  usage?: LineUsage;
}

export interface LineUsage {
  input: number;
  output: number;
  cached: number;
  costUsd: number | null;
}

export type ThreadKind = 'dm' | 'room' | 'work' | 'automation' | 'router' | 'problems';

/** A room goal (docs/crew/PLAN.md §7 "Goals"). */
export interface RoomGoal {
  text: string;
  status: 'running' | 'completed' | 'needs-input' | 'blocked' | 'stopped';
  /** Team turns used / allowed. */
  turns: number;
  maxTurns: number;
  /** The lead's last control note ("Tess checks the logs next"). */
  note: string;
  startedAt: number;
  updatedAt: number;
}

/** threads.json: every engine chat the crew owns. */
export interface ThreadRecord {
  id: string;
  botId: string | null;
  engine: AgentKind;
  /** The chat id the backend knows it by (null until its first turn). */
  chatId: string | null;
  kind: ThreadKind;
  roomId: string | null;
  jobId: string | null;
  /** Room lines it has been sent (transcript index). */
  seen: number;
  /** The setup key it last ran with. */
  setupKey: string | null;
  createdAt: number;
  updatedAt: number;
}

// ------------------------------------------------------------------------------------------------ jobs (Phase 3)

/** docs/crew/PLAN.md §8: queued → running → (waiting → resume → running)* → done | failed | cancelled; needs_input on a question. */
export type JobStatus = 'queued' | 'running' | 'needs_input' | 'waiting' | 'resume' | 'done' | 'failed' | 'cancelled';
export const SETTLED: JobStatus[] = ['done', 'failed', 'cancelled'];

/** A structured result a bot attached with crew_report. */
export interface Artifact {
  kind: 'file' | 'diff' | 'link' | 'data';
  title: string;
  /** file / diff: an absolute path */
  path?: string;
  /** link */
  url?: string;
  /** data, or a diff's text */
  text?: string;
}

/** Per-root counters since the last progress (loop protection, shown in Mission Control). */
export interface JobBudget {
  /** Jobs handed out in this tree. */
  requests: number;
  /** Turns run for jobs of this tree. */
  runs: number;
  /** Resume turns (reports / questions handed back). */
  wakes: number;
  failuresInRow: number;
}

/** A check before done: another model read the result and its evidence. */
export interface JobCheck {
  /** "a quick Codex model", "Rita" */
  by: string;
  verdict: 'checking' | 'pass' | 'issues' | 'cannot';
  note: string;
  at: number;
}

/** jobs/jobs.json: one hand-off (or a root: the turn a tree started in). */
export interface JobRow {
  id: string;
  rootId: string;
  parentId: string | null;
  depth: number;
  origin: { kind: 'person' | 'room' | 'automation' | 'outside'; quote: string; roomId: string | null };
  /** Who asked (null bot = the user: a root). */
  requester: { botId: string | null; threadId: string | null };
  /** Who does it, in which thread (a root: the turn's own thread). */
  assignee: { botId: string; threadId: string | null };
  /** work = do it; consult = answer, change nothing; notify = for your information (no report back). */
  mode: 'work' | 'consult' | 'notify';
  reply: 'resume' | 'none';
  title: string;
  brief: string;
  doneWhen: string | null;
  files: string[];
  /** standing = the bot's work thread; new = a thread of its own; self = crew_thread (parallel work on itself). */
  thread: 'standing' | 'new' | 'self';
  status: JobStatus;
  /** One line: how it ended. */
  outcome: string | null;
  level: CrewAccess;
  /** Its final words (≤ 12k). */
  result: string | null;
  evidence: Evidence | null;
  artifacts: Artifact[];
  question: string | null;
  /** The question was handed to the requester already (a question interrupts the wait once). */
  asked: boolean;
  answer: string | null;
  /** Its report reached the requester (one resume per settle). */
  reported: boolean;
  /** An acknowledgement only ("ok, will do"): does not wake the requester. */
  ack: boolean;
  executions: number;
  usage: LineUsage;
  /** A failed job the user dismissed from the Inbox. */
  dismissed: boolean;
  /** Times the Chief ran it again (≤ 2). */
  retries: number;
  /** Check-before-done rounds so far (≤ 3) and the last one's verdict. */
  checks: number;
  check: JobCheck | null;
  /** A bot goal (Phase 5): the bot keeps going on its own; a cheap judge decides after each turn. */
  goal: { maxTurns: number; turns: number; nextAt: number | null; failures: number; paused: boolean } | null;
  /** Roots only. */
  budget: JobBudget | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
}
