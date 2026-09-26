/**
 * EvilTurbo unit tests (no browser).
 * Run: node tests/turbo-unit.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Turbo = require(path.join(__dirname, '..', 'afg', 'turbo.js'));

assert.equal(Turbo.parseRate(1), Turbo.DEFAULT_RATE, 'turbo=1 → default hundreds×');
assert.equal(Turbo.parseRate(300), 300, 'numeric rate');
assert.equal(Turbo.parseRate(0), 0, '0 off');
assert.equal(Turbo.parseRate(false), 0, 'false off');
assert.equal(Turbo.parseRate(true), Turbo.DEFAULT_RATE, 'true → default');

// Simulate global on
globalThis.__EVILGAME_TURBO__ = 250;
globalThis.__TEST__ = undefined;
const r = Turbo.refresh();
assert.equal(r.on, true, 'on from global');
assert.equal(r.rate, 250, 'rate 250');
assert.equal(Turbo.stepsPerFrame(), 250, 'steps');
assert.equal(Turbo.stepDt(), 1 / 60, 'fixed step');

globalThis.__EVILGAME_TURBO__ = 0;
Turbo.refresh();
assert.equal(Turbo.isOn(), false, 'off');

globalThis.__TEST__ = true;
delete globalThis.__EVILGAME_TURBO__;
Turbo.refresh();
assert.equal(Turbo.isOn(), true, '__TEST__ enables');
assert.equal(Turbo.rate(), Turbo.DEFAULT_RATE, '__TEST__ default rate');

// cleanup
delete globalThis.__TEST__;
Turbo.refresh();

console.log('turbo-unit: ok');
