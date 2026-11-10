// ui/components/ThinkingAccordion.kt
import { createEffect, createMemo, createSignal, on, Show } from 'solid-js';
import { Collapse, Icon } from '../ui/primitives';
import { formatDuration } from '../util/format';

/** Expanded state per thought, so it survives the message re-rendering (ToolCallExpansionCache-like). */
const expanded = new Map<string, boolean>();
export const clearThoughtState = () => expanded.clear();

export function ThinkingAccordion(props: { id: string; text: string; durationMs: number | null | undefined; streaming: boolean }) {
  const [open, setOpen] = createSignal(expanded.get(props.id) ?? props.streaming);
  let manual = expanded.has(props.id);
  // auto-expand while the thought streams, unless the user toggled it
  createEffect(
    on(
      () => props.streaming,
      (s) => {
        if (s && !manual) setOpen(true);
      },
    ),
  );
  const toggle = () => {
    manual = true;
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
    <div class="thinking">
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
