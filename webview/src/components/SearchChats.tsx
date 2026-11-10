// ChatHistoryDrawer.kt's SearchChatsDialog ("Advanced Search"): a query over titles, roles and models, time and
// workspace filters, plus what VS Code adds: matches inside the chats' messages (searchChats, with a snippet).
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { ChatSearchHit } from '@shared/protocol';
import { openConversation, searchChats, state } from '../state/store';
import { Icon, IconButton, nextFrame } from '../ui/primitives';
import { agentAccent, relativeTime, workspaceName } from '../util/format';

export const [searchDialogOpen, setSearchDialogOpen] = createSignal(false);

/** The query's first match in a snippet, split for highlighting. */
export function splitMatch(text: string, q: string): [string, string, string] {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return [text, '', ''];
  return [text.substring(0, i), text.substring(i, i + q.length), text.substring(i + q.length)];
}

/** Content search with a debounce; the latest query wins. Empty under 2 characters. */
export function useDeepSearch(query: () => string, delay = 280) {
  const [hits, setHits] = createSignal<ChatSearchHit[]>([]);
  const [busy, setBusy] = createSignal(false);
  let t: number | undefined;
  createEffect(
    on(query, (q) => {
      clearTimeout(t);
      const s = q.trim();
      if (s.length < 2) {
        setHits([]);
        setBusy(false);
        return;
      }
      setBusy(true);
      t = window.setTimeout(
        () =>
          searchChats(s, (r) => {
            if (query().trim() !== s) return;
            setHits(r);
            setBusy(false);
          }),
        delay,
      );
    }),
  );
  onCleanup(() => clearTimeout(t));
  return { hits, busy };
}

const TIMES = ['All', 'Today', 'Past 7d', 'Past 30d'] as const;

export function SearchChatsDialog(props: { onPick: () => void }) {
  const [mounted, setMounted] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [time, setTime] = createSignal<(typeof TIMES)[number]>('All');
  const [ws, setWs] = createSignal('All');
  let input: HTMLInputElement | undefined;
  let timer: number | undefined;
  createEffect(
    on(searchDialogOpen, (o) => {
      clearTimeout(timer);
      if (o) {
        setMounted(true);
        nextFrame(() => {
          setShown(true);
          input?.focus({ preventScroll: true });
        });
      } else {
        setShown(false);
        timer = window.setTimeout(() => setMounted(false), 160);
      }
    }),
  );
  const close = () => setSearchDialogOpen(false);
  const onKey = (e: KeyboardEvent) => {
    if (searchDialogOpen() && e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  onCleanup(() => {
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(timer);
  });

  const workspaces = createMemo(() => {
    const out = ['All'];
    for (const c of state.conversations) if (c.workspaceUri) {
      const n = workspaceName(c.workspaceUri);
      if (!out.includes(n)) out.push(n);
    }
    return out;
  });
  const passes = (c: { updatedAt: number; workspaceUri?: string }) => {
    const age = Date.now() - c.updatedAt;
    const t = time();
    const okTime = t === 'All' || (t === 'Today' ? age < 86_400_000 : t === 'Past 7d' ? age < 7 * 86_400_000 : age < 30 * 86_400_000);
    const okWs = ws() === 'All' || (!!c.workspaceUri && workspaceName(c.workspaceUri).toLowerCase() === ws().toLowerCase());
    return okTime && okWs;
  };
  const results = createMemo(() => {
    const q = query().trim().toLowerCase();
    return state.conversations
      .filter((c) => passes(c))
      .filter((c) => !q || c.title.toLowerCase().includes(q) || (c.subagentRole ?? '').toLowerCase().includes(q) || c.modelId.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
  const deep = useDeepSearch(query);
  const contentHits = createMemo(() => {
    const ids = new Set(results().map((c) => c.id));
    const byId = new Map(state.conversations.map((c) => [c.id, c]));
    return deep.hits().filter((h) => !ids.has(h.conversationId) && passes({ updatedAt: h.updatedAt, workspaceUri: byId.get(h.conversationId)?.workspaceUri }));
  });
  const snippetOf = (id: string) => deep.hits().find((h) => h.conversationId === id)?.snippet;
  const pick = (id: string) => {
    openConversation(id);
    close();
    props.onPick();
  };
  const total = () => results().length + contentHits().length;

  return (
    <Show when={mounted()}>
      <Portal>
        <div class="dialog-scrim search-scrim" classList={{ shown: shown() }} onClick={(e) => (e.stopPropagation(), close())}>
          <div class="search-dialog dialog" onClick={(e) => e.stopPropagation()}>
            <div class="search-head">
              <span class="search-head-icon">
                <Icon name="search" size={18} />
              </span>
              <div class="search-titles">
                <div class="search-title">Search Conversations</div>
                <div class="search-sub">{state.conversations.length} total chats indexed</div>
              </div>
              <IconButton icon="close" size={32} iconSize={18} color="color-mix(in srgb, var(--on-surface-variant) 70%, transparent)" title="Close" onClick={close} />
            </div>
            <label class="search-field" classList={{ on: !!query() }}>
              <Icon name="search" size={18} />
              <input ref={input} placeholder="Search by title, topic, model, or what was said…" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
              <Show when={query()}>
                <button class="search-clear" title="Clear" onClick={() => setQuery('')}>
                  <Icon name="close" size={15} />
                </button>
              </Show>
            </label>
            <div class="search-filters">
              <For each={TIMES}>{(t) => <button class="search-chip" classList={{ on: time() === t }} onClick={() => setTime(t)}>{t}</button>}</For>
              <Show when={workspaces().length > 1}>
                <span class="search-sep" />
                <For each={workspaces()}>
                  {(w) => (
                    <button class="search-chip" classList={{ on: ws() === w }} onClick={() => setWs(w)}>
                      <Show when={w !== 'All'}>
                        <Icon name="folder" size={12} />
                      </Show>
                      {w}
                    </button>
                  )}
                </For>
              </Show>
            </div>
            <div class="search-count">
              {total()} match{total() !== 1 ? 'es' : ''}
              <Show when={deep.busy()}>
                <span class="mini-spinner" />
              </Show>
            </div>
            <div class="search-results">
              <Show
                when={total() > 0}
                fallback={
                  <div class="search-empty">
                    <Icon name="chat_bubble" size={40} />
                    <div class="search-empty-title">No conversations found</div>
                    <div class="search-empty-text">{query().trim() ? `No chats match "${query().trim()}". Try different keywords or reset filters.` : 'No chats in this category.'}</div>
                  </div>
                }
              >
                <For each={results()}>
                  {(c) => (
                    <SearchRow
                      selected={c.id === state.chat.conversationId}
                      title={c.title || 'Untitled'}
                      time={c.updatedAt}
                      snippet={snippetOf(c.id)}
                      query={query().trim()}
                      workspace={c.workspaceUri ? workspaceName(c.workspaceUri) : null}
                      model={c.modelId ? c.modelId.substring(c.modelId.lastIndexOf('/') + 1) : null}
                      steps={c.stepCount}
                      accent={agentAccent(c.agent)}
                      onClick={() => pick(c.id)}
                    />
                  )}
                </For>
                <Show when={contentHits().length}>
                  <div class="search-section">In messages</div>
                  <For each={contentHits()}>
                    {(h) => {
                      const conv = () => state.conversations.find((c) => c.id === h.conversationId);
                      return (
                        <SearchRow
                          selected={h.conversationId === state.chat.conversationId}
                          title={h.title || 'Untitled'}
                          time={h.updatedAt}
                          snippet={h.snippet}
                          query={query().trim()}
                          workspace={conv()?.workspaceUri ? workspaceName(conv()!.workspaceUri) : null}
                          model={null}
                          steps={0}
                          accent={agentAccent(h.agent)}
                          onClick={() => pick(h.conversationId)}
                        />
                      );
                    }}
                  </For>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

function SearchRow(props: {
  selected: boolean;
  title: string;
  time: number;
  snippet?: string | null;
  query: string;
  workspace: string | null;
  model: string | null;
  steps: number;
  accent: string;
  onClick: () => void;
}) {
  const t = () => splitMatch(props.title, props.query);
  const sn = () => splitMatch(props.snippet ?? '', props.query);
  return (
    <button class="search-row" classList={{ on: props.selected }} onClick={props.onClick} style={{ '--accent': props.accent }}>
      <span class="search-row-top">
        <span class="search-row-title">
          {t()[0]}
          <mark>{t()[1]}</mark>
          {t()[2]}
        </span>
        <span class="search-row-time">{relativeTime(props.time)}</span>
      </span>
      <Show when={props.snippet}>
        <span class="search-row-snippet">
          {sn()[0]}
          <mark>{sn()[1]}</mark>
          {sn()[2]}
        </span>
      </Show>
      <span class="search-row-meta">
        <Show when={props.workspace}>
          <span class="search-tag">
            <Icon name="folder" size={11} />
            {props.workspace}
          </span>
        </Show>
        <Show when={props.model}>
          <span class="search-tag model">{props.model}</span>
        </Show>
        <Show when={props.steps > 0}>
          <span class="search-steps">{props.steps} steps</span>
        </Show>
      </span>
    </button>
  );
}
