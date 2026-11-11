// Media in chat messages: the full-screen image viewer (FullScreenImageDialog.kt), markdown images
// (MarkdownImageView), the YouTube card (YouTubeVideoView) and a video link card (ChatVideoPlayer's idle look).
// Sizes: 1dp = 1px, text in sp (media.css). Nothing plays inline here: the webview may not load remote media, so the
// YouTube card and the video card open their link instead.
import { createComputed, createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { mediaUrl, readImage, send } from '../state/store';
import { isVsCode } from '../host';
import { Icon, IconButton, nextFrame } from '../ui/primitives';

// Material icons the app uses that ui/iconData.ts does not have (filled set, @material-design-icons/svg).
const BROKEN_IMAGE =
  'M21 5v6.59l-3-3.01-4 4.01-4-4-4 4-3-3.01V5c0-1.1.9-2 2-2h14c1.1 0 2 .9 2 2zm-3 6.42 3 3.01V19c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2v-6.58l3 2.99 4-4 4 4 4-3.99z';
const DOWNLOAD_FILLED = 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z';

function PathIcon(props: { d: string; size: number; color?: string }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" width={props.size} height={props.size} fill="currentColor" aria-hidden="true" style={{ color: props.color }}>
      <path d={props.d} />
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------ sources

/** Where an image comes from: a local file (read by the host) or something the webview can load itself. */
type MediaSource = { kind: 'local'; ref: string } | { kind: 'web'; ref: string };

function localPath(p: string): string {
  let s = p.trim();
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\/(localhost)?/i, '');
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep it as written */
    }
    // file:///C:/x → C:/x
    if (/^\/[a-zA-Z]:[\\/]/.test(s)) s = s.slice(1);
  }
  return s;
}

function classify(src?: string | null, path?: string | null): MediaSource | null {
  const p = path?.trim();
  if (p) return { kind: 'local', ref: localPath(p) };
  const s = src?.trim();
  if (!s) return null;
  if (/^file:\/\//i.test(s)) return { kind: 'local', ref: localPath(s) };
  // protocol-relative (//host/x.png) is a web URL, not a path
  if (s.startsWith('//')) return { kind: 'web', ref: 'https:' + s };
  if (s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s)) return { kind: 'local', ref: s };
  return { kind: 'web', ref: s };
}

/**
 * The URL an <img> can show for `src` / `path` (HubMediaResolver's job in the app): web / data: / blob: URLs as they
 * are, local files as a data: URL read by the host. `failed` = nothing to show (no source, or the host could not read it).
 */
function createImageUrl(src: () => string | null | undefined, path: () => string | null | undefined = () => null) {
  const source = createMemo(() => classify(src(), path()), null, {
    equals: (a, b) => a?.kind === b?.kind && a?.ref === b?.ref,
  });
  const [local, setLocal] = createSignal<{ path: string; url: string | null; done: boolean } | null>(null);
  createEffect(() => {
    const s = source();
    if (s?.kind !== 'local') {
      setLocal(null);
      return;
    }
    let alive = true;
    onCleanup(() => (alive = false));
    setLocal({ path: s.ref, url: null, done: false });
    readImage(s.ref).then(
      (url) => alive && setLocal({ path: s.ref, url, done: true }),
      () => alive && setLocal({ path: s.ref, url: null, done: true }),
    );
  });
  const url = () => {
    const s = source();
    if (!s) return null;
    if (s.kind === 'web') return s.ref;
    const l = local();
    return l && l.path === s.ref ? l.url : null;
  };
  const failed = () => {
    const s = source();
    if (!s) return true;
    if (s.kind === 'web') return false;
    const l = local();
    return !!l && l.path === s.ref && l.done && !l.url;
  };
  return { source, url, failed };
}

const fileNameOf = (u: string) => {
  const clean = u.split(/[?#]/)[0].replace(/\/+$/, '');
  const name = clean.substring(clean.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

/** Enter / Space on a role="button" element acts as a click. */
const keyActivate = (fn: (e: Event) => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn(e);
  }
};

// ------------------------------------------------------------------------------------------------ image viewer

interface ViewerRequest {
  src: string | null;
  path: string | null;
  title: string;
  n: number;
}

const [viewerRequest, setViewerRequest] = createSignal<ViewerRequest | null>(null);
let viewerN = 0;

/** Opens the full-screen image viewer (render <ImageViewerHost/> once). A local `path` wins over `src`. */
export function openImageViewer(opts: { src?: string | null; path?: string | null; title?: string | null }) {
  const src = opts.src?.trim() || null;
  const path = opts.path?.trim() || null;
  if (!src && !path) return;
  setViewerRequest({ src, path, title: opts.title?.trim() ?? '', n: ++viewerN });
}

const MIN_SCALE = 0.8;
const MAX_SCALE = 5;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/avif': 'avif',
};

function downloadName(title: string, url: string) {
  const base = (title || 'image').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 80) || 'image';
  if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
  const mime = /^data:([^;,]+)/i.exec(url)?.[1]?.toLowerCase();
  return `${base}.${(mime && EXT_BY_MIME[mime]) || 'png'}`;
}

/**
 * FullScreenImageDialog: terminal background at 96%, the image fit inside 16dp of padding, zoom 0.8–5× (pinch, mouse
 * wheel / trackpad pinch), double-click / double-tap toggles 2.5× ↔ 1×, drag pans while zoomed; top bar with close,
 * title, Reset Zoom (only when zoomed) and Download. Escape closes it (Back in the app); a click outside the image does
 * not (dismissOnClickOutside = false).
 */
export function ImageViewerHost() {
  const [mounted, setMounted] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  const [req, setReq] = createSignal<ViewerRequest | null>(null);
  const [scale, setScale] = createSignal(1);
  const [offset, setOffset] = createSignal({ x: 0, y: 0 });
  const [dragging, setDragging] = createSignal(false);
  let timer: number | undefined;
  let stage: HTMLDivElement | undefined;

  const resetZoom = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  createEffect(
    on(viewerRequest, (r) => {
      clearTimeout(timer);
      if (r) {
        setReq(r);
        resetZoom();
        setMounted(true);
        nextFrame(() => viewerRequest() && setShown(true));
      } else {
        setShown(false);
        timer = window.setTimeout(() => {
          setMounted(false);
          setReq(null);
        }, 160);
      }
    }),
  );

  const close = () => setViewerRequest(null);
  const title = () => req()?.title ?? '';
  const media = createImageUrl(
    () => req()?.src,
    () => req()?.path,
  );

  // Escape = Back. On window in the capture phase: it runs before every document listener (the artifacts panel, the
  // accounts dialog… also close on Escape in the capture phase), and stopping it there keeps them open.
  const onKey = (e: KeyboardEvent) => {
    if (viewerRequest() && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  onMount(() => window.addEventListener('keydown', onKey, true));
  onCleanup(() => {
    window.removeEventListener('keydown', onKey, true);
    clearTimeout(timer);
  });

  // ------------------------------------------------------------------ gestures
  /** A point relative to the stage's center (= the image's transform origin). */
  const rel = (e: { clientX: number; clientY: number }) => {
    const r = stage!.getBoundingClientRect();
    return { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
  };
  /** detectTransformGestures: scale × zoom (clamped), pan only while zoomed in, offset back to 0 at ≤ 1×. */
  const transform = (zoom: number, panX: number, panY: number) => {
    const s = clampScale(scale() * zoom);
    setScale(s);
    if (s > 1) setOffset((o) => ({ x: o.x + panX, y: o.y + panY }));
    else if (offset().x || offset().y) setOffset({ x: 0, y: 0 });
  };
  /** Zoom to `target`, keeping the image point under `at` where it is (wheel, double-click). */
  const zoomAt = (target: number, at: { x: number; y: number }) => {
    const s0 = scale();
    const s1 = clampScale(target);
    setScale(s1);
    if (s1 <= 1) {
      setOffset({ x: 0, y: 0 });
      return;
    }
    const k = s1 / s0;
    setOffset((o) => ({ x: at.x - (at.x - o.x) * k, y: at.y - (at.y - o.y) * k }));
  };

  const pointers = new Map<number, { x: number; y: number }>();
  let last: { cx: number; cy: number; d: number; n: number } | null = null;
  const metrics = () => {
    const a = [...pointers.values()];
    if (!a.length) return null;
    const cx = a.reduce((t, p) => t + p.x, 0) / a.length;
    const cy = a.reduce((t, p) => t + p.y, 0) / a.length;
    const d = a.length > 1 ? Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) : 0;
    return { cx, cy, d, n: a.length };
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stage?.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    last = metrics();
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const m = metrics();
    if (m && last && m.n === last.n) {
      const zoom = m.n > 1 && last.d > 0 ? m.d / last.d : 1;
      if (zoom !== 1 || m.cx !== last.cx || m.cy !== last.cy) transform(zoom, m.cx - last.cx, m.cy - last.cy);
    }
    last = m;
  };
  const onPointerEnd = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    last = metrics();
    if (!pointers.size) setDragging(false);
  };
  const onDblClick = (e: MouseEvent) => {
    if (scale() > 1.2) resetZoom();
    else zoomAt(2.5, rel(e));
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    // ctrlKey = a trackpad pinch (small deltas)
    const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002));
    zoomAt(scale() * factor, rel(e));
  };
  const bindStage = (el: HTMLDivElement) => {
    stage = el;
    el.addEventListener('wheel', onWheel, { passive: false });
    onCleanup(() => el.removeEventListener('wheel', onWheel));
  };

  // ------------------------------------------------------------------ download
  const download = () => {
    const r = req();
    const m = r && classify(r.src, r.path);
    if (!m) return;
    if (m.kind === 'local') {
      send({ type: 'saveArtifact', path: m.ref });
      return;
    }
    if (/^https?:/i.test(m.ref)) {
      send({ type: 'openUrl', url: m.ref });
      return;
    }
    const a = document.createElement('a');
    a.href = m.ref;
    a.download = downloadName(r.title, m.ref);
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Show when={mounted()}>
      <Portal>
        <div
          class="iv"
          classList={{ shown: shown() }}
          role="dialog"
          aria-modal="true"
          aria-label={title() || 'Image Viewer'}
          // Solid sends portal events on to the component that renders the host: keep them here
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onDblClick={(e) => e.stopPropagation()}
        >
          <div
            ref={bindStage}
            class="iv-stage"
            classList={{ zoomed: scale() > 1, dragging: dragging() && scale() > 1 }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onLostPointerCapture={onPointerEnd}
            onDblClick={onDblClick}
          >
            <Show when={media.url()} keyed>
              {(u) => (
                <img
                  class="iv-img"
                  src={u}
                  alt={title()}
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                  // Coil draws nothing for an image it cannot load (no broken-image glyph / alt text)
                  onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
                  style={{ transform: `translate(${offset().x}px, ${offset().y}px) scale(${scale()})` }}
                />
              )}
            </Show>
          </div>

          <div class="iv-bar">
            <button class="iv-btn" title="Close" aria-label="Close" onClick={close}>
              <Icon name="close" size={24} />
            </button>
            <div class="iv-title">{title() || 'Image Viewer'}</div>
            <Show when={scale() !== 1}>
              <button class="iv-btn iv-btn-reset" title="Reset Zoom" aria-label="Reset Zoom" onClick={resetZoom}>
                <Icon name="refresh_f" size={18} />
              </button>
            </Show>
            <button class="iv-btn" title="Download" aria-label="Download" onClick={download}>
              <PathIcon d={DOWNLOAD_FILLED} size={18} />
            </button>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

// ------------------------------------------------------------------------------------------------ markdown image

/** Indeterminate CircularProgressIndicator (24dp, 2dp stroke). */
function Spinner(props: { color?: string }) {
  return (
    <svg class="media-spinner" viewBox="0 0 24 24" width="24" height="24" aria-label="Loading" style={{ color: props.color }}>
      <circle cx="12" cy="12" r="11" />
    </svg>
  );
}

/**
 * MarkdownImageView: rounded 12dp surface (surfaceVariant 30%, 1dp onSurface 10% border), the image fit to the full
 * width and 120–340dp tall, a spinner while it loads, the broken-image state, the alt text as an italic caption; a click
 * opens the full-screen viewer.
 */
export function MarkdownImage(props: { src: string; alt?: string; title?: string }) {
  const media = createImageUrl(() => props.src);
  const [loaded, setLoaded] = createSignal(false);
  const [broken, setBroken] = createSignal(false);
  createComputed(
    on(media.url, () => {
      setLoaded(false);
      setBroken(false);
    }),
  );
  const alt = () => props.alt?.trim() ?? '';
  const error = () => media.failed() || broken();
  const loading = () => !error() && !loaded();

  const open = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    openImageViewer({ src: props.src, title: alt() || props.title?.trim() || '' });
  };

  return (
    <div class="mimg">
      <div
        class="mimg-frame"
        role="button"
        tabIndex={0}
        title={props.title || undefined}
        aria-label={alt() || props.title || 'Image'}
        onClick={open}
        onKeyDown={keyActivate(open)}
      >
        <div class="mimg-box">
          <Show when={media.url()} keyed>
            {(u) => (
              <img
                class="mimg-img"
                classList={{ loaded: loaded(), broken: broken() }}
                src={u}
                alt={alt()}
                loading="lazy"
                draggable={false}
                onLoad={() => u === media.url() && setLoaded(true)}
                onError={() => u === media.url() && setBroken(true)}
              />
            )}
          </Show>
          <Show when={loading()}>
            <Spinner />
          </Show>
          <Show when={error()}>
            <div class="mimg-error">
              <PathIcon d={BROKEN_IMAGE} size={32} color="var(--error)" />
              <div class="mimg-error-text">{alt() || 'Image could not be loaded'}</div>
            </div>
          </Show>
        </div>
      </div>
      <Show when={alt()}>
        <div class="media-caption">{alt()}</div>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ YouTube card

/**
 * YouTubeVideoView before it plays: header (24dp red play badge, title, open button), 16:9 thumbnail (crop) with a
 * dark gradient and the 62×42dp red play button. Every part opens the video's URL (no inline player in a webview).
 */
export function YouTubeCard(props: { url: string; videoId: string; title?: string | null }) {
  const videoUrl = () =>
    props.url && /youtube\.com|youtu\.be/i.test(props.url) ? props.url : `https://www.youtube.com/watch?v=${props.videoId}`;
  const title = () => props.title?.trim() || 'YouTube Video';
  const [thumbFailed, setThumbFailed] = createSignal(false);
  // the inline player (an embed page from the host's preview server: YouTube refuses to play without a referrer)
  const [player, setPlayer] = createSignal<string | null>(null);
  createComputed(
    on(
      () => props.videoId,
      () => {
        setThumbFailed(false);
        setPlayer(null);
      },
    ),
  );
  const open = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    send({ type: 'openUrl', url: videoUrl() });
  };
  const start = () => {
    const t = /[?&#](?:t|start)=(\d+)/.exec(props.url ?? '')?.[1];
    return t ? Number(t) : 0;
  };
  const play = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    // YouTube's player loads inside VS Code but never starts (it aborts every video request in VS Code's Electron):
    // there the video opens in the browser. Elsewhere (the dev page) it plays in the chat.
    if (isVsCode) {
      send({ type: 'openUrl', url: videoUrl() });
      return;
    }
    mediaUrl('youtube', props.videoId, start()).then(setPlayer, () => send({ type: 'openUrl', url: videoUrl() }));
  };
  return (
    <div class="yt-card">
      <div class="yt-head">
        <div class="yt-head-main">
          <div class="yt-badge" aria-hidden="true">
            <Icon name="play" size={16} color="#fff" />
          </div>
          <div class="yt-title" title={title()}>
            {title()}
          </div>
        </div>
        <IconButton
          icon="open_in_new"
          size={28}
          iconSize={16}
          color="color-mix(in srgb, var(--on-surface-variant) 80%, transparent)"
          title="Open in YouTube"
          onClick={open}
        />
      </div>
      <Show when={player()} keyed>
        {(u) => (
          <div class="yt-media playing">
            <iframe class="yt-frame" src={u} title={title()} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen />
          </div>
        )}
      </Show>
      <div
        class="yt-media"
        classList={{ hidden: !!player() }}
        role="button"
        tabIndex={0}
        aria-label={`Play ${title()}`}
        title={isVsCode ? `Opens in your browser: ${videoUrl()}` : videoUrl()}
        onClick={play}
        onKeyDown={keyActivate(play)}
      >
        <Show when={!thumbFailed()}>
          <img
            class="yt-thumb"
            src={`https://i.ytimg.com/vi/${props.videoId}/hqdefault.jpg`}
            alt={props.title?.trim() || 'YouTube Video Thumbnail'}
            loading="lazy"
            draggable={false}
            onError={() => setThumbFailed(true)}
          />
        </Show>
        <div class="yt-shade" />
        <div class="yt-play" aria-hidden="true">
          <Icon name="play" size={26} color="#fff" />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ video link card

const formatTime = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/**
 * ChatVideoPlayer: a local or web video plays in the app's player (the preview server's player page: first frame and
 * length, then the round play / pause with ⟲10 / 10⟳, seek bar, speed, full view). Inside VS Code the webview cannot
 * stream a local file itself (its service worker re-fetches every request to 127.0.0.1, which a <video> rejects), and a
 * web video may refuse the webview (CORS), so both play in that page. The player loads once the card is on screen.
 * data: / blob: videos play here directly.
 */
export function VideoLinkCard(props: { url: string; title?: string | null; thumbnail?: string | null; durationMs?: number | null }) {
  const thumb = createImageUrl(() => props.thumbnail);
  const [thumbFailed, setThumbFailed] = createSignal(false);
  createComputed(on(thumb.url, () => setThumbFailed(false)));
  const hasThumb = () => !!thumb.url() && !thumbFailed();
  // the app's caption is the alt text only; with no title and no picture the card would say nothing, so it shows the
  // file name there instead
  const caption = () => props.title?.trim() || (props.thumbnail?.trim() ? '' : fileNameOf(props.url));
  const name = () => props.title?.trim() || fileNameOf(props.url) || 'Video';
  const source = createMemo(() => classify(props.url));
  const inline = () => {
    const m = source();
    return m?.kind === 'web' && /^(data|blob):/i.test(m.ref);
  };
  const [frame, setFrame] = createSignal<string | null>(null);
  const [direct, setDirect] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [full, setFull] = createSignal(false);
  let box: HTMLDivElement | undefined;
  let iframe: HTMLIFrameElement | undefined;

  const openOutside = () => {
    const m = source();
    if (!m) return;
    if (m.kind === 'local') send({ type: 'openFile', path: m.ref });
    else send({ type: 'openUrl', url: m.ref });
  };
  /** The player page for this video ([autoplay]: the user already pressed play). */
  const load = (autoplay: boolean) => {
    const m = source();
    if (!m || frame() || direct()) return;
    if (inline()) {
      setDirect(true);
      return;
    }
    const accent = getComputedStyle(document.body).getPropertyValue('--primary').trim();
    const q = new URLSearchParams({ title: name(), ...(m.kind === 'local' ? { local: '1' } : {}), ...(autoplay ? { autoplay: '1' } : {}) });
    if (/^#[0-9a-f]{3,8}$/i.test(accent)) q.set('accent', accent);
    mediaUrl('player', m.ref).then(
      (u) => setFrame(`${u}?${q}`),
      () => setFailed(true),
    );
  };
  createComputed(
    on(
      () => props.url,
      () => {
        setFrame(null);
        setDirect(false);
        setFailed(false);
        setFull(false);
      },
    ),
  );
  // load the player once the card is (nearly) on screen: it shows the first frame and the length, like the app
  onMount(() => {
    if (!box) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (io.disconnect(), load(false)), { rootMargin: '200px' });
    io.observe(box);
    onCleanup(() => io.disconnect());
  });
  // the player's requests: full view, open elsewhere, save a copy (only from this card's own frame)
  const onMessage = (e: MessageEvent) => {
    if (!iframe || e.source !== iframe.contentWindow) return;
    const what = (e.data as { antigemPlayer?: string } | null)?.antigemPlayer;
    if (what === 'full') setFull(true);
    else if (what === 'unfull') setFull(false);
    else if (what === 'open') openOutside();
    else if (what === 'save') {
      const m = source();
      if (m?.kind === 'local') send({ type: 'saveArtifact', path: m.ref });
      // a web video: the extension downloads it (save dialog first)
      else if (m && /^https?:/i.test(m.ref)) send({ type: 'downloadUrl', url: m.ref, name: fileNameOf(m.ref) || `${name()}.mp4` });
    }
  };
  // Esc in the chat leaves the full view too (the player is told, so its button turns back)
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !full()) return;
    e.stopPropagation();
    setFull(false);
    iframe?.contentWindow?.postMessage({ antigemPlayerFull: false }, '*');
  };
  onMount(() => {
    window.addEventListener('message', onMessage);
    document.addEventListener('keydown', onKey, true);
    onCleanup(() => {
      window.removeEventListener('message', onMessage);
      document.removeEventListener('keydown', onKey, true);
    });
  });

  return (
    <div class="vl">
      <div ref={box} class="vl-box" classList={{ playing: !!frame() || direct(), full: full() }}>
        <Show
          when={frame()}
          keyed
          fallback={
            <Show
              when={direct()}
              fallback={
                <div
                  class="vl-idle"
                  role="button"
                  tabIndex={0}
                  aria-label={`Play ${name()}`}
                  title={props.url}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (failed()) openOutside();
                    else load(true);
                  }}
                  onKeyDown={keyActivate(() => load(true))}
                >
                  <Show when={hasThumb()}>
                    <img class="vl-thumb" src={thumb.url()!} alt="" draggable={false} onError={() => setThumbFailed(true)} />
                  </Show>
                  <div class="vl-disc" aria-hidden="true">
                    <Icon name="play" size={31.2} color="#fff" />
                  </div>
                  <Show when={(props.durationMs ?? 0) > 0}>
                    <div class="vl-length">{formatTime(props.durationMs!)}</div>
                  </Show>
                </div>
              }
            >
              <video class="vl-video" src={source()?.ref} controls autoplay playsinline preload="metadata" onError={() => setDirect(false)} />
            </Show>
          }
        >
          {(u) => <iframe ref={iframe} class="vl-frame" src={u} title={name()} allow="autoplay; fullscreen; picture-in-picture" allowfullscreen />}
        </Show>
      </div>
      <Show when={caption() && !full()}>
        <div class="media-caption">{caption()}</div>
      </Show>
    </div>
  );
}
