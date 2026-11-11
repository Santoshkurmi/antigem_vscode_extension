// File links ↔ paths for every OS. VS Code hands out `file:///c%3A/Users/me/proj` on Windows and `%20` for spaces
// everywhere; agents report plain paths (`C:\Users\me\proj`, `/home/me/proj`). Never strip `file://` by hand: that
// gives `/c:/Users/...` (not a Windows path) and leaves `%20` in.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A `file:` link (or a plain path, returned as it is) → a path of this OS. */
export function uriToPath(u: string): string {
  if (!u.startsWith('file:')) {
    // `/C:/x`: a link whose `file://` was cut off by hand (never a real path on Windows)
    if (process.platform === 'win32' && /^\/[A-Za-z]:([\\/]|$)/.test(u)) return path.normalize(u.slice(1));
    return u;
  }
  try {
    return fileURLToPath(u);
  } catch {
    // not a proper file URL (`file://C:\x`, written by hand somewhere): drop the scheme, decode what is safe
    let rest = u.replace(/^file:\/\//, '');
    try {
      rest = decodeURIComponent(rest);
    } catch {
      /* a lone % in a folder name */
    }
    // `/c:/x` → `c:/x` on Windows
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(rest)) rest = rest.slice(1);
    return path.normalize(rest);
  }
}

/** A path (or a link, returned as it is) → a proper `file:` link. */
export function pathToUri(p: string): string {
  if (!p || p.startsWith('file:')) return p;
  return pathToFileURL(uriToPath(p)).href;
}

/** A link or path as a path when it is an absolute one on this OS, else null. */
export function absPath(u: string | null | undefined): string | null {
  if (!u) return null;
  const p = uriToPath(u);
  return path.isAbsolute(p) ? p : null;
}

/**
 * A key to compare folders with: one form for `file:` links and paths, no trailing separator, and case / Unicode
 * folded where the file system ignores them (Windows, macOS).
 */
export function folderKey(u: string): string {
  let p = path.resolve(uriToPath(u));
  if (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p)) p = p.slice(0, -1);
  if (process.platform === 'win32' || process.platform === 'darwin') p = p.normalize('NFC').toLowerCase();
  return p;
}

/** The last part of a path or link, for either separator. */
export function baseName(p: string): string {
  const s = uriToPath(p).replace(/[\\/]+$/, '');
  return s.split(/[\\/]/).pop() || s;
}

/** `~/x` (or `~\x`) → the home folder; anything else unchanged. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  return /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p;
}

/** The home folder shown as `~` (`/home/me/x` → `~/x`), for display. */
export function tildePath(p: string): string {
  const home = os.homedir();
  if (!home) return p;
  const same = process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase().startsWith(home.toLowerCase()) : p.startsWith(home);
  if (!same) return p;
  const rest = p.slice(home.length);
  return rest === '' ? '~' : /^[\\/]/.test(rest) ? `~${rest}` : p;
}
