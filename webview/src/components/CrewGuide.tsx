// Getting started (Crew Phase 9): three steps on the Crew home (bots, a Chief, a first ask) until they are done and
// the guide is closed. Closing it is saved in crew.json (every window and the app see it).
import { For, Show, type JSX } from 'solid-js';
import { crew, crewAction, setEditBot } from '../state/crew';
import { Icon, IconButton } from '../ui/primitives';

interface Step {
  done: boolean;
  title: string;
  text: string;
  actions?: JSX.Element;
}

export function CrewGuide(props: { onImport: () => void }) {
  const chief = () => crew.bots.find((b) => b.id === crew.chiefId) ?? null;
  const steps = (): Step[] => [
    {
      done: crew.bots.length > 0,
      title: 'Add your bots',
      text: 'Each bot is its own agent with a persona, a model and tools. Start from a ready-made crew, or make one yourself.',
      actions: (
        <>
          <button class="filled-btn" onClick={() => props.onImport()}>
            <Icon name="download" size={15} /> Ready-made crews
          </button>
          <button class="text-btn" onClick={() => setEditBot('new')}>
            <Icon name="add" size={15} /> New bot
          </button>
        </>
      ),
    },
    {
      done: !!chief(),
      title: 'Choose a Chief',
      text: 'One bot you talk to. It splits the work, hands it to the others and answers you once, with the evidence.',
      actions: (
        <Show when={crew.bots.length}>
          <select class="gc-input" value="" onChange={(e) => e.currentTarget.value && crewAction('setChief', e.currentTarget.value)}>
            <option value="">Make a bot the Chief…</option>
            <For each={crew.bots}>{(b) => <option value={b.id}>{`${b.emoji} ${b.name}`}</option>}</For>
          </select>
        </Show>
      ),
    },
    {
      done: !!chief()?.dmChatId,
      title: 'Ask for something',
      text: 'For example “plan, build and test a small feature”. Follow the work in Mission Control; anything that needs you lands in the Inbox.',
      actions: (
        <Show when={chief()}>
          <button class="filled-btn" onClick={() => crewAction('openDm', chief()!.id)}>
            <Icon name="chat_bubble" size={15} /> Ask {chief()!.name}
          </button>
        </Show>
      ),
    },
  ];
  const next = () => steps().findIndex((s) => !s.done);
  return (
    <Show when={crew.loaded && !crew.tourDone}>
      <div class="crew-guide">
        <div class="crew-guide-head">
          <Icon name="rocket" size={18} />
          <b>{next() < 0 ? 'Your crew is ready' : 'Get your crew going'}</b>
          <span class="gc-muted">
            {steps().filter((s) => s.done).length}/{steps().length}
          </span>
          <span class="flex1" />
          <IconButton icon="close" title="Close this guide" size={28} iconSize={16} onClick={() => crewAction('tourDone', null, { done: true })} />
        </div>
        <For each={steps()}>
          {(s, i) => (
            <div class="crew-guide-step" classList={{ done: s.done, now: i() === next() }}>
              <span class="crew-guide-mark">{s.done ? <Icon name="check" size={14} /> : i() + 1}</span>
              <div class="crew-guide-body">
                <b>{s.title}</b>
                <Show when={i() === next()}>
                  <div class="gc-muted">{s.text}</div>
                  <Show when={s.actions}>
                    <div class="crew-guide-actions">{s.actions}</div>
                  </Show>
                </Show>
              </div>
            </div>
          )}
        </For>
        <Show when={next() < 0}>
          <div class="gc-muted crew-guide-more">
            More: rooms (several bots talk it through), Automations (a bot does something on a schedule or when tests fail), and each bot’s
            settings (memory, check its work, its own browser, voice).
          </div>
        </Show>
      </div>
    </Show>
  );
}
