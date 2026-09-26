/**
 * Integration: attic.html + AfgStore localStorage return-visit.
 * Run: node tests/afg-attic-persist.integration.mjs
 * Pref: Chrome at /usr/bin/google-chrome
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
    const ok = await page.evaluate(() => !!(window.AfgStore && window.__AFG_ATTIC__ && window.__AFG_ATTIC__.store));
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('__AFG_ATTIC__ / AfgStore not ready');
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
    // Seed legacy-shaped identity before first paint (return visitor).
    await page.goto('about:blank');
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('evilgame.attic.v1', JSON.stringify({
          nick: 'ReturnGoblin77',
          highScore: 88,
          niceSeen: true
        }));
      } catch (e1) {}
    });

    await page.goto(ATTIC, { waitUntil: 'domcontentloaded' });
    await waitForAttic(page);

    const visit1 = await page.evaluate(() => {
      const api = window.__AFG_ATTIC__;
      const p = api.getProfile();
      const hudNick = document.getElementById('nick').textContent;
      const hudHigh = document.getElementById('high').textContent;
      const slack = document.getElementById('slackPost');
      const raw = localStorage.getItem('evilgame.attic.v1');
      return {
        nick: p.nick,
        high: p.highScore,
        niceSeen: p.niceSeen,
        playCount: p.playCount,
        hudNick,
        hudHigh,
        slackOk: !!(slack && /POST TO SLACK/i.test(slack.textContent)),
        storeKey: api.store.key,
        adapter: api.store.adapter.name,
        raw: raw ? JSON.parse(raw) : null,
        afgGlobal: typeof window.AfgStore === 'function' || typeof window.AfgStore === 'object'
      };
    });

    assert(visit1.afgGlobal, 'AfgStore global present');
    assert(visit1.storeKey === 'evilgame.attic.v1', 'storage key');
    assert(visit1.adapter === 'localStorage', 'default adapter');
    assert(visit1.nick === 'ReturnGoblin77', 'profile nick restored');
    assert(visit1.high === 88, 'profile high restored');
    assert(visit1.niceSeen === true, 'niceSeen restored');
    assert(visit1.hudNick === 'ReturnGoblin77', 'HUD nick');
    assert(visit1.hudHigh === '88', 'HUD high');
    assert(visit1.slackOk, 'POST TO SLACK intact');
    assert(visit1.raw && visit1.raw.nick === 'ReturnGoblin77', 'raw ls nick');

    // Play: bump high live, then reset → recordScore bookkeeping.
    const afterPlay = await page.evaluate(() => {
      const api = window.__AFG_ATTIC__;
      api.setScore(120);
      api.bumpHighIfNeeded();
      api.hud();
      const midHigh = api.getProfile().highScore;
      const midHud = document.getElementById('high').textContent;
      api.resetAll();
      const p = api.getProfile();
      return {
        midHigh,
        midHud,
        high: p.highScore,
        lastScore: p.lastScore,
        playCount: p.playCount,
        lastPlayedAt: p.lastPlayedAt,
        scoreAfterReset: api.getScore(),
        snap: api.exportSnapshot()
      };
    });

    assert(afterPlay.midHigh === 120 && afterPlay.midHud === '120', 'live high bump');
    assert(afterPlay.high === 120, 'high kept after reset');
    assert(afterPlay.lastScore === 120, 'lastScore recorded');
    assert(afterPlay.playCount >= 1, 'playCount incremented');
    assert(typeof afterPlay.lastPlayedAt === 'string' && afterPlay.lastPlayedAt, 'lastPlayedAt');
    assert(afterPlay.scoreAfterReset === 0, 'run score cleared');
    assert(afterPlay.snap.adapter === 'localStorage', 'snapshot adapter');

    // Rename must not wipe scores.
    const renamed = await page.evaluate(() => {
      const api = window.__AFG_ATTIC__;
      let p = api.getProfile();
      p.nick = 'RenamedSpud';
      api.saveProfile();
      api.hud();
      p = api.getProfile();
      return {
        nick: p.nick,
        high: p.highScore,
        hudNick: document.getElementById('nick').textContent,
        hudHigh: document.getElementById('high').textContent
      };
    });
    assert(renamed.nick === 'RenamedSpud' && renamed.hudNick === 'RenamedSpud', 'rename');
    assert(renamed.high === 120 && renamed.hudHigh === '120', 'rename keeps high');

    // True return-visit: new page, same origin storage, no evaluateOnNewDocument seed.
    const page2 = await browser.newPage();
    page2.on('pageerror', (e) => errors.push('p2:' + String(e)));
    // Copy storage from page1 by reading then seeding page2 before navigation.
    const blob = await page.evaluate(() => localStorage.getItem('evilgame.attic.v1'));
    assert(blob && blob.indexOf('RenamedSpud') !== -1, 'persisted blob before revisit');

    await page2.evaluateOnNewDocument((stored) => {
      try { localStorage.setItem('evilgame.attic.v1', stored); } catch (e1) {}
    }, blob);

    await page2.goto(ATTIC, { waitUntil: 'domcontentloaded' });
    await waitForAttic(page2);

    const visit2 = await page2.evaluate(() => {
      const api = window.__AFG_ATTIC__;
      const p = api.getProfile();
      return {
        nick: p.nick,
        high: p.highScore,
        lastScore: p.lastScore,
        playCount: p.playCount,
        hudNick: document.getElementById('nick').textContent,
        hudHigh: document.getElementById('high').textContent
      };
    });

    assert(visit2.nick === 'RenamedSpud' && visit2.hudNick === 'RenamedSpud', 'revisit nick');
    assert(visit2.high === 120 && visit2.hudHigh === '120', 'revisit high');
    assert(visit2.lastScore === 120, 'revisit lastScore');
    assert(visit2.playCount >= 1, 'revisit playCount');

    await page2.close();

    assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
    console.log('afg-attic-persist.integration: ok');
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
