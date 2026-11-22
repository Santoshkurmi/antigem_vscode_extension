// Group chats as they were saved before the Crew (~/.antigem/groups/<id>/group.json): read once by the migration
// (store/migrate.ts), which copies them into Crew rooms. Nothing writes these files any more.
import type { Group } from '../rooms/types';

/** A group read from disk (an older or hand-edited file) with every field present. */
export function normalize(raw: Partial<Group>, id: string): Group {
  const now = Date.now();
  return {
    id,
    title: String(raw.title ?? 'Group chat'),
    topic: String(raw.topic ?? ''),
    userName: String(raw.userName ?? 'You'),
    bots: Array.isArray(raw.bots)
      ? raw.bots.map((b) => ({
          id: String(b.id),
          name: String(b.name ?? 'Bot'),
          agent: b.agent,
          modelId: b.modelId ?? null,
          persona: String(b.persona ?? ''),
          emoji: String(b.emoji ?? '🤖'),
          color: String(b.color ?? '#6366F1'),
          chattiness: clamp(Number(b.chattiness ?? 40), 0, 100),
          access: b.access === 'read' || b.access === 'edit' ? b.access : 'chat',
          effort: String(b.effort ?? 'default'),
          muted: b.muted === true,
          chatId: b.chatId ?? null,
          seen: Number(b.seen ?? 0),
          title: '',
          description: '',
          aliases: [],
        }))
      : [],
    // the old 'natural' mode (the user always got an answer) is 'auto' now
    mode: raw.mode === 'everyone' || raw.mode === 'moderator' ? raw.mode : 'auto',
    lead: null,
    drafting: 'turns',
    turnsPerMember: 1,
    moderatorAgent: raw.moderatorAgent ?? null,
    moderatorModelId: raw.moderatorModelId ?? null,
    moderatorChatId: raw.moderatorChatId ?? null,
    moderatorSeen: Number(raw.moderatorSeen ?? 0),
    maxBotTurns: clamp(Number(raw.maxBotTurns ?? 6), 1, 50),
    autoTalk: raw.autoTalk === true,
    idleSeconds: clamp(Number(raw.idleSeconds ?? 60), 10, 3600),
    project: raw.project ?? null,
    paused: raw.paused === true,
    botTurns: Number(raw.botTurns ?? 0),
    waiting: raw.waiting === true,
    heldMessages: [],
    goal: null,
    summaryUpTo: 0,
    createdAt: Number(raw.createdAt ?? now),
    updatedAt: Number(raw.updatedAt ?? now),
    messages: Array.isArray(raw.messages) ? raw.messages : [],
  };
}

export const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo);
