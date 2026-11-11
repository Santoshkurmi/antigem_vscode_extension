// theme_mcp: port of the app's theme/ThemeMcp.kt over the extension's shared view prefs (UiPrefs: theme =
// 'auto'|'light'|'dark', lightTheme, darkTheme, customThemes) — every view (sidebar, editor tabs) re-themes at once.
// Theme data and color rules come from the UI's port of AppTheme.kt (webview/src/themes.ts), so both sides agree.
import {
  BUILT_IN,
  DARK_DEFAULT,
  LIGHT_DEFAULT,
  contrast,
  customFromJson,
  baseTheme,
  defaultTheme,
  hex,
  parseHex,
  resolveTheme,
  type AppTheme,
  type CustomThemeJson,
} from '../../../webview/src/themes';
import { S, errorResult, jsonResult, text, type McpResult, type McpServerDef, type McpTool } from './server';
import { READABILITY_PAIRS, THEME_SEEDS, THEME_TOKENS } from './themeTokens';

export interface ThemePrefsAccess {
  get(): Record<string, unknown>;
  set(patch: Record<string, unknown>): void;
}

const INSTRUCTIONS =
  "Controls AntiGem's color themes. theme_list shows every theme (built-in and custom) and which is used for the light " +
  'and the dark side; theme_apply switches. To make a theme: call theme_tokens once to see every color and what it is for, then ' +
  'theme_create with a name, dark=true/false and at least the seed colors (background, surface, card, surface_variant, on_background, ' +
  'on_surface_variant, primary, secondary, tertiary, success, warning, danger, info, code_bg and the syntax_* colors); every other color is ' +
  'worked out from them (the IDE editor, diff colors and the terminal palette follow code_bg / code_text and the status colors unless you set editor_* , terminal_* or ansi_*). Read the readability warnings it returns and fix them with theme_update. Built-in themes cannot be changed: ' +
  'duplicate one first. Colors are hex like #1E293B or #FF1E293B.';

const TOKEN_KEYS = new Set(THEME_TOKENS.map((t) => t.key));
const hex8 = (c: number) => `#${(c >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

function tools(): McpTool[] {
  const idProp = { id: S.prop('string', 'Theme id or name (default: the theme on screen)') };
  const colorsProp = { colors: S.prop('object', 'Token → hex color, e.g. {"background": "#0B1020", "primary": "#FF4FD8"}. Keys from theme_tokens.') };
  return [
    S.tool('theme_list', 'Every theme (built-in and custom), light or dark, and which one is used for each side and on screen now.', [], {}),
    S.tool('theme_get', 'All colors of one theme (as hex), plus its readability check.', [], idProp),
    S.tool('theme_tokens', 'Every color token a theme can set, what it is used for, and which ones are the seeds to give when creating a theme.', [], {}),
    S.tool('theme_apply', 'Use a theme (for its side: light or dark). If the app\'s mode would not show that side, the mode switches to it.', ['id'], idProp),
    S.tool(
      'theme_set_mode',
      "vscode (the default: VS Code's own theme colors, live), system (Auto: VS Code's light / dark side with AntiGem themes), light or dark.",
      ['mode'],
      { mode: S.prop('string', 'The mode', ['vscode', 'system', 'light', 'dark']) },
    ),
    S.tool(
      'theme_create',
      'Create a custom theme. Give the seed colors (see theme_tokens); the rest is worked out from them or taken from base. Returns the id and readability warnings.',
      ['name', 'dark'],
      {
        name: S.prop('string', 'Theme name, e.g. Neon Night'),
        dark: S.prop('boolean', 'true for a dark theme, false for a light one'),
        ...colorsProp,
        base: S.prop('string', 'Theme to start from (default: the default theme of the same side)'),
        about: S.prop('string', 'One line describing the look'),
        apply: S.prop('boolean', 'Use it right away (default true)'),
      },
    ),
    S.tool('theme_update', 'Change colors, name or description of a custom theme (only the given colors change; dependent ones are worked out again).', ['id'], {
      ...idProp,
      ...colorsProp,
      name: S.prop('string', 'New name'),
      about: S.prop('string', 'New description'),
      remove: S.prop('array', "Tokens to reset to the base theme's value"),
      apply: S.prop('boolean', 'Also use it now'),
    }),
    S.tool('theme_duplicate', 'Copy a theme (built-in or custom) into a new custom theme you can edit.', ['id'], { ...idProp, name: S.prop('string', 'Name of the copy') }),
    S.tool('theme_delete', 'Delete a custom theme. Ask the user first.', ['id'], idProp),
    S.tool('theme_export', 'A theme as JSON (to share or keep).', [], idProp),
    S.tool('theme_import', 'Add a theme from JSON (as made by theme_export).', ['json'], {
      json: S.prop('string', 'The theme JSON'),
      apply: S.prop('boolean', 'Use it right away (default false)'),
    }),
  ];
}

export function themeMcp(prefs: ThemePrefsAccess): McpServerDef {
  const customs = (): CustomThemeJson[] => ((prefs.get().customThemes as CustomThemeJson[] | undefined) ?? []).filter((c) => c && c.name);
  const all = (): AppTheme[] => [...BUILT_IN, ...customs().map((c) => customFromJson(c)).filter((t): t is AppTheme => !!t)];
  const find = (idOrName: string): AppTheme | undefined => {
    const k = idOrName.trim().toLowerCase();
    return all().find((t) => t.id.toLowerCase() === k) ?? all().find((t) => t.name.toLowerCase() === k);
  };
  /** vscode: VS Code's own theme colors (the default); system: VS Code's light / dark side with AntiGem themes. */
  const mode = (): 'vscode' | 'system' | 'light' | 'dark' => {
    const t = String(prefs.get().theme ?? 'vscode');
    if (t === 'light' || t === 'dark' || t === 'vscode') return t;
    if (t === 'auto') return 'system';
    return find(t)?.dark ? 'dark' : 'light';
  };
  const lightId = () => {
    const t = find(String(prefs.get().theme ?? ''));
    if (t && !t.dark) return t.id;
    return String(prefs.get().lightTheme ?? LIGHT_DEFAULT);
  };
  const darkId = () => {
    const t = find(String(prefs.get().theme ?? ''));
    if (t?.dark) return t.id;
    return String(prefs.get().darkTheme ?? DARK_DEFAULT);
  };
  /** The side the views show (auto follows the editor; the views report it as screenSide). */
  const side = (): 'light' | 'dark' => {
    const m = mode();
    if (m === 'light' || m === 'dark') return m;
    return prefs.get().screenSide === 'light' ? 'light' : 'dark';
  };
  const current = () => find(side() === 'dark' ? darkId() : lightId()) ?? defaultTheme(side() === 'dark');
  const resolved = (t: AppTheme) => resolveTheme(t, all());
  const check = (colors: Record<string, number>): string[] =>
    READABILITY_PAIRS.flatMap(([fg, bg, min]) => {
      const f = colors[fg];
      const b = colors[bg];
      if (f == null || b == null) return [];
      const r = contrast(f, b);
      return r < min ? [`${fg} on ${bg} has contrast ${r.toFixed(1)} (needs at least ${min})`] : [];
    });
  const themeJson = (t: AppTheme) => {
    const uses = [
      lightId() === t.id && !t.dark ? 'light side' : null,
      darkId() === t.id && t.dark ? 'dark side' : null,
      current().id === t.id ? 'on screen now' : null,
    ].filter(Boolean);
    return { id: t.id, name: t.name, dark: t.dark, built_in: t.builtIn, ...(t.about ? { about: t.about } : {}), ...(t.base ? { base: t.base } : {}), ...(uses.length ? { in_use: uses } : {}) };
  };
  /** ThemeManager.select: use it for its side; switch the mode when the current one would not show it. */
  const select = (t: AppTheme): string | null => {
    const m = mode();
    const patch: Record<string, unknown> = t.dark ? { darkTheme: t.id } : { lightTheme: t.id };
    let switched: string | null = null;
    // matching VS Code shows no AntiGem theme: keep following VS Code's side, with this theme's colors
    if (m === 'vscode') {
      patch.theme = 'auto';
      switched = 'auto (follows VS Code light / dark)';
    } else if (m !== 'system' && (m === 'dark') !== t.dark) {
      patch.theme = t.dark ? 'dark' : 'light';
      switched = t.dark ? 'dark' : 'light';
    } else if (m !== 'system') patch.theme = m;
    prefs.set(patch);
    return switched;
  };
  const newId = (name: string) => {
    const base = `custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'theme'}`;
    let id = base;
    for (let i = 2; all().some((t) => t.id === id); i++) id = `${base}_${i}`;
    return id;
  };
  const saveCustom = (t: CustomThemeJson) => {
    const list = customs().filter((c) => c.id !== t.id);
    prefs.set({ customThemes: [...list, t] });
    return customFromJson(t)!;
  };
  const colorsOf = (args: Record<string, unknown>, problems: string[]): Record<string, string> => {
    const o = args.colors;
    if (!o || typeof o !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const key = k.trim().toLowerCase();
      if (!TOKEN_KEYS.has(key)) {
        problems.push(`unknown token "${k}" (see theme_tokens)`);
        continue;
      }
      const c = parseHex(String(v));
      if (c == null) problems.push(`"${k}": "${String(v)}" is not a hex color`);
      else out[key] = hex8(c);
    }
    return out;
  };
  const report = (t: AppTheme, problems: string[], switched: string | null, applied: boolean): McpResult => {
    const warnings = check(resolved(t));
    return jsonResult({
      ...themeJson(t),
      applied,
      ...(switched ? { mode_switched_to: switched } : {}),
      ...(problems.length ? { ignored: problems } : {}),
      readability: warnings.length ? warnings : ['ok'],
      ...(warnings.length ? { hint: 'Fix the low-contrast pairs with theme_update (lighter text on dark, darker text on light).' } : {}),
    });
  };
  const target = (a: Record<string, unknown>) => {
    const id = String(a.id ?? '').trim();
    return id ? find(id) : current();
  };
  const toJson = (t: AppTheme, colors: Record<string, number>): CustomThemeJson => ({
    id: t.id,
    name: t.name,
    dark: t.dark,
    ...(t.about ? { about: t.about } : {}),
    colors: Object.fromEntries(Object.entries(colors).filter(([k]) => TOKEN_KEYS.has(k)).map(([k, v]) => [k, hex8(v)])),
  });

  const handlers: Record<string, (a: Record<string, unknown>) => McpResult> = {
    theme_list: () =>
      jsonResult({
        mode: mode(),
        light_side: lightId(),
        dark_side: darkId(),
        on_screen: mode() === 'vscode' ? 'vscode (the colors of the user\'s VS Code theme)' : current().id,
        themes: all().map(themeJson),
      }),
    theme_get(a) {
      const t = target(a);
      if (!t) return errorResult(`No theme "${String(a.id ?? '')}". Use theme_list.`);
      const colors = resolved(t);
      const w = check(colors);
      return jsonResult({ ...themeJson(t), colors: Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, hex8(v)])), readability: w.length ? w : ['ok'] });
    },
    theme_tokens: () =>
      jsonResult({
        seeds: THEME_SEEDS,
        tokens: THEME_TOKENS.map((t) => ({ key: t.key, group: t.group, used_for: t.about })),
        note: 'Give the seeds when creating; the rest (containers, on_* text colors, outlines, surface levels) is worked out unless you set them.',
      }),
    theme_apply(a) {
      const t = target(a);
      if (!t) return errorResult(`No theme "${String(a.id ?? '')}". Use theme_list.`);
      const m = select(t);
      return text(`Using ${t.name} for the ${t.dark ? 'dark' : 'light'} side${m ? `, and switched the app to ${m} mode` : ''}.`);
    },
    theme_set_mode(a) {
      const m = String(a.mode ?? '').toLowerCase();
      const v = m === 'light' ? 'light' : m === 'dark' ? 'dark' : m === 'system' || m === 'auto' ? 'auto' : m === 'vscode' || m === 'vs code' ? 'vscode' : null;
      if (!v) return errorResult('Use vscode, system, light or dark.');
      prefs.set({ theme: v });
      return text(`Theme mode is now ${v === 'auto' ? 'system' : v}.`);
    },
    theme_create(a) {
      const name = String(a.name ?? '').trim();
      if (!name) return errorResult('name is required');
      if (a.dark === undefined) return errorResult('Say whether it is a dark theme (dark=true) or a light one (dark=false).');
      const dark = a.dark === true || a.dark === 'true';
      const problems: string[] = [];
      const colors = colorsOf(a, problems);
      let base = baseTheme(dark);
      if (String(a.base ?? '').trim()) {
        const b = find(String(a.base));
        if (!b) return errorResult(`No base theme "${String(a.base)}".`);
        base = b;
      }
      if (base.dark !== dark) problems.push(`base ${base.name} is a ${base.dark ? 'dark' : 'light'} theme; its colors were still used where you gave none`);
      const t = saveCustom({ id: newId(name), name: name.slice(0, 40), dark, about: String(a.about ?? '').slice(0, 200), base: base.id, colors });
      const apply = a.apply === undefined ? true : a.apply === true;
      const m = apply ? select(t) : null;
      return report(t, problems, m, apply);
    },
    theme_update(a) {
      const t = target(a);
      if (!t) return errorResult(`No theme "${String(a.id ?? '')}".`);
      if (t.builtIn) return errorResult(`${t.name} is built in and cannot be changed. Use theme_duplicate, then update the copy.`);
      const problems: string[] = [];
      const changes = colorsOf(a, problems);
      const remove = new Set(((a.remove as unknown[]) ?? []).map((x) => String(x).trim().toLowerCase()));
      const prev = customs().find((c) => c.id === t.id)!;
      const kept = Object.fromEntries(Object.entries(prev.colors ?? {}).filter(([k]) => !remove.has(k)));
      const updated = saveCustom({
        ...prev,
        name: (String(a.name ?? '').trim() || t.name).slice(0, 40),
        about: a.about !== undefined ? String(a.about).slice(0, 200) : prev.about,
        colors: { ...kept, ...changes },
      });
      const m = a.apply === true ? select(updated) : null;
      return report(updated, problems, m, a.apply === true || current().id === updated.id);
    },
    theme_duplicate(a) {
      const t = target(a);
      if (!t) return errorResult(`No theme "${String(a.id ?? '')}".`);
      const name = String(a.name ?? '').trim() || `${t.name} copy`;
      // the copy keeps every resolved color, so it looks the same even if the original changes later
      const copy = saveCustom({ ...toJson(t, resolved(t)), id: newId(name), name: name.slice(0, 40), base: t.id });
      return jsonResult({ ...themeJson(copy), note: 'Edit it with theme_update.' });
    },
    theme_delete(a) {
      const t = find(String(a.id ?? ''));
      if (!t) return errorResult(`No theme "${String(a.id ?? '')}".`);
      if (t.builtIn) return errorResult('Built-in themes cannot be deleted.');
      const patch: Record<string, unknown> = { customThemes: customs().filter((c) => c.id !== t.id) };
      if (prefs.get().lightTheme === t.id) patch.lightTheme = LIGHT_DEFAULT;
      if (prefs.get().darkTheme === t.id) patch.darkTheme = DARK_DEFAULT;
      if (prefs.get().theme === t.id) patch.theme = 'auto';
      prefs.set(patch);
      return text(`Deleted ${t.name}.`);
    },
    theme_export(a) {
      const t = target(a);
      if (!t) return errorResult(`No theme "${String(a.id ?? '')}".`);
      return text(JSON.stringify(toJson(t, resolved(t)), null, 2));
    },
    theme_import(a) {
      let o: CustomThemeJson;
      try {
        o = JSON.parse(String(a.json ?? ''));
      } catch {
        return errorResult('json is not valid JSON.');
      }
      if (!o?.name || !o.colors) return errorResult('The JSON needs at least a name and colors.');
      const colors: Record<string, string> = {};
      for (const [k, v] of Object.entries(o.colors)) {
        const c = parseHex(String(v));
        if (c != null && TOKEN_KEYS.has(k)) colors[k] = hex8(c);
      }
      const saved = saveCustom({ id: newId(o.name), name: String(o.name).slice(0, 40), dark: !!o.dark, about: o.about ?? '', base: o.base ?? null, colors });
      const m = a.apply === true ? select(saved) : null;
      return report(saved, [], m, a.apply === true);
    },
  };

  void hex;
  return {
    path: '/theme',
    name: 'theme_mcp',
    instructions: INSTRUCTIONS,
    tools,
    call(name, args) {
      const h = handlers[name];
      if (!h) return errorResult(`Unknown tool ${name}`);
      try {
        return h(args);
      } catch (e) {
        return errorResult(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
