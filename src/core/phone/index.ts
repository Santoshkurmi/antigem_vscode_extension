// Settings → Connect phone: lets the AntiGem app on a phone use this PC's agents (the same chats on both). The phone
// pairs once over the Wi-Fi with a 6-digit code (docs/connect-to-pc-protocol.md: SPAKE2, so nobody on the network can
// learn or guess it offline); its SSH key is then allowed in this user's authorized_keys, limited to reading the
// bridge token and tunnels to the bridge and hub ports (plus a shell with "Allow terminal from phone"). Nothing listens
// on the network except sshd and, only while pairing, the pairing port and its mDNS announcement.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { SettingItem, SettingsPage, SettingsSection } from '../../../shared/protocol';
import type { KeyValueStore } from '../types';
import { announce, type Announcer } from './mdns';
import { newCode, pcSide, type PcKeys } from './spake';
import { editKeys, hostKeys, keyFile, keyLine, lanAddresses, sshdHelp, sshdStatus, sshUser, validPhoneKey, windowsNetworkCategory, type SshdInfo } from './sshd';

export interface PairedPhone {
  id: string;
  name: string;
  publicKey: string;
  pairedAt: number;
}

export interface PhoneAccessDeps {
  store: KeyValueStore;
  log: (line: string) => void;
  /** The bridge and hub ports the phone tunnels to. */
  ports(): { bridge: number; hub: number };
  /** Stops and starts the bridge (after its token changed). */
  restartBridge(): Promise<void>;
  confirm(message: string, action: string): Promise<boolean>;
  /** Where the bridge keeps its token (the phone reads it over SFTP at every connect). */
  tokenFile?: string;
  /** Pairing port and bind address (tests use 127.0.0.1). */
  pairPort?: number;
  pairBind?: string;
  /** authorized_keys override (tests). */
  keyFilePath?: string;
  /** SSH port override (tests). */
  sshPort?: number;
}

const PAIR_MINUTES = 2;
const MAX_TRIES = 3;
const K_PHONES = 'phone.access.phones';
const K_MODE = 'phone.access.mode';
const K_TERMINAL = 'phone.access.terminal';
const K_PCID = 'phone.access.pcId';

interface Pairing {
  code: string;
  until: number;
  tries: number;
  port: number;
  server: http.Server;
  mdns: Announcer | null;
  sessions: Map<string, { keys: PcKeys; phoneId: string; phoneName: string; at: number }>;
  timer: NodeJS.Timeout;
}

export class PhoneAccess {
  private pairing: Pairing | null = null;
  private listeners: (() => void)[] = [];
  private sshd: SshdInfo | null = null;
  private network: string | null = null;
  private lastPaired: string | null = null;
  private busy = false;

  constructor(private d: PhoneAccessDeps) {}

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  // ------------------------------------------------------------------ state

  phones(): PairedPhone[] {
    return this.d.store.get<PairedPhone[]>(K_PHONES) ?? [];
  }

  private setPhones(list: PairedPhone[]) {
    this.d.store.set(K_PHONES, list);
  }

  private mode(): 'one' | 'several' {
    return this.d.store.get<string>(K_MODE) === 'several' ? 'several' : 'one';
  }

  private terminal(): boolean {
    return this.d.store.get<boolean>(K_TERMINAL) === true;
  }

  private pcId(): string {
    let id = this.d.store.get<string>(K_PCID);
    if (!id) {
      id = crypto.randomUUID();
      this.d.store.set(K_PCID, id);
    }
    return id;
  }

  private pcName(): string {
    return os.hostname().replace(/\.local$/i, '') || 'PC';
  }

  private keyFilePath() {
    return this.d.keyFilePath ? { path: this.d.keyFilePath, elevated: false } : keyFile();
  }

  private lines(phones: PairedPhone[]): string[] {
    const { bridge, hub } = this.d.ports();
    return phones.map((p) => keyLine(p.publicKey, [bridge, hub], this.terminal()));
  }

  private tokenFile() {
    return this.d.tokenFile ?? path.join(os.homedir(), '.antigem_bridge', 'csrf_token.txt');
  }

  // ------------------------------------------------------------------ pairing

  isPairing() {
    return !!this.pairing && this.pairing.until > Date.now();
  }

  async startPairing(): Promise<void> {
    this.stopPairing(false);
    const sshd = await sshdStatus(this.d.sshPort);
    this.sshd = sshd;
    if (!sshd.running) throw new Error("This PC's SSH server is not running: turn it on first (see the steps on this page).");
    const sessions: Pairing['sessions'] = new Map();
    const server = http.createServer((req, res) => void this.handle(req, res));
    const port = await listen(server, this.d.pairPort ?? 1250, this.d.pairBind ?? '0.0.0.0');
    const p: Pairing = {
      code: newCode(),
      until: Date.now() + PAIR_MINUTES * 60_000,
      tries: 0,
      port,
      server,
      mdns: null,
      sessions,
      timer: setInterval(() => {
        if (!this.pairing) return;
        if (Date.now() > this.pairing.until) this.stopPairing();
        else this.changed();
      }, 5_000),
    };
    this.pairing = p;
    this.lastPaired = null;
    if ((this.d.pairBind ?? '0.0.0.0') !== '127.0.0.1') {
      p.mdns = announce({ name: this.pcName(), port, txt: { v: '1', id: this.pcId(), name: this.pcName(), os: process.platform } }, this.d.log);
    }
    this.d.log(`[phone] pairing open on port ${port} for ${PAIR_MINUTES} minutes`);
    this.changed();
  }

  stopPairing(notify = true) {
    const p = this.pairing;
    if (!p) return;
    this.pairing = null;
    clearInterval(p.timer);
    p.mdns?.stop();
    p.server.close();
    this.d.log('[phone] pairing closed');
    if (notify) this.changed();
  }

  private newCodeAfterTries() {
    if (!this.pairing) return;
    this.pairing.code = newCode();
    this.pairing.tries = 0;
    this.pairing.sessions.clear();
    this.changed();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const p = this.pairing;
    if (!p) return send(404, { error: 'This PC is not pairing right now. Open "Connect phone" in AntiGem on the PC.' });
    if (Date.now() > p.until) {
      this.stopPairing();
      return send(410, { error: 'The code expired. Start pairing again on the PC.' });
    }
    if (req.method !== 'POST') return send(404, { error: 'not found' });
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64_000) return send(413, { error: 'too large' });
    }
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(body || '{}');
    } catch {
      return send(400, { error: 'bad request' });
    }
    try {
      if (req.url === '/antigem/pair/start') {
        if (p.tries >= MAX_TRIES) {
          this.newCodeAfterTries();
          return send(423, { error: 'Too many tries. Use the new code shown on the PC.' });
        }
        p.tries++;
        const phoneId = String(j.phoneId ?? '');
        if (!/^[A-Za-z0-9-]{8,64}$/.test(phoneId)) return send(400, { error: 'bad request' });
        const keys = pcSide(p.code, phoneId, String(j.x ?? ''));
        const id = crypto.randomUUID();
        p.sessions.set(id, { keys, phoneId, phoneName: String(j.phoneName ?? 'Phone').slice(0, 60), at: Date.now() });
        this.d.log(`[phone] pairing attempt ${p.tries}/${MAX_TRIES} from ${String(j.phoneName ?? 'a phone').slice(0, 60)} (${req.socket.remoteAddress})`);
        return send(200, { v: 1, session: id, y: keys.y, confirm: keys.confirm });
      }
      if (req.url === '/antigem/pair/finish') {
        const s = p.sessions.get(String(j.session ?? ''));
        if (!s || Date.now() - s.at > 120_000) return send(404, { error: 'This pairing attempt expired. Try again.' });
        p.sessions.delete(String(j.session));
        if (!s.keys.phoneConfirmed(String(j.confirm ?? ''))) return send(403, { error: 'Wrong code.' });
        const phone = JSON.parse(s.keys.openFromPhone(String(j.box ?? '')).toString('utf8')) as { phoneId?: string; phoneName?: string; publicKey?: string };
        const publicKey = String(phone.publicKey ?? '').trim();
        if (phone.phoneId !== s.phoneId || !validPhoneKey(publicKey, s.phoneId)) return send(400, { error: 'The phone sent a key this PC cannot use.' });
        const name = String(phone.phoneName ?? s.phoneName).replace(/[\r\n]/g, ' ').slice(0, 60) || 'Phone';

        // the phones that may log in from now on (one phone: this one replaces the others)
        const others = this.mode() === 'one' ? [] : this.phones().filter((x) => x.id !== s.phoneId);
        const next = [...others, { id: s.phoneId, name, publicKey, pairedAt: Date.now() }];
        await editKeys(null, this.lines(next), this.keyFilePath());
        this.setPhones(next);

        const { bridge, hub } = this.d.ports();
        const sshd = await sshdStatus(this.d.sshPort);
        const info = {
          pcId: this.pcId(),
          pcName: this.pcName(),
          os: process.platform,
          user: sshUser(),
          sshPort: sshd.port,
          addresses: lanAddresses(),
          hostKeys: await hostKeys(sshd.port),
          bridgePort: bridge,
          hubPort: hub,
          token: readToken(this.tokenFile()),
        };
        this.d.log(`[phone] paired ${name}`);
        this.lastPaired = name;
        // the code was used: pairing ends (another phone needs a new code)
        setTimeout(() => this.stopPairing(), 300);
        this.changed();
        return send(200, { v: 1, box: s.keys.sealForPhone(Buffer.from(JSON.stringify(info), 'utf8')) });
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      this.d.log(`[phone] pairing failed: ${e instanceof Error ? e.message : String(e)}`);
      return send(400, { error: e instanceof Error && /admin prompt|Could not update/.test(e.message) ? e.message : 'Pairing failed. Try again.' });
    }
  }

  // ------------------------------------------------------------------ removing phones

  /** Takes the phone's key out and changes the bridge token, which ends a connection it has open now. */
  async remove(ids: string[] | null) {
    const left = ids === null ? [] : this.phones().filter((p) => !ids.includes(p.id));
    await editKeys(ids, [], this.keyFilePath());
    this.setPhones(left);
    rotateToken(this.tokenFile());
    await this.d.restartBridge().catch((e) => this.d.log(`[phone] bridge restart: ${e instanceof Error ? e.message : String(e)}`));
    this.changed();
  }

  /** The options changed: rewrite the phones' lines. */
  private async rewrite() {
    const phones = this.phones();
    if (phones.length) await editKeys(null, this.lines(phones), this.keyFilePath());
  }

  // ------------------------------------------------------------------ settings page

  rootItem(): SettingItem {
    const n = this.phones().length;
    return {
      kind: 'page',
      id: 'phone',
      label: 'Connect phone',
      icon: 'phone_android',
      description: 'Use this PC’s agents from the AntiGem app on your phone',
      badge: this.isPairing() ? 'Pairing…' : n ? `${n} phone${n === 1 ? '' : 's'}` : null,
    };
  }

  async page(_id: string): Promise<SettingsPage> {
    this.sshd = await sshdStatus(this.d.sshPort);
    if (process.platform === 'win32' && this.network === null) this.network = (await windowsNetworkCategory()) ?? '';
    const sshd = this.sshd;
    const phones = this.phones();
    const p = this.isPairing() ? this.pairing : null;
    const addresses = lanAddresses();
    const sections: SettingsSection[] = [];

    const pc: SettingItem[] = [
      sshd.running
        ? { kind: 'info', id: 'phone.sshd', label: 'SSH server', value: `Running on port ${sshd.port}`, tone: 'ok', description: sshd.banner || null }
        : { kind: 'info', id: 'phone.sshd', label: 'SSH server', value: 'Not running', tone: 'error', description: 'The phone connects to this PC over SSH. Turn it on:' },
    ];
    if (!sshd.running) sshdHelp().forEach((t, i) => pc.push({ kind: 'info', id: `phone.help.${i}`, label: `${i + 1}.`, value: t, tone: 'muted' }));
    pc.push({ kind: 'info', id: 'phone.addr', label: 'This PC on the network', value: addresses.join(', ') || 'No network', tone: addresses.length ? 'muted' : 'warn' });
    if (this.network && /public/i.test(this.network)) {
      pc.push({ kind: 'info', id: 'phone.net', label: 'Wi-Fi profile', value: 'Public: Windows blocks the phone. Set this network to Private.', tone: 'warn' });
    }
    sections.push({ id: 'phone.pc', title: 'This PC', items: pc });

    const pair: SettingItem[] = [];
    if (p) {
      const left = Math.max(0, Math.round((p.until - Date.now()) / 1000));
      pair.push(
        { kind: 'info', id: 'phone.code', label: 'Pairing code', value: `${p.code.slice(0, 3)} ${p.code.slice(3)}`, tone: 'ok', description: 'Type it in the app: Settings › Connect to PC › Add a PC' },
        { kind: 'info', id: 'phone.where', label: 'Address (if the phone does not list this PC)', value: addresses.map((a) => `${a}:${p.port}`).join('  ·  ') || `port ${p.port}`, tone: 'muted' },
        { kind: 'info', id: 'phone.left', label: 'Open for', value: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, tone: 'muted' },
        { kind: 'button', id: 'phone.stop', label: 'Stop pairing' },
      );
    } else {
      const replacing = this.mode() === 'one' && phones.length ? phones.map((x) => x.name).join(', ') : '';
      if (this.lastPaired) pair.push({ kind: 'info', id: 'phone.done', label: 'Paired', value: this.lastPaired, tone: 'ok' });
      pair.push({
        kind: 'button',
        id: 'phone.start',
        label: 'Start pairing',
        style: 'primary',
        disabled: !sshd.running,
        description: `Shows a code for ${PAIR_MINUTES} minutes and lets phones on this Wi-Fi find this PC`,
        confirm: replacing ? `Pairing a new phone replaces ${replacing}: its access to this PC is removed. (Settings below: "Phones allowed".)` : null,
      });
    }
    sections.push({ id: 'phone.pair', title: 'Pair a phone', description: 'In the AntiGem app: Settings › Connect to PC › turn it on › Add a PC.', items: pair });

    sections.push({
      id: 'phone.list',
      title: '',
      items: [
        {
          kind: 'list',
          id: 'phone.phones',
          label: 'Paired phones',
          emptyText: 'No phone yet.',
          rows: phones.map((x) => ({
            id: x.id,
            title: x.name,
            subtitle: `Paired ${new Date(x.pairedAt).toLocaleDateString()}`,
            actions: [{ id: 'remove', label: 'Remove', danger: true, confirm: `Remove ${x.name}? Its key is taken out and the bridge restarts with a new token, so a connection it has open now ends too. Running chats stop.` }],
          })),
        },
        ...(phones.length > 1
          ? [{ kind: 'button' as const, id: 'phone.removeAll', label: 'Remove all phones', style: 'danger' as const, confirm: 'Remove every phone? Their keys are taken out and the bridge restarts with a new token. Running chats stop.' }]
          : []),
      ],
    });

    sections.push({
      id: 'phone.options',
      title: 'Options',
      items: [
        {
          kind: 'select',
          id: 'phone.mode',
          label: 'Phones allowed',
          description: 'One: pairing a new phone removes the one before (safest)',
          value: this.mode(),
          options: [
            { value: 'one', label: 'One phone' },
            { value: 'several', label: 'Several phones' },
          ],
        },
        {
          kind: 'toggle',
          id: 'phone.terminal',
          label: 'Allow terminal from phone',
          description: "The app's terminal and Run configurations open a shell on this PC. Off: the phone can only reach the agents.",
          value: this.terminal(),
        },
        { kind: 'info', id: 'phone.keys', label: 'Keys file', value: this.keyFilePath().path, tone: 'muted' },
      ],
    });
    return { id: 'phone', title: 'Connect phone', sections };
  }

  async change(_page: string, id: string, value: unknown): Promise<void> {
    if (id === 'phone.mode') {
      const mode = value === 'several' ? 'several' : 'one';
      const phones = this.phones();
      if (mode === 'one' && phones.length > 1) {
        // keep the newest phone
        const keep = [...phones].sort((a, b) => b.pairedAt - a.pairedAt)[0];
        if (!(await this.d.confirm(`Only one phone: ${phones.filter((x) => x !== keep).map((x) => x.name).join(', ')} lose access (${keep.name} stays).`, 'Remove them'))) return;
        this.d.store.set(K_MODE, mode);
        await this.remove(phones.filter((x) => x !== keep).map((x) => x.id));
        return;
      }
      this.d.store.set(K_MODE, mode);
    } else if (id === 'phone.terminal') {
      this.d.store.set(K_TERMINAL, value === true);
      await this.rewrite();
    }
    this.changed();
  }

  async action(_page: string, id: string, rowId?: string, actionId?: string): Promise<string | void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (id === 'phone.start') {
        await this.startPairing();
        return 'Pairing is open: type the code in the app';
      }
      if (id === 'phone.stop') {
        this.stopPairing();
        return;
      }
      if (id === 'phone.phones' && actionId === 'remove' && rowId) {
        const name = this.phones().find((x) => x.id === rowId)?.name ?? 'Phone';
        await this.remove([rowId]);
        return `${name} removed`;
      }
      if (id === 'phone.removeAll') {
        await this.remove(null);
        return 'Every phone removed';
      }
    } finally {
      this.busy = false;
    }
  }

  dispose() {
    this.stopPairing(false);
  }
}

function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = (p: number) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && tries++ < 10) attempt(p + 1);
        else reject(new Error(`Could not open the pairing port (${e.message})`));
      });
      server.listen(p, host, () => resolve((server.address() as { port: number }).port));
    };
    attempt(port);
  });
}

function readToken(file: string): string {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    return t.length === 12 ? t : '';
  } catch {
    return '';
  }
}

/** A new bridge token (the bridge reads it when it starts): a removed phone's saved one stops working. */
function rotateToken(file: string) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let t = '';
  for (let i = 0; i < 12; i++) t += chars[crypto.randomInt(chars.length)];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t, { mode: 0o600 });
}
