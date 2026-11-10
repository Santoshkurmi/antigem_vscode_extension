// The settings screen of ui/settings/SettingsDialog.kt: a full-screen page that slides over the chat, a header with
// back / title / Done, and pages that slide sideways. It draws the host's SettingsPage (any depth) in the app's styles —
// rounded row groups (SettingsRows.kt) for page links, cards with switches, chips, radio lists, text fields, lists and
// usage bars (ClaudeUiKit / the agent settings pages) — plus the pages the view owns: Themes and Appearance.
import { createEffect, createMemo, createSignal, For, type JSX, Match, on, onCleanup, Show, Switch } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { AgentKind } from '@shared/model';
import type { ModelGroupView, SettingFormField, SettingItem, SettingListRow, SettingOption, SettingsSection } from '@shared/protocol';
import {
  changeSetting,
  closeSettings,
  LOCAL_APPEARANCE,
  LOCAL_THEMES,
  popPage,
  pushPage,
  setUiPref,
  settingAction,
  settings,
  type StackEntry,
} from '../state/settings';
import { agentStatus, setUi, state } from '../state/store';
import { BottomSheet, Dialog, DropdownMenu, Icon, IconButton, nextFrame, type IconName } from '../ui/primitives';
import { AgentMark } from './AgentStatus';
import { agentAccent, alpha, stateColor } from '../util/format';
import { ThemesPage, themeName } from './Themes';
import { fontScale } from '../theme';

// ------------------------------------------------------------------------------------------------ screen

export function SettingsScreen() {
  // AnimatedVisibility(slideInHorizontally + fadeIn(250) / slideOutHorizontally + fadeOut(200))
  const [mounted, setMounted] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  let timer: number | undefined;
  createEffect(
    on(
      () => settings.open,
      (o) => {
        clearTimeout(timer);
        if (o) {
          setMounted(true);
          nextFrame(() => setShown(true));
        } else {
          setShown(false);
          timer = window.setTimeout(() => setMounted(false), 300);
        }
      },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  const top = () => settings.stack[settings.stack.length - 1];
  const title = () => {
    const t = top();
    if (!t) return 'Settings';
    return settings.pages[t.id]?.title || t.title;
  };
  const loading = () => {
    const t = top();
    if (!t || t.id.startsWith('local:')) return false;
    const p = settings.pages[t.id];
    return !p || !!p.loading;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !document.querySelector('.dialog-scrim, .sheet-scrim.shown, .menu')) popPage();
  };

  return (
    <Show when={mounted()}>
      <div class="settings" classList={{ shown: shown() }} onKeyDown={onKey} tabIndex={-1} ref={(el) => setTimeout(() => el.focus({ preventScroll: true }), 50)}>
        <header class="settings-head">
          <button class="nav-btn" title="Back" onClick={popPage}>
            <Icon name="arrow_back" size={24} />
          </button>
          <div class="settings-titles">
            <div class="settings-title">{title()}</div>
            <Show when={settings.stack.length > 1 && top()?.subtitle}>
              <div class="settings-sub">{top()!.subtitle}</div>
            </Show>
          </div>
          <Show when={loading()}>
            <span class="head-spinner" />
          </Show>
          <button class="text-btn strong done-btn" onClick={closeSettings}>
            Done
          </button>
        </header>
        <div class="settings-divider" />
        <PageStack />
      </div>
    </Show>
  );
}

/** Pages slide like the app's AnimatedContent: forward = in from the right, back = in from the left quarter. */
function PageStack() {
  interface Layer {
    key: string;
    entry: StackEntry;
    anim: 'in-fwd' | 'in-back' | 'out-fwd' | 'out-back' | 'still';
  }
  const [layers, setLayers] = createSignal<Layer[]>([]);
  const keyOf = () => settings.stack.map((s) => s.id).join('/');
  createEffect(
    on(keyOf, (key, prev) => {
      const entry = settings.stack[settings.stack.length - 1];
      if (!entry) return;
      if (prev === undefined) {
        setLayers([{ key, entry, anim: 'still' }]);
        return;
      }
      const fwd = settings.dir === 'fwd';
      setLayers((ls) => [
        ...ls.filter((l) => l.key !== key && !l.anim.startsWith('out')).map((l) => ({ ...l, anim: (fwd ? 'out-fwd' : 'out-back') as Layer['anim'] })),
        { key, entry, anim: fwd ? 'in-fwd' : 'in-back' },
      ]);
      setTimeout(() => setLayers((ls) => ls.filter((l) => !l.anim.startsWith('out'))), 260);
    }),
  );
  return (
    <div class="settings-pages">
      <For each={layers()}>
        {(l) => (
          <div class={`settings-page ${l.anim}`}>
            <PageBody entry={l.entry} />
          </div>
        )}
      </For>
    </div>
  );
}

function PageBody(props: { entry: StackEntry }) {
  return (
    <Switch fallback={<HostPage id={props.entry.id} />}>
      <Match when={props.entry.id === LOCAL_THEMES}>
        <ThemesPage />
      </Match>
      <Match when={props.entry.id === LOCAL_APPEARANCE}>
        <AppearancePage />
      </Match>
    </Switch>
  );
}

// ------------------------------------------------------------------------------------------------ host pages

function HostPage(props: { id: string }) {
  const page = () => settings.pages[props.id];
  const isRoot = () => props.id === 'root';
  return (
    <div class="settings-content">
      <Show when={isRoot()}>
        <RowGroup
          rows={[
            { icon: 'palette', tint: 'var(--accent-pink)', title: 'Themes', value: themeName(), onClick: () => pushPage({ id: LOCAL_THEMES, title: 'Themes', subtitle: 'Light and dark mode, and the theme gallery' }) },
            {
              icon: 'tune',
              tint: 'var(--accent-alt)',
              title: 'Appearance',
              value: fontScale() !== 1 ? `${Math.round(fontScale() * 100)}%` : undefined,
              onClick: () => pushPage({ id: LOCAL_APPEARANCE, title: 'Appearance', subtitle: 'Chat text size and the chat list' }),
            },
          ]}
        />
      </Show>
      <Show
        when={page()}
        fallback={
          <Show when={!isRoot()}>
            <div class="settings-loading">
              <span class="head-spinner" />
            </div>
          </Show>
        }
      >
        <For each={page()!.sections}>{(s) => <SectionView section={s} pageId={props.id} />}</For>
      </Show>
    </div>
  );
}

const PAGE_TINTS: Record<string, string> = {
  palette: 'var(--accent-pink)',
  tune: 'var(--accent-alt)',
  dns: 'var(--info)',
  hub: 'var(--agy)',
  rocket: 'var(--agy)',
  security: 'var(--warning)',
  policy: 'var(--warning)',
  bolt: 'var(--warning)',
  extension: 'var(--accent-alt)',
  auto_awesome: 'var(--accent-alt)',
  terminal: 'var(--accent-indigo)',
  terminal_o: 'var(--accent-indigo)',
  info_o: 'var(--accent-alt)',
  speed: 'var(--success)',
  key: 'var(--warning)',
  lock: 'var(--warning)',
  person: 'var(--info)',
  account: 'var(--info)',
  code: 'var(--accent-teal)',
  lan: 'var(--info)',
  smart_toy: 'var(--primary)',
  cloud: 'var(--info)',
  voice: 'var(--accent-teal)',
  backup: 'var(--info)',
  storage: 'var(--accent-teal)',
  handyman: 'var(--accent-teal)',
  memory: 'var(--accent-teal)',
  history: 'var(--accent-indigo)',
  model: 'var(--accent-alt)',
  forum: 'var(--info)',
  chat: 'var(--info)',
};

const ICON_ALIASES: Record<string, IconName> = {
  info: 'info_o',
  rocket_launch: 'rocket',
  vpn_key: 'key',
  account_circle: 'account',
  record_voice_over: 'voice',
  power_settings_new: 'power',
  delete: 'delete_o',
  settings: 'settings',
  terminal: 'terminal_o',
  model_training: 'model',
  description: 'description_o',
  folder: 'folder_o',
  build: 'build_o',
  warning: 'warning_o',
  error: 'error_o',
  check_circle: 'check_circle_o',
};

function iconOf(name: string | null | undefined): IconName {
  if (!name) return 'settings';
  const n = name.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const alias = ICON_ALIASES[n];
  if (alias) return alias;
  return (KNOWN_ICONS.has(n) ? n : 'settings') as IconName;
}
const KNOWN_ICONS = new Set([
  'palette', 'tune', 'dns', 'hub', 'security', 'bolt', 'key', 'person', 'speed', 'memory', 'history', 'link', 'api', 'account',
  'logout', 'sync', 'storage', 'voice', 'science', 'cable', 'backup', 'handyman', 'format_size', 'workspaces', 'power',
  'download', 'upload', 'edit_note', 'rule', 'policy', 'lock', 'model', 'forum', 'chat', 'cloud_sync', 'extension',
  'auto_awesome', 'code', 'smart_toy', 'cloud', 'rocket', 'language', 'public', 'notifications', 'schedule', 'layers',
  'settings', 'search', 'image', 'terminal_o', 'info_o', 'folder_o', 'build_o', 'description_o', 'edit_o', 'chat_bubble', 'lan',
]);

const toneColor = (tone: string | null | undefined) =>
  tone === 'ok' ? 'var(--success)' : tone === 'warn' ? 'var(--warning)' : tone === 'error' ? 'var(--danger)' : tone === 'muted' ? alpha('var(--on-surface)', 0.45) : null;

function SectionView(props: { section: SettingsSection; pageId: string }) {
  const s = () => props.section;
  const accent = () => (s().agent ? agentAccent(s().agent as AgentKind) : 'var(--primary)');
  const onlyPages = () => s().items.length > 0 && s().items.every((i) => i.kind === 'page');
  // consecutive page links share one row group (dividers between them), like the app's settings lists
  const runs = createMemo(() => {
    const out: { pages?: Extract<SettingItem, { kind: 'page' }>[]; buttons?: SettingItem[]; item?: SettingItem }[] = [];
    for (const it of s().items) {
      const last = out[out.length - 1];
      if (it.kind === 'page') {
        if (last?.pages) last.pages.push(it);
        else out.push({ pages: [it] });
      } else if (it.kind === 'button' && !it.description) {
        // buttons without a description sit side by side
        if (last?.buttons) last.buttons.push(it);
        else out.push({ buttons: [it] });
      } else out.push({ item: it });
    }
    return out;
  });
  // a section with settings and page links: the header above (like a links-only section), the settings in a card,
  // each run of page links in its own row group
  const mixed = () => !onlyPages() && s().items.some((i) => i.kind === 'page');
  // items that are cards themselves (the agents checklist: one card per agent) are not put in another card
  const selfCarded = () => s().items.length > 0 && s().items.every((i) => i.kind === 'checklist' && isAgentList(i.options));
  const blocks = createMemo(() => {
    const out: { pages?: Extract<SettingItem, { kind: 'page' }>[]; runs?: ReturnType<typeof runs> }[] = [];
    for (const r of runs()) {
      const last = out[out.length - 1];
      if (r.pages) out.push({ pages: r.pages });
      else if (last?.runs) last.runs.push(r);
      else out.push({ runs: [r] });
    }
    return out;
  });
  const header = () => (
    <Show when={s().title}>
      <div class="section-head" classList={{ agent: !!s().agent }}>
        <Show when={s().agent}>
          <AgentMark agent={s().agent as AgentKind} size={22} />
        </Show>
        <span class="section-title">{s().title}</span>
      </div>
    </Show>
  );
  const runView = (run: ReturnType<typeof runs>[number]) => (
    <Switch fallback={<ItemView item={run.item!} pageId={props.pageId} section={s()} />}>
      <Match when={run.pages}>
        <RowGroup rows={run.pages!.map((it) => pageRow(it, s()))} />
      </Match>
      <Match when={run.buttons}>
        <div class="button-row">
          <For each={run.buttons!}>{(b) => <ItemView item={b} pageId={props.pageId} section={s()} />}</For>
        </div>
      </Match>
    </Switch>
  );
  return (
    <div class="settings-section" style={{ '--accent': accent() }}>
      <Switch
        fallback={
          <div class="settings-card">
            <Show when={s().title}>
              <div class="card-title-row">
                <Show when={s().agent}>
                  <AgentMark agent={s().agent as AgentKind} size={22} />
                </Show>
                <span class="card-title" classList={{ tinted: !!s().agent }}>
                  {s().title}
                </span>
              </div>
            </Show>
            <Show when={s().description}>
              <div class="hint">{s().description}</div>
            </Show>
            <div class="card-items">
              <For each={runs()}>{runView}</For>
            </div>
          </div>
        }
      >
        <Match when={selfCarded()}>
          {header()}
          <For each={s().items}>{(it) => <ItemView item={it} pageId={props.pageId} section={s()} />}</For>
        </Match>
        <Match when={onlyPages()}>
          {header()}
          <Show when={s().description}>
            <div class="hint section-desc">{s().description}</div>
          </Show>
          <RowGroup rows={s().items.map((it) => pageRow(it as Extract<SettingItem, { kind: 'page' }>, s()))} />
        </Match>
        <Match when={mixed()}>
          {header()}
          <Show when={s().description}>
            <div class="hint section-desc">{s().description}</div>
          </Show>
          <For each={blocks()}>
            {(b) => (
              <Show when={b.runs} fallback={<RowGroup rows={b.pages!.map((it) => pageRow(it, s()))} />}>
                <div class="settings-card bare">
                  <div class="card-items">
                    <For each={b.runs!}>{runView}</For>
                  </div>
                </div>
              </Show>
            )}
          </For>
        </Match>
      </Switch>
    </div>
  );
}

/** A page link that is an agent's page takes the agent's color (the app's settings rows do). */
function agentOfPage(it: { id: string; label: string }): AgentKind | null {
  const k = `${it.id} ${it.label}`.toLowerCase();
  if (/\bclaude\b/.test(k)) return 'CLAUDE';
  if (/opencode/.test(k)) return 'OPENCODE';
  if (/codex/.test(k)) return 'CODEX';
  if (/^(agy|antigravity)$|\bantigravity\b/.test(k.trim()) && !/\./.test(it.id)) return 'AGY';
  return null;
}

function pageRow(it: Extract<SettingItem, { kind: 'page' }>, section: SettingsSection): RowItem {
  const icon = iconOf(it.icon);
  const agent = section.agent ?? agentOfPage(it);
  const own = agentOfPage(it);
  return {
    icon,
    tint: agent ? agentAccent(agent) : (PAGE_TINTS[icon] ?? 'var(--primary)'),
    title: it.label,
    // the short value on the right (SettingsRowItem.value): the badge, else the page's status when it is a short one
    // (an address, an account); a sentence is not a value; the app's rows have no description, the page shows it
    value: it.badge ?? (it.description && it.description.length <= 28 && it.description.trim().split(/\s+/).length <= 3 ? it.description : undefined),
    // an agent's own page shows its state as a dot (the app's Claude Code row)
    valueColor: own ? stateColor(agentStatus(own)?.state) : null,
    onClick: () => pushPage({ id: it.id, title: it.label, subtitle: it.description }),
  };
}

// ------------------------------------------------------------------------------------------------ rows (SettingsRows.kt)

interface RowItem {
  icon: IconName;
  tint: string;
  title: string;
  value?: string;
  valueColor?: string | null;
  onClick: () => void;
}

/** Rows in one rounded card, split by thin dividers that start after the icon. */
function RowGroup(props: { rows: RowItem[] }) {
  return (
    <Show when={props.rows.length}>
      <div class="row-group">
        <For each={props.rows}>
          {(r, i) => (
            <>
              <button class="settings-row" onClick={r.onClick}>
                <span class="row-icon" style={{ background: alpha(r.tint, 0.14), color: r.tint }}>
                  <Icon name={r.icon} size={19} />
                </span>
                <span class="row-title">{r.title}</span>
                <Show when={r.value}>
                  <Show when={r.valueColor}>
                    <span class="row-dot" style={{ background: r.valueColor! }} />
                  </Show>
                  <span class="row-value">{r.value}</span>
                </Show>
                <Icon name="chevron_right" size={20} class="row-chev" />
              </button>
              <Show when={i() < props.rows.length - 1}>
                <div class="row-divider" />
              </Show>
            </>
          )}
        </For>
      </div>
    </Show>
  );
}

// ------------------------------------------------------------------------------------------------ items

function ItemView(props: { item: SettingItem; pageId: string; section: SettingsSection }) {
  const it = () => props.item;
  const as = <K extends SettingItem['kind']>(_k: K) => it() as Extract<SettingItem, { kind: K }>;
  return (
    <div
      class="setting-item"
      classList={{
        // a read-only log (disabled multi-line text) stays at full strength
        disabled: 'disabled' in it() && !!(it() as { disabled?: boolean }).disabled && !(it().kind === 'text' && (it() as { multiline?: boolean }).multiline),
      }}
    >
      <Switch>
        <Match when={it().kind === 'toggle'}>
          <ToggleItem item={as('toggle')} pageId={props.pageId} />
        </Match>
        <Match when={it().kind === 'select'}>
          <SelectItem item={as('select')} pageId={props.pageId} />
        </Match>
        <Match when={it().kind === 'checklist'}>
          <ChecklistItem item={as('checklist')} pageId={props.pageId} />
        </Match>
        <Match when={it().kind === 'text'}>
          <TextItem item={as('text')} pageId={props.pageId} />
        </Match>
        <Match when={it().kind === 'info'}>
          <InfoItem item={as('info')} />
        </Match>
        <Match when={it().kind === 'button'}>
          <ButtonItem item={as('button')} pageId={props.pageId} />
        </Match>
        <Match when={it().kind === 'list'}>
          <ListItem item={as('list')} pageId={props.pageId} />
        </Match>
        <Match when={it().kind === 'page'}>
          <RowGroup rows={[pageRow(as('page'), props.section)]} />
        </Match>
        <Match when={it().kind === 'quota'}>
          <QuotaItem label={as('quota').label === props.section.title ? '' : as('quota').label} groups={as('quota').groups} />
        </Match>
      </Switch>
    </div>
  );
}

function Label(props: { label: string; description?: string | null; children?: JSX.Element }) {
  return (
    <div class="item-label">
      <div class="item-title">{props.label}</div>
      <Show when={props.description}>
        <div class="hint">{props.description}</div>
      </Show>
      {props.children}
    </div>
  );
}

/** Material 3 Switch (52 × 32, thumb 16 → 24 dp). */
export function MSwitch(props: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      class="m-switch"
      classList={{ on: props.checked }}
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation();
        props.onChange(!props.checked);
      }}
    >
      <span class="m-switch-thumb" />
    </button>
  );
}

function ToggleItem(props: { item: Extract<SettingItem, { kind: 'toggle' }>; pageId: string }) {
  return (
    <div class="toggle-row" onClick={() => !props.item.disabled && changeSetting(props.pageId, props.item.id, !props.item.value)}>
      <Label label={props.item.label} description={props.item.description} />
      <MSwitch checked={props.item.value} disabled={props.item.disabled} label={props.item.label} onChange={(v) => changeSetting(props.pageId, props.item.id, v)} />
    </div>
  );
}

/** Chips (ControlChip) for a few short options, radio rows when options explain themselves, a sheet for long lists. */
const AGENT_KINDS: AgentKind[] = ['AGY', 'CLAUDE', 'CODEX', 'OPENCODE'];
const isAgentList = (options: SettingOption[]) => options.length > 0 && options.every((o) => AGENT_KINDS.includes(o.value as AgentKind));

/**
 * Several options ticked at once (settingChange value = the ticked values). Agents render as the app's AgentSelector
 * (ui/agents/AgentsSetupUi.kt): a card per agent with its mark, tinted with its accent when on, a rounded checkbox;
 * at least one stays on. Other options are plain checkbox rows.
 */
function ChecklistItem(props: { item: Extract<SettingItem, { kind: 'checklist' }>; pageId: string }) {
  const agents = () => isAgentList(props.item.options);
  const on = (v: string) => props.item.values.includes(v);
  const toggle = (v: string) => {
    if (props.item.disabled) return;
    const next = on(v) ? props.item.values.filter((x) => x !== v) : [...props.item.values, v];
    if (agents() && next.length === 0) return;
    // keep the options' order
    changeSetting(props.pageId, props.item.id, props.item.options.map((o) => o.value).filter((x) => next.includes(x)));
  };
  return (
    <>
      <Show when={props.item.label || props.item.description}>
        <Label label={props.item.label} description={props.item.description} />
      </Show>
      <div class="checklist" classList={{ agents: agents() }}>
        <For each={props.item.options}>
          {(o) => {
            const accent = () => (agents() ? agentAccent(o.value as AgentKind) : 'var(--primary)');
            return (
              <button
                class="check-row"
                classList={{ on: on(o.value) }}
                role="checkbox"
                aria-checked={on(o.value)}
                disabled={props.item.disabled}
                style={{ '--accent': accent() }}
                onClick={() => toggle(o.value)}
              >
                <Show when={agents()}>
                  <AgentMark agent={o.value as AgentKind} size={40} />
                </Show>
                <span class="check-text">
                  <span class="check-title">{o.label}</span>
                  <Show when={o.description}>
                    <span class="check-desc">{o.description}</span>
                  </Show>
                </span>
                <span class="check-box">
                  <Show when={on(o.value)}>
                    <Icon name="check" size={15} />
                  </Show>
                </span>
              </button>
            );
          }}
        </For>
      </div>
    </>
  );
}

function SelectItem(props: { item: Extract<SettingItem, { kind: 'select' }>; pageId: string }) {
  const [sheet, setSheet] = createSignal(false);
  const style = createMemo(() => {
    const o = props.item.options;
    if (o.some((x) => x.description)) return o.length > 6 ? 'sheet' : 'radio';
    if (o.length <= 6 && o.reduce((n, x) => n + x.label.length, 0) <= 60) return 'chips';
    return 'sheet';
  });
  const pick = (v: string) => changeSetting(props.pageId, props.item.id, v);
  const current = () => props.item.options.find((o) => o.value === props.item.value);
  return (
    <Switch>
      <Match when={style() === 'chips'}>
        <Label label={props.item.label} description={props.item.description} />
        <div class="chip-flow">
          <For each={props.item.options}>{(o) => <Chip label={o.label} on={o.value === props.item.value} onClick={() => pick(o.value)} disabled={props.item.disabled} />}</For>
        </div>
      </Match>
      <Match when={style() === 'radio'}>
        <Label label={props.item.label} description={props.item.description} />
        <RadioList options={props.item.options} value={props.item.value} onPick={pick} disabled={props.item.disabled} />
      </Match>
      <Match when={style() === 'sheet'}>
        <button class="select-row" disabled={props.item.disabled} onClick={() => setSheet(true)}>
          <Label label={props.item.label} description={props.item.description} />
          <span class="row-value accent">{current()?.label ?? props.item.value}</span>
          <Icon name="chevron_right" size={20} class="row-chev" />
        </button>
        <BottomSheet open={sheet()} onClose={() => setSheet(false)} class="select-sheet">
          <div class="sheet-title" style={{ 'margin-bottom': '8px' }}>
            {props.item.label}
          </div>
          <div class="sheet-list">
            <RadioList
              options={props.item.options}
              value={props.item.value}
              onPick={(v) => {
                pick(v);
                setSheet(false);
              }}
            />
          </div>
        </BottomSheet>
      </Match>
    </Switch>
  );
}

export function Chip(props: { label: string; on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button class="control-chip" classList={{ on: props.on }} disabled={props.disabled} onClick={props.onClick}>
      {props.label}
    </button>
  );
}

function RadioList(props: { options: SettingOption[]; value: string; onPick: (v: string) => void; disabled?: boolean }) {
  return (
    <div class="radio-list">
      <For each={props.options}>
        {(o) => (
          <button class="radio-row" disabled={props.disabled} onClick={() => props.onPick(o.value)}>
            <span class="radio" classList={{ on: o.value === props.value }} />
            <span class="radio-text">
              <span class="radio-label">{o.label}</span>
              <Show when={o.description}>
                <span class="hint">{o.description}</span>
              </Show>
            </span>
          </button>
        )}
      </For>
    </div>
  );
}

function TextItem(props: { item: Extract<SettingItem, { kind: 'text' }>; pageId: string }) {
  return (
    <Show when={!(props.item.disabled && props.item.multiline)} fallback={<LogItem item={props.item} />}>
      <EditableText item={props.item} pageId={props.pageId} />
    </Show>
  );
}

/** A read-only multi-line text (an install log): monospace, scrolls, follows its end while it grows. */
function LogItem(props: { item: Extract<SettingItem, { kind: 'text' }> }) {
  let box: HTMLPreElement | undefined;
  createEffect(
    on(
      () => props.item.value,
      () => {
        if (!box) return;
        const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
        if (atEnd) queueMicrotask(() => box && (box.scrollTop = box.scrollHeight));
      },
    ),
  );
  return (
    <>
      <Label label={props.item.label} description={props.item.description} />
      <pre class="log-block" ref={(el) => (box = el, queueMicrotask(() => (el.scrollTop = el.scrollHeight)))}>
        {props.item.value || props.item.placeholder || ''}
      </pre>
    </>
  );
}

function EditableText(props: { item: Extract<SettingItem, { kind: 'text' }>; pageId: string }) {
  const [draft, setDraft] = createSignal(props.item.value);
  createEffect(on(() => props.item.value, (v) => setDraft(v), { defer: true }));
  const dirty = () => draft() !== props.item.value;
  const save = () => dirty() && changeSetting(props.pageId, props.item.id, draft());
  return (
    <>
      <Label label={props.item.label} description={props.item.description} />
      <div class="text-item-row">
        <Show
          when={props.item.multiline}
          fallback={
            <input
              class="outlined-field single"
              value={draft()}
              placeholder={props.item.placeholder ?? ''}
              disabled={props.item.disabled}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
            />
          }
        >
          <textarea
            class="outlined-field"
            rows={3}
            value={draft()}
            placeholder={props.item.placeholder ?? ''}
            disabled={props.item.disabled}
            onInput={(e) => setDraft(e.currentTarget.value)}
          />
        </Show>
        <Show when={dirty()}>
          <button class="filled-btn accent" onClick={save}>
            Save
          </button>
        </Show>
      </div>
    </>
  );
}

function InfoItem(props: { item: Extract<SettingItem, { kind: 'info' }> }) {
  const color = () => toneColor(props.item.tone);
  return (
    <div class="info-row">
      <Label label={props.item.label} description={props.item.description} />
      <span class="info-value">
        <Show when={color()}>
          <span class="row-dot" style={{ background: color()! }} />
        </Show>
        <span style={{ color: props.item.tone && props.item.tone !== 'muted' ? color()! : undefined }}>{props.item.value}</span>
      </span>
    </div>
  );
}

function ButtonItem(props: { item: Extract<SettingItem, { kind: 'button' }>; pageId: string }) {
  const [confirm, setConfirm] = createSignal(false);
  const [form, setForm] = createSignal(false);
  // values of a form that still has to be confirmed
  let pending: Record<string, string> | undefined;
  const run = (values?: Record<string, string>) => settingAction(props.pageId, props.item.id, { values });
  const click = () => {
    pending = undefined;
    if (props.item.form?.length) setForm(true);
    else if (props.item.confirm) setConfirm(true);
    else run();
  };
  return (
    <div class="button-item">
      <Show when={props.item.description}>
        <div class="hint">{props.item.description}</div>
      </Show>
      <button
        class={props.item.style === 'primary' ? 'filled-btn accent' : 'outlined-btn'}
        classList={{ danger: props.item.style === 'danger' }}
        disabled={props.item.disabled}
        onClick={click}
      >
        {props.item.label}
      </button>
      <ConfirmDialog
        open={confirm()}
        text={props.item.confirm ?? ''}
        title={props.item.label}
        danger={props.item.style === 'danger'}
        onClose={() => setConfirm(false)}
        onConfirm={() => run(pending)}
      />
      <FormDialog
        open={form()}
        title={props.item.label}
        fields={props.item.form ?? []}
        confirmLabel={props.item.label}
        onClose={() => setForm(false)}
        onSubmit={(v) => {
          if (props.item.confirm) {
            pending = v;
            setConfirm(true);
          } else run(v);
        }}
      />
    </div>
  );
}

function ListItem(props: { item: Extract<SettingItem, { kind: 'list' }>; pageId: string }) {
  const [adding, setAdding] = createSignal(false);
  return (
    <div class="list-item">
      <div class="list-head">
        <div class="item-label">
          <div class="item-title strong">
            {props.item.label} <Show when={props.item.rows.length}>({props.item.rows.length})</Show>
          </div>
          <Show when={props.item.description}>
            <div class="hint">{props.item.description}</div>
          </Show>
        </div>
      </div>
      <Show when={props.item.rows.length} fallback={<div class="list-empty">{props.item.emptyText ?? 'Nothing here yet'}</div>}>
        <div class="list-rows">
          <For each={props.item.rows}>{(r) => <ListRow row={r} itemId={props.item.id} pageId={props.pageId} />}</For>
        </div>
      </Show>
      <Show when={props.item.addLabel && props.item.addForm?.length}>
        <button class="outlined-btn add-btn" onClick={() => setAdding(true)}>
          <Icon name="add" size={18} />
          {props.item.addLabel}
        </button>
        <FormDialog
          open={adding()}
          title={props.item.addLabel!}
          fields={props.item.addForm ?? []}
          confirmLabel="Add"
          onClose={() => setAdding(false)}
          onSubmit={(values) => settingAction(props.pageId, props.item.id, { actionId: 'add', values })}
        />
      </Show>
    </div>
  );
}

type RowAction = NonNullable<SettingListRow['actions']>[number];

function ListRow(props: { row: SettingListRow; itemId: string; pageId: string }) {
  const [menu, setMenu] = createSignal(false);
  const [confirm, setConfirm] = createSignal<RowAction | null>(null);
  const [formFor, setFormFor] = createSignal<RowAction | null>(null);
  let pending: Record<string, string> | undefined;
  let menuBtn: HTMLButtonElement | undefined;
  const actions = () => props.row.actions ?? [];
  const send = (a: RowAction, values?: Record<string, string>) =>
    settingAction(props.pageId, props.itemId, { rowId: props.row.id, actionId: a.id, values });
  // a form first (prefilled: "Edit"), then the confirmation, then the action
  const run = (a: RowAction) => {
    pending = undefined;
    if (a.form?.length) setFormFor(a);
    else if (a.confirm) setConfirm(a);
    else send(a);
  };
  const tone = () => toneColor(props.row.statusTone) ?? alpha('var(--on-surface)', 0.45);
  return (
    <div class="list-row">
      <div class="list-row-text">
        <div class="list-row-title">{props.row.title}</div>
        <div class="list-row-meta">
          <Show when={props.row.status}>
            <span class="badge" style={{ color: tone(), background: alpha(tone(), 0.15) }}>
              {props.row.status}
            </span>
          </Show>
          <Show when={props.row.subtitle}>
            <span class="hint list-row-sub">{props.row.subtitle}</span>
          </Show>
        </div>
      </div>
      <Show when={props.row.toggle != null}>
        <MSwitch checked={!!props.row.toggle} label={props.row.title} onChange={(v) => changeSetting(props.pageId, props.itemId, v, props.row.id)} />
      </Show>
      <Show when={actions().length === 1}>
        <Show
          when={actions()[0].danger}
          fallback={
            <button class="text-btn small" onClick={() => run(actions()[0])}>
              {actions()[0].label}
            </button>
          }
        >
          <IconButton icon="delete_o" size={36} iconSize={20} color="color-mix(in srgb, var(--danger) 80%, transparent)" title={actions()[0].label} onClick={() => run(actions()[0])} />
        </Show>
      </Show>
      <Show when={actions().length > 1}>
        <IconButton ref={(el) => (menuBtn = el)} icon="more_vert" size={32} iconSize={18} color={alpha('var(--on-surface)', 0.6)} title="More" onClick={() => setMenu(true)} />
        <DropdownMenu
          anchor={() => menuBtn}
          open={menu()}
          onClose={() => setMenu(false)}
          align="end"
          radius={12}
          minWidth={180}
          background="var(--surface-container-high)"
          border={`1px solid ${alpha('var(--outline-variant)', 0.35)}`}
          items={actions().map((a) => ({ label: a.label, color: a.danger ? 'var(--error)' : undefined, onClick: () => run(a) }))}
        />
      </Show>
      <ConfirmDialog
        open={!!confirm()}
        title={confirm()?.label ?? ''}
        text={confirm()?.confirm ?? ''}
        danger={!!confirm()?.danger}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const a = confirm();
          if (a) send(a, pending);
        }}
      />
      <FormDialog
        open={!!formFor()}
        title={`${formFor()?.label ?? ''} · ${props.row.title}`}
        fields={formFor()?.form ?? []}
        confirmLabel={formFor()?.label === 'Edit' ? 'Save' : (formFor()?.label ?? 'Save')}
        onClose={() => setFormFor(null)}
        onSubmit={(values) => {
          const a = formFor();
          if (!a) return;
          if (a.confirm) {
            pending = values;
            setConfirm(a);
          } else send(a, values);
        }}
      />
    </div>
  );
}

/** Plan / quota usage as the app's UsageBar: label, "% used · resets …", a bar colored by how much is used. */
function QuotaItem(props: { label: string; groups: ModelGroupView[] }) {
  const usageColor = (used: number) => (used >= 0.9 ? 'var(--danger)' : used >= 0.7 ? 'var(--warning)' : 'var(--success)');
  return (
    <div class="quota-item">
      <Show when={props.label}>
        <div class="item-title strong">{props.label}</div>
      </Show>
      <For each={props.groups}>
        {(g) => (
          <div class="usage-group">
            <Show when={props.groups.length > 1 || g.name !== props.label}>
              <div class="usage-group-name">{g.name}</div>
            </Show>
            <For each={g.windows ?? []}>
              {(w) => {
                const used = () => Math.max(0, Math.min(1, 1 - w.remaining));
                return (
                  <div class="usage-bar">
                    <div class="usage-bar-top">
                      <span class="usage-label">{w.label}</span>
                      <span class="usage-text">
                        {Math.round(used() * 100)}% used{w.resetText ? ` · resets ${w.resetText}` : ''}
                      </span>
                    </div>
                    <div class="usage-track">
                      <span style={{ width: `${used() * 100}%`, background: usageColor(used()) }} />
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ dialogs

function ConfirmDialog(props: { open: boolean; title: string; text: string; danger?: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      radius={18}
      background="var(--surface-container-high)"
      actions={
        <>
          <button class="text-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            class="filled-btn"
            style={{ background: props.danger ? 'var(--error)' : 'var(--primary)', color: props.danger ? 'var(--on-error)' : 'var(--on-primary)', 'border-radius': '10px' }}
            onClick={() => {
              props.onClose();
              props.onConfirm();
            }}
          >
            {props.danger ? 'Delete' : 'Continue'}
          </button>
        </>
      }
    >
      {props.text}
    </Dialog>
  );
}

/** A form as an AlertDialog with labeled fields (the app's Add MCP / provider dialogs). */
function FormDialog(props: {
  open: boolean;
  title: string;
  fields: SettingFormField[];
  confirmLabel: string;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = createStore<Record<string, string>>({});
  const [reveal, setReveal] = createStore<Record<string, boolean>>({});
  createEffect(
    on(
      () => props.open,
      (o) => {
        if (!o) return;
        const init: Record<string, string> = {};
        for (const f of props.fields) init[f.id] = f.value ?? (f.kind === 'select' ? (f.options?.[0]?.value ?? '') : f.kind === 'toggle' ? 'false' : '');
        setValues(init);
      },
    ),
  );
  const valid = () => props.fields.every((f) => !f.required || (values[f.id] ?? '').trim());
  const submit = () => {
    if (!valid()) return;
    // submit first: the caller may still need what opened the form
    props.onSubmit({ ...values });
    props.onClose();
  };
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      radius={24}
      actions={
        <>
          <button class="text-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button class="filled-btn" disabled={!valid()} onClick={submit}>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <form
        class="form-fields"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <For each={props.fields}>
          {(f, i) => (
            <div class="form-field">
              <Switch>
                <Match when={f.kind === 'toggle'}>
                  <div class="toggle-row">
                    <div class="item-title">{f.label}</div>
                    <MSwitch checked={values[f.id] === 'true'} onChange={(v) => setValues(f.id, String(v))} />
                  </div>
                </Match>
                <Match when={f.kind === 'select'}>
                  <div class="form-label">{f.label}</div>
                  <div class="chip-flow">
                    <For each={f.options ?? []}>{(o) => <Chip label={o.label} on={values[f.id] === o.value} onClick={() => setValues(f.id, o.value)} />}</For>
                  </div>
                </Match>
                <Match when={f.kind === 'multiline'}>
                  <div class="form-label">
                    {f.label}
                    <Show when={f.required}> *</Show>
                  </div>
                  <textarea class="outlined-field" rows={3} placeholder={f.placeholder ?? ''} value={values[f.id] ?? ''} onInput={(e) => setValues(f.id, e.currentTarget.value)} />
                </Match>
                <Match when={f.kind === 'text' || f.kind === 'password'}>
                  <div class="form-label">
                    {f.label}
                    <Show when={f.required}> *</Show>
                  </div>
                  <div class="field-wrap">
                    <input
                      class="outlined-field single"
                      type={f.kind === 'password' && !reveal[f.id] ? 'password' : 'text'}
                      placeholder={f.placeholder ?? ''}
                      value={values[f.id] ?? ''}
                      autocomplete="off"
                      ref={(el) => i() === 0 && setTimeout(() => el.focus({ preventScroll: true }), 80)}
                      onInput={(e) => setValues(f.id, e.currentTarget.value)}
                    />
                    <Show when={f.kind === 'password'}>
                      <IconButton
                        class="field-eye"
                        icon={reveal[f.id] ? 'visibility_off' : 'visibility'}
                        size={36}
                        iconSize={18}
                        title={reveal[f.id] ? 'Hide' : 'Show'}
                        onClick={() => setReveal(f.id, !reveal[f.id])}
                      />
                    </Show>
                  </div>
                </Match>
              </Switch>
            </div>
          )}
        </For>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ appearance (local)


/** Settings → Appearance: chat text scaling with presets and a live preview, and grouping chats by workspace. */
function AppearancePage() {
  const presets: [number, string][] = [
    [0.85, 'Small'],
    [1.0, 'Normal'],
    [1.15, 'Medium'],
    [1.3, 'Large'],
    [1.5, 'Huge'],
  ];
  const set = (v: number) => setUiPref('chatFontScale', Math.round(v * 100) / 100);
  return (
    <div class="settings-content gap16">
      <div class="scale-head">
        <div>
          <div class="settings-label">Chat Text Scaling ({Math.round(fontScale() * 100)}%)</div>
          <div class="hint">Scales messages, markdown, and code blocks</div>
        </div>
        <Show when={fontScale() !== 1}>
          <button class="text-btn small" onClick={() => set(1)}>
            Reset (1.0x)
          </button>
        </Show>
      </div>
      <div class="settings-card">
        <div class="slider-row">
          <span class="slider-a small">A</span>
          <input
            class="m-slider"
            type="range"
            min="0.75"
            max="1.6"
            step="0.05"
            value={fontScale()}
            style={{ '--fill': `${((fontScale() - 0.75) / 0.85) * 100}%` }}
            onInput={(e) => set(+e.currentTarget.value)}
          />
          <span class="slider-a big">A</span>
        </div>
        <div class="preset-row">
          <For each={presets}>
            {([v, label]) => (
              <button class="preset" classList={{ on: Math.abs(fontScale() - v) < 0.04 }} onClick={() => set(v)}>
                {label}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="settings-label sub">Live Preview</div>
      <div class="settings-card preview-card" style={{ '--chat-scale': String(fontScale()) }}>
        <div class="pv-user">How does AntiGem connect to the agents?</div>
        <div class="pv-assistant">The extension talks to each agent's own server and streams its steps and tool calls into this chat.</div>
      </div>
      <div class="settings-card toggle-card" onClick={() => setUi('groupByWorkspace', !state.ui.groupByWorkspace)}>
        <div class="toggle-row">
          <div class="item-label">
            <div class="item-title">Group Chats by Workspace</div>
            <div class="hint">Categorize chat history in the drawer under workspace folders</div>
          </div>
          <MSwitch checked={state.ui.groupByWorkspace} onChange={(v) => setUi('groupByWorkspace', v)} label="Group Chats by Workspace" />
        </div>
      </div>
    </div>
  );
}

