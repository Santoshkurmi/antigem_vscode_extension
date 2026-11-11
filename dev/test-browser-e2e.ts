// End-to-end test of browser_mcp with a THROWAWAY Chrome: a temp profile (native host manifest inside it, so the
// user's ~/.config is never touched) with ../antigem-chrome-extension loaded unpacked, a local test site, and the dev server's
// MCP (/browser on ANTIGEM_MCP_PORT, browser socket ANTIGEM_BROWSER_SOCKET). Runs every tool, prints a table, then
// closes Chrome and deletes the profile.
//   ANTIGEM_MCP_PORT=1258 ANTIGEM_BROWSER_SOCKET=<sock> CHROME=<chrome binary> node <bundle> [--headed]
/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { register } from '../src/core/browser/nativeHost';

const ROOT = process.env.ANTIGEM_ROOT ?? process.cwd();
// the Chrome extension's own repository, next to this one
const CHROME_EXT = process.env.ANTIGEM_CHROME_EXTENSION ?? path.join(ROOT, '..', 'antigem-chrome-extension');
const MCP_PORT = Number(process.env.ANTIGEM_MCP_PORT ?? 1258);
const SOCK = process.env.ANTIGEM_BROWSER_SOCKET!;
const CHROME = process.env.CHROME!;
const WORK = process.env.E2E_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'antigem-e2e-'));
const HEADED = process.argv.includes('--headed');
const DEVICE = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.antigem-vscode-dev', 'state.json'), 'utf8'))['mcp.deviceId'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rows: { tool: string; what: string; ok: boolean; note: string }[] = [];
function rec(tool: string, what: string, ok: boolean, note = '') {
  rows.push({ tool, what, ok, note: note.replace(/\s+/g, ' ').slice(0, 160) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${tool} — ${what}${note ? ` — ${note.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
}

// ------------------------------------------------------------------------------------------------ MCP client

let rpcId = 1;
async function mcp(method: string, params: unknown = {}) {
  const res = await fetch(`http://127.0.0.1:${MCP_PORT}/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Device-Id': DEVICE },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  return (await res.json()) as any;
}
async function tool(name: string, args: Record<string, unknown> = {}) {
  const r = await mcp('tools/call', { name, arguments: args });
  if (r.error) return { isError: true, text: `RPC ${r.error.code}: ${r.error.message}`, images: [] as any[], raw: r };
  const content = r.result?.content ?? [];
  return {
    isError: !!r.result?.isError,
    text: content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'),
    images: content.filter((c: any) => c.type === 'image'),
    raw: r.result,
  };
}
const evalJs = async (script: string, tab_id?: string) => (await tool('browser_eval_js', { script, ...(tab_id ? { tab_id } : {}) })).text;

// ------------------------------------------------------------------------------------------------ test site

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>AntiGem Test Page</title>
<style>body{font:16px sans-serif;margin:20px} button,input,select{margin:4px}</style></head><body>
<main>
<h1>Browser MCP test</h1>
<p id="intro">This is the AntiGem browser test page. It has a form, page dialogs, uploads, a drop area, a new-tab link and
a long scroll area, so that every browser tool can be checked against something real. The quick brown fox jumps over the lazy dog.</p>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'submitted:' + document.getElementById('name').value;">
 <label>Name <input id="name" name="name" placeholder="Your name"></label>
 <label>Email <input id="email" type="email"></label>
 <label>Color <select id="color"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select></label>
 <label><input type="checkbox" id="agree"> I agree</label>
 <button id="submit" type="submit">Send form</button>
</form>
<div id="out">-</div>
<button id="alertBtn" onclick="alert('Hello from the page')">Show alert</button>
<button id="confirmBtn" onclick="document.getElementById('out').textContent = 'confirm:' + confirm('Proceed?')">Ask confirm</button>
<button id="promptBtn" onclick="document.getElementById('out').textContent = 'prompt:' + prompt('Your city?', 'Kathmandu')">Ask prompt</button>
<button id="counter" data-n="0" onclick="this.dataset.n = +this.dataset.n + 1; this.textContent = 'Clicked ' + this.dataset.n" ondblclick="document.getElementById('out').textContent = 'dbl'" oncontextmenu="event.preventDefault(); document.getElementById('out').textContent = 'ctx'">Click me</button>
<div id="hoverBox" onmouseenter="this.textContent = 'hovered'" style="width:200px;height:40px;background:#eee">Hover here</div>
<div id="dragArea" style="width:400px;height:60px;background:#def;position:relative" onmousedown="window.__d = event.clientX" onmouseup="document.getElementById('out').textContent = 'drag:' + Math.round(event.clientX - window.__d)">Drag area</div>
<p><a id="newTabLink" href="/page2.html" target="_blank">Open page 2 in a new tab</a> · <a id="navLink" href="/page2.html">Go to page 2</a></p>
<label for="file">Upload file</label> <input type="file" id="file" multiple>
<input type="file" id="hiddenFile" style="display:none" onchange="document.getElementById('out').textContent = 'hidden:' + this.files[0].name">
<button id="uploadBtn" onclick="document.getElementById('hiddenFile').click()">Choose a file</button>
<div id="drop" style="width:300px;height:60px;border:2px dashed #999" ondragover="event.preventDefault()" ondrop="event.preventDefault(); this.textContent = 'dropped:' + [...event.dataTransfer.files].map(f => f.name + ':' + f.size).join(',')">Drop files here</div>
<textarea id="notes" aria-label="Notes"></textarea>
<div style="height:2500px"></div>
<p id="bottom">Bottom of the page</p>
</main>
<script>
console.log('page loaded', 42); console.warn('a warning'); console.error('an error happened');
fetch('/api/data').then(r => r.json()).then(j => console.log('data', j.value));
fetch('/missing').catch(() => {});
</script></body></html>`;
const PAGE2 = '<!doctype html><html><head><title>Page 2</title></head><body><h1>Second page</h1><p>You reached page two.</p></body></html>';

function serve(): Promise<http.Server & { port: number }> {
  const srv = http.createServer((req, res) => {
    const u = req.url ?? '/';
    if (u === '/' || u.startsWith('/index')) return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (u.startsWith('/page2')) return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE2);
    if (u.startsWith('/api/data')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"value":7}');
    res.writeHead(404).end('nope');
  }) as http.Server & { port: number };
  return new Promise((r) =>
    srv.listen(0, '127.0.0.1', () => {
      srv.port = (srv.address() as any).port;
      r(srv);
    }),
  );
}

// ------------------------------------------------------------------------------------------------ CDP (the harness's own, to play the user)

class Cdp {
  ws!: WebSocket;
  id = 1;
  pending = new Map<number, (m: any) => void>();
  async open(url: string) {
    this.ws = new WebSocket(url);
    await new Promise((r, j) => {
      this.ws.once('open', r);
      this.ws.once('error', j);
    });
    this.ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      }
    });
  }
  send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    const id = this.id++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    // a target that closes while handling the command (the confirm window after a click) may never answer
    return new Promise((r) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        r({ timedOut: true });
      }, 10_000);
      this.pending.set(id, (m) => {
        clearTimeout(t);
        r(m.result ?? m);
      });
    });
  }
  async session(targetId: string) {
    return (await this.send('Target.attachToTarget', { targetId, flatten: true })).sessionId as string;
  }
  async click(sessionId: string, x: number, y: number) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 }, sessionId);
    }
  }
  async evaluate(sessionId: string, expression: string) {
    return (await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;
  }
}

/** Waits for the confirm window and presses Allow or Deny with a real (trusted) click. */
async function answerConfirm(cdp: Cdp, allow: boolean, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const t = targetInfos.find((x: any) => x.type === 'page' && x.url.includes('/confirm.html#'));
    if (t) {
      const s = await cdp.session(t.targetId);
      await sleep(300);
      const r = await cdp.evaluate(s, `(() => { const b = document.getElementById('${allow ? 'allow' : 'deny'}').getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2, title: document.getElementById('title').textContent}; })()`);
      await cdp.click(s, r.x, r.y);
      return r.title as string;
    }
    await sleep(150);
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ main

async function main() {
  const profile = path.join(WORK, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  // the native host manifest inside the throwaway profile (Chrome reads <user-data-dir>/NativeMessagingHosts)
  const reg = await register({
    binPath: path.join(ROOT, 'bin', `antigem-bridge-${process.platform}-${process.arch}`),
    dirs: [path.join(profile, 'NativeMessagingHosts')],
    wrapper: path.join(WORK, 'native', 'antigem-native-host'),
    socketPath: SOCK,
  });
  console.log(`native host: ${reg.written.join(', ')}`);
  const site = await serve();
  const base = `http://127.0.0.1:${site.port}`;
  const upload1 = path.join(WORK, 'hello.txt');
  fs.writeFileSync(upload1, 'hello upload');
  const upload2 = path.join(WORK, 'pixel.png');
  fs.writeFileSync(upload2, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

  const args = [
    `--user-data-dir=${profile}`,
    `--load-extension=${CHROME_EXT}`,
    `--disable-extensions-except=${CHROME_EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--password-store=basic',
    '--remote-debugging-port=0',
    '--window-size=1280,900',
    ...(HEADED ? [] : ['--headless=new']),
    'about:blank',
  ];
  const chrome = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let wsUrl = '';
  chrome.stderr.on('data', (d) => {
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
    if (m) wsUrl = m[1];
  });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) throw new Error('Chrome did not start');
  const cdp = new Cdp();
  await cdp.open(wsUrl);
  const ver = await cdp.send('Browser.getVersion');
  console.log(`browser: ${ver.product}${HEADED ? '' : ' (headless)'}`);

  try {
    // ---------------------------------------------------------------- connection
    let connected = false;
    for (let i = 0; i < 100 && !connected; i++) {
      const r = await tool('browser_list_tabs');
      connected = !r.isError;
      if (!connected) await sleep(200);
    }
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t: any) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://kbdjcdlfeoijcchepbldpldeaeijgibi/'));
    rec('(link)', 'extension loaded, id pinned by key', !!sw && sw.url.startsWith('chrome-extension://kbdjcdlfeoijcchepbldpldeaeijgibi/'), sw?.url ?? 'no service worker');
    rec('(link)', 'native host -> VS Code socket -> MCP', connected);
    if (!connected) throw new Error('extension never connected');

    // ---------------------------------------------------------------- open, list, read
    let r = await tool('browser_list_tabs');
    rec('browser_list_tabs', 'no AntiGem tabs yet; other tabs hidden', !r.isError && r.text.startsWith('[]') && /other tab/.test(r.text), r.text);

    r = await tool('browser_open_url', { url: `${base}/`, action_summary: 'Opening the test page' });
    const tabId = /Tab (\d+): loaded/.exec(r.text)?.[1] ?? '';
    rec('browser_open_url', 'opens a new tab in the AntiGem group and waits', !r.isError && !!tabId && /AntiGem Test Page/.test(r.text), r.text);
    const groups = await cdp.evaluate(
      (await cdp.session(sw.targetId)) as string,
      `(async () => (await chrome.tabGroups.query({})).map(g => g.title + ':' + g.color))()`,
    ).catch(() => null);
    rec('(policy)', 'tab group "AntiGem" created', JSON.stringify(groups ?? '').includes('AntiGem'), JSON.stringify(groups));

    r = await tool('browser_list_tabs');
    rec('browser_list_tabs', 'lists the AntiGem tab', !r.isError && r.text.includes(`"id": "${tabId}"`) && r.text.includes('"isActive": true'), r.text.slice(0, 200));

    r = await tool('browser_read_page', { filter: 'interactive' });
    rec('browser_read_page', 'interactive tree with refs', !r.isError && /textbox "Name" \[ref_\d+\]/.test(r.text) && /button "Send form"/.test(r.text), r.text.slice(0, 200));
    r = await tool('browser_read_page', {});
    rec('browser_read_page', 'full tree', !r.isError && /heading "Browser MCP test"/.test(r.text) && r.text.includes('Page: AntiGem Test Page'), r.text.slice(0, 160));

    r = await tool('browser_find', { query: 'name field' });
    const nameRef = /- (ref_\d+): textbox "Name"/.exec(r.text)?.[1] ?? '';
    rec('browser_find', 'finds the name field', !r.isError && !!nameRef, r.text.slice(0, 200));

    r = await tool('browser_get_page_text', {});
    rec('browser_get_page_text', 'main text', !r.isError && /quick brown fox/.test(r.text) && /From: main/.test(r.text), r.text.slice(0, 160));

    // ---------------------------------------------------------------- screenshot & coordinates
    r = await tool('browser_computer', { action: 'screenshot' });
    const size = /Size (\d+)x(\d+)/.exec(r.text);
    const shotW = Number(size?.[1] ?? 0);
    const shotH = Number(size?.[2] ?? 0);
    rec('browser_computer', 'screenshot (<= 1568 px, JPEG)', !r.isError && r.images.length === 1 && shotW > 0 && shotW <= 1568 && r.images[0].mimeType === 'image/jpeg', r.text.split('\n')[1]);
    if (r.images[0]) fs.writeFileSync(path.join(WORK, 'shot.jpg'), Buffer.from(r.images[0].data, 'base64'));
    const overlayInShot = await evalJs('!!document.querySelector("antigem-agent-overlay")');
    rec('(overlay)', 'agent overlay present in the page DOM', overlayInShot === 'true', overlayInShot);

    r = await tool('browser_computer', { action: 'scale' as any });
    rec('browser_computer', 'unknown action refused', r.isError && /Unknown action/.test(r.text), r.text);

    r = await tool('browser_computer', { action: 'zoom', region: [0, 0, Math.round(shotW / 2), Math.round(shotH / 4)] });
    rec('browser_computer', 'zoom', !r.isError && r.images.length === 1 && /Zoomed view/.test(r.text), r.text);

    // find the counter button in screenshot pixels: CSS rect * (shot / viewport)
    const geo = JSON.parse(
      await evalJs(`(() => { const b = document.getElementById('counter').getBoundingClientRect(); return JSON.stringify({x: b.x + b.width/2, y: b.y + b.height/2, w: innerWidth, h: innerHeight}); })()`),
    );
    const sx = Math.round((geo.x * shotW) / geo.w);
    const sy = Math.round((geo.y * shotH) / geo.h);
    r = await tool('browser_computer', { action: 'left_click', coordinate: [sx, sy], action_summary: 'Clicking the counter' });
    let n = await evalJs('document.getElementById("counter").dataset.n');
    rec('browser_computer', 'left_click by coordinate (trusted)', !r.isError && n === '1' && /button "Click me"/.test(r.text), `${r.text} | n=${n}`);

    r = await tool('browser_find', { query: 'Clicked 1 button' });
    const counterRef = /- (ref_\d+): button "Clicked 1"/.exec(r.text)?.[1] ?? '';
    r = await tool('browser_computer', { action: 'left_click', ref: counterRef });
    n = await evalJs('document.getElementById("counter").dataset.n');
    rec('browser_computer', 'left_click by ref', !r.isError && n === '2', `${r.text} | n=${n}`);

    r = await tool('browser_computer', { action: 'double_click', ref: counterRef });
    rec('browser_computer', 'double_click', !r.isError && (await evalJs('document.getElementById("out").textContent')) === 'dbl', r.text);
    r = await tool('browser_computer', { action: 'right_click', ref: counterRef });
    rec('browser_computer', 'right_click', !r.isError && (await evalJs('document.getElementById("out").textContent')) === 'ctx', r.text);

    r = await tool('browser_find', { query: 'Hover here' });
    const hoverRef = /- (ref_\d+):/.exec(r.text)?.[1] ?? '';
    r = await tool('browser_computer', { action: 'hover', ref: hoverRef });
    rec('browser_computer', 'hover', !r.isError && (await evalJs('document.getElementById("hoverBox").textContent')) === 'hovered', r.text);

    const dg = JSON.parse(await evalJs(`(() => { const b = document.getElementById('dragArea').getBoundingClientRect(); return JSON.stringify({x: b.x, y: b.y + b.height/2}); })()`));
    const k = shotW / geo.w;
    r = await tool('browser_computer', { action: 'left_click_drag', start_coordinate: [Math.round((dg.x + 20) * k), Math.round(dg.y * k)], coordinate: [Math.round((dg.x + 220) * k), Math.round(dg.y * k)] });
    const dragOut = await evalJs('document.getElementById("out").textContent');
    rec('browser_computer', 'left_click_drag', !r.isError && /^drag:(19\d|20\d)$/.test(dragOut), `${r.text} | ${dragOut}`);

    // ---------------------------------------------------------------- typing & keys
    r = await tool('browser_computer', { action: 'type', text: 'nothing focused' });
    rec('browser_computer', 'type without focus refused', r.isError && /no text field has keyboard focus|not a text field/.test(r.text), r.text);
    r = await tool('browser_computer', { action: 'left_click', ref: nameRef });
    r = await tool('browser_computer', { action: 'type', text: 'Ada Lovelace' });
    rec('browser_computer', 'type', !r.isError && (await evalJs('document.getElementById("name").value')) === 'Ada Lovelace', r.text);
    r = await tool('browser_computer', { action: 'key', text: 'ctrl+a Backspace' });
    rec('browser_computer', 'key ctrl+a Backspace', !r.isError && (await evalJs('document.getElementById("name").value')) === '', r.text);
    await tool('browser_computer', { action: 'type', text: 'Grace\n' });
    rec('browser_computer', 'type with \\n submits', (await evalJs('document.getElementById("out").textContent')) === 'submitted:Grace');

    r = await tool('browser_computer', { action: 'wait', duration: 0.3 });
    rec('browser_computer', 'wait', !r.isError && /Waited 0.3 s/.test(r.text), r.text);

    // ---------------------------------------------------------------- forms
    r = await tool('browser_read_page', { filter: 'interactive' });
    const ref = (re: RegExp) => re.exec(r.text)?.[1] ?? '';
    const emailRef = ref(/textbox "Email" \[(ref_\d+)\]/);
    const colorRef = ref(/combobox "Color" \[(ref_\d+)\]/);
    const agreeRef = ref(/checkbox "I agree" \[(ref_\d+)\]/);
    let f = await tool('browser_form_input', { ref: emailRef, value: 'ada@example.com' });
    const f2 = await tool('browser_form_input', { ref: colorRef, value: 'Blue' });
    const f3 = await tool('browser_form_input', { ref: agreeRef, value: true });
    const vals = await evalJs('JSON.stringify([email.value, color.value, agree.checked])');
    rec('browser_form_input', 'text, select, checkbox', !f.isError && !f2.isError && !f3.isError && vals === '["ada@example.com","b",true]', `${f.text} | ${f2.text} | ${f3.text} | ${vals}`);
    f = await tool('browser_form_input', { ref: agreeRef, value: true });
    rec('browser_form_input', 'checkbox never clicked twice', !f.isError && /already checked/.test(f.text), f.text);

    // ---------------------------------------------------------------- eval, console, network
    r = await tool('browser_eval_js', { script: "await fetch('/api/data').then(r => r.json())" });
    rec('browser_eval_js', 'top-level await, JSON result', !r.isError && /"value": 7/.test(r.text), r.text);
    r = await tool('browser_eval_js', { script: 'throw new Error("boom")' });
    rec('browser_eval_js', 'JS errors reported', r.isError && /JavaScript error: Error: boom/.test(r.text), r.text);

    // the page's own load was recorded because the debugger attached before navigating
    r = await tool('browser_get_console_logs', {});
    rec('browser_get_console_logs', 'records from the first load', !r.isError && /page loaded 42/.test(r.text) && /WARN a warning/.test(r.text) && /ERROR an error happened/.test(r.text), r.text.slice(0, 220));
    r = await tool('browser_get_console_logs', { only_errors: true });
    rec('browser_get_console_logs', 'only_errors', !r.isError && !/page loaded/.test(r.text) && /an error happened/.test(r.text), r.text.slice(0, 160));
    r = await tool('browser_get_console_logs', { pattern: 'data\\s+7' });
    rec('browser_get_console_logs', 'pattern', !r.isError && /data 7/.test(r.text), r.text.slice(0, 160));

    r = await tool('browser_read_network', {});
    rec('browser_read_network', 'requests with status/type/size/time', !r.isError && /GET 200 document text\/html/.test(r.text) && /\/api\/data/.test(r.text), r.text.slice(0, 260));
    r = await tool('browser_read_network', { only_failed: true });
    rec('browser_read_network', 'only_failed', !r.isError && /GET 404 .*\/missing/.test(r.text) && !/api\/data/.test(r.text), r.text.slice(0, 200));

    // ---------------------------------------------------------------- dialogs
    r = await tool('browser_find', { query: 'Show alert button' });
    const alertRef = /- (ref_\d+): button "Show alert"/.exec(r.text)?.[1] ?? '';
    r = await tool('browser_computer', { action: 'left_click', ref: alertRef });
    rec('browser_computer', 'click that opens an alert reports it', /opened a page dialog: a JavaScript alert is open/.test(r.text), r.text);
    r = await tool('browser_find', { query: 'anything' });
    rec('(dialog guard)', 'other tools refuse while the alert is open', r.isError && /alert is open/.test(r.text), r.text.slice(0, 160));
    r = await tool('browser_list_tabs');
    rec('browser_list_tabs', 'shows the open dialog', /"dialog"/.test(r.text) && /Hello from the page/.test(r.text));
    r = await tool('browser_handle_dialog', { accept: true });
    rec('browser_handle_dialog', 'accept alert', !r.isError && /Accepted the alert "Hello from the page"/.test(r.text), r.text);

    r = await tool('browser_find', { query: 'Ask prompt button' });
    const promptRef = /- (ref_\d+): button "Ask prompt"/.exec(r.text)?.[1] ?? '';
    await tool('browser_computer', { action: 'left_click', ref: promptRef });
    r = await tool('browser_handle_dialog', { accept: true, prompt_text: 'Pokhara' });
    rec('browser_handle_dialog', 'prompt with prompt_text', !r.isError && (await evalJs('document.getElementById("out").textContent')) === 'prompt:Pokhara', r.text);
    r = await tool('browser_find', { query: 'Ask confirm button' });
    const confirmRef = /- (ref_\d+): button "Ask confirm"/.exec(r.text)?.[1] ?? '';
    await tool('browser_computer', { action: 'left_click', ref: confirmRef });
    r = await tool('browser_handle_dialog', { accept: false });
    rec('browser_handle_dialog', 'dismiss confirm', !r.isError && (await evalJs('document.getElementById("out").textContent')) === 'confirm:false', r.text);

    // ---------------------------------------------------------------- uploads
    r = await tool('browser_find', { query: 'Upload file input' });
    const fileRef = /- (ref_\d+): file-input/.exec(r.text)?.[1] ?? '';
    r = await tool('browser_upload_file', { ref: fileRef, file_paths: [upload1, upload2] });
    const names = await evalJs('JSON.stringify([...document.getElementById("file").files].map(f => f.name + ":" + f.size))');
    rec('browser_upload_file', 'file input by ref (2 files)', !r.isError && names === '["hello.txt:12","pixel.png:70"]' && /"method": "chooser"/.test(r.text), `${names} ${r.text.replace(/\s+/g, ' ')}`);
    r = await tool('browser_find', { query: 'Choose a file button' });
    const btnRef = /- (ref_\d+): button "Choose a file"/.exec(r.text)?.[1] ?? '';
    r = await tool('browser_upload_file', { ref: btnRef, file_paths: [upload1] });
    const hiddenOut = await evalJs('document.getElementById("out").textContent');
    rec('browser_upload_file', 'button that opens a hidden input (chooser)', !r.isError && hiddenOut === 'hidden:hello.txt', `${hiddenOut} ${r.text.replace(/\s+/g, ' ')}`);
    r = await tool('browser_upload_file', { selector: '#drop', file_paths: [upload1], method: 'drop' });
    const dropped = await evalJs('document.getElementById("drop").textContent');
    rec('browser_upload_file', 'drop area (built in the page)', !r.isError && dropped === 'dropped:hello.txt:12', `${dropped} ${r.text.replace(/\s+/g, ' ')}`);
    r = await tool('browser_computer', { action: 'left_click', ref: fileRef });
    rec('browser_computer', 'clicking a file input is refused', r.isError && /browser_upload_file/.test(r.text), r.text);

    // ---------------------------------------------------------------- scrolling
    r = await tool('browser_computer', { action: 'scroll', scroll_direction: 'down', scroll_amount: 5 });
    const sy1 = Number(await evalJs('scrollY'));
    rec('browser_computer', 'scroll (+ screenshot)', !r.isError && sy1 > 0 && r.images.length === 1, `${r.text.split('\n')[0]} scrollY=${sy1}`);
    r = await tool('browser_find', { query: 'Bottom of the page' });
    const bottomRef = /- (ref_\d+):/.exec(r.text)?.[1] ?? '';
    r = await tool('browser_computer', { action: 'scroll_to', ref: bottomRef });
    rec('browser_computer', 'scroll_to', !r.isError && /into view/.test(r.text) && Number(await evalJs('scrollY')) > sy1, r.text);
    await tool('browser_eval_js', { script: 'scrollTo(0,0)' });

    // ---------------------------------------------------------------- lock: the user's input is kept off the page
    r = await tool('browser_lock', { action_summary: 'Testing the lock' });
    rec('browser_lock', 'lock on', !r.isError && /Agent lock on. Locked now: /.test(r.text) && r.text.includes(tabId), r.text.split('\n')[0]);
    const pageTarget = (await cdp.send('Target.getTargets')).targetInfos.find((t: any) => t.type === 'page' && t.url.startsWith(base));
    const ps = await cdp.session(pageTarget.targetId);
    const before = await cdp.evaluate(ps, 'document.getElementById("counter").dataset.n');
    const cr = await cdp.evaluate(ps, `(() => { const b = document.getElementById('counter').getBoundingClientRect(); return {x: b.x + b.width/2, y: b.y + b.height/2}; })()`);
    const ov = await cdp.send('Page.captureScreenshot', { format: 'png' }, ps);
    if (ov?.data) fs.writeFileSync(path.join(WORK, 'overlay-locked.png'), Buffer.from(ov.data, 'base64'));
    const agentShot = await tool('browser_computer', { action: 'screenshot', scale: 0.5 });
    if (agentShot.images[0]) fs.writeFileSync(path.join(WORK, 'agent-view-locked.jpg'), Buffer.from(agentShot.images[0].data, 'base64'));
    await cdp.click(ps, cr.x, cr.y); // a "user" click while locked
    await sleep(200);
    const afterUser = await cdp.evaluate(ps, 'document.getElementById("counter").dataset.n');
    rec('(lock)', "user's click is blocked while locked", afterUser === before, `${before} -> ${afterUser}`);
    r = await tool('browser_computer', { action: 'left_click', ref: counterRef });
    const afterAgent = await evalJs('document.getElementById("counter").dataset.n');
    rec('(lock)', "agent's click still works while locked", !r.isError && Number(afterAgent) === Number(before) + 1, `${before} -> ${afterAgent}`);
    r = await tool('browser_list_tabs');
    rec('browser_list_tabs', 'lockedByAgent', /"lockedByAgent": true/.test(r.text));
    r = await tool('browser_lock', { locked: false });
    rec('browser_lock', 'unlock all', !r.isError && /Agent lock off. Released 1 tab/.test(r.text), r.text);
    await sleep(300);
    await cdp.click(ps, cr.x, cr.y);
    await sleep(200);
    const afterUnlock = await cdp.evaluate(ps, 'document.getElementById("counter").dataset.n');
    rec('(lock)', "user's click works again after unlock", Number(afterUnlock) === Number(afterAgent) + 1, `${afterAgent} -> ${afterUnlock}`);

    // ---------------------------------------------------------------- navigation & tabs
    r = await tool('browser_find', { query: 'Open page 2 in a new tab' });
    const newTabRef = /- (ref_\d+): link/.exec(r.text)?.[1] ?? '';
    r = await tool('browser_computer', { action: 'left_click', ref: newTabRef });
    const tab2 = /This opened a new tab: (\d+)/.exec(r.text)?.[1] ?? '';
    rec('browser_computer', 'click opening a new tab is reported (tab joins the group)', !!tab2, r.text);
    r = await tool('browser_list_tabs');
    rec('browser_list_tabs', 'new tab listed (group)', r.text.includes(`"id": "${tab2}"`), '');
    r = await tool('browser_switch_tab', { tab_id: tabId });
    rec('browser_switch_tab', 'switch', !r.isError && r.text === `Switched to tab ${tabId}`, r.text);
    r = await tool('browser_close_tab', { tab_id: tab2 });
    rec('browser_close_tab', 'close', !r.isError && r.text === `Closed tab ${tab2}`, r.text);

    r = await tool('browser_find', { query: 'Go to page 2 link' });
    const navRef = /- (ref_\d+): link "Go to page 2"/.exec(r.text)?.[1] ?? '';
    r = await tool('browser_computer', { action: 'left_click', ref: navRef });
    rec('browser_computer', 'navigation reported by settle', /The page changed to .*page2.html — "Page 2"/.test(r.text), r.text);
    r = await tool('browser_open_url', { url: 'back' });
    rec('browser_open_url', 'back', !r.isError && /AntiGem Test Page/.test(r.text), r.text.split('\n')[0]);
    r = await tool('browser_open_url', { url: 'forward' });
    rec('browser_open_url', 'forward', !r.isError && /Page 2/.test(r.text), r.text.split('\n')[0]);
    r = await tool('browser_open_url', { url: 'reload' });
    rec('browser_open_url', 'reload', !r.isError && /loaded/.test(r.text), r.text.split('\n')[0]);
    r = await tool('browser_computer', { action: 'left_click', ref: counterRef });
    rec('browser_computer', 'stale ref after navigation is explained', r.isError && /(not from this page|No element)/.test(r.text), r.text);

    // ---------------------------------------------------------------- view mode
    r = await tool('browser_set_view_mode', { mode: 'mobile' });
    const ua = await evalJs('navigator.userAgent + " " + innerWidth');
    rec('browser_set_view_mode', 'mobile', !r.isError && /Android.*Mobile/.test(ua), `${r.text} | ${ua}`);
    r = await tool('browser_computer', { action: 'screenshot' });
    const ms = /Size (\d+)x(\d+)/.exec(r.text);
    rec('browser_computer', 'mobile screenshot is portrait', !!ms && Number(ms[2]) > Number(ms[1]), r.text.split('\n')[1]);
    r = await tool('browser_set_view_mode', { desktop_mode: true });
    const ua2 = await evalJs('navigator.userAgent');
    rec('browser_set_view_mode', 'desktop', !r.isError && !/Mobile/.test(ua2), r.text);

    // ---------------------------------------------------------------- batch (Claude-in-Chrome names)
    await tool('browser_open_url', { url: `${base}/` });
    r = await tool('browser_batch', {
      actions: [
        { name: 'find', input: { query: 'Notes' } },
        { name: 'computer', input: { action: 'screenshot', scale: 0.5 } },
        { name: 'javascript_tool', input: { script: 'document.title' } },
      ],
    });
    rec('browser_batch', '3 steps incl. aliases + image', !r.isError && /\[1\/3\] browser_find/.test(r.text) && /\[3\/3\] browser_eval_js: AntiGem Test Page/.test(r.text) && r.images.length === 1, r.text.replace(/\n/g, ' | ').slice(0, 200));
    r = await tool('browser_batch', { actions: [{ name: 'computer', input: { action: 'nope' } }, { name: 'find', input: { query: 'x' } }] });
    rec('browser_batch', 'stops at the first error', r.isError && /Batch stopped at step 1 of 2/.test(r.text), r.text.replace(/\n/g, ' | '));

    // ---------------------------------------------------------------- legacy hidden tools
    r = await tool('browser_screenshot', {});
    rec('browser_screenshot (hidden)', 'image', !r.isError && r.images.length === 1);
    r = await tool('browser_inspect_dom', {});
    rec('browser_inspect_dom (hidden)', 'tree', !r.isError && /Browser MCP test/.test(r.text));
    r = await tool('browser_interact', { action: 'type', selector: '#notes', text: 'legacy' });
    rec('browser_interact (hidden)', 'type', !r.isError && r.text === 'Done' && (await evalJs('document.getElementById("notes").value')) === 'legacy', r.text);

    // ---------------------------------------------------------------- safety: blocklist, other tabs, confirm
    r = await tool('browser_open_url', { url: 'https://www.paypal.com/', new_tab: true });
    rec('(blocklist)', 'banking site refused', r.isError && /blocklist/.test(r.text), r.text);
    r = await tool('browser_open_url', { url: 'chrome://settings' });
    rec('(blocklist)', 'browser pages refused', r.isError && /browser pages cannot be controlled/.test(r.text), r.text);

    // a tab the user opened outside the group: invisible to the agent, needs an OK
    const userTab = await cdp.send('Target.createTarget', { url: `${base}/page2.html`, newWindow: true });
    await sleep(800);
    const chromeTabs = JSON.parse(await (async () => {
      const s = await cdp.session(sw.targetId);
      return cdp.evaluate(s, `(async () => JSON.stringify((await chrome.tabs.query({})).map(t => ({id: t.id, url: t.url, group: t.groupId}))))()`);
    })());
    const outside = chromeTabs.find((t: any) => t.url.endsWith('/page2.html') && t.group === -1);
    if (!outside) console.log('tabs seen by the extension:', JSON.stringify(chromeTabs));
    r = await tool('browser_list_tabs');
    rec('(policy)', 'user tab not listed', !!outside && !r.text.includes(`"id": "${outside.id}"`), `outside=${outside?.id}`);
    // deny
    const denyP = tool('browser_read_page', { tab_id: String(outside.id) });
    const denyTitle = await answerConfirm(cdp, false);
    r = await denyP;
    rec('(confirm)', 'user tab: Deny', denyTitle === 'Let the agent use this tab?' && r.isError && /did not allow/.test(r.text), `${denyTitle} | ${r.text}`);
    // allow
    const allowP = tool('browser_get_page_text', { tab_id: String(outside.id) });
    const allowTitle = await answerConfirm(cdp, true);
    r = await allowP;
    rec('(confirm)', 'user tab: Allow -> joins the group', !!allowTitle && !r.isError && /Second page/.test(r.text), r.text.slice(0, 100));
    r = await tool('browser_list_tabs');
    rec('(policy)', 'allowed tab now listed', r.text.includes(`"id": "${outside.id}"`));
    await cdp.send('Target.closeTarget', { targetId: userTab.targetId });

    // ---------------------------------------------------------------- a background tab, the popup, VS Code settings
    r = await tool('browser_open_url', { url: `${base}/page2.html`, new_tab: true });
    const front = /Tab (\d+)/.exec(r.text)?.[1] ?? '';
    r = await tool('browser_computer', { action: 'screenshot', tab_id: tabId });
    rec('browser_computer', 'screenshot of a background tab', !r.isError && r.images.length === 1, r.text.split('\n')[0]);
    await tool('browser_close_tab', { tab_id: front });

    const pop = await cdp.send('Target.createTarget', { url: 'chrome-extension://kbdjcdlfeoijcchepbldpldeaeijgibi/popup.html' });
    const popS = await cdp.session(pop.targetId);
    await sleep(800);
    const popState = await cdp.evaluate(popS, `JSON.stringify({status: document.getElementById('status').textContent, tabs: document.querySelectorAll('#tabs li').length, block: document.getElementById('blocklist').value.split('\\n').length})`);
    const popShot = await cdp.send('Page.captureScreenshot', { format: 'png' }, popS);
    if (popShot?.data) fs.writeFileSync(path.join(WORK, 'popup.png'), Buffer.from(popShot.data, 'base64'));
    await cdp.send('Target.closeTarget', { targetId: pop.targetId });
    rec('(popup)', 'shows "Connected to VS Code", the group tabs, the blocklist', /Connected to VS Code/.test(popState) && /"block":3\d/.test(popState), popState);

    const view = new WebSocket(`ws://127.0.0.1:${process.env.ANTIGEM_DEV_PORT ?? 5196}`);
    await new Promise((res, rej) => {
      view.once('open', res);
      view.once('error', rej);
    });
    const inbox: any[] = [];
    view.on('message', (d) => inbox.push(JSON.parse(String(d))));
    const waitMsg = async (pred: (m: any) => boolean, ms = 8000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const i = inbox.findIndex(pred);
        if (i >= 0) return inbox.splice(i, 1)[0];
        await sleep(50);
      }
      return null;
    };
    view.send(JSON.stringify({ type: 'requestSettings', page: 'root' }));
    const root = await waitMsg((m) => m.type === 'settings' && m.page?.id === 'root');
    const row = root?.page.sections.flatMap((x: any) => x.items).find((i: any) => i.id === 'browser');
    rec('(settings)', 'root has a Browser row', row?.label === 'Browser' && row?.badge === 'Connected', JSON.stringify(row));
    view.send(JSON.stringify({ type: 'requestSettings', page: 'browser' }));
    const bp = await waitMsg((m) => m.type === 'settings' && m.page?.id === 'browser');
    const items = bp?.page.sections.flatMap((x: any) => x.items) ?? [];
    const st = items.find((i: any) => i.id === 'browser.status');
    const bl = items.find((i: any) => i.id === 'browser.blocklist');
    rec('(settings)', 'Browser page: status, setup buttons, blocklist', st?.tone === 'ok' && /Connected · HeadlessChrome 156/.test(st?.value) && items.some((i: any) => i.id === 'browser.register') && items.some((i: any) => i.id === 'browser.install') && /paypal\.com/.test(bl?.value ?? ''), `${st?.value} | blocklist ${String(bl?.value ?? '').split('\n').length} lines`);
    view.send(JSON.stringify({ type: 'settingAction', page: 'browser', id: 'browser.test' }));
    const toast = await waitMsg((m) => m.type === 'toast');
    rec('(settings)', 'Test the connection', /answered in \d+ ms/.test(toast?.message ?? ''), toast?.message);
    // adding to the blocklist from VS Code applies directly; removing needs the browser's OK (denied here)
    view.send(JSON.stringify({ type: 'settingChange', page: 'browser', id: 'browser.blocklist', value: `${bl.value}\nexample.org` }));
    await sleep(500);
    let list = (await (async () => { const s2 = await cdp.session(sw.targetId); return cdp.evaluate(s2, `(async () => (await chrome.storage.local.get('blocklist')).blocklist.join(','))()`); })()) as string;
    rec('(settings)', 'blocklist addition from VS Code', /example\.org/.test(list), '');
    view.send(JSON.stringify({ type: 'settingChange', page: 'browser', id: 'browser.blocklist', value: 'example.org' }));
    const askTitle = await answerConfirm(cdp, false);
    await sleep(500);
    list = (await (async () => { const s2 = await cdp.session(sw.targetId); return cdp.evaluate(s2, `(async () => (await chrome.storage.local.get('blocklist')).blocklist.length)()`); })()) as string;
    rec('(settings)', 'blocklist removal from VS Code needs the browser OK (denied -> kept)', askTitle === 'Remove sites from the AntiGem blocklist?' && Number(list) > 30, `${askTitle} | ${list} entries`);
    view.close();

    // ---------------------------------------------------------------- a real site
    r = await tool('browser_open_url', { url: 'https://example.com', new_tab: true });
    const exTab = /Tab (\d+)/.exec(r.text)?.[1] ?? '';
    rec('browser_open_url', 'example.com', !r.isError && /Example Domain/.test(r.text), r.text.split('\n')[0]);
    r = await tool('browser_get_page_text', {});
    rec('browser_get_page_text', 'example.com text', !r.isError && /(documentation examples|illustrative examples)/i.test(r.text), r.text.slice(0, 120));
    r = await tool('browser_find', { query: 'More information link' });
    const moreRef = /- (ref_\d+): link/.exec(r.text)?.[1] ?? '';
    r = await tool('browser_computer', { action: 'left_click', ref: moreRef });
    rec('browser_computer', 'example.com link navigates', !r.isError && /The page changed to https:\/\/www\.iana\.org/.test(r.text), r.text.replace(/\n/g, ' | ').slice(0, 200));
    r = await tool('browser_computer', { action: 'screenshot', tab_id: exTab });
    rec('browser_computer', 'screenshot of a real site', !r.isError && r.images.length === 1, r.text.split('\n')[0]);
    r = await tool('browser_open_url', { url: 'http://nonexistent.invalid/', tab_id: exTab });
    rec('browser_open_url', 'load error reported', /error: net::ERR_NAME_NOT_RESOLVED/.test(r.text), r.text.split('\n').slice(0, 2).join(' | '));

    // ---------------------------------------------------------------- the user disconnects in the popup
    const pop2 = await cdp.send('Target.createTarget', { url: 'chrome-extension://kbdjcdlfeoijcchepbldpldeaeijgibi/popup.html', newWindow: true });
    const p2 = await cdp.session(pop2.targetId);
    await sleep(800);
    const tg = await cdp.evaluate(p2, `(() => { const b = document.getElementById('toggle').getBoundingClientRect(); return {x: b.x + b.width/2, y: b.y + b.height/2}; })()`);
    await cdp.click(p2, tg.x, tg.y);
    await sleep(800);
    r = await tool('browser_list_tabs');
    rec('(popup)', 'Disconnect: agents get the not-connected error', r.isError && /not connected/.test(r.text), r.text.slice(0, 120));
    const tg2 = await cdp.evaluate(p2, `(() => { const b = document.getElementById('toggle'); const r = b.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2, label: b.textContent}; })()`);
    await cdp.click(p2, tg2.x, tg2.y);
    let back = false;
    for (let i = 0; i < 40 && !back; i++) {
      await sleep(250);
      back = !(await tool('browser_list_tabs')).isError;
    }
    rec('(popup)', 'Connect again', back && tg2.label === 'Connect', tg2.label);
    await cdp.send('Target.closeTarget', { targetId: pop2.targetId });
  } finally {
    // report
    const ok = rows.filter((x) => x.ok).length;
    console.log(`\n${ok}/${rows.length} passed`);
    fs.writeFileSync(path.join(WORK, 'results.json'), JSON.stringify(rows, null, 2));
    try {
      await cdp.send('Browser.close');
    } catch {
      /* gone */
    }
    await sleep(500);
    chrome.kill('SIGTERM');
    site.close();
  }
}

main().catch((e) => {
  console.error('E2E aborted:', e);
  process.exit(1);
});
