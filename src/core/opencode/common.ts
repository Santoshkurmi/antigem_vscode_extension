// Small helpers shared by the OpenCode backend, transcript and settings (ports of the app's OpenCodeTranscript.kt JSON
// accessors, OpenCodeChatBackend.newId / rules and OpenCodePreferences constants).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomInt } from 'node:crypto';

export type Json = any;

/** A string value (numbers and booleans as text, like kotlinx's `contentOrNull`). */
export function str(o: Json, key: string): string | undefined {
  const v = o?.[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}
export function num(o: Json, key: string): number | undefined {
  const v = o?.[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
export function bool(o: Json, key: string): boolean | undefined {
  const v = o?.[key];
  return typeof v === 'boolean' ? v : undefined;
}
export function obj(o: Json, key: string): Json | undefined {
  const v = o?.[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
}
export function arr(o: Json, key: string): Json[] {
  const v = o?.[key];
  return Array.isArray(v) ? v : [];
}
export function isObj(v: Json): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Whether OpenCode can be used (the app's OpenCodeState). */
export type OpenCodeState = 'checking' | 'ready' | 'not_installed' | 'disabled' | 'outdated' | 'offline' | 'error';

export const STATE_LABELS: Record<OpenCodeState, string> = {
  checking: 'Checking…',
  ready: 'Ready',
  not_installed: 'Not installed',
  disabled: 'Turned off on the bridge',
  outdated: 'Bridge update needed',
  offline: 'Bridge offline',
  error: 'Error',
};

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ ids

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastMs = 0;
let counter = 0;

/**
 * An id in OpenCode's own format ("ses_" / "msg_" + 12 hex digits of time + 14 random characters), so ids made here
 * sort like OpenCode's: sessions newest first (descending), messages oldest first.
 */
export function newId(prefix: 'ses' | 'msg', descending: boolean): string {
  const now = Date.now();
  if (now !== lastMs) {
    lastMs = now;
    counter = 0;
  }
  counter++;
  let v = BigInt(now) * 0x1000n + BigInt(counter);
  if (descending) v = ~v;
  const hex = (v & 0xffffffffffffn).toString(16).padStart(12, '0');
  let rnd = '';
  for (let i = 0; i < 14; i++) rnd += BASE62[randomInt(BASE62.length)];
  return `${prefix}_${hex}${rnd}`;
}

/** OpenCode's session ids ("ses_…"); anything else is a view-made id that gets an alias. */
export const isSessionId = (id: string) => id.startsWith('ses_');

// ------------------------------------------------------------------------------------------------ models

/** "provider/model" of an OpenCode model ref ({id, providerID}). */
export function modelRef(m: Json): string | null {
  const id = str(m, 'id');
  if (!id) return null;
  const provider = str(m, 'providerID');
  return provider ? `${provider}/${id}` : id;
}

/** {id, providerID} for a "provider/model" id (null when it is not one). */
export function modelRefJson(modelId: string | null | undefined): { id: string; providerID: string } | null {
  if (!modelId) return null;
  const i = modelId.indexOf('/');
  if (i <= 0 || i === modelId.length - 1) return null;
  return { id: modelId.slice(i + 1), providerID: modelId.slice(0, i) };
}

export const providerOf = (modelId: string) => (modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : modelId);

// ------------------------------------------------------------------------------------------------ approvals mode

/** OpenCode's own rules (its config and the agent's; most tools run without asking). */
export const MODE_DEFAULT = 'default';
/** Ask before commands, file edits and web access; reading the project is allowed. */
export const MODE_ASK = 'ask';
/** Allow everything without asking. */
export const MODE_AUTO = 'auto';
export const MODES = [MODE_ASK, MODE_AUTO, MODE_DEFAULT] as const;

export function modeLabel(mode: string): string {
  return mode === MODE_AUTO ? 'Allow all' : mode === MODE_DEFAULT ? 'OpenCode rules' : 'Ask first';
}

export function modeDescription(mode: string): string {
  return mode === MODE_AUTO
    ? 'Commands, edits and web access run without asking.'
    : mode === MODE_DEFAULT
      ? "OpenCode's own rules from its config (by default most tools run without asking)."
      : 'Ask before commands, file changes and web access. Reading the project is allowed.';
}

export function modeIcon(mode: string): string {
  return mode === MODE_AUTO ? 'warning' : mode === MODE_DEFAULT ? 'rule' : 'pan_tool';
}

/**
 * Session permission rules for an approval mode. Session rules are checked after the agent's, so they win; the plan
 * agent keeps its "no edits" rule. null = no session rules (OpenCode's own).
 */
export function rules(mode: string, agent: string): { action: string; resource: string; effect: string }[] | null {
  const rule = (action: string, effect: string, resource = '*') => ({ action, resource, effect });
  const plan = agent === 'plan';
  if (mode === MODE_AUTO) return [rule('*', 'allow'), ...(plan ? [rule('edit', 'deny')] : [])];
  if (mode === MODE_ASK)
    return [
      rule('shell', 'ask'),
      ...(plan ? [] : [rule('edit', 'ask')]),
      rule('webfetch', 'ask'),
      rule('websearch', 'ask'),
      rule('external_directory', 'ask'),
      // files the app copied for the chat (OpenCode's `*` also matches across folders; last match wins)
      rule('external_directory', 'allow', '*/.antigem/uploads/*'),
    ];
  return null;
}

// ------------------------------------------------------------------------------------------------ agents

/** One agent of OpenCode (build, plan, or the user's own). */
export interface OpenCodeAgent {
  id: string;
  name: string;
  description: string;
}

export const DEFAULT_AGENTS: OpenCodeAgent[] = [
  { id: 'build', name: 'build', description: '' },
  { id: 'plan', name: 'plan', description: '' },
];

export function agentIcon(id: string): string {
  return id === 'plan' ? 'lightbulb' : id === 'build' ? 'smart_toy' : 'psychology';
}

export function agentDescription(a: OpenCodeAgent): string {
  return a.id === 'build'
    ? 'Makes changes: edits files and runs commands to get the job done.'
    : a.id === 'plan'
      ? 'Read-only: explores the code and plans the work, without changing files.'
      : a.description || 'Your own agent from the OpenCode config.';
}

export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
