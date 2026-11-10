// Claude's plan limits as quota groups (port of the app's ClaudeQuotaGroups.kt). The 5-hour and weekly limits cover
// every model ("All models"); a model with its own weekly share (Fable on Max) gets a group of its own, which also
// counts against the 5-hour limit and the all-models weekly limit.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AiModel } from '../../../shared/model';
import type { ModelGroupView, QuotaWindowView } from '../../../shared/protocol';
import { countdownText, quotaPercentText } from '../agy/quota';
import { num, type UnifiedWindow } from './protocol';

export const ALL = 'all';

export interface ClaudeQuotaWindow {
  label: string;
  /** 0..1 share left. */
  remaining: number;
  resetAt: number | null;
}

export interface ClaudeQuotaGroup {
  id: string;
  title: string;
  fiveHour: ClaudeQuotaWindow | null;
  weekly: ClaudeQuotaWindow[];
}

/** A model's own weekly limit: name ("Fable"), share used (0..1), reset time. */
export interface ScopedLimit {
  name: string;
  used: number;
  resetsAt: string | null;
}

const left = (used: number) => Math.max(0, Math.min(1, 1 - used));
const isoMillis = (iso: unknown): number | null => {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** The per-model weekly limits: `limits[]` rows of kind weekly_scoped, else `model_scoped[]`, else the older fields. */
export function scopedLimits(rl: any): ScopedLimit[] {
  if (!rl || typeof rl !== 'object') return [];
  const out: ScopedLimit[] = [];
  for (const e of Array.isArray(rl.limits) ? rl.limits : []) {
    const name = e?.scope?.model?.display_name;
    if (e?.kind === 'weekly_scoped' && typeof name === 'string' && name.trim()) out.push({ name, used: num(e.percent) / 100, resetsAt: e.resets_at ?? null });
  }
  for (const s of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
    if (typeof s?.display_name === 'string' && s.display_name.trim()) out.push({ name: s.display_name, used: num(s.utilization) / 100, resetsAt: s.resets_at ?? null });
  }
  if (rl.seven_day_opus) out.push({ name: 'Opus', used: num(rl.seven_day_opus.utilization) / 100, resetsAt: rl.seven_day_opus.resets_at ?? null });
  if (rl.seven_day_sonnet) out.push({ name: 'Sonnet', used: num(rl.seven_day_sonnet.utilization) / 100, resetsAt: rl.seven_day_sonnet.resets_at ?? null });
  const merged = new Map<string, ScopedLimit>();
  for (const s of out) if (!merged.has(s.name.toLowerCase())) merged.set(s.name.toLowerCase(), s);
  return [...merged.values()];
}

/**
 * The groups for the plan, or none when there are no plan limits (API billing, not loaded yet). [live] (the chat
 * stream's windows, fresher than the cached usage call) wins for the 5h / 7d numbers.
 */
export function claudeQuotaGroups(usage: any, live: Record<string, UnifiedWindow>): ClaudeQuotaGroup[] {
  const rl = usage?.rate_limits;
  const liveWin = (k: string, label: string): ClaudeQuotaWindow | null =>
    live[k] ? { label, remaining: left(live[k].utilization), resetAt: live[k].resetsAt != null ? live[k].resetsAt! * 1000 : null } : null;
  const apiWin = (w: any, label: string): ClaudeQuotaWindow | null => (w ? { label, remaining: left(num(w.utilization) / 100), resetAt: isoMillis(w.resets_at) } : null);
  const five = liveWin('five_hour', '5h') ?? apiWin(rl?.five_hour, '5h');
  const week = liveWin('seven_day', '7d') ?? apiWin(rl?.seven_day, '7d');
  const scoped = scopedLimits(rl);
  if (!five && !week && !scoped.length) return [];
  return [
    { id: ALL, title: 'All models', fiveHour: five, weekly: week ? [week] : [] },
    ...scoped.map((s) => ({
      id: groupId(s.name),
      title: s.name,
      fiveHour: five,
      // its own share first (shown in the header), then the all-models limit it also counts against
      weekly: [{ label: '7d', remaining: left(s.used), resetAt: isoMillis(s.resetsAt) }, ...(week ? [{ ...week, label: '7d all' }] : [])],
    })),
  ];
}

export function groupId(name: string) {
  return `model:${name.toLowerCase()}`;
}

/** The group of model [value] ("fable", "claude-fable-5", "opus"…): the user's choice, else by name. */
export function groupOf(value: string, displayName: string | null, groups: ClaudeQuotaGroup[], overrides: Record<string, string>): ClaudeQuotaGroup | null {
  const o = overrides[value];
  if (o) {
    const g = groups.find((x) => x.id === o);
    if (g) return g;
  }
  return autoGroup(value, displayName, groups);
}

export function autoGroup(value: string, displayName: string | null, groups: ClaudeQuotaGroup[]): ClaudeQuotaGroup | null {
  const name = `${value} ${displayName ?? ''}`.toLowerCase();
  return groups.find((g) => g.id !== ALL && name.includes(g.title.toLowerCase())) ?? groups.find((g) => g.id === ALL) ?? null;
}

function windowView(w: ClaudeQuotaWindow): QuotaWindowView {
  return { label: w.label, remaining: w.remaining, resetText: countdownText(w.resetAt) };
}

export function groupViews(groups: ClaudeQuotaGroup[]): ModelGroupView[] {
  return groups.map((g) => ({ name: g.title, windows: [g.fiveHour, ...g.weekly].filter((w): w is ClaudeQuotaWindow => w != null).map(windowView) }));
}

/** Claude's own models: each gets its plan group and the chat-pill text for the chosen limit (5h or 7d). */
export function applyClaudeQuota(models: AiModel[], groups: ClaudeQuotaGroup[], pill: '5h' | '7d', overrides: Record<string, string>): AiModel[] {
  return models.map((m) => {
    const g = groupOf(m.id, m.displayName, groups, overrides);
    if (!g) return m;
    const tight = g.weekly.reduce<ClaudeQuotaWindow | null>((a, w) => (!a || w.remaining < a.remaining ? w : a), null);
    const win = pill === '5h' ? (g.fiveHour ?? tight) : (tight ?? g.fiveHour);
    const weekly = win != null && win !== g.fiveHour;
    return {
      ...m,
      group: g.title,
      quotaRemaining: win?.remaining ?? null,
      quotaText: win ? `${weekly ? '7d ' : ''}${quotaPercentText(win.remaining)}` : null,
    };
  });
}
