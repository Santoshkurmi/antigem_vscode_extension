// ui/agents/AgentStatusUi.kt (AgentStatusDot, AgentMark, AgentStatusRow, AgentStatusMenu) and
// ui/components/AgentPicker.kt.
import { createEffect, For, Show } from 'solid-js';
import type { AgentKind } from '@shared/model';
import type { AgentStatus } from '@shared/protocol';
import { agentAccent, agentLabel, alpha, stateColor, stateLabel } from '../util/format';
import { DropdownMenu, Icon, sp } from '../ui/primitives';
import { openAgentSettings } from '../state/settings';
import { agentStatus, send, state } from '../state/store';

/** One slice per agent: one color = solid dot, two = upper/lower halves, more = pie slices (first centred on top). */
export function AgentStatusDot(props: { colors: string[]; size?: number; pulsing?: boolean }) {
  const size = () => props.size ?? 11;
  const slices = () => (props.colors.length ? props.colors : ['#9CA3AF']);
  const arc = (start: number, sweep: number) => {
    const r = 12;
    const a0 = (start * Math.PI) / 180;
    const a1 = ((start + sweep) * Math.PI) / 180;
    const x0 = 12 + r * Math.cos(a0);
    const y0 = 12 + r * Math.sin(a0);
    const x1 = 12 + r * Math.cos(a1);
    const y1 = 12 + r * Math.sin(a1);
    return `M12 12 L${x0} ${y0} A${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${x1} ${y1} Z`;
  };
  return (
    <svg class="status-dot" classList={{ pulsing: !!props.pulsing }} width={size()} height={size()} viewBox="0 0 24 24">
      <Show
        when={new Set(slices()).size > 1}
        fallback={<circle cx="12" cy="12" r="12" fill={slices()[0]} />}
      >
        <Show
          when={slices().length === 2}
          fallback={
            <For each={slices()}>
              {(c, i) => {
                const sweep = 360 / slices().length;
                return <path d={arc(-90 - sweep / 2 + i() * sweep, sweep)} fill={c} />;
              }}
            </For>
          }
        >
          <path d={arc(180, 180)} fill={slices()[0]} />
          <path d={arc(0, 180)} fill={slices()[1]} />
        </Show>
      </Show>
    </svg>
  );
}

/** Round agent mark tinted with the agent's color, with an optional status badge. */
export function AgentMark(props: { agent: AgentKind; size?: number; statusColor?: string }) {
  const size = () => props.size ?? 32;
  const accent = () => agentAccent(props.agent);
  return (
    <div class="agent-mark" style={{ width: `${size()}px`, height: `${size()}px` }}>
      <div class="agent-mark-circle" style={{ background: alpha(accent(), 0.15), color: accent() }}>
        <Show when={props.agent === 'AGY'}>
          <Icon name="rocket" size={size() * 0.52} />
        </Show>
        <Show when={props.agent === 'CLAUDE'}>
          <span style={{ 'font-size': `${size() * 0.5}px`, 'font-weight': 700 }}>✻</span>
        </Show>
        <Show when={props.agent === 'OPENCODE'}>
          <span style={{ 'font-size': `${size() * 0.3}px`, 'font-weight': 700 }}>{'</>'}</span>
        </Show>
        <Show when={props.agent === 'CODEX'}>
          <span style={{ 'font-size': `${size() * 0.36}px`, 'font-weight': 700 }}>{'>_'}</span>
        </Show>
      </div>
      <Show when={props.statusColor}>
        <div class="agent-mark-badge" style={{ width: `${size() * 0.34}px`, height: `${size() * 0.34}px` }}>
          <div style={{ background: props.statusColor }} />
        </div>
      </Show>
    </div>
  );
}

export function AgentStatusRow(props: { status: AgentStatus; onDone?: () => void }) {
  const color = () => stateColor(props.status.state);
  const detail = () => props.status.detail ?? props.status.account ?? null;
  const action = () => {
    switch (props.status.state) {
      case 'offline':
        return 'Start';
      case 'error':
        return 'Retry';
      default:
        return null;
    }
  };
  return (
    <div class="agent-row">
      <AgentMark agent={props.status.kind} size={34} statusColor={color()} />
      <div class="agent-row-text">
        <div class="agent-row-title">
          <span class="agent-row-name">{agentLabel(props.status.kind)}</span>
          <span class="agent-row-state" style={{ color: color() }}>
            {props.status.label && props.status.label !== agentLabel(props.status.kind) ? props.status.label : stateLabel(props.status.state)}
          </span>
        </div>
        <Show when={detail()}>
          <div class="agent-row-detail">{detail()}</div>
        </Show>
      </div>
      {/* the agent's settings page (Install / Sign in / Restart live there) */}
      <button
        class="agent-settings-btn"
        title={`${agentLabel(props.status.kind)} settings`}
        onClick={() => {
          props.onDone?.();
          openAgentSettings(props.status.kind);
        }}
      >
        <Icon name="settings" size={16} />
      </button>
      <Show when={action()}>
        <button
          class="agent-action-pill"
          style={{ '--accent': agentAccent(props.status.kind) }}
          onClick={() => {
            send({ type: 'retryConnections' });
            props.onDone?.();
          }}
        >
          {action()}
        </button>
      </Show>
    </div>
  );
}

/** The agents' status popup (each agent's state, a retry), anchored to the top bar's status dot. */
export function AgentStatusMenu(props: { anchor: () => HTMLElement | undefined; open: boolean; onClose: () => void }) {
  return (
    <DropdownMenu
      anchor={props.anchor}
      open={props.open}
      onClose={props.onClose}
      width={300}
      radius={16}
      align="end"
      background="var(--surface)"
      border={`1px solid ${alpha('var(--outline)', 0.18)}`}
      class="agent-menu"
    >
      <div class="agent-menu-label">AGENTS</div>
      <div class="agent-menu-rows">
        <For each={state.agents}>{(a) => <AgentStatusRow status={a} onDone={props.onClose} />}</For>
        <Show when={!state.agents.length}>
          <div class="agent-row-detail">Waiting for the extension…</div>
        </Show>
      </div>
      <div class="menu-divider" style={{ 'margin-top': '12px' }} />
      <button
        class="agent-menu-link"
        title="Stops the bridge with its agents and the Antigravity hub, then starts it again"
        onClick={() => {
          props.onClose();
          send({ type: 'restartBridge' });
        }}
      >
        <Icon name="restart" size={17} color={alpha('var(--on-surface)', 0.7)} />
        <span>Restart bridge</span>
      </button>
    </DropdownMenu>
  );
}

/** Segmented picker for the agent of a new chat, with each agent's status dot. */
export function AgentPicker(props: { selected: AgentKind; agents: AgentKind[]; onSelect: (a: AgentKind) => void }) {
  return (
    <Show when={props.agents.length > 1}>
      <div class="agent-picker">
        <For each={props.agents}>
          {(a) => {
            const on = () => a === props.selected;
            return (
              <button
                class="agent-picker-chip"
                classList={{ on: on() }}
                style={{ '--accent': agentAccent(a) }}
                // the picked agent stays in view when the row scrolls (four agents in a narrow sidebar)
                ref={(el) => createEffect(() => on() && requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', inline: 'nearest' })))}
                onClick={() => props.onSelect(a)}
              >
                <Show when={agentStatus(a)}>
                  <span class="agent-picker-dot" style={{ background: stateColor(agentStatus(a)?.state) }} />
                </Show>
                <span style={{ 'font-size': sp(13) }}>{agentLabel(a)}</span>
              </button>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
