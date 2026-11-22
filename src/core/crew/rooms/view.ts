// What the room screen gets (shared/protocol.ts GroupView & co.), built from the in-memory room and its runtime.
import type { AgentKind } from '../../../../shared/model';
import type { GroupBotView, GroupMessageView, GroupSummaryView, GroupView } from '../../../../shared/protocol';
import { evidenceLines } from '../turns/evidence';
import type { BotProfile } from '../types';
import type { Bot, Group, Msg } from './types';

export interface RuntimeView {
  typing: { botId: string; activity: 'typing' | 'working' | 'waiting'; step: string | null }[];
  status: string | null;
  queue: { id: string; text: string }[];
}

export function roomView(g: Group, rt: RuntimeView | null, crewBots: BotProfile[]): GroupView {
  const members = new Set(g.bots.map((b) => b.id));
  return {
    id: g.id,
    title: g.title,
    topic: g.topic,
    userName: g.userName,
    bots: g.bots.map((b) => botView(b, g.heldMessages.filter((h) => h.botId === b.id).length)),
    mode: g.mode,
    lead: g.lead,
    drafting: g.drafting,
    turnsPerMember: g.turnsPerMember,
    moderatorAgent: g.moderatorAgent,
    moderatorModelId: g.moderatorModelId,
    maxBotTurns: g.maxBotTurns,
    autoTalk: g.autoTalk,
    idleSeconds: g.idleSeconds,
    project: g.project,
    paused: g.paused,
    waiting: g.waiting,
    typing: rt?.typing ?? [],
    status: rt?.status ?? null,
    queue: rt?.queue ?? [],
    goal: g.goal ? { text: g.goal.text, status: g.goal.status, turns: g.goal.turns, maxTurns: g.goal.maxTurns, note: g.goal.note } : null,
    others: crewBots.filter((b) => !members.has(b.id)).map((b) => ({ id: b.id, name: b.name, emoji: b.emoji, color: b.color, title: b.title, agent: b.engine as AgentKind })),
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

export function botView(b: Bot, held = 0): GroupBotView {
  return {
    id: b.id,
    name: b.name,
    agent: b.agent,
    modelId: b.modelId,
    persona: b.persona,
    emoji: b.emoji,
    color: b.color,
    chattiness: b.chattiness,
    access: b.access,
    effort: b.effort,
    muted: b.muted,
    chatId: b.chatId,
    title: b.title,
    aliases: b.aliases,
    voice: b.voice ?? null,
    held,
  };
}

export function msgView(m: Msg): GroupMessageView {
  return {
    id: m.id,
    from: m.from,
    name: m.name,
    text: m.text,
    at: m.at,
    attachments: m.attachments,
    replyTo: m.replyTo ?? null,
    picked: m.picked ?? null,
    digest: m.digest ?? null,
    evidence: m.evidence ? evidenceLines(m.evidence) : null,
    usage: m.usage ?? null,
  };
}

export function summaryView(g: Group, active: boolean): GroupSummaryView {
  const last = [...g.messages].reverse().find((m) => m.from !== 'notice' && m.from !== 'system');
  return {
    id: g.id,
    title: g.title,
    topic: g.topic,
    bots: g.bots.map((b) => ({ name: b.name, emoji: b.emoji, color: b.color, agent: b.agent })),
    lastText: last ? preview(last.text) : '',
    lastName: last?.name ?? '',
    messageCount: g.messages.filter((m) => m.from !== 'notice').length,
    updatedAt: g.updatedAt,
    active,
  };
}

/** One line for the room list: code and images as short labels, Markdown marks out. */
export function preview(text: string): string {
  return text
    .replace(/```(\w*)[\s\S]*?(```|$)/g, (_m, lang: string) => ` [${lang === 'mermaid' ? 'diagram' : 'code'}] `)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}
