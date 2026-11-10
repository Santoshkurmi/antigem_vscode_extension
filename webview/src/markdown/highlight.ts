// Port of the app's regex highlighter (ui/components/CodeBlock.kt: highlightSyntax) to HTML spans.
// Same token classes, patterns and colors; overlapping matches are resolved by priority
// (comment > string > annotation > number > keyword > type > function) so a keyword inside a string stays a string.
import { esc } from './inline';

const COMMENT_PY_SH = /#.*/gm;
const COMMENT_SQL = /(--.*|\/\*[\s\S]*?\*\/)/gm;
const COMMENT_GENERIC = /(\/\/.*|\/\*[\s\S]*?\*\/|#.*)/gm;
const STRING = /("(\\.|[^"\\])*"|'(\\.|[^'\\])*'|`(\\.|[^`\\])*`)/g;
const NUMBER = /\b(0x[0-9a-fA-F]+|\d+(\.\d+)?([eE][+-]?\d+)?[fFL]?)\b/g;
const ANNOTATION = /@[A-Za-z0-9_.]+/g;
const KOTLIN_KW = /\b(package|import|fun|val|var|class|interface|object|enum|return|if|else|when|for|while|do|try|catch|finally|throw|override|private|public|protected|internal|abstract|data|sealed|open|const|suspend|inline|is|as|in|by|companion|lateinit|typealias|this|super|null|true|false)\b/g;
const PYTHON_KW = /\b(def|class|return|if|elif|else|for|while|try|except|finally|raise|import|from|as|with|lambda|async|await|yield|pass|break|continue|global|nonlocal|in|is|not|and|or|None|True|False|self|cls)\b/g;
const JS_KW = /\b(function|const|let|var|return|if|else|switch|case|default|for|while|do|try|catch|finally|throw|import|export|from|as|class|extends|interface|type|async|await|yield|new|this|super|null|undefined|true|false|typeof|instanceof|in|of|void)\b/g;
const SQL_KW = /\b(SELECT|FROM|WHERE|INSERT|INTO|UPDATE|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|CREATE|TABLE|ALTER|DROP|INDEX|VIEW|AS|AND|OR|NOT|IN|IS|NULL|LIKE|BETWEEN|UNION|ALL|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END)\b/gi;
const GENERAL_KW = /\b(fun|val|var|class|interface|def|function|const|let|return|if|else|for|while|try|catch|finally|throw|import|package|public|private|protected|override|async|await|new|this|super|null|true|false|SELECT|FROM|WHERE)\b/g;
const TYPES = /\b(String|Int|Long|Float|Double|Boolean|Char|Byte|Short|List|Map|Set|Array|Any|Unit|Nothing|Throwable|Exception|Result|StateFlow|Flow|MutableStateFlow|Promise|Observable|void|int|float|double|bool|char|number|string|boolean|any|unknown|never|dict|tuple|str)\b/g;
const FUNCTION = /\b([a-zA-Z_][a-zA-Z0-9_]*)(?=\s*\()/g;

interface Span {
  s: number;
  e: number;
  cls: string;
  p: number;
}

function collect(code: string, re: RegExp, cls: string, p: number, out: Span[]) {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(code)) && guard++ < 50_000) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    out.push({ s: m.index, e: m.index + m[0].length, cls, p });
  }
}

export function highlight(code: string, language: string): string {
  const lang = language.toLowerCase().trim();
  const spans: Span[] = [];
  const comment =
    ['python', 'py', 'bash', 'sh', 'shell', 'yaml', 'yml', 'dockerfile', 'zsh', 'toml'].includes(lang)
      ? COMMENT_PY_SH
      : lang === 'sql'
        ? COMMENT_SQL
        : COMMENT_GENERIC;
  collect(code, comment, 'tk-c', 0, spans);
  collect(code, STRING, 'tk-s', 1, spans);
  collect(code, ANNOTATION, 'tk-a', 2, spans);
  collect(code, NUMBER, 'tk-n', 3, spans);
  const kw =
    lang === 'kotlin' || lang === 'kt' || lang === 'kts'
      ? KOTLIN_KW
      : lang === 'python' || lang === 'py'
        ? PYTHON_KW
        : ['javascript', 'js', 'typescript', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].includes(lang)
          ? JS_KW
          : lang === 'sql'
            ? SQL_KW
            : GENERAL_KW;
  collect(code, kw, 'tk-k', 4, spans);
  collect(code, TYPES, 'tk-t', 5, spans);
  FUNCTION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNCTION.exec(code))) spans.push({ s: m.index, e: m.index + m[1].length, cls: 'tk-f', p: 6 });

  // resolve overlaps by priority: comments/strings claim their ranges first, then the rest fill the gaps
  const taken: Span[] = [];
  const byPriority = spans.sort((a, b) => a.p - b.p || a.s - b.s);
  const claimed: Span[] = [];
  const overlaps = (x: Span) => {
    // claimed is kept sorted by start; binary search the first that ends after x.s
    let lo = 0;
    let hi = claimed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (claimed[mid].e <= x.s) lo = mid + 1;
      else hi = mid;
    }
    return lo < claimed.length && claimed[lo].s < x.e;
  };
  for (const sp of byPriority) {
    if (overlaps(sp)) continue;
    // insert sorted by start
    let lo = 0;
    let hi = claimed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (claimed[mid].s < sp.s) lo = mid + 1;
      else hi = mid;
    }
    claimed.splice(lo, 0, sp);
  }
  taken.push(...claimed);

  let out = '';
  let pos = 0;
  for (const sp of taken) {
    if (sp.s > pos) out += esc(code.substring(pos, sp.s));
    out += `<span class="${sp.cls}">${esc(code.substring(sp.s, sp.e))}</span>`;
    pos = sp.e;
  }
  out += esc(code.substring(pos));
  return out;
}

const cache = new Map<string, string>();

export function highlightCached(code: string, language: string): string {
  const key = language + '\u0000' + code;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = highlight(code, language);
  cache.set(key, html);
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return html;
}
