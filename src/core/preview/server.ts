// Local server for what the webview cannot show by itself (its CSP blocks scripts in any frame it creates, and it may
// only load files from the extension folder):
//   /p/<id>/…   an Interactive App block (```html_app): the AI's HTML, or a .html file on disk with the files next to it
//   /f/<id>/…   a local video / audio file the chat shows (with Range support, so the player can seek)
//   /v/<id>/…   a player page for that file: VS Code's webview service worker re-fetches every request the webview
//               makes to 127.0.0.1 and a <video> rejects such re-fetched byte ranges, so the chat plays local
//               media in this page (a frame's own requests never pass through that worker)
//   /yt/<id>    a YouTube embed (YouTube refuses to play inside a page that sends no referrer, like a webview)
// It listens on 127.0.0.1 only. Every page and file has a random, unguessable id the host hands to its own webview;
// nothing else is served. Apps run sandboxed (CSP `sandbox`) but keep this server's origin, so localStorage,
// sessionStorage, IndexedDB and cookies work (shared by all apps; the port is kept, so they last across restarts).
// That origin is not the webview's: an app cannot reach the chat, VS Code or the extension.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

type Entry = { kind: 'html'; html: string; at: number } | { kind: 'dir'; dir: string; at: number } | { kind: 'file'; file: string; at: number };

const MAX_ENTRIES = 300;
const MAX_HTML = 4 * 1024 * 1024;

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
};

/** Media the chat plays through /f/ (anything else is refused there). */
export const PLAYABLE = /\.(mp4|m4v|webm|mov|mkv|ogv|3gp|mp3|wav|ogg|m4a|flac)$/i;

// an app's page: scripts, forms, storage (its own origin, never the webview's), dialogs and popups where the embedder
// allows them (VS Code's webview does not: alert() and window.open() do nothing there)
const APP_CSP =
  'sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock';

const ytPage = (id: string, start: number) => `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="strict-origin-when-cross-origin">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{border:0;width:100%;height:100%}</style></head><body>
<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1&rel=0${start > 0 ? `&start=${start}` : ''}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
</body></html>`;

/** A bare player for one file: fills the frame, native controls, says so when the file cannot play. */
const playerPage = (src: string, audio: boolean) => `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden;font-family:system-ui,sans-serif}
${audio ? 'body{display:flex;align-items:center;padding:0 12px}audio{width:100%}' : 'video{display:block;width:100%;height:100%;object-fit:contain;background:#000}'}
#err{display:none;position:absolute;inset:0;align-items:center;justify-content:center;color:#ddd;font-size:13px;text-align:center;padding:16px}</style></head>
<body><${audio ? 'audio' : 'video'} id="m" src="${src}" controls autoplay playsinline preload="metadata"></${audio ? 'audio' : 'video'}>
<div id="err"></div>
<script>
const m = document.getElementById('m');
m.addEventListener('error', () => { const e = document.getElementById('err'); e.style.display = 'flex'; e.textContent = 'This file cannot play here' + (m.error && m.error.message ? ' (' + m.error.message + ')' : '') + '.'; m.style.display = 'none'; });
</script></body></html>`;

export class PreviewServer {
  private server: http.Server | null = null;
  private entries = new Map<string, Entry>();
  port = 0;
  /** The address the webview uses (VS Code may forward the port when the extension runs remotely). */
  base = '';

  constructor(public log: (line: string) => void = () => undefined) {}

  /**
   * Listens on [preferred] when it is free (the apps' storage belongs to the address, so keeping the port keeps it),
   * else on any free port.
   */
  start(preferred = 0): Promise<number> {
    if (this.server) return Promise.resolve(this.port);
    return this.listen(preferred).catch((e) => {
      if (!preferred) throw e;
      this.log(`[preview] port ${preferred} is taken (another window?): using a free one`);
      return this.listen(0);
    });
  }

  private listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.handle(req, res));
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        this.server = srv;
        this.port = (srv.address() as AddressInfo).port;
        if (!this.base) this.base = `http://127.0.0.1:${this.port}`;
        this.log(`[preview] serving chat previews on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  stop() {
    this.server?.close();
    this.server = null;
    this.entries.clear();
  }

  /** The origin the webview's CSP must allow for frames and media. */
  origin(): string {
    try {
      return new URL(this.base).origin;
    } catch {
      return `http://127.0.0.1:${this.port}`;
    }
  }

  private put(e: Entry): string {
    const id = randomBytes(16).toString('hex');
    this.entries.set(id, e);
    if (this.entries.size > MAX_ENTRIES) {
      // forget the oldest
      const old = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, this.entries.size - MAX_ENTRIES);
      for (const [k] of old) this.entries.delete(k);
    }
    return id;
  }

  /** An app made of one HTML document. */
  html(html: string): string {
    if (html.length > MAX_HTML) throw new Error('The app is too big to preview (over 4 MB)');
    // the same document gets the same address while it is remembered (a re-render does not pile up entries)
    for (const [id, e] of this.entries) if (e.kind === 'html' && e.html === html) return `${this.base}/p/${id}/`;
    return `${this.base}/p/${this.put({ kind: 'html', html, at: Date.now() })}/`;
  }

  /** An app on disk: its .html file, with the files of its folder (css, js, images) next to it. */
  htmlFile(file: string): string {
    const abs = path.resolve(file.replace(/^file:\/\//, ''));
    if (!/\.html?$/i.test(abs)) throw new Error('Not an .html file');
    if (!fs.statSync(abs).isFile()) throw new Error('Not a file');
    const dir = path.dirname(abs);
    const name = encodeURIComponent(path.basename(abs));
    for (const [id, e] of this.entries) if (e.kind === 'dir' && e.dir === dir) return `${this.base}/p/${id}/${name}`;
    return `${this.base}/p/${this.put({ kind: 'dir', dir, at: Date.now() })}/${name}`;
  }

  /** A local video / audio file. */
  file(file: string): string {
    const abs = path.resolve(file.replace(/^file:\/\//, ''));
    if (!PLAYABLE.test(abs)) throw new Error('Not a video or audio file');
    if (!fs.statSync(abs).isFile()) throw new Error('Not a file');
    const name = encodeURIComponent(path.basename(abs));
    for (const [id, e] of this.entries) if (e.kind === 'file' && e.file === abs) return `${this.base}/f/${id}/${name}`;
    return `${this.base}/f/${this.put({ kind: 'file', file: abs, at: Date.now() })}/${name}`;
  }

  /** The player page of a local video / audio file (see /v/ above). */
  player(file: string): string {
    return this.file(file).replace(`${this.base}/f/`, `${this.base}/v/`);
  }

  youtube(videoId: string, start = 0): string {
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error('Not a YouTube video id');
    return `${this.base}/yt/${videoId}${start > 0 ? `?t=${Math.floor(start)}` : ''}`;
  }

  // ------------------------------------------------------------------ requests

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      // only names of this machine (a page on another site cannot reach us through DNS rebinding)
      const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) return this.fail(res, 403);
      if (req.method !== 'GET' && req.method !== 'HEAD') return this.fail(res, 405);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean);
      const [kind, id] = parts;
      if (kind === 'yt' && id) {
        if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return this.fail(res, 404);
        const t = Number(url.searchParams.get('t') ?? 0) || 0;
        return this.send(res, 200, ytPage(id, t), 'text/html; charset=utf-8', req.method === 'HEAD');
      }
      const e = id ? this.entries.get(id) : undefined;
      if (!e) return this.fail(res, 404);
      e.at = Date.now();
      if (kind === 'p' && e.kind === 'html') {
        if (parts.length > 2) return this.fail(res, 404);
        return this.send(res, 200, e.html, 'text/html; charset=utf-8', req.method === 'HEAD', APP_CSP);
      }
      if (kind === 'p' && e.kind === 'dir') {
        let rel: string;
        try {
          rel = decodeURIComponent(parts.slice(2).join('/')) || 'index.html';
        } catch {
          return this.fail(res, 400);
        }
        const target = path.resolve(e.dir, rel);
        if (target !== e.dir && !target.startsWith(e.dir + path.sep)) return this.fail(res, 403);
        let st: fs.Stats;
        try {
          st = fs.statSync(target);
        } catch {
          return this.fail(res, 404);
        }
        const file = st.isDirectory() ? path.join(target, 'index.html') : target;
        return this.stream(req, res, file, /\.html?$/i.test(file) ? APP_CSP : null);
      }
      if (kind === 'f' && e.kind === 'file') return this.stream(req, res, e.file, null);
      if (kind === 'v' && e.kind === 'file') {
        const audio = /\.(mp3|wav|ogg|m4a|flac)$/i.test(e.file);
        return this.send(res, 200, playerPage(`/f/${id}/${encodeURIComponent(path.basename(e.file))}`, audio), 'text/html; charset=utf-8', req.method === 'HEAD');
      }
      return this.fail(res, 404);
    } catch (err) {
      this.log(`[preview] ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) this.fail(res, 500);
      else res.destroy();
    }
  }

  private headers(type: string, csp: string | null): Record<string, string> {
    return {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // sandboxed pages have an opaque origin: their module scripts and fonts are cross-origin requests
      'Access-Control-Allow-Origin': '*',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      ...(csp ? { 'Content-Security-Policy': csp } : {}),
    };
  }

  private send(res: http.ServerResponse, code: number, body: string, type: string, head: boolean, csp: string | null = null) {
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(code, { ...this.headers(type, csp), 'Content-Length': String(buf.length) });
    res.end(head ? undefined : buf);
  }

  private fail(res: http.ServerResponse, code: number) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(String(code));
  }

  /** A file, honouring a single `Range: bytes=a-b` (video seeking). */
  private stream(req: http.IncomingMessage, res: http.ServerResponse, file: string, csp: string | null) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
      if (!st.isFile()) return this.fail(res, 404);
    } catch {
      return this.fail(res, 404);
    }
    const type = MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
    const head = { ...this.headers(type, csp), 'Accept-Ranges': 'bytes' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, st.size - 1);
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': String(end - start + 1) });
      if (req.method === 'HEAD') return res.end();
      return void fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    }
    res.writeHead(200, { ...head, 'Content-Length': String(st.size) });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
}
