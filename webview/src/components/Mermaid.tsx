// MermaidDiagramView / MermaidFullscreenDialog from ui/components/MarkdownContent.kt: a card with a "MERMAID DIAGRAM"
// header, Diagram / Code pills, copy and expand buttons, the diagram (180–420dp tall) or the code as a CodeBlock, and a
// fullscreen view with zoom. The app draws the diagram with mermaid.js in a WebView (theme 'dark' / 'default'); here
// mermaid renders to an SVG string in the page. It is loaded the first time a message contains a diagram.
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, type Accessor } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { MermaidConfig } from 'mermaid';
import { Icon, IconButton, nextFrame } from '../ui/primitives';
import { CodeBlock } from './CodeBlock';
import { copyText } from '../state/store';
import { themeMode } from '../theme';
import '../styles/mermaid.css';

// ------------------------------------------------------------------------------------------------ rendering

type Mermaid = typeof import('mermaid').default;
type Drawn = { svg: string; id: string; w: number; h: number };
type Failed = { error: string };
type Result = Drawn | Failed;

let loading: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  if (!loading) {
    loading = import('mermaid').then((m) => m.default);
    loading.catch(() => (loading = null));
  }
  return loading;
}

/** The app's font (theme.css --font, its var() resolved), so labels are measured and drawn in the chat's font. */
function appFont(): string {
  const f = getComputedStyle(document.documentElement).getPropertyValue('--font').trim();
  return f && !f.includes('var(') ? f : 'Roboto, system-ui, sans-serif';
}

/**
 * The app's mermaid.initialize({ theme: isDark ? 'dark' : 'default' }) on mermaid 10, with mermaid 10's defaults
 * where mermaid 12 changed them (classic look, dagre layout, HTML labels, labels wrap at 200px, nodes as wide as their
 * label). 'strict': no click callbacks, labels sanitized; the app's 'loose' needs nothing the chat uses. Errors are
 * thrown instead of drawn (the card shows the code then).
 */
function config(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    theme: dark ? 'dark' : 'default',
    look: 'classic',
    layout: 'dagre',
    htmlLabels: true,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    fontFamily: appFont(),
    logLevel: 'fatal',
    flowchart: { wrappingWidth: 200, minNodeWidth: 0 },
    state: { minNodeWidth: 0 },
  };
}

// Mermaid measures labels in the DOM while it lays a diagram out: an off-screen element under <body> with the same
// text styles as the card's diagram area (mermaid.css), so the labels fit where the SVG is shown.
let host: HTMLDivElement | null = null;
function measureHost(width: number): HTMLDivElement {
  if (!host || !host.isConnected) {
    host = document.createElement('div');
    host.className = 'mmd-measure';
    host.setAttribute('aria-hidden', 'true');
    document.body.appendChild(host);
  }
  // diagrams that size to their container (gantt) get the card's width, like the WebView's page
  host.style.width = `${Math.round(width)}px`;
  return host;
}

/** The SVG's size in its own units (viewBox; else max-width / width / height). */
function naturalSize(svg: string): { w: number; h: number } {
  const tag = svg.substring(0, svg.indexOf('>') + 1);
  const vb = /viewBox="\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*"/i.exec(tag);
  if (vb && +vb[1] > 0 && +vb[2] > 0) return { w: +vb[1], h: +vb[2] };
  const mw = /max-width:\s*([\d.]+)px/.exec(tag);
  const w = /\swidth="([\d.]+)(?:px)?"/.exec(tag);
  const h = /\sheight="([\d.]+)(?:px)?"/.exec(tag);
  return { w: mw ? +mw[1] : w ? +w[1] : 600, h: h ? +h[1] : 400 };
}

function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : (e as { str?: string })?.str ?? String(e);
  return (m || 'Syntax error in diagram').trim();
}

let seq = 0;
let queue: Promise<unknown> = Promise.resolve();

async function draw(mermaid: Mermaid, code: string, dark: boolean, width: number): Promise<Result> {
  const id = `agmmd-${++seq}-${Math.random().toString(36).substring(2, 7)}`;
  try {
    mermaid.initialize(config(dark));
    const { svg } = await mermaid.render(id, code, measureHost(width));
    return { svg, id, ...naturalSize(svg) };
  } catch (e) {
    return { error: errorText(e) };
  } finally {
    document.getElementById('d' + id)?.remove();
  }
}

const done = new Map<string, Result>();
const inflight = new Map<string, Promise<Result>>();
const keyOf = (code: string, dark: boolean) => (dark ? 'd\n' : 'l\n') + code;

/** A finished render of this code in this theme, if there is one. */
function cached(code: string, dark: boolean): Result | undefined {
  return done.get(keyOf(code, dark));
}

/** Renders one diagram at a time (mermaid's config is global), each code + theme once. */
function renderDiagram(code: string, dark: boolean, width: number): Promise<Result> {
  const key = keyOf(code, dark);
  const hit = done.get(key);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (p) return p;
  p = loadMermaid().then(
    (mermaid) => {
      const run = queue.then(() => draw(mermaid, code, dark, width));
      queue = run;
      return run.then((r) => {
        done.set(key, r);
        if (done.size > 60) done.delete(done.keys().next().value!);
        return r;
      });
    },
    (): Result => ({ error: 'Could not load the diagram renderer' }),
  );
  p.finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

let viewSeq = 0;
/** The SVG with ids of its own: every id and #selector in it starts with the render's id (the card and the
 *  fullscreen view, or the same diagram in two messages, must not share marker / style ids). */
function placed(r: Drawn): string {
  return r.svg.split(r.id).join(`${r.id}v${++viewSeq}`);
}

const firstLine = (msg: string) => {
  const lines = msg.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? msg;
  // "Parse error on line 2:" … "Expecting 'X', got 'Y'"
  return `${lines[0]} ${lines[lines.length - 1]}`;
};

// ------------------------------------------------------------------------------------------------ pieces

const DIM = 'color-mix(in srgb, var(--on-surface) 60%, transparent)';
const DIM70 = 'color-mix(in srgb, var(--on-surface) 70%, transparent)';

/** The Diagram / Code switcher pills. */
function Pills(props: { tab: number; onTab: (t: number) => void }) {
  return (
    <div class="mmd-tabs" role="tablist">
      <button class="mmd-tab" classList={{ on: props.tab === 0 }} role="tab" aria-selected={props.tab === 0} onClick={() => props.onTab(0)}>
        Diagram
      </button>
      <button class="mmd-tab" classList={{ on: props.tab === 1 }} role="tab" aria-selected={props.tab === 1} onClick={() => props.onTab(1)}>
        Code
      </button>
    </div>
  );
}

/** The code with a small error line above it (a diagram that does not parse). */
function ErrorView(props: { code: string; error: string }) {
  return (
    <>
      <div class="mmd-error" title={props.error}>
        <Icon name="error_o" size={14} />
        <span class="mmd-error-text">{firstLine(props.error)}</span>
      </div>
      <CodeBlock code={props.code} lang="mermaid" complete />
    </>
  );
}

// Icons.Outlined.ZoomIn / ZoomOut (@material-design-icons/svg outlined zoom_in / zoom_out; not in iconData)
const ZOOM_IN =
  'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zm.5-7H9v2H7v1h2v2h1v-2h2V9h-2z';
const ZOOM_OUT =
  'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zM7 9h5v1H7z';

function PathButton(props: { d: string; title: string; onClick: () => void }) {
  return (
    <button class="icon-btn" style={{ width: '32px', height: '32px' }} title={props.title} aria-label={props.title} onClick={() => props.onClick()}>
      <svg class="icon" viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-hidden="true" style={{ color: DIM70 }}>
        <path d={props.d} />
      </svg>
    </button>
  );
}

// ------------------------------------------------------------------------------------------------ card

export function MermaidBlock(props: { code: string }) {
  const [tab, setTab] = createSignal(0); // 0 = Diagram, 1 = Code
  const [copied, setCopied] = createSignal(false);
  const [full, setFull] = createSignal(false);
  const [result, setResult] = createSignal<Result | null>(null);
  let card: HTMLDivElement | undefined;
  let copyTimer: number | undefined;
  let renderTimer: number | undefined;
  let token = 0;

  // (re)render when the code or the light / dark side changes; a streaming block settles before it is drawn
  createEffect(() => {
    const code = props.code;
    const dark = themeMode() === 'dark';
    clearTimeout(renderTimer);
    const t = ++token;
    const hit = cached(code, dark);
    if (hit) {
      setResult(hit);
      return;
    }
    renderTimer = window.setTimeout(() => {
      const w = (card?.clientWidth ?? 0) - 32;
      renderDiagram(code, dark, w > 100 ? w : 600).then((r) => t === token && setResult(r));
    }, 200);
  });
  onCleanup(() => {
    token++;
    clearTimeout(renderTimer);
    clearTimeout(copyTimer);
  });

  const drawn = () => {
    const r = result();
    return r && 'svg' in r ? r : null;
  };
  const error = () => {
    const r = result();
    return r && 'error' in r ? r.error : null;
  };
  const svg = createMemo(() => {
    const r = drawn();
    return r ? placed(r) : '';
  });

  const copy = () => {
    copyText(props.code, 'Diagram code copied');
    setCopied(true);
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div ref={card} class="mmd-card">
      <div class="mmd-head">
        <Icon name="auto_awesome" size={15} color="var(--primary)" />
        <span class="mmd-title">MERMAID DIAGRAM</span>
        <span class="mmd-spacer" />
        <Pills tab={tab()} onTab={setTab} />
        <IconButton
          icon={copied() ? 'check' : 'copy'}
          size={28}
          iconSize={15}
          color={copied() ? 'var(--success)' : DIM}
          title={copied() ? 'Copied' : 'Copy'}
          onClick={copy}
        />
        <IconButton class="mmd-expand" icon="open_in_full" size={28} iconSize={15} color={DIM} title="Expand" onClick={() => setFull(true)} />
      </div>
      <div class="mmd-divider" />
      <Show when={tab() === 0} fallback={<CodeBlock code={props.code} lang="mermaid" complete />}>
        <Show
          when={error() === null}
          fallback={<ErrorView code={props.code} error={error()!} />}
        >
          <div class="mmd-body">
            <div class="mmd-canvas">
              <div class="mmd-svg" innerHTML={svg()} />
            </div>
          </div>
        </Show>
      </Show>
      <MermaidFullscreen open={full()} code={props.code} result={result} onClose={() => setFull(false)} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ fullscreen

/** MermaidFullscreenDialog: mounted while open (and while it fades out, without taking pointer events). */
function MermaidFullscreen(props: { open: boolean; code: string; result: Accessor<Result | null>; onClose: () => void }) {
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
  // Escape closes this view only (capture: before the chat's own Escape handling). A fullscreen CodeBlock opened from
  // the Code tab sits above it and closes first.
  const onKey = (e: KeyboardEvent) => {
    if (!props.open || e.key !== 'Escape' || document.querySelector('.code-full')) return;
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
        <FullView shown={shown()} code={props.code} result={props.result} onClose={props.onClose} />
      </Portal>
    </Show>
  );
}

function FullView(props: { shown: boolean; code: string; result: Accessor<Result | null>; onClose: () => void }) {
  const [tab, setTab] = createSignal(0);
  const [copied, setCopied] = createSignal(false);
  const [zoom, setZoom] = createSignal(1);
  const [availW, setAvailW] = createSignal(0);
  let canvas: HTMLDivElement | undefined;
  let copyTimer: number | undefined;
  let ro: ResizeObserver | undefined;
  onCleanup(() => {
    clearTimeout(copyTimer);
    ro?.disconnect();
  });

  const drawn = () => {
    const r = props.result();
    return r && 'svg' in r ? r : null;
  };
  const error = () => {
    const r = props.result();
    return r && 'error' in r ? r.error : null;
  };
  const svg = createMemo(() => {
    const r = drawn();
    return r ? placed(r) : '';
  });
  // zoom 1 = the page width (like the WebView's max-width: 100%), at most twice the diagram's own size
  const width = () => {
    const r = drawn();
    if (!r) return 0;
    const fit = availW() > 40 ? Math.min((availW() - 20) / r.w, 2) : 1;
    return Math.max(1, r.w * fit * zoom());
  };

  const observe = (el: HTMLDivElement) => {
    canvas = el;
    ro?.disconnect();
    setAvailW(el.clientWidth);
    // next frame: the new width can add / remove a scrollbar, which would re-enter the observer in the same frame
    ro = new ResizeObserver(() => requestAnimationFrame(() => setAvailW(el.clientWidth)));
    ro.observe(el);
  };

  /** WebView.zoomIn / zoomOut (×1.25), keeping the middle of the view where it is. */
  const zoomTo = (z: number) => {
    const c = canvas;
    const cx = c ? (c.scrollLeft + c.clientWidth / 2) / Math.max(1, c.scrollWidth) : 0.5;
    const cy = c ? (c.scrollTop + c.clientHeight / 2) / Math.max(1, c.scrollHeight) : 0.5;
    setZoom(Math.min(8, Math.max(0.25, z)));
    if (c) {
      c.scrollLeft = cx * c.scrollWidth - c.clientWidth / 2;
      c.scrollTop = cy * c.scrollHeight - c.clientHeight / 2;
    }
  };
  const reset = () => {
    setZoom(1);
    canvas?.scrollTo(0, 0);
  };

  const copy = () => {
    copyText(props.code, 'Diagram code copied');
    setCopied(true);
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div
      class="mmd-full"
      classList={{ shown: props.shown }}
      role="dialog"
      aria-modal="true"
      aria-label="Mermaid Diagram"
      // Solid sends events from a Portal on to its parent in the component tree (the card, the message): stop here
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div class="mmd-full-bar">
        <IconButton icon="close" size={36} iconSize={24} color="var(--on-surface)" title="Close" onClick={props.onClose} />
        <span class="mmd-full-title">Mermaid Diagram</span>
        <span class="mmd-spacer" />
        <Pills tab={tab()} onTab={setTab} />
        <Show when={tab() === 0}>
          <PathButton d={ZOOM_OUT} title="Zoom Out" onClick={() => zoomTo(zoom() / 1.25)} />
          <PathButton d={ZOOM_IN} title="Zoom In" onClick={() => zoomTo(zoom() * 1.25)} />
          <IconButton icon="restart" size={32} iconSize={18} color={DIM70} title="Reset Zoom" onClick={reset} />
          <span class="mmd-gap2" />
        </Show>
        <IconButton
          icon={copied() ? 'check' : 'copy'}
          size={36}
          iconSize={18}
          color={copied() ? 'var(--success)' : DIM70}
          title={copied() ? 'Copied' : 'Copy'}
          onClick={copy}
        />
      </div>
      <div class="mmd-full-divider" />
      <Show
        when={tab() === 0 && error() === null}
        fallback={
          <div class="mmd-full-code">
            <Show when={tab() === 0 && error() !== null} fallback={<CodeBlock code={props.code} lang="mermaid" complete />}>
              <ErrorView code={props.code} error={error()!} />
            </Show>
          </div>
        }
      >
        <div
          ref={observe}
          class="mmd-full-canvas"
          onWheel={(e) => {
            // pinch / ctrl + wheel zooms, as pinch-zoom does in the app's WebView
            if (!e.ctrlKey) return;
            e.preventDefault();
            zoomTo(zoom() * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
          }}
        >
          <div class="mmd-full-svg" style={{ width: drawn() ? `${width()}px` : undefined }} innerHTML={svg()} />
        </div>
      </Show>
    </div>
  );
}
