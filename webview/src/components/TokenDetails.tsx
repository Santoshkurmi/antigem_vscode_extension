// ui/components/TokenUsageDetailsSheet.kt: one reply's usage (tap the token pill under a reply): the full model id,
// input / output / cache tokens, time and cost. Same for every agent; values an agent does not report are left out.
import { createSignal, For, Show } from 'solid-js';
import type { TokenUsage } from '@shared/model';
import { BottomSheet, Icon, IconButton, type IconName } from '../ui/primitives';
import { copyText } from '../state/store';

const [current, setCurrent] = createSignal<{ usage: TokenUsage; title: string } | null>(null);
const [open, setOpen] = createSignal(false);

/** Opens the reply details sheet (TokenDetailsHost must be rendered once). */
export function openTokenDetails(usage: TokenUsage, title?: string) {
  setCurrent({ usage, title: title ?? 'Reply details' });
  setOpen(true);
}

/** String.format(Locale.US, "%,d", n) */
const grouped = (n: number) => Math.trunc(n || 0).toLocaleString('en-US');

/** durationText() of the sheet (not the pill's formatDuration) */
function durationText(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.floor((ms % 60_000) / 1000)} s`;
}

interface Row {
  icon: IconName;
  label: string;
  value: string;
  color: string;
}

function rows(u: TokenUsage): Row[] {
  const dim = 'color-mix(in srgb, var(--on-surface) 75%, transparent)';
  const out: Row[] = [
    { icon: 'download', label: 'Input tokens', value: grouped(u.promptTokens), color: 'var(--info)' },
    { icon: 'upload', label: 'Output tokens', value: grouped(u.outputTokens), color: 'var(--success)' },
  ];
  if (u.cachedTokens > 0) {
    const pct = u.promptTokens + u.cachedTokens > 0 ? Math.trunc((u.cachedTokens * 100) / (u.promptTokens + u.cachedTokens)) : 0;
    out.push({ icon: 'bolt', label: 'Cache read', value: `${grouped(u.cachedTokens)}  (${pct}% of the input)`, color: 'var(--warning)' });
  }
  // the app's icon is Outlined.Save, which iconData.ts does not have
  if (u.cacheCreationTokens > 0) out.push({ icon: 'save', label: 'Cache write', value: grouped(u.cacheCreationTokens), color: 'var(--warning)' });
  const total = u.totalTokens > 0 ? u.totalTokens : u.promptTokens + u.outputTokens + u.cachedTokens + u.cacheCreationTokens;
  out.push({ icon: 'functions', label: 'Total', value: grouped(total), color: dim });
  if (u.durationMs > 0) out.push({ icon: 'timer', label: 'Time', value: durationText(u.durationMs), color: dim });
  // the app's icon is Outlined.Paid, which iconData.ts does not have
  if (u.costUsd != null && u.costUsd > 0) out.push({ icon: 'paid', label: 'Cost', value: `$${u.costUsd.toFixed(4)}`, color: 'var(--accent-teal)' });
  return out;
}

/** The sheet itself; render once at app level. */
export function TokenDetailsHost() {
  return (
    <BottomSheet open={open()} onClose={() => setOpen(false)} class="tud-sheet">
      <Show when={current()}>
        {(d) => {
          const u = () => d().usage;
          const model = () => (u().model ?? '').trim() ? u().model! : null;
          return (
            <div class="tud-body">
              <div class="tud-title">{d().title}</div>
              <div class="tud-sub">{u().isEstimated ? 'Token counts are estimates' : 'What this reply used'}</div>

              <Show when={model()}>
                {(m) => (
                  <div class="tud-card tud-model">
                    <div class="tud-model-icon">
                      <Icon name="memory" size={19} color="var(--accent-alt)" />
                    </div>
                    <div class="tud-model-text">
                      <div class="tud-model-label">Model</div>
                      <div class="tud-model-name">{m().includes('/') ? m().substring(m().indexOf('/') + 1) : m()}</div>
                      <Show when={m().includes('/')}>
                        <div class="tud-model-provider">Provider: {m().substring(0, m().indexOf('/'))}</div>
                      </Show>
                    </div>
                    <IconButton
                      icon="copy"
                      size={40}
                      iconSize={18}
                      color="color-mix(in srgb, var(--on-surface) 60%, transparent)"
                      title="Copy model name"
                      style={{ margin: '4px' }}
                      onClick={() => copyText(m(), 'Model name copied')}
                    />
                  </div>
                )}
              </Show>

              <div class="tud-card tud-rows">
                <For each={rows(u())}>
                  {(r, i) => (
                    <>
                      <Show when={i() > 0}>
                        <div class="tud-divider" />
                      </Show>
                      <div class="tud-row">
                        <Icon name={r.icon} size={18} color={r.color} />
                        <span class="tud-row-label">{r.label}</span>
                        <span class="tud-row-value">{r.value}</span>
                      </div>
                    </>
                  )}
                </For>
              </div>
            </div>
          );
        }}
      </Show>
    </BottomSheet>
  );
}
