// Attachments as the app shows them (ChatInputBar.kt's preview chips, MessageBubble.kt's images and file rows), plus
// what VS Code adds: folders and editor selections ("file.ts:12-30" code-range chips that reveal the lines).
import { createResource, Show } from 'solid-js';
import type { ChatAttachment } from '@shared/model';
import { readImage, send } from '../state/store';
import { Icon, type IconName } from '../ui/primitives';
import { openImageViewer } from './Media';
import { fileLinkToPath } from '../util/paths';

export type AttKind = 'image' | 'selection' | 'folder' | 'file' | 'audio';

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|svg)$/i;

export function attKind(a: ChatAttachment): AttKind {
  if (a.kind === 'selection') return 'selection';
  if (a.kind === 'folder') return 'folder';
  if (a.isAudio) return 'audio';
  if (a.kind === 'image' || a.isImage || a.mimeType?.startsWith('image/') || IMAGE_EXT.test(a.name)) return 'image';
  return 'file';
}

const pathOf = (a: ChatAttachment) => fileLinkToPath(a.path || a.localUri || '');

/** A src the webview can show right away (base64, http, data:), else null. */
export function directImageSrc(a: ChatAttachment): string | null {
  if (a.base64) return `data:${a.mimeType ?? 'image/png'};base64,${a.base64}`;
  const u = a.url || a.localUri || '';
  if (/^(https?:|data:image\/|blob:)/i.test(u)) return u;
  if (/^(https?:|data:image\/)/i.test(a.path)) return a.path;
  return null;
}

/** The image of an attachment: inline data, or the host reads the file (readImage) when only a path is known. */
export function useImageSrc(a: () => ChatAttachment) {
  const [local] = createResource(
    () => (directImageSrc(a()) ? null : pathOf(a()) || null),
    (p) => readImage(p),
  );
  return () => directImageSrc(a()) ?? local() ?? null;
}

/** "file.ts:12-30" (one line: "file.ts:12"). */
export function selectionLabel(name: string, start?: number | null, end?: number | null): string {
  if (!start) return name;
  return end && end !== start ? `${name}:${start}-${end}` : `${name}:${start}`;
}

/** "file.ts" + ":12-30": a long name shortens with "…", the line numbers always show. */
export function RangeName(props: { name: string; start?: number | null; end?: number | null; class: string }) {
  return (
    <span class="range-name">
      <span class={props.class}>{props.name}</span>
      <Show when={props.start}>
        <span class={`${props.class} range-lines`}>{selectionLabel('', props.start, props.end)}</span>
      </Show>
    </span>
  );
}

export function openAttachment(a: ChatAttachment, src?: string | null) {
  const k = attKind(a);
  const path = pathOf(a);
  if (k === 'selection' && path && a.lineStart) {
    send({ type: 'revealRange', path, startLine: a.lineStart, endLine: a.lineEnd ?? a.lineStart });
  } else if (k === 'image') {
    openImageViewer({ src: src ?? directImageSrc(a), path: directImageSrc(a) ? null : path || null, title: a.name });
  } else if (path) {
    send({ type: 'openFile', path });
  }
}

const ICONS: Record<AttKind, IconName> = { image: 'image', selection: 'code', folder: 'folder', file: 'file', audio: 'voice' };

/** A chip of the composer (ChatInputBar.kt attachment preview): thumbnail or icon, name, size, ✕. */
export function ComposerChip(props: { att: ChatAttachment; onRemove: () => void }) {
  const kind = () => attKind(props.att);
  const src = useImageSrc(() => props.att);
  // no size line (it said nothing useful); a range chip's name already says its lines (app.js:12-30)
  const sub = () => (kind() === 'folder' ? 'Folder' : null);
  return (
    <div class="att-chip" classList={{ [`k-${kind()}`]: true }}>
      <button class="att-main" title={pathOf(props.att) || props.att.name} onClick={() => openAttachment(props.att, src())}>
        <Show when={kind() === 'image' && src()} fallback={<Icon name={ICONS[kind()]} size={20} class="att-icon" />}>
          <img class="att-thumb" src={src()!} alt={props.att.name} />
        </Show>
        <span class="att-text">
          <Show when={kind() === 'selection'} fallback={<span class="att-name">{props.att.name}</span>}>
            <RangeName name={props.att.name.replace(/:\d+(-\d+)?$/, '')} start={props.att.lineStart} end={props.att.lineEnd} class="att-name" />
          </Show>
          <Show when={sub()}>
            <span class="att-sub">{sub()}</span>
          </Show>
        </span>
      </button>
      <button class="att-remove" title="Remove" onClick={props.onRemove}>
        <Icon name="close_o" size={13} />
      </button>
    </div>
  );
}

/**
 * A selection, file or folder sent with a prompt, shown back in the user's bubble (all the same chip): a click reveals
 * the lines / opens the file.
 */
export function SelectionChip(props: { att: ChatAttachment }) {
  const a = () => props.att;
  const base = () => a().name.replace(/:\d+(-\d+)?$/, '');
  return (
    <button
      class="user-range"
      title={`${pathOf(a())}${a().lineStart ? `:${a().lineStart}` : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        openAttachment(a());
      }}
    >
      <Icon name={attKind(a()) === 'selection' ? 'code' : attKind(a()) === 'folder' ? 'folder' : 'file'} size={15} />
      <span class="user-range-name">{base()}</span>
      <Show when={a().lineStart}>
        <span class="user-range-lines">{a().lineEnd && a().lineEnd !== a().lineStart ? `${a().lineStart}–${a().lineEnd}` : a().lineStart}</span>
      </Show>
    </button>
  );
}
