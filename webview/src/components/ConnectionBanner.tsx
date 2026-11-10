// ChatScreen.kt's "Disconnection / Reconnecting Inline Banner": docked above the input when the chat's agent is
// down ("Antigravity Disconnected" + Reconnect) or coming back ("Connecting to Antigravity..."). Driven by the
// `agents` status of the chat's own agent (any of the four), shown only once the chat has messages, like the app.
import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js';
import { agentStatus, send, state } from '../state/store';
import { agentLabel } from '../util/format';
import { Collapse, Icon } from '../ui/primitives';

export function ConnectionBanner() {
  const status = () => agentStatus(state.chat.agent);
  const down = () => status()?.state === 'offline' || status()?.state === 'error';
  // a tap on Reconnect shows "Connecting…" at once (the app's isReconnecting) until the host reports back
  const [retrying, setRetrying] = createSignal(false);
  let timer: number | undefined;
  createEffect(
    on(
      () => status()?.state,
      () => {
        clearTimeout(timer);
        setRetrying(false);
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  const connecting = () => retrying() || status()?.state === 'starting';
  const visible = () => state.chat.order.length > 0 && (down() || connecting()) && !!status();
  const name = () => agentLabel(state.chat.agent);
  const reconnect = () => {
    setRetrying(true);
    clearTimeout(timer);
    timer = window.setTimeout(() => setRetrying(false), 8000);
    send({ type: 'retryConnections' });
  };
  return (
    <Collapse when={visible()}>
      <div class="conn-banner" classList={{ connecting: connecting() }} title={status()?.detail ?? undefined}>
        <span class="conn-lead">
          <Show when={connecting()} fallback={<span class="conn-dot" />}>
            <span class="conn-spinner" />
          </Show>
          <span class="conn-text">
            {connecting() ? `Connecting to ${name()}...` : `${name()} Disconnected`}
            <Show when={!connecting() && status()?.detail}>
              <span class="conn-detail"> · {status()!.detail}</span>
            </Show>
          </span>
        </span>
        <Show when={!connecting()}>
          <button class="conn-retry" onClick={reconnect}>
            <Icon name="refresh_f" size={13} />
            Reconnect
          </button>
        </Show>
      </div>
    </Collapse>
  );
}
