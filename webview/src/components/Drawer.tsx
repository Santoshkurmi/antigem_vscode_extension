// ui/drawer/ChatHistoryDrawer.kt: wordmark + round header buttons (search, group by workspace, archive), the agent
// filter chips, the newest-first chat list (sub-agent chats nested as a tree, optional grouping by workspace with
// "Show N more"), each row with its agent-tinted icon, running dot, relative time and ⋮ menu.
import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from 'solid-js';
import type { AgentKind, Conversation } from '@shared/model';
import { conversationAction, enabledAgents, openConversation, setUi, state } from '../state/store';
import { openSettings, setThemePanelOpen, themePanelOpen } from '../state/settings';
import { Collapse, Dialog, DropdownMenu, Icon, type MenuItem } from '../ui/primitives';
import { SearchChatsDialog, setSearchDialogOpen, splitMatch, useDeepSearch } from './SearchChats';
import { AccountsButton } from './Accounts';
import { exportChat } from '../state/exportFlow';
import { agentAccent, agentChipLabel, alpha, relativeTime, workspaceName } from '../util/format';

interface TreeItem {
  conv: Conversation;
  depth: number;
  children: Conversation[];
  expanded: boolean;
}

export function Drawer(props: { open: boolean; onClose: () => void }) {
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [expandedParents, setExpandedParents] = createSignal<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = createSignal<Set<string>>(new Set());
  const [toDelete, setToDelete] = createSignal<Conversation | null>(null);
  const [toRename, setToRename] = createSignal<Conversation | null>(null);
  const [renameText, setRenameText] = createSignal('');
  let searchInput: HTMLInputElement | undefined;
  let listEl: HTMLDivElement | undefined;

  const visibleAgents = createMemo(() => {
    const base = state.agents.length ? enabledAgents() : [...new Set(state.conversations.map((c) => c.agent))];
    return (['AGY', 'CLAUDE', 'OPENCODE', 'CODEX'] as AgentKind[]).filter((a) => base.includes(a));
  });
  const filter = () => (state.ui.agentFilter && visibleAgents().includes(state.ui.agentFilter) ? state.ui.agentFilter : null);

  // archived chats, sub-agents included when an ancestor is archived
  const archivedIds = createMemo(() => {
    const byId = new Map(state.conversations.map((c) => [c.id, c]));
    const out = new Set<string>();
    for (const c of state.conversations) {
      let cur: Conversation | undefined = c;
      let hops = 0;
      while (cur && hops++ < 32) {
        if (cur.archived) {
          out.add(c.id);
          break;
        }
        const p: string | null | undefined = cur.parentConversationId;
        if (!p || p === cur.id) break;
        cur = byId.get(p);
      }
    }
    return out;
  });

  const filtered = createMemo(() => {
    const a = filter();
    const q = query().trim().toLowerCase();
    return state.conversations
      .filter((c) => (a ? c.agent === a : true))
      .filter((c) => archivedIds().has(c.id) === state.ui.showArchived)
      .filter((c) => !q || c.title.toLowerCase().includes(q) || (c.subagentRole ?? '').toLowerCase().includes(q))
      .sort((x, y) => y.updatedAt - x.updatedAt);
  });
  // what was said in the chats (searchChats), below the title matches
  const deep = useDeepSearch(query);
  const contentHits = createMemo(() => {
    const shown = new Set(filtered().map((c) => c.id));
    return deep.hits().filter((h) => !shown.has(h.conversationId) && (!filter() || h.agent === filter()));
  });
  const ids = createMemo(() => new Set(filtered().map((c) => c.id)));
  const childrenOf = createMemo(() => {
    const m = new Map<string, Conversation[]>();
    for (const c of filtered()) {
      const p = c.parentConversationId;
      if (p && p !== c.id && ids().has(p)) m.set(p, [...(m.get(p) ?? []), c]);
    }
    return m;
  });
  const topLevel = createMemo(() =>
    filtered().filter((c) => {
      const p = c.parentConversationId;
      return !p || p === c.id || !ids().has(p);
    }),
  );
  const tree = (roots: Conversation[], depth = 0): TreeItem[] => {
    const out: TreeItem[] = [];
    for (const conv of roots) {
      const children = childrenOf().get(conv.id) ?? [];
      const expanded = expandedParents().has(conv.id);
      out.push({ conv, depth, children, expanded });
      if (expanded && children.length) out.push(...tree(children, depth + 1));
    }
    return out;
  };
  const groupMap = createMemo(() => {
    const m = new Map<string, Conversation[]>();
    for (const c of topLevel()) {
      const g = c.workspaceUri ? workspaceName(c.workspaceUri) : 'General';
      m.set(g, [...(m.get(g) ?? []), c]);
    }
    return m;
  });
  const groupNames = createMemo(() => [...groupMap().keys()], undefined, {
    equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
  });
  // tree rows keyed by the (stable) conversation objects: a list update re-renders only the rows that changed
  const flatTree = createMemo(() => tree(topLevel()));
  const items = createMemo(() => new Map(flatTree().map((t) => [t.conv.id, t])));
  const groupTrees = createMemo(() => {
    const m = new Map<string, TreeItem[]>();
    for (const [name, chats] of groupMap()) m.set(name, tree(expandedGroups().has(name) ? chats : chats.slice(0, 5)));
    return m;
  });
  const groupItems = createMemo(() => {
    const m = new Map<string, TreeItem>();
    for (const list of groupTrees().values()) for (const t of list) m.set(t.conv.id, t);
    return m;
  });

  // the open chat's ancestors expand; the list shows it when the drawer opens
  createEffect(
    on(
      [() => state.chat.conversationId, () => state.conversationsLoaded],
      ([id]) => {
        if (!id) return;
        const byId = new Map(state.conversations.map((c) => [c.id, c]));
        const cur = byId.get(id);
        if (!cur) return;
        const add = new Set(expandedParents());
        if (state.conversations.some((c) => c.parentConversationId === cur.id)) add.add(cur.id);
        let p = cur.parentConversationId;
        let hops = 0;
        while (p && hops++ < 32) {
          add.add(p);
          p = byId.get(p)?.parentConversationId ?? null;
        }
        setExpandedParents(add);
      },
    ),
  );
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        requestAnimationFrame(() => {
          const el = listEl?.querySelector('.chat-row.selected') as HTMLElement | null;
          if (el) el.scrollIntoView({ block: 'nearest' });
          else listEl?.scrollTo({ top: 0 });
        });
      },
    ),
  );

  const select = (c: Conversation, hasChildren: boolean) => {
    if (hasChildren) setExpandedParents((s) => new Set(s).add(c.id));
    openConversation(c.id);
    props.onClose();
  };
  const toggleParent = (id: string) =>
    setExpandedParents((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const listState = () => {
    if (!state.conversationsLoaded) return 'loading';
    if (!filtered().length && !contentHits().length) return 'empty';
    return 'content';
  };

  const row = (conv: Conversation, lookup: () => Map<string, TreeItem>) => {
    const item = () => lookup().get(conv.id) ?? { conv, depth: 0, children: [], expanded: false };
    return (
      <ChatRow
        item={item()}
        onSelect={() => select(conv, item().children.length > 0)}
        onToggle={() => toggleParent(conv.id)}
        onDelete={() => setToDelete(conv)}
        onRename={() => {
          setRenameText(conv.title);
          setToRename(conv);
        }}
      />
    );
  };

  return (
    <>
      <div class="drawer-scrim" classList={{ shown: props.open }} onClick={props.onClose} />
      <aside class="drawer" classList={{ open: props.open }} aria-hidden={!props.open}>
        <div class="drawer-inner">
          <div class="drawer-header">
            <span class="wordmark">AntiGem</span>
            <HeaderIcon
              icon="search"
              title="Search"
              active={searchOpen() || !!query()}
              onClick={() => {
                const next = !searchOpen();
                setSearchOpen(next);
                if (next) setTimeout(() => searchInput?.focus({ preventScroll: true }), 120);
                else setQuery('');
              }}
            />
            <HeaderIcon
              icon={state.ui.groupByWorkspace ? 'folder' : 'folder_open'}
              title={state.ui.groupByWorkspace ? 'Disable Workspace Grouping' : 'Group by Workspace'}
              active={state.ui.groupByWorkspace}
              onClick={() => setUi('groupByWorkspace', !state.ui.groupByWorkspace)}
            />
            <HeaderIcon
              icon="archive"
              title={state.ui.showArchived ? 'Show Chats' : 'Show Archived Chats'}
              active={state.ui.showArchived}
              onClick={() => setUi('showArchived', !state.ui.showArchived)}
            />
          </div>

          <Collapse when={searchOpen() || !!query()}>
            <div class="drawer-search" classList={{ active: !!query() }}>
              <Icon name="search" size={18} />
              <input
                ref={searchInput}
                placeholder="Search chats"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setQuery('');
                    setSearchOpen(false);
                  }
                }}
              />
              <Show when={query()}>
                <button class="icon-btn" style={{ width: '32px', height: '32px' }} title="Clear" onClick={() => setQuery('')}>
                  <Icon name="close" size={16} />
                </button>
              </Show>
              {/* deep search (message contents, filters) */}
              <button class="icon-btn" style={{ width: '34px', height: '34px' }} title="Advanced Search" onClick={() => setSearchDialogOpen(true)}>
                <Icon name="tune" size={17} color="color-mix(in srgb, var(--on-surface-variant) 75%, transparent)" />
              </button>
            </div>
          </Collapse>
          <Collapse when={!!query()}>
            <div class="drawer-found">
              <span>
                {filtered().length} chat{filtered().length !== 1 ? 's' : ''} found
                <Show when={contentHits().length}> · {contentHits().length} in messages</Show>
                <Show when={deep.busy()}>
                  <span class="mini-spinner" />
                </Show>
              </span>
              <button class="drawer-advanced" onClick={() => setSearchDialogOpen(true)}>
                Advanced Search ›
              </button>
            </div>
          </Collapse>

          <div style={{ height: '10px', 'flex-shrink': 0 }} />

          <Show when={visibleAgents().length > 1}>
            <div class="filter-chips">
              <For each={[null, ...visibleAgents()] as (AgentKind | null)[]}>
                {(a) => {
                  const on = () => filter() === a;
                  return (
                    <button
                      class="filter-chip"
                      classList={{ on: on() }}
                      style={{ '--accent': a ? agentAccent(a) : 'var(--primary)' }}
                      onClick={() => setUi('agentFilter', a)}
                    >
                      {a ? agentChipLabel(a) : 'All'}
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>

          <Show when={state.ui.showArchived}>
            <div class="archive-bar">
              <Icon name="archive" size={15} color="var(--primary)" />
              <span class="archive-title">Archived chats · {topLevel().length}</span>
              <button class="archive-back" onClick={() => setUi('showArchived', false)}>
                Back to chats
              </button>
            </div>
          </Show>

          <div class="drawer-list" ref={listEl}>
            <Switch>
              <Match when={listState() === 'loading'}>
                <SidebarSkeleton />
              </Match>
              <Match when={listState() === 'empty'}>
                <div class="drawer-empty">
                  {query()
                    ? `No ${state.ui.showArchived ? 'archived ' : ''}chats found matching "${query()}"`
                    : state.ui.showArchived
                      ? 'No archived chats. Archive a chat from its ⋮ menu to keep it here, out of the main list.'
                      : 'No recent chats'}
                </div>
              </Match>
              <Match when={listState() === 'content' && !state.ui.groupByWorkspace}>
                <For each={flatTree().map((t) => t.conv)}>{(c) => row(c, items)}</For>
              </Match>
              <Match when={listState() === 'content' && state.ui.groupByWorkspace}>
                <For each={groupNames()}>
                  {(name) => {
                    const chats = () => groupMap().get(name) ?? [];
                    const exp = () => expandedGroups().has(name);
                    const toggle = () =>
                      setExpandedGroups((s) => {
                        const n = new Set(s);
                        if (n.has(name)) n.delete(name);
                        else n.add(name);
                        return n;
                      });
                    return (
                      <>
                        <div class="group-head" classList={{ clickable: chats().length > 5 }} onClick={() => chats().length > 5 && toggle()}>
                          <Icon name={name === 'General' ? 'public' : 'folder'} size={15} />
                          <span class="group-name">{name}</span>
                          <span class="group-count">{chats().length}</span>
                          <Show when={chats().length > 5}>
                            <span class="flex1" />
                            <Icon name={exp() ? 'chevron_up' : 'chevron_down'} size={16} />
                          </Show>
                        </div>
                        <For each={(groupTrees().get(name) ?? []).map((t) => t.conv)}>{(c) => row(c, groupItems)}</For>
                        <Show when={chats().length > 5}>
                          <button class="group-more" onClick={toggle}>
                            {exp() ? 'Show less' : `Show ${chats().length - 5} more`}
                            <Icon name={exp() ? 'chevron_up' : 'chevron_down'} size={14} />
                          </button>
                        </Show>
                      </>
                    );
                  }}
                </For>
              </Match>
            </Switch>
            <Show when={query().trim() && contentHits().length}>
              <div class="drawer-hits-head">In messages</div>
              <For each={contentHits()}>
                {(h) => {
                  const sn = () => splitMatch(h.snippet, query().trim());
                  return (
                    <button
                      class="drawer-hit"
                      classList={{ selected: h.conversationId === state.chat.conversationId }}
                      onClick={() => {
                        openConversation(h.conversationId);
                        props.onClose();
                      }}
                    >
                      <span class="drawer-hit-top">
                        <Icon name="chat_bubble" size={15} color={agentAccent(h.agent)} />
                        <span class="drawer-hit-title">{h.title || 'Untitled'}</span>
                        <span class="chat-row-time">{relativeTime(h.updatedAt)}</span>
                      </span>
                      <span class="drawer-hit-snippet">
                        {sn()[0]}
                        <mark>{sn()[1]}</mark>
                        {sn()[2]}
                      </span>
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>

          <div class="drawer-divider" />
          <div class="drawer-footer">
            <button
              class="footer-btn"
              title="Settings"
              onClick={() => {
                props.onClose();
                openSettings();
              }}
            >
              <Icon name="settings" size={20} />
            </button>
            {/* Themes: a floating picker over the sidebar and chat, to try themes and see them live */}
            <button class="footer-btn" classList={{ on: themePanelOpen() }} title="Themes" onClick={() => setThemePanelOpen(!themePanelOpen())}>
              <Icon name="palette" size={20} />
            </button>
            <span class="flex1" />
            <AccountsButton />
          </div>
        </div>
      </aside>
      <SearchChatsDialog onPick={props.onClose} />

      <Dialog
        open={!!toDelete()}
        onClose={() => setToDelete(null)}
        radius={18}
        background="var(--surface-container-high)"
        title="Delete Conversation?"
        actions={
          <>
            <button class="text-btn" onClick={() => setToDelete(null)}>
              Cancel
            </button>
            <button
              class="filled-btn"
              style={{ background: 'var(--error)', color: 'var(--on-error)', 'border-radius': '10px' }}
              onClick={() => {
                const c = toDelete();
                setToDelete(null);
                if (c) conversationAction(c.id, 'delete');
              }}
            >
              <Icon name="delete" size={16} /> Delete
            </button>
          </>
        }
      >
        Are you sure you want to delete "{toDelete()?.title || 'this conversation'}"? This will permanently remove all messages and trajectory data.
      </Dialog>

      <Dialog
        open={!!toRename()}
        onClose={() => setToRename(null)}
        title="Rename chat"
        actions={
          <>
            <button class="text-btn" onClick={() => setToRename(null)}>
              Cancel
            </button>
            <button
              class="text-btn strong"
              style={{ color: 'var(--primary)' }}
              disabled={!renameText().trim()}
              onClick={() => {
                const c = toRename();
                setToRename(null);
                if (c) conversationAction(c.id, 'rename', renameText().trim());
              }}
            >
              Save
            </button>
          </>
        }
      >
        <input
          class="outlined-field single"
          value={renameText()}
          onInput={(e) => setRenameText(e.currentTarget.value)}
          ref={(el) => setTimeout(() => el.select(), 60)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && renameText().trim()) {
              const c = toRename();
              setToRename(null);
              if (c) conversationAction(c.id, 'rename', renameText().trim());
            }
          }}
        />
      </Dialog>
    </>
  );
}

function HeaderIcon(props: { icon: 'search' | 'folder' | 'folder_open' | 'archive'; title: string; active: boolean; onClick: () => void }) {
  return (
    <button class="header-round" classList={{ active: props.active }} title={props.title} onClick={props.onClick}>
      <Icon name={props.icon} size={19} />
    </button>
  );
}

function ChatRow(props: { item: TreeItem; onSelect: () => void; onToggle: () => void; onDelete: () => void; onRename: () => void }) {
  const c = () => props.item.conv;
  const sub = () => props.item.depth > 0;
  const selected = () => c().id === state.chat.conversationId;
  const running = () => c().isRunning;
  const background = () => !running() && (c().notFullyIdle || c().hasActivity);
  const dot = () => (running() ? 'var(--success)' : background() ? 'var(--warning)' : null);
  const name = () => (sub() ? c().subagentRole?.trim() || c().title : c().title) || 'Untitled';
  const iconColor = () => {
    const a = c().agent;
    if (a === 'AGY') return selected() ? 'var(--primary)' : alpha('var(--on-surface)', 0.6);
    return alpha(agentAccent(a), selected() ? 1 : 0.85);
  };
  const [menu, setMenu] = createSignal(false);
  let menuBtn: HTMLButtonElement | undefined;
  const items = (): MenuItem[] => [
    { label: 'Copy Conversation ID', icon: 'copy', onClick: () => conversationAction(c().id, 'copyId') },
    { label: 'Fork Conversation', icon: 'call_split', iconColor: 'var(--primary)', onClick: () => conversationAction(c().id, 'fork') },
    { label: 'Rename', icon: 'edit_o', onClick: props.onRename },
    {
      label: 'Open in editor tab',
      description: 'Side by side, for multitasking',
      icon: 'open_in_new',
      iconColor: 'var(--info)',
      divider: true,
      onClick: () => conversationAction(c().id, 'openInEditor'),
    },
    { label: 'Export Markdown (.md)', icon: 'description_o', iconColor: 'var(--agy)', divider: true, onClick: () => exportChat(c().id, 'md') },
    { label: 'Export Standalone HTML', icon: 'code', iconColor: 'var(--success)', onClick: () => exportChat(c().id, 'html') },
    {
      label: c().archived ? 'Unarchive' : 'Archive',
      icon: c().archived ? 'unarchive' : 'archive',
      divider: true,
      onClick: () => conversationAction(c().id, c().archived ? 'unarchive' : 'archive'),
    },
    { label: 'Delete Conversation', icon: 'delete', iconColor: 'var(--error)', color: 'var(--error)', onClick: props.onDelete },
  ];
  return (
    <div
      class="chat-row"
      classList={{ selected: selected(), sub: sub() }}
      style={{ 'margin-left': sub() ? `${12 + props.item.depth * 14}px` : undefined }}
      onClick={props.onSelect}
      title={c().title}
    >
      <span class="chat-row-icon">
        <Show
          when={sub()}
          fallback={<Icon name={c().cloudProjectId ? 'cloud' : 'chat_bubble'} size={17} color={c().cloudProjectId ? alpha('var(--info)', selected() ? 1 : 0.85) : iconColor()} />}
        >
          <Icon name="call_split" size={15} color={selected() ? 'var(--primary)' : alpha('var(--on-surface-variant)', 0.7)} />
        </Show>
        <Show when={dot()}>
          <span class="chat-row-icon-dot" classList={{ small: sub() }} style={{ background: dot()! }} />
        </Show>
      </span>
      <span class="chat-row-main">
        <span class="chat-row-title">{name()}</span>
        <span class="chat-row-meta">
          <Show when={props.item.children.length}>
            <button
              class="sub-count"
              classList={{ on: props.item.expanded }}
              onClick={(e) => {
                e.stopPropagation();
                props.onToggle();
              }}
            >
              {props.item.children.length}
              <Icon name={props.item.expanded ? 'chevron_up' : 'chevron_down'} size={13} />
            </button>
          </Show>
          <span class="chat-row-time">{relativeTime(c().updatedAt)}</span>
        </span>
      </span>
      <Show when={dot()}>
        <span class="chat-row-dot" style={{ background: dot()! }} />
      </Show>
      <button
        ref={menuBtn}
        class="row-menu-btn"
        title="Options"
        onClick={(e) => {
          e.stopPropagation();
          setMenu(true);
        }}
      >
        <Icon name="more_vert" size={17} />
      </button>
      <DropdownMenu
        anchor={() => menuBtn}
        open={menu()}
        onClose={() => setMenu(false)}
        items={items()}
        minWidth={210}
        radius={12}
        background="var(--surface-container-high)"
        border={`1px solid ${alpha('var(--outline-variant)', 0.35)}`}
        align="end"
      />
    </div>
  );
}

function SidebarSkeleton() {
  const widths = [0.78, 0.6, 0.88, 0.52, 0.7, 0.82, 0.65, 0.75];
  return (
    <div class="sidebar-skeleton">
      <For each={widths}>
        {(w) => (
          <div class="sk-chat">
            <span class="shimmer" style={{ width: '18px', height: '18px', 'border-radius': '5px' }} />
            <span class="sk-chat-title">
              <span class="shimmer" style={{ width: `${w * 100}%`, height: '13.5px', 'border-radius': '4px' }} />
            </span>
            <span class="shimmer" style={{ width: '22px', height: '11px', 'border-radius': '3px' }} />
            <span class="shimmer" style={{ width: '16px', height: '16px', 'border-radius': '4px' }} />
          </div>
        )}
      </For>
    </div>
  );
}
