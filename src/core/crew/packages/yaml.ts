// A small YAML reader and writer, enough for a Crew package's frontmatter (docs/crew/PLAN.md §14), no dependency.
// Reads block maps and lists (a list may sit at its key's indent), flow [a, b] and {a: 1} (also across lines), plain,
// 'single' and "double" quoted scalars (also across lines), | and > block strings, comments; numbers, true/false and
// null as YAML 1.2 reads them. No anchors, aliases, tags or second documents. Errors name the line. The writer emits
// only what the reader reads back as the same value (JSON-like values: objects, arrays, strings, numbers, booleans, null).
import { Flow, NEED_MORE, resolvePlain, setKey } from './yamlFlow';

export class YamlError extends Error {
  constructor(
    readonly reason: string,
    readonly line: number,
  ) {
    super(`${reason} (line ${line})`);
    this.name = 'YamlError';
  }
}

export function parseYaml(text: string): unknown {
  return new Reader(text).document();
}

const SEQ = /^-(?=\s|$)/;

class Reader {
  private readonly lines: string[];
  private i = 0;

  constructor(text: string) {
    this.lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
  }

  document(): unknown {
    this.skipBlank();
    if (!this.eof() && /^---\s*(#.*)?$/.test(this.lines[this.i])) this.i++;
    this.skipBlank();
    if (this.eof()) return null;
    const value = this.node(0);
    this.skipBlank();
    if (!this.eof() && /^\.\.\.\s*$/.test(this.lines[this.i])) {
      this.i++;
      this.skipBlank();
    }
    if (this.eof()) return value;
    if (/^---/.test(this.lines[this.i])) throw this.err('a second document (---) is not supported');
    throw this.err(this.indent(this.i) > 0 ? 'unexpected indentation' : 'unexpected text after the value above');
  }

  // ---------------------------------------------------------------------------------------------- lines

  private eof() {
    return this.i >= this.lines.length;
  }

  private err(reason: string, at = this.i) {
    return new YamlError(reason, Math.min(at, this.lines.length - 1) + 1);
  }

  private isBlank(n: number) {
    return /^\s*(#.*)?$/.test(this.lines[n]);
  }

  private skipBlank() {
    while (!this.eof() && this.isBlank(this.i)) this.i++;
  }

  private indent(n: number): number {
    const lead = /^[ \t]*/.exec(this.lines[n])![0];
    if (lead.includes('\t')) throw this.err('tabs cannot indent YAML; use spaces', n);
    return lead.length;
  }

  // ---------------------------------------------------------------------------------------------- blocks

  /** The node at the current (non-blank) line; its parent sits at minIndent - 1. */
  private node(minIndent: number): unknown {
    const n = this.indent(this.i);
    const content = this.lines[this.i].slice(n);
    if (SEQ.test(content)) return this.seq(n);
    if (/^\?(\s|$)/.test(content)) throw this.err('complex keys (?) are not supported');
    if (keyOf(content)) return this.map(n);
    return this.scalar(content, minIndent - 1);
  }

  private map(n: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (;;) {
      this.skipBlank();
      if (this.eof()) break;
      const ind = this.indent(this.i);
      if (ind < n) break;
      if (ind > n) throw this.err('unexpected indentation');
      const content = this.lines[this.i].slice(n);
      if (SEQ.test(content)) throw this.err('a list item where a "key: value" was expected');
      const kv = keyOf(content);
      if (!kv) throw this.err('expected "key: value"');
      if (seen.has(kv.key)) throw this.err(`the key "${kv.key}" appears twice`);
      seen.add(kv.key);
      setKey(obj, kv.key, this.value(kv.rest, n));
    }
    return obj;
  }

  /** What follows "key:" on the current line (maybe nothing: then a nested block), in a map at indent n. */
  private value(rest: string, n: number): unknown {
    const text = rest.trim();
    if (text && !text.startsWith('#')) return this.scalar(text, n);
    this.i++;
    this.skipBlank();
    if (this.eof()) return null;
    const ind = this.indent(this.i);
    if (ind > n) return this.node(n + 1);
    if (ind === n && SEQ.test(this.lines[this.i].slice(n))) return this.seq(n);
    return null;
  }

  private seq(n: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      this.skipBlank();
      if (this.eof()) break;
      const ind = this.indent(this.i);
      if (ind < n) break;
      if (ind > n) throw this.err('unexpected indentation');
      const content = this.lines[this.i].slice(n);
      if (!SEQ.test(content)) break; // the map around it goes on (a list at its key's indent)
      const after = content.slice(1);
      const item = after.trimStart();
      if (!item || item.startsWith('#')) {
        this.i++;
        this.skipBlank();
        out.push(!this.eof() && this.indent(this.i) > n ? this.node(n + 1) : null);
        continue;
      }
      // "- x" becomes "  x": the item's content then sits at its own column, like any other block
      this.lines[this.i] = ' '.repeat(n + 1 + after.length - item.length) + item;
      out.push(this.node(n + 1));
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------- scalars

  /** A value starting on the current line (text = from the value's first character); parent = the indent it hangs off. */
  private scalar(text: string, parent: number): unknown {
    const c = text[0];
    if (c === '|' || c === '>') return this.blockString(text, parent);
    if (c === '[' || c === '{' || c === '"' || c === "'") return this.spanning(text);
    if (c === '&' || c === '*' || c === '!') throw this.err('anchors, aliases and tags (& * !) are not supported; quote the text');
    return this.plain(text, parent);
  }

  /** A quoted string or flow collection, which may run over several lines. */
  private spanning(text: string): unknown {
    const start = this.i;
    const read = (src: string) => {
      const p = new Flow(src);
      const value = src[0] === '"' || src[0] === "'" ? p.quotedValue() : p.value();
      return { value, end: p.at };
    };
    let src = text;
    let got: { value: unknown; end: number };
    try {
      got = read(src);
    } catch (e) {
      if (e !== NEED_MORE) throw this.wrap(e, start);
      // rare: read the rest of the document once, then count the lines it took
      src = [text, ...this.lines.slice(start + 1)].join('\n');
      try {
        got = read(src);
      } catch (e2) {
        if (e2 === NEED_MORE) throw this.err(text[0] === '"' || text[0] === "'" ? 'a quoted string is not closed' : `a ${text[0]} is not closed`, start);
        throw this.wrap(e2, start);
      }
    }
    const used = src.slice(0, got.end).split('\n').length - 1;
    const tail = src.slice(got.end).split('\n')[0];
    this.i = start + used;
    if (!/^\s*(#.*)?$/.test(tail) || (tail.trimStart().startsWith('#') && !/^\s/.test(tail)))
      throw this.err('unexpected text after the value', this.i);
    this.i++;
    return got.value;
  }

  private wrap(e: unknown, at: number) {
    return e instanceof YamlError ? e : this.err(e instanceof Error ? e.message : String(e), at);
  }

  /** A plain scalar; more-indented lines below continue it (folded with spaces, blank lines kept as line breaks). */
  private plain(text: string, parent: number): unknown {
    const first = splitComment(text);
    this.i++;
    if (first.comment) return resolvePlain(first.value);
    let out = first.value;
    let multi = false;
    for (let j = this.i, breaks = 0; j < this.lines.length; j++) {
      const s = this.lines[j];
      if (/^\s*$/.test(s)) {
        breaks++;
        continue;
      }
      if (/^\s*#/.test(s) || this.indent(j) <= parent) break;
      const part = splitComment(s.trim());
      if (keyOf(part.value)) throw this.err('this line is indented under a value that already has text; a key cannot hold both', j);
      out += breaks ? '\n'.repeat(breaks) + part.value : ' ' + part.value;
      multi = true;
      breaks = 0;
      this.i = j + 1;
      if (part.comment) break;
    }
    return multi ? out : resolvePlain(out);
  }

  /** | (literal) or > (folded), with optional indent digit and chomping (- strip, + keep). */
  private blockString(header: string, parent: number): string {
    const h = /^([|>])(?:([1-9])([+-])?|([+-])([1-9])?)?\s*(?:#.*)?$/.exec(header);
    if (!h) throw this.err(`a block string header is "|" or ">" with an optional digit and - or +, not "${header}"`);
    const folded = h[1] === '>';
    const digit = Number(h[2] ?? h[5] ?? 0);
    const chomp = h[3] ?? h[4] ?? '';
    this.i++;
    let ind = digit ? Math.max(parent, 0) + digit : -1;
    if (ind < 0) {
      for (let k = this.i; k < this.lines.length; k++) {
        if (this.lines[k].trim() === '') continue;
        ind = /^ */.exec(this.lines[k])![0].length;
        break;
      }
      if (ind <= parent) ind = -1;
    }
    const raw: string[] = [];
    while (!this.eof()) {
      const s = this.lines[this.i];
      if (s.trim() === '') raw.push(ind > 0 && s.length > ind ? s.slice(ind) : '');
      else if (ind < 0 || /^ */.exec(s)![0].length < ind) break;
      else raw.push(s.slice(ind));
      this.i++;
    }
    let last = raw.length - 1;
    while (last >= 0 && raw[last] === '') last--;
    const body = raw.slice(0, last + 1);
    const trailing = raw.length - body.length;
    if (!body.length) return chomp === '+' ? '\n'.repeat(trailing) : '';
    const text = folded ? fold(body) : body.join('\n');
    return chomp === '-' ? text : chomp === '+' ? text + '\n' + '\n'.repeat(trailing) : text + '\n';
  }
}

/** "key: rest" (key plain or quoted) or null. */
function keyOf(content: string): { key: string; rest: string } | null {
  if (content[0] === '"' || content[0] === "'") {
    try {
      const p = new Flow(content);
      const key = p.quotedValue();
      const m = /^[ \t]*:(\s|$)/.exec(content.slice(p.at));
      return m ? { key, rest: content.slice(p.at + m[0].length - m[1].length) } : null;
    } catch {
      return null;
    }
  }
  if (/^[[{]/.test(content) || SEQ.test(content)) return null;
  for (let j = 0; j < content.length; j++) {
    const c = content[j];
    if (c === '#' && (j === 0 || /\s/.test(content[j - 1]))) return null;
    if (c === ':' && (j + 1 === content.length || /\s/.test(content[j + 1]))) {
      const key = content.slice(0, j).trim();
      return key ? { key, rest: content.slice(j + 1) } : null;
    }
  }
  return null;
}

function splitComment(text: string): { value: string; comment: boolean } {
  for (let j = 0; j < text.length; j++) if (text[j] === '#' && (j === 0 || /\s/.test(text[j - 1]))) return { value: text.slice(0, j).trim(), comment: true };
  return { value: text.trim(), comment: false };
}

function fold(lines: string[]): string {
  let out = '';
  let prev: 'none' | 'text' | 'more' = 'none';
  let empties = 0;
  for (const l of lines) {
    if (l === '') {
      empties++;
      continue;
    }
    const more = /^[ \t]/.test(l);
    if (prev === 'none') out += '\n'.repeat(empties);
    else if (prev === 'text' && !more) out += empties ? '\n'.repeat(empties) : ' ';
    else out += '\n' + '\n'.repeat(empties);
    out += l;
    prev = more ? 'more' : 'text';
    empties = 0;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ writer

/** YAML text for a JSON-like value (ends with a newline). undefined object values are left out. */
export function stringifyYaml(value: unknown): string {
  const out: string[] = [];
  if (isBlock(value)) emit(value, 0, out);
  else {
    const s = scalarText(value, 2);
    out.push(s.head, ...s.tail);
  }
  return out.join('\n') + '\n';
}

const isBlock = (v: unknown): v is object =>
  (Array.isArray(v) && v.length > 0) || (!!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some((x) => x !== undefined));

function emit(value: object, indent: number, out: string[]) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item) && isBlock(item)) {
        out.push(pad + '-');
        emit(item, indent + 2, out);
      } else if (isBlock(item)) {
        const sub: string[] = [];
        emit(item, indent + 2, sub);
        sub[0] = pad + '- ' + sub[0].slice(indent + 2);
        out.push(...sub);
      } else {
        const s = scalarText(item, indent + 2);
        out.push(pad + '- ' + s.head, ...s.tail);
      }
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const key = pad + (plainSafe(k) ? k : JSON.stringify(k)) + ':';
    if (isBlock(v)) {
      out.push(key);
      emit(v, indent + 2, out);
    } else {
      const s = scalarText(v, indent + 2);
      out.push(key + ' ' + s.head, ...s.tail);
    }
  }
}

/** A scalar (or empty collection) on one line, or a | block whose lines sit at `indent`. */
function scalarText(v: unknown, indent: number): { head: string; tail: string[] } {
  if (v === null || v === undefined) return { head: 'null', tail: [] };
  if (Array.isArray(v)) return { head: '[]', tail: [] };
  if (typeof v === 'object') return { head: '{}', tail: [] };
  if (typeof v === 'boolean') return { head: String(v), tail: [] };
  if (typeof v === 'number') return { head: Number.isFinite(v) ? String(v) : Number.isNaN(v) ? '.nan' : v > 0 ? '.inf' : '-.inf', tail: [] };
  const s = String(v);
  if (s.includes('\n') && !/[\x00-\x08\x0b-\x1f\x7f\uFEFF]/.test(s)) return literal(s, indent);
  return { head: plainSafe(s) ? s : JSON.stringify(s), tail: [] };
}

function literal(s: string, indent: number): { head: string; tail: string[] } {
  let body = s;
  let chomp = '-';
  if (s.endsWith('\n')) {
    body = s.slice(0, -1);
    chomp = body === '' || body.endsWith('\n') ? '+' : '';
  }
  const lines = body.split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  const digit = first < 0 || /^[ \t]/.test(lines[first]) || lines.slice(0, first).some((l) => l !== '') ? '2' : '';
  const pad = ' '.repeat(indent);
  return { head: '|' + digit + chomp, tail: lines.map((l) => (l === '' ? '' : pad + l)) };
}

/** Text that reads back as the same string without quotes (also in older YAML 1.1 readers: no yes/no, 09:00, dates). */
function plainSafe(s: string): boolean {
  return (
    s !== '' &&
    !/^[-?:,[\]{}#&*!|>'"%@`<=\s]/.test(s) &&
    !/\s$/.test(s) &&
    !/: |:$| #|[\x00-\x1f\x7f\x85\u2028\u2029\uFEFF]/.test(s) &&
    !/\p{Cs}/u.test(s) &&
    resolvePlain(s) === s &&
    !/^(y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/.test(s) &&
    !/^[-+.]?[0-9][0-9a-fA-FxXoO_:.+\-TZ ]*$/.test(s)
  );
}
