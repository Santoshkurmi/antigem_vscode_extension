// ui/settings/ThemeGallery.kt (ThemeCard previews, light / dark grids), the Themes page's mode cards, and
// ui/settings/ThemeQuickPanel.kt (the floating switcher opened from the drawer).
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from 'solid-js';
import { DARK_DEFAULT, hex, LIGHT_DEFAULT, resolveTheme, type AppTheme } from '../themes';
import { allThemes, currentTheme, darkThemeId, lightThemeId, matchingVscode, themeMode, themeModeSetting, uiPrefs, type ModeSetting } from '../theme';
import { setThemePanelOpen, setUiPref, themePanelOpen } from '../state/settings';
import { Dialog, Icon, IconButton, type IconName } from '../ui/primitives';
import { alpha } from '../util/format';

/** Gallery pick (ThemeGallery.pick): the theme becomes its side's theme; a fixed mode switches to that side. */
export function pickTheme(t: AppTheme) {
  setUiPref(t.dark ? 'darkTheme' : 'lightTheme', t.id);
  const mode = themeModeSetting();
  const want = t.dark ? 'dark' : 'light';
  // picking a theme while matching VS Code: keep following VS Code's light / dark side, with this theme's colors
  if (mode === 'vscode') setUiPref('theme', 'auto');
  else if (mode !== 'auto' && mode !== want) setUiPref('theme', want);
  // a theme id in `theme` would pin the old one: keep `theme` a mode
  else if (mode === 'auto' && uiPrefs()?.theme && !['auto', 'light', 'dark'].includes(String(uiPrefs()?.theme))) setUiPref('theme', 'auto');
}

export function setThemeMode(mode: ModeSetting) {
  setUiPref('theme', mode);
}

/** A small live preview of a theme: background, a card with text lines and a button, your bubble, code and status. */
export function ThemeCard(props: { theme: AppTheme; selected: boolean; cardBg: string; width?: number; onClick: () => void; onDelete?: () => void }) {
  const c = createMemo(() => {
    const m = resolveTheme(props.theme, allThemes());
    return (k: string, d = 0xff888888) => hex(m[k] ?? d);
  });
  const isDefault = () => props.theme.id === LIGHT_DEFAULT || props.theme.id === DARK_DEFAULT;
  return (
    <button
      class="theme-card"
      classList={{ selected: props.selected }}
      style={{ background: props.cardBg, width: props.width ? `${props.width}px` : undefined }}
      onClick={props.onClick}
      title={props.theme.about}
    >
      <div class="theme-preview" style={{ background: c()('background') }}>
        <div class="tp-card" style={{ background: c()('card') }}>
          <span style={{ width: '80%', height: '5px', background: c()('on_background') }} />
          <span style={{ width: '55%', height: '4px', background: c()('text_secondary') }} />
          <span style={{ width: '30px', height: '10px', background: c()('primary') }} />
        </div>
        <span class="tp-bubble" style={{ background: c()('user_bubble') }} />
        <div class="tp-bottom">
          <span class="tp-code" style={{ background: c()('code_bg') }}>
            <span style={{ background: c()('syntax_keyword') }} />
            <span style={{ background: c()('syntax_string') }} />
            <span style={{ background: c()('syntax_function') }} />
          </span>
          <For each={['success', 'warning', 'danger', 'info']}>{(k) => <span class="tp-dot" style={{ background: c()(k) }} />}</For>
        </div>
        <Show when={isDefault()}>
          <span class="tp-star" style={{ 'border-color': c()('background') }} title="Default theme">
            <Icon name="star" size={11} />
          </span>
        </Show>
      </div>
      <div class="theme-card-foot">
        <span class="theme-card-names">
          <span class="theme-card-name">{props.theme.name}</span>
          <Show when={!props.theme.builtIn}>
            <span class="theme-card-custom">Custom</span>
          </Show>
        </span>
        <Show when={props.onDelete}>
          <span
            class="theme-card-del"
            role="button"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              props.onDelete!();
            }}
          >
            <Icon name="delete_o" size={18} />
          </span>
        </Show>
        <Show when={props.selected}>
          <Icon name="check_circle" size={18} color="var(--primary)" />
        </Show>
      </div>
    </button>
  );
}

/** Settings → Themes: the mode cards and the gallery of light and dark themes. */
export function ThemesPage() {
  const [toDelete, setToDelete] = createSignal<AppTheme | null>(null);
  const modes: [ModeSetting, string, IconName][] = [
    ['vscode', 'VS Code', 'code'],
    ['auto', 'Auto', 'brightness_auto'],
    ['light', 'Light', 'light_mode_o'],
    ['dark', 'Dark', 'dark_mode'],
  ];
  const vscode = () => themeModeSetting() === 'vscode';
  const modeHint = () =>
    vscode()
      ? matchingVscode()
        ? "Uses your VS Code theme's colors and follows it when you switch. Pick a theme below to use AntiGem's colors instead."
        : 'Outside VS Code this works like Auto.'
      : themeModeSetting() === 'auto'
        ? "Light or dark follows VS Code; the colors are the themes picked below."
        : null;
  const deleteCustom = (t: AppTheme) => {
    const list = (uiPrefs()?.customThemes as { id: string }[] | undefined) ?? [];
    setUiPref('customThemes', list.filter((x) => x.id !== t.id));
    if (lightThemeId() === t.id) setUiPref('lightTheme', LIGHT_DEFAULT);
    if (darkThemeId() === t.id) setUiPref('darkTheme', DARK_DEFAULT);
  };
  return (
    <div class="settings-content gap16">
      <div class="settings-label">Color Theme</div>
      <div class="mode-cards">
        <For each={modes}>
          {([mode, label, icon]) => (
            <button class="mode-card" classList={{ on: themeModeSetting() === mode }} onClick={() => setThemeMode(mode)}>
              <Icon name={icon} size={24} />
              <span>{label}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={modeHint()}>
        <div class="gallery-hint mode-hint">{modeHint()}</div>
      </Show>
      <div class="gallery" classList={{ dimmed: vscode() && matchingVscode() }}>
        <GalleryHeader title="Light theme" hint="Used in Light mode, and by Auto when VS Code is light." />
        <ThemeGrid themes={allThemes().filter((t) => !t.dark)} selected={vscode() && matchingVscode() ? '' : lightThemeId()} onDelete={setToDelete} />
        <GalleryHeader title="Dark theme" hint="Used in Dark mode, and by Auto when VS Code is dark." />
        <ThemeGrid themes={allThemes().filter((t) => t.dark)} selected={vscode() && matchingVscode() ? '' : darkThemeId()} onDelete={setToDelete} />
        <div class="gallery-note">
          Make your own: add the Theme preset in MCP Servers and ask any chat, e.g. “create a neon cyberpunk dark theme and apply
          it”.
        </div>
      </div>
      <Dialog
        open={!!toDelete()}
        onClose={() => setToDelete(null)}
        title={`Delete “${toDelete()?.name ?? ''}”?`}
        actions={
          <>
            <button class="text-btn" onClick={() => setToDelete(null)}>
              Cancel
            </button>
            <button
              class="text-btn"
              onClick={() => {
                const t = toDelete();
                setToDelete(null);
                if (t) deleteCustom(t);
              }}
            >
              Delete
            </button>
          </>
        }
      >
        This custom theme is removed. If it is in use, the default theme takes its place.
      </Dialog>
    </div>
  );
}

function GalleryHeader(props: { title: string; hint: string }) {
  return (
    <div class="gallery-head">
      <div class="gallery-title">{props.title}</div>
      <div class="gallery-hint">{props.hint}</div>
    </div>
  );
}

function ThemeGrid(props: { themes: AppTheme[]; selected: string; onDelete: (t: AppTheme) => void }) {
  return (
    <div class="theme-grid">
      <For each={props.themes}>
        {(t) => (
          <ThemeCard
            theme={t}
            selected={t.id === props.selected}
            cardBg="var(--card)"
            onClick={() => pickTheme(t)}
            onDelete={t.builtIn ? undefined : () => props.onDelete(t)}
          />
        )}
      </For>
    </div>
  );
}

/** ThemeQuickPanel: a floating strip of the side's themes; a tap applies at once, the app changes behind it. */
export function ThemeQuickPanel() {
  const dark = () => themeMode() === 'dark';
  const selectedId = () => (themeModeSetting() === 'vscode' && matchingVscode() ? '' : dark() ? darkThemeId() : lightThemeId());
  const themes = () => allThemes().filter((t) => t.dark === dark());
  let list: HTMLDivElement | undefined;
  const scrollToSelected = () => {
    const i = themes().findIndex((t) => t.id === selectedId());
    const el = list?.children[Math.max(0, i - 1)] as HTMLElement | undefined;
    if (el && list) list.scrollLeft = el.offsetLeft - 12;
  };
  // show the theme in use (with one neighbour before it) when the side changes
  createEffect(on(themeMode, () => requestAnimationFrame(() => requestAnimationFrame(scrollToSelected)), { defer: true }));
  const options: [ModeSetting, string, IconName][] = [
    ['vscode', 'VS Code', 'code'],
    ['auto', 'Auto', 'brightness_auto'],
    ['light', 'Light', 'light_mode_o'],
    ['dark', 'Dark', 'dark_mode'],
  ];
  return (
    <Show when={themePanelOpen()}>
      <div class="theme-panel" onKeyDown={(e) => e.key === 'Escape' && setThemePanelOpen(false)}>
        <div class="theme-panel-head">
          <Icon name="palette" size={18} color="var(--primary)" />
          <span class="theme-panel-title">Themes</span>
          <span class="flex1" />
          <div class="mode-toggle">
            <For each={options}>
              {([mode, label, icon]) => (
                <button
                  class="mode-pill"
                  classList={{ on: themeModeSetting() === mode }}
                  title={label}
                  onClick={() => setThemeMode(mode)}
                >
                  <Icon name={icon} size={13} />
                  <span class="mode-pill-label">{label}</span>
                </button>
              )}
            </For>
          </div>
          <IconButton icon="close_o" size={36} iconSize={18} color={alpha('var(--on-surface)', 0.7)} title="Close" onClick={() => setThemePanelOpen(false)} />
        </div>
        <div class="theme-panel-hint">Tap a theme to try it: the app changes behind this panel.</div>
        <div
          class="theme-panel-list"
          ref={(el) => {
            list = el;
            onMount(() => requestAnimationFrame(scrollToSelected));
          }}
        >
          <For each={themes()}>
            {(t) => <ThemeCard theme={t} selected={t.id === selectedId()} cardBg="var(--surface)" width={138} onClick={() => pickTheme(t)} />}
          </For>
        </div>
      </div>
    </Show>
  );
}

export const themeName = () => currentTheme()?.name ?? (themeMode() === 'dark' ? 'Midnight Aurora' : 'Porcelain');
