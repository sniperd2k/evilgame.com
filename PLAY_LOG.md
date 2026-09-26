# Server-side play logging

IIS Python CGI + SQLite under `App_Data/` (never shipped secrets / DB files).

Normalized schema: **users → visits → game_sessions → scores**. History is insert-only; the only UPDATE fills `game_sessions.ended_at` / `end_reason` when still NULL.

## Endpoints

| Script | Method | Role |
|--------|--------|------|
| `play_log.py` | POST JSON | visit / session_start / session_end / score |
| `play_log_query.py` | GET | Filtered views (JSON) |

Shared logic: `play_log_lib.py` (stdlib `sqlite3` only). Client helper: `afg/play_log.js`.

### POST `play_log.py`

```http
POST /play_log.py
Content-Type: application/json

{"action":"visit","user":"SoggyGoblin42"}
{"action":"session_start","user":"SoggyGoblin42","game":"attic","visit_id":1}
{"action":"score","user":"SoggyGoblin42","game":"attic","score":120,"game_session_id":1}
{"action":"session_end","user":"SoggyGoblin42","game_session_id":1,"end_reason":"pagehide"}
```

**Actions:** `visit` | `session_start` | `session_end` | `score`

| Field | Required | Notes |
|-------|----------|-------|
| `action` | yes | allow-list above (`event` / `type` accepted as alias; legacy `login`→visit) |
| `user` / `nick` / `login` | visit, session_start, score | ≤64 chars, `[\w .@+\-]` |
| `game` / `game_name` | session_start, score | ≤64, `[\w.\-]` |
| `visit_id` | optional on session_start | positive int FK |
| `game_session_id` | session_end, score | positive int FK |
| `score` | score | int 0…999999 |
| `end_reason` | session_end | `pagehide` \| `hidden` \| `beforeunload` \| `unbind` \| `reset_wipe` \| `leave` |

**Server-only fields (never from JSON body):** `ip_address` ← `REMOTE_ADDR` / `X-Forwarded-For`, `user_agent` ← `User-Agent`, `referrer` ← `Referer`. Client-supplied `ip` / `user_agent` / `referrer` keys are rejected.

Success examples: `{"ok":true,"visit_id":N}`, `{"ok":true,"game_session_id":N}`, `{"ok":true,"score_id":N}`, `{"ok":true,"updated":true}`. Errors are generic (no paths / stacks).

### GET `play_log_query.py`

```
play_log_query.py?view=visits&user=SoggyGoblin42&limit=20
play_log_query.py?view=sessions&game=attic&since=2026-09-01T00:00:00Z
play_log_query.py?view=scores&user=SoggyGoblin42
play_log_query.py?view=users
```

| `view` | Answers |
|--------|---------|
| `visits` (default) | Who visited when (ip / ua / referrer / visited_at) |
| `sessions` | Who played what + `duration_seconds` (ended_at − started_at) |
| `scores` | Score rows with session / user / game / achieved_at |
| `users` | user_id, first_seen_at, last_seen_at |

Filters: `user`, `game` (sessions/scores), `since`, `until` (UTC `YYYY-MM-DDTHH:MM:SSZ`), `limit` (1–100, default 50).

If `App_Data/play_log_query_key.txt` exists, require header `X-Play-Log-Key` or `?key=` (constant-time compare).

## Schema

```sql
PRAGMA foreign_keys=ON;

users(
  user_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,   -- UTC ISO8601 …Z
  last_seen_at  TEXT NOT NULL    -- upserted on every visit
)

visits(
  visit_id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  ip_address TEXT,               -- from SERVER request
  user_agent TEXT,
  referrer TEXT,
  visited_at TEXT NOT NULL
)

game_sessions(
  game_session_id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  visit_id INTEGER REFERENCES visits(visit_id),  -- nullable
  game_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,                 -- filled once on leave beacon
  end_reason TEXT
)

scores(
  score_id INTEGER PRIMARY KEY,
  game_session_id INTEGER NOT NULL REFERENCES game_sessions(game_session_id),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  game_name TEXT NOT NULL,
  score_value INTEGER NOT NULL,
  achieved_at TEXT NOT NULL
)
```

Indexes on join / time columns: `users.last_seen_at`, `visits(user_id, visited_at)`, `game_sessions(user_id, visit_id, started_at, game_name)`, `scores(game_session_id, user_id, achieved_at, game_name)`.

DB file: `App_Data/play_log.sqlite` (gitignored). IIS: `App_Data/web.config` hides the folder and denies `.sqlite` / secret `.txt` download.

## sqlite3 CLI (on the IIS host)

```bash
sqlite3 App_Data/play_log.sqlite \
  "SELECT visit_id, user_id, visited_at, ip_address FROM visits
   WHERE user_id = ? ORDER BY visit_id DESC LIMIT 20;" "SoggyGoblin42"

sqlite3 App_Data/play_log.sqlite \
  "SELECT game_session_id, user_id, game_name, started_at, ended_at, end_reason,
          CAST((julianday(ended_at)-julianday(started_at))*86400 AS INT) AS secs
   FROM game_sessions WHERE user_id = ? ORDER BY game_session_id DESC;" "SoggyGoblin42"
```

Prefer the `?` placeholder form (or bind in a small Python one-liner). Never paste unsanitized nicknames into a double-quoted SQL string.

## Client events

| When | Action | Where |
|------|--------|-------|
| AFG unlock success | `visit` | gate `onSuccess` |
| Page load (game) | `visit` + `session_start` | attic / farm via `AfgPlayLog.bindSession` |
| High / end-of-run score | `score` (uses active `game_session_id`) | attic / farm |
| pagehide / visibility hidden / beforeunload | `session_end` | attic / farm `bindSession` |
| Index Reset wipe | `session_end` (`reset_wipe`) if session active | index |

```js
AfgPlayLog.visit({ user: nick || 'afg' });
AfgPlayLog.bindSession({
  game: 'attic',
  getUser: function () { return profile.nick; }
});
AfgPlayLog.score({ user: profile.nick, game: 'attic', score: state.score });
```

Leave beacons use `fetch(..., { keepalive: true })` so the POST can outlive the page.

## Security notes

- Parameterized SQL only; inputs validated before bind; `PRAGMA foreign_keys=ON`.
- POST requires `Content-Type: application/json`; body capped at 4 KiB.
- IP / UA / referrer from CGI environ only — body keys for those fields rejected.
- CORS allow-list (no arbitrary `Origin` reflection).
- Query key optional in `App_Data` (gitignored).
- No shell / subprocess; no hardcoded secrets.
- No history overwrites: visits / sessions / scores are inserts; session end is a one-shot NULL→value update.

## Tests

```bash
python3 tests/play-log-unit.py
node tests/play-log-client.test.mjs
npm run test:playlog
```
