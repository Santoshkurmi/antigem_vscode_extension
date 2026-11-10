// notes_mcp + the notes store: port of the app's data/notes/NotesRepository.kt and NotesMcp.kt (same JSON file format,
// same tools and messages). Stored in ~/.antigem/notes/notes.json; the Notes screen and the MCP share it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { S, errorResult, text, type McpResult, type McpServerDef, type McpTool } from './server';

export type NoteKind = 'note' | 'todo';
export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}
export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  text: string;
  items: TodoItem[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

const newId = () => randomUUID().replace(/-/g, '').slice(0, 12);
const kindOf = (v: unknown): NoteKind | null => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'note' || s === 'todo' ? s : null;
};

/** Notes and to-do lists, saved 400 ms after each change (tmp file + rename), like the app. */
export class NotesStore {
  private notes: Note[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(notes: Note[]) => void>();
  readonly file: string;

  constructor(file = path.join(os.homedir(), '.antigem', 'notes', 'notes.json')) {
    this.file = file;
    try {
      if (fs.existsSync(file)) this.notes = NotesStore.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.notes = [];
    }
  }

  onChange(l: (notes: Note[]) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  all(): Note[] {
    return this.notes;
  }

  get(id: string): Note | undefined {
    return this.notes.find((n) => n.id === id);
  }

  create(kind: NoteKind, title = '', body = '', items: string[] = [], pinned = false): Note {
    const now = Date.now();
    const note: Note = {
      id: newId(),
      kind,
      title,
      text: body,
      items: items.filter((t) => t.trim()).map((t) => ({ id: newId(), text: t.trim(), done: false })),
      pinned,
      createdAt: now,
      updatedAt: now,
    };
    this.mutate((list) => [...list, note]);
    return note;
  }

  /** Applies change and bumps updatedAt; null when there is no such note. */
  update(id: string, change: (n: Note) => Note): Note | null {
    let result: Note | null = null;
    this.mutate((list) =>
      list.map((n) => {
        if (n.id !== id) return n;
        result = { ...change(n), id: n.id, createdAt: n.createdAt, updatedAt: Date.now() };
        return result;
      }),
    );
    return result;
  }

  delete(id: string): Note | null {
    const removed = this.get(id) ?? null;
    if (removed) this.mutate((list) => list.filter((n) => n.id !== id));
    return removed;
  }

  /** Puts back a deleted note as it was (undo). */
  restore(note: Note) {
    this.mutate((list) => (list.some((n) => n.id === note.id) ? list : [...list, note]));
  }

  private mutate(block: (list: Note[]) => Note[]) {
    this.notes = block(this.notes);
    for (const l of this.listeners) l(this.notes);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, notes: this.notes.map((n) => NotesStore.toJson(n)) }));
      fs.renameSync(tmp, this.file);
    } catch {
      /* next change retries */
    }
  }

  static toJson(n: Note, includeBody = true): Record<string, unknown> {
    const o: Record<string, unknown> = { id: n.id, kind: n.kind, title: n.title };
    if (includeBody) o.text = n.text;
    if (n.kind === 'todo' || n.items.length) {
      if (includeBody) o.items = n.items.map((it, index) => ({ id: it.id, index, text: it.text, done: it.done }));
      o.items_total = n.items.length;
      o.items_done = n.items.filter((i) => i.done).length;
    }
    o.pinned = n.pinned;
    o.created_at = n.createdAt;
    o.updated_at = n.updatedAt;
    return o;
  }

  static parse(raw: string): Note[] {
    const arr = (JSON.parse(raw)?.notes ?? []) as Record<string, unknown>[];
    return arr
      .filter((o) => o && typeof o === 'object')
      .map((o) => {
        const created = Number(o.created_at ?? Date.now());
        return {
          id: String(o.id || newId()),
          kind: kindOf(o.kind) ?? 'note',
          title: String(o.title ?? ''),
          text: String(o.text ?? ''),
          items: ((o.items as Record<string, unknown>[] | undefined) ?? []).map((t) => ({ id: String(t.id || newId()), text: String(t.text ?? ''), done: t.done === true })),
          pinned: o.pinned === true,
          createdAt: created,
          updatedAt: Number(o.updated_at ?? created),
        };
      });
  }
}

const INSTRUCTIONS =
  "Reads and edits the user's Notes screen: plain notes (title + text) and to-do lists (title + checkable items). " +
  'Use notes_list to find things (filter by kind, search, sort by created/updated, page with limit/offset), notes_get to read one in full ' +
  '(or latest=true for the most recently created), then notes_create / notes_update / notes_delete. For to-do items use ' +
  'notes_todo_add_items, notes_todo_set_item (check, uncheck or rename by item_id or index) and notes_todo_remove_item. ' +
  'These are the user\'s own notes: ask before deleting anything you did not create.';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const PREVIEW_CHARS = 160;

const noteId = { id: S.prop('string', 'Note id from notes_list or notes_create') };
const itemId = { item_id: S.prop('string', 'To-do item id (from notes_get)') };
const itemIndex = { index: S.prop('integer', '0-based position of the to-do item, when no item_id') };

function tools(): McpTool[] {
  return [
    S.tool(
      'notes_list',
      'List notes and to-do lists, newest change first by default. Returns total count, paging info (has_more, next_offset) and for each ' +
        'entry its id, kind, title, a short text preview, to-do progress, pinned flag and created/updated times. Pinned ones are not moved ' +
        'to the top here; filter with pinned_only. For the most recently created use sort=created_desc with limit=1.',
      [],
      {
        kind: S.prop('string', 'Only this kind (default all)', ['all', 'note', 'todo']),
        query: S.prop('string', 'Case-insensitive search in titles, text and to-do items'),
        pinned_only: S.prop('boolean', 'Only pinned entries'),
        status: S.prop('string', 'For to-do lists: open = has unchecked items, completed = every item checked (default any)', ['any', 'open', 'completed']),
        sort: S.prop('string', 'Order (default updated_desc)', ['updated_desc', 'updated_asc', 'created_desc', 'created_asc', 'title_asc', 'title_desc']),
        limit: S.prop('integer', `Entries per page, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT})`),
        offset: S.prop('integer', 'Entries to skip (default 0)'),
        page: S.prop('integer', '1-based page number, instead of offset'),
        include_body: S.prop('boolean', 'Include full text and all to-do items instead of a preview (default false)'),
      },
    ),
    S.tool('notes_get', 'Read one note or to-do list in full: title, text, every to-do item with its id, index and done state, and times.', [], {
      ...noteId,
      latest: S.prop('boolean', 'Instead of id: return the most recently created entry'),
      kind: S.prop('string', 'With latest: only consider this kind', ['note', 'todo']),
    }),
    S.tool('notes_create', 'Create a note (title + text) or a to-do list (title + items, text optional). Returns the created entry with its id.', [], {
      kind: S.prop('string', 'note or todo (default note; todo when items are given)', ['note', 'todo']),
      title: S.prop('string', 'Title'),
      text: S.prop('string', 'Body text'),
      items: S.strings('To-do items, unchecked'),
      pinned: S.prop('boolean', 'Pin it to the top of the Notes screen'),
    }),
    S.tool(
      'notes_update',
      'Change a note or to-do list. Only the fields you pass change. Passing items replaces the whole to-do list (to edit single items use the notes_todo_ tools).',
      ['id'],
      {
        ...noteId,
        title: S.prop('string', 'New title'),
        text: S.prop('string', 'New body text (replaces it, unless append_text is true)'),
        append_text: S.prop('boolean', 'Add text to the end of the existing body (on a new line) instead of replacing it'),
        pinned: S.prop('boolean', 'Pin or unpin'),
        kind: S.prop('string', 'Turn a note into a to-do list or back. Items are kept.', ['note', 'todo']),
        items: S.strings('Replace all to-do items with these (unchecked)'),
      },
    ),
    S.tool('notes_delete', 'Delete a note or to-do list for good.', ['id'], noteId),
    S.tool('notes_todo_add_items', 'Add one or more unchecked items to a to-do list.', ['id', 'items'], {
      ...noteId,
      items: S.strings('Item texts to add'),
      position: S.prop('integer', '0-based position to insert at (default: the end)'),
    }),
    S.tool('notes_todo_set_item', 'Check (done=true), uncheck (done=false) or rename a to-do item, picked by item_id or index.', ['id'], {
      ...noteId,
      ...itemId,
      ...itemIndex,
      done: S.prop('boolean', 'true = checked / done, false = unchecked / open'),
      text: S.prop('string', 'New item text'),
    }),
    S.tool('notes_todo_remove_item', 'Remove one to-do item, picked by item_id or index.', ['id'], { ...noteId, ...itemId, ...itemIndex }),
    S.tool('notes_todo_bulk', 'Act on every item of a to-do list at once.', ['id', 'action'], {
      ...noteId,
      action: S.prop('string', 'check_all, uncheck_all, or clear_completed (removes checked items)', ['check_all', 'uncheck_all', 'clear_completed']),
    }),
  ];
}

type Args = Record<string, unknown>;
const has = (a: Args, k: string) => Object.prototype.hasOwnProperty.call(a, k) && a[k] !== undefined && a[k] !== null;
const str = (a: Args, k: string) => (has(a, k) ? String(a[k]) : '');
const bool = (a: Args, k: string) => a[k] === true || a[k] === 'true';
const int = (a: Args, k: string, d: number) => {
  const n = Number(a[k]);
  return has(a, k) && Number.isFinite(n) ? Math.trunc(n) : d;
};

function stringList(a: Args, k: string): string[] {
  const v = a[k];
  const raw = Array.isArray(v)
    ? v.map((x) => (x && typeof x === 'object' ? String((x as { text?: unknown }).text ?? '') : String(x ?? '')))
    : String(v ?? '').split('\n');
  return raw.map((s) => s.trim()).filter(Boolean);
}

function iso(ms: number): string {
  const d = new Date(ms);
  const tz = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  const local = new Date(ms + tz * 60_000).toISOString().slice(0, 19);
  return `${local}${tz >= 0 ? '+' : '-'}${pad(tz / 60)}:${pad(tz % 60)}`;
}

const withTimes = (o: Record<string, unknown>, n: Note) => ({ ...o, created: iso(n.createdAt), updated: iso(n.updatedAt) });

function preview(n: Note): string {
  const raw = n.kind === 'todo' && n.items.length ? n.items.slice(0, 5).map((i) => `${i.done ? '[x] ' : '[ ] '}${i.text}`).join('; ') : n.text;
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

const matches = (n: Note, q: string) =>
  n.title.toLowerCase().includes(q) || n.text.toLowerCase().includes(q) || n.items.some((i) => i.text.toLowerCase().includes(q));

export function notesMcp(store: NotesStore): McpServerDef {
  const entry = (n: Note, headline?: string): McpResult => {
    const body = JSON.stringify(withTimes(NotesStore.toJson(n), n), null, 2);
    return text(headline ? `${headline}\n${body}` : body);
  };
  const notFound = (id: string) => errorResult(id ? `No note or to-do list with id ${id}. Find ids with notes_list.` : 'Pass id.');
  const itemIndexOf = (n: Note, a: Args): number | null => {
    const iid = str(a, 'item_id');
    if (iid) {
      const i = n.items.findIndex((x) => x.id === iid);
      return i >= 0 ? i : null;
    }
    if (has(a, 'index')) {
      const i = int(a, 'index', -1);
      return i >= 0 && i < n.items.length ? i : null;
    }
    return null;
  };
  const itemNotFound = (n: Note, a: Args) =>
    !str(a, 'item_id') && !has(a, 'index')
      ? errorResult('Pass item_id or index.')
      : errorResult(`No such item in ${n.id} (it has ${n.items.length} item(s), indexes 0-${Math.max(0, n.items.length - 1)}). Read it with notes_get.`);

  const handlers: Record<string, (a: Args) => McpResult> = {
    notes_list(a) {
      const kind = kindOf(a.kind);
      const q = str(a, 'query').trim().toLowerCase();
      const status = (str(a, 'status') || 'any').toLowerCase();
      const limit = Math.min(MAX_LIMIT, Math.max(1, int(a, 'limit', DEFAULT_LIMIT)));
      const offset = has(a, 'page') ? (Math.max(1, int(a, 'page', 1)) - 1) * limit : Math.max(0, int(a, 'offset', 0));
      const includeBody = bool(a, 'include_body');
      const filtered = store
        .all()
        .filter((n) => !kind || n.kind === kind)
        .filter((n) => !bool(a, 'pinned_only') || n.pinned)
        .filter((n) =>
          status === 'open'
            ? n.kind === 'todo' && n.items.some((i) => !i.done)
            : status === 'completed'
              ? n.kind === 'todo' && n.items.length > 0 && n.items.every((i) => i.done)
              : true,
        )
        .filter((n) => !q || matches(n, q));
      const by = {
        updated_asc: (x: Note, y: Note) => x.updatedAt - y.updatedAt,
        created_desc: (x: Note, y: Note) => y.createdAt - x.createdAt,
        created_asc: (x: Note, y: Note) => x.createdAt - y.createdAt,
        title_asc: (x: Note, y: Note) => x.title.toLowerCase().localeCompare(y.title.toLowerCase()),
        title_desc: (x: Note, y: Note) => y.title.toLowerCase().localeCompare(x.title.toLowerCase()),
        updated_desc: (x: Note, y: Note) => y.updatedAt - x.updatedAt,
      } as Record<string, (x: Note, y: Note) => number>;
      const sorted = [...filtered].sort(by[(str(a, 'sort') || 'updated_desc').toLowerCase()] ?? by.updated_desc);
      const page = sorted.slice(offset, offset + limit);
      const hasMore = offset + page.length < sorted.length;
      return text(
        JSON.stringify(
          {
            total: sorted.length,
            offset,
            limit,
            page: Math.floor(offset / limit) + 1,
            pages: sorted.length ? Math.ceil(sorted.length / limit) : 0,
            has_more: hasMore,
            ...(hasMore ? { next_offset: offset + page.length } : {}),
            notes: page.map((n) => ({ ...withTimes(NotesStore.toJson(n, includeBody), n), ...(includeBody ? {} : { preview: preview(n) }) })),
          },
          null,
          2,
        ),
      );
    },
    notes_get(a) {
      if (bool(a, 'latest') && !str(a, 'id')) {
        const kind = kindOf(a.kind);
        const note = store
          .all()
          .filter((n) => !kind || n.kind === kind)
          .reduce<Note | null>((m, n) => (!m || n.createdAt > m.createdAt ? n : m), null);
        if (!note) return text(`There are no ${kind ? (kind === 'todo' ? 'to-do lists' : 'notes') : 'notes or to-do lists'} yet.`);
        return entry(note);
      }
      const id = str(a, 'id');
      if (!id) return errorResult('Pass id, or latest=true.');
      const n = store.get(id);
      return n ? entry(n) : notFound(id);
    },
    notes_create(a) {
      const items = stringList(a, 'items');
      const kind = kindOf(a.kind) ?? (items.length ? 'todo' : 'note');
      const title = str(a, 'title').trim();
      const body = str(a, 'text');
      if (!title && !body.trim() && !items.length) return errorResult('Give at least a title, text or items.');
      const n = store.create(kind, title, body, items, bool(a, 'pinned'));
      return entry(n, `Created ${n.kind} ${n.id}.`);
    },
    notes_update(a) {
      const id = str(a, 'id');
      if (!store.get(id)) return notFound(id);
      let newKind: NoteKind | null = null;
      if (has(a, 'kind')) {
        newKind = kindOf(a.kind);
        if (!newKind) return errorResult('kind must be note or todo');
      }
      const newItems = has(a, 'items') ? stringList(a, 'items').map((t) => ({ id: newId(), text: t, done: false })) : null;
      const updated = store.update(id, (n) => ({
        ...n,
        title: has(a, 'title') ? str(a, 'title').trim() : n.title,
        text: !has(a, 'text') ? n.text : bool(a, 'append_text') && n.text.trim() ? `${n.text.trimEnd()}\n${str(a, 'text')}` : str(a, 'text'),
        pinned: has(a, 'pinned') ? bool(a, 'pinned') : n.pinned,
        kind: newKind ?? n.kind,
        items: newItems ?? n.items,
      }));
      return updated ? entry(updated, `Updated ${updated.kind} ${id}.`) : notFound(id);
    },
    notes_delete(a) {
      const id = str(a, 'id');
      const removed = store.delete(id);
      return removed ? text(`Deleted ${removed.kind} ${id} ("${removed.title.trim() || 'Untitled'}").`) : notFound(id);
    },
    notes_todo_add_items(a) {
      const id = str(a, 'id');
      const note = store.get(id);
      if (!note) return notFound(id);
      if (note.kind !== 'todo') return errorResult(`${id} is a note, not a to-do list. Turn it into one with notes_update kind=todo first.`);
      const texts = stringList(a, 'items');
      if (!texts.length) return errorResult('items is empty.');
      const updated = store.update(id, (n) => {
        const pos = has(a, 'position') ? Math.min(n.items.length, Math.max(0, int(a, 'position', n.items.length))) : n.items.length;
        const items = [...n.items];
        items.splice(pos, 0, ...texts.map((t) => ({ id: newId(), text: t, done: false })));
        return { ...n, items };
      });
      return updated ? entry(updated, `Added ${texts.length} item(s).`) : notFound(id);
    },
    notes_todo_set_item(a) {
      const id = str(a, 'id');
      const note = store.get(id);
      if (!note) return notFound(id);
      const index = itemIndexOf(note, a);
      if (index == null) return itemNotFound(note, a);
      if (!has(a, 'done') && !has(a, 'text')) return errorResult('Pass done and/or text.');
      const updated = store.update(id, (n) => ({
        ...n,
        items: n.items.map((it, i) => (i !== index ? it : { ...it, done: has(a, 'done') ? bool(a, 'done') : it.done, text: has(a, 'text') ? str(a, 'text').trim() : it.text })),
      }));
      if (!updated) return notFound(id);
      const item = updated.items[index];
      return entry(updated, `Item ${index} (${item.id}) is now ${item.done ? 'checked' : 'unchecked'}: "${item.text}".`);
    },
    notes_todo_remove_item(a) {
      const id = str(a, 'id');
      const note = store.get(id);
      if (!note) return notFound(id);
      const index = itemIndexOf(note, a);
      if (index == null) return itemNotFound(note, a);
      const removed = note.items[index];
      const updated = store.update(id, (n) => ({ ...n, items: n.items.filter((i) => i.id !== removed.id) }));
      return updated ? entry(updated, `Removed item "${removed.text}".`) : notFound(id);
    },
    notes_todo_bulk(a) {
      const id = str(a, 'id');
      if (!store.get(id)) return notFound(id);
      const action = str(a, 'action');
      if (!['check_all', 'uncheck_all', 'clear_completed'].includes(action)) return errorResult('action must be check_all, uncheck_all or clear_completed');
      const updated = store.update(id, (n) =>
        action === 'check_all'
          ? { ...n, items: n.items.map((i) => ({ ...i, done: true })) }
          : action === 'uncheck_all'
            ? { ...n, items: n.items.map((i) => ({ ...i, done: false })) }
            : { ...n, items: n.items.filter((i) => !i.done) },
      );
      return updated ? entry(updated, `Done: ${action}.`) : notFound(id);
    },
  };

  return {
    path: '/notes',
    name: 'notes_mcp',
    instructions: INSTRUCTIONS,
    tools,
    call(name, args) {
      const h = handlers[name];
      if (!h) return errorResult(`Unknown tool ${name}`);
      try {
        return h(args);
      } catch (e) {
        return errorResult(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
