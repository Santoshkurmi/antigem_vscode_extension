// Mission Control (docs/crew/PLAN.md §16): every job tree the crew runs, live. A tree starts where you asked a bot (its
// DM, a room); under it the jobs it handed out, who asked whom, status, a live timer, what each did (observed from its
// tool calls), cost, and the tree's budgets. A job opens to its brief, question (answer it here), result, evidence
// and artifacts; Stop / Retry / Open its chat.
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import type { JobTreeView, JobView } from '@shared/protocol';
import { jobAction, jobs, setMcOpen } from '../state/jobs';
import { Icon, IconButton } from '../ui/primitives';
import { Avatar } from './Groups';
import { InboxDock } from './Inbox';
import { MarkdownContent } from './Markdown';
import { relativeTime } from '../util/format';

const STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: 'queued', tone: 'idle' },
  running: { label: 'working', tone: 'run' },
  resume: { label: 'reading reports', tone: 'run' },
  waiting: { label: 'waiting on team', tone: 'wait' },
  needs_input: { label: 'needs an answer', tone: 'ask' },
  done: { label: 'done', tone: 'ok' },
  failed: { label: 'failed', tone: 'bad' },
  cancelled: { label: 'stopped', tone: 'idle' },
};
const LIVE = new Set(['queued', 'running', 'resume', 'waiting', 'needs_input']);

/** A clock that ticks every second while something runs. */
function useNow() {
  const [now, setNow] = createSignal(Date.now());
  const t = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(t));
  return now;
}

function took(j: JobView, now: number): string {
  if (!j.startedAt) return '';
  const ms = (j.endedAt ?? now) - j.startedAt;
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const tokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function MissionControl() {
  const now = useNow();
  const [bot, setBot] = createSignal('');
  const [liveOnly, setLiveOnly] = createSignal(false);
  const names = createMemo(() => [...new Set(jobs.trees.flatMap((t) => [t.root, ...t.jobs].map((j) => j.bot?.name).filter((x): x is string => !!x)))].sort());
  const trees = createMemo(() =>
    jobs.trees.filter((t) => {
      const all = [t.root, ...t.jobs];
      if (liveOnly() && !all.some((j) => LIVE.has(j.status))) return false;
      return !bot() || all.some((j) => j.bot?.name === bot());
    }),
  );
  const sub = () => {
    const c = jobs.counts;
    const parts = [c.working && `${c.working} working`, c.waiting && `${c.waiting} waiting`, c.needsYou && `${c.needsYou} need${c.needsYou === 1 ? 's' : ''} an answer`].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'Who asked whom, what they did, what it cost';
  };
  return (
    <div class="gc-page">
      <div class="gc-bar">
        <IconButton icon="arrow_back" title="Crew" size={36} iconSize={20} onClick={() => setMcOpen(false)} />
        <div class="gc-bar-title">
          <div class="gc-bar-text">
            <div class="gc-title">Mission Control</div>
            <div class="gc-sub">{sub()}</div>
          </div>
        </div>
      </div>
      <div class="mc-filters">
        <select class="gc-input mc-select" value={bot()} onChange={(e) => setBot(e.currentTarget.value)}>
          <option value="">Every bot</option>
          <For each={names()}>{(n) => <option value={n}>{n}</option>}</For>
        </select>
        <label class="gc-check">
          <input type="checkbox" checked={liveOnly()} onChange={(e) => setLiveOnly(e.currentTarget.checked)} /> Live only
        </label>
      </div>
      <div class="gc-list mc-list">
        <InboxDock max={2} />
        <Show when={trees().length} fallback={<Empty />}>
          <For each={trees()}>{(t) => <Tree tree={t} now={now()} />}</For>
        </Show>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div class="gc-empty">
      <div class="gc-empty-art">🧭 → 🛠️🧪</div>
      <div class="gc-empty-title">{jobs.loaded ? 'No jobs yet' : 'Loading…'}</div>
      <div class="gc-empty-text">
        Ask one bot for something bigger, in its chat or a room, for example <i>"Plan, build and test a todo app with Ada, Pip and Tess"</i>. It hands the parts out
        (crew_assign), each teammate works in its own thread, and when all are back it gets one message with every report and answers you once, with the evidence.
        Every step shows up here.
      </div>
    </div>
  );
}

function Tree(props: { tree: JobTreeView; now: number }) {
  const t = () => props.tree;
  const live = () => [t().root, ...t().jobs].some((j) => LIVE.has(j.status));
  const cost = () => [t().root, ...t().jobs].reduce((n, j) => n + (j.usage.costUsd ?? 0), 0);
  const from = () => (t().origin.kind === 'room' ? `#${t().origin.roomName ?? 'room'}` : 'You');
  return (
    <div class="mc-tree" classList={{ live: live() }}>
      <div class="mc-tree-head">
        <span class="mc-origin">
          {from()} → {t().root.bot?.emoji} {t().root.bot?.name ?? '?'}
        </span>
        <span class="gc-row-time">{relativeTime(t().root.createdAt)}</span>
      </div>
      <Show when={t().origin.quote}>
        <div class="mc-quote">“{t().origin.quote.slice(0, 220)}”</div>
      </Show>
      <Node job={t().root} now={props.now} root />
      <For each={t().jobs}>{(j) => <Node job={j} now={props.now} />}</For>
      <div class="mc-budget" title="Loop protection: limits for this task since it started">
        <Meter label="jobs" n={t().budget.requests} max={t().budget.limits.requests} />
        <Meter label="turns" n={t().budget.runs} max={t().budget.limits.runs} />
        <Meter label="report rounds" n={t().budget.wakes} max={t().budget.limits.wakes} />
        <Show when={cost() > 0}>
          <span class="mc-cost">${cost().toFixed(3)}</span>
        </Show>
      </div>
    </div>
  );
}

function Meter(props: { label: string; n: number; max: number }) {
  const pct = () => Math.min(100, Math.round((props.n / Math.max(1, props.max)) * 100));
  return (
    <span class="mc-meter" classList={{ high: pct() >= 75 }}>
      <span class="mc-meter-bar">
        <span style={{ width: `${pct()}%` }} />
      </span>
      {props.n}/{props.max} {props.label}
    </span>
  );
}

function Node(props: { job: JobView; now: number; root?: boolean }) {
  const j = () => props.job;
  const [open, setOpen] = createSignal(false);
  const [answer, setAnswer] = createSignal('');
  const st = () => STATUS[j().status] ?? { label: j().status, tone: 'idle' };
  const line = () => j().title || j().brief.split('\n')[0];
  const send = () => {
    if (!answer().trim()) return;
    jobAction('answer', j().id, { answer: answer().trim() });
    setAnswer('');
  };
  return (
    <div class="mc-node" classList={{ root: props.root }} style={{ '--mc-depth': String(props.root ? 0 : j().depth) }}>
      <button class="mc-node-row" onClick={() => setOpen((v) => !v)}>
        <Avatar emoji={j().bot?.emoji ?? '?'} color={j().bot?.color ?? '#64748B'} size={24} />
        <div class="mc-node-main">
          <div class="mc-node-top">
            <span class="mc-name">{j().bot?.name ?? '?'}</span>
            <Show when={!props.root && j().requester}>
              <span class="gc-muted">from {j().requester!.name}</span>
            </Show>
            <Show when={j().mode !== 'work'}>
              <span class="gc-badge">{j().mode}</span>
            </Show>
            <span class={`mc-status ${st().tone}`}>{st().label}</span>
            <span class="mc-time">{took(j(), props.now)}</span>
          </div>
          <div class="mc-line">{props.root ? (j().outcome ?? (LIVE.has(j().status) ? 'handing out the work' : 'answered')) : line()}</div>
          <Show when={j().digest}>
            <div class="mc-digest">
              <Icon name="build" size={12} /> {j().digest}
            </div>
          </Show>
          <Show when={!props.root && j().outcome && j().status !== 'needs_input'}>
            <div class="mc-outcome">{j().ack ? '✓ acknowledged' : j().outcome}</div>
          </Show>
          <Show when={j().status === 'needs_input' && j().question}>
            <div class="mc-ask">❓ {j().question}</div>
          </Show>
          <Show when={j().check}>
            <div class="mc-digest mc-check" classList={{ [j().check!.verdict]: true }} title={j().check!.note || undefined}>
              <Icon name="verified_user" size={12} />{' '}
              {j().check!.verdict === 'checking'
                ? `being checked by ${j().check!.by}…`
                : j().check!.verdict === 'pass'
                  ? `checked by ${j().check!.by}${j().check!.round > 1 ? ` (after ${j().check!.round - 1} fix${j().check!.round > 2 ? 'es' : ''})` : ''}`
                  : j().check!.verdict === 'issues'
                    ? `${j().check!.by} found issues (check ${j().check!.round}/3)`
                    : `${j().check!.by} could not check it`}
            </div>
          </Show>
          <Show when={j().goal}>
            <div class="mc-digest">
              🎯 goal · turn {j().goal!.turns}/{j().goal!.maxTurns}
              {j().goal!.paused ? ' · paused' : j().goal!.nextAt && j().status === 'waiting' ? ` · next ${new Date(j().goal!.nextAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
            </div>
          </Show>
        </div>
      </button>
      <Show when={open() || j().status === 'needs_input'}>
        <div class="mc-detail">
          <Show when={open() && !props.root}>
            <div class="mc-label">Brief</div>
            <div class="mc-brief">{j().brief}</div>
            <Show when={j().doneWhen}>
              <div class="mc-label">Done when</div>
              <div>{j().doneWhen}</div>
            </Show>
          </Show>
          <Show when={j().status === 'needs_input'}>
            <div class="mc-answer">
              <input class="gc-input" placeholder={`Answer ${j().bot?.name ?? 'it'}…`} value={answer()} onInput={(e) => setAnswer(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
              <button class="filled-btn" disabled={!answer().trim()} onClick={send}>
                Answer
              </button>
            </div>
          </Show>
          <Show when={open()}>
            <Show when={j().answer}>
              <div class="mc-label">Answer given</div>
              <div>{j().answer}</div>
            </Show>
            <Show when={j().evidence.length}>
              <div class="mc-label">Observed (from its tool calls)</div>
              <div class="gc-evidence">
                <For each={j().evidence}>{(l) => <div>{l}</div>}</For>
              </div>
            </Show>
            <Show when={j().result}>
              <div class="mc-label">{props.root ? 'Its answer' : 'What it says (its own account)'}</div>
              <div class="mc-result">
                <MarkdownContent text={j().result!} />
              </div>
            </Show>
            <Show when={j().artifacts.length}>
              <div class="mc-label">Attached</div>
              <div class="mc-artifacts">
                <For each={j().artifacts}>
                  {(a, i) => (
                    <button class="gc-chip mc-artifact" title={a.path ?? a.url ?? a.text ?? ''} onClick={() => (a.path || a.url) && jobAction('openArtifact', j().id, { index: i() })}>
                      <Icon name={a.kind === 'link' ? 'link' : a.kind === 'data' ? 'data_object' : a.kind === 'diff' ? 'difference' : 'file'} size={14} />
                      <span class="gc-chip-name">{a.title}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <div class="mc-actions">
              <span class="gc-muted mc-usage">
                {tokens(j().usage.input + j().usage.cached)} in · {tokens(j().usage.output)} out{j().usage.costUsd != null ? ` · $${j().usage.costUsd!.toFixed(3)}` : ''} · {j().level}
              </span>
              <span class="flex1" />
              <Show when={j().canOpen}>
                <button class="text-btn" onClick={() => jobAction('openThread', j().id)}>
                  <Icon name="open_in_new" size={15} /> Open chat
                </button>
              </Show>
              <Show when={!props.root && (j().status === 'failed' || j().status === 'cancelled')}>
                <button class="text-btn" onClick={() => jobAction('retry', j().id)}>
                  <Icon name="replay" size={15} /> Retry
                </button>
              </Show>
              <Show when={j().goal?.paused && LIVE.has(j().status)}>
                <button class="text-btn" onClick={() => jobAction('resumeGoal', j().id)}>
                  <Icon name="play_arrow" size={15} /> Resume goal
                </button>
              </Show>
              <Show when={LIVE.has(j().status)}>
                <button class="text-btn danger" onClick={() => jobAction('stop', j().id)}>
                  <Icon name="stop" size={15} /> {props.root ? 'Stop all' : 'Stop'}
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
