// Loads the hub's LanguageServerService proto (the Android app's filtered copy) at runtime with protobufjs.
// Messages are plain objects with the proto's snake_case field names (like the app's Wire classes), enums as names,
// int64 as numbers and bytes as base64 strings.
import path from 'node:path';
import fs from 'node:fs';
import protobuf from 'protobufjs';
import { GrpcClient, GrpcError } from './grpc';

const PKG = 'exa.language_server_pb';
const SERVICE = `${PKG}.LanguageServerService`;

let root: protobuf.Root | null = null;

function protoPath(): string {
  // dist/extension.js → dist/proto; dev runs from dist too
  const candidates = [
    path.join(__dirname, 'proto', 'LanguageServerService.proto'),
    path.join(__dirname, '..', 'proto', 'LanguageServerService.proto'),
    path.join(process.cwd(), 'proto', 'LanguageServerService.proto'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('LanguageServerService.proto not found');
}

export function loadRoot(): protobuf.Root {
  if (root) return root;
  const r = new protobuf.Root();
  r.loadSync(protoPath(), { keepCase: true });
  r.resolveAll();
  root = r;
  return r;
}

const toObjectOpts: protobuf.IConversionOptions = {
  enums: String,
  longs: Number,
  bytes: String,
  defaults: false,
  arrays: true,
  objects: true,
};

export function type(name: string): protobuf.Type {
  return loadRoot().lookupType(`${PKG}.${name}`);
}

export function decodeAs<T = any>(typeName: string, buf: Uint8Array): T {
  const t = type(typeName);
  return t.toObject(t.decode(buf), toObjectOpts) as T;
}

export function encodeAs(typeName: string, obj: object): Uint8Array {
  const t = type(typeName);
  const msg = t.fromObject(obj);
  return t.encode(msg).finish();
}

/** Typed-ish RPC helper bound to the hub's LanguageServerService. */
export class HubRpc {
  constructor(private client: GrpcClient) {}

  private method(name: string): protobuf.Method {
    const svc = loadRoot().lookupService(SERVICE);
    const m = svc.methods[name];
    if (!m) throw new GrpcError(12, `unknown hub method ${name}`);
    m.resolve();
    return m;
  }

  async call<T = any>(name: string, req: object, timeoutMs?: number): Promise<T> {
    const m = this.method(name);
    const reqType = m.resolvedRequestType!;
    const resType = m.resolvedResponseType!;
    const bytes = reqType.encode(reqType.fromObject(req)).finish();
    const out = await this.client.unary(`/${SERVICE}/${name}`, bytes, timeoutMs);
    return resType.toObject(resType.decode(out), toObjectOpts) as T;
  }

  /** Unary call with an already-encoded request; returns the raw response bytes. */
  async callRaw(name: string, request: Uint8Array, timeoutMs?: number): Promise<Buffer> {
    this.method(name);
    return this.client.unary(`/${SERVICE}/${name}`, request, timeoutMs);
  }

  /** Server stream delivering raw response bytes. */
  streamRaw(name: string, req: object, onBytes: (buf: Buffer) => void, signal?: AbortSignal): Promise<void> {
    const m = this.method(name);
    const reqType = m.resolvedRequestType!;
    return this.client.serverStream(`/${SERVICE}/${name}`, reqType.encode(reqType.fromObject(req)).finish(), onBytes, signal);
  }

  stream<T = any>(name: string, req: object, onMessage: (msg: T) => void, signal?: AbortSignal): Promise<void> {
    const m = this.method(name);
    const reqType = m.resolvedRequestType!;
    const resType = m.resolvedResponseType!;
    const bytes = reqType.encode(reqType.fromObject(req)).finish();
    return this.client.serverStream(
      `/${SERVICE}/${name}`,
      bytes,
      (buf) => onMessage(resType.toObject(resType.decode(buf), toObjectOpts) as T),
      signal,
    );
  }
}

// ---------------------------------------------------------------- raw field patching
// protobufjs drops proto3 fields the hub sent with an explicit default (false / 0), and the hub uses that presence
// (e.g. its settings migrations). To change a few fields of a stored message without touching anything else, edit
// the original bytes: drop the changed field numbers and append their new encoding.

/** Splits a message into its top-level fields, each with its exact original bytes (tag included). */
export function rawFields(bytes: Uint8Array): { id: number; bytes: Uint8Array; payload: Uint8Array | null }[] {
  const r = protobuf.Reader.create(bytes);
  const out: { id: number; bytes: Uint8Array; payload: Uint8Array | null }[] = [];
  while (r.pos < r.len) {
    const start = r.pos;
    const tag = r.uint32();
    let payload: Uint8Array | null = null;
    if ((tag & 7) === 2) payload = r.bytes();
    else r.skipType(tag & 7);
    out.push({ id: tag >>> 3, bytes: bytes.subarray(start, r.pos), payload });
  }
  return out;
}

/** `original` with the fields named in `patch` replaced (encoded from `patch` with type `typeName`; explicit false kept). */
export function patchMessage(typeName: string, original: Uint8Array, patch: Record<string, unknown>): Uint8Array {
  const t = type(typeName);
  const ids = new Set<number>();
  for (const k of Object.keys(patch)) {
    const f = t.fields[k];
    if (!f) throw new Error(`${typeName} has no field ${k}`);
    ids.add(f.id);
  }
  const kept = rawFields(original).filter((f) => !ids.has(f.id)).map((f) => f.bytes);
  // every patched field is written explicitly, even false / 0 / "" (the hub tells "unset" from "false")
  const w = protobuf.Writer.create();
  for (const [k, v] of Object.entries(patch)) {
    const f = t.fields[k].resolve();
    if (v == null) continue;
    if (f.resolvedType instanceof protobuf.Type) {
      const sub = f.resolvedType;
      for (const item of f.repeated ? (v as object[]) : [v as object]) w.uint32((f.id << 3) | 2).bytes(sub.encode(sub.fromObject(item)).finish());
    } else if (f.resolvedType instanceof protobuf.Enum) {
      const en = f.resolvedType;
      for (const item of f.repeated ? (v as unknown[]) : [v]) w.uint32(f.id << 3).int32(typeof item === 'number' ? item : (en.values[String(item)] ?? 0));
    } else {
      const wire = (protobuf.types.basic as Record<string, number>)[f.type];
      const write = (w as unknown as Record<string, (x: unknown) => protobuf.Writer>)[f.type].bind(w);
      for (const item of f.repeated ? (v as unknown[]) : [v]) {
        w.uint32((f.id << 3) | wire);
        write(item);
      }
    }
  }
  const fresh = w.finish();
  const total = kept.reduce((n, b) => n + b.length, 0) + fresh.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of kept) {
    out.set(b, o);
    o += b.length;
  }
  out.set(fresh, o);
  return out;
}

/** Wraps `payload` as field `id` (length-delimited). */
export function lengthDelimited(id: number, payload: Uint8Array): Uint8Array {
  const w = protobuf.Writer.create();
  w.uint32((id << 3) | 2).bytes(payload);
  return w.finish();
}
