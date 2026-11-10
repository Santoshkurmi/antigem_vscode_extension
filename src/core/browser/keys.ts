// Key names, aliases and US-layout characters for browser_computer `key` and `type` (port of the app's BrowserKeys.kt).
// Modifier bits follow DevTools: Alt=1, Ctrl=2, Meta=4, Shift=8.

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string | null;
  modifierBit?: number;
  location?: number;
}

export type KeyStep = { kind: 'press'; def: KeyDef; modifiers: number } | { kind: 'text'; text: string };

export const ALT = 1;
export const CTRL = 2;
export const META = 4;
export const SHIFT = 8;

const named = new Map<string, KeyDef>();
const chars = new Map<string, [KeyDef, boolean]>();

function name(def: KeyDef, ...aliases: string[]) {
  named.set(def.key.toLowerCase(), def);
  for (const a of aliases) named.set(a, def);
}

name({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }, 'return', 'enter', 'kp_enter');
name({ key: 'Tab', code: 'Tab', keyCode: 9 }, 'tab');
name({ key: 'Backspace', code: 'Backspace', keyCode: 8 }, 'backspace', 'back_space', 'bksp');
name({ key: 'Delete', code: 'Delete', keyCode: 46 }, 'delete', 'del');
name({ key: 'Escape', code: 'Escape', keyCode: 27 }, 'escape', 'esc');
name({ key: ' ', code: 'Space', keyCode: 32, text: ' ' }, 'space', 'spacebar');
name({ key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, 'arrowup', 'up');
name({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }, 'arrowdown', 'down');
name({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, 'arrowleft', 'left');
name({ key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 }, 'arrowright', 'right');
name({ key: 'Home', code: 'Home', keyCode: 36 }, 'home');
name({ key: 'End', code: 'End', keyCode: 35 }, 'end');
name({ key: 'PageUp', code: 'PageUp', keyCode: 33 }, 'pageup', 'page_up', 'pgup');
name({ key: 'PageDown', code: 'PageDown', keyCode: 34 }, 'pagedown', 'page_down', 'pgdn');
name({ key: 'Insert', code: 'Insert', keyCode: 45 }, 'insert', 'ins');
name({ key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 }, 'contextmenu', 'menu', 'apps');
name({ key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifierBit: SHIFT, location: 1 }, 'shift');
name({ key: 'Control', code: 'ControlLeft', keyCode: 17, modifierBit: CTRL, location: 1 }, 'control', 'ctrl');
name({ key: 'Alt', code: 'AltLeft', keyCode: 18, modifierBit: ALT, location: 1 }, 'alt', 'option', 'opt');
name({ key: 'Meta', code: 'MetaLeft', keyCode: 91, modifierBit: META, location: 1 }, 'meta', 'cmd', 'command', 'super', 'win', 'windows');
for (let i = 1; i <= 12; i++) name({ key: `F${i}`, code: `F${i}`, keyCode: 111 + i }, `f${i}`);

for (let c = 97; c <= 122; c++) {
  const lo = String.fromCharCode(c);
  const up = lo.toUpperCase();
  chars.set(lo, [{ key: lo, code: `Key${up}`, keyCode: up.charCodeAt(0), text: lo }, false]);
  chars.set(up, [{ key: up, code: `Key${up}`, keyCode: up.charCodeAt(0), text: up }, true]);
}
const shiftedDigits = ')!@#$%^&*(';
for (let d = 0; d <= 9; d++) {
  const c = String(d);
  chars.set(c, [{ key: c, code: `Digit${d}`, keyCode: c.charCodeAt(0), text: c }, false]);
  const s = shiftedDigits[d];
  chars.set(s, [{ key: s, code: `Digit${d}`, keyCode: c.charCodeAt(0), text: s }, true]);
}
function punct(plain: string, shifted: string, code: string, vk: number) {
  chars.set(plain, [{ key: plain, code, keyCode: vk, text: plain }, false]);
  chars.set(shifted, [{ key: shifted, code, keyCode: vk, text: shifted }, true]);
}
punct('-', '_', 'Minus', 189);
punct('=', '+', 'Equal', 187);
punct('[', '{', 'BracketLeft', 219);
punct(']', '}', 'BracketRight', 221);
punct('\\', '|', 'Backslash', 220);
punct(';', ':', 'Semicolon', 186);
punct("'", '"', 'Quote', 222);
punct(',', '<', 'Comma', 188);
punct('.', '>', 'Period', 190);
punct('/', '?', 'Slash', 191);
punct('`', '~', 'Backquote', 192);
chars.set(' ', [named.get('space')!, false]);

/** The key that types `c` on a US keyboard, and whether Shift is needed. */
export function forChar(c: string): [KeyDef, boolean] | null {
  return chars.get(c) ?? null;
}

export const enter = () => named.get('enter')!;
export const tab = () => named.get('tab')!;

function lookup(n: string): KeyDef | null {
  const d = named.get(n.toLowerCase());
  if (d) return d;
  if ([...n].length === 1) return chars.get(n)?.[0] ?? chars.get(n.toLowerCase())?.[0] ?? null;
  return null;
}

/**
 * Parses a `key` action: space-separated presses, each a key name ("Enter", "ArrowDown"), a chord ("ctrl+a",
 * "shift+Tab", "ctrl+shift+k", "shift++" for the + key) or one character.
 */
export function parse(input: string): KeyStep[] {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new Error('text is empty: name the key(s) to press, e.g. "Enter" or "ctrl+a"');
  return tokens.map((token, index): KeyStep => {
    if (token === '+' || !token.includes('+')) {
      const def = lookup(token);
      if (!def) {
        if ([...token].length === 1) return { kind: 'text', text: token };
        throw new Error(`Unknown key "${token}". Use names like Enter, Tab, Escape, Backspace, ArrowDown, PageDown, F5, or chords like ctrl+a. To enter text use the type action.`);
      }
      if (def.modifierBit && index < tokens.length - 1) {
        throw new Error(`"${token}" on its own is released before the next key. Join them with +, e.g. ctrl+a or shift+Tab.`);
      }
      return { kind: 'press', def, modifiers: 0 };
    }
    const parts = token.endsWith('++') ? [...token.slice(0, -2).split('+'), '+'] : token.split('+');
    let mods = 0;
    const keys: string[] = [];
    for (const part of parts) {
      const d = named.get(part.toLowerCase());
      if (d?.modifierBit) mods |= d.modifierBit;
      else keys.push(part);
    }
    if (keys.length !== 1 || !keys[0]) {
      throw new Error(
        !keys.length || keys.some((k) => !k)
          ? `"${token}" is incomplete: join modifiers and one key with +, e.g. ctrl+a (shift++ for the + key).`
          : `"${token}" has more than one key. Modifiers are ctrl, shift, alt and meta/cmd; separate keys pressed one after another with spaces.`,
      );
    }
    const def = lookup(keys[0]);
    if (!def) throw new Error(`Unknown key "${keys[0]}" in "${token}".`);
    return { kind: 'press', def, modifiers: mods };
  });
}

/** The modifier keys held for `modifiers`, in press order. */
export function modifierKeys(modifiers: number): KeyDef[] {
  return ([
    [CTRL, 'control'],
    [ALT, 'alt'],
    [SHIFT, 'shift'],
    [META, 'meta'],
  ] as const)
    .filter(([bit]) => (modifiers & bit) !== 0)
    .map(([, n]) => named.get(n)!);
}

/** Parses a click's modifiers string ("ctrl", "shift+alt", "cmd") into DevTools bits. */
export function parseModifiers(spec: string | null | undefined): number {
  if (!spec || !spec.trim()) return 0;
  let bits = 0;
  for (const part of spec.toLowerCase().split(/[+ ,]/).map((s) => s.trim()).filter(Boolean)) {
    const d = named.get(part);
    if (!d?.modifierBit) throw new Error(`Unknown modifier "${part}": use ctrl, shift, alt or meta (cmd).`);
    bits |= d.modifierBit;
  }
  return bits;
}
