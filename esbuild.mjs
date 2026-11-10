// Bundles the extension host (src/extension.ts) and the dev server (dev/server.ts) for Node.
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');

mkdirSync('dist', { recursive: true });
cpSync('proto', 'dist/proto', { recursive: true });
// custom plugins: the app's Node plugin runtime (run as a child process) and the plugin SDK docs the developer MCP serves
cpSync('src/core/plugins/runtime', 'dist/plugin-runtime', { recursive: true });
cpSync('src/core/plugins/sdk', 'dist/plugin-sdk', { recursive: true });
// the AntiGem Chrome extension lives in its own repository next to this one (antiGem/antigem-chrome-extension); the
// VSIX ships a copy (Settings → Browser copies it on to ~/.antigem/chrome-extension for "Load unpacked")
const chromeSrc = resolve(process.env.ANTIGEM_CHROME_EXTENSION ?? '../antigem-chrome-extension');
rmSync('dist/chrome-extension', { recursive: true, force: true });
if (existsSync(`${chromeSrc}/manifest.json`)) {
  cpSync(chromeSrc, 'dist/chrome-extension', { recursive: true, filter: (src) => src === chromeSrc || !basename(src).startsWith('.') });
} else {
  console.warn(`! AntiGem Chrome extension not found at ${chromeSrc}: Settings → Browser will say it is missing (set ANTIGEM_CHROME_EXTENSION)`);
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};

const configs = [];
if (!dev) configs.push({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] });
configs.push({ ...common, entryPoints: ['dev/server.ts'], outfile: 'dist/dev-server.js' });

if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
