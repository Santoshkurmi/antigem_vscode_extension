// The view's whole state: one Solid store fed by host messages (protocol.ts). Messages live in their own keyed store
// and are merged with reconcile(), so a streaming patch only touches the fields that changed: one message re-renders,
// the rest of the chat does not.
import { batch, createSignal } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import type {
  AgentKind,
  ArtifactSnapshot,
  ChatAttachment,
  ChatMessage,
  Conversation,
  QueuedMessage,
} from '@shared/model';
import type {
  AgentStatus,
  ApprovalView,
  ChatPatch,
  ControlChipView,
  ChatSearchHit,
  ConversationAction,
  EditorContextView,
  FileSuggestion,
  HostToView,
  ModelsState,
  ProjectView,
  QuestionView,
  SlashCommandView,
  ViewToHost,
  WorkspaceFolder,
} from '@shared/protocol';
import { host } from '../host';
import { patchUiPrefs, setThemeSurface, setUiPrefsSignal, uiPrefs } from '../theme';
import { jarvisDraft, setJarvisDraft } from './jarvis';

export interface ChatState {
  conversationId: string | null;
  conversation: Conversation | null;
  agent: AgentKind;
  order: string[];
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  queued: QueuedMessage[];
  approvals: ApprovalView[];
  question: QuestionView | null;
  artifacts: ArtifactSnapshot[];
  workingLabel: string | null;
  /** The agent's controls strip above the composer (ClaudeControlsStrip / CodexControlsStrip / OpenCodeControlsStrip). */
  controls: ControlChipView[];
  /** One-line notice above the strip (a reroute, a provider hiccup). */
  notice: string | null;
  /** The chat's own model (per-chat model agents): the model pill prefers it. */
  modelId: string | null;
  /** Set for a chat that takes no prompts here (a Claude subagent's): the composer becomes a bar with this text. */
  readOnly: string | null;
  /** Prompts sent from this view that the host has not listed yet (shown right away). */
  pending: ChatMessage[];
  /** Bumped when the user sends: the feed jumps to the end. */
  sentTick: number;
}

export interface Toast {
  id: number;
  level: 'info' | 'warning' | 'error' | 'success';
  message: string;
}

export interface AppState {
  initialized: boolean;
  viewKind: 'sidebar' | 'panel' | 'browser';
  workspaceFolders: WorkspaceFolder[];
  /** Project of the next new chat (file:// URI). */
  workspaceUri: string | null;
  defaultAgent: AgentKind;
  agents: AgentStatus[];
  conversations: Conversation[];
  conversationsLoaded: boolean;
  models: Partial<Record<AgentKind, ModelsState>>;
  commands: Partial<Record<AgentKind, SlashCommandView[]>>;
  chat: ChatState;
  toasts: Toast[];
  ui: ViewUi;
}

/** Small per-view preferences kept with host.setState (they survive the webview being hidden). */
export interface ViewUi {
  groupByWorkspace: boolean;
  showArchived: boolean;
  agentFilter: AgentKind | null;
}

const AGENTS: AgentKind[] = ['AGY', 'CLAUDE', 'OPENCODE', 'CODEX'];

function emptyChat(conversationId: string | null, agent: AgentKind): ChatState {
  return {
    conversationId,
    conversation: null,
    agent,
    order: [],
    isStreaming: false,
    isLoading: false,
    error: null,
    queued: [],
    approvals: [],
    question: null,
    artifacts: [],
    workingLabel: null,
    controls: [],
    notice: null,
    modelId: null,
    readOnly: null,
    pending: [],
    sentTick: 0,
  };
}

const saved = host.getState<{ ui?: Partial<ViewUi> }>();

export const [state, setState] = createStore<AppState>({
  initialized: false,
  viewKind: 'sidebar',
  workspaceFolders: [],
  workspaceUri: null,
  defaultAgent: 'AGY',
  agents: [],
  conversations: [],
  conversationsLoaded: false,
  models: {},
  commands: {},
  chat: emptyChat(null, 'AGY'),
  toasts: [],
  ui: {
    groupByWorkspace: saved?.ui?.groupByWorkspace ?? false,
    showArchived: false,
    agentFilter: saved?.ui?.agentFilter ?? null,
  },
});

/** Messages by id (the chat's order is state.chat.order). */
export const [messages, setMessages] = createStore<Record<string, ChatMessage>>({});

/** A prompt left this view and the agent has not started answering (keeps the working row steady). */
export const [awaitingReply, setAwaitingReply] = createSignal(false);
let awaitTimer: number | undefined;

/** Text the composer should take (insertText / rewind); the input bar consumes it. */
export const [composerInsert, setComposerInsert] = createSignal<{ text: string; replace: boolean; n: number } | null>(null);

const listeners = {
  attachments: new Map<string, (a: ChatAttachment[]) => void>(),
  files: new Map<string, (f: FileSuggestion[]) => void>(),
  projects: new Map<string, (p: ProjectView[]) => void>(),
  folder: new Map<string, (p: ProjectView | null) => void>(),
  image: new Map<string, (d: string | null) => void>(),
  media: new Map<string, (r: { url: string | null; error: string | null }) => void>(),
  chatSearch: new Map<string, (r: ChatSearchHit[]) => void>(),
};

/** No agents chosen yet (init.firstRun): the first-run agent picker covers the view. */
export const [firstRun, setFirstRun] = createSignal(false);

/** The first-run choice: the agents to run (the host restarts with them and sends the agents again). */
export function chooseFirstAgents(agents: AgentKind[]) {
  send({ type: 'settingChange', page: 'agents', id: 'agents.enabled', value: agents });
  setFirstRun(false);
}

/** The VS Code editor's active file / selection (the composer's offer chip). */
export const [editorContext, setEditorContext] = createSignal<EditorContextView | null>(null);
/** Chips pushed by the host (VS Code "Add to AntiGem Chat" commands); the composer takes them. */
export const [incomingAttachments, setIncomingAttachments] = createSignal<{ list: ChatAttachment[]; n: number } | null>(null);
/** Bumped when the host asks for the cursor in the composer. */
export const [focusTick, setFocusTick] = createSignal(0);

export const send = (msg: ViewToHost) => host.send(msg);

function persistUi() {
  host.setState({ ui: { groupByWorkspace: state.ui.groupByWorkspace, agentFilter: state.ui.agentFilter } });
}

export function setUi<K extends keyof ViewUi>(key: K, value: ViewUi[K]) {
  setState('ui', key, value as any);
  persistUi();
  // grouping is one of the shared prefs (Settings → Appearance), the same in every view
  if (key === 'groupByWorkspace') {
    patchUiPrefs({ groupByWorkspace: value });
    host.send({ type: 'setUiPref', key, value });
  }
}

// ------------------------------------------------------------------------------------------------ host → view

let toastId = 0;
export function showToast(message: string, level: Toast['level'] = 'info') {
  const id = ++toastId;
  setState('toasts', (t) => [...t, { id, level, message }]);
  setTimeout(() => setState('toasts', (t) => t.filter((x) => x.id !== id)), level === 'error' ? 5000 : 3000);
}

function applyChat(conversationId: string | null, patch: ChatPatch) {
  if (!patch.reset && conversationId !== state.chat.conversationId) return;
  batch(() => {
    if (patch.reset) {
      const agent = patch.agent ?? patch.conversation?.agent ?? state.chat.agent;
      const sentTick = state.chat.sentTick;
      // a reset for the chat this view just created keeps its unconfirmed prompt until the host lists it
      const pending = conversationId && conversationId === state.chat.conversationId ? state.chat.pending : [];
      setState('chat', { ...emptyChat(conversationId, agent), sentTick, pending });
      setMessages(reconcile({}));
    }
    if (patch.upserts?.length) {
      const fresh = patch.upserts.filter((m) => !messages[m.id]);
      if (fresh.length) {
        setMessages(
          produce((all) => {
            for (const m of fresh) all[m.id] = m;
          }),
        );
      }
      for (const m of patch.upserts) {
        // existing messages merge field by field (toolCalls / attachments by id)
        if (!fresh.includes(m)) setMessages(m.id, reconcile(m, { key: 'id', merge: false }));
      }
    }
    if (patch.order) {
      const before = new Set(state.chat.order);
      setState('chat', 'order', reconcile(patch.order));
      if (state.chat.pending.length) {
        // the host's copy of a prompt sent from here replaces it: by text, or (when the host changed the text, e.g.
        // expanded a command) the first prompt it newly lists takes the place of the oldest pending one
        const contents = new Set(patch.order.map((id) => messages[id]).filter((m) => m?.role === 'USER').map((m) => m!.content.trim()));
        let fresh = patch.order.filter((id) => !before.has(id) && messages[id]?.role === 'USER').length;
        setState('chat', 'pending', (p) =>
          p.filter((m) => {
            if (contents.has(m.content.trim())) {
              fresh--;
              return false;
            }
            return true;
          }).filter(() => (fresh-- > 0 ? false : true)),
        );
      }
    }
    if (patch.conversation !== undefined) setState('chat', 'conversation', patch.conversation ? reconcile(patch.conversation) : null);
    if (patch.agent) setState('chat', 'agent', patch.agent);
    if (patch.isStreaming !== undefined) setState('chat', 'isStreaming', patch.isStreaming);
    if (patch.isLoading !== undefined) setState('chat', 'isLoading', patch.isLoading);
    if (patch.error !== undefined) setState('chat', 'error', patch.error);
    if (patch.queued) setState('chat', 'queued', reconcile(patch.queued));
    if (patch.approvals) setState('chat', 'approvals', reconcile(patch.approvals, { key: 'key' }));
    if (patch.question !== undefined) setState('chat', 'question', patch.question ? reconcile(patch.question, { key: 'id' }) : null);
    if (patch.artifacts) setState('chat', 'artifacts', reconcile(patch.artifacts, { key: 'absoluteUri' }));
    if (patch.workingLabel !== undefined) setState('chat', 'workingLabel', patch.workingLabel);
    if (patch.controls) setState('chat', 'controls', reconcile(patch.controls, { key: 'id' }));
    if (patch.notice !== undefined) setState('chat', 'notice', patch.notice);
    if (patch.modelId !== undefined) setState('chat', 'modelId', patch.modelId);
    if (patch.readOnly !== undefined) setState('chat', 'readOnly', patch.readOnly ?? null);
  });
}

function onHostMessage(msg: HostToView) {
  switch (msg.type) {
    case 'init':
      batch(() => {
        setState({
          initialized: true,
          viewKind: msg.viewKind,
          workspaceFolders: msg.workspaceFolders,
          workspaceUri: msg.workspaceFolders[0]?.uri ?? null,
          defaultAgent: msg.defaultAgent,
        });
        setFirstRun(!!msg.firstRun);
        setThemeSurface(msg.viewKind);
        if (!state.chat.conversationId && !state.chat.order.length) {
          setState('chat', emptyChat(msg.conversationId, msg.defaultAgent));
          if (msg.conversationId) setState('chat', 'isLoading', true);
        }
      });
      requestModels(state.chat.agent);
      break;
    case 'agents':
      setState('agents', reconcile(msg.agents, { key: 'kind' }));
      break;
    case 'conversations':
      batch(() => {
        setState('conversations', reconcile(msg.conversations, { key: 'id' }));
        setState('conversationsLoaded', true);
        const cur = state.chat.conversationId;
        if (cur) {
          const c = msg.conversations.find((x) => x.id === cur);
          if (c && !state.chat.conversation) setState('chat', 'conversation', c);
        }
      });
      break;
    case 'chat':
      applyChat(msg.conversationId, msg.patch);
      break;
    case 'models':
      setState('models', msg.state.agent, reconcile(msg.state));
      break;
    case 'commands':
      setState('commands', msg.agent, reconcile(msg.commands));
      break;
    case 'toast':
      showToast(msg.message, msg.level);
      break;
    case 'uiPrefs':
      batch(() => {
        setUiPrefsSignal(msg.prefs);
        if (typeof msg.prefs.groupByWorkspace === 'boolean') setState('ui', 'groupByWorkspace', msg.prefs.groupByWorkspace);
      });
      break;
    case 'insertText':
      setComposerInsert({ text: msg.text, replace: false, n: Date.now() });
      break;
    case 'attachments': {
      const cb = listeners.attachments.get(msg.reqId);
      listeners.attachments.delete(msg.reqId);
      cb?.(msg.attachments);
      break;
    }
    case 'fileSearchResult': {
      const cb = listeners.files.get(msg.reqId);
      listeners.files.delete(msg.reqId);
      cb?.(msg.files);
      break;
    }
    case 'projects': {
      const cb = listeners.projects.get(msg.reqId);
      listeners.projects.delete(msg.reqId);
      cb?.(msg.projects);
      break;
    }
    case 'folderPicked': {
      const cb = listeners.folder.get(msg.reqId);
      listeners.folder.delete(msg.reqId);
      cb?.(msg.project);
      break;
    }
    case 'mediaUrl': {
      const cb = listeners.media.get(msg.reqId);
      listeners.media.delete(msg.reqId);
      cb?.({ url: msg.url, error: msg.error ?? null });
      break;
    }
    case 'imageData': {
      const cb = listeners.image.get(msg.reqId);
      listeners.image.delete(msg.reqId);
      cb?.(msg.dataUrl);
      break;
    }
    case 'chatSearchResult': {
      const cb = listeners.chatSearch.get(msg.reqId);
      listeners.chatSearch.delete(msg.reqId);
      cb?.(msg.results);
      break;
    }
    case 'editorContext':
      setEditorContext(msg.context);
      break;
    case 'addAttachments':
      setIncomingAttachments({ list: msg.attachments, n: Date.now() });
      setFocusTick((n) => n + 1);
      break;
    case 'focusComposer':
      setFocusTick((n) => n + 1);
      break;
  }
}

export function startHost() {
  host.onMessage(onHostMessage);
  host.send({ type: 'ready' });
}

// ------------------------------------------------------------------------------------------------ view → host

const requested = new Set<AgentKind>();
export function requestModels(agent: AgentKind, force = false) {
  if (!force && requested.has(agent)) return;
  requested.add(agent);
  send({ type: 'requestModels', agent });
  send({ type: 'requestCommands', agent });
}

/** Chats left by following a chat link (ChatScreen's conversationBackStack): the top bar shows a back arrow. */
export const [chatBackStack, setChatBackStack] = createSignal<string[]>([]);

/** A `conversation://` link in a message: remember where we were, then open it. */
export function openLinkedConversation(id: string) {
  if (id === state.chat.conversationId) return;
  if (state.conversationsLoaded && !state.conversations.some((c) => c.id === id)) {
    showToast("This conversation doesn't exist", 'warning');
    return;
  }
  const cur = state.chat.conversationId;
  openConversation(id, true);
  if (cur) setChatBackStack((s) => [...s, cur]);
}

/** Back to the chat the link was followed from. */
export function goBackConversation() {
  const s = chatBackStack();
  const prev = s[s.length - 1];
  if (!prev) return;
  setChatBackStack(s.slice(0, -1));
  openConversation(prev, true);
}

export function openConversation(id: string, keepBackStack = false) {
  if (!keepBackStack) setChatBackStack([]);
  setJarvisDraft(null);
  if (id === state.chat.conversationId) return;
  const conv = state.conversations.find((c) => c.id === id) ?? null;
  batch(() => {
    setState('chat', { ...emptyChat(id, conv?.agent ?? state.chat.agent), conversation: conv, isLoading: true });
    setMessages(reconcile({}));
  });
  if (conv) requestModels(conv.agent);
  send({ type: 'openConversation', id });
}

export function newChat(agent?: AgentKind) {
  setChatBackStack([]);
  const a = agent ?? state.chat.agent ?? state.defaultAgent;
  batch(() => {
    setState('chat', emptyChat(null, a));
    setMessages(reconcile({}));
  });
  requestModels(a);
  send({ type: 'openConversation', id: null, agent: a });
}

/** The agent picker on the empty screen. */
export function pickAgent(agent: AgentKind) {
  if (state.chat.conversationId && state.chat.order.length) return;
  setState('chat', 'agent', agent);
  requestModels(agent);
  send({ type: 'openConversation', id: null, agent });
}

function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function currentModelId(agent: AgentKind = state.chat.agent): string | null {
  const m = state.models[agent];
  // the chat's own model (per-chat model agents, a Jarvis draft's preselected model) first
  const own = agent === state.chat.agent ? state.chat.modelId : null;
  if (own && (!m || m.models.some((x) => x.id === own || x.key === own))) return own;
  return m?.selectedId ?? m?.models.find((x) => x.isDefault)?.id ?? null;
}

export function sendMessage(text: string, attachments: ChatAttachment[]) {
  const isNew = !state.chat.conversationId || (!state.chat.order.length && !state.chat.conversation);
  const conversationId = state.chat.conversationId ?? uuid();
  const agent = state.chat.agent;
  const running = state.chat.isStreaming;
  batch(() => {
    if (!state.chat.conversationId) setState('chat', 'conversationId', conversationId);
    if (!running) {
      // shown at once; replaced by the host's copy when it lists the chat
      const local: ChatMessage = {
        id: `local-${uuid()}`,
        conversationId,
        role: 'USER',
        content: text,
        toolCalls: [],
        isStreaming: false,
        attachments,
        createdAt: Date.now(),
      };
      setState('chat', 'pending', (p) => [...p, local]);
    }
    setState('chat', 'sentTick', (n) => n + 1);
    if (!running) {
      setAwaitingReply(true);
      clearTimeout(awaitTimer);
      awaitTimer = window.setTimeout(() => setAwaitingReply(false), 10_000);
    }
  });
  // the first message of a chat opened with "New Jarvis chat" makes it a Jarvis chat
  const jarvisFirst = isNew && !!jarvisDraft();
  send({
    type: 'send',
    conversationId,
    isNew,
    agent,
    text,
    attachments,
    modelId: currentModelId(agent),
    workspaceUri: chatWorkspaceUri() ?? newChatProjectUri(),
    ...(jarvisFirst ? { jarvis: true } : {}),
  });
  if (jarvisFirst) setJarvisDraft(null);
}

// ------------------------------------------------------------------------------------------------ projects

/** The folder of the open chat (its conversation, or its row in the chat list); null when it has none. */
export function chatWorkspaceUri(): string | null {
  const id = state.chat.conversationId;
  const uri = state.chat.conversation?.workspaceUri || (id ? state.conversations.find((c) => c.id === id)?.workspaceUri : '') || '';
  return uri || null;
}

/**
 * The folder the next new chat runs in: the one picked in the project picker (shared pref `lastProject`; '' = no
 * folder), else the first folder open in VS Code.
 */
export function newChatProjectUri(): string | null {
  const last = uiPrefs()?.lastProject;
  if (typeof last === 'string') return last || null;
  return state.workspaceUri;
}

export function requestProjects(cb: (p: ProjectView[]) => void) {
  const reqId = uuid();
  listeners.projects.set(reqId, cb);
  send({ type: 'requestProjects', reqId });
}

export function pickFolder(cb: (p: ProjectView | null) => void) {
  const reqId = uuid();
  listeners.folder.set(reqId, cb);
  send({ type: 'pickFolder', reqId });
}

export function chooseProject(uri: string | null) {
  patchUiPrefs({ lastProject: uri ?? '' });
  send({ type: 'setUiPref', key: 'lastProject', value: uri ?? '' });
}

export function stop() {
  const id = state.chat.conversationId;
  if (id) send({ type: 'stop', conversationId: id });
}

export function selectModel(agent: AgentKind, modelId: string) {
  if (state.models[agent]) setState('models', agent, 'selectedId', modelId);
  // the chat's own model follows the pick at once (the host confirms with ChatPatch.modelId)
  if (state.chat.conversationId && state.chat.agent === agent && state.chat.modelId) setState('chat', 'modelId', modelId);
  send({ type: 'selectModel', agent, conversationId: state.chat.conversationId, modelId });
}

export function conversationAction(id: string, action: ConversationAction, value?: string) {
  send({ type: 'conversationAction', id, action, value });
  if (action === 'copyId') showToast('Conversation ID copied', 'success');
  if (action === 'archive') showToast('Chat archived', 'success');
  if (action === 'unarchive') showToast('Chat unarchived', 'success');
  if (action === 'delete' && id === state.chat.conversationId) newChat();
}

export function copyText(text: string, toast?: string) {
  send({ type: 'copy', text });
  if (toast) showToast(toast, 'success');
}

export function pickAttachments(cb: (a: ChatAttachment[]) => void) {
  const reqId = uuid();
  listeners.attachments.set(reqId, cb);
  send({ type: 'pickAttachments', reqId });
}

/**
 * An address the chat can frame / play, from the host's local preview server: an Interactive App's HTML, an app's
 * .html file, a local video or a YouTube id. Rejects with the reason when it cannot be served.
 */
export function mediaUrl(kind: 'html' | 'htmlFile' | 'file' | 'youtube', value: string, start?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reqId = uuid();
    listeners.media.set(reqId, (r) => (r.url ? resolve(r.url) : reject(new Error(r.error || 'Cannot show it here'))));
    send({ type: 'mediaUrl', reqId, kind, value, ...(start ? { start } : {}) });
    setTimeout(() => {
      if (listeners.media.delete(reqId)) reject(new Error('No answer from the extension'));
    }, 15000);
  });
}

const imageCache = new Map<string, Promise<string | null>>();
/** A local image (artifact, attachment, tool output) as a data: URL, read by the host; cached per path. */
export function readImage(path: string): Promise<string | null> {
  const key = path.replace(/^file:\/\//, '');
  let p = imageCache.get(key);
  if (!p) {
    p = new Promise((resolve) => {
      const reqId = uuid();
      listeners.image.set(reqId, resolve);
      send({ type: 'readImage', reqId, path: key });
      // no answer (older host): give up quietly
      setTimeout(() => {
        if (listeners.image.delete(reqId)) resolve(null);
      }, 15000);
    });
    imageCache.set(key, p);
    void p.then((d) => d === null && imageCache.delete(key));
  }
  return p;
}

/** Drawer deep search: chats whose content matches (the latest query wins). */
export function searchChats(query: string, cb: (r: ChatSearchHit[]) => void) {
  const reqId = uuid();
  listeners.chatSearch.clear();
  listeners.chatSearch.set(reqId, cb);
  send({ type: 'searchChats', reqId, query });
}

/** Files / folders dropped on the view, turned into attachments by the host. */
export function resolveDrop(uris: string[], cb: (a: ChatAttachment[]) => void) {
  const reqId = uuid();
  listeners.attachments.set(reqId, cb);
  send({ type: 'resolveDrop', reqId, uris });
}

export function searchFiles(query: string, cb: (f: FileSuggestion[]) => void) {
  const reqId = uuid();
  listeners.files.clear();
  listeners.files.set(reqId, cb);
  send({ type: 'searchFiles', reqId, query });
}

/**
 * A controls-strip chip changed (the next new chat's defaults on the new-chat screen). Shown at once: the value, and
 * the label when it is (or ends with) the old option's label; the host's next `controls` has the real label.
 */
export function setControl(id: string, value: string, optimistic = true) {
  const i = state.chat.controls.findIndex((c) => c.id === id);
  if (i < 0) return;
  const c = state.chat.controls[i];
  if (!optimistic) {
    send({ type: 'setControl', agent: state.chat.agent, conversationId: state.chat.conversationId, id, value });
    return;
  }
  const from = c.options?.find((o) => o.value === c.value)?.label;
  const to = c.options?.find((o) => o.value === value)?.label;
  let label = c.label;
  if (from && to) label = label === from ? to : label.endsWith(from) ? label.slice(0, label.length - from.length) + to : label;
  setState('chat', 'controls', i, { value, label });
  send({ type: 'setControl', agent: state.chat.agent, conversationId: state.chat.conversationId, id, value });
}

export function agentStatus(kind: AgentKind): AgentStatus | undefined {
  return state.agents.find((a) => a.kind === kind);
}

/** Agents to offer: the host's list (enabled ones), else all four. */
export function enabledAgents(): AgentKind[] {
  const listed = state.agents.filter((a) => a.state !== 'disabled').map((a) => a.kind);
  return listed.length ? AGENTS.filter((a) => listed.includes(a)) : AGENTS;
}

export { AGENTS };

// dev only: inspect the state from the browser console (read-only use)
if (import.meta.env.DEV) Object.assign(((globalThis as any).__antigem ??= {}), { state, messages });
