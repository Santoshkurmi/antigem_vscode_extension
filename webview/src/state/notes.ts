// The Notes screen's data (the app's data/notes/NotesRepository.kt as seen from the view). The host owns the notes and
// sends the whole list (`notes`) after requestNotes and again after every change, also when an agent edits them through
// notes_mcp. Edits here are applied at once (optimistic) and sent as notesAction; a note with changes the host has not
// echoed back yet keeps its local version, so a list that crosses an edit in flight never resets what is being typed.
import { createSignal, untrack } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { NoteView } from '@shared/protocol';
import { host } from '../host';

export type NoteKind = NoteView['kind'];
export type TodoItemView = NoteView['items'][number];
export type NotesActionKind = 'create' | 'update' | 'delete' | 'restore';

/** Every note and to-do list (unsorted; the screen sorts). Items keep their identity by id across updates. */
const [notesStore, setNotesStore] = createStore<NoteView[]>([]);
export const notes = notesStore;

const [loaded, setLoaded] = createSignal(false);
/** True once the host has sent the list at least once. */
export const notesLoaded = loaded;

/** How long a sent change wins over host lists that do not show it yet. */
const WINDOW_MS = 1500;
/** A create (or an undo) may take a little longer to show up in the host's list. */
const CREATE_WINDOW_MS = 5000;

interface Pending {
  /** What the host should end up with; null = deleted here. */
  want: NoteView | null;
  /** When the last message for it went out (0 = nothing sent yet). */
  sentAt: number;
  /** A debounced update that has not been sent yet: the local version always wins meanwhile. */
  timer?: number;
  /** Sent but not seen in a host list yet. A 'create' may come back under an id the host chose. */
  create?: 'create' | 'restore';
  /** For matching a create the host gave another id. */
  createdAt: number;
  kind: NoteKind;
}

const pending = new Map<string, Pending>();
/** Local id → host id, for creates the host stored under its own id (and back). */
const toHost = new Map<string, string>();
const toLocal = new Map<string, string>();
/** The host's last list (host ids). */
let lastHost: NoteView[] | null = null;
/** Ids in the host's previous list: a create's note is one that was not there. */
let prevHostIds = new Set<string>();

// ------------------------------------------------------------------------------------------------ helpers

export function newNoteId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  }
}

export const newTodoItem = (text = ''): TodoItemView => ({ id: newNoteId(), text, done: false });

/** Note.isEmpty: nothing but blanks. */
export const isNoteEmpty = (n: NoteView) => !n.title.trim() && !n.text.trim() && n.items.every((i) => !i.text.trim());

/** Note.doneCount */
export const noteDoneCount = (n: NoteView) => n.items.reduce((c, i) => c + (i.done ? 1 : 0), 0);

function cloneNote(n: NoteView): NoteView {
  return {
    id: String(n.id),
    kind: n.kind === 'todo' ? 'todo' : 'note',
    title: n.title ?? '',
    text: n.text ?? '',
    items: (n.items ?? []).map((i) => ({ id: String(i.id), text: i.text ?? '', done: i.done === true })),
    pinned: n.pinned === true,
    createdAt: Number(n.createdAt) || 0,
    updatedAt: Number(n.updatedAt) || Number(n.createdAt) || 0,
  };
}

function sameContent(a: NoteView, b: NoteView): boolean {
  if (a.kind !== b.kind || a.title !== b.title || a.text !== b.text || a.pinned !== b.pinned) return false;
  if (a.items.length !== b.items.length) return false;
  return a.items.every((x, i) => {
    const y = b.items[i];
    return x.id === y.id && x.text === y.text && x.done === y.done;
  });
}

/** A copy of the note as the view has it now (with edits not sent yet). */
export function getNote(id: string): NoteView | undefined {
  return untrack(() => {
    const n = notesStore.find((x) => x.id === id);
    return n ? cloneNote(n) : undefined;
  });
}

const expired = (p: Pending, ms: number) => p.timer === undefined && Date.now() - p.sentAt > ms;

function post(action: NotesActionKind, note: Partial<NoteView> & { id?: string }) {
  const id = note.id != null ? (toHost.get(note.id) ?? note.id) : undefined;
  host.send({ type: 'notesAction', action, note: { ...note, id } });
}

/** Looks again once a window has passed (a host list that was ignored meanwhile may be the final word). */
function recheckIn(ms: number) {
  window.setTimeout(() => {
    if (lastHost) applyHost(lastHost, false);
    else render();
  }, ms + 50);
}

// ------------------------------------------------------------------------------------------------ merge

/** The view's list: the host's, with local versions in place of notes that have changes on their way. */
function render() {
  const out: NoteView[] = [];
  const seen = new Set<string>();
  for (const raw of lastHost ?? []) {
    const id = toLocal.get(raw.id) ?? raw.id;
    seen.add(id);
    const p = pending.get(id);
    if (!p) out.push({ ...raw, id });
    else if (p.want) out.push(p.want);
    // deleted here: hidden until the host's list agrees
  }
  for (const [id, p] of pending) if (!seen.has(id) && p.want) out.push(p.want);
  setNotesStore(reconcile(out.map(cloneNote), { key: 'id' }));
}

function applyHost(list: NoteView[], fresh: boolean) {
  lastHost = list;
  const now = Date.now();

  if (fresh) {
    // A create the host stored under its own id: the new note of the same kind made about then
    const hostIds = new Set(list.map((n) => n.id));
    const claimed = new Set<string>();
    for (const [lid, p] of pending) {
      if (p.create !== 'create' || toHost.has(lid) || hostIds.has(lid)) continue;
      let best: NoteView | undefined;
      for (const h of list) {
        if (prevHostIds.has(h.id) || toLocal.has(h.id) || pending.has(h.id) || claimed.has(h.id) || h.kind !== p.kind) continue;
        const d = Math.abs(h.createdAt - p.createdAt);
        if (d > 60_000) continue;
        if (!best || d < Math.abs(best.createdAt - p.createdAt)) best = h;
      }
      if (!best) continue;
      claimed.add(best.id);
      toHost.set(lid, best.id);
      toLocal.set(best.id, lid);
      if (p.want === null) {
        // made and dropped again (an untouched new note) before the host answered
        p.create = undefined;
        p.sentAt = now;
        post('delete', { id: lid });
        recheckIn(WINDOW_MS);
      }
    }
    prevHostIds = hostIds;
  }

  const byId = new Map<string, NoteView>();
  for (const raw of list) {
    const id = toLocal.get(raw.id) ?? raw.id;
    byId.set(id, raw);
  }

  for (const [id, p] of [...pending]) {
    const h = byId.get(id);
    if (p.want === null) {
      if (!h) {
        if (!p.create || expired(p, CREATE_WINDOW_MS)) pending.delete(id);
      } else {
        p.create = undefined; // the host has it under this id: the delete sent already covers it
        if (expired(p, WINDOW_MS)) pending.delete(id); // the delete did not happen
      }
      continue;
    }
    if (h) {
      if (p.create) {
        // first time the host shows it: make sure it holds everything (a create drops blank items, typing may be ahead)
        p.create = undefined;
        if (p.timer === undefined && !sameContent(cloneNote(h), p.want)) {
          p.sentAt = now;
          post('update', p.want);
          recheckIn(WINDOW_MS);
          continue;
        }
      }
      if (p.timer !== undefined) continue;
      if (sameContent(cloneNote(h), p.want) || expired(p, WINDOW_MS)) pending.delete(id);
      continue;
    }
    // not in the host's list
    if (p.create) {
      if (expired(p, CREATE_WINDOW_MS)) pending.delete(id);
      continue;
    }
    // deleted elsewhere (e.g. notes_delete)
    if (p.timer !== undefined) clearTimeout(p.timer);
    pending.delete(id);
  }

  render();
}

host.onMessage((m) => {
  if (m.type !== 'notes') return;
  applyHost(Array.isArray(m.notes) ? m.notes.map(cloneNote) : [], true);
  if (!untrack(loaded)) setLoaded(true);
});

// ------------------------------------------------------------------------------------------------ actions

/** Asks the host for the list (it answers with `notes`, and sends it again after every change). */
export function requestNotes() {
  host.send({ type: 'requestNotes' });
}

function sendUpdate(id: string) {
  const p = pending.get(id);
  if (!p || !p.want) return;
  if (p.timer !== undefined) {
    clearTimeout(p.timer);
    p.timer = undefined;
  }
  // the host may store a create under its own id: the first list that shows it sends the latest content
  if (p.create === 'create') return;
  p.sentAt = Date.now();
  post('update', p.want);
  recheckIn(WINDOW_MS);
}

/**
 * Changes a note here at once and sends the whole note to the host: now, or after `debounceMs` without further
 * changes (typing). Bumps updatedAt like NotesRepository.update.
 */
export function editNote(id: string, change: (n: NoteView) => NoteView, debounceMs = 0) {
  const cur = getNote(id);
  if (!cur) return;
  const next = cloneNote({ ...change(cur), id, createdAt: cur.createdAt, updatedAt: Date.now() });
  let p = pending.get(id);
  if (!p || p.want === null) {
    p = { want: next, sentAt: 0, createdAt: cur.createdAt, kind: cur.kind };
    pending.set(id, p);
  } else {
    p.want = next;
  }
  render();
  if (debounceMs > 0) {
    if (p.timer !== undefined) clearTimeout(p.timer);
    const rec = p;
    rec.timer = window.setTimeout(() => {
      if (pending.get(id) !== rec) return;
      rec.timer = undefined;
      sendUpdate(id);
    }, debounceMs);
  } else {
    sendUpdate(id);
  }
}

/** Sends a debounced change of this note now. */
export function flushNote(id: string) {
  if (pending.get(id)?.timer !== undefined) sendUpdate(id);
}

/** Sends every debounced change now. */
export function flushAllNotes() {
  for (const [id, p] of pending) if (p.timer !== undefined) sendUpdate(id);
}

/**
 * create: a new note (missing fields filled in; id = crypto.randomUUID() when not given).
 * update: the note's fields (the whole note incl. items with ids, or just the changed fields) — sent at once.
 * delete: { id }.
 * restore: the deleted note as it was (undo).
 */
export function notesAction(action: NotesActionKind, note: Partial<NoteView> & { id?: string }) {
  const now = Date.now();
  switch (action) {
    case 'create': {
      const n = cloneNote({
        id: note.id ?? newNoteId(),
        kind: note.kind ?? 'note',
        title: note.title ?? '',
        text: note.text ?? '',
        items: note.items ?? [],
        pinned: note.pinned ?? false,
        createdAt: note.createdAt ?? now,
        updatedAt: note.updatedAt ?? note.createdAt ?? now,
      });
      pending.set(n.id, { want: n, sentAt: now, create: 'create', createdAt: n.createdAt, kind: n.kind });
      render();
      post('create', n);
      recheckIn(CREATE_WINDOW_MS);
      return;
    }
    case 'update': {
      if (!note.id) return;
      editNote(note.id, (cur) => ({ ...cur, ...note, items: note.items ?? cur.items }) as NoteView);
      return;
    }
    case 'delete': {
      const id = note.id;
      if (!id) return;
      const old = pending.get(id);
      if (old?.timer !== undefined) clearTimeout(old.timer);
      const cur = getNote(id);
      pending.set(id, {
        want: null,
        sentAt: now,
        // a create the host has not shown yet may still come back under another id: it gets deleted then
        create: old?.create === 'create' && !toHost.has(id) ? 'create' : undefined,
        createdAt: old?.createdAt ?? cur?.createdAt ?? now,
        kind: old?.kind ?? cur?.kind ?? 'note',
      });
      render();
      post('delete', { id });
      recheckIn(WINDOW_MS);
      return;
    }
    case 'restore': {
      if (!note.id) return;
      const old = pending.get(note.id);
      if (old?.timer !== undefined) clearTimeout(old.timer);
      const n = cloneNote({
        id: note.id,
        kind: note.kind ?? 'note',
        title: note.title ?? '',
        text: note.text ?? '',
        items: note.items ?? [],
        pinned: note.pinned ?? false,
        createdAt: note.createdAt ?? now,
        updatedAt: note.updatedAt ?? now,
      });
      pending.set(n.id, { want: n, sentAt: now, create: 'restore', createdAt: n.createdAt, kind: n.kind });
      render();
      post('restore', n);
      recheckIn(CREATE_WINDOW_MS);
      return;
    }
  }
}

// typing that is still debounced goes out before the view is hidden or torn down
window.addEventListener('pagehide', flushAllNotes);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAllNotes();
});
