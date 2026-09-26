/**
 * Shared test runner: AFG persist unit + attic integration + farm + optional gate.
 * Run: npm test
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const REQUIRED = [
  'tests/afg-persist.test.mjs',
  'tests/afg-attic-persist.integration.mjs',
  'tests/farm-input-lock.test.mjs',
  'tests/farm-ronnie-cycle.mjs'
];

// Gate executor may add these later — run when present, don't fail the suite if absent.
const OPTIONAL = [
  'tests/afg-gate.test.mjs',
  'tests/afg-gate.integration.mjs'
];

function runFile(rel) {
  const full = path.join(ROOT, rel);
  console.log('\n=== ' + rel + ' ===');
  const r = spawnSync(process.execPath, [full], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env
  });
  if (r.status !== 0) {
    console.error('FAIL:', rel, 'exit', r.status);
    process.exit(r.status || 1);
  }
}

for (const rel of REQUIRED) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    console.error('MISSING required test:', rel);
    process.exit(1);
  }
  runFile(rel);
}

for (const rel of OPTIONAL) {
  const full = path.join(ROOT, rel);
  if (fs.existsSync(full)) runFile(rel);
  else console.log('\n(skip optional, not present:', rel + ')');
}

console.log('\nAll tests passed.');
