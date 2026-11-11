// Registers the native messaging host com.antigem.browser_bridge for Chromium browsers (like Claude Code registers
// com.anthropic.claude_code_browser_extension) that only our pinned extension id may use:
//   - Linux / macOS: a small wrapper script that runs `<bin> --native-host`, and a host manifest in each installed
//     browser's NativeMessagingHosts folder;
//   - Windows: one host manifest (~/.antigem/chrome/com.antigem.browser_bridge.json) that names the bridge .exe itself
//     (Chrome passes its origin, which puts the bridge in native-host mode), and per browser a registry key
//     HKCU\Software\<browser>\NativeMessagingHosts\com.antigem.browser_bridge whose default value is that manifest. No
//     .bat wrapper: cmd.exe reads batch files in the OEM code page, which breaks a user name like "Jürgen".
// Runs only from the explicit "Register with Chrome" button (Settings → Browser), never at activation.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION_ORIGIN, HOST_NAME } from './constants';

export interface BrowserTarget {
  id: string;
  name: string;
  /** The browser's user-data folder (exists when the browser was used on this PC). */
  userDir: string;
  /** Its NativeMessagingHosts folder (Linux / macOS). */
  dir: string;
  /**
   * Windows: the HKCU keys (`Software\Google\Chrome`…) under whose NativeMessagingHosts the browser looks for hosts.
   * Side-by-side Chrome channels and some forks may read Chrome's key instead of their own: both are written.
   */
  regKeys?: string[];
}

const isWin = () => process.platform === 'win32';

/** Chromium browsers we know, per OS. */
export function browserTargets(): BrowserTarget[] {
  const home = os.homedir();
  if (isWin()) {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const chrome = 'Software\\Google\\Chrome';
    const win: [string, string, string, string[]][] = [
      ['chrome', 'Google Chrome', 'Google\\Chrome\\User Data', [chrome]],
      ['chrome-beta', 'Google Chrome Beta', 'Google\\Chrome Beta\\User Data', ['Software\\Google\\Chrome Beta', chrome]],
      ['chrome-dev', 'Google Chrome Dev', 'Google\\Chrome Dev\\User Data', ['Software\\Google\\Chrome Dev', chrome]],
      ['chrome-canary', 'Google Chrome Canary', 'Google\\Chrome SxS\\User Data', ['Software\\Google\\Chrome SxS', chrome]],
      ['chromium', 'Chromium', 'Chromium\\User Data', ['Software\\Chromium']],
      ['brave', 'Brave', 'BraveSoftware\\Brave-Browser\\User Data', ['Software\\BraveSoftware\\Brave-Browser', chrome]],
      ['edge', 'Microsoft Edge', 'Microsoft\\Edge\\User Data', ['Software\\Microsoft\\Edge']],
      ['vivaldi', 'Vivaldi', 'Vivaldi\\User Data', ['Software\\Vivaldi', chrome]],
    ];
    return win.map(([id, name, rel, regKeys]) => ({ id, name, userDir: path.join(local, rel), dir: '', regKeys }));
  }
  const list: [string, string, string][] =
    process.platform === 'darwin'
      ? [
          ['chrome', 'Google Chrome', 'Library/Application Support/Google/Chrome'],
          ['chrome-beta', 'Google Chrome Beta', 'Library/Application Support/Google/Chrome Beta'],
          ['chrome-canary', 'Google Chrome Canary', 'Library/Application Support/Google/Chrome Canary'],
          ['chromium', 'Chromium', 'Library/Application Support/Chromium'],
          ['brave', 'Brave', 'Library/Application Support/BraveSoftware/Brave-Browser'],
          ['edge', 'Microsoft Edge', 'Library/Application Support/Microsoft Edge'],
          ['vivaldi', 'Vivaldi', 'Library/Application Support/Vivaldi'],
        ]
      : [
          ['chrome', 'Google Chrome', '.config/google-chrome'],
          ['chrome-beta', 'Google Chrome Beta', '.config/google-chrome-beta'],
          ['chrome-dev', 'Google Chrome Dev', '.config/google-chrome-unstable'],
          ['chromium', 'Chromium', '.config/chromium'],
          ['brave', 'Brave', '.config/BraveSoftware/Brave-Browser'],
          ['edge', 'Microsoft Edge', '.config/microsoft-edge'],
          ['vivaldi', 'Vivaldi', '.config/vivaldi'],
        ];
  return list.map(([id, name, rel]) => {
    const userDir = path.join(home, rel);
    return { id, name, userDir, dir: path.join(userDir, 'NativeMessagingHosts') };
  });
}

export const manifestName = `${HOST_NAME}.json`;

/**
 * Where the wrapper script lives (stable across extension updates; its target is the current binary). On Windows this
 * is the host manifest itself, which names the current binary.
 */
export function defaultWrapperPath() {
  return path.join(os.homedir(), '.antigem', 'chrome', isWin() ? manifestName : 'antigem-native-host');
}

// ---- Windows registry (reg.exe: always there, no admin rights needed for HKCU)

const regExe = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
const hostKey = (regKey: string) => `HKCU\\${regKey}\\NativeMessagingHosts\\${HOST_NAME}`;

function reg(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(regExe(), args, { windowsHide: true, timeout: 15_000 }, (e, stdout, stderr) => resolve({ ok: !e, out: String(stdout), err: String(stderr || e?.message || '').trim() }));
  });
}

/** The default value of a host key (the manifest path), or null when the key is not there. */
async function regHostValue(regKey: string): Promise<string | null> {
  const r = await reg(['query', hostKey(regKey), '/ve']);
  if (!r.ok) return null;
  // "    (Default)    REG_SZ    C:\…" ("(Default)" is translated on other Windows languages)
  return /REG_(?:EXPAND_)?SZ[ \t]+(.+?)[ \t]*$/m.exec(r.out)?.[1] ?? '';
}

const winKeys = (targets: BrowserTarget[]) => [...new Set(targets.flatMap((t) => t.regKeys ?? []))];

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function wrapperScript(binPath: string, socketPath?: string | null) {
  return [
    '#!/bin/sh',
    '# AntiGem native messaging host for Chromium browsers (com.antigem.browser_bridge).',
    '# Generated by the AntiGem VS Code extension: Settings -> Browser -> Register with Chrome. Do not edit.',
    `exec ${shQuote(binPath)} --native-host${socketPath ? ` --socket ${shQuote(socketPath)}` : ''} "$@"`,
    '',
  ].join('\n');
}

export function hostManifest(wrapper: string) {
  return {
    name: HOST_NAME,
    description: 'AntiGem browser bridge (connects the AntiGem extension to VS Code)',
    path: wrapper,
    type: 'stdio',
    allowed_origins: [EXTENSION_ORIGIN],
  };
}

export interface RegisterOptions {
  /** The bridge binary (`<extension>/bin/antigem-bridge-<platform>-<arch>`). */
  binPath: string;
  /** NativeMessagingHosts folders to write (default: every installed browser's). */
  dirs?: string[];
  wrapper?: string;
  /** Bake a socket path into the wrapper (tests). */
  socketPath?: string | null;
}

export interface RegisterResult {
  wrapper: string;
  written: string[];
  browsers: string[];
}

export async function register(o: RegisterOptions): Promise<RegisterResult> {
  if (!fs.existsSync(o.binPath)) throw new Error(`The AntiGem bridge binary is missing: ${o.binPath}`);
  if (isWin()) return registerWindows(o);
  const wrapper = o.wrapper ?? defaultWrapperPath();
  fs.mkdirSync(path.dirname(wrapper), { recursive: true, mode: 0o700 });
  const tmp = `${wrapper}.tmp`;
  fs.writeFileSync(tmp, wrapperScript(o.binPath, o.socketPath), { mode: 0o755 });
  fs.renameSync(tmp, wrapper);
  fs.chmodSync(wrapper, 0o755);
  const manifest = `${JSON.stringify(hostManifest(wrapper), null, 2)}\n`;
  const written: string[] = [];
  const browsers: string[] = [];
  const targets = o.dirs
    ? o.dirs.map((dir) => ({ name: dir, dir, userDir: path.dirname(dir) }))
    : browserTargets().filter((t) => fs.existsSync(t.userDir));
  if (!targets.length) throw new Error('No Chromium browser profile found (Chrome, Chromium, Brave, Edge, Vivaldi). Open the browser once, then register again.');
  for (const t of targets) {
    fs.mkdirSync(t.dir, { recursive: true });
    const file = path.join(t.dir, manifestName);
    fs.writeFileSync(file, manifest, { mode: 0o644 });
    written.push(file);
    browsers.push(t.name);
  }
  return { wrapper, written, browsers };
}

/** Windows: the manifest names the bridge .exe; each installed browser's registry key names the manifest. */
async function registerWindows(o: RegisterOptions): Promise<RegisterResult> {
  const manifestFile = o.wrapper ?? defaultWrapperPath();
  const targets = browserTargets().filter((t) => fs.existsSync(t.userDir));
  if (!targets.length) throw new Error('No Chromium browser profile found (Chrome, Chromium, Brave, Edge, Vivaldi). Open the browser once, then register again.');
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  const tmp = `${manifestFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(hostManifest(path.resolve(o.binPath)), null, 2)}\n`);
  fs.renameSync(tmp, manifestFile);
  const written: string[] = [];
  for (const key of winKeys(targets)) {
    const r = await reg(['add', hostKey(key), '/ve', '/t', 'REG_SZ', '/d', manifestFile, '/f']);
    if (!r.ok) throw new Error(`Could not write the registry key ${hostKey(key)}: ${r.err}`);
    written.push(hostKey(key));
  }
  return { wrapper: manifestFile, written, browsers: targets.map((t) => t.name) };
}

/** Removes our host manifests (and the wrapper; on Windows the registry keys and the manifest). */
export async function unregister(wrapper = defaultWrapperPath()): Promise<string[]> {
  if (isWin()) {
    const removed: string[] = [];
    for (const key of winKeys(browserTargets())) {
      if ((await regHostValue(key)) === null) continue;
      if ((await reg(['delete', hostKey(key), '/f'])).ok) removed.push(hostKey(key));
    }
    fs.rmSync(wrapper, { force: true });
    return removed;
  }
  const removed: string[] = [];
  for (const t of browserTargets()) {
    const file = path.join(t.dir, manifestName);
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (m?.name !== HOST_NAME) continue;
      fs.unlinkSync(file);
      removed.push(file);
    } catch {
      /* not there */
    }
  }
  try {
    fs.unlinkSync(wrapper);
  } catch {
    /* not there */
  }
  return removed;
}

export interface RegistrationStatus {
  wrapper: string;
  wrapperExists: boolean;
  /** The binary the wrapper runs. */
  wrapperTarget: string | null;
  /** The wrapper runs this extension's own binary (false after an extension update moved it). */
  wrapperCurrent: boolean;
  browsers: { id: string; name: string; installed: boolean; registered: boolean; manifestOk: boolean }[];
}

export async function registrationStatus(binPath: string, wrapper = defaultWrapperPath()): Promise<RegistrationStatus> {
  if (isWin()) return registrationStatusWindows(binPath, wrapper);
  let target: string | null = null;
  try {
    const m = /exec '((?:[^']|'\\'')*)' --native-host/.exec(fs.readFileSync(wrapper, 'utf8'));
    target = m ? m[1].replace(/'\\''/g, "'") : null;
  } catch {
    target = null;
  }
  const browsers = browserTargets().map((t) => {
    const installed = fs.existsSync(t.userDir);
    let registered = false;
    let manifestOk = false;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(t.dir, manifestName), 'utf8'));
      registered = m?.name === HOST_NAME;
      manifestOk = registered && m.path === wrapper && Array.isArray(m.allowed_origins) && m.allowed_origins.includes(EXTENSION_ORIGIN);
    } catch {
      /* none */
    }
    return { id: t.id, name: t.name, installed, registered, manifestOk };
  });
  return {
    wrapper,
    wrapperExists: fs.existsSync(wrapper),
    wrapperTarget: target,
    wrapperCurrent: !!target && path.resolve(target) === path.resolve(binPath) && fs.existsSync(target),
    browsers,
  };
}

/** Windows: the manifest (wrapper = its path) and, per browser, whether one of its registry keys names it. */
async function registrationStatusWindows(binPath: string, manifestFile: string): Promise<RegistrationStatus> {
  let target: string | null = null;
  let manifestValid = false;
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    target = typeof m?.path === 'string' ? m.path : null;
    manifestValid = m?.name === HOST_NAME && Array.isArray(m.allowed_origins) && m.allowed_origins.includes(EXTENSION_ORIGIN);
  } catch {
    /* none */
  }
  const targets = browserTargets();
  const values = new Map<string, string | null>();
  await Promise.all(winKeys(targets).map(async (k) => values.set(k, await regHostValue(k))));
  // reg.exe prints in the console code page: a path with other than ASCII letters cannot be compared reliably
  const ascii = /^[\x20-\x7e]*$/.test(manifestFile);
  const same = (v: string) => !ascii || v.toLowerCase() === manifestFile.toLowerCase();
  const browsers = targets.map((t) => {
    const found = (t.regKeys ?? []).map((k) => values.get(k)).filter((v): v is string => v != null);
    const installed = fs.existsSync(t.userDir);
    // several browsers share Chrome's key: only the ones on this PC count
    const registered = installed && found.length > 0;
    return { id: t.id, name: t.name, installed, registered, manifestOk: registered && manifestValid && found.some(same) };
  });
  const sameFile = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  return {
    wrapper: manifestFile,
    wrapperExists: fs.existsSync(manifestFile),
    wrapperTarget: target,
    wrapperCurrent: !!target && sameFile(target, binPath) && fs.existsSync(target),
    browsers,
  };
}

/**
 * Copies the bundled chrome-extension folder to a stable place (~/.antigem/chrome-extension) for "Load unpacked":
 * the VS Code extension's own folder changes with every update, which would break an unpacked install.
 */
export function installExtensionFiles(srcDir: string, destDir = path.join(os.homedir(), '.antigem', 'chrome-extension')): string {
  if (!fs.existsSync(path.join(srcDir, 'manifest.json'))) throw new Error(`The bundled browser extension is missing: ${srcDir}`);
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  const tmp = `${destDir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  // hidden entries (.git of the extension's own repository, editor files) are not part of the extension
  fs.cpSync(srcDir, tmp, { recursive: true, filter: (src) => src === srcDir || !path.basename(src).startsWith('.') });
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.renameSync(tmp, destDir);
  return destDir;
}

/** Version of an extension folder's manifest (null when missing). */
export function extensionVersion(dir: string): string | null {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version ?? '') || null;
  } catch {
    return null;
  }
}
