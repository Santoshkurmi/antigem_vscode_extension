// ui/components/MessageBubble.kt (ContextSummaryCheckpointBanner) and ui/components/ContextSummaryCard.kt
// (LiveSummarizingCard). The app's ClaudeTerracotta is the theme's primary (theme/Color.kt), so these use --primary.
import { createSignal, Show } from 'solid-js';

/** "🧠 Context Compacted (History Summarized)": tap to show the summary (selectable) under a divider. */
export function ContextCompactedBanner(props: { summary: string }) {
  const [expanded, setExpanded] = createSignal(false);
  return (
    <div
      class="ctx-banner"
      onClick={() => {
        // a click that selected text is not a tap
        if (window.getSelection()?.toString()) return;
        setExpanded(!expanded());
      }}
    >
      <div class="ctx-banner-head">
        <span class="ctx-banner-title">🧠 Context Compacted (History Summarized)</span>
        <span class="ctx-banner-toggle">{expanded() ? 'Hide ▲' : 'Show Details ▼'}</span>
      </div>
      <Show when={expanded()}>
        <div class="ctx-banner-divider" />
        <div class="ctx-banner-text">{props.summary}</div>
      </Show>
    </div>
  );
}

/** Live card while the agent summarizes the context; a message sent meanwhile waits for it. */
export function SummarizingCard(props: { model?: string | null; queued?: string | null }) {
  const queued = () => props.queued ?? '';
  return (
    <div class="ctx-summarizing">
      <div class="ctx-summarizing-row">
        <span class="ctx-dot" />
        <span class="ctx-dot" style={{ opacity: 0.8 }} />
        <span class="ctx-dot" style={{ opacity: 0.6 }} />
        <span class="ctx-summarizing-text">Summarizing context with {props.model?.trim() || 'AI'}...</span>
      </div>
      <Show when={queued().trim()}>
        <div class="ctx-summarizing-queued">
          ⏳ Queued: "{queued().slice(0, 80)}"{queued().length > 80 ? '...' : ''} (will send immediately after summary)
        </div>
      </Show>
    </div>
  );
}
