// Small helpers shared by the Codex backend, transcript and settings: tolerant JSON access, the approval modes
// (port of the app's CodexPreferences.kt) and the labels of the Codex controls strip (CodexChatUi.kt).
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { QuotaWindowView } from '../../../shared/protocol';
import { countdownText } from '../agy/quota';
import { remainingText } from '../agy/settingsKit';

export type J = Record<string, any>;

/** An object field (null when absent or not an object). */
export function obj(v: any): J | null {
  return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null;
}
export function o(x: any, k: string): J | null {
  return obj(obj(x)?.[k]);
}
export function arr(x: any, k: string): any[] {
  const v = obj(x)?.[k];
  return Array.isArray(v) ? v : [];
}
/** A string field (numbers and booleans as text, like kotlinx's `content`). */
export function str(x: any, k: string): string | null {
  const v = obj(x)?.[k];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}
export function num(x: any, k: string): number | null {
  const v = obj(x)?.[k];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}
export function bool(x: any, k: string): boolean | null {
  const v = obj(x)?.[k];
  return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null;
}
export const nonBlank = (s: string | null | undefined): string | null => (s && s.trim() ? s : null);
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Whether Codex can be used (the app's CodexState). */
export type CodexStateName = 'CHECKING' | 'READY' | 'SIGNED_OUT' | 'NOT_INSTALLED' | 'DISABLED' | 'OUTDATED' | 'OFFLINE' | 'ERROR';

export const STATE_LABEL: Record<CodexStateName, string> = {
  CHECKING: 'Checking…',
  READY: 'Ready',
  SIGNED_OUT: 'Not signed in',
  NOT_INSTALLED: 'Not installed',
  DISABLED: 'Turned off on the bridge',
  OUTDATED: 'Bridge update needed',
  OFFLINE: 'Bridge offline',
  ERROR: 'Error',
};

// ------------------------------------------------------------------------------------------------ approval modes

/** Reads the project; asks before any change or command that needs more. */
export const MODE_READ_ONLY = 'read-only';
/** Edits the project; asks before every command that is not a known safe one. */
export const MODE_ASK = 'ask';
/** Codex's default: edits and runs commands inside the project; asks before going outside it or online. */
export const MODE_AUTO = 'auto';
/** No sandbox and no questions. */
export const MODE_FULL = 'full';
export const MODES = [MODE_READ_ONLY, MODE_ASK, MODE_AUTO, MODE_FULL];

/** `approvalPolicy` of a mode (thread/start, turn/start). */
export function approvalPolicy(mode: string): string {
  return mode === MODE_ASK ? 'untrusted' : mode === MODE_FULL ? 'never' : 'on-request';
}

/** `sandbox` of a mode for thread/start. */
export function sandboxMode(mode: string): string {
  return mode === MODE_READ_ONLY ? 'read-only' : mode === MODE_FULL ? 'danger-full-access' : 'workspace-write';
}

/** `sandboxPolicy` of a mode for turn/start (applies to that turn and the next ones). */
export function sandboxPolicy(mode: string): J {
  if (mode === MODE_READ_ONLY) return { type: 'readOnly', networkAccess: false };
  if (mode === MODE_FULL) return { type: 'dangerFullAccess' };
  return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

export function modeLabel(mode: string): string {
  return mode === MODE_READ_ONLY ? 'Read only' : mode === MODE_ASK ? 'Ask first' : mode === MODE_FULL ? 'Full access' : 'Auto';
}

export function modeDescription(mode: string): string {
  switch (mode) {
    case MODE_READ_ONLY:
      return 'Reads the project. Asks before changing files or running anything that needs more.';
    case MODE_ASK:
      return 'Edits files in the project; asks before running commands (except known safe ones).';
    case MODE_FULL:
      return 'No sandbox and no questions: Codex can change anything and use the network.';
    default:
      return "Codex's default: edits and runs commands inside the project; asks before going outside it or online.";
  }
}

export function modeIcon(mode: string): string {
  return mode === MODE_READ_ONLY ? 'lock' : mode === MODE_ASK ? 'pan_tool' : mode === MODE_FULL ? 'warning' : 'verified_user';
}

export function effortLabel(effort: string): string {
  if (!effort) return 'Default';
  if (effort === 'xhigh') return 'Extra high';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function effortDescription(effort: string): string {
  if (effort === 'low' || effort === 'minimal' || effort === 'none') return 'Fast answers for simple tasks.';
  if (effort === 'medium') return 'Balanced: the usual choice.';
  if (effort === 'high') return 'Thinks longer on hard problems (uses more of your limits).';
  return 'Longest thinking (uses the most of your limits).';
}

// ------------------------------------------------------------------------------------------------ usage limits

/** One usage-limit window (`account/rateLimits/read`): share used, its length and when it resets (epoch seconds). */
export interface LimitWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface RateLimits {
  primary: LimitWindow | null;
  secondary: LimitWindow | null;
  plan: string | null;
}

export function limitsOf(x: J | null): RateLimits | null {
  if (!x) return null;
  const w = (v: J | null): LimitWindow | null => (v ? { usedPercent: num(v, 'usedPercent') ?? 0, windowMinutes: num(v, 'windowDurationMins'), resetsAt: num(v, 'resetsAt') } : null);
  return { primary: w(o(x, 'primary')), secondary: w(o(x, 'secondary')), plan: str(x, 'planType') };
}

/** "5h", "7d", "30d", "45m" (the app's codexQuotaWindows label). */
export function windowLabel(minutes: number | null): string {
  if (minutes == null) return 'Limit';
  if (minutes >= 60 * 24) return `${Math.round(minutes / (60 * 24))}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

/** The plan's limits as quota meters: the primary window, then the secondary one. */
export function quotaWindows(limits: RateLimits | null): QuotaWindowView[] {
  return [limits?.primary, limits?.secondary]
    .filter((w): w is LimitWindow => w != null)
    .map((w) => {
      const remaining = Math.max(0, Math.min(1, 1 - w.usedPercent / 100));
      // share left in whole percents ("72%"), as the app's codexQuotaWindows (oneDecimal = false)
      return { label: windowLabel(w.windowMinutes), remaining, resetText: countdownText(w.resetsAt != null ? w.resetsAt * 1000 : null), text: remainingText(remaining, false) };
    });
}

export const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
