// The drawer's "Export Markdown (.md)" / "Export Standalone HTML" (ConversationExportHelper.kt): the chat's messages
// as a document, saved by the host with a save dialog. A chat that is not open is opened first, then exported once
// its messages have loaded.
import { createEffect, createRoot } from 'solid-js';
import { exportHtml, exportMarkdown } from '../util/exportChat';
import { messages, openConversation, send, showToast, state } from './store';

type Format = 'md' | 'html';
let pending: { id: string; format: Format; until: number } | null = null;

function run(id: string, format: Format) {
  const list = state.chat.order.map((i) => messages[i]).filter((m) => !!m);
  if (!list.length) {
    showToast('No messages to export', 'warning');
    return;
  }
  const conv = state.chat.conversation ?? state.conversations.find((c) => c.id === id) ?? null;
  const out = format === 'md' ? exportMarkdown(conv, list) : exportHtml(conv, list);
  send({ type: 'saveFile', suggestedName: out.suggestedName, content: out.content });
}

export function exportChat(id: string, format: Format) {
  showToast(format === 'md' ? 'Exporting Markdown...' : 'Exporting HTML...', 'info');
  if (state.chat.conversationId === id && !state.chat.isLoading) {
    run(id, format);
    return;
  }
  pending = { id, format, until: Date.now() + 15_000 };
  openConversation(id);
}

createRoot(() =>
  createEffect(() => {
    const ready = !state.chat.isLoading && (state.chat.order.length > 0 || !!state.chat.error);
    const id = state.chat.conversationId;
    if (!pending || !ready || id !== pending.id) return;
    const p = pending;
    pending = null;
    if (Date.now() > p.until || state.chat.error) showToast('Could not load the chat to export it', 'error');
    else run(p.id, p.format);
  }),
);
