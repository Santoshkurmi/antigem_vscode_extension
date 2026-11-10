// Port of ui/jarvis/JarvisCommandCenter.kt (minus the Voice chip): the command strip above the input of a Jarvis chat
// (JarvisCommandStrip, ToggleChip, TaskPill) with its expandable Board, the news card in the feed (JarvisEventCard) and
// the welcome of a fresh Jarvis chat (JarvisChatWelcome). PulseDot / taskColor come from ui/jarvis/JarvisOverlay.kt.
// Sizes: 1dp = 1px; text = sp × var(--sp) (styles/jarvis.css). Colors are the app's fixed Jarvis colors.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, type ParentProps, Show } from 'solid-js';
import type { JarvisEventView } from '@shared/model';
import type { JarvisManagerView, JarvisTaskState, JarvisTaskView } from '@shared/protocol';
import { isJarvisChat, jarvis, jarvisAction, managerOf, tasksOf } from '../state/jarvis';
import { openSettings } from '../state/settings';
import { Icon, IconButton } from '../ui/primitives';
import { JarvisBot, JarvisBotBadge } from './JarvisBot';

// ui/jarvis/JarvisOverlay.kt
const CYAN = 'var(--jv-cyan)';
const VIOLET = 'var(--jv-violet)';
const GREEN = 'var(--jv-green)';
const AMBER = 'var(--jv-amber)';
const DANGER = 'var(--jv-danger)';
const ORANGE = 'var(--jv-orange)';
const GRAY = 'var(--jv-gray)';
/** onSurface.copy(alpha = a) */
const onSurface = (a: number) => `color-mix(in srgb, var(--on-surface) ${a * 100}%, transparent)`;

/** taskColor() */
function taskColor(s: JarvisTaskState): string {
  switch (s) {
    case 'starting':
      return CYAN;
    case 'running':
      return VIOLET;
    case 'waiting_approval':
    case 'asking':
      return AMBER;
    case 'no_progress':
      return ORANGE;
    case 'done':
      return GREEN;
    case 'failed':
      return DANGER;
    default:
      return GRAY;
  }
}

/** JarvisTasks.State.label */
const STATE_LABEL: Record<JarvisTaskState, string> = {
  starting: 'starting',
  running: 'running',
  waiting_approval: 'waiting for approval',
  asking: 'asking a question',
  no_progress: 'no progress',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

/** JarvisCommandCenter.kt agentLabel() (works for "CLAUDE" and the events' "claude"). */
function agentLabel(name: string): string {
  switch (name.toUpperCase()) {
    case 'AGY':
      return 'Antigravity';
    case 'OPENCODE':
      return 'OpenCode';
    case 'CODEX':
      return 'Codex';
    case 'CLAUDE':
      return 'Claude';
    default:
      return name;
  }
}

/** JarvisCommandCenter.kt age() */
function age(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const plural = (n: number) => (n === 1 ? '' : 's');

/** Enter / Space on a role="button" element. */
const onKeyPress = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  fn();
};

// Icons.Filled.Autorenew (not in the bundled set)
const AUTORENEW =
  'M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8A5.87 5.87 0 0 1 6 12c0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z';

/**
 * Modifier.animateContentSize(): the box follows its content's height on the default spring (StiffnessMediumLow) and
 * clips what does not fit yet. Content that goes away is gone at once; the space it took shrinks.
 */
function AnimatedSize(props: ParentProps) {
  let outer!: HTMLDivElement;
  let inner!: HTMLDivElement;
  onMount(() => {
    let target = inner.offsetHeight;
    let timer: number | undefined;
    const settle = () => {
      clearTimeout(timer);
      outer.style.height = '';
    };
    const ro = new ResizeObserver(() => {
      const h = inner.offsetHeight;
      if (h === target) return;
      // mid-animation: go on from where it is now; otherwise from the old size (layout already has the new one)
      const from = outer.style.height ? outer.getBoundingClientRect().height : target;
      target = h;
      outer.style.transition = 'none';
      outer.style.height = `${from}px`;
      void outer.offsetHeight;
      outer.style.transition = '';
      outer.style.height = `${h}px`;
      clearTimeout(timer);
      // hidden pages may never fire transitionend
      timer = window.setTimeout(settle, 600);
    });
    ro.observe(inner);
    const end = (e: TransitionEvent) => {
      if (e.target === outer && e.propertyName === 'height') settle();
    };
    outer.addEventListener('transitionend', end);
    onCleanup(() => {
      ro.disconnect();
      clearTimeout(timer);
      outer.removeEventListener('transitionend', end);
    });
  });
  return (
    <div ref={outer} class="jv-size">
      <div ref={inner}>{props.children}</div>
    </div>
  );
}

/** PulseDot: 10dp; pulses (700 ms, reversed) while the task works. The halo may spill out of its box, as in the app. */
function PulseDot(props: { color: string; working: boolean }) {
  return (
    <span class="jv-dot" classList={{ working: props.working }} style={{ '--c': props.color }}>
      <Show when={props.working}>
        <span class="jv-dot-halo" />
      </Show>
      <span class="jv-dot-core" />
    </span>
  );
}

/** IconMini: a 30dp round button with a 16dp icon (it never also taps the row / card it sits on). */
function IconMini(props: { icon: 'close' | 'stop' | 'open_in_new'; label: string; tint: string; onClick: () => void }) {
  return (
    <IconButton
      icon={props.icon}
      size={30}
      iconSize={16}
      color={props.tint}
      title={props.label}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    />
  );
}

// ------------------------------------------------------------------------------------------------ the command strip

/**
 * The command strip above the input of a Jarvis chat: the mission and its progress, what Jarvis is doing, its teams'
 * running tasks (tap one to open its chat), and the autopilot switch. Tap the head for the full board: every step,
 * team and task. Nothing shows for a chat that is not a Jarvis chat (or while Jarvis is off).
 */
export function JarvisCommandStrip(props: { chatId: string }) {
  const [expanded, setExpanded] = createSignal(false);
  // remember(chatId) { mutableStateOf(false) }
  createEffect(on(() => props.chatId, () => setExpanded(false), { defer: true }));

  const m = () => managerOf(props.chatId);
  const shown = () => jarvis.enabled && (!!m() || isJarvisChat(props.chatId));
  const mission = () => m()?.mission ?? null;
  const missionEmpty = () => {
    const mi = mission();
    return !mi || (!mi.goal.trim() && mi.steps.length === 0);
  };
  const missionStatus = () => mission()?.status ?? 'active';
  const autopilot = () => mission()?.autopilot ?? false;
  const steps = () => mission()?.steps ?? [];
  const mine = createMemo(() => tasksOf(props.chatId));
  const active = createMemo(() => mine().filter((t) => t.active));
  const status = () => m()?.status || null;

  const title = () => (missionEmpty() ? 'Jarvis command center' : (mission()?.goal ?? ''));
  const subtitle = () => {
    const s = status();
    if (s != null) return s;
    const a = active();
    if (a.some((t) => t.needsUser)) return 'A task needs a decision';
    if (a.length) return `${a.length} task${plural(a.length)} working · news comes in by itself`;
    if (missionStatus() === 'done') return 'Mission complete';
    if (missionStatus() === 'paused') return 'Mission paused';
    if (missionEmpty()) return 'Give me a big job: I plan it, run it with teams and keep going.';
    if (autopilot()) return 'Autopilot on · keeps going until done';
    return 'Waiting for you';
  };
  const toggle = () => setExpanded(!expanded());
  const openTask = (id: string) => jarvisAction('openTask', { taskId: id });
  // JarvisController.requestSettings("JARVIS_SETUP"): Settings → Jarvis → Setup
  const openSetup = () => openSettings({ id: 'jarvis', title: 'Jarvis' }, [{ id: 'jarvis.setup', title: 'Setup' }]);

  return (
    <Show when={shown()}>
      <div class="jv-strip-wrap">
        <div class="jv-strip">
          <AnimatedSize>
            <div
              class="jv-head"
              role="button"
              tabIndex={0}
              aria-expanded={expanded()}
              onClick={toggle}
              onKeyDown={onKeyPress(toggle)}
            >
              <JarvisBot size={28} active={active().length > 0 || status() != null} />
              <div class="jv-head-texts">
                <div class="jv-title">{title()}</div>
                <div class="jv-sub">{subtitle()}</div>
              </div>
              <Show when={steps().length > 0}>
                <span class="jv-count">
                  {mission()?.doneCount ?? 0}/{steps().length}
                </span>
              </Show>
              <Icon
                name={expanded() ? 'expand_less' : 'expand_more'}
                size={24}
                color={onSurface(0.6)}
                title={expanded() ? 'Hide the board' : 'Show the board'}
              />
            </div>
            <Show when={steps().length > 0}>
              <div class="jv-progress">
                <div
                  class="jv-progress-fill"
                  style={{
                    width: `${Math.min(1, (mission()?.doneCount ?? 0) / steps().length) * 100}%`,
                    background: missionStatus() === 'done' ? GREEN : CYAN,
                  }}
                />
              </div>
            </Show>
            <div class="jv-chips">
              <Show when={!missionEmpty()}>
                <ToggleChip
                  label={autopilot() ? 'Autopilot on' : 'Autopilot'}
                  on={autopilot()}
                  onClick={() => jarvisAction('setAutopilot', { chatId: props.chatId, on: !autopilot() })}
                />
              </Show>
              <For each={active()}>{(t) => <TaskPill task={t} onClick={() => openTask(t.id)} />}</For>
              <Show when={active().length === 0 && mine().length > 0}>
                <span class="jv-finished">
                  {mine().length} finished task{plural(mine().length)}
                </span>
              </Show>
            </div>
            <Show when={m()?.toolsMissing}>
              {/* the chat's agent answered that it has no jarvis_mcp tools */}
              <div class="jv-hint" role="button" tabIndex={0} onClick={openSetup} onKeyDown={onKeyPress(openSetup)}>
                This chat's agent has no Jarvis tools yet. Tap to add the Jarvis MCP server (Settings → Jarvis → Setup).
              </div>
            </Show>
            <Show when={expanded()}>
              <Board chatId={props.chatId} manager={m()} mine={mine()} onOpen={openTask} />
            </Show>
          </AnimatedSize>
        </div>
      </div>
    </Show>
  );
}

function ToggleChip(props: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button class="jv-toggle" classList={{ on: props.on }} aria-pressed={props.on} onClick={() => props.onClick()}>
      <svg class="jv-toggle-icon" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
        <path d={AUTORENEW} />
      </svg>
      <span>{props.label}</span>
    </button>
  );
}

function TaskPill(props: { task: JarvisTaskView; onClick: () => void }) {
  const c = () => taskColor(props.task.state);
  return (
    <button class="jv-pill" style={{ '--c': c() }} title={props.task.title} onClick={() => props.onClick()}>
      <PulseDot color={c()} working={props.task.state === 'running' || props.task.state === 'starting'} />
      <span class="jv-pill-text">{(props.task.team.trim() ? `${props.task.team} · ` : '') + props.task.title.slice(0, 22)}</span>
    </button>
  );
}

// ------------------------------------------------------------------------------------------------ the board

/** Everything of one manager: mission steps, teams, tasks. */
function Board(props: { chatId: string; manager: JarvisManagerView | undefined; mine: JarvisTaskView[]; onOpen: (id: string) => void }) {
  const mi = () => props.manager?.mission ?? null;
  const empty = () => {
    const x = mi();
    return !x || (!x.goal.trim() && x.steps.length === 0);
  };
  const teams = () => props.manager?.teams ?? [];
  const chatId = () => props.chatId;
  return (
    <div class="jv-board">
      <BoardTitle text="Mission" />
      <Show
        when={!empty()}
        fallback={
          <div class="jv-board-empty">
            No mission yet. Ask for something big ("build the settings screen, test it and don't stop until it works"): Jarvis writes the plan here and works through it.
          </div>
        }
      >
        <Show when={mi()?.doneWhen.trim()}>
          <div class="jv-done-when">Done when: {mi()?.doneWhen}</div>
        </Show>
        <For each={mi()?.steps ?? []}>
          {(s) => {
            const mark = () =>
              s.status === 'done'
                ? { t: '✓', c: GREEN }
                : s.status === 'doing'
                  ? { t: '▶', c: CYAN }
                  : s.status === 'blocked'
                    ? { t: '!', c: DANGER }
                    : { t: '○', c: onSurface(0.4) };
            return (
              <div class="jv-step">
                <span class="jv-step-mark" style={{ color: mark().c }}>
                  {mark().t}
                </span>
                <div class="jv-step-body">
                  <div class="jv-step-text" style={{ color: onSurface(s.status === 'done' ? 0.55 : 0.9) }}>
                    {s.n}. {s.text}
                  </div>
                  <Show when={s.note.trim()}>
                    <div class="jv-step-note">{s.note}</div>
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
        <Show when={mi()?.notes.trim()}>
          <div class="jv-notes">Notes: {mi()?.notes}</div>
        </Show>
        <div class="jv-actions">
          <SmallAction label="Clear mission" color={DANGER} onClick={() => jarvisAction('clearMission', { chatId: chatId() })} />
          <Show when={(mi()?.status ?? 'active') !== 'active'} fallback={<SmallAction label="Pause" color={AMBER} onClick={() => jarvisAction('pauseMission', { chatId: chatId() })} />}>
            <SmallAction label="Resume" color={CYAN} onClick={() => jarvisAction('resumeMission', { chatId: chatId() })} />
          </Show>
        </div>
      </Show>
      <Show when={teams().length > 0}>
        <BoardTitle text="Teams" />
        <For each={teams()}>
          {(t) => {
            const running = () => props.mine.filter((k) => k.active && k.team.toLowerCase() === t.name.toLowerCase()).length;
            return (
              <div class="jv-team">
                <div class="jv-team-body">
                  <div class="jv-team-name">
                    {t.name} · {agentLabel(t.agent)}
                    {t.model.trim() ? ` · ${t.model}` : ''}
                  </div>
                  <Show when={t.role.trim()}>
                    <div class="jv-team-role">{t.role}</div>
                  </Show>
                </div>
                <Show when={running() > 0}>
                  <span class="jv-team-running">{running()} working</span>
                </Show>
                <IconMini icon="close" label="Remove team" tint={onSurface(0.45)} onClick={() => jarvisAction('removeTeam', { chatId: chatId(), teamName: t.name })} />
              </div>
            );
          }}
        </For>
      </Show>
      <BoardTitle text="Tasks" />
      <Show when={props.mine.length === 0}>
        <div class="jv-none">None yet.</div>
      </Show>
      <For each={props.mine.slice(0, 20)}>
        {(t) => {
          const c = () => taskColor(t.state);
          const meta = () =>
            [t.team.trim() ? t.team : null, agentLabel(t.agent), t.stateLabel || STATE_LABEL[t.state], age(t.createdAt), t.note.trim() && t.note !== 'Working' ? t.note : null]
              .filter((x) => x != null)
              .join(' · ');
          const open = () => props.onOpen(t.id);
          return (
            <div class="jv-task" role="button" tabIndex={0} onClick={open} onKeyDown={onKeyPress(open)}>
              <span class="jv-task-dot" style={{ background: c() }} />
              <div class="jv-task-body">
                <div class="jv-task-title">{t.title}</div>
                <div class="jv-task-meta" style={{ color: `color-mix(in srgb, ${c()} 90%, transparent)` }}>
                  {meta()}
                </div>
              </div>
              <IconMini icon="open_in_new" label="Open" tint={onSurface(0.6)} onClick={open} />
              <Show
                when={t.active}
                fallback={<IconMini icon="close" label="Dismiss" tint={onSurface(0.45)} onClick={() => jarvisAction('dismissTask', { taskId: t.id })} />}
              >
                <IconMini icon="stop" label="Stop" tint={DANGER} onClick={() => jarvisAction('stopTask', { taskId: t.id })} />
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

function BoardTitle(props: { text: string }) {
  return <div class="jv-board-title">{props.text.toUpperCase()}</div>;
}

function SmallAction(props: { label: string; color: string; onClick: () => void }) {
  return (
    <button class="jv-small-action" style={{ '--c': props.color }} onClick={() => props.onClick()}>
      {props.label}
    </button>
  );
}

// ------------------------------------------------------------------------------------------------ the event card

/** eventColor() */
function eventColor(kind: string): string {
  switch (kind) {
    case 'task_done':
      return GREEN;
    case 'task_failed':
      return DANGER;
    case 'task_stalled':
      return ORANGE;
    case 'task_approval':
    case 'task_question':
    case 'autopilot_paused':
      return AMBER;
    case 'nudge':
      return VIOLET;
    default:
      return CYAN;
  }
}

/** eventWord() */
function eventWord(kind: string): string {
  switch (kind) {
    case 'task_done':
      return 'Finished';
    case 'task_failed':
      return 'Failed';
    case 'task_stalled':
      return 'No progress';
    case 'task_approval':
      return 'Needs approval';
    case 'task_question':
      return 'Asks a question';
    case 'nudge':
      return 'Autopilot: keep going';
    case 'autopilot_paused':
      return 'Autopilot paused';
    default:
      return kind;
  }
}

/**
 * The news Jarvis got from its teams, as it shows in the chat (in place of the user bubble): one row per event (who,
 * what happened), and on tap what each sub-agent reported. `content` is the message's one-line label (not shown; a new
 * label folds the reports again, like remember(raw)).
 */
export function JarvisEventCard(props: { content: string; events: JarvisEventView[] }) {
  const [open, setOpen] = createSignal(false);
  createEffect(on(() => props.content, () => setOpen(false), { defer: true }));
  const hasDetails = () => props.events.some((e) => e.text.trim() !== '');
  const toggle = () => {
    if (!hasDetails()) return;
    // a click that selected report text is not a tap
    if (window.getSelection()?.toString()) return;
    setOpen(!open());
  };
  return (
    <Show when={props.events.length > 0}>
      <div class="jv-ev-wrap">
        <div
          class="jv-ev"
          classList={{ clickable: hasDetails() }}
          role={hasDetails() ? 'button' : undefined}
          tabIndex={hasDetails() ? 0 : undefined}
          aria-expanded={hasDetails() ? open() : undefined}
          onClick={toggle}
          onKeyDown={onKeyPress(toggle)}
        >
          <AnimatedSize>
            <div class="jv-ev-head">
              <JarvisBot size={18} />
              <span class="jv-ev-head-title">{props.events.length === 1 ? 'Team update' : `${props.events.length} team updates`}</span>
              <Show when={hasDetails()}>
                <span class="jv-ev-toggle">{open() ? 'Hide reports' : 'Show reports'}</span>
              </Show>
            </div>
            <For each={props.events}>
              {(e) => {
                const c = () => eventColor(e.kind);
                const who = () => {
                  const extra = [e.team.trim() ? e.team : null, e.agent.trim() ? agentLabel(e.agent) : null].filter((x) => x != null).join(' · ');
                  return (e.title.trim() ? e.title : 'Mission') + (extra.trim() ? `  ·  ${extra}` : '');
                };
                const listed = () => !!e.taskId.trim() && jarvis.tasks.some((t) => t.id === e.taskId);
                return (
                  <div class="jv-ev-row">
                    <span class="jv-ev-dot" style={{ background: c() }} />
                    <div class="jv-ev-body">
                      <div class="jv-ev-title">{who()}</div>
                      <div class="jv-ev-word" style={{ color: c() }}>
                        {eventWord(e.kind)}
                      </div>
                      <Show when={open() && e.text.trim()}>
                        <div class="jv-ev-text">{e.text.slice(0, 4000)}</div>
                      </Show>
                    </div>
                    <Show when={listed()}>
                      <IconMini icon="open_in_new" label="Open the task's chat" tint={onSurface(0.55)} onClick={() => jarvisAction('openTask', { taskId: e.taskId })} />
                    </Show>
                  </div>
                );
              }}
            </For>
          </AnimatedSize>
        </div>
      </div>
    </Show>
  );
}

// ------------------------------------------------------------------------------------------------ a fresh Jarvis chat

const STARTERS = [
  "Build a dark-mode toggle in the settings screen of my active project, have a reviewer team check it and run the tests. Don't stop until it works.",
  'Create two teams: builders (Claude) to implement and reviewers (Antigravity) to review and test. Then fix all failing tests in this project.',
  'Investigate why the app is slow to start, try the three most promising fixes in parallel and tell me which one wins.',
];

/** What a new Jarvis chat shows before the first message: what it does, and a few starters (the app puts one in the input to edit). */
export function JarvisChatWelcome(props: { onStarter: (text: string) => void }) {
  return (
    <div class="jv-welcome">
      <JarvisBotBadge size={72} active />
      <div class="jv-welcome-title">Jarvis command center</div>
      <div class="jv-welcome-desc">
        Give me a big job. I write the plan, put together teams of agents, hand out the work in parallel, check what comes back and keep going until it's done.
      </div>
      <For each={STARTERS}>
        {(ex) => (
          <button class="jv-starter" onClick={() => props.onStarter(ex)}>
            {ex}
          </button>
        )}
      </For>
    </div>
  );
}
