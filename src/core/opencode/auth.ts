// Port of the app's OpenCodeAuth.kt: how OpenCode's providers sign in (`GET /integration`): API key, OAuth (device
// code, or a browser that comes back to 127.0.0.1 on the machine OpenCode runs on), "external" (credentials already on
// that machine: Claude Code's login, an AWS profile, gcloud), and environment variables. Some methods first ask a few
// questions (a form), shown here as the fields of a settings form.
import type { SettingFormField } from '../../../shared/protocol';
import { arr, bool, obj, str, type Json } from './common';

/** One question of a sign-in form (GitHub.com or Enterprise, GitLab URL, Snowflake account…). */
export interface AuthField {
  key: string;
  type: string;
  title: string;
  description: string | null;
  placeholder: string | null;
  required: boolean;
  hidden: boolean;
  default: string | null;
  /** value → label (and description) for a choice. */
  options: { value: string; label: string; description: string | null }[];
  /** A choice field also takes a typed answer. */
  custom: boolean;
  /** Shown only when these hold. */
  conditions: { key: string; op: string; value: string }[];
  pattern: string | null;
}

export interface AuthMethod {
  type: string;
  id: string | null;
  label: string | null;
  envNames: string[];
  form: AuthField[];
}

export interface Integration {
  id: string;
  name: string;
  methods: AuthMethod[];
  connections: { id: string; label: string; method: string | null }[];
}

export interface Attempt {
  id: string;
  url: string;
  instructions: string;
  /** "auto": finishes by itself; "code": the user pastes a code from the provider. */
  mode: string;
  paste: boolean;
  expiresAt: number | null;
}

export const isKey = (m: AuthMethod) => m.type === 'key';
export const isOAuth = (m: AuthMethod) => m.type === 'oauth';
export const isExternal = (m: AuthMethod) => m.type === 'external';
/** The method shows a code to enter on the provider's site (works from any device). */
export const looksLikeDeviceCode = (m: AuthMethod) => isOAuth(m) && (m.id === 'device' || !!m.id?.includes('headless') || !!m.label?.toLowerCase().includes('device'));
export const signInMethods = (i: Integration) => i.methods.filter((m) => isKey(m) || isOAuth(m) || isExternal(m));

/** Methods in the app's order: browser / device-code sign-in first, the machine's own login, then a key. */
export function orderedMethods(i: Integration): AuthMethod[] {
  const rank = (m: AuthMethod) => (isOAuth(m) ? 0 : isExternal(m) ? 1 : 3);
  return [...signInMethods(i)].sort((a, b) => rank(a) - rank(b));
}

// ------------------------------------------------------------------ parsing

const prim = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);

export function field(o: Json): AuthField | null {
  const key = str(o, 'key');
  if (!key) return null;
  return {
    key,
    type: str(o, 'type') ?? 'string',
    title: str(o, 'title') ?? key,
    description: str(o, 'description') ?? null,
    placeholder: str(o, 'placeholder') ?? null,
    required: bool(o, 'required') === true,
    hidden: bool(o, 'hidden') === true,
    default: prim(o?.default),
    options: arr(o, 'options')
      .filter((op) => str(op, 'value') != null)
      .map((op) => ({ value: str(op, 'value')!, label: str(op, 'label') ?? str(op, 'value')!, description: str(op, 'description') ?? null })),
    custom: bool(o, 'custom') === true,
    conditions: arr(o, 'when')
      .filter((w) => str(w, 'key'))
      .map((w) => ({ key: str(w, 'key')!, op: str(w, 'op') ?? 'eq', value: prim(w?.value) ?? '' })),
    pattern: str(o, 'pattern') ?? null,
  };
}

export function method(o: Json): AuthMethod {
  return {
    type: str(o, 'type') ?? '',
    id: str(o, 'id') ?? null,
    label: str(o, 'label') ?? null,
    envNames: arr(o, 'names').map(prim).filter((x): x is string => !!x),
    form: arr(o, 'form').map(field).filter((f): f is AuthField => !!f),
  };
}

export function integrations(data: Json): Integration[] {
  return arr(data, 'data')
    .filter((o) => str(o, 'id'))
    .map((o) => ({
      id: str(o, 'id')!,
      name: str(o, 'name') ?? str(o, 'id')!,
      methods: arr(o, 'methods').map(method),
      connections: arr(o, 'connections')
        .filter((c) => str(c, 'id'))
        .map((c) => ({ id: str(c, 'id')!, label: str(c, 'label') ?? str(c, 'method') ?? str(c, 'type') ?? 'Account', method: str(c, 'method') ?? null })),
    }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export function attempt(o: Json): Attempt | null {
  const d = obj(o, 'data') ?? o;
  const id = str(d, 'attemptID');
  if (!id) return null;
  const expires = Number(obj(d, 'time')?.expires);
  return {
    id,
    url: str(d, 'url') ?? '',
    instructions: str(d, 'instructions') ?? '',
    mode: str(d, 'mode') ?? 'auto',
    paste: bool(d, 'paste') === true,
    expiresAt: Number.isFinite(expires) && expires > 0 ? expires : null,
  };
}

// ------------------------------------------------------------------ forms

/** Fields to show for `answers` so far (hidden fields and unmet conditions are left out). */
export function visibleFields(form: AuthField[], answers: Record<string, string>): AuthField[] {
  return form.filter(
    (f) =>
      !f.hidden &&
      f.conditions.every(({ key, op, value }) => {
        const cur = answers[key] ?? form.find((x) => x.key === key)?.default ?? '';
        return op === 'neq' ? cur !== value : cur === value;
      }),
  );
}

/** The answer object for the start call: visible answers plus the defaults of hidden fields. */
export function answer(form: AuthField[], answers: Record<string, string>): Record<string, unknown> {
  const shown = new Set(visibleFields(form, answers).map((f) => f.key));
  const out: Record<string, unknown> = {};
  for (const f of form) {
    const v = shown.has(f.key) ? answers[f.key]?.trim() || f.default : f.hidden ? f.default : null;
    if (v == null) continue;
    if (f.type === 'number') out[f.key] = Number.isFinite(Number(v)) ? Number(v) : v;
    else if (f.type === 'integer') out[f.key] = /^-?\d+$/.test(v) ? Number(v) : v;
    else if (f.type === 'boolean') out[f.key] = v === 'true';
    else out[f.key] = v;
  }
  return out;
}

/** What is still missing before the form can be sent (null = ready). */
export function missing(form: AuthField[], answers: Record<string, string>): string | null {
  const f = visibleFields(form, answers).find((x) => {
    const v = (answers[x.key]?.trim() || x.default) ?? '';
    if (x.required && !v) return true;
    if (v && x.pattern) {
      try {
        return !new RegExp(x.pattern).test(v);
      } catch {
        return false;
      }
    }
    return false;
  });
  return f?.title ?? null;
}

/**
 * A method's questions as settings form fields (choices as selects, a choice that also takes a typed answer gets a
 * text field next to it, conditional fields say when they apply), then the key for a key method.
 */
export function formFields(m: AuthMethod): SettingFormField[] {
  const out: SettingFormField[] = [];
  const titleOf = (key: string) => m.form.find((f) => f.key === key)?.title ?? key;
  for (const f of m.form) {
    if (f.hidden) continue;
    const when = f.conditions.length ? ` (only when ${f.conditions.map((c) => `${titleOf(c.key)} ${c.op === 'neq' ? 'is not' : 'is'} ${c.value}`).join(' and ')})` : '';
    const label = `${f.title}${f.required ? '' : ' (optional)'}${when}`;
    const required = f.required && !f.conditions.length;
    if (f.options.length) {
      const options = [...(f.required ? [] : [{ value: '', label: '—', description: null }]), ...f.options];
      out.push({ id: f.key, label, kind: 'select', value: f.default ?? options[0]?.value ?? '', options });
      if (f.custom) out.push({ id: `${f.key}__custom`, label: `${f.title}: or type it`, kind: 'text', placeholder: f.placeholder });
    } else if (f.type === 'boolean') {
      out.push({ id: f.key, label, kind: 'select', value: f.default ?? 'false', options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] });
    } else {
      out.push({ id: f.key, label: f.description && f.description !== f.title ? `${label} — ${f.description}` : label, kind: 'text', value: f.default ?? '', placeholder: f.placeholder, required });
    }
  }
  if (isKey(m)) out.push({ id: '__key', label: `API key${m.envNames[0] ? ` (or set ${m.envNames[0]} on this machine)` : ''}`, kind: 'password', required: true });
  return out;
}

/** The typed answers of a submitted method form (a typed "or type it" answer wins over the picked one). */
export function answersFrom(m: AuthMethod, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of m.form) {
    const typed = values[`${f.key}__custom`]?.trim();
    const v = typed || values[f.key];
    if (v != null && v !== '') out[f.key] = v;
  }
  return out;
}

// ------------------------------------------------------------------ helpers

const CODE = /code[:\s]+([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})*)/i;

export function codeIn(text: string): string | null {
  const c = CODE.exec(text)?.[1] ?? null;
  return c && (/\d/.test(c) || c.includes('-')) ? c : null;
}

export function queryParam(url: string, name: string): string | null {
  try {
    return new URL(url).searchParams.get(name);
  } catch {
    return null;
  }
}

export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

/** The code to enter on the provider's page ("Enter code: 43D3-E418"), if the attempt shows one. */
export const userCode = (a: Attempt) => codeIn(a.instructions) ?? queryParam(a.url, 'user_code');
/** The browser is sent back to 127.0.0.1 on the machine OpenCode runs on. */
export const returnsToLoopback = (a: Attempt) => {
  const r = queryParam(a.url, 'redirect_uri');
  return !!r && isLoopback(r);
};

/** A label for a method in a provider's menu. */
export function methodTitle(m: AuthMethod): string {
  if (isKey(m)) return m.label ?? 'API key';
  if (isExternal(m)) return m.label ?? "Use this machine's login";
  return m.label ?? 'Sign in';
}

export function methodHint(m: AuthMethod): string {
  if (isKey(m)) return `Paste the provider's API key${m.envNames[0] ? ` (or set ${m.envNames[0]} on this machine)` : ''}`;
  if (isExternal(m)) return 'Uses credentials already set up on this machine';
  if (looksLikeDeviceCode(m)) return "Enter a short code on the provider's site · works from any device";
  return 'Sign in in your browser';
}
