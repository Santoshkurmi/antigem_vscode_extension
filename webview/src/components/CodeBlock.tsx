// ui/components/CodeBlock.kt: header (LANG • N lines, expand, copy), syntax-highlighted body that shows the first
// 10 lines of long code with a "Show all N lines" footer. Highlighting runs once the block is complete, when the
// browser is idle, and is cached; while it streams the code is plain text.
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { highlightCached } from '../markdown/highlight';
import { esc } from '../markdown/inline';
import { Dialog, Icon, IconButton } from '../ui/primitives';
import { chatWorkspaceUri, copyText, send } from '../state/store';
import { themeMode } from '../theme';

const SHELL = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shellsession', 'terminal', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat', 'fish']);

/** CodeBlock.kt isPreviewableCode: HTML / SVG (by language or by content). */
export function isPreviewable(code: string, lang: string): boolean {
  const l = lang.toLowerCase().trim();
  if (['html', 'htm', 'svg', 'xhtml', 'web', 'webapp', 'xml'].includes(l)) return true;
  const t = code.trim().toLowerCase();
  return t.startsWith('<!doctype html') || t.startsWith('<html') || t.startsWith('<svg') || (t.includes('<script') && t.includes('</script>')) || (t.includes('<style') && t.includes('</style>'));
}

/** CodeBlock.kt prepareHtmlForPreview: an SVG centered on a plain page, a snippet wrapped in a responsive page. */
function previewHtml(raw: string, dark: boolean): string {
  const t = raw.trim();
  if (/^<svg/i.test(t)) {
    const bg = dark ? '#1E1E2E' : '#F8FAFC';
    return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>*{box-sizing:border-box}html,body{margin:0;padding:12px;background-color:${bg};display:flex;justify-content:center;align-items:center;min-height:100vh;overflow:auto}svg{max-width:100%;height:auto;display:block}</style></head><body>${t}</body></html>`;
  }
  if (/<head/i.test(t)) return t;
  const bg = dark ? '#181825' : '#FFFFFF';
  const fg = dark ? '#CDD6F4' : '#1E293B';
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>*{box-sizing:border-box}body{margin:0;padding:12px;font-family:system-ui,-apple-system,sans-serif;background-color:${bg};color:${fg}}</style></head><body>${t}</body></html>`;
}

const CODE_PREVIEW_LINES = 10;
const expansion = new Map<string, boolean>();
export const clearCodeState = () => expansion.clear();

const idle: (cb: () => void) => number =
  (window as any).requestIdleCallback?.bind(window) ?? ((cb: () => void) => window.setTimeout(cb, 16));
const cancelIdle: (h: number) => void = (window as any).cancelIdleCallback?.bind(window) ?? clearTimeout;

export function CodeBlock(props: { code: string; lang: string; complete: boolean }) {
  const lines = createMemo(() => {
    let n = 1;
    let previewEnd = props.code.length;
    const c = props.code;
    for (let i = 0; i < c.length; i++) {
      if (c.charCodeAt(i) === 10) {
        n++;
        if (n === CODE_PREVIEW_LINES + 1) previewEnd = i;
      }
    }
    return { n, previewEnd };
  });
  const isLong = () => lines().n > CODE_PREVIEW_LINES;
  const key = () => `${props.lang}:${props.code.length}:${props.code.substring(0, 64)}`;
  const [expanded, setExpanded] = createSignal(expansion.get(key()) ?? false);
  const toggle = () => {
    const next = !expanded();
    setExpanded(next);
    expansion.set(key(), next);
  };
  const [copied, setCopied] = createSignal(false);
  const [full, setFull] = createSignal(false);
  const [tab, setTab] = createSignal<'code' | 'preview'>('code');
  const [reload, setReload] = createSignal(0);
  const [run, setRun] = createSignal(false);
  const canPreview = () => props.complete && isPreviewable(props.code, props.lang);
  const isShell = () => SHELL.has(props.lang.toLowerCase().trim());
  let copyTimer: number | undefined;
  onCleanup(() => clearTimeout(copyTimer));

  const shownCode = () => (isLong() && !expanded() ? props.code.substring(0, lines().previewEnd) : props.code);

  // highlighted HTML, computed when idle once the block is complete
  const [html, setHtml] = createSignal<string | null>(null);
  let pending: number | undefined;
  createEffect(
    on([() => props.code, () => props.lang, () => props.complete], ([code, lang, complete]) => {
      if (pending !== undefined) cancelIdle(pending);
      pending = undefined;
      if (!complete) {
        setHtml(null);
        return;
      }
      pending = idle(() => {
        pending = undefined;
        setHtml(highlightCached(code, lang));
      });
    }),
  );
  onCleanup(() => pending !== undefined && cancelIdle(pending));

  const bodyHtml = () => {
    const h = html();
    if (h === null) return esc(shownCode());
    if (!isLong() || expanded()) return h;
    return cutHtmlAtLine(h, CODE_PREVIEW_LINES);
  };

  return (
    <div class="code-block">
      <div class="code-head">
        <span class="code-lang">{(props.lang || 'code').toUpperCase()}</span>
        <Show when={lines().n > 1}>
          <span class="code-lines">•&nbsp; {lines().n} lines</span>
        </Show>
        <span class="flex1" />
        {/* [Code | Preview] for HTML / SVG */}
        <Show when={canPreview()}>
          <div class="code-tabs">
            <button class="code-tab" classList={{ on: tab() === 'code' }} onClick={() => setTab('code')}>
              <Icon name="code" size={13} />
              Code
            </button>
            <button class="code-tab" classList={{ on: tab() === 'preview' }} onClick={() => setTab('preview')}>
              <Icon name="play_arrow" size={13} />
              Preview
            </button>
          </div>
          <Show when={tab() === 'preview'}>
            <IconButton icon="refresh" iconSize={15} color="color-mix(in srgb, var(--code-text) 70%, transparent)" title="Reload preview" onClick={() => setReload((n) => n + 1)} />
          </Show>
        </Show>
        <IconButton
          icon="open_in_full"
          iconSize={14}
          color="color-mix(in srgb, var(--code-text) 70%, transparent)"
          title="Fullscreen"
          onClick={() => setFull(true)}
        />
        <Show when={isLong()}>
          <IconButton
            icon={expanded() ? 'expand_less' : 'expand_more'}
            iconSize={17}
            color={expanded() ? 'var(--primary)' : 'color-mix(in srgb, var(--code-text) 70%, transparent)'}
            title={expanded() ? 'Collapse code block' : 'Expand full height'}
            onClick={toggle}
          />
        </Show>
        <IconButton
          icon={copied() ? 'check' : 'copy'}
          iconSize={copied() ? 16 : 15}
          color={copied() ? 'var(--success)' : 'color-mix(in srgb, var(--code-text) 70%, transparent)'}
          title="Copy code"
          onClick={() => {
            copyText(props.code, 'Code copied to clipboard');
            setCopied(true);
            clearTimeout(copyTimer);
            copyTimer = window.setTimeout(() => setCopied(false), 2500);
          }}
        />
        {/* shell code runs in a VS Code terminal (the app's "Run in terminal", the command editable first) */}
        <Show when={isShell() && props.complete}>
          <IconButton icon="play_arrow" iconSize={18} color="var(--primary)" title="Run in terminal" onClick={() => setRun(true)} />
        </Show>
      </div>
      <div class="code-divider" />
      <Show
        when={tab() === 'preview' && canPreview()}
        fallback={
          <pre class="code-body">
            <code innerHTML={bodyHtml()} />
          </pre>
        }
      >
        <PreviewFrame code={props.code} reload={reload()} />
      </Show>
      <Show when={run()}>
        <RunDialog command={props.code.trimEnd().split('\n').map((l) => l.replace(/^\$ /, '')).join('\n')} onClose={() => setRun(false)} />
      </Show>
      <Show when={full()}>
        <CodeFullscreen code={props.code} lang={props.lang} html={html() ?? esc(props.code)} lines={lines().n} onClose={() => setFull(false)} />
      </Show>
      <Show when={isLong() && tab() === 'code'}>
        <div class="code-foot-divider" />
        <button class="code-foot" onClick={toggle}>
          <span>
            {expanded()
              ? 'Collapse code block ▲'
              : `Show all ${lines().n} lines (${Math.max(1, lines().n - CODE_PREVIEW_LINES)} more) ▼`}
          </span>
          <Icon name={expanded() ? 'expand_less' : 'expand_more'} size={14} />
        </button>
      </Show>
    </div>
  );
}

/** The fullscreen code dialog: top bar (close, LANG / N lines, copy), line numbers, the whole highlighted code. */
function CodeFullscreen(props: { code: string; lang: string; html: string; lines: number; onClose: () => void }) {
  const [copied, setCopied] = createSignal(false);
  let t: number | undefined;
  onCleanup(() => clearTimeout(t));
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
  document.addEventListener('keydown', onKey);
  onCleanup(() => document.removeEventListener('keydown', onKey));
  const numbers = () => Array.from({ length: props.lines }, (_, i) => i + 1).join('\n');
  return (
    <Portal>
      <div class="code-full" onClick={(e) => e.stopPropagation()}>
        <div class="code-full-bar">
          <IconButton icon="close" size={48} iconSize={24} title="Close" onClick={props.onClose} />
          <div class="code-full-titles">
            <div class="code-full-title">{(props.lang || 'code').toUpperCase()}</div>
            <div class="code-full-sub">{props.lines} lines</div>
          </div>
          <IconButton
            icon={copied() ? 'check' : 'copy'}
            size={48}
            iconSize={24}
            color={copied() ? 'var(--success)' : 'var(--on-surface)'}
            title="Copy code"
            onClick={() => {
              copyText(props.code, 'Code copied to clipboard');
              setCopied(true);
              clearTimeout(t);
              t = window.setTimeout(() => setCopied(false), 2000);
            }}
          />
        </div>
        <div class="code-full-divider" />
        <div class="code-full-body">
          <pre class="code-full-gutter">{numbers()}</pre>
          <div class="code-full-sep" />
          <pre class="code-full-code">
            <code innerHTML={props.html} />
          </pre>
        </div>
      </div>
    </Portal>
  );
}

/** The highlighted HTML up to the end of line `n` (spans never cross a newline except comments; close them). */
function cutHtmlAtLine(html: string, n: number): string {
  let count = 0;
  let depth = 0;
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === '<') {
      if (html.startsWith('</span>', i)) depth--;
      else if (html.startsWith('<span', i)) depth++;
      continue;
    }
    if (ch === '\n') {
      count++;
      if (count === n) return html.substring(0, i) + '</span>'.repeat(Math.max(0, depth));
    }
  }
  return html;
}

// ------------------------------------------------------------------------------------------------ diff

interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
  old?: number;
  new?: number;
}

/** parseUnifiedDiff() from ui/ide/UnifiedDiffViewer.kt */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (!diff.trim()) return [];
  const out: DiffLine[] = [];
  let o = 0;
  let n = 0;
  const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)/;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('\\')) continue;
    if (/^(diff --git|index |---|\+\+\+|new file mode|deleted file mode)/.test(raw)) {
      out.push({ type: 'meta', text: raw });
      continue;
    }
    const h = hunk.exec(raw);
    if (h) {
      o = +h[1] || 1;
      n = +h[2] || 1;
      out.push({ type: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('+')) out.push({ type: 'add', text: raw.substring(1), new: n++ });
    else if (raw.startsWith('-')) out.push({ type: 'del', text: raw.substring(1), old: o++ });
    else {
      out.push({ type: 'ctx', text: raw.startsWith(' ') ? raw.substring(1) : raw, old: o > 0 ? o : undefined, new: n > 0 ? n : undefined });
      if (o > 0) o++;
      if (n > 0) n++;
    }
  }
  return out;
}

export function looksLikeDiff(text: string): boolean {
  return /^@@ -\d+/m.test(text) || (/^--- /m.test(text) && /^\+\+\+ /m.test(text));
}

/** The diff rows of UnifiedDiffViewer (line numbers, +/-/@ gutter, editor diff colors), for tool cards. */
export function DiffView(props: { diff: string; path?: string }) {
  const parsed = createMemo(() => parseUnifiedDiff(props.diff));
  const adds = () => parsed().filter((l) => l.type === 'add').length;
  const dels = () => parsed().filter((l) => l.type === 'del').length;
  const html = createMemo(() =>
    parsed()
      .map(
        (l) =>
          `<div class="diff-line ${l.type}"><span class="diff-num">${l.old ?? ''}</span><span class="diff-num">${l.new ?? ''}</span><span class="diff-sign">${
            l.type === 'add' ? '+' : l.type === 'del' ? '-' : l.type === 'hunk' ? '@' : ' '
          }</span><span class="diff-text">${esc(l.text)}</span></div>`,
      )
      .join(''),
  );
  return (
    <div class="diff">
      <Show when={props.path}>
        <div class="diff-head">
          <Icon name="difference" size={16} color="var(--primary)" />
          <span class="diff-file">{props.path!.substring(props.path!.lastIndexOf('/') + 1)}</span>
          <span class="flex1" />
          <span class="diff-stats">
            <span style={{ color: 'var(--success)' }}>+{adds()}</span> <span style={{ color: 'var(--danger)' }}>-{dels()}</span>
          </span>
        </div>
      </Show>
      <div class="diff-body" innerHTML={html()} />
    </div>
  );
}

/**
 * The live preview (CodeBlock.kt's WebView): a sandboxed frame, white like the app's. The webview's security policy
 * applies to it, so the page's own scripts do not run (HTML and CSS do).
 */
function PreviewFrame(props: { code: string; reload: number }) {
  const html = createMemo(() => (props.reload, previewHtml(props.code, false)));
  const scripts = () => /<script/i.test(props.code);
  return (
    <div class="code-preview">
      <iframe class="code-preview-frame" sandbox="" srcdoc={html()} title="Preview" />
      <Show when={scripts()}>
        <div class="code-preview-note">Scripts don't run in the preview</div>
      </Show>
    </div>
  );
}

/** ChatCommandRunDialog: the command, editable, then "Run" opens a VS Code terminal in the chat's folder. */
function RunDialog(props: { command: string; onClose: () => void }) {
  const [value, setValue] = createSignal(props.command);
  const single = !props.command.includes('\n');
  const runNow = () => {
    const cmd = value().trim();
    if (!cmd) return;
    const ws = chatWorkspaceUri();
    send({ type: 'runInTerminal', command: cmd, cwd: ws ? decodeURIComponent(ws.replace(/^file:\/\//, '')) : null });
    props.onClose();
  };
  return (
    <Dialog
      open
      onClose={props.onClose}
      radius={18}
      background="var(--editor-bg)"
      width={520}
      title={
        <span class="run-head">
          <span class="run-head-icon">
            <Icon name="terminal" size={19} />
          </span>
          <span>
            <span class="run-title">Run in terminal</span>
            <span class="run-sub">Opens a new VS Code terminal. Edit the command if needed.</span>
          </span>
        </span>
      }
      actions={
        <>
          <button class="text-btn" style={{ color: 'var(--editor-muted)' }} onClick={props.onClose}>
            Cancel
          </button>
          <button class="filled-btn small run-btn" disabled={!value().trim()} onClick={runNow}>
            <Icon name="play_arrow" size={18} /> Run
          </button>
        </>
      }
    >
      <div class="run-field">
        <span class="run-prompt">$</span>
        <textarea
          class="run-input"
          rows={single ? 1 : Math.min(12, props.command.split('\n').length)}
          value={value()}
          ref={(el) => setTimeout(() => (el.focus({ preventScroll: true }), el.setSelectionRange(el.value.length, el.value.length)), 60)}
          onInput={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (single || e.shiftKey)) {
              e.preventDefault();
              runNow();
            }
          }}
          spellcheck={false}
        />
      </div>
      <div class="run-hint">
        {single ? 'Press Enter to run · closing the terminal stops everything in it' : 'Shift+Enter or Run to start · closing the terminal stops everything in it'}
      </div>
    </Dialog>
  );
}
