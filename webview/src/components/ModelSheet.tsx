// ui/models/ModelSelectorBottomSheet.kt + QuotaGroupUi.kt + ui/agents/AgentSheetUi.kt: the model picker as a bottom
// sheet — agent header with refresh, one section per quota group (its limits as meters), model cards with an
// "Active" badge and a sliding Low / Medium / High selector for models that come in tiers.
import { createEffect, createMemo, createSignal, For, type JSX, Show } from 'solid-js';
import type { AgentKind, AiModel } from '@shared/model';
import type { ModelGroupView, QuotaWindowView } from '@shared/protocol';
import { requestModels, selectModel, send, state } from '../state/store';
import { BottomSheet, DropdownMenu, Icon, IconButton } from '../ui/primitives';
import { AgentMark } from './AgentStatus';
import { agentAccent, agentLabel } from '../util/format';
import { modelSheetOpen, setModelSheetOpen } from './InputBar';
import { quotaPillWindow } from '../theme';
import { openSettings, setUiPref } from '../state/settings';

interface Family {
  key: string;
  name: string;
  description: string;
  variants: { model: AiModel; tier: string }[];
}

const tierRank = (t: string) => ({ low: 1, medium: 2, med: 2, high: 3 })[t.toLowerCase()] ?? 4;

function tierOf(m: AiModel): string {
  if (m.tier) return m.tier.toLowerCase() === 'med' ? 'Medium' : m.tier;
  const s = `${m.id} ${m.displayName}`;
  if (/-high\b|\bhigh\b/i.test(s)) return 'High';
  if (/-medium\b|-med\b|\bmedium\b/i.test(s)) return 'Medium';
  if (/-low\b|\blow\b/i.test(s)) return 'Low';
  return '';
}

/**
 * Models that come in tiers (Low / Medium / High, or a Codex reasoning effort) share one card with a tier selector.
 * Only models with a tier are merged: OpenCode sends the provider as baseName, and its models stay one card each.
 */
function families(models: AiModel[], agent: AgentKind): Family[] {
  const map = new Map<string, AiModel[]>();
  for (const m of models) {
    const tiered = !!m.tier || (agent === 'AGY' && !!tierOf(m));
    const k = tiered && m.baseName?.trim() ? `t:${m.baseName.trim()}` : `m:${m.id}`;
    map.set(k, [...(map.get(k) ?? []), m]);
  }
  return [...map.entries()].map(([key, list]) => {
    const first = list[0];
    const name =
      list.length > 1 || first.tier
        ? first.baseName?.trim() || first.displayName.replace(/\s*\((High|Medium|Low|Med|Thinking)\)/gi, '').trim()
        : first.displayName;
    return {
      key,
      name,
      description: first.description,
      variants: list.map((model) => ({ model, tier: list.length > 1 ? tierOf(model) : '' })).sort((a, b) => tierRank(a.tier) - tierRank(b.tier)),
    };
  });
}

function groupAccent(agent: AgentKind, name: string | null): string {
  if (agent !== 'AGY' || !name) return agentAccent(agent);
  if (/argon/i.test(name)) return '#9B6BDF';
  if (/claude|gpt/i.test(name)) return 'var(--claude)';
  if (/gemini/i.test(name)) return 'var(--agy)';
  return '#14B8A6';
}

export function ModelSheet() {
  const agent = () => state.chat.agent;
  const ms = () => state.models[agent()];
  const selectedId = () => {
    const own = state.chat.modelId;
    const mine = own ? ms()?.models.find((m) => m.id === own || m.key === own) : undefined;
    return mine?.id ?? ms()?.selectedId ?? ms()?.models.find((m) => m.isDefault)?.id ?? null;
  };
  // quota group edit mode (EditGroupsAction / GroupMoveButton): which limit each model counts against
  const [editing, setEditing] = createSignal(false);
  createEffect(() => modelSheetOpen() || setEditing(false));
  const editableGroups = () => (ms()?.groups ?? []).filter((g) => !!g);
  // OpenCode's long provider lists get a search box (OpenCodeModelSheet.kt: more than 8 models)
  const [query, setQuery] = createSignal('');
  createEffect(() => modelSheetOpen() && setQuery(''));
  const searchable = () => agent() === 'OPENCODE' && (ms()?.models.length ?? 0) > 8;
  const sections = createMemo(() => {
    const s0 = ms();
    if (!s0) return [];
    const q = searchable() ? query().trim().toLowerCase() : '';
    const s = q
      ? { ...s0, models: s0.models.filter((m) => `${m.displayName} ${m.id} ${m.description}`.toLowerCase().includes(q)) }
      : s0;
    const groups: (ModelGroupView | null)[] = s.groups?.length ? [...s.groups] : [];
    const byGroup = new Map<string | null, AiModel[]>();
    for (const m of s.models) {
      const g = m.group && (groups.length === 0 || groups.some((x) => x?.name === m.group)) ? m.group : null;
      byGroup.set(g, [...(byGroup.get(g) ?? []), m]);
    }
    const out: { group: ModelGroupView | null; title: string; fams: Family[] }[] = [];
    for (const g of groups) if (g && byGroup.has(g.name)) out.push({ group: g, title: g.name, fams: families(byGroup.get(g.name)!, s.agent) });
    for (const [name, list] of byGroup) {
      if (name && groups.some((g) => g?.name === name)) continue;
      out.push({ group: name ? { name } : null, title: name ?? (s.groups?.length || byGroup.size > 1 ? 'Other models' : 'All models'), fams: families(list, s.agent) });
    }
    return out;
  });
  const pick = (id: string) => {
    selectModel(agent(), id);
    setModelSheetOpen(false);
  };

  return (
    <BottomSheet open={modelSheetOpen()} onClose={() => setModelSheetOpen(false)} class="model-sheet">
      <div class="sheet-header">
        <AgentMark agent={agent()} size={36} />
        <div class="sheet-titles">
          <div class="sheet-title">Select model</div>
          <div class="sheet-sub" style={{ color: agentAccent(agent()) }}>
            {agentLabel(agent())} · {ms()?.models.length ? `${ms()!.models.length} models` : 'no models loaded'}
          </div>
        </div>
        <Show when={editableGroups().length > 1 && ms()?.models.length}>
          <button
            class="edit-groups-btn"
            classList={{ on: editing() }}
            style={{ '--accent': agentAccent(agent()) }}
            title={editing() ? 'Done editing groups' : 'Edit quota groups'}
            onClick={() => setEditing(!editing())}
          >
            <Icon name={editing() ? 'check' : 'edit_o'} size={18} />
          </button>
        </Show>
        <IconButton
          icon="refresh"
          size={38}
          iconSize={20}
          color={agentAccent(agent())}
          class={ms()?.refreshing ? 'spinning' : undefined}
          title="Refresh"
          onClick={() => requestModels(agent(), true)}
        />
      </div>
      <Show
        when={!editing()}
        fallback={
          <div class="edit-groups-banner" style={{ '--accent': agentAccent(agent()) }}>
            <Icon name="tune" size={18} />
            <div class="edit-groups-text">
              <div class="edit-groups-title">Edit quota groups</div>
              <div class="edit-groups-hint">Pick which limit each model counts against.</div>
            </div>
            <button class="text-btn" style={{ color: 'var(--accent)' }} onClick={() => setEditing(false)}>
              Done
            </button>
          </div>
        }
      >
        <Show when={ms()?.groups?.some((g) => g.windows?.some((w) => /^5h$|5 ?h|five/i.test(w.label)))}>
          <PillWindowRow accent={agentAccent(agent())} />
        </Show>
      </Show>
      <Show when={searchable()}>
        <div class="sheet-search">
          <Icon name="search" size={18} />
          <input placeholder="Search models or providers" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        </div>
      </Show>
      <div class="sheet-list">
        <Show
          when={ms()?.models.length}
          fallback={
            <div class="no-models">
              <div class="no-models-title">No models loaded</div>
              <div class="no-models-sub">Sign in to the agent or tap refresh to load its models.</div>
            </div>
          }
        >
          <For each={sections()}>
            {(sec) => {
              const accent = () => groupAccent(agent(), sec.group?.name ?? null);
              return (
                <>
                  <div class="quota-group">
                    <div class="quota-group-row">
                      <span class="quota-group-dot" style={{ background: accent() }} />
                      <span class="quota-group-title">{sec.title.toUpperCase()}</span>
                      <span class="quota-group-count">{sec.fams.length === 1 ? '1 model' : `${sec.fams.length} models`}</span>
                    </div>
                    <Show when={sec.group?.windows?.length}>
                      <div class="quota-meters">
                        <For each={sec.group!.windows}>{(w) => <QuotaMeter w={w} />}</For>
                      </div>
                    </Show>
                  </div>
                  <For each={sec.fams}>
                    {(f) => (
                      <ModelCard
                        family={f}
                        selectedId={selectedId()}
                        accent={accent()}
                        onPick={pick}
                        groupControl={
                          editing() ? (
                            <GroupMoveButton
                              current={sec.group?.name ?? null}
                              groups={editableGroups()}
                              accent={accent()}
                              onPick={(g) => send({ type: 'setQuotaGroup', agent: agent(), modelId: f.variants[0].model.id, group: g })}
                            />
                          ) : undefined
                        }
                      />
                    )}
                  </For>
                </>
              );
            }}
          </For>
        </Show>
      </div>
      {/* the per-agent sheets' way to their settings (OpenCodeModelSheet / CodexModelSheet) */}
      <Show when={agent() === 'OPENCODE' || agent() === 'CODEX'}>
        <button
          class="sheet-link"
          onClick={() => {
            setModelSheetOpen(false);
            openSettings(agent() === 'OPENCODE' ? { id: 'opencode', title: 'OpenCode' } : { id: 'codex', title: 'Codex' });
          }}
        >
          <Icon name="settings" size={16} />
          {agent() === 'OPENCODE' ? 'Connect providers or add an OpenAI-compatible endpoint' : 'Codex account and settings'}
        </button>
      </Show>
    </BottomSheet>
  );
}

/** "Shown in chat [5h | 7d]": which limit the model pill in the chat shows (QuotaGroupUi.PillWindowRow). */
function PillWindowRow(props: { accent: string }) {
  return (
    <div class="pill-window-row">
      <div class="pill-window-text">
        <div class="pill-window-title">Shown in chat</div>
        <div class="pill-window-hint">Share left next to the model name. Models with no 5h limit show 7d.</div>
      </div>
      <div class="segmented" style={{ '--accent': props.accent }}>
        <For each={['5h', '7d'] as const}>
          {(w) => (
            <button class="segment" classList={{ on: quotaPillWindow() === w }} onClick={() => setUiPref('quotaPillWindow', w)}>
              {w}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

function quotaColor(left: number) {
  return left > 0.5 ? 'var(--success)' : left > 0.2 ? 'var(--warning)' : 'var(--danger)';
}

function QuotaMeter(props: { w: QuotaWindowView }) {
  const left = () => Math.max(0, Math.min(1, props.w.remaining));
  return (
    <div class="quota-meter">
      <span class="quota-label">{props.w.label}</span>
      <span class="quota-track">
        <span class="quota-fill" style={{ width: `${left() * 100}%`, background: quotaColor(left()) }} />
      </span>
      <span class="quota-pct" style={{ color: quotaColor(left()) }}>
        {props.w.text?.trim() || `${Math.round(left() * 100)}%`}
      </span>
      <Show when={props.w.resetText}>
        <span class="quota-time"> · {props.w.resetText}</span>
      </Show>
    </div>
  );
}

/** "⇄ Gemini 4 Argon ▾": moves a model to another quota group, or back to the automatic one. */
function GroupMoveButton(props: { current: string | null; groups: ModelGroupView[]; accent: string; onPick: (g: string | null) => void }) {
  const [open, setOpen] = createSignal(false);
  let btn: HTMLButtonElement | undefined;
  const limits = (g: ModelGroupView) => (g.windows ?? []).map((w) => `${w.label} ${Math.round(w.remaining * 100)}%`).join(' · ');
  return (
    <>
      <button
        ref={btn}
        class="group-move"
        style={{ '--accent': props.accent }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Icon name="swap_horiz" size={14} />
        <span>{props.current ?? 'No group'}</span>
        <Icon name="arrow_drop_down" size={18} />
      </button>
      <DropdownMenu anchor={() => btn} open={open()} onClose={() => setOpen(false)} minWidth={220} radius={12} background="var(--surface-container-high)">
        <button class="group-move-item" onClick={() => (setOpen(false), props.onPick(null))}>
          <span class="group-move-check" />
          <span class="group-move-text">
            <span class="group-move-name strong">Automatic</span>
            <span class="group-move-sub">The group the agent puts it in</span>
          </span>
        </button>
        <div class="menu-divider" />
        <For each={props.groups}>
          {(g) => (
            <button class="group-move-item" onClick={() => (setOpen(false), props.onPick(g.name))}>
              <span class="group-move-check" style={{ color: props.accent }}>
                <Show when={g.name === props.current}>
                  <Icon name="check" size={18} />
                </Show>
              </span>
              <span class="group-move-text">
                <span class="group-move-name">{g.name}</span>
                <Show when={limits(g)}>
                  <span class="group-move-sub">{limits(g)}</span>
                </Show>
              </span>
            </button>
          )}
        </For>
      </DropdownMenu>
    </>
  );
}

function ModelCard(props: { family: Family; selectedId: string | null; accent: string; onPick: (id: string) => void; groupControl?: JSX.Element }) {
  const active = () => props.family.variants.find((v) => v.model.id === props.selectedId);
  const defaultVariant = () =>
    props.family.variants.find((v) => v.model.isDefault) ?? props.family.variants.find((v) => tierRank(v.tier) === 2) ?? props.family.variants[0];
  return (
    <div
      class="model-card"
      classList={{ active: !!active() }}
      style={{ '--accent': props.accent }}
      role="button"
      tabIndex={0}
      onClick={() => props.onPick((active() ?? defaultVariant()).model.id)}
      onKeyDown={(e) => e.key === 'Enter' && props.onPick((active() ?? defaultVariant()).model.id)}
    >
      <div class="model-card-row">
        <div class="model-card-text">
          <div class="model-card-name">{props.family.name}</div>
          <Show when={props.family.description}>
            <div class="model-card-desc">{props.family.description}</div>
          </Show>
        </div>
        <Show when={active()}>
          <span class="active-badge">
            <Icon name="check" size={12} />
            Active
          </span>
        </Show>
      </div>
      <Show when={props.family.variants.length > 1}>
        <TierSelector variants={props.family.variants} selectedId={props.selectedId} onPick={props.onPick} />
      </Show>
      <Show when={props.groupControl}>
        <div class="model-card-group" onClick={(e) => e.stopPropagation()}>
          {props.groupControl}
        </div>
      </Show>
    </div>
  );
}

/** Low / Medium / High in one track with a highlight that slides to the chosen tier. */
function TierSelector(props: { variants: { model: AiModel; tier: string }[]; selectedId: string | null; onPick: (id: string) => void }) {
  const idx = () => props.variants.findIndex((v) => v.model.id === props.selectedId);
  const n = () => props.variants.length;
  return (
    <div class="tier-track" onClick={(e) => e.stopPropagation()}>
      <span
        class="tier-highlight"
        style={{
          width: `calc((100% - 6px) / ${n()})`,
          transform: `translateX(${Math.max(0, idx()) * 100}%)`,
          opacity: idx() >= 0 ? 1 : 0,
        }}
      />
      <For each={props.variants}>
        {(v, i) => {
          const level = () => {
            const r = tierRank(v.tier);
            return r >= 1 && r <= 3 ? r : 0;
          };
          return (
            <button class="tier" classList={{ on: i() === idx() }} onClick={() => props.onPick(v.model.id)}>
              <Show when={level()}>
                <span class="tier-bars">
                  <For each={[1, 2, 3]}>
                    {(b) => <span style={{ height: `${3 + b * 3}px`, opacity: b <= level() ? 1 : 0.28 }} />}
                  </For>
                </span>
              </Show>
              <span>{v.tier || v.model.displayName}</span>
            </button>
          );
        }}
      </For>
    </div>
  );
}

