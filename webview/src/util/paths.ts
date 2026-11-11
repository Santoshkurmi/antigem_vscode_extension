// File links and paths in the webview (no Node `path` here). Links come as `file:///c%3A/Users/me/x` (VS Code on
// Windows) or `file:///home/me/my%20x`; agents report plain paths of any OS (`C:\Users\me\x`, `/home/me/x`). Never
// cut `file://` off by hand: that leaves `%20` in and gives `/C:/…`, which is not a Windows path.

/** A `file:` link → a plain path (decoded; `file:///C:/x` → `C:/x`); anything else is returned as it is. */
export function fileLinkToPath(p: string): string {
  let s = p.trim();
  if (!/^file:\/\//i.test(s)) return s;
  s = s.replace(/^file:\/\/(localhost)?/i, '');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* a lone % in a folder name: keep it as written */
  }
  if (/^\/[a-zA-Z]:([\\/]|$)/.test(s)) s = s.slice(1);
  return s;
}

/** The last part of a path or link, for either separator. */
export function pathBaseName(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  return s.substring(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1) || s;
}

/** One form of a folder link / path for comparing: `/` separators, no trailing one, drive paths in lower case. */
function pathKey(p: string): string {
  const s = fileLinkToPath(p).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
}

/** Whether two links / paths name the same folder (`file:///c%3A/x` = `file:///C:/x` = `C:\x`). */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && pathKey(a) === pathKey(b);
}
