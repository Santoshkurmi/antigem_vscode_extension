// Which theme is on screen. Like the app's ThemeManager: a mode (Auto / Light / Dark) plus the theme used for the light
// side and the one for the dark side. Auto follows VS Code (body class vscode-light / -dark / -high-contrast[-light]),
// or prefers-color-scheme in a browser; `?theme=light|dark` in the URL forces a side (dev).
//
// Shared view prefs (UiPrefs) from the host:  theme: 'auto' | 'light' | 'dark' | <theme id>,  lightTheme / darkTheme:
// theme ids, customThemes: CustomThemeJson[]. Before the first uiPrefs arrive the defaults apply from the stylesheet.
import { createMemo, createRoot, createSignal } from 'solid-js';
import type { UiPrefs } from '@shared/protocol';
import { BUILT_IN, cssVars, customFromJson, DARK_DEFAULT, LIGHT_DEFAULT, type AppTheme, type CustomThemeJson } from './themes';

export type ThemeMode = 'dark' | 'light';
export type ModeSetting = 'auto' | 'light' | 'dark';

const [systemSide, setSystemSide] = createSignal<ThemeMode>('dark');
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

  /** Auto / Light / Dark ('theme' may also be a theme id: that theme, fixed). */
  const modeSetting = createMemo<ModeSetting>(() => {
    const t = uiPrefs()?.theme;
    if (t === 'light' || t === 'dark' || t === 'auto' || t == null) return (t ?? 'auto') as ModeSetting;
    const th = find(t);
    return th ? (th.dark ? 'dark' : 'light') : 'auto';
  });
  const side = createMemo<ThemeMode>(() => {
    const m = modeSetting();
    return m === 'auto' ? systemSide() : m;
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
  const current = createMemo(() => find(side() === 'dark' ? darkId() : lightId())!);
  return { allThemes, modeSetting, side, lightId, darkId, current };
});

export const allThemes = state.allThemes;
export const themeModeSetting = state.modeSetting;
export const lightThemeId = state.lightId;
export const darkThemeId = state.darkId;
export const currentTheme = state.current;
/** The side on screen ('dark' | 'light'). */
export const themeMode = state.side;

let applied: string[] = [];

function apply() {
  const root = document.documentElement;
  const side = state.side();
  if (root.dataset.theme !== side) root.dataset.theme = side;
  // until the host sends prefs the stylesheet's defaults (Midnight Aurora / Porcelain) are what shows
  for (const k of applied) root.style.removeProperty(k);
  applied = [];
  if (!uiPrefs()) return;
  const vars = cssVars(state.current(), state.allThemes());
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
    applied.push(k);
  }
}

/** A local change before the host echoes it (optimistic). */
export function patchUiPrefs(patch: Partial<UiPrefs>) {
  setUiPrefsSignal((p) => ({ theme: 'auto', ...(p ?? {}), ...patch }) as UiPrefs);
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
  });
  const update = () => setSystemSide(detectSystem());
  new MutationObserver(update).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', update);
}

/** Settings → Appearance → Chat Text Scaling (0.75–1.6; scales the chat feed like the app's chatFontScale). */
export const fontScale = () => {
  const v = Number(uiPrefs()?.chatFontScale);
  return Number.isFinite(v) && v > 0 ? Math.min(1.6, Math.max(0.75, v)) : 1;
};

/** Which limit the composer's model pill shows: '5h' (default) or '7d' (Settings in the model picker). */
export const quotaPillWindow = () => (uiPrefs()?.quotaPillWindow === '7d' ? '7d' : '5h');
