// ui/agents/AccountsUi.kt: AccountsButton (the drawer footer's account avatars) and AccountsDialog (each agent's
// account: who is signed in, its state and the next step). The view has no sign-in messages of its own: signing in,
// out and managing an account happen on the agent's settings page, which the dialog's buttons open.
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { AgentKind } from '@shared/model';
import type { AgentStatus } from '@shared/protocol';
import { AgentMark } from './AgentStatus';
import { openAgentSettings } from '../state/settings';
import { send, state } from '../state/store';
import { agentAccent, agentLabel, alpha, stateColor, stateLabel } from '../util/format';
import { Icon, IconButton, nextFrame, sp, type IconName } from '../ui/primitives';

/** The accounts dialog is open (AccountsButton opens it; AccountsDialog is rendered once at app level). */
export const [accountsOpen, setAccountsOpen] = createSignal(false);

/** The app's order (AccountsButton and AccountsDialog both list Antigravity, Claude Code, OpenCode, Codex). */
const ORDER: AgentKind[] = ['AGY', 'CLAUDE', 'OPENCODE', 'CODEX'];

/** ClaudeStatus.SIGNED_OUT / SystemStatus.UNAUTHENTICATED dot color. */
const SIGNED_OUT_COLOR = '#A855F7';

/** Material's Icons.AutoMirrored.Outlined.Login (not in iconData). */
const LOGIN_PATH = 'M11 7 9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z';

/** One entry per enabled agent (the app leaves an agent that is turned off out). */
function accountEntries(): AgentStatus[] {
  return ORDER.map((k) => state.agents.find((a) => a.kind === k)).filter((a): a is AgentStatus => !!a && a.state !== 'disabled');
}

const isReady = (s: AgentStatus) => s.state === 'online';

/** Transitional (starting / checking): the app offers no action then. */
const isPending = (s: AgentStatus) => s.state === 'starting';

/**
 * AgentStatusEntry.isSignedOut. The host has no signed-out state of its own: a missing sign-in is an error whose
 * detail says so (Claude Code: "Sign in required …", Codex: "Not signed in …").
 */
const isSignedOut = (s: AgentStatus) => s.state === 'error' && /sign[ -]?in required|not signed in|signed out/i.test(s.detail ?? '');

/** AgentStatusEntry.color */
const entryColor = (s: AgentStatus) => (isSignedOut(s) ? SIGNED_OUT_COLOR : stateColor(s.state));

/** AgentStatusEntry.label (the state, as the StatusChip shows it). */
const entryLabel = (s: AgentStatus) => (isSignedOut(s) ? (s.kind === 'CODEX' ? 'Not signed in' : 'Sign in required') : stateLabel(s.state));

/** The settings page of the agent (Settings → Agents → …). */
const settingsPage = (k: AgentKind) => ({ id: k.toLowerCase(), title: agentLabel(k) });

function LoginIcon(props: { size: number }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" width={props.size} height={props.size} fill="currentColor" aria-hidden="true">
      <path d={LOGIN_PATH} />
    </svg>
  );
}

/** AccountAvatar: the account's initial when signed in, a sign-in glyph (or the agent's mark) otherwise; status badge corner. */
function AccountAvatar(props: { status: AgentStatus; size?: number }) {
  const size = () => props.size ?? 26;
  // the app takes the initial of the AGY display name / Claude and Codex e-mail; OpenCode has none
  const initial = () => (props.status.kind === 'OPENCODE' ? '' : (props.status.account ?? '').trim().charAt(0).toUpperCase()) || '•';
  return (
    <div class="acc-avatar" style={{ width: `${size()}px`, height: `${size()}px`, '--acc': agentAccent(props.status.kind) }}>
      <div class="acc-avatar-ring" classList={{ idle: !isReady(props.status) }}>
        <Show
          when={isReady(props.status)}
          fallback={
            <Show when={isSignedOut(props.status)} fallback={<AgentMark agent={props.status.kind} size={size()} />}>
              <LoginIcon size={size() * 0.5} />
            </Show>
          }
        >
          <span class="acc-initial" style={{ 'font-size': sp(size() * 0.44) }}>
            {initial()}
          </span>
        </Show>
      </div>
      <div class="acc-avatar-badge" style={{ width: `${size() * 0.38}px`, height: `${size() * 0.38}px` }}>
        <div style={{ background: entryColor(props.status) }} />
      </div>
    </div>
  );
}

/**
 * Drawer footer button for the agent accounts: one avatar per enabled agent (sign-in glyph when signed out) with its
 * status badge. Opens AccountsDialog.
 */
export function AccountsButton() {
  const entries = () => accountEntries();
  const signedOut = () => entries().find(isSignedOut);
  const text = () => {
    if (signedOut()) return 'Sign in';
    const list = entries();
    const single = list.length === 1 ? list[0] : null;
    if (!single) return 'Accounts';
    if (!isReady(single)) return entryLabel(single);
    const user = (single.account ?? '').split('@')[0].trim();
    switch (single.kind) {
      case 'AGY':
      case 'CLAUDE':
        return user || 'Account';
      case 'OPENCODE':
        return 'OpenCode';
      default:
        return user || 'Codex';
    }
  };
  return (
    <button class="acc-button" title="Accounts" onClick={() => setAccountsOpen(true)}>
      <span class="acc-button-avatars">
        <For each={entries()}>{(s) => <AccountAvatar status={s} />}</For>
      </span>
      <span class="acc-button-text" style={{ color: signedOut() ? agentAccent(signedOut()!.kind) : undefined }}>
        {text()}
      </span>
    </button>
  );
}

interface SectionAction {
  label: string;
  icon?: IconName;
  /** A filled button in the agent's color (the entry's own action: sign in, install, start, retry). */
  primary?: boolean;
  run: () => void;
}

/**
 * Every enabled agent's account: who is signed in, the state and the next step. `onOpenSettings` runs before a button
 * opens an agent's settings page (the app closes the drawer then).
 */
export function AccountsDialog(props: { onOpenSettings?: () => void }) {
  const [mounted, setMounted] = createSignal(accountsOpen());
  const [shown, setShown] = createSignal(false);
  let timer: number | undefined;
  createEffect(
    on(accountsOpen, (o) => {
      clearTimeout(timer);
      if (o) {
        setMounted(true);
        nextFrame(() => accountsOpen() && setShown(true));
      } else {
        setShown(false);
        timer = window.setTimeout(() => setMounted(false), 160);
      }
    }),
  );
  const close = () => setAccountsOpen(false);
  // Escape closes this dialog only (not the drawer under it), as Back does in the app
  const onKey = (e: KeyboardEvent) => {
    if (accountsOpen() && e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  onMount(() => document.addEventListener('keydown', onKey, true));
  onCleanup(() => {
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(timer);
  });

  const toSettings = (k: AgentKind) => {
    close();
    props.onOpenSettings?.();
    openAgentSettings(k);
  };
  const retry = () => {
    send({ type: 'retryConnections' });
    close();
  };

  /** The entry's own action (AgentStatusEntry.action): signing in and installing happen on the settings page. */
  const entryAction = (s: AgentStatus): SectionAction | null => {
    if (isSignedOut(s)) return { label: 'Sign in', primary: true, run: () => toSettings(s.kind) };
    switch (s.state) {
      case 'not_installed':
        return { label: s.kind === 'CLAUDE' || s.kind === 'AGY' ? 'Set up' : 'Install', primary: true, run: () => toSettings(s.kind) };
      case 'offline':
        return { label: 'Start', primary: true, run: retry };
      case 'error':
        return { label: 'Retry', primary: true, run: retry };
      default:
        return null;
    }
  };

  const actions = (s: AgentStatus): SectionAction[] => {
    const ready = isReady(s);
    const own = ready ? null : entryAction(s);
    const settings = (label: string): SectionAction => ({ label, icon: 'settings', run: () => toSettings(s.kind) });
    const list: (SectionAction | null)[] = [own];
    switch (s.kind) {
      case 'AGY':
        // in place of the app's "Manage plan" and "Sign out" (sign-out is on the Antigravity settings page here)
        if (ready) list.push(settings('Antigravity settings'));
        break;
      case 'CLAUDE':
        if (ready || !isPending(s)) list.push(settings('Claude settings'));
        break;
      case 'CODEX':
        if (ready || !isPending(s)) list.push(settings('Codex settings'));
        break;
      case 'OPENCODE':
        list.push(settings(ready ? 'Providers & settings' : 'OpenCode settings'));
        break;
    }
    return list.filter((a): a is SectionAction => !!a);
  };

  return (
    <Show when={mounted()}>
      <Portal>
        <div
          class="acc-scrim"
          classList={{ shown: shown() }}
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
        >
          <div class="acc-card" role="dialog" aria-label="Accounts" onClick={(e) => e.stopPropagation()}>
            <div class="acc-head">
              <span class="acc-title">Accounts</span>
              <IconButton icon="close_o" size={30} iconSize={24} title="Close" color={alpha('var(--on-surface)', 0.6)} onClick={close} />
            </div>
            <div class="acc-sub">Each agent signs in on its own.</div>
            <div class="acc-sections">
              <For each={accountEntries()}>{(s) => <AccountSection status={s} actions={actions(s)} />}</For>
              <Show when={!accountEntries().length}>
                <div class="acc-sub">Waiting for the extension…</div>
              </Show>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

/** AccountSection: avatar, name, account and state chip; facts; the buttons. */
function AccountSection(props: { status: AgentStatus; actions: SectionAction[] }) {
  const s = () => props.status;
  /** The ready detail's parts ("e-mail · Max plan", "Plus plan", "OpenCode 1.2"), minus the account itself. */
  const readyParts = () =>
    isReady(s())
      ? (s().detail ?? '')
          .split(' · ')
          .map((t) => t.trim())
          .filter((t) => t && t !== s().account && t !== 'Signed in')
      : [];
  // the app's facts: the plan (when signed in) and "CLI <version>"; older hosts only had them in the detail line
  const facts = () => {
    const st = s();
    const v = st.version?.trim() ? `CLI ${(/\d+(\.\d+)+\S*/.exec(st.version) ?? [st.version.trim()])[0]}` : null;
    const plan = isReady(st) ? st.plan?.trim() || null : null;
    if (v || st.plan) return [plan, v].filter((x): x is string => !!x);
    return readyParts().filter((t) => t.length <= 32);
  };
  const subtitle = () => {
    const st = s();
    if (!isReady(st)) return st.detail || null;
    if (st.kind === 'OPENCODE') return 'No sign-in: each provider uses its own API key (free models need none).';
    // a longer ready detail is a note (e.g. the sign-in state could not be read), not a fact chip
    const note = readyParts().filter((t) => t.length > 32).join(' · ') || null;
    return st.account || note || (st.kind === 'CODEX' ? 'Signed in' : null);
  };
  return (
    <div class="acc-section" style={{ '--acc': agentAccent(s().kind) }}>
      <div class="acc-section-head">
        <AccountAvatar status={s()} size={44} />
        <div class="acc-section-text">
          <div class="acc-section-title">{agentLabel(s().kind)}</div>
          <Show when={subtitle()}>
            <div class="acc-section-sub">{subtitle()}</div>
          </Show>
        </div>
        <span class="acc-chip" style={{ '--chip': entryColor(s()) }}>
          <span class="acc-chip-dot" />
          <span>{entryLabel(s())}</span>
        </span>
      </div>
      <Show when={facts().length}>
        <div class="acc-facts">
          <For each={facts()}>{(f) => <span class="acc-fact">{f}</span>}</For>
        </div>
      </Show>
      <div class="acc-actions">
        <For each={props.actions}>
          {(a) => (
            <Show
              when={a.primary}
              fallback={
                <button class="acc-btn" onClick={a.run}>
                  <Show when={a.icon}>
                    <Icon name={a.icon!} size={15} />
                  </Show>
                  <span>{a.label}</span>
                </button>
              }
            >
              <button class="acc-btn-primary" onClick={a.run}>
                {a.label}
              </button>
            </Show>
          )}
        </For>
      </div>
    </div>
  );
}
