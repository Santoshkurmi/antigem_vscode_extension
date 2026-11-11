import type { AgentKind } from '@shared/model';
import type { AgentRunState } from '@shared/protocol';

/** formatDuration() from MessageBubble.kt */
export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '';
  const totalSeconds = Math.floor((ms + 500) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0 && seconds > 0) return `${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m`;
  if (ms < 1000) return `${ms}ms`;
  if (totalSeconds < 10) return `${(ms / 1000).toFixed(1)}s`;
  return `${seconds}s`;
}

/** formatCompactTokens() from MessageBubble.kt */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`.replace('.0M', 'M');
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`.replace('.0k', 'k');
  return String(n);
}

/** formatRelativeTime() from ChatHistoryDrawer.kt */
export function relativeTime(ts: number): string {
  if (!ts || ts <= 0) return '';
  const diff = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return 'now';
  if (hours < 1) return `${minutes}m`;
  if (days < 1) return `${hours}h`;
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.max(1, Math.floor(days / 30))}mo`;
  return `${Math.max(1, Math.floor(days / 365))}y`;
}

export function shortModelName(model: string): string {
  return model.substring(model.lastIndexOf('/') + 1).replace(/^claude-/, '');
}

export function agentLabel(a: AgentKind): string {
  return a === 'AGY' ? 'Antigravity' : a === 'CLAUDE' ? 'Claude Code' : a === 'OPENCODE' ? 'OpenCode' : 'Codex';
}

/** The short names of the drawer's filter chips. */
export function agentChipLabel(a: AgentKind): string {
  return a === 'AGY' ? 'Antigravity' : a === 'CLAUDE' ? 'Claude' : a === 'OPENCODE' ? 'OpenCode' : 'Codex';
}

export function agentAccent(a: AgentKind): string {
  return a === 'AGY' ? 'var(--agy)' : a === 'CLAUDE' ? 'var(--claude)' : a === 'OPENCODE' ? 'var(--opencode)' : 'var(--codex)';
}

/** Raw hex accents (for color-mix in inline styles it is the same as the CSS var). */
export const AGENT_HEX: Record<AgentKind, string> = {
  AGY: '#3B82F6',
  CLAUDE: '#D97757',
  OPENCODE: '#10B981',
  CODEX: '#8B5CF6',
};

/** Status dot colors (SystemStatus / ClaudeStatus dotColor). */
export function stateColor(s: AgentRunState | undefined): string {
  switch (s) {
    case 'online':
      return '#22C55E';
    case 'starting':
      return '#F59E0B';
    case 'error':
      return '#EF4444';
    case 'not_installed':
      return '#F97316';
    case 'offline':
    case 'disabled':
    default:
      return '#9CA3AF';
  }
}

export function stateLabel(s: AgentRunState | undefined): string {
  switch (s) {
    case 'online':
      return 'Ready';
    case 'starting':
      return 'Starting…';
    case 'error':
      return 'Error';
    case 'not_installed':
      return 'Not installed';
    case 'disabled':
      return 'Disabled';
    default:
      return 'Offline';
  }
}

/** Alpha variant of a color (Compose's Color.copy(alpha = a)). */
export const alpha = (color: string, a: number) => `color-mix(in srgb, ${color} ${Math.round(a * 1000) / 10}%, transparent)`;

/** "Sat, Oct 10, 15:45" (the year added when it is not this year) — ChatFeedCache.dayLabel. */
export function dayLabel(ms: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date}, ${time}`;
}

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function workspaceName(uri: string | null | undefined): string {
  if (!uri) return '';
  // a link (file:///c%3A/…) or a path of any OS (C:\Users\…, /home/…)
  const clean = uri.replace(/^file:\/\//, '').replace(/[\\/]+$/, '');
  const name = clean.split(/[\\/]/).pop() ?? clean;
  try {
    return decodeURIComponent(name) || 'Workspace';
  } catch {
    return name || 'Workspace';
  }
}

export function formatSize(bytes: number): string {
  // a small file in bytes: rounded to KB it read "0 KB", as if it were empty
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
}
