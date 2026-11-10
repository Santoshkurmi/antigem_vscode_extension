// Files and folders dragged from VS Code's explorer (or the OS) onto the chat become composer chips: the host turns
// the dropped URIs into attachments (resolveDrop); dropped images are read here. VS Code lets a drag into a webview
// through only while Shift is held, so the overlay says so until it is.
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { resolveDrop, setFocusTick, showToast } from '../state/store';
import { Icon } from '../ui/primitives';
import { addComposerAttachments, imageFilesToChips } from './InputBar';

const URI_TYPES = ['application/vnd.code.uri-list', 'text/uri-list', 'resourceurls', 'codefiles'];
const accepts = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).some((t) => t === 'Files' || URI_TYPES.includes(t));

/** Every URI a drop carries (VS Code explorer, editor tabs, the OS file manager), without duplicates. */
function droppedUris(dt: DataTransfer): string[] {
  const out = new Set<string>();
  const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const t of ['application/vnd.code.uri-list', 'text/uri-list']) {
    const v = dt.getData(t);
    if (v) lines(v).forEach((u) => out.add(u));
  }
  for (const t of ['resourceurls', 'codefiles']) {
    const v = dt.getData(t);
    if (!v) continue;
    try {
      const list = JSON.parse(v);
      if (Array.isArray(list))
        for (const x of list) {
          const s = typeof x === 'string' ? x : typeof x?.uri === 'string' ? x.uri : typeof x?.path === 'string' ? x.path : null;
          if (s) out.add(/^[a-z][\w+.-]*:/i.test(s) ? s : `file://${encodeURI(s)}`);
        }
    } catch {
      /* not JSON */
    }
  }
  return [...out];
}

export function DropZone() {
  const [over, setOver] = createSignal(false);
  const [shift, setShift] = createSignal(false);
  let depth = 0;
  const reset = () => {
    depth = 0;
    setOver(false);
  };
  const enter = (e: DragEvent) => {
    if (!accepts(e.dataTransfer)) return;
    depth++;
    setOver(true);
    setShift(e.shiftKey);
  };
  const overEv = (e: DragEvent) => {
    if (!accepts(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setShift(e.shiftKey);
    if (!over()) setOver(true);
  };
  const leave = (e: DragEvent) => {
    if (!over()) return;
    depth = Math.max(0, depth - 1);
    // left the window
    if (depth === 0 || (e.clientX <= 0 && e.clientY <= 0)) reset();
  };
  const drop = (e: DragEvent) => {
    const dt = e.dataTransfer;
    reset();
    if (!dt || !accepts(dt)) return;
    e.preventDefault();
    const uris = droppedUris(dt);
    const files = Array.from(dt.files);
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (uris.length) resolveDrop(uris, (atts) => (atts.length ? addComposerAttachments(atts) : showToast('Nothing to attach from that drop', 'warning')));
    else if (images.length) imageFilesToChips(images);
    else if (files.length) showToast('Drag files from the VS Code explorer (hold Shift) to attach them', 'info');
    setFocusTick((n) => n + 1);
  };
  onMount(() => {
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', overEv);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('dragend', reset);
  });
  onCleanup(() => {
    window.removeEventListener('dragenter', enter);
    window.removeEventListener('dragover', overEv);
    window.removeEventListener('dragleave', leave);
    window.removeEventListener('drop', drop);
    window.removeEventListener('dragend', reset);
  });
  return (
    <div class="drop-zone" classList={{ shown: over() }} aria-hidden={!over()}>
      <div class="drop-card" classList={{ ready: shift() }}>
        <span class="drop-icon">
          <Icon name={shift() ? 'download' : 'add'} size={28} />
        </span>
        <div class="drop-title">{shift() ? 'Drop to attach' : 'Hold Shift to drop'}</div>
        <div class="drop-sub">
          <Show when={shift()} fallback={'VS Code lets files into the chat while Shift is held'}>
            Files and folders become chips in the message box
          </Show>
        </div>
      </div>
    </div>
  );
}
