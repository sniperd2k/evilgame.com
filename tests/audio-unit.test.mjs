/**
 * EvilAudio manager unit tests (event-driven, turbo-safe mic).
 * Run: node tests/audio-unit.test.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import assert from 'assert';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EvilAudio = require(path.join(ROOT, 'afg', 'audio.js'));
const Turbo = require(path.join(ROOT, 'afg', 'turbo.js'));

function section(name, fn) {
  fn();
  console.log('  ok:', name);
}

console.log('audio-unit');

section('create + register + fire salad priority', () => {
  const a = EvilAudio.create({
    name: 't',
    urls: ['sfx/dont-like-salad.wav', 'sfx/slurp1.wav'],
    priorityTtl: 6,
    turboPriorityTtl: 2.8
  });
  a.register('salad', { url: 'sfx/dont-like-salad.wav', priority: true });
  a.register('slurp', { url: 'sfx/slurp1.wav', vol: 0.95 });
  const r = a.fire('salad');
  assert.equal(r.played, true);
  assert.equal(a.getLastSfx().url, 'sfx/dont-like-salad.wav');
  assert.equal(a.getLastSfx().priority, true);
  assert.equal(a.hasVoicePriority(), true);
});

section('mic blocks lesser while priority owns', () => {
  const a = EvilAudio.create({ name: 't2', priorityTtl: 6, turboPriorityTtl: 2.8 });
  a.register('salad', { url: 'sfx/dont-like-salad.wav', priority: true });
  a.register('slurp', { url: 'sfx/slurp1.wav' });
  a.fire('salad');
  const blocked = a.fire('slurp');
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.reason, 'mic-blocked');
});

section('game-time tick releases mic (turbo desync-safe)', () => {
  const a = EvilAudio.create({ name: 't3', priorityTtl: 6, turboPriorityTtl: 2.5 });
  a.register('crow', {
    url: 'sfx/cockadoodle.wav',
    priority: true,
    turboSkipIfBusy: true,
    turboHoldTtl: true
  });
  globalThis.__EVILGAME_TURBO__ = 200;
  Turbo.refresh();
  assert.ok(Turbo.isOn());
  a.fire('crow');
  assert.equal(a.hasVoicePriority(), true);
  const skip = a.fire('crow');
  assert.equal(skip.reason, 'turbo-busy');
  a.tick(2.6);
  assert.equal(a.hasVoicePriority(), false);
  globalThis.__EVILGAME_TURBO__ = 0;
  Turbo.refresh();
});

section('html pages load audio.js + fire cues', () => {
  for (const f of ['attic.html', 'farm.html', 'index.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(html.includes('afg/audio.js'), f + ' loads audio.js');
    assert.ok(html.includes('EvilAudio.create'), f + ' creates manager');
  }
  const attic = fs.readFileSync(path.join(ROOT, 'attic.html'), 'utf8');
  assert.ok(/audio\.fire\(\s*['"]salad['"]/.test(attic), 'attic fires salad');
  const farm = fs.readFileSync(path.join(ROOT, 'farm.html'), 'utf8');
  assert.ok(/audio\.fire\(\s*['"]meow['"]/.test(farm), 'farm fires meow');
  assert.ok(/audio\.fire\(\s*['"]crow['"]/.test(farm), 'farm fires crow');
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(/menuAudio\.fire\(\s*['"]gay['"]/.test(idx) || /playUntilEnd/.test(idx), 'index gay path');
  assert.ok(/menuAudio\.fire\(\s*['"]boom['"]/.test(idx), 'index boom path');
});

section('attic playDontLikeSalad still requests priority', () => {
  const html = fs.readFileSync(path.join(ROOT, 'attic.html'), 'utf8');
  const fn = html.slice(html.indexOf('function playDontLikeSalad'));
  const body = fn.slice(0, fn.indexOf('function ', 10));
  assert.ok(/saladShoutSfxOpts|priority:\s*true|priority !== false/.test(body), 'priority');
});

console.log('audio-unit: ok');
