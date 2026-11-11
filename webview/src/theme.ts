// Which theme is on screen. Like the app's ThemeManager: a mode (VS Code / Auto / Light / Dark) plus the theme used for
// the light side and the one for the dark side. Auto follows VS Code's side (body class vscode-light / -dark /
// -high-contrast[-light]), or prefers-color-scheme in a browser; `?theme=light|dark` in the URL forces a side (dev).
// VS Code (the default) also takes VS Code's colors: a theme made live from the --vscode-* variables (outside VS Code,
// where they are missing, it behaves like Auto).
//
// Shared view prefs (UiPrefs) from the host:  theme: 'vscode' | 'auto' | 'light' | 'dark' | <theme id>,  lightTheme /
// darkTheme: theme ids, customThemes: CustomThemeJson[]. Before the first uiPrefs arrive the defaults apply from the
// stylesheet.
import { createEffect, createMemo, createRoot, createSignal, on } from 'solid-js';
import { host } from './host';
import type { UiPrefs } from '@shared/protocol';
import { BUILT_IN, cssVars, customFromJson, DARK_DEFAULT, LIGHT_DEFAULT, vscodeTheme, type AppTheme, type CustomThemeJson } from './themes';

export type ThemeMode = 'dark' | 'light';
export type ModeSetting = 'vscode' | 'auto' | 'light' | 'dark';
const MODES = ['vscode', 'auto', 'light', 'dark'];

const [systemSide, setSystemSide] = createSignal<ThemeMode>('dark');
/** Bumped when VS Code changes its theme colors (the --vscode-* variables on <html>). */
const [vscodeColors, setVscodeColors] = createSignal(0);
/** Where the chat is: VS Code paints the side bar and editor tabs with different backgrounds. */
const [surface, setSurface] = createSignal<'sidebar' | 'editor'>('sidebar');
export const setThemeSurface = (kind: 'sidebar' | 'panel' | 'browser') => setSurface(kind === 'sidebar' ? 'sidebar' : 'editor');
/** The shared prefs from the host (null until the first uiPrefs message). */
export const [uiPrefs, setUiPrefsSignal] = createSignal<UiPrefs | null>(null);

function detectSystem(): ThemeMode {
  const forced = new URLSearchParams(location.search).get('theme');
  if (forced === 'light' || forced === 'dark') return forced;
  const cls = document.body?.classList;
  if (cls) {
    if (cls.contains('vscode-high-contrast-light') || cls.contains('vscode-light')) return 'light';
    if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')) return 'dark';
  }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const state = createRoot(() => {
  const customThemes = createMemo<AppTheme[]>(() => {
    const raw = uiPrefs()?.customThemes;
    if (!Array.isArray(raw)) return [];
    return (raw as CustomThemeJson[]).map(customFromJson).filter((t): t is AppTheme => !!t);
  });
  const allThemes = createMemo(() => [...BUILT_IN, ...customThemes()]);
  const find = (id: unknown) => (typeof id === 'string' ? allThemes().find((t) => t.id === id) : undefined);

  /** VS Code / Auto / Light / Dark ('theme' may also be a theme id: that theme, fixed). */
  const modeSetting = createMemo<ModeSetting>(() => {
    const t = uiPrefs()?.theme;
    if (t == null) return 'vscode';
    if (MODES.includes(t)) return t as ModeSetting;
    const th = find(t);
    return th ? (th.dark ? 'dark' : 'light') : 'vscode';
  });
  const side = createMemo<ThemeMode>(() => {
    const m = modeSetting();
    return m === 'auto' || m === 'vscode' ? systemSide() : m;
  });
  /** VS Code mode's theme, made from the editor's colors (null outside VS Code). */
  const fromVscode = createMemo<AppTheme | null>(() => {
    if (modeSetting() !== 'vscode') return null;
    vscodeColors();
    const css = getComputedStyle(document.documentElement);
    return vscodeTheme(side() === 'dark', (n) => css.getPropertyValue(n), surface());
  });
  const lightId = createMemo(() => {
    const t = find(uiPrefs()?.theme);
    if (t && !t.dark) return t.id;
    const l = find(uiPrefs()?.lightTheme);
    return l && !l.dark ? l.id : LIGHT_DEFAULT;
  });
  const darkId = createMemo(() => {
    const t = find(uiPrefs()?.theme);
    if (t && t.dark) return t.id;
    const d = find(uiPrefs()?.darkTheme);
    return d && d.dark ? d.id : DARK_DEFAULT;
  });
  const current = createMemo(() => fromVscode() ?? find(side() === 'dark' ? darkId() : lightId())!);
  return { allThemes, modeSetting, side, lightId, darkId, current, fromVscode };
});

export const allThemes = state.allThemes;
export const themeModeSetting = state.modeSetting;
export const lightThemeId = state.lightId;
export const darkThemeId = state.darkId;
export const currentTheme = state.current;
/** VS Code mode is showing the editor's own colors (false outside VS Code, where it acts like Auto). */
export const matchingVscode = () => !!state.fromVscode();
/** The side on screen ('dark' | 'light'). */
export const themeMode = state.side;

let applied: string[] = [];

function apply() {
  const root = document.documentElement;
  const side = state.side();
  if (root.dataset.theme !== side) root.dataset.theme = side;
  // until the host sends prefs: VS Code's own colors (the default mode) when the webview has them, so the first paint
  // already matches the editor; elsewhere (dev browser page) the stylesheet's defaults (Midnight Aurora / Porcelain)
  for (const k of applied) root.style.removeProperty(k);
  applied = [];
  if (!uiPrefs() && !state.fromVscode()) return;
  const vars = cssVars(state.current(), state.allThemes());
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
    applied.push(k);
  }
}

/** A local change before the host echoes it (optimistic). */
export function patchUiPrefs(patch: Partial<UiPrefs>) {
  setUiPrefsSignal((p) => ({ theme: 'vscode', ...(p ?? {}), ...patch }) as UiPrefs);
}

export function initTheme() {
  setSystemSide(detectSystem());
  createRoot(() => {
    // re-apply whenever the side, the theme or the prefs change
    createMemo(() => {
      state.side();
      state.current();
      uiPrefs();
      apply();
    });
    // the side on screen now (theme_mcp's "on screen now" in auto mode): told to the host whenever it changes
    createEffect(
      on(state.side, (side) => {
        if ((uiPrefs() as { screenSide?: string } | null)?.screenSide === side) return;
        host.send({ type: 'setUiPref', key: 'screenSide', value: side });
      }),
    );
  });
  const update = () => {
    setSystemSide(detectSystem());
    setVscodeColors((n) => n + 1);
  };
  new MutationObserver(update).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  // VS Code rewrites its color variables on <html> when the user switches themes (no reload); our own theme
  // variables go there too, so only a change to a --vscode-* value counts
  let lastVscode = '';
  new MutationObserver(() => {
    const st = document.documentElement.getAttribute('style') ?? '';
    const vs = st
      .split(';')
      .filter((d) => d.trim().startsWith('--vscode-'))
      .join(';');
    if (vs === lastVscode) return;
    lastVscode = vs;
    setVscodeColors((n) => n + 1);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', update);
}

/** Settings → Appearance → Chat Text Scaling (0.75–1.6; scales the chat feed like the app's chatFontScale). */
export const fontScale = () => {
  const v = Number(uiPrefs()?.chatFontScale);
  return Number.isFinite(v) && v > 0 ? Math.min(1.6, Math.max(0.75, v)) : 1;
};

/** Which limit the composer's model pill shows: '5h' (default) or '7d' (Settings in the model picker). */
export const quotaPillWindow = () => (uiPrefs()?.quotaPillWindow === '7d' ? '7d' : '5h');
