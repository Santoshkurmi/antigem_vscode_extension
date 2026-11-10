// The app's themes (theme/AppTheme.kt: ThemeTokens + BuiltInThemes, theme/ThemeManager.kt: resolve), ported as data:
// every built-in theme, the rules that work out dependent colors from a few seeds (Compose's lerp is in Oklab, so is
// this one), Material 3's baseline schemes for the slots a theme leaves unset, and custom themes (theme_mcp's JSON).

export interface AppTheme {
  id: string;
  name: string;
  dark: boolean;
  about: string;
  builtIn: boolean;
  /** Custom themes: the theme they build on. */
  base?: string | null;
  /** token → 0xAARRGGBB */
  colors: Record<string, number>;
}

/** A custom theme as theme_mcp / the host stores it: hex colors. */
export interface CustomThemeJson {
  id: string;
  name: string;
  dark: boolean;
  about?: string;
  base?: string | null;
  colors: Record<string, string>;
}

export const LIGHT_DEFAULT = 'antigem_light';
export const DARK_DEFAULT = 'midnight_aurora';

// ------------------------------------------------------------------------------------------------ color math

const ch = (c: number, shift: number) => ((c >>> shift) & 0xff) / 255;
const toArgb = (r: number, g: number, b: number, a = 1) =>
  ((Math.round(clamp(a) * 255) << 24) | (Math.round(clamp(r) * 255) << 16) | (Math.round(clamp(g) * 255) << 8) | Math.round(clamp(b) * 255)) >>> 0;
function clamp(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function toOklab(c: number): [number, number, number, number] {
  const r = toLinear(ch(c, 16));
  const g = toLinear(ch(c, 8));
  const b = toLinear(ch(c, 0));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ch(c, 24),
  ];
}

function fromOklab(L: number, A: number, B: number, alpha: number): number {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return toArgb(toGamma(clamp(r)), toGamma(clamp(g)), toGamma(clamp(b)), alpha);
}

/** androidx.compose.ui.graphics.lerp: interpolation in Oklab. */
export function lerp(a: number, b: number, t: number): number {
  const x = toOklab(a);
  const y = toOklab(b);
  return fromOklab(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t, x[3] + (y[3] - x[3]) * t);
}

export function luminance(c: number): number {
  return 0.2126 * toLinear(ch(c, 16)) + 0.7152 * toLinear(ch(c, 8)) + 0.0722 * toLinear(ch(c, 0));
}

export function contrast(a: number, b: number): number {
  const la = luminance(a) + 0.05;
  const lb = luminance(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

export function hex(c: number): string {
  const a = (c >>> 24) & 0xff;
  const rgb = (c & 0xffffff).toString(16).padStart(6, '0');
  return a === 0xff ? `#${rgb}` : `#${rgb}${a.toString(16).padStart(2, '0')}`;
}

/** "#RRGGBB", "#AARRGGBB", "RRGGBB" or "0xAARRGGBB" (ThemeTokens.parse). */
export function parseHex(text: string): number | null {
  const t = text.trim().replace(/^#/, '').replace(/^0x/i, '');
  if (!/^([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(t)) return null;
  const v = parseInt(t, 16) >>> 0;
  return t.length === 6 ? (0xff000000 | v) >>> 0 : v;
}

// ------------------------------------------------------------------------------------------------ tokens + rules

const WHITE = 0xffffffff;
const BLACK = 0xff111111; // ThemeTokens' "near black"
const PURE_BLACK = 0xff000000;

export const MATERIAL_KEYS = new Set([
  'primary', 'on_primary', 'primary_container', 'on_primary_container', 'secondary', 'on_secondary', 'secondary_container',
  'on_secondary_container', 'tertiary', 'on_tertiary', 'tertiary_container', 'on_tertiary_container', 'background',
  'on_background', 'surface', 'on_surface', 'surface_variant', 'on_surface_variant', 'surface_container_lowest',
  'surface_container_low', 'surface_container', 'surface_container_high', 'surface_container_highest', 'outline',
  'outline_variant', 'error', 'on_error', 'error_container', 'on_error_container', 'inverse_surface', 'inverse_on_surface',
  'inverse_primary',
]);

/** Text color for a fill: whichever of near-black and white reads better on it. */
const on = (c: number) => (contrast(c, BLACK) >= contrast(c, WHITE) ? BLACK : WHITE);

type Rule = [key: string, sources: string[], compute: (m: Record<string, number>, d: boolean) => number];

const RULES: Rule[] = [
  ['on_primary', ['primary'], (m) => on(m.primary)],
  ['primary_container', ['primary', 'surface'], (m, d) => lerp(m.surface, m.primary, d ? 0.3 : 0.18)],
  ['on_primary_container', ['primary'], (m, d) => lerp(m.primary, d ? WHITE : BLACK, d ? 0.35 : 0.45)],
  ['inverse_primary', ['primary'], (m) => m.primary],
  ['on_secondary', ['secondary'], (m) => on(m.secondary)],
  ['secondary_container', ['secondary', 'surface'], (m, d) => lerp(m.surface, m.secondary, d ? 0.3 : 0.18)],
  ['on_secondary_container', ['secondary'], (m, d) => lerp(m.secondary, d ? WHITE : BLACK, d ? 0.35 : 0.45)],
  ['on_tertiary', ['tertiary'], (m) => on(m.tertiary)],
  ['tertiary_container', ['tertiary', 'surface'], (m, d) => lerp(m.surface, m.tertiary, d ? 0.3 : 0.18)],
  ['on_tertiary_container', ['tertiary'], (m, d) => lerp(m.tertiary, d ? WHITE : BLACK, d ? 0.35 : 0.45)],
  ['on_surface', ['on_background'], (m) => m.on_background],
  ['text_secondary', ['on_surface_variant'], (m) => m.on_surface_variant],
  ['outline', ['on_surface_variant', 'background'], (m) => lerp(m.on_surface_variant, m.background, 0.25)],
  ['outline_variant', ['on_background', 'background'], (m, d) => lerp(m.background, m.on_background, d ? 0.18 : 0.14)],
  ['surface_container_lowest', ['background'], (m, d) => lerp(m.background, d ? PURE_BLACK : WHITE, d ? 0.3 : 0.6)],
  ['surface_container_low', ['background', 'card'], (m) => lerp(m.background, m.card, 0.5)],
  ['surface_container', ['card'], (m) => m.card],
  ['surface_container_high', ['card', 'on_background'], (m, d) => lerp(m.card, m.on_background, d ? 0.06 : 0.04)],
  ['surface_container_highest', ['card', 'on_background'], (m, d) => lerp(m.card, m.on_background, d ? 0.1 : 0.07)],
  ['inverse_surface', ['on_background'], (m) => m.on_background],
  ['inverse_on_surface', ['background'], (m) => m.background],
  ['error', ['danger'], (m) => m.danger],
  ['on_error', ['danger'], (m) => on(m.danger)],
  ['error_container', ['danger', 'surface'], (m, d) => lerp(m.surface, m.danger, d ? 0.28 : 0.15)],
  ['on_error_container', ['danger'], (m, d) => lerp(m.danger, d ? WHITE : BLACK, d ? 0.3 : 0.4)],
  ['user_bubble', ['surface_variant'], (m) => m.surface_variant],
  ['thinking_bg', ['surface_variant', 'background'], (m) => lerp(m.surface_variant, m.background, 0.45)],
  ['code_text', ['code_bg'], (m) => (luminance(m.code_bg) < 0.5 ? 0xffe6e6e6 : 0xff1f2328)],
  ['accent_alt', ['tertiary'], (m) => m.tertiary],
  ['syntax_control', ['syntax_keyword'], (m) => m.syntax_keyword],
  ['syntax_tag', ['syntax_function'], (m) => m.syntax_function],
  ['syntax_attribute', ['syntax_type'], (m) => m.syntax_type],
  ['border', ['card', 'on_background'], (m, d) => lerp(m.card, m.on_background, d ? 0.14 : 0.11)],
  ['fill', ['card', 'on_background'], (m, d) => lerp(m.card, m.on_background, d ? 0.07 : 0.05)],
  ['success_container', ['success', 'surface'], (m, d) => lerp(m.surface, m.success, d ? 0.18 : 0.12)],
  ['warning_container', ['warning', 'surface'], (m, d) => lerp(m.surface, m.warning, d ? 0.18 : 0.12)],
  ['danger_container', ['danger', 'surface'], (m, d) => lerp(m.surface, m.danger, d ? 0.18 : 0.12)],
  ['info_container', ['info', 'surface'], (m, d) => lerp(m.surface, m.info, d ? 0.18 : 0.12)],
  ['accent_indigo', ['info', 'accent_alt'], (m) => lerp(m.info, m.accent_alt, 0.5)],
  ['accent_teal', ['info', 'success'], (m) => lerp(m.info, m.success, 0.45)],
  ['accent_pink', ['danger', 'accent_alt'], (m) => lerp(m.danger, m.accent_alt, 0.4)],
  ['editor_bg', ['code_bg'], (m) => m.code_bg],
  ['editor_text', ['code_text'], (m) => m.code_text],
  ['editor_panel', ['editor_bg', 'editor_text'], (m) => lerp(m.editor_bg, m.editor_text, 0.05)],
  ['editor_line', ['editor_bg', 'editor_text'], (m) => lerp(m.editor_bg, m.editor_text, 0.08)],
  ['editor_border', ['editor_bg', 'editor_text'], (m) => lerp(m.editor_bg, m.editor_text, 0.15)],
  ['editor_muted', ['editor_bg', 'editor_text'], (m) => lerp(m.editor_bg, m.editor_text, 0.5)],
  ['editor_selection', ['editor_bg', 'primary'], (m) => lerp(m.editor_bg, m.primary, 0.32)],
  ['editor_added_bg', ['editor_bg', 'success'], (m) => lerp(m.editor_bg, m.success, 0.22)],
  ['editor_added_text', ['editor_text', 'success'], (m) => lerp(m.success, m.editor_text, 0.5)],
  ['editor_removed_bg', ['editor_bg', 'danger'], (m) => lerp(m.editor_bg, m.danger, 0.22)],
  ['editor_removed_text', ['editor_text', 'danger'], (m) => lerp(m.danger, m.editor_text, 0.5)],
  ['editor_info_bg', ['editor_bg', 'info'], (m) => lerp(m.editor_bg, m.info, 0.18)],
  ['editor_info_text', ['editor_text', 'info'], (m) => lerp(m.info, m.editor_text, 0.3)],
  ['terminal_bg', ['code_bg'], (m) => m.code_bg],
  ['terminal_fg', ['code_text'], (m) => m.code_text],
  ['terminal_cursor', ['primary'], (m) => m.primary],
];

/** ThemeTokens.derive: works out again every color that depends on a changed one, in rule order. */
export function derive(map: Record<string, number>, changed: Set<string>, dark: boolean) {
  const touched = new Set(changed);
  for (const [key, sources, compute] of RULES) {
    if (changed.has(key)) continue;
    if (!sources.some((s) => touched.has(s))) continue;
    if (sources.some((s) => map[s] === undefined)) continue;
    map[key] = compute(map, dark);
    touched.add(key);
  }
}

// Material 3's baseline schemes: the slots a theme leaves unset (lightColorScheme() / darkColorScheme())
const M3_LIGHT: Record<string, number> = {
  primary: 0xff6750a4, on_primary: 0xffffffff, primary_container: 0xffeaddff, on_primary_container: 0xff4f378b,
  inverse_primary: 0xffd0bcff, secondary: 0xff625b71, on_secondary: 0xffffffff, secondary_container: 0xffe8def8,
  on_secondary_container: 0xff4a4458, tertiary: 0xff7d5260, on_tertiary: 0xffffffff, tertiary_container: 0xffffd8e4,
  on_tertiary_container: 0xff633b48, background: 0xfffef7ff, on_background: 0xff1d1b20, surface: 0xfffef7ff,
  on_surface: 0xff1d1b20, surface_variant: 0xffe7e0ec, on_surface_variant: 0xff49454f, inverse_surface: 0xff322f35,
  inverse_on_surface: 0xfff5eff7, error: 0xffb3261e, on_error: 0xffffffff, error_container: 0xfff9dedc,
  on_error_container: 0xff8c1d18, outline: 0xff79747e, outline_variant: 0xffcac4d0, surface_container_lowest: 0xffffffff,
  surface_container_low: 0xfff7f2fa, surface_container: 0xfff3edf7, surface_container_high: 0xffece6f0,
  surface_container_highest: 0xffe6e0e9,
};
const M3_DARK: Record<string, number> = {
  primary: 0xffd0bcff, on_primary: 0xff381e72, primary_container: 0xff4f378b, on_primary_container: 0xffeaddff,
  inverse_primary: 0xff6750a4, secondary: 0xffccc2dc, on_secondary: 0xff332d41, secondary_container: 0xff4a4458,
  on_secondary_container: 0xffe8def8, tertiary: 0xffefb8c8, on_tertiary: 0xff492532, tertiary_container: 0xff633b48,
  on_tertiary_container: 0xffffd8e4, background: 0xff141218, on_background: 0xffe6e0e9, surface: 0xff141218,
  on_surface: 0xffe6e0e9, surface_variant: 0xff49454f, on_surface_variant: 0xffcac4d0, inverse_surface: 0xffe6e0e9,
  inverse_on_surface: 0xff322f35, error: 0xfff2b8b5, on_error: 0xff601410, error_container: 0xff8c1d18,
  on_error_container: 0xfff9dedc, outline: 0xff938f99, outline_variant: 0xff49454f, surface_container_lowest: 0xff0f0d13,
  surface_container_low: 0xff1d1b20, surface_container: 0xff211f26, surface_container_high: 0xff2b2930,
  surface_container_highest: 0xff36343b,
};

// ------------------------------------------------------------------------------------------------ built-in themes

const SYNTAX_KEYS = ['syntax_keyword', 'syntax_type', 'syntax_string', 'syntax_number', 'syntax_comment', 'syntax_function', 'syntax_annotation', 'syntax_punctuation'];
const ONE_DARK = [0xffc678dd, 0xffe5c07b, 0xff98c379, 0xffd19a66, 0xff7f848e, 0xff61afef, 0xffe5c07b, 0xffabb2bf];

/** The original AntiGem look ("Porcelain" light / "Amber Night" dark). */
function antigem(dark: boolean): AppTheme {
  const c: Record<string, number> = { primary: 0xffd97706, secondary: 0xffb45309, on_primary: 0xffffffff };
  if (dark) {
    Object.assign(c, { background: 0xff181816, surface: 0xff181816, on_background: 0xfff5f5f4, on_surface: 0xfff5f5f4, surface_variant: 0xff32312d, card: 0xff232320, text_secondary: 0xffa8a29e, user_bubble: 0xff32312d, thinking_bg: 0xff282724 });
  } else {
    Object.assign(c, { background: 0xfff9f9fb, surface: 0xfff9f9fb, on_background: 0xff1c1917, on_surface: 0xff1c1917, surface_variant: 0xffe8eaed, card: 0xffffffff, text_secondary: 0xff78716c, user_bubble: 0xffe8eaed, thinking_bg: 0xfff1f3f5 });
  }
  Object.assign(c, { code_bg: 0xff1e1e1c, code_text: 0xfff5f5f4, success: 0xff16a34a, warning: 0xffd97706, danger: 0xffdc2626, info: 0xff3b82f6, accent_alt: 0xff8b5cf6 });
  SYNTAX_KEYS.forEach((k, i) => (c[k] = ONE_DARK[i]));
  Object.assign(c, { syntax_control: 0xffc678dd, syntax_tag: 0xffe06c75, syntax_attribute: 0xffd19a66 });
  if (dark) {
    Object.assign(c, { border: 0xff34332f, fill: 0xff2c2c2a, success_container: 0xff143324, warning_container: 0xff451a03, danger_container: 0xff381919, info_container: 0xff1e2a44 });
  } else {
    Object.assign(c, { border: 0xffe5e7eb, fill: 0xfff3f4f6, success_container: 0xffe8f5e9, warning_container: 0xfffff3e0, danger_container: 0xfffef2f2, info_container: 0xffe3f2fd });
  }
  Object.assign(c, {
    accent_indigo: 0xff6366f1, accent_teal: 0xff00acc1, accent_pink: 0xffec4899,
    editor_bg: 0xff1e1e1e, editor_panel: 0xff252526, editor_text: 0xffd4d4d4, editor_muted: 0xff888888, editor_border: 0xff3c3c3c,
    editor_selection: 0xff264f78, editor_line: 0xff2d2d2d, editor_added_bg: 0xff1b4728, editor_added_text: 0xffb9f6ca,
    editor_removed_bg: 0xff4b1e1e, editor_removed_text: 0xffffcdd2, editor_info_bg: 0xff1e293b, editor_info_text: 0xff90caf9,
    terminal_bg: 0xff000000, terminal_fg: 0xffffffff, terminal_cursor: 0xffffffff,
  });
  return {
    id: dark ? 'antigem_dark' : LIGHT_DEFAULT,
    name: dark ? 'Amber Night' : 'Porcelain',
    dark,
    builtIn: true,
    about: dark ? "AntiGem's original warm dark look with the amber accent" : "AntiGem's original clean light look with the amber accent",
    colors: c,
  };
}

function midnightAurora(): AppTheme {
  const c: Record<string, number> = {
    primary: 0xffa78bfa, on_primary: 0xff14102b, primary_container: 0xff373256, on_primary_container: 0xffc4b5fe,
    secondary: 0xff7c6ae6, on_secondary: 0xff111111, secondary_container: 0xff2c2a52, on_secondary_container: 0xffa6a0f2,
    tertiary: 0xff5eead4, on_tertiary: 0xff111111, tertiary_container: 0xff28494d, on_tertiary_container: 0xffa2f2e3,
    background: 0xff0a0b14, on_background: 0xffe8eaf6, surface: 0xff0f111c, on_surface: 0xffe8eaf6,
    surface_variant: 0xff1c2033, on_surface_variant: 0xff9aa1bf, surface_container_lowest: 0xff030408,
    surface_container_low: 0xff0f111d, surface_container: 0xff151826, surface_container_high: 0xff1f2231,
    surface_container_highest: 0xff262938, outline: 0xff3a4066, outline_variant: 0xff23283f, error: 0xfffb7185,
    on_error: 0xff111111, error_container: 0xff492b38, on_error_container: 0xffff9ea9, inverse_surface: 0xffe8eaf6,
    inverse_on_surface: 0xff0a0b14, inverse_primary: 0xffa78bfa, card: 0xff151826, text_secondary: 0xff9aa1bf,
    user_bubble: 0xff252a47, thinking_bg: 0xff12152a, code_bg: 0xff0c0e19, code_text: 0xffd6dbf5, success: 0xff4ade80,
    warning: 0xfffbbf24, danger: 0xfffb7185, info: 0xff60a5fa, accent_alt: 0xffc084fc, syntax_keyword: 0xffc4a7ff,
    syntax_type: 0xff5eead4, syntax_string: 0xff9ae6b4, syntax_number: 0xffffb86b, syntax_comment: 0xff5b6285,
    syntax_function: 0xff7db5ff, syntax_annotation: 0xfff4a9d8, syntax_punctuation: 0xff8991b3, syntax_control: 0xffc4a7ff,
    syntax_tag: 0xff7db5ff, syntax_attribute: 0xff5eead4, border: 0xff2d313f, fill: 0xff212432,
    success_container: 0xff1c302e, warning_container: 0xff322d27, danger_container: 0xff34222e, info_container: 0xff1d283e,
    accent_indigo: 0xff818cf8, accent_teal: 0xff2dd4bf, accent_pink: 0xfff472b6, editor_bg: 0xff0c0e19,
    editor_panel: 0xff141622, editor_text: 0xffd6dbf5, editor_muted: 0xff676b7e, editor_border: 0xff252735,
    editor_selection: 0xff373258, editor_line: 0xff191b27, editor_added_bg: 0xff1c3530, editor_added_text: 0xff9cdebd,
    editor_removed_bg: 0xff39232f, editor_removed_text: 0xffefaabd, editor_info_bg: 0xff1a253b, editor_info_text: 0xff86b6fa,
    terminal_bg: 0xff0c0e19, terminal_fg: 0xffd6dbf5, terminal_cursor: 0xffa78bfa,
  };
  return { id: DARK_DEFAULT, name: 'Midnight Aurora', dark: true, builtIn: true, about: 'Deep ink-blue midnight with luminous violet, aurora teal and rose accents', colors: c };
}

/** A full theme from a few colors; everything else is worked out (BuiltInThemes.seeded). */
function seeded(
  id: string, name: string, about: string, dark: boolean,
  [bg, surface, card, variant, text, muted, primary, secondary, tertiary, success, warning, danger, info, codeBg]: number[],
  syntax: number[],
): AppTheme {
  const m: Record<string, number> = {
    background: bg, surface, card, surface_variant: variant, on_background: text, on_surface_variant: muted, primary,
    secondary, tertiary, success, warning, danger, info, code_bg: codeBg,
  };
  SYNTAX_KEYS.forEach((k, i) => (m[k] = syntax[i]));
  derive(m, new Set(Object.keys(m)), dark);
  return { id, name, about, dark, builtIn: true, colors: m };
}

export const BUILT_IN: AppTheme[] = [
  // light, best first: the first is the default
  antigem(false),
  seeded('lavender', 'Lavender', 'Soft lilac with a violet accent', false,
    [0xfff8f6fd, 0xfff8f6fd, 0xffffffff, 0xffece7f8, 0xff241b3a, 0xff655b7f, 0xff7c3aed, 0xffa855f7, 0xffdb2777, 0xff15803d, 0xffb45309, 0xffdc2626, 0xff2563eb, 0xff1e1830],
    [0xffd8b4fe, 0xfffde68a, 0xffa7f3d0, 0xfffdba74, 0xff7e7396, 0xff93c5fd, 0xfffde68a, 0xffe4ddf5]),
  seeded('sky', 'Sky', 'Crisp, airy light blue', false,
    [0xfff5f8fc, 0xfff5f8fc, 0xffffffff, 0xffe3ebf5, 0xff0f1b2d, 0xff52637a, 0xff2563eb, 0xff0ea5e9, 0xff7c3aed, 0xff16a34a, 0xffb45309, 0xffdc2626, 0xff0284c7, 0xff0f172a],
    [0xffc792ea, 0xffffcb6b, 0xffa3e4a1, 0xfff9a87a, 0xff64748b, 0xff82aaff, 0xffffcb6b, 0xffcbd5e1]),
  seeded('sakura', 'Sakura', 'Soft cherry-blossom pink with a magenta accent', false,
    [0xfffff7f9, 0xfffff7f9, 0xffffffff, 0xfffbe4ea, 0xff3b1f2b, 0xff7f5a68, 0xffdb2777, 0xffc026d3, 0xff7c3aed, 0xff15803d, 0xffb45309, 0xffdc2626, 0xff2563eb, 0xff2a1520],
    [0xfff472b6, 0xfffcd34d, 0xff86efac, 0xfffdba74, 0xff9c7b88, 0xff93c5fd, 0xfffcd34d, 0xfff3e8ee]),
  seeded('mint', 'Mint', 'Fresh, clean light green', false,
    [0xfff4fbf8, 0xfff4fbf8, 0xffffffff, 0xffddf2ea, 0xff10231b, 0xff4b6858, 0xff059669, 0xff0d9488, 0xff7c3aed, 0xff15803d, 0xffb45309, 0xffdc2626, 0xff0369a1, 0xff0f1e19],
    [0xffc4b5fd, 0xfffde68a, 0xffa7f3d0, 0xfffdba74, 0xff6b8a7a, 0xff7dd3fc, 0xfffde68a, 0xffd1e7dd]),
  seeded('linen', 'Linen', 'Warm minimal off-white with a burnt-orange accent', false,
    [0xfffbf8f3, 0xfffbf8f3, 0xffffffff, 0xfff0ebe3, 0xff26211c, 0xff6f6861, 0xffc2410c, 0xffea580c, 0xff7c3aed, 0xff15803d, 0xffb45309, 0xffdc2626, 0xff1d4ed8, 0xff1f1b18],
    [0xffe4a7f0, 0xfff2cc8f, 0xffb7d99a, 0xfff5a97f, 0xff8a8078, 0xff8fc2f0, 0xfff2cc8f, 0xffe6ded5]),
  seeded('paper', 'Paper', 'Warm sepia paper with a rust accent, easy on the eyes', false,
    [0xfff7f1e3, 0xfff7f1e3, 0xfffffaef, 0xffece3ce, 0xff2b2418, 0xff6e6250, 0xff9a3412, 0xffb45309, 0xff4d7c0f, 0xff4d7c0f, 0xffb45309, 0xffb91c1c, 0xff1d4ed8, 0xff2b2418],
    [0xfff0a6ca, 0xfff2d58a, 0xffb5d49a, 0xfff4b183, 0xff8c7f67, 0xff9cc3e6, 0xfff2d58a, 0xffe8dfcc]),
  seeded('solarized_light', 'Solarized Light', 'The classic low-glare cream palette', false,
    [0xfffdf6e3, 0xfffdf6e3, 0xfffffbef, 0xffeee8d5, 0xff073642, 0xff586e75, 0xff268bd2, 0xff2aa198, 0xff6c71c4, 0xff859900, 0xffb58900, 0xffdc322f, 0xff268bd2, 0xff002b36],
    [0xff859900, 0xffb58900, 0xff2aa198, 0xffd33682, 0xff657b83, 0xff268bd2, 0xffcb4b16, 0xff93a1a1]),
  // dark: the same
  midnightAurora(),
  seeded('obsidian', 'Obsidian', 'Refined deep black with layered surfaces and a soft periwinkle glow', true,
    [0xff0d0e12, 0xff0d0e12, 0xff16181d, 0xff1f2229, 0xffecedf0, 0xff9297a3, 0xff8b9cff, 0xff6e7ff3, 0xffc4a1ff, 0xff4ade80, 0xfff5b454, 0xfff87171, 0xff60a5fa, 0xff111318],
    [0xffc4a1ff, 0xff7dd3fc, 0xff9fe2b0, 0xfff9b98a, 0xff5e6573, 0xff8bb4ff, 0xfff5d08a, 0xffb8bdc8]),
  seeded('graphite', 'Graphite', "Warm charcoal with a glowing amber accent: AntiGem's look, refined", true,
    [0xff121212, 0xff121212, 0xff1b1b1c, 0xff262628, 0xffedebe8, 0xffa29e98, 0xfff0a04b, 0xffd9822b, 0xffb794f4, 0xff5bd18a, 0xfff4c152, 0xffef6b6b, 0xff6cb4f2, 0xff161616],
    [0xffc678dd, 0xffe5c07b, 0xff98c379, 0xffd19a66, 0xff6b717d, 0xff61afef, 0xffe5c07b, 0xffabb2bf]),
  seeded('midnight', 'Midnight', 'Pure black for OLED screens, with an electric cyan accent', true,
    [0xff000000, 0xff000000, 0xff0f1115, 0xff1a1d24, 0xffeceff4, 0xff9aa3b2, 0xff22d3ee, 0xff0891b2, 0xffa78bfa, 0xff22c55e, 0xfff59e0b, 0xfff43f5e, 0xff60a5fa, 0xff0a0c10],
    [0xffc792ea, 0xffffcb6b, 0xffc3e88d, 0xfff78c6c, 0xff5c6370, 0xff82aaff, 0xffffcb6b, 0xffa6accd]),
  seeded('high_contrast', 'High Contrast', 'Maximum readability: white on black with bold yellow', true,
    [0xff000000, 0xff000000, 0xff0d0d0d, 0xff1f1f1f, 0xffffffff, 0xffd4d4d4, 0xffffd60a, 0xff00e5ff, 0xffff6eff, 0xff00e676, 0xffffc400, 0xffff5252, 0xff40c4ff, 0xff000000],
    [0xffff6eff, 0xffffd60a, 0xff00e676, 0xffff9e40, 0xffbdbdbd, 0xff40c4ff, 0xffffd60a, 0xffffffff]),
  antigem(true),
  seeded('mocha', 'Mocha', 'Cozy pastel dark: lavender, pink and sky on deep cocoa-blue', true,
    [0xff1e1e2e, 0xff1e1e2e, 0xff252536, 0xff313244, 0xffcdd6f4, 0xffa6adc8, 0xffcba6f7, 0xfff5c2e7, 0xff89b4fa, 0xffa6e3a1, 0xfff9e2af, 0xfff38ba8, 0xff89dceb, 0xff181825],
    [0xffcba6f7, 0xfff9e2af, 0xffa6e3a1, 0xfffab387, 0xff7f849c, 0xff89b4fa, 0xfff5c2e7, 0xffbac2de]),
  seeded('neon_city', 'Neon City', 'Night-time city blues with electric violet', true,
    [0xff1a1b26, 0xff1a1b26, 0xff1f2335, 0xff292e42, 0xffc0caf5, 0xff8b93b8, 0xff7aa2f7, 0xffbb9af7, 0xff7dcfff, 0xff9ece6a, 0xffe0af68, 0xfff7768e, 0xff7dcfff, 0xff16161e],
    [0xffbb9af7, 0xff2ac3de, 0xff9ece6a, 0xffff9e64, 0xff6a72a0, 0xff7aa2f7, 0xffe0af68, 0xffa9b1d6]),
  seeded('aurora', 'Aurora', 'Northern-lights teal and violet over a deep night sky', true,
    [0xff0b1118, 0xff0b1118, 0xff121a23, 0xff1a2530, 0xffe3ecf2, 0xff8da2b3, 0xff2dd4bf, 0xff34d399, 0xffa78bfa, 0xff4ade80, 0xfffbbf24, 0xfffb7185, 0xff67e8f9, 0xff0a1016],
    [0xffa78bfa, 0xfffde68a, 0xff86efac, 0xfffdba74, 0xff5b6f80, 0xff67e8f9, 0xfffde68a, 0xffcbd9e3]),
  seeded('nord', 'Nord', 'Calm arctic blue-grey', true,
    [0xff2e3440, 0xff2e3440, 0xff3b4252, 0xff434c5e, 0xffeceff4, 0xffa3adc2, 0xff88c0d0, 0xff81a1c1, 0xffb48ead, 0xffa3be8c, 0xffebcb8b, 0xffbf616a, 0xff5e81ac, 0xff272c36],
    [0xff81a1c1, 0xff8fbcbb, 0xffa3be8c, 0xffb48ead, 0xff6e7a94, 0xff88c0d0, 0xffd08770, 0xffeceff4]),
  seeded('dracula', 'Dracula', 'Dark purple with vivid pink, green and cyan', true,
    [0xff282a36, 0xff282a36, 0xff303241, 0xff44475a, 0xfff8f8f2, 0xffa9adcb, 0xffbd93f9, 0xffff79c6, 0xff8be9fd, 0xff50fa7b, 0xffffb86c, 0xffff5555, 0xff8be9fd, 0xff21222c],
    [0xffff79c6, 0xff8be9fd, 0xfff1fa8c, 0xffbd93f9, 0xff7282b5, 0xff50fa7b, 0xffffb86c, 0xfff8f8f2]),
  seeded('velvet', 'Velvet', 'Dusky rose and soft violet on deep plum', true,
    [0xff191724, 0xff191724, 0xff1f1d2e, 0xff26233a, 0xffe0def4, 0xff9a96b5, 0xffebbcba, 0xffc4a7e7, 0xff9ccfd8, 0xff95d5a7, 0xfff6c177, 0xffeb6f92, 0xff9ccfd8, 0xff16141f],
    [0xffc4a7e7, 0xff9ccfd8, 0xfff6c177, 0xffebbcba, 0xff6e6a86, 0xffea9a97, 0xfff6c177, 0xffbdb9d6]),
  seeded('ocean', 'Deep Ocean', 'Deep navy with a sky-blue accent', true,
    [0xff0b1426, 0xff0b1426, 0xff111d33, 0xff1a2942, 0xffe2e8f0, 0xff94a3b8, 0xff38bdf8, 0xff6366f1, 0xfff472b6, 0xff34d399, 0xfffbbf24, 0xfffb7185, 0xff38bdf8, 0xff070e1c],
    [0xffc084fc, 0xfffcd34d, 0xff86efac, 0xfffdba74, 0xff64748b, 0xff7dd3fc, 0xfffcd34d, 0xffcbd5e1]),
  seeded('ember', 'Ember', 'Retro warm dark: toasted browns with orange and gold', true,
    [0xff1d2021, 0xff1d2021, 0xff282828, 0xff32302f, 0xffebdbb2, 0xffa89984, 0xfffe8019, 0xfffabd2f, 0xffd3869b, 0xffb8bb26, 0xfffabd2f, 0xfffb4934, 0xff83a598, 0xff1a1c1d],
    [0xfffb4934, 0xfffabd2f, 0xffb8bb26, 0xffd3869b, 0xff928374, 0xff8ec07c, 0xfffe8019, 0xffebdbb2]),
  seeded('forest', 'Forest', 'Dark pine green with a fresh leaf accent', true,
    [0xff0f1a14, 0xff0f1a14, 0xff16241c, 0xff1e3127, 0xffe6f0e9, 0xff9db5a6, 0xff4ade80, 0xff2dd4bf, 0xfffacc15, 0xff4ade80, 0xfffbbf24, 0xfff87171, 0xff60a5fa, 0xff0a120e],
    [0xffc4b5fd, 0xfffde68a, 0xffa7f3d0, 0xfffdba74, 0xff6a8777, 0xff7dd3fc, 0xfffde68a, 0xffcbd5d1]),
  seeded('sunset', 'Sunset', 'Warm plum dusk with an orange glow', true,
    [0xff1c1020, 0xff1c1020, 0xff26162b, 0xff342036, 0xfff6e7ef, 0xffc2a3b4, 0xfffb923c, 0xfff472b6, 0xffc084fc, 0xff4ade80, 0xfffbbf24, 0xfff43f5e, 0xff818cf8, 0xff140a17],
    [0xfff472b6, 0xfffde047, 0xffbef264, 0xfffb923c, 0xff8a7083, 0xff93c5fd, 0xfffde047, 0xffe5d4de]),
  seeded('solarized_dark', 'Solarized Dark', 'The classic low-glare teal-black palette', true,
    [0xff002b36, 0xff002b36, 0xff073642, 0xff0b4452, 0xffeee8d5, 0xff93a1a1, 0xff268bd2, 0xff2aa198, 0xff6c71c4, 0xff859900, 0xffb58900, 0xffdc322f, 0xff2aa198, 0xff00212b],
    [0xff859900, 0xffb58900, 0xff2aa198, 0xffd33682, 0xff6c8288, 0xff268bd2, 0xffcb4b16, 0xff93a1a1]),
];

export const defaultTheme = (dark: boolean) => BUILT_IN.find((t) => t.id === (dark ? DARK_DEFAULT : LIGHT_DEFAULT))!;

export function customFromJson(j: CustomThemeJson): AppTheme | null {
  if (!j || !j.name?.trim()) return null;
  const colors: Record<string, number> = {};
  for (const [k, v] of Object.entries(j.colors ?? {})) {
    const c = parseHex(String(v));
    if (c !== null) colors[k] = c;
  }
  return { id: j.id || `custom_${j.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, name: j.name.slice(0, 40), dark: !!j.dark, about: j.about ?? '', base: j.base ?? null, builtIn: false, colors };
}

// ------------------------------------------------------------------------------------------------ resolving

const resolvedCache = new Map<AppTheme, Record<string, number>>();

/** Every token of a theme (ThemeManager.resolveMap + ThemeTokens.scheme's Material fallbacks). */
export function resolveTheme(theme: AppTheme, all: AppTheme[], depth = 0): Record<string, number> {
  const hit = resolvedCache.get(theme);
  if (hit) return hit;
  let m: Record<string, number>;
  if (theme.builtIn || depth > 5) {
    m = { ...theme.colors };
  } else {
    const base = all.find((t) => t.id === theme.base && t.id !== theme.id) ?? defaultTheme(theme.dark);
    m = { ...resolveTheme(base, all, depth + 1), ...theme.colors };
    derive(m, new Set(Object.keys(theme.colors)), theme.dark);
  }
  const def = defaultTheme(theme.dark);
  if (theme.id !== def.id) {
    for (const [k, v] of Object.entries(def.colors)) if (!MATERIAL_KEYS.has(k) && m[k] === undefined) m[k] = v;
  }
  const m3 = theme.dark ? M3_DARK : M3_LIGHT;
  for (const k of MATERIAL_KEYS) if (m[k] === undefined) m[k] = m3[k];
  if (resolvedCache.size > 60) resolvedCache.clear();
  resolvedCache.set(theme, m);
  return m;
}

/** Tokens the stylesheet reads (token → CSS custom property). */
const CSS_TOKENS = [
  'primary', 'on_primary', 'primary_container', 'on_primary_container', 'secondary', 'tertiary', 'background', 'on_background',
  'surface', 'on_surface', 'surface_variant', 'on_surface_variant', 'surface_container_lowest', 'surface_container_low',
  'surface_container', 'surface_container_high', 'surface_container_highest', 'outline', 'outline_variant', 'error',
  'on_error', 'error_container', 'on_error_container', 'inverse_surface', 'inverse_on_surface', 'card', 'text_secondary',
  'user_bubble', 'thinking_bg', 'code_bg', 'code_text', 'success', 'warning', 'danger', 'info', 'accent_alt',
  ...SYNTAX_KEYS, 'border', 'fill', 'success_container', 'warning_container', 'danger_container', 'info_container',
  'accent_teal', 'accent_indigo', 'accent_pink', 'editor_bg', 'editor_panel', 'editor_text', 'editor_muted', 'editor_border',
  'editor_added_bg', 'editor_added_text', 'editor_removed_bg', 'editor_removed_text', 'editor_info_bg', 'editor_info_text',
  'terminal_bg',
];

/** The theme as CSS custom properties (set on :root from JS: CSP-safe, no style element). */
export function cssVars(theme: AppTheme, all: AppTheme[]): Record<string, string> {
  const m = resolveTheme(theme, all);
  const out: Record<string, string> = {};
  for (const k of CSS_TOKENS) if (m[k] !== undefined) out[`--${k.replace(/_/g, '-')}`] = hex(m[k]);
  out['--composer-border'] = theme.dark ? 'rgba(255, 255, 255, 0.08)' : `color-mix(in srgb, ${hex(m.on_surface)} 12%, transparent)`;
  out['--swatch-ring'] = theme.dark ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.25)';
  out['--is-dark'] = theme.dark ? '1' : '0';
  return out;
}
