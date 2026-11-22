// The Automations page (docs/crew/PLAN.md §13): every automation as a plain sentence ("Every weekday at 09:00, Scout:
// summarize yesterday's commits → #Ops"), on/off, last and next run, "Needs you: … [Fix]", its last runs, its
// webhook address; Run now, Undo, Delete, Open its chat. "+ New" sends your words to a bot, which sets it up.
import { createSignal, For, Show } from 'solid-js';
import type { AutomationView } from '@shared/protocol';
import { automationAction, autos, setAutoOpen } from '../state/automations';
import { crew } from '../state/crew';
import { copyText } from '../state/store';
import { Icon, IconButton } from '../ui/primitives';
import { relativeTime } from '../util/format';
import { Avatar } from './Groups';
import { InboxDock } from './Inbox';

const STATUS: Record<string, string> = { ok: 'posted', nothing: 'nothing new', failed: 'failed', 'needs-input': 'asked you', skipped: 'skipped' };

export function AutomationsPage() {
  const [text, setText] = createSignal('');
  const [bot, setBot] = createSignal('');
  const who = () => bot() || crew.chiefId || crew.bots[0]?.id || '';
  const send = () => {
    if (!text().trim() || !who()) return;
    automationAction('new', null, { botId: who(), text: text().trim() });
    setText('');
  };
  const live = () => autos.list.filter((a) => !a.done);
  const finished = () => autos.list.filter((a) => a.done);
  return (
    <div class="gc-page">
      <div class="gc-bar">
        <IconButton icon="arrow_back" title="Crew" size={36} iconSize={20} onClick={() => setAutoOpen(false)} />
        <div class="gc-bar-title">
          <div class="gc-bar-text">
            <div class="gc-title">Automations</div>
            <div class="gc-sub">
              {live().filter((a) => !a.paused).length} on
              {live().some((a) => a.needsFix) ? ` · ${live().filter((a) => a.needsFix).length} need you` : ''}
            </div>
          </div>
        </div>
      </div>
      <div class="gc-list">
        <InboxDock max={1} />
        <div class="au-new">
          <textarea
            class="gc-input au-new-text"
            rows={2}
            placeholder={`Say what should happen, and when. E.g. "Every weekday at 9:00, summarize yesterday's commits in #Ops" or "When tests fail, find out why"`}
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && send()}
          />
          <div class="au-new-row">
            <span class="gc-muted">Who does it</span>
            <select class="gc-input" value={who()} onChange={(e) => setBot(e.currentTarget.value)}>
              <For each={crew.bots}>{(b) => <option value={b.id}>{`${b.emoji} ${b.name}${b.id === crew.chiefId ? ' (Chief)' : ''}`}</option>}</For>
            </select>
            <span class="flex1" />
            <button class="filled-btn" disabled={!text().trim() || !who()} onClick={send} title="The bot sets it up in its chat (you see it happen)">
              <Icon name="add" size={16} /> Set it up
            </button>
          </div>
        </div>
        <Show
          when={autos.list.length}
          fallback={
            <Show when={autos.loaded}>
              <div class="gc-empty">
                <div class="gc-empty-art">⏰</div>
                <div class="gc-empty-title">No automations yet</div>
                <div class="gc-empty-text">
                  Bots can run on a schedule, when something happens in the editor (a test fails, a file is saved, a commit), when a webhook is called, or when a page, file or
                  process changes. Write it above, or just ask a bot in its chat.
                </div>
              </div>
            </Show>
          }
        >
          <For each={live()}>{(a) => <AutoRow a={a} />}</For>
          <Show when={finished().length}>
            <div class="crew-section-head">
              <span>Finished</span>
            </div>
            <For each={finished()}>{(a) => <AutoRow a={a} />}</For>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function AutoRow(props: { a: AutomationView }) {
  const a = () => props.a;
  const [open, setOpen] = createSignal(false);
  const fix = () => a().bot && automationAction('new', null, { botId: a().bot!.id, text: `Fix my automation ${a().id} ("${a().name}"): it ${a().needsFix}. Update it with crew_automation.` });
  return (
    <div class="au-row" classList={{ paused: a().paused || a().done, fix: !!a().needsFix }}>
      <div class="au-top">
        <Show when={a().bot} fallback={<span class="ib-sys">?</span>}>
          <Avatar emoji={a().bot!.emoji} color={a().bot!.color} size={26} />
        </Show>
        <button class="au-main" onClick={() => setOpen((v) => !v)}>
          <div class="au-sentence">{a().sentence}</div>
          <div class="gc-muted au-sub">
            <Show when={a().lastRunAt} fallback={<span>never ran</span>}>
              <span>
                {relativeTime(a().lastRunAt!)}: {STATUS[a().lastStatus ?? ''] ?? a().lastStatus}
              </span>
            </Show>
            <Show when={a().nextRunAt && !a().paused && !a().done}>
              <span> · next {new Date(a().nextRunAt!).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            </Show>
            <Show when={a().skipped}>
              <span> · {a().skipped} skipped (still running)</span>
            </Show>
          </div>
        </button>
        <Show when={!a().done}>
          <label class="au-switch" title={a().paused ? 'Off: turn it on' : 'On: turn it off'}>
            <input type="checkbox" checked={!a().paused} onChange={(e) => automationAction(e.currentTarget.checked ? 'resume' : 'pause', a().id)} />
            <span />
          </label>
        </Show>
      </div>
      <Show when={a().needsFix}>
        <div class="au-fix">
          <span>Needs you: {a().needsFix}</span>
          <button class="text-btn" onClick={fix}>
            Fix
          </button>
        </div>
      </Show>
      <Show when={open()}>
        <div class="mc-detail au-detail">
          <Show when={a().webhook}>
            <div class="mc-label">Webhook</div>
            <div class="au-hook">
              <code>POST {a().webhook!.url}</code>
              <button class="text-btn" onClick={() => copyText(`curl -X POST ${a().webhook!.url} -H "Authorization: Bearer ${a().webhook!.token}" -d '{}'`, 'Copied a curl command')}>
                Copy
              </button>
            </div>
          </Show>
          <Show when={a().runs.length}>
            <div class="mc-label">Last runs</div>
            <For each={a().runs}>
              {(r) => (
                <div class="au-run">
                  <span class="gc-muted">{relativeTime(r.at)}</span> <b>{STATUS[r.status] ?? r.status}</b> <span class="gc-muted">({r.trigger.slice(0, 80)})</span>
                  <Show when={r.result && r.status !== 'nothing'}>
                    <div class="au-run-result">{r.result}</div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
          <div class="mc-actions">
            <span class="gc-muted mc-usage">made by {a().createdBy}</span>
            <span class="flex1" />
            <Show when={a().canOpen}>
              <button class="text-btn" onClick={() => automationAction('open', a().id)}>
                <Icon name="open_in_new" size={15} /> Open chat
              </button>
            </Show>
            <Show when={!a().done}>
              <button class="text-btn" onClick={() => automationAction('runNow', a().id)}>
                <Icon name="play_arrow" size={15} /> Run now
              </button>
            </Show>
            <Show when={a().canUndo}>
              <button class="text-btn" onClick={() => automationAction('undo', a().id)}>
                <Icon name="replay" size={15} /> Undo last change
              </button>
            </Show>
            <button class="text-btn danger" onClick={() => automationAction('delete', a().id)}>
              <Icon name="delete_o" size={15} /> Delete
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
