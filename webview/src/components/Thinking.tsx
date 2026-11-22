// ui/components/ThinkingAccordion.kt
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { Collapse, Icon } from '../ui/primitives';
import { formatDuration } from '../util/format';

/** Expanded state per thought, so it survives the message re-rendering (ToolCallExpansionCache-like). */
const expanded = new Map<string, boolean>();
export const clearThoughtState = () => expanded.clear();

/** How long a finished thought has to stay off-screen before it closes. */
const CLOSE_OFFSCREEN_MS = 1500;

export function ThinkingAccordion(props: { id: string; text: string; durationMs: number | null | undefined; streaming: boolean }) {
  const [open, setOpen] = createSignal(expanded.get(props.id) ?? props.streaming);
  let manual = expanded.has(props.id);
  let root!: HTMLDivElement;
  // Open while the thought streams. Once it is done it stays open while on screen (never closing under the reader's
  // eyes) and closes only after it has left the screen, like the app, whose list drops items scrolled away so they
  // come back closed. The earlier thoughts of a long reply still don't fill the chat. A thought the user opened or
  // closed keeps their choice.
  let visible = true;
  let closeTimer: number | undefined;
  const closeLater = () => {
    clearTimeout(closeTimer);
    if (manual || props.streaming || !open() || visible) return;
    closeTimer = window.setTimeout(() => {
      if (!manual && !props.streaming && !visible) setOpen(false);
    }, CLOSE_OFFSCREEN_MS);
  };
  createEffect(
    on(
      () => props.streaming,
      (s) => {
        if (manual) return;
        if (s) setOpen(true);
        // done while already off-screen (a long reply pushed it up): close it from there
        else closeLater();
      },
    ),
  );
  onMount(() => {
    const io = new IntersectionObserver(
      (entries) => {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible) clearTimeout(closeTimer);
        else closeLater();
      },
      { root: root.closest('.feed-scroll') },
    );
    io.observe(root);
    onCleanup(() => {
      io.disconnect();
      clearTimeout(closeTimer);
    });
  });
  const toggle = () => {
    manual = true;
    clearTimeout(closeTimer);
    const next = !open();
    setOpen(next);
    expanded.set(props.id, next);
  };
  const preview = createMemo(() => {
    for (const l of props.text.trim().split('\n')) {
      const t = l.trim().replace(/^#/, '').replace(/^\*/, '').replace(/^-/, '').trim();
      if (t) return t;
    }
    return '';
  });
  const duration = () => (props.durationMs && props.durationMs > 0 ? formatDuration(props.durationMs) : '');

  return (
    <div class="thinking" ref={root}>
      <button class="thinking-head" onClick={toggle} aria-expanded={open()}>
        <Icon name="chevron_right" size={15} class="chev" style={{ transform: open() ? 'rotate(90deg)' : 'none' }} />
        <Icon name="psychology" size={15} class="thinking-brain" />
        <Show
          when={props.streaming}
          fallback={
            <>
              <span class="thinking-title">{duration() ? `Thought for ${duration()}` : 'Thinking process'}</span>
              <Show when={!open() && preview()}>
                <span class="thinking-sep">·</span>
                <span class="thinking-preview">{preview()}</span>
              </Show>
            </>
          }
        >
          <span class="thinking-dot" />
          <span class="thinking-live">Thinking...</span>
        </Show>
      </button>
      <Collapse when={open()}>
        <div class="thinking-body">
          <div class="thinking-bar" />
          <div class="thinking-content">
            <div class="thinking-text">{props.text}</div>
            <Show when={!props.streaming && duration()}>
              <div class="thinking-duration">⏱️ Thought for {duration()}</div>
            </Show>
          </div>
        </div>
      </Collapse>
    </div>
  );
}
