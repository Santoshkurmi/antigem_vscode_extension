// Bundles the extension host (src/extension.ts) and the dev server (dev/server.ts) for Node.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');

mkdirSync('dist', { recursive: true });
cpSync('proto', 'dist/proto', { recursive: true });

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
