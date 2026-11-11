// MarkdownBlockView / MarkdownContent from ui/components/MarkdownContent.kt: one renderer per block type.
// Blocks render through accessors, so a streaming block updates in place (no DOM rebuild).
import { createMemo, createSignal, For, Index, type JSX, Match, onCleanup, Show, Switch } from 'solid-js';
import type { ToolCall } from '@shared/model';
import type { AgentErrorBlock, Align, AlertType, Block } from '../markdown/parse';
import { parseBlocks } from '../markdown/parse';
import { formatLatex, inlineHtml } from '../markdown/inline';
import { cleanLatex, mathReady, renderTex } from '../markdown/math';
import { Collapse, Icon, IconButton, type IconName } from '../ui/primitives';
import { MermaidBlock } from './Mermaid';
import { MarkdownImage, VideoLinkCard, YouTubeCard } from './Media';
import { openSettings } from '../state/settings';
import { CodeBlock } from './CodeBlock';
import { InteractiveAppBlock } from './InteractiveApp';
import { ToolCallCard } from './ToolCallCard';
import { ThinkingAccordion } from './Thinking';
import { copyText } from '../state/store';
import { themeMode } from '../theme';

export function Inline(props: { text: string; class?: string; style?: JSX.CSSProperties; strike?: boolean }) {
  return (
    <div
      class={'md-text' + (props.class ? ' ' + props.class : '')}
      classList={{ 'md-strike': !!props.strike }}
      style={props.style}
      innerHTML={inlineHtml(props.text)}
    />
  );
}

type B<T extends Block['t']> = Extract<Block, { t: T }>;

/**
 * One block. `resolveTool` turns a tool block's id into the live ToolCall (from the message, so status changes show
 * without re-parsing). `streaming` = the message is still streaming (code blocks highlight only when complete).
 */
export function BlockView(props: {
  block: Block;
  resolveTool?: (id: string) => ToolCall | undefined;
  streaming?: boolean;
  thoughtKey?: string;
}) {
  const b = () => props.block;
  const as = <T extends Block['t']>(_t: T) => b() as B<T>;
  return (
    <Switch>
      <Match when={b().t === 'p'}>
        <Inline text={as('p').text} class="md-p" />
      </Match>
      <Match when={b().t === 'h'}>
        <Inline text={as('h').text} class={`md-h md-h${as('h').level}`} />
      </Match>
      <Match when={b().t === 'li'}>
        <div class="md-li" style={{ 'padding-left': `${as('li').indent * 14}px` }}>
          <span class="md-bullet">{as('li').indent === 0 ? '• ' : '◦ '}</span>
          <Inline text={as('li').text} />
        </div>
      </Match>
      <Match when={b().t === 'ol'}>
        <div class="md-ol">
          <span class="md-num">{as('ol').num}&nbsp;</span>
          <Inline text={as('ol').text} />
        </div>
      </Match>
      <Match when={b().t === 'task'}>
        <div class="md-task">
          <Icon
            name={as('task').checked ? 'check_box' : 'check_box_blank'}
            size={17}
            color={as('task').checked ? 'var(--success)' : 'color-mix(in srgb, var(--on-surface) 50%, transparent)'}
          />
          <Inline text={as('task').text} strike={as('task').checked} />
        </div>
      </Match>
      <Match when={b().t === 'quote'}>
        <div class="md-quote">
          <div class="md-quote-bar" />
          <Inline text={as('quote').text} class="md-quote-text" />
        </div>
      </Match>
      <Match when={b().t === 'alert'}>
        <AlertView kind={as('alert').kind} title={as('alert').title} text={as('alert').text} />
      </Match>
      <Match when={b().t === 'hr'}>
        <div class="md-hr" />
      </Match>
      <Match when={b().t === 'code'}>
        <CodeBlock code={as('code').code} lang={as('code').lang} complete={!as('code').open || !props.streaming} />
      </Match>
      <Match when={b().t === 'table'}>
        <TableView headers={as('table').headers} rows={as('table').rows} align={as('table').align} />
      </Match>
      <Match when={b().t === 'details'}>
        <DetailsView summary={as('details').summary} body={as('details').body} open={as('details').open} />
      </Match>
      <Match when={b().t === 'thought'}>
        <div class="md-thought">
          <ThinkingAccordion
            id={(props.thoughtKey ?? '') + ':' + as('thought').thought.substring(0, 40)}
            text={as('thought').thought}
            durationMs={as('thought').durationMs}
            streaming={as('thought').streaming}
          />
        </div>
      </Match>
      <Match when={b().t === 'tool'}>
        <Show when={as('tool').synthetic ?? props.resolveTool?.(as('tool').id)}>{(call) => <ToolCallCard call={call()} />}</Show>
      </Match>
      <Match when={b().t === 'error'}>
        <ErrorCard error={as('error')} />
      </Match>
      <Match when={b().t === 'math'}>
        <MathBlock latex={as('math').latex} />
      </Match>
      <Match when={b().t === 'mermaid'}>
        {/* drawn once the fence is complete (partial code would be a syntax error) */}
        <Show when={!props.streaming} fallback={<CodeBlock code={as('mermaid').code} lang="mermaid" complete={false} />}>
          <MermaidBlock code={as('mermaid').code} />
        </Show>
      </Match>
      <Match when={b().t === 'ui'}>
        {/* a streaming app is shown as code until it is complete (a half page would run half its script) */}
        <Show when={!props.streaming} fallback={<CodeBlock code={as('ui').html} lang="html" complete={false} />}>
          <InteractiveAppBlock code={as('ui').html} />
        </Show>
      </Match>
      <Match when={b().t === 'img'}>
        <MarkdownImage src={as('img').url} alt={as('img').alt} />
      </Match>
      <Match when={b().t === 'yt'}>
        <YouTubeCard url={as('yt').url} videoId={as('yt').videoId} title={as('yt').title} />
      </Match>
      <Match when={b().t === 'video'}>
        <VideoLinkCard url={as('video').url} title={as('video').alt || null} />
      </Match>
    </Switch>
  );
}

/** Nested markdown (details body, plan approvals). */
export function MarkdownContent(props: { text: string }) {
  const blocks = createMemo(() => parseBlocks(props.text));
  return (
    <div class="md">
      <Index each={blocks()}>{(b) => <BlockView block={b()} />}</Index>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ math

/** NativeMathView: a soft card, the formula centered (scrolls sideways when wider), the app's text fallback. */
function MathBlock(props: { latex: string }) {
  const html = () => {
    mathReady();
    return renderTex(props.latex, true);
  };
  return (
    <div class="md-math-block">
      <div class="md-math-scroll">
        <Show when={html()} fallback={<span class="md-math-fallback">{formatLatex(cleanLatex(props.latex))}</span>}>
          <div class="md-math-k display" innerHTML={html()!} />
        </Show>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ alert

const ALERTS: Record<AlertType, { color: string; container: string; title: string; icon: IconName }> = {
  NOTE: { color: 'var(--info)', container: 'var(--info-container)', title: 'Note', icon: 'info_o' },
  TIP: { color: 'var(--success)', container: 'var(--success-container)', title: 'Tip', icon: 'lightbulb_o' },
  IMPORTANT: { color: 'var(--accent-alt)', container: 'var(--fill)', title: 'Important', icon: 'priority_high' },
  WARNING: { color: 'var(--warning)', container: 'var(--warning-container)', title: 'Warning', icon: 'warning_o' },
  CAUTION: { color: 'var(--danger)', container: 'var(--danger-container)', title: 'Caution', icon: 'report_o' },
};

function AlertView(props: { kind: AlertType; title: string | null; text: string }) {
  const s = () => ALERTS[props.kind];
  const dark = () => themeMode() === 'dark';
  return (
    <div
      class="md-alert"
      style={{
        background: dark() ? `color-mix(in srgb, ${s().color} 13%, transparent)` : s().container,
        'border-color': `color-mix(in srgb, ${s().color} ${dark() ? 35 : 25}%, transparent)`,
        '--accent': s().color,
      }}
    >
      <div class="md-alert-bar" />
      <div class="md-alert-body">
        <div class="md-alert-title" classList={{ spaced: !!props.text.trim() }}>
          <Icon name={s().icon} size={16} color={s().color} />
          <span>{props.title ?? s().title}</span>
        </div>
        <Show when={props.text.trim()}>
          <Inline text={props.text} />
        </Show>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ table

/** MarkdownTableView: natural column widths (chars × 8.5 + 28, 80..280dp), stretched to fill when they fit. */
function TableView(props: { headers: string[]; rows: string[][]; align: Align[] }) {
  const [avail, setAvail] = createSignal(0);
  const natural = createMemo(() =>
    props.headers.map((h, c) => {
      const max = Math.max(h.length, ...props.rows.map((r) => (r[c] ?? '').length));
      return Math.min(280, Math.max(80, max * 8.5 + 28));
    }),
  );
  const widths = createMemo(() => {
    const nat = natural();
    const total = nat.reduce((a, b) => a + b, 0);
    const net = avail() - (nat.length - 1);
    if (net > total && total > 0) {
      const scale = net / total;
      return nat.map((w) => (scale <= 2.2 ? w * scale : w * 1.5));
    }
    return nat;
  });
  const ro = new ResizeObserver((e) => setAvail(e[0].contentRect.width));
  onCleanup(() => ro.disconnect());
  const attach = (el: HTMLDivElement) => ro.observe(el);
  return (
    <div class="md-table" ref={attach}>
      <div class="md-table-scroll">
        <table style={{ width: `${widths().reduce((a, b) => a + b, 0) + widths().length - 1}px` }}>
          <colgroup>
            <For each={widths()}>{(w) => <col style={{ width: `${w}px` }} />}</For>
          </colgroup>
          <thead>
            <tr>
              <Index each={props.headers}>
                {(h, i) => <th style={{ 'text-align': props.align[i] ?? 'left' }} innerHTML={inlineHtml(h())} />}
              </Index>
            </tr>
          </thead>
          <tbody>
            <Index each={props.rows}>
              {(row) => (
                <tr>
                  <Index each={row()}>
                    {(cell, i) => <td style={{ 'text-align': props.align[i] ?? 'left' }} innerHTML={inlineHtml(cell())} />}
                  </Index>
                </tr>
              )}
            </Index>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ details

function DetailsView(props: { summary: string; body: string; open: boolean }) {
  const [open, setOpen] = createSignal(props.open);
  return (
    <div class="md-details">
      <button class="md-details-head" onClick={() => setOpen(!open())}>
        <Icon name="expand_more" size={20} color="var(--primary)" class="spin-180" style={{ transform: open() ? 'rotate(180deg)' : 'none' }} />
        <Inline text={props.summary} />
      </button>
      <Collapse when={open()}>
        <div class="md-details-body">
          <div class="md-details-divider" />
          <MarkdownContent text={props.body} />
        </div>
      </Collapse>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ error

/** Error actions that open the settings page with the fix (OpenCode's provider keys, an agent's account). */
const SETTINGS_ACTIONS: Record<string, () => void> = {
  opencode_providers: () =>
    openSettings({ id: 'agents', title: 'Agents' }, [
      { id: 'opencode', title: 'OpenCode' },
      { id: 'opencode.providers', title: 'Providers' },
    ]),
  providers: () => openSettings({ id: 'agents', title: 'Agents' }, [{ id: 'opencode', title: 'OpenCode' }, { id: 'opencode.providers', title: 'Providers' }]),
  claude_login: () => openSettings({ id: 'agents', title: 'Agents' }, [{ id: 'claude', title: 'Claude Code' }]),
  codex_login: () => openSettings({ id: 'agents', title: 'Agents' }, [{ id: 'codex', title: 'Codex' }]),
  agy_login: () => openSettings({ id: 'agents', title: 'Agents' }, [{ id: 'agy', title: 'Antigravity' }]),
};

/** AgentErrorCard: title + code badge + copy, message, short error, expandable stack trace / JSON. */
function ErrorCard(props: { error: AgentErrorBlock }) {
  const e = () => props.error;
  const [open, setOpen] = createSignal(false);
  const verbose = () => e().fullError || e().rawJson || e().errorId;
  const copy = () => {
    const x = e();
    const lines = [`Error: ${x.title}`];
    if (x.userMessage) lines.push(`Message: ${x.userMessage}`);
    if (x.shortError) lines.push(`Detail: ${x.shortError}`);
    if (x.errorCode != null) lines.push(`Code: ${x.errorCode}`);
    if (x.errorId) lines.push(`ID: ${x.errorId}`);
    if (x.fullError) lines.push(`\nFull Trace:\n${x.fullError}`);
    if (x.rawJson) lines.push(`\nRaw JSON:\n${x.rawJson}`);
    copyText(lines.join('\n').trim(), 'Error details copied to clipboard');
  };
  return (
    <div class="err-card">
      <div class="err-head">
        <Icon name="error_o" size={18} color="var(--danger)" />
        <span class="err-title">{e().title || 'Agent Execution Error'}</span>
        <Show when={e().errorCode != null && e().errorCode !== 0}>
          <span class="err-code">Code: {e().errorCode}</span>
        </Show>
        <span class="flex1" />
        <IconButton icon="copy" size={24} iconSize={14} color="color-mix(in srgb, var(--danger) 70%, transparent)" title="Copy Error Details" onClick={copy} />
      </div>
      <Show when={e().userMessage && e().userMessage !== e().title}>
        <div class="err-msg">{e().userMessage}</div>
      </Show>
      <Show when={e().shortError && e().shortError !== e().userMessage}>
        <div class="err-short">{e().shortError}</div>
      </Show>
      {/* the fix, when the agent knows it: an account / provider to reconnect */}
      <Show when={e().action && SETTINGS_ACTIONS[e().action!]}>
        <button class="err-action" onClick={() => SETTINGS_ACTIONS[e().action!]()}>
          Reconnect in Settings
        </button>
      </Show>
      <Show when={verbose()}>
        <button class="err-toggle" onClick={() => setOpen(!open())}>
          <Icon name="expand_more" size={16} style={{ transform: open() ? 'rotate(180deg)' : 'none' }} />
          <span>{open() ? 'Hide Error Details & Stack Trace' : 'View Error Details & Stack Trace'}</span>
        </button>
        <Collapse when={open()}>
          <div class="err-verbose">
            <Show when={e().errorId}>
              <div class="err-id">Error ID: {e().errorId}</div>
            </Show>
            <pre>{e().fullError || e().rawJson}</pre>
          </div>
        </Collapse>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ media

