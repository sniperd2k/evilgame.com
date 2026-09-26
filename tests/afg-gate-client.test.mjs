/**
 * Unit tests for afg/gate.js client helpers (normalize + overlay factory shape).
 * Run: node tests/afg-gate-client.test.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AfgGate = require(path.join(__dirname, '..', 'afg', 'gate.js'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(AfgGate.normalizePassword('  Hi  ') === 'hi', 'normalize');
assert(AfgGate.normalizePassword(null) === '', 'null');
assert(AfgGate.COOKIE_NAME === 'afg_unlock', 'cookie name');
assert(AfgGate.CGI === 'check_afg.py', 'cgi path');
assert(typeof AfgGate.checkUnlocked === 'function', 'checkUnlocked');
assert(typeof AfgGate.submitPassword === 'function', 'submitPassword');
assert(typeof AfgGate.createOverlay === 'function', 'createOverlay');

// Overlay needs a DOM — skip full create when no document (node).
if (typeof document !== 'undefined') {
  const el = AfgGate.createOverlay({ title: 'T' });
  assert(el.className === 'afg-gate', 'overlay class');
  assert(el.querySelector('#afgGatePw'), 'password input');
  const input = el.querySelector('#afgGatePw');
  assert(input.getAttribute('enterkeyhint') === 'go', 'enterkeyhint');
  assert(input.getAttribute('autocomplete') === 'off', 'autocomplete');
  assert(input.getAttribute('inputmode') === 'text', 'inputmode');
}

console.log('afg-gate-client: ok');
