// ui/components/ProjectPickerBottomSheet.kt (ProjectPickerDialog): "Select Workspace" — General (no folder), every
// known folder (open in VS Code, saved, used by chats), and "Browse or Open Other Folder…".
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { ProjectView } from '@shared/protocol';
import { chooseProject, newChatProjectUri, pickFolder, requestProjects, send, showToast } from '../state/store';
import { Icon, IconButton, nextFrame } from '../ui/primitives';
import { alpha, relativeTime } from '../util/format';

export const [projectPickerOpen, setProjectPickerOpen] = createSignal(false);

const samePath = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.replace(/^file:\/\//, '').replace(/\/+$/, '') === b.replace(/^file:\/\//, '').replace(/\/+$/, '');

export function ProjectPicker() {
  const [mounted, setMounted] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  const [projects, setProjects] = createSignal<ProjectView[] | null>(null);
  let timer: number | undefined;
  let list: HTMLDivElement | undefined;

  const load = () => {
    setProjects(null);
    requestProjects((p) => setProjects(p));
  };
  createEffect(
    on(projectPickerOpen, (o) => {
      clearTimeout(timer);
      if (o) {
        load();
        setMounted(true);
        nextFrame(() => setShown(true));
      } else {
        setShown(false);
        timer = window.setTimeout(() => setMounted(false), 160);
      }
    }),
  );
  // the active folder in view when the list arrives (initialFirstVisibleItemIndex)
  createEffect(
    on(projects, (p) => {
      if (!p || !list) return;
      queueMicrotask(() => list?.querySelector('.proj-row.on')?.scrollIntoView({ block: 'nearest' }));
    }),
  );
  const close = () => setProjectPickerOpen(false);
  const onKey = (e: KeyboardEvent) => {
    if (projectPickerOpen() && e.key === 'Escape') close();
  };
  onMount(() => document.addEventListener('keydown', onKey));
  onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    clearTimeout(timer);
  });

  const active = () => newChatProjectUri();
  const pick = (uri: string | null) => {
    chooseProject(uri);
    close();
  };
  const browse = () => {
    close();
    pickFolder((p) => {
      if (p) chooseProject(p.uri);
    });
  };
  const forget = (p: ProjectView) => {
    send({ type: 'forgetProject', path: p.path });
    setProjects((list) => list?.filter((x) => x.path !== p.path) ?? null);
    if (samePath(active(), p.uri)) chooseProject(null);
    showToast(`Removed ${p.name} from the list`);
  };

  return (
    <Show when={mounted()}>
      <Portal>
        <div class="dialog-scrim proj-scrim" classList={{ shown: shown() }} onClick={(e) => (e.stopPropagation(), close())}>
          <div class="proj-dialog dialog" onClick={(e) => e.stopPropagation()}>
            <div class="proj-head">
              <span class="proj-head-icon">
                <Icon name="folder_special" size={22} />
              </span>
              <div class="proj-titles">
                <div class="proj-title">Select Workspace</div>
                <div class="proj-sub">
                  {projects() ? `${projects()!.length} available workspace${projects()!.length === 1 ? '' : 's'}` : 'Loading…'}
                </div>
              </div>
              <IconButton icon="refresh_f" size={32} iconSize={18} color={alpha('var(--on-surface-variant)', 0.8)} title="Refresh" onClick={load} />
              <IconButton icon="close_o" size={32} iconSize={18} color={alpha('var(--on-surface-variant)', 0.8)} title="Close" onClick={close} />
            </div>
            <div class="proj-list" ref={list}>
              {/* the VS Code window's own folder(s) first: a new chat uses it unless another one is picked */}
              <For each={(projects() ?? []).filter((p) => p.source === 'workspace')}>
                {(p) => (
                  <ProjectRow
                    selected={samePath(active(), p.uri)}
                    current
                    name={`Current folder · ${p.name || p.path.substring(p.path.lastIndexOf('/') + 1)}`}
                    detail={p.path}
                    meta={[p.chats ? `${p.chats} chat${p.chats === 1 ? '' : 's'}` : null, p.lastUsed ? relativeTime(p.lastUsed) : null].filter(Boolean).join(' · ')}
                    onClick={() => pick(p.uri)}
                  />
                )}
              </For>
              <ProjectRow
                selected={!active()}
                general
                name="General (No Workspace)"
                detail="Chat without attaching to a directory"
                onClick={() => pick(null)}
              />
              <Show when={projects()} fallback={<div class="proj-loading"><span class="head-spinner" /></div>}>
                <For each={projects()!.filter((p) => p.source !== 'workspace')}>
                  {(p) => (
                    <ProjectRow
                      selected={samePath(active(), p.uri)}
                      name={p.name || p.path.substring(p.path.lastIndexOf('/') + 1) || 'Workspace'}
                      detail={p.path}
                      meta={[
                        p.chats ? `${p.chats} chat${p.chats === 1 ? '' : 's'}` : null,
                        p.lastUsed ? relativeTime(p.lastUsed) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      onClick={() => pick(p.uri)}
                      onForget={p.source === 'saved' ? () => forget(p) : undefined}
                    />
                  )}
                </For>
              </Show>
            </div>
            <button class="proj-browse" onClick={browse}>
              <Icon name="folder_open" size={18} />
              Browse or Open Other Folder...
            </button>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

function ProjectRow(props: {
  selected: boolean;
  general?: boolean;
  current?: boolean;
  name: string;
  detail: string;
  meta?: string;
  onClick: () => void;
  onForget?: () => void;
}) {
  return (
    <div class="proj-row" classList={{ on: props.selected }} role="button" tabIndex={0} onClick={props.onClick} onKeyDown={(e) => e.key === 'Enter' && props.onClick()}>
      <span class="proj-icon" classList={{ round: !!props.general, current: !!props.current }}>
        <Icon name={props.general ? 'public' : props.current ? 'folder_special' : 'folder'} size={18} />
      </span>
      <span class="proj-text">
        <span class="proj-name-row">
          <span class="proj-name">{props.name}</span>
          <Show when={props.selected}>
            <span class="proj-active">Active</span>
          </Show>
        </span>
        <span class="proj-detail" classList={{ path: !props.general }}>
          {props.detail}
        </span>
        <Show when={props.meta}>
          <span class="proj-meta">{props.meta}</span>
        </Show>
      </span>
      <Show when={props.onForget && !props.selected}>
        <IconButton
          class="proj-forget"
          icon="close_o"
          size={28}
          iconSize={16}
          title="Remove from the list"
          onClick={(e) => {
            e.stopPropagation();
            props.onForget!();
          }}
        />
      </Show>
      <Show when={props.selected}>
        <span class="proj-check">
          <Icon name="check" size={15} />
        </span>
      </Show>
    </div>
  );
}
