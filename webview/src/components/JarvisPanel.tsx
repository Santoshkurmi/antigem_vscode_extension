// The Jarvis panel (ui/jarvis/JarvisPanel.kt) without its voice parts (quick switches, quick settings, the typing box,
// talk / new session): Jarvis' face and what it does, the notices, every task with open / stop / dismiss and
// "Clear finished", the log (newest last, with day / time dividers and one where a new Jarvis chat began), and the
// shortcuts New Jarvis chat · Jarvis settings · Stop all. A sheet from the bottom over a 50% black scrim.
import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { JarvisTaskView } from '@shared/protocol';
import { jarvis, jarvisAction, jarvisPanelOpen, managerOf, setJarvisPanelOpen } from '../state/jarvis';
import { state } from '../state/store';
import { openSettings } from '../state/settings';
import { Icon, type IconName, nextFrame } from '../ui/primitives';
import { agentChipLabel, agentLabel, dayKey, dayLabel } from '../util/format';
import { accentOf, CYAN, DANGER, type JarvisPhase, NoticeChip, taskColor, VIOLET } from './JarvisOverlay';

export function JarvisPanel() {
  const close = () => setJarvisPanelOpen(false);
  const [mounted, setMounted] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  let timer: number | undefined;
  createEffect(
    on(jarvisPanelOpen, (o) => {
      clearTimeout(timer);
      if (o) {
        setMounted(true);
        nextFrame(() => jarvisPanelOpen() && setShown(true));
      } else {
        setShown(false);
        timer = window.setTimeout(() => setMounted(false), 320);
      }
    }),
  );
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !jarvisPanelOpen()) return;
    e.stopPropagation();
    e.preventDefault();
    close();
  };
  onMount(() => document.addEventListener('keydown', onKey, true));
  onCleanup(() => {
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(timer);
  });
  return (
    <Show when={mounted()}>
      <Portal>
        <div
          class="jp-panel"
          classList={{ shown: shown() }}
          // Solid passes events from a Portal on to its parent in the component tree
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
        >
          <div class="jp-scrim" />
          {/* taps inside the sheet stay inside */}
          <div class="jp-sheet" role="dialog" aria-label="Jarvis" onClick={(e) => e.stopPropagation()}>
            <PanelBody close={close} />
          </div>
        </div>
      </Portal>
    </Show>
  );
}

type LogRow = { divider: boolean; text: string };

/** "Nov 10, 15:45" (the app's "MMM d, HH:mm" on its new-session divider). */
function stamp(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date}, ${time}`;
}

/** A day / time divider before the first line, a new day, or a line after an hour of quiet (like the chat feed). */
const GAP_DIVIDER_MS = 60 * 60 * 1000;

function PanelBody(props: { close: () => void }) {
  // task ages ("5m") stay fresh while the panel is open
  const [now, setNow] = createSignal(Date.now());
  const tick = window.setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(tick));

  // the Jarvis chat on screen when its turn runs, otherwise any that works
  const busy = createMemo(() => {
    const s = managerOf(state.chat.conversationId);
    return s && s.phase !== 'idle' ? s : jarvis.managers.find((m) => m.phase !== 'idle');
  });
  const sub = () => {
    const b = busy();
    if (b) return b.steps[b.steps.length - 1]?.text ?? b.status ?? 'Working';
    if (!jarvis.enabled) return 'Off · turn it on in Settings → Jarvis';
    return jarvis.agent ? `Ready · runs on ${agentLabel(jarvis.agent)}` : 'Ready';
  };
  const activeCount = () => jarvis.tasks.filter((t) => t.active).length;

  const rows = createMemo(() => {
    const out: LogRow[] = [];
    let prev = 0;
    for (const e of jarvis.log) {
      // where a new Jarvis chat began (the app's LOG_DIVIDER line)
      if (e.kind === 'chat') out.push({ divider: true, text: `${e.text} · ${stamp(e.at)}` });
      else {
        if (!prev || dayKey(prev) !== dayKey(e.at) || e.at - prev >= GAP_DIVIDER_MS) out.push({ divider: true, text: dayLabel(e.at) });
        out.push({ divider: false, text: e.text });
      }
      prev = e.at;
    }
    return out;
  });

  // the list ends with the newest line: open there, and follow new lines (the log is capped: watch its newest line too)
  let list: HTMLDivElement | undefined;
  createEffect(
    on(
      () => [jarvis.log.length, jarvis.log[jarvis.log.length - 1]?.at],
      () =>
        requestAnimationFrame(() => {
          if (list) list.scrollTop = list.scrollHeight;
        }),
    ),
  );

  return (
    <>
      <div class="jp-handle" />

      {/* ---- header */}
      <div class="jp-head">
        <HeaderOrb phase={busy()?.phase ?? null} tasks={activeCount()} />
        <div class="jp-head-text">
          <div class="jp-title">Jarvis</div>
          <div class="jp-sub">{sub()}</div>
        </div>
        <RoundIcon icon="close" label="Close" color="rgba(255, 255, 255, 0.7)" onClick={props.close} />
      </div>

      <Show when={jarvis.notices.length > 0}>
        <div class="jp-notices">
          <For each={jarvis.notices}>{(n) => <NoticeChip n={n} />}</For>
        </div>
      </Show>

      {/* ---- tasks and the log */}
      <div ref={list} class="jp-list">
        <Show when={jarvis.tasks.length > 0}>
          <div class="jp-sec-row">
            <div class="jp-sec">Tasks</div>
            <Show when={jarvis.tasks.some((t) => !t.active)}>
              <button class="jp-link jp-click" onClick={() => jarvisAction('clearFinished')}>
                Clear finished
              </button>
            </Show>
          </div>
          <For each={jarvis.tasks}>{(t) => <TaskRow t={t} now={now()} close={props.close} />}</For>
        </Show>
        <div classList={{ 'jp-conv-gap': jarvis.tasks.length > 0 }}>
          <div class="jp-sec-row">
            <div class="jp-sec">Activity</div>
            <Show when={jarvis.log.length > 0}>
              <button class="jp-link dim jp-click" onClick={() => jarvisAction('clearLog')}>
                Clear
              </button>
            </Show>
          </div>
          <Show when={jarvis.log.length === 0}>
            <div class="jp-empty">
              Nothing yet. Open a Jarvis chat and give it a job: it plans, starts tasks in other chats, checks what they did and
              keeps going. What it does shows up here.
            </div>
          </Show>
        </div>
        <Index each={rows()}>
          {(r) => (
            <Show
              when={r().divider}
              fallback={
                <div class="jp-bubble-row">
                  <div class="jp-bubble">{r().text}</div>
                </div>
              }
            >
              <div class="jp-divider">
                <span class="jp-divider-line" />
                <span class="jp-divider-text">{r().text}</span>
                <span class="jp-divider-line" />
              </div>
            </Show>
          )}
        </Index>
        <div class="jp-list-end" />
      </div>

      {/* ---- shortcuts */}
      <div class="jp-footer">
        <FooterButton
          label="New Jarvis chat"
          onClick={() => {
            props.close();
            jarvisAction('newChat');
          }}
        />
        <FooterButton
          label="Jarvis settings"
          onClick={() => {
            props.close();
            openSettings({ id: 'jarvis', title: 'Jarvis' });
          }}
        />
        <FooterButton label="Stop all" color={DANGER} onClick={() => jarvisAction('stopAll')} />
      </div>
    </>
  );
}

/** TaskRow: dot, title, "team · agent · state · age · note", Open and Stop (running) or Dismiss (finished). */
function TaskRow(props: { t: JarvisTaskView; now: number; close: () => void }) {
  const open = () => {
    props.close();
    jarvisAction('openTask', { taskId: props.t.id });
  };
  const age = () => {
    const m = Math.floor((props.now - props.t.createdAt) / 60_000);
    return m < 1 ? 'just now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };
  const meta = () =>
    [
      props.t.team.trim() ? props.t.team : null,
      agentChipLabel(props.t.agent),
      props.t.stateLabel,
      age(),
      props.t.note.trim() && props.t.note !== 'Working' ? props.t.note : null,
    ]
      .filter((x) => !!x)
      .join(' · ');
  return (
    <div class="jp-task jp-click" style={{ '--jp-c': taskColor(props.t.state) }} onClick={open}>
      <span class="jp-task-dot" />
      <div class="jp-task-body">
        <div class="jp-task-title">{props.t.title}</div>
        <div class="jp-task-meta">{meta()}</div>
      </div>
      <RoundIcon icon="open_in_new" label="Open" color="rgba(255, 255, 255, 0.7)" small onClick={open} />
      <Show
        when={props.t.active}
        fallback={
          <RoundIcon
            icon="close"
            label="Dismiss"
            color="rgba(255, 255, 255, 0.5)"
            small
            onClick={() => jarvisAction('dismissTask', { taskId: props.t.id })}
          />
        }
      >
        <RoundIcon icon="stop" label="Stop" color={DANGER} small onClick={() => jarvisAction('stopTask', { taskId: props.t.id })} />
      </Show>
    </div>
  );
}

/** RoundIcon: a 44dp (small: 34dp) round icon button. */
function RoundIcon(props: { icon: IconName; label: string; color: string; small?: boolean; onClick: () => void }) {
  return (
    <button
      class="jp-ricon jp-click"
      classList={{ small: props.small }}
      title={props.label}
      aria-label={props.label}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    >
      <Icon name={props.icon} size={props.small ? 18 : 22} color={props.color} />
    </button>
  );
}

function FooterButton(props: { label: string; color?: string; onClick: () => void }) {
  return (
    <button class="jp-fbtn jp-click" style={{ '--jp-c': props.color ?? CYAN }} onClick={props.onClick}>
      {props.label}
    </button>
  );
}

// ------------------------------------------------------------------------------------------------ Jarvis' face (42dp)

let orbSeq = 0;

/** An arc like DrawScope.drawArc: degrees from 3 o'clock, clockwise. */
function arcPath(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number): string {
  const a0 = (startDeg * Math.PI) / 180;
  const a1 = ((startDeg + sweepDeg) * Math.PI) / 180;
  const f = (n: number) => n.toFixed(3);
  return `M ${f(cx + r * Math.cos(a0))} ${f(cy + r * Math.sin(a0))} A ${r} ${r} 0 ${sweepDeg > 180 ? 1 : 0} 1 ${f(cx + r * Math.cos(a1))} ${f(cy + r * Math.sin(a1))}`;
}

/**
 * The panel header's face: IdleOrb (glass disc, cyan ring, the bot, a violet arc per running task) while every Jarvis
 * chat waits; JarvisOrb (breathing halo, ring and bot in the phase's color, glancing eyes, a spinning white arc) while
 * one works.
 */
function HeaderOrb(props: { phase: JarvisPhase | null; tasks: number }) {
  const uid = `jp-orb-${++orbSeq}`;
  const R = 21;
  const working = () => !!props.phase && props.phase !== 'idle';
  const accent = () => accentOf(props.phase ?? 'idle');
  const arcs = () => {
    const n = Math.min(props.tasks, 4);
    if (n <= 0) return [];
    const sweep = 360 / n - 14;
    return Array.from({ length: n }, (_, i) => arcPath(R, R, R * 0.92, -90 + i * (sweep + 14) + 7, sweep));
  };
  return (
    <svg class="jp-orb" width="42" height="42" viewBox="0 0 42 42" aria-hidden="true">
      <Show
        when={working()}
        fallback={
          <>
            <defs>
              <radialGradient id={`${uid}-g`} gradientUnits="userSpaceOnUse" cx={R} cy={R} r={R}>
                <stop offset="0" stop-color="rgba(24, 38, 64, 0.941)" />
                <stop offset="1" stop-color="rgba(10, 15, 28, 0.941)" />
              </radialGradient>
            </defs>
            <circle cx={R} cy={R + R * 0.08} r={R} fill="rgba(0, 0, 0, 0.28)" />
            <circle cx={R} cy={R} r={R * 0.96} fill={`url(#${uid}-g)`} />
            <circle cx={R} cy={R} r={R * 0.92} fill="none" stroke={CYAN} stroke-opacity="0.5" stroke-width={R * 0.06} />
            <BotFace cx={R} cy={R} box={R * 1.32} color={CYAN} />
            <For each={arcs()}>
              {(d) => <path d={d} fill="none" stroke={VIOLET} stroke-width={R * 0.1} stroke-linecap="round" />}
            </For>
          </>
        }
      >
        <defs>
          <clipPath id={`${uid}-c`}>
            <circle cx={R} cy={R} r={R} />
          </clipPath>
        </defs>
        <circle cx={R} cy={R} r={R} fill="rgba(10, 15, 28, 0.902)" />
        <g clip-path={`url(#${uid}-c)`} fill={accent()}>
          <circle class="jp-breathe" cx={R} cy={R} r={R * 0.74} fill-opacity="0.15" />
          <circle class="jp-breathe" cx={R} cy={R} r={R * 0.86} fill-opacity="0.1" />
          <circle class="jp-breathe" cx={R} cy={R} r={R * 0.98} fill-opacity="0.05" />
        </g>
        <circle cx={R} cy={R} r={R * 0.93} fill="none" stroke={accent()} stroke-opacity="0.55" stroke-width={R * 0.05} />
        <BotFace cx={R} cy={R} box={R * 1.3} color={accent()} look />
        <circle
          class="jp-orb-spin"
          cx={R}
          cy={R}
          r={R * 0.86}
          fill="none"
          stroke="#fff"
          stroke-opacity="0.9"
          stroke-width={R * 0.07}
          stroke-linecap="round"
          stroke-dasharray={`${((2 * Math.PI * R * 0.86 * 110) / 360).toFixed(3)} 200`}
        />
      </Show>
    </svg>
  );
}

/**
 * drawJarvisBot (JarvisBot.kt) in a 100-unit box: antenna with a glowing tip, ears, head, visor, two eyes with a
 * highlight, a mouth line. `look`: the eyes glance from side to side (thinking).
 */
function BotFace(props: { cx: number; cy: number; box: number; color: string; look?: boolean }) {
  const eyes = [50 - 13.3, 50 + 13.3];
  return (
    <g transform={`translate(${props.cx - props.box / 2} ${props.cy - props.box / 2}) scale(${props.box / 100})`} fill={props.color} stroke={props.color}>
      <line x1="50" y1="31" x2="50" y2="19" stroke-opacity="0.9" stroke-width="5.5" stroke-linecap="round" />
      <circle cx="50" cy="14" r="10" fill-opacity="0.28" stroke="none" />
      <circle cx="50" cy="14" r="5.5" stroke="none" />
      <rect x="8.625" y="45.56" width="7.5" height="22.88" rx="3.75" fill-opacity="0.85" stroke="none" />
      <rect x="83.875" y="45.56" width="7.5" height="22.88" rx="3.75" fill-opacity="0.85" stroke="none" />
      <rect x="15" y="31" width="70" height="52" rx="18.72" fill-opacity="0.16" stroke-width="5.5" />
      <rect x="23.5" y="39.5" width="53" height="35" rx="13.62" fill="#07101C" fill-opacity="0.9" stroke="none" />
      <g class={props.look ? 'jp-bot-look' : undefined} stroke="none">
        <For each={eyes}>
          {(cx) => (
            <>
              <circle cx={cx} cy="53.88" r="12.075" fill-opacity="0.22" />
              <rect x={cx - 5.25} y="46.38" width="10.5" height="15" rx="5.25" />
              <circle cx={cx - 1.26} cy="50.88" r="2.1" fill="#fff" fill-opacity="0.85" />
            </>
          )}
        </For>
      </g>
      <line x1="40.9" y1="69.48" x2="59.1" y2="69.48" stroke-opacity="0.8" stroke-width="4.4" stroke-linecap="round" />
    </g>
  );
}
