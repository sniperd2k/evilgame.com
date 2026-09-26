/** Optional gate tests — no-op until the gate executor lands files. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['tests/afg-gate.test.mjs', 'tests/afg-gate.integration.mjs']
  .map((f) => path.join(root, f))
  .filter((f) => fs.existsSync(f));

if (!files.length) {
  console.log('no gate tests yet');
  process.exit(0);
}

for (const full of files) {
  console.log('===', path.relative(root, full), '===');
  const r = spawnSync(process.execPath, [full], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
