/** Gate unit + integration (JS client, Python CGI logic, CGI integration). */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'tests/afg-gate-client.test.mjs',
  'tests/afg-gate-unit.py',
  'tests/afg-gate-integration.mjs'
];

let ran = 0;
for (const rel of files) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    console.log('missing', rel);
    process.exit(1);
  }
  console.log('===', rel, '===');
  const cmd = rel.endsWith('.py') ? 'python3' : process.execPath;
  const r = spawnSync(cmd, [full], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
  ran++;
}
console.log('gate tests passed (' + ran + ')');
