// The flow half of the YAML reader (yaml.ts): a cursor over [ ], { }, 'single' / "double" quoted and plain scalars,
// which may run over several lines (it asks for more with NEED_MORE), and what a plain scalar means (YAML 1.2 core).

/** A quoted string or flow collection ran past the end of the text it was given: give it more lines. */
export const NEED_MORE = Symbol('need more');

const ESCAPES: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
};

/** A cursor over flow text: [ ], { }, quoted and plain scalars; throws NEED_MORE when the text ends too soon. */
export class Flow {
  at = 0;
  constructor(private readonly src: string) {}

  private skip() {
    for (;;) {
      const c = this.src[this.at];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.at++;
      else if (c === '#' && (this.at === 0 || /\s/.test(this.src[this.at - 1]))) while (this.at < this.src.length && this.src[this.at] !== '\n') this.at++;
      else return;
    }
  }

  value(): unknown {
    this.skip();
    const c = this.src[this.at];
    if (c === undefined) throw NEED_MORE;
    if (c === '[') return this.list();
    if (c === '{') return this.object();
    if (c === '"' || c === "'") return this.quotedValue();
    return this.plainValue();
  }

  private list(): unknown[] {
    const out: unknown[] = [];
    this.at++;
    for (;;) {
      this.skip();
      if (this.src[this.at] === undefined) throw NEED_MORE;
      if (this.src[this.at] === ']') {
        this.at++;
        return out;
      }
      out.push(this.value());
      this.skip();
      const c = this.src[this.at];
      if (c === undefined) throw NEED_MORE;
      if (c === ',') this.at++;
      else if (c === ']') {
        this.at++;
        return out;
      }
      else if (c === ':') throw new Error('a "key: value" inside [ ] is not supported; use { }');
      else throw new Error('expected , or ] in a [ ] list');
    }
  }

  private object(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.at++;
    for (;;) {
      this.skip();
      const c = this.src[this.at];
      if (c === undefined) throw NEED_MORE;
      if (c === '}') {
        this.at++;
        return out;
      }
      const key = c === '"' || c === "'" ? this.quotedValue() : String(this.plainText(true));
      this.skip();
      let value: unknown = null;
      if (this.src[this.at] === ':') {
        this.at++;
        this.skip();
        if (this.src[this.at] !== ',' && this.src[this.at] !== '}') value = this.value();
      }
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`the key "${key}" appears twice`);
      setKey(out, key, value);
      this.skip();
      const d = this.src[this.at];
      if (d === undefined) throw NEED_MORE;
      if (d === ',') this.at++;
      else if (d === '}') {
        this.at++;
        return out;
      }
      else throw new Error('expected , or } in a { } map');
    }
  }

  private plainValue(): unknown {
    const text = this.plainText(false);
    return text.includes('\n') ? text.replace(/\n/g, ' ') : resolvePlain(text);
  }

  /** Plain text up to , [ ] { } or ": " (and ":" in a key); lines folded. */
  private plainText(isKey: boolean): string {
    const from = this.at;
    while (this.at < this.src.length) {
      const c = this.src[this.at];
      const next = this.src[this.at + 1];
      if (c === ',' || c === '[' || c === ']' || c === '{' || c === '}') break;
      if (c === ':' && (next === undefined || /[\s,\]}]/.test(next) || isKey)) break;
      if (c === '#' && /\s/.test(this.src[this.at - 1] ?? '')) break;
      this.at++;
    }
    const raw = this.src.slice(from, this.at);
    const lines = raw.split('\n').map((l) => l.trim());
    let out = lines[0];
    for (let k = 1, empties = 0; k < lines.length; k++) {
      if (!lines[k]) {
        empties++;
        continue;
      }
      out += empties ? '\n'.repeat(empties) + lines[k] : (out ? ' ' : '') + lines[k];
      empties = 0;
    }
    if (!out && !isKey) throw new Error(`unexpected "${this.src[this.at] ?? ''}"`);
    return out;
  }

  /** 'single' ('' = ') or "double" (backslash escapes); line breaks fold to a space, blank lines to line breaks. */
  quotedValue(): string {
    const q = this.src[this.at];
    let out = '';
    let j = this.at + 1;
    for (;;) {
      const c = this.src[j];
      if (c === undefined) throw NEED_MORE;
      if (c === q) {
        if (q === "'" && this.src[j + 1] === "'") {
          out += "'";
          j += 2;
          continue;
        }
        this.at = j + 1;
        return out;
      }
      if (c === '\\' && q === '"') {
        const e = this.src[j + 1];
        if (e === undefined) throw NEED_MORE;
        if (e === '\n') {
          j += 2;
          while (this.src[j] === ' ' || this.src[j] === '\t') j++;
          continue;
        }
        const width = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
        if (width) {
          const hex = this.src.slice(j + 2, j + 2 + width);
          if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) throw new Error(`a bad \\${e} escape in a quoted string`);
          out += width === 8 ? String.fromCodePoint(parseInt(hex, 16)) : String.fromCharCode(parseInt(hex, 16));
          j += 2 + width;
          continue;
        }
        if (!(e in ESCAPES)) throw new Error(`an unknown escape \\${e} in a quoted string`);
        out += ESCAPES[e];
        j += 2;
        continue;
      }
      if (c === '\n' || (c === '\r' && this.src[j + 1] === '\n')) {
        out = out.replace(/[ \t]+$/, '');
        let empties = 0;
        j += c === '\r' ? 2 : 1;
        for (;;) {
          while (this.src[j] === ' ' || this.src[j] === '\t') j++;
          if (this.src[j] !== '\n') break;
          empties++;
          j++;
        }
        out += empties ? '\n'.repeat(empties) : ' ';
        continue;
      }
      out += c;
      j++;
    }
  }
}

export function setKey(obj: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** YAML 1.2 core schema: what a plain scalar means. */
export function resolvePlain(s: string): unknown {
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?[0-9]+$/.test(s) || /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}
