// Offline unit tests of the custom plugin feature (src/core/plugins): `/plu:` expansion (HostSettings.expand + the app's
// pluginGuide), the `/` picker rows, versions, repository names, the Custom Plugin MCP preset, skills parsing and the
// SDK ZIP. Nothing touches the bridge or the user's plugin folders (fixtures live in a temp folder).
//   npx esbuild dev/test-plugins.ts --bundle --platform=node --outfile=<tmp>/test-plugins.js && node <tmp>/test-plugins.js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostSettings } from '../src/core/settings';
import { pluginGuide, pluginSlashItems, pluginSuggestions } from '../src/core/plugins/expansion';
import { parseRepo, repoLabel } from '../src/core/plugins/repos';
import { describe as describeSkill, listSkills, callSkillTool, skillInstructions } from '../src/core/plugins/skills';
import { compareVersions, pluginServerName, versionLabel, type Plugin } from '../src/core/plugins/types';
import { resolvePreset, setPresetEnv, setPresetPlugins, mcpPresets } from '../src/core/mcp/presets';
import { zipFolder } from '../src/core/plugins/zip';
import { PluginRuntime } from '../src/core/plugins/runtime';
import { chromeExtensionBrowser, type BrowserLink } from '../src/core/plugins/chromeBrowser';
import vm from 'node:vm';
import type { KeyValueStore } from '../src/core/types';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passes++;
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 500)}` : ''}`);
  }
}

// ---- fixtures: two plugins with skills, one with tools, one disabled
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antigem-plugins-test-'));
const mk = (rel: string, content: string) => {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
};
const reaSkill = mk('rea/skills/rea.md', '---\nname: REA setup\ndescription: Install REA and check its server.\n---\n# REA\nBody');
mk('rea/skills/rea/setup.md', '# Setup');
const yt = mk('yt/skills/youtube_upload.md', '# Upload a video\n\nUpload a **video** to [YouTube](https://youtube.com) Studio.\n\n- step');
const plugin = (o: Partial<Plugin> & { id: string }): Plugin => ({
  name: o.id,
  version: '1.0.0',
  description: '',
  toolCount: 0,
  skillCount: 0,
  folderName: o.id,
  permissions: [],
  isEnabled: true,
  dirPath: path.join(tmp, o.id),
  iconPath: '',
  location: 'installed',
  skills: [],
  ...o,
});
const plugins: Plugin[] = [
  plugin({
    id: 'rea',
    name: 'REA · Reverse Engineering',
    description: 'Reverse engineer anything',
    skillCount: 1,
    skills: [{ name: 'rea', title: 'REA setup', description: 'Install REA and check its server.', path: reaSkill, detailDir: path.join(tmp, 'rea/skills/rea') }],
  }),
  plugin({ id: 'yt', name: 'YouTube', toolCount: 3, skillCount: 1, skills: [{ name: 'youtube_upload', title: 'Upload a video', description: 'Upload a video', path: yt }] }),
  plugin({ id: 'off', name: 'Disabled one', isEnabled: false, skillCount: 1, skills: [{ name: 'x', title: 'x', description: '', path: mk('off/skills/x.md', '# x') }] }),
];

const mem = new Map<string, unknown>();
const store: KeyValueStore = { get: <T,>(k: string) => mem.get(k) as T | undefined, set: (k, v) => void mem.set(k, v) };
const s = new HostSettings(store);

console.log('— /plu: expansion (HostSettings.expand)');
check('no guide set: /plu: stays as typed', s.expand('/plu:rea do it') === '/plu:rea do it');
s.pluginGuide = (id, skill) => pluginGuide(plugins, id, skill);
const e1 = s.expand('/plu:rea look at this apk');
check('/plu:<id> → block with the plugin guide', e1.startsWith('<antigem-expansion command="/plu:rea">\nThe user wants you to use the custom AntiGem plugin "REA · Reverse Engineering" (id: rea): Reverse engineer anything') && e1.endsWith('</antigem-expansion> look at this apk'), e1);
check('plugin guide points at the skills folder', e1.includes(`- Its skills (guides) are in ${path.join(tmp, 'rea/skills')}/: rea. Read the one that matches the task before acting.`), e1);
check('skills-only plugin: no tools line', e1.includes('- This plugin has no tools of its own: follow its instructions with the tools you already have.'), e1);
check('other enabled skill plugins listed (not disabled ones)', e1.includes(`Other installed plugins with skills: yt (${path.join(tmp, 'yt/skills')}/).`) && !e1.includes('off ('), e1);
const e2 = s.expand('/plu:rea: go');
check('dangling colon = no skill; chat shows /plu:rea', e2.startsWith('<antigem-expansion command="/plu:rea">') && e2.endsWith(' go'), e2);
const e3 = s.expand('please /plu:rea:rea now');
check('/plu:<id>:<skill> → the skill file and detail dir', e3.startsWith('please <antigem-expansion command="/plu:rea:rea">') && e3.includes(`- Read the skill file fully before acting: ${reaSkill}`) && e3.includes(`- Its detail files are in ${path.join(tmp, 'rea/skills/rea')}/`) && e3.includes('call its get_skill tool with name "rea"'), e3);
const e4 = s.expand('/plu:yt:youtube_upload');
check('tools plugin: MCP server hint (extension_<id>)', e4.includes('come from the MCP server "extension_yt"') && e4.includes('Custom AntiGem Plugin MCP'), e4);
check('id is case-insensitive', s.expand('/plu:REA').includes('(id: rea)'));
check('unknown plugin stays as typed', s.expand('/plu:nope x') === '/plu:nope x');
check('disabled plugin stays as typed', s.expand('/plu:off') === '/plu:off');
check('unknown skill → plugin-level guide', s.expand('/plu:rea:missing').includes('Its skills (guides) are in'));
check('inside a word / path: untouched', s.expand('see a/plu:rea') === 'see a/plu:rea' && s.expand('x /plu:rea/y') === 'x /plu:rea/y');
store.set('custom.commands', [
  { name: 'review', description: '', expansion: 'Review it' },
  { name: 'ask', description: '', expansion: 'Answer: $ARGUMENTS' },
]);
const e5 = s.expand('/plu:rea then /review');
check('with custom commands in one pass', e5.includes('command="/plu:rea"') && e5.includes('<antigem-expansion command="/review">\nReview it\n</antigem-expansion>'), e5);
const e6 = s.expand('/plu:rea /ask what is /plu:yt');
check('$ARGUMENTS takes the rest (a later /plu: stays inside the arguments, as the app)', e6.includes('command="/plu:rea"') && e6.includes('<antigem-expansion command="/ask what is /plu:yt">\nAnswer: what is /plu:yt'), e6);
check('text without a slash untouched', s.expand('hello') === 'hello');
check('google-flow server name', pluginServerName('google-flow') === 'google_flow_mcp' && pluginServerName('x') === 'extension_x');

console.log('— / picker rows');
const items = pluginSlashItems(plugins);
check('/plu: first', items[0].command === '/plu:' && items[0].kind === 'plugin');
check('plugin rows (":" when it has skills), not disabled', items.some((i) => i.command === '/plu:rea:') && items.some((i) => i.command === '/plu:yt:') && !items.some((i) => i.command.startsWith('/plu:off')), items.map((i) => i.command));
check('skill rows carry pluginName', items.some((i) => i.command === '/plu:rea:rea' && i.pluginName === 'REA · Reverse Engineering' && i.description === 'Install REA and check its server.'));
check('plugin row description: name · counts · description', items.find((i) => i.command === '/plu:yt:')?.description === 'YouTube · 3 tools · 1 skills');
const sug1 = pluginSuggestions(plugins, 'yo');
check('suggestions: plugins matching "yo"', sug1.length === 1 && sug1[0].command === '/plu:yt:', sug1);
const sug2 = pluginSuggestions(plugins, 'rea:');
check('suggestions: one plugin → whole + its skills', sug2[0].command === '/plu:rea' && sug2[1].command === '/plu:rea:rea', sug2);

console.log('— versions / repositories');
check('compare', compareVersions('1.2.0', '1.1.9') === 1 && compareVersions('v1.0', '1.0.0') === 0 && compareVersions('1.0', '1.0.1') === -1 && compareVersions('1.0-beta', '1') === null && compareVersions('', '1') === null);
check('label', versionLabel('1.2') === 'v1.2' && versionLabel('v2') === 'v2' && versionLabel('') === 'no version');
const r1 = parseRepo('https://github.com/Owner/Repo.git');
const r2 = parseRepo('owner/repo@v2.0');
const r3 = parseRepo('github.com/o/r/tree/feature/x');
check('parseRepo', repoLabel(r1) === 'Owner/Repo' && repoLabel(r2) === 'owner/repo@v2.0' && repoLabel(r3) === 'o/r@feature/x', [r1, r2, r3]);
let threw = false;
try {
  parseRepo('just-a-name');
} catch {
  threw = true;
}
check('parseRepo rejects a bare name', threw);

console.log('— Custom Plugin MCP preset');
setPresetEnv({ port: 1246, deviceId: 'dev123', served: (p) => p === '/mcp' });
setPresetPlugins(() => []);
check('no enabled plugin: tile disabled', mcpPresets().find((p) => p.id === 'custom_plugin')?.available === false);
setPresetPlugins(() => [{ id: 'yt', name: 'YouTube', folderName: 'yt', toolCount: 3, skillCount: 1, serverName: 'extension_yt' }]);
const tile = mcpPresets().find((p) => p.id === 'custom_plugin');
check('tile has a plugin picker', tile?.available === true && tile.form?.[0]?.id === 'plugin' && tile.form[0].options?.[0]?.value === 'yt', tile);
const pr = resolvePreset('custom_plugin', { plugin: 'yt' });
check('resolves to /mcp?extension=yt + X-Device-Id + extension_yt', pr.url === 'http://127.0.0.1:1246/mcp?extension=yt' && pr.headers?.['X-Device-Id'] === 'dev123' && pr.serverName === 'extension_yt', pr);

console.log('— skills (the runtime skills.mjs port)');
const d1 = describeSkill(fs.readFileSync(yt, 'utf8'), 'youtube_upload');
check('describe: heading + first paragraph without markdown', d1.title === 'Upload a video' && d1.description === 'Upload a video to YouTube Studio.', d1);
const d2 = describeSkill(fs.readFileSync(reaSkill, 'utf8'), 'rea');
check('describe: frontmatter', d2.title === 'REA setup' && d2.description === 'Install REA and check its server.', d2);
const ls = listSkills(path.join(tmp, 'rea'));
check('listSkills: detail files', ls.length === 1 && ls[0].detail_files.join() === 'setup.md', ls);
const gs = callSkillTool(path.join(tmp, 'rea'), 'get_skill', { name: 'rea' }) as { detail_files: { file: string }[] };
check('get_skill detail files', gs.detail_files[0].file === 'setup.md');
check('instructions', /^This server is the custom AntiGem plugin "REA"/.test(skillInstructions('REA', ls) ?? '') && skillInstructions('x', []) === undefined);

console.log('— SDK ZIP');
const sdk = path.join(process.cwd(), 'src', 'core', 'plugins', 'sdk');
if (fs.existsSync(sdk)) {
  const zipPath = path.join(tmp, 'sdk.zip');
  fs.writeFileSync(zipPath, zipFolder(sdk, 'antigem-plugin-sdk'));
  let ok = false;
  let names = '';
  try {
    names = execFileSync('python3', ['-I', '-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))', zipPath], { encoding: 'utf8' });
    ok = true;
  } catch (e) {
    names = String(e);
  }
  check('valid ZIP with the SDK under antigem-plugin-sdk/', ok && names.includes('antigem-plugin-sdk/README.md') && names.includes('antigem-plugin-sdk/examples/hello-mcp/worker.js'), names.slice(0, 300));
} else console.log('  (run from the project folder to test the SDK ZIP: skipped)');

// ---- the Node runtime (child process) with the Chrome-extension browser adapter over a fake extension link
async function runtimeTest() {
  console.log('— runtime + Chrome extension adapter (fake link)');
  const entry = path.join(process.cwd(), 'src', 'core', 'plugins', 'runtime', 'host-ipc.mjs');
  if (!fs.existsSync(entry)) return console.log('  (run from the project folder: skipped)');
  const sent: { command: string; payload: Record<string, unknown> }[] = [];
  const tabs = [{ id: '7', url: 'https://example.com/a', title: 'Example', status: 'complete', active: true }];
  let connected = true;
  const listeners = new Set<() => void>();
  const link: BrowserLink = {
    connected: () => connected,
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async call<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
      sent.push({ command, payload });
      if (command === 'tabs.list') return { tabs } as T;
      if (command === 'tabs.open') {
        const id = String(8 + tabs.length);
        tabs.push({ id, url: String(payload.url), title: '', status: 'loading', active: true });
        return { tabId: id } as T;
      }
      if (command === 'page.eval') {
        // the page: a title and a viewport
        const value = await vm.runInNewContext(String(payload.expression), { document: { title: 'Example page' }, innerWidth: 1000, innerHeight: 800, visualViewport: null });
        return { result: { value } } as T;
      }
      return { ok: true } as T;
    },
  };
  const provider = chromeExtensionBrowser(link);
  const dir = path.join(tmp, 'brw');
  mk('brw/manifest.json', JSON.stringify({ manifest_version: 3, id: 'brw', name: 'Browser test', version: '1.0.0', permissions: ['scripting', 'antigemFiles', 'storage'], host_permissions: ['https://example.com/*'], background: { service_worker: 'worker.js' }, mcp_tools: ['title', 'open', 'tap', 'zoom'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) }));
  mk(
    'brw/worker.js',
    `chrome.runtime.onMessage.addListener((m, s, reply) => {
      if (m.type !== 'mcp_tool_call') return;
      (async () => {
        if (m.tool === 'title') {
          const [tab] = await chrome.tabs.query({ active: true });
          const [frame] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (x) => document.title + x, args: ['!'] });
          return { tab: tab.url, title: frame.result };
        }
        if (m.tool === 'open') { const t = await chrome.tabs.create({ url: 'https://example.com/new' }); return { url: t.url }; }
        if (m.tool === 'tap') { const [tab] = await chrome.tabs.query({ active: true }); await chrome.antigem.automation({ tabId: tab.id, busy: true }); await chrome.antigem.automation({ tabId: tab.id, tap: { fx: 0.5, fy: 0.25 } }); return 'tapped'; }
        if (m.tool === 'zoom') { const [tab] = await chrome.tabs.query({ active: true }); await chrome.tabs.setZoom(tab.id, 2); }
      })().then(reply, (e) => reply({ isError: true, content: [{ type: 'text', text: e.message }] }));
      return true;
    });`,
  );
  const rt = new PluginRuntime({ entry, root: path.join(tmp, 'root'), stateRoot: path.join(tmp, 'state'), log: () => undefined, browser: () => provider });
  try {
    await rt.call('load', { dir });
    const t1 = (await rt.call('call', { id: 'brw', tool: 'title', args: {} })) as { tab: string; title: string };
    check('chrome.tabs.query + scripting.executeScript via page.eval', t1.tab === 'https://example.com/a' && t1.title === 'Example page!', t1);
    const t2 = (await rt.call('call', { id: 'brw', tool: 'open', args: {} })) as { url: string };
    check('chrome.tabs.create via tabs.open', t2.url === 'https://example.com/new' && sent.some((c) => c.command === 'tabs.open' && c.payload.newTab === true), t2);
    const t3 = await rt.call('call', { id: 'brw', tool: 'tap', args: {} });
    const input = sent.filter((c) => c.command === 'cdp').flatMap((c) => c.payload.commands as { method: string; params: { type: string; x: number; y: number } }[]);
    check('automation busy + tap → agent.begin + trusted mouse at viewport fractions', t3 === 'tapped' && sent.some((c) => c.command === 'agent.begin') && input.some((i) => i.params.type === 'mousePressed' && i.params.x === 500 && i.params.y === 200), input);
    const t4 = (await rt.call('call', { id: 'brw', tool: 'zoom', args: {} })) as { isError?: boolean; content?: { text: string }[] };
    check('unsupported API → clear error', t4?.isError === true && /not available through the AntiGem Chrome extension/.test(t4.content?.[0]?.text ?? ''), t4);
    connected = false;
    listeners.forEach((f) => f());
    const t5 = (await rt.call('call', { id: 'brw', tool: 'title', args: {} })) as { isError?: boolean; content?: { text: string }[] };
    check('disconnected → "connect the AntiGem Chrome extension"', t5?.isError === true && /AntiGem Chrome extension is not connected/.test(t5.content?.[0]?.text ?? ''), t5);
  } catch (e) {
    check('runtime test', false, e instanceof Error ? e.message : String(e));
  } finally {
    rt.dispose();
  }
}

void runtimeTest().then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
});
