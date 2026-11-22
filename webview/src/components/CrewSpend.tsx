// What the crew spent today and its daily budget (Crew Phase 9, src/core/crew/usage.ts), on the Crew home. The budget
// is checked before new work starts; running work finishes and the user's own DMs still answer.
import { createSignal, Show } from 'solid-js';
import type { SpendView } from '@shared/protocol';
import { crew, crewAction } from '../state/crew';
import { Icon } from '../ui/primitives';

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** "120k tokens · $0.42 · 18 turns" (dollars only where an agent reported a cost). */
export const spendText = (s: SpendView) => `${fmtTokens(s.tokens)} tokens${s.usd ? ` · $${s.usd.toFixed(2)}` : ''} · ${s.turns} turn${s.turns === 1 ? '' : 's'}`;

export function CrewSpend() {
  const [editing, setEditing] = createSignal(false);
  const [tokens, setTokens] = createSignal('');
  const [usd, setUsd] = createSignal('');
  const u = () => crew.usage;
  const hasCap = () => !!(u()?.caps.dayTokens || u()?.caps.dayUsd);
  /** The larger share of either limit, 0..1. */
  const share = () => {
    const { caps, today } = u()!;
    return Math.min(1, Math.max(caps.dayTokens ? today.tokens / caps.dayTokens : 0, caps.dayUsd ? today.usd / caps.dayUsd : 0));
  };
  const capText = () => {
    const c = u()!.caps;
    return [c.dayTokens ? `${fmtTokens(c.dayTokens)} tokens` : '', c.dayUsd ? `$${c.dayUsd.toFixed(2)}` : ''].filter(Boolean).join(' or ');
  };
  const edit = () => {
    setTokens(u()?.caps.dayTokens ? String(u()!.caps.dayTokens) : '');
    setUsd(u()?.caps.dayUsd ? String(u()!.caps.dayUsd) : '');
    setEditing(true);
  };
  const save = () => {
    crewAction('setCaps', null, { dayTokens: Number(tokens().replace(/[,\s_]/g, '')) || 0, dayUsd: Number(usd().replace(/[$\s]/g, '')) || 0 });
    setEditing(false);
  };
  return (
    <Show when={crew.bots.length && u()}>
      <div class="crew-spend" classList={{ over: !!u()!.over }}>
        <div class="crew-spend-top">
          <Icon name="data_usage" size={16} />
          <span>Today</span>
          <span class="gc-muted crew-spend-text">{u()!.today.turns ? spendText(u()!.today) : 'nothing spent yet'}</span>
          <span class="flex1" />
          <button class="text-btn" onClick={() => (editing() ? setEditing(false) : edit())} title="A daily limit for the whole crew">
            {hasCap() ? `Budget ${capText()}` : 'Set a budget'}
          </button>
        </div>
        <Show when={hasCap()}>
          <div class="crew-spend-bar" title={`${Math.round(share() * 100)}% of today's budget`}>
            <div style={{ width: `${Math.round(share() * 100)}%` }} />
          </div>
        </Show>
        <Show when={u()!.over}>
          <div class="gc-hint warn">New work waits until tomorrow: {u()!.over}. Running work finishes, and your DMs still answer.</div>
        </Show>
        <Show when={editing()}>
          <div class="crew-spend-edit">
            <label>
              <span class="gc-muted">Tokens a day</span>
              <input class="gc-input" inputMode="numeric" placeholder="No limit" value={tokens()} onInput={(e) => setTokens(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
            </label>
            <label>
              <span class="gc-muted">Dollars a day</span>
              <input class="gc-input" inputMode="decimal" placeholder="No limit" value={usd()} onInput={(e) => setUsd(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
            </label>
            <button class="filled-btn" onClick={save}>
              Save
            </button>
          </div>
          <div class="gc-muted crew-spend-note">Checked before new work starts: room turns, hand-offs, automations. Dollars count only where the agent reports a cost. Empty = no limit.</div>
        </Show>
      </div>
    </Show>
  );
}
