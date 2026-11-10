// Ports of the app's first-run agent choice and the empty-chat "agent not ready" card:
// ui/agents/AgentsSetupUi.kt (AgentChoiceDialog, AgentSelector), ui/onboarding/OnboardingStep.kt (OnboardingStepScreen),
// ui/agents/AgentStatusUi.kt (AgentSetupPrompt) with the texts of ui/claude/ClaudeStatusViews.kt (ClaudeStatusPrompt),
// AgentStatusUi.kt (openCodeStatusEntry / codexStatusEntry) and ui/chat/ChatScreen.kt. 1dp = 1px, text N sp.
import { createSignal, For, type JSX, type ParentProps, Show } from 'solid-js';
import type { AgentKind } from '@shared/model';
import { AgentMark } from './AgentStatus';
import { agentAccent, agentLabel } from '../util/format';

/** AgentKind.entries: the app's agent order. */
const AGENT_ENTRIES: AgentKind[] = ['AGY', 'CLAUDE', 'OPENCODE', 'CODEX'];

/** AgentsSetupUi.kt AGENT_OPTIONS. */
const AGENT_OPTIONS: { agent: AgentKind; title: string; description: string }[] = [
  {
    agent: 'AGY',
    title: 'Antigravity',
    description: "Google's coding agent through the agy hub: Gemini and Claude models on your Google plan.",
  },
  {
    agent: 'CLAUDE',
    title: 'Claude Code',
    description: "Anthropic's Claude Code CLI on this device: your Claude subscription or Anthropic Console account.",
  },
  {
    agent: 'OPENCODE',
    title: 'OpenCode',
    description: 'Open-source coding agent: 200+ providers with your own keys, any OpenAI-compatible API, and free models.',
  },
  {
    agent: 'CODEX',
    title: 'Codex',
    description: "OpenAI's Codex CLI on this device: sign in with your ChatGPT account (or an API key).",
  },
];

/**
 * OnboardingStepScreen: one full-screen step of the first-launch setup. A progress bar with "STEP x OF y" (left out
 * with one step), the step's icon, title and text, its content (scrolls), and the primary button fixed at the bottom.
 */
function OnboardingStepScreen(
  props: ParentProps<{
    step: number;
    total: number;
    accent: string;
    icon: JSX.Element;
    title: string;
    subtitle: string;
    primaryLabel: string;
    primaryEnabled?: boolean;
    onPrimary: () => void;
    footnote?: string;
  }>,
) {
  return (
    <div class="onb-screen" role="dialog" aria-modal="true" aria-label={props.title} style={{ '--accent': props.accent }}>
      {/* progress */}
      <Show when={props.total > 1} fallback={<div class="onb-top-space" />}>
        <div class="onb-progress">
          <div class="onb-progress-bars">
            <For each={Array.from({ length: props.total }, (_, i) => i + 1)}>
              {(i) => <div class="onb-progress-bar" classList={{ done: i <= props.step }} />}
            </For>
          </div>
          <div class="onb-progress-label">
            STEP {props.step} OF {props.total}
          </div>
        </div>
      </Show>

      {/* header + content */}
      <div class="onb-scroll">
        <div class="onb-body">
          <div class="onb-icon">{props.icon}</div>
          <div class="onb-title">{props.title}</div>
          <div class="onb-subtitle">{props.subtitle}</div>
          <div class="onb-content">{props.children}</div>
        </div>
      </div>

      {/* bottom action */}
      <div class="onb-divider" />
      <div class="onb-bottom">
        <button class="onb-primary" disabled={props.primaryEnabled === false} onClick={() => props.onPrimary()}>
          {props.primaryLabel}
        </button>
        <Show when={props.footnote}>
          <div class="onb-footnote">{props.footnote}</div>
        </Show>
      </div>
    </div>
  );
}

/**
 * AgentSelector: one card per agent (mark, name, description, a checkbox in the agent's color); tap to turn it on or
 * off. Without [allowEmpty] the last one stays on.
 */
function AgentSelector(props: { selected: AgentKind[]; onSelect: (next: AgentKind[]) => void; allowEmpty?: boolean }) {
  return (
    <div class="fra-selector">
      <For each={AGENT_OPTIONS}>
        {(option) => {
          const isOn = () => props.selected.includes(option.agent);
          return (
            <button
              class="fra-card"
              classList={{ on: isOn() }}
              role="checkbox"
              aria-checked={isOn()}
              style={{ '--accent': agentAccent(option.agent) }}
              onClick={() => {
                const next = isOn() ? props.selected.filter((a) => a !== option.agent) : [...props.selected, option.agent];
                if (props.allowEmpty || next.length > 0) props.onSelect(next);
              }}
            >
              <AgentMark agent={option.agent} size={40} />
              <span class="fra-card-text">
                <span class="fra-card-title">{option.title}</span>
                <span class="fra-card-desc">{option.description}</span>
              </span>
              <span class="fra-check">
                <Show when={isOn()}>
                  <span class="fra-check-mark">✓</span>
                </Show>
              </span>
            </button>
          );
        }}
      </For>
      <Show when={props.selected.length > 1}>
        <div class="fra-hint">With several agents on, pick the agent for each new chat on the empty chat screen.</div>
      </Show>
    </div>
  );
}

/** The step icon: one mark per agent, two by two (fits the round icon). */
function AgentMarksIcon() {
  const corners = ['top-start', 'top-end', 'bottom-start', 'bottom-end'];
  return (
    <div class="fra-marks">
      <For each={AGENT_ENTRIES.slice(0, corners.length)}>
        {(agent, i) => (
          <div class={`fra-marks-cell ${corners[i()]}`}>
            <AgentMark agent={agent} size={28} />
          </div>
        )}
      </For>
    </div>
  );
}

/**
 * First launch (AgentChoiceDialog): which agents to run. Nothing is preselected; the user ticks one or more.
 * Full screen over the whole app, as step 1 of 1. [onDone] gets the picked agents in the app's agent order.
 */
export function FirstRunAgents(props: { onDone: (agents: AgentKind[]) => void }) {
  const [selected, setSelected] = createSignal<AgentKind[]>([]);
  const primaryLabel = () => {
    const s = selected();
    if (s.length === 0) return 'Pick at least one agent';
    if (s.length === 1) return `Continue with ${agentLabel(s[0])}`;
    return `Continue with ${s.length} agents`;
  };
  return (
    <OnboardingStepScreen
      step={1}
      total={1}
      accent="var(--primary)"
      icon={<AgentMarksIcon />}
      title="Choose your agents"
      subtitle="Tick the coding agents you want to use. The app runs only the ones you pick; you can change this later in Settings → Agents."
      primaryLabel={primaryLabel()}
      primaryEnabled={selected().length > 0}
      onPrimary={() => {
        const s = selected();
        if (s.length) props.onDone(AGENT_ENTRIES.filter((a) => s.includes(a)));
      }}
    >
      <AgentSelector selected={selected()} onSelect={setSelected} allowEmpty />
    </OnboardingStepScreen>
  );
}

/**
 * AgentSetupPrompt: centered prompt for an agent that is not ready (empty chat screen). The agent's mark (60dp, with
 * an optional status badge), title, message, a filled button in the agent's color and an optional text button.
 */
export function AgentSetupPrompt(props: {
  agent: AgentKind;
  title: string;
  text: string;
  actionLabel: string;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** The status badge on the mark (the app passes the agent's status dot color). */
  statusColor?: string;
}) {
  return (
    <div class="asp" style={{ '--accent': agentAccent(props.agent) }}>
      <AgentMark agent={props.agent} size={60} statusColor={props.statusColor} />
      <div class="asp-title">{props.title}</div>
      <div class="asp-text">{props.text}</div>
      <Show when={props.actionLabel}>
        <button class="asp-action" onClick={() => props.onAction()}>
          {props.actionLabel}
        </button>
      </Show>
      <Show when={props.secondaryLabel}>
        <button class="asp-secondary" onClick={() => props.onSecondary?.()}>
          {props.secondaryLabel}
        </button>
      </Show>
    </div>
  );
}

/**
 * The empty-chat card's texts for an agent that is not installed, as the app shows them: Claude Code from
 * ClaudeStatusPrompt (NOT_INSTALLED), OpenCode and Codex from ChatScreen's title with the status entry's detail and
 * action. The app has no such card for Antigravity: its texts come from the agy CLI card (Settings → Antigravity).
 * [secondary] is the app's text button under the action (null: none); [statusColor] the mark's status badge.
 * [termuxPackage]: Codex is a Termux package there (codexStatusEntry's "pkg install codex" variant).
 */
export function notInstalledText(
  agent: AgentKind,
  opts?: { termuxPackage?: boolean },
): { title: string; text: string; action: string; secondary: string | null; statusColor: string } {
  switch (agent) {
    case 'CLAUDE':
      return {
        title: 'Claude Code not found',
        text: 'The claude CLI is not installed on this device yet. You can install it from Settings in one tap.',
        action: 'Set up Claude Code',
        secondary: 'Check again',
        // ClaudeStatus.NOT_INSTALLED
        statusColor: '#F97316',
      };
    case 'OPENCODE':
      return {
        title: 'OpenCode is not installed',
        text: 'OpenCode is not installed yet. The app can install it for you.',
        action: 'Install',
        secondary: 'Server logs',
        // openCodeStatusEntry: NOT_INSTALLED -> ClaudeStatus.ERROR.dotColor
        statusColor: '#EF4444',
      };
    case 'CODEX':
      return {
        title: 'Codex is not installed',
        text: opts?.termuxPackage
          ? 'Codex is not installed yet (pkg install codex). The app can install it for you.'
          : 'Codex is not installed yet. The app can install it for you.',
        action: 'Install',
        secondary: 'Server logs',
        // codexStatusEntry: NOT_INSTALLED -> ClaudeStatus.ERROR.dotColor
        statusColor: '#EF4444',
      };
    case 'AGY':
    default:
      return {
        title: 'Antigravity is not installed',
        text: 'agy is not installed on this device.',
        action: 'Install agy',
        secondary: null,
        statusColor: '#F97316',
      };
  }
}
