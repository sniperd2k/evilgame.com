# AFG persistence

Small client-side profile + high-score store for Attic Gaming (and future AFG games).

## Why adapters?

Game code must not talk to `localStorage` (or Slack) directly. It uses `AfgStore` only. When AFG ships inside Slack, swap the adapter — no attic/farm rewrites.

```js
// Today (browser):
var store = AfgStore.create({
  gameId: 'attic',
  defaultProfile: function () { return { nick: sillyNick(), highScore: 0 }; }
});

// Later (Slack):
var store = AfgStore.create({
  gameId: 'attic',
  adapter: new AfgStore.SlackAdapter({
    userId: slackUserId,
    saveProfile: function (key, json, userId) {
      // POST to your Slack-backed backend / datastore
    }
  })
});
```

## Keys

| Game  | Key                 |
|-------|---------------------|
| attic | `evilgame.attic.v1` |
| farm  | `evilgame.farm.v1`  |

Attic keeps the existing key so return visitors retain nick / high / `niceSeen`.

## Profile shape

```json
{
  "nick": "SoggyGoblin42",
  "highScore": 120,
  "lastScore": 48,
  "playCount": 7,
  "lastPlayedAt": "2026-09-26T16:00:00.000Z",
  "niceSeen": true
}
```

Extra fields are preserved (forward-compatible game flags).

## API

| Method | Role |
|--------|------|
| `getProfile()` | Load + sanitize |
| `setProfile(patch)` | Merge patch (rename without wiping scores) |
| `getHighScore()` / `setHighScore(n)` | High score helpers |
| `recordScore(n)` | End-of-run: lastScore, playCount++, lastPlayedAt, high if better |
| `exportSnapshot()` | Debug / future sync payload |

## Adapters

- **LocalStorageAdapter** — default in the browser
- **MemoryAdapter** — tests / ephemeral
- **SlackAdapter** — stub with the same `get`/`set`/`remove` contract; plug `saveProfile` + `userId` when the Slack backend exists

## Tests

```bash
npm run test:afg              # unit (persist framework)
npm run test:afg:integration  # attic return-visit (puppeteer)
npm test                      # all: afg unit + integration + farm (+ gate if present)
```

## Soft password gate

AFG-tagged games (Attic) require a server-side password check via `check_afg.py`
before play. Helpers:

- `afg_gate.py` — normalize / match / signed unlock cookie (unit-tested)
- `afg/gate.js` — mobile-friendly overlay + CGI client
- Secret file: `App_Data/afg_password.txt` on IIS only (gitignored)

```bash
npm run test:gate
```

## Turbo / test mode (`afg/turbo.js`)

Speed up attic + farm simulation for automated playthroughs (hundreds×).

**Enable (pick one):**

| Method | Example |
|--------|---------|
| URL param | `attic.html?turbo=1` (200×) or `?turbo=300` |
| localStorage | `localStorage.setItem('evilgame.turbo', '200')` then reload |
| Global | `window.__EVILGAME_TURBO__ = 200` before/during load; or `EvilTurbo.set(200)` |
| Test harness | `window.__TEST__ = true` → 200× |

**Disable:** `?turbo=0`, `EvilTurbo.set(0)`, or remove the localStorage key.

Games run many fixed `1/60` update steps per animation frame (capped) so physics stay stable. Under turbo, non-priority SFX are muted and meow clones are skipped; priority voice unlocks on **game-time** so the mic cannot softlock when wall-clock `ended` never fires.

**Automated suite defaults** (`tests/turbo-playthrough.mjs`):

| Env | Default | Why |
|-----|---------|-----|
| `TURBO_SPEED` | `200` | Few hundred× — cinema (~30s) finishes in fractions of a second of ticks; still fires collisions/audio hooks in headless |
| `TURBO_RUNS` | `3` | Per game: happy path + softlock stress + audio-cue stress (6 runs total) |

`?turbo=1` maps to the same default rate (200×) via `EvilTurbo.parseRate`.


## Event-driven audio (`afg/audio.js`)

Game loops **fire cues**; a separate manager schedules playback (pool, mic priority, unlock, turbo mute/skip).

```js
var audio = EvilAudio.create({
  name: 'attic',
  urls: ['sfx/dont-like-salad.wav', ...],
  priorityTtl: 6,
  turboPriorityTtl: 2.8
});
audio.register('salad', { url: 'sfx/dont-like-salad.wav', priority: true });
audio.register('meow', { pick: ['sfx/meow1.wav',...], vol: 0.9, overlap: true });

// from game logic (not the rAF clock):
audio.fire('salad');
audio.tick(dt); // game-time mic TTL — turbo can race ahead without softlock
```

Under turbo, non-priority SFX are muted/skipped; priority lines still arm the mic but unlock on **game-time** so wall-clock `ended` cannot desync the sim. Index reset uses `playUntilEnd` (gay.wav) and `playBoom` (procedural).

`fire()` is the additive hook point for future play_log POSTs — do not bury logging inside the scheduler.

## Play logging (server)

Normalized SQLite play log via IIS CGI (`App_Data/play_log.sqlite`, gitignored).

- Client: `afg/play_log.js` (`visit` / `bindSession` / `score` / leave beacons)
- POST: `play_log.py` — visit / session_start / session_end / score
- GET: `play_log_query.py` — views: visits, sessions, scores, users
- Full docs: [`PLAY_LOG.md`](../PLAY_LOG.md)

```bash
npm run test:playlog
```

