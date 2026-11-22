// Import a crew (docs/crew/PLAN.md §14): a ready-made crew from the library, a GitHub link (AntiGem, OpenMausBot or
// BotMRR teams) or pasted text → a review (faces, rooms, what it needs, what was taken out or left out) → Add.
import { createEffect, createSignal, For, on, Show } from 'solid-js';
import type { ImportPreviewView } from '@shared/protocol';
import { host } from '../host';
import { crewAction } from '../state/crew';
import { Dialog, Icon } from '../ui/primitives';
import { Avatar } from './Groups';

const [library, setLibrary] = createSignal<{ id: string; name: string; tagline: string; emojis: string }[]>([]);
const [preview, setPreview] = createSignal<ImportPreviewView | null>(null);
const [error, setError] = createSignal<string | null>(null);
const [busy, setBusy] = createSignal(false);
host.onMessage((m) => {
  if (m.type !== 'crewImport') return;
  if (m.library) setLibrary(m.library);
  if (m.preview !== undefined || m.error !== undefined) {
    setPreview(m.preview ?? null);
    setError(m.error ?? null);
    setBusy(false);
  }
});

export function CrewImportDialog(props: { open: boolean; onClose: () => void }) {
  const [url, setUrl] = createSignal('');
  const [text, setText] = createSignal('');
  const [source, setSource] = createSignal<Record<string, string> | null>(null);
  createEffect(
    on(
      () => props.open,
      (o) => {
        if (!o) return;
        setPreview(null);
        setError(null);
        setSource(null);
        crewAction('library');
      },
    ),
  );
  const look = (src: Record<string, string>) => {
    setSource(src);
    setBusy(true);
    setError(null);
    crewAction('importPreview', null, src);
  };
  const add = () => {
    const s = source();
    if (!s) return;
    crewAction('importApply', null, s);
    props.onClose();
  };
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={preview() ? `Add "${preview()!.name}"?` : 'Add a crew'}
      width={520}
      actions={
        <>
          <Show when={preview()}>
            <button class="text-btn" onClick={() => (setPreview(null), setSource(null))}>
              Back
            </button>
          </Show>
          <span class="flex1" />
          <button class="text-btn" onClick={props.onClose}>
            Cancel
          </button>
          <Show when={preview()}>
            <button class="filled-btn" onClick={add}>
              Add {preview()!.bots.length} bot{preview()!.bots.length === 1 ? '' : 's'}
            </button>
          </Show>
        </>
      }
    >
      <Show when={preview()} fallback={<Pick busy={busy()} error={error()} url={url()} setUrl={setUrl} text={text()} setText={setText} look={look} />}>
        <Review p={preview()!} />
      </Show>
    </Dialog>
  );
}

function Pick(props: { busy: boolean; error: string | null; url: string; setUrl: (s: string) => void; text: string; setText: (s: string) => void; look: (s: Record<string, string>) => void }) {
  return (
    <div class="gc-form">
      <div class="gc-label">Ready-made crews</div>
      <div class="ci-lib">
        <For each={library()}>
          {(l) => (
            <button class="ci-card" onClick={() => props.look({ library: l.id })}>
              <span class="ci-emojis">{l.emojis}</span>
              <span class="ci-card-text">
                <b>{l.name}</b>
                <span class="gc-muted">{l.tagline}</span>
              </span>
            </button>
          )}
        </For>
      </div>
      <div class="gc-label">From a GitHub link</div>
      <div class="ci-row">
        <input class="gc-input" placeholder="https://github.com/someone/crews/blob/main/team.md (AntiGem, OpenMausBot or BotMRR)" value={props.url} onInput={(e) => props.setUrl(e.currentTarget.value)} />
        <button class="text-btn" disabled={!props.url.trim() || props.busy} onClick={() => props.look({ url: props.url.trim() })}>
          Look
        </button>
      </div>
      <div class="gc-label">Or paste a crew package</div>
      <textarea class="gc-input gc-textarea" rows={4} placeholder={'---\nantigem-crew: 1\nname: …'} value={props.text} onInput={(e) => props.setText(e.currentTarget.value)} />
      <div class="ci-row">
        <span class="gc-muted">Every crew is checked first: secrets are taken out, access is at most Edit, automations arrive paused.</span>
        <button class="text-btn" disabled={!props.text.trim() || props.busy} onClick={() => props.look({ text: props.text })}>
          Look
        </button>
      </div>
      <Show when={props.busy}>
        <div class="gc-muted">Reading it…</div>
      </Show>
      <Show when={props.error}>
        <div class="gc-hint warn">{props.error}</div>
      </Show>
    </div>
  );
}

function Review(props: { p: ImportPreviewView }) {
  const p = () => props.p;
  return (
    <div class="gc-form ci-review">
      <Show when={p().tagline}>
        <div class="gc-muted">{p().tagline}</div>
      </Show>
      <div class="ci-bots">
        <For each={p().bots}>
          {(b) => (
            <div class="ci-bot">
              <Avatar emoji={b.emoji} color={b.color} size={30} />
              <div>
                <b>{b.name}</b>
                <Show when={b.name !== b.from}>
                  <span class="gc-muted"> (was {b.from})</span>
                </Show>
                <Show when={p().chief === b.name}>
                  <span class="gc-badge">Chief</span>
                </Show>
                <div class="gc-muted">
                  {b.title || 'bot'} · {b.access}
                  {b.engine ? ` · ${b.engine.toLowerCase()}` : ''}
                </div>
              </div>
            </div>
          )}
        </For>
      </div>
      <Show when={p().rooms.length}>
        <div class="gc-label">Rooms</div>
        <For each={p().rooms}>{(r) => <div>#{r.name}: {r.members.join(', ')}</div>}</For>
      </Show>
      <Show when={p().automations.length}>
        <div class="gc-label">Automations (arrive paused)</div>
        <For each={p().automations}>{(a) => <div>{a.when}: {a.bot} · {a.name}</div>}</For>
      </Show>
      <Show when={p().mcp.length}>
        <div class="gc-label">MCP servers it needs (add them yourself)</div>
        <For each={p().mcp}>{(m) => <div>{m.name}: {m.reason}</div>}</For>
      </Show>
      <div class="gc-muted ci-meta">
        <Icon name="shield" size={13} /> From {p().from} · {p().format === 'antigem' ? 'AntiGem crew' : p().format === 'botmrr' ? 'BotMRR team' : 'OpenMausBot team'}
        {p().playbooks ? ` · ${p().playbooks} playbook${p().playbooks === 1 ? '' : 's'}` : ''}
        {p().redacted ? ` · ${p().redacted} secret${p().redacted === 1 ? '' : 's'} taken out` : ''}
      </div>
      <Show when={p().leftOut.length || p().warnings.length}>
        <details class="ci-details">
          <summary>{p().leftOut.length + p().warnings.length} notes</summary>
          <For each={[...p().warnings, ...p().leftOut]}>{(w) => <div class="gc-muted">• {w}</div>}</For>
        </details>
      </Show>
    </div>
  );
}
