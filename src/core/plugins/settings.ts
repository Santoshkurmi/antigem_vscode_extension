// Settings → Custom AntiGem Plugins (port of the app's WebViewExtensionsScreen + PluginRepositoriesTab + PluginUi):
// Installed (enable, Update / Update ZIP / Reload / Export / Remove), Install ZIP, Repositories, Store (Install /
// Update), Guide & SDK. Pages: 'plugins', 'plugins.installed', 'plugins.repos', 'plugins.store', 'plugins.guide'.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SettingItem, SettingListRow, SettingsPage, SettingsSection, SlashCommandView } from '../../../shared/protocol';
import { REPO_INDEX, repoLabel } from './repos';
import { needsWorker, PluginService } from './service';
import { compareVersions, versionLabel, type Plugin, type PluginHooks, type PluginHostApi, type PluginRepo, type RepoPlugin } from './types';
import { zipFolder } from './zip';

const GUIDE = 'plugin-repository.md';

/** A safe folder name from a file / folder name (the app's picker default). */
const folderFrom = (name: string, fallback: string) =>
  name
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.\-_]+/, '')
    .slice(0, 64) || fallback;

export function pluginHooks(service: PluginService): PluginHooks {
  const platform = service.platform;
  const taken = (name: string) => service.plugins().some((p) => p.folderName.toLowerCase() === name.trim().toLowerCase());
  const freeFolder = (base: string) => {
    for (let i = 2; ; i++) {
      const n = `${base.slice(0, 60)}-${i}`;
      if (!taken(n)) return n;
    }
  };

  /** Saves bytes with the platform's "Save a copy" dialog (a temp file named as suggested). */
  const saveBytes = async (name: string, data: Buffer) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigem-plugin-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    try {
      await platform.saveCopy(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const progressItem = (): SettingItem[] => {
    const pr = service.progress;
    if (!pr) return [];
    const files = pr.filesTotal > 0 ? `${pr.filesDone}/${pr.filesTotal} files` : null;
    const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
    const label =
      pr.phase === 'listing'
        ? 'Reading the repository…'
        : pr.phase === 'downloading'
          ? ['Downloading', files, pr.bytesTotal > 0 ? `${mb(pr.bytesDone)} / ${mb(pr.bytesTotal)}` : mb(pr.bytesDone)].filter(Boolean).join(' · ')
          : pr.phase === 'extracting'
            ? ['Extracting', files].filter(Boolean).join(' · ')
            : pr.phase === 'installing'
              ? 'Installing…'
              : 'Starting plugin…';
    const pct = pr.bytesTotal > 0 && (pr.phase === 'downloading' || pr.phase === 'extracting') ? ` · ${Math.round((pr.bytesDone / pr.bytesTotal) * 100)}%` : '';
    return [{ kind: 'info', id: 'plugins.progress', label: `Installing ${pr.folder}`, value: label + pct, tone: 'muted' }];
  };

  const counts = (p: Plugin) => [`${p.toolCount} MCP tools`, p.skillCount > 0 ? `${p.skillCount} skills` : ''].filter(Boolean).join(' · ');

  // ---------------------------------------------------------------- pages

  const installedRows = (): SettingListRow[] =>
    service.plugins().map((p) => {
      const update = service.repos.updateFor(p);
      const err = service.loadErrors.get(p.id);
      const subtitle = [
        `${p.name} · ${versionLabel(p.version)} · ${counts(p)}`,
        p.source ? `From ${p.source.repo}${p.source.ref ? `@${p.source.ref}` : ''}` : '',
        update ? `Update available: ${versionLabel(p.version)} → ${versionLabel(update.offered.version)}` : '',
        err ? `Worker failed: ${err.split('\n')[0].slice(0, 160)}` : '',
        p.description,
      ]
        .filter(Boolean)
        .join(' · ');
      const removeText =
        p.location === 'bundled'
          ? 'This came with AntiGem: it is removed now and may come back with an update. To keep it off, disable it instead.'
          : p.location === 'user_folder'
            ? `This deletes the folder ${p.dirPath} from your files. Make sure you have another copy if it is your source.`
            : `Deletes the plugin from ${p.dirPath}.`;
      return {
        id: p.id,
        title: p.folderName,
        subtitle,
        status: err ? 'Error' : update ? 'Update' : !p.isEnabled ? 'Off' : null,
        statusTone: err ? 'error' : update ? 'warn' : 'muted',
        toggle: p.isEnabled,
        actions: [
          ...(update ? [{ id: 'update', label: `Update to ${versionLabel(update.offered.version)}` }] : []),
          { id: 'updateZip', label: 'Update ZIP' },
          ...(p.isEnabled ? [{ id: 'reload', label: 'Reload' }] : []),
          { id: 'export', label: 'Export ZIP' },
          {
            id: 'remove',
            label: 'Remove',
            danger: true,
            confirm: `Remove ${p.folderName}? ${removeText} If you added it in an agent's MCP settings, remove that server there too.`,
            form: [
              {
                id: 'data',
                label: 'Stored data',
                kind: 'select',
                value: 'keep',
                options: [
                  { value: 'keep', label: 'Keep its stored data (for a reinstall)' },
                  { value: 'delete', label: 'Also delete its stored data' },
                ],
              },
            ],
          },
        ],
      } satisfies SettingListRow;
    });

  const browserInfo = (): SettingItem => {
    const b = service.browserProvider();
    return b.available()
      ? { kind: 'info', id: 'plugins.browser', label: 'Browser', value: 'AntiGem Chrome extension connected', tone: 'ok' }
      : {
          kind: 'info',
          id: 'plugins.browser',
          label: 'Browser',
          value: 'Not connected',
          tone: 'muted',
          description: 'Plugins that open or script web pages need the AntiGem Chrome extension. Skills and storage work without it.',
        };
  };

  const runtimeInfo = (): SettingItem => {
    const need = service.plugins().filter((p) => p.isEnabled && needsWorker(p));
    const err = service.hostError();
    if (err) return { kind: 'info', id: 'plugins.runtime', label: 'Plugin runtime', value: 'Not running', tone: 'error', description: err };
    if (!need.length) return { kind: 'info', id: 'plugins.runtime', label: 'Plugin runtime', value: 'Not needed (no plugin workers)', tone: 'muted' };
    return {
      kind: 'info',
      id: 'plugins.runtime',
      label: 'Plugin runtime',
      value: service.runtime.running() ? `Running · ${need.length} worker${need.length === 1 ? '' : 's'}` : service.isLeader ? 'Starting…' : 'Runs in another AntiGem window',
      tone: service.runtime.running() ? 'ok' : 'muted',
    };
  };

  const hubPage = (): SettingsPage => {
    const list = service.plugins();
    const updates = service.updatesAvailable().length;
    const offered = [...service.repos.listings.values()].reduce((n, l) => n + l.plugins.length, 0);
    return {
      id: 'plugins',
      title: 'Custom AntiGem Plugins',
      loading: !service.loaded() && !service.error(),
      error: !service.loaded() && service.error() ? service.error() : null,
      sections: [
        {
          id: 'install',
          title: '',
          description:
            'Install custom AntiGem plugins from ZIP files or from a repository. A plugin can have MCP tools, skills (skills/*.md), or both. Changes apply right away.',
          items: [
            ...progressItem(),
            { kind: 'button', id: 'plugins.installZip', label: 'Install ZIP', style: 'primary', description: 'Choose a ZIP with manifest.json plus a background worker, a skills/ folder, or both' },
            { kind: 'button', id: 'plugins.refresh', label: 'Refresh', description: 'Read the plugin folders again and restart workers that changed' },
          ],
        },
        {
          id: 'pages',
          title: '',
          items: [
            { kind: 'page', id: 'plugins.installed', label: 'Installed', icon: 'extension', description: `${list.filter((p) => p.isEnabled).length} enabled`, badge: String(list.length) },
            { kind: 'page', id: 'plugins.repos', label: 'Repositories', icon: 'folder', description: 'GitHub repositories of plugins', badge: String(service.repos.repos().length) },
            {
              kind: 'page',
              id: 'plugins.store',
              label: 'Store',
              icon: 'download',
              description: updates ? `${updates} update${updates === 1 ? '' : 's'} available` : 'Plugins from your repositories',
              badge: updates ? String(updates) : offered ? String(offered) : null,
            },
            { kind: 'page', id: 'plugins.guide', label: 'Guide & SDK', icon: 'description', description: 'Host a repository, build plugins on this PC' },
          ],
        },
        {
          id: 'status',
          title: '',
          items: [runtimeInfo(), browserInfo()],
        },
        {
          id: 'help',
          title: '',
          description:
            "Add an enabled plugin to your agent in its MCP page → Quick add → Custom Plugin MCP; its skills come with it as get_skills / get_skill tools. In chat, type /plu: to point the agent at a plugin or one of its skills. To build a plugin with your agent, add Plugin Developer there too.",
          items: [],
        },
      ],
    };
  };

  const installedPage = (): SettingsPage => ({
    id: 'plugins.installed',
    title: 'Installed plugins',
    loading: !service.loaded() && !service.error(),
    error: !service.loaded() && service.error() ? service.error() : null,
    sections: [
      {
        id: 'installed',
        title: '',
        description: 'Updating or reloading restarts that plugin’s worker; its MCP connection and stored data are kept.',
        items: [
          ...progressItem(),
          {
            kind: 'list',
            id: 'installed',
            label: 'Plugins',
            emptyText: 'No plugins installed. Choose a ZIP containing manifest.json plus a background worker, a skills/ folder, or both — or install one from the Store.',
            rows: installedRows(),
          },
          { kind: 'button', id: 'plugins.installZip', label: 'Install ZIP', style: 'primary' },
        ],
      },
    ],
  });

  const reposPage = (): SettingsPage => ({
    id: 'plugins.repos',
    title: 'Plugin repositories',
    sections: [
      {
        id: 'repos',
        title: '',
        description: 'Public GitHub repositories with one folder per plugin. Only add repositories you trust: plugins run code on your PC.',
        items: [
          {
            kind: 'list',
            id: 'repos',
            label: 'Repositories',
            emptyText: 'No repositories added.',
            rows: service.repos.repos().map((r) => {
              const label = repoLabel(r);
              const listing = service.repos.listings.get(label);
              const err = service.repos.errors.get(label);
              const loading = service.repos.loading.has(label);
              const ups = service.updatesAvailable().filter((u) => u.repo === label).length;
              return {
                id: label,
                title: listing?.title || label,
                subtitle: [listing?.title && listing.title !== label ? label : '', listing ? `${listing.plugins.length} plugin${listing.plugins.length === 1 ? '' : 's'}` : '', err ?? '']
                  .filter(Boolean)
                  .join(' · ') || null,
                status: loading ? 'Checking…' : err ? 'Error' : ups ? `${ups} update${ups === 1 ? '' : 's'}` : null,
                statusTone: loading ? 'muted' : err ? 'error' : 'warn',
                actions: [
                  { id: 'refresh', label: 'Check for updates' },
                  { id: 'remove', label: 'Remove', danger: true, confirm: `Remove ${label}? Installed plugins stay installed.` },
                ],
              } satisfies SettingListRow;
            }),
            addLabel: 'Add repository',
            addForm: [{ id: 'repo', label: 'GitHub repository', kind: 'text', placeholder: 'owner/repo, owner/repo@branch or URL', required: true }],
          },
          { kind: 'button', id: 'repos.refreshAll', label: 'Check all for updates' },
          { kind: 'page', id: 'plugins.store', label: 'Store', icon: 'download', description: 'Install plugins from these repositories' },
        ],
      },
    ],
  });

  const storeRow = (repo: PluginRepo, plugin: RepoPlugin): SettingListRow => {
    const installed = service.repos.installedFor(service.plugins(), repo, plugin);
    const c = installed ? compareVersions(plugin.version, installed.version) : null;
    const state = !installed
      ? ''
      : c == null
        ? `Installed ${versionLabel(installed.version)} as ${installed.folderName}`
        : c > 0
          ? `Update available: ${versionLabel(installed.version)} → ${versionLabel(plugin.version)}`
          : c === 0
            ? 'Installed · up to date'
            : `Installed ${versionLabel(installed.version)} is newer than this repository's`;
    const action = !installed ? 'Install' : c != null && c > 0 ? 'Update' : 'Reinstall';
    return {
      id: `${repoLabel(repo)}|${plugin.path}`,
      title: `${plugin.name} · ${versionLabel(plugin.version)}`,
      subtitle: [plugin.description, state].filter(Boolean).join(' · ') || null,
      status: !installed ? null : c != null && c > 0 ? 'Update' : 'Installed',
      statusTone: c != null && c > 0 ? 'warn' : 'ok',
      actions: [{ id: 'install', label: action, ...(action === 'Reinstall' ? { confirm: `Reinstall ${plugin.name} from ${repoLabel(repo)}?` } : {}) }],
    };
  };

  const storePage = (): SettingsPage => {
    const repos = service.repos.repos();
    const sections: SettingsSection[] = [];
    if (service.progress) sections.push({ id: 'progress', title: '', items: progressItem() });
    if (!repos.length) {
      sections.push({ id: 'none', title: '', items: [{ kind: 'page', id: 'plugins.repos', label: 'Add a repository', icon: 'add', description: 'The Store lists the plugins of your repositories' }] });
    }
    for (const r of repos) {
      const label = repoLabel(r);
      const listing = service.repos.listings.get(label);
      const err = service.repos.errors.get(label);
      sections.push({
        id: `repo:${label}`,
        title: listing?.title || label,
        description: [listing?.title && listing.title !== label ? label : '', err ?? '', service.repos.loading.has(label) ? 'Checking…' : ''].filter(Boolean).join(' · ') || null,
        items: [
          {
            kind: 'list',
            id: `store:${label}`,
            label: 'Plugins',
            emptyText: listing ? 'This repository lists no plugins.' : err ? 'Could not read this repository.' : 'Loading…',
            rows: (listing?.plugins ?? []).map((p) => storeRow(r, p)),
          },
        ],
      });
    }
    return { id: 'plugins.store', title: 'Plugin store', loading: [...service.repos.loading].length > 0, sections };
  };

  const guidePage = (): SettingsPage => ({
    id: 'plugins.guide',
    title: 'Guide & SDK',
    sections: [
      {
        id: 'repo',
        title: 'Host your own repository',
        description: `How to lay out a GitHub repository of plugins and its ${REPO_INDEX}.`,
        items: [
          { kind: 'button', id: 'guide.view', label: 'View guide' },
          { kind: 'button', id: 'guide.save', label: 'Save guide…' },
        ],
      },
      {
        id: 'sdk',
        title: 'Plugin SDK',
        description: 'All plugin docs and examples as a ZIP, for building plugins in any folder; start with pc-development.md.',
        items: [
          { kind: 'button', id: 'sdk.save', label: 'Save SDK ZIP…' },
          { kind: 'button', id: 'sdk.readme', label: 'View SDK README' },
        ],
      },
      {
        id: 'dev',
        title: 'Build with your agent',
        description:
          'Add Plugin Developer from an agent’s MCP page (Quick add). It serves this SDK, edits drafts in ~/extension-projects, installs and updates plugins, tests their tools and reads worker logs — the plugins run here on this PC.',
        items: [],
      },
    ],
  });

  // ---------------------------------------------------------------- actions

  /** Install ZIP / Update ZIP: pick a file, look at its manifest, then install, update or install a separate copy. */
  const installZip = async (update: Plugin | null): Promise<string> => {
    if (!platform.pickFile) throw new Error('Choosing a file is not available here');
    const file = await platform.pickFile({ title: update ? `Update ${update.folderName}` : 'Install plugin ZIP', filters: { 'Plugin ZIP': ['zip'] } });
    if (!file) return '';
    // an unreadable ZIP is reported by the install itself
    const manifest = await service.bridgeApi.inspect(file).catch(() => null);
    const zipVersion = typeof manifest?.version === 'string' ? manifest.version : '';
    const zipId = typeof manifest?.id === 'string' ? manifest.id : '';
    if (update) {
      const ok = await choose(`Update ${update.folderName}?\n${PluginService.versionChange(update.version, zipVersion)}\nThe plugin's ID and stored data are kept. The previous package is restored if loading fails.`, ['Update']);
      if (ok !== 'Update') return '';
      const p = await service.installZip(file, update.folderName, update.id, false);
      return `Updated ${p.folderName}: ${versionLabel(update.version)} → ${versionLabel(p.version)}`;
    }
    const base = folderFrom(path.basename(file).replace(/\.[^.]*$/, ''), 'my-extension');
    const conflict = service.plugins().find((p) => p.folderName.toLowerCase() === base.toLowerCase() || (zipId && p.id === zipId));
    if (conflict) {
      const pick = await choose(
        `${conflict.folderName} (${conflict.name}) is already installed. Update it with this ZIP, or install the ZIP as a separate new plugin?\n${PluginService.versionChange(conflict.version, zipVersion)}`,
        ['Update', 'Install as new'],
      );
      if (pick === 'Update') {
        const p = await service.installZip(file, conflict.folderName, conflict.id, false);
        return `Updated ${p.folderName}: ${versionLabel(conflict.version)} → ${versionLabel(p.version)}`;
      }
      if (pick !== 'Install as new') return '';
      const name = (await platform.prompt('Folder name for the new plugin (its ID comes from this name)', freeFolder(base)))?.trim();
      if (!name) return '';
      if (taken(name)) throw new Error('A plugin already uses this folder name');
      const p = await service.installZip(file, name, null, true);
      return `Installed ${p.folderName} ${versionLabel(p.version)}`;
    }
    const name = (await platform.prompt(`Install plugin (${versionLabel(zipVersion)}): folder name`, base))?.trim();
    if (!name) return '';
    if (taken(name)) throw new Error('A plugin already uses this folder name');
    const p = await service.installZip(file, name, null, false);
    return `Installed ${p.folderName} ${versionLabel(p.version)}`;
  };

  /** A choice between buttons (falls back to a yes/no confirm with the first option). */
  const choose = async (message: string, options: string[]): Promise<string | undefined> => {
    if (platform.choose) return platform.choose(message, options);
    return (await platform.confirm(message)) ? options[0] : undefined;
  };

  const installFromStore = async (repo: PluginRepo, plugin: RepoPlugin): Promise<string> => {
    const installed = service.repos.installedFor(service.plugins(), repo, plugin);
    if (installed) {
      const p = await service.installRepo(repoLabel(repo), plugin, installed.folderName, installed.id);
      return `Updated ${p.folderName}: ${versionLabel(installed.version)} → ${versionLabel(p.version)}`;
    }
    let name = folderFrom(plugin.path.split('/').pop() ?? '', 'plugin');
    if (taken(name)) {
      const other = (await platform.prompt(`A plugin already uses the folder ${name}. Folder name for ${plugin.name}`, freeFolder(name)))?.trim();
      if (!other) return '';
      if (taken(other)) throw new Error('A plugin already uses this folder name');
      name = other;
    }
    const p = await service.installRepo(repoLabel(repo), plugin, name, null);
    return `Installed ${p.folderName} ${versionLabel(p.version)} from ${repoLabel(repo)}`;
  };

  const readGuide = () => fs.readFileSync(path.join(service.sdkDir, GUIDE), 'utf8');

  const settings: PluginHooks['settings'] = {
    rootItem() {
      const list = service.plugins();
      const updates = service.updatesAvailable().length;
      return {
        kind: 'page',
        id: 'plugins',
        label: 'Custom AntiGem Plugins',
        icon: 'extension',
        description: updates ? `${list.length} installed · ${updates} update${updates === 1 ? '' : 's'}` : list.length ? `${list.filter((p) => p.isEnabled).length} of ${list.length} enabled` : 'Skills and MCP tools for every agent',
        badge: updates ? String(updates) : null,
      };
    },

    async page(id) {
      // the list is read again whenever a plugin page opens; repositories at most every 2 minutes
      void service.fresh(2000);
      if (id !== 'plugins.guide') service.refreshReposIfStale();
      if (id === 'plugins.installed') return installedPage();
      if (id === 'plugins.repos') return reposPage();
      if (id === 'plugins.store') return storePage();
      if (id === 'plugins.guide') return guidePage();
      return hubPage();
    },

    async change(page, id, value, rowId) {
      if (id === 'installed' && rowId) {
        await service.setEnabled(rowId, value === true);
      }
    },

    async action(page, id, rowId, actionId, values) {
      if (id === 'plugins.installZip') return installZip(null);
      if (id === 'plugins.refresh') {
        await service.resync();
        return 'Plugins refreshed';
      }
      if (id === 'installed' && rowId) {
        const p = service.find(rowId);
        if (!p) throw new Error('Extension not found');
        if (actionId === 'updateZip') return installZip(p);
        if (actionId === 'reload') {
          await service.reload(p.id);
          return `Reloaded ${p.folderName}`;
        }
        if (actionId === 'update') {
          const u = service.repos.updateFor(p);
          if (!u) return 'Up to date';
          const updated = await service.installRepo(repoLabel(u.repo), u.offered, p.folderName, p.id);
          return `Updated ${updated.folderName}: ${versionLabel(p.version)} → ${versionLabel(updated.version)}`;
        }
        if (actionId === 'export') {
          const { name, data } = await service.bridgeApi.export(p.id);
          await saveBytes(name, data);
          return '';
        }
        if (actionId === 'remove') {
          await service.remove(p.id, values?.data === 'delete');
          return `Removed ${p.folderName}`;
        }
      }
      if (id === 'repos') {
        if (actionId === 'add') {
          const repo = service.repos.add(values?.repo ?? '');
          void service.repos.refresh(repo).then(() => service.refreshReposIfStale());
          return `Added ${repoLabel(repo)}`;
        }
        const repo = rowId ? service.repos.find(rowId) : undefined;
        if (!repo) throw new Error('Repository not found');
        if (actionId === 'refresh') {
          await service.repos.refresh(repo);
          const err = service.repos.errors.get(rowId!);
          if (err) throw new Error(err);
          return '';
        }
        if (actionId === 'remove') {
          service.repos.remove(rowId!);
          return `Removed ${rowId}`;
        }
      }
      if (id === 'repos.refreshAll') {
        await Promise.all([service.repos.refreshAll(), service.refresh().catch(() => undefined)]);
        service.notifyUpdates();
        const ups = service.updatesAvailable().length;
        return ups ? `${ups} update${ups === 1 ? '' : 's'} available` : 'Everything is up to date';
      }
      if (id.startsWith('store:') && rowId && actionId === 'install') {
        const [label, ...rest] = rowId.split('|');
        const repo = service.repos.find(label);
        const plugin = service.repos.listings.get(label)?.plugins.find((x) => x.path === rest.join('|'));
        if (!repo || !plugin) throw new Error('That plugin is no longer listed; check the repository again');
        return installFromStore(repo, plugin);
      }
      if (id === 'guide.view') {
        platform.openText('Plugin repository guide', readGuide(), 'markdown');
        return '';
      }
      if (id === 'guide.save') {
        await platform.saveText('antigem-plugin-repository.md', readGuide());
        return '';
      }
      if (id === 'sdk.readme') {
        platform.openText('AntiGem plugin SDK', fs.readFileSync(path.join(service.sdkDir, 'README.md'), 'utf8'), 'markdown');
        return '';
      }
      if (id === 'sdk.save') {
        await saveBytes('antigem-plugin-sdk.zip', zipFolder(service.sdkDir, 'antigem-plugin-sdk'));
        return '';
      }
      return '';
    },
  };

  return {
    bind: (api: PluginHostApi) => service.bind(api),
    slashItems: (): SlashCommandView[] => service.slashItems(),
    guide: (id, skill) => service.guide(id, skill),
    settings,
    dispose: () => service.dispose(),
  };
}

