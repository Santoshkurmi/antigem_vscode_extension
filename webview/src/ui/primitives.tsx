// Small building blocks that stand in for the Compose/Material pieces the app uses:
// Icon, AnimatedVisibility (expandVertically + fade), DropdownMenu, AlertDialog and ModalBottomSheet.
import {
  createEffect,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
  splitProps,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { iconPaths, type IconName } from './iconData';

export type { IconName };

export function Icon(props: { name: IconName; size?: number; color?: string; class?: string; style?: JSX.CSSProperties; title?: string }) {
  return (
    <svg
      class={'icon' + (props.class ? ' ' + props.class : '')}
      viewBox="0 0 24 24"
      width={props.size ?? 24}
      height={props.size ?? 24}
      fill="currentColor"
      aria-hidden={props.title ? undefined : 'true'}
      style={{ color: props.color, ...props.style }}
      innerHTML={iconPaths(props.name)}
    />
  );
}

/**
 * Runs `cb` once the current state has been painted (two animation frames), so a CSS transition can start from it.
 * A timer backs it up: hidden or throttled pages (and screenshots of them) skip animation frames.
 */
export function nextFrame(cb: () => void) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cb();
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(run, 80);
}

/** Font size in sp (see --sp in theme.css). */
export const sp = (n: number) => `calc(${n} * var(--sp))`;

/**
 * AnimatedVisibility(enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()).
 * Height animates with a grid 0fr → 1fr track (no measuring), on Compose's default spring.
 * Visible from the start = shown without animation, as in Compose.
 */
export function Collapse(props: ParentProps<{ when: boolean; fade?: boolean; class?: string; duration?: string; easing?: string }>) {
  const [mounted, setMounted] = createSignal(props.when);
  const [open, setOpen] = createSignal(props.when);
  let timer: number | undefined;
  createEffect(
    on(
      () => props.when,
      (w) => {
        clearTimeout(timer);
        if (w) {
          setMounted(true);
          // two frames: the closed state must be painted before it can transition
          nextFrame(() => setOpen(true));
        } else {
          setOpen(false);
          timer = window.setTimeout(() => setMounted(false), 480);
        }
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  return (
    <Show when={mounted()}>
      <div
        class={'collapse' + (props.fade === false ? ' no-fade' : '') + (props.class ? ' ' + props.class : '')}
        classList={{ open: open() }}
        style={{
          '--c-dur': props.duration,
          '--c-ease': props.easing,
        }}
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && e.propertyName === 'grid-template-rows' && !props.when) {
            clearTimeout(timer);
            setMounted(false);
          }
        }}
      >
        <div class="collapse-inner">{props.children}</div>
      </div>
    </Show>
  );
}

/** Presence with fade (+ optional scale) in/out: AnimatedVisibility(fadeIn() + scaleIn(…), fadeOut() + scaleOut(…)). */
export function Fade(props: ParentProps<{ when: boolean; class?: string; scale?: number; style?: JSX.CSSProperties }>) {
  const [mounted, setMounted] = createSignal(props.when);
  const [shown, setShown] = createSignal(props.when);
  let timer: number | undefined;
  createEffect(
    on(
      () => props.when,
      (w) => {
        clearTimeout(timer);
        if (w) {
          setMounted(true);
          nextFrame(() => setShown(true));
        } else {
          setShown(false);
          timer = window.setTimeout(() => setMounted(false), 450);
        }
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  return (
    <Show when={mounted()}>
      <div
        class={'fade' + (props.class ? ' ' + props.class : '')}
        classList={{ shown: shown() }}
        style={{ '--fade-scale': String(props.scale ?? 1), ...props.style }}
      >
        {props.children}
      </div>
    </Show>
  );
}

// ------------------------------------------------------------------------------------------------ dropdown menu

export interface MenuItem {
  label: string;
  icon?: IconName;
  iconColor?: string;
  color?: string;
  description?: string;
  onClick: () => void;
  divider?: boolean;
}

/**
 * Material3 DropdownMenu anchored to an element: opens below it (above when there is no room), scales in from
 * the anchor's corner (120 ms LinearOutSlowIn), fades out in 75 ms.
 */
export function DropdownMenu(
  props: ParentProps<{
    anchor: () => HTMLElement | undefined;
    open: boolean;
    onClose: () => void;
    items?: MenuItem[];
    width?: number;
    minWidth?: number;
    class?: string;
    radius?: number;
    align?: 'start' | 'end';
    background?: string;
    border?: string;
  }>,
) {
  const [pos, setPos] = createSignal<{ left: number; top: number; origin: string } | null>(null);
  const [mounted, setMounted] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  let el: HTMLDivElement | undefined;
  let timer: number | undefined;

  const place = () => {
    const a = props.anchor();
    if (!a || !el) return;
    const r = a.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = props.align === 'end' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    let top = r.bottom + 2;
    let originY = 'top';
    if (top + h > vh - 8 && r.top - h - 2 > 8) {
      top = r.top - h - 2;
      originY = 'bottom';
    }
    top = Math.max(8, Math.min(top, vh - h - 8));
    const originX = left + w / 2 < r.left + r.width / 2 ? 'right' : 'left';
    setPos({ left, top, origin: `${originY} ${props.align === 'end' ? 'right' : originX === 'right' ? 'right' : 'left'}` });
  };

  createEffect(
    on(
      () => props.open,
      (o) => {
        clearTimeout(timer);
        if (o) {
          setMounted(true);
          setShown(false);
          requestAnimationFrame(place);
          nextFrame(() => {
            place();
            setShown(true);
          });
        } else if (mounted()) {
          setShown(false);
          timer = window.setTimeout(() => setMounted(false), 90);
        }
      },
    ),
  );

  const onDocDown = (e: PointerEvent) => {
    if (!props.open) return;
    const t = e.target as Node;
    if (el?.contains(t) || props.anchor()?.contains(t)) return;
    props.onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (props.open && e.key === 'Escape') {
      e.stopPropagation();
      props.onClose();
    }
  };
  onMount(() => {
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', props.onClose);
  });
  onCleanup(() => {
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', props.onClose);
    clearTimeout(timer);
  });

  return (
    <Show when={mounted()}>
      <Portal>
        <div
          ref={el}
          class={'menu' + (props.class ? ' ' + props.class : '')}
          classList={{ shown: shown() }}
          role="menu"
          // Solid sends events from a Portal on to its parent in the component tree: a menu item must not also click
          // the row / pill the menu belongs to
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            left: `${pos()?.left ?? -9999}px`,
            top: `${pos()?.top ?? -9999}px`,
            'transform-origin': pos()?.origin ?? 'top left',
            width: props.width ? `${props.width}px` : undefined,
            'min-width': props.minWidth ? `${props.minWidth}px` : undefined,
            'border-radius': props.radius != null ? `${props.radius}px` : undefined,
            background: props.background,
            border: props.border,
          }}
        >
          <Show when={props.items}>
            <For each={props.items}>
              {(it) => (
                <>
                  <Show when={it.divider}>
                    <div class="menu-divider" />
                  </Show>
                  <button
                    class="menu-item"
                    role="menuitem"
                    onClick={() => {
                      props.onClose();
                      it.onClick();
                    }}
                  >
                    <Show when={it.icon}>
                      <Icon name={it.icon!} size={18} color={it.iconColor ?? 'var(--on-surface-variant)'} />
                    </Show>
                    <span class="menu-item-text" style={{ color: it.color }}>
                      <span>{it.label}</span>
                      <Show when={it.description}>
                        <span class="menu-item-desc">{it.description}</span>
                      </Show>
                    </span>
                  </button>
                </>
              )}
            </For>
          </Show>
          {props.children}
        </div>
      </Portal>
    </Show>
  );
}

// ------------------------------------------------------------------------------------------------ dialog

export function Dialog(
  props: ParentProps<{
    open: boolean;
    onClose: () => void;
    title?: JSX.Element;
    icon?: JSX.Element;
    actions?: JSX.Element;
    radius?: number;
    background?: string;
    width?: number;
  }>,
) {
  const [mounted, setMounted] = createSignal(props.open);
  const [shown, setShown] = createSignal(false);
  let timer: number | undefined;
  createEffect(
    on(
      () => props.open,
      (o) => {
        clearTimeout(timer);
        if (o) {
          setMounted(true);
          nextFrame(() => setShown(true));
        } else {
          setShown(false);
          timer = window.setTimeout(() => setMounted(false), 160);
        }
      },
    ),
  );
  const onKey = (e: KeyboardEvent) => {
    if (props.open && e.key === 'Escape') props.onClose();
  };
  onMount(() => document.addEventListener('keydown', onKey));
  onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    clearTimeout(timer);
  });
  return (
    <Show when={mounted()}>
      <Portal>
        <div
          class="dialog-scrim"
          classList={{ shown: shown() }}
          onClick={(e) => {
            e.stopPropagation();
            props.onClose();
          }}
        >
          <div
            class="dialog"
            role="dialog"
            style={{
              'border-radius': `${props.radius ?? 28}px`,
              background: props.background,
              width: props.width ? `${props.width}px` : undefined,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <Show when={props.icon}>
              <div class="dialog-icon">{props.icon}</div>
            </Show>
            <Show when={props.title}>
              <div class="dialog-title" classList={{ centered: !!props.icon }}>
                {props.title}
              </div>
            </Show>
            <div class="dialog-body">{props.children}</div>
            <Show when={props.actions}>
              <div class="dialog-actions">{props.actions}</div>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

// ------------------------------------------------------------------------------------------------ bottom sheet

/** ModalBottomSheet: scrim, slides up on Material's spatial spring, drag handle, max width 640dp. */
export function BottomSheet(props: ParentProps<{ open: boolean; onClose: () => void; class?: string }>) {
  const [mounted, setMounted] = createSignal(props.open);
  const [shown, setShown] = createSignal(false);
  let timer: number | undefined;
  let sheet: HTMLDivElement | undefined;
  createEffect(
    on(
      () => props.open,
      (o) => {
        clearTimeout(timer);
        if (o) {
          setMounted(true);
          nextFrame(() => setShown(true));
        } else {
          setShown(false);
          timer = window.setTimeout(() => setMounted(false), 320);
        }
      },
    ),
  );
  const onKey = (e: KeyboardEvent) => {
    if (props.open && e.key === 'Escape') props.onClose();
  };
  onMount(() => document.addEventListener('keydown', onKey));
  onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    clearTimeout(timer);
  });

  // drag the handle down to dismiss
  let dragY0 = 0;
  let dragging = false;
  const down = (e: PointerEvent) => {
    dragging = true;
    dragY0 = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (sheet) sheet.style.transition = 'none';
  };
  const move = (e: PointerEvent) => {
    if (!dragging || !sheet) return;
    const dy = Math.max(0, e.clientY - dragY0);
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const up = (e: PointerEvent) => {
    if (!dragging || !sheet) return;
    dragging = false;
    const dy = Math.max(0, e.clientY - dragY0);
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > sheet.offsetHeight * 0.25) props.onClose();
  };

  return (
    <Show when={mounted()}>
      <Portal>
        <div
          class="sheet-scrim"
          classList={{ shown: shown() }}
          onClick={(e) => {
            e.stopPropagation();
            props.onClose();
          }}
        />
        <div class="sheet-wrap" classList={{ shown: shown() }} onClick={(e) => e.stopPropagation()}>
          <div ref={sheet} class={'sheet' + (props.class ? ' ' + props.class : '')}>
            <div class="sheet-handle-area" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
              <div class="sheet-handle" />
            </div>
            {props.children}
          </div>
        </div>
      </Portal>
    </Show>
  );
}

/** A round icon button (Material IconButton: 40/48dp touch target with a state layer). */
export function IconButton(
  props: {
    icon: IconName;
    size?: number;
    iconSize?: number;
    color?: string;
    title?: string;
    onClick?: (e: MouseEvent) => void;
    class?: string;
    style?: JSX.CSSProperties;
    ref?: (el: HTMLButtonElement) => void;
    disabled?: boolean;
  },
) {
  const [p] = splitProps(props, ['icon', 'size', 'iconSize', 'color', 'title', 'onClick', 'class', 'style', 'ref', 'disabled']);
  return (
    <button
      ref={p.ref}
      class={'icon-btn' + (p.class ? ' ' + p.class : '')}
      title={p.title}
      aria-label={p.title}
      disabled={p.disabled}
      style={{ width: `${p.size ?? 28}px`, height: `${p.size ?? 28}px`, ...p.style }}
      onClick={(e) => p.onClick?.(e)}
    >
      <Icon name={p.icon} size={p.iconSize ?? 16} color={p.color} />
    </button>
  );
}
