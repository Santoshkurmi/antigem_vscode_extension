// Interactive App block (InteractiveUiView.kt): a ```html_app (or ui / widget / mini_app…) code block runs as a live
// page in the chat. Header: icon, title, App / Code tabs, reload, open in browser, fullscreen. The page comes from the
// host's local preview server (the webview's CSP blocks scripts in any frame it builds itself) and runs sandboxed, with
// that server's origin (localStorage / IndexedDB work).
// A block whose only line is the absolute path of an .html file shows that file with the files next to it (a whole
// small website on disk).
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { mediaUrl, send } from '../state/store';
import { Icon, IconButton, nextFrame } from '../ui/primitives';
import { CodeBlock } from './CodeBlock';
import { fileLinkToPath } from '../util/paths';

const DIM = 'color-mix(in srgb, var(--on-surface) 70%, transparent)';
// allow-same-origin: the app keeps the preview server's origin (not the webview's), so its storage works
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock';

/** The block is just a path to an .html file on disk. */
const FILE_LINE = /^(?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])\S*\.html?$/i;

const cssVar = (name: string, fallback: string) => getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;

/** A fragment gets the app's page around it (its theme colors as --primary / --bg / --text…); a whole document stays. */
function wrapHtml(code: string): string {
  const t = code.trimStart();
  if (/^<!doctype/i.test(t) || /^<html[\s>]/i.test(t)) return code;
  const primary = cssVar('--primary', '#D97757');
  const bg = cssVar('--background', '#1E1E1E');
  const text = cssVar('--on-surface', '#ECECF1');
  const card = cssVar('--surface', '#2A2A2A');
  const border = cssVar('--outline-variant', '#3A3A3A');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root { --primary: ${primary}; --bg: ${bg}; --text: ${text}; --card-bg: ${card}; --border: ${border}; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background-color: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; padding: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; }
button, input, select, textarea { font-family: inherit; }
</style>
</head>
<body>
${code}
</body>
</html>`;
}

export function InteractiveAppBlock(props: { code: string; title?: string }) {
  const [tab, setTab] = createSignal(0); // 0 = App, 1 = Code
  const [reload, setReload] = createSignal(0);
  const [full, setFull] = createSignal(false);
  const [url, setUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const filePath = createMemo(() => {
    const c = props.code.trim();
    return !c.includes('\n') && FILE_LINE.test(c) ? fileLinkToPath(c) : null;
  });
  const title = () => props.title?.trim() || (filePath() ? filePath()!.split(/[\\/]/).pop()! : 'Interactive App');

  // the page's address (again after a reload, so a changed file on disk shows)
  createEffect(
    on([() => props.code, reload], () => {
      let alive = true;
      onCleanup(() => (alive = false));
      setError(null);
      const p = filePath();
      mediaUrl(p ? 'htmlFile' : 'html', p ?? wrapHtml(props.code)).then(
        (u) => alive && setUrl(u + (reload() ? `${u.includes('?') ? '&' : '?'}r=${reload()}` : '')),
        (e) => alive && (setUrl(null), setError(e instanceof Error ? e.message : String(e))),
      );
    }),
  );

  const frame = (cls: string) => (
    <Show when={url()} keyed fallback={<div class="iapp-msg">{error() ?? 'Starting…'}</div>}>
      {(u) => <iframe class={cls} src={u} sandbox={SANDBOX} allow="clipboard-write; fullscreen; autoplay" title={title()} />}
    </Show>
  );

  return (
    <div class="mmd-card iapp-card">
      <div class="mmd-head">
        <Icon name="code" size={16} color="var(--primary)" />
        <span class="mmd-title iapp-title" title={filePath() ?? undefined}>
          {title()}
        </span>
        <span class="mmd-spacer" />
        <div class="mmd-tabs" role="tablist">
          <button class="mmd-tab" classList={{ on: tab() === 0 }} role="tab" aria-selected={tab() === 0} onClick={() => setTab(0)}>
            App
          </button>
          <button class="mmd-tab" classList={{ on: tab() === 1 }} role="tab" aria-selected={tab() === 1} onClick={() => setTab(1)}>
            Code
          </button>
        </div>
        <IconButton icon="refresh" size={28} iconSize={15} color={DIM} title="Restart app" onClick={() => setReload((n) => n + 1)} />
        <IconButton
          icon="open_in_new"
          size={28}
          iconSize={15}
          color={DIM}
          title="Open in browser"
          onClick={() => {
            const u = url();
            if (u) send({ type: 'openUrl', url: u });
          }}
        />
        <IconButton icon="open_in_full" size={28} iconSize={15} color="var(--primary)" title="Fullscreen" onClick={() => setFull(true)} />
      </div>
      <div class="mmd-divider" />
      <Show when={tab() === 0} fallback={<CodeBlock code={props.code} lang={filePath() ? 'text' : 'html'} complete />}>
        <div class="iapp-body">
          {/* one running copy at a time: the fullscreen view takes over */}
          <Show when={!full()} fallback={<div class="iapp-msg">Running in fullscreen</div>}>
            {frame('iapp-frame')}
          </Show>
        </div>
      </Show>
      <AppFullscreen open={full()} title={title()} onClose={() => setFull(false)} onReload={() => setReload((n) => n + 1)}>
        {frame('iapp-frame full')}
      </AppFullscreen>
    </div>
  );
}

function AppFullscreen(props: { open: boolean; title: string; onClose: () => void; onReload: () => void; children: any }) {
  const [mounted, setMounted] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  let timer: number | undefined;
  createEffect(
    on(
      () => props.open,
      (o) => {
        clearTimeout(timer);
        if (o) {
          setMounted(true);
          nextFrame(() => props.open && setShown(true));
        } else {
          setShown(false);
          timer = window.setTimeout(() => setMounted(false), 160);
        }
      },
      { defer: true },
    ),
  );
  const onKey = (e: KeyboardEvent) => {
    if (!props.open || e.key !== 'Escape') return;
    e.stopPropagation();
    props.onClose();
  };
  onMount(() => document.addEventListener('keydown', onKey, true));
  onCleanup(() => {
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(timer);
  });
  return (
    <Show when={mounted()}>
      <Portal>
        <div class="iapp-full" classList={{ shown: shown() }}>
          <div class="iapp-full-head">
            <Icon name="code" size={16} color="var(--primary)" />
            <span class="iapp-full-title">{props.title}</span>
            <span class="mmd-spacer" />
            <IconButton icon="refresh" size={30} iconSize={16} color={DIM} title="Restart app" onClick={props.onReload} />
            <IconButton icon="close" size={30} iconSize={18} color={DIM} title="Close (Esc)" onClick={props.onClose} />
          </div>
          <div class="iapp-full-body">{props.children}</div>
        </div>
      </Portal>
    </Show>
  );
}
