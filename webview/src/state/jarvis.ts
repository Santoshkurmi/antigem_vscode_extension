// Jarvis (the app's command center, data/jarvis/* minus voice): the host owns the whole state and pushes it as
// `jarvis` messages (`full` = everything; otherwise only the top-level fields that changed, each complete). The view
// draws it and sends `jarvisAction`s. See docs/JARVIS.md.
import { createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { AgentKind } from '@shared/model';
import type { JarvisActionKind, JarvisManagerView, JarvisState, JarvisTaskView } from '@shared/protocol';
import { host } from '../host';

const EMPTY: JarvisState = {
  enabled: false,
  listMode: 'none',
  agent: null,
  modelId: null,
  chatIds: [],
  managers: [],
  tasks: [],
  notices: [],
  log: [],
  timers: [],
  anyActive: false,
} as JarvisState;

/** The host's Jarvis state (read-only for the view). */
export const [jarvis, setJarvis] = createStore<JarvisState>({ ...EMPTY });

/**
 * A new chat opened by "New Jarvis chat" (jarvisNewChat): its welcome shows, its model is preselected, and its first
 * send carries `jarvis: true`. Cleared once that first message is sent or another chat opens.
 */
export const [jarvisDraft, setJarvisDraft] = createSignal<{ agent: AgentKind; modelId: string | null } | null>(null);

/** The Jarvis panel (all tasks, the log, stop all). */
export const [jarvisPanelOpen, setJarvisPanelOpen] = createSignal(false);

host.onMessage((m) => {
  if (m.type === 'jarvis') {
    const patch = m.state as Partial<JarvisState>;
    if (m.full) setJarvis(reconcile({ ...EMPTY, ...patch } as JarvisState, { key: 'id', merge: false }));
    else
      for (const k of Object.keys(patch) as (keyof JarvisState)[]) {
        const v = patch[k];
        if (Array.isArray(v)) setJarvis(k as 'tasks', reconcile(v as JarvisTaskView[], { key: k === 'managers' ? 'chatId' : 'id' }));
        else setJarvis(k as 'enabled', v as boolean);
      }
  } else if (m.type === 'jarvisNewChat') {
    setJarvisDraft({ agent: m.agent, modelId: m.modelId });
    // the model for this chat only (the pill and the first send use it)
    if (m.modelId) queueMicrotask(() => import('./store').then(({ setState }) => setState('chat', 'modelId', m.modelId)));
  }
  else if (m.type === 'init') host.send({ type: 'requestJarvis' });
});

/** Send a Jarvis action (see JarvisActionKind for the fields each one takes). */
export function jarvisAction(
  action: JarvisActionKind,
  fields: { chatId?: string | null; taskId?: string | null; agent?: AgentKind | null; noticeId?: string | null; teamName?: string | null; on?: boolean | null; settingsPage?: string | null } = {},
) {
  host.send({ type: 'jarvisAction', action, ...fields });
}

/** The manager (Jarvis state) of a Jarvis chat. */
export const managerOf = (chatId: string | null | undefined): JarvisManagerView | undefined =>
  chatId ? jarvis.managers.find((m) => m.chatId === chatId) : undefined;

/** The tasks a Jarvis chat started, newest first. */
export const tasksOf = (chatId: string | null | undefined): JarvisTaskView[] => (chatId ? jarvis.tasks.filter((t) => t.owner === chatId) : []);

/** Whether a chat is a Jarvis chat. */
export const isJarvisChat = (chatId: string | null | undefined) => !!chatId && jarvis.chatIds.includes(chatId);
