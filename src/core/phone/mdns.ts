// Connect phone: announces this PC on the Wi-Fi as "_antigem-pc._tcp" while pairing is open, so the AntiGem app lists
// it under Nearby PCs (Android's NsdManager). Uses the system's announcer where there is one (macOS: dns-sd, always
// there; Linux: avahi-publish-service when installed) and otherwise answers mDNS itself (Windows, Linux without
// avahi): a small responder on 224.0.0.251:5353 that only knows this one service.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import os from 'node:os';
import { lanAddresses } from './sshd';

export const SERVICE = '_antigem-pc._tcp';

export interface Announcement {
  /** Instance name shown on the phone (the PC's name). */
  name: string;
  port: number;
  txt: Record<string, string>;
}

export interface Announcer {
  stop(): void;
}

const onPath = (cmd: string) =>
  spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', windowsHide: true }).status === 0;

/** Starts announcing; never throws (the phone can still pair by typing the address). */
export function announce(a: Announcement, log: (line: string) => void): Announcer {
  const txt = Object.entries(a.txt).map(([k, v]) => `${k}=${v}`);
  const tool =
    process.platform === 'darwin' ? ['dns-sd', ['-R', a.name, SERVICE, 'local', String(a.port), ...txt]]
    : process.platform === 'linux' && onPath('avahi-publish-service') ? ['avahi-publish-service', [a.name, SERVICE, String(a.port), ...txt]]
    : null;
  if (tool) {
    try {
      const p: ChildProcess = spawn(tool[0] as string, tool[1] as string[], { stdio: 'ignore', windowsHide: true });
      // the tool may fail to start (missing, no daemon): then the built-in responder takes over
      let current: Announcer = { stop: () => p.kill() };
      let stopped = false;
      p.on('error', (e) => {
        log(`[phone] ${tool[0]} failed (${e.message}); using the built-in mDNS responder`);
        if (!stopped) current = responder(a, log);
      });
      p.on('exit', (code) => {
        if (!stopped && code) {
          log(`[phone] ${tool[0]} exited (${code}); using the built-in mDNS responder`);
          current = responder(a, log);
        }
      });
      log(`[phone] announcing "${a.name}" with ${tool[0]}`);
      return {
        stop() {
          stopped = true;
          current.stop();
          p.kill();
        },
      };
    } catch (e) {
      log(`[phone] ${tool[0]} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return responder(a, log);
}

// ------------------------------------------------------------------ a minimal mDNS responder (RFC 6762 / 6763)

const GROUP = '224.0.0.251';
const PORT = 5353;
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const;
const CLASS_IN = 1;
const CACHE_FLUSH = 0x8000;

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.');
  // an instance name may contain dots: it is one label before the service type
  const bufs: Buffer[] = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8').subarray(0, 63);
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

function encodeLabels(labels: string[]): Buffer {
  const bufs: Buffer[] = [];
  for (const l of labels) {
    const b = Buffer.from(l, 'utf8').subarray(0, 63);
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

function record(name: Buffer, type: number, flush: boolean, ttl: number, data: Buffer): Buffer {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(CLASS_IN | (flush ? CACHE_FLUSH : 0), 2);
  h.writeUInt32BE(ttl, 4);
  h.writeUInt16BE(data.length, 8);
  return Buffer.concat([name, h, data]);
}

/** Reads a (possibly compressed) name at [off]: the lowercase name and the offset after it. */
function readName(buf: Buffer, off: number): [string, number] {
  const labels: string[] = [];
  let end = -1;
  for (let jumps = 0; off < buf.length && jumps < 20; ) {
    const len = buf[off];
    if (len === 0) {
      off++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      jumps++;
      continue;
    }
    labels.push(buf.subarray(off + 1, off + 1 + len).toString('utf8'));
    off += 1 + len;
  }
  return [labels.join('.').toLowerCase(), end >= 0 ? end : off];
}

const lanIPv4 = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

/** The records of the announcement, and the answer to one mDNS query (null: not about this PC). */
function zone(a: Announcement, addresses: () => string[]) {
  const host = `antigem-${os.hostname().replace(/\.local$/i, '').replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40) || 'pc'}`;
  const serviceName = `${SERVICE}.local`;
  const instanceLabels = [a.name, '_antigem-pc', '_tcp', 'local'];
  const instance = instanceLabels.join('.').toLowerCase();
  const hostName = `${host}.local`;

  const records = (ttl: number) => {
    const inst = encodeLabels(instanceLabels);
    const srvData = Buffer.concat([Buffer.from([0, 0, 0, 0, a.port >> 8, a.port & 0xff]), encodeName(hostName)]);
    const txtData = Buffer.concat(
      Object.entries(a.txt).map(([k, v]) => {
        const s = Buffer.from(`${k}=${v}`, 'utf8').subarray(0, 255);
        return Buffer.concat([Buffer.from([s.length]), s]);
      }),
    );
    return {
      ptr: record(encodeName(serviceName), TYPE.PTR, false, ttl ? 4500 : 0, inst),
      srv: record(inst, TYPE.SRV, true, ttl ? 120 : 0, srvData),
      txt: record(inst, TYPE.TXT, true, ttl ? 4500 : 0, txtData),
      a: addresses().map((ip) => record(encodeName(hostName), TYPE.A, true, ttl ? 120 : 0, Buffer.from(ip.split('.').map(Number)))),
    };
  };

  const packet = (answers: Buffer[], additional: Buffer[] = []) => {
    const h = Buffer.alloc(12);
    h.writeUInt16BE(0x8400, 2); // response, authoritative
    h.writeUInt16BE(answers.length, 6);
    h.writeUInt16BE(additional.length, 10);
    return Buffer.concat([h, ...answers, ...additional]);
  };

  /** The reply to a query from [port] (null when it asks nothing about this PC); unicast = answer the asker only. */
  const reply = (msg: Buffer, port: number): { out: Buffer; unicast: boolean } | null => {
    if (msg.length < 12 || msg.readUInt16BE(2) & 0x8000) return null; // only queries
    const qd = msg.readUInt16BE(4);
    let off = 12;
    const r = records(1);
    const answers: Buffer[] = [];
    let unicast = port !== PORT;
    for (let i = 0; i < qd && off < msg.length; i++) {
      const [name, next] = readName(msg, off);
      if (next + 4 > msg.length) break;
      const type = msg.readUInt16BE(next);
      if (msg.readUInt16BE(next + 2) & 0x8000) unicast = true; // "QU": answer straight to the asker
      off = next + 4;
      const any = type === TYPE.ANY;
      if ((name === serviceName.toLowerCase() && (type === TYPE.PTR || any)) || (name === '_services._dns-sd._udp.local' && type === TYPE.PTR)) {
        if (name === '_services._dns-sd._udp.local') answers.push(record(encodeName('_services._dns-sd._udp.local'), TYPE.PTR, false, 4500, encodeName(serviceName)));
        else answers.push(r.ptr);
      } else if (name === instance) {
        if (type === TYPE.SRV || any) answers.push(r.srv);
        if (type === TYPE.TXT || any) answers.push(r.txt);
      } else if (name === hostName.toLowerCase() && (type === TYPE.A || any)) {
        answers.push(...r.a);
      }
    }
    if (!answers.length) return null;
    // what the asker needs next comes along (SRV, TXT and the addresses with the PTR)
    const extra = answers.includes(r.ptr) ? [r.srv, r.txt, ...r.a] : answers.includes(r.srv) ? r.a : [];
    return { out: packet(answers, extra), unicast };
  };

  return { records, packet, reply };
}

function responder(a: Announcement, log: (line: string) => void): Announcer {
  // the Wi-Fi / Ethernet address first (Docker, VPN… last): Android uses the first one it gets
  const addresses = () => (lanAddresses().length ? lanAddresses() : lanIPv4());
  const { records, packet, reply } = zone(a, addresses);
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let closed = false;
  const send = (buf: Buffer, port = PORT, address = GROUP) => {
    if (!closed) sock.send(buf, port, address, () => {});
  };

  sock.on('error', (e) => log(`[phone] mDNS: ${e.message}`));
  sock.on('message', (msg, rinfo) => {
    const r = reply(msg, rinfo.port);
    if (!r) return;
    if (r.unicast) send(r.out, rinfo.port, rinfo.address);
    else send(r.out);
  });

  sock.bind(PORT, () => {
    try {
      sock.setMulticastTTL(255);
      sock.setMulticastLoopback(true);
    } catch {
      /* best effort */
    }
    // join the group on every IPv4 interface (Windows only joins the default one otherwise)
    const ifaces = addresses();
    let joined = 0;
    for (const ip of ifaces) {
      try {
        sock.addMembership(GROUP, ip);
        joined++;
      } catch {
        /* that interface cannot */
      }
    }
    if (!joined) {
      try {
        sock.addMembership(GROUP);
      } catch (e) {
        log(`[phone] mDNS: cannot join the multicast group (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    log(`[phone] announcing "${a.name}" on ${ifaces.join(', ') || 'no network'} (built-in mDNS)`);
    // unsolicited announcements (RFC 6762 §8.3): twice, a second apart
    const r = records(1);
    const ann = packet([r.ptr, r.srv, r.txt, ...r.a]);
    send(ann);
    setTimeout(() => send(ann), 1000);
  });

  return {
    stop() {
      if (closed) return;
      // goodbye: TTL 0 tells phones the PC is gone
      const r = records(0);
      try {
        sock.send(packet([r.ptr, r.srv, r.txt]), PORT, GROUP, () => {
          closed = true;
          try {
            sock.close();
          } catch {
            /* closed */
          }
        });
      } catch {
        closed = true;
      }
      setTimeout(() => {
        if (!closed) {
          closed = true;
          try {
            sock.close();
          } catch {
            /* closed */
          }
        }
      }, 500);
    },
  };
}

/** The responder's packet code, for tests. */
export const __test = { encodeName, encodeLabels, readName, record, zone };
