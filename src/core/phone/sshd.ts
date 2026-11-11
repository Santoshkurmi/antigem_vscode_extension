// Connect phone: this PC's SSH server, per OS. Finds it (and its port), reads its host keys for the phone to pin, and
// adds / removes the phones' keys in the file sshd reads:
//   Linux, macOS: ~/.ssh/authorized_keys
//   Windows:      %USERPROFILE%\.ssh\authorized_keys, or for a member of Administrators (when sshd_config keeps its
//                 default "Match Group administrators") C:\ProgramData\ssh\administrators_authorized_keys, which only an
//                 elevated process may read or write: that edit runs through one UAC prompt.
// Every phone line ends with "antigem-phone:<phone id>" (the key's comment), which is how it is found again.
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';
const MARK = 'antigem-phone:';

export interface SshdInfo {
  running: boolean;
  port: number;
  /** The server's greeting ("SSH-2.0-OpenSSH_9.6"), when it answered. */
  banner: string;
}

export interface HostKey {
  type: string;
  key: string;
}

function sshdConfigPath(): string {
  return isWin ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh', 'sshd_config') : '/etc/ssh/sshd_config';
}

function readConfig(): string {
  try {
    return fs.readFileSync(sshdConfigPath(), 'utf8');
  } catch {
    return '';
  }
}

/** The port sshd listens on (its config's first Port, else 22). */
export function sshdPort(): number {
  const m = /^\s*Port\s+(\d+)/im.exec(readConfig());
  const n = m ? Number(m[1]) : 22;
  return n > 0 && n < 65536 ? n : 22;
}

/** Is an SSH server answering on this PC? */
export function sshdStatus(port = sshdPort()): Promise<SshdInfo> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let banner = '';
    const done = (running: boolean) => {
      s.destroy();
      resolve({ running, port, banner: banner.trim() });
    };
    s.setTimeout(2500, () => done(banner.startsWith('SSH-')));
    s.on('data', (d) => {
      banner += d.toString('utf8');
      if (banner.includes('\n')) done(banner.startsWith('SSH-'));
    });
    s.on('error', () => done(false));
  });
}

/** The SSH server's host public keys: asked from the server itself (ssh-keyscan), else read from its key files. */
export async function hostKeys(port = sshdPort()): Promise<HostKey[]> {
  const fromScan = await new Promise<HostKey[]>((resolve) => {
    execFile('ssh-keyscan', ['-p', String(port), '-T', '4', '127.0.0.1'], { timeout: 10_000, windowsHide: true }, (err, out) => {
      if (err && !out) return resolve([]);
      const keys: HostKey[] = [];
      for (const line of String(out).split('\n')) {
        const [, type, key] = line.trim().split(/\s+/);
        if (type && key && !line.startsWith('#')) keys.push({ type, key });
      }
      resolve(keys);
    });
  });
  if (fromScan.length) return dedupe(fromScan);
  const dir = isWin ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh') : '/etc/ssh';
  const keys: HostKey[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^ssh_host_.*_key\.pub$/.test(f)) continue;
      const [type, key] = fs.readFileSync(path.join(dir, f), 'utf8').trim().split(/\s+/);
      if (type && key) keys.push({ type, key });
    }
  } catch {
    /* not readable */
  }
  return dedupe(keys);
}

function dedupe(keys: HostKey[]): HostKey[] {
  const seen = new Set<string>();
  return keys.filter((k) => !seen.has(k.key) && seen.add(k.key));
}

/** The SSH login name of this user. */
export function sshUser(): string {
  return os.userInfo().username;
}

// ------------------------------------------------------------------ the phones' lines

/**
 * The line for one phone. Without the terminal: only SFTP (the phone reads the bridge token) and tunnels to the bridge
 * and hub ports. With it: a shell too ("Allow terminal from phone").
 */
export function keyLine(publicKey: string, ports: number[], terminal: boolean): string {
  const opens = ports.map((p) => `permitopen="127.0.0.1:${p}"`).join(',');
  const opts = terminal ? `restrict,port-forwarding,pty,${opens}` : `command="internal-sftp",restrict,port-forwarding,${opens}`;
  return `${opts} ${publicKey.trim()}`;
}

/** A public key line from the phone: "ecdsa-sha2-nistp256 AAAA… antigem-phone:<id>", nothing else on it. */
export function validPhoneKey(publicKey: string, phoneId: string): boolean {
  const m = /^(ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ssh-ed25519|ssh-rsa) ([A-Za-z0-9+/]+={0,2}) (\S+)$/.exec(publicKey.trim());
  return !!m && m[3] === MARK + phoneId && /^[A-Za-z0-9-]{8,64}$/.test(phoneId);
}

interface KeyFile {
  path: string;
  /** Windows admin file: edited by an elevated helper. */
  elevated: boolean;
}

/** Is the user in Administrators (Windows; a filtered, not-elevated token still lists the group)? */
function isWindowsAdmin(): boolean {
  const r = spawnSync('whoami', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && /S-1-5-32-544/.test(r.stdout || '');
}

export function keyFile(): KeyFile {
  if (isWin) {
    const cfg = readConfig();
    // sshd's default config sends Administrators to the shared file (unless the user commented that block out)
    const adminBlock = /^\s*Match\s+Group\s+administrators\b/im.test(cfg) || cfg === '';
    if (adminBlock && isWindowsAdmin()) {
      return { path: path.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh', 'administrators_authorized_keys'), elevated: true };
    }
  }
  return { path: path.join(os.homedir(), '.ssh', 'authorized_keys'), elevated: false };
}

/**
 * Puts the phones' lines in place: removes every line of [removeIds] (null = every AntiGem phone) and adds [add]. Other
 * lines are kept as they are. Throws a message for the user (a cancelled UAC prompt, no permission…).
 */
export async function editKeys(removeIds: string[] | null, add: string[], file = keyFile()): Promise<void> {
  const drop = (line: string) => {
    const i = line.lastIndexOf(MARK);
    if (i < 0) return false;
    if (removeIds === null) return true;
    return removeIds.includes(line.slice(i + MARK.length).trim());
  };
  if (file.elevated) return editElevated(file.path, removeIds, add);
  const dir = path.dirname(file.path);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isWin) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* not ours to change */
    }
  }
  let old = '';
  try {
    old = fs.readFileSync(file.path, 'utf8');
  } catch {
    old = '';
  }
  const eol = old.includes('\r\n') ? '\r\n' : '\n';
  const kept = old.split(/\r?\n/).filter((l) => l.trim() && !drop(l));
  const next = [...kept, ...add].join(eol) + eol;
  if (next === old) return;
  // a new file next to it, then a rename: sshd never reads a half-written file
  const tmp = `${file.path}.antigem-${process.pid}`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  if (!isWin) fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file.path);
}

/** Windows admin file: an elevated PowerShell does the edit (one UAC prompt) and keeps the file's required ACL. */
function editElevated(target: string, removeIds: string[] | null, add: string[]): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigem-keys-'));
  const job = path.join(dir, 'job.json');
  const script = path.join(dir, 'edit.ps1');
  const result = path.join(dir, 'result.txt');
  fs.writeFileSync(job, JSON.stringify({ target, removeIds, add, result, mark: MARK }), 'utf8');
  fs.writeFileSync(
    script,
    [
      '$ErrorActionPreference = "Stop"',
      `$j = Get-Content -Raw -LiteralPath '${job.replace(/'/g, "''")}' | ConvertFrom-Json`,
      'try {',
      '  $lines = @()',
      '  if (Test-Path -LiteralPath $j.target) { $lines = @(Get-Content -LiteralPath $j.target) }',
      '  $keep = @($lines | Where-Object {',
      '    $l = $_; if (-not $l.Trim()) { return $false }',
      '    $i = $l.LastIndexOf($j.mark); if ($i -lt 0) { return $true }',
      '    if ($null -eq $j.removeIds) { return $false }',
      '    $id = $l.Substring($i + $j.mark.Length).Trim()',
      '    return -not ($j.removeIds -contains $id)',
      '  })',
      '  $out = @($keep) + @($j.add)',
      '  [System.IO.File]::WriteAllLines($j.target, [string[]]$out, (New-Object System.Text.UTF8Encoding($false)))',
      // sshd refuses this file unless only Administrators and SYSTEM may access it
      '  icacls $j.target /inheritance:r /grant "*S-1-5-32-544:F" /grant "*S-1-5-18:F" | Out-Null',
      '  Set-Content -LiteralPath $j.result -Value "ok"',
      '} catch { Set-Content -LiteralPath $j.result -Value ("error: " + $_.Exception.Message) }',
    ].join('\r\n'),
    'utf8',
  );
  const outer =
    `Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden ` +
    `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${script.replace(/'/g, "''")}"'`;
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', outer], { windowsHide: true, timeout: 180_000 }, (err) => {
      let res = '';
      try {
        res = fs.readFileSync(result, 'utf8').trim();
      } catch {
        res = '';
      }
      fs.rmSync(dir, { recursive: true, force: true });
      if (res === 'ok') resolve();
      else if (res.startsWith('error:')) reject(new Error(`Could not update ${target}: ${res.slice(6).trim()}`));
      else reject(new Error(err ? 'The Windows admin prompt was cancelled: the phone\'s key was not added.' : `Could not update ${target}.`));
    });
  });
}

// ------------------------------------------------------------------ help for turning the SSH server on

/** What to do when no SSH server answers (per OS). */
export function sshdHelp(): string[] {
  switch (process.platform) {
    case 'darwin':
      return [
        'System Settings › General › Sharing › turn on Remote Login.',
        'Under "Allow access for", allow your user (or all users).',
      ];
    case 'win32':
      return [
        'Settings › System › Optional features › Add a feature › OpenSSH Server (needs admin).',
        'Then in PowerShell as admin: Start-Service sshd; Set-Service sshd -StartupType Automatic',
        'Set this Wi-Fi to Private (Settings › Network & internet › Wi-Fi › your network), or Windows blocks the phone.',
      ];
    default:
      return [
        'Install and start the SSH server, e.g. Ubuntu/Debian: sudo apt install openssh-server · Fedora: sudo dnf install openssh-server · Arch: sudo pacman -S openssh',
        'Then: sudo systemctl enable --now sshd   (Ubuntu/Debian: ssh)',
        'With a firewall (ufw): sudo ufw allow ssh',
      ];
  }
}

/** Windows: the network profile of the active connection ("Public" blocks the phone). Null elsewhere / unknown. */
export function windowsNetworkCategory(): Promise<string | null> {
  if (!isWin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-NetConnectionProfile | Select-Object -ExpandProperty NetworkCategory) -join ","'],
      { windowsHide: true, timeout: 8000 },
      (err, out) => resolve(err ? null : String(out).trim() || null),
    );
  });
}

/** This PC's addresses on the local network, the likely Wi-Fi / Ethernet ones first. */
export function lanAddresses(): string[] {
  const virtual = /^(docker|br-|veth|virbr|vboxnet|vmnet|vEthernet|tailscale|zt|utun|lo|wg|tun|tap)/i;
  const list: { name: string; ip: string }[] = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const i of infos ?? []) if (i.family === 'IPv4' && !i.internal) list.push({ name, ip: i.address });
  }
  const priv = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const score = (x: { name: string; ip: string }) => (virtual.test(x.name) ? 2 : 0) + (priv(x.ip) ? 0 : 1);
  return list.sort((a, b) => score(a) - score(b)).map((x) => x.ip);
}
