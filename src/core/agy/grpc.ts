// Minimal native gRPC client (binary protobuf over HTTP/2 cleartext), the same wire protocol the Android app's
// Wire client speaks to the agy hub. Unary + server-streaming only, which is all the hub chat API needs.
import http2 from 'node:http2';

export class GrpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'GrpcError';
  }
  /** UNAUTHENTICATED / PERMISSION_DENIED: the hub's csrf token is stale. */
  get isAuth(): boolean {
    return this.code === 16 || this.code === 7;
  }
}

export interface GrpcClientOptions {
  baseUrl: string;
  /** Extra metadata per call (the csrf header). */
  headers: () => Record<string, string>;
}

function frame(payload: Uint8Array): Buffer {
  const out = Buffer.alloc(5 + payload.length);
  out.writeUInt8(0, 0);
  out.writeUInt32BE(payload.length, 1);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, 5);
  return out;
}

/** Splits a byte stream into gRPC length-prefixed messages. */
class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer, onMessage: (msg: Buffer) => void) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 5) {
      const compressed = this.buf.readUInt8(0);
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      const msg = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      if (compressed) throw new GrpcError(12, 'compressed gRPC messages are not supported');
      onMessage(Buffer.from(msg));
    }
  }
}

function statusFrom(headers: http2.IncomingHttpHeaders): { code: number; message: string } | null {
  const raw = headers['grpc-status'];
  if (raw === undefined) return null;
  const code = Number(Array.isArray(raw) ? raw[0] : raw);
  let message = String(headers['grpc-message'] ?? '');
  try {
    message = decodeURIComponent(message);
  } catch {
    /* keep raw */
  }
  return { code, message };
}

export class GrpcClient {
  private session: http2.ClientHttp2Session | null = null;

  constructor(private opts: GrpcClientOptions) {}

  setBaseUrl(url: string) {
    if (url === this.opts.baseUrl) return;
    this.opts.baseUrl = url;
    this.close();
  }

  close() {
    this.session?.close();
    this.session = null;
  }

  private getSession(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const s = http2.connect(this.opts.baseUrl);
    s.on('error', () => {
      /* surfaced per stream */
    });
    s.on('close', () => {
      if (this.session === s) this.session = null;
    });
    s.on('goaway', () => {
      if (this.session === s) this.session = null;
    });
    this.session = s;
    return s;
  }

  private open(path: string, signal?: AbortSignal): http2.ClientHttp2Stream {
    const session = this.getSession();
    const req = session.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      te: 'trailers',
      ...this.opts.headers(),
    });
    if (signal) {
      if (signal.aborted) req.close(http2.constants.NGHTTP2_CANCEL);
      else signal.addEventListener('abort', () => req.close(http2.constants.NGHTTP2_CANCEL), { once: true });
    }
    return req;
  }

  /** Unary call: request bytes in, response bytes out. */
  unary(path: string, request: Uint8Array, timeoutMs = 60_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let req: http2.ClientHttp2Stream;
      try {
        req = this.open(path, ac.signal);
      } catch (e) {
        clearTimeout(timer);
        reject(e);
        return;
      }
      const reader = new FrameReader();
      const messages: Buffer[] = [];
      let status: { code: number; message: string } | null = null;
      let httpStatus = 0;
      req.on('response', (h) => {
        httpStatus = Number(h[':status'] ?? 0);
        status = statusFrom(h); // trailers-only response
      });
      req.on('trailers', (t) => {
        status = statusFrom(t) ?? status;
      });
      req.on('data', (chunk: Buffer) => {
        try {
          reader.push(chunk, (m) => messages.push(m));
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', (e) => {
        clearTimeout(timer);
        reject(ac.signal.aborted ? new GrpcError(4, `deadline exceeded: ${path}`) : e);
      });
      req.on('close', () => {
        clearTimeout(timer);
        if (ac.signal.aborted) return reject(new GrpcError(4, `deadline exceeded: ${path}`));
        if (!status) return reject(new GrpcError(14, `no grpc-status (HTTP ${httpStatus}) for ${path}`));
        if (status.code !== 0) return reject(new GrpcError(status.code, status.message || `gRPC error ${status.code}`));
        resolve(messages[0] ?? Buffer.alloc(0));
      });
      req.end(frame(request));
    });
  }

  /**
   * Server-streaming call. Resolves when the server ends the stream cleanly; rejects with GrpcError otherwise.
   * Abort `signal` to cancel (resolves quietly).
   */
  serverStream(path: string, request: Uint8Array, onMessage: (msg: Buffer) => void, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let req: http2.ClientHttp2Stream;
      try {
        req = this.open(path, signal);
      } catch (e) {
        reject(e);
        return;
      }
      const reader = new FrameReader();
      let status: { code: number; message: string } | null = null;
      let httpStatus = 0;
      req.on('response', (h) => {
        httpStatus = Number(h[':status'] ?? 0);
        status = statusFrom(h);
      });
      req.on('trailers', (t) => {
        status = statusFrom(t) ?? status;
      });
      req.on('data', (chunk: Buffer) => {
        try {
          reader.push(chunk, onMessage);
        } catch (e) {
          req.close(http2.constants.NGHTTP2_CANCEL);
          reject(e);
        }
      });
      req.on('error', (e) => {
        if (signal?.aborted) resolve();
        else reject(e);
      });
      req.on('close', () => {
        if (signal?.aborted) return resolve();
        if (!status) return reject(new GrpcError(14, `stream closed without grpc-status (HTTP ${httpStatus}) for ${path}`));
        if (status.code !== 0) return reject(new GrpcError(status.code, status.message || `gRPC error ${status.code}`));
        resolve();
      });
      req.end(frame(request));
    });
  }
}
