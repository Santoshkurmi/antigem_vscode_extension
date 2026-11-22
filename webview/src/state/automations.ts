// The Automations page (src/core/crew/automations): every automation as a sentence, while the page is open.
import { createEffect, createRoot, createSignal, on } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { AutomationView } from '@shared/protocol';
import { host } from '../host';
import { groupsOpen } from './groups';

export const [autoOpen, setAutoOpen] = createSignal(false);
export const [autos, setAutos] = createStore<{ list: AutomationView[]; loaded: boolean }>({ list: [], loaded: false });

host.onMessage((m) => {
  if (m.type === 'automationsState') {
    setAutos('list', reconcile(m.automations, { key: 'id' }));
    setAutos('loaded', true);
  }
});

createRoot(() =>
  createEffect(
    on([groupsOpen, autoOpen], ([g, open]) => {
      host.send({ type: 'automationsWatch', open: g && open });
    }),
  ),
);

export function automationAction(action: 'pause' | 'resume' | 'runNow' | 'delete' | 'undo' | 'open' | 'new', id: string | null, data: Record<string, unknown> | null = null) {
  host.send({ type: 'automationAction', action, id, data });
}
