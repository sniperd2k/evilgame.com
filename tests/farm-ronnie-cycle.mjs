/**
 * Mandy's Store — Ronnie cycle playtest
 *
 * Drives: catch 3 cats → Ronnie cinema → bounce/reshuffle → broom → soft reset
 * Asserts: after reset, Mandy moves under WASD; input lock cleared; not stuck.
 *
 * Run:  node tests/farm-ronnie-cycle.mjs
 * Pref: Chrome at /usr/bin/google-chrome
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FARM = pathToFileURL(path.join(ROOT, 'farm.html')).href;
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

async function waitForApi(page, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await page.evaluate(() => !!(window.__MANDY_STORE__ && window.__MANDY_STORE__.getState));
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('__MANDY_STORE__ API not ready');
}

async function run() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(FARM, { waitUntil: 'domcontentloaded' });
  await waitForApi(page);

  const result = await page.evaluate(async () => {
    const api = window.__MANDY_STORE__;
    const out = { steps: [], ok: true, failures: [] };

    function check(cond, msg) {
      if (!cond) {
        out.ok = false;
        out.failures.push(msg);
      }
    }

    function snap() {
      const s = api.getState();
      return {
        mode: s.mode,
        score: s.score,
        dragging: s.dragging,
        px: s.player.x,
        py: s.player.y,
        stuck: api.entityDeeplyStuck(s.player),
        ptr: api.getActivePointerId(),
        cats: s.cats.length,
        shelves: s.shelves.length
      };
    }

    function tickMany(seconds, dt) {
      dt = dt || 1 / 60;
      const n = Math.ceil(seconds / dt);
      for (let i = 0; i < n; i++) api.tick(dt);
    }

    // --- Simulate the classic bug: drag active when Ronnie triggers ---
    api.getState().dragging = true;
    api.setActivePointerId(42);
    out.steps.push({ at: 'pre-ronnie-drag', ...snap() });

    // Force score to 2, then exit one more cat to hit 3 → Ronnie
    const st = api.getState();
    st.score = 2;
    st.lastRonnieAt = 0;
    st.catsNeeded = 1;
    // Ensure at least one live cat
    if (!st.cats.length) {
      st.cats.push({
        x: 200, y: 200, r: 12, vx: 0, vy: 0,
        color: { body: '#e8a060', belly: '#f0d0a0', ear: '#d08050' },
        meowCd: 0, wobble: 0, exiting: false, exitT: 0, stuckT: 0, idleStuck: 0
      });
    }
    const cat = st.cats.find((c) => !c.exiting) || st.cats[0];
    api.catExited(cat);
    out.steps.push({ at: 'after-3rd-cat', ...snap() });
    check(api.getState().mode === 'ronnie_intro', 'Ronnie intro should start at score 3');
    check(api.getState().dragging === false, 'dragging cleared when cinema starts');
    check(api.getActivePointerId() == null, 'activePointerId cleared when cinema starts (root-cause fix)');

    // Drive full cinema until soft reset → play
    let guard = 0;
    while (api.getState().mode !== 'play' && guard < 1200) {
      api.tick(1 / 60);
      guard++;
      // Soft-reset is one frame; if we land on play mid-loop, break
      if (api.getState().mode === 'play' && guard > 10) break;
    }
    out.steps.push({ at: 'after-cinema', frames: guard, ...snap() });
    check(api.getState().mode === 'play', 'mode should be play after Ronnie cycle');
    check(api.getActivePointerId() == null, 'pointer id still clear after cinema');
    check(api.getState().dragging === false, 'not dragging after cinema');
    check(api.getState().ronnie == null, 'Ronnie gone after broom');
    check(api.getState().cats.length >= 1, 'one cat snuck back after soft reset');
    check(!api.entityDeeplyStuck(api.getState().player), 'Mandy not deeply stuck after reshuffle');

    // Assert WASD movement works after reset
    const before = { x: api.getState().player.x, y: api.getState().player.y };
    api.setKey('d', true);
    tickMany(0.5);
    api.setKey('d', false);
    const mid = { x: api.getState().player.x, y: api.getState().player.y };
    api.setKey('w', true);
    tickMany(0.5);
    api.setKey('w', false);
    const after = { x: api.getState().player.x, y: api.getState().player.y };

    const movedX = Math.abs(mid.x - before.x) > 2 || Math.abs(after.x - before.x) > 2;
    const movedY = Math.abs(after.y - mid.y) > 2 || Math.abs(after.y - before.y) > 2;
    const moved = movedX || movedY;
    out.movement = { before, mid, after, movedX, movedY, moved };
    check(moved, 'Mandy position must change under WASD after Ronnie reset');
    check(api.getState().mode === 'play', 'still in play while moving');
    check(!api.entityDeeplyStuck(api.getState().player), 'Mandy not stuck after moving');

    // Simulate stale pointer id AFTER reset would have been fatal before fix;
    // restorePlayControl / releaseInputLock must keep it clear; if test sets it,
    // a fresh "down" path is validated via releaseInputLock.
    api.setActivePointerId(99);
    api.releaseInputLock();
    check(api.getActivePointerId() == null, 'releaseInputLock clears stale pointer id');

    // Second Ronnie cycle smoke (score 6)
    api.getState().score = 5;
    api.getState().lastRonnieAt = 3;
    if (!api.getState().cats.length) {
      api.getState().cats.push({
        x: 220, y: 220, r: 12, vx: 0, vy: 0,
        color: { body: '#c8c8d0', belly: '#f0f0f4', ear: '#a8a8b0' },
        meowCd: 0, wobble: 0, exiting: false, exitT: 0, stuckT: 0, idleStuck: 0
      });
    }
    api.setActivePointerId(7);
    api.getState().dragging = true;
    const c2 = api.getState().cats.find((c) => !c.exiting) || api.getState().cats[0];
    api.catExited(c2);
    check(api.getState().mode === 'ronnie_intro', 'second Ronnie cycle starts');
    check(api.getActivePointerId() == null, 'pointer cleared on second cinema');
    guard = 0;
    while (api.getState().mode !== 'play' && guard < 1200) {
      api.tick(1 / 60);
      guard++;
    }
    const b2 = { x: api.getState().player.x, y: api.getState().player.y };
    api.setKey('a', true);
    tickMany(0.45);
    api.setKey('a', false);
    const a2 = { x: api.getState().player.x, y: api.getState().player.y };
    out.secondCycle = { frames: guard, before: b2, after: a2, moved: Math.abs(a2.x - b2.x) > 2 };
    check(out.secondCycle.moved, 'Mandy moves after second Ronnie cycle');

    out.final = snap();
    return out;
  });

  await browser.close();

  if (errors.length) {
    console.error('PAGE ERRORS:', errors);
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok || errors.length) {
    console.error('FAIL', result.failures);
    process.exit(1);
  }
  console.log('PASS farm-ronnie-cycle');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
