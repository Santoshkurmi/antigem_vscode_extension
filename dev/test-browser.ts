// Offline tests of the AntiGem browser link (no browser): the Go native host's framing between a fake Chrome
// (stdin/stdout) and the real BrowserBridge socket, socket permissions and takeover, the native host registration
// helper, key parsing, browser_mcp over HTTP (schemas, not-connected errors) and tool -> command routing against a
// fake extension. Everything is written under a temp folder.
//   npx esbuild dev/test-browser.ts --bundle --platform=node --outfile=<tmp>/test-browser.js && node <tmp>/test-browser.js
/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge } from '../src/core/browser/bridge';
import { EXTENSION_ID, HOST_NAME } from '../src/core/browser/constants';
import * as K from '../src/core/browser/keys';
import { browserMcp } from '../src/core/browser/mcp';
import { register, registrationStatus } from '../src/core/browser/nativeHost';
import { TOOLS } from '../src/core/browser/tools';
import { McpHost } from '../src/core/mcp/server';

const ROOT = process.env.ANTIGEM_ROOT ?? process.cwd();
const BIN = path.join(ROOT, 'bin', `antigem-bridge-${process.platform}-${process.arch}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antigem-browser-test-'));
const log = (_: string) => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------------------------------------------ fake Chrome

/** Speaks native messaging to the host process like Chrome does. */
class FakeChrome {
  private buf = Buffer.alloc(0);
  private waiters: ((m: any) => void)[] = [];
  private queue: any[] = [];
  private chunks = new Map<number, Buffer[]>();
  proc;
  constructor(socket: string) {
    this.proc = spawn(BIN, ['--native-host', '--socket', socket, `chrome-extension://${EXTENSION_ID}/`], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= 4) {
        const n = this.buf.readUInt32LE(0);
        if (this.buf.length < 4 + n) break;
        const msg = JSON.parse(this.buf.subarray(4, 4 + n).toString('utf8'));
        this.buf = this.buf.subarray(4 + n);
        this.deliver(msg, n);
      }
    });
  }
  maxFrame = 0;
  private deliver(msg: any, n: number) {
    this.maxFrame = Math.max(this.maxFrame, n);
    if (msg.type === 'chunk') {
      const parts = this.chunks.get(msg.id) ?? [];
      parts[msg.i] = Buffer.from(msg.data, 'base64');
      this.chunks.set(msg.id, parts);
      if (parts.filter(Boolean).length < msg.n) return;
      this.chunks.delete(msg.id);
      msg = JSON.parse(Buffer.concat(parts).toString('utf8'));
    }
    const w = this.waiters.shift();
    if (w) w(msg);
    else this.queue.push(msg);
  }
  next(timeout = 3000): Promise<any> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for a message from the host')), timeout);
      this.waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }
  async until(pred: (m: any) => boolean, timeout = 3000) {
    for (;;) {
      const m = await this.next(timeout);
      if (pred(m)) return m;
    }
  }
  send(msg: unknown) {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(body.length, 0);
    this.proc.stdin.write(Buffer.concat([hdr, body]));
  }
  close() {
    this.proc.stdin.end();
  }
}

async function testNativeHost() {
  if (!fs.existsSync(BIN)) {
    check('native host binary exists', false, BIN);
    return;
  }
  const sock = path.join(tmp, 'run', 'browser.sock');
  const bridge = new BrowserBridge({ log, socketPath: sock });
  const st = await bridge.start();
  check('bridge listens', st === 'listening', st);
  check('socket dir is 0700', (fs.statSync(path.dirname(sock)).mode & 0o777) === 0o700);
  check('socket is 0600', (fs.statSync(sock).mode & 0o777) === 0o600);

  // a second server on the same path sees it is taken
  const other = new BrowserBridge({ log, socketPath: sock });
  check('second window is busy', (await other.start()) === 'busy');

  const chrome = new FakeChrome(sock);
  const status = await chrome.until((m) => m.type === 'host_status');
  check('host reports VS Code connected', status.connected === true && status.socket === sock, JSON.stringify(status));
  chrome.send({ type: 'hello', protocol: 1, version: '0.1.0', extensionId: EXTENSION_ID, browser: 'Mozilla/5.0 Chrome/156.0.0.0' });
  for (let i = 0; i < 40 && !bridge.connected(); i++) await sleep(25);
  check('extension hello accepted', bridge.connected());

  // a command round trip
  const p = bridge.call<{ pong: boolean }>('ping', { a: 1 }, 3000);
  const cmd = await chrome.until((m) => m.command === 'ping');
  check('command reaches Chrome framed', cmd.payload?.a === 1 && typeof cmd.id === 'number');
  chrome.send({ id: cmd.id, success: true, result: { pong: true } });
  check('result comes back', (await p).pong === true);

  // an error with a code
  const pe = bridge.call<any>('tabs.close', { tabId: '1' }, 3000).catch((e: any) => e);
  const cmd2 = await chrome.until((m) => m.command === 'tabs.close');
  chrome.send({ id: cmd2.id, success: false, error: 'The user did not allow it', code: 'denied' });
  const err = await pe;
  check('error code is kept', err?.code === 'denied' && /did not allow/.test(err?.message), String(err));

  // big message VS Code -> Chrome is chunked under 1 MB per frame
  const big = 'x'.repeat(2_500_000);
  const pb = bridge.call<{ n: number }>('upload', { data: big }, 5000);
  const cmd3 = await chrome.until((m) => m.command === 'upload', 5000);
  check('2.5 MB command rebuilt from chunks', cmd3.payload?.data === big);
  check('every frame to Chrome <= 1 MB', chrome.maxFrame <= 1024 * 1024, String(chrome.maxFrame));
  // big message Chrome -> VS Code (screenshot sized)
  chrome.send({ id: cmd3.id, success: true, result: { n: 3, blob: 'y'.repeat(3_000_000) } });
  check('3 MB result reaches VS Code', (await pb).n === 3);

  // timeout
  const pt = await bridge.call<any>('slow', {}, 300).catch((e: any) => e);
  check('timeout rejects', pt?.code === 'timeout');

  // heartbeat ping from the extension
  // wrong extension id is refused
  const sock2 = path.join(tmp, 'run2', 'b.sock');
  const bridge2 = new BrowserBridge({ log, socketPath: sock2 });
  await bridge2.start();
  const rogue = new FakeChrome(sock2);
  await rogue.until((m) => m.type === 'host_status' && m.connected);
  rogue.send({ type: 'hello', protocol: 1, version: '9', extensionId: 'aaaabbbbccccddddeeeeffffgggghhhh', browser: 'x' });
  await sleep(200);
  check('another extension id is refused', !bridge2.connected());
  rogue.close();
  bridge2.stop();

  // VS Code restarts: the host reconnects by itself
  bridge.stop();
  const down = await chrome.until((m) => m.type === 'host_status' && m.connected === false, 4000);
  check('host notices VS Code is gone', down.connected === false);
  check('socket removed on stop', !fs.existsSync(sock));
  const bridge3 = new BrowserBridge({ log, socketPath: sock });
  await bridge3.start();
  const up = await chrome.until((m) => m.type === 'host_status' && m.connected === true, 8000);
  check('host reconnects to a new VS Code', up.connected === true);
  chrome.send({ type: 'hello', protocol: 1, version: '0.1.0', extensionId: EXTENSION_ID, browser: 'Chrome/156' });
  for (let i = 0; i < 40 && !bridge3.connected(); i++) await sleep(25);
  check('extension connected again', bridge3.connected());

  // pending calls fail when the browser goes away
  const pd = bridge3.call<any>('ping', {}, 5000).catch((e: any) => e);
  await chrome.until((m) => m.command === 'ping');
  chrome.close();
  const ed = await pd;
  check('pending call fails on disconnect', ed?.code === 'not_connected', String(ed?.message));
  await sleep(100);
  check('host exits when Chrome closes the port', chrome.proc.exitCode === 0 || chrome.proc.signalCode === null);
  bridge3.stop();

  // a stale socket file (crashed window) is replaced
  const sock4 = path.join(tmp, 'run4', 'b.sock');
  fs.mkdirSync(path.dirname(sock4), { recursive: true });
  const dead = net.createServer();
  await new Promise<void>((r) => dead.listen(sock4, () => r()));
  // close without unlinking: simulate a crash by leaving the file behind
  (dead as any)._handle?.close?.();
  await sleep(50);
  const bridge4 = new BrowserBridge({ log, socketPath: sock4 });
  const st4 = await bridge4.start();
  check('stale socket is taken over', st4 === 'listening', st4);
  bridge4.stop();
}

// ------------------------------------------------------------------------------------------------ registration

function testRegistration() {
  const dirs = [path.join(tmp, 'chrome', 'NativeMessagingHosts'), path.join(tmp, 'brave', 'NativeMessagingHosts')];
  const wrapper = path.join(tmp, 'wrapper', 'antigem-native-host');
  const fakeBin = path.join(tmp, "bin dir's", 'antigem-bridge');
  fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
  fs.writeFileSync(fakeBin, '#!/bin/sh\n', { mode: 0o755 });
  const r = register({ binPath: fakeBin, dirs, wrapper, socketPath: '/tmp/x y.sock' });
  check('manifests written', r.written.length === 2 && r.written.every((f) => fs.existsSync(f)));
  const m = JSON.parse(fs.readFileSync(path.join(dirs[0], `${HOST_NAME}.json`), 'utf8'));
  check('manifest content', m.name === HOST_NAME && m.type === 'stdio' && m.path === wrapper && m.allowed_origins?.[0] === `chrome-extension://${EXTENSION_ID}/`, JSON.stringify(m));
  const w = fs.readFileSync(wrapper, 'utf8');
  check('wrapper is executable', (fs.statSync(wrapper).mode & 0o111) !== 0);
  check('wrapper quotes paths', w.includes(`exec '${tmp}/bin dir'\\''s/antigem-bridge' --native-host --socket '/tmp/x y.sock' "$@"`), w);
  const s = registrationStatus(fakeBin, wrapper);
  check('status reads the wrapper target', s.wrapperExists && s.wrapperCurrent && s.wrapperTarget === fakeBin, JSON.stringify(s));
}

// ------------------------------------------------------------------------------------------------ keys

function testKeys() {
  const steps = K.parse('ctrl+a Backspace shift+Tab shift++ x');
  check('key chords', steps.length === 5 && steps[0].kind === 'press' && steps[0].modifiers === K.CTRL && (steps[0] as any).def.code === 'KeyA');
  check('shift++ is the plus key', (steps[3] as any).def.key === '+' && (steps[3] as any).modifiers === K.SHIFT);
  let threw = '';
  try {
    K.parse('ctrl a');
  } catch (e) {
    threw = String(e);
  }
  check('lone modifier refused', /released before the next key/.test(threw));
  check('modifiers parse', K.parseModifiers('cmd+shift') === (K.META | K.SHIFT));
  check('forChar', K.forChar('A')?.[1] === true && K.forChar('!')?.[0].code === 'Digit1');
}

// ------------------------------------------------------------------------------------------------ MCP + routing

/** A scripted extension: answers the primitives in memory and records what it was asked. */
class FakeExtension {
  calls: { command: string; payload: any }[] = [];
  socket: net.Socket | null = null;
  constructor(private sock: string) {}
  async connect() {
    this.socket = net.connect(this.sock);
    await new Promise((r) => this.socket!.once('connect', r));
    let buf = '';
    this.socket.setEncoding('utf8');
    this.socket.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = JSON.parse(line);
        if (m.type === 'ping') continue;
        void this.answer(m);
      }
    });
    this.write({ type: 'host_hello', origin: `chrome-extension://${EXTENSION_ID}/`, pid: 1 });
    this.write({ type: 'hello', protocol: 1, version: 'test', extensionId: EXTENSION_ID, browser: 'Chrome/156' });
  }
  write(m: unknown) {
    this.socket!.write(`${JSON.stringify(m)}\n`);
  }
  tab = { id: '7', url: 'http://test/', title: 'Test', status: 'complete', active: true, isCurrent: true, locked: false, viewMode: 'desktop', blocked: false, dialog: null, consoleErrors: 0, networkErrors: 0 };
  vp = { ok: true, w: 1280, h: 720, ox: 0, oy: 0, sx: 0, sy: 0, pw: 1280, ph: 2000, iw: 1280, url: 'http://test/', title: 'Test' };
  async answer(m: any) {
    this.calls.push({ command: m.command, payload: m.payload });
    const ok = (result: unknown) => this.write({ id: m.id, success: true, result });
    switch (m.command) {
      case 'tabs.resolve':
        return ok(this.tab);
      case 'tabs.list':
        return ok({ tabs: [this.tab], current: '7', others: 3 });
      case 'agent.begin':
        return ok({ userUnlocked: false, locked: false, active: true });
      case 'agent.end':
      case 'overlay':
        return ok(null);
      case 'screenshot':
        return ok({ data: 'AAAA', mimeType: 'image/jpeg', fitW: 1456, fitH: 819, outW: 1456, outH: 819, vp: this.vp });
      case 'page.call': {
        const fn = m.payload.fn;
        if (fn === 'viewport') return ok(this.vp);
        if (fn === 'hitTest') return ok({ ok: true, desc: 'button "Go"', ref: 'ref_3', fileInput: false });
        if (fn === 'focusInfo') return ok({ ok: true, kind: 'editable', desc: 'textbox "Name"', ref: 'ref_4', sig: `${this.calls.length}`, sensitive: false });
        if (fn === 'find') return ok({ ok: true, text: 'Best matches…' });
        return ok({ ok: true, text: '' });
      }
      case 'cdp':
        return ok({ count: m.payload.commands.length });
      case 'tabs.wait':
        return ok({ loaded: true, url: 'http://test/', title: 'Test' });
      default:
        return this.write({ id: m.id, success: false, error: `unknown ${m.command}`, code: 'bad_request' });
    }
  }
}

async function testMcp() {
  const sock = path.join(tmp, 'mcp', 'b.sock');
  const bridge = new BrowserBridge({ log, socketPath: sock });
  const mcp = new McpHost({ port: 0, deviceId: 'dev-test', log });
  mcp.register(browserMcp(bridge, { workspace: () => tmp }));
  // port 0: pick a free port by hand
  const port = await new Promise<number>((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
  (mcp as any).opts.port = port;
  await mcp.start();
  const rpc = async (method: string, params: unknown = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/browser`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Device-Id': 'dev-test' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await res.json()) as any;
  };
  const init = await rpc('initialize');
  check('initialize: browser_mcp + instructions', init.result?.serverInfo?.name === 'browser_mcp' && /AntiGem/.test(init.result?.instructions ?? ''));
  const list = await rpc('tools/list');
  const names = (list.result?.tools ?? []).map((t: any) => t.name);
  check('the app\'s 16 tools + browser_batch listed', names.length === 17 && names.includes('browser_batch') && names.includes('browser_upload_file'), names.join(','));
  check('schemas are objects', (list.result?.tools ?? []).every((t: any) => t.inputSchema?.type === 'object' && typeof t.description === 'string'));
  check('legacy names hidden', !names.includes('browser_screenshot'));
  const nc = await rpc('tools/call', { name: 'browser_list_tabs', arguments: {} });
  check('not connected -> clear error', nc.result?.isError === true && /Settings → Browser/.test(nc.result?.content?.[0]?.text ?? ''), JSON.stringify(nc));
  const hidden = await rpc('tools/call', { name: 'browser_screenshot', arguments: {} });
  check('legacy tool callable', hidden.result?.isError === true && !hidden.error);
  const unknown = await rpc('tools/call', { name: 'browser_nope', arguments: {} });
  check('unknown tool -> -32601', unknown.error?.code === -32601);

  await bridge.start();
  const ext = new FakeExtension(sock);
  await ext.connect();
  for (let i = 0; i < 40 && !bridge.connected(); i++) await sleep(25);
  const call = async (name: string, args: unknown) => (await rpc('tools/call', { name, arguments: args })).result;

  const tabs = await call('browser_list_tabs', {});
  const arr = JSON.parse(tabs.content[0].text);
  check('list_tabs shape', arr[0].id === '7' && arr[0].isActive === true && arr[0].isDesktopMode === true && /3 other tabs/.test(tabs.content[1]?.text ?? ''), JSON.stringify(tabs));

  // a coordinate click before any screenshot: refused with a fresh screenshot attached
  const noFrame = await call('browser_computer', { action: 'left_click', coordinate: [10, 10] });
  check('click without a screenshot -> FrameError + screenshot', noFrame.isError && noFrame.content.some((c: any) => c.type === 'image') && /no screenshot of this tab yet/.test(noFrame.content.map((c: any) => c.text ?? '').join(' ')));

  const shot = await call('browser_computer', { action: 'screenshot' });
  check('screenshot -> text + image', shot.content[0].text.includes('1456x819') && shot.content[1]?.type === 'image');

  ext.calls = [];
  const click = await call('browser_computer', { action: 'left_click', coordinate: [728, 409.5], action_summary: 'Pressing Go' });
  const cdp = ext.calls.find((c) => c.command === 'cdp');
  const press = cdp?.payload.commands.find((c: any) => c.params.type === 'mousePressed');
  check('click maps screenshot px to CSS px', !!press && Math.abs(press.params.x - 640) < 0.01 && Math.abs(press.params.y - 360) < 0.01, JSON.stringify(press));
  check('click text', /^Clicked \(640, 360 CSS px\) on button "Go" \[ref_3\]/.test(click.content[0].text), click.content[0].text);
  check('cursor caption sent', ext.calls.some((c) => c.command === 'overlay' && c.payload.op === 'move' && c.payload.label === 'Pressing Go'));
  check('agent.begin/end bracket', ext.calls[0]?.command === 'tabs.resolve' && ext.calls.some((c) => c.command === 'agent.begin') && ext.calls.some((c) => c.command === 'agent.end'));

  ext.calls = [];
  await call('browser_computer', { action: 'type', text: 'Hi!\n' });
  const typed = ext.calls.find((c) => c.command === 'cdp')?.payload.commands ?? [];
  const keys = typed.filter((c: any) => c.params.type === 'keyDown').map((c: any) => c.params.text);
  check('type sends key events', keys.join('') === 'Hi!\r' && typed.find((c: any) => c.params.key === '!')?.params.modifiers === K.SHIFT, JSON.stringify(keys));

  ext.calls = [];
  const batch = await call('browser_batch', { actions: [{ name: 'computer', input: { action: 'key', text: 'ctrl+a' } }, { name: 'find', input: { query: 'go button' } }] });
  check('batch with Claude-in-Chrome aliases', !batch.isError && /^\[1\/2\] browser_computer key: Pressed key: ctrl\+a/.test(batch.content[0].text) && /^\[2\/2\] browser_find: Best matches/.test(batch.content[1].text), JSON.stringify(batch.content));
  const ctrl = ext.calls.find((c) => c.command === 'cdp')?.payload.commands ?? [];
  check('ctrl+a holds Control', ctrl[0]?.params.key === 'Control' && ctrl[1]?.params.key === 'a' && ctrl[1]?.params.modifiers === K.CTRL);

  const nested = await call('browser_batch', { actions: [{ name: 'browser_batch', input: {} }] });
  check('nested batch refused', nested.isError && /cannot be nested/.test(nested.content[0].text));

  const zoomBad = await call('browser_computer', { action: 'zoom', region: [0, 0, 5000, 10] });
  check('zoom outside frame refused', zoomBad.isError);

  const up = await call('browser_upload_file', { file_paths: ['~/.ssh/id_rsa'] });
  check('secret folders never uploaded', up.isError && /(keys or credentials|not found)/.test(up.content.map((c: any) => c.text).join(' ')));

  ext.socket?.destroy();
  bridge.stop();
  mcp.stop();
}

async function main() {
  testKeys();
  testRegistration();
  await testNativeHost();
  await testMcp();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
