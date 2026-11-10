// Jarvis' face (ui/jarvis/JarvisBot.kt): a small robot head (antenna, ears, a glass visor with two glowing eyes and a
// mouth). drawJarvisBot's geometry 1:1 as an SVG (1dp = 1px). JarvisBotIcon(animated = true) blinks now and then and
// glances sideways (keyframes 3800 ms / tween 2200 ms linear, reversed); JarvisBotBadge puts it on a round glass badge.
// The voice-only parts of the drawing (mouth opening while speaking, eyes growing while listening) are not ported.
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show } from 'solid-js';

/** The app's Jarvis accent (ui/jarvis/JarvisOverlay.kt Cyan). */
export const JARVIS_CYAN = '#22D3EE';
const VISOR = '#07101C';

// one animation clock for every animated bot (an infinite transition redraws each frame, so does this)
const subs = new Set<(now: number) => void>();
let raf = 0;
function tick(now: number) {
  raf = 0;
  for (const fn of [...subs]) fn(now);
  if (subs.size) raf = requestAnimationFrame(tick);
}
function onFrame(fn: (now: number) => void): () => void {
  subs.add(fn);
  if (!raf) raf = requestAnimationFrame(tick);
  return () => {
    subs.delete(fn);
  };
}

/** keyframes { durationMillis = 3800; 1f at 3500; 0.1f at 3620; 1f at 3760 } (linear between keyframes). */
function blinkAt(ms: number): number {
  const t = ms % 3800;
  if (t < 3500 || t >= 3760) return 1;
  if (t < 3620) return 1 - 0.9 * ((t - 3500) / 120);
  return 0.1 + 0.9 * ((t - 3620) / 140);
}

/** animateFloat(-1f, 1f, infiniteRepeatable(tween(2200, easing = LinearEasing), RepeatMode.Reverse)). */
function lookAt(ms: number): number {
  const t = ms % 4400;
  return t < 2200 ? -1 + 2 * (t / 2200) : 1 - 2 * ((t - 2200) / 2200);
}

/** drawRoundRect: Skia shrinks both corner radii together when they do not fit (SVG would clamp each on its own). */
function RRect(p: { x: number; y: number; w: number; h: number; r: number; fill: string; fillOpacity?: string; stroke?: string; strokeWidth?: number }) {
  const k = () => Math.max(0, Math.min(p.r, p.w / 2, p.h / 2));
  return (
    <rect
      x={p.x}
      y={p.y}
      width={Math.max(0, p.w)}
      height={Math.max(0, p.h)}
      rx={k()}
      ry={k()}
      fill={p.fill}
      fill-opacity={p.fillOpacity}
      stroke={p.stroke}
      stroke-width={p.strokeWidth}
    />
  );
}

/**
 * JarvisBotIcon: the Jarvis mark for lists, headers and cards. `active` = animated (it blinks and glances while Jarvis
 * works). `color` defaults to the app's cyan; any CSS color works (it is drawn with currentColor).
 */
export function JarvisBot(props: { size: number; active?: boolean; color?: string; class?: string; title?: string }) {
  const [now, setNow] = createSignal(0);
  createEffect(() => {
    if (!props.active) {
      setNow(0);
      return;
    }
    // the infinite transition starts when the animated bot appears
    let start = -1;
    const off = onFrame((t) => {
      if (start < 0) start = t;
      setNow(t - start);
    });
    onCleanup(off);
  });

  const g = createMemo(() => {
    const box = props.size;
    const c = box / 2;
    const hw = box * 0.7;
    const hh = box * 0.52;
    const headTop = c - hh / 2 + box * 0.07;
    const headLeft = c - hw / 2;
    // 1.2px / 1px floors of the Canvas code, in dp
    const stroke = Math.max(box * 0.055, 0.45);
    const r = hh * 0.36;
    const tipY = headTop - box * 0.17;
    const earW = box * 0.075;
    const earH = hh * 0.44;
    const earTop = headTop + (hh - earH) / 2;
    const inset = box * 0.085;
    return {
      box,
      c,
      hw,
      hh,
      headTop,
      headLeft,
      stroke,
      r,
      tipY,
      earW,
      earH,
      earTop,
      inset,
      eyeCy: headTop + hh * 0.44,
      eyeDx: hw * 0.19,
      eyeW: box * 0.105,
      mouthW: hw * 0.26,
      mouthY: headTop + hh * 0.74,
    };
  });
  const eyeOpen = () => (props.active ? blinkAt(now()) : 1);
  const lookX = () => (props.active ? lookAt(now()) * 0.6 : 0);
  const eyeH = () => g().box * 0.15 * Math.min(1, Math.max(0.08, eyeOpen()));
  const shift = () => Math.min(1, Math.max(-1, lookX())) * g().hw * 0.07;

  return (
    <svg
      class={'jv-bot' + (props.class ? ' ' + props.class : '')}
      width={props.size}
      height={props.size}
      viewBox={`0 0 ${props.size} ${props.size}`}
      style={{ color: props.color ?? JARVIS_CYAN }}
      role={props.title ? 'img' : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : 'true'}
    >
      {/* antenna with a glowing tip */}
      <line
        x1={g().c}
        y1={g().headTop}
        x2={g().c}
        y2={g().tipY + g().box * 0.05}
        stroke="currentColor"
        stroke-opacity="0.9"
        stroke-width={g().stroke}
        stroke-linecap="round"
      />
      <circle cx={g().c} cy={g().tipY} r={g().box * 0.1} fill="currentColor" fill-opacity="0.28" />
      <circle cx={g().c} cy={g().tipY} r={g().box * 0.055} fill="currentColor" />
      {/* ears */}
      <RRect x={g().headLeft - g().earW * 0.85} y={g().earTop} w={g().earW} h={g().earH} r={g().earW / 2} fill="currentColor" fillOpacity="0.85" />
      <RRect x={g().headLeft + g().hw - g().earW * 0.15} y={g().earTop} w={g().earW} h={g().earH} r={g().earW / 2} fill="currentColor" fillOpacity="0.85" />
      {/* head and visor */}
      <RRect x={g().headLeft} y={g().headTop} w={g().hw} h={g().hh} r={g().r} fill="currentColor" fillOpacity="0.16" />
      <RRect x={g().headLeft} y={g().headTop} w={g().hw} h={g().hh} r={g().r} fill="none" stroke="currentColor" strokeWidth={g().stroke} />
      <RRect
        x={g().headLeft + g().inset}
        y={g().headTop + g().inset}
        w={g().hw - g().inset * 2}
        h={g().hh - g().inset * 2}
        r={Math.max(g().r - g().inset * 0.6, 0.36)}
        fill={VISOR}
        fillOpacity="0.9"
      />
      {/* eyes (pills that blink and glance) */}
      <For each={[-1, 1]}>
        {(side) => {
          const cx = () => g().c + side * g().eyeDx + shift();
          return (
            <>
              <circle cx={cx()} cy={g().eyeCy} r={g().eyeW * 1.15} fill="currentColor" fill-opacity="0.22" />
              <RRect x={cx() - g().eyeW / 2} y={g().eyeCy - eyeH() / 2} w={g().eyeW} h={eyeH()} r={g().eyeW / 2} fill="currentColor" />
              <Show when={eyeOpen() > 0.5}>
                <circle cx={cx() - g().eyeW * 0.12} cy={g().eyeCy - eyeH() * 0.2} r={g().eyeW * 0.2} fill="#fff" fill-opacity="0.85" />
              </Show>
            </>
          );
        }}
      </For>
      {/* mouth: a soft line */}
      <line
        x1={g().c - g().mouthW / 2}
        y1={g().mouthY}
        x2={g().c + g().mouthW / 2}
        y2={g().mouthY}
        stroke="currentColor"
        stroke-opacity="0.8"
        stroke-width={g().stroke * 0.8}
        stroke-linecap="round"
      />
    </svg>
  );
}

/** JarvisBotBadge: the bot (74 % of the size) on a round glass badge with a ring in its color. */
export function JarvisBotBadge(props: { size: number; active?: boolean; color?: string; class?: string }) {
  const id = createUniqueId();
  const r = () => props.size / 2;
  return (
    <div
      class={'jv-badge' + (props.class ? ' ' + props.class : '')}
      style={{ width: `${props.size}px`, height: `${props.size}px`, color: props.color ?? JARVIS_CYAN }}
    >
      <svg class="jv-badge-glass" width={props.size} height={props.size} viewBox={`0 0 ${props.size} ${props.size}`} aria-hidden="true">
        <defs>
          <radialGradient id={`jvg${id}`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stop-color="#16233A" />
            <stop offset="1" stop-color="#0A0F1C" />
          </radialGradient>
        </defs>
        <circle cx={r()} cy={r()} r={r()} fill={`url(#jvg${id})`} />
        <circle cx={r()} cy={r()} r={r() * 0.94} fill="none" stroke="currentColor" stroke-opacity="0.55" stroke-width={r() * 0.07} />
      </svg>
      <JarvisBot size={props.size * 0.74} active={props.active} color={props.color} />
    </div>
  );
}
