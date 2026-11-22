// Crew (src/core/crew): the bots and crew settings the Crew screen shows, while it is open. The Crew home is the
// Group chats screen's list page (rooms = group chats); a bot's DM is a normal chat drawn with the bot's face.
import { createEffect, createRoot, createSignal, on } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { CrewActionKind, CrewStateView } from '@shared/protocol';
import { host } from '../host';
import { groupsOpen, openGroupId, setGroupsOpen, setOpenGroupId } from './groups';
import { mcOpen, setMcOpen } from './jobs';
import { setAutoOpen } from './automations';
import { newChat, setState, state } from './store';

export const [crew, setCrew] = createStore<CrewStateView & { loaded: boolean }>({ bots: [], crewAccess: null, root: '', softNotes: {}, jobs: { working: 0, waiting: 0, needsYou: 0, today: 0 }, paused: false, agyCrewServer: 'ask', chiefId: null, changes: [], hasProblems: false, aboutMe: [], usage: { today: { tokens: 0, usd: 0, turns: 0 }, caps: { dayTokens: null, dayUsd: null }, over: null }, tourDone: true, loaded: false });
/** The bot editor: a bot id, 'new', or closed (null). */
export const [editBot, setEditBot] = createSignal<string | 'new' | null>(null);

host.onMessage((m) => {
  switch (m.type) {
    case 'crewState':
      setCrew(reconcile({ ...m.crew, loaded: true }, { key: 'id' }));
      return;
    case 'crewNavigate':
      setMcOpen(false);
      setAutoOpen(false);
      setOpenGroupId(null);
      setGroupsOpen(true);
      setEditBot(m.botId);
      return;
    case 'crewDm':
      // an empty chat of the bot's agent; its first message starts the DM
      setEditBot(null);
      setGroupsOpen(false);
      newChat(m.agent);
      setState('chat', 'crew', m.tag);
      if (m.modelId) setState('chat', 'modelId', m.modelId);
      return;
  }
});

// the bots are sent while the Crew home (or a bot editor) is on screen
createRoot(() =>
  createEffect(
    on([groupsOpen, openGroupId, editBot, mcOpen], ([open, id, edit, mc]) => {
      host.send({ type: 'crewWatch', open: open && !mc && (!id || !!edit) });
    }),
  ),
);

export function crewAction(action: CrewActionKind, botId: string | null = null, data: Record<string, unknown> | null = null) {
  host.send({ type: 'crewAction', action, botId, data });
}

/** The bot a chat belongs to (a DM opened from the Crew, or one being started). */
export function chatCrewTag() {
  return state.chat.crew ?? state.chat.conversation?.crew ?? state.conversations.find((c) => c.id === state.chat.conversationId)?.crew ?? null;
}
