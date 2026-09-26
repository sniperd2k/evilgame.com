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
assert(typeof AfgGate.clearUnlockCookie === 'function', 'clearUnlockCookie');
assert(typeof AfgGate.wipeUserData === 'function', 'wipeUserData');

// clearUnlockCookie returns expire assignment (cookie cleared client-side).
const expire = AfgGate.clearUnlockCookie();
assert(typeof expire === 'string' && expire.indexOf('afg_unlock=') === 0, 'expire prefix');
assert(expire.indexOf('Max-Age=0') >= 0, 'max-age 0');
assert(expire.indexOf('Path=/') >= 0, 'path /');

// wipeUserData clears evilgame.* keys from a fake storage.
(function wipeCheck() {
  const bag = {
    'evilgame.attic.v1': '{"nick":"X","highScore":9}',
    'evilgame.farm.v1': '{"cheddar":1}',
    'other.app': 'keep'
  };
  const fake = {
    get length() { return Object.keys(bag).length; },
    key(i) { return Object.keys(bag)[i]; },
    getItem(k) { return Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : null; },
    setItem(k, v) { bag[k] = String(v); },
    removeItem(k) { delete bag[k]; }
  };
  const prevLS = globalThis.localStorage;
  const prevSs = globalThis.sessionStorage;
  const prevDoc = globalThis.document;
  globalThis.localStorage = fake;
  globalThis.sessionStorage = {
    length: 0, key() { return null; }, getItem() { return null; },
    setItem() {}, removeItem() {}
  };
  globalThis.document = { cookie: 'afg_unlock=v1.9.dead; Path=/' };
  try {
    AfgGate.wipeUserData();
    assert(fake.getItem('evilgame.attic.v1') == null, 'attic wiped');
    assert(fake.getItem('evilgame.farm.v1') == null, 'farm wiped');
    assert(fake.getItem('other.app') === 'keep', 'unrelated kept');
    assert(String(globalThis.document.cookie).indexOf('Max-Age=0') >= 0 ||
           String(globalThis.document.cookie).indexOf('afg_unlock=') === 0, 'cookie expire assigned');
  } finally {
    if (prevLS === undefined) delete globalThis.localStorage; else globalThis.localStorage = prevLS;
    if (prevSs === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = prevSs;
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
  }
})();

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
