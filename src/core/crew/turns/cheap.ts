// Small helper turns on the cheapest model an engine has (the router, room summaries, the goal judge, memory
// capture): a throwaway hidden chat, talk-only, deleted afterwards.
import { randomUUID } from 'node:crypto';
import type { AgentKind } from '../../../../shared/model';
import type { AgentBackend } from '../../types';
import { runTurn } from './runner';

/** The engine's cheapest-looking model (haiku, mini, flash, lite, nano, small, fast), else its default. */
export function cheapestModel(backend: AgentBackend | undefined): string | null {
  const ms = backend?.models().models ?? [];
  const cheap = ms.find((m) => /haiku|mini|flash|lite|nano|small|fast/i.test(`${m.id} ${m.displayName}`));
  return cheap?.id ?? ms.find((m) => m.isDefault)?.id ?? null;
}

/** One question to a cheap model; its final words ('' on failure). */
export async function cheapTurn(backend: AgentBackend, agent: AgentKind, text: string, folder: string, opts: { model?: string | null; timeoutMs?: number; isRunning?: (chatId: string) => boolean } = {}): Promise<string> {
  const chatId = randomUUID();
  try {
    const res = await runTurn({
      backend,
      agent,
      chatId,
      isNew: true,
      text,
      modelId: opts.model ?? cheapestModel(backend),
      folder,
      effort: 'low',
      access: 'talk',
      cancelled: () => false,
      isRunning: opts.isRunning ? () => opts.isRunning!(chatId) : undefined,
      reask: false,
      settleMs: 300,
      timeoutMs: opts.timeoutMs ?? 180_000,
    });
    return res.error && !res.text ? '' : res.text;
  } catch {
    return '';
  } finally {
    setTimeout(() => void backend.conversationAction(chatId, 'delete').catch(() => undefined), 1500);
  }
}
