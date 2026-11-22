// The Crew screen: the Crew home (the bots, then the rooms) and a room = a group chat with the user and several crew
// bots (each its own hidden chat on any agent / model): bubbles with avatars, who is typing, @mentions, the cast and
// the room's settings. Like Notes, the screen sits over the chat and stays alive while hidden. The host runs
// who-speaks-when (src/core/groups on the crew's rooms) and the bots (src/core/crew).
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show } from 'solid-js';
import type { AgentKind, ChatAttachment } from '@shared/model';
import type { GroupBotAccess, GroupBotView, GroupMessageView, GroupMode, GroupView } from '@shared/protocol';
import { group, groupAction, groupList, groupMsgs, groupSend, groupsOpen, openGroupId, replyTo, setGroupsOpen, setOpenGroupId, setReplyTo } from '../state/groups';
import { copyText, enabledAgents, pickAttachments, requestModels, state } from '../state/store';
import { MarkdownContent } from './Markdown';
import { AgentMark } from './AgentStatus';
import { attKind, useImageSrc, openAttachment } from './Attachments';
import { Dialog, Icon, IconButton } from '../ui/primitives';
import { CrewAboutMe, CrewBotEditor, CrewBots, CrewChief, CrewControls } from './Crew';
import { CrewImportDialog } from './CrewImport';
import { CrewGuide } from './CrewGuide';
import { CrewSpend } from './CrewSpend';
import { canSpeak, speak, speaking, stopSpeaking } from '../util/speech';
import { crewAction } from '../state/crew';
import { InboxDock } from './Inbox';
import { crew } from '../state/crew';
import { mcOpen, setMcOpen } from '../state/jobs';
import { MissionControl } from './MissionControl';
import { AutomationsPage } from './Automations';
import { autoOpen, setAutoOpen } from '../state/automations';
import { agentLabel, relativeTime, shortModelName } from '../util/format';

export const PALETTE = ['#8B5CF6', '#EF4444', '#10B981', '#F59E0B', '#3B82F6', '#EC4899', '#14B8A6', '#F97316', '#6366F1', '#84CC16'];

const TEMPLATES: { id: string; title: string; emojis: string; hint: string }[] = [
  { id: '', title: 'Empty group', emojis: '➕', hint: 'Add your own characters' },
  { id: 'brainstorm', title: 'Brainstorm squad', emojis: '🚀🧐🛠️', hint: 'Visionary, skeptic, builder' },
  { id: 'review', title: 'Code review panel', emojis: '🏛️🛡️🧪', hint: 'Read your project and review it' },
  { id: 'debate', title: 'Debate club', emojis: '👍👎⚖️', hint: 'Pro vs Con, a judge keeps score' },
  { id: 'coffee', title: 'Coffee break', emojis: '🎤👴🐣', hint: 'Jokes and dev stories' },
];

const MODES: { id: GroupMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'The best fit answers: names, topics it answers to, its role, who edited the file you name. When unsure, a cheap router model picks (else the lead). You always get a reply.' },
  { id: 'mentions', label: 'Mentions', hint: 'Only the members you @mention answer; the others may chime in by their chattiness.' },
  { id: 'lead', label: 'Lead', hint: 'The lead answers anything nobody was @mentioned in, and may hand it on with @Name.' },
  { id: 'everyone', label: 'Everyone', hint: 'Every member answers you.' },
  { id: 'moderator', label: 'Moderator', hint: 'A model reads the room and picks who speaks after every message (one extra call per message).' },
];

/** "Picked by router · why" under a member's name. */
const PICKED: Record<string, string> = {
  reply: 'you replied',
  mention: 'mentioned',
  everyone: 'everyone asked',
  lead: 'lead',
  auto: 'auto',
  router: 'router',
  moderator: 'moderator',
  chime: 'chimed in',
  held: 'back from hold',
  nudge: 'spoke up',
  user: 'you asked',
};

const ACCESS: { id: GroupBotAccess; label: string; hint: string }[] = [
  { id: 'chat', label: 'Talk only', hint: 'No tools: cheapest, just conversation.' },
  { id: 'read', label: 'Read project', hint: 'May read the project and the web to back up what it says.' },
  { id: 'edit', label: 'Edit project', hint: 'May change files and run commands when asked.' },
];

// ------------------------------------------------------------------------------------------------ screen

export function GroupsScreen() {
  let root: HTMLDivElement | undefined;
  const back = () => {
    if (autoOpen()) setAutoOpen(false);
    else if (mcOpen()) setMcOpen(false);
    else if (openGroupId()) setOpenGroupId(null);
    else setGroupsOpen(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
    if (document.querySelector('.dialog-scrim, .sheet-scrim, .menu, .settings.shown, .gc-mention-pop')) return;
    e.preventDefault();
    e.stopPropagation();
    back();
  };
  createEffect(() => {
    if (!groupsOpen()) return;
    document.addEventListener('keydown', onKey, true);
    onCleanup(() => document.removeEventListener('keydown', onKey, true));
  });
  return (
    <div ref={root} class="gc-screen" classList={{ shown: groupsOpen() }} aria-hidden={groupsOpen() ? undefined : 'true'} onClick={(e) => e.stopPropagation()}>
      <Show when={groupsOpen()}>
        <Show when={!autoOpen()} fallback={<AutomationsPage />}>
        <Show when={!mcOpen()} fallback={<MissionControl />}>
          <Show when={openGroupId()} keyed fallback={<GroupList />}>
            {(id) => <Room id={id} onBack={() => setOpenGroupId(null)} />}
          </Show>
        </Show>
        </Show>
        <CrewBotEditor />
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ avatars

export function Avatar(props: { emoji: string; color: string; size?: number; title?: string; ring?: boolean }) {
  const size = () => props.size ?? 32;
  return (
    <div
      class="gc-avatar"
      classList={{ ring: props.ring }}
      title={props.title}
      style={{ width: `${size()}px`, height: `${size()}px`, background: props.color, 'font-size': `${Math.round(size() * 0.52)}px` }}
    >
      {props.emoji}
    </div>
  );
}

function AvatarStack(props: { bots: { emoji: string; color: string; name: string }[]; size?: number; max?: number }) {
  const shown = () => props.bots.slice(0, props.max ?? 4);
  const more = () => props.bots.length - shown().length;
  return (
    <div class="gc-stack">
      <For each={shown()}>{(b) => <Avatar emoji={b.emoji} color={b.color} size={props.size ?? 28} title={b.name} ring />}</For>
      <Show when={more() > 0}>
        <div class="gc-avatar ring more" style={{ width: `${props.size ?? 28}px`, height: `${props.size ?? 28}px` }}>
          +{more()}
        </div>
      </Show>
      <Show when={!props.bots.length}>
        <div class="gc-avatar ring empty" style={{ width: `${props.size ?? 28}px`, height: `${props.size ?? 28}px` }}>
          <Icon name="forum" size={(props.size ?? 28) * 0.55} />
        </div>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ list

function GroupList() {
  const [creating, setCreating] = createSignal(false);
  const [aiOpen, setAiOpen] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  return (
    <div class="gc-page">
      <div class="gc-bar">
        <IconButton icon="arrow_back" title="Back" size={36} iconSize={20} onClick={() => setGroupsOpen(false)} />
        <div class="gc-bar-title">
          <div class="gc-bar-text">
            <div class="gc-title">Crew</div>
            <div class="gc-sub">Your AI team: bots to chat with, rooms to work together</div>
          </div>
        </div>
        <IconButton icon="download" title="Add a crew (ready-made, from GitHub, OpenMausBot teams)" size={36} iconSize={19} onClick={() => setImporting(true)} />
        <Show when={crew.bots.length}>
          <IconButton icon="upload" title="Share your crew (save it as one file)" size={36} iconSize={19} onClick={() => crewAction('export')} />
        </Show>
        <IconButton icon="auto_awesome" title="Create a room with AI" size={36} iconSize={19} onClick={() => setAiOpen(true)} />
      </div>
      <CrewImportDialog open={importing()} onClose={() => setImporting(false)} />
      <div class="gc-list">
        <InboxDock max={3} />
        <CrewGuide onImport={() => setImporting(true)} />
        <CrewChief />
        <CrewAboutMe />
        <CrewControls />
        <CrewSpend />
        <button class="mc-entry" onClick={() => setMcOpen(true)} title="Every job your crew works on: who asked whom, status, evidence, cost">
          <span class="mc-entry-icon">
            <Icon name="account_tree" size={20} />
          </span>
          <span class="mc-entry-text">
            <b>Mission Control</b>
            <span class="gc-muted">
              {crew.jobs?.working || crew.jobs?.waiting || crew.jobs?.needsYou
                ? [crew.jobs.working && `${crew.jobs.working} working`, crew.jobs.waiting && `${crew.jobs.waiting} waiting`, crew.jobs.needsYou && `${crew.jobs.needsYou} need${crew.jobs.needsYou === 1 ? 's' : ''} an answer`]
                    .filter(Boolean)
                    .join(' · ')
                : crew.jobs?.today
                  ? `${crew.jobs.today} task${crew.jobs.today === 1 ? '' : 's'} today`
                  : 'Jobs your bots hand each other show up here'}
            </span>
          </span>
          <Show when={crew.jobs?.needsYou}>
            <span class="mc-dot" />
          </Show>
          <Icon name="chevron_right" size={18} />
        </button>
        <button class="mc-entry" onClick={() => setAutoOpen(true)} title="Bots that run on a schedule, on editor events or webhooks">
          <span class="mc-entry-icon">
            <Icon name="schedule" size={20} />
          </span>
          <span class="mc-entry-text">
            <b>Automations</b>
            <span class="gc-muted">When something happens, a bot does something</span>
          </span>
          <Icon name="chevron_right" size={18} />
        </button>
        <CrewBots />
        <div class="crew-section-head">
          <span>Rooms</span>
          <button class="crew-add" onClick={() => setCreating(true)}>
            <Icon name="add" size={16} /> New room
          </button>
        </div>
        <Show
          when={groupList.list.length}
          fallback={
            <Show when={groupList.loaded}>
              <Show
                when={crew.bots.length}
                fallback={
                  <div class="gc-empty">
                    <div class="gc-empty-art">🤖💬🤖</div>
                    <div class="gc-empty-title">Or start a room with ready-made bots</div>
                    <div class="gc-empty-text">
                      A room is a group chat: give each bot a name, a personality and its own agent or model. They talk to you and to each other: brainstorm,
                      review code, debate, or just joke around. Only what they say is shared, never their thinking or tool calls.
                    </div>
                    <div class="gc-empty-actions">
                      <button class="filled-btn" onClick={() => setCreating(true)}>
                        <Icon name="add" size={18} /> New room
                      </button>
                      <button class="outlined-btn gc-outlined" onClick={() => setAiOpen(true)}>
                        <Icon name="auto_awesome" size={16} /> Create with AI
                      </button>
                    </div>
                  </div>
                }
              >
                <button class="crew-empty-row" onClick={() => setCreating(true)}>
                  <span class="crew-empty-art">💬</span>
                  <span>
                    <b>No rooms yet.</b> A room is a group chat: you and several bots talk it through together.
                  </span>
                </button>
              </Show>
            </Show>
          }
        >
          <For each={groupList.list}>
            {(g) => (
              <button class="gc-row" onClick={() => setOpenGroupId(g.id)}>
                <AvatarStack bots={g.bots} size={30} max={3} />
                <div class="gc-row-main">
                  <div class="gc-row-top">
                    <span class="gc-row-title">{g.title}</span>
                    <Show when={g.active}>
                      <span class="gc-live" title="Talking now" />
                    </Show>
                    <span class="gc-row-time">{g.updatedAt ? relativeTime(g.updatedAt) : ''}</span>
                  </div>
                  <div class="gc-row-text">
                    <Show when={g.lastText} fallback={<span class="gc-muted">{g.bots.length ? g.bots.map((b) => b.name).join(', ') : 'No members yet'}</span>}>
                      <b>{g.lastName}:</b> {g.lastText}
                    </Show>
                  </div>
                </div>
              </button>
            )}
          </For>
        </Show>
      </div>
      <NewGroupDialog open={creating()} onClose={() => setCreating(false)} />
      <SetupWithAiDialog open={aiOpen()} onClose={() => setAiOpen(false)} />
    </div>
  );
}

function NewGroupDialog(props: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = createSignal('');
  const [topic, setTopic] = createSignal('');
  const [userName, setUserName] = createSignal('');
  const [tpl, setTpl] = createSignal('brainstorm');
  createEffect(
    on(
      () => props.open,
      (o) => {
        if (!o) return;
        setTitle('');
        setTopic('');
        setTpl('brainstorm');
      },
    ),
  );
  const create = () => {
    const t = TEMPLATES.find((x) => x.id === tpl());
    groupAction('create', { data: { title: title().trim() || (t?.id ? t.title : 'Group chat'), topic: topic().trim() || undefined, userName: userName().trim() || undefined, template: tpl() || null } });
    props.onClose();
  };
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="New group chat"
      width={440}
      actions={
        <>
          <button class="text-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button class="filled-btn" onClick={create}>
            Create
          </button>
        </>
      }
    >
      <div class="gc-form">
        <div class="gc-label">Start from</div>
        <div class="gc-templates">
          <For each={TEMPLATES}>
            {(t) => (
              <button class="gc-template" classList={{ on: tpl() === t.id }} onClick={() => setTpl(t.id)}>
                <span class="gc-template-emoji">{t.emojis}</span>
                <span class="gc-template-title">{t.title}</span>
                <span class="gc-template-hint">{t.hint}</span>
              </button>
            )}
          </For>
        </div>
        <Field label="Name">
          <input class="gc-input" value={title()} placeholder={TEMPLATES.find((x) => x.id === tpl())?.id ? TEMPLATES.find((x) => x.id === tpl())!.title : 'Group chat'} onInput={(e) => setTitle(e.currentTarget.value)} />
        </Field>
        <Field label="Topic" hint="Every bot is told what the group is about (optional).">
          <textarea class="gc-input gc-textarea" rows={2} value={topic()} onInput={(e) => setTopic(e.currentTarget.value)} />
        </Field>
        <Field label="Your name in the chat" hint="One word; the bots call you this and @mention you with it.">
          <input class="gc-input" value={userName()} placeholder="Boss" onInput={(e) => setUserName(e.currentTarget.value)} />
        </Field>
        <div class="gc-hint">Template bots use your enabled agents in turn; change any bot's agent, model or persona afterwards.</div>
      </div>
    </Dialog>
  );
}

function SetupWithAiDialog(props: { open: boolean; onClose: () => void }) {
  const [idea, setIdea] = createSignal('');
  const [agent, setAgent] = createSignal<AgentKind>(state.defaultAgent);
  createEffect(
    on(
      () => props.open,
      (o) => {
        if (o && !enabledAgents().includes(agent())) setAgent(enabledAgents()[0] ?? state.defaultAgent);
      },
    ),
  );
  const go = () => {
    groupAction('setupWithAI', { data: { agent: agent(), idea: idea().trim() } });
    props.onClose();
    setIdea('');
  };
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Create with AI"
      width={420}
      actions={
        <>
          <button class="text-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button class="filled-btn" onClick={go}>
            Open chat
          </button>
        </>
      }
    >
      <div class="gc-form">
        <div class="gc-hint">
          Opens a new chat with a request to design the group and its characters with the <b>Group Chat</b> MCP. Add it first in Settings → (the agent) → MCP
          servers → Group Chat.
        </div>
        <Field label="What should the group be about?">
          <textarea class="gc-input gc-textarea" rows={3} placeholder="e.g. a startup pitch panel that grills my app idea, with a VC, a designer and a hacker" value={idea()} onInput={(e) => setIdea(e.currentTarget.value)} />
        </Field>
        <Field label="Designer agent">
          <AgentSelect value={agent()} onChange={setAgent} />
        </Field>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ room

function Room(props: { id: string; onBack: () => void }) {
  const [members, setMembers] = createSignal(false);
  const [settings, setSettings] = createSignal(false);
  const [editing, setEditing] = createSignal<GroupBotView | 'new' | null>(null);
  const g = () => (group()?.id === props.id ? group() : null);
  const bots = () => g()?.bots ?? [];
  const botOf = (id: string) => bots().find((b) => b.id === id);
  // read aloud: every new member message, one after another, each in its bot's voice
  const [aloud, setAloud] = createSignal(false);
  let heard = '';
  createEffect(() => {
    const list = groupMsgs.id === props.id ? groupMsgs.list : [];
    const last = list[list.length - 1];
    if (!last) return;
    const at = heard ? list.findIndex((m) => m.id === heard) : -1;
    if (aloud() && at >= 0) for (const m of list.slice(at + 1)) if (m.from !== 'user' && m.from !== 'notice' && m.from !== 'system' && m.text) speak(m.id, m.text, botOf(m.from)?.voice ?? null, true);
    heard = last.id;
  });
  onCleanup(stopSpeaking);
  const typingNames = createMemo(() =>
    (g()?.typing ?? [])
      .map((t) => ({ bot: botOf(t.botId), activity: t.activity, step: t.step ?? null }))
      .filter((t): t is { bot: GroupBotView; activity: 'typing' | 'working' | 'waiting'; step: string | null } => !!t.bot),
  );
  const subtitle = () => {
    const t = typingNames();
    if (t.length === 1)
      return t[0].activity === 'waiting'
        ? `${t[0].bot.name} is ${t[0].step ?? 'busy elsewhere'}…`
        : t[0].activity === 'working'
          ? `${t[0].bot.name} is ${t[0].step ?? 'checking something'}…`
          : `${t[0].bot.name} is typing…`;
    if (t.length > 1) return `${t.map((x) => x.bot.name).join(', ')} are typing…`;
    if (g()?.status) return g()!.status!;
    const b = bots();
    if (!b.length) return 'No members yet';
    return `${b.map((x) => x.name).join(', ')} and you`;
  };

  return (
    <div class="gc-page">
      <div class="gc-bar">
        <IconButton icon="arrow_back" title="Groups" size={36} iconSize={20} onClick={props.onBack} />
        <button class="gc-bar-title clickable" onClick={() => setMembers(true)} title="Members">
          <AvatarStack bots={bots()} size={26} max={3} />
          <div class="gc-bar-text">
            <div class="gc-title">{g()?.title ?? 'Group chat'}</div>
            <div class="gc-sub" classList={{ typing: typingNames().length > 0 }}>
              {subtitle()}
            </div>
          </div>
        </button>
        <Show when={g()}>
          <Show
            when={!g()!.paused}
            fallback={<IconButton icon="play_arrow" title="Resume" size={34} iconSize={20} onClick={() => groupAction('resume')} />}
          >
            <IconButton icon="pan_tool" title="Pause (stops the bot replying now)" size={34} iconSize={17} onClick={() => groupAction('pause')} />
          </Show>
        </Show>
        <Show when={canSpeak()}>
          <IconButton
            icon="record_voice_over"
            class={aloud() ? 'gc-on' : undefined}
            title={aloud() ? 'Stop reading new messages aloud' : 'Read new messages aloud (each bot in its voice)'}
            size={34}
            iconSize={18}
            onClick={() => {
              if (aloud()) stopSpeaking();
              setAloud((v) => !v);
            }}
          />
        </Show>
        <IconButton icon="person" title="Members" size={34} iconSize={19} onClick={() => setMembers(true)} />
        <IconButton icon="settings" title="Room settings" size={34} iconSize={18} onClick={() => setSettings(true)} />
      </div>
      <Show when={g()?.goal}>
        <GoalCard goal={g()!.goal!} />
      </Show>
      <Feed group={g()} onAddBot={() => setEditing('new')} onBot={(b) => setEditing(b)} />
      <Show when={g()?.waiting}>
        <div class="gc-banner">
          <span>💤 The bots are waiting for you.</span>
          <button class="text-btn" onClick={() => groupAction('continue')}>
            Continue
          </button>
        </div>
      </Show>
      <Show when={g()?.paused && !g()?.waiting}>
        <div class="gc-banner">
          <span>⏸ Paused: the bots won't speak until you write or resume.</span>
          <button class="text-btn" onClick={() => groupAction('resume')}>
            Resume
          </button>
        </div>
      </Show>
      <InboxDock max={1} />
      <Composer bots={bots()} disabled={!g()} queue={g()?.queue ?? []} />
      <MembersDialog open={members()} onClose={() => setMembers(false)} group={g()} onEdit={(b) => setEditing(b)} />
      <BotEditor open={editing() !== null} bot={editing() === 'new' ? null : (editing() as GroupBotView | null)} count={bots().length} onClose={() => setEditing(null)} />
      <GroupSettings open={settings()} group={g()} onClose={() => setSettings(false)} />
    </div>
  );
}

/** The room's goal: progress, the lead's last note, Stop / Continue. */
function GoalCard(props: { goal: NonNullable<GroupView['goal']> }) {
  const g = () => props.goal;
  const label: Record<string, string> = { running: 'working on it', completed: 'reached', 'needs-input': 'needs you', blocked: 'blocked', stopped: 'paused' };
  return (
    <div class="gc-goal" classList={{ done: g().status === 'completed', wait: g().status !== 'running' && g().status !== 'completed' }}>
      <span class="gc-goal-icon">🎯</span>
      <div class="gc-goal-main">
        <div class="gc-goal-text">{g().text}</div>
        <div class="gc-muted gc-goal-sub">
          {label[g().status] ?? g().status} · team turn {g().turns}/{g().maxTurns}
          {g().note && g().status === 'running' ? ` · next: ${g().note}` : ''}
        </div>
        <div class="gc-goal-bar">
          <span style={{ width: `${Math.min(100, Math.round((g().turns / Math.max(1, g().maxTurns)) * 100))}%` }} />
        </div>
      </div>
      <Show when={g().status === 'running'} fallback={<Show when={g().status !== 'completed'}><button class="text-btn" onClick={() => groupAction('goal', { data: { continue: true } })}>Continue</button></Show>}>
        <button class="text-btn danger" onClick={() => groupAction('goal', { data: { stop: true } })}>
          Stop
        </button>
      </Show>
    </div>
  );
}

function Feed(props: { group: GroupView | null; onAddBot: () => void; onBot: (b: GroupBotView) => void }) {
  let scroller: HTMLDivElement | undefined;
  const [atBottom, setAtBottom] = createSignal(true);
  const list = () => groupMsgs.list;
  const toBottom = (smooth = false) => scroller?.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  // the room follows new messages while the user is at the end
  createEffect(
    on(
      () => [list().length, props.group?.typing.length ?? 0],
      () => {
        if (atBottom()) requestAnimationFrame(() => toBottom());
      },
    ),
  );
  createEffect(on(() => groupMsgs.id, () => requestAnimationFrame(() => toBottom())));
  const onScroll = () => {
    if (!scroller) return;
    setAtBottom(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80);
  };
  const botOf = (id: string) => props.group?.bots.find((b) => b.id === id);
  const typing = createMemo(() =>
    (props.group?.typing ?? [])
      .map((t) => ({ bot: botOf(t.botId), activity: t.activity, step: t.step ?? null }))
      .filter((t): t is { bot: GroupBotView; activity: 'typing' | 'working' | 'waiting'; step: string | null } => !!t.bot),
  );
  return (
    <div class="gc-feed-wrap">
      <div class="gc-feed" ref={scroller} onScroll={onScroll}>
        <Show when={props.group && !list().some((m) => m.from === 'user' || props.group!.bots.some((b) => b.id === m.from))}>
          <div class="gc-welcome">
            <Show
              when={props.group!.bots.length}
              fallback={
                <>
                  <div class="gc-welcome-title">No one here yet</div>
                  <button class="filled-btn" onClick={props.onAddBot}>
                    <Icon name="add" size={18} /> Add a bot
                  </button>
                </>
              }
            >
              <AvatarStack bots={props.group!.bots} size={40} max={6} />
              <div class="gc-welcome-title">Say hi 👋</div>
              <div class="gc-welcome-text">
                Mention someone with <code>@Name</code>, everyone with <code>@all</code>, or just talk.
                <Show when={props.group!.topic}>
                  <br />
                  <span class="gc-muted">Topic: {props.group!.topic}</span>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
        <For each={list()}>
          {(m, i) => {
            const prev = () => list()[i() - 1];
            const grouped = () => !!prev() && prev()!.from === m.from && m.at - prev()!.at < 3 * 60_000 && m.from !== 'notice' && m.from !== 'system';
            return <GroupMessage msg={m} bot={botOf(m.from)} grouped={grouped()} onBot={props.onBot} replyName={m.replyTo ? (list().find((x) => x.id === m.replyTo)?.name ?? null) : null} />;
          }}
        </For>
        <For each={typing()}>
          {(t) => (
            <div class="gc-msg bot typing-row">
              <div class="gc-msg-side">
                <Avatar emoji={t.bot.emoji} color={t.bot.color} size={30} />
              </div>
              <div class="gc-typing">
                <span class="gc-typing-name" style={{ color: t.bot.color }}>
                  {t.bot.name}
                </span>
                <span class="gc-dots">
                  <i />
                  <i />
                  <i />
                </span>
                <Show when={t.activity !== 'typing'}>
                  <span class="gc-muted">{t.step ?? (t.activity === 'waiting' ? 'busy elsewhere' : 'checking something')}</span>
                </Show>
              </div>
            </div>
          )}
        </For>
        <Show when={props.group?.status && !typing().length}>
          <div class="gc-note">{props.group!.status}</div>
        </Show>
      </div>
      <Show when={!atBottom()}>
        <button class="gc-jump" title="Latest" onClick={() => toBottom(true)}>
          <Icon name="expand_more" size={20} />
        </button>
      </Show>
    </div>
  );
}

function GroupMessage(props: { msg: GroupMessageView; bot: GroupBotView | undefined; grouped: boolean; onBot: (b: GroupBotView) => void; replyName: string | null }) {
  const m = () => props.msg;
  const time = () => new Date(m().at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const [facts, setFacts] = createSignal(false);
  const pickedText = () => {
    const p = m().picked;
    if (!p) return null;
    const label = PICKED[p.by] ?? p.by;
    return p.why ? `${label} · ${p.why}` : label;
  };
  return (
    <Show
      when={m().from !== 'notice' && m().from !== 'system'}
      fallback={<div class="gc-note">{m().text}</div>}
    >
      <Show
        when={m().from !== 'user'}
        fallback={
          <div class="gc-msg user" classList={{ grouped: props.grouped }}>
            <div class="gc-bubble user">
              <Show when={props.replyName}>
                <div class="gc-reply-to">
                  <Icon name="reply" size={13} /> to {props.replyName}
                </div>
              </Show>
              <Attachments list={m().attachments} />
              <Show when={m().text}>
                <MarkdownContent text={m().text} />
              </Show>
              <MsgFooter time={time()} text={m().text} />
            </div>
          </div>
        }
      >
        <div class="gc-msg bot" classList={{ grouped: props.grouped }}>
          <div class="gc-msg-side">
            <Show when={!props.grouped}>
              <button class="gc-avatar-btn" title={props.bot ? `${props.bot.name}: ${props.bot.persona.split('\n')[0]}` : m().name} onClick={() => props.bot && props.onBot(props.bot)}>
                <Avatar emoji={props.bot?.emoji ?? '👻'} color={props.bot?.color ?? '#64748B'} size={30} />
              </button>
            </Show>
          </div>
          <div class="gc-bubble bot" style={{ '--gc-accent': props.bot?.color ?? '#64748B' } as JSX.CSSProperties}>
            <Show when={!props.grouped}>
              <div class="gc-name">
                <span style={{ color: props.bot?.color ?? 'inherit' }}>{m().name}</span>
                <Show when={props.bot}>
                  <span class="gc-agent-tag">{botTag(props.bot!)}</span>
                </Show>
                <Show when={pickedText()}>
                  <span class="gc-picked" title="Why this member answered">
                    {pickedText()}
                  </span>
                </Show>
              </div>
            </Show>
            <MarkdownContent text={m().text} />
            <Show when={m().digest}>
              <button class="gc-digest" classList={{ open: facts() }} title="What it did before answering (from its tool calls)" onClick={() => setFacts((v) => !v)}>
                <Icon name="build" size={12} /> {m().digest}
              </button>
              <Show when={facts() && m().evidence?.length}>
                <div class="gc-evidence">
                  <For each={m().evidence!}>{(l) => <div>{l}</div>}</For>
                </div>
              </Show>
            </Show>
            <MsgFooter
              time={time()}
              text={m().text}
              usage={m().usage ? `${fmtTokens(m().usage!.input + m().usage!.cached)} in · ${fmtTokens(m().usage!.output)} out${m().usage!.costUsd != null ? ` · $${m().usage!.costUsd!.toFixed(3)}` : ''}` : null}
              onReply={() => setReplyTo(m().id)}
              onSpeak={canSpeak() ? () => speak(m().id, m().text, props.bot?.voice ?? null) : undefined}
              speaking={speaking() === m().id}
            />
          </div>
        </div>
      </Show>
    </Show>
  );
}

function MsgFooter(props: { time: string; text: string; usage?: string | null; onReply?: () => void; onSpeak?: () => void; speaking?: boolean }) {
  return (
    <div class="gc-foot">
      <Show when={props.onSpeak}>
        <button class="gc-copy" classList={{ on: props.speaking }} title={props.speaking ? 'Stop reading' : 'Read aloud'} onClick={() => props.onSpeak!()}>
          <Icon name={props.speaking ? 'stop' : 'record_voice_over'} size={13} />
        </button>
      </Show>
      <Show when={props.onReply}>
        <button class="gc-copy" title="Reply (this member answers)" onClick={() => props.onReply!()}>
          <Icon name="reply" size={13} />
        </button>
      </Show>
      <button class="gc-copy" title="Copy" onClick={() => copyText(props.text, 'Copied')}>
        <Icon name="copy" size={13} />
      </button>
      <span title={props.usage ?? undefined}>{props.time}</span>
    </div>
  );
}

const fmtTokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function Attachments(props: { list: ChatAttachment[] }) {
  const images = () => props.list.filter((a) => attKind(a) === 'image');
  const files = () => props.list.filter((a) => attKind(a) !== 'image');
  return (
    <Show when={props.list.length}>
      <div class="gc-atts" classList={{ one: images().length === 1 }}>
        <For each={images()}>{(a) => <AttImage att={a} />}</For>
      </div>
      <For each={files()}>
        {(a) => (
          <button class="gc-file" onClick={() => openAttachment(a)}>
            <Icon name="file" size={15} /> {a.name}
          </button>
        )}
      </For>
    </Show>
  );
}

function AttImage(props: { att: ChatAttachment }) {
  const src = useImageSrc(() => props.att);
  return (
    <button class="gc-att-img" onClick={() => openAttachment(props.att, src())}>
      <Show when={src()} fallback={<Icon name="image" size={22} />}>
        <img src={src()!} alt={props.att.name} />
      </Show>
    </button>
  );
}

function modelName(agent: AgentKind, modelId: string | null): string | null {
  if (!modelId) return null;
  const m = state.models[agent]?.models.find((x) => x.id === modelId || x.key === modelId);
  return m ? m.displayName : shortModelName(modelId);
}

function botTag(b: GroupBotView): string {
  const model = modelName(b.agent, b.modelId);
  return model ? `${agentLabel(b.agent)} · ${model}` : agentLabel(b.agent);
}

// ------------------------------------------------------------------------------------------------ composer

function Composer(props: { bots: GroupBotView[]; disabled: boolean; queue: { id: string; text: string }[] }) {
  const [text, setText] = createSignal('');
  const [atts, setAtts] = createSignal<ChatAttachment[]>([]);
  const [mention, setMention] = createSignal<{ query: string; start: number } | null>(null);
  const [sel, setSel] = createSignal(0);
  let box: HTMLTextAreaElement | undefined;

  const options = createMemo(() => {
    const m = mention();
    if (!m) return [];
    const q = m.query.toLowerCase();
    const list: { name: string; emoji: string; color: string; hint: string }[] = props.bots
      .filter((b) => b.name.toLowerCase().startsWith(q))
      .map((b) => ({ name: b.name, emoji: b.emoji, color: b.color, hint: b.muted ? 'on hold' : b.title || agentLabel(b.agent) }));
    if ('all'.startsWith(q)) list.push({ name: 'all', emoji: '👥', color: '#64748B', hint: 'everyone answers' });
    if ('here'.startsWith(q)) list.push({ name: 'here', emoji: '🙋', color: '#64748B', hint: 'everyone not busy elsewhere' });
    return list;
  });
  createEffect(on(options, () => setSel(0)));

  const grow = () => {
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 180)}px`;
  };
  const scanMention = () => {
    if (!box) return;
    const upto = box.value.slice(0, box.selectionStart ?? box.value.length);
    const m = /(^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(upto);
    setMention(m ? { query: m[2], start: upto.length - m[2].length - 1 } : null);
  };
  const pick = (name: string) => {
    const m = mention();
    if (!m || !box) return;
    const v = box.value;
    const end = box.selectionStart ?? v.length;
    const next = `${v.slice(0, m.start)}@${name} ${v.slice(end)}`;
    setText(next);
    box.value = next;
    const caret = m.start + name.length + 2;
    box.setSelectionRange(caret, caret);
    setMention(null);
    box.focus();
    grow();
  };
  const send = () => {
    const t = text().trim();
    if ((!t && !atts().length) || props.disabled) return;
    groupSend(t, atts());
    setText('');
    setAtts([]);
    if (box) box.value = '';
    setMention(null);
    grow();
  };
  const onKey = (e: KeyboardEvent) => {
    const opts = options();
    if (mention() && opts.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(opts[sel()].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const replyMsg = () => {
    const id = replyTo();
    return id ? (groupMsgs.list.find((m) => m.id === id) ?? null) : null;
  };
  return (
    <div class="gc-composer">
      <Show when={props.queue.length}>
        <div class="gc-queue" title="Sent while a member speaks: they go together when it is done">
          <For each={props.queue}>
            {(q) => (
              <div class="gc-queued">
                <Icon name="schedule" size={13} />
                <span class="gc-queued-text">{q.text || '(files)'}</span>
                <button title="Don't send" onClick={() => groupAction('unqueue', { data: { id: q.id } })}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={replyMsg()}>
        <div class="gc-replying">
          <Icon name="reply" size={14} />
          <span class="gc-replying-text">
            Replying to <b>{replyMsg()!.name}</b>: {replyMsg()!.text.replace(/```[\s\S]*?(```|$)/g, ' [code] ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').slice(0, 80)}
          </span>
          <button title="Cancel reply" onClick={() => setReplyTo(null)}>
            <Icon name="close" size={13} />
          </button>
        </div>
      </Show>
      <Show when={mention() && options().length}>
        <div class="gc-mention-pop">
          <For each={options()}>
            {(o, i) => (
              <button class="gc-mention" classList={{ on: i() === sel() }} onMouseDown={(e) => (e.preventDefault(), pick(o.name))}>
                <Avatar emoji={o.emoji} color={o.color} size={22} />
                <span class="gc-mention-name">@{o.name}</span>
                <span class="gc-muted">{o.hint}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={atts().length}>
        <div class="gc-chips">
          <For each={atts()}>
            {(a) => (
              <span class="gc-chip">
                <Icon name={attKind(a) === 'image' ? 'image' : 'file'} size={14} />
                <span class="gc-chip-name">{a.name}</span>
                <button title="Remove" onClick={() => setAtts((l) => l.filter((x) => x !== a))}>
                  <Icon name="close" size={13} />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <div class="gc-input-row">
        <IconButton icon="add" title="Attach images or files" size={34} iconSize={20} onClick={() => pickAttachments((a) => setAtts((l) => [...l, ...a]))} />
        <textarea
          ref={box}
          class="gc-box"
          rows={1}
          placeholder={props.bots.length ? 'Message the room… (@ to mention, /goal to give the lead a goal)' : 'Add a member to start'}
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            grow();
            scanMention();
          }}
          onKeyDown={onKey}
          onClick={scanMention}
          onBlur={() => setTimeout(() => setMention(null), 120)}
        />
        <button class="gc-send" disabled={props.disabled || (!text().trim() && !atts().length)} title="Send" onClick={send}>
          <Icon name="arrow_up" size={18} />
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ members

function MembersDialog(props: { open: boolean; onClose: () => void; group: GroupView | null; onEdit: (b: GroupBotView | 'new') => void }) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Members"
      width={460}
      actions={
        <>
          <button class="text-btn" onClick={props.onClose}>
            Close
          </button>
          <button class="filled-btn" onClick={() => (props.onClose(), props.onEdit('new'))}>
            <Icon name="add" size={18} /> New member
          </button>
        </>
      }
    >
      <div class="gc-members">
        <div class="gc-member you">
          <Avatar emoji="🙂" color="#64748B" size={34} />
          <div class="gc-member-main">
            <div class="gc-member-name">{props.group?.userName ?? 'You'} (you)</div>
            <div class="gc-muted">The human in the room</div>
          </div>
        </div>
        <For each={props.group?.bots ?? []}>
          {(b) => (
            <div class="gc-member" classList={{ muted: b.muted }}>
              <button class="gc-member-click" onClick={() => (props.onClose(), props.onEdit(b))}>
                <Avatar emoji={b.emoji} color={b.color} size={34} />
                <div class="gc-member-main">
                  <div class="gc-member-name">
                    {b.name}
                    <Show when={props.group?.lead === b.id}>
                      <span class="gc-badge">lead</span>
                    </Show>
                    <Show when={b.muted}>
                      <span class="gc-badge">on hold{b.held ? ` · ${b.held} kept` : ''}</span>
                    </Show>
                    <Show when={b.access !== 'chat'}>
                      <span class="gc-badge">{b.access === 'read' ? 'reads project' : 'edits project'}</span>
                    </Show>
                  </div>
                  <div class="gc-member-tag">
                    <AgentMark agent={b.agent} size={16} /> {botTag(b)} · chattiness {b.chattiness}
                  </div>
                  <div class="gc-member-persona">{b.title ? `${b.title}${b.persona ? ' — ' : ''}` : ''}{b.persona || (b.title ? '' : 'No persona yet')}</div>
                </div>
              </button>
              <div class="gc-member-actions">
                <IconButton icon="chat_bubble" title={`Make ${b.name} speak now`} size={30} iconSize={16} onClick={() => groupAction('nudgeBot', { botId: b.id })} />
                <IconButton
                  icon={b.muted ? 'play_arrow' : 'pause'}
                  title={b.muted ? `Release ${b.name} (it answers what was kept for it)` : `Hold ${b.name} (skipped here; messages for it are kept)`}
                  size={30}
                  iconSize={16}
                  onClick={() => groupAction(b.muted ? 'release' : 'hold', { botId: b.id })}
                />
                <Show when={b.chatId}>
                  <IconButton icon="open_in_new" title={`Open ${b.name}'s own chat (thinking, tool calls)`} size={30} iconSize={16} onClick={() => groupAction('openBotChat', { botId: b.id })} />
                </Show>
              </div>
            </div>
          )}
        </For>
        <Show when={props.group?.others.length}>
          <div class="gc-label gc-others-head">Add from your crew</div>
          <For each={props.group!.others}>
            {(o) => (
              <div class="gc-member">
                <Avatar emoji={o.emoji} color={o.color} size={30} />
                <div class="gc-member-main">
                  <div class="gc-member-name">{o.name}</div>
                  <div class="gc-member-tag">
                    <AgentMark agent={o.agent} size={14} /> {o.title || agentLabel(o.agent)}
                  </div>
                </div>
                <button class="text-btn" onClick={() => groupAction('addMember', { botId: o.id })}>
                  <Icon name="add" size={16} /> Add
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>
    </Dialog>
  );
}

function BotEditor(props: { open: boolean; bot: GroupBotView | null; count: number; onClose: () => void }) {
  const [name, setName] = createSignal('');
  const [emoji, setEmoji] = createSignal('');
  const [color, setColor] = createSignal(PALETTE[0]);
  const [persona, setPersona] = createSignal('');
  const [agent, setAgent] = createSignal<AgentKind>(state.defaultAgent);
  const [model, setModel] = createSignal<string | null>(null);
  const [chattiness, setChattiness] = createSignal(40);
  const [access, setAccess] = createSignal<GroupBotAccess>('chat');
  const [effort, setEffort] = createSignal('default');
  const [confirmDelete, setConfirmDelete] = createSignal(false);

  createEffect(
    on(
      () => props.open,
      (o) => {
        if (!o) return;
        const b = props.bot;
        setName(b?.name ?? '');
        setEmoji(b?.emoji ?? '');
        setColor(b?.color ?? PALETTE[props.count % PALETTE.length]);
        setPersona(b?.persona ?? '');
        setAgent(b?.agent ?? (enabledAgents()[props.count % Math.max(1, enabledAgents().length)] ?? state.defaultAgent));
        setModel(b?.modelId ?? null);
        setChattiness(b?.chattiness ?? 40);
        setAccess(b?.access ?? 'chat');
        setEffort(b?.effort ?? 'default');
      },
    ),
  );
  createEffect(() => {
    if (props.open) requestModels(agent());
  });
  const restarts = () => {
    const b = props.bot;
    return !!b?.chatId && (b.agent !== agent() || b.modelId !== model());
  };
  const save = () => {
    const data = { name: name().trim(), emoji: emoji().trim(), color: color(), persona: persona().trim(), agent: agent(), modelId: model(), chattiness: chattiness(), access: access(), effort: effort() };
    if (!data.name) return;
    if (props.bot) groupAction('updateBot', { botId: props.bot.id, data });
    else groupAction('addBot', { data });
    props.onClose();
  };
  return (
    <>
      <Dialog
        open={props.open}
        onClose={props.onClose}
        title={props.bot ? `Edit ${props.bot.name}` : 'New member'}
        width={480}
        actions={
          <>
            <Show when={props.bot}>
              <button class="text-btn danger" onClick={() => setConfirmDelete(true)}>
                Remove
              </button>
            </Show>
            <span class="flex1" />
            <button class="text-btn" onClick={props.onClose}>
              Cancel
            </button>
            <button class="filled-btn" disabled={!name().trim()} onClick={save}>
              {props.bot ? 'Save' : 'Add'}
            </button>
          </>
        }
      >
        <div class="gc-form">
          <div class="gc-avatar-edit">
            <Avatar emoji={emoji().trim() || (name().trim()[0] ?? '?').toUpperCase()} color={color()} size={52} />
            <div class="gc-avatar-fields">
              <div class="gc-row2">
                <Field label="Name" grow>
                  <input class="gc-input" value={name()} placeholder="Nova" maxLength={24} onInput={(e) => setName(e.currentTarget.value)} />
                </Field>
                <Field label="Emoji">
                  <input class="gc-input gc-emoji" value={emoji()} placeholder="🚀" maxLength={8} onInput={(e) => setEmoji(e.currentTarget.value)} />
                </Field>
              </div>
              <div class="gc-swatches">
                <For each={PALETTE}>{(c) => <button class="gc-swatch" classList={{ on: color() === c }} style={{ background: c }} title={c} onClick={() => setColor(c)} />}</For>
              </div>
            </div>
          </div>
          <Field label="Soul (persona)" hint="Who they are, how they talk, what they care about. It is the crew bot's: every room and its DM follow, and an edit applies at once.">
            <textarea
              class="gc-input gc-textarea"
              rows={4}
              placeholder="A grumpy senior engineer who has seen every bug twice. Short sentences, dry humor, hates over-engineering, secretly kind."
              value={persona()}
              onInput={(e) => setPersona(e.currentTarget.value)}
            />
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
          </div>
          <Field label={`Chattiness: ${chattiness()}`} hint="How often it joins in when nobody mentioned it.">
            <div class="gc-slider">
              <span class="gc-muted">Quiet</span>
              <input type="range" min={0} max={100} step={5} value={chattiness()} onInput={(e) => setChattiness(+e.currentTarget.value)} />
              <span class="gc-muted">Chatty</span>
            </div>
          </Field>
          <Field label="Access" hint={ACCESS.find((a) => a.id === access())?.hint}>
            <Segmented options={ACCESS} value={access()} onChange={setAccess} />
          </Field>
          <div class="gc-row2">
            <Field label="Effort" grow>
              <select class="gc-input" value={effort()} onChange={(e) => setEffort(e.currentTarget.value)}>
                <option value="default">Agent default</option>
                <option value="low">Low (cheapest)</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </Field>
          </div>
          <Show when={restarts()}>
            <div class="gc-hint warn">A new agent or model starts its memory of this room again (it catches up on the summary and the last 30 messages).</div>
          </Show>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete()}
        title={`Remove ${props.bot?.name ?? 'this bot'}?`}
        text="It leaves this room and its chat here is deleted. Its messages stay, and it stays in your crew."
        action="Remove"
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          if (props.bot) groupAction('removeBot', { botId: props.bot.id });
          setConfirmDelete(false);
          props.onClose();
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------------------------------------ group settings

function GroupSettings(props: { open: boolean; group: GroupView | null; onClose: () => void }) {
  const [title, setTitle] = createSignal('');
  const [topic, setTopic] = createSignal('');
  const [userName, setUserName] = createSignal('');
  const [mode, setMode] = createSignal<GroupMode>('auto');
  const [lead, setLead] = createSignal<string | null>(null);
  const [drafting, setDrafting] = createSignal<'turns' | 'parallel'>('turns');
  const [turnsEach, setTurnsEach] = createSignal(1);
  /** The router's agent / model were changed here (else the room keeps "the lead's agent, its cheapest model"). */
  const [routerSet, setRouterSet] = createSignal(false);
  const [modAgent, setModAgent] = createSignal<AgentKind>(state.defaultAgent);
  const [modModel, setModModel] = createSignal<string | null>(null);
  const [maxTurns, setMaxTurns] = createSignal(6);
  const [autoTalk, setAutoTalk] = createSignal(false);
  const [idle, setIdle] = createSignal(60);
  const [confirm, setConfirm] = createSignal<'clear' | 'delete' | null>(null);

  createEffect(
    on(
      () => props.open,
      (o) => {
        const g = props.group;
        if (!o || !g) return;
        setTitle(g.title);
        setTopic(g.topic);
        setUserName(g.userName);
        setMode(g.mode);
        setLead(g.lead);
        setDrafting(g.drafting);
        setTurnsEach(g.turnsPerMember);
        setRouterSet(false);
        setModAgent(g.moderatorAgent ?? g.bots.find((b) => b.id === g.lead)?.agent ?? enabledAgents()[0] ?? state.defaultAgent);
        setModModel(g.moderatorModelId);
        setMaxTurns(g.maxBotTurns);
        setAutoTalk(g.autoTalk);
        setIdle(g.idleSeconds);
      },
    ),
  );
  createEffect(() => {
    if (props.open && (mode() === 'moderator' || mode() === 'auto')) requestModels(modAgent());
  });
  const save = () => {
    groupAction('update', {
      data: {
        title: title(),
        topic: topic(),
        userName: userName(),
        mode: mode(),
        ...(lead() ? { lead: lead() } : {}),
        drafting: drafting(),
        turnsPerMember: turnsEach(),
        ...((mode() === 'moderator' || mode() === 'auto') && routerSet() ? { moderatorAgent: modAgent(), moderatorModelId: modModel() } : {}),
        maxBotTurns: maxTurns(),
        autoTalk: autoTalk(),
        idleSeconds: idle(),
      },
    });
    props.onClose();
  };
  return (
    <>
      <Dialog
        open={props.open}
        onClose={props.onClose}
        title="Room settings"
        width={480}
        actions={
          <>
            <button class="text-btn" onClick={props.onClose}>
              Cancel
            </button>
            <button class="filled-btn" onClick={save}>
              Save
            </button>
          </>
        }
      >
        <div class="gc-form">
          <div class="gc-row2">
            <Field label="Name" grow>
              <input class="gc-input" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
            </Field>
            <Field label="Your name">
              <input class="gc-input gc-short" value={userName()} onInput={(e) => setUserName(e.currentTarget.value)} />
            </Field>
          </div>
          <Field label="Bulletin" hint="What the room is for. Every member is told; a change is announced in the room.">
            <textarea class="gc-input gc-textarea" rows={2} value={topic()} onInput={(e) => setTopic(e.currentTarget.value)} />
          </Field>
          <Field label="Who speaks" hint={MODES.find((m) => m.id === mode())?.hint}>
            <Segmented options={MODES} value={mode()} onChange={setMode} />
          </Field>
          <Show when={props.group?.bots.length}>
            <Field label="Lead" hint="Answers what nobody else is picked for (Lead mode; Auto mode when the router is unsure).">
              <select class="gc-input" value={lead() ?? ''} onChange={(e) => setLead(e.currentTarget.value || null)}>
                <For each={props.group!.bots}>{(b) => <option value={b.id}>{`${b.emoji} ${b.name}`}</option>}</For>
              </select>
            </Field>
          </Show>
          <Show when={mode() === 'moderator' || mode() === 'auto'}>
            <div class="gc-row2">
              <Field label={mode() === 'auto' ? 'Router agent' : 'Moderator agent'} grow>
                <AgentSelect
                  value={modAgent()}
                  onChange={(a) => {
                    setModAgent(a);
                    setModModel(null);
                    setRouterSet(true);
                  }}
                />
              </Field>
              <Field label="Model (default: its cheapest)" grow>
                <ModelSelect
                  agent={modAgent()}
                  value={modModel()}
                  onChange={(m) => {
                    setModModel(m);
                    setRouterSet(true);
                  }}
                />
              </Field>
            </div>
          </Show>
          <Field label="Drafting" hint={drafting() === 'parallel' ? 'Everyone picked writes at once (faster); posts still land in order and each sees the others next turn.' : 'One member at a time, so each sees what the one before said.'}>
            <Segmented
              options={[
                { id: 'turns', label: 'One at a time' },
                { id: 'parallel', label: 'At once' },
              ]}
              value={drafting()}
              onChange={setDrafting}
            />
          </Field>
          <Field label={`Turns per member: ${turnsEach()}`} hint="How often each member may speak before you write again (the last turn is told to wrap up).">
            <input type="range" min={1} max={5} value={turnsEach()} onInput={(e) => setTurnsEach(+e.currentTarget.value)} />
          </Field>
          <Field label={`Bot messages in a row: ${maxTurns()}`} hint="Then the bots wait for you (keeps them from talking forever and using up your quota).">
            <input type="range" min={1} max={30} value={maxTurns()} onInput={(e) => setMaxTurns(+e.currentTarget.value)} />
          </Field>
          <label class="gc-check">
            <input type="checkbox" checked={autoTalk()} onChange={(e) => setAutoTalk(e.currentTarget.checked)} /> Auto-talk: a bot speaks up when the room is quiet (only
            while this group is open)
          </label>
          <Show when={autoTalk()}>
            <Field label={`Quiet for ${idle()} s`}>
              <input type="range" min={10} max={600} step={10} value={idle()} onInput={(e) => setIdle(+e.currentTarget.value)} />
            </Field>
          </Show>
          <Field label="Project folder" hint="Bots with read / edit access work here (default: the open workspace). Talk-only bots use a private empty folder.">
            <div class="gc-project">
              <span class="gc-path" title={props.group?.project ?? ''}>
                {props.group?.project ?? 'The open workspace'}
              </span>
              <button class="text-btn" onClick={() => groupAction('pickProject')}>
                Choose…
              </button>
              <Show when={props.group?.project}>
                <button class="text-btn muted" onClick={() => groupAction('pickProject', { data: { clear: true } })}>
                  Reset
                </button>
              </Show>
            </div>
          </Field>
          <div class="gc-danger">
            <button class="text-btn danger" onClick={() => setConfirm('clear')}>
              <Icon name="refresh" size={16} /> Clear chat
            </button>
            <button class="text-btn danger" onClick={() => setConfirm('delete')}>
              <Icon name="delete_o" size={16} /> Delete room
            </button>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirm() !== null}
        title={confirm() === 'delete' ? 'Delete this room?' : 'Clear the chat?'}
        text={
          confirm() === 'delete'
            ? 'Its messages and the members’ chats in it are deleted. The members stay in your crew.'
            : 'Every message is deleted and each member starts this room with a fresh memory. The members stay.'
        }
        action={confirm() === 'delete' ? 'Delete' : 'Clear'}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm();
          setConfirm(null);
          props.onClose();
          if (c === 'delete') {
            groupAction('delete');
            setOpenGroupId(null);
          } else groupAction('clear');
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------------------------------------ small parts

export function Field(props: { label: string; hint?: string; grow?: boolean; children: JSX.Element }) {
  return (
    <div class="gc-field" classList={{ grow: props.grow }}>
      <span class="gc-label">{props.label}</span>
      {props.children}
      <Show when={props.hint}>
        <span class="gc-hint">{props.hint}</span>
      </Show>
    </div>
  );
}

export function Segmented<T extends string>(props: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div class="gc-seg">
      <For each={props.options}>
        {(o) => (
          <button type="button" classList={{ on: props.value === o.id }} onClick={() => props.onChange(o.id)}>
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

export function AgentSelect(props: { value: AgentKind; onChange: (a: AgentKind) => void }) {
  const agents = () => {
    const list = enabledAgents();
    return list.includes(props.value) ? list : [props.value, ...list];
  };
  return (
    <select class="gc-input" value={props.value} onChange={(e) => props.onChange(e.currentTarget.value as AgentKind)}>
      <For each={agents()}>{(a) => <option value={a}>{agentLabel(a)}</option>}</For>
    </select>
  );
}

export function ModelSelect(props: { agent: AgentKind; value: string | null; onChange: (m: string | null) => void }) {
  const models = () => state.models[props.agent]?.models ?? [];
  return (
    <select class="gc-input" value={props.value ?? ''} onChange={(e) => props.onChange(e.currentTarget.value || null)}>
      <option value="">Agent default</option>
      <Show when={props.value && !models().some((m) => m.id === props.value)}>
        <option value={props.value!}>{shortModelName(props.value!)}</option>
      </Show>
      <For each={models()}>{(m) => <option value={m.id}>{m.displayName}</option>}</For>
    </select>
  );
}

export function ConfirmDialog(props: { open: boolean; title: string; text: string; action: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      width={360}
      actions={
        <>
          <button class="text-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button class="text-btn danger strong" onClick={props.onConfirm}>
            {props.action}
          </button>
        </>
      }
    >
      <div class="gc-hint">{props.text}</div>
    </Dialog>
  );
}
