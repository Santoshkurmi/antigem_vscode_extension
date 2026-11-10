// The 52dp TopAppBar of ui/chat/ChatScreen.kt: menu, chat title (cross-fades when it changes), the project pill with
// the agents' status dot, and the new-chat button.
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js';
import { chatBackStack, chatWorkspaceUri, goBackConversation, newChat, newChatProjectUri, state } from '../state/store';
import { AgentStatusDot, AgentStatusMenu } from './AgentStatus';
import { feedScrolled } from './Feed';
import { Icon } from '../ui/primitives';
import { setProjectPickerOpen } from './ProjectPicker';
import { stateColor, workspaceName } from '../util/format';

export function TopBar(props: { onMenu: () => void }) {
  const [statusOpen, setStatusOpen] = createSignal(false);
  let dotEl: HTMLButtonElement | undefined;
  let pillEl: HTMLDivElement | undefined;

  const started = () => state.chat.order.length > 0 || state.chat.pending.length > 0;
  // an existing chat keeps its folder (even before its messages load, or when they fail to)
  const fixed = () => started() || !!state.chat.conversationId;
  const title = createMemo(() => {
    const id = state.chat.conversationId;
    const listed = id ? state.conversations.find((c) => c.id === id)?.title : undefined;
    const ok = (t?: string | null) => (t && t.trim() && t !== 'New Chat' && t !== 'Conversation' ? t : undefined);
    return ok(listed) ?? ok(state.chat.conversation?.title) ?? state.chat.conversation?.title ?? 'New Chat';
  });
  // the chat's own folder; before the chat starts, the folder picked for it ("Outside" only for a chat without one)
  const project = () => {
    if (state.chat.conversationId) {
      const uri = chatWorkspaceUri();
      if (uri) return workspaceName(uri);
      if (state.chat.conversation || started()) return 'Outside';
    }
    const next = newChatProjectUri();
    return next ? workspaceName(next) : 'Select Project';
  };
  const colors = () => state.agents.filter((a) => a.state !== 'disabled').map((a) => stateColor(a.state));
  const pending = () => state.agents.some((a) => a.state === 'starting');

  // Crossfade(targetState = title, tween(250)): the old title fades out while the new one fades in
  const [cur, setCur] = createSignal({ text: title(), k: 0 });
  const [prev, setPrev] = createSignal<{ text: string; k: number } | null>(null);
  let fadeTimer: number | undefined;
  createEffect(
    on(
      title,
      (t) => {
        setPrev(cur());
        setCur({ text: t, k: cur().k + 1 });
        clearTimeout(fadeTimer);
        fadeTimer = window.setTimeout(() => setPrev(null), 260);
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(fadeTimer));

  return (
    <header class="topbar" classList={{ lined: feedScrolled() && started() }}>
      {/* after following a chat link: back to the chat it was in (the app's back arrow) */}
      <Show
        when={chatBackStack().length}
        fallback={
          <button class="nav-btn" title="Open Drawer" onClick={props.onMenu}>
            <Icon name="menu" size={24} />
          </button>
        }
      >
        <button class="nav-btn" title="Back to the previous chat" onClick={goBackConversation}>
          <Icon name="arrow_back" size={24} />
        </button>
      </Show>
      <div class="topbar-row">
        <div class="topbar-title">
          <Show when={prev()} keyed>
            {(p) => <span class="topbar-title-text leaving">{p.text}</span>}
          </Show>
          <Show when={cur()} keyed>
            {(c) => <span class="topbar-title-text" classList={{ entering: c.k > 0 }}>{c.text}</span>}
          </Show>
        </div>
        <div class="project-pill-box">
          <div
            ref={pillEl}
            class="project-pill"
            classList={{ started: fixed(), dot: colors().length > 0 }}
            onClick={() => {
              // before the chat starts a tap picks the project; after, it shows the agents' status
              if (!fixed()) setProjectPickerOpen(true);
              else setStatusOpen(true);
            }}
          >
            <Show when={colors().length > 0}>
              <button
                ref={dotEl}
                class="project-dot"
                title="Agents"
                onClick={(e) => {
                  e.stopPropagation();
                  setStatusOpen(true);
                }}
              >
                <AgentStatusDot colors={colors()} size={colors().length > 2 ? 10 : 8} pulsing={pending()} />
              </button>
            </Show>
            <span class="project-name">{project()}</span>
            <Show when={!fixed()}>
              <Icon name="arrow_drop_down" size={16} class="project-arrow" />
            </Show>
          </div>
          <AgentStatusMenu anchor={() => pillEl} open={statusOpen()} onClose={() => setStatusOpen(false)} />

        </div>
        <button class="header-icon" title="New chat" onClick={() => newChat()}>
          <Icon name="add_comment" size={19} />
        </button>
      </div>
    </header>
  );
}
