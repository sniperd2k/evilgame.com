/**
 * Unit tests: salad "I don't even like salad" shout must fire on zoom-in
 * with priority so Belchertown cannot mute it.
 * Run: node tests/attic-salad-sfx.test.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const Edge = require(path.join(ROOT, 'afg', 'attic-edge.js'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function section(name, fn) {
  fn();
  console.log('  ok:', name);
}

console.log('attic-salad-sfx unit');

section('shout URL + priority opts', () => {
  assert(Edge.saladShoutUrl() === 'sfx/dont-like-salad.wav', 'url');
  const opts = Edge.saladShoutSfxOpts();
  assert(opts && opts.priority === true, 'priority true');
});

section('onLastBelchItemEaten emits shout once', () => {
  const first = Edge.onLastBelchItemEaten({ saladShouted: false });
  assert(first.saladClosing === true, 'closing');
  assert(first.shouldPlaySaladShout === true, 'should play');
  assert(first.skipSlurp === true, 'skip slurp');
  assert(first.shoutOpts.priority === true, 'shout priority');
  assert(first.shoutUrl === 'sfx/dont-like-salad.wav', 'shout url');

  const second = Edge.onLastBelchItemEaten({ saladShouted: true });
  assert(second.shouldPlaySaladShout === false, 'no double shout');
  assert(second.saladClosing === true, 'still closing');
});

section('mic policy: lesser blocked, priority allowed', () => {
  assert(Edge.sfxAllowed(true, false) === false, 'blocked without priority');
  assert(Edge.sfxAllowed(true, true) === true, 'priority cuts through');
  assert(Edge.sfxAllowed(false, false) === true, 'idle allows lesser');
});

section('wav asset exists', () => {
  const wav = path.join(ROOT, 'sfx', 'dont-like-salad.wav');
  assert(fs.existsSync(wav), 'dont-like-salad.wav present');
  assert(fs.statSync(wav).size > 1000, 'wav non-trivial');
});

section('attic.html wires priority shout (shipping gate)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'attic.html'), 'utf8');
  assert(html.includes('afg/attic-edge.js'), 'loads attic-edge');
  assert(/function playDontLikeSalad\s*\(/.test(html), 'playDontLikeSalad defined');
  // Must pass opts with priority (via AtticEdge or literal).
  const fn = html.slice(html.indexOf('function playDontLikeSalad'));
  const body = fn.slice(0, fn.indexOf('function ', 10));
  assert(
    /saladShoutSfxOpts|priority:\s*true/.test(body),
    'playDontLikeSalad must request priority'
  );
  assert(!/playHtmlSfx\(\s*['"]sfx\/dont-like-salad\.wav['"]\s*,\s*1\s*\)\s*;/.test(body),
    'must not call playHtmlSfx salad URL without opts');
  assert(/onLastBelchItemEaten|shouldPlaySaladShout/.test(html), 'last-item path uses shout contract');
  assert(/I don't even like salad/.test(html), 'caption text present');
});

console.log('attic-salad-sfx: ok');
