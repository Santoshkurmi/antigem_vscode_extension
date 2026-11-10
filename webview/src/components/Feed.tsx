// The chat feed of ui/chat/ChatScreen.kt: the LazyColumn of feed items, the working row, auto-follow while the
// agent works, the floating scroll button, and the empty / loading / error states.
import { batch, createEffect, createMemo, createRoot, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from 'solid-js';
import type { ChatMessage } from '@shared/model';
import { agentStatus, awaitingReply, enabledAgents, messages, pickAgent, send, setAwaitingReply, state } from '../state/store';
import { AssistantMessage, SummaryCard, UserBubble, WaveDivider } from './Messages';
import { WorkingSpinner } from './WorkingSpinner';
import { AgentMark, AgentPicker } from './AgentStatus';
import { Fade, Icon } from '../ui/primitives';
import { fontScale } from '../theme';
import { agentAccent, agentLabel, dayKey, dayLabel, shortModelName, stateColor } from '../util/format';

/** The top bar draws its bottom line when the chat is scrolled under it. */
export const [feedScrolled, setFeedScrolled] = createSignal(false);

const WINDOW = 60;
const GAP_DIVIDER_MS = 60 * 60 * 1000;
const scrollCache = new Map<string, { top: number; atBottom: boolean }>();

const msgOf = (id: string): ChatMessage | undefined => messages[id] ?? state.chat.pending.find((m) => m.id === id);

const { feedIds, lastMsg, isRunning } = createRoot(() => {
  /** Every message id the feed shows: the host's order, then prompts sent from here that it has not listed yet. */
  const feedIds = createMemo(() => [...state.chat.order, ...state.chat.pending.map((m) => m.id)]);
  const lastMsg = createMemo(() => {
    const ids = feedIds();
    return ids.length ? msgOf(ids[ids.length - 1]) : undefined;
  });
  // a prompt was sent and the agent has not answered yet: the working row stays up through the host's first patches
  // (which can briefly list the prompt before the reply or the streaming flag), so it never blinks out and back
  createEffect(() => {
    if (!awaitingReply()) return;
    const last = lastMsg();
    if (state.chat.isStreaming || last?.role === 'ASSISTANT' || state.chat.error) setAwaitingReply(false);
  });
  /** The agent works (or a prompt from here is on its way). */
  const isRunning = createMemo(
    () => state.chat.isStreaming || !!lastMsg()?.isStreaming || state.chat.pending.length > 0 || awaitingReply(),
  );
  return { feedIds, lastMsg, isRunning };
});
export { isRunning };

export function Feed() {
  const hasMessages = () => feedIds().length > 0;
  return (
    <Switch>
      <Match when={!hasMessages() && state.chat.error && state.chat.conversationId}>
        <LoadError />
      </Match>
      <Match when={!hasMessages() && state.chat.isLoading && state.chat.conversationId}>
        <ConversationSkeleton />
      </Match>
      <Match when={!hasMessages()}>
        <EmptyChat />
      </Match>
      <Match when={hasMessages()}>
        <FeedList />
      </Match>
    </Switch>
  );
}

function FeedList() {
  let scroller!: HTMLDivElement;
  let content!: HTMLDivElement;
  const [limit, setLimit] = createSignal(WINDOW);
  const [follow, setFollow] = createSignal(true);
  const [atBottom, setAtBottom] = createSignal(true);
  const [atTop, setAtTop] = createSignal(true);
  const [showButton, setShowButton] = createSignal(false);
  const [direction, setDirection] = createSignal<'up' | 'down'>('down');

  const visibleIds = createMemo(() => {
    const ids = feedIds();
    return ids.length > limit() ? ids.slice(ids.length - limit()) : ids;
  });

  // dividers (ChatFeedCache.buildFeedItems with dividers = true): a new day / an hour's gap before a prompt, and
  // "Switched to <model>" before the prompt whose reply used another model
  const dividers = createMemo(() => {
    const out = new Map<string, string[]>();
    let lastDay: string | null = null;
    let lastPromptAt = 0;
    let lastModel: string | null = null;
    let promptId: string | null = null;
    const add = (id: string, label: string, front = false) => {
      const l = out.get(id) ?? [];
      if (front) l.unshift(label);
      else l.push(label);
      out.set(id, l);
    };
    for (const id of feedIds()) {
      const m = msgOf(id);
      if (!m) continue;
      if (m.role === 'USER') {
        const day = dayKey(m.createdAt);
        if (day !== lastDay) {
          add(id, dayLabel(m.createdAt));
          lastDay = day;
        } else if (lastPromptAt > 0 && m.createdAt - lastPromptAt >= GAP_DIVIDER_MS) {
          add(id, dayLabel(m.createdAt));
        }
        lastPromptAt = m.createdAt;
        promptId = id;
      }
      if (m.role === 'ASSISTANT' && m.modelId) {
        if (lastModel != null && m.modelId !== lastModel) add(promptId ?? id, `Switched to ${modelName(m.modelId)}`, true);
        lastModel = m.modelId;
      }
      if (m.role === 'ASSISTANT') promptId = null;
    }
    return out;
  });

  // ---- the working row (ChatScreen: showWorkingRow / holdingTail)
  const footerShown = () => {
    const m = lastMsg();
    return !!m && m.role === 'ASSISTANT' && !m.isStreaming && m.content.length > 0;
  };
  const lastIsAssistantWithText = () => {
    const m = lastMsg();
    return !!m && m.role === 'ASSISTANT' && m.content.length > 0;
  };
  const [tailFinishing, setTailFinishing] = createSignal(false);
  let tailTimer: number | undefined;
  createEffect(
    on(isRunning, (running, was) => {
      clearTimeout(tailTimer);
      if (was && !running) {
        setTailFinishing(true);
        tailTimer = window.setTimeout(() => setTailFinishing(false), 1000);
      } else setTailFinishing(false);
    }),
  );
  createEffect(() => {
    if (tailFinishing() && (footerShown() || !lastIsAssistantWithText())) {
      clearTimeout(tailTimer);
      tailTimer = window.setTimeout(() => setTailFinishing(false), 300);
    }
  });
  onCleanup(() => clearTimeout(tailTimer));
  const waitingForUser = () =>
    state.chat.approvals.length > 0 ||
    !!state.chat.question ||
    !!lastMsg()?.toolCalls.some((t) => t.status === 'PENDING_APPROVAL' || t.status === 'AWAITING_CHOICE');
  const holdingTail = () => tailFinishing() && lastIsAssistantWithText() && !footerShown();
  const showWorking = () => (isRunning() || holdingTail()) && !waitingForUser() && !footerShown();

  // ---- scrolling
  let userInput = 0; // time of the last wheel / key / touch / drag
  let lastTop = 0;
  let hideTimer: number | undefined;
  const markUser = () => (userInput = performance.now());
  const toBottom = () => {
    scroller.scrollTop = scroller.scrollHeight;
  };
  const measure = () => {
    const bottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 4;
    setAtBottom(bottom);
    setAtTop(scroller.scrollTop <= 0);
    setFeedScrolled(scroller.scrollTop > 0);
    if (bottom) setFollow(true);
  };
  const onScroll = () => {
    const top = scroller.scrollTop;
    const user = performance.now() - userInput < 400;
    if (user) {
      const dir = top < lastTop ? 'up' : top > lastTop ? 'down' : null;
      if (dir) setDirection(dir);
      if (dir === 'up') setFollow(false);
      setShowButton(true);
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setShowButton(false), 4000);
    }
    lastTop = top;
    measure();
    // older messages come in as the top gets near
    if (top < 300 && limit() < feedIds().length) {
      setLimit((l) => l + WINDOW);
    }
  };

  // follow the tail in the same frame the content grows (ResizeObserver runs before paint); right after the chat
  // opens (or a prompt is sent) heights still settle (content-visibility, images, highlighting): stay pinned then too
  let settleUntil = performance.now() + 1500;
  const following = () => follow() && (isRunning() || tailFinishing() || performance.now() < settleUntil);
  onMount(() => {
    const convId = state.chat.conversationId;
    const saved = convId ? scrollCache.get(convId) : undefined;
    if (saved && !saved.atBottom) {
      scroller.scrollTop = saved.top;
      setFollow(false);
    } else toBottom();
    lastTop = scroller.scrollTop;
    measure();
    const ro = new ResizeObserver(() => {
      if (following()) toBottom();
      measure();
    });
    ro.observe(content);
    ro.observe(scroller);
    onCleanup(() => {
      ro.disconnect();
      if (convId) scrollCache.set(convId, { top: scroller.scrollTop, atBottom: atBottom() });
      setFeedScrolled(false);
    });
  });
  onCleanup(() => clearTimeout(hideTimer));

  // the user sent a message: jump to the end and follow again
  createEffect(
    on(
      () => state.chat.sentTick,
      () => {
        batch(() => {
          setFollow(true);
          setLimit(WINDOW);
        });
        settleUntil = performance.now() + 1500;
        // now, in the same task as the new bubble: the next paint already shows the end of the chat
        toBottom();
      },
      { defer: true },
    ),
  );

  const jump = () => {
    setShowButton(false);
    if (direction() === 'up') {
      setLimit(feedIds().length);
      requestAnimationFrame(() => (scroller.scrollTop = 0));
    } else {
      setFollow(true);
      toBottom();
    }
  };
  const showUp = () => showButton() && direction() === 'up' && !atTop();
  const showDown = () => showButton() && direction() === 'down' && !atBottom();

  return (
    <div class="feed-wrap">
      <div
        class="feed-scroll"
        classList={{ pinned: follow() }}
        style={{ '--sp': `calc(0.965px * ${fontScale()})` }}
        ref={scroller}
        onScroll={onScroll}
        onWheel={markUser}
        onTouchMove={markUser}
        onPointerDown={markUser}
        onKeyDown={markUser}
        tabIndex={-1}
      >
        <div class="feed-content" ref={content}>
          <For each={visibleIds()}>
            {(id, i) => (
              <>
                <For each={dividers().get(id) ?? []}>{(label) => <WaveDivider label={label} />}</For>
                <MessageItem id={id} recent={i() >= visibleIds().length - RECENT} />
              </>
            )}
          </For>
          <Show when={showWorking()}>
            <WorkingSpinner
              color={agentAccent(state.chat.agent)}
              compacting={/compact/i.test(state.chat.workingLabel ?? '')}
              label={state.chat.workingLabel}
            />
          </Show>
          <div class="feed-bottom" />
        </div>
      </div>
      <Fade when={(showUp() || showDown()) && feedIds().length > 1} class="scroll-btn-wrap" scale={0.8}>
        <button class="scroll-btn" onClick={jump} title={showUp() ? 'Jump to Top' : 'Jump to Bottom'}>
          <Icon name={showUp() ? 'chevron_up' : 'chevron_down'} size={22} color="var(--primary)" />
        </button>
      </Fade>
    </div>
  );
}

function modelName(id: string): string {
  for (const s of Object.values(state.models)) {
    const m = s?.models.find((x) => x.id === id);
    if (m) return m.displayName;
  }
  return shortModelName(id);
}

/**
 * The newest messages never get content-visibility: a message added below the screen would otherwise be laid out at
 * its placeholder height (160px) and snap to its real height a frame later, which shakes the chat on every send.
 */
const RECENT = 6;

function MessageItem(props: { id: string; recent: boolean }) {
  const m = () => msgOf(props.id);
  return (
    <Show when={m()}>
      {(msg) => (
        <div class="msg" classList={{ cv: !props.recent }}>
          <Switch>
            <Match when={msg().role === 'USER'}>
              <UserBubble msg={msg()} />
            </Match>
            <Match when={msg().role === 'ASSISTANT'}>
              <AssistantMessage msg={msg()} />
            </Match>
            <Match when={msg().role === 'SUMMARY'}>
              <SummaryCard msg={msg()} />
            </Match>
          </Switch>
        </div>
      )}
    </Show>
  );
}

// ------------------------------------------------------------------------------------------------ empty / loading

function EmptyChat() {
  const agent = () => state.chat.agent;
  const fresh = () => !state.chat.conversation || state.chat.conversation.title === 'New Chat';
  const status = () => agentStatus(agent());
  const notReady = () => {
    const s = status()?.state;
    return s && s !== 'online';
  };
  return (
    <div class="empty-scroll">
      <div class="empty">
        <Show when={fresh()}>
          <div class="agent-picker-box">
            <AgentPicker selected={agent()} agents={enabledAgents()} onSelect={pickAgent} />
          </div>
        </Show>
        <Show
          when={notReady()}
          fallback={
            <>
              <div class="empty-title">How can I help you today?</div>
              <div class="empty-sub">Ask a question, brainstorm ideas, or start coding</div>
            </>
          }
        >
          <AgentSetupPrompt />
        </Show>
      </div>
    </div>
  );
}

/** AgentSetupPrompt: the agent is not ready (starting, offline, not installed). */
function AgentSetupPrompt() {
  const agent = () => state.chat.agent;
  const s = () => agentStatus(agent());
  const title = () => {
    switch (s()?.state) {
      case 'starting':
        return `Starting ${agentLabel(agent())}…`;
      case 'not_installed':
        return `${agentLabel(agent())} is not installed`;
      default:
        return `${agentLabel(agent())} is unavailable`;
    }
  };
  const message = () =>
    s()?.state === 'starting'
      ? 'Waiting for the server to come up. This takes a few seconds.'
      : s()?.detail ?? 'The agent is not running.';
  return (
    <div class="setup-prompt">
      <AgentMark agent={agent()} size={60} statusColor={stateColor(s()?.state)} />
      <div class="setup-title">{title()}</div>
      <div class="setup-msg">{message()}</div>
      <Show when={s()?.state !== 'starting'}>
        <button class="filled-btn" style={{ background: agentAccent(agent()) }} onClick={() => send({ type: 'retryConnections' })}>
          Retry
        </button>
      </Show>
    </div>
  );
}

function LoadError() {
  return (
    <div class="empty">
      <Icon name="cloud_off" size={48} color="var(--error)" />
      <div class="load-error-title">Unable to Load Chat</div>
      <div class="load-error-msg">{state.chat.error || 'Failed to load conversation messages.'}</div>
      <button
        class="filled-btn"
        onClick={() => {
          const id = state.chat.conversationId;
          if (id) send({ type: 'openConversation', id });
          else send({ type: 'retryConnections' });
        }}
      >
        <Icon name="refresh_f" size={16} /> Retry
      </button>
    </div>
  );
}

/** ConversationLoadingSkeleton with the shimmer brush. */
export function ConversationSkeleton() {
  return (
    <div class="skeleton">
      <div class="sk-row end">
        <div class="shimmer sk-user" style={{ width: '200px', height: '44px' }} />
      </div>
      <div class="sk-assistant" style={{ width: '88%' }}>
        <div class="shimmer" style={{ width: '110px', height: '20px', 'border-radius': '10px' }} />
        <div class="shimmer sk-line" style={{ width: '95%' }} />
        <div class="shimmer sk-line" style={{ width: '82%' }} />
        <div class="shimmer sk-line" style={{ width: '58%' }} />
      </div>
      <div class="sk-row end">
        <div class="shimmer sk-user" style={{ width: '160px', height: '40px' }} />
      </div>
      <div class="sk-assistant" style={{ width: '92%' }}>
        <div class="shimmer sk-line" style={{ width: '100%' }} />
        <div class="shimmer sk-line" style={{ width: '88%' }} />
        <div class="shimmer sk-line" style={{ width: '65%' }} />
      </div>
    </div>
  );
}

