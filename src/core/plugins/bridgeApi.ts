// The bridge's /api/custom-plugins endpoints (port of the app's PluginBridge.kt): every plugin file operation —
// list, inspect, install (ZIP / repository / developer draft), commit / restore, remove, enable, rename, export,
// repository listings and progress, developer drafts. The extension only loads plugins into its runtime.
import fs from 'node:fs';
import type { BridgeManager } from '../bridge/BridgeManager';
import { pluginFromJson, type Plugin, type RepoInstallProgress, type RepoListing } from './types';

export interface Installed {
  plugin: Plugin;
  replaced: boolean;
}

const BASE = '/api/custom-plugins/';

export class PluginBridge {
  constructor(private bridge: BridgeManager) {}

  private async request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    await this.bridge.ensureRunning();
    const { timeoutMs, ...rest } = init;
    const res = await this.bridge.fetch(BASE + path, { ...rest, signal: AbortSignal.timeout(timeoutMs ?? 30_000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = '';
      try {
        msg = String(JSON.parse(text)?.error ?? '');
      } catch {
        msg = text.trim().slice(0, 300);
      }
      throw new Error(msg || `AntiGem bridge HTTP ${res.status}`);
    }
    return res;
  }

  private async get<T>(path: string, timeoutMs?: number): Promise<T> {
    return (await (await this.request(path, { timeoutMs })).json()) as T;
  }

  private async post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    const res = await this.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, timeoutMs });
    return (await res.json()) as T;
  }

  private installed(body: { plugin: Record<string, unknown>; replaced?: boolean }): Installed {
    return { plugin: pluginFromJson(body.plugin), replaced: body.replaced === true };
  }

  async list(): Promise<Plugin[]> {
    const body = await this.get<{ plugins: Record<string, unknown>[] }>('', 15_000);
    return (body.plugins ?? []).map(pluginFromJson).filter((p) => p.id);
  }

  /** The manifest inside a ZIP file (to spot an installed plugin and compare versions before installing). */
  async inspect(zipPath: string): Promise<Record<string, unknown>> {
    const body = await this.request('inspect', { method: 'POST', body: fs.readFileSync(zipPath), headers: { 'content-type': 'application/zip' }, timeoutMs: 120_000 });
    return ((await body.json()) as { manifest: Record<string, unknown> }).manifest ?? {};
  }

  async install(zipPath: string, folder: string, updateId: string | null, asNew: boolean): Promise<Installed> {
    const q = new URLSearchParams({ folder, update_id: updateId ?? '', as_new: String(asNew) });
    const res = await this.request(`install?${q}`, { method: 'POST', body: fs.readFileSync(zipPath), headers: { 'content-type': 'application/zip' }, timeoutMs: 300_000 });
    return this.installed((await res.json()) as { plugin: Record<string, unknown>; replaced?: boolean });
  }

  async repoList(repo: string): Promise<RepoListing> {
    const b = await this.post<{ title?: string; plugins?: Record<string, unknown>[]; fromIndex?: boolean }>('repo/list', { repo }, 120_000);
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    return {
      title: s(b.title),
      plugins: (b.plugins ?? []).map((p) => ({ path: s(p.path), id: s(p.id), name: s(p.name) || s(p.path), version: s(p.version), description: s(p.description), iconUrl: s(p.iconUrl) })),
      fromIndex: b.fromIndex === true,
    };
  }

  async repoInstall(repo: string, path: string, folder: string, updateId: string | null, asNew: boolean): Promise<Installed> {
    return this.installed(await this.post('repo/install', { repo, path, folder, update_id: updateId ?? '', as_new: asNew }, 600_000));
  }

  /** Progress of the repository install into `folder` while it runs; null when none runs. */
  async repoProgress(folder: string): Promise<RepoInstallProgress | null> {
    const b = await this.get<Record<string, unknown>>(`repo/progress?${new URLSearchParams({ folder })}`, 5_000);
    if (b.active !== true) return null;
    return {
      folder,
      phase: String(b.phase ?? ''),
      bytesDone: Number(b.bytes_done ?? 0),
      bytesTotal: Number(b.bytes_total ?? 0),
      filesDone: Number(b.files_done ?? 0),
      filesTotal: Number(b.files_total ?? 0),
    };
  }

  async commit(folder: string) {
    await this.post('commit', { folder });
  }
  async restore(folder: string) {
    await this.post('restore', { folder });
  }
  async remove(id: string, deleteData: boolean) {
    await this.post('remove', { id, delete_data: deleteData });
  }
  async setEnabled(id: string, enabled: boolean) {
    await this.post('set-enabled', { id, enabled });
  }
  async rename(id: string, folder: string): Promise<Plugin> {
    return pluginFromJson((await this.post<{ plugin: Record<string, unknown> }>('rename', { id, folder })).plugin);
  }

  /** The plugin as a ZIP (bytes) and the bridge's suggested file name (folder-version.zip). */
  async export(id: string): Promise<{ name: string; data: Buffer }> {
    const res = await this.request(`export?${new URLSearchParams({ id })}`, { timeoutMs: 300_000 });
    const disp = res.headers.get('content-disposition') ?? '';
    const name = (/filename="([^"]+)"/.exec(disp)?.[1] ?? `${id}.zip`).replace(/[^A-Za-z0-9._-]/g, '_');
    return { name, data: Buffer.from(await res.arrayBuffer()) };
  }

  // ---- developer MCP drafts (~/extension-projects)

  async draftProjects(): Promise<string[]> {
    return (await this.get<{ projects: string[] }>('drafts')).projects ?? [];
  }
  draftCreate(projectId: string, files: { path: string; content: string }[]) {
    return this.post<Record<string, unknown>>('drafts/create', { project_id: projectId, files });
  }
  draftRead(projectId: string, path: string) {
    return this.post<Record<string, unknown>>('drafts/read', { project_id: projectId, path });
  }
  draftWrite(projectId: string, files: unknown) {
    return this.post<Record<string, unknown>>('drafts/write', { project_id: projectId, files });
  }
  draftPackage(projectId: string) {
    return this.post<Record<string, unknown>>('drafts/package', { project_id: projectId }, 120_000);
  }
  async draftInstall(projectId: string | null, zipPath: string | null, folder: string, updateId: string | null): Promise<Installed> {
    return this.installed(await this.post('drafts/install', { project_id: projectId ?? '', zip_path: zipPath ?? '', folder, update_id: updateId ?? '' }, 300_000));
  }
}
