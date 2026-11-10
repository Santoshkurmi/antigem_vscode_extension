// Package the extension for every supported 64-bit platform.
import { execSync } from 'node:child_process';

const targets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];
for (const t of targets) {
  console.log(`\n========== ${t} ==========`);
  execSync(`node scripts/package-target.mjs ${t}`, { stdio: 'inherit' });
}
console.log('\nAll platform packages built.');