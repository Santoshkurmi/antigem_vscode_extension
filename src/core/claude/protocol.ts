// Claude Code stream-json protocol and bridge `/api/claude/` shapes (port of the app's ClaudeProtocol.kt), plus the
// small label helpers the app keeps in ClaudeUiKit.kt / ClaudeModeSheets.kt. Unknown fields are ignored; every
// number is read defensively (third-party providers send `null` usage counters).
/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------- bridge frames (WebSocket)

export interface BridgeSessionState {
  live: boolean;
  busy: boolean;
  pending_turns: number;
  buffer_start_seq: number;
  next_seq: number;
  history_offset: number;
}

export interface BridgeFrame {
  type: 'bridge_line' | 'bridge_state' | 'bridge_error' | string;
  seq?: number;
  data?: any;
  event?: 'attached' | 'spawned' | 'exited' | 'restarted' | string;
  state?: BridgeSessionState;
  exit_code?: number;
  error?: string;
}

/** Spawn options of a session (`bridge_config` frame or the session WebSocket's query). */
export interface SpawnConfig {
  cwd?: string;
  model?: string;
  permission_mode?: string;
  effort?: string;
  fork_from?: string;
  resume_session_at?: string;
  /** "on" | "off" */
  thinking?: string;
}

export function sessionState(s: any): BridgeSessionState {
  return {
    live: s?.live === true,
    busy: s?.busy === true,
    pending_turns: num(s?.pending_turns),
    buffer_start_seq: num(s?.buffer_start_seq),
    next_seq: num(s?.next_seq),
    history_offset: num(s?.history_offset),
  };
}

// ---------------------------------------------------------------- bridge REST

export interface SessionSummary {
  id: string;
  title: string;
  last_prompt: string;
  cwd: string;
  created_at: number;
  updated_at: number;
  live: boolean;
  busy: boolean;
  archived: boolean;
}

export interface ModelInfo {
  value: string;
  resolvedModel?: string | null;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
  disabled?: boolean;
}

export interface CommandInfo {
  name: string;
  description: string;
  argumentHint: string;
  builtin: boolean;
}

export interface InitializeInfo {
  models: ModelInfo[];
  commands: CommandInfo[];
  output_style?: string | null;
  available_output_styles: string[];
  account?: { email?: string | null; organization?: string | null; subscriptionType?: string | null } | null;
  current_permission_mode?: string | null;
  fast_mode_state?: string | null;
}

export function initializeInfo(i: any): InitializeInfo {
  const models: ModelInfo[] = (Array.isArray(i?.models) ? i.models : [])
    .filter((m: any) => typeof m?.value === 'string')
    .map((m: any) => ({
      ...m,
      displayName: String(m.displayName ?? ''),
      description: String(m.description ?? ''),
      supportedEffortLevels: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.map(String) : [],
    }));
  const commands: CommandInfo[] = (Array.isArray(i?.commands) ? i.commands : [])
    .filter((c: any) => typeof c?.name === 'string')
    .map((c: any) => ({ name: c.name, description: String(c.description ?? ''), argumentHint: String(c.argumentHint ?? ''), builtin: c.builtin === true }));
  return {
    models,
    commands,
    output_style: i?.output_style ?? null,
    available_output_styles: Array.isArray(i?.available_output_styles) ? i.available_output_styles.map(String) : [],
    account: i?.account ?? null,
    current_permission_mode: i?.current_permission_mode ?? null,
    fast_mode_state: i?.fast_mode_state ?? null,
  };
}

export interface CliStatus {
  installed: boolean;
  version?: string | null;
  bin_path?: string | null;
  auth?: { loggedIn?: boolean; authMethod?: string | null; email?: string | null; subscriptionType?: string | null; orgName?: string | null } | null;
  auth_error?: string | null;
  error?: string | null;
}

/** `/usage` → `usage` (plan limits; utilization 0-100). */
export interface UsageInfo {
  session?: { total_cost_usd?: number } | null;
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: any;
}

/** Live `rate_limit_event.rate_limit_info.unifiedWindows` entry (utilization 0..1, resetsAt unix seconds). */
export interface UnifiedWindow {
  utilization: number;
  resetsAt: number | null;
}

export interface ContextUsage {
  categories: { name: string; tokens: number }[];
  totalTokens: number;
  maxTokens: number;
  percentage: number;
}

export function contextUsage(r: any): ContextUsage | null {
  if (!r || typeof r !== 'object') return null;
  return {
    categories: (Array.isArray(r.categories) ? r.categories : []).map((c: any) => ({ name: String(c?.name ?? ''), tokens: num(c?.tokens) })),
    totalTokens: num(r.totalTokens),
    maxTokens: num(r.maxTokens),
    percentage: num(r.percentage),
  };
}

// ---------------------------------------------------------------- custom providers

export interface ProviderModel {
  id: string;
  name?: string | null;
  context_length?: number;
  max_output_tokens?: number;
  thinking_mode?: string;
  thinking_budget?: number;
  can_think?: boolean;
}

export interface Provider {
  id: string;
  name: string;
  base_url: string;
  api_key?: string | null;
  api_key_hint?: string | null;
  models_url?: string;
  small_model?: string;
  auth_mode?: string;
  headers?: Record<string, string>;
  extra_env?: Record<string, string>;
  timeout_sec?: number;
  thinking_budget?: number;
  max_retries?: number;
  default_context?: number;
  default_max_output?: number;
  disable_betas?: boolean;
  models: ProviderModel[];
  openrouter?: boolean;
  [k: string]: unknown;
}

export interface ModelLimits {
  context: number;
  maxOutput: number;
  thinkingBudget: number;
}

/** The settings a chat on [model] runs with: the model's own value, else the provider's default (limitsOf). */
export function limitsOf(p: Provider, modelId: string): ModelLimits {
  const m = p.models.find((x) => x.id === modelId);
  return {
    context: num(m?.context_length) > 0 ? num(m?.context_length) : num(p.default_context),
    maxOutput: num(m?.max_output_tokens) > 0 ? num(m?.max_output_tokens) : num(p.default_max_output),
    thinkingBudget: m?.thinking_mode === 'off' ? 0 : m?.thinking_mode === 'budget' ? num(m?.thinking_budget) : num(p.thinking_budget),
  };
}

export const sameLimits = (a: ModelLimits, b: ModelLimits) => a.context === b.context && a.maxOutput === b.maxOutput && a.thinkingBudget === b.thinkingBudget;

/** The provider id of a custom model ("@openrouter/x" → "openrouter"), "" for Claude's own models. */
export function providerOf(modelId: string): string {
  return modelId.startsWith('@') ? modelId.slice(1).split('/')[0] : '';
}

/** The model's own id (without "@provider/"). */
export function rawModel(modelId: string): string {
  return modelId.startsWith('@') ? modelId.slice(modelId.indexOf('/') + 1) : modelId;
}

/** 128000 → "128K", 1000000 → "1M". */
export function tokenLabel(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return Number.isInteger(v) ? `${v}M` : `${v.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.floor((n + 500) / 1000)}K`;
  return String(n);
}

/** "128K context · 8K output", or null when the context window is unknown. */
export function contextLabel(p: Provider, m: ProviderModel): string | null {
  const l = limitsOf(p, m.id);
  if (l.context <= 0) return null;
  return `${tokenLabel(l.context)} context${l.maxOutput > 0 ? ` · ${tokenLabel(l.maxOutput)} output` : ''}`;
}

// ---------------------------------------------------------------- labels

/** Permission modes in the order the mode menu shows them. */
export const PERMISSION_MODES: [string, string][] = [
  ['default', 'Manual'],
  ['acceptEdits', 'Accept edits'],
  ['plan', 'Plan'],
  ['auto', 'Auto'],
  ['dontAsk', "Don't ask"],
];

export function permissionModeLabel(mode: string): string {
  switch (mode) {
    case 'default':
      return 'Manual';
    case 'acceptEdits':
      return 'Accept edits';
    case 'plan':
      return 'Plan';
    case 'auto':
      return 'Auto';
    case 'dontAsk':
      return "Don't ask";
    case 'bypassPermissions':
      return 'Bypass';
    default:
      return mode;
  }
}

export function permissionModeDescription(mode: string): string {
  switch (mode) {
    case 'default':
      return 'Ask before edits and commands';
    case 'acceptEdits':
      return 'Apply file edits without asking';
    case 'plan':
      return 'Explore and propose a plan, no changes';
    case 'auto':
      return 'Claude decides what is safe to run';
    case 'dontAsk':
      return 'Never ask; deny anything not pre-allowed';
    case 'bypassPermissions':
      return 'Allow everything (sandboxes only)';
    default:
      return '';
  }
}

/** Material icon name of a permission mode (permissionModeIcon). */
export function permissionModeIcon(mode: string): string {
  switch (mode) {
    case 'plan':
      return 'map';
    case 'acceptEdits':
      return 'edit_note';
    case 'auto':
      return 'auto_mode';
    case 'bypassPermissions':
      return 'warning';
    case 'dontAsk':
      return 'do_not_disturb_on';
    default:
      return 'pan_tool';
  }
}

export function permissionModeTone(mode: string): 'accent' | 'warn' | 'danger' | 'success' | 'muted' {
  switch (mode) {
    case 'plan':
    case 'auto':
      return 'accent';
    case 'acceptEdits':
      return 'success';
    case 'bypassPermissions':
      return 'danger';
    case 'dontAsk':
      return 'warn';
    default:
      return 'muted';
  }
}

export function effortLabel(level: string | null | undefined): string {
  if (!level) return 'Default';
  if (level === 'xhigh') return 'Extra high';
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function effortDescription(level: string | null): string {
  switch (level) {
    case null:
      return "The model's own default";
    case 'low':
      return 'Quick answers with light reasoning';
    case 'medium':
      return 'Balanced speed and depth';
    case 'high':
      return 'Thorough work on hard tasks';
    case 'xhigh':
      return 'Extra depth for complex changes';
    case 'max':
      return 'Most thorough; uses plan limits fastest';
    default:
      return '';
  }
}

export function planLabel(raw: string): string {
  const l = raw.toLowerCase();
  if (l === 'pro') return 'Pro';
  if (l === 'max') return 'Max';
  if (l === 'team') return 'Team';
  if (l === 'enterprise') return 'Enterprise';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** 1234 → "1k", 1_500_000 → "1.5M" (compactTokens). */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.floor(n / 1000)}k`;
  return String(n);
}

/** Fraction used → chip tone (usageColor). */
export function usageTone(fraction: number): 'danger' | 'warn' | 'success' {
  return fraction >= 0.9 ? 'danger' : fraction >= 0.7 ? 'warn' : 'success';
}

/** "in 2h 14m" / "Tue 09:00" for an ISO-8601 or epoch-seconds reset time (formatReset). */
export function formatReset(iso: string | null | undefined, epochSeconds?: number | null): string | null {
  const millis = epochSeconds != null ? epochSeconds * 1000 : iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(millis)) return null;
  const diff = millis - Date.now();
  if (diff <= 0) return 'now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  const d = new Date(millis);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
