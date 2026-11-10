// The single screen of the app (ui/chat/ChatScreen.kt): drawer, top bar, chat feed, the panels docked above the
// input, and the input bar. Sidebar = phone layout; an editor tab centers the same column (max 820px).
import { createEffect, createSignal, For, on, onCleanup, onMount } from 'solid-js';
import { Drawer } from './components/Drawer';
import { TopBar } from './components/TopBar';
import { Feed } from './components/Feed';
import { ComposerPopups, InputBar } from './components/InputBar';
import { ApprovalPanel, QuestionPanel } from './components/Panels';
import { ModelSheet } from './components/ModelSheet';
import { SettingsScreen } from './components/Settings';
import { ThemeQuickPanel } from './components/Themes';
import { ProjectPicker } from './components/ProjectPicker';
import { ConnectionBanner } from './components/ConnectionBanner';
import { ArtifactsDrawer } from './components/Artifacts';
import { ControlsStrip } from './components/ControlsStrip';
import { ImageViewerHost } from './components/Media';
import { DropZone } from './components/DropZone';
import { TerminatedDialogHost } from './components/ToolCallCard';
import { TokenDetailsHost } from './components/TokenDetails';
import { AccountsDialog } from './components/Accounts';
import { themePanelOpen, setThemePanelOpen } from './state/settings';
import { clearToolExpansion } from './components/ToolCallCard';
import { clearThoughtState } from './components/Thinking';
import { clearCodeState } from './components/CodeBlock';
import { openLinkedConversation, send, setState, state } from './state/store';
import { Icon } from './ui/primitives';

export function App() {
  const [drawerOpen, setDrawerOpen] = createSignal(false);

  // expansion caches are per chat (ToolCallExpansionCache.setChat)
  createEffect(
    on(
      () => state.chat.conversationId,
      () => {
        clearToolExpansion();
        clearThoughtState();
        clearCodeState();
      },
      { defer: true },
    ),
  );

  // links, file paths and chat links in any rendered markdown
  const onClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-file],[data-url],[data-conv]');
    if (!el) {
      if ((e.target as HTMLElement).closest('a[href]')) e.preventDefault();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (el.dataset.conv) openLinkedConversation(el.dataset.conv);
    else if (el.dataset.url) send({ type: 'openUrl', url: el.dataset.url });
    else if (el.dataset.file) send({ type: 'openFile', path: el.dataset.file, line: el.dataset.line ? +el.dataset.line : undefined });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (themePanelOpen()) setThemePanelOpen(false);
    else if (drawerOpen()) setDrawerOpen(false);
  };
  onMount(() => document.addEventListener('keydown', onKey));
  onCleanup(() => document.removeEventListener('keydown', onKey));

  return (
    <div class="app" classList={{ wide: state.viewKind !== 'sidebar' }} onClick={onClick}>
      <div class="screen">
        <TopBar onMenu={() => setDrawerOpen(true)} />
        <main class="column">
          <div class="feed-area">
            <Feed />
            <ComposerPopups />
          </div>
          <ConnectionBanner />
          <ApprovalPanel />
          <QuestionPanel />
          {/* the agent's controls strip (ClaudeControlsStrip / CodexControlsStrip / OpenCodeControlsStrip) */}
          <ControlsStrip />
          <InputBar />
        </main>
      </div>
      <Drawer open={drawerOpen()} onClose={() => setDrawerOpen(false)} />
      <SettingsScreen />
      <ModelSheet />
      <ThemeQuickPanel />
      <ProjectPicker />
      <ArtifactsDrawer />
      <TokenDetailsHost />
      <AccountsDialog onOpenSettings={() => setDrawerOpen(false)} />
      <ImageViewerHost />
      <DropZone />
      <TerminatedDialogHost />
      <Toasts />
    </div>
  );
}

/** ChatToastBanner: bottom-centered, slides up + fades in. */
function Toasts() {
  return (
    <div class="toasts">
      <For each={state.toasts}>
        {(t) => (
          <div class={`toast ${t.level}`}>
            <Icon
              name={t.level === 'success' ? 'check_circle' : t.level === 'error' ? 'error_o' : t.level === 'warning' ? 'warning_o' : 'info_o'}
              size={20}
              class="toast-icon"
            />
            <span class="toast-text">{t.message}</span>
            <button class="icon-btn" style={{ width: '24px', height: '24px' }} onClick={() => setState('toasts', (l) => l.filter((x) => x.id !== t.id))}>
              <Icon name="close_o" size={16} />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
