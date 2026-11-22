// crew_later and crew_automation (docs/crew/PLAN.md §9, §13): a bot sets up check-backs, waits and automations in the
// same turn (no confirming), with lenient input and errors that say what would work. A bot makes automations for
// itself; the Chief may make them for anyone. Results go to the room it was made in, else to its DM as a notice.
import type { CrewStore } from '../store/store';
import type { ThreadRecord } from '../types';
import type { Automations } from './runner';
import type { Automation, PostTo } from './store';
import { describeWhen, parseWhen, readMoment, WAIT_KINDS, type WaitKind, type When } from './when';

const str = (v: unknown) => (v == null ? '' : String(v)).trim();

/** Where a result goes by default: the room the caller talks in, else its DM. */
function defaultPost(store: CrewStore, caller: ThreadRecord, raw: unknown, room: unknown): PostTo {
  const want = str(raw).toLowerCase();
  if (want === 'none' || want === 'nowhere') return { kind: 'none' };
  if (want === 'dm') return { kind: 'dm' };
  const named = str(room).replace(/^#/, '').toLowerCase();
  if (named) {
    const r = store.rooms().find((x) => x.id === named || x.name.toLowerCase() === named);
    if (!r) throw new Error(`No room "${str(room)}". Rooms: ${store.rooms().map((x) => `#${x.name}`).join(', ') || 'none'}.`);
    return { kind: 'room', roomId: r.id };
  }
  if (caller.kind === 'room' && caller.roomId) return { kind: 'room', roomId: caller.roomId };
  return { kind: 'dm' };
}

function line(auto: Automations, a: Automation): string {
  return `- ${a.id}: ${auto.sentence(a)}${a.paused ? ' (paused)' : ''}${a.nextRunAt ? ` · next ${new Date(a.nextRunAt).toLocaleString()}` : ''}`;
}

/** crew_later: check_back / wait / list / cancel. */
export function crewLater(auto: Automations, store: CrewStore, caller: ThreadRecord, a: Record<string, unknown>): string {
  const botId = caller.botId!;
  const action = str(a.action) || 'check_back';
  if (action === 'list') {
    const mine = auto.of(botId).filter((x) => x.when.kind === 'checkback' || x.when.kind === 'wait');
    return mine.length ? mine.map((x) => line(auto, x)).join('\n') : 'Nothing pending.';
  }
  if (action === 'cancel') {
    const x = auto.of(botId).find((y) => y.id === str(a.id) || y.id.endsWith(str(a.id)));
    if (!x) throw new Error('No such check-back or wait of yours.');
    auto.remove(x.id, botId);
    return `Cancelled ${x.id}.`;
  }
  if (action === 'check_back') {
    const at = readMoment(str(a.when));
    if (!at) throw new Error('Say when: "in 2h", "in 30 min", "tomorrow 9:00", "friday 14:00" or "2026-12-01 10:00".');
    if (at - Date.now() > 90 * 86_400_000) throw new Error('At most 90 days ahead.');
    if (auto.of(botId).filter((x) => x.when.kind === 'checkback').length >= 50) throw new Error('You have 50 check-backs already: cancel some.');
    const note = str(a.note) || 'come back to this';
    const x = auto.create(botId, { name: `Check back: ${note.slice(0, 40)}`, botId, when: { kind: 'checkback', at }, instructions: note, postTo: { kind: 'none' }, threadId: caller.id });
    return `I will bring you back here ${describeWhen(x.when).replace(/^Come back /, '')} (${x.id}). No AI runs until then.`;
  }
  if (action === 'wait') {
    const kind = str(a.kind).replace(/-/g, '_') as WaitKind;
    if (!WAIT_KINDS.includes(kind)) throw new Error(`kind must be one of: ${WAIT_KINDS.join(', ')}.`);
    const target = str(a.target);
    if (!target) throw new Error('Say what to watch in "target" (a URL, a file path, a process name or a bot name).');
    if ((kind === 'url_contains' || kind === 'url_missing') && !str(a.text)) throw new Error('Say which text to look for in "text".');
    const hours = Math.min(168, Math.max(1, Number(a.hours ?? 24) || 24));
    const follow = str(a.follow_up) || str(a.note);
    if (!follow) throw new Error('Say what to do when it happens in "follow_up" (self-contained: the run does not see this chat).');
    const when: When = { kind: 'wait', wait: kind, target, text: str(a.text) || null, expiresAt: Date.now() + hours * 3600_000 };
    const x = auto.create(botId, { name: `Wait: ${target.slice(0, 40)}`, botId, when, instructions: follow, postTo: defaultPost(store, caller, a.post_to, a.room) });
    return `Waiting (${x.id}): ${auto.sentence(x)}. Checked every 30 s without AI, for at most ${hours} h.`;
  }
  throw new Error('action must be check_back, wait, list or cancel.');
}

/** crew_automation: info / create / update / pause / resume / run_now / delete. */
export function crewAutomation(auto: Automations, store: CrewStore, caller: ThreadRecord, a: Record<string, unknown>, isChief: boolean): string {
  const me = caller.botId!;
  const action = str(a.action) || 'create';
  const mine = (id: string) => {
    const x = auto.store.all().find((y) => y.id === id || (id.length >= 4 && y.id.endsWith(id)));
    if (!x) throw new Error(`No automation ${id}.`);
    if (x.botId !== me && !isChief) throw new Error('That automation belongs to another bot (the Chief can change it).');
    return x;
  };
  switch (action) {
    case 'info': {
      const list = isChief ? auto.store.all().filter((x) => !x.done) : auto.of(me);
      return [
        `Now: ${new Date().toString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`,
        'when: a sentence like "every weekday at 9:00", "every 30 min between 9:00 and 17:00", "cron 0 9 * * 1-5", "once at 2026-12-01 10:00", "when tests fail", "on save of src/**/*.ts", "when files change in docs/**", "on commit", "when a terminal command fails", "when problems increase", "webhook".',
        'Instructions must be self-contained: a run does not see this chat. Results post in this room (or your DM as a notice); "NOTHING NEW" posts nothing.',
        list.length ? `Automations:\n${list.map((x) => line(auto, x)).join('\n')}` : 'No automations yet.',
      ].join('\n');
    }
    case 'create': {
      const parsed = parseWhen(a.when ?? a.schedule ?? a.event);
      if (!parsed.when) throw new Error(parsed.error ?? 'Say when.');
      const instructions = str(a.instructions);
      if (instructions.length < 10) throw new Error('Write the instructions: everything the run needs (it does not see this chat).');
      let botId = me;
      if (a.bot) {
        const b = store.bots().find((x) => x.name.toLowerCase() === str(a.bot).replace(/^@/, '').toLowerCase());
        if (!b) throw new Error(`No bot "${str(a.bot)}".`);
        if (b.id !== me && !isChief) throw new Error('You can only make automations for yourself (the Chief can make them for others).');
        botId = b.id;
      }
      const x = auto.create(me, { name: str(a.name) || instructions.split('\n')[0].slice(0, 60), botId, when: parsed.when, instructions, postTo: defaultPost(store, caller, a.post_to, a.room) });
      return [`Made (${x.id}): ${auto.sentence(x)}.`, x.when.kind === 'webhook' ? `Webhook: POST ${auto.webhookUrl(x)} with "Authorization: Bearer ${x.token}".` : '', 'Tell the user the sentence in one line; they can pause or undo it on the Automations page.'].filter(Boolean).join('\n');
    }
    case 'update': {
      const x = mine(str(a.id));
      const fields: Partial<Automation> = {};
      if (a.when !== undefined) {
        const parsed = parseWhen(a.when);
        if (!parsed.when) throw new Error(parsed.error ?? 'Say when.');
        fields.when = parsed.when;
      }
      if (a.instructions !== undefined) fields.instructions = str(a.instructions);
      if (a.name !== undefined) fields.name = str(a.name);
      if (a.post_to !== undefined || a.room !== undefined) fields.postTo = defaultPost(store, caller, a.post_to, a.room);
      const y = auto.update(x.id, me, fields);
      return `Updated: ${auto.sentence(y)}.`;
    }
    case 'pause':
    case 'resume': {
      const x = mine(str(a.id));
      auto.setPaused(x.id, action === 'pause', me);
      return `${action === 'pause' ? 'Paused' : 'Resumed'}: ${auto.sentence(x)}.`;
    }
    case 'run_now': {
      const x = mine(str(a.id));
      auto.runNow(x.id);
      return `Running "${x.name}" now (its result posts as usual).`;
    }
    case 'delete': {
      const x = mine(str(a.id));
      auto.remove(x.id, me);
      return `Deleted "${x.name}" (the user can undo it).`;
    }
    default:
      throw new Error('action must be info, create, update, pause, resume, run_now or delete.');
  }
}
