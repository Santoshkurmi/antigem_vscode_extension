// ui/components/ChatInputBar.kt + QueuedMessagesCard.kt + ui/chat/SlashCommandOverlay.kt (and the @ file popup of
// ChatScreen): the rounded composer with [+], the model pill (quota badge), and the send / stop button.
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import type { AgentKind, ChatAttachment, QueuedMessage } from '@shared/model';
import type { FileSuggestion, SlashCommandView } from '@shared/protocol';
import {
  composerInsert,
  editorContext,
  focusTick,
  incomingAttachments,
  pickAttachments,
  searchFiles,
  send,
  newChat,
  openConversation,
  sendMessage,
  setComposerInsert,
  setIncomingAttachments,
  showToast,
  state,
  stop,
} from '../state/store';
import { ComposerChip, selectionLabel } from './Attachments';
import { Collapse, Dialog, Icon, type IconName } from '../ui/primitives';
import { isRunning } from './Feed';
import { alpha } from '../util/format';
import { quotaPillWindow } from '../theme';
import { openAgentSettings, openSettings, setThemePanelOpen } from '../state/settings';

export const [modelSheetOpen, setModelSheetOpen] = createSignal(false);

// ------------------------------------------------------------------------------------------------ popups state

type Popup =
  | { kind: 'slash'; items: SlashCommandView[]; query: string; index: number; pick: (c: SlashCommandView) => void; runs: (c: SlashCommandView) => boolean }
  | { kind: 'mention'; files: FileSuggestion[]; query: string; index: number; pick: (f: FileSuggestion) => void };
const [popup, setPopup] = createSignal<Popup | null>(null);

const drafts = new Map<string, string>();

// ------------------------------------------------------------------------------------------------ composer chips

const [attachments, setAttachments] = createSignal<ChatAttachment[]>([]);
const newId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const sameAtt = (a: ChatAttachment, b: ChatAttachment) =>
  !!a.path && a.path === b.path && (a.kind ?? null) === (b.kind ?? null) && (a.lineStart ?? 0) === (b.lineStart ?? 0) && (a.lineEnd ?? 0) === (b.lineEnd ?? 0);

/** Add chips to the composer (picker, drop, paste, VS Code commands); the same file / range is not added twice. */
export function addComposerAttachments(list: ChatAttachment[]) {
  setAttachments((cur) => {
    const out = [...cur];
    for (const a of list) if (!out.some((x) => sameAtt(x, a))) out.push({ ...a, id: a.id || newId() });
    return out;
  });
}

/** A file / folder by path, as a chip (an `@` pick, the active editor's file). */
export function fileChip(path: string, kind: 'file' | 'folder' = 'file'): ChatAttachment {
  const name = path.replace(/\/+$/, '').substring(path.replace(/\/+$/, '').lastIndexOf('/') + 1) || path;
  const image = kind === 'file' && /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
  return { id: newId(), name, path, isImage: image, isAudio: false, size: 0, reference: true, kind: image ? 'image' : kind };
}

/** Images from the clipboard / an OS drop, as image chips (base64 png/jpeg…). */
export function imageFilesToChips(files: File[]) {
  files.forEach((f, i) => {
    const r = new FileReader();
    r.onload = () => {
      const data = String(r.result);
      addComposerAttachments([
        {
          id: newId(),
          name: f.name && f.name !== 'image.png' ? f.name : `pasted-image-${Date.now() % 100000}${i ? `-${i}` : ''}.png`,
          path: '',
          isImage: true,
          isAudio: false,
          size: f.size,
          mimeType: f.type || 'image/png',
          base64: data.substring(data.indexOf(',') + 1),
          kind: 'image',
        },
      ]);
    };
    r.readAsDataURL(f);
  });
}

// the editor's selection offered with the next message: included unless the user took it out (until it changes)
const [excludedKey, setExcludedKey] = createSignal<string | null>(null);
const offerKey = () => {
  const c = editorContext();
  if (!c?.selection) return null;
  return `${c.path}:${c.selection.startLine}-${c.selection.endLine}:${c.selection.text.length}`;
};
const selectionIncluded = () => !!offerKey() && excludedKey() !== offerKey();
function selectionAttachment(): ChatAttachment | null {
  const c = editorContext();
  if (!c?.selection || !selectionIncluded()) return null;
  return {
    id: newId(),
    name: selectionLabel(c.name, c.selection.startLine, c.selection.endLine),
    path: c.path,
    isImage: false,
    isAudio: false,
    size: c.selection.text.length,
    reference: true,
    kind: 'selection',
    lineStart: c.selection.startLine,
    lineEnd: c.selection.endLine,
    selectionText: c.selection.text,
    languageId: c.languageId,
  };
}

/** `/` commands of kind 'app' that open a screen of this view (per agent first, then for every agent). */
const AGENT_APP_COMMANDS: Partial<Record<AgentKind, Record<string, () => void>>> = {
  CODEX: {
    status: () => openAgentSettings('CODEX'),
    mcp: () => openAgentSettings('CODEX', { id: 'codex.mcp', title: 'MCP servers' }),
  },
  CLAUDE: {
    mcp: () => openAgentSettings('CLAUDE', { id: 'claude.mcp', title: 'MCP servers' }),
    config: () => openAgentSettings('CLAUDE'),
  },
  OPENCODE: {
    mcp: () => openAgentSettings('OPENCODE', { id: 'opencode.mcp', title: 'MCP servers' }),
    connect: () => openAgentSettings('OPENCODE', { id: 'opencode.providers', title: 'Providers' }),
  },
};
const APP_COMMANDS: Record<string, () => void> = {
  model: () => setModelSheetOpen(true),
  models: () => setModelSheetOpen(true),
  settings: () => openSettings(),
  config: () => openSettings(),
  theme: () => setThemePanelOpen(true),
  themes: () => setThemePanelOpen(true),
  new: () => newChat(),
};
const appCommand = (cmd: string) => {
  const k = cmd.replace(/^\//, '').toLowerCase();
  return AGENT_APP_COMMANDS[state.chat.agent]?.[k] ?? APP_COMMANDS[k];
};

/**
 * `/plu:` suggestions like the app (PromptExpansion.kt; the host's pluginSuggestions): before a second colon only the
 * plugins (`/plu:<id>:`, or `/plu:<id>` for one without skills), matched on id and name; after it that plugin's skills
 * (`/plu:<id>:<skill>`), led by the plugin on its own while no skill is typed.
 */
function pluginItems(all: SlashCommandView[], afterPlu: string): SlashCommandView[] {
  const plugins = all.filter((c) => c.kind === 'plugin' && /^\/plu:[^:\s]+:?$/i.test(c.command));
  const has = (s: string | null | undefined, q: string) => !!s && s.toLowerCase().includes(q.toLowerCase());
  const idOf = (c: SlashCommandView) => c.command.replace(/^\/plu:/i, '').replace(/:$/, '');
  const colon = afterPlu.indexOf(':');
  if (colon < 0) {
    const q = afterPlu.trim();
    return plugins.filter((c) => !q || has(idOf(c), q) || has(c.pluginName, q) || has(c.description, q));
  }
  const id = afterPlu.slice(0, colon).toLowerCase();
  const query = afterPlu.slice(colon + 1).trim();
  const plugin = plugins.find((c) => idOf(c).toLowerCase() === id);
  if (!plugin) return [];
  const pid = idOf(plugin);
  const name = plugin.pluginName || plugin.description?.split(' · ')[0] || pid;
  const skills = all.filter((c) => {
    const m = /^\/plu:([^:\s]+):(\S+)$/i.exec(c.command);
    return c.kind === 'plugin' && !!m && m[1].toLowerCase() === id && (!query || has(m[2], query) || has(c.description, query));
  });
  const whole: SlashCommandView = { command: `/plu:${pid}`, description: `Use ${name} without a specific skill`, kind: 'plugin', pluginName: plugin.pluginName };
  return query ? skills : [whole, ...skills];
}

function quotaColor(left: number) {
  return left > 0.5 ? 'var(--success)' : left > 0.2 ? 'var(--warning)' : 'var(--danger)';
}

export function InputBar() {
  let ta!: HTMLTextAreaElement;
  const [text, setText] = createSignal('');
  const [confirmStop, setConfirmStop] = createSignal(false);
  const draftKey = () => state.chat.conversationId ?? `new:${state.chat.agent}`;

  // drafts per chat
  createEffect(
    on(draftKey, (key, prev) => {
      if (prev !== undefined) drafts.set(prev, text());
      setText(drafts.get(key) ?? '');
      queueMicrotask(autosize);
    }),
  );
  // text pushed by the host (insertText, rewind)
  createEffect(
    on(composerInsert, (ins) => {
      if (!ins) return;
      setComposerInsert(null);
      const cur = text();
      setText(ins.replace || !cur ? ins.text : cur + (cur.endsWith(' ') || cur.endsWith('\n') ? '' : ' ') + ins.text);
      queueMicrotask(() => {
        autosize();
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    }),
  );

  // VS Code commands: "Add to AntiGem Chat" / "Add Selection" (chips), the focus shortcut
  createEffect(
    on(incomingAttachments, (inc) => {
      if (!inc) return;
      setIncomingAttachments(null);
      addComposerAttachments(inc.list);
    }),
  );
  createEffect(
    on(
      focusTick,
      () => {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      },
      { defer: true },
    ),
  );

  const models = () => state.models[state.chat.agent];
  const model = createMemo(() => {
    const m = models();
    if (!m) return null;
    // the chat's own model first (per-chat model agents), then the agent's selection, then its default
    const own = state.chat.modelId;
    return (own && m.models.find((x) => x.id === own || x.key === own)) || m.models.find((x) => x.id === m.selectedId) || m.models.find((x) => x.isDefault) || null;
  });
  const modelName = () => model()?.displayName ?? (models() ? (models()!.models.length ? 'Choose model' : 'Models unavailable') : 'Loading models…');
  const familyColor = () => (model()?.family === 'CLAUDE' ? 'var(--primary)' : 'var(--info)');
  const placeholder = () => `Reply to ${(model()?.displayName ?? 'Gemini').split(' ')[0]}...`;

  // sub-agents / background work still running in this chat: the send button turns amber (ChatInputBar.kt)
  const backgroundActive = () => {
    const id = state.chat.conversationId;
    const c = id ? state.conversations.find((x) => x.id === id) : null;
    return !!c && !isRunning() && (c.notFullyIdle || c.hasActivity);
  };
  // the editor's selection goes with a message, it is not one by itself
  const canSend = () => text().trim().length > 0 || attachments().length > 0;
  const agentReady = () => {
    const s = state.agents.find((a) => a.kind === state.chat.agent)?.state;
    return !s || s === 'online';
  };

  const autosize = () => {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  };

  const doSend = () => {
    const t = text().trim();
    const sel = selectionAttachment();
    const atts = sel ? [sel, ...attachments().filter((a) => !sameAtt(a, sel))] : attachments();
    if (!t && !atts.length) return;
    if (!agentReady()) {
      showToast('The agent is not ready yet. Start it to send messages.', 'warning');
      return;
    }
    // clear the box (and this chat's draft) BEFORE sending: the first message of a new chat gives it its id, and that
    // key change saves the box as the "new chat" draft — with the text still in it, every next new chat showed it again
    const key = draftKey();
    batch(() => {
      setText('');
      setAttachments([]);
      setPopup(null);
    });
    drafts.delete(key);
    sendMessage(t, atts);
    drafts.delete(key);
    drafts.delete(draftKey());
    queueMicrotask(autosize);
  };

  // ---- `/` and `@` triggers
  let searchTimer: number | undefined;
  onCleanup(() => clearTimeout(searchTimer));
  const updateTriggers = () => {
    const caret = ta.selectionStart ?? text().length;
    const before = text().substring(0, caret);
    const slash = /(^|\s)\/([^\s/]*)$/.exec(before);
    if (slash) {
      const slashIndex = before.length - slash[2].length - 1;
      const query = slash[2];
      const nothingBefore = !before.substring(0, slashIndex).trim();
      const all = state.commands[state.chat.agent] ?? [];
      const q = query.toLowerCase();
      // in the picker's group order, so arrow keys walk the rows as shown
      const rank = (c: SlashCommandView) => {
        const i = ORDER.indexOf(c.kind ?? 'command');
        return i < 0 ? ORDER.length : i;
      };
      // `/plu:` browses plugins in two levels (PromptExpansion.kt): the plugins, then one plugin's skills
      const items = q.startsWith('plu:')
        ? pluginItems(all, query.slice(4))
        : all
            // a plugin's skills only show inside `/plu:<id>:` (the plugins themselves list here too)
            .filter((c) => !(c.kind === 'plugin' && /^\/plu:[^:\s]+:\S+$/i.test(c.command)))
            .filter(
              (c) =>
                !q ||
                c.command.replace(/^\//, '').toLowerCase().includes(q) ||
                (c.description ?? '').toLowerCase().includes(q),
            )
            .map((c, i) => ({ c, i }))
            .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
            .map((x) => x.c);
      const runs = (c: SlashCommandView) => !!c.runsOnTap && nothingBefore && !isRunning() && !attachments().length;
      if (!items.length) {
        setPopup(null);
        return;
      }
      setPopup({
        kind: 'slash',
        items,
        query,
        index: 0,
        runs,
        pick: (c) => {
          const head = text().substring(0, slashIndex);
          const tail = text().substring(caret);
          // "Opens in the app": the view handles the ones it has a screen for; any other goes to the agent as a
          // message (the back end answers it: a toast, a local reply)
          const local = c.kind === 'app' ? appCommand(c.command) : undefined;
          if (local) {
            setText((head + tail).replace(/\s+$/, head ? ' ' : ''));
            setPopup(null);
            local();
            return;
          }
          if (c.kind === 'app' && !head.trim() && !tail.trim()) {
            setText('');
            setPopup(null);
            sendMessage(c.command, []);
            return;
          }
          if (runs(c)) {
            setText('');
            setPopup(null);
            sendMessage(c.command, []);
            return;
          }
          const ins = c.command.endsWith(':') ? c.command : c.command + ' ';
          setText(head + ins + tail);
          setPopup(null);
          queueMicrotask(() => {
            ta.focus();
            const pos = (head + ins).length;
            ta.setSelectionRange(pos, pos);
            autosize();
            // a plugin (`/plu:<id>:`): straight on to its skills
            if (ins.endsWith(':')) updateTriggers();
          });
        },
      });
      return;
    }
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (at) {
      const atIndex = before.length - at[2].length - 1;
      const query = at[2];
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        searchFiles(query, (files) => {
          // still the same mention?
          const now = text().substring(0, ta.selectionStart ?? text().length);
          if (!/(^|\s)@([^\s@]*)$/.test(now)) return;
          if (!files.length) {
            setPopup(null);
            return;
          }
          setPopup({
            kind: 'mention',
            files,
            query,
            index: 0,
            pick: (f) => {
              // the typed "@query" goes; the file becomes a chip
              const head = text().substring(0, atIndex).replace(/ $/, (m) => (atIndex > 0 ? m : ''));
              const tail = text().substring(ta.selectionStart ?? text().length).replace(/^ /, '');
              const joined = head && tail && !/\s$/.test(head) ? `${head} ${tail}` : head + tail;
              setText(joined);
              addComposerAttachments([fileChip(f.path, f.kind ?? 'file')]);
              setPopup(null);
              queueMicrotask(() => {
                ta.focus();
                const pos = head.length;
                ta.setSelectionRange(pos, pos);
                autosize();
              });
            },
          });
        });
      }, 120);
      return;
    }
    clearTimeout(searchTimer);
    setPopup(null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const p = popup();
    if (p) {
      const n = p.kind === 'slash' ? p.items.length : p.files.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setPopup({ ...p, index: (p.index + d + n) % n } as Popup);
        requestAnimationFrame(() => document.querySelector('.slash-row.active, .mention-row.active')?.scrollIntoView({ block: 'nearest' }));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (p.kind === 'slash') p.pick(p.items[p.index]);
        else p.pick(p.files[p.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPopup(null);
        return;
      }
    }
    // Ctrl+Enter (Cmd+Enter on a Mac) makes a new line, like Shift+Enter; Enter alone sends
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      const a = ta.selectionStart ?? text().length;
      const b = ta.selectionEnd ?? a;
      const v = text().substring(0, a) + '\n' + text().substring(b);
      setText(v);
      ta.value = v;
      ta.setSelectionRange(a + 1, a + 1);
      autosize();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  };

  // pasted images become image chips (the app's attachment preview)
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    imageFilesToChips(files);
  };

  // the selected model's share left: 5h by default, 7d when picked in the model sheet or when it has no 5h limit
  const quota = () => {
    const m = model();
    if (!m) return null;
    const pct = (x: number) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;
    const g = models()?.groups?.find((x) => x.name === m.group);
    const win = (re: RegExp) => g?.windows?.find((w) => re.test(w.label));
    const weekly = win(/7 ?d|week/i);
    const fiveH = win(/^5 ?h|five/i);
    // the agent's own formatting of a window's share left wins ("48.8%" for Antigravity)
    if (weekly && (quotaPillWindow() === '7d' || (!fiveH && m.quotaRemaining == null))) return { left: weekly.remaining, text: `7d ${weekly.text?.trim() || pct(weekly.remaining)}` };
    if (m.quotaRemaining != null) return { left: Math.max(0, Math.min(1, m.quotaRemaining)), text: m.quotaText ?? pct(m.quotaRemaining) };
    if (m.quotaText) {
      const n = parseFloat(m.quotaText);
      return { left: Number.isFinite(n) ? n / 100 : 1, text: m.quotaText };
    }
    if (fiveH) return { left: fiveH.remaining, text: fiveH.text?.trim() || pct(fiveH.remaining) };
    return null;
  };

  return (
    <Show when={!state.chat.readOnly} fallback={<ReadOnlyBar />}>
    <div class="input-bar">
      <QueuedCard />
      <div class="composer">
        <div class="composer-inner">
          <textarea
            ref={ta}
            class="composer-text"
            rows={1}
            placeholder={placeholder()}
            value={text()}
            onInput={(e) => {
              setText(e.currentTarget.value);
              autosize();
              updateTriggers();
            }}
            onKeyDown={onKeyDown}
            onClick={updateTriggers}
            onBlur={() => setTimeout(() => setPopup(null), 150)}
            onPaste={onPaste}
          />
          <Show when={attachments().length || editorContext()}>
            <div class="composer-atts">
              <EditorOffer />
              <For each={attachments()}>{(a) => <ComposerChip att={a} onRemove={() => setAttachments((x) => x.filter((y) => y.id !== a.id))} />}</For>
            </div>
          </Show>
          <div class="composer-row">
            <button class="round-btn" title="Add attachments" onClick={() => pickAttachments((a) => setAttachments((x) => [...x, ...a]))}>
              <Icon name="add" size={19} />
            </button>
            <div class="model-pill-wrap">
              <button class="model-pill" onClick={() => setModelSheetOpen(true)} title="Switch Model">
                <Icon name="auto_awesome" size={13} color={familyColor()} />
                <span class="model-pill-name">{modelName()}</span>
                <Show when={quota()}>
                  {(q) => (
                    <span class="quota-badge" style={{ color: quotaColor(q().left), background: alpha(quotaColor(q().left), 0.15) }}>
                      {q().text}
                    </span>
                  )}
                </Show>
                <Icon name="chevron_down" size={14} class="model-pill-chev" />
              </button>
            </div>
            <div class="send-slot">
              <Show
                when={isRunning() && !canSend()}
                fallback={
                  <button
                    class="send-btn"
                    classList={{ idle: !canSend(), blocked: canSend() && !agentReady(), bg: canSend() && agentReady() && backgroundActive() }}
                    title="Send"
                    disabled={!canSend()}
                    onClick={doSend}
                  >
                    <Icon name="arrow_up" size={19} />
                  </button>
                }
              >
                <button class="send-btn stop" title="Stop" onClick={() => setConfirmStop(true)}>
                  <Icon name="stop" size={18} />
                </button>
              </Show>
            </div>
          </div>
        </div>
      </div>
      <Dialog
        open={confirmStop()}
        onClose={() => setConfirmStop(false)}
        radius={16}
        background="var(--surface)"
        title={
          <span class="row-center">
            <Icon name="cancel" size={22} color="var(--error)" />
            <span style={{ 'margin-left': '8px', 'font-size': 'calc(17.5 * var(--sp))', 'font-weight': 700 }}>Stop Generation?</span>
          </span>
        }
        actions={
          <>
            <button class="text-btn" onClick={() => setConfirmStop(false)}>
              Cancel
            </button>
            <button
              class="filled-btn small"
              style={{ background: 'var(--error)', color: 'var(--on-error)', 'border-radius': '8px' }}
              onClick={() => {
                setConfirmStop(false);
                stop();
              }}
            >
              Stop Output
            </button>
          </>
        }
      >
        <span style={{ color: alpha('var(--on-surface)', 0.8) }}>
          Do you want to stop the model from outputting? The current generation will be stopped immediately.
        </span>
      </Dialog>
    </div>
    </Show>
  );
}

// ------------------------------------------------------------------------------------------------ read-only chats

/**
 * A chat that takes no prompts here (a Claude subagent's: it takes instructions from its parent chat only): the
 * composer becomes a compact bar with the host's explanation and the way to the parent chat.
 */
function ReadOnlyBar() {
  const parent = () => {
    const id = state.chat.conversationId;
    return state.chat.conversation?.parentConversationId ?? (id ? state.conversations.find((c) => c.id === id)?.parentConversationId : null) ?? null;
  };
  return (
    <div class="input-bar">
      <div class="readonly-bar">
        <Icon name="call_split" size={17} class="readonly-icon" />
        <span class="readonly-text">{state.chat.readOnly}</span>
        <Show when={parent()}>
          <button class="readonly-open" onClick={() => openConversation(parent()!)}>
            <Icon name="open_in_new" size={15} />
            Open parent chat
          </button>
        </Show>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ editor offer

/**
 * What is open / selected in the VS Code editor, offered with the next message (like Claude Code's VS Code
 * extension): a selection is included by default (✕ takes it out until the selection changes; a tap shows the
 * lines); the active file alone is offered dimmed, a tap attaches it as a file chip.
 */
function EditorOffer() {
  const ctx = () => editorContext();
  const fileAttached = () => !!ctx() && attachments().some((a) => a.path === ctx()!.path && (a.kind ?? 'file') !== 'selection');
  return (
    <Show when={ctx() && (ctx()!.selection || !fileAttached())}>
      <Show
        when={ctx()!.selection}
        fallback={
          <button class="offer-chip off" title={`${ctx()!.relativePath} · attach the current file`} onClick={() => addComposerAttachments([fileChip(ctx()!.path)])}>
            <Icon name="visibility" size={15} />
            <span class="offer-name">{ctx()!.name}</span>
            <Icon name="add" size={14} class="offer-add" />
          </button>
        }
      >
        {(sel) => (
          <Show
            when={selectionIncluded()}
            fallback={
              <button class="offer-chip off" title="Not included · click to include the selection" onClick={() => setExcludedKey(null)}>
                <Icon name="visibility_off" size={15} />
                <span class="offer-name">{selectionLabel(ctx()!.name, sel().startLine, sel().endLine)}</span>
              </button>
            }
          >
            <div class="offer-chip on">
              <button
                class="offer-main"
                title={`${ctx()!.relativePath} · included with your message · click to show the lines`}
                onClick={() => send({ type: 'revealRange', path: ctx()!.path, startLine: sel().startLine, endLine: sel().endLine })}
              >
                <Icon name="visibility" size={15} />
                <span class="offer-name">{selectionLabel(ctx()!.name, sel().startLine, sel().endLine)}</span>
              </button>
              <button class="att-remove" title="Don't include the selection" onClick={() => setExcludedKey(offerKey())}>
                <Icon name="close_o" size={13} />
              </button>
            </div>
          </Show>
        )}
      </Show>
    </Show>
  );
}

// ------------------------------------------------------------------------------------------------ queued

function QueuedCard() {
  const items = () => state.chat.queued;
  const [last, setLast] = createSignal<QueuedMessage[]>([]);
  createEffect(() => {
    if (items().length) setLast(items().slice());
  });
  const shown = () => (items().length ? items() : last());
  const act = (id: string, action: 'sendNow' | 'delete') => {
    const c = state.chat.conversationId;
    if (c) send({ type: 'queueAction', conversationId: c, id, action });
  };
  return (
    <Collapse when={items().length > 0}>
      <div class="queued">
        <div class="queued-head">
          <Icon name="schedule_r" size={14} color="var(--text-secondary)" />
          <span class="queued-count">{shown().length === 1 ? '1 queued message' : `${shown().length} queued messages`}</span>
          <span class="queued-hint">Sends when the agent is done</span>
        </div>
        <For each={shown()}>
          {(q) => (
            <div class="queued-row">
              <span class="queued-text" classList={{ muted: !q.text.trim() }}>
                {q.text.trim().replace(/\s+/g, ' ') || (q.attachmentCount === 1 ? '1 attachment' : `${q.attachmentCount} attachments`)}
              </span>
              <Show when={q.isPending}>
                <span class="mini-spinner" />
              </Show>
              <Show when={q.canSendNow}>
                <button class="queued-btn" title="Send now" onClick={() => act(q.id, 'sendNow')}>
                  <Icon name="arrow_up_r" size={18} color="var(--on-background)" />
                </button>
              </Show>
              <Show when={q.canDelete}>
                <button class="queued-btn" title="Delete" onClick={() => act(q.id, 'delete')}>
                  <Icon name="close_r" size={18} color="var(--text-secondary)" />
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Collapse>
  );
}

// ------------------------------------------------------------------------------------------------ popups

const GROUPS: Record<string, { title: string; icon: IconName; color: string }> = {
  plugin: { title: 'Custom AntiGem plugins', icon: 'extension', color: 'var(--agy)' },
  custom: { title: 'Custom commands', icon: 'auto_awesome', color: 'var(--primary)' },
  app: { title: 'Opens in the app', icon: 'open_in_new', color: 'var(--agy)' },
  command: { title: 'Commands', icon: 'terminal_o', color: 'var(--primary)' },
  skill: { title: 'Skills & plugins', icon: 'extension', color: 'var(--success)' },
};
const ORDER = ['plugin', 'custom', 'app', 'command', 'skill'];

/** The `/` and `@` pickers, laid over the bottom of the chat (ChatScreen aligns them BottomCenter). */
export function ComposerPopups() {
  const slash = () => {
    const p = popup();
    return p?.kind === 'slash' ? p : null;
  };
  const mention = () => {
    const p = popup();
    return p?.kind === 'mention' ? p : null;
  };
  const groups = createMemo(() => {
    const p = slash();
    if (!p) return [];
    const by = new Map<string, { cmd: SlashCommandView; i: number }[]>();
    p.items.forEach((cmd, i) => {
      const k = ORDER.includes(cmd.kind ?? 'command') ? (cmd.kind ?? 'command') : 'skill';
      by.set(k, [...(by.get(k) ?? []), { cmd, i }]);
    });
    return ORDER.filter((k) => by.has(k)).map((k) => ({ key: k, ...GROUPS[k], list: by.get(k)! }));
  });
  const highlight = (name: string, q: string) => {
    const i = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (i < 0) return { a: name, b: '', c: '' };
    return { a: name.substring(0, i), b: name.substring(i, i + q.length), c: name.substring(i + q.length) };
  };
  return (
    <>
      <div class="popup-anchor" classList={{ shown: !!slash() }}>
        <Show when={slash()}>
          {(p) => (
            <div class="slash-popup" onMouseDown={(e) => e.preventDefault()}>
              <For each={groups()}>
                {(g) => (
                  <>
                    <div class="slash-group">
                      <span>{g.title.toUpperCase()}</span>
                      <span class="slash-count">{g.list.length}</span>
                    </div>
                    <For each={g.list}>
                      {({ cmd, i }) => {
                        const h = () => highlight(cmd.command, p().query);
                        const tag = () => cmd.pluginName ?? (cmd.kind === 'app' ? 'opens' : p().runs(cmd) ? 'runs' : null);
                        return (
                          <button class="slash-row" classList={{ active: p().index === i }} onClick={() => p().pick(cmd)} style={{ '--g': g.color }}>
                            <span class="slash-icon">
                              <Icon name={cmd.kind === 'skill' && !cmd.pluginName ? 'auto_awesome' : g.icon} size={16} color={g.color} />
                            </span>
                            <span class="slash-text">
                              <span class="slash-name">
                                {h().a}
                                <span style={{ color: g.color }}>{h().b}</span>
                                {h().c}
                                <Show when={cmd.argumentHint}>
                                  <span class="slash-hint"> {cmd.argumentHint}</span>
                                </Show>
                              </span>
                              <Show when={cmd.description}>
                                <span class="slash-desc">{cmd.description}</span>
                              </Show>
                            </span>
                            <Show when={tag()}>
                              <span class="slash-tag">{tag()}</span>
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                  </>
                )}
              </For>
            </div>
          )}
        </Show>
      </div>
      <div class="popup-anchor mention" classList={{ shown: !!mention() }}>
        <Show when={mention()}>
          {(p) => (
            <div class="mention-popup" onMouseDown={(e) => e.preventDefault()}>
              <For each={p().files}>
                {(f, i) => {
                  const rel = () => f.relativePath.replace(/\/+$/, '');
                  const name = () => rel().substring(rel().lastIndexOf('/') + 1) || rel();
                  const dir = () => rel().substring(0, Math.max(0, rel().lastIndexOf('/')));
                  const h = () => highlight(name(), p().query);
                  const folder = () => f.kind === 'folder';
                  return (
                    <button class="mention-row" classList={{ active: p().index === i() }} onClick={() => p().pick(f)} title={f.path}>
                      <Icon name={folder() ? 'folder' : 'description'} size={16} color={folder() ? 'var(--warning)' : 'var(--primary)'} />
                      <span class="mention-name">
                        {h().a}
                        <mark>{h().b}</mark>
                        {h().c}
                        {folder() ? '/' : ''}
                      </span>
                      <Show when={f.isOpen}>
                        <span class="mention-open">open</span>
                      </Show>
                      <span class="mention-path">{dir()}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          )}
        </Show>
      </div>
    </>
  );
}

