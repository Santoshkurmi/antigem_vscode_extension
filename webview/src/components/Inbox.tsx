// The Crew's Inbox, docked at the top of the Crew screens (home, a room, Mission Control): what each bot needs from
// you, with its face and why ("for Lead's job: deploy · it reaches outside"). Approvals: Allow / for this session /
// always / Deny with a note. A job's question: answer it here. A failed job: Retry / Dismiss. Setup (Antigravity's
// crew server): Add / Not now.
import { createSignal, For, Show } from 'solid-js';
import type { InboxItemView } from '@shared/protocol';
import { inbox, inboxAnswer } from '../state/inbox';
import { Icon } from '../ui/primitives';
import { Avatar } from './Groups';

const LABEL: Record<string, string> = {
  allow: 'Allow',
  allow_session: 'This session',
  allow_always: 'Always',
  deny: 'Deny',
  add: 'Add it',
  later: 'Not now',
  retry: 'Retry',
  dismiss: 'Dismiss',
};
const KIND: Record<string, string> = { approval: 'wants to', setup: 'setup', question: 'asks', failed: 'failed' };

/** Shows the first [max] items; the rest behind "N more". */
export function InboxDock(props: { max?: number }) {
  const [all, setAll] = createSignal(false);
  const shown = () => (all() ? inbox.items : inbox.items.slice(0, props.max ?? 2));
  const more = () => inbox.items.length - shown().length;
  return (
    <Show when={inbox.items.length}>
      <div class="ib-dock">
        <div class="ib-head">
          <Icon name="notifications" size={15} />
          <span>
            {inbox.items.length} thing{inbox.items.length === 1 ? '' : 's'} need{inbox.items.length === 1 ? 's' : ''} you
          </span>
          <Show when={inbox.items.length > (props.max ?? 2)}>
            <button class="text-btn ib-more" onClick={() => setAll((v) => !v)}>
              {all() ? 'Less' : `${more()} more`}
            </button>
          </Show>
        </div>
        <For each={shown()}>{(it) => <InboxCard item={it} />}</For>
      </div>
    </Show>
  );
}

function InboxCard(props: { item: InboxItemView }) {
  const it = () => props.item;
  const [note, setNote] = createSignal('');
  const [denying, setDenying] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  const send = (choice: string) => {
    if (choice === 'deny' && !denying()) {
      setDenying(true);
      return;
    }
    inboxAnswer(it().id, choice, choice === 'deny' || choice === 'answer' ? note().trim() || null : null);
    setNote('');
    setDenying(false);
  };
  const answerable = () => it().choices.includes('answer');
  return (
    <div class="ib-card" classList={{ outward: it().outward, risky: it().risk === 'RISKY', failed: it().kind === 'failed' }}>
      <div class="ib-top">
        <Show when={it().bot} fallback={<span class="ib-sys"><Icon name="settings" size={16} /></span>}>
          <Avatar emoji={it().bot!.emoji} color={it().bot!.color} size={26} />
        </Show>
        <div class="ib-main">
          <div class="ib-title">
            <Show when={it().bot}>
              <b>{it().bot!.name}</b> <span class="gc-muted">{KIND[it().kind] ?? ''}</span>{' '}
            </Show>
            <span>{it().title}</span>
            <Show when={it().outward}>
              <span class="ib-tag">outward</span>
            </Show>
            <Show when={it().risk === 'RISKY'}>
              <span class="ib-tag">risky</span>
            </Show>
          </div>
          <div class="ib-why">{it().why}</div>
          <Show when={it().detail}>
            <button class="ib-detail-toggle" onClick={() => setOpen((v) => !v)}>
              <Icon name={open() ? 'expand_less' : 'expand_more'} size={14} /> {open() ? 'Hide' : 'Details'}
            </button>
            <Show when={open()}>
              <pre class="ib-detail">{it().detail}</pre>
            </Show>
          </Show>
          <Show when={it().inChat}>
            <div class="gc-muted ib-note">Its card is in its chat too.</div>
          </Show>
        </div>
      </div>
      <Show when={answerable() || denying()}>
        <input
          class="gc-input ib-input"
          placeholder={answerable() ? `Answer ${it().bot?.name ?? ''}…` : 'Why not? (optional, it is told)'}
          value={note()}
          onInput={(e) => setNote(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && send(answerable() ? 'answer' : 'deny')}
        />
      </Show>
      <div class="ib-actions">
        <Show when={it().canOpen}>
          <button class="text-btn ib-open" onClick={() => inboxAnswer(it().id, 'open')} title="Open its chat">
            <Icon name="open_in_new" size={14} />
          </button>
        </Show>
        <span class="flex1" />
        <For each={it().choices}>
          {(c) =>
            c === 'answer' ? (
              <button class="filled-btn ib-btn" disabled={!note().trim()} onClick={() => send('answer')}>
                Answer
              </button>
            ) : (
              <button
                class={c === 'allow' || c === 'add' || c === 'retry' ? 'filled-btn ib-btn' : c === 'deny' ? 'text-btn danger ib-btn' : 'text-btn ib-btn'}
                title={c === 'allow_always' && it().key ? `Always allow ${it().key} for ${it().bot?.name ?? 'this bot'}` : undefined}
                onClick={() => send(c)}
              >
                {c === 'deny' && denying() ? 'Deny' : LABEL[c] ?? c}
              </button>
            )
          }
        </For>
      </div>
    </div>
  );
}
