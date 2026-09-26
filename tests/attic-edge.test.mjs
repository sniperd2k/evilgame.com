/**
 * Unit tests: Attic edge-bounce (−1) vs salad-zoom center-shrink (no point loss).
 * Run: node tests/attic-edge.test.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const Edge = require(path.join(__dirname, '..', 'afg', 'attic-edge.js'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function section(name, fn) {
  fn();
  console.log('  ok:', name);
}

console.log('attic-edge unit');

section('normal edge: −1 point + inward bounce + wobble', () => {
  const bounds = Edge.playBounds('attic', false, 34, 14, 640, 480);
  const before = { x: bounds.minX, y: 240 };
  const out = Edge.applyEdgeTouch({
    score: 12,
    size: 1.5,
    saladClosing: false,
    scene: 'attic',
    player: before,
    bounds,
    playerR: 14,
    W: 640,
    H: 480
  });
  assert(out.lostPoint === true, 'lost point');
  assert(out.score === 11, 'score 12→11');
  assert(out.bounced === true, 'bounced');
  assert(out.player.x > before.x, 'pushed inward from left');
  assert(out.bounceT > 0, 'wobble timer');
  assert(out.shrunk === false, 'no shrink in normal play');
  assert(out.size === 1.5, 'size unchanged');
});

section('normal edge: score clamps at 0', () => {
  const bounds = Edge.playBounds('attic', false, 34, 14, 640, 480);
  const out = Edge.applyEdgeTouch({
    score: 0,
    size: 1,
    saladClosing: false,
    player: { x: bounds.maxX, y: 200 },
    bounds,
    W: 640,
    H: 480
  });
  assert(out.score === 0, 'stays 0');
  assert(out.lostPoint === false, 'no loss flag when already 0');
  assert(out.player.x < bounds.maxX, 'bounced inward from right');
});

section('normal edge: negative input score still clamps', () => {
  const bounds = Edge.playBounds('attic', false, 34, 14, 640, 480);
  const out = Edge.applyEdgeTouch({
    score: -5,
    saladClosing: false,
    player: { x: bounds.minX, y: 100 },
    bounds,
    W: 640,
    H: 480
  });
  assert(out.score === 0, 'neg → 0');
});

section('salad zoom: no point loss + center + shrink', () => {
  const out = Edge.applyEdgeTouch({
    score: 40,
    size: 2.2,
    saladClosing: true,
    scene: 'belch',
    player: { x: 20, y: 20 },
    W: 640,
    H: 480
  });
  assert(out.lostPoint === false, 'no point loss');
  assert(out.score === 40, 'score unchanged');
  assert(out.player.x === 320 && out.player.y === 240, 'center');
  assert(out.shrunk === true, 'shrunk');
  assert(out.size < 2.2 && out.size >= Edge.SALAD_SIZE_FLOOR, 'size reduced');
  assert(Math.abs(out.size - 2.2 * Edge.SALAD_SHRINK_FACTOR) < 1e-9, 'factor applied');
});

section('salad zoom: size floor', () => {
  const out = Edge.applyEdgeTouch({
    score: 10,
    size: Edge.SALAD_SIZE_FLOOR,
    saladClosing: true,
    player: { x: 10, y: 10 },
    W: 640,
    H: 480
  });
  assert(out.size === Edge.SALAD_SIZE_FLOOR, 'floor held');
  assert(out.score === 10, 'score safe');
});

section('isEdgeContact detects walls', () => {
  assert(Edge.isEdgeContact({
    scene: 'attic',
    saladClosing: false,
    playerR: 14,
    player: { x: 14 + 8, y: 240 },
    W: 640,
    H: 480
  }) === true, 'left wall');
  assert(Edge.isEdgeContact({
    scene: 'attic',
    saladClosing: false,
    playerR: 14,
    player: { x: 320, y: 240 },
    W: 640,
    H: 480
  }) === false, 'center clear');
});

section('salad rim counts during closing', () => {
  assert(Edge.isEdgeContact({
    scene: 'belch',
    saladClosing: true,
    saladInset: 120,
    playerR: 14,
    player: { x: 120 + 4 + 14, y: 240 },
    W: 640,
    H: 480
  }) === true, 'on salad rim');
});

console.log('attic-edge: ok');
