// The agents' controls strips above the input (ui/claude/ClaudeChatControls.kt ClaudeControlsStrip,
// ui/codex/CodexChatUi.kt CodexControlsStrip, ui/opencode/OpenCodeChatUi.kt OpenCodeControlsStrip): a scrolling row
// of ControlChips (ClaudeUiKit.kt). The host sends the chips (ChatPatch.controls); 'select' opens a picker sheet
// (ClaudePickerSheet + PickerOption), 'toggle' flips on / off, 'info' only shows (cache timer, context, plan usage).
import { createMemo, createSignal, For, Show } from 'solid-js';
import type { Conversation } from '@shared/model';
import type { ControlChipView } from '@shared/protocol';
import { openLinkedConversation, setControl, state } from '../state/store';
import { agentAccent, agentLabel } from '../util/format';
import { BottomSheet, DropdownMenu, Icon, type IconName } from '../ui/primitives';
import { hasIcon } from '../ui/iconData';
import { AgentMark } from './AgentStatus';

const MUTED = 'color-mix(in srgb, var(--on-surface) 75%, transparent)';

// Claude Code's permission modes in the app's own colors and icons (permissionModeColor / permissionModeIcon)
const MODE_COLORS: Record<string, string> = {
  plan: 'var(--accent-teal)',
  acceptEdits: 'var(--success)',
  auto: 'var(--accent-alt)',
  bypassPermissions: 'var(--danger)',
  dontAsk: 'var(--warning)',
};
const MODE_ICONS: Record<string, IconName> = {
  default: 'pan_tool',
  plan: 'map',
  acceptEdits: 'edit_note',
  auto: 'auto_mode',
  bypassPermissions: 'warning_amber',
  dontAsk: 'do_not_disturb_on',
};
const isModeChip = (c: ControlChipView) => state.chat.agent === 'CLAUDE' && /mode|permission|approval/i.test(c.id) && (c.options ?? []).some((o) => o.value in MODE_ICONS && o.value !== 'default');

// icon hints from the host → the bundled Material icons
const ICONS: Record<string, IconName> = {
  bolt: 'bolt',
  psychology: 'psychology',
  shield: 'shield',
  speed: 'speed',
  timer: 'timer',
  lightbulb: 'lightbulb_o',
  thinking: 'lightbulb_o',
  data_usage: 'data_usage',
  context: 'data_usage',
  auto_mode: 'auto_mode',
  map: 'map',
  plan: 'map',
  edit_note: 'edit_note',
  pan_tool: 'pan_tool',
  verified_user: 'verified_user',
  warning: 'warning_amber',
  warning_amber: 'warning_amber',
  play_arrow: 'play_arrow',
  build: 'build_o',
  smart_toy: 'smart_toy',
  tune: 'tune',
  schedule: 'schedule',
};
const iconOf = (hint: string | null | undefined): IconName | null =>
  !hint ? null : (ICONS[hint] ?? (hasIcon(hint) ? hint : null));

function toneColor(c: ControlChipView): string {
  if (isModeChip(c) && MODE_COLORS[c.value]) return MODE_COLORS[c.value];
  switch (c.tone) {
    case 'accent':
      return agentAccent(state.chat.agent);
    case 'success':
      return 'var(--success)';
    case 'warn':
      return 'var(--warning)';
    case 'danger':
      return 'var(--danger)';
    case 'muted':
      return 'color-mix(in srgb, var(--on-surface) 58%, transparent)';
    default:
      return MUTED;
  }
}

/** "permissionMode" / "effort" / "codex.reasoning" → "Permission mode" / "Effort" / "Reasoning" (the sheet title). */
function titleOf(c: ControlChipView): string {
  if (c.title?.trim()) return c.title.trim();
  if (c.label.includes(' · ')) return c.label.split(' · ')[0];
  if (c.label.includes(': ')) return c.label.split(': ')[0];
  const words = c.id
    .substring(c.id.lastIndexOf('.') + 1)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every subagent of the chat on screen, nested ones included (newest first). */
function chatSubagents(): Conversation[] {
  const root = state.chat.conversationId;
  if (!root) return [];
  const byParent = new Map<string, Conversation[]>();
  for (const c of state.conversations) {
    const p = c.parentConversationId;
    if (p && p !== c.id) byParent.set(p, [...(byParent.get(p) ?? []), c]);
  }
  const out: Conversation[] = [];
  const seen = new Set<string>([root]);
  const walk = (id: string) => {
    for (const c of byParent.get(id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      walk(c.id);
    }
  };
  walk(root);
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * ClaudeChatControls.SubagentsChip: "2 agents" with a green dot while some of this chat's subagents work, "0 agents"
 * with a white dot when none does. A click lists them all; picking one opens its chat (Back returns here).
 */
function SubagentsChip(props: { agents: Conversation[] }) {
  const [open, setOpen] = createSignal(false);
  let btn: HTMLButtonElement | undefined;
  const running = () => props.agents.filter((a) => a.isRunning).length;
  const name = (a: Conversation) => a.subagentRole?.trim() || a.title || 'Subagent';
  return (
    <>
      <button
        ref={btn}
        class="control-chip sub-chip"
        classList={{ live: running() > 0 }}
        title={`Subagents of this chat: ${running()} of ${props.agents.length} running`}
        onClick={() => setOpen(!open())}
      >
        <span class="sub-chip-dot" />
        <span>{running() === 1 ? '1 agent' : `${running()} agents`}</span>
      </button>
      <DropdownMenu anchor={() => btn} open={open()} onClose={() => setOpen(false)} minWidth={240} width={320} radius={12} background="var(--surface-container-high)">
        <div class="sub-menu-head">
          Subagents · {running()} of {props.agents.length} running
        </div>
        <div class="sub-menu-list">
          <For each={props.agents}>
            {(a) => (
              <button
                class="sub-menu-item"
                title={a.subagentTypeName ? `${name(a)} · ${a.subagentTypeName}` : name(a)}
                onClick={() => {
                  setOpen(false);
                  openLinkedConversation(a.id);
                }}
              >
                <span class="sub-menu-dot" classList={{ live: a.isRunning }} />
                <span class="sub-menu-text">
                  <span class="sub-menu-name">{name(a)}</span>
                  <span class="sub-menu-sub">{[a.subagentTypeName?.trim() || null, a.isRunning ? 'running' : 'done'].filter(Boolean).join(' · ')}</span>
                </span>
                <Icon name="chevron_right" size={16} class="sub-menu-go" />
              </button>
            )}
          </For>
        </div>
      </DropdownMenu>
    </>
  );
}

/** The chip the subagents chip follows (the app puts it next to thinking). */
const isThinkingChip = (c: ControlChipView) => /think/i.test(c.id) || /^(no )?thinking\b/i.test(c.label);

export function ControlsStrip() {
  const subagents = createMemo(chatSubagents);
  const hasThinkingChip = () => state.chat.controls.some(isThinkingChip);
  const [open, setOpenId] = createSignal<string | null>(null);
  // the sheet keeps its chip while it slides away
  const [last, setLast] = createSignal<string | null>(null);
  const setOpen = (id: string | null) => {
    if (id) setLast(id);
    setOpenId(id);
  };
  const chip = () => state.chat.controls.find((c) => c.id === last()) ?? null;
  return (
    <>
    <Show when={state.chat.notice}>
      <div class="controls-notice">
        <span class="conn-spinner small" style={{ 'border-color': agentAccent(state.chat.agent), 'border-right-color': 'transparent' }} />
        <span>{state.chat.notice}</span>
      </div>
    </Show>
    <Show when={state.chat.controls.length > 0 || subagents().length > 0}>
      <div class="controls-strip">
        <For each={state.chat.controls}>
          {(c) => {
            const color = () => toneColor(c);
            // a setting that differs from its default shows tinted (an info chip only colors its text)
            // an action ("Implement plan") is a tinted button; an info chip only colors its text
            const highlighted = () => c.kind === 'action' || (c.kind !== 'info' && !!c.tone && c.tone !== 'muted');
            const icon = () => (isModeChip(c) ? MODE_ICONS[c.value] : null) ?? iconOf(c.icon);
            const click = () => {
              if (c.disabled) return;
              if (c.kind === 'toggle') setControl(c.id, c.value === 'on' ? 'off' : 'on');
              else if (c.kind === 'select' && c.options?.length) setOpen(c.id);
              // the host runs it / answers with its details (cache timer, context window, plan usage)
              else if (c.kind === 'action') setControl(c.id, 'run', false);
              else if (c.kind === 'info') setControl(c.id, 'details', false);
            };
            return (
              <>
              <button
                class="control-chip"
                classList={{ hl: highlighted(), info: c.kind === 'info' }}
                style={{ '--chip': color() }}
                disabled={c.disabled}
                title={c.kind === 'select' ? titleOf(c) : c.kind === 'info' ? 'Details' : undefined}
                onClick={click}
              >
                <Show when={icon()}>
                  <Icon name={icon()!} size={13} />
                </Show>
                <span>{c.label}</span>
              </button>
              <Show when={isThinkingChip(c) && subagents().length}>
                <SubagentsChip agents={subagents()} />
              </Show>
              </>
            );
          }}
        </For>
        {/* no thinking chip (other agents): at the end */}
        <Show when={!hasThinkingChip() && subagents().length}>
          <SubagentsChip agents={subagents()} />
        </Show>
      </div>
      <BottomSheet open={!!open() && !!chip()} onClose={() => setOpen(null)} class="picker-sheet">
        <Show when={chip()}>
          {(c) => (
            <>
              <div class="sheet-header">
                <AgentMark agent={state.chat.agent} size={36} />
                <div class="sheet-titles">
                  <div class="sheet-title">{titleOf(c())}</div>
                  <div class="sheet-sub" style={{ color: agentAccent(state.chat.agent) }}>
                    {agentLabel(state.chat.agent)}
                  </div>
                </div>
              </div>
              <div class="picker-options">
                <For each={c().options ?? []}>
                  {(o) => {
                    const mode = () => isModeChip(c());
                    const color = () => (mode() ? (MODE_COLORS[o.value] ?? agentAccent(state.chat.agent)) : agentAccent(state.chat.agent));
                    const icon = () => (mode() ? MODE_ICONS[o.value] : null) ?? iconOf(c().icon) ?? 'tune';
                    const selected = () => o.value === c().value;
                    return (
                      <button
                        class="picker-option"
                        classList={{ on: selected() }}
                        style={{ '--opt': color() }}
                        onClick={() => {
                          setControl(c().id, o.value);
                          setOpen(null);
                        }}
                      >
                        <span class="picker-option-icon">
                          <Icon name={icon()} size={19} />
                        </span>
                        <span class="picker-option-text">
                          <span class="picker-option-title">{o.label}</span>
                          <Show when={o.description}>
                            <span class="picker-option-desc">{o.description}</span>
                          </Show>
                        </span>
                        <Show when={selected()}>
                          <span class="picker-option-check">
                            <Icon name="check" size={14} />
                          </span>
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </div>
              <Show when={c().note}>
                <div class="picker-note">
                  <Icon name="info_o" size={15} />
                  <span>{c().note}</span>
                </div>
              </Show>
            </>
          )}
        </Show>
      </BottomSheet>
    </Show>
    </>
  );
}
