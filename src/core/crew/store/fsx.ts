// File helpers of the Crew store: every write is a temp file + rename (a reader never sees half a file, two windows
// never interleave), JSON reads are cached by mtime, journals are append-only NDJSON.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function writeAtomic(file: string, data: string | Buffer, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export function writeJson(file: string, value: unknown, mode = 0o644) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
  cache.delete(file);
}

const cache = new Map<string, { mtime: number; size: number; value: unknown }>();

/** The parsed file (cached until it changes on disk), or null when it is missing or not JSON. */
export function readJson<T>(file: string): T | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return structuredClone(hit.value) as T;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache.set(file, { mtime: st.mtimeMs, size: st.size, value });
    return structuredClone(value) as T;
  } catch {
    return null;
  }
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function appendLine(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

/** The NDJSON file's records (bad lines, e.g. a half-written last one, are skipped). */
export function readLines<T>(file: string): T[] {
  const text = readText(file);
  if (!text) return [];
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skipped */
    }
  }
  return out;
}

export function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
