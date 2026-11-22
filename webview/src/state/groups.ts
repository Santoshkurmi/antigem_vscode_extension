// Group chats (src/core/groups): the user and several AI bots in one room. The host owns everything; this view keeps
// the list, the open group (settings, bots, who is typing) and its messages, and sends groupWatch / groupAction /
// groupSend. While the screen is closed the host sends nothing.
import { createEffect, createRoot, createSignal, on } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { ChatAttachment } from '@shared/model';
import type { GroupActionKind, GroupMessageView, GroupSummaryView, GroupView } from '@shared/protocol';
import { host } from '../host';

export const [groupsOpen, setGroupsOpen] = createSignal(false);
/** The group the screen shows (null = the list). */
export const [openGroupId, setOpenGroupId] = createSignal<string | null>(null);

export const [groupList, setGroupList] = createStore<{ list: GroupSummaryView[]; loaded: boolean }>({ list: [], loaded: false });
export const [group, setGroup] = createSignal<GroupView | null>(null);
export const [groupMsgs, setGroupMsgs] = createStore<{ id: string | null; list: GroupMessageView[] }>({ id: null, list: [] });

host.onMessage((m) => {
  switch (m.type) {
    case 'groupList':
      setGroupList({ list: m.groups, loaded: true });
      return;
    case 'groupState':
      if (m.groupId !== openGroupId()) return;
      setGroup(m.group);
      if (!m.group) setOpenGroupId(null);
      return;
    case 'groupMessages': {
      if (m.groupId !== openGroupId()) return;
      if (m.full || groupMsgs.id !== m.groupId) {
        setGroupMsgs({ id: m.groupId, list: m.messages });
        return;
      }
      const list = [...groupMsgs.list];
      for (const msg of m.messages) {
        const i = list.findIndex((x) => x.id === msg.id);
        if (i >= 0) list[i] = msg;
        else list.push(msg);
      }
      setGroupMsgs('list', reconcile(list, { key: 'id' }));
      return;
    }
    case 'groupNavigate':
      setOpenGroupId(m.groupId);
      setGroupsOpen(true);
      return;
    // "Create with AI" opens a new chat: this screen gives way to it; so does a bot's chat (jarvisNavigate chat)
    case 'startChat':
      setGroupsOpen(false);
      return;
    case 'jarvisNavigate':
      if (m.screen === 'chat') setGroupsOpen(false);
      return;
  }
});

// the host sends what the screen shows, and stops when it closes
createRoot(() =>
  createEffect(
    on([groupsOpen, openGroupId], ([open, id]) => {
      if (id !== groupMsgs.id) {
        setReplyTo(null);
        setGroup(null);
        setGroupMsgs({ id: null, list: [] });
      }
      host.send({ type: 'groupWatch', groupId: id, open });
    }),
  ),
);

export function groupAction(action: GroupActionKind, fields: { groupId?: string | null; botId?: string | null; data?: Record<string, unknown> } = {}) {
  host.send({ type: 'groupAction', action, groupId: fields.groupId ?? openGroupId(), botId: fields.botId ?? null, data: fields.data ?? null });
}

/** The member message the composer replies to (its id), or null. */
export const [replyTo, setReplyTo] = createSignal<string | null>(null);

export function groupSend(text: string, attachments: ChatAttachment[]) {
  const id = openGroupId();
  if (id) host.send({ type: 'groupSend', groupId: id, text, attachments, replyTo: replyTo() });
  setReplyTo(null);
}
