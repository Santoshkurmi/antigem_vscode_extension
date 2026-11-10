// The Jarvis overlay (ui/jarvis/JarvisOverlay.kt) without its voice parts: no orb, mic, waves, transcript, send / cancel /
// wait, orb drag. What is left sits under the top bar on the right (the side the app's orb rests on by default):
// the notices, and the slim status pill of the Jarvis chat on screen (or of the one that is working), which opens into
// the activity card (its steps, Stop, its running tasks). Only the chips and cards take clicks.
// Shared bits (colors, PulseDot, Crossfade, NoticeChip, TaskChip) are used by JarvisPanel too.
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
  untrack,
} from 'solid-js';
import type { JarvisManagerView, JarvisNoticeView, JarvisTaskState, JarvisTaskView } from '@shared/protocol';
import { jarvis, jarvisAction, managerOf, setJarvisPanelOpen, tasksOf } from '../state/jarvis';
import { openConversation, state } from '../state/store';
import { closeSettings, openSettings } from '../state/settings';
import { setNotesOpen } from './Notes';
import { Collapse, Icon, type IconName, nextFrame } from '../ui/primitives';

// ------------------------------------------------------------------------------------------------ colors (JarvisOverlay.kt)

export const CYAN = '#22D3EE';
export const BLUE = '#3B82F6';
export const VIOLET = '#8B5CF6';
export const GREEN = '#22C55E';
export const AMBER = '#F59E0B';
export const DANGER = '#EF4444';
const STALLED = '#F97316';
const STOPPED = '#9CA3AF';

export type JarvisPhase = JarvisManagerView['phase'];

/** accentOf(): thinking (the model writes) violet, otherwise cyan. */
export const accentOf = (p: JarvisPhase) => (p === 'thinking' ? VIOLET : CYAN);

const defaultLabel = (p: JarvisPhase) => (p === 'thinking' ? 'Thinking…' : p === 'working' ? 'Working…' : 'Ready');

export function taskColor(s: JarvisTaskState): string {
  switch (s) {
    case 'starting':
      return CYAN;
    case 'running':
      return VIOLET;
    case 'waiting_approval':
    case 'asking':
      return AMBER;
    case 'no_progress':
      return STALLED;
    case 'done':
      return GREEN;
    case 'failed':
      return DANGER;
    default:
      return STOPPED;
  }
}

// ------------------------------------------------------------------------------------------------ small pieces

/** PulseDot: a 10dp dot; while working it pulses (alpha 0.35 → 1, halo 0.85 → 1.25, 700 ms, reversing). */
export function PulseDot(props: { color: string; working: boolean }) {
  return <span class="jp-dot" classList={{ working: props.working }} style={{ '--jp-dot': props.color }} />;
}

/** Crossfade(targetState = text, tween(ms)): the old line fades out while the new one fades in, stacked in one box. */
export function Crossfade(props: { text: string; ms: number; class?: string }) {
  interface Item {
    text: string;
    fresh: boolean;
    out: Accessor<boolean>;
    setOut: (v: boolean) => void;
  }
  const make = (text: string, fresh: boolean): Item => {
    const [out, setOut] = createSignal(false);
    return { text, fresh, out, setOut };
  };
  const [items, setItems] = createSignal<Item[]>([make(props.text, false)]);
  const timers = new Set<number>();
  createEffect(
    on(
      () => props.text,
      (t) => {
        const cur = items();
        const top = cur[cur.length - 1];
        if (top && !top.out() && top.text === t) return;
        for (const it of cur) {
          if (it.out()) continue;
          it.setOut(true);
          const h = window.setTimeout(() => {
            timers.delete(h);
            setItems((l) => l.filter((x) => x !== it));
          }, props.ms);
          timers.add(h);
        }
        setItems([...cur, make(t, true)]);
      },
      { defer: true },
    ),
  );
  onCleanup(() => timers.forEach((h) => clearTimeout(h)));
  return (
    <span class={'jp-xfade' + (props.class ? ' ' + props.class : '')} style={{ '--jp-xf': `${props.ms}ms` }}>
      <For each={items()}>{(it) => <span classList={{ in: it.fresh && !it.out(), out: it.out() }}>{it.text}</span>}</For>
    </span>
  );
}

const noticeColor = (n: JarvisNoticeView) => (n.action === 'setup' ? AMBER : n.level === 'info' ? CYAN : DANGER);

const dismissNotice = (n: JarvisNoticeView) => jarvisAction('dismissNotice', { noticeId: n.id });

/** What tapping a notice does: Settings → Jarvis (→ Setup), or open the chat it is about; then it goes away. */
export function runNoticeAction(n: JarvisNoticeView) {
  setJarvisPanelOpen(false);
  if (n.action === 'setup') openSettings({ id: 'jarvis', title: 'Jarvis' }, [{ id: 'jarvis.setup', title: 'Setup' }]);
  else if (n.action === 'settings') openSettings({ id: 'jarvis', title: 'Jarvis' });
  else if (n.action === 'chat' && n.chatId) {
    setNotesOpen(false);
    closeSettings();
    openConversation(n.chatId);
  }
  dismissNotice(n);
}

/** NoticeChip: dot, up to 4 lines, the action ("Set up" / "Open") and ✕. */
export function NoticeChip(props: { n: JarvisNoticeView }) {
  return (
    <div
      class="jp-notice jp-click"
      style={{ '--jp-c': noticeColor(props.n) }}
      onClick={(e) => {
        e.stopPropagation();
        if (props.n.action) runNoticeAction(props.n);
        else dismissNotice(props.n);
      }}
    >
      <span class="jp-notice-dot" />
      <span class="jp-notice-text">{props.n.text}</span>
      <Show when={props.n.action}>
        <button
          class="jp-notice-act jp-click"
          onClick={(e) => {
            e.stopPropagation();
            runNoticeAction(props.n);
          }}
        >
          {props.n.action === 'chat' ? 'Open' : 'Set up'}
        </button>
      </Show>
      <button
        class="jp-notice-x jp-click"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          dismissNotice(props.n);
        }}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** TaskChip: a running task on the card (tap: the Jarvis panel). */
export function TaskChip(props: { t: JarvisTaskView }) {
  return (
    <button
      class="jp-tchip jp-click"
      style={{ '--jp-c': taskColor(props.t.state) }}
      title={props.t.title}
      onClick={(e) => {
        e.stopPropagation();
        setJarvisPanelOpen(true);
      }}
    >
      <span class="jp-tchip-dot" />
      <span class="jp-tchip-text">{props.t.title.slice(0, 16)}</span>
    </button>
  );
}

/** PillButton (small): outlined pill with an icon tinted in its color and a white label. */
function PillButton(props: { label: string; icon: IconName; color: string; onClick: () => void }) {
  return (
    <button
      class="jp-pbtn jp-click"
      style={{ '--jp-c': props.color }}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    >
      <Icon name={props.icon} size={15} color={props.color} />
      <span>{props.label}</span>
    </button>
  );
}

/**
 * A list whose items animate in and out (AnimatedVisibility per item): items that left the source stay (closing) for the
 * exit animation, new ones are added closed and opened right after, so they expand in.
 */
function presence<T>(list: () => readonly T[], key: (t: T) => string) {
  interface Entry {
    key: string;
    item: Accessor<T>;
    setItem: (t: T) => void;
    open: Accessor<boolean>;
    setOpen: (v: boolean) => void;
  }
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const timers = new Map<string, number>();
  createEffect(() => {
    const src = list().slice();
    untrack(() => {
      const cur = entries();
      const have = new Map(cur.map((e) => [e.key, e]));
      const keys = new Set(src.map(key));
      const added: Entry[] = [];
      for (const it of src) {
        const k = key(it);
        const e = have.get(k);
        if (e) {
          e.setItem(it);
          if (!e.open()) {
            clearTimeout(timers.get(k));
            timers.delete(k);
            e.setOpen(true);
          }
          continue;
        }
        const [item, setItem] = createSignal<T>(it);
        const [open, setOpen] = createSignal(false);
        const ne: Entry = { key: k, item, setItem: (t) => setItem(() => t), open, setOpen };
        added.push(ne);
        // rendered closed first, then opened: it expands in
        queueMicrotask(() => ne.setOpen(true));
      }
      for (const e of cur) {
        if (keys.has(e.key) || !e.open()) continue;
        e.setOpen(false);
        timers.set(
          e.key,
          window.setTimeout(() => {
            timers.delete(e.key);
            setEntries((l) => l.filter((x) => x !== e));
          }, 480),
        );
      }
      if (added.length) setEntries([...cur, ...added]);
    });
  });
  onCleanup(() => timers.forEach((h) => clearTimeout(h)));
  return entries;
}

// ------------------------------------------------------------------------------------------------ overlay

export function JarvisOverlay() {
  const [now, setNow] = createSignal(Date.now());

  // a manager has something to show: its turn runs, it says what it does, or its last steps are still up
  const live = (m: JarvisManagerView) => m.phase !== 'idle' || !!m.status || m.steps.length > 0;
  // the Jarvis chat on screen when it is one, otherwise the one that is working
  const target = createMemo(() => {
    if (!jarvis.enabled) return undefined;
    const m = managerOf(state.chat.conversationId) ?? jarvis.managers.find((x) => x.phase !== 'idle') ?? jarvis.managers.find(live);
    return m && live(m) ? m : undefined;
  });
  // the last one stays drawn while the pill / card animate away
  let last: JarvisManagerView | undefined;
  const view = createMemo(() => {
    const m = target();
    if (m) last = m;
    return last;
  });

  // the pill opens into the activity card (tap the card to fold it back)
  const [expanded, setExpanded] = createSignal(false);
  createEffect(
    on(target, (m, prev) => {
      if (!m || (prev && prev.chatId !== m.chatId)) setExpanded(false);
    }),
  );

  // the last step counts as current for 6 s after it was set (StepsBlock)
  const tick = window.setInterval(() => {
    if (target()) setNow(Date.now());
  }, 1000);
  onCleanup(() => clearInterval(tick));

  const notices = presence(() => (jarvis.enabled ? jarvis.notices : []), (n) => n.id);

  return (
    <div class="jp-overlay">
      <For each={notices()}>
        {(e) => (
          <Collapse when={e.open()} class="jp-ov-item">
            <div class="jp-notice-gap">
              <NoticeChip n={e.item()} />
            </div>
          </Collapse>
        )}
      </For>
      <CardPresence when={!!target() && expanded()}>
        <Show when={view()}>{(m) => <ActivityCard m={m()} now={now()} onFold={() => setExpanded(false)} />}</Show>
      </CardPresence>
      <Collapse when={!!target() && !expanded()} class="jp-ov-item">
        <Show when={view()}>{(m) => <StatusPill m={m()} onOpen={() => setExpanded(true)} />}</Show>
      </Collapse>
    </div>
  );
}

/**
 * The card's AnimatedVisibility: in = fadeIn(tween 180) + scaleIn(tween 240, from 0.85) + expandVertically(tween 240),
 * out = fadeOut(tween 160) + scaleOut(tween 200, to 0.9) + shrinkVertically(tween 220).
 */
function CardPresence(props: ParentProps<{ when: boolean }>) {
  const [mounted, setMounted] = createSignal(props.when);
  const [st, setSt] = createSignal<'pre' | 'in' | 'out'>(props.when ? 'in' : 'pre');
  let timer: number | undefined;
  createEffect(
    on(
      () => props.when,
      (w) => {
        clearTimeout(timer);
        if (w) {
          setSt('pre');
          setMounted(true);
          nextFrame(() => props.when && setSt('in'));
        } else {
          setSt('out');
          timer = window.setTimeout(() => setMounted(false), 240);
        }
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  return (
    <Show when={mounted()}>
      <div class={'jp-card-pres ' + st()}>
        <div class="jp-card-clip">{props.children}</div>
      </div>
    </Show>
  );
}

/** StatusPill: the current step in a slim pill, Stop while the turn runs (tap: the activity card). */
function StatusPill(props: { m: JarvisManagerView; onOpen: () => void }) {
  const busy = () => props.m.phase !== 'idle';
  const accent = () => accentOf(props.m.phase);
  const text = () => props.m.steps[props.m.steps.length - 1]?.text ?? props.m.status ?? defaultLabel(props.m.phase);
  return (
    <div
      class="jp-pill jp-click"
      classList={{ busy: busy() }}
      style={{ '--jp-a': accent() }}
      title={props.m.title ?? undefined}
      onClick={(e) => {
        e.stopPropagation();
        props.onOpen();
      }}
    >
      <PulseDot color={accent()} working={busy()} />
      <Crossfade text={text()} ms={220} class="jp-pill-text" />
      <Show when={busy()}>
        <button
          class="jp-pill-stop jp-click"
          title="Stop"
          aria-label="Stop"
          onClick={(e) => {
            e.stopPropagation();
            jarvisAction('stopAll', { chatId: props.m.chatId });
          }}
        >
          <Icon name="stop" size={14} color={DANGER} />
        </button>
      </Show>
    </div>
  );
}

/** ActivityCard without waves / transcript / send meter: the steps, Stop, and up to 3 running tasks. */
function ActivityCard(props: { m: JarvisManagerView; now: number; onFold: () => void }) {
  let el: HTMLDivElement | undefined;
  // Brush.linearGradient runs from the top-left to the bottom-right corner: its CSS angle depends on the card's size
  const [angle, setAngle] = createSignal(135);
  onMount(() => {
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el && el.offsetWidth && el.offsetHeight) setAngle((Math.atan2(el.offsetWidth, -el.offsetHeight) * 180) / Math.PI);
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  const busy = () => props.m.phase !== 'idle';
  const liveTasks = () => tasksOf(props.m.chatId).filter((t) => t.active).slice(0, 3);
  return (
    <div
      ref={el}
      class="jp-card"
      style={{ '--jp-accent': accentOf(props.m.phase), '--jp-ang': `${angle()}deg` }}
      title={props.m.title ?? undefined}
      onClick={(e) => {
        e.stopPropagation();
        props.onFold();
      }}
    >
      <StepsBlock m={props.m} now={props.now} />
      <div class="jp-actions">
        <Show when={busy()}>
          <PillButton label="Stop" icon="stop" color={DANGER} onClick={() => jarvisAction('stopAll', { chatId: props.m.chatId })} />
        </Show>
        <button
          class="jp-round32 jp-click"
          title="Jarvis panel"
          aria-label="Jarvis panel"
          onClick={(e) => {
            e.stopPropagation();
            setJarvisPanelOpen(true);
          }}
        >
          <Icon name="open_in_full" size={16} />
        </button>
      </div>
      <Show when={liveTasks().length > 0}>
        <div class="jp-live">
          <For each={liveTasks()}>{(t) => <TaskChip t={t} />}</For>
        </div>
      </Show>
    </div>
  );
}

/** StepsBlock (small): the current step bright, the steps before it fading out below while the turn runs. */
function StepsBlock(props: { m: JarvisManagerView; now: number }) {
  const busy = () => props.m.phase !== 'idle';
  const text = () => {
    const l = props.m.steps[props.m.steps.length - 1];
    return l && (busy() || props.now - l.at < 6000) ? l.text : (props.m.status ?? defaultLabel(props.m.phase));
  };
  const previous = () => (busy() ? props.m.steps.slice(0, -1).slice(-3).reverse() : []);
  return (
    <div>
      <div class="jp-steps-head">
        <PulseDot color={accentOf(props.m.phase)} working={busy()} />
        <Crossfade text={text()} ms={260} class="jp-step-now" />
      </div>
      <For each={previous()}>
        {(s, i) => (
          <div class="jp-step-prev" style={{ color: `rgba(255, 255, 255, ${Math.max(0.15, 0.5 - i() * 0.14)})` }}>
            {'✓  ' + s.text}
          </div>
        )}
      </For>
    </div>
  );
}
