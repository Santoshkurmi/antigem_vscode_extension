// LaTeX like the app's MarkdownContent.kt (NativeMathView / inline JLatexMath): the same delimiters (parsed in
// parse.ts / inline.ts), the same coloring of the formula (colorizeLatexEquation), the same colors and sizes, and the
// same fallback when a formula does not parse. KaTeX is loaded the first time a message contains math.
import { createRoot, createSignal } from 'solid-js';
import { themeMode } from '../theme';

type Katex = typeof import('katex').default;
let katex: Katex | null = null;
let loading: Promise<void> | null = null;
const [ready, setReady] = createRoot(() => createSignal(false));

/** True once KaTeX is loaded (math renders again then). */
export const mathReady = ready;

export function ensureKatex() {
  if (!loading) {
    loading = import('katex')
      .then((m) => {
        katex = m.default;
        setReady(true);
      })
      .catch(() => {
        loading = null;
      });
  }
}

// JLatexMath's named colors (java.awt values) as the app uses them per theme
const COLORS = {
  dark: { num: '#FFC800', op: '#00FFFF', greek: '#FFFF00', func: '#00FF00' },
  light: { num: '#FFC800', op: '#008080', greek: '#800080', func: '#0000FF' },
};

/** colorizeLatexEquation(): big operators, Greek letters, functions and numbers in their own colors. */
export function colorize(latex: string, dark: boolean): string {
  if (latex.includes('\\color') || latex.includes('\\textcolor')) return latex;
  const c = dark ? COLORS.dark : COLORS.light;
  let r = latex;
  r = r.replace(/(\\(?:int|iint|iiint|oint|sum|prod|coprod|lim)\b)/g, `\\textcolor{${c.op}}{$1}`);
  r = r.replace(
    /(\\(?:alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)\b)/g,
    `\\textcolor{${c.greek}}{$1}`,
  );
  r = r.replace(/(\\(?:sin|cos|tan|cot|sec|csc|log|ln|exp|det|max|min)\b)/g, `\\textcolor{${c.func}}{$1}`);
  r = r.replace(/(?<![a-zA-Z\\])(\b\d+(?:\.\d+)?\b)/g, `\\textcolor{${c.num}}{$1}`);
  return r;
}

/** The app strips stray delimiters before rendering. */
export function cleanLatex(latex: string): string {
  return latex
    .trim()
    .replace(/^\$\$|\$\$$/g, '')
    .replace(/^\\\[|\\\]$/g, '')
    .replace(/^\$|\$$/g, '')
    .trim();
}

const cache = new Map<string, string | null>();

/**
 * The formula as KaTeX HTML (colorized first, then plain, like the app), null while KaTeX loads or when the formula
 * cannot be drawn (the caller shows the app's text fallback then).
 */
export function renderTex(latex: string, display: boolean): string | null {
  if (!katex) {
    ensureKatex();
    return null;
  }
  const dark = themeMode() === 'dark';
  const tex = cleanLatex(latex);
  const key = `${display ? 'D' : 'I'}${dark ? 1 : 0}${tex}`;
  if (cache.has(key)) return cache.get(key)!;
  let html: string | null = null;
  for (const src of [colorize(tex, dark), tex]) {
    try {
      html = katex.renderToString(src, { displayMode: display, throwOnError: true, strict: 'ignore', output: 'html', trust: false });
      break;
    } catch {
      /* next attempt */
    }
  }
  cache.set(key, html);
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return html;
}
