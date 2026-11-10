// ui/components/MessageBubble.kt (UserMessageBubble, AssistantMessageFooter, TokenUsageTelemetryPill) and how
// ui/chat/ChatFeedCache.kt turns an assistant message into blocks + footer.
import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show } from 'solid-js';
import type { ChatAttachment, ChatMessage, TokenUsage } from '@shared/model';
import { parseIncremental } from '../markdown/parse';
import { BlockView } from './Markdown';
import { ThinkingAccordion } from './Thinking';
import { setArtifactsOpen } from './Artifacts';
import { attKind, openAttachment, SelectionChip, useImageSrc } from './Attachments';
import { ContextCompactedBanner, SummarizingCard } from './ContextCards';
import { openTokenDetails } from './TokenDetails';
import { Collapse, Dialog, Icon, IconButton } from '../ui/primitives';
import { compactTokens, formatDuration, formatSize, shortModelName } from '../util/format';
import { copyText, send, state } from '../state/store';
import { themeMode } from '../theme';

// ------------------------------------------------------------------------------------------------ user

export function UserBubble(props: { msg: ChatMessage }) {
  const [actions, setActions] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [overflowing, setOverflowing] = createSignal(false);
  let textEl: HTMLDivElement | undefined;
  let bubbleEl: HTMLDivElement | undefined;

  const text = () => props.msg.content.trim();
  const lineCount = () => text().split('\n').length;
  // images (inline data, or read from their path by the host), selections as code ranges, then files / folders
  const images = createMemo(() => props.msg.attachments.filter((a) => attKind(a) === 'image' && !(a.reference && !a.base64 && !a.path)));
  const ranges = createMemo(() => props.msg.attachments.filter((a) => attKind(a) === 'selection'));
  const docs = createMemo(() => props.msg.attachments.filter((a) => !a.isAudio && !images().includes(a) && !ranges().includes(a)));
  const [confirmEdit, setConfirmEdit] = createSignal(false);
  const [restoreFiles, setRestoreFiles] = createSignal(false);
  const agent = () => state.chat.agent;
  const canRestore = () => agent() === 'CLAUDE' || agent() === 'OPENCODE';
  const hasLater = () => {
    const order = state.chat.order;
    const i = order.indexOf(props.msg.id);
    return i >= 0 && i < order.length - 1;
  };
  const rewind = (restore: boolean) => {
    const id = state.chat.conversationId;
    if (id) send({ type: 'rewind', conversationId: id, messageId: props.msg.id, ...(restore ? { restoreFiles: true } : {}) });
  };
  // slash commands that expanded (custom commands, plugins) stand out from the typed text (PromptExpansion.commandRanges)
  const styled = createMemo(() => {
    const t = text();
    if (!t.includes('/')) return null;
    const known = new Set((state.commands[agent()] ?? []).filter((c) => c.kind === 'custom' || c.kind === 'plugin').map((c) => c.command.toLowerCase()));
    if (!known.size) return null;
    const parts: { t: string; cmd: boolean }[] = [];
    let last = 0;
    for (const m of t.matchAll(/(^|\s)(\/[\w:.-]+)/g)) {
      const start = m.index! + m[1].length;
      // a plugin is listed as `/plu:<id>:`; `/plu:<id>` and `/plu:<id>:<skill>` are that plugin too
      const tok = m[2].toLowerCase();
      const plu = /^\/plu:([^:]+)(:.*)?$/.exec(tok);
      if (!known.has(tok) && !(plu && (known.has(`/plu:${plu[1]}:`) || known.has(`/plu:${plu[1]}`)))) continue;
      if (start > last) parts.push({ t: t.substring(last, start), cmd: false });
      parts.push({ t: m[2], cmd: true });
      last = start + m[2].length;
    }
    if (!parts.length) return null;
    if (last < t.length) parts.push({ t: t.substring(last), cmd: false });
    return parts;
  });
  const measure = () => {
    if (!textEl || expanded()) return;
    setOverflowing(textEl.scrollHeight > textEl.clientHeight + 1);
  };
  onMount(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (textEl) ro.observe(textEl);
    onCleanup(() => ro.disconnect());
  });
  createEffect(on(text, () => queueMicrotask(measure), { defer: true }));

  return (
    <div class="user-msg">
      <Show when={props.msg.contextSummary && props.msg.contextSummary !== 'null'}>
        <ContextCompactedBanner summary={props.msg.contextSummary!} />
      </Show>
      <div ref={bubbleEl} class="user-bubble" onClick={(e) => {
        // a click that selected text is not a tap
        if (window.getSelection()?.toString()) return;
        if ((e.target as HTMLElement).closest('a,button,[data-file],.user-image')) return;
        setActions(!actions());
      }}>
        <Show when={images().length}>
          <div class="user-images" classList={{ one: images().length === 1, two: images().length === 2 }}>
            <For each={images()}>{(a) => <UserImage att={a} />}</For>
          </div>
        </Show>
        <For each={ranges()}>{(a) => <SelectionChip att={a} />}</For>
        <For each={docs()}>{(a) => <DocChip att={a} />}</For>
        <Show when={text()}>
          <div>
            <div ref={textEl} class="user-text" classList={{ clamped: !expanded() }}>
              <Show when={styled()} fallback={text()}>
                <For each={styled()!}>{(p) => (p.cmd ? <span class="user-cmd">{p.t}</span> : p.t)}</For>
              </Show>
            </div>
            <Show when={expanded() || overflowing()}>
              <button
                class="user-more"
                onClick={(e) => {
                  e.stopPropagation();
                  const collapsing = expanded();
                  setExpanded(!collapsing);
                  if (collapsing) requestAnimationFrame(() => bubbleEl?.scrollIntoView({ block: 'nearest' }));
                  else setOverflowing(true);
                }}
              >
                {expanded() ? 'Show less ▲' : `Show more (${lineCount()} lines) ▼`}
              </button>
            </Show>
          </div>
        </Show>
      </div>
      <Collapse when={actions()}>
        <div class="user-actions">
          <IconButton
            icon="copy"
            iconSize={15}
            color="color-mix(in srgb, var(--on-surface) 50%, transparent)"
            title="Copy"
            onClick={() => {
              copyText(props.msg.content, 'Copied prompt');
              setActions(false);
            }}
          />
          <Show when={!props.msg.id.startsWith('local-')}>
            <IconButton
              icon="edit_o"
              iconSize={15}
              color="var(--primary)"
              title="Undo and edit prompt"
              onClick={() => {
                setActions(false);
                // with replies after it, ask first (ChatScreen's "Edit Message?")
                if (hasLater() || canRestore()) {
                  setRestoreFiles(false);
                  setConfirmEdit(true);
                } else rewind(false);
              }}
            />
          </Show>
        </div>
      </Collapse>
      <Dialog
        open={confirmEdit()}
        onClose={() => setConfirmEdit(false)}
        radius={16}
        background="var(--surface)"
        title={<span style={{ 'font-size': 'calc(18 * var(--sp))', 'font-weight': 700 }}>Edit Message?</span>}
        actions={
          <>
            <button class="text-btn" style={{ color: 'color-mix(in srgb, var(--on-surface) 60%, transparent)' }} onClick={() => setConfirmEdit(false)}>
              Cancel
            </button>
            <button
              class="text-btn strong"
              style={{ color: 'var(--primary)' }}
              onClick={() => {
                setConfirmEdit(false);
                rewind(canRestore() && restoreFiles());
              }}
            >
              {agent() === 'AGY' ? 'Edit & Delete' : 'Edit'}
            </button>
          </>
        }
      >
        <div class="edit-confirm-text">
          {agent() === 'CODEX'
            ? 'This chat goes back to right before this message, so you can change it and send again. Everything after it is removed from the chat. Files Codex changed stay as they are.'
            : canRestore()
              ? 'This chat goes back to right before this message, so you can change it and send again. Everything after it is removed from the chat.'
              : 'Editing this message will delete the subsequent response so you can edit and send a fresh query. Do you want to continue?'}
        </div>
        <Show when={canRestore()}>
          <button class="edit-restore" role="checkbox" aria-checked={restoreFiles()} onClick={() => setRestoreFiles(!restoreFiles())}>
            <span class="m-checkbox" classList={{ on: restoreFiles() }}>
              <Show when={restoreFiles()}>
                <Icon name="check" size={14} />
              </Show>
            </span>
            Also restore files {agent() === 'OPENCODE' ? 'OpenCode' : 'Claude'} changed after this message
          </button>
        </Show>
      </Dialog>
    </div>
  );
}

/** A picture sent with a prompt (UserMessageImageItem): inline data, or read by the host from its path; opens the viewer. */
function UserImage(props: { att: ChatAttachment }) {
  const src = useImageSrc(() => props.att);
  return (
    <div class="user-image" title={props.att.name} onClick={(e) => (e.stopPropagation(), openAttachment(props.att, src()))}>
      <Show when={src()} fallback={<div class="user-image-wait"><Icon name="image" size={22} /></div>}>
        <img src={src()!} alt={props.att.name} />
      </Show>
    </div>
  );
}

function DocChip(props: { att: ChatAttachment }) {
  return (
    <div
      class="user-doc"
      data-file={props.att.path || undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <Icon name={attKind(props.att) === 'folder' ? 'folder' : 'file'} size={24} color={attKind(props.att) === 'folder' ? 'var(--warning)' : 'var(--primary)'} />
      <div class="user-doc-text">
        <div class="user-doc-name">{props.att.name}</div>
        <Show when={props.att.size > 0}>
          <div class="user-doc-size">{formatSize(props.att.size)}</div>
        </Show>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ assistant

// a thought marker at the start of a line (quoted in inline code it is text)
const THOUGHT_MARK = /(^|\n)[ \t]*<(!--\s*)?thought/;

/**
 * An assistant message: its thought (from thoughtText, as ChatFeedCache prepends it), its blocks, then the footer
 * once the reply is done. Only the streaming message's blocks ever re-parse, and only their tail.
 */
export function AssistantMessage(props: { msg: ChatMessage }) {
  const m = () => props.msg;
  const hasThought = () => !!m().thoughtText && !THOUGHT_MARK.test(m().content);
  const blocks = createMemo(() => parseIncremental(m().id, m().content, m().toolCalls));
  const tool = (id: string) => m().toolCalls.find((t) => t.id === id);
  const showFooter = () => !m().isStreaming && m().content.length > 0;
  return (
    <div class="assistant-msg">
      <Show when={hasThought()}>
        <div class="feed-block">
          <div class="md-thought">
            <ThinkingAccordion id={m().id + ':thought'} text={m().thoughtText!.trim()} durationMs={m().thoughtDurationMs} streaming={m().isStreaming} />
          </div>
        </div>
      </Show>
      <Index each={blocks()}>
        {(b) => (
          <div class="feed-block">
            <BlockView block={b()} resolveTool={tool} streaming={m().isStreaming} thoughtKey={m().id} />
          </div>
        )}
      </Index>
      <Show when={showFooter()}>
        <AssistantFooter msg={m()} />
      </Show>
    </div>
  );
}

export function AssistantFooter(props: { msg: ChatMessage }) {
  const [confirmRetry, setConfirmRetry] = createSignal(false);
  let root!: HTMLDivElement;
  const selectAll = () => {
    const msgEl = root.closest('.assistant-msg');
    if (!msgEl) return;
    const sel = window.getSelection();
    const range = document.createRange();
    const blocks = msgEl.querySelectorAll('.feed-block');
    if (!blocks.length) return;
    range.setStartBefore(blocks[0]);
    range.setEndAfter(blocks[blocks.length - 1]);
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  return (
    <div class="assistant-footer" ref={root}>
      <Show when={props.msg.tokenUsage}>{(u) => <TokenPill usage={u()} />}</Show>
      <div class="assistant-actions">
        <IconButton icon="copy" iconSize={15} color="color-mix(in srgb, var(--on-surface) 40%, transparent)" title="Copy message" onClick={() => copyText(props.msg.content, 'Copied response')} />
        <IconButton icon="select_all" iconSize={16} color="color-mix(in srgb, var(--on-surface) 40%, transparent)" title="Select text" onClick={selectAll} />
        <IconButton icon="refresh" iconSize={16} color="color-mix(in srgb, var(--on-surface) 40%, transparent)" title="Regenerate response" onClick={() => setConfirmRetry(true)} />
        <Show when={state.chat.artifacts.length > 0}>
          <IconButton icon="layers" iconSize={16} color="var(--claude)" title={`View Artifacts (${state.chat.artifacts.length})`} onClick={() => setArtifactsOpen(true)} />
        </Show>
      </div>
      <Dialog
        open={confirmRetry()}
        onClose={() => setConfirmRetry(false)}
        title="Regenerate response?"
        actions={
          <>
            <button class="text-btn" onClick={() => setConfirmRetry(false)}>
              Cancel
            </button>
            <button
              class="text-btn strong"
              style={{ color: 'var(--primary)' }}
              onClick={() => {
                setConfirmRetry(false);
                const id = state.chat.conversationId;
                if (id) send({ type: 'retry', conversationId: id, messageId: props.msg.id });
              }}
            >
              Regenerate
            </button>
          </>
        }
      >
        The same message is sent again and this reply is replaced by a new one.
      </Dialog>
    </div>
  );
}

/** TokenUsageTelemetryPill: 📥 in · 📤 out · ⚡ cached (%) · ⏱️ time · model, on one line. */
export function TokenPill(props: { usage: TokenUsage }) {
  const u = () => props.usage;
  const cachePct = () =>
    u().promptTokens > 0 && u().cachedTokens > 0
      ? Math.max(0, Math.min(100, Math.floor((u().cachedTokens / (u().promptTokens + u().cachedTokens)) * 100)))
      : 0;
  const dark = () => themeMode() === 'dark';
  return (
    <div
      class="token-pill"
      role="button"
      onClick={() => openTokenDetails(u())}
      style={{
        background: `color-mix(in srgb, var(--surface-variant) ${dark() ? 45 : 70}%, transparent)`,
        'border-color': `color-mix(in srgb, var(--on-surface) ${dark() ? 12 : 18}%, transparent)`,
      }}
      title={u().costUsd != null ? `$${u().costUsd!.toFixed(4)}` : undefined}
    >
      <span style={{ color: 'var(--info)' }}>📥 {compactTokens(u().promptTokens)}</span>
      <span style={{ color: 'var(--success)' }}>📤 {compactTokens(u().outputTokens)}</span>
      <Show when={u().cachedTokens > 0}>
        <span style={{ color: 'var(--warning)', 'font-weight': 700 }}>
          ⚡ {compactTokens(u().cachedTokens)} ({cachePct()}%)
        </span>
      </Show>
      <Show when={u().durationMs > 0}>
        <span class="muted">⏱️ {formatDuration(u().durationMs)}</span>
      </Show>
      <Show when={u().model}>
        <span class="muted model">{shortModelName(u().model!)}</span>
      </Show>
      <Show when={u().isEstimated}>
        <span class="est">(est.)</span>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ summary

/** ActiveContextSummaryCard (compact: header, expandable text). */
export function SummaryCard(props: { msg: ChatMessage }) {
  const [open, setOpen] = createSignal(false);
  // the summary being written: the app's LiveSummarizingCard (model, and the prompt waiting behind it)
  return (
    <Show
      when={!props.msg.isStreaming}
      fallback={
        <div class="summary-live">
          <SummarizingCard model={props.msg.modelId ? shortModelName(props.msg.modelId) : null} queued={state.chat.queued[0]?.text ?? null} />
        </div>
      }
    >
    <div class="summary-card">
      <button class="summary-head" onClick={() => setOpen(!open())}>
        <span class="summary-icon">
          <Icon name="psychology_alt" size={15} color="var(--primary)" />
        </span>
        <span class="summary-titles">
          <span class="summary-title">
            Context Memory <span class="summary-badge">{props.msg.isStreaming ? 'Summarizing…' : 'Active Summary'}</span>
          </span>
          <span class="summary-sub">{open() ? 'Tap to collapse' : 'Older turns compressed • Tap to view'}</span>
        </span>
        <Icon name={open() ? 'chevron_up' : 'chevron_down'} size={18} color="var(--on-surface-variant)" />
      </button>
      <Collapse when={open()}>
        <div class="summary-text">{props.msg.content}</div>
      </Collapse>
    </div>
    </Show>
  );
}

/** WaveDivider: a label between two muted wavy lines (a new day, a model switch). */
let waveIds = 0;
export function WaveDivider(props: { label: string }) {
  // one smooth curve repeated across the width: 14 × 7 per wave, 1px line (inline SVG: no data: URL for the CSP)
  const id = `wave-${++waveIds}`;
  const wave = () => (
    <svg class="wave" height="7" aria-hidden="true">
      <defs>
        <pattern id={id} width="14" height="7" patternUnits="userSpaceOnUse">
          <path d="M0 3.5 Q1.75 0 3.5 3.5 T7 3.5 T10.5 3.5 T14 3.5" fill="none" stroke="currentColor" stroke-width="1" />
        </pattern>
      </defs>
      <rect width="100%" height="7" fill={`url(#${id})`} />
    </svg>
  );
  return (
    <div class="wave-divider">
      {wave()}
      <span class="wave-label">{props.label}</span>
      {wave()}
    </div>
  );
}
