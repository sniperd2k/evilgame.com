/**
 * Integration: attic edge-bounce + salad zoom shout via __AFG_ATTIC__.
 * Run: node tests/attic-endgame.integration.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ATTIC = pathToFileURL(path.join(ROOT, 'attic.html')).href;
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

async function waitForAttic(page, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await page.evaluate(
      () => !!(window.__AFG_ATTIC__ && window.AtticEdge && window.__AFG_ATTIC__.forceEdgeTouch)
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('__AFG_ATTIC__ / AtticEdge not ready');
}

async function run() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await page.goto(ATTIC, { waitUntil: 'domcontentloaded' });
    await waitForAttic(page);

    // (a) Normal play: edge touch loses 1 point (clamp style).
    const normal = await page.evaluate(() => {
      const api = window.__AFG_ATTIC__;
      api.resetAll();
      api.setScore(10);
      api.setSize(1.2);
      api.setSaladClosing(false);
      api.setScene('attic');
      const before = api.getState();
      const after = api.forceEdgeTouch();
      return { before, after, score: api.getScore(), size: api.getSize() };
    });
    assert(normal.before.score === 10, 'seed score');
    assert(normal.score === 9, 'normal edge −1');
    assert(normal.size === 1.2, 'normal no shrink');
    assert(normal.after.bounceT > 0, 'wobble armed');
    assert(
      Math.abs(normal.after.player.x - 320) > 5 || Math.abs(normal.after.player.y - 240) > 5,
      'not teleported to center in normal play'
    );

    // Score already 0 → stays 0
    const clamped = await page.evaluate(() => {
      const api = window.__AFG_ATTIC__;
      api.setScore(0);
      api.forceEdgeTouch();
      return api.getScore();
    });
    assert(clamped === 0, 'edge at 0 stays 0');

    // (b) Salad zoom: no point loss, center bounce, shrink + shout.
    const salad = await page.evaluate(() => {
      const api = window.__AFG_ATTIC__;
      api.resetAll();
      api.setScore(25);
      api.setSize(2.5);
      const shout = api.eatLastBelchItem();
      const scoreAfterLoot = api.getScore();
      const sizeBeforeEdge = api.getSize();
      const st = api.getState();
      const edge = api.forceEdgeTouch();
      return {
        shout,
        st,
        edge,
        scoreAfterLoot,
        scoreAfterEdge: api.getScore(),
        sizeBeforeEdge,
        sizeAfterEdge: api.getSize(),
        lastSfx: api.getLastSfx()
      };
    });

    assert(salad.shout.saladClosing === true, 'salad closing after last item');
    assert(salad.shout.saladShouted === true, 'saladShouted');
    assert(
      /don't even like salad/i.test(salad.shout.msg || ''),
      'msg caption: ' + salad.shout.msg
    );
    assert(
      salad.shout.lastSfx && salad.shout.lastSfx.url === 'sfx/dont-like-salad.wav',
      'sfx url: ' + JSON.stringify(salad.shout.lastSfx)
    );
    assert(salad.shout.lastSfx.priority === true, 'sfx priority');
    assert(salad.scoreAfterLoot === 20, 'loot −5 from 25');
    assert(salad.scoreAfterEdge === salad.scoreAfterLoot, 'no point loss during salad zoom edge');
    assert(salad.sizeAfterEdge < salad.sizeBeforeEdge, 'shrunk on salad edge');
    assert(
      Math.abs(salad.edge.player.x - 320) < 1 && Math.abs(salad.edge.player.y - 240) < 1,
      'center bounce'
    );

    // Priority cuts through Belchertown mic lock (simulate voicePriority).
    const priorityCut = await page.evaluate(() => {
      const api = window.__AFG_ATTIC__;
      // Re-trigger shout path after resetting shouted flag via triggerSaladShout
      return api.triggerSaladShout();
    });
    assert(priorityCut.lastSfx.url === 'sfx/dont-like-salad.wav', 're-shout url');
    assert(priorityCut.lastSfx.priority === true, 're-shout priority');

    assert(errors.length === 0, 'page errors: ' + errors.join(' | '));
    console.log('attic-endgame.integration: ok');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
