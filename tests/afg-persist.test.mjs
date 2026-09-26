/**
 * Unit tests for AFG persistence framework (afg/persist.js).
 * Run: node tests/afg-persist.test.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AfgStore = require(path.join(__dirname, '..', 'afg', 'persist.js'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function section(name, fn) {
  fn();
  console.log('  ok:', name);
}

function run() {
  console.log('afg-persist unit');

  section('legacy attic key + defaults', () => {
    const mem = new AfgStore.MemoryAdapter();
    const store = AfgStore.create({
      gameId: 'attic',
      adapter: mem,
      defaultProfile: () => ({ nick: 'TestGoblin99', highScore: 0 })
    });
    assert(store.key === 'evilgame.attic.v1', 'legacy attic key');
    const p = store.getProfile();
    assert(p.nick === 'TestGoblin99', 'default nick');
    assert(p.highScore === 0 && p.lastScore === 0 && p.playCount === 0, 'zero scores');
    assert(p.lastPlayedAt === null && p.niceSeen === false, 'null played / nice');
  });

  section('farm key is separate', () => {
    const mem = new AfgStore.MemoryAdapter();
    const attic = AfgStore.create({ gameId: 'attic', adapter: mem });
    const farm = AfgStore.create({ gameId: 'farm', adapter: mem });
    assert(farm.key === 'evilgame.farm.v1', 'farm key');
    attic.setProfile({ nick: 'AtticGuy', highScore: 10 });
    farm.setProfile({ nick: 'FarmGal', highScore: 3 });
    assert(attic.getProfile().nick === 'AtticGuy' && attic.getHighScore() === 10, 'attic isolated');
    assert(farm.getProfile().nick === 'FarmGal' && farm.getHighScore() === 3, 'farm isolated');
  });

  section('legacy blob migration', () => {
    const mem = new AfgStore.MemoryAdapter();
    mem.set('evilgame.attic.v1', JSON.stringify({
      nick: 'OldNick',
      highScore: 69,
      niceSeen: true
    }));
    const store = AfgStore.create({ gameId: 'attic', adapter: mem });
    const p = store.getProfile();
    assert(p.nick === 'OldNick' && p.highScore === 69 && p.niceSeen === true, 'legacy fields');
    assert(p.lastScore === 0 && p.playCount === 0 && p.lastPlayedAt === null, 'new field defaults');
  });

  section('corrupt / empty storage falls back', () => {
    const mem = new AfgStore.MemoryAdapter();
    mem.set('evilgame.attic.v1', '{not-json');
    const store = AfgStore.create({
      gameId: 'attic',
      adapter: mem,
      defaultProfile: () => ({ nick: 'FreshNick', highScore: 0 })
    });
    assert(store.getProfile().nick === 'FreshNick', 'corrupt → default');
  });

  section('sanitize nick + clamp scores', () => {
    assert(AfgStore.sanitizeNick('  Ab  Cd  ', 'X') === 'Ab Cd', 'collapse spaces');
    assert(AfgStore.sanitizeNick('x'.repeat(40), 'X').length === 18, 'nick max 18');
    assert(AfgStore.sanitizeNick('   ', 'Fallback') === 'Fallback', 'blank → fallback');
    assert(AfgStore.clampScore(-3) === 0, 'neg → 0');
    assert(AfgStore.clampScore(1.9) === 1, 'floor');
    assert(AfgStore.clampScore(1e9) === 999999, 'cap');
    assert(AfgStore.clampScore(NaN) === 0, 'NaN → 0');
  });

  section('high score never drops; rename keeps scores', () => {
    const store = AfgStore.create({
      gameId: 'attic',
      adapter: new AfgStore.MemoryAdapter(),
      defaultProfile: () => ({ nick: 'A', highScore: 0 })
    });
    store.setHighScore(100);
    assert(store.getHighScore() === 100, 'set high');
    store.setHighScore(50);
    assert(store.getHighScore() === 100, 'never drops');
    store.setProfile({ nick: '  New Name  ' });
    const p = store.getProfile();
    assert(p.nick === 'New Name' && p.highScore === 100, 'rename keeps high');
  });

  section('recordScore bookkeeping', () => {
    const store = AfgStore.create({
      gameId: 'attic',
      adapter: new AfgStore.MemoryAdapter(),
      defaultProfile: () => ({ nick: 'R', highScore: 0 })
    });
    const r1 = store.recordScore(120);
    assert(r1.isNewHigh === true && r1.profile.highScore === 120, 'new high');
    assert(r1.profile.lastScore === 120 && r1.profile.playCount === 1, 'last + count');
    assert(typeof r1.profile.lastPlayedAt === 'string' && r1.profile.lastPlayedAt, 'played at');
    const r2 = store.recordScore(40);
    assert(r2.isNewHigh === false, 'not new high');
    const p = store.getProfile();
    assert(p.highScore === 120 && p.lastScore === 40 && p.playCount === 2, 'second run');
  });

  section('exportSnapshot', () => {
    const store = AfgStore.create({
      gameId: 'attic',
      adapter: new AfgStore.MemoryAdapter()
    });
    store.setHighScore(5);
    const snap = store.exportSnapshot();
    assert(snap.schemaVersion === AfgStore.SCHEMA_VERSION, 'schema');
    assert(snap.gameId === 'attic' && snap.key === 'evilgame.attic.v1', 'ids');
    assert(snap.adapter === 'memory' && snap.profile.highScore === 5, 'adapter + profile');
    assert(typeof snap.exportedAt === 'string', 'exportedAt');
  });

  section('SlackAdapter swap + saveProfile hook', () => {
    const writes = [];
    const slack = new AfgStore.SlackAdapter({
      userId: 'U123',
      saveProfile: (key, json, userId) => {
        writes.push({ key, json, userId });
      }
    });
    const store = AfgStore.create({ gameId: 'attic', adapter: slack });
    store.setProfile({ nick: 'SlackGoblin', highScore: 10 });
    assert(store.getProfile().nick === 'SlackGoblin', 'slack readback');
    assert(slack.name === 'slack', 'adapter name');
    assert(writes.length >= 1 && writes[0].userId === 'U123', 'hook fired');
    assert(writes[0].key === 'evilgame.attic.v1', 'hook key');
  });

  section('adapter swap without rewriting game API', () => {
    function playRound(store, score) {
      store.setProfile({ nick: store.getProfile().nick || 'P' });
      return store.recordScore(score);
    }
    const local = AfgStore.create({
      gameId: 'attic',
      adapter: new AfgStore.MemoryAdapter(),
      defaultProfile: () => ({ nick: 'LocalP', highScore: 0 })
    });
    const remote = AfgStore.create({
      gameId: 'attic',
      adapter: new AfgStore.SlackAdapter({ userId: 'U9' }),
      defaultProfile: () => ({ nick: 'SlackP', highScore: 0 })
    });
    assert(playRound(local, 20).profile.highScore === 20, 'local round');
    assert(playRound(remote, 15).profile.highScore === 15, 'slack round');
  });

  section('LocalStorageAdapter with fake storage', () => {
    const fake = {
      _d: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; }
    };
    const store = AfgStore.create({
      gameId: 'attic',
      adapter: new AfgStore.LocalStorageAdapter(fake),
      defaultProfile: () => ({ nick: 'LS', highScore: 0 })
    });
    store.setHighScore(7);
    assert(JSON.parse(fake.getItem('evilgame.attic.v1')).highScore === 7, 'wrote ls');
    assert(store.adapter.name === 'localStorage', 'ls name');
  });

  console.log('afg-persist: ok');
}

run();
