// The user's plugin repositories and what each offers (port of the app's PluginRepositories.kt): public GitHub
// repositories of plugin folders, listed by the bridge from their antigem-plugins.json (or top-level folders with a
// manifest.json). The official repositories are added once each; a removed one stays removed.
import type { KeyValueStore } from '../types';
import type { PluginBridge } from './bridgeApi';
import { compareVersions, type Plugin, type PluginRepo, type RepoListing, type RepoPlugin } from './types';

export const REPO_INDEX = 'antigem-plugins.json';

const DEFAULT_REPOS: [string, string][] = [
  ['dipeshkrydv/antigem_plugins', 'default_repo_added'],
  ['Santoshkurmi/antigem_plugins', 'default_repo_added_santoshkurmi'],
];
const NAME = '[A-Za-z0-9_.-]+';

export const repoSlug = (r: PluginRepo) => `${r.owner}/${r.name}`;
export const repoLabel = (r: PluginRepo) => (r.ref ? `${repoSlug(r)}@${r.ref}` : repoSlug(r));

/** Accepts owner/repo, owner/repo@branch, https://github.com/owner/repo and …/tree/branch URLs. */
export function parseRepo(input: string): PluginRepo {
  const text = input
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//, '');
  const m = new RegExp(`^(${NAME})/(${NAME})/tree/(.+)$`).exec(text) ?? new RegExp(`^(${NAME})/(${NAME})(?:@(.+))?$`).exec(text);
  if (!m) throw new Error('Use owner/repo, owner/repo@branch or a github.com repository URL');
  const ref = m[3] ?? '';
  if (ref && (/\s/.test(ref) || ref.split('/').some((p) => !p || p === '..'))) throw new Error(`Invalid branch or tag: ${ref}`);
  return { owner: m[1], name: m[2], ref };
}

export class PluginRepositories {
  /** Latest listing / error per repo label; labels being refreshed. */
  listings = new Map<string, RepoListing>();
  errors = new Map<string, string>();
  loading = new Set<string>();
  /** When all repositories were last listed (ms). */
  lastRefresh = 0;
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private store: KeyValueStore,
    private bridge: PluginBridge,
    private changed: () => void,
  ) {
    this.addDefaults();
  }

  /** Each official repository once, at the top in this order. */
  private addDefaults() {
    const flags = this.store.get<Record<string, boolean>>('plugins.repoFlags') ?? {};
    let list = this.repos();
    let changed = false;
    DEFAULT_REPOS.forEach(([repo, key], index) => {
      if (flags[key]) return;
      const official = parseRepo(repo);
      if (!list.some((r) => repoSlug(r).toLowerCase() === repoSlug(official).toLowerCase())) {
        list = [...list.slice(0, Math.min(index, list.length)), official, ...list.slice(Math.min(index, list.length))];
      }
      flags[key] = true;
      changed = true;
    });
    if (changed) {
      this.store.set('plugins.repoFlags', flags);
      this.persist(list);
    }
  }

  repos(): PluginRepo[] {
    const labels = this.store.get<string[]>('plugins.repos') ?? [];
    const out: PluginRepo[] = [];
    for (const l of labels) {
      try {
        out.push(parseRepo(l));
      } catch {
        /* skip a bad entry */
      }
    }
    return out;
  }

  private persist(list: PluginRepo[]) {
    this.store.set('plugins.repos', list.map(repoLabel));
  }

  add(input: string): PluginRepo {
    const repo = parseRepo(input);
    const list = this.repos();
    if (list.some((r) => repoLabel(r).toLowerCase() === repoLabel(repo).toLowerCase())) throw new Error(`${repoLabel(repo)} is already added`);
    this.persist([...list, repo]);
    this.changed();
    return repo;
  }

  remove(label: string) {
    this.persist(this.repos().filter((r) => repoLabel(r) !== label));
    this.listings.delete(label);
    this.errors.delete(label);
    this.changed();
  }

  find(label: string): PluginRepo | undefined {
    return this.repos().find((r) => repoLabel(r) === label);
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.repos().map((r) => this.refresh(r)));
    this.lastRefresh = Date.now();
  }

  refresh(repo: PluginRepo): Promise<void> {
    const label = repoLabel(repo);
    const running = this.inflight.get(label);
    if (running) return running;
    this.loading.add(label);
    this.changed();
    const p = this.bridge
      .repoList(label)
      .then(
        (listing) => {
          this.listings.set(label, listing);
          this.errors.delete(label);
        },
        (e) => {
          this.errors.set(label, e instanceof Error ? e.message : `Could not read ${label}`);
        },
      )
      .finally(() => {
        this.loading.delete(label);
        this.inflight.delete(label);
        this.changed();
      });
    this.inflight.set(label, p);
    return p;
  }

  /** The installed plugin a repository entry corresponds to: same repo and folder, else the same plugin ID. */
  installedFor(installed: Plugin[], repo: PluginRepo, plugin: RepoPlugin): Plugin | undefined {
    return (
      installed.find((p) => p.source?.repo.toLowerCase() === repoSlug(repo).toLowerCase() && p.source?.path === plugin.path) ??
      (plugin.id ? installed.find((p) => p.id === plugin.id) : undefined)
    );
  }

  /** A newer version of `p` in the repository it was installed from, if one has been seen. */
  updateFor(p: Plugin): { repo: PluginRepo; offered: RepoPlugin } | null {
    const source = p.source;
    if (!source) return null;
    const repo = this.repos().find((r) => repoSlug(r).toLowerCase() === source.repo.toLowerCase() && r.ref === source.ref);
    if (!repo) return null;
    const offered = this.listings.get(repoLabel(repo))?.plugins.find((x) => x.path === source.path);
    if (!offered || (compareVersions(offered.version, p.version) ?? 0) <= 0) return null;
    return { repo, offered };
  }
}
