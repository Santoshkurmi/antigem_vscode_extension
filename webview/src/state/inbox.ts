// The Crew's Inbox (src/core/crew/inbox.ts): everything a crew bot needs from you, from every bot, and the crew's
// status. Asked for once at start; the host sends it again on every change.
import { createStore, reconcile } from 'solid-js/store';
import type { CrewStatusView, InboxItemView } from '@shared/protocol';
import { host } from '../host';

export const [inbox, setInbox] = createStore<{ items: InboxItemView[]; status: CrewStatusView }>({ items: [], status: { working: 0, needsYou: 0, paused: false } });

host.onMessage((m) => {
  if (m.type === 'crewInbox') {
    setInbox('items', reconcile(m.items, { key: 'id' }));
    setInbox('status', m.status);
  }
  // the view (re)connected: ask again
  if (m.type === 'init') host.send({ type: 'inboxWatch', open: true });
});

export function inboxAnswer(id: string, choice: string, note: string | null = null) {
  host.send({ type: 'inboxAnswer', id, choice, note });
}
