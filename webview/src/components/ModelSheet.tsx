// The model picker, made for a desktop: a dropdown anchored above the composer's model pill (not a full-screen sheet).
// Same content as the app's ModelSelectorBottomSheet / QuotaGroupUi: one section per quota group with its limits on
// top, models that come in tiers (Low / Medium / High, Codex reasoning effort) as one row with a tier switch, the
// quota group editor, the "pill shows 5h / 7d" choice. Search at the top; ↑ ↓ move, ← → tier, Enter picks, Esc closes.
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { AgentKind, AiModel } from '@shared/model';
import type { ModelGroupView, QuotaWindowView } from '@shared/protocol';
import { requestModels, selectModel, send, state } from '../state/store';
import { DropdownMenu, Icon, IconButton, nextFrame } from '../ui/primitives';
import { AgentMark } from './AgentStatus';
import { agentAccent, agentLabel } from '../util/format';
import { modelPillEl, modelSheetOpen, setModelSheetOpen } from './InputBar';
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

/** "Medium" → "Med" on the small tier chips. */
const shortTier = (t: string) => (/^medium$/i.test(t) ? 'Med' : t);

/**
 * Models that come in tiers (Low / Medium / High, or a Codex reasoning effort) share one row with a tier switch.
 * Only models with a tier are merged: OpenCode sends the provider as baseName, and its models stay one row each.
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

const quotaColor = (left: number) => (left > 0.5 ? 'var(--success)' : left > 0.2 ? 'var(--warning)' : 'var(--danger)');

interface Section {
  group: ModelGroupView | null;
  title: string;
  accent: string;
  fams: Family[];
}

const WIDTH = 420;

export function ModelSheet() {
  const agent = () => state.chat.agent;
  const ms = () => state.models[agent()];
  const accent = () => agentAccent(agent());
  const selectedId = () => {
    const own = state.chat.modelId;
    const mine = own ? ms()?.models.find((m) => m.id === own || m.key === own) : undefined;
    return mine?.id ?? ms()?.selectedId ?? ms()?.models.find((m) => m.isDefault)?.id ?? null;
  };
  const close = () => setModelSheetOpen(false);

  // quota group edit mode (EditGroupsAction / GroupMoveButton): which limit each model counts against
  const [editing, setEditing] = createSignal(false);
  const editableGroups = () => (ms()?.groups ?? []).filter((g) => !!g);
  const [query, setQuery] = createSignal('');

  const sections = createMemo<Section[]>(() => {
    const s0 = ms();
    if (!s0) return [];
    const q = query().trim().toLowerCase();
    const models = q ? s0.models.filter((m) => `${m.displayName} ${m.baseName} ${m.id} ${m.description} ${m.group ?? ''}`.toLowerCase().includes(q)) : s0.models;
    const groups: ModelGroupView[] = s0.groups?.length ? [...s0.groups] : [];
    const byGroup = new Map<string | null, AiModel[]>();
    for (const m of models) {
      const g = m.group && (groups.length === 0 || groups.some((x) => x?.name === m.group)) ? m.group : null;
      byGroup.set(g, [...(byGroup.get(g) ?? []), m]);
    }
    const out: Section[] = [];
    for (const g of groups)
      if (g && byGroup.has(g.name)) out.push({ group: g, title: g.name, accent: groupAccent(s0.agent, g.name), fams: families(byGroup.get(g.name)!, s0.agent) });
    for (const [name, list] of byGroup) {
      if (name && groups.some((g) => g?.name === name)) continue;
      out.push({
        group: name ? { name } : null,
        title: name ?? (s0.groups?.length || byGroup.size > 1 ? 'Other models' : 'All models'),
        accent: groupAccent(s0.agent, name),
        fams: families(list, s0.agent),
      });
    }
    return out;
  });
  /** Every row in order (keyboard moves through them). */
  const rows = createMemo(() => sections().flatMap((sec) => sec.fams.map((fam) => ({ fam, accent: sec.accent }))));
  const activeVariant = (f: Family) => f.variants.findIndex((v) => v.model.id === selectedId());
  const defaultVariant = (f: Family) => {
    const a = activeVariant(f);
    if (a >= 0) return a;
    const d = f.variants.findIndex((v) => v.model.isDefault);
    if (d >= 0) return d;
    const m = f.variants.findIndex((v) => tierRank(v.tier) === 2);
    return m >= 0 ? m : 0;
  };

  // keyboard: the row under the cursor and the tier ← → chose in it
  const [cursor, setCursor] = createSignal(0);
  const [tierAt, setTierAt] = createSignal<number | null>(null);
  const rowEls: HTMLElement[] = [];
  const moveCursor = (i: number) => {
    const n = rows().length;
    if (!n) return;
    const next = (i + n) % n;
    setCursor(next);
    setTierAt(null);
    rowEls[next]?.scrollIntoView({ block: 'nearest' });
  };
  // a new search: the first match is under the cursor
  createEffect(on(query, () => moveCursor(0), { defer: true }));

  const pick = (id: string) => {
    selectModel(agent(), id);
    close();
  };
  const pickRow = (i: number) => {
    const r = rows()[i];
    if (!r) return;
    const t = tierAt();
    const v = r.fam.variants[t != null && i === cursor() ? t : defaultVariant(r.fam)];
    if (v) pick(v.model.id);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (editing()) setEditing(false);
      else close();
      return;
    }
    if (editing()) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveCursor(cursor() + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickRow(cursor());
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !query()) {
      const r = rows()[cursor()];
      if (!r || r.fam.variants.length < 2) return;
      e.preventDefault();
      const cur = tierAt() ?? defaultVariant(r.fam);
      setTierAt(Math.max(0, Math.min(r.fam.variants.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1))));
    }
  };

  // ---- placement: above the pill, its left edge on the pill's, inside the window
  const [pos, setPos] = createSignal<{ left: number; bottom: number; width: number; maxHeight: number } | null>(null);
  const place = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(WIDTH, vw - 16);
    const r = modelPillEl()?.getBoundingClientRect();
    if (!r || r.width === 0) {
      setPos({ left: Math.max(8, (vw - width) / 2), bottom: 80, width, maxHeight: Math.min(560, vh - 100) });
      return;
    }
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    const bottom = vh - r.top + 6;
    setPos({ left, bottom, width, maxHeight: Math.max(220, Math.min(600, r.top - 14)) });
  };

  let pop: HTMLDivElement | undefined;
  let search: HTMLInputElement | undefined;
  const outside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (pop?.contains(t) || modelPillEl()?.contains(t)) return;
    // a menu of this picker (move to group) sits in its own portal
    if ((t as HTMLElement).closest?.('.dropdown-menu, .menu')) return;
    close();
  };
  createEffect(
    on(modelSheetOpen, (open) => {
      if (!open) {
        setEditing(false);
        return;
      }
      setQuery('');
      setTierAt(null);
      place();
      const i = rows().findIndex((r) => activeVariant(r.fam) >= 0);
      setCursor(Math.max(0, i));
      nextFrame(() => {
        search?.focus();
        rowEls[Math.max(0, i)]?.scrollIntoView({ block: 'center' });
      });
      // keys work wherever the focus is while the picker is open (a click inside it moves the focus off the search);
      // typing that starts elsewhere goes into the search
      const keys = (e: KeyboardEvent) => {
        // while editing groups, only Escape is ours (the group menus use the other keys)
        if (editing() && e.key !== 'Escape') return;
        if (['Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) {
          onKey(e);
          e.stopPropagation();
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== search && !editing()) search?.focus();
      };
      window.addEventListener('resize', place);
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', keys, true);
      onCleanup(() => {
        window.removeEventListener('resize', place);
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('keydown', keys, true);
      });
    }),
  );

  const showsFiveH = () => !!ms()?.groups?.some((g) => g.windows?.some((w) => /^5h$|5 ?h|five/i.test(w.label)));
  const count = () => ms()?.models.length ?? 0;

  return (
    <Show when={modelSheetOpen() && pos()}>
      <Portal>
        <div
          ref={pop}
          class="mp-pop"
          role="dialog"
          aria-label="Select model"
          style={{
            left: `${pos()!.left}px`,
            bottom: `${pos()!.bottom}px`,
            width: `${pos()!.width}px`,
            'max-height': `${pos()!.maxHeight}px`,
            '--accent': accent(),
          }}
        >
          <div class="mp-head">
            <AgentMark agent={agent()} size={22} />
            <div class="mp-titles">
              <span class="mp-title">{agentLabel(agent())}</span>
              <span class="mp-count">{count() ? `${count()} models` : 'no models'}</span>
            </div>
            <Show when={editableGroups().length > 1 && count()}>
              <IconButton
                icon={editing() ? 'check' : 'tune'}
                size={28}
                iconSize={16}
                color={editing() ? 'var(--accent)' : 'var(--on-surface-variant)'}
                title={editing() ? 'Done editing quota groups' : 'Edit quota groups'}
                onClick={() => setEditing(!editing())}
              />
            </Show>
            <IconButton
              icon="refresh"
              size={28}
              iconSize={16}
              color="var(--on-surface-variant)"
              class={ms()?.refreshing ? 'spinning' : undefined}
              title="Reload models and usage"
              onClick={() => requestModels(agent(), true)}
            />
          </div>

          <Show
            when={!editing()}
            fallback={
              <div class="mp-editing">
                <Icon name="tune" size={15} />
                <span>Pick which limit each model counts against.</span>
              </div>
            }
          >
            <div class="mp-search">
              <Icon name="search" size={15} />
              <input ref={search} placeholder="Search models" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} spellcheck={false} />
              <Show when={query()}>
                <button class="mp-clear" title="Clear" onClick={() => (setQuery(''), search?.focus())}>
                  <Icon name="close" size={14} />
                </button>
              </Show>
            </div>
          </Show>

          <div class="mp-list">
            <Show
              when={count()}
              fallback={
                <div class="mp-empty">
                  <div class="mp-empty-title">No models loaded</div>
                  <div>Sign in to the agent, or reload.</div>
                </div>
              }
            >
              <Show when={rows().length} fallback={<div class="mp-empty">No model matches “{query()}”</div>}>
                <For each={sections()}>
                  {(sec) => (
                    <div class="mp-section">
                      <div class="mp-group">
                        <div class="mp-group-row">
                          <span class="mp-dot" style={{ background: sec.accent }} />
                          <span class="mp-group-name">{sec.title}</span>
                          <span class="mp-group-count">{sec.fams.length}</span>
                        </div>
                        <Show when={sec.group?.windows?.length}>
                          <div class="mp-meters">
                            <For each={sec.group!.windows}>{(w) => <Meter w={w} />}</For>
                          </div>
                        </Show>
                      </div>
                      <For each={sec.fams}>
                        {(f) => {
                          const i = rows().findIndex((r) => r.fam === f);
                          return (
                            <Row
                              ref={(el) => (rowEls[i] = el)}
                              family={f}
                              accent={sec.accent}
                              selectedId={selectedId()}
                              cursor={cursor() === i}
                              pendingTier={cursor() === i ? tierAt() : null}
                              onHover={() => !editing() && (setCursor(i), setTierAt(null))}
                              onPick={(id) => (editing() ? undefined : pick(id))}
                              onPickRow={() => (editing() ? undefined : pickRow(i))}
                              groupControl={
                                editing() ? (
                                  <GroupMoveButton
                                    current={sec.group?.name ?? null}
                                    groups={editableGroups()}
                                    accent={sec.accent}
                                    onPick={(g) => send({ type: 'setQuotaGroup', agent: agent(), modelId: f.variants[0].model.id, group: g })}
                                  />
                                ) : undefined
                              }
                            />
                          );
                        }}
                      </For>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </div>

          <div class="mp-foot">
            <Show
              when={showsFiveH()}
              fallback={
                <span class="mp-keys">
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> move <kbd>⏎</kbd> pick
                </span>
              }
            >
              <span class="mp-foot-label" title="The share left shown next to the model name in the chat (models with no 5h limit show 7d)">
                Pill shows
              </span>
              <div class="mp-seg">
                <For each={['5h', '7d'] as const}>
                  {(w) => (
                    <button classList={{ on: quotaPillWindow() === w }} onClick={() => setUiPref('quotaPillWindow', w)}>
                      {w}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <span class="mp-spacer" />
            <Show when={agent() === 'OPENCODE' || agent() === 'CODEX'}>
              <button
                class="mp-link"
                onClick={() => {
                  close();
                  openSettings(agent() === 'OPENCODE' ? { id: 'opencode.providers', title: 'Providers' } : { id: 'codex', title: 'Codex' });
                }}
              >
                <Icon name="settings" size={13} />
                {agent() === 'OPENCODE' ? 'Providers' : 'Codex settings'}
              </button>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

/** One usage limit of a group: "5h ▬▬▬▬▭ 91.7% · 2h 1m" (aligned with the others of the group). */
function Meter(props: { w: QuotaWindowView }) {
  const left = () => Math.max(0, Math.min(1, props.w.remaining));
  return (
    <div class="mp-meter" title={`${props.w.label}: ${props.w.text?.trim() || `${Math.round(left() * 100)}%`} left${props.w.resetText ? `, resets in ${props.w.resetText}` : ''}`}>
      <span class="mp-meter-label">{props.w.label}</span>
      <span class="mp-bar">
        <span style={{ width: `${left() * 100}%`, background: quotaColor(left()) }} />
      </span>
      <span class="mp-meter-val" style={{ color: quotaColor(left()) }}>
        {props.w.text?.trim() || `${Math.round(left() * 100)}%`}
      </span>
      <span class="mp-meter-reset">{props.w.resetText ? `↻ ${props.w.resetText}` : ''}</span>
    </div>
  );
}

function Row(props: {
  ref: (el: HTMLElement) => void;
  family: Family;
  accent: string;
  selectedId: string | null;
  cursor: boolean;
  pendingTier: number | null;
  onHover: () => void;
  onPick: (id: string) => void;
  onPickRow: () => void;
  groupControl?: JSX.Element;
}) {
  const activeIdx = () => props.family.variants.findIndex((v) => v.model.id === props.selectedId);
  const active = () => activeIdx() >= 0;
  const tiered = () => props.family.variants.length > 1;
  return (
    <div
      ref={props.ref}
      class="mp-row"
      classList={{ active: active(), cursor: props.cursor }}
      style={{ '--row-accent': props.accent }}
      role="option"
      aria-selected={active()}
      onPointerMove={() => !props.cursor && props.onHover()}
      onClick={props.onPickRow}
    >
      <span class="mp-check">
        <Show when={active()}>
          <Icon name="check" size={15} />
        </Show>
      </span>
      <div class="mp-row-text">
        <div class="mp-name">{props.family.name}</div>
        <Show when={props.family.description}>
          <div class="mp-desc" title={props.family.description}>
            {props.family.description}
          </div>
        </Show>
      </div>
      <Show when={props.groupControl} fallback={
        <Show when={tiered()}>
          <div class="mp-tiers" onClick={(e) => e.stopPropagation()}>
            <For each={props.family.variants}>
              {(v, i) => {
                const level = () => {
                  const r = tierRank(v.tier);
                  return r >= 1 && r <= 3 ? r : 0;
                };
                return (
                  <button
                    class="mp-tier"
                    classList={{ on: i() === activeIdx(), pending: props.pendingTier === i() }}
                    title={`${props.family.name} · ${v.tier || v.model.displayName}`}
                    onClick={() => props.onPick(v.model.id)}
                  >
                    <Show when={level()}>
                      <span class="mp-tier-bars">
                        <For each={[1, 2, 3]}>{(b) => <span style={{ height: `${2 + b * 2.5}px`, opacity: b <= level() ? 1 : 0.3 }} />}</For>
                      </span>
                    </Show>
                    {shortTier(v.tier || v.model.displayName)}
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      }>
        <div onClick={(e) => e.stopPropagation()}>{props.groupControl}</div>
      </Show>
    </div>
  );
}

/** "⇄ Gemini 4 Argon ▾": moves a model to another quota group, or back to the automatic one. */
function GroupMoveButton(props: { current: string | null; groups: ModelGroupView[]; accent: string; onPick: (g: string | null) => void }) {
  const [open, setOpen] = createSignal(false);
  let btn: HTMLButtonElement | undefined;
  const limits = (g: ModelGroupView) => (g.windows ?? []).map((w) => `${w.label} ${w.text?.trim() || `${Math.round(w.remaining * 100)}%`}`).join(' · ');
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
