// The Notes screen: port of ui/notes/NotesScreen.kt. Notes and to-do lists, pinned first, filter chips and search; the
// editor for a note (title + text) and for a to-do list (title + checkable items); delete with an Undo snackbar.
// Like the app's persistent screen it is shown / hidden at once (graphicsLayer alpha 1 / 0, no animation) and stays
// alive while hidden, so the open note survives switching back to the chat. Sizes: 1dp = 1px, text in sp (notes.css).
import { type Accessor, createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, type Setter, Show } from 'solid-js';
import type { NoteView } from '@shared/protocol';
import {
  editNote,
  flushNote,
  getNote,
  isNoteEmpty,
  newNoteId,
  newTodoItem,
  noteDoneCount,
  notes,
  notesAction,
  notesLoaded,
  requestNotes,
  type NoteKind,
  type TodoItemView,
} from '../state/notes';
import { DropdownMenu, Icon, nextFrame, type IconName } from '../ui/primitives';
import { allThemes, currentTheme } from '../theme';
import { hex, resolveTheme } from '../themes';

export const [notesOpen, setNotesOpen] = createSignal(false);

/** Typing goes to the host this long after the last key. */
const TYPING_DEBOUNCE_MS = 400;

// Material icons the app uses that ui/iconData.ts does not have (outlined set, @material-design-icons/svg).
const PUSH_PIN =
  'M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z';
const CHECK_BOX =
  'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM17.99 9l-1.41-1.42-6.59 6.59-2.58-2.57-1.42 1.41 4 3.99z';
const DONE_ALL =
  'm18 7-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41 6 19l1.41-1.41L1.83 12 .41 13.41z';
const CLEAR_ALL = 'M5 13h14v-2H5v2zm-2 4h14v-2H3v2zM7 7v2h14V7H7z';

// ------------------------------------------------------------------------------------------------ screen

export function NotesScreen() {
  const [everOpened, setEverOpened] = createSignal(false);
  const [openId, setOpenId] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const bar = createSnackbar();
  let root: HTMLDivElement | undefined;

  // Material slots the stylesheet has no token for: FilterChip's selected colors, the Snackbar action
  const m3Vars = createMemo<JSX.CSSProperties>(() => {
    const m = resolveTheme(currentTheme(), allThemes());
    return {
      '--nt-secondary-container': hex(m.secondary_container),
      '--nt-on-secondary-container': hex(m.on_secondary_container),
      '--nt-inverse-primary': hex(m.inverse_primary),
    };
  });

  createEffect(
    on(notesOpen, (open) => {
      if (open) {
        setEverOpened(true);
        setNow(Date.now());
        requestNotes();
        // keys typed now belong to this screen, not to the chat input under it
        setTimeout(() => {
          if (notesOpen() && root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
        }, 0);
      } else {
        // LaunchedEffect(isVisible) { if (!isVisible) focusManager.clearFocus() }
        const a = document.activeElement as HTMLElement | null;
        if (a && root?.contains(a)) a.blur();
      }
    }),
  );

  // relative times ("5 min. ago") stay current while the screen shows
  createEffect(() => {
    if (!notesOpen()) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(t));
  });

  const openNote = createMemo(() => {
    const id = openId();
    return id ? notes.find((n) => n.id === id) : undefined;
  });
  // deleted elsewhere, e.g. notes_delete
  createEffect(() => {
    if (openId() && !openNote()) setOpenId(null);
  });

  const clearFocus = () => {
    const a = document.activeElement as HTMLElement | null;
    if (a && root?.contains(a) && a !== root) {
      a.blur();
      root?.focus({ preventScroll: true });
    }
  };

  const deleteWithUndo = (id: string) => {
    const note = getNote(id);
    if (!note) return;
    notesAction('delete', { id });
    if (isNoteEmpty(note)) return;
    bar.show(note.kind === 'todo' ? 'To-do list deleted' : 'Note deleted', 'Undo', () => notesAction('restore', note));
  };

  // A new note left untouched is dropped, and blank to-do rows are tidied away
  const closeEditor = () => {
    clearFocus();
    const id = openId();
    if (id) {
      const n = getNote(id);
      if (n) {
        if (isNoteEmpty(n)) notesAction('delete', { id });
        else if (n.items.some((i) => !i.text.trim())) editNote(id, (c) => ({ ...c, items: c.items.filter((i) => i.text.trim()) }));
        else flushNote(id);
      }
    }
    setOpenId(null);
  };

  const openNew = (kind: NoteKind) => {
    const t = Date.now();
    const note: NoteView = {
      id: newNoteId(),
      kind,
      title: '',
      text: '',
      items: kind === 'todo' ? [newTodoItem()] : [],
      pinned: false,
      createdAt: t,
      updatedAt: t,
    };
    notesAction('create', note);
    setOpenId(note.id);
  };

  // Back: the editor closes (BackHandler), the list leaves the screen (MainActivity's BackHandler)
  const back = () => {
    if (openId()) closeEditor();
    else setNotesOpen(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
    // a menu, dialog, sheet or the settings page over this screen handles its own Escape
    if (document.querySelector('.dialog-scrim, .sheet-scrim, .menu, .settings.shown')) return;
    e.preventDefault();
    e.stopPropagation();
    back();
  };
  createEffect(() => {
    if (!notesOpen()) return;
    document.addEventListener('keydown', onKey, true);
    onCleanup(() => document.removeEventListener('keydown', onKey, true));
  });

  return (
    <div
      ref={root}
      class="nt-screen"
      classList={{ shown: notesOpen() }}
      style={m3Vars()}
      tabIndex={-1}
      aria-hidden={notesOpen() ? undefined : 'true'}
      onClick={(e) => e.stopPropagation()}
    >
      <Show when={everOpened()}>
        <Show when={openNote()} keyed fallback={<NotesList now={now} onOpen={(id) => setOpenId(id)} onNew={openNew} />}>
          {(note) => (
            <NoteEditor
              note={note}
              now={now}
              onBack={closeEditor}
              onDelete={() => {
                const id = note.id;
                clearFocus();
                setOpenId(null);
                deleteWithUndo(id);
              }}
            />
          )}
        </Show>
        <SnackbarHost bar={bar} />
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ list

type Filter = 'ALL' | 'NOTES' | 'TODOS';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'ALL', label: 'All' },
  { id: 'NOTES', label: 'Notes' },
  { id: 'TODOS', label: 'To-dos' },
];

function NotesList(props: { now: Accessor<number>; onOpen: (id: string) => void; onNew: (kind: NoteKind) => void }) {
  const [filter, setFilter] = createSignal<Filter>('ALL');
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [newMenu, setNewMenu] = createSignal(false);
  let fab: HTMLButtonElement | undefined;
  createEffect(() => {
    if (!notesOpen()) setNewMenu(false);
  });

  const q = createMemo(() => query().trim().toLowerCase());
  const shown = createMemo(() => {
    const f = filter();
    const s = q();
    return notes
      .filter((n) => (f === 'ALL' ? true : f === 'NOTES' ? n.kind === 'note' : n.kind === 'todo'))
      .filter(
        (n) =>
          !s ||
          n.title.toLowerCase().includes(s) ||
          n.text.toLowerCase().includes(s) ||
          n.items.some((i) => i.text.toLowerCase().includes(s)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
  const pinned = createMemo(() => shown().filter((n) => n.pinned));
  const others = createMemo(() => shown().filter((n) => !n.pinned));
  const count = (f: Filter) =>
    f === 'ALL' ? notes.length : notes.filter((n) => n.kind === (f === 'NOTES' ? 'note' : 'todo')).length;
  const emptyText = () =>
    q()
      ? `Nothing matches "${query()}"`
      : filter() === 'TODOS'
        ? 'No to-do lists yet'
        : filter() === 'NOTES'
          ? 'No notes yet'
          : 'No notes or to-do lists yet';

  return (
    <div class="nt-page">
      <div class="nt-head">
        <div class="nt-bar">
          <NtIconButton
            icon="arrow_back"
            title="Back"
            onClick={() => {
              if (searching()) {
                setSearching(false);
                setQuery('');
              } else setNotesOpen(false);
            }}
          />
          <Show
            when={searching()}
            fallback={
              <>
                <div class="nt-title">Notes</div>
                <NtIconButton icon="search" title="Search" onClick={() => setSearching(true)} />
              </>
            }
          >
            <PlainField class="nt-search" value={query()} placeholder="Search notes" autofocus onInput={(v) => setQuery(v)} />
            <Show when={query().length > 0}>
              <NtIconButton icon="close_o" title="Clear search" onClick={() => setQuery('')} />
            </Show>
          </Show>
        </div>
        <div class="nt-chips">
          <For each={FILTERS}>
            {(f) => (
              <button class="nt-chip" classList={{ on: filter() === f.id }} aria-pressed={filter() === f.id} onClick={() => setFilter(f.id)}>
                <span class="nt-chip-box">{count(f.id) > 0 ? `${f.label} ${count(f.id)}` : f.label}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="nt-body">
        <Show when={notesLoaded()}>
          <Show when={shown().length > 0} fallback={<EmptyState message={emptyText()} />}>
            <div class="nt-list">
              <Show when={pinned().length > 0}>
                <div class="nt-section">PINNED</div>
                <For each={pinned()}>{(n) => <NoteCard note={n} now={props.now} onClick={() => props.onOpen(n.id)} />}</For>
                <Show when={others().length > 0}>
                  <div class="nt-section">OTHERS</div>
                </Show>
              </Show>
              <For each={others()}>{(n) => <NoteCard note={n} now={props.now} onClick={() => props.onOpen(n.id)} />}</For>
            </div>
          </Show>
        </Show>

        <div class="nt-fab-wrap">
          <button ref={fab} class="nt-fab" title="New" aria-label="New" onClick={() => setNewMenu(!newMenu())}>
            <Icon name="add" size={24} />
          </button>
          <DropdownMenu anchor={() => fab} open={newMenu()} onClose={() => setNewMenu(false)} align="end" class="nt-menu">
            <MenuRow
              label="Note"
              icon="edit_note"
              onClick={() => {
                setNewMenu(false);
                props.onNew('note');
              }}
            />
            <MenuRow
              label="To-do list"
              icon="checklist"
              onClick={() => {
                setNewMenu(false);
                props.onNew('todo');
              }}
            />
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

function EmptyState(props: { message: string }) {
  return (
    <div class="nt-empty">
      <Icon name="edit_note" size={56} class="nt-empty-icon" />
      <div class="nt-empty-msg">{props.message}</div>
      <div class="nt-empty-hint">Tap + to add one, or ask an agent with the Notes MCP</div>
    </div>
  );
}

function NoteCard(props: { note: NoteView; now: Accessor<number>; onClick: () => void }) {
  const n = () => props.note;
  const filled = createMemo(() => n().items.filter((i) => i.text.trim()));
  const hidden = () => filled().length - 4;
  const done = () => noteDoneCount(n());
  return (
    <button class="nt-card" onClick={() => props.onClick()}>
      <div class="nt-card-head">
        <Show when={n().kind === 'todo'}>
          <Icon name="checklist" size={16} class="nt-muted nt-card-kind" />
        </Show>
        <div class="nt-card-title" classList={{ blank: !n().title.trim() }}>
          {n().title.trim() ? n().title : 'Untitled'}
        </div>
        <Show when={n().pinned}>
          <Glyph d={PUSH_PIN} size={16} color="var(--primary)" />
        </Show>
      </div>
      <Show
        when={n().kind === 'todo'}
        fallback={
          <Show when={n().text.trim()}>
            <div class="nt-card-text">{n().text.trim()}</div>
          </Show>
        }
      >
        <For each={filled().slice(0, 4)}>
          {(item) => (
            <div class="nt-card-item">
              <Show when={item.done} fallback={<Icon name="check_box_blank" size={16} class="nt-muted" />}>
                <Glyph d={CHECK_BOX} size={16} color="var(--primary)" />
              </Show>
              <div class="nt-card-item-text" classList={{ done: item.done }}>
                {item.text}
              </div>
            </div>
          )}
        </For>
        <Show when={hidden() > 0}>
          <div class="nt-card-more">{`+${hidden()} more`}</div>
        </Show>
      </Show>
      <div class="nt-card-foot">
        <div class="nt-card-time">{noteRelativeTime(n().updatedAt, props.now())}</div>
        <Show when={n().kind === 'todo' && n().items.length > 0}>
          <div class="nt-card-count" classList={{ all: done() === n().items.length }}>
            {`${done()}/${n().items.length} done`}
          </div>
        </Show>
      </div>
    </button>
  );
}

// ------------------------------------------------------------------------------------------------ editor

function NoteEditor(props: { note: NoteView; now: Accessor<number>; onBack: () => void; onDelete: () => void }) {
  const id = props.note.id;
  const n = () => props.note;
  const isTodo = () => n().kind === 'todo';
  const done = () => noteDoneCount(n());
  const [menu, setMenu] = createSignal(false);
  const [focusItem, setFocusItem] = createSignal<string | null>(null);
  let more: HTMLButtonElement | undefined;
  let body: HTMLDivElement | undefined;
  createEffect(() => {
    if (!notesOpen()) setMenu(false);
  });

  const setItems = (f: (items: TodoItemView[]) => TodoItemView[]) => editNote(id, (c) => ({ ...c, items: f(c.items) }));

  const insertItem = (at: number) => {
    const item = newTodoItem();
    setItems((items) => {
      const next = items.slice();
      next.splice(Math.max(0, Math.min(at, next.length)), 0, item);
      return next;
    });
    setFocusItem(item.id);
  };

  /** ImeAction.Next: on to the next field. */
  const focusNext = (el: HTMLElement) => {
    const fields = Array.from(body?.querySelectorAll<HTMLElement>('.nt-field') ?? []);
    fields[fields.indexOf(el) + 1]?.focus();
  };

  const menuDo = (f: () => void) => () => {
    setMenu(false);
    f();
  };

  const convert = () =>
    editNote(id, (c) => {
      if (c.kind === 'todo') {
        // Items become lines of text so nothing is lost
        const lines = c.items
          .filter((i) => i.text.trim())
          .map((i) => (i.done ? '[x] ' : '[ ] ') + i.text)
          .join('\n');
        return { ...c, kind: 'note', items: [], text: [c.text.trimEnd(), lines].filter((s) => s.trim()).join('\n') };
      }
      const lines = c.text
        .split(/\r\n|\n|\r/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const parsed = lines.map((l) => {
        const isDone = l.slice(0, 3).toLowerCase() === '[x]';
        let t = l;
        for (const p of ['[x]', '[X]', '[ ]', '- ']) if (t.startsWith(p)) t = t.slice(p.length);
        return { id: newNoteId(), text: t.trim(), done: isDone };
      });
      return { ...c, kind: 'todo', text: '', items: [...c.items, ...(parsed.length > 0 ? parsed : [newTodoItem()])] };
    });

  return (
    <div class="nt-page">
      <div class="nt-ed-bar">
        <NtIconButton icon="arrow_back" title="Back" onClick={() => props.onBack()} />
        <div class="nt-spacer" />
        <NtIconButton
          d={PUSH_PIN}
          title={n().pinned ? 'Unpin' : 'Pin'}
          iconColor={n().pinned ? 'var(--primary)' : 'color-mix(in srgb, var(--on-surface) 70%, transparent)'}
          onClick={() => editNote(id, (c) => ({ ...c, pinned: !c.pinned }))}
        />
        <NtIconButton ref={(el) => (more = el)} icon="more_vert_o" title="More" onClick={() => setMenu(!menu())} />
        <DropdownMenu anchor={() => more} open={menu()} onClose={() => setMenu(false)} align="end" class="nt-menu">
          <Show when={isTodo()}>
            <MenuRow label="Check all" d={DONE_ALL} onClick={menuDo(() => setItems((items) => items.map((i) => ({ ...i, done: true }))))} />
            <MenuRow
              label="Uncheck all"
              icon="check_box_blank"
              onClick={menuDo(() => setItems((items) => items.map((i) => ({ ...i, done: false }))))}
            />
            <MenuRow
              label="Clear completed"
              d={CLEAR_ALL}
              disabled={done() === 0}
              onClick={menuDo(() => setItems((items) => items.filter((i) => !i.done)))}
            />
            <div class="nt-menu-divider" />
          </Show>
          <MenuRow
            label={isTodo() ? 'Turn into note' : 'Turn into to-do list'}
            icon={isTodo() ? 'edit_note' : 'checklist'}
            onClick={menuDo(convert)}
          />
          <MenuRow label="Delete" icon="delete_o" danger onClick={menuDo(() => props.onDelete())} />
        </DropdownMenu>
      </div>

      <div ref={body} class="nt-ed-scroll">
        <PlainField
          class="nt-ed-title"
          value={n().title}
          placeholder="Title"
          onInput={(v) => editNote(id, (c) => ({ ...c, title: v }), TYPING_DEBOUNCE_MS)}
          onEnter={focusNext}
        />

        <Show when={!isTodo() || n().text.length > 0}>
          <PlainField
            class="nt-ed-text"
            multiline
            value={n().text}
            placeholder={isTodo() ? 'Details' : 'Note'}
            onInput={(v) => editNote(id, (c) => ({ ...c, text: v }), TYPING_DEBOUNCE_MS)}
          />
        </Show>

        <Show when={isTodo()}>
          <div class="nt-ed-gap" />
          <For each={n().items}>
            {(item, index) => (
              <TodoRow
                noteId={id}
                item={item}
                requestFocus={focusItem() === item.id}
                onFocused={() => setFocusItem(null)}
                onNext={() => insertItem(index() + 1)}
                onRemove={() => setItems((items) => items.filter((i) => i.id !== item.id))}
              />
            )}
          </For>
          <button class="nt-add" onClick={() => insertItem(n().items.length)}>
            <Icon name="add" size={20} class="nt-add-icon" />
            <span class="nt-add-text">Add item</span>
          </button>
          <Show when={n().items.length > 0}>
            <div class="nt-progress">{`${done()} of ${n().items.length} done`}</div>
          </Show>
        </Show>

        <div class="nt-edited">{`Edited ${noteRelativeTime(n().updatedAt, props.now())}`}</div>
      </div>
    </div>
  );
}

function TodoRow(props: {
  noteId: string;
  item: TodoItemView;
  requestFocus: boolean;
  onFocused: () => void;
  onNext: () => void;
  onRemove: () => void;
}) {
  let field: HTMLElement | undefined;
  createEffect(() => {
    if (props.requestFocus) {
      field?.focus();
      props.onFocused();
    }
  });
  const setItem = (change: (i: TodoItemView) => TodoItemView, debounceMs = 0) => {
    const itemId = props.item.id;
    editNote(props.noteId, (c) => ({ ...c, items: c.items.map((i) => (i.id === itemId ? change(i) : i)) }), debounceMs);
  };
  return (
    <div class="nt-row">
      <button
        class="nt-check"
        classList={{ on: props.item.done }}
        role="checkbox"
        aria-checked={props.item.done}
        onClick={() => {
          const checked = !props.item.done;
          setItem((i) => ({ ...i, done: checked }));
        }}
      >
        <span class="nt-check-box">
          <svg class="nt-check-mark" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
            <path d="M4 10L8 14L16 6" />
          </svg>
        </span>
      </button>
      <PlainField
        ref={(el) => (field = el)}
        class="nt-item"
        done={props.item.done}
        value={props.item.text}
        placeholder="List item"
        onInput={(v) => setItem((i) => ({ ...i, text: v }), TYPING_DEBOUNCE_MS)}
        onEnter={() => props.onNext()}
      />
      <button class="nt-rm" title="Remove item" aria-label="Remove item" onClick={() => props.onRemove()}>
        <Icon name="close_o" size={18} />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ pieces

/**
 * PlainField / SyncedField: a bare text field (BasicTextField, primary cursor, placeholder at 35%) that keeps its own
 * text and only takes the note's value when it really is something else (an agent's edit), so typing is never reset.
 */
function PlainField(props: {
  value: string;
  placeholder: string;
  class: string;
  multiline?: boolean;
  done?: boolean;
  autofocus?: boolean;
  onInput: (v: string) => void;
  onEnter?: (el: HTMLElement) => void;
  ref?: (el: HTMLElement) => void;
}) {
  let el!: HTMLInputElement | HTMLTextAreaElement;
  const grow = () => {
    if (!props.multiline || !el) return;
    // keep the editor's scroll where it is while the field is measured
    const scroller = el.closest('.nt-ed-scroll');
    const top = scroller?.scrollTop ?? 0;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    if (scroller) scroller.scrollTop = top;
  };
  createEffect(() => {
    const v = props.value;
    if (el.value !== v) {
      el.value = v;
      grow();
    }
  });
  onMount(() => {
    grow();
    if (props.autofocus) el.focus({ preventScroll: true });
    if (props.multiline && typeof ResizeObserver !== 'undefined') {
      let width = el.clientWidth;
      const ro = new ResizeObserver(() => {
        if (el.clientWidth !== width) {
          width = el.clientWidth;
          grow();
        }
      });
      ro.observe(el);
      onCleanup(() => ro.disconnect());
    }
  });
  const cls = () => `nt-field ${props.class}${props.done ? ' done' : ''}`;
  return (
    <Show
      when={props.multiline}
      fallback={
        <input
          ref={(r) => {
            el = r;
            props.ref?.(r);
          }}
          type="text"
          class={cls()}
          placeholder={props.placeholder}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.isComposing && props.onEnter) {
              e.preventDefault();
              props.onEnter(e.currentTarget);
            }
          }}
        />
      }
    >
      <textarea
        ref={(r) => {
          el = r;
          props.ref?.(r);
        }}
        class={cls()}
        rows={1}
        placeholder={props.placeholder}
        onInput={(e) => {
          grow();
          props.onInput(e.currentTarget.value);
        }}
      />
    </Show>
  );
}

/** Material IconButton: 48dp target, 40dp state layer, 24dp icon. */
function NtIconButton(props: {
  icon?: IconName;
  d?: string;
  title: string;
  iconColor?: string;
  onClick: () => void;
  ref?: (el: HTMLButtonElement) => void;
}) {
  return (
    <button ref={(el) => props.ref?.(el)} class="nt-ib" title={props.title} aria-label={props.title} onClick={() => props.onClick()}>
      <Glyph icon={props.icon} d={props.d} size={24} color={props.iconColor} />
    </button>
  );
}

/** An icon from ui/iconData.ts, or a path inlined here. */
function Glyph(props: { icon?: IconName; d?: string; size: number; color?: string; class?: string }) {
  return (
    <Show when={props.d} fallback={<Icon name={props.icon!} size={props.size} color={props.color} class={props.class} />}>
      <svg
        class={'icon' + (props.class ? ' ' + props.class : '')}
        viewBox="0 0 24 24"
        width={props.size}
        height={props.size}
        fill="currentColor"
        aria-hidden="true"
        style={{ color: props.color }}
      >
        <path d={props.d} />
      </svg>
    </Show>
  );
}

/** Material3 DropdownMenuItem: 48dp, 12dp padding, 24dp leading icon (onSurfaceVariant), labelLarge text. */
function MenuRow(props: { label: string; icon?: IconName; d?: string; danger?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button class="nt-mi" classList={{ danger: !!props.danger }} role="menuitem" disabled={props.disabled} onClick={() => props.onClick()}>
      <Glyph icon={props.icon} d={props.d} size={24} class="nt-mi-icon" />
      <span class="nt-mi-text">{props.label}</span>
    </button>
  );
}

// ------------------------------------------------------------------------------------------------ snackbar

interface Snack {
  id: number;
  message: string;
  action: string;
  onAction: () => void;
  /** Waits for the one it replaces to fade out (FadeInFadeOutWithScale). */
  delay: number;
  leaving: Accessor<boolean>;
  setLeaving: Setter<boolean>;
}

/** SnackbarHostState: one at a time, a new one dismisses the current one; SnackbarDuration.Short = 4 s. */
function createSnackbar() {
  const [list, setList] = createSignal<Snack[]>([]);
  let seq = 0;
  let timer: number | undefined;
  const dismiss = (s: Snack) => {
    if (s.leaving()) return;
    s.setLeaving(true);
    window.setTimeout(() => setList((l) => l.filter((x) => x !== s)), 120);
  };
  const show = (message: string, action: string, onAction: () => void) => {
    clearTimeout(timer);
    const current = list().filter((s) => !s.leaving());
    current.forEach(dismiss);
    const [leaving, setLeaving] = createSignal(false);
    const s: Snack = { id: ++seq, message, action, onAction, delay: current.length > 0 ? 75 : 0, leaving, setLeaving };
    setList((l) => [...l, s]);
    timer = window.setTimeout(() => dismiss(s), 4000 + s.delay);
  };
  const act = (s: Snack) => {
    if (s.leaving()) return;
    clearTimeout(timer);
    dismiss(s);
    s.onAction();
  };
  onCleanup(() => clearTimeout(timer));
  return { list, show, act };
}

function SnackbarHost(props: { bar: ReturnType<typeof createSnackbar> }) {
  return (
    <div class="nt-snack-host">
      <For each={props.bar.list()}>{(s) => <SnackView snack={s} onAction={() => props.bar.act(s)} />}</For>
    </div>
  );
}

/** Material3 Snackbar: inverseSurface, 4dp corners, 6dp shadow; fades in 150 ms scaling from 0.8, out in 75 ms. */
function SnackView(props: { snack: Snack; onAction: () => void }) {
  const [entered, setEntered] = createSignal(false);
  onMount(() => nextFrame(() => setEntered(true)));
  return (
    <div
      class="nt-snack"
      classList={{ shown: entered() && !props.snack.leaving() }}
      style={{ '--nt-snack-delay': `${props.snack.delay}ms` }}
      role="status"
      aria-live="polite"
    >
      <div class="nt-snack-text">{props.snack.message}</div>
      <button
        class="nt-snack-action"
        onClick={(e) => {
          e.stopPropagation();
          props.onAction();
        }}
      >
        {props.snack.action}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ time

/** Calendar days between two times (local time zone). */
function dayDistance(a: number, b: number): number {
  const da = new Date(a);
  const db = new Date(b);
  const ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  const ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round(Math.abs(ub - ua) / 86_400_000);
}

/**
 * relativeTime(): "just now" under a minute, else DateUtils.getRelativeTimeSpanString(millis, now, MINUTE_IN_MILLIS,
 * FORMAT_ABBREV_RELATIVE): "5 min. ago", "2 hr. ago", "Yesterday", "3 days ago", then the date ("March 4", with the
 * year when it is not this year).
 */
function noteRelativeTime(ms: number, now: number): string {
  if (now - ms < 60_000) return 'just now';
  const d = now - ms;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min. ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} hr. ago`;
  if (d < 7 * 86_400_000) {
    const days = dayDistance(ms, now);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return `${days} days ago`;
  }
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}
