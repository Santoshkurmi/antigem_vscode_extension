// The extension's built-in MCP servers (notes, theme, plugin developer, Jarvis, browser…), one HTTP server with a
// path per server — the Android app's AndroidLocalBridgeServer protocol exactly: JSON-RPC 2.0 over POST (one request
// or a batch), notifications → 202, GET → 405, `X-Device-Id` header on every request, `initialize` →
// protocolVersion 2024-11-05 + per-server instructions, unknown tool → -32601, failures → -32603.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../types';

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface McpResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerDef {
  /** URL path ("/notes"). */
  path: string;
  /** serverInfo.name ("notes_mcp"). */
  name: string;
  instructions?: string;
  /** Gives each connection a session id (Mcp-Session-Id) and passes it to calls as `_mcp_session` (Jarvis). */
  stateful?: boolean;
  tools(): McpTool[] | Promise<McpTool[]>;
  /** Tools that work but are not listed (legacy names). */
  hiddenTool?(name: string): boolean;
  call(name: string, args: Record<string, unknown>): Promise<McpResult> | McpResult;
  /** Refuse every method but ping with this message (e.g. "Jarvis is turned off"). */
  notReady?(): string | null;
  /** serverInfo.version (default "1.0.0"). */
  version?: string;
  /**
   * One path serving several servers (plugin MCPs at /mcp?extension=<id>): picks the server for the request's query,
   * or answers with an HTTP error ({status: 400 | 404, error}).
   */
  resolve?(query: URLSearchParams): Promise<McpServerDef | { status: number; error: string }> | McpServerDef | { status: number; error: string };
}

export const text = (t: string): McpResult => ({ content: [{ type: 'text', text: t }] });
export const errorResult = (t: string): McpResult => ({ content: [{ type: 'text', text: t }], isError: true });
export const jsonResult = (o: unknown): McpResult => text(JSON.stringify(o, null, 2));

/** JSON-Schema helpers matching the app's tool definitions. */
export const S = {
  prop: (type: string, description: string, enumValues?: string[]) => ({ type, description, ...(enumValues ? { enum: enumValues } : {}) }),
  strings: (description: string) => ({ type: 'array', description, items: { type: 'string' } }),
  tool: (name: string, description: string, required: string[], props: Record<string, unknown>): McpTool => ({
    name,
    description,
    inputSchema: { type: 'object', properties: props, ...(required.length ? { required } : {}) },
  }),
};

export interface McpHostOptions {
  port: number;
  deviceId: string;
  log: Logger;
}

export class McpHost {
  private servers = new Map<string, McpServerDef>();
  private server: http.Server | null = null;
  /** The port this window serves on (null = another window serves it, or not started). */
  boundPort: number | null = null;

  constructor(private opts: McpHostOptions) {}

  register(def: McpServerDef) {
    this.servers.set(def.path, def);
  }

  get deviceId() {
    return this.opts.deviceId;
  }

  get port() {
    return this.opts.port;
  }

  /** Whether a path is served (registered here; when another window owns the port it runs the same build). */
  serves(p: string): boolean {
    return this.servers.has(p);
  }

  /** URL agents connect to for a server path. */
  url(p: string) {
    return `http://127.0.0.1:${this.opts.port}${p}`;
  }

  /** Header every agent must send. */
  headers() {
    return { 'X-Device-Id': this.opts.deviceId };
  }

  /**
   * Starts listening. Resolves false when the port is already used (another VS Code window serves it — its servers
   * answer for everyone).
   */
  start(): Promise<boolean> {
    if (this.server) return Promise.resolve(this.boundPort != null);
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => void this.handle(req, res));
      let listening = false;
      srv.on('error', (e: NodeJS.ErrnoException) => {
        if (listening) {
          this.opts.log(`[mcp] server error: ${e.message}`);
          return;
        }
        this.server = null;
        if (e.code === 'EADDRINUSE') this.opts.log(`[mcp] port ${this.opts.port} is in use (another window serves the built-in MCPs)`);
        // Windows keeps port ranges for Hyper-V / WSL / Docker (EACCES): never wait forever for a port that is refused
        else this.opts.log(`[mcp] cannot use port ${this.opts.port} (${e.code ?? e.message}): set another one in the antigem.mcpPort setting`);
        resolve(false);
      });
      srv.listen(this.opts.port, '127.0.0.1', () => {
        listening = true;
        this.server = srv;
        this.boundPort = this.opts.port;
        this.opts.log(`[mcp] built-in MCP servers on 127.0.0.1:${this.opts.port} (${[...this.servers.keys()].join(' ')})`);
        resolve(true);
      });
    });
  }

  stop() {
    this.server?.close();
    this.server = null;
    this.boundPort = null;
  }

  private send(res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}) {
    // no CORS headers: agents are not browsers, and web pages must never be able to read these answers
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
    res.end(body);
  }

  private rpcError(id: unknown, code: number, message: string) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const path = (req.url ?? '/').split('?')[0];
    // a browser preflight (a web page trying to call us) is refused; a page cannot add X-Device-Id without one
    if (req.method === 'OPTIONS' || req.headers.origin) return this.send(res, 403, JSON.stringify({ error: 'Forbidden' }));
    if ((req.headers['x-device-id'] as string | undefined) !== this.opts.deviceId) {
      return this.send(res, 401, JSON.stringify({ error: 'Unauthorized: Invalid or missing X-Device-Id header' }));
    }
    if (path === '/api/health') return this.send(res, 200, JSON.stringify({ status: 'ok', port: this.boundPort, servers: [...this.servers.keys()] }));
    let def = this.servers.get(path);
    if (!def) return this.send(res, 404, JSON.stringify({ error: 'Not Found' }));
    if (req.method !== 'POST') return this.send(res, 405, JSON.stringify(this.rpcError(null, -32600, 'Use POST for MCP requests')), { Allow: 'POST, OPTIONS' });
    if (def.resolve) {
      const picked = await def.resolve(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams);
      if ('status' in picked) return this.send(res, picked.status, JSON.stringify({ error: picked.error }));
      def = picked;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    const session = (req.headers['mcp-session-id'] as string | undefined) ?? null;
    const trimmed = body.trim();
    try {
      if (trimmed.startsWith('[')) {
        let batch: unknown[];
        try {
          batch = JSON.parse(trimmed);
        } catch {
          return this.send(res, 200, JSON.stringify(this.rpcError(null, -32700, 'Parse error')));
        }
        const out: unknown[] = [];
        for (const item of batch) {
          if (!item || typeof item !== 'object') {
            out.push(this.rpcError(null, -32600, 'Invalid request'));
            continue;
          }
          if (!('id' in (item as object))) continue;
          out.push(await this.run(def, item as Record<string, unknown>, session));
        }
        return out.length ? this.send(res, 200, JSON.stringify(out)) : this.send(res, 202, '');
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return this.send(res, 200, JSON.stringify(this.rpcError(null, -32700, 'Parse error')));
      }
      if (!('id' in msg)) return this.send(res, 202, '');
      const newSession = def.stateful && msg.method === 'initialize' ? randomUUID() : null;
      const out = await this.run(def, msg, session);
      return this.send(res, 200, JSON.stringify(out), newSession ? { 'Mcp-Session-Id': newSession } : {});
    } catch (e) {
      return this.send(res, 200, JSON.stringify(this.rpcError(null, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`)));
    }
  }

  private async run(def: McpServerDef, msg: Record<string, unknown>, session: string | null) {
    const id = msg.id;
    const method = String(msg.method ?? '');
    try {
      if (method !== 'ping') {
        const notReady = def.notReady?.();
        if (notReady) return this.rpcError(id, -32001, notReady);
      }
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              ...(def.instructions ? { instructions: def.instructions } : {}),
              capabilities: { tools: {} },
              serverInfo: { name: def.name, version: def.version ?? '1.0.0' },
            },
          };
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: await def.tools() } };
        case 'tools/call': {
          const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const name = String(params.name ?? '');
          const tools = await def.tools();
          if (!tools.some((t) => t.name === name) && !def.hiddenTool?.(name)) {
            return this.rpcError(id, -32601, `Tool '${name}' is not available on ${def.name}`);
          }
          const args = { ...(params.arguments ?? {}) };
          if (def.stateful && session) args._mcp_session = session;
          return { jsonrpc: '2.0', id, result: await def.call(name, args) };
        }
        default:
          return this.rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      this.opts.log(`[mcp] ${def.name} ${method} failed: ${e instanceof Error ? e.message : String(e)}`);
      return this.rpcError(id, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
