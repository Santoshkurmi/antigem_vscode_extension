// The app's ui/chat/StepGroupPill.kt: a run of agent steps folded into one pill. "Working 12s · 5 tool calls · 2 running"
// while the agent works, "Worked 40s · 5 tool calls · 2 thoughts" when done, with the latest step on a second line
// (open or closed, so the pill keeps one height). A click opens the steps below it.
// Kept cheap: no animation while working (a still dot, not a spinner), the counts are worked out only when the steps
// change, and the clock is its own text node, so the once-a-second tick changes only "Working 12s".
import { createMemo, createSignal, For, Match, onCleanup, Show, Switch } from 'solid-js';
import type { ToolCall } from '@shared/model';
import type { Step, StepRun } from '../state/stepGroups';
import { Icon } from '../ui/primitives';

export function StepGroupPill(props: { run: StepRun; open: boolean; onToggle: () => void }) {
  const summary = createMemo(() => summarize(props.run.steps));
  const worked = () => !props.run.live && props.run.startedAt > 0 && props.run.endedAt > props.run.startedAt;
  const hasClock = () => props.run.live || worked();
  // "5 tool calls · 2 running" (the clock before it is separate)
  const counts = createMemo(() => {
    const s = summary();
    const parts: { text: string; color?: string }[] = [];
    if (s.tools > 0) parts.push({ text: plural(s.tools, 'tool call', 'tool calls') });
    if (s.thoughts > 0) parts.push({ text: plural(s.thoughts, 'thought', 'thoughts') });
    if (s.running > 0) parts.push({ text: `${s.running} running`, color: 'var(--primary)' });
    else if (s.thinking) parts.push({ text: 'thinking', color: 'var(--primary)' });
    if (s.failed > 0) parts.push({ text: `${s.failed} failed`, color: 'var(--error)' });
    return parts;
  });
  return (
    <button class="step-pill" onClick={props.onToggle} aria-expanded={props.open}>
      <span class="step-pill-mark">
        <Switch fallback={<Icon name="check_circle" size={14} color="var(--success)" />}>
          <Match when={props.run.live}>
            <span class="step-pill-dot" />
          </Match>
          <Match when={summary().failed > 0}>
            <Icon name="warning" size={14} color="var(--error)" />
          </Match>
        </Switch>
      </span>
      <span class="step-pill-text">
        <span class="step-pill-title">
          <Show when={props.run.live}>
            <Show when={props.run.startedAt > 0} fallback="Working">
              <WorkingClock startedAt={props.run.startedAt} />
            </Show>
          </Show>
          <Show when={worked()}>Worked {elapsed(props.run.endedAt - props.run.startedAt)}</Show>
          <For each={counts()}>
            {(p, i) => (
              <>
                <Show when={i() > 0 || hasClock()}> · </Show>
                <span style={p.color ? { color: p.color } : undefined}>{p.text}</span>
              </>
            )}
          </For>
        </span>
        {/* the latest step, open or closed (a blank line when there is none): the pill keeps one height */}
        <span class="step-pill-latest">{summary().latest || ' '}</span>
      </span>
      <Icon name="chevron_right" size={16} class="chev" style={{ transform: props.open ? 'rotate(90deg)' : 'none' }} />
    </button>
  );
}

/** "Working 12s": ticks once a second, right on the second; only this text changes. */
function WorkingClock(props: { startedAt: number }) {
  const [now, setNow] = createSignal(Date.now());
  let timer: number | undefined;
  const tick = () => {
    const t = Date.now();
    setNow(t);
    timer = window.setTimeout(tick, 1000 - (((t - props.startedAt) % 1000) + 1000) % 1000);
  };
  tick();
  onCleanup(() => clearTimeout(timer));
  return <>Working {elapsed(now() - props.startedAt)}</>;
}

interface StepSummary {
  tools: number;
  thoughts: number;
  running: number;
  thinking: boolean;
  failed: number;
  latest: string;
}

function summarize(steps: Step[]): StepSummary {
  const s: StepSummary = { tools: 0, thoughts: 0, running: 0, thinking: false, failed: 0, latest: '' };
  for (const step of steps) {
    if (step.kind === 'tool') {
      s.tools++;
      if (step.call.status === 'RUNNING') s.running++;
      if (failed(step.call)) s.failed++;
    } else {
      s.thoughts++;
      if (step.streaming) s.thinking = true;
    }
  }
  const last = steps[steps.length - 1];
  s.latest = last ? stepLabel(last) : '';
  return s;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** "8s", "1m 05s", "1h 02m". */
function elapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

/** Same rule as the tool card's red state. */
const failed = (t: ToolCall) =>
  t.status === 'FAILED' || t.status === 'TERMINATED' || (t.exitCode != null && t.exitCode !== 0 && t.status !== 'REJECTED' && t.status !== 'RUNNING');

/** One line about a step: "Running: npm test", "Read: src/App.ts", "Thinking…", "Thought: Checking the config". */
function stepLabel(step: Step): string {
  if (step.kind === 'thought') {
    if (step.streaming) return 'Thinking…';
    const l = firstLine(step.text);
    return l ? `Thought: ${l}` : '';
  }
  const t = step.call;
  const run = t.status === 'RUNNING';
  let verb: string;
  if (failed(t)) verb = 'Failed';
  else if (t.status === 'REJECTED') verb = 'Rejected';
  else
    switch (t.toolType) {
      case 'VIEW_FILE':
        verb = run ? 'Reading' : 'Read';
        break;
      case 'EDIT_FILE':
        verb = run ? 'Editing' : 'Edited';
        break;
      case 'LIST_DIR':
        verb = run ? 'Listing' : 'Listed';
        break;
      case 'GREP_SEARCH':
      case 'FIND':
        verb = run ? 'Searching' : 'Searched';
        break;
      case 'SEARCH_WEB':
        verb = run ? 'Searching web' : 'Searched web';
        break;
      case 'READ_URL':
        verb = run ? 'Fetching' : 'Fetched';
        break;
      case 'MATH':
        verb = run ? 'Evaluating' : 'Evaluated';
        break;
      case 'MCP':
        verb = run ? 'Running MCP' : 'MCP';
        break;
      case 'UNKNOWN':
        // the agent's own verb ("Checked", "Messaged") when it gave one
        verb = t.label || (run ? 'Working' : 'Done');
        break;
      default:
        verb = run ? 'Running' : 'Ran';
    }
  const target = firstLine(t.command);
  return target ? `${verb}: ${target}` : verb;
}

function firstLine(text: string): string {
  for (const l of text.split('\n')) {
    const t = l.trim().replace(/^[#*\->\s]+/, '').replace(/[*\s]+$/, '');
    if (t) return t.slice(0, 200);
  }
  return '';
}
