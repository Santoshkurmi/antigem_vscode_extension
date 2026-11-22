// Crew (src/core/crew): the bots on the Crew home (above the rooms), the bot editor (look, SOUL.md, agent and model,
// access, folder) and the bot's face above its DM. A bot's DM is a normal chat of its agent.
import { createEffect, createSignal, For, on, Show } from 'solid-js';
import type { AgentKind } from '@shared/model';
import type { CrewBotView } from '@shared/protocol';
import { chatCrewTag, crew, crewAction, editBot, setEditBot } from '../state/crew';
import { setGroupsOpen, setOpenGroupId } from '../state/groups';
import { enabledAgents, requestModels, state } from '../state/store';
import { AgentSelect, Avatar, ConfirmDialog, Field, ModelSelect, PALETTE, Segmented } from './Groups';
import { Dialog, Icon, IconButton } from '../ui/primitives';
import { agentLabel, shortModelName } from '../util/format';
import { canSpeak, speak, voices } from '../util/speech';
import { spendText } from './CrewSpend';

type Access = 'talk' | 'read' | 'edit' | 'auto' | 'full';

export const ACCESS_LEVELS: { id: Access; label: string; hint: string }[] = [
  { id: 'talk', label: 'Talk', hint: 'No tools but its crew tools: conversation only.' },
  { id: 'read', label: 'Read', hint: 'Reads files, searches and browses; changes nothing.' },
  { id: 'edit', label: 'Edit', hint: 'Reads and changes files in its folder and runs ordinary commands; anything else asks you.' },
  { id: 'auto', label: 'Auto', hint: 'Works on its own; risky actions are reviewed before they run.' },
  { id: 'full', label: 'Full', hint: 'Does what the work needs; pushing, sending and posting still ask you.' },
];
const accessLabel = (a: string) => ACCESS_LEVELS.find((x) => x.id === a)?.label ?? a;

// ------------------------------------------------------------------------------------------------ Crew home: bots

/** The Chief: your single point of contact (Ask = its chat), its Problems thread, its recent changes with Undo. */
export function CrewChief() {
  const chief = () => crew.bots.find((b) => b.id === crew.chiefId) ?? null;
  return (
    <Show when={crew.bots.length}>
      <div class="crew-chief">
        <Show
          when={chief()}
          fallback={
            <div class="crew-chief-pick">
              <span class="gc-muted">No Chief yet: one bot you talk to, that hands work to the others.</span>
              <select class="gc-input" value="" onChange={(e) => e.currentTarget.value && crewAction('setChief', e.currentTarget.value)}>
                <option value="">Make a bot the Chief…</option>
                <For each={crew.bots}>{(b) => <option value={b.id}>{`${b.emoji} ${b.name}`}</option>}</For>
              </select>
            </div>
          }
        >
          {(c) => (
            <>
              <div class="crew-chief-top">
                <Avatar emoji={c().emoji} color={c().color} size={30} />
                <div class="crew-chief-text">
                  <b>{c().name}</b> <span class="gc-muted">is your Chief: tell it what you want, it hands the work out</span>
                </div>
                <button class="filled-btn crew-chief-ask" onClick={() => crewAction('openDm', c().id)}>
                  <Icon name="chat_bubble" size={15} /> Ask
                </button>
                <Show when={crew.hasProblems}>
                  <IconButton icon="report_o" title="Its Problems thread (failed jobs it looked at)" size={30} iconSize={17} onClick={() => crewAction('openProblems')} />
                </Show>
              </div>
              <Show when={crew.changes.some((x) => !x.undone)}>
                <div class="crew-changes">
                  <For each={crew.changes.filter((x) => !x.undone).slice(0, 3)}>
                    {(x) => (
                      <div class="crew-change">
                        <span>{x.summary}</span>
                        <button class="text-btn" onClick={() => crewAction('undoManage', null, { id: x.id })}>
                          Undo
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  );
}

/** What every bot knows about you: lines you add, and lines bots added (with who), each removable. */
export function CrewAboutMe() {
  const [open, setOpen] = createSignal(false);
  const [text, setText] = createSignal('');
  const add = () => {
    if (!text().trim()) return;
    crewAction('aboutMe', null, { text: text().trim() });
    setText('');
  };
  return (
    <Show when={crew.bots.length}>
      <div class="crew-about">
        <button class="crew-about-head" onClick={() => setOpen((v) => !v)}>
          <Icon name="person" size={16} />
          <span>About you</span>
          <span class="gc-muted">{crew.aboutMe.length ? `${crew.aboutMe.length} thing${crew.aboutMe.length === 1 ? '' : 's'} every bot knows` : 'what every bot should know about you'}</span>
          <Icon name={open() ? 'expand_less' : 'expand_more'} size={16} />
        </button>
        <Show when={open()}>
          <For each={crew.aboutMe}>
            {(l) => (
              <div class="crew-change">
                <span>
                  {l.text} <span class="gc-muted">· {l.by}</span>
                </span>
                <button class="text-btn" onClick={() => crewAction('aboutMe', null, { remove: l.id })}>
                  Remove
                </button>
              </div>
            )}
          </For>
          <div class="crew-goal-new">
            <input class="gc-input" placeholder="I like short answers; I work in TypeScript; call me Sam" value={text()} onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button class="text-btn" disabled={!text().trim()} onClick={add}>
              Add
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
}

/** The whole crew at once: its level (each bot's own, or raised to Edit / Auto / Full up to each ceiling) and pause. */
export function CrewControls() {
  return (
    <div class="crew-controls">
      <label class="crew-level" title="Raise every bot at Edit or above at once (never above a bot's highest level). Pushing, sending and posting always ask.">
        <span class="gc-muted">Crew level</span>
        <select class="gc-input" value={crew.crewAccess ?? ''} onChange={(e) => crewAction('setCrewAccess', null, { access: e.currentTarget.value || null })}>
          <option value="">Each bot’s own</option>
          <option value="edit">Edit</option>
          <option value="auto">Auto</option>
          <option value="full">Full</option>
        </select>
      </label>
      <span class="flex1" />
      <button class={crew.paused ? 'filled-btn crew-pause' : 'text-btn crew-pause'} onClick={() => crewAction('setPaused', null, { paused: !crew.paused })} title={crew.paused ? 'Let the crew work again' : 'Stop every bot: no room turns, no jobs (running work stops and waits). DMs still answer you.'}>
        <Icon name={crew.paused ? 'play_arrow' : 'pause'} size={16} /> {crew.paused ? 'Resume all' : 'Pause all'}
      </button>
    </div>
  );
}

export function CrewBots() {
  return (
    <div class="crew-section">
      <div class="crew-section-head">
        <span>Bots</span>
        <button class="crew-add" onClick={() => setEditBot('new')}>
          <Icon name="add" size={16} /> New bot
        </button>
      </div>
      <Show
        when={crew.bots.length}
        fallback={
          <Show when={crew.loaded}>
            <button class="crew-empty-row" onClick={() => setEditBot('new')}>
              <span class="crew-empty-art">🤖</span>
              <span>
                <b>Make your first bot.</b> Each one is its own agent with a persona, a model and its own tools. Chat with it alone, or put it in a room
                with others.
              </span>
            </button>
          </Show>
        }
      >
        <For each={crew.bots}>{(b) => <BotRow bot={b} />}</For>
      </Show>
    </div>
  );
}

function BotRow(props: { bot: CrewBotView }) {
  const b = () => props.bot;
  return (
    <div class="crew-row" classList={{ paused: b().paused }}>
      <button class="crew-row-main" onClick={() => setEditBot(b().id)} title="Edit this bot">
        <div class="crew-avatar-wrap" classList={{ working: b().working }}>
          <Avatar emoji={b().emoji} color={b().color} size={36} />
        </div>
        <div class="crew-row-text">
          <div class="crew-row-top">
            <span class="crew-row-name">{b().name}</span>
            <Show when={b().title}>
              <span class="crew-row-title">{b().title}</span>
            </Show>
            <Show when={b().working}>
              <span class="gc-live" title={b().busyWhere ? `Answering in ${b().busyWhere}` : 'Answering now'} />
            </Show>
          </div>
          <div class="crew-row-sub">
            {agentLabel(b().agent)}
            <Show when={b().modelId}> · {shortModelName(b().modelId!)}</Show> · {accessLabel(b().effectiveAccess)}
            <Show when={b().rooms.length}> · in {b().rooms.map((r) => r.name).join(', ')}</Show>
            <Show when={b().softNote}>
              <span class="crew-soft" title={b().softNote!}>
                <Icon name="info_o" size={13} />
              </span>
            </Show>
          </div>
        </div>
      </button>
      <IconButton icon="chat_bubble" title={`Message ${b().name}`} size={34} iconSize={18} onClick={() => crewAction('openDm', b().id)} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ bot editor

export function CrewBotEditor() {
  const bot = () => {
    const id = editBot();
    return id && id !== 'new' ? (crew.bots.find((b) => b.id === id) ?? null) : null;
  };
  const open = () => editBot() === 'new' || !!bot();
  const [name, setName] = createSignal('');
  const [title, setTitle] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [aliases, setAliases] = createSignal('');
  const [emoji, setEmoji] = createSignal('');
  const [color, setColor] = createSignal(PALETTE[0]);
  const [soul, setSoul] = createSignal('');
  const [soulBase, setSoulBase] = createSignal('');
  const [agent, setAgent] = createSignal<AgentKind>(state.defaultAgent);
  const [model, setModel] = createSignal<string | null>(null);
  const [effort, setEffort] = createSignal('default');
  const [access, setAccess] = createSignal<Access>('edit');
  const [ceiling, setCeiling] = createSignal<Access>('edit');
  const [chattiness, setChattiness] = createSignal(40);
  const [checkWork, setCheckWork] = createSignal<string | null>(null);
  const [browser, setBrowser] = createSignal(false);
  const [voice, setVoice] = createSignal<string | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal(false);

  // filled when the editor opens on a bot (or a new one), not on every update from the host
  createEffect(
    on(
      () => (open() ? (bot()?.id ?? 'new') : null),
      (key) => {
        if (!key) return;
        const b = bot();
        setName(b?.name ?? '');
        setTitle(b?.title ?? '');
        setDescription(b?.description ?? '');
        setAliases((b?.aliases ?? []).join(', '));
        setEmoji(b?.emoji ?? '');
        setColor(b?.color ?? PALETTE[crew.bots.length % PALETTE.length]);
        setSoul(b?.soul ?? '');
        setSoulBase(b?.soul ?? '');
        setAgent(b?.agent ?? enabledAgents()[0] ?? state.defaultAgent);
        setModel(b?.modelId ?? null);
        setEffort(b?.effort ?? 'default');
        setAccess((b?.access as Access) ?? 'edit');
        setCeiling((b?.accessCeiling as Access) ?? 'edit');
        setChattiness(b?.chattiness ?? 40);
        setCheckWork(b?.checkWork ?? null);
        setBrowser(b?.browser ?? false);
        setVoice(b?.voice ?? null);
      },
    ),
  );
  // SOUL.md edited in its editor tab meanwhile: the box follows unless you typed here too
  createEffect(
    on(
      () => bot()?.soul,
      (s) => {
        if (s === undefined || soul() !== soulBase()) return;
        setSoul(s);
        setSoulBase(s);
      },
      { defer: true },
    ),
  );
  createEffect(() => {
    if (open()) requestModels(agent());
  });
  const levelIndex = (a: Access) => ACCESS_LEVELS.findIndex((x) => x.id === a);
  const close = () => setEditBot(null);
  const save = () => {
    const data: Record<string, unknown> = {
      name: name().trim(),
      title: title().trim(),
      description: description().trim(),
      aliases: aliases(),
      emoji: emoji().trim(),
      color: color(),
      agent: agent(),
      modelId: model(),
      effort: effort(),
      access: access(),
      accessCeiling: levelIndex(ceiling()) < levelIndex(access()) ? access() : ceiling(),
      chattiness: chattiness(),
      checkWork: checkWork(),
      browser: browser(),
      voice: voice(),
    };
    if (!data.name) return;
    const b = bot();
    if (b) {
      if (soul() !== soulBase()) data.soul = soul();
      crewAction('updateBot', b.id, data);
      close();
    } else crewAction('createBot', null, { ...data, soul: soul() });
  };
  const softNote = () => crew.softNotes[agent()]?.[access()] ?? null;
  return (
    <>
      <Dialog
        open={open()}
        onClose={close}
        title={bot() ? bot()!.name : 'New bot'}
        width={540}
        actions={
          <>
            <Show when={bot()}>
              <button class="text-btn danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
              <button class="text-btn" onClick={() => (crewAction('openDm', bot()!.id), close())}>
                <Icon name="chat_bubble" size={15} /> Message
              </button>
            </Show>
            <span class="flex1" />
            <button class="text-btn" onClick={close}>
              Cancel
            </button>
            <button class="filled-btn" disabled={!name().trim()} onClick={save}>
              {bot() ? 'Save' : 'Create'}
            </button>
          </>
        }
      >
        <div class="gc-form crew-form">
          <div class="gc-avatar-edit">
            <Avatar emoji={emoji().trim() || (name().trim()[0] ?? '?').toUpperCase()} color={color()} size={52} />
            <div class="gc-avatar-fields">
              <div class="gc-row2">
                <Field label="Name" grow>
                  <input class="gc-input" value={name()} placeholder="Ada" maxLength={24} onInput={(e) => setName(e.currentTarget.value)} />
                </Field>
                <Field label="Emoji">
                  <input class="gc-input gc-emoji" value={emoji()} placeholder="🧭" maxLength={8} onInput={(e) => setEmoji(e.currentTarget.value)} />
                </Field>
              </div>
              <div class="gc-swatches">
                <For each={PALETTE}>{(c) => <button class="gc-swatch" classList={{ on: color() === c }} style={{ background: c }} title={c} onClick={() => setColor(c)} />}</For>
              </div>
            </div>
          </div>
          <div class="gc-row2">
            <Field label="Role" grow>
              <input class="gc-input" value={title()} placeholder="planner, tester, reviewer…" maxLength={80} onInput={(e) => setTitle(e.currentTarget.value)} />
            </Field>
          </div>
          <Field label="What it does" hint="One line teammates see in the roster.">
            <input class="gc-input" value={description()} placeholder="Breaks features into steps and keeps the plan up to date." maxLength={400} onInput={(e) => setDescription(e.currentTarget.value)} />
          </Field>
          <Field label="Answers to" hint="Topics that send a room message to it in Auto mode (comma-separated). Learned ones show up here when you re-ask it after someone else was picked.">
            <input class="gc-input" value={aliases()} placeholder="deploy, docker, ci" onInput={(e) => setAliases(e.currentTarget.value)} />
          </Field>
          <Field label="Soul" hint="Who it is, how it works and talks, what it must always or never do (SOUL.md, its system prompt). Editing it keeps its memory.">
            <textarea
              class="gc-input gc-textarea crew-soul"
              rows={7}
              placeholder="You are Ada, a calm senior planner. You split work into small steps, name the risks first and never write code yourself."
              value={soul()}
              onInput={(e) => setSoul(e.currentTarget.value)}
            />
            <Show when={bot()}>
              <button class="text-btn crew-soul-open" onClick={() => crewAction('openSoul', bot()!.id)}>
                <Icon name="open_in_new" size={14} /> Open SOUL.md in an editor tab
              </button>
            </Show>
          </Field>
          <div class="gc-row2">
            <Field label="Agent" grow>
              <AgentSelect
                value={agent()}
                onChange={(a) => {
                  setAgent(a);
                  setModel(null);
                }}
              />
            </Field>
            <Field label="Model" grow>
              <ModelSelect agent={agent()} value={model()} onChange={setModel} />
            </Field>
            <Field label="Effort">
              <select class="gc-input" value={effort()} onChange={(e) => setEffort(e.currentTarget.value)}>
                <option value="default">Default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </Field>
          </div>
          <Field label="Access" hint={ACCESS_LEVELS.find((a) => a.id === access())?.hint}>
            <Segmented options={ACCESS_LEVELS} value={access()} onChange={setAccess} />
          </Field>
          <Show when={softNote()}>
            <div class="gc-hint warn">{softNote()}</div>
          </Show>
          <Show when={agent() === 'AGY' && crew.agyCrewServer !== 'allowed'}>
            <div class="gc-hint warn crew-agy">
              <span>Its crew tools (crew_roster, crew_assign…) need the AntiGem Crew server in Antigravity’s MCP servers. Until you add it, it works without them.</span>
              <button class="text-btn" onClick={() => crewAction('allowAgyServer', null, { allow: true })}>
                Add it
              </button>
            </div>
          </Show>
          <Field label="Highest level" hint="The crew switch (and later the Chief) can raise it up to here, never above.">
            <select class="gc-input" value={levelIndex(ceiling()) < levelIndex(access()) ? access() : ceiling()} onChange={(e) => setCeiling(e.currentTarget.value as Access)}>
              <For each={ACCESS_LEVELS.slice(levelIndex(access()))}>{(a) => <option value={a.id}>{a.label}</option>}</For>
            </select>
          </Field>
          <Show when={bot()}>
            <Field label="Work folder" hint="Where it works at Edit and up. Talk and Read bots work in their own empty folder.">
              <div class="crew-folder">
                <span class="crew-folder-path" title={bot()!.folder ?? ''}>
                  {bot()!.folder ?? 'The project open in this window'}
                </span>
                <button class="text-btn" onClick={() => crewAction('pickFolder', bot()!.id)}>
                  Choose…
                </button>
                <Show when={bot()!.folder}>
                  <button class="text-btn" onClick={() => crewAction('pickFolder', bot()!.id, { clear: true })}>
                    Use the project
                  </button>
                </Show>
              </div>
            </Field>
          </Show>
          <Field label={`Chattiness in rooms: ${chattiness()}`} hint="How often it joins in when nobody mentioned it.">
            <div class="gc-slider">
              <span class="gc-muted">Quiet</span>
              <input type="range" min={0} max={100} step={5} value={chattiness()} onInput={(e) => setChattiness(+e.currentTarget.value)} />
              <span class="gc-muted">Chatty</span>
            </div>
          </Field>
          <Field label="Check its work" hint="Before work it was handed counts as done, another model reads its answer and what it really ran. Issues go back to it (at most twice more).">
            <select class="gc-input" value={checkWork() ?? ''} onChange={(e) => setCheckWork(e.currentTarget.value || null)}>
              <option value="">Off</option>
              <option value="auto">A quick model of another agent checks it</option>
              <For each={crew.bots.filter((x) => x.id !== bot()?.id)}>{(x) => <option value={x.id}>{`${x.emoji} ${x.name} checks it`}</option>}</For>
            </select>
          </Field>
          <label class="gc-check" title="AntiGem's Browser: your Chrome through the AntiGem extension, in the AntiGem tab group; blocked sites stay blocked. Not at Talk.">
            <input type="checkbox" checked={browser()} onChange={(e) => setBrowser(e.currentTarget.checked)} /> Its own browser{' '}
            <span class="gc-muted">{agent() === 'CLAUDE' || agent() === 'CODEX' ? '(your Chrome, AntiGem tab group)' : '(Claude Code and Codex only; other agents use it only if you added it to their MCP servers)'}</span>
          </label>
          <Show when={canSpeak()}>
            <Field label="Voice" hint="Its room messages are read in this voice (the speaker on a message, or read-aloud in a room).">
              <div class="crew-voice">
                <select class="gc-input" value={voice() ?? ''} onChange={(e) => setVoice(e.currentTarget.value || null)}>
                  <option value="">Default voice</option>
                  <For each={voices()}>{(v) => <option value={v.name}>{`${v.name} (${v.lang})`}</option>}</For>
                </select>
                <IconButton icon="record_voice_over" title="Try it" size={32} iconSize={17} onClick={() => speak('try', `Hi, I'm ${name().trim() || 'your new bot'}.`, voice())} />
              </div>
            </Field>
          </Show>
          <Show when={bot()?.today}>
            <div class="gc-muted crew-today">Today: {spendText(bot()!.today!)}</div>
          </Show>
          <Show when={bot()}>
            <label class="gc-check" title="A paused bot takes no room turns and starts no jobs (running work stops and waits); its DM still answers you.">
              <input type="checkbox" checked={bot()!.paused} onChange={(e) => crewAction('updateBot', bot()!.id, { paused: e.currentTarget.checked })} /> Paused
            </label>
            <label class="gc-check" title="The Chief is your single point of contact: it hands work to the others, can add specialists (with Undo) and looks at failed jobs.">
              <input type="checkbox" checked={crew.chiefId === bot()!.id} onChange={(e) => crewAction('setChief', e.currentTarget.checked ? bot()!.id : null)} /> Chief of the crew
            </label>
            <BotGoal bot={bot()!} />
            <BotMemoryPanel bot={bot()!} />
            <Show when={bot()!.rules.length}>
              <Field label="Always allowed" hint="You chose “Always” in the Inbox for these; anything else that needs you still asks.">
                <div class="crew-rules">
                  <For each={bot()!.rules}>
                    {(k) => (
                      <span class="gc-chip">
                        <span class="gc-chip-name">{k}</span>
                        <button title="Ask again" onClick={() => crewAction('forgetRule', bot()!.id, { key: k })}>
                          <Icon name="close" size={13} />
                        </button>
                      </span>
                    )}
                  </For>
                </div>
              </Field>
            </Show>
          </Show>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete()}
        title={`Delete ${bot()?.name ?? 'this bot'}?`}
        text="It leaves its rooms; its DM and its memory are deleted. What it said in rooms stays."
        action="Delete"
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          if (bot()) crewAction('deleteBot', bot()!.id);
          setConfirmDelete(false);
          close();
        }}
      />
    </>
  );
}

/** Its memory: on / off, filing new facts by itself, its notes (forget one), its file, Undo. */
function BotMemoryPanel(props: { bot: CrewBotView }) {
  const m = () => props.bot.memory;
  return (
    <Field label="Memory" hint="What it remembers goes with every turn (its first 200 lines); topics are looked up when they fit.">
      <div class="crew-mem">
        <div class="crew-mem-row">
          <label class="gc-check">
            <input type="checkbox" checked={m().enabled} onChange={(e) => crewAction('updateBot', props.bot.id, { memoryEnabled: e.currentTarget.checked })} /> On
          </label>
          <label class="gc-check" title="After a few turns (or 2 minutes of quiet) a quick model files new facts from what was said.">
            <input type="checkbox" checked={m().capture} disabled={!m().enabled} onChange={(e) => crewAction('updateBot', props.bot.id, { memoryCapture: e.currentTarget.checked })} /> Files new facts by itself
          </label>
          <span class="flex1" />
          <button class="text-btn" onClick={() => crewAction('openMemory', props.bot.id)}>
            Open
          </button>
          <Show when={m().undo}>
            <button class="text-btn" title={m().undo!.what} onClick={() => crewAction('undoMemory', props.bot.id, { id: m().undo!.id })}>
              Undo
            </button>
          </Show>
        </div>
        <Show when={m().notes.length} fallback={<div class="gc-muted">Nothing yet.</div>}>
          <div class="crew-mem-notes">
            <For each={m().notes}>
              {(n) => (
                <div class="crew-change">
                  <span title={[n.date, n.from, n.where !== 'core' ? n.where : ''].filter(Boolean).join(' · ')}>
                    {n.text}
                    <Show when={n.where !== 'core'}>
                      <span class="gc-muted"> · {n.where}</span>
                    </Show>
                  </span>
                  <button class="text-btn" title="Forget it" onClick={() => crewAction('forgetMemory', props.bot.id, { id: n.id })}>
                    <Icon name="close" size={13} />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Field>
  );
}

/** A standing goal: the bot works on it by itself, one step per turn, until a judge says it is done (or its turns run out). */
function BotGoal(props: { bot: CrewBotView }) {
  const [text, setText] = createSignal('');
  const g = () => props.bot.goal;
  const live = () => !!g() && !['done', 'failed', 'cancelled'].includes(g()!.status);
  return (
    <Field label="Standing goal" hint="It works on this by itself, one step per turn; a quick check after each turn says done, go on, or wait. Writing to it pauses the goal.">
      <Show
        when={live()}
        fallback={
          <div class="crew-goal-new">
            <input class="gc-input" placeholder="Keep the test suite green" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
            <button class="text-btn" disabled={!text().trim()} onClick={() => (crewAction('goal', props.bot.id, { text: text().trim() }), setText(''))}>
              Start
            </button>
          </div>
        }
      >
        <div class="crew-goal">
          <span class="crew-goal-text">🎯 {g()!.text}</span>
          <span class="gc-muted">
            turn {g()!.turns}/{g()!.maxTurns}
            {g()!.paused ? ' · paused' : g()!.nextAt ? ` · next ${new Date(g()!.nextAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
          <button class="text-btn danger" onClick={() => crewAction('goal', props.bot.id, { stop: true })}>
            Stop
          </button>
        </div>
      </Show>
    </Field>
  );
}

// ------------------------------------------------------------------------------------------------ DM header

/** A bot's DM: its face, role and access above the chat; the gear opens its editor. */
export function CrewChatHeader() {
  return (
    <Show when={chatCrewTag()} keyed>
      {(t) => (
        <div class="crew-chat-head">
          <Avatar emoji={t.emoji} color={t.color} size={28} />
          <div class="crew-chat-text">
            <span class="crew-chat-name">{t.name}</span>
            <Show when={t.title}>
              <span class="crew-chat-title">{t.title}</span>
            </Show>
          </div>
          <span class="crew-chip" title={ACCESS_LEVELS.find((a) => a.id === t.access)?.hint}>
            {accessLabel(t.access)}
          </span>
          <Show when={t.softNote}>
            <span class="crew-soft" title={t.softNote!}>
              <Icon name="info_o" size={15} />
            </span>
          </Show>
          <span class="flex1" />
          <IconButton
            icon="tune"
            title={`${t.name}'s settings`}
            size={30}
            iconSize={17}
            onClick={() => {
              setOpenGroupId(null);
              setGroupsOpen(true);
              setEditBot(t.botId);
            }}
          />
        </div>
      )}
    </Show>
  );
}
