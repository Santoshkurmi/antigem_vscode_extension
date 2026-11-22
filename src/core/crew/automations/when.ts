// When an automation runs (docs/crew/PLAN.md §13), read leniently from what a bot or the user wrote ("every weekday at
// 9:00", "every 30 min between 9 and 17", "cron 0 9 * * 1-5", "when tests fail", "on save of src/**/*.ts", "in 2h"),
// told back as a plain sentence, and the next time a schedule is due (local time).

export type EditorEvent = 'file_saved' | 'problems_rose' | 'task_failed' | 'test_failed' | 'git_commit' | 'git_branch' | 'git_pull' | 'terminal_failed' | 'files_changed' | 'project_opened';
export const EDITOR_EVENTS: EditorEvent[] = ['file_saved', 'problems_rose', 'task_failed', 'test_failed', 'git_commit', 'git_branch', 'git_pull', 'terminal_failed', 'files_changed', 'project_opened'];

export type Schedule =
  | { type: 'once'; at: number }
  | { type: 'daily'; time: string; days: number[] }
  | { type: 'every'; minutes: number; from?: string; to?: string; until?: number | null }
  | { type: 'cron'; expr: string };

export type WaitKind = 'url_contains' | 'url_missing' | 'file_exists' | 'file_missing' | 'file_changed' | 'process_running' | 'process_gone' | 'bot_idle';
export const WAIT_KINDS: WaitKind[] = ['url_contains', 'url_missing', 'file_exists', 'file_missing', 'file_changed', 'process_running', 'process_gone', 'bot_idle'];

export type When =
  | { kind: 'schedule'; schedule: Schedule }
  | { kind: 'event'; event: EditorEvent; filter: string | null }
  | { kind: 'webhook'; filter: string | null }
  | { kind: 'wait'; wait: WaitKind; target: string; text: string | null; expiresAt: number }
  | { kind: 'checkback'; at: number };

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const pad = (n: number) => String(n).padStart(2, '0');

/** "9", "9:30", "09:30", "9am", "5:15 pm" → "HH:MM" (null = not a time). */
export function readTime(s: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]) {
    if (h === 12) h = 0;
    if (/pm/i.test(m[3])) h += 12;
  }
  return h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null;
}

function readDays(s: string): number[] | null {
  const t = s.toLowerCase();
  if (/\b(weekdays?|workdays?|mon(day)?\s*(-|to|through)\s*fri(day)?)\b/.test(t)) return WEEKDAYS;
  if (/\bweekends?\b/.test(t)) return [0, 6];
  if (/\b(daily|every\s*day|each\s*day)\b/.test(t)) return ALL_DAYS;
  const found = DAY_NAMES.map((d, i) => (new RegExp(`\\b${d.slice(0, 3)}(${d.slice(3)})?s?\\b`).test(t) ? i : -1)).filter((i) => i >= 0);
  return found.length ? found : null;
}

/** "in 2h", "in 30 minutes", "tomorrow 9:00", "friday 9", "2026-11-23 09:00" → a time (null = not one). */
export function readMoment(s: string, now = Date.now()): number | null {
  const t = s.trim().toLowerCase().replace(/^(at|on)\s+/, '');
  const rel = /^in\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2][0] === 'm' ? 60_000 : rel[2][0] === 'h' ? 3600_000 : 86_400_000;
    return now + Math.round(n * unit);
  }
  const iso = Date.parse(s.trim().replace(' ', 'T'));
  if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(s)) return iso;
  const dm = /^(today|tomorrow|(?:next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*)?\s*(?:at\s+)?([\d:]+\s*(?:am|pm)?)?$/.exec(t);
  if (dm && (dm[1] || dm[3])) {
    const time = dm[3] ? readTime(dm[3]) : '09:00';
    if (!time) return null;
    const [h, m] = time.split(':').map(Number);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (dm[1] === 'tomorrow') d.setDate(d.getDate() + 1);
    else if (dm[2]) {
      const want = DAY_NAMES.findIndex((x) => x.startsWith(dm[2]));
      let add = (want - d.getDay() + 7) % 7;
      if (add === 0 && d.getTime() <= now) add = 7;
      d.setDate(d.getDate() + add);
    } else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

const EVENT_WORDS: [RegExp, EditorEvent][] = [
  [/\btests?\b.*\b(fail|break|red)|\bfailing tests?\b/, 'test_failed'],
  [/\b(task|build)s?\b.*\b(fail|break)/, 'task_failed'],
  [/\b(terminal|command)s?\b.*\b(fail|exit|error)/, 'terminal_failed'],
  [/\b(problems?|errors?|diagnostics?|warnings?)\b.*\b(rise|grow|increase|go up|appear|new)|\bnew (problems?|errors?)\b/, 'problems_rose'],
  [/\bcommit/, 'git_commit'],
  [/\b(branch|checkout|switch)/, 'git_branch'],
  [/\bpull/, 'git_pull'],
  [/\b(save|saved|saving)\b/, 'file_saved'],
  [/\b(files?|folder)\b.*\b(change|create|delete|added|removed)/, 'files_changed'],
  [/\b(project|workspace|editor)\b.*\b(open|start)/, 'project_opened'],
];

export interface ParseResult {
  when: When | null;
  error: string | null;
}

const HELP =
  'Say when, e.g. "every weekday at 9:00", "daily at 18:30", "every 30 min between 9:00 and 17:00", "mon,wed at 8", "once at 2026-12-01 10:00", "in 2h", "cron 0 9 * * 1-5", "when tests fail", "when a task fails", "when a terminal command fails", "when problems increase", "on save of src/**/*.ts", "when files change in docs/**", "on commit", "on branch switch", "after a pull", "when the project opens", or "webhook".';

/** A "when" from a sentence or a structured object (lenient); error says what would be understood. */
export function parseWhen(input: unknown, now = Date.now()): ParseResult {
  if (input && typeof input === 'object') return fromObject(input as Record<string, unknown>, now);
  const raw = String(input ?? '').trim();
  if (raw.startsWith('{')) {
    try {
      return fromObject(JSON.parse(raw), now);
    } catch {
      /* a sentence after all */
    }
  }
  const t = raw.toLowerCase();
  if (!t) return { when: null, error: HELP };
  if (/^webhook\b/.test(t)) return { when: { kind: 'webhook', filter: raw.replace(/^webhook\s*/i, '').trim() || null }, error: null };
  const cron = /^cron\s+(.+)$/.exec(raw.trim());
  if (cron) return validCron(cron[1].trim()) ? { when: { kind: 'schedule', schedule: { type: 'cron', expr: cron[1].trim() } }, error: null } : { when: null, error: `"${cron[1]}" is not a cron expression (5 fields: minute hour day month weekday).` };
  const every = /\bevery\s+(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?)\b(?:.*?\bbetween\s+([\d:apm ]+?)\s+and\s+([\d:apm ]+))?/.exec(t);
  if (every) {
    const minutes = Number(every[1]) * (every[2][0] === 'h' ? 60 : 1);
    if (minutes < 5 || minutes > 1440) return { when: null, error: 'Every 5 minutes to every 24 hours.' };
    const from = every[3] ? readTime(every[3]) : null;
    const to = every[4] ? readTime(every[4]) : null;
    return { when: { kind: 'schedule', schedule: { type: 'every', minutes, ...(from && to ? { from, to } : {}) } }, error: null };
  }
  const atTime = /\b(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*$/.exec(t.replace(/\b(every|each)\s+/g, ''));
  const days = readDays(t);
  if (days && atTime) {
    const time = readTime(atTime[1]);
    if (time) return { when: { kind: 'schedule', schedule: { type: 'daily', time, days } }, error: null };
  }
  for (const [re, ev] of EVENT_WORDS) {
    if (re.test(t) && /\b(when|on|after|whenever|if|each time|every time)\b/.test(t)) {
      const glob = /\b(?:of|in|under|matching|for)\s+([^\s,;]*[*/.][^\s,;]*)/.exec(raw)?.[1] ?? null;
      return { when: { kind: 'event', event: ev, filter: glob }, error: null };
    }
  }
  const once = /^(?:once\s+)?(?:at\s+|on\s+)?(.+)$/.exec(t.replace(/^once\b\s*/, ''));
  const at = once ? readMoment(once[1], now) : null;
  if (at) return { when: { kind: 'schedule', schedule: { type: 'once', at } }, error: null };
  return { when: null, error: `I could not read "${raw}". ${HELP}` };
}

function fromObject(o: Record<string, unknown>, now: number): ParseResult {
  const kind = String(o.kind ?? o.type ?? '');
  if (EDITOR_EVENTS.includes(String(o.event ?? kind) as EditorEvent)) return { when: { kind: 'event', event: String(o.event ?? kind) as EditorEvent, filter: o.filter ? String(o.filter) : (o.glob ? String(o.glob) : null) }, error: null };
  if (kind === 'webhook') return { when: { kind: 'webhook', filter: o.filter ? String(o.filter) : null }, error: null };
  if (kind === 'cron' && validCron(String(o.expr ?? ''))) return { when: { kind: 'schedule', schedule: { type: 'cron', expr: String(o.expr) } }, error: null };
  if (kind === 'daily') {
    const time = readTime(String(o.time ?? ''));
    const days = Array.isArray(o.days) ? o.days.map(Number).filter((d) => d >= 0 && d <= 6) : ALL_DAYS;
    if (time) return { when: { kind: 'schedule', schedule: { type: 'daily', time, days: days.length ? days : ALL_DAYS } }, error: null };
  }
  if (kind === 'every' || kind === 'interval') {
    const minutes = Math.round(Number(o.minutes ?? 0));
    if (minutes >= 5 && minutes <= 1440) return { when: { kind: 'schedule', schedule: { type: 'every', minutes, ...(o.from && o.to ? { from: readTime(String(o.from)) ?? undefined, to: readTime(String(o.to)) ?? undefined } : {}) } }, error: null };
  }
  if (kind === 'once') {
    const at = typeof o.at === 'number' ? o.at : readMoment(String(o.at ?? ''), now);
    if (at) return { when: { kind: 'schedule', schedule: { type: 'once', at } }, error: null };
  }
  return { when: null, error: HELP };
}

// ------------------------------------------------------------------------------------------------ cron

/** One cron field ("*", "1,5", "1-5", "*\/15", "mon-fri") → the allowed values. */
function cronField(f: string, lo: number, hi: number, names: string[] = []): Set<number> | null {
  const out = new Set<number>();
  for (const part of f.toLowerCase().split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS ? Number(stepS) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    const val = (x: string) => (names.includes(x.slice(0, 3)) ? names.indexOf(x.slice(0, 3)) + lo : Number(x));
    let a: number;
    let b: number;
    if (range === '*') [a, b] = [lo, hi];
    else if (range.includes('-')) [a, b] = range.split('-').map(val) as [number, number];
    else [a, b] = [val(range), stepS ? hi : val(range)];
    if (![a, b].every((x) => Number.isInteger(x) && x >= lo && x <= hi + (hi === 6 ? 1 : 0)) || a > b) return null;
    for (let x = a; x <= b; x += step) out.add(hi === 6 && x === 7 ? 0 : x);
  }
  return out;
}

function cronParts(expr: string) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const parts = [cronField(f[0], 0, 59), cronField(f[1], 0, 23), cronField(f[2], 1, 31), cronField(f[3], 1, 12, ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']), cronField(f[4], 0, 6, ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])];
  return parts.every(Boolean) ? (parts as Set<number>[]) : null;
}

export const validCron = (expr: string) => !!cronParts(expr);

// ------------------------------------------------------------------------------------------------ next run

const atTime = (base: Date, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
};

/** The next time a schedule is due after [after] (null = never again). */
export function nextRun(s: Schedule, after: number, anchor = after): number | null {
  switch (s.type) {
    case 'once':
      return s.at > after ? s.at : null;
    case 'daily': {
      for (let i = 0; i < 8; i++) {
        const d = atTime(new Date(after), s.time);
        d.setDate(d.getDate() + i);
        if (d.getTime() > after && s.days.includes(d.getDay())) return d.getTime();
      }
      return null;
    }
    case 'every': {
      const step = s.minutes * 60_000;
      let t = anchor + Math.ceil((after + 1 - anchor) / step) * step;
      for (let i = 0; i < 2000; i++, t += step) {
        if (s.until && t > s.until) return null;
        if (!s.from || !s.to) return t;
        const d = new Date(t);
        const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        if (hm >= s.from && hm <= s.to) return t;
      }
      return null;
    }
    case 'cron': {
      const p = cronParts(s.expr);
      if (!p) return null;
      const d = new Date(after);
      d.setSeconds(0, 0);
      d.setMinutes(d.getMinutes() + 1);
      for (let i = 0; i < 366 * 24 * 60; i++) {
        if (p[3].has(d.getMonth() + 1) && p[2].has(d.getDate()) && p[4].has(d.getDay()) && p[1].has(d.getHours()) && p[0].has(d.getMinutes())) return d.getTime();
        d.setMinutes(d.getMinutes() + 1);
      }
      return null;
    }
  }
}

// ------------------------------------------------------------------------------------------------ sentences

const dayList = (days: number[]) =>
  days.length === 7 ? 'every day' : days.join() === WEEKDAYS.join() ? 'every weekday' : days.join() === '0,6' ? 'on weekends' : `on ${days.map((d) => DAY_NAMES[d].slice(0, 1).toUpperCase() + DAY_NAMES[d].slice(1, 3)).join(', ')}`;
const when12 = (t: number) => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const EVENT_TEXT: Record<EditorEvent, string> = {
  file_saved: 'When a file is saved',
  problems_rose: 'When the problems count goes up',
  task_failed: 'When a task fails',
  test_failed: 'When tests fail',
  git_commit: 'After a git commit',
  git_branch: 'When the git branch changes',
  git_pull: 'After a git pull',
  terminal_failed: 'When a terminal command fails',
  files_changed: 'When files change',
  project_opened: 'When the project opens',
};

const WAIT_TEXT: Record<WaitKind, string> = {
  url_contains: 'When the page shows',
  url_missing: 'When the page no longer shows',
  file_exists: 'When this file appears:',
  file_missing: 'When this file is gone:',
  file_changed: 'When this file changes:',
  process_running: 'When this process runs:',
  process_gone: 'When this process ends:',
  bot_idle: 'When this bot is free:',
};

/** "Every weekday at 09:00", "When tests fail (src/**)", "Once, Fri 21 Nov 09:00". */
export function describeWhen(w: When): string {
  switch (w.kind) {
    case 'schedule': {
      const s = w.schedule;
      if (s.type === 'once') return `Once, ${when12(s.at)}`;
      if (s.type === 'daily') return `${dayList(s.days).replace(/^./, (c) => c.toUpperCase())} at ${s.time}`;
      if (s.type === 'every') return `Every ${s.minutes % 60 === 0 ? `${s.minutes / 60} h` : `${s.minutes} min`}${s.from && s.to ? ` between ${s.from} and ${s.to}` : ''}`;
      return `On cron "${s.expr}"`;
    }
    case 'event':
      return `${EVENT_TEXT[w.event]}${w.filter ? ` (${w.filter})` : ''}`;
    case 'webhook':
      return `When its webhook is called${w.filter ? ` (with "${w.filter}")` : ''}`;
    case 'wait':
      return `${WAIT_TEXT[w.wait]} ${w.target}${w.text ? ` "${w.text}"` : ''}`;
    case 'checkback':
      return `Come back ${when12(w.at)}`;
  }
}

/** A glob ("src/**\/*.ts", "*.md", "docs/**") as a test on a path (matched against its end). */
export function globTest(glob: string | null): (p: string) => boolean {
  if (!glob) return () => true;
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*$/, '\u0001')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  const rx = new RegExp(`(^|/)${re}$`);
  return (p) => rx.test(p.replace(/\\/g, '/'));
}
