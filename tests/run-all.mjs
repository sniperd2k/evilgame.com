/**
 * Shared test runner: AFG persist unit + attic integration + farm + gate.
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
  'tests/attic-edge.test.mjs',
  'tests/attic-salad-sfx.test.mjs',
  'tests/attic-endgame.integration.mjs',
  'tests/farm-input-lock.test.mjs',
  'tests/farm-ronnie-cycle.mjs',
  'tests/audio-unit.test.mjs',
  'tests/turbo-unit.test.mjs',
  'tests/turbo-playthrough.mjs'
];

const OPTIONAL = [
  'tests/afg-gate-client.test.mjs',
  'tests/afg-gate-unit.py',
  'tests/afg-gate-integration.mjs',
  'tests/play-log-unit.py',
  'tests/play-log-client.test.mjs',
  // legacy names from harness scaffold
  'tests/afg-gate.test.mjs',
  'tests/afg-gate.integration.mjs'
];

function runNode(rel) {
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

function runPy(rel) {
  const full = path.join(ROOT, rel);
  console.log('\n=== ' + rel + ' ===');
  const r = spawnSync('python3', [full], {
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
  runNode(rel);
}

const seen = new Set();
for (const rel of OPTIONAL) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full) || seen.has(full)) {
    if (!fs.existsSync(full)) console.log('\n(skip optional, not present:', rel + ')');
    continue;
  }
  seen.add(full);
  if (rel.endsWith('.py')) runPy(rel);
  else runNode(rel);
}

console.log('\nAll tests passed.');
