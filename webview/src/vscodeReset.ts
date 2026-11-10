// VS Code puts its default stylesheet (<style id="_defaultStyles">) at the top of every webview: body padding, a boxed
// background on every <code>, link colors, blockquote / kbd looks, focus outlines, scrollbars. The app draws all of
// that itself (like the Android app), so the sheet is taken out, and again if VS Code ever puts it back. base.css
// also overrides each of those rules for the whole document (portals included), in case the sheet stays.
// Dev: `?keepvscodecss` keeps the (emulated) sheet, to check that base.css alone is enough.

const ID = '_defaultStyles';

function strip() {
  document.getElementById(ID)?.remove();
}

if (!(import.meta.env.DEV && new URLSearchParams(location.search).has('keepvscodecss'))) {
  strip();
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if ((n as Element).id === ID) return strip();
  }).observe(document.head, { childList: true });
}

export {};
