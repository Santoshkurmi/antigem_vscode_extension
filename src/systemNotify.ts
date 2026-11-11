// The desktop's own notifications (VS Code has no API for them): notify-send on Linux, AppleScript on macOS, a
// PowerShell toast on Windows. A click opens the chat through a vscode:// link, which also brings VS Code forward.
import { spawn } from 'node:child_process';

export interface SystemNote {
  title: string;
  body: string;
  /** vscode://<extension id>/chat?id=… — opens the chat (and focuses VS Code) when the notification is clicked. */
  openUri: string;
  /** PNG for the notification (Linux). */
  icon?: string;
}

/** Why desktop notifications cannot be shown here (null = they can). */
export function systemNotifyUnavailable(remoteName: string | undefined): string | null {
  // the extension host runs on the other machine: a notification would show there, not on this screen
  if (remoteName) return `Not in a remote window (${remoteName}): AntiGem runs on the other machine there`;
  if (process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32') return null;
  return 'Not supported on this system';
}

/** Shows the notification; resolves false when it could not be shown. [open] runs when it is clicked (Linux). */
export function showSystemNote(n: SystemNote, open: () => void, log: (line: string) => void): Promise<boolean> {
  if (process.platform === 'linux') return linux(n, open, log);
  if (process.platform === 'darwin') return mac(n, log);
  if (process.platform === 'win32') return windows(n, log);
  return Promise.resolve(false);
}

const LINUX_WAIT_MS = 30 * 60_000;

function linux(n: SystemNote, open: () => void, log: (line: string) => void): Promise<boolean> {
  const base = ['--app-name=AntiGem', ...(n.icon ? [`--icon=${n.icon}`] : [])];
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const run = (withActions: boolean) => {
      // "default" = a click on the notification itself; "open" = its button
      const args = [...base, ...(withActions ? ['--action=default=Open', '--action=open=Open chat'] : []), '--', n.title, n.body];
      let out = '';
      let err = '';
      let p: ReturnType<typeof spawn>;
      try {
        p = spawn('notify-send', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        done(false);
        return;
      }
      // with actions it waits for a click: shown once it has not failed straight away
      const shown = setTimeout(() => done(true), 800);
      const tooLong = setTimeout(() => p.kill(), LINUX_WAIT_MS);
      p.stdout?.on('data', (d) => (out += d));
      p.stderr?.on('data', (d) => (err += d));
      p.on('error', (e) => {
        clearTimeout(shown);
        clearTimeout(tooLong);
        log(`[notify] notify-send: ${e.message}`);
        done(false);
      });
      p.on('close', (code) => {
        clearTimeout(shown);
        clearTimeout(tooLong);
        // an older notify-send without --action: show it plainly (no click target)
        if (code !== 0 && withActions && !settled) {
          run(false);
          return;
        }
        if (code !== 0 && !settled) log(`[notify] notify-send failed (${code}): ${err.trim()}`);
        done(code === 0);
        const picked = out.trim();
        if (withActions && (picked === 'default' || picked === 'open')) open();
      });
    };
    run(true);
  });
}

function mac(n: SystemNote, log: (line: string) => void): Promise<boolean> {
  // the texts go in as arguments: nothing to escape
  const script = ['on run argv', 'display notification (item 2 of argv) with title "AntiGem" subtitle (item 1 of argv) sound name "Glass"', 'end run'];
  return exec('osascript', [...script.flatMap((l) => ['-e', l]), n.title, n.body], {}, log);
}

function windows(n: SystemNote, log: (line: string) => void): Promise<boolean> {
  const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const [first, ...rest] = n.body.split('\n');
  const xml =
    `<toast activationType="protocol" launch="${xmlEsc(n.openUri)}">` +
    `<visual><binding template="ToastGeneric"><text>${xmlEsc(n.title)}</text><text>${xmlEsc(first ?? '')}</text>` +
    (rest.length ? `<text>${xmlEsc(rest.join(' '))}</text>` : '') +
    `</binding></visual><actions><action content="Open chat" activationType="protocol" arguments="${xmlEsc(n.openUri)}"/></actions></toast>`;
  // the toast goes out under PowerShell's app id (always registered); a click opens the vscode:// link
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$x.LoadXml($env:ANTIGEM_TOAST)',
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show((New-Object Windows.UI.Notifications.ToastNotification $x))",
  ].join('; ');
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { ANTIGEM_TOAST: xml }, log);
}

function exec(cmd: string, args: string[], env: Record<string, string>, log: (line: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    let err = '';
    try {
      const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env }, windowsHide: true });
      p.stderr?.on('data', (d) => (err += d));
      p.on('error', (e) => {
        log(`[notify] ${cmd}: ${e.message}`);
        resolve(false);
      });
      p.on('close', (code) => {
        if (code !== 0) log(`[notify] ${cmd} failed (${code}): ${err.trim().slice(0, 300)}`);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}
