// Package the extension for a single platform target.
// Usage: node scripts/package-target.mjs <target>   (e.g. linux-x64)
//
// vsce packages everything in bin/, so we temporarily move the other platform
// binaries out of bin/ (into a temp dir) and restore them afterwards. This keeps
// each VSIX small and platform-specific.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const target = process.argv[2];
const valid = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];
if (!valid.includes(target)) {
  console.error(`Usage: node scripts/package-target.mjs <${valid.join('|')}>`);
  process.exit(1);
}

const root = path.resolve(process.cwd());
const binDir = path.join(root, 'bin');
const tmpDir = path.join(root, '.bin-stash', String(Date.now()));
fs.mkdirSync(tmpDir, { recursive: true });

const isWin = target.startsWith('win32');
let wanted = `antigem-bridge-${target}${isWin ? '.exe' : ''}`;
// Windows on ARM runs the x64 bridge (emulated) when it has no build of its own; the extension falls back to it
if (target === 'win32-arm64' && !fs.existsSync(path.join(binDir, wanted))) wanted = 'antigem-bridge-win32-x64.exe';

// Sanity: wanted binary must exist.
if (!fs.existsSync(path.join(binDir, wanted))) {
  console.error(`Missing binary: bin/${wanted}. Run "npm run build:bridge" first.`);
  process.exit(1);
}

// Stash everything except the wanted binary.
const stashed = [];
for (const f of fs.readdirSync(binDir)) {
  if (f === wanted) continue;
  const src = path.join(binDir, f);
  const dst = path.join(tmpDir, f);
  fs.renameSync(src, dst);
  stashed.push({ src, dst });
}

let ok = true;
try {
  console.log(`==> packaging target: ${target} (only bin/${wanted} included)`);
  execSync(`npx --yes @vscode/vsce package --target ${target} --out .`, {
    stdio: 'inherit',
    cwd: root,
  });
} catch (e) {
  ok = false;
  console.error('Packaging failed:', e?.message ?? e);
} finally {
  // Restore stashed binaries.
  for (const { src, dst } of stashed) {
    if (fs.existsSync(dst)) fs.renameSync(dst, src);
  }
  try { fs.rmdirSync(tmpDir); } catch {}
}

process.exit(ok ? 0 : 1);
