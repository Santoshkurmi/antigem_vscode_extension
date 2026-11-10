// Port of the app's inline markdown (MarkdownContent.kt: INLINE_MARKDOWN_PATTERN + buildRichAnnotatedString) to
// escaped HTML. Links carry data-* attributes; one delegated click handler (App.tsx) opens them.
import { mathReady, renderTex } from './math';
import { themeMode } from '../theme';

const PATTERN = new RegExp(
  [
    String.raw`(\[(.*?)\]\(((?:https?|file|conversation)://[^\s)]+|/[^\s)]+|(?![a-z][a-z0-9+.-]*:)[\w.@~-][^\s()]*)\))`, // 1: [text](url) (+ relative file paths)
    String.raw`(<a\s+href=["']((?:https?|file|conversation)://[^"']+|/[^"']+)["']\s*>(.*?)</a>)`, // 4: <a href>
    String.raw`(file:///[a-zA-Z0-9_./\-#]+)`, // 7: bare file link
    String.raw`(conversation://[a-zA-Z0-9_./\-#]+)`, // 8: bare conversation link
    String.raw`(` + '`' + String.raw`([^` + '`' + String.raw`\n]+)` + '`' + `)`, // 9: `code`
    String.raw`(<code>(.*?)</code>)`, // 11
    String.raw`([$]{1,2}([^$\n]+)[$]{1,2})`, // 13: $math$
    String.raw`(\\\((.*?)\\\))`, // 15: \(math\)
    String.raw`(\*{3}(.+?)\*{3})`, // 17
    String.raw`(___([^_\n]+)___)`, // 19
    String.raw`(\*{2}(.+?)\*{2})`, // 21
    String.raw`(__([^_\n]+)__)`, // 23
    String.raw`(<b>(.*?)</b>)`, // 25
    String.raw`(<strong>(.*?)</strong>)`, // 27
    String.raw`(~~(.+?)~~)`, // 29
    String.raw`(<s>(.*?)</s>)`, // 31
    String.raw`(<del>(.*?)</del>)`, // 33
    String.raw`(<strike>(.*?)</strike>)`, // 35
    String.raw`(<u>(.*?)</u>)`, // 37
    String.raw`(\*(?!\s)(.+?)(?<!\s)\*)`, // 39
    String.raw`(_(?!\s)([^_\n]+?)(?<!\s)_)`, // 41
    String.raw`(<i>(.*?)</i>)`, // 43
    String.raw`(<em>(.*?)</em>)`, // 45
    String.raw`(<kbd>(.*?)</kbd>)`, // 47
  ].join('|'),
  'gis',
);

const BR = /<br\s*\/?>/gi;
const TAGS = /<[^>]+>/g;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

function baseName(p: string): string {
  const clean = p.replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return i >= 0 ? clean.substring(i + 1) || clean : clean;
}

/** "#rgb", "#rrggbb", "#aarrggbb", "0xAARRGGBB", "rgb(…)" → a CSS color, or null (the app's parseHexOrRgbColor). */
export function parseColor(str: string): string | null {
  const c = str.trim();
  let m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(c);
  if (m) {
    const h = m[1];
    if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    if (h.length === 6) return `#${h}`;
    return `#${h.substring(2)}${h.substring(0, 2)}`; // Android ARGB → CSS RGBA
  }
  m = /^(?:Color\()?0x([0-9a-fA-F]{6,8})\)?$/.exec(c);
  if (m) {
    const h = m[1];
    return h.length === 6 ? `#${h}` : `#${h.substring(2)}${h.substring(0, 2)}`;
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(c);
  if (m) return `rgba(${Math.min(255, +m[1])}, ${Math.min(255, +m[2])}, ${Math.min(255, +m[3])}, ${m[4] ?? 1})`;
  return null;
}

/** A path inside inline code that is worth opening on click (`src/app.ts`, `/abs/file.js`, `index.html`). */
function looksLikePath(s: string): boolean {
  if (s.length > 300 || /\s/.test(s)) return false;
  if (/^(https?:)?\/\//.test(s)) return false;
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('~/')) return /[A-Za-z0-9]/.test(s);
  return /^[\w.@-][\w./@-]*\.[A-Za-z0-9]{1,8}(:\d+)?$/.test(s) && !/^\d+(\.\d+)+$/.test(s);
}

function fileAttrs(target: string): string {
  // "path#L12" / "path:12" → line
  let path = target.replace(/^file:\/\//i, '');
  let line = '';
  const lm = /#L?(\d+)(?:-L?\d+)?$/.exec(path) ?? /:(\d+)(?::\d+)?$/.exec(path);
  if (lm) {
    line = lm[1];
    path = path.substring(0, lm.index);
  }
  path = path.replace(/#.*$/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep raw */
  }
  return ` data-file="${esc(path)}"${line ? ` data-line="${line}"` : ''}`;
}

function linkHtml(title: string, url: string, depth: number): string {
  if (/^conversation:\/\//i.test(url)) {
    const id = url.replace(/^conversation:\/\//i, '').split('#')[0].split('/')[0].trim();
    const label = title.trim() && !/^conversation:\/\//i.test(title) ? title : `Chat #${id.substring(0, 8)}`;
    return `<span class="md-conv" data-conv="${esc(id)}"> 💬 ${esc(label)} </span>`;
  }
  const isWeb = /^https?:\/\//i.test(url);
  if (!isWeb) {
    const clean = url.replace(/^file:\/\//i, '').split('#')[0];
    const label = !title.trim() || /^file:\/\//i.test(title) || title.startsWith('/') ? baseName(clean) : title;
    return `<span class="md-file"${fileAttrs(url)}> ${esc(label)} </span>`;
  }
  return `<a class="md-link" data-url="${esc(url)}" href="${esc(url)}">${depth < 3 ? render(title, depth + 1) : esc(title)}</a>`;
}

function render(text: string, depth: number): string {
  const clean = text.includes('<') ? text.replace(BR, '\n') : text;
  if (
    depth > 0 &&
    !/[[<`$*_]/.test(clean) &&
    !/conversation:\/\//i.test(clean) &&
    !/file:\/\//i.test(clean)
  ) {
    return esc(clean);
  }
  let out = '';
  let last = 0;
  PATTERN.lastIndex = 0;
  const re = new RegExp(PATTERN.source, PATTERN.flags); // own lastIndex: render() recurses
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const full = m[0];
    if (!full) {
      re.lastIndex++;
      continue;
    }
    out += esc(clean.substring(last, m.index));
    last = m.index + full.length;
    const nest = (s: string) => (depth >= 3 ? esc(s) : render(s, depth + 1));

    if (m[1]) {
      out += linkHtml(m[2] ?? '', m[3] ?? '', depth);
    } else if (m[4]) {
      out += linkHtml(m[6] ?? '', m[5] ?? '', depth);
    } else if (m[7]) {
      const path = m[7].replace(/^file:\/\//i, '').split('#')[0];
      out += `<span class="md-file"${fileAttrs(m[7])}> ${esc(baseName(path))} </span>`;
    } else if (m[8]) {
      const id = m[8].replace(/^conversation:\/\//i, '').split('#')[0].split('/')[0].trim();
      out += `<span class="md-conv" data-conv="${esc(id)}"> 💬 Chat #${esc(id.substring(0, 8))} </span>`;
    } else if (m[9] || m[11]) {
      const code = m[9] ? m[10] : (m[12] ?? '').replace(TAGS, '');
      const color = parseColor(code);
      if (color) {
        out += `<span class="md-swatch" style="--sw:${esc(color)}"></span><span class="md-code md-code-color" style="--sw:${esc(color)}"> ${esc(code)} </span>`;
      } else if (looksLikePath(code)) {
        out += `<span class="md-code md-code-path"${fileAttrs(code)}> ${esc(code)} </span>`;
      } else {
        out += `<span class="md-code"> ${esc(code)} </span>`;
      }
    } else if (m[13] || m[15]) {
      // inline math ($…$ or \(…\)): KaTeX once loaded, the app's serif-italic text until then / when it fails
      const math = ((m[13] ? m[14] : m[16]) ?? '').trim();
      const tex = renderTex(math, false);
      out += tex !== null ? `<span class="md-math-k">${tex}</span>` : `<span class="md-math">${esc(formatLatex(math))}</span>`;
    } else if (m[17] || m[19]) {
      out += `<strong><em>${nest(m[17] ? m[18] : m[20])}</em></strong>`;
    } else if (m[21] || m[23]) {
      out += `<strong>${nest(m[21] ? m[22] : m[24])}</strong>`;
    } else if (m[25] || m[27]) {
      out += `<strong>${nest((m[25] ? m[26] : m[28]) ?? '')}</strong>`;
    } else if (m[29] || m[31] || m[33] || m[35]) {
      const s = m[29] ? m[30] : m[31] ? m[32] : m[33] ? m[34] : m[36];
      out += `<span class="md-strike">${nest(s ?? '')}</span>`;
    } else if (m[37]) {
      out += `<u>${nest(m[38] ?? '')}</u>`;
    } else if (m[39] || m[41]) {
      out += `<em>${nest(m[39] ? m[40] : m[42])}</em>`;
    } else if (m[43] || m[45]) {
      out += `<em>${nest((m[43] ? m[44] : m[46]) ?? '')}</em>`;
    } else if (m[47]) {
      out += `<span class="md-kbd"> ${esc((m[48] ?? '').replace(TAGS, '').trim())} </span>`;
    } else {
      out += esc(full);
    }
  }
  out += esc(clean.substring(last));
  return out;
}

/** A few LaTeX commands as Unicode (the app's fallback when it cannot draw the formula). */
const LATEX: [RegExp, string][] = [
  [/\\times/g, '×'],
  [/\\cdot/g, '·'],
  [/\\div/g, '÷'],
  [/\\pm/g, '±'],
  [/\\leq?/g, '≤'],
  [/\\geq?/g, '≥'],
  [/\\neq/g, '≠'],
  [/\\approx/g, '≈'],
  [/\\infty/g, '∞'],
  [/\\sum/g, '∑'],
  [/\\prod/g, '∏'],
  [/\\int/g, '∫'],
  [/\\sqrt\{([^}]*)\}/g, '√($1)'],
  [/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)'],
  [/\\alpha/g, 'α'],
  [/\\beta/g, 'β'],
  [/\\gamma/g, 'γ'],
  [/\\delta/g, 'δ'],
  [/\\Delta/g, 'Δ'],
  [/\\theta/g, 'θ'],
  [/\\lambda/g, 'λ'],
  [/\\mu/g, 'μ'],
  [/\\pi/g, 'π'],
  [/\\sigma/g, 'σ'],
  [/\\Sigma/g, 'Σ'],
  [/\\omega/g, 'ω'],
  [/\\Omega/g, 'Ω'],
  [/\\rightarrow|\\to/g, '→'],
  [/\\leftarrow/g, '←'],
  [/\\Rightarrow/g, '⇒'],
  [/\^\{([^}]*)\}/g, '^$1'],
  [/_\{([^}]*)\}/g, '_$1'],
  [/\\left|\\right/g, ''],
  [/\\[,;!: ]/g, ' '],
  [/[{}]/g, ''],
];

export function formatLatex(s: string): string {
  let r = s;
  for (const [re, to] of LATEX) r = r.replace(re, to);
  return r;
}

const cache = new Map<string, string>();

/** Inline markdown → HTML (cached; most lines repeat between renders). */
export function inlineHtml(text: string): string {
  // nothing to format (bare file:// and conversation:// links count as something)
  if (!/[*_`[<$\\~]|:\/\//.test(text)) return esc(text);
  // text with math depends on KaTeX being loaded and on the theme (formula colors): part of the cache key, and read
  // here so the calling view re-renders when either changes
  const key = text.includes('$') || text.includes('\\(') ? `${mathReady() ? 1 : 0}${themeMode()}\u0000${text}` : text;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = render(text, 0);
  cache.set(key, html);
  if (cache.size > 800) cache.delete(cache.keys().next().value!);
  return html;
}
