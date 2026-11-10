// Antigravity usage limits (RetrieveUserQuotaSummary) and `/` commands (GetAllSkills + built-ins): ports of the app's
// AgyModelService quota parsing, ModelQuotaGroups.kt (AgyQuotaGroups) and SlashCommandsCache.kt.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AiModel } from '../../../shared/model';
import type { ModelGroupView, QuotaWindowView, SlashCommandView } from '../../../shared/protocol';

export interface QuotaWindow {
  label: '5h' | '7d';
  remaining: number;
  resetAt: number | null;
}

export interface QuotaGroup {
  id: string;
  title: string;
  description: string;
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow[];
}

const tsMillis = (ts: any): number | null => (ts ? Number(ts.seconds ?? 0) * 1000 + Math.floor(Number(ts.nanos ?? 0) / 1e6) : null);

/** RetrieveUserQuotaSummary response → groups (only 5h and weekly buckets, like the app). */
export function parseQuotaSummary(res: any): QuotaGroup[] {
  const groups: any[] = res?.response?.groups ?? [];
  return groups.map((g) => {
    const name: string = g.display_name ?? '';
    const lower = name.toLowerCase();
    const id = lower.includes('argon') ? 'argon' : lower.includes('claude') || lower.includes('gpt') ? 'claude_gpt' : lower.includes('gemini') ? 'gemini' : lower.replace(/\s+/g, '_');
    let fiveHour: QuotaWindow | null = null;
    let weekly: QuotaWindow | null = null;
    for (const b of g.buckets ?? []) {
      if (b.disabled) continue;
      const w = String(b.window ?? '').toLowerCase();
      const win = { remaining: Math.max(0, Math.min(1, Number(b.remaining_fraction ?? 0))), resetAt: tsMillis(b.reset_time) };
      if (w.includes('5h')) fiveHour = { label: '5h', ...win };
      else if (w.includes('week') || w.includes('7d')) weekly = { label: '7d', ...win };
    }
    return { id, title: name || id, description: g.description ?? '', fiveHour, weekly: weekly ? [weekly] : [] };
  });
}

/** "48.8%" (one decimal, "100" not "100.0"), as the app's quotaPercentText. */
export function quotaPercentText(remaining: number): string {
  const pct = Math.max(0, Math.min(100, remaining * 100));
  const t = pct.toFixed(1);
  return `${t === '100.0' ? '100' : t}%`;
}

/** "3d 21h" / "2h 4m" / "45m" / "Ready", as the app's formatCleanCountdown. */
export function countdownText(resetAt: number | null): string | null {
  if (resetAt == null) return null;
  const ms = resetAt - Date.now();
  if (ms <= 0) return 'Ready';
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

const TIER_SUFFIX = /-(extra-low|low|medium|med|high)$/i;

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9.-]+/)
      .filter((w) => w && w !== 'models' && w !== 'and'),
  );
}
const containsAll = (a: Set<string>, b: Set<string>) => [...b].every((x) => a.has(x));

export function modelKey(m: AiModel): string {
  return (m.baseName || (m.key ?? m.id).replace(TIER_SUFFIX, '')).trim().toLowerCase();
}

/** The group a model counts against: a user override, else the app's best guess from the server's own words. */
export function groupOf(m: AiModel, groups: QuotaGroup[], overrides: Record<string, string> = {}): QuotaGroup | null {
  // the user's choice while that group still exists (stored by group id; the model sheet names groups by title)
  const o = overrides[modelKey(m)];
  if (o) {
    const g = groups.find((x) => x.id === o) ?? groups.find((x) => x.title === o);
    if (g) return g;
  }
  if (!groups.length) return null;
  const base = m.baseName || m.displayName;
  const mw = words(`${base} ${m.displayName}`);
  let byTitle: { g: QuotaGroup; n: number } | null = null;
  for (const g of groups) {
    const t = words(g.title);
    if (t.size && containsAll(mw, t) && (!byTitle || t.size > byTitle.n)) byTitle = { g, n: t.size };
  }
  if (byTitle && byTitle.n >= 2) return byTitle.g;
  const listed = groups.find(
    (g) =>
      /within this group/i.test(g.description) &&
      g.description
        .slice(g.description.indexOf(':') + 1)
        .split(',')
        .some((item) => {
          const w = words(item);
          return w.size > 0 && containsAll(mw, w);
        }),
  );
  if (listed) return listed;
  if (byTitle) return byTitle.g;
  const name = `${m.displayName} ${m.key ?? ''} ${m.id}`.toLowerCase();
  const has = (s: string, w: string) => s.toLowerCase().includes(w);
  const fam = name.includes('argon')
    ? groups.find((g) => has(g.title, 'argon') || g.id === 'argon')
    : name.includes('claude') || name.includes('gpt')
      ? groups.find((g) => has(g.title, 'claude') || has(g.title, 'gpt') || g.id === 'claude_gpt')
      : groups.find((g) => (has(g.title, 'gemini') || g.id === 'gemini') && !has(g.title, 'argon'));
  return fam ?? groups[0];
}

function windowView(w: QuotaWindow): QuotaWindowView {
  return { label: w.label, remaining: w.remaining, resetText: countdownText(w.resetAt) };
}

/** Model picker sections and each model's chat-pill text. `pill` = which limit the pill shows (app default 5h). */
export function applyQuota(
  models: AiModel[],
  groups: QuotaGroup[],
  pill: '5h' | '7d' = '5h',
  overrides: Record<string, string> = {},
): { models: AiModel[]; groups: ModelGroupView[] } {
  const out = models.map((m) => {
    const g = groupOf(m, groups, overrides);
    if (!g) return { ...m, group: null, quotaRemaining: null, quotaText: null };
    const tight = g.weekly.reduce<QuotaWindow | null>((a, w) => (!a || w.remaining < a.remaining ? w : a), null);
    const win = pill === '5h' ? (g.fiveHour ?? tight) : (tight ?? g.fiveHour);
    const weekly = win != null && win !== g.fiveHour;
    return {
      ...m,
      group: g.title,
      quotaRemaining: win?.remaining ?? null,
      quotaText: win ? `${weekly ? '7d ' : ''}${quotaPercentText(win.remaining)}` : null,
    };
  });
  const views: ModelGroupView[] = groups.map((g) => ({
    name: g.title,
    windows: [g.fiveHour, g.weekly[0] ?? null].filter((w): w is QuotaWindow => w != null).map(windowView),
  }));
  return { models: out, groups: views };
}

// ---------------------------------------------------------------- `/` commands

/** Antigravity's built-in commands (SlashCommandsCache.BUILTIN_COMMANDS). */
const BUILTIN_COMMANDS: [string, string][] = [
  ['goal', 'Run a long-running task overnight and be extra thorough until the goal is achieved'],
  ['schedule', 'Schedule a one-shot timer or recurring cron job'],
  ['browser', 'Interact with web applications or search and browse the web'],
  ['plan', 'Create an implementation plan before taking action'],
  ['grill-me', 'Interactive interview to resolve design decisions and align on approach'],
  ['teamwork-preview', 'Coordinate a team of autonomous agents working together'],
  ['learn', 'Persist custom setup and learned behaviors for future tasks'],
  ['boost', 'Deep thinking, strategic planning, and verification for complex tasks'],
  ['terminal', 'Open terminal session or execute local shell commands'],
  ['ide', 'Open the code editor IDE'],
];

/** Fallback known skills (SlashCommandsCache.DEFAULT_SKILLS). */
const DEFAULT_SKILLS: [string, string, string | null][] = [
  ['android-cli', 'Android CLI tools, emulator, SDK management, APK building', 'android-cli-plugin'],
  ['chrome-extensions', 'Build and publish Chrome Extensions using Manifest V3 best practices', 'modern-web-guidance-plugin'],
  ['modern-web-guidance', 'Search tool for modern web development best practices (HTML/CSS/JS/React/Vue)', 'modern-web-guidance-plugin'],
  ['agy-customizations', 'Comprehensive guide for skills, rules, plugins, hooks, MCP servers', null],
  ['antigravity-guide', 'Comprehensive guide and quick reference for Google Antigravity (AGY CLI, 2.0, IDE, SDK)', null],
  ['generative_ui', 'Render rich interactive HTML widgets inline in chat or as artifacts', null],
  ['migrate-workflows', 'Automatically migrate legacy workflows to modern skills', null],
  ['permissioned-github', 'GitHub integration, PRs, issues, repository operations', null],
];

/** GetAllSkills skills + default skills + built-in commands, de-duplicated by name and sorted (as the app). */
export function agySlashCommands(skillsResponse: any | null): SlashCommandView[] {
  const seen = new Set<string>();
  const items: (SlashCommandView & { name: string })[] = [];
  for (const s of skillsResponse?.skills ?? []) {
    const name: string = s.name ?? '';
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const desc = String(s.description ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean);
    items.push({ name, command: `/${name}`, description: desc ?? null, kind: 'skill', pluginName: s.plugin_name || null });
  }
  for (const [name, description, pluginName] of DEFAULT_SKILLS) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    items.push({ name, command: `/${name}`, description, kind: 'skill', pluginName });
  }
  for (const [name, description] of BUILTIN_COMMANDS) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    items.push({ name, command: `/${name}`, description, kind: 'command' });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items.map(({ name: _n, ...rest }) => rest);
}
