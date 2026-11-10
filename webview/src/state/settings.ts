// The settings screen's state: a stack of pages (the host's SettingsPage by id, or a page the view owns: themes,
// appearance), the pages the host sent, and optimistic edits. The host re-sends a page after every change.
import { batch, createSignal } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import type { SettingItem, SettingsPage, UiPrefs } from '@shared/protocol';
import { host } from '../host';
import { patchUiPrefs } from '../theme';

/** Pages the view draws itself (the settings root's Appearance group). */
export const LOCAL_THEMES = 'local:themes';
export const LOCAL_APPEARANCE = 'local:appearance';

export interface StackEntry {
  id: string;
  title: string;
  subtitle?: string | null;
}

interface SettingsState {
  open: boolean;
  stack: StackEntry[];
  /** 'fwd' when the last move pushed a page, 'back' when it popped one (for the slide direction). */
  dir: 'fwd' | 'back';
  pages: Record<string, SettingsPage>;
}

export const [settings, setSettings] = createStore<SettingsState>({ open: false, stack: [], dir: 'fwd', pages: {} });

/** The floating theme switcher (ThemeQuickPanel). */
export const [themePanelOpen, setThemePanelOpen] = createSignal(false);

host.onMessage((m) => {
  if (m.type === 'settings') setSettings('pages', m.page.id, reconcile(m.page, { key: 'id', merge: false }));
});

const isLocal = (id: string) => id.startsWith('local:');

/** Open the settings screen, optionally at a page (and pages below it: Agents → OpenCode → Providers). */
export function openSettings(page?: StackEntry, deeper: StackEntry[] = []) {
  const pages = page ? [page, ...deeper] : [];
  batch(() => {
    setSettings({ open: true, dir: 'fwd', stack: [{ id: 'root', title: 'Settings' }, ...pages] });
  });
  host.send({ type: 'requestSettings', page: 'root' });
  for (const p of pages) if (!isLocal(p.id)) host.send({ type: 'requestSettings', page: p.id });
}

/** An agent's own settings page, under Settings → Agents (Install / Sign in / Restart live there). */
export function openAgentSettings(agent: 'AGY' | 'CLAUDE' | 'CODEX' | 'OPENCODE', sub?: StackEntry) {
  const page = { AGY: { id: 'agy', title: 'Antigravity' }, CLAUDE: { id: 'claude', title: 'Claude Code' }, CODEX: { id: 'codex', title: 'Codex' }, OPENCODE: { id: 'opencode', title: 'OpenCode' } }[agent];
  openSettings({ id: 'agents', title: 'Agents' }, sub ? [page, sub] : [page]);
}

export function closeSettings() {
  if (!settings.open) return;
  setSettings('open', false);
  host.send({ type: 'closeSettings' });
  // the stack stays while the screen slides away
  setTimeout(() => {
    if (!settings.open) setSettings('stack', []);
  }, 320);
}

export function pushPage(entry: StackEntry) {
  batch(() => {
    setSettings('dir', 'fwd');
    setSettings('stack', (s) => [...s, entry]);
  });
  if (!isLocal(entry.id)) host.send({ type: 'requestSettings', page: entry.id });
}

export function popPage() {
  if (settings.stack.length <= 1) {
    closeSettings();
    return;
  }
  batch(() => {
    setSettings('dir', 'back');
    setSettings('stack', (s) => s.slice(0, -1));
  });
  const top = settings.stack[settings.stack.length - 1];
  if (top && !isLocal(top.id)) host.send({ type: 'requestSettings', page: top.id });
}

function patchItem(pageId: string, itemId: string, fn: (item: SettingItem) => void) {
  setSettings(
    'pages',
    pageId,
    produce((p) => {
      if (!p) return;
      for (const s of p.sections) for (const it of s.items) if (it.id === itemId) fn(it);
    }),
  );
}

/** An edit: shown at once, sent to the host (which answers with the page again). */
export function changeSetting(pageId: string, itemId: string, value: unknown, rowId?: string) {
  patchItem(pageId, itemId, (it) => {
    if (rowId && it.kind === 'list') {
      const row = it.rows.find((r) => r.id === rowId);
      if (row) row.toggle = !!value;
    } else if (it.kind === 'toggle') it.value = !!value;
    else if (it.kind === 'select' || it.kind === 'text') it.value = String(value);
    else if (it.kind === 'checklist' && Array.isArray(value)) it.values = value.map(String);
  });
  host.send({ type: 'settingChange', page: pageId, id: itemId, value, rowId });
}

export function settingAction(pageId: string, itemId: string, opts: { rowId?: string; actionId?: string; values?: Record<string, string> } = {}) {
  host.send({ type: 'settingAction', page: pageId, id: itemId, ...opts });
}

/** A shared view preference: applied here at once, saved by the host (which broadcasts uiPrefs to every view). */
export function setUiPref(key: string, value: unknown) {
  patchUiPrefs({ [key]: value } as Partial<UiPrefs>);
  host.send({ type: 'setUiPref', key, value });
}

// dev only: inspect from the browser console (read-only use)
if (import.meta.env.DEV) Object.assign(((globalThis as any).__antigem ??= {}), { settings });
