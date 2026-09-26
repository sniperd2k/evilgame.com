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
