// Crew rooms (ex Group chats): the user and several crew bots in one room. Each member answers in its own hidden room
// thread (a native chat of its engine); the engine decides who speaks (rooms/router.ts), sends each member only the
// room lines it has not seen (rooms/prompts.ts) and posts only its final words (crew/turns/runner.ts), with a one-line
// digest of what it did. The in-memory room is a `Group` (the shape the view protocol and groups_mcp grew up with);
// rooms/store.ts keeps it in the crew's files (room.json, transcript.ndjson, threads.json, bots/<id>).
import type { AgentKind, ChatAttachment, Conversation } from '../../../../shared/model';
import type { GroupBotAccess, HostToView, ViewToHost } from '../../../../shared/protocol';
import type { ApprovalView } from '../../../../shared/protocol';
import type { AgentBackend, CrewAccess, ThreadSetup } from '../../types';
import type { ApproveResult } from '../access/broker';
import type { BotProfile, Evidence, LineUsage, PickBy, RoomGoal, RoomMode } from '../types';

export type { RoomMode, PickBy };

export interface Bot {
  id: string;
  name: string;
  agent: AgentKind;
  modelId: string | null;
  persona: string;
  emoji: string;
  color: string;
  chattiness: number;
  access: GroupBotAccess;
  effort: string;
  /** On hold in this room: skipped; messages for it are kept for later. */
  muted: boolean;
  /** Its hidden room thread (null until it first speaks). */
  chatId: string | null;
  /** Room messages it has been sent (messages[0..seen) — its own are never sent back to it). */
  seen: number;
  /** From its crew profile (read-only here): what auto routing matches on. */
  title: string;
  description: string;
  aliases: string[];
  /** The voice its messages are read in (null = the default). */
  voice?: string | null;
}

export interface Msg {
  id: string;
  /** 'user', 'system', 'notice' or a bot id. */
  from: string;
  name: string;
  text: string;
  at: number;
  attachments: ChatAttachment[];
  replyTo?: string;
  picked?: { by: PickBy; why?: string };
  digest?: string;
  evidence?: Evidence;
  usage?: LineUsage;
}

export interface Group {
  id: string;
  title: string;
  /** The bulletin: what every member is told the room is for. */
  topic: string;
  userName: string;
  bots: Bot[];
  mode: RoomMode;
  /** Answers when nobody else is picked (lead mode, auto fallback). */
  lead: string | null;
  /** One speaker at a time, or everyone picked drafts at once (posts still land in order). */
  drafting: 'turns' | 'parallel';
  /** Turns each member gets per round (a round = from a user message until the room is quiet). */
  turnsPerMember: number;
  /** The router / moderator's engine and model (null = the lead's engine, its cheapest model). */
  moderatorAgent: AgentKind | null;
  moderatorModelId: string | null;
  /** The router's hidden chat and what it has seen. */
  moderatorChatId: string | null;
  moderatorSeen: number;
  maxBotTurns: number;
  autoTalk: boolean;
  idleSeconds: number;
  project: string | null;
  paused: boolean;
  /** Bot messages since the user last wrote. */
  botTurns: number;
  /** Stopped after maxBotTurns: waits for the user or Continue. */
  waiting: boolean;
  heldMessages: { botId: string; lineId: string }[];
  /** The goal the lead drives (null = none). */
  goal: RoomGoal | null;
  /** summary.md covers messages[0..summaryUpTo). */
  summaryUpTo: number;
  createdAt: number;
  updatedAt: number;
  messages: Msg[];
}

/** Why a bot gets a turn (stronger first): it decides what the bot is told. */
export type Reason = 'report' | 'reply' | 'mention' | 'goal' | 'user' | 'held' | 'all' | 'lead' | 'pick' | 'chime' | 'nudge';
export const REASON_RANK: Record<Reason, number> = { report: 9, reply: 8, mention: 7, goal: 7, user: 6, held: 5, all: 4, lead: 4, pick: 3, chime: 2, nudge: 1 };

/** Where rooms live (rooms/store.ts). */
export interface GroupStoreLike {
  scan(busy?: (id: string) => boolean): void;
  all(): Group[];
  get(id: string): Group | undefined;
  put(g: Group): void;
  delete(id: string): void;
  /** The room's private folder (talk-only bots run there). */
  roomDir(id: string): string;
  /** A member's SOUL.md. */
  soulOf(botId: string): string;
  /**
   * Reads the members' crew profiles into the room (an edit on the Crew screen or in another room). Returns members
   * whose agent or model changed (their room thread starts again).
   */
  refreshBots(id: string): { botId: string; engineChanged: boolean; modelChanged: boolean; oldEngine: AgentKind }[];
  /** The rolling summary of older lines ('' = none). */
  summary(id: string): string;
  setSummary(id: string, text: string, upTo: number): void;
  /** Writes what is pending now (shutdown). */
  flush(): void;
}

/** A bot's turn as a crew bot: its chat's setup (persona, crew tools, access) while the turn runs. */
export interface CrewTurn {
  setup: ThreadSetup;
  /** The turn is over (crew tools stop answering for it). */
  end(): void;
}

/** What rooms get from the crew (CrewEngine.roomApi()). */
export interface RoomCrewApi {
  /** A member's turn as its crew bot (setup + crew tools answering while it runs). */
  turn(roomId: string, botId: string, chatId: string): CrewTurn | null;
  /**
   * Waits until the bot is free crew-wide (one turn at a time per bot: its DM, another room, a job). Returns the release
   * function, or null when cancelled / timed out. `onWait` says where it is busy.
   */
  lock(botId: string, where: string, opts: { cancelled(): boolean; onWait?(busyWhere: string): void; timeoutMs?: number }): Promise<(() => void) | null>;
  /** Auto routing learned words for a bot (the user re-asked it right after another was picked). */
  learn(botId: string, words: string[]): void;
  bot(botId: string): BotProfile | null;
  /** Every crew bot (members can be added from them). */
  bots(): BotProfile[];
  /** Creates a crew bot (a room's "new member"). */
  createBot(fields: Record<string, unknown>): BotProfile;
  /** Updates a crew bot's profile (a room's member editor). */
  updateBot(botId: string, fields: Record<string, unknown>): BotProfile;
  logUsage(entry: Record<string, unknown>): void;
  /** A member's permission request: by its level and the user's rules, or an Inbox item to wait on. */
  approve(botId: string, a: ApprovalView, where: string, folder: string, chat: { engine: AgentKind; chatId: string }, access: CrewAccess): ApproveResult;
  /** The bot (or everyone) is paused: it is skipped. */
  isPaused(botId: string): boolean;
  /** Why new turns may not start (the crew's daily budget is used up), or null. */
  overBudget?(): string | null;
  /** Notes it recalls for this turn ('' = none). */
  recall?(botId: string, text: string): string;
  /** A member answered (memory capture). */
  turnDone?(botId: string, where: string, ask: string, reply: string): void;
}

/** What the engine needs from the host (AppHost.attachGroups). */
export interface GroupsHostApi {
  backend(kind: AgentKind): AgentBackend | undefined;
  enabledKinds(): AgentKind[];
  /** Every chat of the enabled agents (undecorated). */
  conversations(): Conversation[];
  defaultAgent(): AgentKind;
  /** The first workspace folder (default project of new rooms). */
  workspaceFolder(): string | null;
  /** Shows a chat in the view used last. */
  showChat(conversationId: string, agent: AgentKind): void;
  /** Sends a message to the view used last. */
  postActive(msg: HostToView): void;
  /** The bot chats changed: send the chat list again (they are hidden there). */
  refreshConversations(): void;
  pickFolder(): Promise<string | null>;
  confirm(message: string, action?: string): Promise<boolean>;
  log(line: string): void;
  /** The crew the rooms belong to (null in a window without one: rooms still talk, as plain bots). */
  crew(): RoomCrewApi | null;
}

export type GroupViewMsg = Extract<ViewToHost, { type: 'groupWatch' | 'groupAction' | 'groupSend' }>;

/** What the host calls on the engine. */
export interface GroupsHooks {
  bind(api: GroupsHostApi): void;
  /** A room message from a view; may return a toast text. */
  handle(viewId: string, post: (m: HostToView) => void, msg: GroupViewMsg): Promise<string | void>;
  /** The view closed. */
  forgetView(viewId: string): void;
  /** A member's (or the router's) hidden chat. */
  isBotChat(conversationId: string): boolean;
  dispose(): void;
}
