// Custom providers page (port of the app's ClaudeProvidersPage.kt): Anthropic-compatible APIs whose models show up in
// the model picker next to Claude's own ("@provider/model"). Presets, the full editor (connection, models with their
// limits and thinking, thinking budget, defaults, timeout, retries, betas, headers, environment), connection test,
// model-list fetch (with the picker of fetched models, field mapping & pagination, and the raw answer when it fails),
// restart of a provider's idle chats, and moving a settings.json endpoint into a provider.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SettingFormField, SettingItem, SettingListRow, SettingsPage, SettingsSection } from '../../../shared/protocol';
import type { ClaudeBackend } from './ClaudeBackend';
import { contextLabel, limitsOf, num, str, tokenLabel, type Provider, type ProviderModel } from './protocol';

const AGENT = 'CLAUDE' as const;
const SLOW = 90_000;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

const PRESETS: { id: string; label: string; note: string; provider: Partial<Provider> }[] = [
  { id: 'openrouter', label: 'OpenRouter', note: 'Model list is fetched automatically (free tool-capable models by default).', provider: { name: 'OpenRouter', base_url: OPENROUTER_BASE_URL } },
  {
    id: 'kimi',
    label: 'Kimi',
    note: "Moonshot AI's Anthropic-compatible endpoint.",
    provider: { name: 'Kimi', base_url: 'https://api.moonshot.ai/anthropic', models_url: 'https://api.moonshot.ai/v1/models', models: [{ id: 'kimi-k2-0905-preview', name: 'Kimi K2', context_length: 262_144 }] },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    note: "DeepSeek's Anthropic-compatible endpoint.",
    provider: {
      name: 'DeepSeek',
      base_url: 'https://api.deepseek.com/anthropic',
      models_url: 'https://api.deepseek.com/models',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', context_length: 128_000 },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', context_length: 128_000 },
      ],
    },
  },
  {
    id: 'zai',
    label: 'Z.ai',
    note: 'Z.ai (GLM) Anthropic-compatible endpoint.',
    provider: { name: 'Z.ai', base_url: 'https://api.z.ai/api/anthropic', models_url: 'https://api.z.ai/api/paas/v4/models', models: [{ id: 'glm-4.6', name: 'GLM 4.6', context_length: 200_000 }] },
  },
  { id: 'custom', label: 'Custom', note: 'Any endpoint that speaks the Anthropic Messages API.', provider: {} },
];

/** "128k" / "1.5m" / "200000" → tokens; blank → 0; null when it is not a number (parseTokens). */
function parseTokens(text: string | undefined): number | null {
  const t = (text ?? '').trim().toLowerCase().replace(/[,_]/g, '');
  if (!t) return 0;
  const mult = t.endsWith('m') ? 1_000_000 : t.endsWith('k') ? 1000 : 1;
  const n = Number(t.replace(/[km]+$/, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n * mult);
}

function parsePairs(text: string | undefined, sep: string, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf(sep);
    if (i <= 0) throw new Error(`${what}: "${line}" must look like NAME${sep === ':' ? ': value' : '=value'}`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const pairsText = (h: Record<string, string> | undefined, sep: string) =>
  Object.entries(h ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');

/** One model per line: `id | name | context | max output | thinking` (thinking: blank = inherit, off, or a budget). */
function modelsText(models: ProviderModel[]): string {
  return models
    .map((m) => {
      const thinking = m.thinking_mode === 'off' ? 'off' : m.thinking_mode === 'budget' ? String(num(m.thinking_budget)) : '';
      const cols = [m.id, m.name ?? '', num(m.context_length) ? String(m.context_length) : '', num(m.max_output_tokens) ? String(m.max_output_tokens) : '', thinking];
      while (cols.length > 1 && !cols[cols.length - 1]) cols.pop();
      return cols.join(' | ');
    })
    .join('\n');
}

function parseModels(text: string | undefined, old: ProviderModel[]): ProviderModel[] {
  const out: ProviderModel[] = [];
  for (const line of (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [id, name, ctx, maxOut, thinking] = line.split('|').map((c) => c.trim());
    if (!id) continue;
    const context = parseTokens(ctx);
    const output = parseTokens(maxOut);
    if (context == null) throw new Error(`Model ${id}: the context window must be a number like 128k`);
    if (output == null) throw new Error(`Model ${id}: the max output must be a number like 8k`);
    const prev = old.find((m) => m.id === id);
    let thinking_mode = '';
    let thinking_budget = 0;
    if (thinking && /^off$/i.test(thinking)) thinking_mode = 'off';
    else if (thinking) {
      const b = parseTokens(thinking);
      if (b == null || b < 1024) throw new Error(`Model ${id}: the thinking budget must be at least 1024`);
      thinking_mode = 'budget';
      thinking_budget = b;
    }
    out.push({ ...(prev ?? {}), id, name: name || null, context_length: context, max_output_tokens: output, thinking_mode, thinking_budget, can_think: prev?.can_think ?? false });
  }
  return out;
}

export class ClaudeProviders {
  /** The last model-list fetch: its models (for the picker) or its error, and the raw exchange. */
  private fetched: { providerId: string; models: ProviderModel[]; raw: any; error: string | null } | null = null;
  private busy = new Map<string, string>();

  constructor(
    private b: ClaudeBackend,
    private changed: () => void,
  ) {}

  private section(id: string, items: SettingItem[], description: string | null = null): SettingsSection {
    return { id, title: '', agent: AGENT, description, items };
  }

  /** The editor (ProviderEditor) as a form; [p] = the saved provider or a preset. */
  private form(p: Partial<Provider> | undefined, isNew: boolean): SettingFormField[] {
    const openRouter = (p?.base_url ?? '').includes('openrouter.ai');
    const retries = num(p?.max_retries);
    return [
      { id: 'name', label: 'Name', kind: 'text', value: p?.name ?? '', required: true },
      { id: 'base_url', label: 'Base URL (Claude Code calls <base URL>/v1/messages)', kind: 'text', value: p?.base_url ?? '', placeholder: 'https://api.example.com/anthropic', required: true },
      { id: 'api_key', label: isNew ? 'API key' : `API key (blank keeps the saved key${p?.api_key_hint ? ` ${p.api_key_hint}` : ''})`, kind: 'password', value: '', required: isNew },
      {
        id: 'auth_mode',
        label: 'How the key is sent',
        kind: 'select',
        value: p?.auth_mode || 'bearer',
        options: [
          { value: 'bearer', label: 'Authorization: Bearer', description: 'ANTHROPIC_AUTH_TOKEN' },
          { value: 'x-api-key', label: 'x-api-key', description: 'ANTHROPIC_API_KEY' },
        ],
      },
      ...(openRouter ? [] : [{ id: 'models_url', label: 'Models URL (optional, to fetch the list)', kind: 'text' as const, value: p?.models_url ?? '', placeholder: 'https://api.example.com/v1/models' }]),
      {
        id: 'models',
        label: 'Models, one per line: id | name | context | max output | thinking (blank = inherit, off, or a budget ≥ 1024)',
        kind: 'multiline',
        value: modelsText(p?.models ?? []),
        placeholder: 'kimi-k2-0905-preview | Kimi K2 | 256k | 8k',
      },
      { id: 'small_model', label: 'Model for background calls (titles, summaries; blank = the chat’s model)', kind: 'text', value: p?.small_model ?? '' },
      {
        id: 'thinking_budget',
        label: 'Thinking budget sent when Thinking is on (blank = never send one; at least 1024)',
        kind: 'text',
        value: num(p?.thinking_budget) > 0 ? String(p!.thinking_budget) : '',
        placeholder: '16000',
      },
      { id: 'default_context', label: 'Default context window for models without their own', kind: 'text', value: num(p?.default_context) > 0 ? String(p!.default_context) : '', placeholder: 'e.g. 128k (blank = unknown)' },
      { id: 'default_max_output', label: 'Default max output', kind: 'text', value: num(p?.default_max_output) > 0 ? String(p!.default_max_output) : '', placeholder: 'e.g. 8k (blank = unknown)' },
      { id: 'timeout_sec', label: 'Request timeout, seconds (optional)', kind: 'text', value: num(p?.timeout_sec) > 0 ? String(p!.timeout_sec) : '', placeholder: 'default' },
      { id: 'max_retries', label: 'Retries when a request fails, 0–10 (0 = fail at once)', kind: 'text', value: retries > 0 ? String(retries) : retries < 0 ? '0' : '', placeholder: 'default: 3' },
      { id: 'disable_betas', label: 'Disable experimental betas (if the provider answers 400 about unknown fields or beta headers)', kind: 'toggle', value: p?.disable_betas ? 'true' : 'false' },
      { id: 'headers', label: 'Headers (Name: value, one per line)', kind: 'multiline', value: pairsText(p?.headers, ': '), placeholder: 'X-Title: AntiGem' },
      { id: 'extra_env', label: 'Environment (NAME=value, one per line; wins over everything above)', kind: 'multiline', value: pairsText(p?.extra_env, '='), placeholder: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192' },
    ];
  }

  /** The provider as the form gives it, or the first problem with it (ProviderEditor.build). */
  private build(v: Record<string, string>, base: Partial<Provider> | undefined): any {
    const name = (v.name ?? '').trim();
    const baseUrl = (v.base_url ?? '').trim();
    if (!name) throw new Error('Enter a name');
    if (!/^https?:\/\/\S+/.test(baseUrl)) throw new Error('Enter the base URL (https://…)');
    const budget = (v.thinking_budget ?? '').trim() ? parseTokens(v.thinking_budget) : 0;
    if (budget == null || (budget !== 0 && budget < 1024)) throw new Error('The thinking budget must be a number of at least 1024');
    const timeout = (v.timeout_sec ?? '').trim() ? Number(v.timeout_sec.trim()) : 0;
    if (!Number.isInteger(timeout) || timeout < 0) throw new Error('The timeout must be a number of seconds');
    const rawRetries = (v.max_retries ?? '').trim();
    const r = rawRetries ? Number(rawRetries) : 0;
    if (rawRetries && (!Number.isInteger(r) || r < 0 || r > 10)) throw new Error('Retries must be a number from 0 to 10');
    const defCtx = parseTokens(v.default_context);
    if (defCtx == null) throw new Error('The default context window must be a number like 128k');
    const defOut = parseTokens(v.default_max_output);
    if (defOut == null) throw new Error('The default max output must be a number like 8k');
    const openRouter = baseUrl.includes('openrouter.ai');
    const { api_key_hint: _h, openrouter: _o, ...rest } = (base ?? {}) as any;
    return {
      ...rest,
      id: base?.id ?? '',
      name,
      base_url: baseUrl,
      // blank keeps the saved key
      api_key: (v.api_key ?? '').trim() || undefined,
      auth_mode: v.auth_mode || 'bearer',
      models_url: openRouter ? '' : (v.models_url ?? '').trim(),
      small_model: (v.small_model ?? '').trim(),
      models: parseModels(v.models, base?.models ?? []),
      headers: parsePairs(v.headers, ':', 'Headers'),
      extra_env: parsePairs(v.extra_env, '=', 'Environment'),
      timeout_sec: timeout,
      thinking_budget: budget,
      disable_betas: v.disable_betas === 'true',
      default_context: defCtx,
      default_max_output: defOut,
      // 0 (blank) = the default, -1 = never retry
      max_retries: !rawRetries ? 0 : r === 0 ? -1 : r,
    };
  }

  private mappingForm(m: any): SettingFormField[] {
    const t = (id: string, label: string, placeholder?: string): SettingFormField => ({ id, label, kind: 'text', value: str(m?.[id]), placeholder: placeholder ?? 'detect' });
    return [
      t('list_path', 'Where the models are (dotted path of the list)', 'data'),
      t('id_field', 'Id field', 'id'),
      t('name_field', 'Name field', 'name'),
      t('context_field', 'Context window field', 'context_length'),
      t('max_output_field', 'Max output field', 'top_provider.max_completion_tokens'),
      t('strip_prefix', 'Remove from the start of every id', 'e.g. models/'),
      {
        id: 'pagination',
        label: 'Pagination',
        kind: 'select',
        value: str(m?.pagination),
        options: [
          { value: '', label: 'Detect' },
          { value: 'none', label: 'One page' },
          { value: 'cursor', label: 'Cursor (last id of the page)' },
          { value: 'token', label: 'Next-page token' },
          { value: 'next_url', label: 'Next-page URL' },
        ],
      },
      t('next_field', 'Field with the next cursor / token / URL'),
      t('more_field', 'Field saying more pages exist', 'has_more'),
      t('page_param', 'Query parameter to send it in'),
      { id: 'page_size', label: 'Page size (optional)', kind: 'text', value: num(m?.page_size) ? String(m.page_size) : '', placeholder: "provider's default" },
      t('limit_param', 'Parameter name for the page size', 'limit'),
    ];
  }

  // ------------------------------------------------------------------ page

  page(): SettingsPage {
    const b = this.b;
    const providers = b.providers;
    const sections: SettingsSection[] = [
      this.section(
        'about',
        [
          {
            kind: 'info',
            id: 'opencode',
            label: 'Third-party models work better in OpenCode',
            value: '',
            tone: 'muted',
            description:
              "Claude Code only speaks Anthropic's API, so a provider here must offer an Anthropic-compatible endpoint, and tools or thinking can break on the way. OpenCode talks to each provider in its own format. Keep using this page for Anthropic and Anthropic-compatible APIs.",
          },
        ],
        'OpenRouter, Kimi, DeepSeek, Z.ai… Their models are listed in the model picker under Claude’s own. A chat on one of them uses its key, headers and limits; your Claude login and other chats stay as they are.',
      ),
    ];
    if (b.settingsEndpoint) {
      sections.push(
        this.section('endpoint', [
          { kind: 'info', id: 'endpoint', label: `settings.json sends every chat to ${b.settingsEndpoint}`, value: '', tone: 'warn', description: 'Then even chats on Claude’s models go there. Move it into a provider so only the chats you choose use it.' },
          { kind: 'button', id: 'import', label: 'Move into a provider', confirm: 'Move the endpoint configured in settings.json into a provider?' },
        ]),
      );
    }
    if (b.settingsConflicts.length && providers.length) {
      sections.push(
        this.section('conflicts', [
          { kind: 'info', id: 'conflicts', label: 'settings.json sets', value: b.settingsConflicts.join(', '), tone: 'muted', description: 'Provider chats override these, so they cannot change a provider’s model or key.' },
        ]),
      );
    }
    // quick start: one button per preset (OpenRouter once)
    sections.push(
      this.section(
        'add',
        PRESETS.filter((p) => p.id !== 'openrouter' || !providers.some((x) => x.openrouter)).map((p) => ({
          kind: 'button' as const,
          id: `add:${p.id}`,
          label: p.id === 'custom' ? '+ Custom' : `+ ${p.label}`,
          description: p.note,
          form: this.form(p.provider, true),
        })),
        'Add a provider: pick a preset or add your own with its base URL and API key, test the connection, then add or fetch its models.',
      ),
    );
    const rows: SettingListRow[] = providers.map((p) => {
      const busy = this.busy.get(p.id);
      const badges = [
        p.api_key_hint ? `key ${p.api_key_hint}` : 'no key',
        p.auth_mode === 'x-api-key' ? 'x-api-key' : 'Bearer token',
        num(p.thinking_budget) > 0 ? `thinking ${tokenLabel(num(p.thinking_budget))}` : 'no thinking budget',
        Object.keys(p.headers ?? {}).length ? `${Object.keys(p.headers ?? {}).length} headers` : null,
        Object.keys(p.extra_env ?? {}).length ? `${Object.keys(p.extra_env ?? {}).length} env` : null,
        num(p.timeout_sec) > 0 ? `${p.timeout_sec}s timeout` : null,
        p.disable_betas ? 'no betas' : null,
      ].filter(Boolean);
      const models = p.models.length
        ? p.models
            .slice(0, 6)
            .map((m) => `${m.name?.trim() || m.id} (${[contextLabel(p, m) ?? 'context unknown', thinkingLabel(p, m)].filter(Boolean).join(', ')})`)
            .join('; ') + (p.models.length > 6 ? `; +${p.models.length - 6} more` : '')
        : 'No models yet: Edit to add model ids or fetch the provider’s list';
      return {
        id: p.id,
        title: `${p.name} · ${p.models.length} models`,
        subtitle: `${p.base_url} · ${badges.join(' · ')}\n${models}`,
        status: busy ?? null,
        statusTone: busy ? 'warn' : null,
        actions: busy
          ? []
          : [
              { id: 'edit', label: 'Edit', form: this.form(p, false) },
              { id: 'test', label: 'Test connection' },
              {
                id: 'fetch',
                label: 'Fetch the provider’s model list',
                form: p.openrouter || p.base_url.includes('openrouter.ai') ? [{ id: 'free_only', label: 'Only free models that can call tools', kind: 'toggle', value: 'true' }] : null,
              },
              { id: 'mapping', label: 'Field mapping & pagination (then fetch)', form: this.mappingForm(p.models_map) },
              { id: 'restart', label: 'Restart its idle chats', confirm: `Restart the idle chats of ${p.name}? Their next message uses the current settings (the conversation is kept).` },
              { id: 'remove', label: 'Remove', danger: true, confirm: `Remove ${p.name}? Its key, headers and models are removed. Chats on it have to pick another model.` },
            ],
      };
    });
    sections.push(
      this.section(
        'providers',
        [{ kind: 'list', id: 'providers', label: `Providers (${providers.length})`, rows, emptyText: 'No custom providers yet' }],
        'Changes apply the next time a chat’s process starts (switch its model, reopen the chat, or restart its idle chats).',
      ),
    );
    const f = this.fetched;
    const fp = f ? b.provider(f.providerId) : undefined;
    if (f && fp) {
      const items: SettingItem[] = [];
      const raw = f.raw;
      if (f.error || !f.models.length) {
        items.push({
          kind: 'info',
          id: 'fetchError',
          label: f.error ? 'Could not fetch the models' : 'No models to add',
          value: '',
          tone: f.error ? 'error' : 'warn',
          description:
            f.error ??
            (raw && num(raw.entries) > 0
              ? `The server listed ${raw.entries} entries but none could be used (no usable id). Open Field mapping and pick the id field.`
              : `The server answered${num(raw?.status) ? ` (HTTP ${raw.status})` : ''} but no models could be read. If the raw response does contain models, open Field mapping and point at them; otherwise it comes from the provider (empty account, permissions or headers).`),
        });
      }
      if (raw) {
        items.push({
          kind: 'info',
          id: 'raw',
          label: `GET ${str(raw.url)}`,
          value: `HTTP ${num(raw.status)} · ${num(raw.entries)} listed · ${num(raw.kept)} kept${num(raw.pages) > 1 ? ` · ${raw.pages} pages (${str(raw.pagination)})` : ''}`,
          tone: 'muted',
          description: str(raw.paging_error) ? `Stopped early: ${raw.paging_error}` : null,
        });
        if (str(raw.body)) items.push({ kind: 'text', id: 'rawBody', label: 'Raw response (first page)', value: str(raw.body).slice(0, 6000), multiline: true, disabled: true });
      }
      if (f.models.length) {
        const have = new Set(fp.models.map((m) => m.id));
        const fresh = f.models.filter((m) => !have.has(m.id));
        items.push({
          kind: 'list',
          id: 'fetched',
          label: `${fp.name}: ${f.models.length} models`,
          rows: f.models.slice(0, 300).map((m) => ({
            id: m.id,
            title: m.name?.trim() || m.id,
            subtitle: [m.name?.trim() ? m.id : null, contextLabel(fp, m) ?? 'context unknown', m.can_think ? 'can think' : null].filter(Boolean).join(' · '),
            status: have.has(m.id) ? 'Added' : null,
            statusTone: have.has(m.id) ? 'ok' : null,
            actions: have.has(m.id) ? [] : [{ id: 'add', label: 'Add' }],
          })),
        });
        if (fresh.length) items.push({ kind: 'button', id: 'addAll', label: `Add all ${fresh.length} new models`, style: 'primary' });
      }
      items.push({ kind: 'button', id: 'closeFetched', label: 'Close' });
      sections.push(this.section('fetched', items));
    }
    return { id: 'claude.providers', title: 'Custom providers', sections };
  }

  // ------------------------------------------------------------------ actions

  async action(id: string, rowId?: string, actionId?: string, values?: Record<string, string>): Promise<string | void> {
    const b = this.b;
    const check = (r: any, what: string) => {
      if (!r?.success) throw new Error(`${what}: ${r?.error ?? 'the bridge refused'}`);
      return r;
    };
    if (id === 'import') {
      check(await b.bridgeSend('POST', '/api/claude/providers/import-settings', {}), 'Could not move it');
      await Promise.all([b.loadProviders(), b.loadChatDefaults()]);
      this.changed();
      return 'Moved into a provider';
    }
    if (id.startsWith('add:') && values) {
      const preset = PRESETS.find((p) => `add:${p.id}` === id);
      const p = this.build(values, { ...(preset?.provider ?? {}), id: '' } as Partial<Provider>);
      if (!p.api_key) throw new Error('Enter the API key');
      const r = check(await b.bridgeSend('POST', '/api/claude/providers', p), 'Could not save');
      await b.loadProviders();
      this.changed();
      // OpenRouter lists its models by itself: fetch the free tool-capable ones right away (as the app's preset)
      const saved = r.provider?.id ? b.provider(r.provider.id) : undefined;
      if (saved && !saved.models.length && (saved.openrouter || saved.models_url)) await this.fetch(saved, saved.openrouter === true);
      return `Added ${p.name}`;
    }
    if (id === 'closeFetched') {
      this.fetched = null;
      this.changed();
      return;
    }
    if ((id === 'fetched' && actionId === 'add' && rowId) || id === 'addAll') {
      const f = this.fetched;
      const p = f ? b.provider(f.providerId) : undefined;
      if (!f || !p) return;
      const have = new Set(p.models.map((m) => m.id));
      const add = id === 'addAll' ? f.models.filter((m) => !have.has(m.id)) : f.models.filter((m) => m.id === rowId && !have.has(m.id));
      if (!add.length) return;
      await this.save(p, { models: [...p.models, ...add] }, 'Adding…');
      return `Added ${add.length} model${add.length === 1 ? '' : 's'} to ${p.name}`;
    }
    if (id !== 'providers' || !rowId) return;
    const p = b.provider(rowId);
    if (!p) return;
    switch (actionId) {
      case 'edit': {
        if (!values) return;
        await this.save(p, this.build(values, p), 'Saving…');
        return `Saved ${values.name || p.name}. Running chats keep the settings they started with until they restart (⋮ → Restart its idle chats).`;
      }
      case 'test': {
        const r = await this.work(p.id, 'Testing…', async () => check(await b.bridgeSend('POST', '/api/claude/providers/_test', { ...p, model: p.models[0]?.id ?? '' }, SLOW), 'Test failed'));
        const t = r.result ?? {};
        if (t.ok) {
          b.notify('info', `${p.name}: connected · ${num(t.latency_ms)} ms · ${str(t.model)} answered${str(t.reply) ? `: "${str(t.reply).slice(0, 60)}"` : ''}`);
          return;
        }
        throw new Error(`${p.name}: connection failed: ${str(t.error) || 'no answer'}${str(t.hint) ? ` (${t.hint})` : ''}${str(t.url) ? ` · ${t.url}` : ''}`);
      }
      case 'fetch':
        await this.fetch(p, values?.free_only === 'true');
        return this.fetched?.models.length ? `${this.fetched.models.length} models: add them below` : undefined;
      case 'mapping': {
        if (!values) return;
        const map: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(values)) if (v?.trim()) map[k] = k === 'page_size' ? Number(v) || 0 : v.trim();
        await this.save(p, { models_map: Object.keys(map).length ? map : null }, 'Saving…');
        const saved = b.provider(p.id) ?? p;
        await this.fetch(saved, saved.openrouter === true);
        return;
      }
      case 'restart': {
        const r = await this.work(p.id, 'Restarting…', async () => check(await b.bridgeSend('POST', `/api/claude/providers/${encodeURIComponent(p.id)}/restart-sessions`, {}), 'Could not restart'));
        const restarted = num(r.restarted);
        const busy = num(r.busy);
        return `${restarted === 0 ? 'No running chat needed a restart' : `Restarted ${restarted} chat${restarted === 1 ? '' : 's'}`}${busy > 0 ? `; ${busy} still replying: restart ${busy === 1 ? 'it' : 'them'} when done` : ''}`;
      }
      case 'remove':
        await this.work(p.id, 'Removing…', async () => check(await b.bridgeSend('DELETE', `/api/claude/providers/${encodeURIComponent(p.id)}`), 'Cannot remove the provider'));
        if (this.fetched?.providerId === p.id) this.fetched = null;
        return `Removed ${p.name}`;
    }
  }

  /** Fetches the provider's model list (form values with the saved key) and keeps the answer for the picker. */
  private async fetch(p: Provider, freeOnly: boolean) {
    const { api_key_hint: _h, openrouter: _o, ...body } = p as any;
    const r = await this.work(p.id, 'Fetching models…', () => this.b.bridgeSend('POST', '/api/claude/providers/_fetch', { ...body, free_only: freeOnly }, SLOW));
    this.fetched = { providerId: p.id, models: Array.isArray(r?.models) ? r.models : [], raw: r?.raw ?? null, error: r?.success ? null : (r?.error ?? 'the provider did not answer') };
    if (r?.raw?.paging_error) this.b.notify('warning', `Only part of the list was read (${r.raw.paging_error})`);
    this.changed();
  }

  private async save(p: Provider, patch: Record<string, unknown>, label: string) {
    const { api_key_hint: _h, openrouter: _o, ...body } = { ...p, ...patch } as any;
    await this.work(p.id, label, async () => {
      const r = await this.b.bridgeSend('PUT', `/api/claude/providers/${encodeURIComponent(p.id)}`, body);
      if (!r?.success) throw new Error(`Could not save: ${r?.error ?? 'the bridge refused'}`);
      return r;
    });
  }

  private async work<T>(id: string, label: string, fn: () => Promise<T>): Promise<T> {
    this.busy.set(id, label);
    this.changed();
    try {
      return await fn();
    } finally {
      this.busy.delete(id);
      await this.b.loadProviders();
      this.changed();
    }
  }
}

/** "thinking 16K", "no thinking", or null when the model inherits a provider that sends no budget (thinkingLabel). */
function thinkingLabel(p: Provider, m: ProviderModel): string | null {
  const budget = limitsOf(p, m.id).thinkingBudget;
  if (budget > 0) return `thinking ${tokenLabel(budget)}`;
  return m.thinking_mode === 'off' ? 'no thinking' : null;
}
