// Dev only: in a normal browser, make the page look like a VS Code webview — the default stylesheet VS Code injects
// into every webview (prepended, so the app's own CSS comes after it, as in VS Code), the theme's CSS variables and
// the body class (vscode-dark / vscode-light). `?vscode=0` turns it off; `?theme=light` emulates a light theme.

const DEFAULT_STYLES = `
html { scrollbar-color: var(--vscode-scrollbarSlider-background) var(--vscode-editor-background); }
body {
  overscroll-behavior-x: none;
  background-color: transparent;
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-font-family);
  font-weight: var(--vscode-font-weight);
  font-size: var(--vscode-font-size);
  margin: 0;
  padding: 0 20px;
}
img, video { max-width: 100%; max-height: 100%; }
a, a code { color: var(--vscode-textLink-foreground); }
p > a { text-decoration: var(--text-link-decoration); }
a:hover { color: var(--vscode-textLink-activeForeground); }
a:focus, input:focus, select:focus, textarea:focus { outline: 1px solid -webkit-focus-ring-color; outline-offset: -1px; }
code {
  font-family: var(--monaco-monospace-font);
  color: var(--vscode-textPreformat-foreground);
  background-color: var(--vscode-textPreformat-background);
  padding: 1px 3px;
  border-radius: 4px;
}
pre code { padding: 0; }
blockquote { background: var(--vscode-textBlockQuote-background); border-color: var(--vscode-textBlockQuote-border); }
kbd {
  background-color: var(--vscode-keybindingLabel-background);
  color: var(--vscode-keybindingLabel-foreground);
  border-style: solid; border-width: 1px; border-radius: 3px;
  border-color: var(--vscode-keybindingLabel-border);
  border-bottom-color: var(--vscode-keybindingLabel-bottomBorder);
  box-shadow: inset 0 -1px 0 var(--vscode-widget-shadow);
  vertical-align: middle; padding: 1px 3px;
}
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-corner { background-color: var(--vscode-editor-background); }
::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background); }
::-webkit-scrollbar-thumb:hover { background-color: var(--vscode-scrollbarSlider-hoverBackground); }
::-webkit-scrollbar-thumb:active { background-color: var(--vscode-scrollbarSlider-activeBackground); }
`;

const COMMON: Record<string, string> = {
  '--vscode-font-family': 'system-ui, "Ubuntu", "Droid Sans", sans-serif',
  '--vscode-font-weight': 'normal',
  '--vscode-font-size': '13px',
  '--vscode-editor-font-family': '"Droid Sans Mono", "monospace", monospace',
  '--vscode-editor-font-size': '14px',
  '--monaco-monospace-font': '"SF Mono", Monaco, Menlo, Consolas, "Ubuntu Mono", "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace',
  '--text-link-decoration': 'none',
};

// Default Dark Modern / Light Modern values of the variables the default stylesheet reads
const DARK: Record<string, string> = {
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-sideBar-background': '#181818',
  '--vscode-textPreformat-foreground': '#d0d0d0',
  '--vscode-textPreformat-background': '#3c3c3c',
  '--vscode-textLink-foreground': '#4daafc',
  '--vscode-textLink-activeForeground': '#4daafc',
  '--vscode-textBlockQuote-background': '#2b2b2b',
  '--vscode-textBlockQuote-border': '#616161',
  '--vscode-keybindingLabel-background': 'rgba(128, 128, 128, 0.17)',
  '--vscode-keybindingLabel-foreground': '#cccccc',
  '--vscode-keybindingLabel-border': 'rgba(51, 51, 51, 0.6)',
  '--vscode-keybindingLabel-bottomBorder': 'rgba(68, 68, 68, 0.6)',
  '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.36)',
  '--vscode-scrollbarSlider-background': 'rgba(121, 121, 121, 0.4)',
  '--vscode-scrollbarSlider-hoverBackground': 'rgba(100, 100, 100, 0.7)',
  '--vscode-scrollbarSlider-activeBackground': 'rgba(191, 191, 191, 0.4)',
  '--vscode-focusBorder': '#0078d4',
};
const LIGHT: Record<string, string> = {
  '--vscode-editor-foreground': '#3b3b3b',
  '--vscode-editor-background': '#ffffff',
  '--vscode-sideBar-background': '#f8f8f8',
  '--vscode-textPreformat-foreground': '#3b3b3b',
  '--vscode-textPreformat-background': 'rgba(0, 0, 0, 0.12)',
  '--vscode-textLink-foreground': '#005fb8',
  '--vscode-textLink-activeForeground': '#005fb8',
  '--vscode-textBlockQuote-background': '#f8f8f8',
  '--vscode-textBlockQuote-border': '#e5e5e5',
  '--vscode-keybindingLabel-background': 'rgba(221, 221, 221, 0.4)',
  '--vscode-keybindingLabel-foreground': '#3b3b3b',
  '--vscode-keybindingLabel-border': 'rgba(204, 204, 204, 0.4)',
  '--vscode-keybindingLabel-bottomBorder': 'rgba(187, 187, 187, 0.4)',
  '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.16)',
  '--vscode-scrollbarSlider-background': 'rgba(100, 100, 100, 0.4)',
  '--vscode-scrollbarSlider-hoverBackground': 'rgba(100, 100, 100, 0.7)',
  '--vscode-scrollbarSlider-activeBackground': 'rgba(0, 0, 0, 0.6)',
  '--vscode-focusBorder': '#005fb8',
};

const g = globalThis as any;
const params = new URLSearchParams(location.search);
if (import.meta.env.DEV && typeof g.acquireVsCodeApi !== 'function' && params.get('vscode') !== '0') {
  const light = params.get('theme') === 'light';
  const style = document.createElement('style');
  style.id = '_defaultStyles';
  style.textContent = DEFAULT_STYLES;
  document.head.prepend(style);
  const root = document.documentElement;
  for (const [k, v] of Object.entries({ ...COMMON, ...(light ? LIGHT : DARK) })) root.style.setProperty(k, v);
  const applyBody = () => {
    document.body.classList.add(light ? 'vscode-light' : 'vscode-dark');
    document.body.dataset.vscodeThemeKind = light ? 'vscode-light' : 'vscode-dark';
  };
  if (document.body) applyBody();
  else document.addEventListener('DOMContentLoaded', applyBody);
}
