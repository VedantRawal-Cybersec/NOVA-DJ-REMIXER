import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['api', 'scripts', 'public/js'];

for (const dir of dirs) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) continue;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(entry.name)) {
        const res = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
        if (res.status !== 0) {
          console.error(`Syntax check failed for ${p}:\n${res.stderr}`);
          process.exit(1);
        }
        console.log(`OK: ${path.relative(root, p)}`);
      }
    }
  };
  walk(full);
}

const unit = spawnSync(process.execPath, [path.join(root, 'scripts/test-v2-engine.mjs')], { stdio: 'inherit' });
if (unit.status !== 0) process.exit(unit.status ?? 1);
