#!/usr/bin/env python3
"""Play-log helpers (stdlib sqlite3 only). Normalized schema — unit-tested.

Security:
- Parameterized SQL only (never concat user input into statements).
- Strict validation of actions, lengths, and score ranges before write.
- IP / UA / referrer taken from the SERVER request environ — never client JSON.
- DB path confined under App_Data; no shell / subprocess.
- Inserts only for history; the sole UPDATE fills game_sessions.ended_at/end_reason
  when still NULL (no history overwrite).
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

DB_FILENAME = "play_log.sqlite"
MAX_USER_LEN = 64
MAX_GAME_LEN = 64
MAX_BODY = 4096
MAX_QUERY_LIMIT = 100
DEFAULT_QUERY_LIMIT = 50
SCORE_MIN = 0
SCORE_MAX = 999999
MAX_IP_LEN = 45
MAX_UA_LEN = 512
MAX_REFERRER_LEN = 512
MAX_END_REASON_LEN = 32

ALLOWED_ACTIONS = frozenset({
    "visit",
    "session_start",
    "session_end",
    "score",
})

ALLOWED_END_REASONS = frozenset({
    "pagehide",
    "hidden",
    "beforeunload",
    "unbind",
    "reset_wipe",
    "leave",
})

ALLOWED_VIEWS = frozenset({
    "visits",
    "sessions",
    "scores",
    "users",
})

# Nick / user id: printable-ish, no control chars / path separators.
_USER_RE = re.compile(r"^[\w .@+\-]{1,%d}$" % MAX_USER_LEN)
_GAME_RE = re.compile(r"^[\w.\-]{1,%d}$" % MAX_GAME_LEN)
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
_IP_RE = re.compile(
    r"^(?:"
    r"(?:\d{1,3}\.){3}\d{1,3}"  # IPv4
    r"|"
    r"[0-9a-fA-F:.]{2,45}"  # IPv6-ish / mapped
    r")$"
)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visits (
  visit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  ip_address TEXT,
  user_agent TEXT,
  referrer TEXT,
  visited_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS game_sessions (
  game_session_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  visit_id INTEGER REFERENCES visits(visit_id),
  game_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);
CREATE TABLE IF NOT EXISTS scores (
  score_id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_session_id INTEGER NOT NULL REFERENCES game_sessions(game_session_id),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  game_name TEXT NOT NULL,
  score_value INTEGER NOT NULL,
  achieved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_visits_user ON visits(user_id);
CREATE INDEX IF NOT EXISTS idx_visits_visited_at ON visits(visited_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON game_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_visit ON game_sessions(visit_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON game_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_game ON game_sessions(game_name);
CREATE INDEX IF NOT EXISTS idx_scores_session ON scores(game_session_id);
CREATE INDEX IF NOT EXISTS idx_scores_user ON scores(user_id);
CREATE INDEX IF NOT EXISTS idx_scores_achieved ON scores(achieved_at);
CREATE INDEX IF NOT EXISTS idx_scores_game ON scores(game_name);
"""


def db_path(here: Optional[str] = None) -> str:
    base = here if here is not None else os.path.dirname(os.path.abspath(__file__))
    app_data = os.path.join(base, "App_Data")
    return os.path.join(app_data, DB_FILENAME)


def ensure_db(path: str) -> sqlite3.Connection:
    """Open (create) DB under App_Data with safe pragmas. Caller must close."""
    parent = os.path.dirname(path)
    if not os.path.isdir(parent):
        os.makedirs(parent, mode=0o750, exist_ok=True)
    abs_path = os.path.abspath(path)
    abs_parent = os.path.abspath(parent)
    if not abs_path.startswith(abs_parent + os.sep) and abs_path != abs_parent:
        raise ValueError("db path rejected")
    if not abs_path.endswith(DB_FILENAME):
        raise ValueError("db filename rejected")
    conn = sqlite3.connect(abs_path, timeout=5.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.executescript(SCHEMA_SQL)
        # Re-assert after executescript (script connection quirks).
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.commit()
    except Exception:
        conn.close()
        raise
    return conn


def utc_now_iso(now: Optional[float] = None) -> str:
    if now is None:
        now = time.time()
    dt = datetime.fromtimestamp(float(now), tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def sanitize_user(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s or len(s) > MAX_USER_LEN:
        return None
    if not _USER_RE.match(s):
        return None
    return s


def sanitize_game(raw: Any) -> Optional[str]:
    if raw is None or raw == "":
        return None
    s = str(raw).strip().lower()
    if len(s) > MAX_GAME_LEN:
        return None
    if not _GAME_RE.match(s):
        return None
    return s


def sanitize_action(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip().lower()
    if s not in ALLOWED_ACTIONS:
        return None
    return s


def sanitize_score(raw: Any) -> Tuple[bool, Optional[int]]:
    """Return (ok, value). ok=False means present but invalid; value=None means omitted."""
    if raw is None or raw == "":
        return True, None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return False, None
    if n < SCORE_MIN or n > SCORE_MAX:
        return False, None
    return True, n


def sanitize_end_reason(raw: Any) -> Optional[str]:
    if raw is None or raw == "":
        return "leave"
    s = str(raw).strip().lower()[:MAX_END_REASON_LEN]
    if s not in ALLOWED_END_REASONS:
        return None
    return s


def sanitize_id(raw: Any) -> Optional[int]:
    if raw is None or raw == "":
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    if n < 1:
        return None
    return n


def sanitize_ip(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s or len(s) > MAX_IP_LEN:
        return None
    # Strip port if present (IPv4:port); leave IPv6 bracket forms alone.
    if s.count(":") == 1 and "." in s:
        s = s.split(":", 1)[0]
    if s.startswith("[") and "]" in s:
        s = s[1:s.index("]")]
    if not _IP_RE.match(s):
        return None
    return s[:MAX_IP_LEN]


def sanitize_ua(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).replace("\x00", "").strip()
    if not s:
        return None
    return s[:MAX_UA_LEN]


def sanitize_referrer(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).replace("\x00", "").strip()
    if not s:
        return None
    return s[:MAX_REFERRER_LEN]


def request_ip(environ: Optional[Dict[str, str]] = None) -> Optional[str]:
    """IP from SERVER request only — never from client JSON body."""
    env = environ if environ is not None else os.environ
    # Prefer direct peer; optionally first X-Forwarded-For hop (still server header).
    fwd = (env.get("HTTP_X_FORWARDED_FOR") or "").split(",")[0].strip()
    cand = fwd or (env.get("REMOTE_ADDR") or "").strip()
    return sanitize_ip(cand)


def request_ua(environ: Optional[Dict[str, str]] = None) -> Optional[str]:
    env = environ if environ is not None else os.environ
    return sanitize_ua(env.get("HTTP_USER_AGENT"))


def request_referrer(environ: Optional[Dict[str, str]] = None) -> Optional[str]:
    env = environ if environ is not None else os.environ
    return sanitize_referrer(env.get("HTTP_REFERER") or env.get("HTTP_REFERRER"))


def upsert_user(conn: sqlite3.Connection, user_id: str, ts: Optional[str] = None) -> str:
    now = ts or utc_now_iso()
    conn.execute(
        "INSERT INTO users (user_id, first_seen_at, last_seen_at) VALUES (?, ?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at",
        (user_id, now, now),
    )
    return user_id


def insert_visit(
    conn: sqlite3.Connection,
    user_id: str,
    ip_address: Optional[str],
    user_agent: Optional[str],
    referrer: Optional[str],
    visited_at: Optional[str] = None,
) -> int:
    ts = visited_at or utc_now_iso()
    upsert_user(conn, user_id, ts)
    cur = conn.execute(
        "INSERT INTO visits (user_id, ip_address, user_agent, referrer, visited_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (user_id, ip_address, user_agent, referrer, ts),
    )
    conn.commit()
    return int(cur.lastrowid)


def insert_session(
    conn: sqlite3.Connection,
    user_id: str,
    game_name: str,
    visit_id: Optional[int] = None,
    started_at: Optional[str] = None,
) -> int:
    ts = started_at or utc_now_iso()
    upsert_user(conn, user_id, ts)
    if visit_id is not None:
        row = conn.execute(
            "SELECT visit_id FROM visits WHERE visit_id = ? AND user_id = ?",
            (visit_id, user_id),
        ).fetchone()
        if row is None:
            raise ValueError("bad visit")
    cur = conn.execute(
        "INSERT INTO game_sessions "
        "(user_id, visit_id, game_name, started_at, ended_at, end_reason) "
        "VALUES (?, ?, ?, ?, NULL, NULL)",
        (user_id, visit_id, game_name, ts),
    )
    conn.commit()
    return int(cur.lastrowid)


def end_session(
    conn: sqlite3.Connection,
    game_session_id: int,
    end_reason: str,
    ended_at: Optional[str] = None,
    user_id: Optional[str] = None,
) -> bool:
    """Fill ended_at/end_reason only if still open. Returns True if a row updated."""
    ts = ended_at or utc_now_iso()
    if user_id:
        cur = conn.execute(
            "UPDATE game_sessions SET ended_at = ?, end_reason = ? "
            "WHERE game_session_id = ? AND user_id = ? AND ended_at IS NULL",
            (ts, end_reason, game_session_id, user_id),
        )
    else:
        cur = conn.execute(
            "UPDATE game_sessions SET ended_at = ?, end_reason = ? "
            "WHERE game_session_id = ? AND ended_at IS NULL",
            (ts, end_reason, game_session_id),
        )
    conn.commit()
    return cur.rowcount > 0


def insert_score(
    conn: sqlite3.Connection,
    user_id: str,
    game_name: str,
    score_value: int,
    game_session_id: int,
    achieved_at: Optional[str] = None,
) -> int:
    ts = achieved_at or utc_now_iso()
    row = conn.execute(
        "SELECT game_session_id, user_id, game_name FROM game_sessions "
        "WHERE game_session_id = ?",
        (game_session_id,),
    ).fetchone()
    if row is None:
        raise ValueError("bad session")
    if row["user_id"] != user_id:
        raise ValueError("session user mismatch")
    # Prefer session's game_name if client disagrees — still require match for safety.
    if row["game_name"] != game_name:
        raise ValueError("session game mismatch")
    upsert_user(conn, user_id, ts)
    cur = conn.execute(
        "INSERT INTO scores "
        "(game_session_id, user_id, game_name, score_value, achieved_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (game_session_id, user_id, game_name, score_value, ts),
    )
    conn.commit()
    return int(cur.lastrowid)


def validate_action_payload(
    data: Any,
    environ: Optional[Dict[str, str]] = None,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Validate POST JSON. Returns (action_dict, error).

    IP/UA/referrer always sourced from environ (server request), never the body.
    """
    if not isinstance(data, dict):
        return None, "invalid json"
    # Reject client-supplied network fields so they cannot override server values.
    for banned in ("ip", "ip_address", "user_agent", "ua", "referrer", "referer"):
        if banned in data:
            return None, "bad field"

    action = sanitize_action(
        data.get("action") or data.get("event") or data.get("event_type") or data.get("type")
    )
    if not action:
        return None, "bad action"

    user = sanitize_user(
        data.get("user")
        or data.get("user_id")
        or data.get("nick")
        or data.get("login")
    )

    if action == "visit":
        if not user:
            return None, "need user"
        return {
            "action": "visit",
            "user_id": user,
            "ip_address": request_ip(environ),
            "user_agent": request_ua(environ),
            "referrer": request_referrer(environ),
        }, None

    if action == "session_start":
        if not user:
            return None, "need user"
        game = sanitize_game(data.get("game") or data.get("game_name"))
        if not game:
            return None, "need game"
        visit_id = sanitize_id(data.get("visit_id"))
        # visit_id optional; if present must be positive int (FK checked on insert).
        if data.get("visit_id") not in (None, "") and visit_id is None:
            return None, "bad visit_id"
        return {
            "action": "session_start",
            "user_id": user,
            "game_name": game,
            "visit_id": visit_id,
        }, None

    if action == "session_end":
        sid = sanitize_id(data.get("game_session_id") or data.get("session_id"))
        if sid is None:
            return None, "need session"
        reason = sanitize_end_reason(data.get("end_reason") or data.get("reason"))
        if reason is None:
            return None, "bad reason"
        out: Dict[str, Any] = {
            "action": "session_end",
            "game_session_id": sid,
            "end_reason": reason,
        }
        if user:
            out["user_id"] = user
        return out, None

    if action == "score":
        if not user:
            return None, "need user"
        game = sanitize_game(data.get("game") or data.get("game_name"))
        if not game:
            return None, "need game"
        ok_score, score = sanitize_score(data.get("score") if "score" in data else data.get("score_value"))
        if not ok_score or score is None:
            return None, "bad score"
        sid = sanitize_id(data.get("game_session_id") or data.get("session_id"))
        if sid is None:
            return None, "need session"
        return {
            "action": "score",
            "user_id": user,
            "game_name": game,
            "score_value": score,
            "game_session_id": sid,
        }, None

    return None, "bad action"


def apply_action(conn: sqlite3.Connection, action: Dict[str, Any]) -> Dict[str, Any]:
    """Execute a validated action. Returns response fragment (ids). Raises ValueError on FK miss."""
    kind = action["action"]
    if kind == "visit":
        vid = insert_visit(
            conn,
            action["user_id"],
            action.get("ip_address"),
            action.get("user_agent"),
            action.get("referrer"),
        )
        return {"ok": True, "visit_id": vid, "user_id": action["user_id"]}
    if kind == "session_start":
        sid = insert_session(
            conn,
            action["user_id"],
            action["game_name"],
            visit_id=action.get("visit_id"),
        )
        return {
            "ok": True,
            "game_session_id": sid,
            "user_id": action["user_id"],
            "game": action["game_name"],
        }
    if kind == "session_end":
        updated = end_session(
            conn,
            action["game_session_id"],
            action["end_reason"],
            user_id=action.get("user_id"),
        )
        return {
            "ok": True,
            "game_session_id": action["game_session_id"],
            "updated": updated,
        }
    if kind == "score":
        score_id = insert_score(
            conn,
            action["user_id"],
            action["game_name"],
            action["score_value"],
            action["game_session_id"],
        )
        return {"ok": True, "score_id": score_id}
    raise ValueError("bad action")


def parse_query_filters(qs: Dict[str, List[str]]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Build safe filter dict from CGI FieldStorage-like mapping of lists."""
    def first(key: str) -> Optional[str]:
        vals = qs.get(key)
        if not vals:
            return None
        return vals[0]

    filters: Dict[str, Any] = {}
    view = (first("view") or first("q") or "visits").strip().lower()
    if view not in ALLOWED_VIEWS:
        return None, "bad view"
    filters["view"] = view

    user = first("user") or first("user_id") or first("nick")
    if user is not None:
        u = sanitize_user(user)
        if not u:
            return None, "bad user"
        filters["user_id"] = u
    game = first("game") or first("game_name")
    if game is not None:
        g = sanitize_game(game)
        if not g:
            return None, "bad game"
        filters["game_name"] = g
    since = first("since")
    if since is not None and since != "":
        s = str(since).strip()
        if not _ISO_RE.match(s):
            return None, "bad since"
        filters["since"] = s
    until = first("until")
    if until is not None and until != "":
        u = str(until).strip()
        if not _ISO_RE.match(u):
            return None, "bad until"
        filters["until"] = u
    limit_raw = first("limit")
    if limit_raw is None or limit_raw == "":
        filters["limit"] = DEFAULT_QUERY_LIMIT
    else:
        try:
            lim = int(limit_raw)
        except (TypeError, ValueError):
            return None, "bad limit"
        if lim < 1 or lim > MAX_QUERY_LIMIT:
            return None, "bad limit"
        filters["limit"] = lim
    return filters, None


def _session_duration_seconds(started_at: Optional[str], ended_at: Optional[str]) -> Optional[int]:
    if not started_at or not ended_at:
        return None
    try:
        t0 = datetime.strptime(started_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        t1 = datetime.strptime(ended_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        return max(0, int((t1 - t0).total_seconds()))
    except Exception:
        return None


def query_view(conn: sqlite3.Connection, filters: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parameterized SELECT by view. Never interpolates user strings into SQL text."""
    view = filters["view"]
    limit = int(filters.get("limit") or DEFAULT_QUERY_LIMIT)
    params: List[Any] = []
    clauses: List[str] = []

    if view == "users":
        if "user_id" in filters:
            clauses.append("user_id = ?")
            params.append(filters["user_id"])
        if "since" in filters:
            clauses.append("last_seen_at >= ?")
            params.append(filters["since"])
        if "until" in filters:
            clauses.append("last_seen_at <= ?")
            params.append(filters["until"])
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = (
            "SELECT user_id, first_seen_at, last_seen_at FROM users"
            + where
            + " ORDER BY last_seen_at DESC LIMIT ?"
        )
        params.append(limit)
        cur = conn.execute(sql, params)
        return [
            {
                "user_id": r["user_id"],
                "first_seen_at": r["first_seen_at"],
                "last_seen_at": r["last_seen_at"],
            }
            for r in cur.fetchall()
        ]

    if view == "visits":
        if "user_id" in filters:
            clauses.append("user_id = ?")
            params.append(filters["user_id"])
        if "since" in filters:
            clauses.append("visited_at >= ?")
            params.append(filters["since"])
        if "until" in filters:
            clauses.append("visited_at <= ?")
            params.append(filters["until"])
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = (
            "SELECT visit_id, user_id, ip_address, user_agent, referrer, visited_at "
            "FROM visits" + where + " ORDER BY visit_id DESC LIMIT ?"
        )
        params.append(limit)
        cur = conn.execute(sql, params)
        return [
            {
                "visit_id": r["visit_id"],
                "user_id": r["user_id"],
                "ip_address": r["ip_address"],
                "user_agent": r["user_agent"],
                "referrer": r["referrer"],
                "visited_at": r["visited_at"],
            }
            for r in cur.fetchall()
        ]

    if view == "sessions":
        if "user_id" in filters:
            clauses.append("user_id = ?")
            params.append(filters["user_id"])
        if "game_name" in filters:
            clauses.append("game_name = ?")
            params.append(filters["game_name"])
        if "since" in filters:
            clauses.append("started_at >= ?")
            params.append(filters["since"])
        if "until" in filters:
            clauses.append("started_at <= ?")
            params.append(filters["until"])
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = (
            "SELECT game_session_id, user_id, visit_id, game_name, "
            "started_at, ended_at, end_reason FROM game_sessions"
            + where
            + " ORDER BY game_session_id DESC LIMIT ?"
        )
        params.append(limit)
        cur = conn.execute(sql, params)
        out = []
        for r in cur.fetchall():
            out.append({
                "game_session_id": r["game_session_id"],
                "user_id": r["user_id"],
                "visit_id": r["visit_id"],
                "game_name": r["game_name"],
                "started_at": r["started_at"],
                "ended_at": r["ended_at"],
                "end_reason": r["end_reason"],
                "duration_seconds": _session_duration_seconds(
                    r["started_at"], r["ended_at"]
                ),
            })
        return out

    if view == "scores":
        if "user_id" in filters:
            clauses.append("user_id = ?")
            params.append(filters["user_id"])
        if "game_name" in filters:
            clauses.append("game_name = ?")
            params.append(filters["game_name"])
        if "since" in filters:
            clauses.append("achieved_at >= ?")
            params.append(filters["since"])
        if "until" in filters:
            clauses.append("achieved_at <= ?")
            params.append(filters["until"])
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        sql = (
            "SELECT score_id, game_session_id, user_id, game_name, "
            "score_value, achieved_at FROM scores"
            + where
            + " ORDER BY score_id DESC LIMIT ?"
        )
        params.append(limit)
        cur = conn.execute(sql, params)
        return [
            {
                "score_id": r["score_id"],
                "game_session_id": r["game_session_id"],
                "user_id": r["user_id"],
                "game_name": r["game_name"],
                "score_value": r["score_value"],
                "achieved_at": r["achieved_at"],
            }
            for r in cur.fetchall()
        ]

    return []


def read_query_key(here: Optional[str] = None) -> Optional[str]:
    """Optional shared secret for query CGI (App_Data only)."""
    base = here if here is not None else os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(base, "App_Data", "play_log_query_key.txt")
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        key = f.read().strip()
    return key if key else None


def content_type_is_json(header: Optional[str]) -> bool:
    if not header:
        return False
    main = header.split(";")[0].strip().lower()
    return main == "application/json"
