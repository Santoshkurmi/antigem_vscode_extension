// Fixed facts of the AntiGem browser extension link (Chrome native messaging, like Claude in Chrome).
import os from 'node:os';
import path from 'node:path';

/** The extension's id, pinned by the public `key` in chrome-extension/manifest.json (private key: ~/.antigem/chrome-extension.pem). */
export const EXTENSION_ID = 'kbdjcdlfeoijcchepbldpldeaeijgibi';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
/** Native messaging host name (chrome.runtime.connectNative). */
export const HOST_NAME = 'com.antigem.browser_bridge';
/** Line protocol version between the extension and VS Code. */
export const PROTOCOL = 1;

/** Windows: every pipe the browser link listens on is called \\.\pipe\antigem-browser-<random> (lower case). */
export const PIPE_PREFIX = '\\\\.\\pipe\\antigem-browser-';
/** Windows: the file naming the current pipe (read by the native host on every connection attempt). */
export const PIPE_NAME_FILE = path.join(os.homedir(), '.antigem', 'run', 'browser.pipe');

/**
 * Where the VS Code window that serves the MCP port listens for the native host (Linux / macOS), most preferred first:
 * $ANTIGEM_BROWSER_SOCKET, else $XDG_RUNTIME_DIR/antigem/browser.sock, else ~/.antigem/run/browser.sock (the host tries
 * every candidate, since Chrome and VS Code may not share one environment).
 */
export function socketCandidates(forced?: string | null): string[] {
  const f = forced || process.env.ANTIGEM_BROWSER_SOCKET;
  if (f) return [f];
  const out: string[] = [];
  if (process.env.XDG_RUNTIME_DIR) out.push(path.join(process.env.XDG_RUNTIME_DIR, 'antigem', 'browser.sock'));
  out.push(path.join(os.homedir(), '.antigem', 'run', 'browser.sock'));
  return out;
}
