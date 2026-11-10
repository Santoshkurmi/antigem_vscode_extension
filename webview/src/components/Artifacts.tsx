// ui/drawer/ArtifactsDrawerContent.kt in ChatScreen.kt's right-side overlay: a 55% black scrim (fade 220/200 ms) and a
// panel that slides in from the right (tween 260 / 220 ms, FastOutSlowIn), 85% wide. Opened from the layers button
// in an assistant reply's footer (shown when the chat has artifacts). A card opens the file in VS Code.
import { createEffect, createResource, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { ArtifactSnapshot } from '@shared/model';
import { readImage, send, state } from '../state/store';
import { openImageViewer } from './Media';
import { Icon, IconButton, nextFrame, type IconName } from '../ui/primitives';

export const [artifactsOpen, setArtifactsOpen] = createSignal(false);

const isImage = (a: ArtifactSnapshot) => {
  const s = `${a.name} ${a.absoluteUri}`.toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp)$/.test(s) || /\.(png|jpe?g)\?/.test(s);
};
const pathOf = (a: ArtifactSnapshot) => decodeURIComponent((a.absoluteUri || a.name).replace(/^file:\/\//, ''));
const baseName = (s: string) => s.substring(s.lastIndexOf('/') + 1);

function kindOf(a: ArtifactSnapshot): { title: string; icon: IconName; tint: string } {
  const has = (w: string) => a.name.toLowerCase().includes(w) || a.absoluteUri.toLowerCase().includes(w);
  if (isImage(a)) return { title: '', icon: 'image', tint: 'var(--info)' };
  if (has('plan')) return { title: 'Implementation Plan', icon: 'auto_awesome', tint: 'var(--claude)' };
  if (has('walkthrough')) return { title: 'Walkthrough', icon: 'description_o', tint: 'var(--agy)' };
  return { title: '', icon: 'file', tint: 'var(--accent-teal)' };
}

function displayTitle(a: ArtifactSnapshot): string {
  const k = kindOf(a);
  if (k.title) return k.title;
  if (a.name.trim()) {
    return baseName(a.name)
      .replace(/[_-]/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return baseName(a.absoluteUri);
}

export function ArtifactsDrawer() {
  const [mounted, setMounted] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  let timer: number | undefined;
  createEffect(
    on(artifactsOpen, (o) => {
      clearTimeout(timer);
      if (o) {
        setMounted(true);
        nextFrame(() => setShown(true));
      } else {
        setShown(false);
        timer = window.setTimeout(() => setMounted(false), 230);
      }
    }),
  );
  // another chat: its own artifacts (the panel closes, like the app's per-chat state)
  createEffect(on(() => state.chat.conversationId, () => setArtifactsOpen(false), { defer: true }));
  const close = () => setArtifactsOpen(false);
  const onKey = (e: KeyboardEvent) => {
    if (artifactsOpen() && e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  onMount(() => document.addEventListener('keydown', onKey, true));
  onCleanup(() => {
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(timer);
  });
  const list = () => state.chat.artifacts;
  return (
    <Show when={mounted()}>
      <Portal>
        <div class="art-scrim" classList={{ shown: shown() }} onClick={(e) => (e.stopPropagation(), close())}>
          <aside class="art-panel" onClick={(e) => e.stopPropagation()}>
            <div class="art-head">
              <span class="art-head-icon">
                <Icon name="layers" size={20} />
              </span>
              <div class="art-titles">
                <div class="art-title-row">
                  <span class="art-title">Artifacts</span>
                  <span class="art-count">{list().length}</span>
                </div>
                <div class="art-sub">Generated files, plans &amp; media</div>
              </div>
              <IconButton icon="close" size={32} iconSize={20} color="var(--on-surface-variant)" title="Close" onClick={close} />
            </div>
            <div class="art-divider" />
            <Show
              when={list().length > 0}
              fallback={
                <div class="art-empty">
                  <Icon name="folder_open" size={48} />
                  <div class="art-empty-title">No artifacts generated yet</div>
                  <div class="art-empty-text">Plans, walkthroughs, and generated images will appear here.</div>
                </div>
              }
            >
              <div class="art-list">
                <For each={list()}>{(a) => <ArtifactCard artifact={a} />}</For>
              </div>
            </Show>
          </aside>
        </div>
      </Portal>
    </Show>
  );
}

function ArtifactCard(props: { artifact: ArtifactSnapshot }) {
  const a = () => props.artifact;
  const k = () => kindOf(a());
  const title = () => displayTitle(a());
  const subtitle = () => baseName(a().name.trim() ? a().name : a().absoluteUri);
  const [thumb] = createResource(() => (isImage(a()) ? pathOf(a()) : null), (p) => readImage(p));
  const open = () => (isImage(a()) && thumb() ? openImageViewer({ src: thumb(), path: pathOf(a()), title: a().name }) : send({ type: 'openFile', path: pathOf(a()) }));
  return (
    <div class="art-card" role="button" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open()} title={pathOf(a())}>
      <div class="art-card-row">
        <Show
          when={thumb()}
          fallback={
            <span class="art-card-icon" style={{ color: k().tint, background: `color-mix(in srgb, ${k().tint} 16%, transparent)` }}>
              <Icon name={k().icon} size={20} />
            </span>
          }
        >
          {/* an image artifact: its thumbnail (46dp, rounded 8), a click opens the viewer */}
          <img
            class="art-thumb"
            src={thumb()!}
            alt=""
            onClick={(e) => {
              e.stopPropagation();
              openImageViewer({ src: thumb(), path: pathOf(a()), title: a().name });
            }}
          />
        </Show>
        <span class="art-card-text">
          <span class="art-card-title">{title()}</span>
          <Show when={subtitle() && subtitle() !== title()}>
            <span class="art-card-sub">{subtitle()}</span>
          </Show>
        </span>
        <IconButton
          class="art-save"
          icon="download"
          size={34}
          iconSize={17}
          color="var(--on-surface)"
          title="Save a copy…"
          onClick={(e) => {
            e.stopPropagation();
            send({ type: 'saveArtifact', path: pathOf(a()) });
          }}
        />
      </div>
      <Show when={a().summary.trim()}>
        <div class="art-summary">{a().summary}</div>
      </Show>
    </div>
  );
}
