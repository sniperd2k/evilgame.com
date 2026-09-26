/**
 * Turbo automated playthroughs — attic + farm.
 *
 * Defaults (override via env):
 *   TURBO_SPEED=200   — game-time multiplier (?turbo=200)
 *   TURBO_RUNS=3      — playthroughs per game (happy / softlock stress / audio stress)
 *
 * Target: turbo suite under ~3 minutes wall time.
 * Re-enable later: attic.html?turbo=1 | localStorage evilgame.turbo | EvilTurbo.set(200)
 *
 * Run: node tests/turbo-playthrough.mjs
 *   or: npm run test:turbo
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

/** @type {number} hundreds× — high enough for fast cinema, low enough for hooks/collisions */
const TURBO_SPEED = Math.max(1, Number(process.env.TURBO_SPEED) || 200);
/** @type {number} runs per game covering happy + softlock + audio */
const TURBO_RUNS = Math.max(1, Math.min(10, Number(process.env.TURBO_RUNS) || 3));

const ATTIC = pathToFileURL(path.join(ROOT, 'attic.html')).href + '?turbo=' + TURBO_SPEED;
const FARM = pathToFileURL(path.join(ROOT, 'farm.html')).href + '?turbo=' + TURBO_SPEED;

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

async function waitFor(page, pred, ms = 20000, label = 'ready') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(pred)) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timeout waiting for ' + label);
}

async function withPage(browser, url, label, fn) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitFor(
    page,
    () => !!(window.EvilTurbo && window.EvilTurbo.isOn() && (window.__AFG_ATTIC__ || window.__MANDY_STORE__)),
    20000,
    label
  );
  try {
    const result = await fn(page);
    assert(errors.length === 0, label + ' pageerrors: ' + errors.join(' | '));
    return result;
  } finally {
    await page.close();
  }
}

/* ---------- Attic scenarios ---------- */

async function atticHappy(browser) {
  return withPage(browser, ATTIC, 'attic-happy', async (page) => {
    const r = await page.evaluate(() => {
      const api = window.__AFG_ATTIC__;
      const out = { name: 'attic-happy', ok: true, failures: [] };
      function check(c, m) { if (!c) { out.ok = false; out.failures.push(m); } }

      api.resetAll();
      check(api.getTurbo().on && api.getTurbo().rate >= 100, 'turbo on');

      // Grow → belch → salad → home
      api.forceTooBigBelch();
      api.enterBelchertownRoom();
      check(api.getState().scene === 'belch', 'belch scene');

      const shout = api.eatLastBelchItem();
      check(shout.saladClosing, 'salad closing');
      check(shout.saladShouted, 'salad shouted');
      check(shout.lastSfx && /dont-like-salad/.test(shout.lastSfx.url || ''), 'salad sfx');

      api.tickMany(4.0);
      check(api.getState().scene === 'attic', 'back to attic: ' + api.getState().scene);
      check(api.getVoicePriority() === false, 'mic clear');
      return out;
    });
    assert(r.ok, r.name + ': ' + r.failures.join(' | '));
    return r;
  });
}

async function atticSoftlockStress(browser) {
  return withPage(browser, ATTIC, 'attic-softlock', async (page) => {
    const r = await page.evaluate(() => {
      const api = window.__AFG_ATTIC__;
      const out = { name: 'attic-softlock', ok: true, failures: [] };
      function check(c, m) { if (!c) { out.ok = false; out.failures.push(m); } }

      api.resetAll();
      // Rapid edge spam + salad interrupt path
      api.setScore(20);
      api.setSize(2.0);
      for (let i = 0; i < 30; i++) api.forceEdgeTouch();
      check(api.getScore() >= 0, 'score non-negative');
      check(Number.isFinite(api.getState().player.x), 'finite x');

      api.forceTooBigBelch();
      api.enterBelchertownRoom();
      // Eat last while spamming edges during close
      api.eatLastBelchItem();
      for (let i = 0; i < 40; i++) {
        api.forceEdgeTouch();
        api.tickMany(0.1);
        if (api.getState().scene === 'attic') break;
      }
      // Ensure completion even if edges ate time
      if (api.getState().scene === 'belch') {
        api.tickMany(5);
      }
      check(api.getState().scene === 'attic', 'escaped belch softlock: ' + api.getState().scene);
      api.setScore(3);
      const edge = api.forceEdgeTouch();
      check(edge.bounceT > 0, 'still interactive after stress');
      return out;
    });
    assert(r.ok, r.name + ': ' + r.failures.join(' | '));
    return r;
  });
}

async function atticAudioStress(browser) {
  return withPage(browser, ATTIC, 'attic-audio', async (page) => {
    const r = await page.evaluate(() => {
      const api = window.__AFG_ATTIC__;
      const out = { name: 'attic-audio', ok: true, failures: [], sfxLog: [] };
      function check(c, m) { if (!c) { out.ok = false; out.failures.push(m); } }

      api.resetAll();
      // Burst of nug eats → slurps/burps shouldn't throw; priority salad must still record
      for (let i = 0; i < 12; i++) api.eatNugAt(i);
      out.sfxLog.push(api.getLastSfx());

      const shout = api.triggerSaladShout();
      out.sfxLog.push(shout.lastSfx);
      check(shout.lastSfx && shout.lastSfx.url === 'sfx/dont-like-salad.wav', 'priority salad url');
      check(shout.lastSfx.priority === true, 'priority flag');
      check(api.getVoicePriority() === true, 'mic locked for priority');

      // Turbo game-time must release mic (wall-clock ended may never fire headless)
      api.tickMany(3.2);
      check(api.getVoicePriority() === false, 'mic unlocked after game-time TTL');

      // Lesser sfx can play again
      api.playDontLikeSalad(); // priority again
      api.tickMany(3.2);
      check(api.getVoicePriority() === false, 'mic unlocked second cycle');
      return out;
    });
    assert(r.ok, r.name + ': ' + r.failures.join(' | '));
    return r;
  });
}

/* ---------- Farm scenarios ---------- */

async function farmHappy(browser) {
  return withPage(browser, FARM, 'farm-happy', async (page) => {
    const r = await page.evaluate(() => {
      const api = window.__MANDY_STORE__;
      const out = { name: 'farm-happy', ok: true, failures: [], cinemaFrames: 0 };
      function check(c, m) { if (!c) { out.ok = false; out.failures.push(m); } }

      check(api.getTurbo().on, 'turbo on');
      const st = api.getState();
      st.score = 2;
      st.lastRonnieAt = 0;
      st.catsNeeded = 1;
      if (!st.cats.length) {
        st.cats.push({
          x: 200, y: 200, r: 12, vx: 0, vy: 0,
          color: { body: '#e8a060', belly: '#f0d0a0', ear: '#d08050' },
          meowCd: 0, wobble: 0, exiting: false, exitT: 0, stuckT: 0, idleStuck: 0
        });
      }
      api.catExited(st.cats[0]);
      check(api.getState().mode === 'ronnie_intro', 'ronnie intro');
      const sfx = api.getLastSfx();
      check(sfx && sfx.url === 'sfx/cockadoodle.wav', 'cockadoodle: ' + JSON.stringify(sfx));

      let guard = 0;
      while (api.getState().mode !== 'play' && guard < 4000) {
        api.tick(1 / 60);
        guard++;
      }
      out.cinemaFrames = guard;
      check(api.getState().mode === 'play', 'back to play');
      check(api.getVoicePriority() === false, 'mic clear');

      const p0 = { x: api.getState().player.x, y: api.getState().player.y };
      api.setKey('d', true);
      api.tickMany(0.4);
      api.setKey('d', false);
      const p1 = api.getState().player;
      check(Math.abs(p1.x - p0.x) > 1, 'moves after cinema');
      return out;
    });
    assert(r.ok, r.name + ': ' + r.failures.join(' | '));
    return r;
  });
}

async function farmSoftlockStress(browser) {
  return withPage(browser, FARM, 'farm-softlock', async (page) => {
    const r = await page.evaluate(() => {
      const api = window.__MANDY_STORE__;
      const out = { name: 'farm-softlock', ok: true, failures: [] };
      function check(c, m) { if (!c) { out.ok = false; out.failures.push(m); } }

      // Classic input-lock: drag active when Ronnie starts
      api.getState().dragging = true;
      api.setActivePointerId(99);
      const st = api.getState();
      st.score = 2;
      st.lastRonnieAt = 0;
      if (!st.cats.length) {
        st.cats.push({
          x: 180, y: 180, r: 12, vx: 0, vy: 0,
          color: { body: '#e8a060', belly: '#f0d0a0', ear: '#d08050' },
          meowCd: 0, wobble: 0, exiting: false, exitT: 0, stuckT: 0, idleStuck: 0
        });
      }
      api.catExited(st.cats[0]);
      check(api.getState().dragging === false, 'drag cleared on cinema');
      check(api.getActivePointerId() == null, 'pointer cleared');

      let guard = 0;
      while (api.getState().mode !== 'play' && guard < 4000) {
        api.tick(1 / 60);
        guard++;
      }
      check(api.getState().mode === 'play', 'cinema completed');
      check(!api.entityDeeplyStuck(api.getState().player), 'not stuck in shelves');

      // Immediately second cycle (stress soft-reset)
      const st2 = api.getState();
      st2.score = 5;
      st2.lastRonnieAt = 0;
      if (!st2.cats.length) {
        st2.cats.push({
          x: 200, y: 200, r: 12, vx: 0, vy: 0,
          color: { body: '#e8a060', belly: '#f0d0a0', ear: '#d08050' },
          meowCd: 0, wobble: 0, exiting: false, exitT: 0, stuckT: 0, idleStuck: 0
        });
      }
      api.catExited(st2.cats[0]);
      guard = 0;
      while (api.getState().mode !== 'play' && guard < 4000) {
        api.tick(1 / 60);
        guard++;
      }
      check(api.getState().mode === 'play', 'second cinema ok');

      api.setKey('w', true);
      api.setKey('a', true);
      api.tickMany(0.5);
      api.setKey('w', false);
      api.setKey('a', false);
      check(!api.entityDeeplyStuck(api.getState().player), 'mobile after double cinema');
      return out;
    });
    assert(r.ok, r.name + ': ' + r.failures.join(' | '));
    return r;
  });
}

async function farmAudioStress(browser) {
  return withPage(browser, FARM, 'farm-audio', async (page) => {
    const r = await page.evaluate(() => {
      const api = window.__MANDY_STORE__;
      const out = { name: 'farm-audio', ok: true, failures: [], sfx: [] };
      function check(c, m) { if (!c) { out.ok = false; out.failures.push(m); } }

      // Meow spam under turbo must not Audio-storm / softlock mic for cockadoodle
      const st = api.getState();
      st.mode = 'play';
      for (let i = 0; i < 8; i++) {
        st.cats.push({
          x: 100 + i * 20, y: 200, r: 12, vx: 1, vy: 1,
          color: { body: '#e8a060', belly: '#f0d0a0', ear: '#d08050' },
          meowCd: 0, wobble: 0, exiting: false, exitT: 0, stuckT: 0, idleStuck: 0
        });
      }
      api.tickMany(1.0); // meows fire
      out.sfx.push(api.getLastSfx());

      st.score = 2;
      st.lastRonnieAt = 0;
      const cat = st.cats.find((c) => !c.exiting) || st.cats[0];
      api.catExited(cat);
      const crow = api.getLastSfx();
      out.sfx.push(crow);
      check(crow && crow.url === 'sfx/cockadoodle.wav', 'priority crow after meow spam');
      check(crow.priority === true, 'crow priority');
      check(api.getVoicePriority() === true, 'mic locked');

      // Game-time TTL (~2.5s under turbo) must release even mid-cinema.
      api.tickMany(3.0);
      check(api.getVoicePriority() === false, 'mic released (game-time TTL)');

      // Finish cinema — restorePlayControl also clears mic as belt-and-suspenders
      let guard = 0;
      while (api.getState().mode !== 'play' && guard < 4000) {
        api.tick(1 / 60);
        guard++;
      }
      check(api.getState().mode === 'play', 'cinema finished after audio stress');
      check(api.getVoicePriority() === false, 'mic clear after restorePlayControl');
      return out;
    });
    assert(r.ok, r.name + ': ' + r.failures.join(' | '));
    return r;
  });
}

const ATTIC_SCENARIOS = [atticHappy, atticSoftlockStress, atticAudioStress];
const FARM_SCENARIOS = [farmHappy, farmSoftlockStress, farmAudioStress];

async function main() {
  const t0 = Date.now();
  console.log(JSON.stringify({
    TURBO_SPEED,
    TURBO_RUNS,
    reasoning: '200× finishes ~30s cinema in ~0.15s of ticks; 3 runs/game = happy+softlock+audio; toggle via ?turbo=1 / localStorage / EvilTurbo.set'
  }));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--allow-file-access-from-files',
      '--autoplay-policy=no-user-gesture-required'
    ]
  });

  const results = [];
  try {
    const atticFns = ATTIC_SCENARIOS.slice(0, TURBO_RUNS);
    const farmFns = FARM_SCENARIOS.slice(0, TURBO_RUNS);

    for (const fn of atticFns) {
      console.log('run', fn.name, '…');
      results.push(await fn(browser));
    }
    for (const fn of farmFns) {
      console.log('run', fn.name, '…');
      results.push(await fn(browser));
    }

    const ms = Date.now() - t0;
    const failed = results.filter((r) => !r.ok);
    console.log(JSON.stringify({
      ok: failed.length === 0,
      wallMs: ms,
      wallSec: +(ms / 1000).toFixed(2),
      runs: results.map((r) => ({ name: r.name, ok: r.ok, failures: r.failures || [] }))
    }, null, 2));
    if (failed.length) process.exit(1);
    console.log('turbo-playthrough: ok');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
