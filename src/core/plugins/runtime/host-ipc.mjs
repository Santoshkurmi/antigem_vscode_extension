// AntiGem for VS Code: runs the app's plugin runtime (extension-host.mjs, unchanged) as a child process of the
// extension host, controlled over the Node IPC channel instead of the app's HTTP management endpoints.
//   fork(host-ipc.mjs, { execArgv: ['--experimental-vm-modules'], env: { ANTIGEM_PLUGIN_HOST: JSON config } })
// Parent → child: {kind:'call', id, op, args}            → child answers {kind:'ret', id, result | error}
// Child → parent: {kind:'ask', id, op, payload}           → parent answers {kind:'answer', id, result | error}
//   op 'browser' {endpoint, body, method}: the app's /api/browser/<endpoint> contract, served by the parent's browser
//   provider (the AntiGem Chrome extension); 'cdp.open' {tab_id} → session id, 'cdp.send' {session, method, params},
//   'cdp.close' {session}. The parent pushes {kind:'cdp.event', session, method, params} and {kind:'cdp.closed', session}.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { ExtensionHost } from './extension-host.mjs';
import { isSignInPage } from './browser-api.mjs';

const config = JSON.parse(process.env.ANTIGEM_PLUGIN_HOST || '{}');
const host = new ExtensionHost({
  root: config.root,
  stateRoot: config.stateRoot,
  downloadDir: config.downloadDir,
  hostPort: 0,
  // only the runtime's own resource server uses it (runtime.getURL); nothing outside this process knows it
  deviceId: randomBytes(16).toString('hex'),
  bridgeUrl: 'http://127.0.0.1:9',
});

// ---- requests to the parent
const asks = new Map();
let seq = 0;
function ask(op, payload, timeout = 200_000) {
  return new Promise((resolve, reject) => {
    if (!process.connected) return reject(new Error('AntiGem is not connected'));
    const id = ++seq;
    const timer = setTimeout(() => {
      asks.delete(id);
      reject(new Error(`${op} timed out`));
    }, timeout);
    asks.set(id, { resolve, reject, timer });
    process.send({ kind: 'ask', id, op, payload });
  });
}

// ---- the browser: the app's /api/browser/* bridge calls go to the parent
let browserOn = false;
host.browser.bridge = async (endpoint, body, method = 'POST') => {
  const value = await ask('browser', { endpoint, body: body ?? null, method }, 95_000);
  if (value?.success === false) throw new Error(value.error || 'Browser request failed');
  return value;
};

// A DevTools session of one tab, relayed by the parent (chrome.debugger in the Chrome extension).
const sessions = new Map();
class RelayConnection extends EventEmitter {
  constructor(session) {
    super();
    this.session = session;
    this.closed = false;
  }
  send(method, params = {}, timeout = 60_000) {
    if (this.closed) return Promise.reject(new Error('DevTools connection is closed'));
    return ask('cdp.send', { session: this.session, method, params, timeout }, timeout + 5_000);
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    sessions.delete(this.session);
    this.emit('closed', error);
  }
  close() {
    if (this.closed) return;
    ask('cdp.close', { session: this.session }).catch(() => {});
    this.fail(new Error('DevTools connection closed'));
  }
}

host.browser.connect = async function connect(tabId) {
  if (isSignInPage((await this.tab(tabId)).url)) throw new Error('Extensions are paused on Google sign-in pages');
  const nativeId = this.native(tabId);
  const { session } = await ask('cdp.open', { tab_id: nativeId }, 30_000);
  const connection = new RelayConnection(session);
  sessions.set(session, connection);
  connection.targetId = session;
  connection.tabId = tabId;
  this.connections.set(tabId, connection);
  // the same wiring as browser-api.mjs connect()
  connection.on('event', (name, params) => {
    this.host.onDevToolsEvent(tabId, name, params).catch((e) => console.error(e));
    for (const extension of this.debuggers.get(tabId) || []) this.host.broadcast(extension, 'debugger.onEvent', [{ tabId }, name, params]);
  });
  connection.on('closed', () => {
    this.connections.delete(tabId);
    this.host.dropTabContexts(tabId);
    for (const extension of this.debuggers.get(tabId) || []) this.host.broadcast(extension, 'debugger.onDetach', [{ tabId }, 'target_closed']);
    this.debuggers.delete(tabId);
  });
  await connection.send('Runtime.enable');
  await connection.send('Page.enable');
  return connection;
};

// Tab polling (tab events, content scripts) only while a browser is connected and a plugin is loaded.
const poll = host.browser.poll.bind(host.browser);
host.browser.poll = async () => {
  if (!browserOn || !host.extensions.size) return;
  return poll();
};

// ---- calls from the parent
async function run(op, args = {}) {
  switch (op) {
    case 'load': {
      const ext = await host.loadExtension(args.dir);
      return { id: ext.id, dir: ext.dir };
    }
    case 'unload':
      if (host.extensions.has(args.id)) await host.unload(args.id);
      return { success: true };
    case 'reload':
      return { id: (await host.reload(args.id)).id };
    case 'list':
      return [...host.extensions.values()].map((e) => ({ id: e.id, name: e.manifest.name, enabled: e.enabled, dir: e.dir, tools: (e.manifest.mcp_tools || []).length }));
    case 'tools':
      return [...host.toolRegistry.values()]
        .filter((e) => e.extension.enabled && e.extension.id === args.id)
        .map((e) => ({ name: e.spec.name, description: e.spec.description || '', inputSchema: e.spec.inputSchema || { type: 'object', properties: {} } }));
    case 'call':
      return (await host.callTool(args.tool, args.args || {}, args.id)) ?? null;
    case 'logs': {
      const limit = args.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Log limit must be 1–200');
      const entries = host.logs.filter((e) => !args.id || e.extension_id === args.id);
      return { logs: entries.slice(-limit), retained: entries.length, capacity: 500 };
    }
    case 'browser':
      browserOn = !!args.available;
      if (!browserOn) for (const c of [...sessions.values()]) c.fail(new Error('The browser disconnected'));
      return { success: true };
    default:
      throw new Error(`Unknown runtime operation ${op}`);
  }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.kind === 'answer') {
    const p = asks.get(msg.id);
    if (!p) return;
    asks.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error != null) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
    return;
  }
  if (msg.kind === 'cdp.event') {
    sessions.get(msg.session)?.emit('event', msg.method, msg.params || {});
    return;
  }
  if (msg.kind === 'cdp.closed') {
    sessions.get(msg.session)?.fail(new Error(msg.reason || 'The tab closed'));
    return;
  }
  if (msg.kind === 'call') {
    // never serialized behind each other: a long tool call must not hold up a load or a log read
    Promise.resolve()
      .then(() => run(msg.op, msg.args))
      .then(
        (result) => process.connected && process.send({ kind: 'ret', id: msg.id, result: result === undefined ? null : result }),
        (error) => process.connected && process.send({ kind: 'ret', id: msg.id, error: error?.message || String(error) }),
      );
  }
});

// the extension host (VS Code window / dev server) went away: stop every worker and exit
process.on('disconnect', () => {
  host.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
process.on('unhandledRejection', (e) => console.error('[ExtensionHost] unhandled rejection:', e?.stack || e));

await host.startHttp();
// tab events / content scripts: the app polls its WebView tabs every 300 ms; over the Chrome extension link once a second
clearInterval(host.pollTimer);
host.pollTimer = setInterval(async () => {
  if (host.polling) return;
  host.polling = true;
  try {
    await host.browser.poll();
  } catch {
    /* the next round tries again */
  } finally {
    host.polling = false;
  }
}, 1000);
host.ready = true;
process.send({ kind: 'ready', pid: process.pid, node: process.versions.node, modules: !!(await import('node:vm')).SourceTextModule });
