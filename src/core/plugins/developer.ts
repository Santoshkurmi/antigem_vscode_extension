// Custom AntiGem Plugin Developer MCP at /extension_developer (port of the app's WebViewExtensionDeveloper.kt): the
// bundled SDK docs, drafts in ~/extension-projects (files written, read and packaged by the bridge), install / update
// with rollback, enable, reload, rename, test and worker logs through the plugin service. The 12 tools and their
// schemas are the app's developer-tools.json, unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { type McpResult, type McpServerDef, type McpTool } from '../mcp/server';
import developerTools from './sdk/developer-tools.json';
import { RUNTIME_TOOL, type PluginService } from './service';
import { listFiles } from './zip';

const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;

function projectId(value: unknown): string {
  const v = String(value ?? '');
  if (!PROJECT.test(v)) throw new Error('project_id must contain 1–64 letters, numbers, underscores or hyphens');
  return v;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Character pagination of a text (offset / limit 1–40000, default 16000). */
function page(textValue: string, args: Record<string, unknown>) {
  const offset = args.offset == null ? 0 : Number(args.offset);
  const limit = args.limit == null ? 16_000 : Number(args.limit);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 40_000)
    throw new Error('offset must be non-negative and limit must be 1–40000 characters');
  const end = Math.min(textValue.length, offset + limit);
  return { content: offset >= textValue.length ? '' : textValue.slice(offset, end), offset, total_characters: textValue.length, next_offset: end < textValue.length ? end : null };
}

const response = (value: unknown, failed = false): McpResult => ({
  ...(failed ? { isError: true } : {}),
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});

export function developerMcp(service: PluginService): McpServerDef {
  const tools = developerTools as unknown as McpTool[];

  const docs = (args: Record<string, unknown>) => {
    const files = listFiles(service.sdkDir);
    const result: Record<string, unknown> = { files };
    if (args.list_only === true) return result;
    const p = str(args.path) || 'README.md';
    if (!files.includes(p)) throw new Error('Unknown SDK document. Use list_only=true to list available paths');
    const t = fs.readFileSync(path.join(service.sdkDir, p), 'utf8');
    return { ...result, ...page(t, args), path: p };
  };

  const create = async (args: Record<string, unknown>) => {
    const id = projectId(args.project_id);
    const name = str(args.name).trim();
    if (!name) throw new Error('name is required');
    const tool = projectId(args.tool_name ?? 'hello');
    const example = path.join(service.sdkDir, 'examples', 'hello-mcp');
    const manifest = JSON.parse(fs.readFileSync(path.join(example, 'manifest.json'), 'utf8'));
    manifest.id = id;
    manifest.name = name;
    manifest.description = args.description != null ? str(args.description) : `MCP extension for ${name}`;
    manifest.mcp_tools[0].name = tool;
    const worker = fs.readFileSync(path.join(example, 'worker.js'), 'utf8');
    const files = [
      { path: 'manifest.json', content: JSON.stringify(manifest, null, 2) },
      { path: 'worker.js', content: worker.replace("message.tool !== 'hello'", `message.tool !== '${tool}'`) },
    ];
    const r = await service.bridgeApi.draftCreate(id, files);
    return { ...r, next_steps: 'Edit with webview_extension_write_files, then webview_extension_install(project_id). Read developer-mcp.md for the complete loop.' };
  };

  const readFile = async (args: Record<string, unknown>) => {
    const id = projectId(args.project_id);
    const p = str(args.path);
    const r = await service.bridgeApi.draftRead(id, p);
    if (!p) return r;
    return { ...page(String(r.content ?? ''), args), path: p };
  };

  const list = async (args: Record<string, unknown>) => {
    let hostError: string | null = null;
    if (args.refresh === true) await service.resync().catch((e) => (hostError = e instanceof Error ? e.message : String(e)));
    const installed = await service.refresh().catch((e) => {
      hostError = hostError ?? (e instanceof Error ? e.message : String(e));
      return service.plugins();
    });
    const workers = await service.loadedWorkers();
    const extensions = [];
    for (const p of installed) extensions.push({ ...service.metadata(p), loaded: await service.isLoaded(p, workers) });
    const projects = await service.bridgeApi.draftProjects().catch((e) => {
      hostError = hostError ?? (e instanceof Error ? e.message : String(e));
      return [] as string[];
    });
    return { extensions, projects, host_error: hostError ?? service.hostError() };
  };

  const install = async (args: Record<string, unknown>) => {
    const id = str(args.project_id) ? projectId(args.project_id) : null;
    const zip = str(args.zip_path) || null;
    if ((id == null) === (zip == null)) throw new Error('Provide exactly one of project_id or zip_path');
    await service.refresh();
    const updateId = str(args.extension_id) || null;
    const previous = updateId ? service.find(updateId) : undefined;
    if (updateId && !previous) throw new Error(`Installed extension not found: ${updateId}`);
    const folder = previous?.folderName ?? (str(args.folder_name) || id || path.basename(zip!).replace(/\.[^.]*$/, ''));
    const ext = await service.installDraft(id, zip, folder, updateId);
    return {
      ...service.metadata(ext),
      updated: !!previous,
      next_steps:
        'Use webview_extension_test(extension_id) to discover tools, then pass tool_name and arguments for a real test call. The model can test through this developer MCP without adding another server.',
    };
  };

  const metadataOf = async (id: string) => {
    const p = (await service.refresh().catch(() => service.plugins())).find((x) => x.id === id);
    if (!p) throw new Error('Extension not found');
    return service.metadata(p);
  };

  const test = async (args: Record<string, unknown>): Promise<McpResult | Record<string, unknown>> => {
    const id = str(args.extension_id);
    await service.refresh().catch(() => undefined);
    const p = service.find(id);
    if (!p?.isEnabled) throw new Error('Extension is disabled or not loaded');
    const tool = str(args.tool_name);
    if (tool) return service.callPluginTool(p, tool, (args.arguments as Record<string, unknown>) ?? {});
    return { extension_id: id, mcp_url: service.mcpUrl(id), tools: await service.pluginTools(p), tested: 'Worker loaded and tools discovered; no tool was invoked' };
  };

  const call = async (name: string, args: Record<string, unknown>): Promise<McpResult> => {
    try {
      let value: unknown;
      switch (name) {
        case 'webview_extension_docs':
          value = docs(args);
          break;
        case 'webview_extension_list':
          value = await list(args);
          break;
        case 'webview_extension_create':
          value = await create(args);
          break;
        case 'webview_extension_read_file':
          value = await readFile(args);
          break;
        case 'webview_extension_write_files':
          value = await service.bridgeApi.draftWrite(projectId(args.project_id), args.files);
          break;
        case 'webview_extension_package':
          value = await service.bridgeApi.draftPackage(projectId(args.project_id));
          break;
        case 'webview_extension_install':
          value = await install(args);
          break;
        case 'webview_extension_set_enabled': {
          if (typeof args.enabled !== 'boolean') throw new Error('enabled must be true or false');
          await service.setEnabled(str(args.extension_id), args.enabled);
          value = await metadataOf(str(args.extension_id));
          break;
        }
        case 'webview_extension_reload':
          await service.reload(str(args.extension_id));
          value = await metadataOf(str(args.extension_id));
          break;
        case 'webview_extension_rename':
          value = service.metadata(await service.rename(str(args.extension_id), str(args.folder_name)));
          break;
        case 'webview_extension_test': {
          const r = await test(args);
          // a real call forwards the tested plugin's own MCP result (content / isError) unchanged
          if (str(args.tool_name)) return r as McpResult;
          value = r;
          break;
        }
        case 'webview_extension_logs': {
          const limit = args.limit == null ? 50 : Number(args.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be 1–200');
          value = await service.logs(str(args.extension_id) || null, limit);
          break;
        }
        case RUNTIME_TOOL: {
          // another AntiGem window asks this one (it runs the workers) to make a change
          const r = await service.local(str(args.op), (args.args as Record<string, unknown>) ?? {});
          return response(r ?? null);
        }
        default:
          throw new Error(`Unknown extension developer tool: ${name}`);
      }
      return response(value);
    } catch (e) {
      return response({ error: e instanceof Error ? e.message : String(e) }, true);
    }
  };

  return {
    path: '/extension_developer',
    name: 'custom_plugin_developer_mcp',
    tools: () => tools,
    hiddenTool: (n) => n === RUNTIME_TOOL,
    call,
  };
}
